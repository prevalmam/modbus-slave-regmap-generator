"use strict";
const assert = require("node:assert/strict");
const {test} = require("node:test");
const core = require("./editor-core.cjs");
const plain = value => JSON.parse(JSON.stringify(value));
function draft() { return core.sampleProject(); }
function generate(p) {
 const result = core.inspectProject(p);
 assert.equal(result.errors.length, 0, JSON.stringify(result.errors));
 return {files: core.generateModbusFiles(result.validated), doc: result.validated.documentValue};
}
test("current schema roundtrip retains definitions and multiple memberships", () => {
 const p = draft();
 p.resetGroupDefs.push({id: "factory", label: "Factory"});
 p.registers[0].resetGroups = ["settings", "factory"];
 const {doc} = generate(p);
 assert.equal(doc.schemaVersion, 5);
 const {doc: again} = generate(core.decodeProject(plain(doc)).project);
 assert.deepEqual(plain(again), plain(doc));
});
for (const version of [1, 2, 3]) test("legacy JSON " + version + " has no reset groups", () => {
 const {doc} = generate(draft());
 doc.schemaVersion = version;
 delete doc.resetGroupDefs;
 for (const row of doc.registers) delete row.resetGroups;
 if (version < 3) {
  // Earlier formats used min/max/default instead of valueDomain.
  for (const row of doc.registers) {
   if (row.valueDomain?.kind === "range") Object.assign(row, row.valueDomain);
   else Object.assign(row, {min: "-", max: "-", default: row.valueDomain?.default ?? "-"});
   delete row.valueDomain;
  }
  delete doc.enums;
 }
 const p = core.decodeProject(plain(doc)).project;
 assert.deepEqual(plain(p.resetGroupDefs), []);
 assert.ok(p.registers.every(row => row.resetGroups.length === 0));
});
test("invalid group definitions, references and reserved membership reject export", () => {
 const mutations = [p => p.resetGroupDefs.push({...p.resetGroupDefs[0]}),
 p => p.resetGroupDefs[0].id = "count", p => p.resetGroupDefs[0].id = "Bad-ID",
 p => p.resetGroupDefs[0].label = "", p => p.registers[0].resetGroups = ["missing"],
 p => p.registers[0].resetGroups = ["settings", "settings"],
 p => {p.registers[0].type = "reserved"; p.registers[0].resetGroups = ["settings"];}];
 for (const mutate of mutations) { const p = draft(); mutate(p); assert.equal(core.inspectProject(p).validated, null); }
});
test("read-only and RAM-only entries can belong to reset groups", () => {
 const p = draft(); const row = p.registers[0];
 row.access = "RO"; row.nvmOffset = "-"; row.resetGroups = ["settings"];
 const {files} = generate(p);
 assert.ok(files["modbus_reg_nvm_slave.c"].includes("MODBUS_IDX_" + row.name));
});
test("NVM APIs reserve their identifiers", () => {
 for (const name of ["modbus_reg_nvm_restore", "MODBUS_RESET_GROUP_SETTINGS", "modbus_reset_result_t"]) {
  const p = draft(); p.registers[0].name = name; assert.equal(core.inspectProject(p).validated, null);
 }
});
test("reset and capture expose the agreed flag and ownership contract", () => {
 const {files} = generate(draft()); const c = files["modbus_reg_nvm_slave.c"];
 assert.match(c, /default:\s*return MODBUS_RESET_INVALID_GROUP/);
 assert.match(c, /modbus_reg_nvm_mark_dirty\(\);\s*return MODBUS_RESET_OK/);
 assert.ok(c.indexOf("capacity <") < c.indexOf("s_nvm_dirty == 0U"));
 assert.match(c, /memset\(dst, 0xFF, \(uint16_t\)NVM_TOTAL_SIZE\)/);
 assert.match(c, /s_nvm_dirty = 0U;\s*return MODBUS_NVM_CAPTURE_CAPTURED/);
 assert.match(c, /s_nvm_dirty = repaired/);
 assert.ok(!/uint8_t\s+\w+\[NVM_TOTAL_SIZE\]/.test(c));
 for (const text of Object.values(files)) { assert.ok(text.endsWith("\n")); assert.ok(!text.includes("\r")); assert.ok(!text.includes("NVM_Request_Write_Bytes")); }
});
test("atomic parser marks dirty only after complete validation and application", () => {
 const {files} = generate(draft()); const c = files["modbus_parser.c"];
 const start = c.lastIndexOf("static int handle_modbus_multi_write(");
 const body = c.slice(start);
 assert.ok(body.indexOf("modbus_reg_nvm_mark_dirty();") > body.lastIndexOf("memcpy(entry->ram_ptr"));
 assert.match(body, /nvm_changed = 1U/);
 assert.equal((body.match(/modbus_reg_nvm_mark_dirty\(\)/g) || []).length, 1);
});
test("string, scalar, array, notify and guard outputs retain their contracts", () => {
 const p = draft();
 p.registers[0].access = "RW";
 p.registers[0].updateNotify = true;
 p.registers[0].busyReject = true;
 p.registers[0].writeCheck = true;
 p.registers[0].groupValidate = "PAIR";
 const {files} = generate(p);
 const access = files["modbus_reg_access_slave.c"], parser = files["modbus_parser.c"];
 assert.match(access, /write_nvm_if_used/);
 assert.match(files["modbus_reg_map_slave.c"], /modbus_string_field_is_valid/);
 assert.match(files["modbus_reg_write_guard_slave.h"], /const char \*data/);
 assert.ok(parser.indexOf("modbus_send_write_multi_ack(") < parser.indexOf("modbus_reg_update_notify_master_write("));
 assert.match(parser, /modbus_write_guard_entry_is_busy/);
 assert.match(parser, /modbus_user_group_validate_pair/);
});
