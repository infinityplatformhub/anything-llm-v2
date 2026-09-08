/**
 * Generic executive layouts: `kpi`, `chart`, `two-column`, `statement`.
 *
 * These four cover the shapes a board deck needs regardless of domain, so they
 * sit beside the domain-specific finance layouts rather than inside them.
 * Every renderer has the finance renderer signature
 * `(slide, pptx, section, theme, ctx)` with `ctx = { slideNumber, totalSlides, note?, bg }`.
 */

const {
  boundText,
  addActionTitle,
  addFooter,
  renderStatement,
  chartBaseOptions,
} = require("./utils.js");
const { formatNumber, roundedAxisMax } = require("./format.js");

// Slide geometry, in inches on the 10 x 5.625 LAYOUT_16x9 canvas.
const MARGIN_X = 0.7; // Matches the action title and footer gutter in utils.js.
const CONTENT_W = 8.6; // 10 in canvas minus both 0.7 in gutters.
const CONTENT_TOP_Y = 1.45; // The contentStartY that addActionTitle returns.
const CHART_H = 3.35; // Leaves the 5.05 in footer hairline clear.
const FOOTER_Y = 5.05; // The hairline addFooter draws; content must stay above it.

// KPI tile grid. A 2 x 2 grid of 4.2 in tiles with a 0.2 in gutter spans
// 8.6 in exactly, so the same tile width serves rows of 1, 2, and 4.
const TILE_GAP = 0.2;
const TILE_W_HALF = 4.2;
const TILE_H = 1.55; // Reference height; every inner offset below is a share of it.
// A 2 x 2 grid pushed down by a caller's ctx.y would otherwise cross the footer,
// so tiles compress. Below this the number would be too small to read across a
// boardroom even after scaling, so the tile stops shrinking and the caller's
// start-Y is the thing that has to give.
const TILE_H_MIN = 1.0;

// Inner layout, as fractions of TILE_H so a compressed tile keeps its proportions
// instead of colliding with itself. Derived from the reference tile: label at
// 0.14in, value at 0.44in with a 0.6in box, delta pill 0.32in tall sitting 0.14in
// off the bottom.
const TILE_LABEL_Y_RATIO = 0.14 / TILE_H;
const TILE_LABEL_H_RATIO = 0.28 / TILE_H;
const TILE_VALUE_Y_RATIO = 0.44 / TILE_H;
const TILE_VALUE_H_RATIO = 0.6 / TILE_H;
const TILE_PILL_H_RATIO = 0.32 / TILE_H;
const TILE_PILL_GAP_RATIO = 0.14 / TILE_H;
// The 40pt number is the point of a KPI tile, so it holds full size while the
// tile does. Below the reference height it scales with the tile and stops at
// 28pt, the smallest that still reads as the headline number rather than body text.
const KPI_VALUE_FONT_SIZE = 40;
const KPI_VALUE_FONT_MIN = 28;
const TILE_PAD_X = 0.25; // Inner padding so text never touches the tile edge.
const KPI_DEFAULT_Y = 1.5;

// Right-hand points column of the two-column layout.
const POINTS_X = 5.9;
const POINTS_W = 3.4;
const POINT_ROW_H = 0.95; // Ceiling; four points compress to fit above the footer.
const POINT_BULLET_SIZE = 0.1;
const CHART_HALF_W = 4.9;

const CHART_TYPES = [
  "bar",
  "column",
  "line",
  "area",
  "pie",
  "doughnut",
  "bridge",
];
const SINGLE_SERIES_TYPES = ["pie", "doughnut", "bridge"];
const KPI_STATUSES = ["good", "warn", "bad"];

// Which pptxgenjs chart primitive backs each of our type names, plus the
// options that make the primitive read as that type. `column` and `bar` are
// one pptxgenjs `bar` chart differing only in `barDir`; `bridge` is a signed
// column chart whose per-point colours carry the meaning.
const CHART_PRIMITIVES = {
  bar: { chartType: "bar", options: { barDir: "bar" } },
  column: { chartType: "bar", options: { barDir: "col" } },
  bridge: { chartType: "bar", options: { barDir: "col" } },
  line: { chartType: "line", options: {} },
  area: { chartType: "area", options: {} },
  pie: { chartType: "pie", options: {} },
  doughnut: { chartType: "doughnut", options: {} },
};

