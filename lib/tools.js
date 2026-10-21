/**
 * The tools the trading-agents plugin registers on `ctx.tools`.
 *
 * Schemas are written in the exact JSON Schema subset DSH's tool registry
 * enforces (`type`/`properties`/`required`/`additionalProperties`/`items`/
 * `enum`/`const` plus annotations). `required` is a string array on the object
 * node, never a per-property `required: true` shorthand, so the plugin needs no
 * `@deepseek-ai/*` import to be resolvable from a profile's node_modules.
 *
 * Every tool reports the CLI's real exit code and both streams. A failed read is
 * never replaced by an estimate: that rule is the whole point of the port.
 *
 * @module dsh-plugin-trading-agents/tools
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { ConfigError } from './config.js'

/** Largest stdout/stderr text a single tool result returns, in characters. */
const MAX_RESULT_CHARS = 60_000

/** Rating labels the portfolio manager may produce. */
const RATINGS = ['Buy', 'Overweight', 'Hold', 'Underweight', 'Sell', 'REVIEW']

/** Date-only shape accepted by every `date` argument. */
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/

/** Analyst keys accepted by ta_run / ta_assemble. */
const ANALYST_KEYS = ['market', 'social', 'news', 'fundamentals']

/**
 * Wraps one Markdown body in a text content block.
 *
 * @param body - the text to return.
 * @returns the ContentBlock array a tool render returns.
 */
const text = (body) => [{ type: 'text', text: body }]

/**
 * Truncates free text so one tool result cannot dominate the context window.
 *
 * @param value - the raw text.
 * @param max - maximum characters.
 * @returns the possibly truncated text.
 */
function clip(value, max = MAX_RESULT_CHARS) {
    const body = String(value ?? '')
    return body.length <= max ? body : `${body.slice(0, max)}\n\n…[truncated ${body.length - max} characters]`
}

/**
 * Returns today's date in the local time zone as `YYYY-MM-DD`.
 *
 * @returns the local date.
 */
