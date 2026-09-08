/**
 * Curated presentation themes for pptxgenjs.
 *
 * Each theme is a complete design system: title-slide palette, content-slide
 * palette, table styling, footer colors, and typography.  The rendering code
 * in utils.js consumes these tokens to produce consistent, professional slides.
 *
 * Themes: default · corporate · dark · minimal · creative · executive
 */

const EXEC_TOKEN_DEFAULTS = {
  ground: "0F1B1F",
  groundText: "F4F6F5",
  groundMuted: "9FB0B5",
  hairline: "D6D9DB",
  pillBg: "F1F3F2",
  good: "1E7A4B",
  warn: "8A6100",
  bad: "B3261E",
  tileColors: ["0F4C5C", "1F5F5B", "2E6F6A", "3F7E79"],
  series: ["0F4C5C", "3A7C8C", "6FA3AD", "A6C8CE", "CBDDE2"],
};

const THEMES = {
  default: {
    name: "Professional",
    description: "Clean and versatile — works for any presentation",

    titleSlideBackground: "1E293B",
    titleSlideTitleColor: "FFFFFF",
    titleSlideSubtitleColor: "94A3B8",
    titleSlideAccentColor: "3B82F6",

    background: "FFFFFF",
    titleColor: "0F172A",
    subtitleColor: "64748B",
    bodyColor: "334155",
    accentColor: "2563EB",
    bulletColor: "2563EB",

    tableHeaderBg: "1E293B",
    tableHeaderColor: "FFFFFF",
    tableAltRowBg: "F8FAFC",
    tableBorderColor: "E2E8F0",

    footerColor: "94A3B8",
    footerLineColor: "E2E8F0",

    ground: "1E293B",
    tileColors: ["1E3A8A", "1D4ED8", "2563EB", "3B82F6"],
    series: ["2563EB", "94A3B8", "0EA5E9", "F59E0B", "64748B"],
  },

  corporate: {
    name: "Corporate",
    description: "Refined and authoritative — ideal for business and finance",

    titleSlideBackground: "0C1929",
    titleSlideTitleColor: "FFFFFF",
    titleSlideSubtitleColor: "7B96B5",
    titleSlideAccentColor: "C9943E",

    background: "FFFFFF",
    titleColor: "0C1929",
    subtitleColor: "5A6D82",
    bodyColor: "2C3E50",
    accentColor: "1A5276",
    bulletColor: "1A5276",

    tableHeaderBg: "0C1929",
    tableHeaderColor: "FFFFFF",
    tableAltRowBg: "F4F7FA",
    tableBorderColor: "D5DBE2",

    footerColor: "8B9DB3",
    footerLineColor: "D5DBE2",

    ground: "0C1929",
    tileColors: ["0C1929", "1A3550", "1A5276", "2E6F9E"],
    series: ["1A5276", "C9943E", "7B96B5", "2C3E50", "B8C4D0"],
  },

  dark: {
    name: "Dark",
    description: "Sleek dark theme — great for tech and product presentations",

    titleSlideBackground: "0F0F1A",
    titleSlideTitleColor: "F8FAFC",
    titleSlideSubtitleColor: "7C8DB5",
    titleSlideAccentColor: "818CF8",

    background: "18181B",
    titleColor: "F4F4F5",
    subtitleColor: "A1A1AA",
    bodyColor: "D4D4D8",
    accentColor: "6366F1",
    bulletColor: "818CF8",

    tableHeaderBg: "6366F1",
    tableHeaderColor: "FFFFFF",
    tableAltRowBg: "1F1F24",
    tableBorderColor: "3F3F46",

    footerColor: "71717A",
    footerLineColor: "3F3F46",

    ground: "0F0F1A",
    tileColors: ["312E81", "3730A3", "4338CA", "4F46E5"],
    series: ["818CF8", "38BDF8", "A1A1AA", "F472B6", "C4B5FD"],
    good: "4ADE80",
    warn: "FBBF24",
    bad: "F87171",
    hairline: "3F3F46",
    pillBg: "27272A",
  },

  minimal: {
    name: "Minimal",
    description: "Ultra-clean with maximum whitespace — lets content speak",

    titleSlideBackground: "F5F5F5",
    titleSlideTitleColor: "171717",
    titleSlideSubtitleColor: "737373",
    titleSlideAccentColor: "A3A3A3",

    background: "FFFFFF",
    titleColor: "171717",
    subtitleColor: "737373",
    bodyColor: "404040",
    accentColor: "525252",
    bulletColor: "A3A3A3",

    tableHeaderBg: "262626",
    tableHeaderColor: "FFFFFF",
    tableAltRowBg: "FAFAFA",
    tableBorderColor: "E5E5E5",

    footerColor: "A3A3A3",
    footerLineColor: "E5E5E5",

    ground: "171717",
    tileColors: ["262626", "404040", "525252", "737373"],
    series: ["262626", "737373", "A3A3A3", "D4D4D4", "E5E5E5"],
  },

  creative: {
    name: "Creative",
    description: "Bold and expressive — perfect for pitches and creative work",

    titleSlideBackground: "2E1065",
    titleSlideTitleColor: "FFFFFF",
    titleSlideSubtitleColor: "C4B5FD",
    titleSlideAccentColor: "A78BFA",

    background: "FFFFFF",
    titleColor: "3B0764",
    subtitleColor: "7C3AED",
    bodyColor: "374151",
    accentColor: "7C3AED",
    bulletColor: "7C3AED",

    tableHeaderBg: "5B21B6",
    tableHeaderColor: "FFFFFF",
    tableAltRowBg: "FAF5FF",
    tableBorderColor: "E9D5FF",

    footerColor: "A78BFA",
    footerLineColor: "E9D5FF",

    ground: "2E1065",
    tileColors: ["4C1D95", "5B21B6", "6D28D9", "7C3AED"],
    series: ["7C3AED", "A78BFA", "F472B6", "2DD4BF", "C4B5FD"],
  },

  executive: {
    name: "Executive",
    description: "Board-ready financial reporting with restrained accents",

    titleSlideBackground: "0F1B1F",
    titleSlideTitleColor: "FFFFFF",
    titleSlideSubtitleColor: "5A6D82",
    titleSlideAccentColor: "C9943E",

    background: "FFFFFF",
    titleColor: "141414",
    subtitleColor: "6E7377",
    bodyColor: "141414",
    accentColor: "0F4C5C",
    bulletColor: "0F4C5C",

    tableHeaderBg: "0C1929",
    tableHeaderColor: "FFFFFF",
    tableAltRowBg: "F7F6F2",
    tableBorderColor: "DAD6CC",

    footerColor: "6E7377",
    footerLineColor: "D6D9DB",
  },
};

