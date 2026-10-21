/**
 * DSH plugin entry for the trading-agents bundle.
 *
 * The plugin is intentionally dependency-light: it imports only `node:` builtins
 * and registers tools on `ctx.tools` plus skills on `ctx.skills`, so it needs no
 * `@deepseek-ai/*` peer package to be resolvable from a profile's own
 * `node_modules`.
 *
 * Config shape (every field optional):
 *
 * ```yaml
 * - id: trading-agents
 *   name: dsh-plugin-trading-agents
 *   config:
 *     resultsDir: /absolute/runs
 *     outputLanguage: English
 *     holdingDays: 5
 *     autoBootstrap: true
 * ```
 *
 * @module dsh-plugin-trading-agents
 */

import { ConfigError, resolveConfig } from './config.js'
import { resolvePaths } from './paths.js'
import { PythonBridge } from './python.js'
import { collectSkills, registerSkills } from './skills.js'
import { buildTools } from './tools.js'

/** Loader-facing plugin name. */
export const name = 'trading-agents'

/** This plugin needs the tool registry and the skill registry. */
export const inject = ['tools', 'skills']

/**
 * Replaces every bridge method with one that reports the configuration problem,
 * so a typo degrades to a clear tool error instead of failing the whole profile
 * load. The tools stay visible, which is what lets the model explain the fix.
 *
 * @param bridge - the real bridge to cripple.
 * @param message - the configuration problem to report on every call.
 */
function breakBridge(bridge, message) {
    const fail = async () => {
        throw new ConfigError(
            `trading-agents is not usable because its plugin config is invalid: ${message}. `
            + 'Fix the `config` block of the `trading-agents` row in your profile\'s cordis.patch.yml and reload the profile.',
        )
    }
    bridge.ensureReady = fail
    bridge.runData = fail
    bridge.runAssemble = fail
    bridge.diagnose = fail
    bridge.writeLaunchers = () => {}
}

/**
 * Contributes the plugin's paths to the agent's shell environment when the
 * profile mounts `dsh-shell-env`. Skills then read `$DSH_TRADING_AGENTS_HOME`
 * instead of re-deriving the data home from three variables.
 *
 * @param ctx - the plugin context.
 * @param paths - the resolved paths.
 * @param config - the normalized config, which owns the output language.
 */
function registerShellEnv(ctx, paths, config) {
    /** @type {any} */
    let shellEnv
    try {
        shellEnv = typeof ctx.get === 'function' ? ctx.get('shellEnv') : undefined
    } catch {
        shellEnv = undefined
    }
    if (!shellEnv || typeof shellEnv.register !== 'function') return
    try {
        shellEnv.register({
            name: 'trading-agents',
            variables: {
                DSH_TRADING_AGENTS_ROOT: { description: 'Bundled trading-agents plugin root.' },
                DSH_TRADING_AGENTS_HOME: { description: 'trading-agents data home: venv, memory log and launchers.' },
                DSH_TRADING_AGENTS_RESULTS_DIR: { description: 'trading-agents run-directory root.' },
                DSH_TRADING_AGENTS_OUTPUT_LANGUAGE: { description: 'trading-agents report prose language from the plugin config.' },
            },
            resolve: () => ({
                DSH_TRADING_AGENTS_ROOT: paths.pluginRoot,
                DSH_TRADING_AGENTS_HOME: paths.home,
                DSH_TRADING_AGENTS_RESULTS_DIR: paths.resultsDir,
                DSH_TRADING_AGENTS_OUTPUT_LANGUAGE: config.outputLanguage,
            }),
        })
    } catch (error) {
        ctx.logger?.warn?.(`trading-agents: shell environment contribution rejected: ${error?.message ?? error}`)
    }
}

/**
 * Registers the trading-agents tools and skills.
 *
 * @param ctx - the registrant context; `ctx.tools` and `ctx.skills` are injected.
 * @param rawConfig - the operator's configuration for this row.
 */
export async function apply(ctx, rawConfig) {
    /** @type {ReturnType<typeof resolveConfig>} */
    let config
    let configProblem
    try {
        config = resolveConfig(rawConfig)
    } catch (error) {
        configProblem = error instanceof ConfigError ? error.message : String(error?.message ?? error)
        config = resolveConfig({})
    }

    const paths = resolvePaths(config)
    const bridge = new PythonBridge(config, paths, ctx.logger)

    if (configProblem) {
        ctx.logger?.warn?.(`trading-agents: ${configProblem}`)
        breakBridge(bridge, configProblem)
    } else {
        try {
            bridge.writeLaunchers()
        } catch (error) {
            ctx.logger?.warn?.(`trading-agents: could not write the bin launchers in ${paths.binDir}: ${error?.message ?? error}`)
        }

        if (config.autoBootstrap) {
            const warmUp = bridge.ensureReady()
                .then(() => {
                    ctx.logger?.info?.(`trading-agents: Python environment ready at ${paths.venvDir}`)
                    // The pending-settlement list depends on the memory log existing.
                    return undefined
                })
                .catch((error) => {
                    ctx.logger?.warn?.(
                        `trading-agents: environment warm-up failed (tools stay available and retry on first use): ${error?.message ?? error}`,
                    )
                })
            if (config.bootstrapInline) await warmUp
        }
    }

    for (const definition of buildTools({ ctx, bridge, paths, config })) {
        ctx.tools.register(definition)
    }

    registerShellEnv(ctx, paths, config)

    const { skills, problems } = collectSkills({
        skillsDir: paths.skillsDir,
        rolesDir: paths.rolesDir,
        exposeRoleSkills: config.exposeRoleSkills,
        onError: (message) => ctx.logger?.warn?.(`trading-agents: ${message}`),
    })
    const { registered, rejected } = registerSkills(ctx, skills, ctx.logger)

    ctx.logger?.info?.(
        `trading-agents: ${registered} skill(s) registered`
        + (rejected.length > 0 ? `, ${rejected.length} rejected` : '')
        + (problems.length > 0 ? `, ${problems.length} file problem(s)` : '')
        + `; data home ${paths.home}`,
    )
}
