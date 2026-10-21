/**
 * Filesystem layout for the trading-agents DSH plugin.
 *
 * One place resolves every path the plugin talks about, so the tools, the
 * launchers and the README cannot drift apart.
 *
 * @module dsh-plugin-trading-agents/paths
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { resolveHome, resolveResultsDir } from './config.js'

/** The package root: the directory holding package.json, lib/, scripts/, roles/, skills/. */
export const PLUGIN_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

/**
 * Resolves every path the plugin uses.
 *
 * @param config - the normalized config from `resolveConfig`.
 * @returns the absolute paths, plus the interpreter the operator chose.
 */
export function resolvePaths(config) {
    const home = resolveHome(config)
    // The workspace root is the directory the profile was launched from; the
    // pipeline always writes its run tree inside it because DSH's file policy
    // confines the agent's tools to the workspace.
    const workspace = process.cwd()
    const scripts = join(PLUGIN_ROOT, 'scripts')
    return Object.freeze({
        pluginRoot: PLUGIN_ROOT,
        workspace,
        home,
        resultsDir: resolveResultsDir(config, workspace),
        // A pinned results directory wins over the per-session workspace default.
        resultsDirExplicit: Boolean(
            (process.env.TRADING_AGENTS_RESULTS_DIR && process.env.TRADING_AGENTS_RESULTS_DIR.trim() !== '')
            || config.resultsDir !== '',
        ),
        binDir: join(home, 'bin'),
        venvDir: join(home, 'venv'),
        venvPython: join(home, 'venv', 'bin', 'python'),
        memoryPath: join(home, 'memory', 'trading_memory.md'),
        bootstrapLog: join(home, 'bootstrap.log'),
        python: resolvePython(config),
        scriptsDir: scripts,
        dataScript: join(scripts, 'ta_data.py'),
        assembleScript: join(scripts, 'assemble_report.py'),
        bootstrapScript: join(scripts, 'bootstrap.sh'),
        taScript: join(scripts, 'ta'),
        taAssembleScript: join(scripts, 'ta-assemble'),
        rolesDir: join(PLUGIN_ROOT, 'roles'),
        skillsDir: join(PLUGIN_ROOT, 'skills'),
        version: readVersion(),
    })
}

/**
 * Resolves the interpreter that creates the venv.
 *
 * Precedence: the plugin's `python` config, then `TRADING_AGENTS_PYTHON`, then
 * `python3` on `PATH`.
 *
 * The CPython that ships inside DeepSeek Harness.app is deliberately NOT a
 * default: it is a hardened, signed binary, and macOS library validation makes
 * it refuse to load the ad-hoc-signed extension modules in prebuilt wheels such
 * as numpy, so a venv created from it cannot import yfinance. Point `python` at
 * a normal Python 3.10+ installation instead; `python3` on `PATH` is that.
 *
 * @param config - the normalized config.
 * @returns the interpreter path or command name.
 */
export function resolvePython(config) {
    if (config.python !== '') return config.python
    const fromEnv = process.env.TRADING_AGENTS_PYTHON
    if (fromEnv && fromEnv.trim() !== '') return fromEnv.trim()
    return 'python3'
}

/**
 * Reads the package version so tool output can never drift from the manifest.
 *
 * @returns the version string, or `0.0.0` when the manifest is unreadable.
 */
function readVersion() {
    try {
        // Kept read-only and synchronous: this runs once at activation.
        return JSON.parse(readFileSync(join(PLUGIN_ROOT, 'package.json'), 'utf8')).version ?? '0.0.0'
    } catch {
        return '0.0.0'
    }
}
