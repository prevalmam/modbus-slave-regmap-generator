"use strict";

// Exercise the shipped HTML's model and generator without a browser DOM.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {test} = require("node:test");
const vm = require("node:vm");

const html = fs.readFileSync(path.join(__dirname, "../modbus-regmap-editor.html"), "utf8");
assert.ok(!html.includes("\r"), "The shipped HTML must use LF consistently");
const scripts = [...html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/gi)]
  .filter(match => !/type="application\/json"/i.test(match[1])).map(match => match[2]);
assert.equal(scripts.length, 1);
const script = scripts[0];
new vm.Script(script); // Check the entire bundle, including the UI code.
const boundary = script.indexOf("const editorTabs =");
assert.ok(boundary > 0, "The pure model/generator prefix must exist");
const context = vm.createContext({});
vm.runInContext(script.slice(0, boundary), context);

function row(type, count, offset = 0, name = "value", address = 1) {
  return context.draftRow({address, name, type, length: count, nvmOffset: offset,
    ...(type === "string" ? {default: "ABC"} : {})});
}

function project(registers, lengthDefs = []) {
  return {config: {slaveAddress: "1", nvmSize: "256"}, lengthDefs, enums: [], registers};
}

function maximum(draft, expected) {
  const inspection = context.inspectProject(draft);
  assert.equal(inspection.errors.length, 0, JSON.stringify(inspection.errors));
  const files = context.generateModbusFiles(inspection.validated);
  const header = files["modbus_reg_map_slave.h"];
  const matches = [...header.matchAll(/^#define NVM_MAX_ENTRY_SIZE_BYTES \((\d+)U\)$/gm)];
  assert.equal(matches.length, 1);
  assert.equal(Number(matches[0][1]), expected);
  assert.ok(header.indexOf("#define NVM_OFFSET_UNUSED") < matches[0].index);
  assert.ok(matches[0].index < header.indexOf("#endif"));
  assert.ok(!header.includes("@NVM_MAX_ENTRY_SIZE_BYTES@"));
  return files;
}

for (const [type, bytes] of [["uint16_t", 2], ["uint32_t", 4], ["float", 4]]) {
  test(type + " scalar and array sizes are bytes", () => {
    maximum(project([row(type, 1)]), bytes);
    maximum(project([row(type, 3)]), bytes * 3);
  });
}

test("strings use the fixed field length without an extra terminator", () => {
  maximum(project([row("string", 12)]), 12);
});

test("length macros are resolved for arrays and strings", () => {
  for (const [type, bytes] of [["uint16_t", 12], ["string", 6]]) {
    maximum(project([row(type, "VALUE_COUNT")], [{name: "VALUE_COUNT", length: "6"}]), bytes);
  }
});

test("larger RAM-only and reserved entries do not increase the maximum", () => {
  maximum(project([
    row("uint16_t", 1), row("string", 12, 16, "largest", 10),
    row("float", 2, 32, "middle", 30), row("uint32_t", 20, "-", "ram_only", 100),
    row("reserved", 50, "-", "reserved_area", 200)
  ]), 12);
});

test("no NVM entries emit zero; an empty table stays an invalid UI input", () => {
  maximum(project([row("uint32_t", 20, "-"), row("reserved", 50, "-", "reserved_area", 100)]), 0);
  assert.equal(context.inspectProject(project([])).validated, null);
  const files = context.generateRegisterMap({config: {nvmSize: 256}, lengthDefs: []}, []);
  assert.match(files["modbus_reg_map_slave.h"], /^#define NVM_MAX_ENTRY_SIZE_BYTES \(0U\)$/m);
});

test("enum registers contribute their uint16 wire size", () => {
  const draft = project([row("uint16_t", 1)]);
  draft.enums = [{id: "mode", label: "Mode", members: [{id: "off", value: 0, label: "Off"}]}];
  draft.registers[0].enumDomain = {kind: "enum", enumId: "mode", defaultMemberId: "off"};
  const files = maximum(draft, 2);
  assert.ok(files["modbus_reg_enums_slave.h"]);
});

test("the generated macro cannot be reused as a variable or length macro", () => {
  const name = "NVM_MAX_ENTRY_SIZE_BYTES";
  for (const draft of [project([row("uint16_t", 1, 0, name)]),
    project([row("uint16_t", name)], [{name, length: "1"}])]) {
    const inspection = context.inspectProject(draft);
    assert.equal(inspection.validated, null);
    assert.ok(inspection.errors.some(error => error.text.includes(name)));
  }
});

test("enum members cannot collide with the generated macro", () => {
  const draft = project([]);
  draft.enums = [{id: "nvm_max_entry", label: "Size", members: [{id: "size_bytes", value: 0, label: "Zero"}]}];
  const inspection = context.inspectProject(draft);
  assert.equal(inspection.validated, null);
  assert.ok(inspection.errors.some(error => error.text.includes("NVM_MAX_ENTRY_SIZE_BYTES")));
});
