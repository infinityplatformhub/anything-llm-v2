const {
  addAccentUnderline,
  addBranding,
  addSlideFooter,
  addTopAccentBar,
} = require("./utils.js");

const MARGIN_X = 0.7;
const CONTENT_W = 8.6;

function formatNumber(value, unit = "") {
  const formatted = Number(value).toLocaleString("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 1,
  });
  return unit ? `${formatted} ${unit}` : formatted;
}

function formatPct(value) {
  const prefix = Number(value) > 0 ? "+" : "";
  return `${prefix}${Number(value).toLocaleString("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 1,
  })}%`;
}

function addDeckFooter(slide, theme, footer = {}) {
  const parts = [];
  if (footer.period) parts.push(`งวด ${footer.period}`);
  if (footer.source) parts.push(`แหล่งข้อมูล ${footer.source}`);
  if (footer.preparedOn) parts.push(`จัดทำ ${footer.preparedOn}`);
  if (parts.length === 0) return;

  slide.addText(parts.join(" · "), {
    x: 2.0,
    y: 5.07,
    w: 5.6,
    h: 0.25,
    fontSize: 8,
    color: theme.footerColor,
    fontFace: theme.fontBody,
    align: "left",
  });
}

function addFinanceChrome(slide, pptx, section, theme, ctx) {
  slide.background = { color: theme.background };
  addTopAccentBar(slide, pptx, theme);
  slide.addText(section.title, {
    x: MARGIN_X,
    y: 0.3,
    w: CONTENT_W,
    h: 0.65,
    fontSize: 24,
    bold: true,
    color: theme.titleColor,
    fontFace: theme.fontTitle,
    valign: "bottom",
  });

  if (section.subtitle) {
    slide.addText(section.subtitle, {
      x: MARGIN_X,
      y: 1.0,
      w: CONTENT_W,
      h: 0.3,
      fontSize: 13,
      color: theme.subtitleColor,
      fontFace: theme.fontBody,
    });
  }

  addAccentUnderline(slide, pptx, MARGIN_X, 1.38, theme.accentColor);
  addSlideFooter(slide, pptx, theme, ctx.slideNumber, ctx.totalSlides);
  addBranding(slide, theme.background);
  addDeckFooter(slide, theme, ctx.footer);
  if (section.notes) slide.addNotes(section.notes);
}

function renderSummary(slide, pptx, section, theme, ctx) {
  addFinanceChrome(slide, pptx, section, theme, ctx);

  slide.addText(section.data.narrative, {
    x: MARGIN_X,
    y: 1.62,
    w: CONTENT_W,
    h: 0.72,
    fontSize: 15,
    color: theme.bodyColor,
    fontFace: theme.fontBody,
    breakLine: false,
    valign: "mid",
  });

  const verdicts = {
    on_plan: { text: "ตามแผน", color: theme.statusGreen },
    below_plan: { text: "ต่ำกว่าแผน", color: theme.statusRed },
    mixed: { text: "ผสม", color: theme.statusAmber },
  };
  const verdict = verdicts[section.data.verdict];
  slide.addShape(pptx.ShapeType.roundRect, {
    x: 7.75,
    y: 2.23,
    w: 1.35,
    h: 0.34,
    rectRadius: 0.05,
    fill: { color: verdict.color, transparency: 86 },
    line: { color: verdict.color, pt: 0.8 },
  });
  slide.addText(verdict.text, {
    x: 7.75,
    y: 2.27,
    w: 1.35,
    h: 0.2,
    fontSize: 10,
    bold: true,
    color: verdict.color,
    fontFace: theme.fontBody,
    align: "center",
    valign: "mid",
  });

  const tileW = 2.7;
  section.data.metrics.slice(0, 3).forEach((metric, index) => {
    const x = MARGIN_X + index * 2.95;
    const deltaColor =
      metric.delta >= 0 ? theme.chartPositive : theme.chartNegative;
    slide.addShape(pptx.ShapeType.rect, {
      x,
      y: 2.72,
      w: tileW,
      h: 0.06,
      fill: { color: theme.accentColor },
      line: { color: theme.accentColor },
    });
    slide.addText(metric.label, {
      x,
      y: 2.92,
      w: tileW,
      h: 0.28,
      fontSize: 10,
      bold: true,
      color: theme.subtitleColor,
      fontFace: theme.fontBody,
      charSpacing: 1.2,
    });
    slide.addText(formatNumber(metric.value, ctx.unit), {
      x,
      y: 3.28,
      w: tileW,
      h: 0.55,
      fontSize: 23,
      bold: true,
      color: theme.titleColor,
      fontFace: theme.fontTitle,
      fit: "shrink",
    });
    slide.addText(formatPct(metric.delta), {
      x,
      y: 3.95,
      w: 0.75,
      h: 0.28,
      fontSize: 12,
      bold: true,
      color: deltaColor,
      fontFace: theme.fontBody,
    });
    slide.addText(metric.deltaLabel, {
      x: x + 0.78,
      y: 3.95,
      w: tileW - 0.78,
      h: 0.42,
      fontSize: 9,
      color: theme.subtitleColor,
      fontFace: theme.fontBody,
      fit: "shrink",
    });
  });
}

