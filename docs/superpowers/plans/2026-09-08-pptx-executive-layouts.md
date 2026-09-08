# Executive-grade PPTX layouts — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `create-pptx-presentation` produces board-ready decks: real charts, KPI tiles, dark cover/closing, one typeface for Thai+English, no watermark — in both outline and finance mode.

**Architecture:** Branch `feat/pptx-exec-design` on top of PR #45 (`feat/pptx-finance-mode`). New shared chrome + generic layouts (`exec-layouts.js`) used by the outline section-agent and reused by the finance renderers, which are restyled in place. Theme tokens grow; branding helpers are deleted across all four file formats.

**Tech Stack:** Node 18/26, pptxgenjs 4.0.1, jszip, jest 29 (run with `NODE_OPTIONS=--experimental-vm-modules`).

**Spec:** `docs/superpowers/specs/2026-09-08-pptx-executive-layouts-design.md`

## Global Constraints
- Every colour token: 6-hex, no `#`. Every text run: `fontFace: theme.fontFace` (`"Leelawadee UI"`).
- Minimum sizes: chart labels 11pt, body 14pt, action title 26pt, KPI number 40pt, cover/statement headline 48pt.
- Every `addChart` call sets: `chartColors`, `showLegend`, `showValue`, `dataLabelFontSize`, `catAxisLabelFontSize`, `valGridLine:{style:"none"}`, `catGridLine:{style:"none"}`, `valAxisLineShow:false`, `catAxisMajorTickMark:"none"`, `chartArea:{fill:{color:<slide bg>}}`, `plotArea:{fill:{color:<slide bg>}}`.
- Per-point bar colours only work with ONE series and `chartColors.length === values.length` (emits `<c:dPt>`). Never use combo charts (array of {type,...}) — corrupt on 4.0.1.
- pptxgenjs writes `ref="A1:B9'"` into embedded workbooks; `fixEmbeddedChartTables` must run on EVERY write (both modes).
- Never mock pptxgenjs in tests; assert on unzipped XML.
- Test command (from repo root): `cd server && NODE_OPTIONS=--experimental-vm-modules node ../node_modules/jest/bin/jest.js __tests__/utils/agents/aibitat/plugins/create-files --runInBand`
- Node 26 locally: if a require chain hits `SlowBuffer`, add at top of the test file: `const b=require("buffer"); if(!b.SlowBuffer) b.SlowBuffer=b.Buffer;`
- Commit with `/usr/bin/git` (hook rewrites bare `git` in worktrees). No `TODO`, no commented-out code.
- Coding mindset (mandatory): no hardcoded environment-dependent values; no unnamed shortcuts — a deliberate simplification is named in a comment with its cost.

File map (all under `server/utils/agents/aibitat/plugins/create-files/` unless noted):
| file | responsibility |
|---|---|
| `pptx/themes.js` | tokens; `executive` = data-forward palette; new keys on all themes |
| `pptx/utils.js` | shared chrome: `addActionTitle`, `addFooter`, `renderCover`, `renderStatement`, `renderContentSlide`, `addTableContent`, `chartBaseOptions` |
| `pptx/exec-layouts.js` (new) | generic layouts: `renderKpi`, `renderChart`, `renderTwoColumn` + `validateExecSection` |
| `pptx/finance-layouts.js` | restyled finance renderers on top of the shared chrome |
| `pptx/finance-schema.js` | adds generic layouts to the enum + validators |
| `pptx/section-agent.js` | prompt + `submit-section-slides` schema |
| `pptx/create-presentation.js` | `headline`/`closing` params, cover/closing, fixer on every write |
| `pdf/utils.js`, `xlsx/utils.js`, `docx/create-docx-file.js`, `docx/utils.js`, `lib.js` | remove branding |
| `server/__tests__/utils/agents/aibitat/plugins/create-files/pptx-exec.test.js` (new) | tests for this plan |

---

### Task 1: Theme tokens

**Files:** Modify `pptx/themes.js`; Test `__tests__/.../create-files/pptx-exec.test.js` (create).

**Produces:** every theme from `getTheme()` has: `fontFace`, `ground`, `groundText`, `groundMuted`, `hairline`, `tileColors` (4), `pillBg`, `good`, `warn`, `bad`, `series` (5), `accentColor`; legacy keys (`fontTitle`, `fontBody`, `chartColors`, `chartPositive`, `chartNegative`, `chartNeutral`, `chartGrid`, `statusGreen/Amber/Red`) still present and equal to the new ones so existing finance tests keep passing.

