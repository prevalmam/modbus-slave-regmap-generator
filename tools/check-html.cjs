"use strict";
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const crypto = require("node:crypto");
const {performance} = require("node:perf_hooks");
const {isDeepStrictEqual} = require("node:util");

const USAGE = "node tools/check-html.cjs product.html [--compare before.html] [--out-dir directory]";
const plain = value => JSON.parse(JSON.stringify(value));

// Use the target HTML's own parser, validator and generator, including when this
// single tool is copied beside a product HTML without the generator checkout.
function inspectHtml(html) {
  if (!/<html\b[^>]*\bdata-modbus-regmap-editor="1"/i.test(html)) throw Error("Expected a register editor HTML");
  const embedded = [...html.matchAll(/<script\b[^>]*\bid="html-project-data"[^>]*>([\s\S]*?)<\/script>/gi)];
  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)]
    .filter(match => !/type="application\/json"/i.test(match[1]));
  if (embedded.length !== 1 || scripts.length !== 1) throw Error("Expected one saved definition and one editor script");
  const source = scripts[0][2];
  new vm.Script(source);
  const boundary = source.indexOf("const editorTabs =");
  const parseStart = source.indexOf("function parseHtmlDraft(");
  const parseEnd = source.indexOf("function currentHtmlDraft(", parseStart);
  if (boundary < 0 || parseStart < boundary || parseEnd < parseStart) throw Error("Unsupported editor HTML structure");
  const context = vm.createContext({savedText: embedded[0][1]});
  vm.runInContext(source.slice(0, boundary) + "\n" + source.slice(parseStart, parseEnd) +
    "\nvar savedDraft = parseHtmlDraft(savedText);", context, {timeout: 5000});
  if (!context.savedDraft) throw Error("The HTML has no saved definition; save the product HTML first");
  vm.runInContext("var inspected = inspectProject(savedDraft.project);", context, {timeout: 5000});
  const inspection = plain(context.inspected);
  const pendingForms = ["enumForm", "bitsetForm"].filter(name => context.savedDraft[name] != null);
  const errors = [...inspection.errors, ...pendingForms.map(field => ({row: null, field,
    text: field + " has unregistered edits; register or discard the form edits before generating"}))];
  return {context, inspection, pendingForms, errors};
}

function generate(result) {
  if (result.errors.length) throw Error("The HTML is not ready for generation");
  vm.runInContext("var generatedFiles = generateModbusFiles(inspected.validated);", result.context, {timeout: 5000});
  return plain(result.context.generatedFiles);
}

function definitionDiff(before, after, pointer = "") {
  if (isDeepStrictEqual(before, after)) return [];
  if (before && after && typeof before === "object" && typeof after === "object" &&
      Array.isArray(before) === Array.isArray(after)) {
    const changes = [];
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
      const next = pointer + "/" + key.replace(/~/g, "~0").replace(/\//g, "~1");
      if (!Object.hasOwn(before, key)) changes.push({op: "add", path: next, after: after[key]});
      else if (!Object.hasOwn(after, key)) changes.push({op: "remove", path: next, before: before[key]});
      else changes.push(...definitionDiff(before[key], after[key], next));
    }
    return changes;
  }
  return [{op: "replace", path: pointer, before, after}];
}

function checkHtml(filename, {compare, outDir} = {}) {
  const start = performance.now();
  const source = path.resolve(filename);
  const html = fs.readFileSync(source, "utf8");
  const current = inspectHtml(html);
  const report = {ok: !current.errors.length, source,
    htmlSha256: crypto.createHash("sha256").update(html).digest("hex"),
    registers: current.context.savedDraft.project.registers.length,
    schemaVersion: current.inspection.validated?.documentValue.schemaVersion ?? null,
    pendingForms: current.pendingForms, errors: current.errors, warnings: current.inspection.warnings};
  // Compute and validate everything before creating the requested output folder.
  if (report.ok) {
    const files = generate(current);
    report.generatedFiles = Object.keys(files);
    if (compare) {
      const before = inspectHtml(fs.readFileSync(path.resolve(compare), "utf8"));
      if (before.errors.length) throw Error("Comparison HTML is invalid: " + JSON.stringify(before.errors));
      const previousFiles = generate(before);
      report.comparison = {
        source: path.resolve(compare), warnings: before.inspection.warnings,
        definitionChanges: definitionDiff(before.inspection.validated.documentValue, current.inspection.validated.documentValue),
        changedFiles: [...new Set([...Object.keys(previousFiles), ...Object.keys(files)])]
          .filter(name => previousFiles[name] !== files[name])
      };
    }
    if (outDir) {
      for (const name of Object.keys(files)) {
        if (!/^[A-Za-z_][A-Za-z0-9_]*\.[ch]$/.test(name)) throw Error("Invalid generated filename: " + name);
      }
      const directory = path.resolve(outDir);
      fs.mkdirSync(directory, {recursive: true});
      for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(directory, name), text, "utf8");
      report.outputDirectory = directory;
    }
  }
  report.elapsedMs = Math.round(performance.now() - start);
  return report;
}

function main(argv) {
  if (argv.length === 1 && argv[0] === "--help") {console.log(USAGE); return;}
  const filename = argv[0];
  if (!filename || filename.startsWith("--")) throw Error(USAGE);
  const options = {};
  const flags = new Map([["--compare", "compare"], ["--out-dir", "outDir"]]);
  for (let i = 1; i < argv.length; i++) {
    const key = flags.get(argv[i]);
    if (!key || options[key] || !argv[i + 1] || argv[i + 1].startsWith("--")) throw Error(USAGE);
    options[key] = argv[++i];
  }
  const report = checkHtml(filename, options);
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exitCode = 1;
}

if (require.main === module) {
  const start = performance.now();
  try {main(process.argv.slice(2));}
  catch (error) {
    console.log(JSON.stringify({ok: false, error: error.message, elapsedMs: Math.round(performance.now() - start)}));
    process.exitCode = 1;
  }
}
module.exports = {inspectHtml, checkHtml, definitionDiff};