function deriveTheme(base) {
  const t = { ...EXEC_TOKEN_DEFAULTS, ...base };
  t.fontFace = t.fontFace || "Leelawadee UI";
  t.fontTitle = t.fontFace;
  t.fontBody = t.fontFace;
  t.chartColors = t.series;
  t.chartPositive = t.good;
  t.chartNegative = t.bad;
  t.chartNeutral = t.groundMuted;
  t.chartGrid = t.hairline;
  t.statusGreen = t.good;
  t.statusAmber = t.warn;
  t.statusRed = t.bad;
  return t;
}

/**
 * Get a theme by name, falling back to default if not found.
 * @param {string} themeName
 * @returns {object} Theme configuration
 */
function getTheme(themeName) {
  const key = (themeName || "default").toLowerCase().trim();
  return deriveTheme(THEMES[key] || THEMES.default);
}

/**
 * @returns {string[]} Available theme identifiers
 */
function getAvailableThemes() {
  return Object.keys(THEMES);
}

/**
 * @returns {object[]} Array of { id, name, description } for documentation
 */
function getThemeDescriptions() {
  return Object.entries(THEMES).map(([id, t]) => ({
    id,
    name: t.name,
    description: t.description,
  }));
}

module.exports = { THEMES, getTheme, getAvailableThemes, getThemeDescriptions };