- [ ] **Step 1: failing test** — create the test file with the harness copied from `pptx-finance.test.js` lines 1-87 (same `setupTool`, `getSlideChartXml`, `storageDir`), then:
```js
describe("exec themes", () => {
  const KEYS = ["fontFace","ground","groundText","groundMuted","hairline","tileColors","pillBg","good","warn","bad","series","accentColor"];
  test("every theme carries every exec token as 6-hex / arrays of 6-hex", () => {
    for (const id of getAvailableThemes()) {
      const t = getTheme(id);
      for (const k of KEYS) expect(t[k]).toBeDefined();
      expect(t.fontFace).toBe("Leelawadee UI");
      expect(t.tileColors).toHaveLength(4);
      expect(t.series).toHaveLength(5);
      for (const v of [t.ground,t.groundText,t.groundMuted,t.hairline,t.pillBg,t.good,t.warn,t.bad,...t.tileColors,...t.series]) expect(v).toMatch(/^[0-9A-F]{6}$/);
      expect(t.chartColors).toEqual(t.series); expect(t.chartPositive).toBe(t.good); expect(t.chartNegative).toBe(t.bad);
      expect(t.fontTitle).toBe(t.fontFace); expect(t.fontBody).toBe(t.fontFace);
    }
  });
  test("executive is the data-forward teal palette", () => {
    const t = getTheme("executive");
    expect(t.accentColor).toBe("0F4C5C"); expect(t.ground).toBe("0F1B1F"); expect(t.titleColor).toBe("141414");
  });
});
```
- [ ] **Step 2: run, expect FAIL** (`fontFace` undefined).
- [ ] **Step 3: implement** — in `themes.js`: replace `FINANCE_THEME_DEFAULTS` with `EXEC_TOKEN_DEFAULTS` applied in `getTheme()` as `deriveTheme(base)`:
```js
function deriveTheme(base) {
  const t = { ...EXEC_TOKEN_DEFAULTS, ...base };
  t.fontFace = t.fontFace || "Leelawadee UI";
  t.fontTitle = t.fontFace; t.fontBody = t.fontFace;
  t.chartColors = t.series; t.chartPositive = t.good; t.chartNegative = t.bad;
  t.chartNeutral = t.groundMuted; t.chartGrid = t.hairline;
  t.statusGreen = t.good; t.statusAmber = t.warn; t.statusRed = t.bad;
  return t;
}
```
`EXEC_TOKEN_DEFAULTS` = `{ ground:"0F1B1F", groundText:"F4F6F5", groundMuted:"9FB0B5", hairline:"D6D9DB", pillBg:"F1F3F2", good:"1E7A4B", warn:"8A6100", bad:"B3261E", tileColors:["0F4C5C","1F5F5B","2E6F6A","3F7E79"], series:["0F4C5C","3A7C8C","6FA3AD","A6C8CE","CBDDE2"] }`.
Per-theme overrides: `executive` → `titleColor:"141414", subtitleColor:"6E7377", bodyColor:"141414", accentColor:"0F4C5C", bulletColor:"0F4C5C", footerColor:"6E7377", footerLineColor:"D6D9DB", titleSlideBackground:"0F1B1F"`; `dark` → `ground:"0F0F1A", tileColors:["312E81","3730A3","4338CA","4F46E5"], series:["818CF8","38BDF8","A1A1AA","F472B6","C4B5FD"], good:"4ADE80", warn:"FBBF24", bad:"F87171", hairline:"3F3F46", pillBg:"27272A"`; `creative` → `ground:"2E1065", tileColors:["4C1D95","5B21B6","6D28D9","7C3AED"], series:["7C3AED","A78BFA","F472B6","2DD4BF","C4B5FD"]`; `corporate` → `ground:"0C1929", tileColors:["0C1929","1A3550","1A5276","2E6F9E"], series:["1A5276","C9943E","7B96B5","2C3E50","B8C4D0"]`; `minimal` → `ground:"171717", tileColors:["262626","404040","525252","737373"], series:["262626","737373","A3A3A3","D4D4D4","E5E5E5"]`; `default` → `ground:"1E293B", tileColors:["1E3A8A","1D4ED8","2563EB","3B82F6"], series:["2563EB","94A3B8","0EA5E9","F59E0B","64748B"]`.
- [ ] **Step 4: run new + `pptx-finance.test.js`, expect PASS.**
- [ ] **Step 5: commit** `feat(pptx): exec theme tokens, one Thai/English typeface (#50)`.

