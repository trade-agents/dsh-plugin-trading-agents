# DSH plugin / bundle API — reference for porting a Claude Code plugin

Scope: build a **bundle plugin** for DeepSeek Harness (DSH) 0.2.1-rc.2 porting
`/Users/huike/Project/trading-workspace/trading-agents-plugin`. Read from the *packaged*
DSH (authoritative); items marked **VERIFIED** were exercised against the real runtime.

`$ASAR = /Applications/DeepSeek Harness.app/Contents/Resources/app.asar`; docs at
`$ASAR/dsh/node_modules/@deepseek-ai/<pkg>/README.md`, code at `.../lib/index.js`. The asar
is readable only through Electron's patched fs (`ELECTRON_RUN_AS_NODE=1 "…/DeepSeek
Harness" script.cjs`; `/tmp/ls.cjs`, `/tmp/cat.cjs`). Reference plugin:
`/Users/huike/Project/data-wrokspace/dsh-plugin-mysql-data-agent`.

Claude Code → DSH: prompt-expanding slash command → **user-invocable skill** (§3/§4);
hooks → agent/session events (§6); bundled scripts → tools + `ctx.subprocess` (§7/§8);
`plugin.json`/marketplace → **bundle** + market index (§2/§11).

---

## 1. Runtime version

| Fact | Value | Source |
| --- | --- | --- |
| DSH runtime | **`0.2.1-rc.2`** | `$ASAR/dsh/package.json`, `@deepseek-ai/dsh/package.json` |
| Electron shell / bundled Node / pnpm | `0.2.1-rc.2` / `24.21.0` / `11.28.5` | `$ASAR/package.json`, `desktop-runtime.json` |

`engines.dsh` alone decides compatibility (peer ranges are then ignored); `workspace:`
values are rejected; invalid/empty ranges are incompatible (`dsh-app-boot/README.md`,
`evaluatePluginCompatibility`, `dsh-app-boot/lib/index.js:311`).

Semver against `0.2.1-rc.2` (**VERIFIED** with the packaged `semver`):

```
0.2.1-rc.2          true      >=0.2.1-rc.2 <0.3.0  true  (recommended)
^0.2.1-rc.2         true      0.2.x                 false (prerelease rule)
>=0.2.1-rc.2        true but unbounded upper         (not recommended)
```

Use `"engines": { "dsh": ">=0.2.1-rc.2 <0.3.0" }`.

---

## 2. Plugin / bundle contract

### 2.1 `package.json`

A bundle is an npm package with `dsh.bundle.patch`; the package may itself be the plugin
module (one-package bundle). Verified minimal shape:

```json
{
  "name": "dsh-plugin-trading-agents", "version": "1.0.0", "type": "module",
  "description": "One-line description used as display fallback.",
  "main": "lib/index.js",
  "exports": { ".": "./lib/index.js", "./cordis.patch.yml": "./cordis.patch.yml",
    "./locale/*.json": "./locale/*.json", "./icon": "./icon.svg", "./package.json": "./package.json" },
  "files": ["lib", "skills", "roles", "scripts", "cordis.patch.yml", "locale", "icon.svg", "README.md"],
  "icon": "./icon.svg",
  "engines": { "node": ">=20", "dsh": ">=0.2.1-rc.2 <0.3.0" },
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
}
```

- `exports["."]` must resolve to the ESM entry; the Loader imports the row `name` as a
  bare specifier through Node exports.
- `dsh.bundle.patch`: one path **or an ordered string array**, relative to the package
  root; files are concatenated into one bundle layer (`bundlePatchFiles`,
  `dsh-app-boot/lib/index.js:517-530`). `dsh.manifestVersion` is optional/unenforced.
- Export `./package.json` and `./locale/*.json`: the display-metadata reader resolves
  `<pkg>/locale/en.json` and `<pkg>/package.json` through exports.
- No `@deepseek-ai/*` import/peer is needed for a raw-tool, config-less plugin (§5).
  Declared peers **do** resolve from the installation (**VERIFIED**: linked probe
  imported `@deepseek-ai/dsh-llm` and `dsh-tools` inside a real profile).

### 2.2 `cordis.patch.yml`

