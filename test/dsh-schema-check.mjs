#!/usr/bin/env node
/**
 * Verifies this plugin against DSH's *real* tool registry validator instead of
 * the local mirror in `test/smoke.js`.
 *
 * DSH's `assertSupportedJsonSchema` is the exact check that rejects a schema at
 * profile-load time, and `validateJsonSchemaValue` is the exact check applied to
 * a declared output value, so running them here turns "the schemas look right"
 * into a definitive result.
 *
 * The DSH runtime lives inside `app.asar`, which only Electron's patched `fs`
 * can read, so this script must run through the packaged Electron binary in
 * Node mode:
 *
 *   ELECTRON_RUN_AS_NODE=1 "/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness" \
 *     test/dsh-schema-check.mjs
 *
 * @module dsh-plugin-trading-agents/test/dsh-schema-check
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ASAR_TOOLS = process.env.DSH_APP_ASAR
    ? `${process.env.DSH_APP_ASAR}/dsh/node_modules/@deepseek-ai/dsh-tools/lib/index.js`
    : '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-tools/lib/index.js'

/** Temp home so this check never touches the real data home. */
const HOME = mkdtempSync(join(tmpdir(), 'ta-schema-'))
process.env.TRADING_AGENTS_HOME = HOME
process.env.TRADING_AGENTS_RESULTS_DIR = join(HOME, 'runs')

let passed = 0
const failures = []

/**
 * Records one assertion.
 *
 * @param label - what was checked.
 * @param error - the thrown error, or undefined on success.
 */
function check(label, error) {
    if (error === undefined) {
        passed += 1
        console.log(`  ok   ${label}`)
    } else {
        failures.push(`${label} — ${error?.message ?? error}`)
        console.log(`  FAIL ${label} — ${error?.message ?? error}`)
    }
}

/**
 * Runs a thunk and returns the error it threw, if any.
 *
 * @param fn - the thunk to run.
 * @returns the thrown error, or undefined.
 */
function attempt(fn) {
    try {
        fn()
        return undefined
    } catch (error) {
        return error
    }
}

const { assertSupportedJsonSchema, validateJsonSchemaValue } = await import(ASAR_TOOLS)
console.log('loaded the DSH validator from app.asar\n')

const { apply } = await import('../lib/index.js')

/** @type {Map<string, any>} */
const tools = new Map()
const disposers = []
const warnings = []

await apply(
    {
        logger: {
            info: () => {},
            warn: (message) => warnings.push(String(message)),
            error: () => {},
        },
        tools: { register: (definition) => tools.set(definition.name, definition) },
        skills: { register: () => () => {} },
        effect: (callback) => {
            const disposer = callback()
            if (typeof disposer === 'function') disposers.push(disposer)
        },
    },
    { autoBootstrap: false },
)

console.log('[1] DSH assertSupportedJsonSchema on every declared schema')
for (const [toolName, definition] of tools) {
    check(`${toolName}.parameters`, attempt(() => assertSupportedJsonSchema(definition.parameters)))
    check(`${toolName}.output.schema`, attempt(() => assertSupportedJsonSchema(definition.output.schema)))
}

console.log('\n[2] live execute output validated against its declared output schema')
const liveCases = [
    ['ta_doctor', {}],
]
for (const [toolName, args] of liveCases) {
    const definition = tools.get(toolName)
    try {
        const value = await definition.execute(args, {})
        check(`${toolName}(${JSON.stringify(args)}) output is schema-valid`,
            attempt(() => validateJsonSchemaValue(definition.output.schema, value, 'value')))
        check(`${toolName} render returns ContentBlocks`,
            attempt(() => {
                const blocks = definition.output.render(args, value)
                if (!Array.isArray(blocks) || blocks.length === 0) throw new Error('render returned no blocks')
                for (const block of blocks) {
                    if (block?.type !== 'text' || typeof block.text !== 'string') {
                        throw new Error(`bad block ${JSON.stringify(block)?.slice(0, 80)}`)
                    }
                }
            }))
    } catch (error) {
        check(`${toolName} executed`, error)
    }
}

console.log('\n[3] validation-only tool outputs')
// These exercise the same canonical shapes the CLI tools return when the CLI
// exits non-zero, so schema/value drift is caught without network access.
const synthetic = [
    ['ta_data', 'ta_data', { command: 'today' }, { ok: false, exitCode: 1, stdout: '', stderr: 'ERROR: RuntimeError: offline' }],
    ['ta_memory', 'ta_memory', { action: 'list', pendingOnly: true }, { ok: true, exitCode: 0, stdout: '[]', stderr: '' }],
    [
        'ta_assemble',
        'ta_assemble',
        { runDir: '/tmp/run', ticker: 'NVDA', date: '2026-10-20', rating: 'Hold' },
        { ok: false, exitCode: 1, stdout: '', stderr: 'ERROR: missing decision', reportMdPath: '/tmp/run/complete_report.md', reportHtmlPath: '/tmp/run/complete_report.html', metaPath: '/tmp/run/meta.json' },
    ],
]
for (const [label, toolName, args, value] of synthetic) {
    const definition = tools.get(toolName)
    check(`${label} synthetic output is schema-valid`,
        attempt(() => validateJsonSchemaValue(definition.output.schema, value, 'value')))
    check(`${label} render accepts the synthetic output`,
        attempt(() => {
            const blocks = definition.output.render(args, value)
            if (!Array.isArray(blocks) || blocks.length === 0) throw new Error('render returned no blocks')
        }))
}

console.log('\n[4] ta_run output shape')
const runShape = {
    runDir: '/tmp/run',
    ticker: 'NVDA',
    date: '2026-10-20',
    analysts: 'market,social,news,fundamentals',
    debateRounds: 1,
    riskRounds: 1,
    language: 'English',
    assetType: 'stock',
    runEnvPath: '/tmp/run/run.env',
    instrumentContextPath: '/tmp/run/0_context/instrument_context.md',
    portfolioContextPath: '/tmp/run/0_context/portfolio.md',
    pendingPath: '/tmp/run/6_memory/pending.json',
    pendingReady: 0,
    directories: ['0_context'],
    warnings: [],
}
check('ta_run synthetic output is schema-valid',
    attempt(() => validateJsonSchemaValue(tools.get('ta_run').output.schema, runShape, 'value')))
check('ta_run render accepts the synthetic output',
    attempt(() => {
        const blocks = tools.get('ta_run').output.render({ ticker: 'NVDA' }, runShape)
        if (!Array.isArray(blocks) || blocks.length === 0) throw new Error('render returned no blocks')
    }))

for (const disposer of disposers) await disposer()
rmSync(HOME, { recursive: true, force: true })

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length > 0) {
    console.log('\nFailures:')
    for (const failure of failures) console.log(`  - ${failure}`)
    process.exit(1)
}
