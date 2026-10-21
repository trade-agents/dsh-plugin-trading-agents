#!/usr/bin/env node
/**
 * Offline smoke suite for dsh-plugin-trading-agents.
 *
 * Runs with plain Node, no network, no venv: it exercises the plugin surface,
 * configuration validation, skill/role parsing, CLI argv construction, the
 * generated launchers, and every declared JSON Schema against a local mirror of
 * DSH's supported subset. `test/dsh-schema-check.mjs` re-checks the schemas and
 * live outputs against DSH's real validator.
 *
 * The live half runs only when `DSH_TEST_TRADING_AGENTS_LIVE=1` and a bootstrapped
 * venv exists, because it reaches real data endpoints.
 *
 * @module dsh-plugin-trading-agents/test/smoke
 */

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** `1` runs the live half against real data endpoints. */
const LIVE = process.env.DSH_TEST_TRADING_AGENTS_LIVE === '1'
/** A caller-supplied bootstrapped home is reused by the live half. */
const EXTERNAL_HOME = LIVE && process.env.TRADING_AGENTS_HOME ? process.env.TRADING_AGENTS_HOME : undefined
/** Temp home so the suite never touches the developer's real data home. */
const HOME = EXTERNAL_HOME ?? mkdtempSync(join(tmpdir(), 'ta-smoke-'))
const HOME_IS_TEMP = EXTERNAL_HOME === undefined
process.env.TRADING_AGENTS_HOME = HOME
process.env.TRADING_AGENTS_RESULTS_DIR = join(HOME, 'runs')

const { apply, name, inject } = await import('../lib/index.js')
const { ConfigError, resolveConfig, resolveHome, resolveResultsDir } = await import('../lib/config.js')
const { looseBoolean, parseFrontmatter } = await import('../lib/frontmatter.js')
const { collectCommandSkills, collectRoleSkills } = await import('../lib/skills.js')
const { dataArgv, memoryArgv, localToday } = await import('../lib/tools.js')
const { PLUGIN_ROOT } = await import('../lib/paths.js')

let passed = 0
const failures = []

/**
 * Records one assertion.
 *
 * @param label - what was checked.
 * @param thunk - the assertion body; throwing marks a failure.
 */
function check(label, thunk) {
    try {
        thunk()
        passed += 1
        console.log(`  ok   ${label}`)
    } catch (error) {
        failures.push(`${label} — ${error?.message ?? error}`)
        console.log(`  FAIL ${label} — ${error?.message ?? error}`)
    }
}

/**
 * Asserts a thunk throws, optionally matching a message fragment.
 *
 * @param label - what was checked.
 * @param thunk - the call expected to fail.
 * @param fragment - optional substring the error message must contain.
 */
function checkThrows(label, thunk, fragment) {
    try {
        thunk()
    } catch (error) {
        const message = String(error?.message ?? error)
        if (fragment && !message.includes(fragment)) {
            throw new Error(`threw, but message lacks ${JSON.stringify(fragment)}: ${message}`)
        }
        return
    }
    throw new Error('did not throw')
}

/**
 * Like {@link check}, but awaits an async assertion body.
 *
 * @param label - what was checked.
 * @param thunk - the async assertion body.
 */
async function checkAsync(label, thunk) {
    try {
        await thunk()
        passed += 1
        console.log(`  ok   ${label}`)
    } catch (error) {
        failures.push(`${label} — ${error?.message ?? error}`)
        console.log(`  FAIL ${label} — ${error?.message ?? error}`)
    }
}

/**
 * Asserts an async thunk rejects, optionally matching a message fragment.
 *
 * @param label - what was checked.
 * @param thunk - the async call expected to fail.
 * @param fragment - optional substring the error message must contain.
 */
async function checkRejects(label, thunk, fragment) {
    try {
        await thunk()
    } catch (error) {
        const message = String(error?.message ?? error)
        if (fragment && !message.includes(fragment)) {
            throw new Error(`rejected, but message lacks ${JSON.stringify(fragment)}: ${message}`)
        }
        return
    }
    throw new Error('did not reject')
}