---

### Task 2: Remove branding from all four formats

**Files:** Modify `pptx/utils.js` (delete `addBranding` + its 4 call sites), `pptx/finance-layouts.js` (remove `addBranding` import/call in `addFinanceChrome`), `pdf/utils.js` + `pdf/create-pdf-file.js` (delete `applyBranding`), `xlsx/utils.js` + `xlsx/create-excel-file.js` (delete `applyBranding`), `docx/create-docx-file.js:175` + `docx/utils.js:998-1018` (footer = page number only; drop logo), `lib.js:311-330` (delete `getLogo`, delete `assets/anything-llm*.png`). Test: `pptx-exec.test.js`.

- [ ] **Step 1: failing test**
```js
describe("no watermark", () => {
  test("pptx (finance fixture) has no branding text or image in any slide part", async () => {
    const tool = setupTool(); await tool.call(fixture);
    const file = fs.readdirSync(path.join(storageDir,"generated-files")).find(f=>f.endsWith(".pptx"));
    const zip = await JSZip.loadAsync(fs.readFileSync(path.join(storageDir,"generated-files",file)));
    const slides = Object.keys(zip.files).filter(n=>/^ppt\/slides\/slide\d+\.xml$/.test(n));
    for (const n of slides) { const x = await zip.file(n).async("string"); expect(x).not.toMatch(/Created with|AnythingLLM/); }
    expect(Object.keys(zip.files).some(n=>/^ppt\/media\//.test(n))).toBe(false);
  });
  test("branding helpers are gone", () => {
    expect(require("../../../../../../utils/agents/aibitat/plugins/create-files/lib.js").getLogo).toBeUndefined();
    expect(require("../../../../../../utils/agents/aibitat/plugins/create-files/pdf/utils.js").applyBranding).toBeUndefined();
    expect(require("../../../../../../utils/agents/aibitat/plugins/create-files/xlsx/utils.js").applyBranding).toBeUndefined();
    expect(require("../../../../../../utils/agents/aibitat/plugins/create-files/pptx/utils.js").addBranding).toBeUndefined();
  });
});
```
- [ ] **Step 2: run, expect FAIL.** - [ ] **Step 3: delete the helpers and call sites** (docx footer keeps the page-number cell; drop the 2-cell table for a single paragraph). Grep `getLogo|applyBranding|addBranding|Created with|Generated by AnythingLLM` under `create-files/` → zero hits except `docProps` metadata strings (`pptx.company`, docx `creator`) which stay.
- [ ] **Step 4: run full create-files suite, expect PASS** (existing `lib.test.js` untouched). - [ ] **Step 5: commit** `feat(create-files): remove AnythingLLM watermark from pptx/docx/pdf/xlsx (#50, closes #46)`.

---

### Task 3: Shared chrome — action title, hairline footer, cover, statement

**Files:** Modify `pptx/utils.js`. Test `pptx-exec.test.js`.

**Produces (exports from utils.js):**
- `addActionTitle(slide, theme, title, { y = 0.35 } = {}) → contentStartY` (26pt bold, `fit:"shrink"`, w 8.6, h 0.95, returns 1.45)
- `addFooter(slide, pptx, theme, { slideNumber, totalSlides, note })` — hairline rect at y 5.05 (h 0.007, colour `theme.hairline`), page number left (`x:0.7,y:5.12,w:0.8,fontSize:11,color:footerColor`), `note` right-aligned (`x:1.6,y:5.12,w:7.7,fontSize:11`, `fit:"shrink"`).
- `renderCover(slide, pptx, { title, headline, subtitle, meta }, theme)` — full-slide rect `theme.ground`; `headline || title` at `x:0.6,y:1.5,w:8.8,h:2.2,fontSize:48,bold` colour `groundText`; accent rule `x:0.6,y:1.3,w:0.5,h:0.06` fill `accentColor`; eyebrow (`title` when headline given) `y:0.9,fontSize:14,color:groundMuted`; `subtitle` `y:3.9,fontSize:16`; `meta` `y:4.9,fontSize:12`.
- `renderStatement(slide, pptx, { headline, subtitle }, theme, ctx)` — same ground; headline 48pt at `y:1.9`, subtitle 18pt `groundMuted` at `y:3.6`; no footer.
- `chartBaseOptions(theme, bg)` — returns the Global-Constraints option set with `dataLabelFontSize:11`, `catAxisLabelFontSize:12`, `valAxisLabelFontSize:11`, `dataLabelFontFace/catAxisLabelFontFace/valAxisLabelFontFace: theme.fontFace`, `dataLabelColor: theme.bodyColor`, `catAxisLabelColor: theme.subtitleColor`, `chartArea:{fill:{color:bg},border:{color:bg,pt:0}}`, `plotArea:{fill:{color:bg},border:{color:bg,pt:0}}`, `showTitle:false`.
- `renderContentSlide` / `renderSectionSlide` / `renderTitleSlide` keep their signatures but use the new chrome (`renderTitleSlide` delegates to `renderCover`, `renderSectionSlide` to `renderStatement`); `addTopAccentBar`, `addAccentUnderline`, `addSlideFooter` are deleted (update `finance-layouts.js` imports to `addActionTitle`, `addFooter`, `chartBaseOptions`).