Top-level YAML **array**; a bundle inserts its row(s):

```yaml
- insert:
    - id: trading-agents                 # stable row id
      name: 'dsh-plugin-trading-agents'  # module specifier == package.json.name
      config:                            # passed verbatim to apply(ctx, config)
        outputLanguage: English
```

- `name:` is a module specifier, not a label: package name for an installed dependency,
  or an absolute path / `file:` URL / patch-relative `./` path. A `link:` install makes
  the package name resolve (**VERIFIED**).
- A patch replaces the targeted row's **whole** config (no deep merge). Layer order:
  `dsh.profile.bundles` in order → profile `cordis.patch.yml` → home patch → `--patch`.
- `disabled: !!js "<expr>"` and `!!js` expressions are evaluated by the Loader. **No
  `${env:VAR}` interpolation exists** in DSH (that mysql README example is not a
  feature); write `!!js process.env.MY_VAR`.

### 2.3 Install mechanics

CLI: `/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh` (not on
`PATH` by default; the app can install a launcher).

```
dsh plugin --profile <p> add /abs/path/to/bundle        # VERIFIED
dsh plugin --profile <p> install /abs/path/to/bundle    # forwarded to pnpm; pnpm treats named args as add
dsh plugin --profile <p> remove <name> | version-exemptions | allow-version ...
```

`dsh plugin` forwards args to pnpm inside `$DSH_HOME/profiles/<p>` and reconciles
(`dsh-plugin-manager/lib/types/operations.js:299,95`): restore manifest+lockfile on
failure; if the new dependency declares `dsh.bundle`, validate its patch paths exist and
append the package to `dsh.profile.bundles`; else warn `declares no dsh.bundle — installed
as a plain dependency`. **VERIFIED**: adding a probe bundle produced
`"dsh-plugin-scout-probe": "link:/tmp/dsh-test-bundle"` and appended
`dsh-plugin-scout-probe` to `dsh.profile.bundles`. A running process recomposes live only
with HMR, else `restart-required`. `plugin_manager` / the Web Plugins page use the same
service (`installBundle`: inspect → pnpm add → select); each call needs
`danger-full-access` or approval. The Web **Plugins → Add plugin** dialog accepts a
package name/version, Git address, tarball, or **absolute local path**.

### 2.4 Display metadata (exact shape)

`readPluginMeta` (`dsh-app-boot/lib/index.js:2216`), without importing the module:

- `locale/en.json`: `{"meta":{"title":"…","description":"…"}}` — only these two keys;
  title/description fall back to `package.json` name/description.
- icon: manifest `"icon": "./icon.svg"` (relative file inside the package, SVG/PNG/JPEG/
  WebP, ≤256 KiB, served as `data:` URL) or the exported `<pkg>/icon`.

Missing metadata does not block management (name + default artwork are used).

---

## 3. Skill registration

`ctx.skills.register(skill)` — `SkillRegistry.register`, `dsh-skill/lib/index.js:193`.
Registration does **not** validate `content`/`source`; the loaded definition is
re-validated by `get()` (`validateDefinition`, `:471`), which **requires a string
`source`**. Verified trap: without `source` the skill lists in the catalog but
`ctx.skills.get(name)` throws `loaded skill "<name>" source must be a string`, breaking
`/name` and the `skill` tool.

```js
const dispose = ctx.skills.register({
  name: 'trading-agents-pipeline',   // /^[a-z0-9]+(?:-[a-z0-9]+)*$/  (dsh-skill:29)
  description: '...',                // required, non-empty
  content: markdown,                 // full body (required at load)
  source: 'bundled',                 // REQUIRED at load; free-form string
  whenToUse: '...',                  // optional (not rendered in the model catalog)
  invocation: { modelInvocable: true, userInvocable: true }, // default: both true
  path: '/abs/.../SKILL.md',         // optional; Web preview opens this file
  resourceBase: { kind: 'directory', path: '/abs/.../skill-dir' }, // optional
  // provider forced to 'runtime'; metadata?: record; returns an effect disposer
});
```

