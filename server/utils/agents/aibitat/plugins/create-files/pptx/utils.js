// All positioning assumes LAYOUT_16x9: 10 × 5.625 in.
const SLIDE_W = 10;
const SLIDE_H = 5.625;
const MARGIN_X = 0.7;
const CONTENT_W = SLIDE_W - 2 * MARGIN_X;
const FOOTER_Y = 5.05; // Reserve the bottom strip for page numbers and sources.
const COVER_MARGIN_X = 0.6;
const COVER_W = SLIDE_W - 2 * COVER_MARGIN_X;

function isDarkColor(hexColor) {
  const hex = (hexColor || "FFFFFF").replace("#", "");
  const r = parseInt(hex.substr(0, 2), 16);
  const g = parseInt(hex.substr(2, 2), 16);
  const b = parseInt(hex.substr(4, 2), 16);
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255 < 0.5;
}

function addActionTitle(slide, theme, title, { y = 0.35 } = {}) {
  slide.addText(title, {
    x: MARGIN_X,
    y,
    w: CONTENT_W,
    h: 0.95,
    fontSize: 26,
    bold: true,
    fit: "shrink",
    color: theme.titleColor,
    fontFace: theme.fontFace,
    margin: 0,
    valign: "mid",
  });
  return 1.45;
}

function addFooter(slide, pptx, theme, { slideNumber, totalSlides, note }) {
  slide.addShape(pptx.ShapeType.rect, {
    x: MARGIN_X,
    y: FOOTER_Y,
    w: CONTENT_W,
    h: 0.007,
    fill: { color: theme.hairline },
    line: { color: theme.hairline, transparency: 100 },
  });
  slide.addText(`${slideNumber} / ${totalSlides}`, {
    x: MARGIN_X,
    y: 5.12,
    w: 0.8,
    h: 0.25,
    fontSize: 11,
    color: theme.footerColor,
    fontFace: theme.fontFace,
    align: "left",
    margin: 0,
    fit: "shrink",
  });
  if (note) {
    slide.addText(note, {
      x: 1.6,
      y: 5.12,
      w: 7.7,
      h: 0.25,
      fontSize: 11,
      color: theme.footerColor,
      fontFace: theme.fontFace,
      align: "right",
      margin: 0,
      fit: "shrink",
    });
  }
}

function addGround(slide, pptx, theme) {
  slide.background = { color: theme.ground };
  slide.addShape(pptx.ShapeType.rect, {
    x: 0,
    y: 0,
    w: SLIDE_W,
    h: SLIDE_H,
    fill: { color: theme.ground },
    line: { color: theme.ground, transparency: 100 },
  });
}

function renderCover(slide, pptx, { title, headline, subtitle, meta }, theme) {
  addGround(slide, pptx, theme);
  slide.addShape(pptx.ShapeType.rect, {
    x: COVER_MARGIN_X,
    y: 1.3,
    w: 0.5,
    h: 0.06,
    fill: { color: theme.accentColor },
    line: { color: theme.accentColor, transparency: 100 },
  });
  const textOptions = {
    x: COVER_MARGIN_X,
    w: COVER_W,
    fontFace: theme.fontFace,
    color: theme.groundMuted,
    margin: 0,
    fit: "shrink",
  };
  if (headline && title) {
    slide.addText(title, { ...textOptions, y: 0.9, h: 0.3, fontSize: 14 });
  }
  slide.addText(headline || title || "Untitled", {
    ...textOptions,
    y: 1.5,
    h: 2.2,
    fontSize: 48,
    bold: true,
    color: theme.groundText,
    valign: "mid",
  });
  if (subtitle) {
    slide.addText(subtitle, { ...textOptions, y: 3.9, h: 0.65, fontSize: 16 });
  }
  if (meta) {
    slide.addText(meta, { ...textOptions, y: 4.9, h: 0.3, fontSize: 12 });
  }
}

function renderStatement(slide, pptx, { headline, subtitle }, theme, ctx) {
  addGround(slide, pptx, theme);
  slide.addText(headline || "", {
    x: COVER_MARGIN_X,
    y: 1.9,
    w: COVER_W,
    h: 1.5,
    fontSize: 48,
    bold: true,
    color: theme.groundText,
    fontFace: theme.fontFace,
    margin: 0,
    fit: "shrink",
  });
  if (subtitle) {
    slide.addText(subtitle, {
      x: COVER_MARGIN_X,
      y: 3.6,
      w: COVER_W,
      h: 0.8,
      fontSize: 18,
      color: theme.groundMuted,
      fontFace: theme.fontFace,
      margin: 0,
      fit: "shrink",
    });
  }
}