const DEFAULT_VALUE_FORMAT = "#,##0.##";
const PERCENT_FORMAT = "0%";

/** The slide ground for this section; charts must match it or they show a panel. */
function slideBg(theme, ctx) {
  return ctx.bg || theme.background;
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

/* ------------------------------------------------------------------ *
 * Validation
 * ------------------------------------------------------------------ */

function validateChartData(data, path, errors) {
  if (!CHART_TYPES.includes(data.type)) {
    errors.push(
      `${path}.type "${data.type}" is invalid; expected ${CHART_TYPES.join(", ")}`
    );
    return;
  }

  const categoriesOk =
    Array.isArray(data.categories) &&
    data.categories.length > 0 &&
    data.categories.every(isNonEmptyString);
  if (!categoriesOk)
    errors.push(`${path}.categories must be a non-empty array of strings`);

  if (!Array.isArray(data.series) || data.series.length === 0) {
    errors.push(`${path}.series must be a non-empty array`);
    return;
  }

  if (SINGLE_SERIES_TYPES.includes(data.type) && data.series.length !== 1)
    errors.push(
      `${path}.series must contain exactly 1 series for a ${data.type} chart`
    );

  data.series.forEach((series, index) => {
    const seriesPath = `${path}.series[${index}]`;
    if (!isObject(series)) {
      errors.push(`${seriesPath} must be an object`);
      return;
    }
    if (!isNonEmptyString(series.name))
      errors.push(`${seriesPath}.name must be a non-empty string`);
    if (
      !Array.isArray(series.values) ||
      series.values.length === 0 ||
      !series.values.every((value) => Number.isFinite(value))
    ) {
      errors.push(`${seriesPath}.values must be a non-empty array of numbers`);
      return;
    }
    if (categoriesOk && series.values.length !== data.categories.length)
      errors.push(
        `${seriesPath}.values must have the same length as ${path}.categories`
      );
  });

  if (data.valueFormat !== undefined && !isNonEmptyString(data.valueFormat))
    errors.push(`${path}.valueFormat must be a non-empty string when present`);

  if (data.highlight !== undefined) {
    if (!Array.isArray(data.highlight)) {
      errors.push(`${path}.highlight must be an array of category indexes`);
    } else {
      const limit = Array.isArray(data.categories) ? data.categories.length : 0;
      data.highlight.forEach((index, position) => {
        if (!Number.isInteger(index) || index < 0 || index >= limit)
          errors.push(
            `${path}.highlight[${position}] must be an integer index into ${path}.categories`
          );
      });
    }
  }

  if (data.note !== undefined && !isNonEmptyString(data.note))
    errors.push(`${path}.note must be a non-empty string when present`);
}

function validateKpiData(data, path, errors) {
  if (!Array.isArray(data.kpis)) {
    errors.push(`${path}.kpis must be an array`);
    return;
  }
  if (data.kpis.length < 2 || data.kpis.length > 4) {
    errors.push(`${path}.kpis must contain 2 to 4 items`);
    return;
  }
  data.kpis.forEach((kpi, index) => {
    const kpiPath = `${path}.kpis[${index}]`;
    if (!isObject(kpi)) {
      errors.push(`${kpiPath} must be an object`);
      return;
    }
    if (!isNonEmptyString(kpi.label))
      errors.push(`${kpiPath}.label must be a non-empty string`);
    if (!Number.isFinite(kpi.value) && !isNonEmptyString(kpi.value))
      errors.push(`${kpiPath}.value must be a number or non-empty string`);
    for (const field of ["unit", "delta", "note"]) {
      if (kpi[field] !== undefined && !isNonEmptyString(kpi[field]))
        errors.push(
          `${kpiPath}.${field} must be a non-empty string when present`
        );
    }
    if (kpi.status !== undefined && !KPI_STATUSES.includes(kpi.status))
      errors.push(
        `${kpiPath}.status "${kpi.status}" is invalid; expected ${KPI_STATUSES.join(", ")}`
      );
  });
  if (data.note !== undefined && !isNonEmptyString(data.note))
    errors.push(`${path}.note must be a non-empty string when present`);
}

function validateTwoColumnData(data, path, errors) {
  if (!isObject(data.chart)) errors.push(`${path}.chart must be an object`);
  else validateChartData(data.chart, `${path}.chart`, errors);

  if (!Array.isArray(data.points)) {
    errors.push(`${path}.points must be an array`);
  } else if (data.points.length < 2 || data.points.length > 4) {
    errors.push(`${path}.points must contain 2 to 4 items`);
  } else {
    data.points.forEach((point, index) => {
      if (!isNonEmptyString(point))
        errors.push(`${path}.points[${index}] must be a non-empty string`);
    });
  }

  if (data.note !== undefined && !isNonEmptyString(data.note))
    errors.push(`${path}.note must be a non-empty string when present`);
}

function validateStatementData(data, path, errors) {
  if (!isNonEmptyString(data.headline))
    errors.push(`${path}.headline must be a non-empty string`);
  if (data.subtitle !== undefined && !isNonEmptyString(data.subtitle))
    errors.push(`${path}.subtitle must be a non-empty string when present`);
}

const DATA_VALIDATORS = {
  kpi: validateKpiData,
  chart: validateChartData,
  "two-column": validateTwoColumnData,
  statement: validateStatementData,
};

/**
 * Validate one executive section, appending messages to `errors`.
 * @param {{layout: string, data: object}} section
 * @param {string} path Dotted path used in error messages, e.g. "sections[0]".
 * @param {string[]} errors Accumulator, mutated in place.
 * @returns {string[]} The same accumulator.
 */
function validateExecSection(section, path, errors) {
  const layout = section?.layout;
  const validator = DATA_VALIDATORS[layout];
  if (!validator) {
    errors.push(
      `${path}.layout "${layout}" is not an executive layout; expected ${Object.keys(DATA_VALIDATORS).join(", ")}`
    );
    return errors;
  }
  if (!isObject(section.data)) {
    errors.push(`${path}.data must be an object`);
    return errors;
  }
  validator(section.data, `${path}.data`, errors);
  return errors;
}

/* ------------------------------------------------------------------ *
 * Charts
 * ------------------------------------------------------------------ */

/**
 * Per-point colours for a single-series bar/column: the highlighted categories
 * carry the accent and the rest recede to the muted end of the series ramp, so
 * the eye lands on the point the title is making. Without a highlight every bar
 * is the accent, because nothing is being singled out.
 */
function singleSeriesColors(values, highlight, theme) {
  const focused = Array.isArray(highlight) && highlight.length > 0;
  return values.map((_value, index) =>
    !focused || highlight.includes(index) ? theme.accentColor : theme.series[3]
  );
}

/**
 * Bridge colours: the first and last bars are the opening and closing balance
 * (accent), and every bar between them is a movement coloured by direction.
 */
function bridgeColors(values, theme) {
  const last = values.length - 1;
  return values.map((value, index) =>
    index === 0 || index === last
      ? theme.accentColor
      : value < 0
        ? theme.bad
        : theme.good
  );
}

function toChartSeries(data) {
  return data.series.map((series) => ({
    name: series.name,
    labels: data.categories,
    values: series.values,
  }));
}

/**
 * Build the full pptxgenjs option set for one chart, starting from the shared
 * base so no chart is ever left on a library default.
 */
function chartOptions(data, theme, bg, frame) {
  const { chartType, options: primitiveOptions } = CHART_PRIMITIVES[data.type];
  const values = data.series[0].values;
  const isMultiSeries = data.series.length > 1;
  const options = {
    ...chartBaseOptions(theme, bg),
    ...frame,
    ...primitiveOptions,
    dataLabelFormatCode: data.valueFormat || DEFAULT_VALUE_FORMAT,
  };

  if (isMultiSeries) {
    // Several series need one colour each plus a legend to tell them apart;
    // per-point colouring is meaningless (and pptxgenjs emits no dPt anyway).
    options.chartColors = [...theme.series];
    options.showLegend = true;
    options.legendPos = "b";
    options.legendFontSize = 12;
  } else if (data.type === "bridge") {
    // Symmetric bounds keep the zero line centred so a fall reads as far as an
    // equal rise. invertedColors must be the same index-aligned array or
    // pptxgenjs paints negative bars from its own default palette.
    const colors = bridgeColors(values, theme);
    const bound = roundedAxisMax(
      Math.max(...values.map((value) => Math.abs(value)))
    );
    options.chartColors = colors;
    options.invertedColors = [...colors];
    options.valAxisMinVal = -bound;
    options.valAxisMaxVal = bound;
    options.catAxisLabelPos = "low"; // Keep labels below the axis, clear of the negative bars.
  } else if (data.type === "bar" || data.type === "column") {
    options.chartColors = singleSeriesColors(values, data.highlight, theme);
  } else {
    options.chartColors = [...theme.series];
  }

  // pptxgenjs 4.0.1 discards `outEnd` for a clustered bar chart (two contradictory
  // guards in `createChartOptions`), so bar labels sit at the library default until
  // that is fixed upstream; the option is kept so they move out when it is.
  if (chartType === "bar") options.dataLabelPosition = "outEnd";

  if (data.type === "doughnut") {
    options.holeSize = 62; // Leaves room for the total without crowding the ring.
    options.showValue = false;
    options.showPercent = true;
    options.dataLabelPosition = "ctr";
    // Percent labels are fractions of the whole: a value format code would render
    // a 65% slice as "0.65". Only an explicit valueFormat overrides this.
    options.dataLabelFormatCode = data.valueFormat || PERCENT_FORMAT;
    options.showLegend = true;
    options.legendPos = "b";
    options.legendFontSize = 12;
  } else if (data.type === "pie") {
    options.showLegend = true;
    options.legendPos = "b";
    options.legendFontSize = 12;
  }

  return options;
}

/**
 * A doughnut's ring shows shares; the number it sums to belongs in the hole.
 *
 * The bottom legend eats into the plot, so the ring centre sits above the frame
 * centre. pptxgenjs does not report the legend box, so the offset below is a
 * fixed fraction rather than a measurement: the total reads as centred at the
 * frame sizes this layout uses, and would need revisiting for a much shorter
 * chart frame or a legend moved off the bottom.
 */
const DOUGHNUT_LEGEND_RATIO = 0.12;

function addDoughnutTotal(slide, data, theme, frame) {
  const total = data.series[0].values.reduce((sum, value) => sum + value, 0);
  const holeH = 0.5;
  const ringH = frame.h * (1 - DOUGHNUT_LEGEND_RATIO);
  slide.addText(formatNumber(total, "", { maximumFractionDigits: 2 }), {
    x: frame.x,
    y: frame.y + ringH / 2 - holeH / 2,
    w: frame.w,
    h: holeH,
    fontSize: 28,
    bold: true,
    color: theme.titleColor,
    fontFace: theme.fontFace,
    align: "center",
    valign: "mid",
    margin: 0,
    fit: "shrink",
  });
}

function addChartBlock(slide, data, theme, ctx, frame) {
  slide.addChart(
    CHART_PRIMITIVES[data.type].chartType,
    toChartSeries(data),
    chartOptions(data, theme, slideBg(theme, ctx), frame)
  );
  if (data.type === "doughnut") addDoughnutTotal(slide, data, theme, frame);
}

/* ------------------------------------------------------------------ *
 * Renderers
 * ------------------------------------------------------------------ */

function execFooter(slide, pptx, section, theme, ctx) {
  addFooter(slide, pptx, theme, {
    slideNumber: ctx.slideNumber,
    totalSlides: ctx.totalSlides,
    note: section.data.note || ctx.note,
  });
}

/**
 * Lay out 2-4 KPI tiles: a single row while they fit, a 2 x 2 grid at four.
 * @param {number} [ctx.y] Start-Y, so a caller can seat the tiles under a
 *   narrative block instead of directly under the title.
 */
function renderKpi(slide, pptx, section, theme, ctx) {
  slide.background = { color: slideBg(theme, ctx) };
  addActionTitle(slide, theme, section.title);

  const kpis = section.data.kpis;
  const startY = typeof ctx.y === "number" ? ctx.y : KPI_DEFAULT_Y;
  const columns = kpis.length === 4 ? 2 : kpis.length;
  const rows = Math.ceil(kpis.length / columns);
  const tileW =
    columns === 2
      ? TILE_W_HALF
      : (CONTENT_W - TILE_GAP * (columns - 1)) / columns;
  const tileH = Math.max(
    TILE_H_MIN,
    Math.min(TILE_H, (FOOTER_Y - startY - TILE_GAP * (rows - 1)) / rows)
  );
  const maxValueFontSize = Math.max(
    KPI_VALUE_FONT_MIN,
    Math.round(KPI_VALUE_FONT_SIZE * Math.min(1, tileH / TILE_H))
  );

  kpis.forEach((kpi, index) => {
    const column = index % columns;
    const row = Math.floor(index / columns);
    const x = MARGIN_X + column * (tileW + TILE_GAP);
    const y = startY + row * (tileH + TILE_GAP);
    const textX = x + TILE_PAD_X;
    const textW = tileW - TILE_PAD_X * 2;
    const tileColor = theme.tileColors[index % theme.tileColors.length];

    slide.addShape(pptx.ShapeType.rect, {
      x,
      y,
      w: tileW,
      h: tileH,
      fill: { color: tileColor },
      line: { color: tileColor, transparency: 100 },
    });
    slide.addText(
      boundText(kpi.label, {
        w: textW,
        h: tileH * TILE_LABEL_H_RATIO,
        fontSize: 14,
      }),
      {
        x: textX,
        y: y + tileH * TILE_LABEL_Y_RATIO,
        w: textW,
        h: tileH * TILE_LABEL_H_RATIO,
        fontSize: 14,
        color: theme.groundText,
        fontFace: theme.fontFace,
        margin: 0,
      }
    );
    const rawValue = Number.isFinite(kpi.value)
      ? formatNumber(kpi.value, kpi.unit || "")
      : String(kpi.value);
    let valueFontSize = maxValueFontSize;
    const valueBox = { w: textW, h: tileH * TILE_VALUE_H_RATIO };
    // Reuse the shared width budget: prefer complete figures, then ellipsize
    // at the 28pt floor. A KPI stays on one line even in a tall tile.
    const fitValue = () =>
      boundText(rawValue, {
        ...valueBox,
        h: Math.min(valueBox.h, valueFontSize / 72),
        fontSize: valueFontSize,
      });
    let value = fitValue();
    while (value !== rawValue && valueFontSize > KPI_VALUE_FONT_MIN) {
      valueFontSize -= 1;
      value = fitValue();
    }
    slide.addText(value, {
      x: textX,
      y: y + tileH * TILE_VALUE_Y_RATIO,
      w: textW,
      h: tileH * TILE_VALUE_H_RATIO,
      fontSize: valueFontSize,
      bold: true,
      color: theme.groundText,
      fontFace: theme.fontFace,
      margin: 0,
      valign: "mid",
    });

    const pillH = tileH * TILE_PILL_H_RATIO;
    const gapH = tileH * TILE_PILL_GAP_RATIO;
    let cursorX = textX;
    if (kpi.delta) {
      const pillW = Math.min(1.5, textW);
      const pillY = y + tileH - pillH - gapH;
      slide.addShape(pptx.ShapeType.roundRect, {
        x: textX,
        y: pillY,
        w: pillW,
        h: pillH,
        rectRadius: 0.12,
        fill: { color: theme.pillBg },
        line: { color: theme.pillBg, transparency: 100 },
      });
      slide.addText(
        boundText(kpi.delta, { w: pillW, h: pillH, fontSize: 18 }),
        {
          x: textX,
          y: pillY,
          w: pillW,
          h: pillH,
          fontSize: 18,
          bold: true,
          color: theme[kpi.status] || theme.bodyColor,
          fontFace: theme.fontFace,
          align: "center",
          valign: "mid",
          margin: 0,
        }
      );
      cursorX = textX + pillW + 0.12;
    }
    if (kpi.note) {
      slide.addText(
        boundText(kpi.note, {
          w: textX + textW - cursorX,
          h: pillH,
          fontSize: 12,
        }),
        {
          x: cursorX,
          y: y + tileH - (pillH + gapH),
          w: textX + textW - cursorX,
          h: pillH,
          fontSize: 12,
          color: theme.groundMuted,
          fontFace: theme.fontFace,
          valign: "mid",
          margin: 0,
        }
      );
    }
  });

  execFooter(slide, pptx, section, theme, ctx);
}

function renderChart(slide, pptx, section, theme, ctx) {
  slide.background = { color: slideBg(theme, ctx) };
  addActionTitle(slide, theme, section.title);
  addChartBlock(slide, section.data, theme, ctx, {
    x: MARGIN_X,
    y: CONTENT_TOP_Y,
    w: CONTENT_W,
    h: CHART_H,
  });
  execFooter(slide, pptx, section, theme, ctx);
}

function renderTwoColumn(slide, pptx, section, theme, ctx) {
  slide.background = { color: slideBg(theme, ctx) };
  addActionTitle(slide, theme, section.title);
  addChartBlock(slide, section.data.chart, theme, ctx, {
    x: MARGIN_X,
    y: CONTENT_TOP_Y,
    w: CHART_HALF_W,
    h: CHART_H,
  });

  // Four rows at the full 0.95 in would run past the footer hairline, so the row
  // height shrinks to share whatever space the content area actually has.
  const rowH = Math.min(
    POINT_ROW_H,
    (FOOTER_Y - CONTENT_TOP_Y) / section.data.points.length
  );
  section.data.points.forEach((point, index) => {
    const y = CONTENT_TOP_Y + index * rowH;
    slide.addShape(pptx.ShapeType.rect, {
      x: POINTS_X,
      y: y + 0.11,
      w: POINT_BULLET_SIZE,
      h: POINT_BULLET_SIZE,
      fill: { color: theme.accentColor },
      line: { color: theme.accentColor, transparency: 100 },
    });
    slide.addText(point, {
      x: POINTS_X + POINT_BULLET_SIZE + 0.14,
      y,
      w: POINTS_W - POINT_BULLET_SIZE - 0.14,
      h: rowH - 0.18,
      fontSize: 16,
      color: theme.bodyColor,
      fontFace: theme.fontFace,
      valign: "top",
      margin: 0,
      fit: "shrink",
    });
    if (index < section.data.points.length - 1) {
      slide.addShape(pptx.ShapeType.rect, {
        x: POINTS_X,
        y: y + rowH - 0.09,
        w: POINTS_W,
        h: 0.007,
        fill: { color: theme.hairline },
        line: { color: theme.hairline, transparency: 100 },
      });
    }
  });

  execFooter(slide, pptx, section, theme, ctx);
}

/**
 * A statement slide is a full-bleed pause between chapters; it carries no
 * footer on purpose, so it does not call execFooter.
 */
function renderExecStatement(slide, pptx, section, theme, ctx) {
  renderStatement(slide, pptx, section.data, theme, ctx);
}

const EXEC_RENDERERS = {
  kpi: renderKpi,
  chart: renderChart,
  "two-column": renderTwoColumn,
  statement: renderExecStatement,
};

module.exports = { EXEC_RENDERERS, validateExecSection, CHART_TYPES };