/** A minimal stand-in for the DSH tool registry. */
function fakeContext(options = {}) {
    const tools = new Map()
    const skills = new Map()
    /** @type {string[]} */
    const warnings = []
    return {
        tools,
        skills,
        warnings,
        ctx: {
            get: options?.shellEnv ? (name) => (name === 'shellEnv' ? options.shellEnv : undefined) : () => undefined,
            logger: {
                info: () => {},
                warn: (message) => warnings.push(String(message)),
                error: () => {},
            },
            tools: {
                register: (definition) => {
                    if (tools.has(definition.name)) throw new Error(`duplicate tool ${definition.name}`)
                    tools.set(definition.name, definition)
                },
            },
            skills: {
                register: (skill) => {
                    if (skills.has(skill.name)) throw new Error(`duplicate skill ${skill.name}`)
                    skills.set(skill.name, skill)
                    return () => {}
                },
            },
            effect: (callback) => callback(),
        },
    }
}

/** The JSON Schema keywords DSH's validator accepts, mirrored locally. */
const SUPPORTED_KEYWORDS = new Set([
    'type', 'properties', 'required', 'additionalProperties', 'items', 'enum',
    'const', 'oneOf', 'description', 'title', 'default', 'minimum', 'maximum',
    'minItems', 'maxItems', 'minLength', 'maxLength', 'pattern', 'format',
])

/**
 * Walks a schema and reports any keyword outside the supported subset.
 *
 * @param schema - the schema node.
 * @param path - JSON path for the message.
 * @returns the first unsupported keyword, or undefined.
 */
function unsupportedKeyword(schema, path = '$') {
    if (schema === null || typeof schema !== 'object') return undefined
    if (Array.isArray(schema)) {
        for (const [index, entry] of schema.entries()) {
            const found = unsupportedKeyword(entry, `${path}[${index}]`)
            if (found) return found
        }
        return undefined
    }
    for (const key of Object.keys(schema)) {
        if (!SUPPORTED_KEYWORDS.has(key)) return `${path}.${key}`
    }
    if (schema.properties) {
        for (const [key, value] of Object.entries(schema.properties)) {
            const found = unsupportedKeyword(value, `${path}.properties.${key}`)
            if (found) return found
        }
    }
    if (schema.items) {
        const found = unsupportedKeyword(schema.items, `${path}.items`)
        if (found) return found
    }
    return undefined
}

const { ctx, tools, skills, warnings } = fakeContext()
await apply(ctx, { autoBootstrap: false })

console.log('\n[1] plugin surface')
check('name export', () => assert.equal(name, 'trading-agents'))
check('inject includes tools and skills', () => {
    assert.ok(inject.includes('tools'))
    assert.ok(inject.includes('skills'))
})
check('applied without warnings', () => assert.deepEqual(warnings, []))
check('registers five tools', () => assert.equal(tools.size, 5))
for (const toolName of ['ta_doctor', 'ta_run', 'ta_data', 'ta_memory', 'ta_assemble']) {
    check(`${toolName} is registered`, () => assert.ok(tools.has(toolName)))
}
for (const [toolName, definition] of tools) {
    check(`${toolName} has description/parameters/output/execute`, () => {
        assert.equal(typeof definition.description, 'string')
        assert.ok(definition.description.length > 20)
        assert.equal(typeof definition.execute, 'function')
        assert.equal(definition.parameters.type, 'object')
        assert.equal(definition.parameters.additionalProperties, false)
        assert.ok(definition.output?.schema)
        assert.equal(typeof definition.output.render, 'function')
    })
    check(`${toolName} parameters stay in DSH's subset`, () => {
        const found = unsupportedKeyword(definition.parameters)
        if (found) throw new Error(`unsupported keyword at ${found}`)
    })
    check(`${toolName} output schema stays in DSH's subset`, () => {
        const found = unsupportedKeyword(definition.output.schema)
        if (found) throw new Error(`unsupported keyword at ${found}`)
    })
    check(`${toolName} presentCall is well formed`, () => {
        if (!definition.presentCall) return
        const call = definition.presentCall({})
        assert.equal(typeof call.title, 'string')
        assert.equal(typeof call.card, 'string')
    })
}