- [ ] **Step 1: failing tests** (helper `async function buildDeck(render)`: new PptxGenJS, `pptx.layout="LAYOUT_16x9"`, `render(pptx.addSlide(), pptx)`, `pptx.write({outputType:"nodebuffer"})`, `JSZip.loadAsync`, return `zip.file("ppt/slides/slide1.xml").async("string")`):
```js
describe("chrome", () => {
  const theme = getTheme("executive");
  test("cover: full-slide ground rect, 48pt headline, Leelawadee UI", async () => {
    const xml = await buildDeck((s,p)=>renderCover(s,p,{title:"รายงาน",headline:"รายได้หาย 36.5%\nกำไรหาย 67.5%",subtitle:"ม.ค.–ก.ย. 2569"},theme));
    expect(xml).toMatch(/<a:srgbClr val="0F1B1F"\/>/); expect(xml).toMatch(/sz="4800"/); expect(xml).toMatch(/typeface="Leelawadee UI"/);
    expect(xml).not.toMatch(/typeface="Calibri"/);
    expect(xml).toMatch(/<a:ext cx="9144000" cy="5143500"\/>/); // full-bleed rect
  });
  test("action title is 26pt bold and footer hairline sits at y=5.05in", async () => {
    const xml = await buildDeck((s,p)=>{ addActionTitle(s,theme,"รายได้ต่ำกว่าแผน 5 ใน 8 เดือน"); addFooter(s,p,theme,{slideNumber:3,totalSlides:8,note:"ที่มา FlowAccount"}); });
    expect(xml).toMatch(/sz="2600" b="1"/); expect(xml).toMatch(/<a:off x="640080" y="4617720"\/>/); expect(xml).toMatch(/3 \/ 8/); expect(xml).toMatch(/ที่มา FlowAccount/);
  });
  test("chartBaseOptions has every mandatory key", () => {
    const o = chartBaseOptions(theme, "FFFFFF");
    for (const k of ["showLegend","showValue","dataLabelFontSize","catAxisLabelFontSize","valGridLine","catGridLine","valAxisLineShow","catAxisMajorTickMark","chartArea","plotArea"]) expect(o).toHaveProperty(k);
    expect(o.valGridLine).toEqual({style:"none"}); expect(o.plotArea.fill.color).toBe("FFFFFF"); expect(o.dataLabelFontSize).toBeGreaterThanOrEqual(11);
  });
});
```
(EMU: 1in = 914400; 0.7in = 640080; 5.05in = 4617720.)
- [ ] **Step 2: FAIL.** - [ ] **Step 3: implement** as specified; keep `isDarkColor`. - [ ] **Step 4: PASS incl. finance suite.** - [ ] **Step 5: commit** `feat(pptx): action-title chrome, cover/statement slides, chart base options (#50)`.

---

### Task 4: Generic layouts `kpi`, `chart`, `two-column` + validation

**Files:** Create `pptx/exec-layouts.js`; Modify `pptx/finance-schema.js` (add to `FINANCE_LAYOUTS` + `VALIDATORS`: `kpi`, `chart`, `two-column`, `statement`). Test `pptx-exec.test.js`.

**Produces:** `module.exports = { EXEC_RENDERERS: { kpi, chart, "two-column": twoColumn, statement }, validateExecSection(section, path, errors), CHART_TYPES }`, renderer signature `(slide, pptx, section, theme, ctx)` identical to finance renderers; `ctx = { slideNumber, totalSlides, note?, bg }`.

