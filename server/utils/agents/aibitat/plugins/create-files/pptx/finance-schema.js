const { validateExecSection } = require("./exec-layouts.js");

const FINANCE_LAYOUTS = {
  summary: ["narrative", "metrics", "verdict"],
  scorecard: ["columns", "rows"],
  trend_bar: ["categories", "values", "unit"],
  bar_donut: ["bar", "donut"],
  waterfall: ["start", "steps", "end"],
  cash: ["categories", "receipts", "payments", "aging"],
  ranked_pair: ["left", "right"],
  risks_outlook: ["risks", "forecast"],
  decisions: ["items"],
  // Generic executive layouts, usable from finance mode and from the section agent.
  kpi: ["kpis"],
  chart: ["type", "categories", "series"],
  "two-column": ["chart", "points"],
  statement: ["headline"],
};

const LEGACY_LAYOUTS = ["content", "section", "blank"];
const SCORECARD_STATUSES = ["green", "amber", "red"];
const SUMMARY_VERDICTS = ["on_plan", "below_plan", "mixed"];
const WATERFALL_KINDS = ["timing", "structural", "investment"];

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireObject(value, path, errors) {
  if (isObject(value)) return true;
  errors.push(`${path} must be an object`);
  return false;
}

function requireString(value, path, errors) {
  if (typeof value === "string" && value.trim()) return true;
  errors.push(`${path} must be a non-empty string`);
  return false;
}

function requireNumber(value, path, errors) {
  if (typeof value === "number" && Number.isFinite(value)) return true;
  errors.push(`${path} must be numeric; formatted strings are not allowed`);
  return false;
}

function requireNumberOrString(value, path, errors) {
  if (typeof value === "number" && Number.isFinite(value)) return true;
  if (typeof value === "string" && value.trim()) return true;
  errors.push(`${path} must be a number or non-empty string`);
  return false;
}

function requireArray(value, path, errors, { nonEmpty = true } = {}) {
  if (!Array.isArray(value)) {
    errors.push(`${path} must be an array`);
    return false;
  }
  if (nonEmpty && value.length === 0) {
    errors.push(`${path} must not be empty`);
    return false;
  }
  return true;
}

function validateStringArray(value, path, errors) {
  if (!requireArray(value, path, errors)) return false;
  value.forEach((item, index) =>
    requireString(item, `${path}[${index}]`, errors)
  );
  return true;
}

function validateNumberArray(value, path, errors) {
  if (!requireArray(value, path, errors)) return false;
  value.forEach((item, index) =>
    requireNumber(item, `${path}[${index}]`, errors)
  );
  return true;
}

function validateParallelArrays(arrays, path, errors) {
  if (!arrays.every(Array.isArray)) return;
  const lengths = arrays.map((array) => array.length);
  if (!lengths.every((length) => length === lengths[0]))
    errors.push(`${path} must have the same length`);
}

function validateSummary(data, path, errors) {
  requireString(data.narrative, `${path}.narrative`, errors);
  if (
    requireArray(data.metrics, `${path}.metrics`, errors, { nonEmpty: false })
  ) {
    if (data.metrics.length !== 3)
      errors.push(`${path}.metrics must contain exactly 3 items`);
    data.metrics.forEach((metric, index) => {
      const itemPath = `${path}.metrics[${index}]`;
      if (!requireObject(metric, itemPath, errors)) return;
      requireString(metric.label, `${itemPath}.label`, errors);
      requireNumber(metric.value, `${itemPath}.value`, errors);
      requireNumber(metric.delta, `${itemPath}.delta`, errors);
      requireString(metric.deltaLabel, `${itemPath}.deltaLabel`, errors);
      if (
        metric.polarity !== undefined &&
        !["higher_is_better", "lower_is_better"].includes(metric.polarity)
      )
        errors.push(
          `${itemPath}.polarity must be higher_is_better or lower_is_better`
        );
    });
  }
  if (!SUMMARY_VERDICTS.includes(data.verdict))
    errors.push(
      `${path}.verdict "${data.verdict}" is invalid; expected ${SUMMARY_VERDICTS.join(", ")}`
    );
}

function validateScorecard(data, path, errors) {
  if (
    requireArray(data.columns, `${path}.columns`, errors, { nonEmpty: false })
  ) {
    if (data.columns.length !== 4)
      errors.push(`${path}.columns must contain exactly 4 strings`);
    data.columns.forEach((column, index) =>
      requireString(column, `${path}.columns[${index}]`, errors)
    );
  }
  if (requireArray(data.rows, `${path}.rows`, errors)) {
    data.rows.forEach((row, index) => {
      const rowPath = `${path}.rows[${index}]`;
      if (!requireObject(row, rowPath, errors)) return;
      requireString(row.label, `${rowPath}.label`, errors);
      requireNumber(row.current, `${rowPath}.current`, errors);
      requireNumber(row.compare, `${rowPath}.compare`, errors);
      requireNumber(row.changePct, `${rowPath}.changePct`, errors);
      if (!SCORECARD_STATUSES.includes(row.status))
        errors.push(
          `${rowPath}.status "${row.status}" is invalid; expected ${SCORECARD_STATUSES.join(", ")}`
        );
    });
  }
}

