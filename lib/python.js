/**
 * The Python bridge: bootstrap the plugin's private venv, run the bundled CLI,
 * and install the stable `bin/ta` launchers that skills call from bash.
 *
 * The plugin runs inside the DSH Host process and deliberately publishes a
 * launcher directory instead of relying on `PATH` mutation: a skill's bash block
 * can always reach `"$DATA/bin/ta"` no matter where the package was installed.
 *
 * @module dsh-plugin-trading-agents/python
 */

import { spawn } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { ConfigError } from './config.js'

/** Default cap on captured output per stream, in bytes. */
const DEFAULT_MAX_BUFFER = 8 * 1024 * 1024

/**
 * Quotes a value for a single-quoted POSIX shell string.
 *
 * @param value - the raw text.
 * @returns the text safe inside `'…'`.
 */
function shellQuote(value) {
    return String(value).replace(/'/g, `'\\''`)
}

/**
 * Raised when the Python layer cannot run. Carries the actionable detail a tool
 * result shows the model.
 */
export class PythonUnavailableError extends Error {
    /**
     * @param message - what failed and how to fix it.
     * @param detail - optional captured stderr or log tail.
     */
    constructor(message, detail = '') {
        super(detail ? `${message}\n${detail}` : message)
        this.name = 'PythonUnavailableError'
        this.detail = detail
    }
}

/**
 * Runs a command to completion and collects both streams.
 *
 * A timeout or an abort kills the child and reports it rather than hanging the
 * tool call. Output beyond the buffer cap keeps the tail, which is where errors
 * usually are.
 *
 * @param command - executable to run.
 * @param args - exact argv entries; never a shell string.
 * @param options - cwd, env, timeoutMs, signal, maxBuffer.
 * @returns the exit code, streams, and whether a timeout fired.
 */
export function runProcess(command, args, options = {}) {
    const {
        cwd = process.cwd(),
        env = process.env,
        timeoutMs = 120_000,
        signal,
        maxBuffer = DEFAULT_MAX_BUFFER,
    } = options

    return new Promise((resolve) => {
        /** @type {import('node:child_process').ChildProcessWithoutNullStreams} */
        let child
        try {
            child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
        } catch (error) {
            resolve({ command, args, code: -1, stdout: '', stderr: String(error?.message ?? error), timedOut: false, aborted: false })
            return
        }

        /** @type {Buffer[]} */
        let stdoutChunks = []
        /** @type {Buffer[]} */
        let stderrChunks = []
        let stdoutBytes = 0
        let stderrBytes = 0
        let timedOut = false
        let aborted = false
        let settled = false

        const timer = timeoutMs > 0
            ? setTimeout(() => {
                timedOut = true
                child.kill('SIGKILL')
            }, timeoutMs)
            : undefined

        const onAbort = () => {
            aborted = true
            child.kill('SIGKILL')
        }
        if (signal) {
            if (signal.aborted) onAbort()
            else signal.addEventListener('abort', onAbort, { once: true })
        }

        /**
         * Appends a chunk while keeping only the tail once the cap is exceeded.
         *
         * @param chunks - the chunk list being built.
         * @param chunk - the new data.
         * @param current - bytes captured so far.
         * @returns the new byte count.
         */
        const appendCapped = (chunks, chunk, current) => {
            chunks.push(chunk)
            let total = current + chunk.length
            while (total > maxBuffer && chunks.length > 1) {
                total -= chunks.shift().length
            }
            return total
        }

        child.stdout.on('data', (chunk) => {
            stdoutBytes = appendCapped(stdoutChunks, chunk, stdoutBytes)
        })
        child.stderr.on('data', (chunk) => {
            stderrBytes = appendCapped(stderrChunks, chunk, stderrBytes)
        })

        const finish = (code, spawnError) => {
            if (settled) return
            settled = true
            if (timer) clearTimeout(timer)
            signal?.removeEventListener?.('abort', onAbort)
            let stderr = Buffer.concat(stderrChunks).toString('utf8')
            if (spawnError) stderr = stderr ? `${stderr}\n${spawnError}` : spawnError
            if (timedOut) stderr = `${stderr}\n[timed out after ${timeoutMs} ms]`.trim()
            if (aborted) stderr = `${stderr}\n[aborted by caller]`.trim()
            resolve({
                command,
                args,
                code: code ?? -1,
                stdout: Buffer.concat(stdoutChunks).toString('utf8'),
                stderr,
                timedOut,
                aborted,
            })
        }

        child.on('error', (error) => finish(-1, String(error?.message ?? error)))
        child.on('close', (code) => finish(code, ''))
    })
}

/**
 * Owns the venv lifecycle and the CLI invocations for one plugin instance.
 */
export class PythonBridge {
    /**
     * @param config - the normalized config.
     * @param paths - the resolved paths.
     * @param logger - optional DSH logger (`ctx.logger`).
     */
    constructor(config, paths, logger) {
        this.config = config
        this.paths = paths
        this.logger = logger
        /** @type {Promise<void> | undefined} */
        this.readyPromise = undefined
        this.ready = false
    }

    /**
     * Builds the environment the Python layer sees. Interpreter-level settings
     * and operator `env` entries are layered over the inherited process env.
     *
     * @returns a fresh environment object.
     */
    childEnv() {
        /** @type {Record<string, string>} */
        const env = {
            ...process.env,
            TRADING_AGENTS_HOME: this.paths.home,
            TRADING_AGENTS_RESULTS_DIR: this.paths.resultsDir,
            TRADING_AGENTS_OUTPUT_LANGUAGE: this.config.outputLanguage,
            TRADING_AGENTS_HOLDING_DAYS: String(this.config.holdingDays),
            TRADING_AGENTS_PYTHON: this.paths.python,
            PYTHONUNBUFFERED: '1',
            PYTHONDONTWRITEBYTECODE: '1',
        }
        if (this.config.benchmark !== '') env.TRADING_AGENTS_BENCHMARK = this.config.benchmark
        Object.assign(env, this.config.env)
        return env
    }

    /**
     * Installs the `bin/ta`, `bin/ta-assemble` and `env.sh` launchers.
     *
     * Writes only when the content changed, so activation does not churn the
     * filesystem, and writes through a temporary file plus rename so a reader
     * never sees a half-written launcher.
     */
    writeLaunchers() {
        const { binDir, taScript, taAssembleScript, home, resultsDir, pluginRoot, venvPython } = this.paths
        mkdirSync(binDir, { recursive: true })

        /**
         * Writes one file atomically when its content differs.
         *
         * @param path - destination path.
         * @param content - full file content.
         * @param mode - file mode to apply.
         */
        const writeIfChanged = (path, content, mode = 0o644) => {
            try {
                if (readFileSync(path, 'utf8') === content) return
            } catch {
                // Missing file: fall through and write it.
            }
            const temporary = `${path}.${process.pid}.tmp`
            writeFileSync(temporary, content, { encoding: 'utf8', mode })
            chmodSync(temporary, mode)
            renameSync(temporary, path)
            chmodSync(path, mode)
        }

        const launcher = (target, label) => [
            '#!/usr/bin/env bash',
            `# Generated by dsh-plugin-trading-agents (${label}); recreated on activation.`,
            'set -euo pipefail',
            `exec bash '${shellQuote(target)}' "$@"`,
            '',
        ].join('\n')

        writeIfChanged(join(binDir, 'ta'), launcher(taScript, 'ta'), 0o755)
        writeIfChanged(join(binDir, 'ta-assemble'), launcher(taAssembleScript, 'ta-assemble'), 0o755)
        writeIfChanged(join(binDir, 'env.sh'), [
            '#!/usr/bin/env bash',
            '# Generated by dsh-plugin-trading-agents; source it to get the same paths the plugin uses.',
            `export TRADING_AGENTS_HOME='${shellQuote(home)}'`,
            `export TRADING_AGENTS_RESULTS_DIR='${shellQuote(resultsDir)}'`,
            `export TRADING_AGENTS_PLUGIN_ROOT='${shellQuote(pluginRoot)}'`,
            `export TRADING_AGENTS_VENV_PYTHON='${shellQuote(venvPython)}'`,
            '',
        ].join('\n'))
    }

    /**
     * Ensures the venv exists and satisfies `requirements.txt`.
     *
     * Concurrent callers share one run. A failure clears the memoized promise so
     * a later call retries once the operator fixes the cause.
     *
     * @param options - optional timeout override and abort signal.
     * @returns a promise that resolves when the environment is ready.
     */
    ensureReady(options = {}) {
        if (this.ready) return Promise.resolve()
        if (this.readyPromise) return this.readyPromise

        const timeoutMs = options.timeoutMs ?? this.config.bootstrapTimeoutMs
        this.readyPromise = (async () => {
            const { bootstrapScript, home } = this.paths
            mkdirSync(home, { recursive: true })
            if (!existsSync(bootstrapScript)) {
                throw new PythonUnavailableError(
                    `the bundled bootstrap script is missing at ${bootstrapScript}; reinstall dsh-plugin-trading-agents`,
                )
            }
            const result = await runProcess('bash', [bootstrapScript], {
                cwd: this.paths.pluginRoot,
                env: this.childEnv(),
                timeoutMs,
                signal: options.signal,
            })
            if (result.code !== 0) {
                const tail = result.stderr.trim().split('\n').slice(-12).join('\n')
                throw new PythonUnavailableError(
                    `bootstrapping the plugin Python environment failed (exit ${result.code}); `
                    + `run \`${join(this.paths.binDir, 'ta')} doctor\` and check ${this.paths.bootstrapLog}`,
                    tail,
                )
            }
            this.ready = true
        })()

        this.readyPromise.catch(() => {
            this.readyPromise = undefined
        })
        return this.readyPromise
    }

    /**
     * Runs one data-layer subcommand through the venv interpreter.
     *
     * @param args - the CLI argv after the script name.
     * @param options - timeout and abort signal.
     * @returns the process result.
     */
    async runData(args, options = {}) {
        await this.ensureReady(options)
        if (!existsSync(this.paths.venvPython)) {
            throw new PythonUnavailableError(`the plugin venv interpreter is missing at ${this.paths.venvPython}`)
        }
        if (!existsSync(this.paths.dataScript)) {
            throw new PythonUnavailableError(`the bundled data CLI is missing at ${this.paths.dataScript}`)
        }
        return runProcess(this.paths.venvPython, [this.paths.dataScript, ...args], {
            cwd: this.paths.pluginRoot,
            env: this.childEnv(),
            timeoutMs: options.timeoutMs ?? 180_000,
            signal: options.signal,
        })
    }

    /**
     * Runs the report assembler through the venv interpreter.
     *
     * @param args - the CLI argv after the script name.
     * @param options - timeout and abort signal.
     * @returns the process result.
     */
    async runAssemble(args, options = {}) {
        await this.ensureReady(options)
        if (!existsSync(this.paths.assembleScript)) {
            throw new PythonUnavailableError(`the bundled report assembler is missing at ${this.paths.assembleScript}`)
        }
        return runProcess(this.paths.venvPython, [this.paths.assembleScript, ...args], {
            cwd: this.paths.pluginRoot,
            env: this.childEnv(),
            timeoutMs: options.timeoutMs ?? 180_000,
            signal: options.signal,
        })
    }

    /**
     * Reports the local environment state without touching the network.
     *
     * @param options - `probePython` also runs `--version` probes.
     * @returns the checks and the resolved paths.
     */
    async diagnose(options = {}) {
        const { probePython = true } = options
        /** @type {{name: string, ok: boolean, detail: string}[]} */
        const checks = []

        checks.push({
            name: 'bootstrap script',
            ok: existsSync(this.paths.bootstrapScript),
            detail: this.paths.bootstrapScript,
        })
        checks.push({
            name: 'data CLI',
            ok: existsSync(this.paths.dataScript),
            detail: this.paths.dataScript,
        })
        checks.push({
            name: 'report assembler',
            ok: existsSync(this.paths.assembleScript),
            detail: this.paths.assembleScript,
        })
        checks.push({
            name: 'venv interpreter',
            ok: existsSync(this.paths.venvPython),
            detail: existsSync(this.paths.venvPython)
                ? this.paths.venvPython
                : 'not created yet; the first ta_* call bootstraps it',
        })
        checks.push({
            name: 'ta launcher',
            ok: existsSync(join(this.paths.binDir, 'ta')),
            detail: join(this.paths.binDir, 'ta'),
        })

        if (probePython) {
            const python = await runProcess(this.paths.python, ['--version'], {
                env: this.childEnv(),
                timeoutMs: 15_000,
            })
            checks.push({
                name: 'python interpreter',
                ok: python.code === 0,
                detail: python.code === 0
                    ? `${(python.stdout || python.stderr).trim()} (${this.paths.python})`
                    : `${this.paths.python} is not usable: ${python.stderr.trim() || `exit ${python.code}`}`,
            })

            if (existsSync(this.paths.venvPython)) {
                const imports = await runProcess(this.paths.venvPython, ['-c', 'import yfinance, pandas, requests, markdown; print("deps ok")'], {
                    env: this.childEnv(),
                    timeoutMs: 30_000,
                })
                checks.push({
                    name: 'python dependencies',
                    ok: imports.code === 0,
                    detail: imports.code === 0
                        ? imports.stdout.trim()
                        : `${imports.stderr.trim().split('\n').slice(-3).join(' ')} — run ta_doctor after a bootstrap`,
                })
            }
        }

        return { checks, ...this.paths }
    }
}

/**
 * Reads the requirements file's hash marker, if present. Exposed for tests.
 *
 * @param venvDir - the venv directory.
 * @returns the stored hash, or `undefined`.
 */
export function storedRequirementsHash(venvDir) {
    try {
        return readFileSync(join(venvDir, '.req-hash'), 'utf8').trim()
    } catch {
        return undefined
    }
}

export { ConfigError }