function chartBaseOptions(theme, bg) {
  return {
    chartColors: [...theme.series],
    showLegend: false,
    showValue: true,
    showTitle: false,
    dataLabelFontSize: 11,
    catAxisLabelFontSize: 12,
    valAxisLabelFontSize: 11,
    dataLabelFontFace: theme.fontFace,
    catAxisLabelFontFace: theme.fontFace,
    valAxisLabelFontFace: theme.fontFace,
    legendFontFace: theme.fontFace,
    legendFontSize: 11,
    dataLabelColor: theme.bodyColor,
    catAxisLabelColor: theme.subtitleColor,
    valAxisLabelColor: theme.subtitleColor,
    valGridLine: { style: "none" },
    catGridLine: { style: "none" },
    valAxisLineShow: false,
    catAxisMajorTickMark: "none",
    chartArea: { fill: { color: bg }, border: { color: bg, pt: 0 } },
    plotArea: { fill: { color: bg }, border: { color: bg, pt: 0 } },
  };
}

function renderTitleSlide(slide, pptx, { title, author }, theme) {
  renderCover(slide, pptx, { title, meta: author }, theme);
}

function renderSectionSlide(slide, pptx, slideData, theme, slideNumber, totalSlides) {
  renderStatement(slide, pptx, {
    headline: slideData.headline || slideData.title,
    subtitle: slideData.subtitle,
  }, theme, { slideNumber, totalSlides });
  if (slideData.notes) slide.addNotes(slideData.notes);
}

function renderContentSlide(slide, pptx, slideData, theme, slideNumber, totalSlides) {
  slide.background = { color: theme.background };
  let contentStartY = slideData.title
    ? addActionTitle(slide, theme, slideData.title)
    : 0.4;
  if (slideData.subtitle) {
    slide.addText(slideData.subtitle, {
      x: MARGIN_X,
      y: contentStartY,
      w: CONTENT_W,
      h: 0.3,
      fontSize: 14,
      color: theme.subtitleColor,
      fontFace: theme.fontFace,
      margin: 0,
      fit: "shrink",
    });
    contentStartY += 0.45;
  }
  const contentHeight = FOOTER_Y - contentStartY - 0.15;
  if (slideData.table) {
    addTableContent(slide, pptx, slideData.table, theme, contentStartY);
  } else {
    addBulletContent(slide, slideData.content, theme, contentStartY, contentHeight);
  }
  addFooter(slide, pptx, theme, { slideNumber, totalSlides, note: slideData.note });
  if (slideData.notes) slide.addNotes(slideData.notes);
}

function renderBlankSlide(slide, pptx, theme, slideNumber, totalSlides) {
  slide.background = { color: theme.background };
  addFooter(slide, pptx, theme, { slideNumber, totalSlides });
}

function addBulletContent(slide, content, theme, startY, maxHeight) {
  if (!Array.isArray(content) || content.length === 0) return;

  const bulletPoints = content.map((text) => ({
    text,
    options: {
      fontSize: 15,
      color: theme.bodyColor,
      fontFace: theme.fontFace,
      bullet: { code: "25AA", color: theme.bulletColor },
      paraSpaceAfter: 10,
    },
  }));

  slide.addText(bulletPoints, {
    x: MARGIN_X,
    y: startY,
    w: CONTENT_W,
    h: maxHeight,
    valign: "top",
    fontFace: theme.fontFace,
  });
}

function addTableContent(slide, pptx, tableData, theme, startY) {
  if (!tableData) return;

  const rows = [];

  if (tableData.headers?.length > 0) {
    rows.push(
      tableData.headers.map((header) => ({
        text: header,
        options: {
          bold: true,
          fontSize: 12,
          fontFace: theme.fontFace,
          color: theme.tableHeaderColor,
          fill: { color: theme.tableHeaderBg },
          align: "left",
          valign: "middle",
          margin: [4, 8, 4, 8],
        },
      }))
    );
  }

  if (tableData.rows?.length > 0) {
    tableData.rows.forEach((row, idx) => {
      rows.push(
        row.map((cell) => ({
          text: cell,
          options: {
            fontSize: 11,
            fontFace: theme.fontFace,
            color: theme.bodyColor,
            fill: {
              color: idx % 2 === 1 ? theme.tableAltRowBg : theme.background,
            },
            align: "left",
            valign: "middle",
            margin: [4, 8, 4, 8],
          },
        }))
      );
    });
  }

  if (rows.length === 0) return;

  const colCount = rows[0].length;
  slide.addTable(rows, {
    x: MARGIN_X,
    y: startY,
    w: CONTENT_W,
    colW: CONTENT_W / colCount,
    fontFace: theme.fontFace,
    rowH: 0.4,
    border: { type: "solid", pt: 0.5, color: theme.tableBorderColor },
  });
}

module.exports = {
  isDarkColor,
  addActionTitle,
  addFooter,
  renderCover,
  renderStatement,
  chartBaseOptions,
  renderTitleSlide,
  renderSectionSlide,
  renderContentSlide,
  renderBlankSlide,
  addBulletContent,
  addTableContent,
};
