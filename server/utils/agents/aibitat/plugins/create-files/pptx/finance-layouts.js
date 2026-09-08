const JSZip = require("jszip");
const { addActionTitle, addFooter, chartBaseOptions } = require("./utils.js");
const { EXEC_RENDERERS } = require("./exec-layouts.js");
const { formatNumber, roundedAxisMax } = require("./format.js");

const MARGIN_X = 0.7;
const CONTENT_W = 8.6;

function formatPct(value) {
  const prefix = Number(value) > 0 ? "+" : "";
  return `${prefix}${Number(value).toLocaleString("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 1,
  })}%`;
}

// Shared 10 × 5.625 in slide geometry, leaving the footer at 5.05 in clear.
const CONTENT_TOP_Y = 1.45;
const SUMMARY_TILES_Y = 2.35; // Reserves 0.9 in for the narrative and verdict.
const SCORECARD_COL_W = [2.7, 1.45, 1.45, 2.05, 0.95]; // Full 8.6 in width; headers fit at 14pt.
const SCORECARD_ROW_H = 0.38; // Header plus eight fixture rows fit above the footer.
const STATUS_DOT_SIZE = 0.14; // Native shape keeps status marks independent of font glyphs.

function financeNote(section, ctx) {
  const footer = ctx.footer || {};
  return [
    section.subtitle,
    footer.period && `งวด ${footer.period}`,
    footer.source && `แหล่งข้อมูล ${footer.source}`,
    footer.preparedOn && `จัดทำ ${footer.preparedOn}`,
  ]
    .filter(Boolean)
    .join(" · ");
}

function addFinanceChrome(slide, pptx, section, theme, ctx) {
  slide.background = { color: theme.background };
  const contentStartY = addActionTitle(slide, theme, section.title);
  addFooter(slide, pptx, theme, {
    slideNumber: ctx.slideNumber,
    totalSlides: ctx.totalSlides,
    note: financeNote(section, ctx),
  });
  if (section.notes) slide.addNotes(section.notes);
  return contentStartY;
}

function renderSummary(slide, pptx, section, theme, ctx) {
  // KPI owns the title and footer too; drawing finance chrome again duplicates both.
  EXEC_RENDERERS.kpi(
    slide,
    pptx,
    {
      title: section.title,
      data: {
        kpis: section.data.metrics.map((metric) => ({
          label: [metric.label, ctx.unit].filter(Boolean).join(" · "),
          value: metric.value,
          delta: formatPct(metric.delta),
          status: metric.delta >= 0 ? "good" : "bad",
        })),
      },
    },
    theme,
    {
      ...ctx,
      bg: theme.background,
      note: financeNote(section, ctx),
      y: SUMMARY_TILES_Y,
    }
  );
  if (section.notes) slide.addNotes(section.notes);
  // Comparison sentences cannot fit the KPI's narrow inline note at 12pt.
  // Seat them below the single tile row instead of asking PowerPoint to shrink them.
  const tileGap = 0.2;
  const tileW =
    (CONTENT_W - tileGap * (section.data.metrics.length - 1)) /
    section.data.metrics.length;
  section.data.metrics.forEach((metric, index) =>
    slide.addText(metric.deltaLabel, {
      x: MARGIN_X + index * (tileW + tileGap),
      y: SUMMARY_TILES_Y + 1.65,
      w: tileW,
      h: 0.6,
      fontSize: 12,
      fontFace: theme.fontFace,
      color: theme.subtitleColor,
      margin: 0,
      valign: "top",
    })
  );

  slide.addText(section.data.narrative, {
    x: MARGIN_X,
    y: CONTENT_TOP_Y,
    w: CONTENT_W - 1.85,
    h: SUMMARY_TILES_Y - CONTENT_TOP_Y - 0.1,
    fontSize: 16,
    color: theme.bodyColor,
    fontFace: theme.fontFace,
    margin: 0,
    valign: "mid",
  });

  const verdicts = {
    on_plan: { text: "ตามแผน", color: theme.good },
    below_plan: { text: "ต่ำกว่าแผน", color: theme.bad },
    mixed: { text: "ผสม", color: theme.warn },
  };
  const verdict = verdicts[section.data.verdict];
  const verdictX = MARGIN_X + CONTENT_W - 1.6;
  const verdictY = CONTENT_TOP_Y + 0.2;
  slide.addShape(pptx.ShapeType.roundRect, {
    x: verdictX,
    y: verdictY,
    w: 1.6,
    h: 0.4,
    rectRadius: 0.05,
    fill: { color: theme.pillBg },
    line: { color: theme.hairline, pt: 0.5 },
  });
  slide.addText(verdict.text, {
    x: verdictX,
    y: verdictY,
    w: 1.6,
    h: 0.4,
    fontSize: 14,
    bold: true,
    color: verdict.color,
    fontFace: theme.fontFace,
    align: "center",
    valign: "mid",
    margin: 0,
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
        fontSize: 14,
        fontFace: theme.fontBody,
        color: theme.tableHeaderColor,
        fill: { color: theme.accentColor },
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
          fontSize: 14,
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
          fontSize: 14,
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
          fontSize: 14,
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
          fontSize: 14,
          fontFace: theme.fontBody,
          color: row.changePct >= 0 ? theme.chartPositive : theme.chartNegative,
          fill: { color: fill },
          align: "right",
          valign: "middle",
          margin: [3, 6, 3, 6],
        },
      },
      {
        text: "",
        options: {
          fontSize: 14,
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
    colW: SCORECARD_COL_W,
    rowH: SCORECARD_ROW_H,
    fontSize: 14,
    fontFace: theme.fontFace,
    border: { type: "solid", pt: 0.5, color: theme.hairline },
  });
  section.data.rows.forEach((row, index) => {
    const color =
      theme[`status${row.status[0].toUpperCase()}${row.status.slice(1)}`];
    slide.addShape(pptx.ShapeType.ellipse, {
      x:
        MARGIN_X + CONTENT_W - SCORECARD_COL_W.at(-1) / 2 - STATUS_DOT_SIZE / 2,
      y:
        contentStartY +
        SCORECARD_ROW_H * (index + 1) +
        (SCORECARD_ROW_H - STATUS_DOT_SIZE) / 2,
      w: STATUS_DOT_SIZE,
      h: STATUS_DOT_SIZE,
      fill: { color },
      line: { color, transparency: 100 },
    });
  });
}

