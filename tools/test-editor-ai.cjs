"use strict";
const {test} = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const {spawnSync} = require("node:child_process");
const core = require("./editor-core.cjs");
const {checkHtml, definitionDiff} = require("./check-html.cjs");
const original = fs.readFileSync(path.join(__dirname, "../modbus-regmap-editor.html"), "utf8");
const marker = /(<script id="html-project-data" type="application\/json">)([^<]*)(<\/script>)/;
const plain = value => JSON.parse(JSON.stringify(value));

function fixture(edit = () => {}) {
  const draft = {version: 2, sourceName: "fixture.html", project: plain(core.sampleProject()), enumForm: null, bitsetForm: null};
  edit(draft);
  return original.replace(marker, (_, open, _data, close) => open + JSON.stringify(draft).replace(/</g, "\\u003c") + close);
}

function temporary(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "regmap-ai-"));
  t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
  fs.copyFileSync(path.join(__dirname, "check-html.cjs"), path.join(directory, "check.cjs"));
  return directory;
}

function run(directory, args) {
  const result = spawnSync(process.execPath, ["check.cjs", ...args], {cwd: directory, encoding: "utf8", timeout: 10000});
  assert.ifError(result.error);
  assert.equal(result.stderr, "");
  return {...result, report: JSON.parse(result.stdout)};
}

test("HTML checking works with only the standalone tool and HTML, leaving all inputs untouched", t => {
  const directory = temporary(t), filename = path.join(directory, "product.html"), html = fixture();
  fs.writeFileSync(filename, html);
  const {status, report} = run(directory, ["product.html"]);
  assert.equal(status, 0);
  assert.equal(report.ok, true);
  assert.equal(report.registers, 6);
  assert.equal(report.schemaVersion, 7);
  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.warnings, []);
  assert(report.generatedFiles.includes("modbus_parser.c"));
  assert(report.generatedFiles.includes("modbus_reg_map_slave.c"));
  assert(report.elapsedMs >= 0);
  assert.equal(report.htmlSha256.length, 64);
  assert.deepEqual(fs.readdirSync(directory).sort(), ["check.cjs", "product.html"]);
  assert.equal(fs.readFileSync(filename, "utf8"), html);
});

test("explicit output uses the target HTML's own generation runtime and writes the complete C/H set", t => {
  const directory = temporary(t);
  const html = fixture().replace("/* Modbus register index definitions */", "/* target HTML runtime */");
  fs.writeFileSync(path.join(directory, "product.html"), html);
  const {status, report} = run(directory, ["product.html", "--out-dir", "generated"]);
  assert.equal(status, 0);
  const expected = plain(core.generateModbusFiles(core.inspectProject(core.sampleProject()).validated));
  expected["modbus_reg_idx_slave.h"] = expected["modbus_reg_idx_slave.h"]
    .replace("/* Modbus register index definitions */", "/* target HTML runtime */");
  assert.deepEqual(fs.readdirSync(report.outputDirectory).sort(), Object.keys(expected).sort());
  for (const [name, text] of Object.entries(expected)) {
    assert.equal(fs.readFileSync(path.join(report.outputDirectory, name), "utf8"), text, name);
  }
  assert.equal(fs.readFileSync(path.join(directory, "product.html"), "utf8"), html);
});

test("invalid definitions, unsupported or missing drafts and malformed scripts cannot start output", t => {
  const directory = temporary(t), filename = path.join(directory, "bad.html");
  const invalid = [
    fixture(d => {d.project.registers[0].address = d.project.registers[1].address;}),
    fixture(d => {d.project.config.nvmSize = "1";}),
    fixture(d => {d.version = 1;}),
    original.replace(marker, "$1null$3"),
    original.replace(marker, ""),
    fixture().replace("const editorTabs =", "const unsupportedTabs ="),
    fixture().replace('"use strict";', '"use strict"; const = ;')
  ];
  for (const html of invalid) {
    fs.writeFileSync(filename, html);
    const {status, report} = run(directory, ["bad.html", "--out-dir", "generated"]);
    assert.equal(status, 1);
    assert.equal(report.ok, false);
    assert(report.elapsedMs >= 0);
    assert(!fs.existsSync(path.join(directory, "generated")));
    assert.equal(fs.readFileSync(filename, "utf8"), html);
  }
});

