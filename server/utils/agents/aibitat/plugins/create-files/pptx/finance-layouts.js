const JSZip = require("jszip");
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
    y: 0.25,
    w: CONTENT_W,
    h: 1.0,
    fontSize: 22,
    bold: true,
    color: theme.titleColor,
    fontFace: theme.fontTitle,
    valign: "bottom",
    fit: "shrink",
  });

  let contentStartY = 1.35;
  if (section.subtitle) {
    slide.addText(section.subtitle, {
      x: MARGIN_X,
      y: 1.3,
      w: CONTENT_W,
      h: 0.3,
      fontSize: 13,
      color: theme.subtitleColor,
      fontFace: theme.fontBody,
    });
    contentStartY = 1.65;
  }

  addAccentUnderline(
    slide,
    pptx,
    MARGIN_X,
    contentStartY + 0.05,
    theme.accentColor
  );
  addSlideFooter(slide, pptx, theme, ctx.slideNumber, ctx.totalSlides);
  addBranding(slide, theme.background);
  addDeckFooter(slide, theme, ctx.footer);
  if (section.notes) slide.addNotes(section.notes);
  return contentStartY + 0.25;
}

function renderSummary(slide, pptx, section, theme, ctx) {
  const contentStartY = addFinanceChrome(slide, pptx, section, theme, ctx);
  const narrativeHeight = 0.72;

  slide.addText(section.data.narrative, {
    x: MARGIN_X,
    y: contentStartY,
    w: CONTENT_W,
    h: narrativeHeight,
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
  const verdictY = contentStartY + narrativeHeight + 0.1;
  slide.addShape(pptx.ShapeType.roundRect, {
    x: MARGIN_X,
    y: verdictY,
    w: 1.6,
    h: 0.34,
    rectRadius: 0.05,
    fill: { color: verdict.color, transparency: 86 },
    line: { color: verdict.color, pt: 0.8 },
  });
  slide.addText(verdict.text, {
    x: MARGIN_X,
    y: verdictY + 0.04,
    w: 1.6,
    h: 0.2,
    fontSize: 10,
    bold: true,
    color: verdict.color,
    fontFace: theme.fontBody,
    align: "center",
    valign: "mid",
  });

  const tileW = 2.7;
  const tilesY = verdictY + 0.58;
  section.data.metrics.slice(0, 3).forEach((metric, index) => {
    const x = MARGIN_X + index * 2.95;
    const deltaColor =
      metric.delta >= 0 ? theme.chartPositive : theme.chartNegative;
    slide.addShape(pptx.ShapeType.rect, {
      x,
      y: tilesY,
      w: tileW,
      h: 0.06,
      fill: { color: theme.accentColor },
      line: { color: theme.accentColor },
    });
    slide.addText(metric.label, {
      x,
      y: tilesY + 0.2,
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
      y: tilesY + 0.56,
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
      y: tilesY + 1.23,
      w: 0.75,
      h: 0.28,
      fontSize: 12,
      bold: true,
      color: deltaColor,
      fontFace: theme.fontBody,
    });
    slide.addText(metric.deltaLabel, {
      x: x + 0.78,
      y: tilesY + 1.23,
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
  const contentStartY = addFinanceChrome(slide, pptx, section, theme, ctx);
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
    y: contentStartY,
    w: CONTENT_W,
    colW: [3.05, 1.45, 1.45, 1.45, 0.7],
    rowH: 0.34,
    border: { type: "solid", pt: 0.5, color: theme.tableBorderColor },
  });
}

function renderDecisions(slide, pptx, section, theme, ctx) {
  const contentStartY = addFinanceChrome(slide, pptx, section, theme, ctx);
  const items = section.data.items.slice(0, 3);
  const gap = 0.22;
  const cardW = (CONTENT_W - gap * 2) / 3;
  const cardY = contentStartY;

  items.forEach((item, index) => {
    const x = MARGIN_X + index * (cardW + gap);
    slide.addShape(pptx.ShapeType.roundRect, {
      x,
      y: cardY,
      w: cardW,
      h: 2.92,
      rectRadius: 0.05,
      fill: { color: theme.background },
      line: { color: theme.tableBorderColor, pt: 0.8 },
    });
    slide.addShape(pptx.ShapeType.rect, {
      x,
      y: cardY,
      w: 0.08,
      h: 2.92,
      fill: { color: theme.accentColor },
      line: { color: theme.accentColor },
    });
    slide.addText(String(index + 1), {
      x: x + 0.22,
      y: cardY + 0.18,
      w: 0.35,
      h: 0.34,
      fontSize: 17,
      bold: true,
      color: theme.accentColor,
      fontFace: theme.fontTitle,
    });
    slide.addText(item.title, {
      x: x + 0.22,
      y: cardY + 0.58,
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
      y: cardY + 1.28,
      w: cardW - 0.42,
      h: 0.18,
      fontSize: 8,
      bold: true,
      color: theme.subtitleColor,
      fontFace: theme.fontBody,
    });
    slide.addText(formatNumber(item.cost, ctx.unit), {
      x: x + 0.22,
      y: cardY + 1.48,
      w: cardW - 0.42,
      h: 0.28,
      fontSize: 12,
      bold: true,
      color: theme.bodyColor,
      fontFace: theme.fontBody,
    });
    slide.addText("ผลตอบแทนที่คาด", {
      x: x + 0.22,
      y: cardY + 1.83,
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
        y: cardY + 2.04,
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
      y: cardY + 2.4,
      w: cardW - 0.42,
      h: 0.18,
      fontSize: 8,
      bold: true,
      color: theme.subtitleColor,
      fontFace: theme.fontBody,
    });
    slide.addText(item.killCondition, {
      x: x + 0.22,
      y: cardY + 2.6,
      w: cardW - 0.42,
      h: 0.24,
      fontSize: 8.5,
      color: theme.bodyColor,
      fontFace: theme.fontBody,
      fit: "shrink",
    });
  });
}

function commonChartOptions(theme) {
  return {
    catAxisLabelColor: theme.subtitleColor,
    catAxisLabelFontFace: theme.fontBody,
    catAxisLabelFontSize: 9,
    catGridLine: { style: "none" },
    chartArea: { border: { color: theme.background, pt: 0 } },
    plotArea: { border: { color: theme.background, pt: 0 } },
    showTitle: false,
    valAxisLabelColor: theme.subtitleColor,
    valAxisLabelFontFace: theme.fontBody,
    valAxisLabelFontSize: 8,
    valGridLine: { color: theme.chartGrid, size: 0.5 },
  };
}

function renderTrendBar(slide, pptx, section, theme, ctx) {
  const contentStartY = addFinanceChrome(slide, pptx, section, theme, ctx);
  const chartX = MARGIN_X;
  const chartY = contentStartY;
  const chartW = CONTENT_W;
  const chartH = 2.65;
  const maxValue = Math.max(
    ...section.data.values,
    section.data.planBand?.high || 0
  );
  const axisMax = Math.ceil((maxValue * 1.18) / 100000) * 100000;

  slide.addChart(
    pptx.ChartType.bar,
    [
      {
        name: section.data.unit || ctx.unit,
        labels: [...section.data.categories],
        values: [...section.data.values],
      },
    ],
    {
      ...commonChartOptions(theme),
      x: chartX,
      y: chartY,
      w: chartW,
      h: chartH,
      barDir: "col",
      chartColors: section.data.values.map((value) => {
        if (!section.data.planBand) return theme.chartColors[0];
        if (value < section.data.planBand.low) return theme.chartNegative;
        if (value > section.data.planBand.high) return theme.chartPositive;
        return theme.chartColors[0];
      }),
      dataLabelFormatCode: "#,##0",
      dataLabelPosition: "outEnd",
      showLegend: false,
      showValue: true,
      valAxisMaxVal: axisMax,
      valAxisMinVal: 0,
    }
  );

  if (section.data.planBand) {
    const inBandCount = section.data.values.filter(
      (value) =>
        value >= section.data.planBand.low &&
        value <= section.data.planBand.high
    ).length;
    slide.addText(
      `ช่วงแผน ${formatNumber(section.data.planBand.low)}–${formatNumber(
        section.data.planBand.high
      )} ${section.data.unit || ctx.unit} · ${inBandCount} จาก ${section.data.values.length} เดือนอยู่ในช่วง`,
      {
        x: chartX + 0.1,
        y: chartY + chartH + 0.03,
        w: chartW - 0.2,
        h: 0.2,
        fontSize: 8,
        bold: true,
        color: theme.chartNeutral,
        fontFace: theme.fontBody,
        fit: "shrink",
      }
    );
  }

  if (section.data.annotation) {
    slide.addText(section.data.annotation, {
      x: chartX + 0.1,
      y: chartY + chartH + (section.data.planBand ? 0.23 : 0.03),
      w: chartW - 0.2,
      h: 0.22,
      fontSize: 8.5,
      color: theme.chartNeutral,
      fontFace: theme.fontBody,
      fit: "shrink",
    });
  }
}

function renderBarDonut(slide, pptx, section, theme, ctx) {
  const contentStartY = addFinanceChrome(slide, pptx, section, theme, ctx);

  slide.addChart(
    pptx.ChartType.bar,
    [
      {
        name: "ค่าใช้จ่ายรายเดือน",
        labels: [...section.data.bar.categories],
        values: [...section.data.bar.values],
      },
    ],
    {
      ...commonChartOptions(theme),
      x: MARGIN_X,
      y: contentStartY,
      w: 4.35,
      h: 2.92,
      barDir: "col",
      chartColors: [theme.chartColors[0]],
      dataLabelFontSize: 8,
      dataLabelFormatCode: "#,##0",
      dataLabelPosition: "outEnd",
      showLegend: false,
      showValue: true,
    }
  );
  slide.addChart(
    pptx.ChartType.doughnut,
    [
      {
        name: "โครงสร้างค่าใช้จ่าย",
        labels: [...section.data.donut.labels],
        values: [...section.data.donut.values],
      },
    ],
    {
      x: 5.2,
      y: contentStartY,
      w: 4.05,
      h: 2.92,
      chartArea: { border: { color: theme.background, pt: 0 } },
      chartColors: [...theme.chartColors],
      dataLabelColor: theme.bodyColor,
      dataLabelFontFace: theme.fontBody,
      dataLabelFontSize: 8,
      holeSize: 55,
      dataLabelPosition: "ctr",
      legendColor: theme.subtitleColor,
      legendFontFace: theme.fontBody,
      legendFontSize: 8,
      legendPos: "r",
      showLabel: false,
      showLegend: true,
      showPercent: true,
      showTitle: false,
    }
  );
}

function assertStackedLabelPosition(options) {
  if (
    ["stacked", "percentStacked"].includes(options.barGrouping) &&
    options.dataLabelPosition === "outEnd"
  ) {
    throw new Error(
      'Stacked chart dataLabelPosition "outEnd" is invalid; use "inEnd".'
    );
  }
}

function renderWaterfall(slide, pptx, section, theme, ctx) {
  const contentStartY = addFinanceChrome(slide, pptx, section, theme, ctx);
  const labels = [
    section.data.start.label,
    ...section.data.steps.map((step) => step.label),
    section.data.end.label,
  ];
  const base = [0];
  const up = [section.data.start.value];
  const down = [0];
  let running = section.data.start.value;

  section.data.steps.forEach((step) => {
    if (step.value >= 0) {
      base.push(running);
      up.push(step.value);
      down.push(0);
    } else {
      base.push(running + step.value);
      up.push(0);
      down.push(-step.value);
    }
    running += step.value;
  });
  base.push(0);
  up.push(section.data.end.value);
  down.push(0);

  const chartY = contentStartY;
  const chartH = 2.62;
  const cumulativeValues = [section.data.start.value];
  let cumulative = section.data.start.value;
  section.data.steps.forEach((step) => {
    cumulative += step.value;
    cumulativeValues.push(cumulative);
  });
  const axisMax =
    Math.ceil(
      (Math.max(...cumulativeValues, section.data.end.value) * 1.18) / 100000
    ) * 100000;
  const options = {
    ...commonChartOptions(theme),
    x: MARGIN_X,
    y: chartY,
    w: CONTENT_W,
    h: chartH,
    barDir: "col",
    barGrouping: "stacked",
    barOverlapPct: 100,
    chartColors: [theme.background, theme.chartPositive, theme.chartNegative],
    dataLabelFormatCode: "#,##0",
    dataLabelPosition: "inEnd",
    showLegend: false,
    showValue: false,
    valAxisMaxVal: axisMax,
    valAxisMinVal: 0,
  };
  assertStackedLabelPosition(options);
  slide.addChart(
    pptx.ChartType.bar,
    [
      { name: "ฐาน", labels: [...labels], values: base },
      { name: "เพิ่ม", labels: [...labels], values: up },
      { name: "ลด", labels: [...labels], values: down },
    ],
    options
  );

  const kindLabels = {
    timing: "ชั่วคราว",
    structural: "โครงสร้าง",
    investment: "การลงทุน",
  };
  const cellW = CONTENT_W / labels.length;
  const plotTop = chartY + 0.18;
  const plotBottom = chartY + chartH - 0.48;
  const plotHeight = plotBottom - plotTop;
  const valueLabels = [
    { value: section.data.start.value, top: section.data.start.value },
    ...section.data.steps.map((step, index) => ({
      value: Math.abs(step.value),
      top: Math.max(cumulativeValues[index], cumulativeValues[index + 1]),
    })),
    { value: section.data.end.value, top: section.data.end.value },
  ];
  valueLabels.forEach((label, index) => {
    const y = plotBottom - (label.top / axisMax) * plotHeight - 0.22;
    slide.addText(formatNumber(label.value), {
      x: MARGIN_X + cellW * index,
      y,
      w: cellW,
      h: 0.2,
      align: "center",
      color: theme.bodyColor,
      fontFace: theme.fontBody,
      fontSize: 7.5,
      fit: "shrink",
      margin: 0,
    });
  });
  section.data.steps.forEach((step, index) => {
    slide.addText(kindLabels[step.kind], {
      x: MARGIN_X + cellW * (index + 1),
      y: contentStartY + 2.65,
      w: cellW,
      h: 0.22,
      align: "center",
      color: theme.chartNeutral,
      fontFace: theme.fontBody,
      fontSize: 7.5,
      fit: "shrink",
    });
  });
}

function renderCash(slide, pptx, section, theme, ctx) {
  const contentStartY = addFinanceChrome(slide, pptx, section, theme, ctx);

  slide.addChart(
    pptx.ChartType.line,
    [
      {
        name: "เงินสดรับ",
        labels: [...section.data.categories],
        values: [...section.data.receipts],
      },
      {
        name: "เงินสดจ่าย",
        labels: [...section.data.categories],
        values: [...section.data.payments],
      },
    ],
    {
      ...commonChartOptions(theme),
      x: MARGIN_X,
      y: contentStartY,
      w: 5.3,
      h: 2.9,
      chartColors: [theme.chartPositive, theme.chartNegative],
      legendColor: theme.subtitleColor,
      legendFontFace: theme.fontBody,
      legendFontSize: 8,
      legendPos: "b",
      lineDataSymbol: "none",
      lineSize: 2,
      showLegend: true,
    }
  );
  slide.addChart(
    pptx.ChartType.bar,
    [
      {
        name: "ลูกหนี้คงค้าง",
        labels: section.data.aging.map((item) => item.bucket),
        values: section.data.aging.map((item) => item.value),
      },
    ],
    {
      ...commonChartOptions(theme),
      x: 6.12,
      y: contentStartY,
      w: 3.08,
      h: 1.96,
      barDir: "bar",
      chartColors: [theme.chartColors[0]],
      dataLabelFormatCode: "#,##0",
      dataLabelPosition: "outEnd",
      showLegend: false,
      showValue: true,
    }
  );
  if (section.data.dso !== undefined) {
    slide.addShape(pptx.ShapeType.roundRect, {
      x: 6.15,
      y: contentStartY + 2.18,
      w: 3.0,
      h: 0.68,
      rectRadius: 0.04,
      fill: { color: theme.tableAltRowBg },
      line: { color: theme.tableBorderColor, pt: 0.7 },
    });
    slide.addText("DSO", {
      x: 6.36,
      y: contentStartY + 2.3,
      w: 0.7,
      h: 0.2,
      bold: true,
      color: theme.subtitleColor,
      fontFace: theme.fontBody,
      fontSize: 9,
    });
    slide.addText(`${formatNumber(section.data.dso)} วัน`, {
      x: 7.05,
      y: contentStartY + 2.22,
      w: 1.85,
      h: 0.34,
      align: "right",
      bold: true,
      color: theme.titleColor,
      fontFace: theme.fontTitle,
      fontSize: 17,
    });
  }
}

function renderRankedPair(slide, pptx, section, theme, ctx) {
  const contentStartY = addFinanceChrome(slide, pptx, section, theme, ctx);
  [section.data.left, section.data.right].forEach((group, index) => {
    const x = MARGIN_X + index * 4.48;
    slide.addText(group.title, {
      x,
      y: contentStartY,
      w: 4.12,
      h: 0.28,
      bold: true,
      color: theme.bodyColor,
      fontFace: theme.fontBody,
      fontSize: 11,
    });
    slide.addChart(
      pptx.ChartType.bar,
      [
        {
          name: group.title,
          labels: group.items.map(
            (item) => `${item.label} (${formatNumber(item.sharePct)}%)`
          ),
          values: group.items.map((item) => item.value),
        },
      ],
      {
        ...commonChartOptions(theme),
        x,
        y: contentStartY + 0.3,
        w: 4.12,
        h: 2.6,
        barDir: "bar",
        catAxisLabelFontSize: 8,
        catAxisOrientation: "maxMin",
        chartColors: [theme.chartColors[index]],
        dataLabelFormatCode: "#,##0",
        dataLabelPosition: "outEnd",
        showLegend: false,
        showValue: true,
      }
    );
  });
}

function renderRisksOutlook(slide, pptx, section, theme, ctx) {
  const contentStartY = addFinanceChrome(slide, pptx, section, theme, ctx);
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
    y: contentStartY,
    w: 5.2,
    colW: [2.05, 1.05, 2.1],
    rowH: 0.58,
    border: { type: "solid", pt: 0.5, color: theme.tableBorderColor },
  });

  const forecast = section.data.forecast;
  slide.addChart(
    pptx.ChartType.line,
    [
      {
        name: "ผลจริง",
        labels: [...forecast.categories],
        values: [...forecast.actual],
      },
      {
        name: "ประมาณการ",
        labels: [...forecast.categories],
        values: [...forecast.forecast],
      },
    ],
    {
      ...commonChartOptions(theme),
      x: 6.05,
      y: contentStartY,
      w: 3.25,
      h: 2.9,
      chartColors: [theme.chartColors[0], theme.chartColors[1]],
      displayBlanksAs: "gap",
      legendColor: theme.subtitleColor,
      legendFontFace: theme.fontBody,
      legendFontSize: 8,
      legendPos: "b",
      showLegend: true,
    }
  );
}

async function fixEmbeddedChartTables(buffer) {
  const pptxZip = await JSZip.loadAsync(buffer);
  const chartNames = Object.keys(pptxZip.files).filter((name) =>
    /^ppt\/charts\/chart\d+\.xml$/.test(name)
  );
  await Promise.all(
    chartNames.map(async (chartName) => {
      const chartXml = await pptxZip.file(chartName).async("string");
      if (chartXml.includes("<c:doughnutChart>")) {
        pptxZip.file(
          chartName,
          chartXml.replace(/<c:dLbl>([\s\S]*?)<\/c:dLbl>/g, (label, content) =>
            label.includes("<c:dLblPos")
              ? label
              : `<c:dLbl>${content}<c:dLblPos val="ctr"/></c:dLbl>`
          )
        );
        return;
      }
      if (!chartXml.includes("<c:v>ประมาณการ</c:v>")) return;
      const series = chartXml.match(/<c:ser>[\s\S]*?<\/c:ser>/g) || [];
      if (series.length !== 2) return;
      series[1] = series[1].replace(
        '<a:prstDash val="solid"/>',
        '<a:prstDash val="dash"/>'
      );
      pptxZip.file(
        chartName,
        chartXml.replace(/<c:ser>[\s\S]*?<\/c:ser>/g, () => series.shift())
      );
    })
  );
  const embeddingNames = Object.keys(pptxZip.files).filter((name) =>
    /^ppt\/embeddings\/.*\.xlsx$/.test(name)
  );

  await Promise.all(
    embeddingNames.map(async (embeddingName) => {
      const workbookZip = await JSZip.loadAsync(
        await pptxZip.file(embeddingName).async("nodebuffer")
      );
      const tableNames = Object.keys(workbookZip.files).filter((name) =>
        /^xl\/tables\/.*\.xml$/.test(name)
      );

      await Promise.all(
        tableNames.map(async (tableName) => {
          const tableXml = await workbookZip.file(tableName).async("string");
          workbookZip.file(
            tableName,
            tableXml.replace(/ref="([^"]*)'"/g, 'ref="$1"')
          );
        })
      );
      pptxZip.file(
        embeddingName,
        await workbookZip.generateAsync({ type: "nodebuffer" })
      );
    })
  );

  return pptxZip.generateAsync({ type: "nodebuffer" });
}

function renderPendingSlide(slide, pptx, section, theme, ctx) {
  const contentStartY = addFinanceChrome(slide, pptx, section, theme, ctx);
  slide.addText(`layout ${section.layout} pending`, {
    x: MARGIN_X,
    y: contentStartY,
    w: CONTENT_W,
    h: 0.5,
    fontSize: 15,
    color: theme.bodyColor,
    fontFace: theme.fontBody,
    bullet: { code: "25AA", color: theme.bulletColor },
  });
}

const RENDERERS = {
  summary: renderSummary,
  scorecard: renderScorecard,
  trend_bar: renderTrendBar,
  bar_donut: renderBarDonut,
  waterfall: renderWaterfall,
  cash: renderCash,
  ranked_pair: renderRankedPair,
  risks_outlook: renderRisksOutlook,
  decisions: renderDecisions,
  __pending: renderPendingSlide,
};

module.exports = {
  RENDERERS,
  addDeckFooter,
  assertStackedLabelPosition,
  fixEmbeddedChartTables,
  formatNumber,
  formatPct,
};