function renderDecisions(slide, pptx, section, theme, ctx) {
  const contentStartY = addFinanceChrome(slide, pptx, section, theme, ctx);
  const items = section.data.items.slice(0, 3);
  // Three full-width cards give 18pt titles and 14pt decision detail room to wrap.
  const rowH = 1.12;
  const gap = 0.08;
  const fields = [
    {
      label: "ต้นทุน",
      x: 3.65,
      w: 1.05,
      value: (item) => formatNumber(item.cost, ctx.unit),
    },
    {
      label: "ผลตอบแทนที่คาด",
      x: 4.85,
      w: 1.95,
      value: (item) =>
        typeof item.expectedReturn === "number"
          ? formatNumber(item.expectedReturn, ctx.unit)
          : item.expectedReturn,
    },
    {
      label: "เงื่อนไขยกเลิก",
      x: 6.95,
      w: 2.35,
      value: (item) => item.killCondition,
    },
  ];
  items.forEach((item, index) => {
    const y = contentStartY + index * (rowH + gap);
    slide.addShape(pptx.ShapeType.roundRect, {
      x: MARGIN_X,
      y,
      w: CONTENT_W,
      h: rowH,
      rectRadius: 0.05,
      fill: { color: theme.background },
      line: { color: theme.hairline, pt: 0.5 },
    });
    if (index < items.length - 1)
      slide.addShape(pptx.ShapeType.line, {
        x: MARGIN_X,
        y: y + rowH + gap / 2,
        w: CONTENT_W,
        h: 0,
        line: { color: theme.hairline, pt: 0.5 },
      });
    slide.addText(String(index + 1), {
      x: MARGIN_X,
      y,
      w: 0.4,
      h: 0.5,
      fontSize: 28,
      bold: true,
      color: theme.accentColor,
      fontFace: theme.fontFace,
      margin: 0,
    });
    slide.addText(item.title, {
      x: MARGIN_X + 0.55,
      y,
      w: 2.2,
      h: rowH,
      fontSize: 18,
      bold: true,
      color: theme.titleColor,
      fontFace: theme.fontFace,
      margin: 0,
      valign: "top",
      fit: "shrink",
    });
    fields.forEach((field) => {
      slide.addText(field.label, {
        x: field.x,
        y,
        w: field.w,
        h: 0.24,
        fontSize: 11,
        bold: true,
        color: theme.subtitleColor,
        fontFace: theme.fontFace,
        margin: 0,
      });
      slide.addText(field.value(item), {
        x: field.x,
        y: y + 0.28,
        w: field.w,
        h: rowH - 0.28,
        fontSize: 14,
        color: theme.bodyColor,
        fontFace: theme.fontFace,
        margin: 0,
        valign: "top",
        fit: "shrink",
      });
    });
  });
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
  const axisMax = roundedAxisMax(maxValue);

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
      ...chartBaseOptions(theme, theme.background),
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
        h: 0.3,
        fontSize: 11,
        bold: true,
        color: theme.chartNeutral,
        fontFace: theme.fontBody,
        margin: 0,
      }
    );
  }

  if (section.data.annotation) {
    slide.addText(section.data.annotation, {
      x: chartX + 0.1,
      y: chartY + chartH + (section.data.planBand ? 0.38 : 0.03),
      w: chartW - 0.2,
      h: 0.3,
      fontSize: 11,
      color: theme.chartNeutral,
      fontFace: theme.fontBody,
      margin: 0,
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
      ...chartBaseOptions(theme, theme.background),
      x: MARGIN_X,
      y: contentStartY,
      w: 4.35,
      h: 2.92,
      barDir: "col",
      chartColors: [theme.chartColors[0]],
      dataLabelFontSize: 11,
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
      ...chartBaseOptions(theme, theme.background),
      x: 5.2,
      y: contentStartY,
      w: 4.05,
      h: 2.92,
      chartColors: [...theme.chartColors],
      dataLabelColor: theme.bodyColor,
      dataLabelFontFace: theme.fontBody,
      dataLabelFontSize: 11,
      holeSize: 55,
      dataLabelPosition: "ctr",
      legendColor: theme.subtitleColor,
      legendFontFace: theme.fontBody,
      legendFontSize: 11,
      legendPos: "r",
      showLabel: false,
      showLegend: true,
      showPercent: true,
      showValue: false,
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
  const axisMax = roundedAxisMax(
    Math.max(...cumulativeValues, section.data.end.value)
  );
  const options = {
    ...chartBaseOptions(theme, theme.background),
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
      fontSize: 11,
      margin: 0,
    });
  });
  section.data.steps.forEach((step, index) => {
    slide.addText(kindLabels[step.kind], {
      x: MARGIN_X + cellW * (index + 1),
      y: contentStartY + 2.65,
      w: cellW,
      h: 0.3,
      align: "center",
      color: theme.chartNeutral,
      fontFace: theme.fontBody,
      fontSize: 11,
      margin: 0,
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
      ...chartBaseOptions(theme, theme.background),
      x: MARGIN_X,
      y: contentStartY,
      w: 5.3,
      h: 2.9,
      chartColors: [theme.chartPositive, theme.chartNegative],
      legendColor: theme.subtitleColor,
      legendFontFace: theme.fontBody,
      legendFontSize: 11,
      legendPos: "b",
      lineDataSymbol: "none",
      lineSize: 2,
      showValue: false,
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
      ...chartBaseOptions(theme, theme.background),
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
      fontSize: 11,
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
        ...chartBaseOptions(theme, theme.background),
        x,
        y: contentStartY + 0.3,
        w: 4.12,
        h: 2.6,
        barDir: "bar",
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
        fontSize: 11,
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
          fontSize: 11,
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
      ...chartBaseOptions(theme, theme.background),
      x: 6.05,
      y: contentStartY,
      w: 3.25,
      h: 2.9,
      chartColors: [theme.chartColors[0], theme.chartColors[1]],
      displayBlanksAs: "gap",
      showValue: false,
      legendColor: theme.subtitleColor,
      legendFontFace: theme.fontBody,
      legendFontSize: 11,
      legendPos: "b",
      showLegend: true,
    }
  );
}

function seriesHasNumericGaps(seriesXml) {
  const numCache = seriesXml.match(/<c:numCache>[\s\S]*?<\/c:numCache>/)?.[0];
  if (!numCache) return false;
  const pointCount = Number(numCache.match(/<c:ptCount val="(\d+)"/)?.[1]);
  const populatedPoints = (
    numCache.match(/<c:pt idx="\d+"><c:v>[^<]+<\/c:v><\/c:pt>/g) || []
  ).length;
  return pointCount > populatedPoints;
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
              : `<c:dLbl>${content.replace(
                  /(?=<c:(?:showLegendKey|showVal|showCatName|showSerName|showPercent|showBubbleSize))/,
                  '<c:dLblPos val="ctr"/>'
                )}</c:dLbl>`
          )
        );
        return;
      }
      const lineChart = chartXml.match(/<c:lineChart>[\s\S]*?<\/c:lineChart>/);
      if (!lineChart) return;
      const series = lineChart[0].match(/<c:ser>[\s\S]*?<\/c:ser>/g) || [];
      if (series.length !== 2 || !series.every(seriesHasNumericGaps)) return;
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
  assertStackedLabelPosition,
  fixEmbeddedChartTables,
  formatNumber,
  formatPct,
  roundedAxisMax,
};