Schemas (`data` object):
- kpi: `{ kpis: [{label:string, value:number|string, unit?:string, delta?:string, status?:"good"|"warn"|"bad", note?:string}] }` length 2..4.
- chart: `{ type: "bar"|"column"|"line"|"area"|"pie"|"doughnut"|"bridge", categories:string[], series:[{name:string, values:number[]}], valueFormat?:string, highlight?:number[], note?:string }`; every `values.length === categories.length`; `bridge`/`pie`/`doughnut` require exactly 1 series; `highlight` indexes in range.
- two-column: `{ chart: <chart data>, points: string[] }` points 2..4.
- statement: `{ headline:string, subtitle?:string }`.
Validation failure in finance mode → same fail-closed error path as other layouts. In outline mode (section agent) the renderer is called through `renderOrFallback` (Task 6) which downgrades to `content` with the numbers as text and logs.

Rendering rules:
- kpi: tiles in a row (`n ≤ 3`) or 2×2 (`n = 4`); tile fill `theme.tileColors[i]`; label 14pt `groundText`; value 40pt bold `groundText` (`fit:"shrink"`); delta on a `roundRect` pill (`fill: theme.pillBg`, `rectRadius:0.12`) 18pt bold coloured `theme[status] || theme.bodyColor`; note 12pt `groundMuted`. Geometry for 2×2: tile w 4.2, h 1.55, gap 0.2, from `y=1.5`.
- chart: `addActionTitle`, then `slide.addChart(map[type], data, {...chartBaseOptions(theme, ctx.bg), x:0.7,y:1.45,w:8.6,h:3.35, ...typeOpts})`. `map`: column→`bar` with `barDir:"col"`, bar→`bar` `barDir:"bar"`, line/area/pie/doughnut→same names, bridge→`bar`,`barDir:"col"`. Single-series bar/column colours: `chartColors = values.map((v,i)=> highlight?.includes(i) ? theme.accentColor : theme.series[3])` (muted non-focus); when no `highlight`: all `theme.accentColor`. Bridge: `chartColors = values.map((v,i)=> i===0||i===last ? theme.accentColor : v<0 ? theme.bad : theme.good)`, `invertedColors` = same array, `valAxisMinVal/MaxVal` symmetric to `roundedAxisMax(max|v|)`, `catAxisLabelPos:"low"`. Multi-series: `chartColors = theme.series`, `showLegend:true`, `legendPos:"b"`, `legendFontSize:12`. Doughnut: `holeSize:62`, `showValue:false`, `showPercent:true`, `dataLabelPosition:"ctr"`, total in the hole via `addText` 28pt bold. Value labels: `dataLabelFormatCode: valueFormat || "#,##0.##"`, `dataLabelPosition:"outEnd"` for bars.
- two-column: chart frame `x:0.7,y:1.45,w:4.9,h:3.35`; points as 3 `addText` rows at `x:5.9,w:3.4`, 16pt, with a `theme.accentColor` square 0.1×0.1 bullet; hairline between rows.
- statement: delegate to `renderStatement`.
Every renderer ends with `addFooter(slide,pptx,theme,{slideNumber:ctx.slideNumber,totalSlides:ctx.totalSlides,note:section.data.note||ctx.note})` except `statement`.

