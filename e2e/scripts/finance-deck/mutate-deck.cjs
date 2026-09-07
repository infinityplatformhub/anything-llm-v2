// negative control for verify-deck.cjs: dash the first series of the FIRST lineChart part (cash chart) → checker must FAIL
// jszip is a server dependency (pptxgenjs); resolve it from server/node_modules regardless of cwd
const JSZip = require(require("path").join(__dirname, "../../../server/node_modules/jszip")); const fs = require("fs");
(async () => {
  const [inF, outF] = process.argv.slice(2);
  const z = await JSZip.loadAsync(fs.readFileSync(inF));
  const charts = Object.keys(z.files).filter((n) => /^ppt\/charts\/chart\d+\.xml$/.test(n)).sort();
  let done = false;
  for (const c of charts) {
    let xml = await z.file(c).async("string");
    if (!xml.includes("<c:lineChart>") || done) continue;
    xml = xml.replace(/<c:ser>([\s\S]*?)<\/c:ser>/, (m) => m.replace(/<a:ln([^>]*)>/, '<a:ln$1><a:prstDash val="dash"/>'));
    z.file(c, xml); done = true; console.log("mutated", c);
  }
  fs.writeFileSync(outF, await z.generateAsync({ type: "nodebuffer" }));
})();
