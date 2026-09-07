# Spec: Finance mode for `create-pptx-presentation` (executive deck with native charts)

วันที่: 2026-09-07 · สถานะ: อนุมัติแล้ว (ผู้ใช้ตอบ "mockup ok") · Mockup: `docs/superpowers/mockups/exec-finance-deck.html` @ 56f157f5 · Research: `2026-09-07-exec-finance-deck-skill-research.md`

## เป้าหมาย

Agent ที่ต่อ FlowAccount ผ่าน MCP สร้าง PPTX สำหรับผู้บริหารได้ใน 1 tool call โดยใช้ตัวเลขที่ agent ดึงมาแล้ว มี chart แบบ native (ไม่ใช่รูป) ตามโครง 9 สไลด์ใน mockup และไม่เรียก sub-agent ค้นเว็บ

## สถานะปัจจุบัน (จากโค้ด)

- `server/utils/agents/aibitat/plugins/create-files/pptx/create-presentation.js` รับ `sections[{title,keyPoints,instructions}]` แล้วส่งทุก section ให้ `runSectionAgent()` (child AIbitat + web search) ก่อน render
- `utils.js` render ได้ 3 layout: `section`, `content` (bullets หรือ `table`), `blank` ไม่มี `addChart` เลย
- `themes.js` มี 5 theme; `corporate` ใกล้เคียง mockup ที่สุด
- ไฟล์ออกที่ `storage/generated-files/` ผ่าน `createFilesLib.saveGeneratedFile` และส่ง `fileDownloadCard` ทาง socket
- Skill เปิดต่อ workspace ผ่าน `workspace_agent_settings.enabled_skills` (`create-files-agent`)

## การตัดสินใจ

| # | ตัดสิน | ปัดทิ้ง |
|---|---|---|
| 1 | เพิ่ม parameter `mode: "outline" \| "finance"` ให้ tool เดิม (default `outline` = พฤติกรรมเดิม 100%) | tool ใหม่แยกชื่อ (LLM สับสน 2 tools ทำ pptx) |
| 2 | โหมด `finance`: **ไม่เรียก** `runSectionAgent`; sections ต้องมี `layout` + `data` ตาม schema ด้านล่าง; render ตรง | ให้ sub-agent เติมข้อมูล (จะปนข้อมูลเว็บ) |
| 3 | Chart ผ่าน `pptxgenjs addChart` เท่านั้น; waterfall = stacked bar + series ฐานโปร่งใส | render เป็นรูป |
| 4 | Theme ใหม่ `executive` (navy `0C1929` / graphite / accent `C9943E`, font `Calibri`, ตัวเลข right-aligned) | reuse `corporate` ตรง ๆ (ขาด token สำหรับ chart) |
| 5 | Custom skill (Option B) ทำหลังจาก A merge | ทำพร้อมกัน |

## Schema ของ `sections[]` ในโหมด finance

ทุก section: `{ layout, title, subtitle?, footer?, notes?, data }` โดย `title` เป็นข้อสรุป

| layout | data |
|---|---|
| `summary` | `{ narrative: string, metrics: [{label, value, delta, deltaLabel}] (3), verdict: "on_plan"\|"below_plan"\|"mixed" }` |
| `scorecard` | `{ columns: [string] (4), rows: [{label, current, compare, changePct, status: "green"\|"amber"\|"red"}] }` |
| `trend_bar` | `{ categories: [string], values: [number], planBand?: {low, high}, annotation?: string, unit }` |
| `bar_donut` | `{ bar: {categories, values}, donut: {labels, values} }` |
| `waterfall` | `{ start: {label, value}, steps: [{label, value, kind: "timing"\|"structural"\|"investment"}], end: {label, value} }` |
| `cash` | `{ categories, receipts: [number], payments: [number], aging: [{bucket, value}], dso?: number }` |
| `ranked_pair` | `{ left: {title, items: [{label, value, sharePct}]}, right: {same} }` |
| `risks_outlook` | `{ risks: [{risk, owner, mitigation}], forecast: {categories, actual: [number\|null], forecast: [number\|null]} }` |
| `decisions` | `{ items: [{title, cost, expectedReturn, killCondition}] }` |
| `content`, `section`, `blank` | เหมือนเดิม (ใช้ร่วมได้) |