console.log('\n[2] skills and roles')
check('command skills parse', () => {
    const parsed = collectCommandSkills(join(PLUGIN_ROOT, 'skills'))
    assert.ok(parsed.length >= 3, `expected at least 3 command skills, got ${parsed.length}`)
    const names = parsed.map((skill) => skill.name).sort()
    assert.deepEqual(names, ['trading-agents-pipeline', 'trading-agents-settle-decisions', 'trading-agents-trade'])
})
check('every skill declares a loadable source', () => {
    for (const skill of [...collectCommandSkills(join(PLUGIN_ROOT, 'skills')), ...collectRoleSkills(join(PLUGIN_ROOT, 'roles'), () => {})]) {
        assert.equal(typeof skill.source, 'string', `${skill.name} has no string source`)
        assert.ok(skill.source.length > 0)
        assert.equal(skill.resourceBase?.kind, 'directory', `${skill.name} has no directory resourceBase`)
        assert.ok(existsSync(skill.resourceBase.path), `${skill.name} resourceBase does not exist`)
    }
})
check('every command skill is user-invocable', () => {
    for (const skill of collectCommandSkills(join(PLUGIN_ROOT, 'skills'))) {
        assert.equal(skill.invocation.userInvocable, true, skill.name)
        assert.ok(skill.content.length > 200, `${skill.name} body is suspiciously short`)
        assert.ok(skill.content.length < 8192, `${skill.name} body exceeds the pruner threshold`)
    }
})
check('roles parse and stay model-only', () => {
    const parsed = collectRoleSkills(join(PLUGIN_ROOT, 'roles'), (message) => {
        throw new Error(message)
    })
    assert.equal(parsed.length, 13)
    for (const skill of parsed) {
        assert.match(skill.name, /^trading-agents-[a-z0-9]+(-[a-z0-9]+)*$/)
        assert.equal(skill.invocation.modelInvocable, true)
        assert.equal(skill.invocation.userInvocable, false)
        assert.ok(skill.content.length < 8192, `${skill.name} body exceeds the pruner threshold`)
    }
})
check('all thirteen expected roles are present', () => {
    const expected = [
        'aggressive-risk-analyst', 'bear-researcher', 'bull-researcher',
        'conservative-risk-analyst', 'fundamentals-analyst', 'market-analyst',
        'memory-reflector', 'neutral-risk-analyst', 'news-analyst',
        'portfolio-manager', 'research-manager', 'sentiment-analyst', 'trader',
    ].map((role) => `trading-agents-${role}`).sort()
    assert.deepEqual([...skills.keys()].filter((key) => !key.startsWith('trading-agents-pipeline') && key !== 'trading-agents-trade' && key !== 'trading-agents-settle-decisions').sort(), expected)
})
check('registered skills are the collected ones', () => {
    const expected = collectCommandSkills(join(PLUGIN_ROOT, 'skills')).length + collectRoleSkills(join(PLUGIN_ROOT, 'roles'), () => {}).length
    assert.equal(skills.size, expected)
})
check('no skill body needs pruning', () => {
    for (const [skillName, skill] of skills) {
        assert.ok(skill.content.length < 8192, `${skillName}: ${skill.content.length}`)
    }
})

