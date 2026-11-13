"use strict";
const assert = require("node:assert/strict");
const {test} = require("node:test");
const core = require("./editor-core.cjs");

function fixture() {
  const p = core.sampleProject();
  p.registers = [
    core.draftRow({address: 0, name: "number", type: "uint16_t", length: 1, nvmOffset: 0}),
    core.draftRow({address: 1, name: "array", type: "uint32_t", length: 2, nvmOffset: 2}),
    core.draftRow({address: 5, name: "text", type: "string", length: 6, default: "ABC", nvmOffset: 10}),
    core.draftRow({address: 8, name: "mode", type: "uint16_t", length: 1, nvmOffset: 16})
  ];
  for (const row of p.registers) Object.assign(row, {access: "RW", writeCheck: true, groupValidate: "mixed"});
  p.registers[3].enumDomain = {kind: "enum", enumId: "modbus_parity", defaultMemberId: "none"};
  return p;
}

function files(p) {
  const result = core.inspectProject(p);
  assert.equal(result.errors.length, 0, JSON.stringify(result.errors));
  return core.generateModbusFiles(result.validated);
}

test("group callback payload owns scalar, array, string and enum values", () => {
  const f = files(fixture());
  const h = f["modbus_reg_write_guard_slave.h"];
  const c = f["modbus_parser.c"];
  const payload = h.match(/typedef struct\s*\{([^}]+)\} modbus_mixed_after_t;/)[1];
  assert.ok(!payload.includes("*"));
  assert.match(payload, /uint16_t number;/);
  assert.match(payload, /uint32_t array\[2U\];/);
  assert.match(payload, /char text\[6U\];/);
  assert.match(payload, /modbus_parity_t mode;/);
  assert.ok(!h.includes("modbus_reg_snapshot_t"));
  assert.match(c, /memcpy\(validation_copy.mixed.array, snapshot.array, sizeof\(validation_copy.mixed.array\)\)/);
  assert.match(c, /memcpy\(validation_copy.mixed.text, snapshot.text.data, sizeof\(validation_copy.mixed.text\)\)/);
  assert.match(c, /modbus_user_group_validate_mixed\(&validation_copy.mixed\)/);
  assert.match(c, /modbus_validation_copy_t validation_copy;/);
  assert.ok(!c.includes("modbus_user_group_validate_mixed(&snapshot)"));
});

test("individual string and array checks receive independent current and candidate copies", () => {
  const c = files(fixture())["modbus_parser.c"];
  assert.match(c, /char current_data\[6U\];\s*char new_data\[6U\];/);
  assert.match(c, /uint32_t current_value\[2U\];\s*uint32_t new_value\[2U\];/);
  assert.match(c, /memcpy\(new_data, after_value, sizeof\(new_data\)\)/);
  assert.match(c, /memcpy\(new_value, after_value, sizeof\(new_value\)\)/);
});

test("plain groups also reserve their public value-copy type name", () => {
  const p = fixture();
  p.registers[3].enumDomain = null;
  p.registers[0].name = "modbus_mixed_after_t";
  assert.equal(core.inspectProject(p).validated, null);
});

test("no validation groups leave the internal snapshot type private", () => {
  const p = fixture();
  for (const row of p.registers) row.groupValidate = "-";
  const f = files(p);
  assert.ok(!f["modbus_reg_write_guard_slave.h"].includes("modbus_reg_snapshot_t"));
  assert.match(f["modbus_parser.c"], /const uint8_t \*unused;/);
});

module.exports = {fixture};
