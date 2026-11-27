"use strict";
const {test} = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const {spawnSync} = require("node:child_process");
const root = path.join(__dirname, "..");
const original = fs.readFileSync(path.join(root, "modbus-regmap-editor.html"), "utf8");
const license = fs.readFileSync(path.join(root, "LICENSE"), "utf8").replace(/\r\n?/g, "\n");
const script = [...original.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)]
  .find(match => !match[1].includes("application/json"))[2];
const draftSlot = /(<script id="html-project-data" type="application\/json">)([^<]*)(<\/script>)/;
const licenseSlot = /<pre id="license-text" lang="en">([\s\S]*?)<\/pre>/;
const escaped = text => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

test("standalone HTML contains the complete unchanged LICENSE and accessible dialog controls", () => {
  assert.equal(original.match(licenseSlot)[1], escaped(license));
  assert(original.includes('id="open-license" aria-haspopup="dialog" aria-controls="license-dialog"'));
  assert(original.includes('id="license-dialog" aria-labelledby="license-title"'));
  assert(!original.includes("<!-- @license-text -->"));
});

test("HTML rebuilding embeds LICENSE safely and preserves the saved definition on repeated builds", t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "regmap-license-"));
  t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
  for (const name of ["tools", "src/editor", "build/editor"]) fs.mkdirSync(path.join(directory, name), {recursive: true});
  for (const name of ["tools/build-editor.mjs", "src/editor/editor.template.html", "LICENSE", "modbus-regmap-editor.html"]) {
    fs.copyFileSync(path.join(root, name), path.join(directory, name));
  }
  fs.writeFileSync(path.join(directory, "build/editor/editor.js"), script);
  const rebuild = () => spawnSync(process.execPath, ["tools/build-editor.mjs"], {cwd: directory, encoding: "utf8"});
  for (let count = 0; count < 2; count++) {
    const result = rebuild(); assert.equal(result.status, 0, result.stderr);
    const html = fs.readFileSync(path.join(directory, "modbus-regmap-editor.html"), "utf8");
    assert.equal(html.match(licenseSlot)[1], escaped(license));
    assert.equal(html.match(draftSlot)[2], original.match(draftSlot)[2]);
  }
  const special = license + "\n<&> $& </pre><script>\n";
  fs.writeFileSync(path.join(directory, "LICENSE"), special);
  assert.equal(rebuild().status, 0);
  assert.equal(fs.readFileSync(path.join(directory, "modbus-regmap-editor.html"), "utf8").match(licenseSlot)[1], escaped(special));
});

test("the actual HTML save handler retains the full license while updating embedded data", async () => {
  let disk = original;
  const embedded = {textContent: original.match(draftSlot)[2]};
  const saved = JSON.parse(embedded.textContent);
  saved.project.registers[0].summary = "edited";
  const draft = JSON.stringify(saved);
  const handle = {name: "saved.html", getFile: async () => ({text: async () => disk}),
    createWritable: async () => ({write: async text => {disk = text;}, close: async () => {}, abort: async () => {}})};
  const context = vm.createContext({DOMException, htmlSaving: false, htmlDirty: true,
    htmlFileHandle: undefined, lastWrittenHtml: undefined, savedHtmlDraft: "",
    embeddedHtmlDraft: embedded,
    htmlTemplate: {get outerHTML() {return original.replace(/^<!doctype html>\s*/i, "")
      .replace(draftSlot, (_, open, _data, close) => open + embedded.textContent + close);}},
    window: {showSaveFilePicker: async () => handle}, chooseHtmlFile: async () => handle,
    currentHtmlDraft: () => draft, refreshHtmlSaveState: () => {}, htmlSaveMessage: () => {}});
  const start = script.indexOf("async function saveEditorHtml(");
  const end = script.indexOf("function requestProjectReplacement(", start);
  assert(start >= 0 && end > start);
  vm.runInContext(script.slice(start, end), context);
  assert.equal(await context.saveEditorHtml(), true);
  assert.equal(disk.match(licenseSlot)[1], escaped(license));
  assert.equal(JSON.parse(disk.match(draftSlot)[2]).project.registers[0].summary, "edited");
});