ตัวเลขทุกตัวเป็น number (ไม่ใช่ string ที่ format แล้ว); renderer format เป็น `1,234,567` ด้วย `toLocaleString("en-US")` และแนบ `unit` ที่ section ระดับบน (default `บาท`)

`footer` ระดับ deck: `{ period, source, preparedOn }` → พิมพ์ทุก content slide เป็น "งวด … · แหล่งข้อมูล … · จัดทำ …"

## Validation (fail-closed)

- `mode: "finance"` แต่ section ใด `layout` ไม่รู้จัก หรือ `data` ขาด field ที่จำเป็น → return string error บอก section index + field ที่ขาด, **ไม่สร้างไฟล์**
- `waterfall`: `start + Σsteps` ต้องเท่ากับ `end` (tolerance 1) ไม่งั้น error (กัน LLM ยัดเลขไม่ตรง); ยอดสะสมห้ามต่ำกว่า 0 (แกนเริ่มที่ 0 โดยโครงสร้าง stacked bar) — ขาดทุนให้ส่งเป็นค่าบวกพร้อม label ว่าขาดทุน
- `subtitle` ถ้ามีต้องเป็น string
- layout เดิม (`content`, `section`, `blank`) ผ่านโหมด finance โดย**ไม่ validate** — ใช้ renderer เดิมของ outline ตามเดิม
- `scorecard.rows.status` นอก enum → error
- `outline` mode ไม่เปลี่ยนพฤติกรรมใด ๆ (regression test บังคับ)

## pptxgenjs constraints ที่ต้อง encode เป็นเทส

- สีไม่มี `#`, 6 หลัก
- options object ใหม่ทุกครั้งที่เรียก `add*`
- stacked bar `dataLabelPosition` ∈ `ctr|inEnd|inBase`
- combo chart ที่มี secondary axis ต้องมี `valAxes` และ `catAxes` ครบคู่ (ใช้เฉพาะ `cash` ถ้าต้อง 2 แกน; ทางเลือกคือใช้แกนเดียว)
- `showLegend:false` เมื่อ series เดียว

## Evidence contract

```
cd server && node ../node_modules/jest/bin/jest.js __tests__/utils/agents/aibitat/plugins/create-files/pptx-finance.test.js --runInBand
```
คาดว่าเจอ `pptx-finance` ใน output และ `Tests: … passed`

เทสต้องพิสูจน์: (1) outline mode ยังเรียก `runSectionAgent` และ finance mode ไม่เรียกเลย (spy), (2) ไฟล์ .pptx ที่ได้ unzip แล้วมี `ppt/charts/chart*.xml` ≥ 6 ไฟล์ สำหรับ deck 9 สไลด์ตัวอย่าง, (3) waterfall ไม่ tie → ไม่มีไฟล์, (4) `dataLabelPosition` ผิดใน stacked bar ถูกจับที่ unit level, (5) color token ทุกตัวใน theme `executive` match `/^[0-9A-F]{6}$/`

## Headed check (lesson #35)

หลัง unit เขียว: รัน tool จริงบน dev2 (workspace `infi`) ด้วย prompt ตัวอย่าง เปิดไฟล์ด้วย LibreOffice headless → PDF → ดูภาพ 9 หน้าเทียบ mockup ก่อนปิด issue

System prompt ของ workspace ที่ใช้จริงบน dev2 (ฉบับสุดท้าย, มี call budget 13 ครั้ง): `docs/superpowers/specs/2026-09-07-exec-finance-deck-workspace-prompt.txt` — ต้องคู่กับ `AGENT_MAX_TOOL_CALLS≥14`, `GENERIC_OPEN_AI_MAX_TOKENS≥16384` และปิด Intelligent Skill Selection (ดู ledger #38 Task 4). Machine gate ของไฟล์ที่ได้: `node e2e/scripts/finance-deck/verify-deck.cjs <deck.pptx>`

## นอกขอบเขต

- Custom skill / Hub packaging (Option B)
- แก้ system prompt ของ workspace (ทำแล้วนอกรอบนี้)
- Chart ประเภทที่ PowerPoint ไม่มี native
