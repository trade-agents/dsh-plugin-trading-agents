# roles/ port — 13 subagent role definitions

Source: `/Users/huike/Project/trading-workspace/trading-agents-plugin/agents/` (read-only)
Target: `/Users/huike/Project/trading-workspace/dsh-plugin-trading-agents/roles/`

All 13 roles were ported with a deterministic transform, then diffed back against the
source bodies. After reversing only the two sanctioned edits (the `$TA`/`$TA_ASSEMBLE`
replacement and the inserted CLI-wrapper block), **every target body is byte-identical to
its source body** — no analytical rule, hard rule, table, output shape, or `## Return`
block was shortened or reworded.

## Files

| Role | Source file | Target file | Chars (target) |
| --- | --- | --- | ---: |
| aggressive-risk-analyst | `agents/aggressive-risk-analyst.md` | `roles/aggressive-risk-analyst.md` | 2554 |
| bear-researcher | `agents/bear-researcher.md` | `roles/bear-researcher.md` | 2765 |
| bull-researcher | `agents/bull-researcher.md` | `roles/bull-researcher.md` | 2623 |
| conservative-risk-analyst | `agents/conservative-risk-analyst.md` | `roles/conservative-risk-analyst.md` | 2565 |
| fundamentals-analyst | `agents/fundamentals-analyst.md` | `roles/fundamentals-analyst.md` | 3602 |
| market-analyst | `agents/market-analyst.md` | `roles/market-analyst.md` | 4730 |
| memory-reflector | `agents/memory-reflector.md` | `roles/memory-reflector.md` | 2715 |
| neutral-risk-analyst | `agents/neutral-risk-analyst.md` | `roles/neutral-risk-analyst.md` | 2364 |
| news-analyst | `agents/news-analyst.md` | `roles/news-analyst.md` | 4029 |
| portfolio-manager | `agents/portfolio-manager.md` | `roles/portfolio-manager.md` | 2919 |
| research-manager | `agents/research-manager.md` | `roles/research-manager.md` | 2338 |
| sentiment-analyst | `agents/sentiment-analyst.md` | `roles/sentiment-analyst.md` | 5601 |
| trader | `agents/trader.md` | `roles/trader.md` | 2684 |

All 13 are < 8000 chars (largest: `sentiment-analyst.md`, 5601).

## Frontmatter shape applied

```yaml
---
name: <basename>
description: "<source description, Claude-Code phrasing dropped>"
whenToUse: "Load this role only when the trading-agents pipeline asks you to act as the <role>."
---
```

`tools:` and `model:` lines were dropped. Body mentions of reading/writing files were left
untouched (DSH's read/write tools cover them).

## Deviations / decisions

1. **No `${TRADING_AGENTS_RESULTS_DIR...}` or `~/.claude/trading-agents` occurrences existed
   in any source role.** Rules 3 and 4 of the port spec were therefore no-ops (verified by
   grep over all 13 sources). Every `~/.claude`-style default in this plugin lives outside
   `roles/` (skills/scripts); nothing needed rewriting here.
2. **The CLI-wrapper block was added only to the 5 roles that invoke the wrapper**:
   `fundamentals-analyst`, `market-analyst`, `news-analyst`, `sentiment-analyst`,
   `memory-reflector`. These are the only roles with a "The wrapper works from any
   directory:" sentence or a `## Data` data-access section. The other 8 roles (bull/bear
   researchers, research manager, trader, portfolio manager, 3 risk analysts) receive file
   paths as input, call no CLI, and have no data-access paragraph — a shell preamble there
   would be unused and contrary to the "in the section that currently says…" instruction.
3. **`sentiment-analyst` insertion point**: its source has no "wrapper works from any
   directory:" sentence, so the block was inserted immediately after the `## Data` heading,
   before the existing `ta sentiment` command block.
4. **`TA_ASSEMBLE` line included** in the block exactly as prescribed, although no role body
   currently calls `ta-assemble` (report assembly is done by the pipeline/orchestrator).
5. **Descriptions**: only Claude-Code-specific phrasing was dropped ("Use as the X agent in
   the trading-agents pipeline"). Non-Claude-Code routing clauses such as "or for
   statement-level due diligence on a company" were kept, reworded into a routing hint.
   `memory-reflector`'s "Use to settle past decisions so later runs can learn from their
   outcomes" was kept as-is (not Claude-Code-specific). Descriptions are one line each and
   contain no nested quotes; `whenToUse` is a fixed one-sentence hint per role.

## Validation

```
$ ls roles/ | wc -l
13

$ grep -R "CLAUDE_PLUGIN_ROOT\|\.claude/\|subagent_type" roles/ || echo clean
clean

$ wc -c roles/*.md   # all < 8000 (see table above; largest 5601)

$ grep -c '^## Return$' roles/*.md
1 in every file (13/13)

Path instructions present (spot-check):
  ARGUMENT_PATH: aggressive-risk-analyst, bear-researcher, bull-researcher,
                 conservative-risk-analyst, neutral-risk-analyst
  REPORT_PATH:   fundamentals-analyst, market-analyst, news-analyst, sentiment-analyst
  DECISION_PATH: portfolio-manager
  PLAN_PATH:     research-manager
  PROPOSAL_PATH: trader
  WORK_DIR:      memory-reflector
```

Body equivalence check: for all 13 files, reversing the `$TA`/`$TA_ASSEMBLE` substitution
and removing the inserted wrapper block reproduces the source body exactly (`IDENTICAL BODY`
for 13/13).
