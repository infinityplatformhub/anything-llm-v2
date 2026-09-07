# Finance mode for `create-pptx-presentation` — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Agent สร้าง PPTX ผู้บริหาร 9 สไลด์จากตัวเลขที่ดึงจาก FlowAccount แล้ว ใน 1 tool call มี chart แบบ native ผ่าน `pptxgenjs addChart` ไม่เรียก sub-agent ค้นเว็บ โหมดเดิม (`outline`) ต้องไม่เปลี่ยนพฤติกรรมเลย

**Architecture:** เพิ่ม param `mode` ให้ tool เดิม. `outline` (default) = โค้ดเดิมทุกบรรทัด. `finance` = validate `sections[].{layout,data}` แบบ fail-closed → render ตรงด้วย renderer ใหม่ใน `pptx/finance-layouts.js` (1 ฟังก์ชันต่อ layout, ทุกตัวรับ `(slide, pptx, section, theme, ctx)`) → เขียนไฟล์ผ่าน `saveGeneratedFile` เดิม. Theme ใหม่ `executive` ใน `themes.js` เพิ่ม chart tokens (`chartColors`, `chartPositive`, `chartNegative`, `chartNeutral`, `chartGrid`). Validation อยู่ใน `pptx/finance-schema.js` แยกจาก renderer เพื่อเทสได้โดยไม่สร้างไฟล์.

**Tech Stack:** Node, pptxgenjs 4.0.1 (มีอยู่แล้ว), jszip 3.10.1 (dependency ของ pptxgenjs, require ตรงได้จาก `server/`), Jest.

**Issue:** #38 · **Spec:** `docs/superpowers/specs/2026-09-07-exec-finance-deck-mode.md` · **Mockup:** `docs/superpowers/mockups/exec-finance-deck.html` @ `56f157f5` (blob `1de6d3ea`)

**Evidence contract:** `cd server && NODE_OPTIONS=--experimental-vm-modules node ../node_modules/jest/bin/jest.js __tests__/utils/agents/aibitat/plugins/create-files/pptx-finance.test.js --runInBand` → output มี `pptx-finance` และ `passed`

**Ledger:** `.superpowers/sdd/exec-finance-deck/ledger.md` — ทุก ruling จด `Ruling: <what> — <why> — <cost if wrong>`

**Repo quirks (ใส่ในทุก brief):**
- jest ต้องรัน `cd server && node ../node_modules/jest/bin/jest.js <path>` (ห้าม npx)
- ใน worktree session ใช้ `/usr/bin/git` และ `node node_modules/eslint/bin/eslint.js`
- ห้าม `require` อะไรที่ดึง `@prisma/client` หรือ `jsonwebtoken` เข้าเทสนี้ (ไม่จำเป็น และ Node 26 ไม่มี SlowBuffer)
- เทสที่สร้างไฟล์จริงต้องตั้ง `process.env.STORAGE_DIR` เป็น `fs.mkdtempSync` ก่อน `require` lib (lib อ่าน env ตอน init) และลบทิ้งใน `afterAll`
- pptxgenjs: สี 6 หลักไม่มี `#`; options object ใหม่ทุก `add*`; stacked bar `dataLabelPosition` ∈ `ctr|inEnd|inBase`; `showLegend:false` เมื่อ series เดียว; ห้าม gradient fill
- Tool handler ต้อง return string เสมอ

---

## File map

| Path | Action | Responsibility |
|---|---|---|
| `server/utils/agents/aibitat/plugins/create-files/pptx/finance-schema.js` | create | `FINANCE_LAYOUTS` (รายชื่อ + required fields), `validateFinanceSections(sections) → {ok, errors[]}` รวมกฎ waterfall tie และ status enum; pure, ไม่ require pptxgenjs |
| `server/utils/agents/aibitat/plugins/create-files/pptx/finance-layouts.js` | create | renderer 9 layout + `formatBaht(n)` + `addDeckFooter(slide, theme, footer)`; ใช้ `slide.addChart` |
| `server/utils/agents/aibitat/plugins/create-files/pptx/themes.js` | modify | เพิ่ม theme `executive` + chart tokens; theme เดิมเพิ่ม chart tokens default เพื่อไม่ให้ finance-layouts พังเมื่อผู้ใช้เลือก theme อื่น |
| `server/utils/agents/aibitat/plugins/create-files/pptx/create-presentation.js` | modify | param `mode`, `footer`, `unit`; branch finance ข้าม `runSectionAgent`; description/examples เพิ่ม 1 ตัวอย่าง finance; approval payload บอก mode |
| `server/__tests__/utils/agents/aibitat/plugins/create-files/pptx-finance.test.js` | create | evidence contract (ดูรายการเทสด้านล่าง) |
| `server/__tests__/utils/agents/aibitat/plugins/create-files/fixtures/finance-deck.json` | create | tool input 9 section ตรงกับ mockup (ตัวเลขชุดเดียวกับ mockup) |