function localToday() {
    const now = new Date()
    const pad = (value) => String(value).padStart(2, '0')
    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

/**
 * Returns a local `YYYYMMDD_HHMMSS` stamp for run directory names.
 *
 * @returns the local stamp.
 */
function localStamp() {
    const now = new Date()
    const pad = (value) => String(value).padStart(2, '0')
    return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_`
        + `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
}

/**
 * Asserts a value matches `YYYY-MM-DD`.
 *
 * @param label - argument name for the error.
 * @param value - the candidate.
 * @returns the value.
 */
function assertDate(label, value) {
    if (value === undefined) return undefined
    if (typeof value !== 'string' || !DATE_PATTERN.test(value)) {
        throw new ConfigError(`\`${label}\` must be a date in YYYY-MM-DD form, got ${JSON.stringify(value)}`)
    }
    return value
}

/**
 * Asserts a required non-empty string argument.
 *
 * @param label - argument name for the error.
 * @param value - the candidate.
 * @returns the trimmed value.
 */
function requireString(label, value) {
    if (typeof value !== 'string' || value.trim() === '') {
        throw new ConfigError(`\`${label}\` is required and must be a non-empty string`)
    }
    return value.trim()
}

/**
 * Describes the standard CLI-result surface shared by most tools.
 *
 * @param extra - additional named properties.
 * @returns the output JSON Schema.
 */
function processSchema(extra = {}) {
    return {
        type: 'object',
        additionalProperties: false,
        required: ['ok', 'exitCode', 'stdout', ...(extra.required ?? [])],
        properties: {
            ok: { type: 'boolean', description: 'True when the CLI exited 0.' },
            exitCode: { type: 'integer', description: 'The CLI exit code.' },
            stdout: { type: 'string', description: 'The CLI standard output, truncated when very large.' },
            stderr: { type: 'string', description: 'The CLI standard error tail, when non-empty.' },
            ...(extra.properties ?? {}),
        },
    }
}

/**
 * Renders a CLI result as a readable Markdown block.
 *
 * @param label - what ran.
 * @param value - the canonical tool value.
 * @returns ContentBlocks.
 */
function renderProcess(label, value) {
    const heading = value.ok
        ? `### ${label}`
        : `### ${label} — FAILED (exit ${value.exitCode})`
    const sections = [heading]
    const stdout = String(value.stdout ?? '').trim()
    if (stdout) sections.push(stdout)
    const stderr = String(value.stderr ?? '').trim()
    if (stderr) sections.push(`**stderr**\n\n\`\`\`\n${stderr}\n\`\`\``)
    if (!stdout && !stderr) sections.push('_no output_')
    for (const [key, entry] of Object.entries(value)) {
        if (['ok', 'exitCode', 'stdout', 'stderr'].includes(key)) continue
        if (entry === undefined || entry === null) continue
        sections.push(`**${key}**: ${typeof entry === 'string' ? entry : JSON.stringify(entry)}`)
    }
    return text(sections.join('\n\n'))
}

/**
 * Converts a finished process result into the canonical tool value.
 *
 * @param result - the process result from `runProcess`.
 * @returns the canonical value plus any extra fields.
 */
function fromProcess(result, extra = {}) {
    return {
        ok: result.code === 0,
        exitCode: result.code,
        stdout: clip(result.stdout),
        stderr: clip(result.stderr),
        ...extra,
    }
}

/**
 * Resolves the directory the pipeline should write run trees into.
 *
 * A pinned `resultsDir` (config or `TRADING_AGENTS_RESULTS_DIR`) wins. Otherwise
 * the root follows the **calling session's** working directory, which is what
 * DSH's file sandbox confines the agent's bash and write tools to — the Host
 * process's own cwd is the app launch directory and is not per session.
 *
 * @param ctx - the plugin context.
 * @param paths - resolved paths.
 * @param exec - the tool execution context; `exec.agent.session` selects the session.
 * @returns the absolute run-directory root.
 */
function resultsRoot(ctx, paths, exec) {
    if (paths.resultsDirExplicit) return paths.resultsDir
    try {
        const service = typeof ctx.get === 'function' ? ctx.get('workingDirectory') : undefined
        const session = exec?.agent?.session
        if (service && session && typeof service.get === 'function') {
            const directory = service.get(session)
            if (typeof directory === 'string' && directory !== '') {
                return join(directory, '.trading-agents', 'runs')
            }
        }
    } catch {
        // Fall back to the launch directory.
    }
    return paths.resultsDir
}

/**
 * Builds the argv for one data-layer subcommand.
 *
 * @param args - the validated tool arguments.
 * @returns the CLI argv after the script name.
 */
function dataArgv(args) {
    const command = args.command
    const ticker = args.ticker
    const date = args.date
    const flags = []
    if (date !== undefined) flags.push('--date', assertDate('date', date))

    switch (command) {
        case 'today':
            return ['today']
        case 'doctor':
            return ['doctor']
        case 'identity':
            return ['identity', requireString('ticker', ticker), ...flags, ...(args.assetType ? ['--asset-type', args.assetType] : [])]
        case 'quote': {
            const argv = ['quote', requireString('ticker', ticker), ...flags]
            if (args.start !== undefined) argv.push('--start', assertDate('start', args.start))
            if (args.days !== undefined) argv.push('--days', String(args.days))
            return argv
        }
        case 'snapshot': {
            const argv = ['snapshot', requireString('ticker', ticker), ...flags]
            if (args.lookback !== undefined) argv.push('--lookback', String(args.lookback))
            return argv
        }
        case 'indicator': {
            const argv = ['indicator', requireString('ticker', ticker), ...flags, '--names', requireString('names', args.names)]
            if (args.lookback !== undefined) argv.push('--lookback', String(args.lookback))
            return argv
        }
        case 'fundamentals':
            return ['fundamentals', requireString('ticker', ticker), ...flags]
        case 'statement': {
            const argv = [
                'statement',
                requireString('ticker', ticker),
                '--kind',
                requireString('kind', args.kind),
                '--freq',
                args.freq ?? 'quarterly',
                ...flags,
            ]
            return argv
        }
        case 'insiders':
            return ['insiders', requireString('ticker', ticker), ...flags]
        case 'news': {
            const argv = ['news', requireString('ticker', ticker), ...flags]
            if (args.start !== undefined) argv.push('--start', assertDate('start', args.start))
            if (args.end !== undefined) argv.push('--end', assertDate('end', args.end))
            if (args.days !== undefined) argv.push('--days', String(args.days))
            if (args.limit !== undefined) argv.push('--limit', String(args.limit))
            return argv
        }
        case 'global-news': {
            const argv = ['global-news', ...flags]
            if (args.lookback !== undefined) argv.push('--lookback', String(args.lookback))
            if (args.limit !== undefined) argv.push('--limit', String(args.limit))
            return argv
        }
        case 'macro': {
            const argv = ['macro', requireString('indicator', args.indicator), ...flags]
            if (args.lookback !== undefined) argv.push('--lookback', String(args.lookback))
            return argv
        }
        case 'prediction': {
            const argv = ['prediction', requireString('topic', args.topic), ...flags]
            if (args.limit !== undefined) argv.push('--limit', String(args.limit))
            return argv
        }
        case 'sentiment': {
            const argv = ['sentiment', requireString('ticker', ticker), ...flags]
            if (args.limit !== undefined) argv.push('--limit', String(args.limit))
            return argv
        }
        case 'futu': {
            const argv = ['futu', requireString('ticker', ticker), ...flags]
            if (args.limit !== undefined) argv.push('--limit', String(args.limit))
            return argv
        }
        default:
            throw new ConfigError(`unknown data command ${JSON.stringify(command)}`)
    }
}

/**
 * Builds the argv for one memory subcommand.
 *
 * @param args - the validated tool arguments.
 * @returns the CLI argv after the script name.
 */
function memoryArgv(args) {
    const action = args.action
    switch (action) {
        case 'context': {
            const argv = ['memory', 'context', requireString('ticker', args.ticker)]
            if (args.asOf !== undefined) argv.push('--as-of', assertDate('asOf', args.asOf))
            return argv
        }
        case 'store':
            return [
                'memory', 'store', requireString('ticker', args.ticker),
                '--date', assertDate('date', args.date) ?? requireString('date', args.date),
                '--rating', requireString('rating', args.rating),
                '--decision-file', requireString('decisionFile', args.decisionFile),
                ...(args.replace ? ['--replace'] : []),
            ]
        case 'list':
            return ['memory', 'list', ...(args.pendingOnly ? ['--pending-only'] : [])]
        case 'settle':
            return ['memory', 'settle', ...(args.ticker ? ['--ticker', requireString('ticker', args.ticker)] : [])]
        case 'outcome': {
            if (typeof args.rawReturn !== 'number') throw new ConfigError('`rawReturn` is required and must be a number')
            if (typeof args.alphaReturn !== 'number') throw new ConfigError('`alphaReturn` is required and must be a number')
            if (typeof args.holdingDays !== 'number') throw new ConfigError('`holdingDays` is required and must be an integer')
            const argv = [
                'memory', 'outcome', requireString('ticker', args.ticker),
                '--date', assertDate('date', args.date) ?? requireString('date', args.date),
                '--raw-return', String(args.rawReturn),
                '--alpha-return', String(args.alphaReturn),
                '--holding-days', String(args.holdingDays),
                '--reflection-file', requireString('reflectionFile', args.reflectionFile),
            ]
            if (args.resolutionDate !== undefined) argv.push('--resolution-date', assertDate('resolutionDate', args.resolutionDate))
            return argv
        }
        default:
            throw new ConfigError(`unknown memory action ${JSON.stringify(action)}`)
    }
}

/**
 * Builds the `ta_doctor` tool.
 *
 * @param bridge - the Python bridge.
 * @param paths - resolved paths.
 * @param config - normalized config.
 * @returns the tool definition.
 */
function doctorTool(ctx, bridge, paths, config) {
    return {
        name: 'ta_doctor',
        description: 'Report the trading-agents environment (plugin root, data home, results directory, launcher paths, venv state, Python interpreter) and optionally probe data-source connectivity. Call this when a ta_* tool fails or when a bash block needs the exact launcher path.',
        parameters: {
            type: 'object',
            additionalProperties: false,
            properties: {
                connectivity: {
                    type: 'boolean',
                    description: 'Also run the data layer\'s own doctor, which probes Yahoo Finance, FRED and the other public endpoints. Defaults to false because it needs network access.',
                },
            },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                required: ['version', 'pluginRoot', 'home', 'resultsDir', 'binDir', 'venvPython', 'python', 'memoryPath', 'checks'],
                properties: {
                    version: { type: 'string' },
                    pluginRoot: { type: 'string' },
                    home: { type: 'string' },
                    resultsDir: { type: 'string' },
                    binDir: { type: 'string' },
                    taLauncher: { type: 'string' },
                    venvPython: { type: 'string' },
                    python: { type: 'string' },
                    memoryPath: { type: 'string' },
                    outputLanguage: { type: 'string' },
                    checks: {
                        type: 'array',
                        items: {
                            type: 'object',
                            additionalProperties: false,
                            required: ['name', 'ok', 'detail'],
                            properties: {
                                name: { type: 'string' },
                                ok: { type: 'boolean' },
                                detail: { type: 'string' },
                            },
                        },
                    },
                    connectivity: { type: 'string' },
                },
            },
            render: (_args, value) => text([
                `## trading-agents ${value.version}`,
                '',
                `- **plugin root**: \`${value.pluginRoot}\``,
                `- **data home**: \`${value.home}\``,
                `- **results**: \`${value.resultsDir}\``,
                `- **launchers**: \`${value.taLauncher}\` (and \`ta-assemble\` beside it)`,
                `- **venv python**: \`${value.venvPython}\``,
                `- **python**: \`${value.python}\``,
                `- **memory log**: \`${value.memoryPath}\``,
                `- **output language**: ${value.outputLanguage}`,
                '',
                '| check | state | detail |',
                '| --- | --- | --- |',
                ...value.checks.map((check) => `| ${check.name} | ${check.ok ? 'ok' : 'FAIL'} | ${String(check.detail).replace(/\|/g, '\\|').replace(/\n/g, ' ')} |`),
                '',
                value.connectivity ? `### connectivity\n\n\`\`\`\n${value.connectivity}\n\`\`\`\n` : '',
            ].join('\n')),
        },
        async execute(args, exec) {
            const diagnosis = await bridge.diagnose()
            const resultsDir = resultsRoot(ctx, paths, exec)
            let connectivity
            if (args.connectivity) {
                try {
                    const result = await bridge.runData(['doctor'], { timeoutMs: 120_000, signal: exec?.signal })
                    connectivity = clip([result.stdout, result.stderr].filter((part) => part.trim()).join('\n'))
                } catch (error) {
                    connectivity = `connectivity probe failed: ${error?.message ?? error}`
                }
            }
            return {
                version: diagnosis.version,
                pluginRoot: diagnosis.pluginRoot,
                home: diagnosis.home,
                resultsDir,
                binDir: diagnosis.binDir,
                taLauncher: join(diagnosis.binDir, 'ta'),
                venvPython: diagnosis.venvPython,
                python: diagnosis.python,
                memoryPath: diagnosis.memoryPath,
                outputLanguage: config.outputLanguage,
                checks: diagnosis.checks,
                ...(connectivity === undefined ? {} : { connectivity }),
            }
        },
        presentCall: () => ({ card: 'generic', title: 'Inspect trading-agents environment', kind: 'other' }),
        isConcurrencySafe: () => true,
    }
}

