/**
 * Configuration for the trading-agents DSH plugin.
 *
 * Everything is optional. Unknown keys are rejected so a typo fails loudly
 * instead of being silently ignored, but a bad config never breaks profile
 * startup: `lib/index.js` keeps the plugin loaded, keeps the tools visible, and
 * reports the exact problem on every call until it is fixed.
 *
 * The module has no `@deepseek-ai/*` imports, so the plugin resolves from a
 * profile's own `node_modules` with no peer packages.
 *
 * @module dsh-plugin-trading-agents/config
 */

import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'

/** Accepted defaults. Every field here is documented in the README. */
export const DEFAULTS = Object.freeze({
    /** Venv / memory log / launcher directory. Empty means resolve from the environment. */
    home: '',
    /**
     * Run directory root. Empty means `<workspace>/.trading-agents/runs`:
     * DSH sandboxes the agent's bash and write tools to the workspace, so the
     * run tree those tools create must live there.
     */
    resultsDir: '',
    /** Language every report's prose is written in. */
    outputLanguage: 'English',
    /** Trading days the settlement window waits for. */
    holdingDays: 5,
    /** Alpha benchmark symbol. Empty means the Python layer picks one by exchange suffix. */
    benchmark: '',
    /** Interpreter used to create the venv. Empty means `python3` on PATH. */
    python: '',
    /** Warm the venv when the plugin activates — the SessionStart-hook analog. */
    autoBootstrap: true,
    /** Cap on one bootstrap run. */
    bootstrapTimeoutMs: 300_000,
    /** Await the activation-time warm-up instead of backgrounding it. */
    bootstrapInline: false,
    /** Register the thirteen model-only role skills the pipeline dispatches to. */
    exposeRoleSkills: true,
    /** Extra environment variables handed to the Python layer. */
    env: {},
})

/** Canonical names for the languages operators most often type. */
const LANGUAGE_ALIASES = new Map([
    ['english', 'English'], ['en', 'English'], ['en-us', 'English'], ['en-gb', 'English'],
    ['chinese', 'Chinese'], ['zh', 'Chinese'], ['zh-cn', 'Chinese'], ['zh-hans', 'Chinese'],
    ['中文', 'Chinese'], ['简体中文', 'Chinese'], ['汉语', 'Chinese'],
    ['traditional chinese', 'Traditional Chinese'], ['zh-tw', 'Traditional Chinese'],
    ['zh-hk', 'Traditional Chinese'], ['zh-hant', 'Traditional Chinese'],
    ['繁體中文', 'Traditional Chinese'], ['繁体中文', 'Traditional Chinese'],
    ['japanese', 'Japanese'], ['ja', 'Japanese'], ['jp', 'Japanese'], ['日本語', 'Japanese'],
    ['korean', 'Korean'], ['ko', 'Korean'], ['kr', 'Korean'], ['한국어', 'Korean'],
    ['german', 'German'], ['de', 'German'], ['deutsch', 'German'],
    ['french', 'French'], ['fr', 'French'], ['français', 'French'], ['francais', 'French'],
    ['spanish', 'Spanish'], ['es', 'Spanish'], ['español', 'Spanish'], ['espanol', 'Spanish'],
    ['portuguese', 'Portuguese'], ['pt', 'Portuguese'], ['português', 'Portuguese'], ['portugues', 'Portuguese'],
    ['italian', 'Italian'], ['it', 'Italian'], ['italiano', 'Italian'],
    ['russian', 'Russian'], ['ru', 'Russian'], ['русский', 'Russian'],
    ['arabic', 'Arabic'], ['ar', 'Arabic'],
    ['hindi', 'Hindi'], ['hi', 'Hindi'],
])

/**
 * Resolves a language code or native name to the canonical name the report prose
 * instruction uses. Unknown values pass through unchanged, so a caller can ask for
 * e.g. `Traditional Chinese` or `English (concise)`.
 *
 * @param value - the operator's or caller's language value.
 * @returns the canonical language name.
 */
export function normalizeLanguage(value) {
    const text = String(value).trim()
    if (text === '') return text
    return LANGUAGE_ALIASES.get(text.toLowerCase()) ?? text
}

const KNOWN_KEYS = new Set(Object.keys(DEFAULTS))

/**
 * Raised for configuration problems, so tool results can distinguish an
 * operator mistake from a Python or network failure.
 */
export class ConfigError extends Error {
    /**
     * @param message - the human-readable problem plus how to fix it.
     */
    constructor(message) {
        super(message)
        this.name = 'ConfigError'
    }
}

/**
 * Expands a leading `~` and makes relative paths absolute against the workspace
 * default, matching how operators think about the two path fields.
 *
 * @param value - the raw path from config or the environment.
 * @param base - directory a relative path resolves against.
 * @returns an absolute path.
 */
export function expandPath(value, base = process.cwd()) {
    const text = String(value)
    if (text === '~') return homedir()
    if (text.startsWith('~/') || text.startsWith('~\\')) return join(homedir(), text.slice(2))
    return isAbsolute(text) ? resolve(text) : resolve(base, text)
}

/**
 * Resolves the harness home used to derive every other default.
 *
 * Precedence: `TRADING_AGENTS_HOME`, then `config.home`, then `$DSH_HOME/trading-agents`,
 * then `~/.dsh/trading-agents`.
 *
 * @param config - the normalized config.
 * @returns the absolute home directory.
 */
export function resolveHome(config) {
    const fromEnv = process.env.TRADING_AGENTS_HOME
    if (fromEnv && fromEnv.trim() !== '') return expandPath(fromEnv)
    if (config.home !== '') return expandPath(config.home)
    const dshHome = process.env.DSH_HOME && process.env.DSH_HOME.trim() !== ''
        ? process.env.DSH_HOME
        : join(homedir(), '.dsh')
    return expandPath(join(dshHome, 'trading-agents'))
}