function renderScorecard(slide, pptx, section, theme, ctx) {
  addFinanceChrome(slide, pptx, section, theme, ctx);
  const headers = [...section.data.columns, "สถานะ"];
  const tableRows = [
    headers.map((header, index) => ({
      text: header,
      options: {
        bold: true,
        fontSize: 10,
        fontFace: theme.fontBody,
        color: theme.tableHeaderColor,
        fill: { color: theme.tableHeaderBg },
        align: index === 0 ? "left" : "right",
        valign: "middle",
        margin: [3, 6, 3, 6],
      },
    })),
  ];

  section.data.rows.forEach((row, rowIndex) => {
    const fill = rowIndex % 2 ? theme.tableAltRowBg : theme.background;
    tableRows.push([
      {
        text: row.label,
        options: {
          fontSize: 10,
          fontFace: theme.fontBody,
          color: theme.bodyColor,
          fill: { color: fill },
          align: "left",
          valign: "middle",
          margin: [3, 6, 3, 6],
        },
      },
      {
        text: formatNumber(row.current),
        options: {
          fontSize: 10,
          fontFace: theme.fontBody,
          color: theme.bodyColor,
          fill: { color: fill },
          align: "right",
          valign: "middle",
          margin: [3, 6, 3, 6],
        },
      },
      {
        text: formatNumber(row.compare),
        options: {
          fontSize: 10,
          fontFace: theme.fontBody,
          color: theme.subtitleColor,
          fill: { color: fill },
          align: "right",
          valign: "middle",
          margin: [3, 6, 3, 6],
        },
      },
      {
        text: formatPct(row.changePct),
        options: {
          fontSize: 10,
          fontFace: theme.fontBody,
          color: row.changePct >= 0 ? theme.chartPositive : theme.chartNegative,
          fill: { color: fill },
          align: "right",
          valign: "middle",
          margin: [3, 6, 3, 6],
        },
      },
      {
        text: "●",
        options: {
          fontSize: 11,
          fontFace: theme.fontBody,
          color:
            theme[`status${row.status[0].toUpperCase()}${row.status.slice(1)}`],
          fill: { color: fill },
          align: "center",
          valign: "middle",
          margin: [3, 6, 3, 6],
        },
      },
    ]);
  });

  slide.addTable(tableRows, {
    x: MARGIN_X,
    y: 1.65,
    w: CONTENT_W,
    colW: [3.05, 1.45, 1.45, 1.45, 0.7],
    rowH: 0.34,
    border: { type: "solid", pt: 0.5, color: theme.tableBorderColor },
  });
}

