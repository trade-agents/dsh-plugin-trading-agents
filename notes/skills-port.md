# Skills port — pipeline / trade / settle-decisions

Owner: `skills-porter` (shared task `task-2`). Scope written: `skills/` and this file only.

Sources ported from `/Users/huike/Project/trading-workspace/trading-agents-plugin`:

- `skills/pipeline/SKILL.md` (319 lines, 13.3 KB)
- `commands/trade.md`
- `commands/settle-decisions.md`
- `agents/*.md` (read only, to confirm the 13 role names)

## Deliverables and character counts

| File | `wc -c` (bytes) | Skill body chars (plugin loader) | Cap | Status |
|---|---:|---:|---:|---|
| `skills/trading-agents-pipeline/SKILL.md` | 7397 | 6977 | < 7500 | pass |
| `skills/trading-agents-trade/SKILL.md` | 2687 | 2330 | < 4000 | pass |
| `skills/trading-agents-settle-decisions/SKILL.md` | 3912 | 3523 | < 4000 | pass |
| `skills/trading-agents-pipeline/references/steps.md` | 17293 | — (reference, no cap) | — | pass |

The split exists because DSH's standard tool-result pruner trims results above 8192
characters. `lib/skills.js` warns at the same 8192 body length; the task required < 7500
for every SKILL.md, which all three satisfy.

## File map

```
skills/
  trading-agents-pipeline/
    SKILL.md                     orchestration: goal, inputs, step order, subagent contract,
                                 absence markers, rating validation, final answer, rules,
                                 pointer to references/steps.md
    references/steps.md          exact bash blocks, per-role prompt templates with all field
                                 placeholders, history-append rules, merge loops, assemble +
                                 memory store commands, role output map
  trading-agents-trade/
    SKILL.md                     /trading-agents-trade entry point: argument shape, parsing,
                                 then load and follow trading-agents-pipeline
  trading-agents-settle-decisions/
    SKILL.md                     /trading-agents-settle-decisions entry point: work dir,
                                 memory settle, conditional memory-reflector subagent, report
```

Related files owned elsewhere: `roles/*.md` (13 role prompts, `roles-porter`),
`lib/skills.js` (registers `skills/*/SKILL.md` and `roles/*.md` as
`trading-agents-<role>`), `lib/frontmatter.js`, `scripts/` (`script-porter`).

## Validation run

```
$ find skills -type f
skills/trading-agents-pipeline/SKILL.md
skills/trading-agents-pipeline/references/steps.md
skills/trading-agents-settle-decisions/SKILL.md
skills/trading-agents-trade/SKILL.md

$ wc -c skills/*/SKILL.md
    7383 skills/trading-agents-pipeline/SKILL.md
    3912 skills/trading-agents-settle-decisions/SKILL.md
    2687 skills/trading-agents-trade/SKILL.md

$ grep -R "CLAUDE_PLUGIN_ROOT\|ARGUMENTS\|\.claude/" skills/ || echo clean
clean

$ grep -R "argument-hint\|allowed-tools" skills/ || echo clean
clean
```

Pipeline SKILL.md role/step presence (grep, each exactly once):

- Roles: `trading-agents-market-analyst`, `-sentiment-analyst`, `-news-analyst`,
  `-fundamentals-analyst`, `-bull-researcher`, `-bear-researcher`, `-research-manager`,
  `-trader`, `-aggressive-risk-analyst`, `-conservative-risk-analyst`,
  `-neutral-risk-analyst`, `-portfolio-manager`, `-memory-reflector` — 13/13 present.
- Steps: `0. **Setup` … `8. **Final answer` — each present exactly once.

Frontmatter parse check (each SKILL.md): `name` equals its directory name, `description` is
one line with no colon, `whenToUse` present, `user-invocable: true` explicit.

Plugin-loader check (`lib/skills.js` `collectSkills` over `skills/` + `roles/`): all 16
skills parse, `problems: []`, and the three command skills report
`userInvocable: true, modelInvocable: true`.

## Deviations from the Claude Code sources

1. **Split into SKILL.md + `references/steps.md`.** The long step recipes moved out so the
   SKILL.md body stays under the cap; SKILL.md points to
   "`references/steps.md` in this skill's base directory; read it before step 0." Every
   rule that affects correctness stayed in SKILL.md (absence markers, sequential debate
   order, retry-once, deterministic rating line, pass-paths-not-bodies, final answer).
2. **Subagent spawning.** `Agent` / `subagent_type: trading-agents:<role>` was replaced by
   the DSH `subagent` tool; each child prompt starts with the role-load line (exact
   wording below). The runtime fact was added: `subagent` returns immediately with a child
   id, the parent gets a completion notice, and the parent must not read the role's output
   file before that notice.
