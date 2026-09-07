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
  content: [],
  section: [],
  blank: [],
};

const SCORECARD_STATUSES = new Set(["green", "amber", "red"]);
const WATERFALL_KINDS = new Set(["timing", "structural", "investment"]);

function missingFields(value, fields) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return fields;
  return fields.filter((field) => value[field] === undefined);
}

function validateFinanceSections(sections) {
  const errors = [];
  if (!Array.isArray(sections)) {
    return { ok: false, errors: ["sections must be an array"] };
  }

  sections.forEach((section, index) => {
    const prefix = `sections[${index}]`;
    const layout = section?.layout;
    if (!Object.hasOwn(FINANCE_LAYOUTS, layout)) {
      errors.push(
        `${prefix} layout "${layout}" is unsupported; supported layouts: ${Object.keys(
          FINANCE_LAYOUTS
        ).join(", ")}`
      );
      return;
    }

    if (
      !["content", "section", "blank"].includes(layout) &&
      (!section.data || typeof section.data !== "object")
    ) {
      errors.push(`${prefix} is missing required field data`);
      return;
    }

    for (const field of missingFields(
      section.data || {},
      FINANCE_LAYOUTS[layout]
    ))
      errors.push(`${prefix}.data is missing required field ${field}`);

    if (layout === "summary") {
      if (
        !Array.isArray(section.data.metrics) ||
        section.data.metrics.length !== 3
      )
        errors.push(`${prefix}.data.metrics must contain exactly 3 items`);
      const verdicts = ["on_plan", "below_plan", "mixed"];
      if (
        section.data.verdict !== undefined &&
        !verdicts.includes(section.data.verdict)
      )
        errors.push(
          `${prefix}.data.verdict "${section.data.verdict}" is invalid; expected ${verdicts.join(
            ", "
          )}`
        );
    }

    if (layout === "scorecard") {
      if (
        !Array.isArray(section.data.columns) ||
        section.data.columns.length !== 4
      )
        errors.push(`${prefix}.data.columns must contain exactly 4 strings`);
      if (Array.isArray(section.data.rows)) {
        section.data.rows.forEach((row, rowIndex) => {
          const missing = missingFields(row, [
            "label",
            "current",
            "compare",
            "changePct",
            "status",
          ]);
          for (const field of missing)
            errors.push(
              `${prefix}.data.rows[${rowIndex}] is missing required field ${field}`
            );
          if (row?.status !== undefined && !SCORECARD_STATUSES.has(row.status))
            errors.push(
              `${prefix}.data.rows[${rowIndex}].status "${row.status}" is invalid; expected green, amber, or red`
            );
        });
      }
    }

    if (layout === "waterfall") {
      if (Array.isArray(section.data.steps)) {
        section.data.steps.forEach((step, stepIndex) => {
          const missing = missingFields(step, ["label", "value", "kind"]);
          for (const field of missing)
            errors.push(
              `${prefix}.data.steps[${stepIndex}] is missing required field ${field}`
            );
          if (step?.kind !== undefined && !WATERFALL_KINDS.has(step.kind))
            errors.push(
              `${prefix}.data.steps[${stepIndex}].kind "${step.kind}" is invalid; expected timing, structural, or investment`
            );
        });
      }

      const start = section.data.start?.value;
      const end = section.data.end?.value;
      if (
        typeof start === "number" &&
        typeof end === "number" &&
        Array.isArray(section.data.steps) &&
        section.data.steps.every((step) => typeof step?.value === "number")
      ) {
        const calculatedEnd = section.data.steps.reduce(
          (total, step) => total + step.value,
          start
        );
        if (Math.abs(calculatedEnd - end) > 1)
          errors.push(
            `${prefix}.data waterfall does not tie: start plus steps is ${calculatedEnd}, but end is ${end}`
          );
      }
    }
  });

  return { ok: errors.length === 0, errors };
}

module.exports = { FINANCE_LAYOUTS, validateFinanceSections };