- [ ] **Step 1: failing tests** (helper `renderOne(layout, data, themeId="executive")` → builds a deck with `EXEC_RENDERERS[layout](slide, pptx, {layout,title:"T",data}, theme, {slideNumber:1,totalSlides:1,bg:theme.background})`, returns `{slideXml, chartXmls}` using `getSlideChartXml(zip,1)`):
```js
describe("exec layouts", () => {
  test("kpi: 4 tiles, 40pt numbers, delta in theme.bad", async () => {
    const { slideXml } = await renderOne("kpi", { kpis: [
      {label:"รายได้",value:16994313,delta:"-36.5%",status:"bad"},{label:"ค่าใช้จ่าย",value:14453214,delta:"-23.7%",status:"warn"},
      {label:"กำไรสุทธิ",value:2541099,delta:"-67.5%",status:"bad"},{label:"อัตรากำไร",value:"15.0%",delta:"-14.2 pt",status:"bad"} ]});
    expect((slideXml.match(/sz="4000" b="1"/g)||[]).length).toBe(4);
    expect(slideXml).toMatch(/<a:srgbClr val="B3261E"\/>/); expect(slideXml).toMatch(/<a:srgbClr val="8A6100"\/>/);
    expect(slideXml).toMatch(/16,994,313/);
  });
  test("chart column with highlight: 8 dPt, index 6 accent, others muted, no gridlines", async () => {
    const { chartXmls } = await renderOne("chart", { type:"column", categories:["ม.ค.","ก.พ.","มี.ค.","เม.ย.","พ.ค.","มิ.ย.","ก.ค.","ส.ค."], series:[{name:"รายได้",values:[2.35,2.2,2.05,1.95,1.92,1.83,2.89,1.81]}], highlight:[6] });
    const x = chartXmls[0]; const dpts = x.match(/<c:dPt>[\s\S]*?<\/c:dPt>/g);
    expect(dpts).toHaveLength(8); expect(dpts[6]).toMatch(/0F4C5C/); expect(dpts[0]).toMatch(/A6C8CE/);
    expect(x).not.toMatch(/<c:majorGridlines>/); expect(x).toMatch(/sz="1100"/); expect(x).toMatch(/typeface="Leelawadee UI"/);
  });
  test("bridge: negatives bad, positives good, ends accent, symmetric axis", async () => {
    const { chartXmls } = await renderOne("chart", { type:"bridge", categories:["2568","รายได้หาย","ค่าบริการ","พนักงาน","เบ็ดเตล็ด","อื่นๆ","2569"], series:[{name:"กำไร",values:[7.82,-9.75,-1.8,0.99,4.93,0.35,2.54]}] });
    const d = chartXmls[0].match(/<c:dPt>[\s\S]*?<\/c:dPt>/g);
    expect(d[0]).toMatch(/0F4C5C/); expect(d[1]).toMatch(/B3261E/); expect(d[3]).toMatch(/1E7A4B/); expect(d[6]).toMatch(/0F4C5C/);
    expect(chartXmls[0]).toMatch(/<c:min val="-12"\/>/); expect(chartXmls[0]).toMatch(/<c:max val="12"\/>/);
  });
  test("doughnut: hole + total text", async () => {
    const { slideXml, chartXmls } = await renderOne("chart", { type:"doughnut", categories:["a","b"], series:[{name:"s",values:[7.8,4.26]}] });
    expect(chartXmls[0]).toMatch(/<c:holeSize val="62"\/>/); expect(slideXml).toMatch(/12\.06/);
  });
  test("two-column: chart on the left half, points on the right", async () => {
    const { slideXml, chartXmls } = await renderOne("two-column", { chart:{type:"doughnut",categories:["a","b"],series:[{name:"s",values:[1,2]}]}, points:["หนึ่ง","สอง","สาม"] });
    expect(chartXmls).toHaveLength(1);
    const xs = [...slideXml.matchAll(/<a:off x="(\d+)"/g)].map(m=>+m[1]); expect(Math.max(...xs)).toBeGreaterThanOrEqual(5.9*914400);
    expect(slideXml).toMatch(/หนึ่ง/);
  });
  test("validation: length mismatch, >4 kpis, bridge with 2 series are errors", () => {
    const errs=[]; validateExecSection({layout:"chart",title:"t",data:{type:"bar",categories:["a"],series:[{name:"s",values:[1,2]}]}},"sections[0]",errs);
    validateExecSection({layout:"kpi",title:"t",data:{kpis:new Array(5).fill({label:"l",value:1})}},"sections[1]",errs);
    validateExecSection({layout:"chart",title:"t",data:{type:"bridge",categories:["a"],series:[{name:"s",values:[1]},{name:"t",values:[1]}]}},"sections[2]",errs);
    expect(errs).toHaveLength(3); expect(errs[0]).toMatch(/sections\[0\]/);
  });
});
```
- [ ] **Step 2: FAIL.** - [ ] **Step 3: implement** `exec-layouts.js` (reuse `roundedAxisMax`, `formatNumber` from `finance-layouts.js` — import them; do not duplicate). Register in `finance-schema.js`: `FINANCE_LAYOUTS.kpi/chart/["two-column"]/statement` with descriptions; `VALIDATORS[...] = (data,path,errors)=>validateExecSection({layout,data},path,errors)`. - [ ] **Step 4: PASS + finance suite.** - [ ] **Step 5: commit** `feat(pptx): generic kpi/chart/two-column/statement layouts (#50)`.

---

### Task 5: Restyle finance renderers on the shared chrome

**Files:** Modify `pptx/finance-layouts.js`. Test: existing `pptx-finance.test.js` must stay green; add to `pptx-exec.test.js`.