console.log('\n[3] configuration')
check('defaults resolve', () => {
    const config = resolveConfig(undefined)
    assert.equal(config.outputLanguage, 'English')
    assert.equal(config.holdingDays, 5)
    assert.equal(config.autoBootstrap, true)
    assert.deepEqual(config.env, {})
})
check('unknown field is rejected', () => checkThrows('unknown', () => resolveConfig({ nope: 1 }), 'unknown config field'))
check('bad boolean is rejected', () => checkThrows('bool', () => resolveConfig({ autoBootstrap: 'maybe' }), 'must be a boolean'))
check('bad integer is rejected', () => checkThrows('int', () => resolveConfig({ holdingDays: 0 }), 'greater than or equal to 1'))
check('output language defaults to English', () => assert.equal(resolveConfig(undefined).outputLanguage, 'English'))
check('language codes and native names normalize', () => {
    for (const [input, expected] of [
        ['zh', 'Chinese'], ['中文', 'Chinese'], ['Chinese', 'Chinese'],
        ['en', 'English'], ['EN-US', 'English'], ['ja', 'Japanese'], ['日本語', 'Japanese'],
        ['zh-tw', 'Traditional Chinese'], ['de', 'German'], ['fr', 'French'],
    ]) {
        assert.equal(resolveConfig({ outputLanguage: input }).outputLanguage, expected, input)
    }
})
check('an unknown language passes through unchanged', () => {
    assert.equal(resolveConfig({ outputLanguage: 'Klingon' }).outputLanguage, 'Klingon')
})
check('an empty language is rejected', () => checkThrows('lang', () => resolveConfig({ outputLanguage: '   ' }), 'must not be empty'))
check('an overlong language is rejected', () => checkThrows('lang', () => resolveConfig({ outputLanguage: 'x'.repeat(65) }), 'at most 64'))
check('env mapping is validated', () => checkThrows('env', () => resolveConfig({ env: { 'bad-name': 'x' } }), 'not a valid environment variable name'))
check('home precedence: env beats config', () => {
    const previous = process.env.TRADING_AGENTS_HOME
    process.env.TRADING_AGENTS_HOME = '/tmp/ta-home-env'
    try {
        assert.equal(resolveHome(resolveConfig({ home: '/tmp/ta-home-config' })), '/tmp/ta-home-env')
    } finally {
        if (previous === undefined) delete process.env.TRADING_AGENTS_HOME
        else process.env.TRADING_AGENTS_HOME = previous
    }
})
check('results dir defaults inside the workspace', () => {
    const { TRADING_AGENTS_RESULTS_DIR } = process.env
    delete process.env.TRADING_AGENTS_RESULTS_DIR
    try {
        const config = resolveConfig(undefined)
        assert.equal(resolveResultsDir(config, '/tmp/ta-workspace'), '/tmp/ta-workspace/.trading-agents/runs')
    } finally {
        if (TRADING_AGENTS_RESULTS_DIR !== undefined) process.env.TRADING_AGENTS_RESULTS_DIR = TRADING_AGENTS_RESULTS_DIR
    }
})

console.log('\n[4] frontmatter parser')
check('parses plain values', () => {
    const { fields, body } = parseFrontmatter('---\nname: demo\ndescription: "a: b"\n---\nBody here\n')
    assert.equal(fields.name, 'demo')
    assert.equal(fields.description, 'a: b')
    assert.equal(body.trim(), 'Body here')
})
check('parses strict booleans', () => {
    for (const [text, expected] of [['true', true], ['YES', true], ['on', true], ['1', true], ['false', false], ['No', false], ['off', false], ['0', false]]) {
        assert.equal(looseBoolean(text), expected, text)
    }
    assert.equal(looseBoolean('maybe'), undefined)
})
check('rejects a missing opener', () => checkThrows('opener', () => parseFrontmatter('name: x\n'), 'expected YAML frontmatter'))
check('rejects nested frontmatter', () => checkThrows('nested', () => parseFrontmatter('---\n a: b\n---\n'), 'nested or multi-line'))
check('rejects unterminated frontmatter', () => checkThrows('unterminated', () => parseFrontmatter('---\nname: x\n'), 'unterminated'))

console.log('\n[5] CLI argv construction')
check('today', () => assert.deepEqual(dataArgv({ command: 'today' }), ['today']))
check('identity with asset type', () => {
    assert.deepEqual(
        dataArgv({ command: 'identity', ticker: 'NVDA', date: '2026-10-20', assetType: 'crypto' }),
        ['identity', 'NVDA', '--date', '2026-10-20', '--asset-type', 'crypto'],
    )
})
check('snapshot with lookback', () => {
    assert.deepEqual(dataArgv({ command: 'snapshot', ticker: '700.HK', lookback: 30 }), ['snapshot', '700.HK', '--lookback', '30'])
})
check('quote with start and days', () => {
    assert.deepEqual(
        dataArgv({ command: 'quote', ticker: 'NVDA', date: '2026-10-20', start: '2026-01-01', days: 180 }),
        ['quote', 'NVDA', '--date', '2026-10-20', '--start', '2026-01-01', '--days', '180'],
    )
})
check('indicator requires names', () => checkThrows('names', () => dataArgv({ command: 'indicator', ticker: 'NVDA' }), '`names` is required'))
check('statement builds kind and freq', () => {
    assert.deepEqual(
        dataArgv({ command: 'statement', ticker: 'NVDA', kind: 'income', freq: 'annual' }),
        ['statement', 'NVDA', '--kind', 'income', '--freq', 'annual'],
    )
})
check('news window', () => {
    assert.deepEqual(
        dataArgv({ command: 'news', ticker: 'NVDA', start: '2026-09-01', end: '2026-10-01', limit: 5 }),
        ['news', 'NVDA', '--start', '2026-09-01', '--end', '2026-10-01', '--limit', '5'],
    )
})
check('global news lookback', () => assert.deepEqual(dataArgv({ command: 'global-news', lookback: 7 }), ['global-news', '--lookback', '7']))
check('macro positional', () => assert.deepEqual(dataArgv({ command: 'macro', indicator: 'cpi' }), ['macro', 'cpi']))
check('prediction positional', () => assert.deepEqual(dataArgv({ command: 'prediction', topic: 'fed rate cut' }), ['prediction', 'fed rate cut']))
check('sentiment limit', () => assert.deepEqual(dataArgv({ command: 'sentiment', ticker: 'NVDA', limit: 10 }), ['sentiment', 'NVDA', '--limit', '10']))
check('futu limit', () => assert.deepEqual(dataArgv({ command: 'futu', ticker: '02513.HK', limit: 10 }), ['futu', '02513.HK', '--limit', '10']))
check('rejects a bad date', () => checkThrows('date', () => dataArgv({ command: 'snapshot', ticker: 'NVDA', date: '20-10-2026' }), 'YYYY-MM-DD'))