/**
 * Resolves the run-directory root.
 *
 * Precedence: `TRADING_AGENTS_RESULTS_DIR`, then `config.resultsDir`, then
 * `<workspace>/.trading-agents/runs`.
 *
 * The default deliberately lives inside the workspace: DSH's default file policy
 * confines the agent's bash, read and write tools to the workspace, and the
 * pipeline's run tree is written by exactly those tools. Point this at a shared
 * directory only when the session runs with a wider file policy.
 *
 * @param config - the normalized config.
 * @param workspace - the absolute workspace root.
 * @returns the absolute results directory.
 */
export function resolveResultsDir(config, workspace) {
    const fromEnv = process.env.TRADING_AGENTS_RESULTS_DIR
    if (fromEnv && fromEnv.trim() !== '') return expandPath(fromEnv)
    if (config.resultsDir !== '') return expandPath(config.resultsDir)
    return join(workspace, '.trading-agents', 'runs')
}

/**
 * Asserts a value is a boolean, accepting the strings YAML users often write.
 *
 * @param key - field name, used in the error.
 * @param value - the raw value.
 * @returns the boolean value.
 */
function asBoolean(key, value) {
    if (typeof value === 'boolean') return value
    if (typeof value === 'string') {
        const lowered = value.trim().toLowerCase()
        if (['true', 'yes', 'on', '1'].includes(lowered)) return true
        if (['false', 'no', 'off', '0'].includes(lowered)) return false
    }
    throw new ConfigError(`\`${key}\` must be a boolean, got ${JSON.stringify(value)}`)
}

/**
 * Asserts a value is a positive integer.
 *
 * @param key - field name, used in the error.
 * @param value - the raw value.
 * @param minimum - smallest accepted value.
 * @returns the integer value.
 */
function asPositiveInteger(key, value, minimum = 1) {
    const number = typeof value === 'string' ? Number(value.trim()) : value
    if (!Number.isSafeInteger(number) || number < minimum) {
        throw new ConfigError(`\`${key}\` must be an integer greater than or equal to ${minimum}, got ${JSON.stringify(value)}`)
    }
    return number
}

/**
 * Asserts a value is a non-empty string.
 *
 * @param key - field name, used in the error.
 * @param value - the raw value.
 * @returns the trimmed string.
 */
function asString(key, value) {
    if (typeof value !== 'string') {
        throw new ConfigError(`\`${key}\` must be a string, got ${JSON.stringify(value)}`)
    }
    return value.trim()
}

/**
 * Validates the raw plugin config and fills in defaults.
 *
 * @param raw - the config object the loader handed to `apply`; may be undefined.
 * @returns a frozen, fully populated config object.
 * @throws {ConfigError} when a value is unusable.
 */
export function resolveConfig(raw) {
    if (raw === undefined || raw === null) raw = {}
    if (typeof raw !== 'object' || Array.isArray(raw)) {
        throw new ConfigError('plugin config must be a mapping of setting name to value')
    }

    /** @type {Record<string, unknown>} */
    const out = { ...DEFAULTS }
    const unknown = Object.keys(raw).filter((key) => !KNOWN_KEYS.has(key))
    if (unknown.length > 0) {
        throw new ConfigError(
            `unknown config ${unknown.length === 1 ? 'field' : 'fields'} ${unknown.map((key) => `\`${key}\``).join(', ')}; `
            + `accepted fields are ${[...KNOWN_KEYS].map((key) => `\`${key}\``).join(', ')}`,
        )
    }

    if (raw.home !== undefined) out.home = asString('home', raw.home)
    if (raw.resultsDir !== undefined) out.resultsDir = asString('resultsDir', raw.resultsDir)
    if (raw.outputLanguage !== undefined) {
        out.outputLanguage = normalizeLanguage(asString('outputLanguage', raw.outputLanguage))
        if (out.outputLanguage === '') throw new ConfigError('`outputLanguage` must not be empty; use e.g. `English` or `Chinese`')
        if (out.outputLanguage.length > 64) throw new ConfigError('`outputLanguage` must be at most 64 characters')
    }
    if (raw.holdingDays !== undefined) out.holdingDays = asPositiveInteger('holdingDays', raw.holdingDays)
    if (raw.benchmark !== undefined) out.benchmark = asString('benchmark', raw.benchmark)
    if (raw.python !== undefined) out.python = asString('python', raw.python)
    if (raw.autoBootstrap !== undefined) out.autoBootstrap = asBoolean('autoBootstrap', raw.autoBootstrap)
    if (raw.bootstrapTimeoutMs !== undefined) {
        out.bootstrapTimeoutMs = asPositiveInteger('bootstrapTimeoutMs', raw.bootstrapTimeoutMs, 1_000)
    }
    if (raw.bootstrapInline !== undefined) out.bootstrapInline = asBoolean('bootstrapInline', raw.bootstrapInline)
    if (raw.exposeRoleSkills !== undefined) out.exposeRoleSkills = asBoolean('exposeRoleSkills', raw.exposeRoleSkills)
    if (raw.env !== undefined) {
        if (typeof raw.env !== 'object' || raw.env === null || Array.isArray(raw.env)) {
            throw new ConfigError('`env` must be a mapping of environment variable name to string value')
        }
        /** @type {Record<string, string>} */
        const env = {}
        for (const [name, value] of Object.entries(raw.env)) {
            if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
                throw new ConfigError(`\`env\` key ${JSON.stringify(name)} is not a valid environment variable name`)
            }
            if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
                throw new ConfigError(`\`env.${name}\` must be a string, number or boolean`)
            }
            env[name] = String(value)
        }
        out.env = env
    }

    return Object.freeze(out)
}