Changes:
- `addFinanceChrome` → `addActionTitle` + returns 1.45; subtitle becomes the footer `note` (`ctx.note = section.subtitle`), not a second line under the title; `addDeckFooter` merged into `addFooter` (`note` = `[subtitle, "งวด …", "แหล่งข้อมูล …", "จัดทำ …"].filter(Boolean).join(" · ")`).
- `commonChartOptions(theme)` → `chartBaseOptions(theme, theme.background)` (deletes the old function).
- Font sizes: `catAxisLabelFontSize` 12, value labels 11, tiles: `renderSummary` metrics use the Task-4 `kpi` tile renderer (`EXEC_RENDERERS.kpi` with `status` derived from `delta` sign: `>=0 → good`, else `bad`) placed at `y=2.35` under a 16pt narrative; verdict pill 14pt.
- `renderScorecard` table: header fill `theme.accentColor`, 14pt cells, hairline borders `theme.hairline`, status dot 0.14in.
- `renderDecisions` cards: number 28pt `accentColor`, title 18pt, body 14pt, no left accent strip (hairline row separators instead).
- `renderTrendBar`, `renderBarDonut`, `renderCash`, `renderRankedPair`, `renderRisksOutlook`: only option/size updates (labels ≥ 11pt, `dataLabelFontSize:11`, no gridlines, plot fill).
- `renderWaterfall`: unchanged construction (stacked, base series = `theme.background`); labels 11pt.

- [ ] **Step 1: failing test**
```js
test("finance fixture renders with no font below 11pt, no Calibri, no gridlines, action titles at 26pt", async () => {
  const tool = setupTool(); await tool.call({...copy(fixture), filename:"restyle.pptx"});
  const file = path.join(storageDir,"generated-files", fs.readdirSync(path.join(storageDir,"generated-files")).find(f=>f.endsWith(".pptx")));
  const zip = await JSZip.loadAsync(fs.readFileSync(file));
  for (const n of Object.keys(zip.files).filter(n=>/^ppt\/(slides\/slide|charts\/chart)\d+\.xml$/.test(n))) {
    const x = await zip.file(n).async("string");
    for (const m of x.matchAll(/ sz="(\d+)"/g)) expect(+m[1]).toBeGreaterThanOrEqual(1100);
    expect(x).not.toMatch(/Calibri/); expect(x).not.toMatch(/<c:majorGridlines>/);
  }
  expect(await zip.file("ppt/slides/slide2.xml").async("string")).toMatch(/sz="2600" b="1"/);
});
```
- [ ] **Step 2: FAIL.** - [ ] **Step 3: implement.** - [ ] **Step 4: PASS; run the whole create-files dir.** - [ ] **Step 5: commit** `refactor(pptx): finance layouts on the exec chrome, ≥11pt everywhere (#50)`.

---

### Task 6: Section agent + tool wiring (outline mode gets charts; cover/closing; fixer on every write)

**Files:** Modify `pptx/section-agent.js`, `pptx/create-presentation.js`. Test `pptx-exec.test.js`.

Changes:
- `section-agent.js` `SECTION_BUILDER_PROMPT` rules block replaced with:
```
RULES:
- 1 to 3 slides for this section. One idea per slide. The slide title IS the conclusion — a full sentence that contains the key number (e.g. "รายได้ต่ำกว่าแผน 5 ใน 8 เดือน"), never a topic label.
- Any 3+ numbers over time or categories MUST be a "chart" slide. 2–4 headline metrics MUST be a "kpi" slide. Bullets are for arguments only: max 3 per slide, ≤ 12 words each.
- Never emit a "statement" slide that only repeats the next slide's title. Use "statement" only for a section verdict that stands alone.
- Put source / period / caveat in "note" (one line), not in bullets.
- Numbers in chart/kpi data are raw numbers, never formatted strings.
```
and the layout list: `kpi`, `chart`, `two-column`, `statement`, `content` (with optional table). `blank` removed. `submit-section-slides` schema: `layout` enum `["statement","content","kpi","chart","two-column"]`, add `data: { type:"object" }` and `note: { type:"string" }`; `buildFallbackSlides` emits `statement` + `content`.
- `create-presentation.js`: new params `headline` (string, "one-sentence verdict shown on the cover"), `closing` (`{ headline, subtitle }`), `note` (string, footer on every content slide; finance `footer` object still builds the note string). Cover = `renderCover(slide, pptx, { title, headline, subtitle: `${footer.period||""}`, meta: [author, footer.source, footer.preparedOn].filter(Boolean).join(" · ") }, theme)`. After the loop, if `closing` → `renderStatement`. Render loop: `const renderer = RENDERERS[layout] || EXEC_RENDERERS[layout]`; in outline mode wrap: `renderOrFallback(renderer, ...)` — try `validateExecSection`; on errors log `create-pptx-presentation: slide ${n} ${errors.join("; ")} — falling back to content` and render `content` with `content: [JSON.stringify(slideData.data).slice(0,300)]`. `fixEmbeddedChartTables` runs on every write (drop the `mode === "finance"` guard). `totalSlideCount` includes the closing slide.
- Tool `description`/`examples`: mention charts and the `headline` param.