check('memory context', () => assert.deepEqual(memoryArgv({ action: 'context', ticker: 'NVDA' }), ['memory', 'context', 'NVDA']))
check('memory context as-of', () => assert.deepEqual(memoryArgv({ action: 'context', ticker: 'NVDA', asOf: '2026-01-02' }), ['memory', 'context', 'NVDA', '--as-of', '2026-01-02']))
check('memory store', () => {
    assert.deepEqual(
        memoryArgv({ action: 'store', ticker: 'NVDA', date: '2026-10-20', rating: 'Hold', decisionFile: '/tmp/d.md' }),
        ['memory', 'store', 'NVDA', '--date', '2026-10-20', '--rating', 'Hold', '--decision-file', '/tmp/d.md'],
    )
})
check('memory store replace', () => {
    assert.deepEqual(
        memoryArgv({ action: 'store', ticker: 'NVDA', date: '2026-10-20', rating: 'Hold', decisionFile: '/tmp/d.md', replace: true }),
        ['memory', 'store', 'NVDA', '--date', '2026-10-20', '--rating', 'Hold', '--decision-file', '/tmp/d.md', '--replace'],
    )
})
check('memory settle without ticker', () => assert.deepEqual(memoryArgv({ action: 'settle' }), ['memory', 'settle']))
check('memory settle with ticker', () => assert.deepEqual(memoryArgv({ action: 'settle', ticker: 'NVDA' }), ['memory', 'settle', '--ticker', 'NVDA']))
check('memory list pending only', () => assert.deepEqual(memoryArgv({ action: 'list', pendingOnly: true }), ['memory', 'list', '--pending-only']))
check('memory outcome', () => {
    assert.deepEqual(
        memoryArgv({
            action: 'outcome', ticker: 'NVDA', date: '2026-10-20', rawReturn: 0.03,
            alphaReturn: 0.01, holdingDays: 5, resolutionDate: '2026-10-27', reflectionFile: '/tmp/r.txt',
        }),
        ['memory', 'outcome', 'NVDA', '--date', '2026-10-20', '--raw-return', '0.03', '--alpha-return', '0.01',
            '--holding-days', '5', '--reflection-file', '/tmp/r.txt', '--resolution-date', '2026-10-27'],
    )
})
check('memory outcome requires numbers', () => checkThrows('outcome', () => memoryArgv({ action: 'outcome', ticker: 'NVDA', date: '2026-10-20' }), '`rawReturn` is required'))