---

## Task 1 — schema + validation + mode switch (ไม่มี chart ยัง)

**Files:** `finance-schema.js` (create), `create-presentation.js` (modify), `pptx-finance.test.js` (create), `fixtures/finance-deck.json` (create)

- [ ] เขียน `fixtures/finance-deck.json`: `{filename, title, theme:"executive", mode:"finance", unit:"บาท", footer:{period,source,preparedOn}, sections:[9 รายการตาม spec ตาราง layout/data]}` ตัวเลขคัดจาก mockup (`docs/superpowers/mockups/exec-finance-deck.html` ค้น `const DECK` หรือ JSON panel) waterfall ต้อง tie: 2,714,000 + 1,640,000 − 210,000 − 1,210,000 − 404,000 = 2,530,000
- [ ] เทส RED ก่อน: (a) `validateFinanceSections(fixture.sections).ok === true`; (b) ตัด `data.end` ออกจาก waterfall → `ok:false`, `errors[0]` มี `sections[4]` และ `end`; (c) waterfall end ผิด 1,000 → error มีคำ `tie`; (d) scorecard status `"blue"` → error; (e) layout `"pie"` → error บอก layout ที่รองรับ
- [ ] implement `finance-schema.js` ให้ (a)–(e) เขียว. `errors` เป็น string array อ่านได้ทันทีโดย LLM (จะถูก return เป็น tool output)
- [ ] `create-presentation.js`: เพิ่ม properties `mode` (enum `outline|finance`, default `outline`), `unit` (string), `footer` (object `{period,source,preparedOn}`); ใน handler ถ้า `mode==="finance"` → validate ก่อน approval; ไม่ผ่านให้ return `"Cannot build finance deck: " + errors.join("; ")` และ **ไม่** เรียก `requestToolApproval`/`saveGeneratedFile`; ผ่านแล้ว **ข้าม** loop `runSectionAgent` และส่ง `sections` ตรงไป render (Task 2/3 จะเติม renderer; ตอนนี้ให้ layout ที่ยังไม่มี renderer fallback เป็น `renderContentSlide` ที่แสดง `title` + bullet "layout <x> pending")
- [ ] เทส mode switch: mock `./section-agent.js` ด้วย `jest.mock` (module จริง path จริง ไม่ใช้ `virtual:true` — lesson #31) ให้ `runSectionAgent` เป็น `jest.fn().mockResolvedValue({slides:[{layout:"content",title:"x",content:["y"]}]})`; เรียก handler ผ่าน `plugin().setup(fakeAibitat)` โดย `fakeAibitat.function = (cfg) => captured = cfg`, `handlerProps.log = jest.fn()`, `introspect = jest.fn()`, `socket.send = jest.fn()`, `_chats = []`, ไม่มี `requestToolApproval`; (f) outline fixture → `runSectionAgent` ถูกเรียก = จำนวน sections; (g) finance fixture → ถูกเรียก 0 ครั้ง และ `socket.send` ถูกเรียกด้วย `"fileDownloadCard"`; (h) finance fixture ที่ validate ไม่ผ่าน → return string ขึ้นต้น `Cannot build finance deck` และ `socket.send` ไม่ถูกเรียก
- [ ] `STORAGE_DIR` tmpdir ตามข้อ quirks; ยืนยันไฟล์ `.pptx` ถูกเขียนใน `<tmp>/generated-files/`
- [ ] รัน evidence contract → เขียว; eslint ผ่าน; commit `feat(pptx): finance mode schema + validation + mode switch (#38)`

**QA focus:** พิสูจน์ว่า (f) แดงเมื่อสลับ `mode` default ผิด; (h) แดงเมื่อลบ early-return; outline path diff = 0 บรรทัดนอก block `if (mode === "finance")` และ schema properties

---

## Task 2 — theme `executive` + layouts ที่ไม่มี chart

**Files:** `themes.js` (modify), `finance-layouts.js` (create), `create-presentation.js` (modify: wire renderer map), `pptx-finance.test.js` (extend)

- [ ] `themes.js`: เพิ่ม `executive` (titleSlideBackground `0C1929`, accent `C9943E`, background `FFFFFF`, titleColor `0C1929`, bodyColor `2C3E50`, `chartColors: ["1A5276","C9943E","5A6D82","7B96B5","B8C4D0"]`, `chartPositive: "2E7D5B"`, `chartNegative: "B5483C"`, `chartNeutral: "5A6D82"`, `chartGrid: "E3E8EE"`, `statusGreen/Amber/Red`); theme อื่นทั้ง 5 ได้ chart tokens ค่า default เดียวกัน (`getTheme` merge)
- [ ] เทส RED: (i) ทุก color token ของทุก theme match `/^[0-9A-F]{6}$/i` และไม่มี `#`; (j) `getAvailableThemes()` มี `executive`
- [ ] `finance-layouts.js`: `formatNumber(n, unit)` → `"1,234,567 บาท"` (en-US grouping, ไม่มีทศนิยมถ้าเป็นจำนวนเต็ม), `formatPct(n)` → `"+12.4%"`/`"-6.8%"`; `addDeckFooter`; renderer `summary` (narrative + 3 metric tiles + verdict chip สี status), `scorecard` (table 4 คอลัมน์ ตัวเลข `align:"right"`, status เป็น `●` สีตาม enum), `decisions` (3 การ์ดเป็น shape `ROUNDED_RECTANGLE` + text), `risks_outlook` **เฉพาะตาราง risks** (forecast chart ทำ Task 3). ทุก renderer: title เป็น `slideData.title` ตามที่ agent ส่ง (ไม่แต่งเอง), footer จาก ctx
- [ ] wire ใน `create-presentation.js`: `const FINANCE_RENDERERS = require("./finance-layouts").RENDERERS` และ switch ตาม `layout` ก่อน fallback เดิม
- [ ] เทส: (k) finance fixture → unzip ด้วย `jszip` → `ppt/slides/slide2.xml` (summary) มีข้อความ `18,420,000`; `slide3.xml` (scorecard) มี `<a:tbl>`; ไม่มี string `pending` ในสไลด์ 1,2,3,9
- [ ] commit `feat(pptx): executive theme + summary/scorecard/decisions/risks layouts (#38)`

**QA focus:** ตัวเลขทุกตัวใน slide xml มาจาก fixture ไม่มี hardcode; theme เดิม 5 ตัว snapshot token เดิมไม่เปลี่ยน (เพิ่มได้ ห้ามแก้)

---

## Task 3 — chart layouts

**Files:** `finance-layouts.js` (modify), `pptx-finance.test.js` (extend)

- [ ] `trend_bar`: `addChart(pptx.ChartType.bar, [{name, labels, values}], {barDir:"col", chartColors:[theme.chartColors[0]], showValue:true, dataLabelPosition:"outEnd", dataLabelFormatCode:"#,##0", showLegend:false, catAxisLabelColor, valAxisLabelColor, valGridLine:{color:theme.chartGrid,size:0.5}, catGridLine:{style:"none"}, showTitle:false})`; planBand → 2 เส้น `addShape(pptx.ShapeType.line)` dashed คำนวณ y จากสเกล (บันทึก ruling ถ้าใช้ approximate); annotation เป็น text box
- [ ] `bar_donut`: bar ซ้าย (เหมือน trend_bar), doughnut ขวา `addChart(pptx.ChartType.doughnut, …, {holeSize:55, showPercent:true, showLegend:true, legendPos:"r", chartColors:theme.chartColors})`
- [ ] `waterfall`: stacked bar `barGrouping:"stacked"` 3 series: `base` (โปร่งใส: `chartColors[0]` + `chartColorsOpacity` ไม่พอ → ใช้สี `FFFFFF` และ `valGridLine` อยู่หน้าไม่ได้; **ruling:** ใช้ series `base` สีเท่าพื้นหลัง `theme.background`), `up` สี `chartPositive`, `down` สี `chartNegative`; คำนวณ base/up/down จาก start/steps/end; `dataLabelPosition:"inEnd"` (ห้าม `outEnd`); label kind (ชั่วคราว/โครงสร้าง/การลงทุน) เป็น text box ใต้แกน
- [ ] `cash`: line chart 2 series (receipts, payments) แกนเดียว (`ruling`: ไม่ใช้ secondary axis เพื่อเลี่ยง valAxes/catAxes pitfall) + AR aging เป็น bar `barDir:"bar"` ขวา + DSO เป็น metric tile
- [ ] `ranked_pair`: 2 bar chart `barDir:"bar"` แนวนอน, `catAxisOrientation:"maxMin"` ให้อันดับ 1 อยู่บน, label `sharePct` ใน `dataLabelFormatCode` ไม่ได้ → ใส่ในชื่อ category `"ชื่อ (32%)"`
- [ ] `risks_outlook`: เพิ่ม line chart forecast ขวา (actual solid, forecast dashed `lineDash:"dash"`), null → ช่องว่าง
- [ ] เทส: (l) finance fixture → unzip → นับไฟล์ `ppt/charts/chart*.xml` ≥ 7 (trend 1, bar_donut 2, waterfall 1, cash 2, ranked_pair 2, forecast 1 = 9); (m) `slide6.xml` (waterfall) chart xml มี `<c:grouping val="stacked"/>` และ `dLblPos val="inEnd"`; (n) ไม่มี chart xml ใดมี `dLblPos val="outEnd"` ร่วมกับ `grouping val="stacked"` (negative control: เรียก renderer waterfall ด้วย monkeypatch option `outEnd` แล้ว assert ว่า guard ใน renderer throw — guard ต้องมีจริงในโค้ด ไม่ใช่แค่เทส); (o) ทุก `<c:srgbClr val="…">` ใน chart xml เป็น 6 hex
- [ ] เปิดไฟล์ผลลัพธ์ด้วย LibreOffice ถ้ามีในเครื่อง (`soffice --headless --convert-to pdf`) เพื่อยืนยันไม่ corrupt; ถ้าไม่มี soffice ให้จดใน ledger และให้ Task 4 ทำบน dev2
- [ ] commit `feat(pptx): native charts for finance layouts (#38)`

**QA focus:** (n) ต้องพิสูจน์ RED โดย comment guard ออก; ตรวจว่าไม่มี options object ถูก reuse ข้าม `addChart`/`addText` (grep `const .*Opts = {` ที่ใช้ >1 ครั้ง)

---

## Task 4 — headed check บน dev2 + evidence

**Files:** ไม่แก้โค้ด (ยกเว้น bug ที่เจอ → กลับไป task ที่เกี่ยว)

- [ ] build image ผ่าน PodPilot (`POST /api/projects/anythingllm/deployments/553182a4-019a-4c5b-973a-24010e4f7f20/run`, poll `GET /api/runs/<id>`), rollout restart ตาม `/tmp/k-rollout.sh` (ต้อง branch merge เข้า master ก่อน หรือ deploy image tag ของ branch — ruling ตอนถึง)
- [ ] ใน workspace `infi` สั่ง `@agent ทำ present รายได้ ค่าใช้จ่าย ตั้งแต่ต้นปี สำหรับผู้บริหาร` → ดาวน์โหลด .pptx → แปลง PDF ด้วย LibreOffice → screenshot 9 หน้าเก็บ `e2e/logs/finance-deck/`
- [ ] เทียบ mockup: ลำดับสไลด์, ชนิด chart ต่อสไลด์, footer, หน่วยบาท; จดส่วนต่างเป็น finding
- [ ] เก็บ log `[AgentHandler]` แสดง `create-pptx-presentation` ถูกเรียก 1 ครั้งด้วย `mode:"finance"` และไม่มี `runSectionAgent`/web-search
- [ ] `task.sh check --issue 38` → `task.sh close` ด้วย ledger

---

## Ledger rulings ที่ตัดสินล่วงหน้า

- Ruling: waterfall ใช้ stacked bar + base series สีพื้นหลัง — pptxgenjs ไม่มี waterfall native และ transparency ต่อ series ไม่รองรับ — ถ้าผิด: กราฟดูมีแท่งขาวทับ grid
- Ruling: cash ใช้แกนเดียว — เลี่ยง valAxes/catAxes corruption — ถ้าผิด: receipts/payments สเกลต่างกันมากอ่านยาก
- Ruling: sharePct ใส่ในชื่อ category — pptxgenjs data label แสดงได้แค่ value หรือ percent ของ series — ถ้าผิด: label ยาว