function validateTrendBar(data, path, errors) {
  validateStringArray(data.categories, `${path}.categories`, errors);
  validateNumberArray(data.values, `${path}.values`, errors);
  validateParallelArrays(
    [data.categories, data.values],
    `${path}.categories and ${path}.values`,
    errors
  );
  requireString(data.unit, `${path}.unit`, errors);
  if (data.planBand !== undefined) {
    const bandPath = `${path}.planBand`;
    if (requireObject(data.planBand, bandPath, errors)) {
      requireNumber(data.planBand.low, `${bandPath}.low`, errors);
      requireNumber(data.planBand.high, `${bandPath}.high`, errors);
    }
  }
  if (data.annotation !== undefined)
    requireString(data.annotation, `${path}.annotation`, errors);
}

function validateBarDonut(data, path, errors) {
  for (const [group, labelsField] of [
    ["bar", "categories"],
    ["donut", "labels"],
  ]) {
    const groupPath = `${path}.${group}`;
    if (!requireObject(data[group], groupPath, errors)) continue;
    validateStringArray(
      data[group][labelsField],
      `${groupPath}.${labelsField}`,
      errors
    );
    validateNumberArray(data[group].values, `${groupPath}.values`, errors);
    validateParallelArrays(
      [data[group][labelsField], data[group].values],
      `${groupPath}.${labelsField} and ${groupPath}.values`,
      errors
    );
  }
}

function validateWaterfall(data, path, errors) {
  for (const endpoint of ["start", "end"]) {
    const endpointPath = `${path}.${endpoint}`;
    if (!requireObject(data[endpoint], endpointPath, errors)) continue;
    requireString(data[endpoint].label, `${endpointPath}.label`, errors);
    requireNumber(data[endpoint].value, `${endpointPath}.value`, errors);
  }
  if (requireArray(data.steps, `${path}.steps`, errors)) {
    data.steps.forEach((step, index) => {
      const stepPath = `${path}.steps[${index}]`;
      if (!requireObject(step, stepPath, errors)) return;
      requireString(step.label, `${stepPath}.label`, errors);
      requireNumber(step.value, `${stepPath}.value`, errors);
      if (!WATERFALL_KINDS.includes(step.kind))
        errors.push(
          `${stepPath}.kind "${step.kind}" is invalid; expected ${WATERFALL_KINDS.join(", ")}`
        );
    });
  }

  const start = data.start?.value;
  const end = data.end?.value;
  if (
    typeof start === "number" &&
    Number.isFinite(start) &&
    typeof end === "number" &&
    Number.isFinite(end) &&
    Array.isArray(data.steps) &&
    data.steps.every(
      (step) => typeof step?.value === "number" && Number.isFinite(step.value)
    )
  ) {
    const calculatedEnd = data.steps.reduce(
      (total, step) => total + step.value,
      start
    );
    if (Math.abs(calculatedEnd - end) > 1)
      errors.push(
        `${path} waterfall does not tie: start plus steps is ${calculatedEnd}, but end is ${end}`
      );
    // The stacked-bar waterfall draws on a zero-based axis; a running total below zero
    // has no bar geometry (axis max rounds to -0 and label positions divide by it).
    let running = start;
    const dipsBelowZero =
      start < 0 ||
      end < 0 ||
      data.steps.some((step) => (running += step.value) < 0);
    if (dipsBelowZero)
      errors.push(
        `${path} waterfall running total goes below zero; express losses as a positive magnitude (e.g. "ขาดทุนสุทธิ") so every bar stays on the zero-based axis`
      );
  }
}

function validateCash(data, path, errors) {
  validateStringArray(data.categories, `${path}.categories`, errors);
  validateNumberArray(data.receipts, `${path}.receipts`, errors);
  validateNumberArray(data.payments, `${path}.payments`, errors);
  validateParallelArrays(
    [data.categories, data.receipts, data.payments],
    `${path}.categories, ${path}.receipts, and ${path}.payments`,
    errors
  );
  if (requireArray(data.aging, `${path}.aging`, errors)) {
    data.aging.forEach((item, index) => {
      const itemPath = `${path}.aging[${index}]`;
      if (!requireObject(item, itemPath, errors)) return;
      requireString(item.bucket, `${itemPath}.bucket`, errors);
      requireNumber(item.value, `${itemPath}.value`, errors);
    });
  }
  if (data.dso !== undefined) requireNumber(data.dso, `${path}.dso`, errors);
}

