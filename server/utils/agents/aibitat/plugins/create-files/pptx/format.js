/**
 * Pure number formatting shared by the finance and executive layout families.
 *
 * These two helpers live in their own module so `exec-layouts.js` can use them
 * without requiring `finance-layouts.js`: Task 5 makes finance-layouts depend on
 * exec-layouts, and a shared leaf module keeps that edge acyclic.
 * `finance-layouts.js` re-exports both unchanged for its existing callers.
 */

/**
 * Group-separated number with at most one decimal, optionally suffixed with a unit.
 * @param {number|string} value
 * @param {string} [unit]
 * @param {{ maximumFractionDigits?: number }} [options] Executive totals carry two
 *   decimals (a doughnut total of 12.06 must not read as 12.1); finance callers keep
 *   the historical single-decimal default.
 * @returns {string}
 */
function formatNumber(value, unit = "", { maximumFractionDigits = 1 } = {}) {
  const formatted = Number(value).toLocaleString("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits,
  });
  return unit ? `${formatted} ${unit}` : formatted;
}

/**
 * Zero-based value-axis maximum with ~18% headroom, rounded up to a clean step.
 * Always finite and > 0 so label geometry that divides by it can never be -Infinity/NaN
 * (Opus final review #38: all-negative or all-zero data rounded to -0).
 * The step scales with the data (100000 for Baht-size figures, 1 for tiny values).
 * @param {number} maxValue
 * @returns {number}
 */
function roundedAxisMax(maxValue) {
  const safeMax = Number.isFinite(maxValue) && maxValue > 0 ? maxValue : 0;
  const headroom = safeMax * 1.18;
  const step = Math.max(1, 10 ** Math.floor(Math.log10(headroom || 1)) / 10);
  return Math.max(step, Math.ceil(headroom / step) * step);
}

module.exports = { formatNumber, roundedAxisMax };
