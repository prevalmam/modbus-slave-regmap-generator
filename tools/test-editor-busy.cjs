"use strict";
const assert = require("node:assert/strict");
const {test} = require("node:test");
const vm = require("node:vm");
const core = require("./editor-core.cjs");
const {functionBody} = require("./bitset-test-support.cjs");

function project() {
  const p = core.sampleProject();
  p.registers = ["first", "second", "plain"].map((name, index) => core.draftRow({
    address: index, name, type: "uint16_t", length: 1, access: "RW", nvmOffset: index * 2,
    busyReject: index < 2
  }));
  return p;
}
function files(p = project()) {
  const result = core.inspectProject(p);
  assert.equal(result.errors.length, 0, JSON.stringify(result.errors));
  return core.generateModbusFiles(result.validated);
}
function dispatch(f = files()) {
  const calls = [], values = [0, 0];
  const c = functionBody(f["modbus_reg_write_guard_slave.c"], "modbus_write_guard_entry_is_busy");
  const context = vm.createContext({MB_FALSE: 0, MODBUS_IDX_first: 0, MODBUS_IDX_second: 1,
    modbus_user_is_busy_first() { calls.push(0); return values[0]; },
    modbus_user_is_busy_second() { calls.push(1); return values[1]; }
  });
  vm.runInContext("function check(reg_table_index) {" + c.body + "}", context);
  return {check: context.check, calls, values};
}

test("busy flags emit required MB_BOOL callbacks without stored state, old accessors or defaults", () => {
  const f = files(), h = f["modbus_reg_write_guard_slave.h"], c = f["modbus_reg_write_guard_slave.c"];
  assert.match(h, /typedef uint8_t MB_BOOL;/);
  for (const name of ["first", "second"]) {
    assert.match(h, new RegExp("MB_BOOL modbus_user_is_busy_" + name + "\\(void\\);"));
    assert.match(c, new RegExp("case MODBUS_IDX_" + name + ":\\s+return modbus_user_is_busy_" + name + "\\(\\);"));
  }
  assert.doesNotMatch(h, /modbus_user_is_busy_plain/);
  for (const text of Object.values(f)) assert.doesNotMatch(text, /s_busy_reject_bits|modbus_get_busy_reject_|modbus_set_busy_reject_/);
  assert.doesNotMatch(c, /weak|__attribute__|MB_BOOL modbus_user_is_busy_/);
});

test("dispatch queries current user state once per call and unknown or unguarded entries stay idle", () => {
  const d = dispatch();
  assert.equal(d.check(0), 0);
  d.values[0] = 1; assert.equal(d.check(0), 1);
  d.values[0] = 255; assert.equal(d.check(0), 255);
  d.values[1] = 1; assert.equal(d.check(1), 1);
  assert.equal(d.check(2), 0); assert.equal(d.check(65535), 0);
  assert.deepEqual(d.calls, [0, 0, 0, 1]);
});

test("no busy flags emit no callbacks or hidden default state", () => {
  const p = project(); for (const row of p.registers) row.busyReject = false;
  const f = files(p), d = dispatch(f);
  assert.equal(d.check(0), 0); assert.equal(d.check(1), 0);
  assert.deepEqual(d.calls, []);
  assert.doesNotMatch(f["modbus_reg_write_guard_slave.h"], /modbus_user_is_busy_/);
  assert.doesNotMatch(f["modbus_reg_write_guard_slave.c"], /modbus_user_is_busy_|static|busy_reject/);
});

function preflight(f, d) {
  const body = functionBody(f["modbus_parser.c"], "handle_modbus_multi_write").body;
  const start = body.indexOf("    expected = start_addr;");
  const end = body.indexOf("    snapshot_initialize(&snapshot);");
  assert.ok(start >= 0 && end > start);
  let code = body.slice(start, end)
    .replace("entry = find_entry_at_address(expected, &table_index);", "[entry, table_index] = find_entry_at_address(expected);")
    .replace(/\(const reg_table_entry_t \*\)0/g, "null").replace(/->/g, ".")
    .replace(/\(uint(?:16|32)_t\)/g, "").replace(/(\d+)(?:UL|U)\b/g, "$1");
  const run = new Function("modbus_write_guard_entry_is_busy", "find_entry_at_address", "num_regs",
    "const start_addr = 0, end_addr = num_regs, end_addr32 = num_regs; let expected, entry, table_index, entry_regs;" +
    "const REG_TYPE_RESERVED = 99, ACCESS_READ = 0, MB_FALSE = 0, MODBUS_EXC_ILLEGAL_DATA_ADDRESS = 2, MODBUS_EXCEPTION_SLAVE_DEVICE_BUSY = 6;" +
    "const entry_register_count = entry => entry.count;" + code + "return 'preflight-passed';");
  return count => run(d.check, address => [{type: 0, access: 1, count: 1}, address], count);
}

test("all requested entries are preflighted before validation and RAM application with exception 06 on busy", () => {
  const f = files(), d = dispatch(), run = preflight(f, d);
  assert.equal(run(3), "preflight-passed"); assert.deepEqual(d.calls, [0, 1]);
  d.calls.length = 0; d.values[1] = 255;
  assert.equal(run(3), 6); assert.deepEqual(d.calls, [0, 1]);
  d.calls.length = 0; d.values[0] = 1;
  assert.equal(run(3), 6); assert.deepEqual(d.calls, [0]);
  const body = functionBody(f["modbus_parser.c"], "handle_modbus_multi_write").body;
  assert.ok(body.indexOf("modbus_write_guard_entry_is_busy(") < body.indexOf("snapshot_initialize("));
  assert.ok(body.indexOf("snapshot_initialize(") < body.indexOf("decode_entry_after_value("));
  assert.ok(body.indexOf("decode_entry_after_value(") < body.indexOf("run_user_write_check("));
  assert.ok(body.indexOf("run_user_write_check(") < body.indexOf("memcpy(entry->ram_ptr"));
  assert.match(f["modbus_parser.h"], /MODBUS_EXCEPTION_SLAVE_DEVICE_BUSY\s+\(0x06U\)/);
  assert.match(f["modbus_parser.c"], /status = handle_modbus_multi_write\(start_addr, 1U, data\);/);
});

test("busy callback symbols reject register, length, enum, bitset and group-type collisions", () => {
  const mutations = [
    p => { p.registers[2].name = "modbus_user_is_busy_first"; },
    p => { p.lengthDefs.push({name: "modbus_user_is_busy_first", length: "1"}); },
    p => { p.registers[0].name = "first_t"; p.enums[0].id = "modbus_user_is_busy_first"; },
    p => { p.registers[0].name = "first_from_register"; p.enums[0].id = "modbus_user_is_busy_first"; },
    p => { p.registers[0].name = "first_bits_t"; p.bitsetDefs = [{id: "modbus_user_is_busy_first", label: "Bits", width: 16, bits: [{bit: 0, id: "on", label: "On"}]}]; },
    p => { p.registers[0].name = "first_after_t"; p.registers[1].groupValidate = "user_is_busy_first"; }
  ];
  for (const mutate of mutations) {
    const p = project(); mutate(p);
    assert.equal(core.inspectProject(p).validated, null);
  }
  const p = project(); p.registers[0].busyReject = false; p.registers[2].name = "modbus_user_is_busy_first";
  files(p);
});