- [ ] **Step 1: failing tests**
```js
describe("outline mode with exec layouts", () => {
  test("section agent schema exposes exec layouts and no blank; prompt carries the chart rule", () => {
    const src = fs.readFileSync(require.resolve("../../../../../../utils/agents/aibitat/plugins/create-files/pptx/section-agent.js"),"utf8");
    expect(src).toMatch(/enum: \["statement", "content", "kpi", "chart", "two-column"\]/); expect(src).not.toMatch(/"blank"/); expect(src).toMatch(/MUST be a "chart" slide/);
  });
  test("outline deck: cover from headline, chart slide from agent, closing statement, keynote fix applied", async () => {
    runSectionAgent.mockResolvedValueOnce({ slides:[{layout:"chart",title:"รายได้ต่ำกว่าแผน",data:{type:"column",categories:["a","b","c"],series:[{name:"s",values:[1,2,3]}]}}], citations:[] });
    const tool = setupTool();
    await tool.call({ filename:"outline.pptx", title:"รายงานผู้บริหาร", headline:"รายได้หาย 36.5%", closing:{headline:"ปิดปีที่ 25.49 ล้าน"}, sections:[{title:"x"}] });
    const file = path.join(storageDir,"generated-files", fs.readdirSync(path.join(storageDir,"generated-files")).sort().pop());
    const zip = await JSZip.loadAsync(fs.readFileSync(file));
    expect(await zip.file("ppt/slides/slide1.xml").async("string")).toMatch(/รายได้หาย 36.5%/);
    expect((await getSlideChartXml(zip,2))).toHaveLength(1);
    expect(await zip.file("ppt/slides/slide3.xml").async("string")).toMatch(/ปิดปีที่ 25.49/);
    const wb = await JSZip.loadAsync(await zip.file(Object.keys(zip.files).find(n=>/embeddings\/.*xlsx$/.test(n))).async("nodebuffer"));
    expect(await wb.file("xl/tables/table1.xml").async("string")).not.toMatch(/'"/);
  });
  test("outline deck: invalid chart data falls back to a content slide, deck still written", async () => {
    runSectionAgent.mockResolvedValueOnce({ slides:[{layout:"chart",title:"bad",data:{type:"column",categories:["a"],series:[{name:"s",values:[1,2]}]}}], citations:[] });
    const tool = setupTool(); const r = await tool.call({ filename:"fallback.pptx", title:"t", sections:[{title:"x"}] });
    expect(r).toMatch(/Successfully created/); expect(tool.aibitat.handlerProps.log).toHaveBeenCalledWith(expect.stringMatching(/falling back to content/));
  });
});
```
- [ ] **Step 2: FAIL.** - [ ] **Step 3: implement.** - [ ] **Step 4: PASS whole dir; also `(f)`/`(g)` finance switch tests.** - [ ] **Step 5: commit** `feat(pptx): outline mode emits charts/kpi, cover headline + closing, keynote fix always (#50)`.

---

### Task 7: Preview deck + visual verification (PMO)

**Files:** Modify `pptx/test-themes.js` — `SAMPLE_SLIDES` becomes the INFI deck (cover headline, kpi, chart column with highlight, two-column doughnut, bridge, content decisions, closing) using the numbers in `docs/superpowers/mockups/pptx-directions/data.js`; one deck per theme.

- [ ] **Step 1:** run `cd server && node utils/agents/aibitat/plugins/create-files/pptx/test-themes.js` (Node 26: prepend `const b=require("buffer");if(!b.SlowBuffer)b.SlowBuffer=b.Buffer;` in the script, named as a local-runtime shim).
- [ ] **Step 2 (PMO, not the implementer):** `soffice --headless --convert-to pdf` + `pdftoppm -png -r 80` on `theme-preview-executive.pptx`; compare with `preview-2-data.png`. Open the pptx in Keynote to confirm charts render (fixer). Findings go back as a fix round on the relevant task.
- [ ] **Step 3: commit** `chore(pptx): theme preview deck exercises every exec layout (#50)`.
