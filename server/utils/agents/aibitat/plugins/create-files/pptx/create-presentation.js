const createFilesLib = require("../lib.js");
const { getTheme, getAvailableThemes } = require("./themes.js");
const {
  renderCover,
  renderStatement,
  renderSectionSlide,
  renderContentSlide,
  renderBlankSlide,
} = require("./utils.js");
const { runSectionAgent } = require("./section-agent.js");
const {
  FINANCE_LAYOUTS,
  validateFinanceSections,
} = require("./finance-schema.js");
const { RENDERERS, fixEmbeddedChartTables } = require("./finance-layouts.js");
const { EXEC_RENDERERS, validateExecSection } = require("./exec-layouts.js");

/**
 * Extracts recent conversation history from the parent AIbitat's chat log
 * to provide context to each section sub-agent.
 * @param {Array} chats - The parent AIbitat's _chats array
 * @param {number} [maxMessages=10] - Maximum messages to include
 * @returns {string} Formatted conversation context
 */
function extractConversationContext(chats, maxMessages = 10) {
  if (!Array.isArray(chats) || chats.length === 0) return "";

  const recent = chats
    .filter((c) => c.state === "success" && c.content)
    .slice(-maxMessages);

  if (recent.length === 0) return "";

  return recent
    .map((c) => {
      const content =
        typeof c.content === "string" ? c.content.substring(0, 500) : "";
      return `${c.from}: ${content}`;
    })
    .join("\n");
}