function validateRankedPair(data, path, errors) {
  for (const side of ["left", "right"]) {
    const sidePath = `${path}.${side}`;
    if (!requireObject(data[side], sidePath, errors)) continue;
    requireString(data[side].title, `${sidePath}.title`, errors);
    if (requireArray(data[side].items, `${sidePath}.items`, errors)) {
      data[side].items.forEach((item, index) => {
        const itemPath = `${sidePath}.items[${index}]`;
        if (!requireObject(item, itemPath, errors)) return;
        requireString(item.label, `${itemPath}.label`, errors);
        requireNumber(item.value, `${itemPath}.value`, errors);
        requireNumber(item.sharePct, `${itemPath}.sharePct`, errors);
      });
    }
  }
}

function validateRisksOutlook(data, path, errors) {
  if (requireArray(data.risks, `${path}.risks`, errors)) {
    data.risks.forEach((item, index) => {
      const itemPath = `${path}.risks[${index}]`;
      if (!requireObject(item, itemPath, errors)) return;
      requireString(item.risk, `${itemPath}.risk`, errors);
      requireString(item.owner, `${itemPath}.owner`, errors);
      requireString(item.mitigation, `${itemPath}.mitigation`, errors);
    });
  }

  const forecastPath = `${path}.forecast`;
  if (!requireObject(data.forecast, forecastPath, errors)) return;
  validateStringArray(
    data.forecast.categories,
    `${forecastPath}.categories`,
    errors
  );
  for (const series of ["actual", "forecast"]) {
    const seriesPath = `${forecastPath}.${series}`;
    if (!requireArray(data.forecast[series], seriesPath, errors)) continue;
    data.forecast[series].forEach((value, index) => {
      if (value !== null)
        requireNumber(value, `${seriesPath}[${index}]`, errors);
    });
  }
  validateParallelArrays(
    [data.forecast.categories, data.forecast.actual, data.forecast.forecast],
    `${forecastPath}.categories, ${forecastPath}.actual, and ${forecastPath}.forecast`,
    errors
  );
}

function validateDecisions(data, path, errors) {
  if (!requireArray(data.items, `${path}.items`, errors)) return;
  data.items.forEach((item, index) => {
    const itemPath = `${path}.items[${index}]`;
    if (!requireObject(item, itemPath, errors)) return;
    requireString(item.title, `${itemPath}.title`, errors);
    requireNumber(item.cost, `${itemPath}.cost`, errors);
    requireNumberOrString(
      item.expectedReturn,
      `${itemPath}.expectedReturn`,
      errors
    );
    requireString(item.killCondition, `${itemPath}.killCondition`, errors);
  });
}

/** Adapt an executive layout to the (data, path, errors) validator shape. */
function execValidator(layout) {
  return (data, path, errors) =>
    validateExecSection({ layout, data }, path.replace(/\.data$/, ""), errors);
}

const VALIDATORS = {
  summary: validateSummary,
  scorecard: validateScorecard,
  trend_bar: validateTrendBar,
  bar_donut: validateBarDonut,
  waterfall: validateWaterfall,
  cash: validateCash,
  ranked_pair: validateRankedPair,
  risks_outlook: validateRisksOutlook,
  decisions: validateDecisions,
  kpi: execValidator("kpi"),
  chart: execValidator("chart"),
  "two-column": execValidator("two-column"),
  statement: execValidator("statement"),
};

function validateFinanceSections(sections) {
  const errors = [];
  if (!Array.isArray(sections))
    return { ok: false, errors: ["sections must be an array"] };

  sections.forEach((section, index) => {
    const sectionPath = `sections[${index}]`;
    requireString(section?.title, `${sectionPath}.title`, errors);
    if (section?.subtitle !== undefined && typeof section.subtitle !== "string")
      errors.push(`${sectionPath}.subtitle must be a string when present`);

    const layout = section?.layout;
    if (!Object.hasOwn(FINANCE_LAYOUTS, layout)) {
      if (!LEGACY_LAYOUTS.includes(layout))
        errors.push(
          `${sectionPath}.layout "${layout}" is unsupported; supported layouts: ${[
            ...Object.keys(FINANCE_LAYOUTS),
            ...LEGACY_LAYOUTS,
          ].join(", ")}`
        );
      return;
    }

    const dataPath = `${sectionPath}.data`;
    if (!requireObject(section.data, dataPath, errors)) return;
    VALIDATORS[layout](section.data, dataPath, errors);
  });

  return { ok: errors.length === 0, errors };
}

module.exports = { FINANCE_LAYOUTS, validateFinanceSections };