`resourceBase` is `{kind:'directory',path}` | `{kind:'url',url}` |
`{kind:'opaque',description}`. Duplicate names in one layer warn and first wins; invalid
name / empty description throws; loading an invalid name returns `undefined`. You read the
body yourself (e.g. `readFileSync` of a bundled `SKILL.md` via `import.meta.url`); DSH
never reads `path` (preview-only).

### Skills are the slash-command mapping

- A **user-invocable** skill appears as `/name` in the Web composer (`dsh-client-ui-skill`;
  `ui-skill`/`ui-commands` rows are in the web/desktop composition). Sent `/name` reaches
  the Host verbatim; at `agent/pre-step`, `dsh-tool-skill` appends the full
  `renderSkillContent()` block (`<skill_content name=…>…`) as a `user`-role instructions
  context — Claude Code's expand-to-prompt behavior.
- `modelInvocable:true` also lists it in `<available_skills>` and exposes the `skill` tool;
  `{modelInvocable:false,userInvocable:true}` = `disable-model-invocation`, `/name`-only.
- **Name collision**: a name shared with a host command resolves as that command. Built-in
  host commands: `compact`, `feedback`, `goal`, `plan` — avoid those skill names.
- Runtime skills sit in the global layer, visible in every workspace.

---

## 4. Commands (`ctx.commands.register`)

Commands are **not** prompt expansion: they run against an agent without creating a model
message, and their result renders outside model history (`dsh-commands/README.md`). Name
regex `/^[a-z][a-z0-9_-]*$/` (`dsh-commands/lib/index.js:78`).

```js
ctx.commands.register({
  name: 'trading-agents',                   // /^[a-z][a-z0-9_-]*$/
  description: 'Trading Agents actions',    // required non-empty
  input: { hint: '<ticker>', attachments: false }, // optional
  definitionId: 'my-plugin:trading-agents', // optional stable identity
  recordInput: true,                        // default true
  handler: async ({ agent, rawInput, signal }) =>
    ({ kind: 'success', text: 'done' }),     // or {kind:'error', text:'non-empty'}
});
```

A command **can** start model work: `/plan <message>` calls
`agent.steer(createUserMessage({content, source}))` (`dsh-plan-mode/lib/index.js:216`).
`Agent` = `{id, options, session, inbox, status, ctx, cancel, whenIdle, runMaintenance,
send, followup, steer, inject}`; a `UserMessage` is `{id, role:'user',
content:[{type:'text',text}], source:{kind:'my-plugin'}}`. `createUserMessage` only mints
`id: randomUUID()` and freezes (`dsh-llm/lib/index.js:37-63`; `brandString` is identity),
so it is constructible with no peer import.

Verdict: **map prompt-expanding Claude Code slash commands to user-invocable skills, not
commands.** Use commands only for direct UI/side-effect actions (no token cost).

---

## 5. Config schema / validation

- Cordis `resolveConfig`: **no `Config` export ⇒ raw config passed through unchanged**
  (`cordis/lib/index.js:956` — `if (!runtime.Config) return config`). This is the mysql
  pattern and needs **no schemastery peer**.
- Exporting `Config` requires a Standard-Schema object (`Config["~standard"].validate`,
  synchronous) — in practice `z.object()` from `@deepseek-ai/schemastery` as a peer. It
  buys Loader validation, the Web config form, and `--dump-config-schema`, at the cost of
  a peer and a hard load failure on bad config. Not worth it for this port.
- Recommended: validate in `apply`; on error log and register tools/skills that still
  explain the fix rather than throwing (`dsh-plugin-mysql-data-agent/lib/index.js`).