function renderDecisions(slide, pptx, section, theme, ctx) {
  addFinanceChrome(slide, pptx, section, theme, ctx);
  const items = section.data.items.slice(0, 3);
  const gap = 0.22;
  const cardW = (CONTENT_W - gap * 2) / 3;

  items.forEach((item, index) => {
    const x = MARGIN_X + index * (cardW + gap);
    slide.addShape(pptx.ShapeType.roundRect, {
      x,
      y: 1.72,
      w: cardW,
      h: 2.92,
      rectRadius: 0.05,
      fill: { color: theme.background },
      line: { color: theme.tableBorderColor, pt: 0.8 },
    });
    slide.addShape(pptx.ShapeType.rect, {
      x,
      y: 1.72,
      w: 0.08,
      h: 2.92,
      fill: { color: theme.accentColor },
      line: { color: theme.accentColor },
    });
    slide.addText(String(index + 1), {
      x: x + 0.22,
      y: 1.9,
      w: 0.35,
      h: 0.34,
      fontSize: 17,
      bold: true,
      color: theme.accentColor,
      fontFace: theme.fontTitle,
    });
    slide.addText(item.title, {
      x: x + 0.22,
      y: 2.3,
      w: cardW - 0.42,
      h: 0.62,
      fontSize: 11.5,
      bold: true,
      color: theme.titleColor,
      fontFace: theme.fontBody,
      fit: "shrink",
      valign: "top",
    });
    slide.addText("ต้นทุน", {
      x: x + 0.22,
      y: 3.0,
      w: cardW - 0.42,
      h: 0.18,
      fontSize: 8,
      bold: true,
      color: theme.subtitleColor,
      fontFace: theme.fontBody,
    });
    slide.addText(formatNumber(item.cost, ctx.unit), {
      x: x + 0.22,
      y: 3.2,
      w: cardW - 0.42,
      h: 0.28,
      fontSize: 12,
      bold: true,
      color: theme.bodyColor,
      fontFace: theme.fontBody,
    });
    slide.addText("ผลตอบแทนที่คาด", {
      x: x + 0.22,
      y: 3.55,
      w: cardW - 0.42,
      h: 0.18,
      fontSize: 8,
      bold: true,
      color: theme.subtitleColor,
      fontFace: theme.fontBody,
    });
    slide.addText(
      typeof item.expectedReturn === "number"
        ? formatNumber(item.expectedReturn, ctx.unit)
        : item.expectedReturn,
      {
        x: x + 0.22,
        y: 3.76,
        w: cardW - 0.42,
        h: 0.32,
        fontSize: 9.5,
        color: theme.bodyColor,
        fontFace: theme.fontBody,
        fit: "shrink",
      }
    );
    slide.addText("เงื่อนไขยกเลิก", {
      x: x + 0.22,
      y: 4.12,
      w: cardW - 0.42,
      h: 0.18,
      fontSize: 8,
      bold: true,
      color: theme.subtitleColor,
      fontFace: theme.fontBody,
    });
    slide.addText(item.killCondition, {
      x: x + 0.22,
      y: 4.32,
      w: cardW - 0.42,
      h: 0.24,
      fontSize: 8.5,
      color: theme.bodyColor,
      fontFace: theme.fontBody,
      fit: "shrink",
    });
  });
}

function renderRisksOutlook(slide, pptx, section, theme, ctx) {
  addFinanceChrome(slide, pptx, section, theme, ctx);
  const headers = ["ความเสี่ยง", "เจ้าของ", "แนวทางรับมือ"];
  const tableRows = [
    headers.map((header) => ({
      text: header,
      options: {
        bold: true,
        fontSize: 9,
        fontFace: theme.fontBody,
        color: theme.tableHeaderColor,
        fill: { color: theme.tableHeaderBg },
        align: "left",
        valign: "middle",
        margin: [3, 5, 3, 5],
      },
    })),
  ];

  section.data.risks.forEach((risk, rowIndex) => {
    const fill = rowIndex % 2 ? theme.tableAltRowBg : theme.background;
    tableRows.push(
      [risk.risk, risk.owner, risk.mitigation].map((text) => ({
        text,
        options: {
          fontSize: 8.5,
          fontFace: theme.fontBody,
          color: theme.bodyColor,
          fill: { color: fill },
          align: "left",
          valign: "middle",
          margin: [3, 5, 3, 5],
        },
      }))
    );
  });

  slide.addTable(tableRows, {
    x: MARGIN_X,
    y: 1.7,
    w: 5.2,
    colW: [2.05, 1.05, 2.1],
    rowH: 0.58,
    border: { type: "solid", pt: 0.5, color: theme.tableBorderColor },
  });
}

const RENDERERS = {
  summary: renderSummary,
  scorecard: renderScorecard,
  decisions: renderDecisions,
  risks_outlook: renderRisksOutlook,
};

module.exports = { RENDERERS, formatNumber, formatPct, addDeckFooter };