/**
 * Builds the `ta_run` tool: the deterministic setup step of the pipeline.
 *
 * @param bridge - the Python bridge.
 * @param paths - resolved paths.
 * @param config - normalized config.
 * @returns the tool definition.
 */
function runTool(ctx, bridge, paths, config) {
    return {
        name: 'ta_run',
        description: 'Create a trading-agents run directory and its context: the 0_context…6_memory tree, run.env, the instrument context (identity lookup), the portfolio context, and the pending-settlement list. Returns every path the pipeline and its subagents need. Pass those paths on; never inline report bodies.',
        parameters: {
            type: 'object',
            additionalProperties: false,
            required: ['ticker'],
            properties: {
                ticker: { type: 'string', description: 'Instrument symbol; preserve exchange suffixes (700.HK, 7203.T, BTC-USD).' },
                date: { type: 'string', description: 'Analysis date in YYYY-MM-DD; defaults to today, local time.' },
                analysts: { type: 'string', description: `Comma-separated analyst keys from ${ANALYST_KEYS.join(', ')}; defaults to all four.` },
                debateRounds: { type: 'integer', description: 'Bull+bear rounds; defaults to 1.' },
                riskRounds: { type: 'integer', description: 'Aggressive+conservative+neutral rounds; defaults to 1.' },
                language: { type: 'string', description: 'Report prose language (e.g. English, Chinese). Defaults to the configured output language.' },
                portfolio: { type: 'string', description: 'Free text describing holdings, cash and constraints, if the caller supplied any.' },
                assetType: { type: 'string', enum: ['stock', 'crypto'], description: 'Asset class; defaults to crypto for -USD symbols and stock otherwise.' },
            },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                required: ['runDir', 'ticker', 'date', 'analysts', 'debateRounds', 'riskRounds', 'language', 'runEnvPath', 'instrumentContextPath', 'portfolioContextPath', 'pendingPath', 'pendingReady', 'directories', 'warnings'],
                properties: {
                    runDir: { type: 'string' },
                    ticker: { type: 'string' },
                    date: { type: 'string' },
                    analysts: { type: 'string' },
                    debateRounds: { type: 'integer' },
                    riskRounds: { type: 'integer' },
                    language: { type: 'string' },
                    assetType: { type: 'string' },
                    runEnvPath: { type: 'string' },
                    instrumentContextPath: { type: 'string' },
                    portfolioContextPath: { type: 'string' },
                    pendingPath: { type: 'string' },
                    pendingReady: { type: 'integer' },
                    directories: { type: 'array', items: { type: 'string' } },
                    warnings: { type: 'array', items: { type: 'string' } },
                },
            },
            render: (_args, value) => text([
                `## Run created: \`${value.runDir}\``,
                '',
                '| field | value |',
                '| --- | --- |',
                `| ticker | ${value.ticker} |`,
                `| date | ${value.date} |`,
                `| analysts | ${value.analysts} |`,
                `| debate rounds | ${value.debateRounds} |`,
                `| risk rounds | ${value.riskRounds} |`,
                `| language | ${value.language} |`,
                `| pending settlements ready | ${value.pendingReady} |`,
                '',
                `- instrument context: \`${value.instrumentContextPath}\``,
                `- portfolio context: \`${value.portfolioContextPath}\``,
                `- run env: \`${value.runEnvPath}\``,
                `- pending settlements: \`${value.pendingPath}\``,
                '',
                value.pendingReady > 0
                    ? 'Past decisions are due. Spawn the memory reflector alongside the analysts.'
                    : 'No past decision is due; skip the memory reflector.',
                ...(value.warnings.length > 0 ? ['', '**warnings**', ...value.warnings.map((warning) => `- ${warning}`)] : []),
            ].join('\n')),
        },
        async execute(args, exec) {
            const ticker = requireString('ticker', args.ticker)
            const date = args.date === undefined ? localToday() : assertDate('date', args.date)
            if (date > localToday()) throw new ConfigError(`\`date\` ${date} is in the future; choose today or an earlier date`)
            const analysts = args.analysts === undefined
                ? ANALYST_KEYS.join(',')
                : String(args.analysts).split(',').map((key) => key.trim()).filter(Boolean)
                    .map((key) => {
                        if (!ANALYST_KEYS.includes(key)) {
                            throw new ConfigError(`unknown analyst key ${JSON.stringify(key)}; choose from ${ANALYST_KEYS.join(', ')}`)
                        }
                        return key
                    })
                    .join(',')
            const debateRounds = args.debateRounds ?? 1
            const riskRounds = args.riskRounds ?? 1
            if (!Number.isInteger(debateRounds) || debateRounds < 1 || debateRounds > 5) {
                throw new ConfigError('`debateRounds` must be an integer from 1 to 5')
            }
            if (!Number.isInteger(riskRounds) || riskRounds < 1 || riskRounds > 5) {
                throw new ConfigError('`riskRounds` must be an integer from 1 to 5')
            }
            const language = args.language?.trim() || config.outputLanguage
            const assetType = args.assetType ?? (ticker.toUpperCase().endsWith('-USD') ? 'crypto' : 'stock')

            const warnings = []
            await bridge.ensureReady({ signal: exec?.signal })

            const runRoot = resultsRoot(ctx, paths, exec)
            const safe = ticker.replace(/[^A-Za-z0-9.^=_-]+/g, '_')
            let runDir = join(runRoot, `${safe}_${localStamp()}`)
            for (let suffix = 2; existsSync(runDir); suffix += 1) {
                runDir = join(runRoot, `${safe}_${localStamp()}_${suffix}`)
            }
            const directories = ['0_context', '1_analysts', '2_research', join('2_research', 'debate'), '3_trading', '4_risk', join('4_risk', 'debate'), '5_portfolio', '6_memory']
            for (const directory of directories) mkdirSync(join(runDir, directory), { recursive: true })

            const runEnvPath = join(runDir, 'run.env')
            writeFileSync(runEnvPath, [
                `TICKER=${ticker}`,
                `DATE=${date}`,
                `ANALYSTS=${analysts}`,
                `DEBATE_ROUNDS=${debateRounds}`,
                `RISK_ROUNDS=${riskRounds}`,
                `LANGUAGE=${language}`,
                `ASSET_TYPE=${assetType}`,
                `RUN_DIR=${runDir}`,
                '',
            ].join('\n'))

            const instrumentContextPath = join(runDir, '0_context', 'instrument_context.md')
            const identity = await bridge.runData(['identity', ticker, '--date', date, '--asset-type', assetType], {
                timeoutMs: 180_000,
                signal: exec?.signal,
            })
            if (identity.code === 0) {
                writeFileSync(instrumentContextPath, identity.stdout)
            } else {
                warnings.push(`identity lookup failed (exit ${identity.code}): ${identity.stderr.trim().split('\n').slice(-3).join(' ')}`)
                writeFileSync(instrumentContextPath, `# Instrument context unavailable\n\nTicker: ${ticker}\nAnalysis date: ${date}\n\nThe identity lookup failed, so company name, sector and exchange are unknown for this run.\n\n\`\`\`\n${identity.stderr.trim()}\n\`\`\`\n`)
            }

            const portfolioContextPath = join(runDir, '0_context', 'portfolio.md')
            const portfolioText = typeof args.portfolio === 'string' && args.portfolio.trim() !== ''
                ? args.portfolio.trim()
                : 'Portfolio context: not provided. You do not know the caller\'s current holdings or cash, so do not assume a flat book; give direction and sizing guidance in terms the caller can apply to their own position.'
            writeFileSync(portfolioContextPath, `${portfolioText}\n`)

            const pendingPath = join(runDir, '6_memory', 'pending.json')
            const settle = await bridge.runData(['memory', 'settle', '--ticker', ticker], {
                timeoutMs: 180_000,
                signal: exec?.signal,
            })
            let pendingReady = 0
            if (settle.code === 0) {
                writeFileSync(pendingPath, settle.stdout)
                try {
                    const parsed = JSON.parse(settle.stdout)
                    if (Array.isArray(parsed)) pendingReady = parsed.filter((entry) => entry?.status === 'ready').length
                } catch {
                    warnings.push('the pending-settlement output was not valid JSON; treat every item as waiting')
                }
            } else {
                warnings.push(`memory settle failed (exit ${settle.code}): ${settle.stderr.trim().split('\n').slice(-3).join(' ')}`)
                writeFileSync(pendingPath, '[]\n')
            }

            writeFileSync(join(runDir, '2_research', 'debate', 'history.md'), '')
            writeFileSync(join(runDir, '4_risk', 'debate', 'history.md'), '')
            writeFileSync(join(runDir, '0_context', 'past_context.md'), '## Past context\n\nRefresh this after the analyst step: `memory context <TICKER>` writes the lessons from resolved decisions.\n')

            return {
                runDir,
                ticker,
                date,
                analysts,
                debateRounds,
                riskRounds,
                language,
                assetType,
                runEnvPath,
                instrumentContextPath,
                portfolioContextPath,
                pendingPath,
                pendingReady,
                directories,
                warnings,
            }
        },
        presentCall: () => ({ card: 'generic', title: 'Create trading-agents run', kind: 'other' }),
        isConcurrencySafe: () => false,
    }
}