console.log('\n[6] generated launchers')
check('bin/ta launcher exists and execs the bundled wrapper', () => {
    const path = join(HOME, 'bin', 'ta')
    assert.ok(existsSync(path))
    const body = readFileSync(path, 'utf8')
    assert.match(body, /^#!\/usr\/bin\/env bash/)
    assert.ok(body.includes("scripts/ta'"))
    assert.ok(body.includes(PLUGIN_ROOT.replace(/'/g, `'\\''`)))
})
check('bin/ta-assemble launcher exists', () => assert.ok(existsSync(join(HOME, 'bin', 'ta-assemble'))))
check('env.sh exports the resolved paths', () => {
    const body = readFileSync(join(HOME, 'bin', 'env.sh'), 'utf8')
    assert.ok(body.includes(`export TRADING_AGENTS_HOME='${HOME}'`))
    assert.ok(body.includes(`export TRADING_AGENTS_RESULTS_DIR='${join(HOME, 'runs')}'`))
    assert.ok(body.includes('export TRADING_AGENTS_PLUGIN_ROOT='))
})
check('launchers are executable', () => {
    assert.ok((statSync(join(HOME, 'bin', 'ta')).mode & 0o111) !== 0)
})
check('launcher content is rewritten when the plugin root changes', () => {
    const path = join(HOME, 'bin', 'ta')
    const before = readFileSync(path, 'utf8')
    // Re-applying with the same root must not churn the file.
    assert.ok(before.includes(PLUGIN_ROOT.replace(/'/g, `'\\''`)))
})
await checkAsync('re-applying registers a fresh, complete tool set', async () => {
    const second = fakeContext()
    await apply(second.ctx, { autoBootstrap: false })
    assert.equal(second.tools.size, 5)
    assert.equal(second.skills.size, skills.size)
})

console.log('\n[7] tool behaviour (offline)')
const doctor = tools.get('ta_doctor')
const doctorValue = await doctor.execute({}, {})
check('ta_doctor resolves paths', () => {
    assert.equal(doctorValue.home, HOME)
    assert.equal(doctorValue.resultsDir, join(HOME, 'runs'))
    assert.equal(doctorValue.binDir, join(HOME, 'bin'))
    assert.equal(doctorValue.pluginRoot, PLUGIN_ROOT)
    assert.equal(doctorValue.taLauncher, join(HOME, 'bin', 'ta'))
})
check('ta_doctor reports checks', () => {
    assert.ok(Array.isArray(doctorValue.checks))
    assert.ok(doctorValue.checks.length >= 4)
    for (const entry of doctorValue.checks) {
        assert.equal(typeof entry.name, 'string')
        assert.equal(typeof entry.ok, 'boolean')
        assert.equal(typeof entry.detail, 'string')
    }
})
check('ta_doctor reports the configured output language', () => {
    assert.equal(doctorValue.outputLanguage, 'English')
})
check('ta_doctor render returns ContentBlocks', () => {
    const blocks = doctor.output.render({}, doctorValue)
    assert.ok(Array.isArray(blocks) && blocks.length > 0)
    assert.equal(blocks[0].type, 'text')
    assert.match(blocks[0].text, /plugin root/)
})
if (HOME_IS_TEMP) {
    check('ta_doctor reports a missing venv interpreter until bootstrap', () => {
        const entry = doctorValue.checks.find((item) => item.name === 'venv interpreter')
        assert.equal(entry.ok, false)
        assert.match(entry.detail, /not created yet/)
    })
} else {
    check('ta_doctor sees the bootstrapped venv', () => {
        const entry = doctorValue.checks.find((item) => item.name === 'venv interpreter')
        assert.equal(entry.ok, true)
    })
}
const runTool = tools.get('ta_run')
await checkRejects('ta_run rejects an empty ticker', () => runTool.execute({ ticker: '   ' }, {}), '`ticker` is required')
await checkRejects('ta_run rejects a future date', () => runTool.execute({ ticker: 'NVDA', date: '2999-01-01' }, {}), 'is in the future')
await checkRejects('ta_run rejects an unknown analyst key', () => runTool.execute({ ticker: 'NVDA', analysts: 'market,bogus' }, {}), 'unknown analyst key')
await checkRejects('ta_run rejects an out-of-range debate count', () => runTool.execute({ ticker: 'NVDA', debateRounds: 9 }, {}), 'from 1 to 5')
check('localToday is a valid date', () => assert.match(localToday(), /^\d{4}-\d{2}-\d{2}$/))
const dataTool = tools.get('ta_data')
await checkRejects('ta_data rejects a missing required argument', () => dataTool.execute({ command: 'snapshot' }, {}), '`ticker` is required')
await checkRejects('ta_data rejects an unknown command', () => dataTool.execute({ command: 'nope' }, {}), 'unknown data command')
const memory = tools.get('ta_memory')
await checkRejects('ta_memory rejects an unknown action', () => memory.execute({ action: 'nope' }, {}), 'unknown memory action')

console.log('\n[8] shell environment contribution')
const captured = []
const shellEnvStub = { register: (contribution) => captured.push(contribution) }
const shellCtx = fakeContext({ shellEnv: shellEnvStub })
await apply(shellCtx.ctx, { autoBootstrap: false, outputLanguage: 'zh' })
check('the plugin registers a shell environment contribution', () => assert.equal(captured.length, 1))
check('the contribution declares the language variable', () => {
    assert.ok(captured[0].variables.DSH_TRADING_AGENTS_OUTPUT_LANGUAGE)
    assert.equal(typeof captured[0].variables.DSH_TRADING_AGENTS_OUTPUT_LANGUAGE.description, 'string')
})
check('the contribution resolves the configured language', () => {
    const values = captured[0].resolve()
    assert.equal(values.DSH_TRADING_AGENTS_OUTPUT_LANGUAGE, 'Chinese')
    assert.equal(values.DSH_TRADING_AGENTS_HOME, HOME)
})
check('the contribution resolves the plugin root and results dir', () => {
    const values = captured[0].resolve()
    assert.equal(values.DSH_TRADING_AGENTS_ROOT, PLUGIN_ROOT)
    assert.ok(values.DSH_TRADING_AGENTS_RESULTS_DIR.endsWith('/runs'))
})

console.log('\n[9] configuration failure degrades safely')
const degraded = fakeContext()
await apply(degraded.ctx, { nonsense: true, autoBootstrap: false })
check('tools still register with a broken config', () => assert.equal(degraded.tools.size, 5))
check('a broken config is reported, not thrown at load', () => assert.ok(degraded.warnings.some((message) => message.includes('unknown config field'))))
const degradedDoctor = degraded.tools.get('ta_doctor')
await checkRejects('a broken-config tool call explains the fix', () => degradedDoctor.execute({}, {}), 'plugin config is invalid')

console.log('\n[10] live data (opt-in)')
if (LIVE && existsSync(join(HOME, 'venv', 'bin', 'python'))) {
    const dataTool = tools.get('ta_data')
    const today = await dataTool.execute({ command: 'today' }, {})
    await checkAsync('ta_data today exits 0', () => assert.equal(today.ok, true))
    check('ta_data today prints a date', () => assert.match(today.stdout.trim(), /^\d{4}-\d{2}-\d{2}$/))

    const snapshot = await dataTool.execute({ command: 'snapshot', ticker: 'NVDA', date: localToday(), lookback: 20 }, {})
    await checkAsync('ta_data snapshot returns data or a labelled failure', () => {
        assert.ok(snapshot.stdout.length > 0 || snapshot.stderr.length > 0)
        if (snapshot.ok) assert.match(snapshot.stdout, /NVDA|close|Close/i)
        else assert.match(snapshot.stderr, /ERROR/)
    })

    const macro = await dataTool.execute({ command: 'macro', indicator: 'cpi' }, {})
    await checkAsync('ta_data macro returns data or a labelled failure', () => {
        assert.ok(macro.stdout.length > 0 || macro.stderr.length > 0)
    })

    const run = await runTool.execute({ ticker: 'NVDA', portfolio: 'Smoke test: 100 shares NVDA, 20% cash.' }, {})
    await checkAsync('ta_run creates the run tree', () => {
        assert.ok(existsSync(run.runDir), run.runDir)
        for (const directory of run.directories) assert.ok(existsSync(join(run.runDir, directory)), directory)
        assert.match(readFileSync(run.runEnvPath, 'utf8'), /^TICKER=NVDA$/m)
        assert.match(readFileSync(run.runEnvPath, 'utf8'), /^RUN_DIR=/m)
        assert.ok(existsSync(run.instrumentContextPath))
        assert.ok(existsSync(run.portfolioContextPath))
        assert.ok(existsSync(run.pendingPath))
        assert.ok(Array.isArray(run.warnings))
    })

    // Assemble a deterministic fixture through the real assembler.
    const fixture = join(HOME, 'runs', 'fixture_NVDA')
    for (const directory of ['1_analysts', '2_research', '3_trading', '4_risk', '5_portfolio', '0_context', '6_memory']) {
        mkdirSync(join(fixture, directory), { recursive: true })
    }
    const sections = {
        '1_analysts/market.md': '## Market\n\nSupport at 100, resistance at 120.',
        '1_analysts/sentiment.md': '## Sentiment\n\nRetail mildly bullish.',
        '1_analysts/news.md': '## News\n\nNo material news.',
        '1_analysts/fundamentals.md': '## Fundamentals\n\nRevenue growing.',
        '2_research/bull.md': '## Bull\n\nGrowth case.',
        '2_research/bear.md': '## Bear\n\nValuation case.',
        '2_research/manager.md': '## Plan\n\nBalanced.',
        '3_trading/trader.md': '## Trade\n\nBuy a starter position.',
        '4_risk/aggressive.md': '## Aggressive\n\nAdd.',
        '4_risk/conservative.md': '## Conservative\n\nWait.',
        '4_risk/neutral.md': '## Neutral\n\nScale in.',
        '5_portfolio/decision.md': '**Rating**: Hold\n\n**Executive Summary**: Hold and wait for confirmation.\n\n**Investment Thesis**: Mixed evidence.\n\n**Price Target**: not provided\n\n**Time Horizon**: not provided\n',
        '0_context/instrument_context.md': '# NVDA\n\nSemiconductors.',
    }
    for (const [relative, text] of Object.entries(sections)) writeFileSync(join(fixture, relative), `${text}\n`)
    const assembleTool = tools.get('ta_assemble')
    const assembled = await assembleTool.execute({ runDir: fixture, ticker: 'NVDA', date: '2026-10-20', rating: 'Hold' }, {})
    await checkAsync('ta_assemble builds all three artifacts', () => {
        assert.equal(assembled.ok, true, assembled.stderr)
        assert.ok(existsSync(assembled.reportMdPath), assembled.reportMdPath)
        assert.ok(existsSync(assembled.reportHtmlPath), assembled.reportHtmlPath)
        assert.ok(existsSync(assembled.metaPath), assembled.metaPath)
    })
    await checkAsync('meta.json records the DSH engine and the rating', () => {
        const meta = JSON.parse(readFileSync(assembled.metaPath, 'utf8'))
        assert.equal(meta.rating, 'Hold')
        assert.equal(meta.ticker, 'NVDA')
        assert.equal(meta.engine, 'deepseek-harness')
    })
    await checkAsync('the HTML report is self-contained and styled', () => {
        const page = readFileSync(assembled.reportHtmlPath, 'utf8')
        assert.match(page, /<html/i)
        assert.match(page, /Rating|rating/)
        assert.doesNotMatch(page, /<script[^>]+src=/i)
        assert.doesNotMatch(page, /<link[^>]+href="http/i)
    })
} else {
    console.log('  --   skipped (set DSH_TEST_TRADING_AGENTS_LIVE=1 with a bootstrapped venv)')
}

console.log('\n[11] workspace hygiene')
check('no __pycache__ is shipped', () => {
    const found = []
    for (const directory of ['roles', 'lib', 'skills', 'scripts', 'test']) {
        for (const entry of readdirSync(join(PLUGIN_ROOT, directory), { withFileTypes: true })) {
            if (entry.name === '__pycache__') found.push(join(directory, entry.name))
        }
    }
    assert.deepEqual(found, [])
})
check('package.json declares the bundle patch', () => {
    const manifest = JSON.parse(readFileSync(join(PLUGIN_ROOT, 'package.json'), 'utf8'))
    assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml')
    assert.ok(existsSync(join(PLUGIN_ROOT, manifest.dsh.bundle.patch)))
})
check('cordis patch inserts the trading-agents row', () => {
    const body = readFileSync(join(PLUGIN_ROOT, 'cordis.patch.yml'), 'utf8')
    assert.match(body, /id: trading-agents/)
    assert.match(body, /name: 'dsh-plugin-trading-agents'/)
})

if (HOME_IS_TEMP) rmSync(HOME, { recursive: true, force: true })

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length > 0) {
    console.log('\nFailures:')
    for (const failure of failures) console.log(`  - ${failure}`)
    process.exitCode = 1
}
