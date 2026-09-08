/**
 * Generate an INFI executive preview for every theme using production renderers.
 * Run from server:
 *
 *   node utils/agents/aibitat/plugins/create-files/pptx/test-themes.js
 *
 * Output: storage/generated-files/theme-previews/
 */

// Local-runtime shim for Node 26; Docker and CI run Node 18.
const b = require("node:buffer");
if (!b.SlowBuffer) b.SlowBuffer = b.Buffer;

const path = require("path");
const fs = require("fs");
const PptxGenJS = require("pptxgenjs");
const createFilesLib = require("../lib.js");
const { getTheme, getAvailableThemes } = require("./themes.js");
const { renderCover, renderContentSlide } = require("./utils.js");
const { EXEC_RENDERERS, validateExecSection } = require("./exec-layouts.js");
const { fixEmbeddedChartTables } = require("./finance-layouts.js");
const data = require("../../../../../../../docs/superpowers/mockups/pptx-directions/data.js");

const SAMPLE_SLIDES = [
  {
    layout: "cover",
    title: "INFI · รายงานผู้บริหาร 2569",
    headline: "รายได้ยังไม่ฟื้น\nต้องเร่งปิดช่องว่างกำไร",
    subtitle: `${data.company} · ${data.period}`,
    meta: data.source,
  },
  {
    layout: "kpi",
    title: "กำไรลดเร็วกว่ารายได้ อัตรากำไรเหลือ 15.0%",
    data: {
      kpis: data.kpis.map(({ label, value, delta, status }) => ({
        label,
        value,
        delta,
        status,
        note: data.compare,
      })),
      note: `${data.unit} · ${data.period} ${data.compare} ไม่ใช่ช่วงเวลาเดียวกัน`,
    },
  },
  {
    layout: "chart",
    title: "ก.ค. ฟื้นเด่น แต่รายได้ 5 ใน 8 เดือนยังต่ำกว่าแผน",
    data: {
      type: "column",
      categories: data.months,
      series: [{ name: "รายได้", values: data.revenue }],
      valueFormat: "#,##0",
      highlight: [6],
      note: `หน่วย: บาท · แผน ${data.planBand.map((value) => value.toLocaleString("en-US")).join("–")} บาท/เดือน · ม.ค.–ส.ค. 2569`,
    },
  },
  {
    layout: "two-column",
    title: "ค่าบริการทั่วไปเป็นต้นทุนหลัก ต้องทบทวนสัญญา",
    data: {
      chart: {
        type: "doughnut",
        categories: data.expenseStructure.map(([label]) => label),
        series: [
          {
            name: "ค่าใช้จ่าย",
            values: data.expenseStructure.map(([, value]) => value),
          },
        ],
      },
      points: [
        "ค่าบริการทั่วไป 7,799,188 บาท เพิ่ม 30%",
        "ค่าพนักงาน 4,255,441 บาท เป็นรายการใหญ่อันดับสอง",
        "ทบทวนสัญญา ลด 5% ประหยัดประมาณ 390,000 บาท/ปี",
      ],
      note: `${data.unit} · ${data.period} · ที่มา: FlowAccount`,
    },
  },
  {
    layout: "chart",
    title: "รายได้บริการที่หายไป ฉุดกำไรลงเหลือ 2.54 ล้านบาท",
    data: {
      type: "bridge",
      categories: data.bridge.map(([label]) => label),
      series: [
        {
          name: "กำไรและรายการเปลี่ยนแปลง",
          values: data.bridge.map(([, value]) => value),
        },
      ],
      valueFormat: "#,##0",
      note: "หน่วย: บาท · ม.ค.–ส.ค. 2569 เทียบทั้งปี 2568 · แท่งแสดงยอดต้น ยอดเปลี่ยนแปลง และยอดปลาย",
    },
  },
  {
    layout: "content",
    title: "ปิดรายได้ ก.ย. ลดค่าบริการ และล็อกเป้ารายได้ Q4",
    table: {
      headers: ["เรื่องที่ต้องตัดสินใจ", "ผู้รับผิดชอบ", "ผลที่คาดหวัง"],
      rows: data.decisions,
    },
    note: "ข้อเสนอเพื่อพิจารณา · เป้าหมายและผลประหยัดยังไม่ใช่ผลที่เกิดขึ้นจริง",
  },
  {
    layout: "statement",
    data: {
      headline: "เร่งรายได้\nคุมค่าบริการ รักษากำไร",
      subtitle: "ปิดเอกสาร ก.ย. ให้ครบ และติดตามเป้ารายได้ Q4 ทุกเดือน",
    },
  },
];

async function generateThemePreview(themeName, outputDir) {
  const theme = getTheme(themeName);
  const pptx = new PptxGenJS();
  pptx.title = `INFI Executive Report · ${theme.name} Theme Preview`;
  pptx.author = "AnythingLLM";
  pptx.company = data.company;

  // The cover is unnumbered, matching the production presentation pipeline.
  const totalSlides = SAMPLE_SLIDES.length - 1;
  SAMPLE_SLIDES.forEach((slideData, index) => {
    const slide = pptx.addSlide();
    if (slideData.layout === "cover") {
      renderCover(slide, pptx, slideData, theme);
      return;
    }

    const renderer = EXEC_RENDERERS[slideData.layout];
    if (renderer) {
      const errors = validateExecSection(slideData, `slide ${index}`, []);
      if (errors.length) throw new Error(errors.join("; "));
      renderer(slide, pptx, slideData, theme, {
        slideNumber: index,
        totalSlides,
        bg: theme.background,
      });
      return;
    }
    renderContentSlide(slide, pptx, slideData, theme, index, totalSlides);
  });

  const filename = `theme-preview-${themeName}.pptx`;
  const filepath = path.join(outputDir, filename);
  const buffer = await fixEmbeddedChartTables(
    await pptx.write({ outputType: "nodebuffer" })
  );
  await fs.promises.writeFile(filepath, buffer);
  console.log(`  ${theme.name}: ${filename}`);
}

async function main() {
  const baseDir = await createFilesLib.getOutputDirectory();
  const outputDir = path.join(baseDir, "theme-previews");
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  console.log("Generating theme previews…\n");
  const themes = getAvailableThemes();
  for (const themeName of themes) {
    await generateThemePreview(themeName, outputDir);
  }
  console.log(`\nDone! ${themes.length} previews saved to:\n  ${outputDir}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