3. **Role skill naming.** Claude role names are unchanged
   (`market-analyst` … `memory-reflector`); the DSH skill name is
   `trading-agents-<role>` (registered by `lib/skills.js` from `roles/<role>.md`).
4. **Wrapper paths.** `"${CLAUDE_PLUGIN_ROOT}/scripts/ta"` → `"$TA"` and
   `"${CLAUDE_PLUGIN_ROOT}/scripts/ta-assemble"` → `"$TA_ASSEMBLE"`. Every bash block
   begins with:
   `DATA="${TRADING_AGENTS_HOME:-${DSH_HOME:-$HOME/.dsh}/trading-agents}"; TA="$DATA/bin/ta"; TA_ASSEMBLE="$DATA/bin/ta-assemble"`
5. **Results directory.** `${TRADING_AGENTS_RESULTS_DIR:-$HOME/.claude/trading-agents/runs}`
   → `${TRADING_AGENTS_RESULTS_DIR:-$DATA/runs}`. Home default
   `~/.claude/trading-agents` → `${TRADING_AGENTS_HOME:-${DSH_HOME:-$HOME/.dsh}/trading-agents}`.
6. **Frontmatter.** Removed Claude Code `argument-hint`; no `$ARGUMENTS`, no `allowed-tools`,
   no `.claude/` paths. Each SKILL.md has `name`, one-line `description`, `whenToUse`,
   `user-invocable: true`.
7. **Arguments.** The body of every skill says "Arguments are the text after the skill
   token in the user's message." `commands/trade.md`'s `$ARGUMENTS` became that sentence
   plus the explicit parse shape.
8. **`doctor`.** `"${CLAUDE_PLUGIN_ROOT}/scripts/ta" doctor` → `"$TA" doctor`. Added the
   DSH bootstrap note: the DSH equivalent of the SessionStart bootstrap is the plugin's
   activation-time warm-up; a first `ta` call may spend about a minute installing the venv;
   on failure run `"$TA" doctor` and report the error, never falling back to another Python.
9. **`trade` entry point.** The Claude command expanded a prompt that invoked the pipeline
   skill; the DSH skill parses the argument shape, then explicitly calls the `skill` tool
   with name `trading-agents-pipeline` and follows it from step 0. It states that it never
   runs pipeline steps itself.
10. **`settle-decisions` entry point.** `$ARGUMENTS` was replaced by an optional `TICKER`
    parsed from the message; `"$TA" memory settle` with/without `--ticker` is written as an
    explicit `if`. The reflector is spawned with the `subagent` tool and the role-load line;
    the same completion-notice rule applies. Added the required report contract: settled,
    waiting, and failed counts (the source only said "say how many are waiting or failed").
11. **Wording.** "Claude Code subagents" → "DSH subagents"; "the bundled wrapper" kept;
    "plugin agents are namespaced: use `trading-agents:<role>`" removed as it no longer
    applies.
12. **Preserved verbatim in meaning.** The absence-marker strings
    (`(No <key> report in this run: it is not available, not an empty finding.)`,
    `<Bull|Bear> Analyst: (argument unavailable this turn.)`, and the risk equivalent), the
    five-value rating set plus `REVIEW` fallback, the final-answer bullet contract, and the
    "pass paths, not report text / never `cat` a full report" rules.
13. **No `ta_run`/`ta_data` tool calls in skills.** Per the port convention the skills use
    the `$TA` / `$TA_ASSEMBLE` wrappers; the plugin tools exist for direct model use, not
    for these procedures.
14. **References are explicit about state.** Every bash block in `references/steps.md`
    repeats the wrapper definitions and starts from the literal `RUN_DIR` / `WORK_DIR`,
    because shell state does not persist between tool calls. `run.env` sourcing is spelled
    out in every later-step block.

## Exact subagent-loads-role-skill contract wording

From `skills/trading-agents-pipeline/SKILL.md` (the wording to mirror in the README):

> Spawn every role with the `subagent` tool, beginning every child prompt with this literal
> first line (substitute the role name):
>
> ```
> First call the `skill` tool with name `trading-agents-<role>` to load your role instructions, then follow them exactly.
> ```
>
> Then append the role's field block from `references/steps.md` (`TICKER`,
> `ANALYSIS_DATE`, input/output paths, `OUTPUT_LANGUAGE`).
>
> The `subagent` tool returns immediately with a child id; the parent gets a completion
> notice when the child settles. Do not read a role's output before that notice — the file
> may be stale or absent. Spawn selected analysts (plus the memory reflector when due) as
> parallel calls in one message; run debate turns sequentially.