/**
 * Builds the `ta_data` tool.
 *
 * @param bridge - the Python bridge.
 * @returns the tool definition.
 */
function dataTool(bridge) {
    return {
        name: 'ta_data',
        description: 'Read keyless market data through the bundled trading-agents data layer: instrument identity, OHLCV quotes, a verified snapshot with indicators, technical indicators, fundamentals, statements, insider transactions, ticker/global news, FRED macro series, Polymarket odds, and StockTwits/Reddit/Futu social sentiment. Missing data comes back as an explicit placeholder, never an estimate.',
        parameters: {
            type: 'object',
            additionalProperties: false,
            required: ['command'],
            properties: {
                command: {
                    type: 'string',
                    enum: ['today', 'identity', 'quote', 'snapshot', 'indicator', 'fundamentals', 'statement', 'insiders', 'news', 'global-news', 'macro', 'prediction', 'sentiment', 'futu'],
                    description: 'Which read to run.',
                },
                ticker: { type: 'string', description: 'Instrument symbol; preserve exchange suffixes.' },
                date: { type: 'string', description: 'Analysis date in YYYY-MM-DD; defaults to today.' },
                start: { type: 'string', description: 'Window start date in YYYY-MM-DD.' },
                end: { type: 'string', description: 'Window end date in YYYY-MM-DD (news only).' },
                days: { type: 'integer', description: 'Window length in calendar days (quote, news).' },
                lookback: { type: 'integer', description: 'Lookback in days or bars (snapshot, indicator, global-news, macro).' },
                names: { type: 'string', description: 'Comma-separated indicator names (indicator command): close_50_sma, close_200_sma, close_10_ema, macd, macds, macdh, rsi, boll, boll_ub, boll_lb, atr, vwma.' },
                kind: { type: 'string', enum: ['balance', 'cashflow', 'income'], description: 'Statement kind (statement command).' },
                freq: { type: 'string', enum: ['quarterly', 'annual'], description: 'Statement frequency; defaults to quarterly.' },
                limit: { type: 'integer', description: 'Maximum items (news, global-news, prediction, sentiment, futu).' },
                indicator: { type: 'string', description: 'Macro series (macro command): cpi, core_pce, unemployment, fed_funds_rate, 10y_treasury, yield_curve, real_gdp, vix, ecb_deposit_rate, euro_hicp, euro_core_hicp, euro_real_gdp, germany_10y, france_10y, eur_usd, or a raw FRED series id.' },
                topic: { type: 'string', description: 'Prediction-market topic (prediction command).' },
                assetType: { type: 'string', enum: ['stock', 'crypto'], description: 'Asset class (identity command).' },
            },
        },
        output: {
            schema: processSchema(),
            render: (args, value) => renderProcess(`ta_data ${args.command}`, value),
        },
        async execute(args, exec) {
            const argv = dataArgv(args)
            const result = await bridge.runData(argv, { signal: exec?.signal })
            return fromProcess(result)
        },
        presentCall: (args) => ({ card: 'generic', title: `Read market data (${args.command})`, kind: 'other' }),
        isConcurrencySafe: () => true,
    }
}

