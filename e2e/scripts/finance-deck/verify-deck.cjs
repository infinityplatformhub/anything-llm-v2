// usage: node e2e/scripts/finance-deck/verify-deck.cjs <deck.pptx>   (any cwd)
// Machine checks on a finance deck: slide count, chart per slide, no bar+line combo parts,
// only undeclared axId 2094734556, doughnut dLblPos before show*, dash only on gap-bearing 2-series line chart,
// embedded table ref has no stray apostrophe. Exits 1 on any failure.
// jszip is a server dependency (pptxgenjs); resolve it from server/node_modules regardless of cwd
const JSZip = require(require("path").join(__dirname, "../../../server/node_modules/jszip"));
const fs = require("fs");
(async () => {
  const z = await JSZip.loadAsync(fs.readFileSync(process.argv[2]));
  const names = Object.keys(z.files);
  const fails = [];
  const slides = names.filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)).sort((a, b) => +a.match(/\d+/)[0] - +b.match(/\d+/)[0]);
  console.log("slides:", slides.length);
  for (const s of slides) {
    const xml = await z.file(s).async("string");
    const charts = (xml.match(/<c:chart /g) || []).length;
    const titles = [...xml.matchAll(/<a:t>([^<]{0,60})<\/a:t>/g)].slice(0, 2).map((m) => m[1]);
    console.log(` ${s.replace("ppt/slides/", "")} charts=${charts} :: ${titles.join(" | ")}`);
  }
  const charts = names.filter((n) => /^ppt\/charts\/chart\d+\.xml$/.test(n)).sort();
  for (const c of charts) {
    const xml = await z.file(c).async("string");
    const types = ["barChart", "lineChart", "doughnutChart", "pieChart"].filter((t) => xml.includes(`<c:${t}>`));
    if (types.includes("barChart") && types.includes("lineChart")) fails.push(`${c}: bar+line combo part`);
    const declared = new Set([...xml.matchAll(/<c:(?:valAx|catAx)>[\s\S]*?<c:axId val="(\d+)"/g)].map((m) => m[1]));
    const referenced = [...xml.matchAll(/<c:axId val="(\d+)"\/>/g)].map((m) => m[1]);
    const undeclared = [...new Set(referenced.filter((id) => !declared.has(id)))].filter((id) => id !== "2094734556");
    if (undeclared.length) fails.push(`${c}: undeclared axId ${undeclared.join(",")}`);
    const serCount = (xml.match(/<c:ser>/g) || []).length;
    const dashed = [...xml.matchAll(/<c:ser>[\s\S]*?<\/c:ser>/g)].map((m) => /<a:prstDash val="(?!solid)/.test(m[0]));
    if (types.includes("doughnutChart")) {
      const dl = xml.match(/<c:dLbls>[\s\S]*?<\/c:dLbls>/)?.[0] || "";
      const pos = dl.indexOf("<c:dLblPos"), show = dl.search(/<c:show(LegendKey|Val|CatName|SerName|Percent)/);
      if (pos < 0) fails.push(`${c}: doughnut has no dLblPos`);
      else if (show >= 0 && pos > show) fails.push(`${c}: dLblPos after show* (CT_DLbl order)`);
    }
    if (types.includes("lineChart")) {
      const gaps = [...xml.matchAll(/<c:ser>[\s\S]*?<\/c:ser>/g)].map((m) => {
        // mirror seriesHasNumericGaps in finance-layouts.js: ptCount and populated <c:v> points from numCache only
        const nc = m[0].match(/<c:numCache>[\s\S]*?<\/c:numCache>/)?.[0] || "";
        const pc = +(nc.match(/<c:ptCount val="(\d+)"/)?.[1] || 0);
        const pts = (nc.match(/<c:pt idx="\d+"><c:v>[^<]+<\/c:v><\/c:pt>/g) || []).length;
        return pts < pc;
      });
      const isForecast = serCount === 2 && gaps.every(Boolean);
      const expect = isForecast ? [false, true] : dashed.map(() => false);
      if (JSON.stringify(dashed) !== JSON.stringify(expect)) fails.push(`${c}: dash pattern ${JSON.stringify(dashed)} expected ${JSON.stringify(expect)} (forecast=${isForecast})`);
    }
    console.log(` ${c.replace("ppt/charts/", "")} types=${types.join("+")} ser=${serCount} dashed=${dashed.map((d) => (d ? "dash" : "solid")).join(",")}`);
  }
  // embedded workbooks are nested zips under ppt/embeddings/*.xlsx
  let tables = 0;
  for (const e of names.filter((n) => /^ppt\/embeddings\/.*\.xlsx$/.test(n))) {
    const wb = await JSZip.loadAsync(await z.file(e).async("nodebuffer"));
    for (const t of Object.keys(wb.files).filter((n) => /^xl\/tables\/table\d+\.xml$/.test(n))) {
      tables++;
      const xml = await wb.file(t).async("string");
      if (/ref="[^"]*'"/.test(xml)) fails.push(`${e}!${t}: stray apostrophe in ref`);
    }
  }
  console.log("embedded tables checked:", tables);
  if (charts.length && tables === 0) fails.push("no embedded tables found although charts exist");
  if (fails.length) { console.log("FAIL\n - " + fails.join("\n - ")); process.exit(1); }
  console.log("DECK CHECKS PASS");
})();