test("unregistered enum and bitset edits are reported and block output", t => {
  const directory = temporary(t), filename = path.join(directory, "pending.html");
  for (const field of ["enumForm", "bitsetForm"]) {
    fs.writeFileSync(filename, fixture(d => {
      d[field] = field === "enumForm" ? {index: null, id: "pending", label: "Pending", members: []} :
        {index: null, id: "pending", label: "Pending", width: "16", bits: []};
    }));
    const {status, report} = run(directory, ["pending.html", "--out-dir", "generated"]);
    assert.equal(status, 1);
    assert.deepEqual(report.pendingForms, [field]);
    assert.equal(report.errors[0].field, field);
    assert(!fs.existsSync(path.join(directory, "generated")));
  }
});

test("warnings remain visible while valid definitions can generate", t => {
  const directory = temporary(t), filename = path.join(directory, "warning.html");
  fs.writeFileSync(filename, fixture(d => {
    d.project.registers.push(plain(core.draftRow({name: "unaligned", type: "uint32_t", address: 200, nvmOffset: 17})));
  }));
  const {status, report} = run(directory, ["warning.html", "--out-dir", "generated"]);
  assert.equal(status, 0);
  assert.equal(report.warnings.length, 1);
  assert.equal(report.errors.length, 0);
  assert(fs.existsSync(path.join(report.outputDirectory, "modbus_reg_map_slave.c")));
});

test("comparison reports definition and generated-code changes, and preflights the comparison before writing", t => {
  const directory = temporary(t), before = path.join(directory, "before.html"), after = path.join(directory, "after.html");
  fs.writeFileSync(before, fixture());
  fs.writeFileSync(after, fixture(d => {d.project.registers[0].default = "2";}));
  const report = checkHtml(after, {compare: before});
  assert.deepEqual(report.comparison.definitionChanges, [{op: "replace", path: "/registers/0/valueDomain/default", before: 0, after: 2}]);
  assert(report.comparison.changedFiles.includes("modbus_reg_map_slave.c"));
  fs.writeFileSync(after, fixture(d => {d.project.enums[0].label = "New label";}));
  const labels = checkHtml(after, {compare: before});
  assert.deepEqual(labels.comparison.changedFiles, []);
  assert.equal(labels.comparison.definitionChanges[0].path, "/enums/0/label");
  fs.writeFileSync(before, "invalid HTML");
  const {status} = run(directory, ["after.html", "--compare", "before.html", "--out-dir", "generated"]);
  assert.equal(status, 1);
  assert(!fs.existsSync(path.join(directory, "generated")));
});

test("definition diff preserves array indices and escapes JSON Pointer field names", () => {
  assert.deepEqual(definitionDiff({"a/b": [1, 2], "~": false}, {"a/b": [3], "new": 4}), [
    {op: "replace", path: "/a~1b/0", before: 1, after: 3},
    {op: "remove", path: "/a~1b/1", before: 2},
    {op: "remove", path: "/~0", before: false},
    {op: "add", path: "/new", after: 4}
  ]);
});

test("the embedded guide opens and closes through the actual editor handlers", () => {
  assert(original.includes('id="open-ai-guide" aria-haspopup="dialog" aria-controls="ai-guide"'));
  assert(original.includes('id="ai-guide" aria-labelledby="ai-guide-title"'));
  assert(original.includes("tools/check-html.cjs product.html --compare before.html"));
  const source = [...original.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)]
    .find(match => !match[1].includes("application/json"))[2];
  const start = source.indexOf('$("open-ai-guide").addEventListener(');
  const end = source.indexOf("initializeHtmlSave();", start);
  assert(start >= 0 && end > start);
  let open, close;
  const dialog = {open: false, showModal() {this.open = true;}, close() {this.open = false;}};
  const button = {addEventListener: (_event, callback) => {close = callback;}, closest: () => dialog};
  const context = vm.createContext({HTMLDialogElement: class {},
    $: id => id === "ai-guide" ? dialog : {addEventListener: (_event, callback) => {open = callback;}},
    document: {querySelectorAll: () => [button]}});
  vm.runInContext(source.slice(start, end), context);
  open(); assert.equal(dialog.open, true);
  close(); assert.equal(dialog.open, false);
});