/**
 * Builds the `ta_memory` tool.
 *
 * @param bridge - the Python bridge.
 * @returns the tool definition.
 */
function memoryTool(bridge) {
    return {
        name: 'ta_memory',
        description: 'Read and write the shared trading-agents memory log: lessons from resolved past decisions, appending this run\'s decision as pending, listing entries, scoring decisions whose holding window has traded, and recording a reflection for a settled entry.',
        parameters: {
            type: 'object',
            additionalProperties: false,
            required: ['action'],
            properties: {
                action: { type: 'string', enum: ['context', 'store', 'list', 'settle', 'outcome'], description: 'Memory operation.' },
                ticker: { type: 'string', description: 'Instrument symbol (context, store, settle filter, outcome).' },
                asOf: { type: 'string', description: 'Only use lessons known by this date (context).' },
                date: { type: 'string', description: 'Decision date (store, outcome).' },
                rating: { type: 'string', enum: RATINGS, description: 'Decision rating (store).' },
                decisionFile: { type: 'string', description: 'Path to the decision file (store).' },
                replace: { type: 'boolean', description: 'Rewrite an existing pending entry for the same ticker and date (store).' },
                pendingOnly: { type: 'boolean', description: 'List only unresolved entries (list).' },
                rawReturn: { type: 'number', description: 'Holding-window raw return as a fraction (outcome).' },
                alphaReturn: { type: 'number', description: 'Holding-window return relative to the benchmark (outcome).' },
                holdingDays: { type: 'integer', description: 'Holding-window length in trading days (outcome).' },
                resolutionDate: { type: 'string', description: 'Date the holding window ended (outcome).' },
                reflectionFile: { type: 'string', description: 'Path to the reflection text (outcome).' },
            },
        },
        output: {
            schema: processSchema(),
            render: (args, value) => renderProcess(`ta_memory ${args.action}`, value),
        },
        async execute(args, exec) {
            const argv = memoryArgv(args)
            const result = await bridge.runData(argv, { signal: exec?.signal })
            return fromProcess(result)
        },
        presentCall: (args) => ({ card: 'generic', title: `Memory ${args.action}`, kind: 'other' }),
        isConcurrencySafe: () => false,
    }
}