- `inject` (`cordis/lib/index.js:1044-1100,1491`): `export const inject = ['tools']`; the
  fiber stays **inactive** until every service exists and never throws (app-boot: "An
  injected service is unavailable → warn; continue while the entry waits"). No
  `{required, optional}` form; `ctx.get('x')` reads without injecting and returns
  `undefined` (**VERIFIED**). Only *required* profile rows make this fatal.
- `apply` may be async; throwing fails activation (warn on optional rows). Cleanup:
  `ctx.effect(() => disposeFn)` (canonical) or `ctx.on('dispose', fn)`.

## 6. Events / hook equivalents

`ctx.on(name, listener, options?)`; `{global:true}` when mounted inside an agent scope.
Waterfalls take `next()`; serial events are awaited.

| Event | Args | Use |
| --- | --- | --- |
| `session/created` | `(session)` | closest to **SessionStart**; fires on create and resume (`dsh-session/lib/index.js:1910`) |
| `session/disposed` | `(session)` | SessionEnd / cleanup |
| `session/event` | `(session, event)` | every committed log event (`user/message`, `turn/start`, `step/start`, …) |
| `agent/created` | `({agent, source, signal})` | `source`: `startup` \| `resume` \| `clear` \| `compaction`; serial (`dsh-agent/lib/index.js:581`) |
| `agent/pre-step` | `({agent, messages, signal, step}, next)` | waterfall: `{kind:'reject'}` or `{kind:'enter', messages}`; **inject context here** |
| `agent/request`, `agent/request-error` | request / error + `next` | route or retry hooks |
| `agent/turn-stopping` | turn | runs before a completed turn closes |
| `tools/pre-execute` / `execute` / `post-execute` / `result` | pipeline | allow/deny/ask, wrap, inspect |
| `skills/change`, `plugin-manager/changed`, `app-boot/config-reload` | — | cache invalidation |

**VERIFIED** order for one fresh headless turn:
`session/created` (cwd `undefined`) → `agent/created {agent,source:'startup',signal}` →
`session/event turn/start` → `agent/pre-step step=1 messages=1` → `step/start` →
`user/message`.

SessionStart-with-context recipe (pattern from
`dsh-agent-instructions/lib/index.js:1406`):

```js
import { randomUUID } from 'node:crypto';
const injected = new Set();
ctx.on('agent/pre-step', async ({ agent, messages, step }, next) => {
  const decision = await next();
  if (decision.kind === 'reject' || injected.has(agent.id)) return decision;
  injected.add(agent.id);
  const message = { id: randomUUID(), role: 'user',
    content: [{ type: 'text', text: runSessionStartHook() }],
    source: { kind: 'trading-agents' } };
  return { ...decision, messages: [message, ...decision.messages] };
}, { global: true });
```

There is no `SessionStart` hook *name* and no hook-file format for plugins; these
listeners are the equivalent (Codex/Claude subagent hooks are a different feature).

## 7. Subprocesses, sandbox, writable locations

Confinement is consumer-owned: `dsh-bash-sandbox` confines `['bash','-c',cmd]` via
`ctx.sandbox.confine()`; `dsh-fs-sandbox` confines the *model's* `ctx.fs` mutations
(`workspace-write` = session workspace root or `/tmp`/`os.tmpdir()`). Modes govern **file
effects only**; network is unrestricted. **A Host plugin's own code is not sandboxed** —
Plugin Manager README: *"installed Host code executes in-process outside the workspace
sandbox"*. `node:fs`, `node:child_process`, and `ctx.subprocess` run with the host user's
authority. Writes go to `$DSH_HOME` (`DSH_HOME` or `~/.dsh`), the session workspace
(`session.header.cwd`), or a plugin `home` config value; no per-plugin data dir exists.

`ctx.subprocess` (`dsh-subprocess-local` is in the base bundle — **VERIFIED** row in
`dsh --profile web --dump-config`); `export const inject = ['subprocess']`:

```js
const exe = await ctx.subprocess.resolveExecutable('python3');
const handle = ctx.subprocess.spawn({
  argv: [exe, '/abs/plugin/scripts/ta.py', 'analyze', '--ticker', 'NVDA'],
  cwd: sessionDir,
  stdio: { stdin: 'ignore', stdout: { maxBytes: 256 * 1024 }, stderr: 'collect' },
  graceMs: 5000, env: { TRADING_AGENTS_HOME: home }, signal: exec.signal,
});
const { exitCode, signal } = await handle.done;
const out = handle.collected.stdout?.readFrom(0); // offset-based, non-consuming
await handle.terminate();                          // idempotent, kills managed range
```

`argv` is never shell-interpreted. Children start from `scrubbedParentEnv()`: ambient
`*KEY|PASSWORD|SECRET|TOKEN*` and all `DSH_*` are removed, then explicit `env` merges
(`dsh-subprocess/lib/index.js:15-60`). Output is bounded; a `spill` cap keeps the full
stream recoverable.

**Bundled Python**: CPython 3.12.14 ships at
`…/runtime/primary-runtime/dependencies/python/bin/python3`; Desktop installs it to
`$DSH_HOME/dsh-runtimes/dsh-primary-runtime` on first `load_workspace_dependencies` call
(`dsh-desktop-host/lib/index.js:333`). No service exposes these paths to plugins — resolve:
config `python` → `$DSH_PRIMARY_RUNTIME/dependencies/python/bin/python3` → the app path →
`python3` on PATH.

## 8. Tool definition contract

`export const inject = ['tools']`; raw definitions are fine (no `defineTool` import).

```js
ctx.tools.register({
  name: 'ta_analyze',                 // reserved: run_code
  description: 'Run one keyless market analysis and return a structured summary.',
  parameters: { type: 'object', additionalProperties: false, required: ['ticker'],
    properties: { ticker: { type: 'string', description: 'Ticker, e.g. NVDA' },
                  horizon: { type: 'integer', enum: [5, 10, 21] } } },
  output: {
    schema: { type: 'object', required: ['summary'],
              properties: { summary: { type: 'string' } } },
    render: (_args, value) => [{ type: 'text', text: value.summary }],
    // presentationMeta?(args, value) -> lossless JSON (optional)
  },
  async execute(args, exec) {
    // exec = { token, callId, rootCallId, name, signal, agent?, parent?, schema?,
    //          arguments, deferContext(ctx), concludeTurn() }
    return { summary: '…' };          // MUST satisfy output.schema
  },
  // optional: timeoutMs, deferLoading, projectContent, finalizeContent,
  //   isConcurrencySafe(args) (only === true is parallel),
  //   presentCall(args), presentResult(args,result)  // Host-local; Web ignores them
});
```

`register` (`dsh-tools/lib/index.js:2974`) validates `output {schema,render}` and
`output.schema` only; `parameters` is **not** asserted there — validate it offline.
`render` must return lossless-JSON ContentBlocks (`{type:'text',text}` is safe). DSH only
reserves the tool name `run_code`; providers constrain function names, so stay in
`/^[a-z][a-z0-9_]{0,63}$/`.

**Supported JSON-Schema subset** (`dsh-tools/lib/index.js:34-56,150-330`):

- Constraint: `type`, `oneOf`, `properties`, `required`, `additionalProperties`,
  `items`, `enum`, `const`. Annotations: `description`, `title`, `default`, `examples`
  (lossless JSON; `description`/`title` strings).
- `type` single string: `object|array|string|number|integer|boolean|null`; type arrays
  rejected; annotation-only schema allowed. `properties`/`required`/
  `additionalProperties` only on `object`; `items` only on `array`; `enum`/`const` only
  on scalars.
- **`required` must be a string array on the object node** and every name must exist in
  `properties` (`checkObjectSchemaTail`, `:170`); no per-property `required:true`.
- `additionalProperties` boolean; `enum` non-empty and type-correct; `const` type-correct
  and in `enum` when both are present. `oneOf`: ≥2 schemas, no `type` sibling, no sibling
  `properties`/`required`/`additionalProperties`/`items`/`enum`/`const`.
- Rejected: `$ref`, `$defs`, `pattern`, `format`, `min*`/`max*`, `allOf`, `anyOf`, `not`,
  `nullable`, … (the error names the subset). **VERIFIED** with the real validator:
  `minimum` rejected; `required:[{x:1}]` → `must be an array of strings`; valid `oneOf` OK.

## 9. Shell environment (`dsh-shell-env`)

Model bash/pwsh calls run with a managed `DSH_*` env (`DSH_HOME`, `DSH_SHELL=1`,
`DSH_SESSION_ID`, `DSH_PROFILE`, `DSH_PROFILE_DIR`). Plugins add facts — the supported way
to hand bundled scripts a plugin-root path:

```js
import { fileURLToPath } from 'node:url';
export const inject = ['shellEnv'];
export function apply(ctx) {
  ctx.shellEnv.register({
    name: 'trading-agents',
    variables: { DSH_TRADING_AGENTS_ROOT: { description: 'Bundled plugin root.' } },
    resolve: () => ({ DSH_TRADING_AGENTS_ROOT: fileURLToPath(new URL('.', import.meta.url)) }),
  });
}
```

Rules (`dsh-shell-env/README.md`): declared keys only, all-caps `DSH_*`, each with a
description; duplicate ownership or a reserved key fails plugin load loudly; values must
be strings; collection is per shell execution; disposal follows the plugin; `process.env`
is never modified.

## 10. Plugin directory and logger

- Own directory: `import.meta.url` (**VERIFIED**; symlinks resolved). `ctx.baseUrl` is the
  **profile** directory (`file:///tmp/…/profiles/headless/`) — never use it for assets.
- `ctx.logger` is callable with `.info/.warn/.error/.debug`, or `ctx.logger('name')`
  (`cordis/lib/index.js:570-640`); `ctx.effect`/`ctx.on` exist (**VERIFIED**). Use
  `ctx.effect` for teardown (kill children, release handles), including on HMR.

## 11. Plugin market index (`dsh-plugin-market-index`)

DSH reads third-party market indexes: one JSON document served over `http(s)`, validated
as format **1**. None configured by default; users add URLs in **Plugins → Discover**
(`pluginMarket.setIndexes`) or via the `plugin-market` row's `indexes` config. Only
`http:`/`https:` (no local files); relative `icon` URLs resolve against the index URL.

```json
{ "format": 1,
  "title": { "en": "Trading Agents plugins" },
  "description": { "en": "Optional." },
  "metadata": {
    "categories": { "finance": { "title": { "en": "Finance" } } },
    "labels": { "trading": { "title": { "en": "Trading" } } },
    "sortKeys": { "stars": { "title": { "en": "Stars" }, "order": "desc" } } },
  "plugins": [{
    "name": "dsh-plugin-trading-agents",
    "title": { "en": "Trading Agents" },
    "description": { "en": "Multi-agent equity research and trading decisions." },
    "author": "…", "homepage": "https://github.com/trade-agents/trading-agents-plugin",
    "repository": { "url": "https://github.com/trade-agents/trading-agents-plugin" },
    "icon": "./icon.png",
    "metadata": { "category": "finance", "labels": ["trading"], "keywords": ["trading"] },
    "versions": [{ "version": "1.0.0", "publishTimestamp": 1760000000,
      "source": { "type": "npm" },
      "engines": { "dsh": ">=0.2.1-rc.2 <0.3.0" } }] }] }
```

Required: `format:1`; localized `title` containing `en`; unique `plugins[].name` (valid
npm name); non-empty unique `plugins[].versions`, each exact SemVer + integer Unix-seconds
`publishTimestamp` + `source` (`{type:"npm",registry?}` or
`{type:"git",url,commit:40-hex,path?}`). Declared ids must be referenced correctly; sort
values are finite numbers. Install targets: `name@version` or
`git+<url>.git#<commit>&path:/<path>`. The validator cannot check that the package
actually declares a bundle.

## 12. Verification recipes

```sh
DSH="/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh"
```

**(a) Tool schemas against DSH's real validator (VERIFIED).** Run through Electron in Node
mode (same as the mysql plugin's `test/dsh-schema-check.mjs`):

```js
const ASAR = '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh';
const { assertSupportedJsonSchema, validateJsonSchemaValue } =
  await import(ASAR + '/node_modules/@deepseek-ai/dsh-tools/lib/index.js');
assertSupportedJsonSchema(tool.parameters);
assertSupportedJsonSchema(tool.output.schema);
validateJsonSchemaValue(tool.output.schema, liveValue, 'value');
```

```sh
ELECTRON_RUN_AS_NODE=1 "/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness"   test/dsh-schema-check.mjs
```

**(b) Syntax check.** `node --check lib/index.js && node --check lib/tools.js` (ESM under
`"type":"module"`; packaged Node at `…/runtime/primary-runtime/dependencies/node/bin/node`).

**(c) `--dump-config`.** `DSH_HOME=/tmp/dsh-home-test "$DSH" --profile web --dump-config`
prints the composed entry list as loadable YAML with `# == <source bundle>` headers; your
rows appear at the end. It **initializes the profile on first use** (writes
`$DSH_HOME/profiles/<name>`) and imports no plugins. `--dump-config-schema` imports each
module to read `Config`; the shipped profile emits unrelated pre-existing warnings/errors,
so grep for your own row id instead of trusting the exit code.

**(d) Install the local bundle.** Two supported routes:

- **Web/desktop-managed profile (this GUI):** sidebar **Plugins → Add plugin** → the
  **absolute directory path**. The Host inspects it, refuses packages without a bundle
  patch, installs, and offers **Enable now**. No CLI needed; Electron owns the profile.
- **CLI into a normal profile (VERIFIED):**
  `"$DSH" plugin --profile web add /abs/path/to/dsh-plugin-trading-agents`, then
  `"$DSH" --profile web --dump-config` to confirm the row.
- **`desktop` is reserved:** `dsh --profile desktop …` is refused — *`error: profile
  "desktop" is managed exclusively by the Electron application`* (**VERIFIED**).
  `dsh plugin --profile desktop …` works only through the app's desktop CLI
  (`manageDesktopProfile: true`), requires the app to have initialized the profile and to
  be fully quit first; otherwise use the Plugins page while it runs.
- Live recomposition needs HMR (shipped `web` uses it, other templates are startup-only);
  adding a new module can report `restart-required` — restarting is always safe.

---

## Confirmed vs uncertain

**Confirmed** (docs/code; "exercised" = run against the real runtime)

1. Runtime `0.2.1-rc.2`; `engines.dsh` alone decides compatibility (`>=0.2.1-rc.2 <0.3.0`
   passes, `0.2.x` does not — semver checked). Install/select flow exercised end-to-end.
2. Bundle = package with `dsh.bundle.patch` (string or ordered array); the row `name` is a
   module specifier (`package.json.name` for `link:` installs).
3. Display metadata: `locale/en.json {meta:{title,description}}` + `package.json.icon`
   (≤256 KiB SVG/PNG/JPEG/WebP), with name/description fallbacks.
4. `ctx.skills.register` shape as documented, kebab-case names; **`source` required at
   load** though registration accepts its absence (exercised: `get()` throws without it).
   User-invocable skills are `/name` commands injecting the full body; host-command names
   win collisions.
5. Commands create no model turn by default; a handler can `agent.steer()` a hand-built
   `UserMessage` (plan mode does).
6. No `Config` export ⇒ raw config in `apply` (no schemastery peer); exporting `Config`
   needs schemastery/Standard Schema. `inject` waits for services, never throws;
   `ctx.get()` reads without injecting.
7. `session/created` → `agent/created {agent,source,signal}` → `agent/pre-step
   {agent,messages,signal,step}` fire in order on a fresh session (exercised).
8. Host plugin code runs outside the workspace sandbox; `ctx.subprocess` is in the base
   composition, scrubs ambient credentials/`DSH_*`; the app ships Python 3.12.
9. Tool definition fields and JSON-Schema subset; `required` is a string array on the
   object node naming declared properties; unsupported keywords reject (validator exercised).
10. `ctx.shellEnv.register` contributor API; `import.meta.url` resolves the plugin dir;
    `ctx.baseUrl` is the profile dir; `ctx.logger`/`ctx.effect` exist (exercised).
11. Market index format-1 fields, http(s)-only serving; Web Plugins accepts an absolute
    local path; desktop boot via CLI is refused, desktop plugin management is app-owned.

**Uncertain / caveats**

- `dsh plugin … install <dir>` (vs `add`) not exercised; args are forwarded to pnpm
  verbatim and pnpm treats named `install` args as `add`, so expect identical behavior.
- Peer resolution was verified for a `link:` package; registry-copy installs are assumed
  equivalent (runtime resolution is install-source agnostic) but untested.
- `session.cwd` was `undefined` on the in-process Session in a headless probe; the durable
  dir is in `session.header.cwd` / the working-directory projection. Handle both.
- Async work inside `session/created` is only "contained" (rejections logged), not
  documented as awaited; keep hooks fast or move work to `agent/pre-step`.
- Runtime-skill `path` preview in the sidebar was not visually exercised.
- `presentCall`/`presentResult` are Host-local only; the Web client derives card props
  itself, so treat them as optional metadata.