module.exports.CreatePptxPresentation = {
  name: "create-pptx-presentation",
  plugin: function () {
    return {
      name: "create-pptx-presentation",
      setup(aibitat) {
        aibitat.function({
          super: aibitat,
          name: this.name,
          description:
            "Create a professional PowerPoint presentation (PPTX) in outline or finance mode. " +
            "Outline mode independently builds section outlines with focused sub-agents that emit " +
            "native charts and KPI tiles alongside bullet slides. " +
            "Pass headline for the one-sentence verdict on the cover and closing for the final statement slide. " +
            "Finance mode validates structured financial data and renders sections directly without research.",
          examples: [
            {
              prompt: "Create a presentation about project updates",
              call: JSON.stringify({
                filename: "project-updates.pptx",
                title: "Q1 Project Updates",
                headline: "Q1 shipped on plan with 40% fewer bugs",
                theme: "corporate",
                closing: {
                  headline: "Hold the Q1 pace into Q2",
                  subtitle: "Keep the two new engineers on feature X",
                },
                sections: [
                  {
                    title: "Overview",
                    keyPoints: [
                      "Project on track for Q1 delivery",
                      "Team expanded by 2 new members",
                      "Budget within expectations",
                    ],
                  },
                  {
                    title: "Key Achievements",
                    keyPoints: [
                      "Launched new feature X",
                      "Reduced bug count by 40%",
                      "Improved performance by 25%",
                    ],
                    instructions:
                      "Include specific metrics and quarter-over-quarter comparisons",
                  },
                ],
              }),
            },
            {
              prompt: "Create an executive finance review",
              call: JSON.stringify({
                filename: "finance-review.pptx",
                title: "Executive Finance Review",
                theme: "executive",
                mode: "finance",
                unit: "บาท",
                footer: {
                  period: "ม.ค.–ส.ค. 2569",
                  source: "FlowAccount",
                  preparedOn: "2026-09-07",
                },
                sections: [
                  {
                    layout: "summary",
                    title: "รายได้โต แต่กำไรลด",
                    data: {
                      narrative: "รายได้โต 12.4% แต่กำไรลด 6.8%",
                      metrics: [
                        {
                          label: "รายได้",
                          value: 18420000,
                          delta: 12.4,
                          deltaLabel: "เทียบปีก่อน",
                        },
                        {
                          label: "ค่าใช้จ่าย",
                          value: 15890000,
                          delta: 16.2,
                          deltaLabel: "เทียบปีก่อน",
                        },
                        {
                          label: "กำไรสุทธิ",
                          value: 2530000,
                          delta: -6.8,
                          deltaLabel: "เทียบปีก่อน",
                        },
                      ],
                      verdict: "mixed",
                    },
                  },
                  {
                    layout: "waterfall",
                    title: "การลงทุนทีมขายกินกำไรที่ลูกค้าใหญ่ทำได้",
                    data: {
                      start: { label: "งวดเทียบ", value: 2714000 },
                      steps: [
                        {
                          label: "ลูกค้าใหญ่",
                          value: 1640000,
                          kind: "structural",
                        },
                        {
                          label: "เลื่อนรับสินค้า",
                          value: -210000,
                          kind: "timing",
                        },
                        {
                          label: "ทีมขายใหม่",
                          value: -1210000,
                          kind: "investment",
                        },
                        {
                          label: "ต้นทุนสินค้า",
                          value: -404000,
                          kind: "structural",
                        },
                      ],
                      end: { label: "งวดนี้", value: 2530000 },
                    },
                  },
                ],
              }),
            },
            {
              prompt: "Create a dark themed presentation about AI trends",
              call: JSON.stringify({
                filename: "ai-trends.pptx",
                title: "AI Trends 2025",
                theme: "dark",
                sections: [
                  {
                    title: "Large Language Models",
                    keyPoints: [
                      "Model scaling trends",
                      "Open vs closed source landscape",
                    ],
                    instructions:
                      "Research the latest developments and include recent data",
                  },
                  {
                    title: "AI in Enterprise",
                    keyPoints: ["Adoption rates", "Top use cases", "ROI data"],
                  },
                ],
              }),
            },
          ],
          parameters: {
            $schema: "http://json-schema.org/draft-07/schema#",
            type: "object",
            properties: {
              filename: {
                type: "string",
                description:
                  "The filename for the presentation (should end with .pptx).",
              },
              title: {
                type: "string",
                description:
                  "The title of the presentation (shown on title slide).",
              },
              author: {
                type: "string",
                description:
                  "Optional author name for the presentation metadata.",
              },
              headline: {
                type: "string",
                description:
                  "One-sentence verdict shown on the cover, in place of a topic label.",
              },
              closing: {
                type: "object",
                description:
                  "Optional closing statement slide rendered after every section.",
                properties: {
                  headline: { type: "string" },
                  subtitle: { type: "string" },
                },
                additionalProperties: false,
              },
              note: {
                type: "string",
                description:
                  "One-line source or period note shown in the footer of every content slide.",
              },
              theme: {
                type: "string",
                enum: getAvailableThemes(),
                description:
                  "Color theme for the presentation. Options: " +
                  getAvailableThemes().join(", "),
              },
              mode: {
                type: "string",
                enum: ["outline", "finance"],
                default: "outline",
                description:
                  "outline builds sections with sub-agents; finance validates and renders structured section data directly.",
              },
              unit: {
                type: "string",
                description:
                  "Default unit for finance values (for example, บาท).",
              },
              footer: {
                type: "object",
                description:
                  "Deck footer shown on finance content slides, including period, source, and preparation date.",
                properties: {
                  period: { type: "string" },
                  source: { type: "string" },
                  preparedOn: { type: "string" },
                },
                additionalProperties: false,
              },
              sections: {
                type: "array",
                description:
                  "Section outlines for the presentation. Each section is independently researched and built by a focused sub-agent.",
                items: {
                  type: "object",
                  properties: {
                    layout: {
                      type: "string",
                      enum: [
                        ...Object.keys(FINANCE_LAYOUTS),
                        "content",
                        "section",
                        "blank",
                      ],
                      description:
                        "Finance or executive layout, or legacy content, section, or blank layout.",
                    },
                    title: {
                      type: "string",
                      description: "The section title.",
                    },
                    subtitle: {
                      type: "string",
                      description: "Optional section subtitle.",
                    },
                    notes: {
                      type: "string",
                      description: "Optional speaker notes.",
                    },
                    data: {
                      type: "object",
                      description:
                        "Structured finance data matching the selected finance layout schema.",
                    },
                    keyPoints: {
                      type: "array",
                      items: { type: "string" },
                      description:
                        "Key points this section should cover. The sub-agent will expand these into detailed slides.",
                    },
                    instructions: {
                      type: "string",
                      description:
                        "Optional guidance for the section builder (e.g. 'research recent statistics', 'compare with competitors', 'include a data table').",
                    },
                  },
                  required: ["title"],
                },
              },
            },
            required: ["filename", "title", "sections"],
            additionalProperties: false,
          },

          handler: async function ({
            filename = "presentation.pptx",
            title = "Untitled Presentation",
            headline = "",
            closing = null,
            note = "",
            author = "",
            theme: themeName = "default",
            mode = "outline",
            unit = "บาท",
            footer = {},
            sections = [],
          }) {
            try {
              this.super.handlerProps.log(
                `Using the create-pptx-presentation tool.`
              );

              // Strip XML 1.0 illegal control characters so PowerPoint can open
              // the generated deck (slide content is sanitized after assembly).
              title = createFilesLib.stripInvalidXmlChars(title);
              headline = createFilesLib.stripInvalidXmlChars(headline);
              note = createFilesLib.stripInvalidXmlChars(note);
              closing = createFilesLib.stripInvalidXmlChars(closing);
              // The cover reads period/source/preparedOn straight out of footer,
              // ahead of the post-assembly sweep that only covers section slides.
              footer = createFilesLib.stripInvalidXmlChars(footer);
              author = createFilesLib.stripInvalidXmlChars(author);

              if (!filename.toLowerCase().endsWith(".pptx"))
                filename += ".pptx";

              const theme = getTheme(themeName);
              const totalSections = sections.length;

              if (mode === "finance") {
                const validation = validateFinanceSections(sections);
                if (!validation.ok)
                  return `Cannot build finance deck: ${validation.errors.join("; ")}`;
              }

              this.super.introspect(
                `${this.caller}: Planning presentation "${title}" — ${totalSections} section${totalSections !== 1 ? "s" : ""}, ${theme.name} theme`
              );

              // Ask for approval BEFORE kicking off the expensive sub-agent work
              if (this.super.requestToolApproval) {
                const approval = await this.super.requestToolApproval({
                  skillName: this.name,
                  payload: {
                    filename,
                    title,
                    mode,
                    sectionCount: totalSections,
                    sectionTitles: sections.map((s) => s.title),
                  },
                  description: `Create PowerPoint presentation "${title}" with ${totalSections} sections`,
                });
                if (!approval.approved) {
                  this.super.introspect(
                    `${this.caller}: User rejected the ${this.name} request.`
                  );
                  return approval.message;
                }
              }

              let allSlides;
              if (mode === "finance") {
                allSlides = sections.map((section) => ({
                  ...section,
                  unit: section.unit || unit,
                  footer: section.footer || footer,
                }));
              } else {
                const conversationContext = extractConversationContext(
                  this.super._chats
                );

                // Run a focused sub-agent for each section sequentially.
                // Sequential execution is intentional — local models typically serve
                // one request at a time, and it keeps introspection events ordered.
                allSlides = [];
                const allCitations = [];
                for (let i = 0; i < sections.length; i++) {
                  const section = sections[i];
                  this.super.introspect(
                    `${this.caller}: [${i + 1}/${totalSections}] Building section "${section.title}"…`
                  );

                  const sectionResult = await runSectionAgent({
                    parentAibitat: this.super,
                    section,
                    presentationTitle: title,
                    conversationContext,
                    sectionPrefix: `${i + 1}/${totalSections}`,
                  });

                  const slideCount = sectionResult.slides?.length || 0;
                  allSlides.push(...(sectionResult.slides || []));
                  if (sectionResult.citations?.length > 0)
                    allCitations.push(...sectionResult.citations);

                  this.super.introspect(
                    `${this.caller}: [${i + 1}/${totalSections}] Section "${section.title}" complete — ${slideCount} slide${slideCount !== 1 ? "s" : ""}`
                  );
                }

                // Roll up all citations from sub-agents to the parent so they
                // appear as sources on the final assistant message.
                if (allCitations.length > 0)
                  this.super.addCitation(allCitations);
              }

              // Assemble the final PPTX from all section outputs
              this.super.introspect(
                `${this.caller}: Assembling final deck — ${allSlides.length} slides total`
              );

              const PptxGenJS = require("pptxgenjs");
              const pptx = new PptxGenJS();

              pptx.title = title;
              if (author) pptx.author = author;
              pptx.company = "AnythingLLM";

              const closingHeadline = closing?.headline || "";
              // The closing statement is a real slide, so it counts toward the
              // "n / total" footer the section slides print.
              const totalSlideCount =
                allSlides.length + (closingHeadline ? 1 : 0);

              // Sub-agent output can carry XML 1.0 illegal control characters
              // (e.g. a form feed from a LaTeX `\frac`); strip them recursively
              // from every slide so PowerPoint can open the generated deck.
              const cleanSlides =
                createFilesLib.stripInvalidXmlChars(allSlides);

              // Cover slide: the headline is the verdict, the title becomes the eyebrow.
              const coverSlide = pptx.addSlide();
              renderCover(
                coverSlide,
                pptx,
                {
                  title,
                  headline,
                  subtitle: `${footer.period || ""}`,
                  meta: [author, footer.source, footer.preparedOn]
                    .filter(Boolean)
                    .join(" · "),
                },
                theme
              );

              const log = this.super.handlerProps.log;

              // Render every slide produced by the section agents
              cleanSlides.forEach((slideData, index) => {
                const slide = pptx.addSlide();
                const slideNumber = index + 1;
                const layout = slideData.layout || "content";
                // The generic executive layouts are valid finance layouts too, so
                // they must render rather than fall through to the pending slide.
                const financeRenderer =
                  mode === "finance"
                    ? RENDERERS[layout] ||
                      EXEC_RENDERERS[layout] ||
                      (!["content", "section", "blank"].includes(layout)
                        ? RENDERERS.__pending
                        : null)
                    : null;
                // Outline slides come from a language model, so their layout data
                // can be malformed; validate before handing it to a renderer that
                // would otherwise throw and lose the whole deck.
                const execRenderer =
                  mode !== "finance" ? EXEC_RENDERERS[layout] : null;

                if (execRenderer) {
                  const errors = validateExecSection(
                    slideData,
                    `slide ${slideNumber}`,
                    []
                  );
                  if (errors.length > 0) {
                    log(
                      `create-pptx-presentation: slide ${slideNumber} ${errors.join("; ")} — falling back to content`
                    );
                    renderContentSlide(
                      slide,
                      pptx,
                      {
                        title: slideData.title,
                        content: [
                          JSON.stringify(slideData.data ?? null).slice(0, 300),
                        ],
                        note: slideData.note || note,
                      },
                      theme,
                      slideNumber,
                      totalSlideCount
                    );
                    return;
                  }
                  execRenderer(slide, pptx, slideData, theme, {
                    slideNumber,
                    totalSlides: totalSlideCount,
                    note: slideData.note || note,
                    bg: theme.background,
                  });
                  return;
                }

                if (financeRenderer) {
                  financeRenderer(slide, pptx, slideData, theme, {
                    slideNumber,
                    totalSlides: totalSlideCount,
                    unit: slideData.unit,
                    footer: slideData.footer,
                    bg: theme.background,
                  });
                  return;
                }

                switch (layout) {
                  case "title":
                  case "section":
                    renderSectionSlide(
                      slide,
                      pptx,
                      slideData,
                      theme,
                      slideNumber,
                      totalSlideCount
                    );
                    break;
                  case "blank":
                    renderBlankSlide(
                      slide,
                      pptx,
                      theme,
                      slideNumber,
                      totalSlideCount
                    );
                    break;
                  default:
                    renderContentSlide(
                      slide,
                      pptx,
                      { ...slideData, note: slideData.note || note },
                      theme,
                      slideNumber,
                      totalSlideCount
                    );
                    break;
                }
              });

              if (closingHeadline) {
                renderStatement(
                  pptx.addSlide(),
                  pptx,
                  { headline: closingHeadline, subtitle: closing.subtitle },
                  theme,
                  { slideNumber: totalSlideCount, totalSlides: totalSlideCount }
                );
              }

              // Every mode can now emit native charts, and pptxgenjs writes a
              // table ref Keynote refuses to open, so the fixer runs on all decks.
              const buffer = await fixEmbeddedChartTables(
                await pptx.write({ outputType: "nodebuffer" })
              );
              const bufferSizeKB = (buffer.length / 1024).toFixed(2);
              const bufferSizeMB = (buffer.length / (1024 * 1024)).toFixed(2);
              this.super.handlerProps.log(
                `create-pptx-presentation: Generated buffer - size: ${bufferSizeKB}KB (${bufferSizeMB}MB), slides: ${totalSlideCount}, theme: ${theme.name}`
              );

              const displayFilename = filename.split("/").pop();

              const savedFile = await createFilesLib.saveGeneratedFile({
                fileType: "pptx",
                extension: "pptx",
                buffer,
                displayFilename,
              });

              this.super.socket.send("fileDownloadCard", {
                filename: savedFile.displayFilename,
                storageFilename: savedFile.filename,
                fileSize: savedFile.fileSize,
              });

              createFilesLib.registerOutput(this.super, "PptxFileDownload", {
                filename: savedFile.displayFilename,
                storageFilename: savedFile.filename,
                fileSize: savedFile.fileSize,
              });

              this.super.introspect(
                `${this.caller}: Successfully created presentation "${title}"`
              );

              return `Successfully created presentation "${title}" with ${totalSlideCount} slides across ${totalSections} sections using the ${theme.name} theme.`;
            } catch (e) {
              this.super.handlerProps.log(
                `create-pptx-presentation error: ${e.message}`
              );
              this.super.introspect(`Error: ${e.message}`);
              return `Error creating presentation: ${e.message}`;
            }
          },
        });
      },
    };
  },
};