/**
 * Builds the `ta_assemble` tool.
 *
 * @param bridge - the Python bridge.
 * @returns the tool definition.
 */
function assembleTool(bridge, config) {
    return {
        name: 'ta_assemble',
        description: 'Assemble a finished run directory into reader-facing artifacts: complete_report.md, a self-contained styled complete_report.html, and meta.json (ticker, date, rating, sections, data gaps, version). Run it after the portfolio manager has written 5_portfolio/decision.md.',
        parameters: {
            type: 'object',
            additionalProperties: false,
            required: ['runDir', 'ticker', 'date', 'rating'],
            properties: {
                runDir: { type: 'string', description: 'Absolute run directory path.' },
                ticker: { type: 'string', description: 'Instrument symbol as the caller named it.' },
                date: { type: 'string', description: 'Analysis date in YYYY-MM-DD.' },
                rating: { type: 'string', enum: RATINGS, description: 'The rating read verbatim from the decision file.' },
                analysts: { type: 'string', description: `Comma-separated analyst keys from ${ANALYST_KEYS.join(', ')}.` },
                debateRounds: { type: 'integer', description: 'Bull+bear rounds actually run.' },
                riskRounds: { type: 'integer', description: 'Risk rounds actually run.' },
                language: { type: 'string', description: 'Language the reports were written in.' },
            },
        },
        output: {
            schema: processSchema({
                required: ['reportMdPath', 'reportHtmlPath', 'metaPath'],
                properties: {
                    reportMdPath: { type: 'string' },
                    reportHtmlPath: { type: 'string' },
                    metaPath: { type: 'string' },
                    meta: { type: 'string', description: 'The meta.json document, when it was written.' },
                },
            }),
            render: (args, value) => {
                const base = renderProcess('ta_assemble', value)
                if (!value.ok) return base
                return text([
                    `## Report assembled: ${value.meta?.match(/"rating":\s*"([^"]+)"/)?.[1] ?? args.rating}`,
                    '',
                    `- **Markdown**: \`${value.reportMdPath}\``,
                    `- **HTML** (open this one): \`${value.reportHtmlPath}\``,
                    `- **metadata**: \`${value.metaPath}\``,
                    '',
                    base[0].text,
                ].join('\n'))
            },
        },
        async execute(args, exec) {
            const argv = [
                '--run-dir', requireString('runDir', args.runDir),
                '--ticker', requireString('ticker', args.ticker),
                '--date', assertDate('date', args.date) ?? requireString('date', args.date),
                '--rating', requireString('rating', args.rating),
                '--analysts', args.analysts?.trim() || ANALYST_KEYS.join(','),
                '--debate-rounds', String(args.debateRounds ?? 1),
                '--risk-rounds', String(args.riskRounds ?? 1),
                '--language', args.language?.trim() || config.outputLanguage,
            ]
            const result = await bridge.runAssemble(argv, { signal: exec?.signal })
            const reportMdPath = join(args.runDir, 'complete_report.md')
            const reportHtmlPath = join(args.runDir, 'complete_report.html')
            const metaPath = join(args.runDir, 'meta.json')
            let meta
            try {
                meta = readFileSync(metaPath, 'utf8')
            } catch {
                meta = undefined
            }
            return fromProcess(result, { reportMdPath, reportHtmlPath, metaPath, ...(meta === undefined ? {} : { meta: clip(meta, 8_000) }) })
        },
        presentCall: () => ({ card: 'generic', title: 'Assemble trading-agents report', kind: 'other' }),
        isConcurrencySafe: () => false,
    }
}

/**
 * Builds every tool definition the plugin registers.
 *
 * @param bridge - the Python bridge.
 * @param paths - resolved paths.
 * @param config - normalized config.
 * @returns the tool definitions in registration order.
 */
export function buildTools({ ctx, bridge, paths, config }) {
    return [
        doctorTool(ctx, bridge, paths, config),
        runTool(ctx, bridge, paths, config),
        dataTool(bridge),
        memoryTool(bridge),
        assembleTool(bridge, config),
    ]
}

export { MAX_RESULT_CHARS, RATINGS, ANALYST_KEYS, localToday, localStamp, dataArgv, memoryArgv }
