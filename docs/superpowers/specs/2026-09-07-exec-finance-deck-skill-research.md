# Research: executive finance deck skill for AnythingLLM agent

Status: research only, no spec approved yet. Date 2026-09-07.

## Why

User asked FlowAccount-connected agent (workspace `infi`) for a 7-slide finance PPTX. Agent had no file tool (Document Creation off) and hallucinated an "Add folder" permission. Even with Document Creation on, the built-in tool cannot draw charts, has no finance structure, and hands each section to a web-searching sub-agent that will pad slides with internet filler instead of FlowAccount numbers.

## What exists today

Built-in `create-pptx-presentation` (`server/utils/agents/aibitat/plugins/create-files/pptx/`):

| Capability | Status |
|---|---|
| Library | `pptxgenjs` 4.0.1 already in `server/package.json` |
| Layouts | `section`, `content` (bullets), `blank`; tables via `slideData.table` |
| Charts | none (`addChart` never called) |
| Content source | per-section sub-agent with web search + scrape (`section-agent.js`) |
| Themes | 4 named themes in `themes.js` |
| Output | `storage/generated-files/<file>`, served by `/agent-skills/generated-files/:filename` |
| Availability | `ANYTHING_LLM_RUNTIME=docker` (dev2 OK) or `NODE_ENV=development` |

Custom agent skill contract (docs.anythingllm.com/agent/custom): folder `storage/plugins/agent-skills/<hubId>/` with `plugin.json` (`entrypoint.params` types limited to string/number/boolean) + `handler.js` exporting `runtime.handler` that returns a string. Bundled deps must live inside the folder; `require("pptxgenjs")` from the server node_modules works at runtime on dev2 but is not guaranteed by the contract.

## What "executive finance deck" means (sources)

Consensus across Umbrex CFO handbook, XLSlides CFO guide, Pragmatic CFO board pack, Rework FA playbook:

1. **Answer-first cover**: 2 sentences + 3 numbers + verdict (on plan / below / mixed). No agenda slide.
2. **KPI scorecard**: 6 to 12 tiles, each actual vs plan vs prior period, traffic-light colour, trend arrow. No commentary on this slide.
3. **Variance bridge**: waterfall from plan (or prior period) to actual. Drivers named as timing / structural / investment. Word "timing" alone is banned; name the deal or the cost.
4. **Trend**: 6 to 9 periods, plan band shaded, one annotation per line that moved >10%.
5. **Cash and liquidity**: balance, 13-week view, working capital (AR aging, DSO, DPO).
6. **Concentration cut**: ranked bar of where the variance comes from (customer, product, expense head).
7. **Outlook / forecast reset**: prior vs revised with bridge.
8. **Risks**: top 3 to 5, owner, mitigation.
9. **Decisions requested**: numbered asks with cost, return, kill condition.
10. Appendix: everything else, footer with period, source, and "prepared by".

Style rules: action titles that read as conclusions; one number format for the whole deck; variance columns always same position and sign; no stock photos; charts native (not images); 8 to 12 core slides.

## pptxgenjs gotchas (anthropics/skills pptx SKILL.md)

- Hex colours without `#`, never 8-digit.
- Never reuse an options object across two `add*` calls (mutated to EMU in place).
- Set `pres.layout` before adding slides; `LAYOUT_16x9` is 10" x 5.625".
- `addChart()` for every native chart type; set `showTitle`, `showValue`, `chartColors`, quiet gridlines, `showLegend:false` for single series.
- Stacked bar: `dataLabelPosition` must be `ctr | inEnd | inBase`, `outEnd` corrupts the file.
- Combo chart with secondary axis needs both `valAxes` and `catAxes` (2 entries each) or PowerPoint discards the chart.
- Waterfall: not native in pptxgenjs; build as stacked bar with an invisible base series.
- `bullet:true` per item, `breakLine:true` on all but last, `paraSpaceAfter` for spacing.
- Speaker notes via `slide.addNotes()`.
- Validate output; LibreOffice renders files PowerPoint rejects.

## Options

### A. Extend built-in tool (recommended)

Add a `finance` mode to `create-pptx-presentation`: new layouts `scorecard`, `waterfall`, `trend`, `ranked_bar`, `decisions`; sections take structured `data` (numbers the agent already fetched from FlowAccount) instead of free text; section sub-agent disabled in this mode so no web padding. Theme `executive` (navy / grey / one accent, tabular numerals, footer with period + source). Charts through `addChart` per gotchas above.

Pros: one code path, reuses existing download endpoint and tests, per-workspace skill toggle already works. Cons: modifies core plugin, needs infi-dev round with mockup (has UI output).

### B. Custom agent skill `exec-finance-deck`

Standalone folder in `storage/plugins/agent-skills/`, own `handler.js` calling `pptxgenjs`. Takes a JSON string param (`deck`) because custom params are scalar only. Pros: no core change, installable per instance via Community Hub. Cons: `require("pptxgenjs")` outside the folder violates the contract; must bundle 2 MB of node_modules or vendor; JSON-in-string param is brittle for the LLM; no per-workspace toggle (imported skills are global).

### C. Prompt-only

System prompt for workspace `infi` describing the 9-slide structure and telling the agent to call the existing tool with tables. No charts. Zero code. Good enough for a first read, not for executives.

## Recommendation

Option C today (5 min, unblocks the user), Option A as the next infi-dev task after #37. Option B only if the skill must ship outside this fork.

## Data the deck needs from FlowAccount (already reachable via MCP)

`accounting__get_profit_loss` (period vs compare), `accounting__list_cash_receipts` / `list_cash_payments`, `accounting__get_ar_aging`, `sales__list_*` and `expense__list_*` by period for concentration cuts, `overview__*` for KPI tiles. All 62 tools were listed on dev2 on 2026-09-07.
