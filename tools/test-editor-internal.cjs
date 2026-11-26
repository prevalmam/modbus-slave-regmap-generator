"use strict";
const assert = require("node:assert/strict");
const {test} = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const core = require("./editor-core.cjs");
const plain = value => JSON.parse(JSON.stringify(value));

function fixture() {
  const p = core.sampleProject();
  p.enums = [];
  p.registers = [
    core.draftRow({address: "-", access: "-", name: "private_saved", min: 0, max: 9999, default: 123,
      nvmOffset: 0, updateNotify: true, resetGroups: ["settings"]}),
    core.draftRow({address: 0, name: "public_first", min: 0, max: 100, default: 7, nvmOffset: 2, updateNotify: true}),
    core.draftRow({address: "-", access: "-", name: "private_ram", min: 0, max: 9999, default: 456,
      nvmOffset: "-", updateNotify: true}),
    core.draftRow({address: 1, name: "public_second", min: 0, max: 100, default: 8, nvmOffset: 4})
  ];
  return p;
}
function generate(p = fixture()) {
  const result = core.inspectProject(p);
  assert.equal(result.errors.length, 0, JSON.stringify(result.errors));
  return {files: core.generateModbusFiles(result.validated), doc: plain(result.validated.documentValue), validated: result.validated};
}
function body(source, name) {
  const match = new RegExp("\\b" + name + "\\([^;{}]*\\)\\s*\\{").exec(source);
  assert.ok(match, name);
  let end = match.index + match[0].length, depth = 1;
  while (depth) {if (source[end] === "{") depth++; if (source[end] === "}") depth--; end++;}
  return source.slice(match.index + match[0].length, end - 1);
}
function expressions(c) {
  return c.replace(/\((?:const )?(?:void|reg_table_entry_t|uint8_t)\s*\*\)0/g, "null")
    .replace(/&g_reg_table_slave\[/g, "g_reg_table_slave[")
    .replace(/->/g, ".").replace(/\((?:uint(?:8|16|32)_t|int)\)/g, "")
    .replace(/\(void\)/g, "").replace(/\b(0x[\da-f]+|\d+)(?:UL|U)\b/gi, "$1");
}
function declarations(c) {
  return c.replace(/\b(?:const )?(?:uint(?:8|16|32)_t|reg_table_entry_t|modbus_\w+_t|int|void)\s*\*?\s*(\w+)(\s*=\s*[^;]+)?;/g, "let $1$2;");
}

// Execute emitted selection, transaction and persistence loops. Byte buffers,
// scratch allocation, value decoding and NVM value validation are mocked.
// Target C89 syntax and static analysis are checked separately.
function runtime(p = fixture()) {
  const {files, validated} = generate(p), parser = files["modbus_parser.c"];
  const entries = core.generatorEntries(validated);
  const bytes = n => Uint8Array.of(n & 255, n >> 8);
  const read16 = data => data[0] | data[1] << 8;
  const table = entries.map(entry => ({name: entry.name, modbus_addr: entry.address,
    access: entry.internal ? 3 : {RO: 0, WO: 1, RW: 2}[entry.access], type: 0, size: entry.bytes, length: entry.count,
    nvm_offset: entry.nvmOffset === "-" ? 256 : entry.nvmOffset,
    min_value: bytes(entry.min), max_value: bytes(entry.max), default_value: bytes(entry.default), ram_ptr: bytes(entry.default)}));
  const notifications = [], scratch = [];
  let scratchIndex = 0;
  const context = vm.createContext({
    g_reg_table_slave: table, g_reg_table_slave_size: table.length,
    ACCESS_READ: 0, ACCESS_WRITE: 1, ACCESS_READWRITE: 2, ACCESS_INTERNAL: 3,
    REG_TYPE_RESERVED: 99, MB_FALSE: 0, MODBUS_MAX_DATA_LENGTH: 250, MODBUS_REG_SIZE_BYTES: 2,
    MODBUS_EXC_ILLEGAL_DATA_VALUE: 3, MODBUS_EXC_ILLEGAL_DATA_ADDRESS: 2, MODBUS_EXC_SLAVE_DEVICE_FAILURE: 4,
    MODBUS_EXCEPTION_SLAVE_DEVICE_BUSY: 6, MODBUS_WRITE_OK: 0, MAX_MATCHED_ENTRIES: 125,
    NVM_TOTAL_SIZE: 256, NVM_OFFSET_UNUSED: 256,
    MODBUS_REG_UPDATE_SOURCE_MASTER_WRITE: 1, MODBUS_REG_UPDATE_SOURCE_INTERNAL_SET: 2,
    read_uint16: read16, read16, write16: (data, value) => data.set(bytes(value)),
    modbus_write_guard_entry_is_busy: () => 0,
    snapshot_initialize: () => {}, snapshot_set_after_pointer: () => {},
    run_user_write_check: () => 0, normalize_user_write_result: value => value,
    scratch_reset: () => {scratchIndex = 0;},
    scratch_allocate: entry => scratch[scratchIndex++] ??= new Uint8Array(entry.size),
    decode_entry_after_value: (entry, data, after) => {
      const value = data[0] << 8 | data[1];
      if (value < read16(entry.min_value) || value > read16(entry.max_value)) return -1;
      after.set(bytes(value)); return 0;
    },
    memcpy: (dst, src, size) => {dst.set(src.subarray(0, size)); return dst;},
    memset: (dst, value, size) => dst.fill(value, 0, size),
    memcmp: (a, b, size) => a.slice(0, size).some((v, i) => v !== b[i]) ? 1 : 0,
    sort_entries_by_address: list => list.sort((a, b) => a.modbus_addr - b.modbus_addr),
    nvm_entry_is_valid: entry => entry.nvm_offset !== 256 ? 1 : 0,
    nvm_data_is_valid: (entry, data) => read16(data) >= read16(entry.min_value) && read16(data) <= read16(entry.max_value) ? 1 : 0
  });
  entries.forEach((entry, i) => {
    context["MODBUS_IDX_" + entry.name] = i;
    context["modbus_user_" + entry.name + "_updated"] = source => notifications.push([entry.name, source]);
  });
  for (const [, block] of files["modbus_reg_nvm_slave.h"].matchAll(/typedef enum\s*\{([^}]+)\}/g)) {
    let value = 0;
    for (const member of block.split(",")) {
      const match = member.trim().match(/^(MODBUS_\w+)(?:\s*=\s*(\d+))?$/);
      if (match) {if (match[2]) value = Number(match[2]); context[match[1]] = value++;}
    }
  }
  let find = body(parser, "find_entry_at_address").replace("*table_index = i;", "")
    .replace("return &g_reg_table_slave[i];", "return [g_reg_table_slave[i], i];")
    .replace("return (const reg_table_entry_t *)0;", "return [null, 0];");
  vm.runInContext("function find_entry_at_address(address) {" + declarations(expressions(find)) + "}", context);
  vm.runInContext("function entry_register_count(entry) {" + expressions(body(parser, "entry_register_count")) + "}", context);
  const read = body(parser, "handle_modbus_read");
  const start = read.indexOf("for (i = 0U; i < g_reg_table_slave_size;");
  const end = read.lastIndexOf("for (i = 0U; i < match_count;", read.indexOf("src = (const uint8_t *)"));
  vm.runInContext("function select_read(start_addr, num_regs) {let i, entry, matched=[], match_count=0;" +
    "const end_addr=(start_addr+num_regs)&65535;" + declarations(expressions(read.slice(start, end))) +
    "return matched.slice(0,match_count).map(entry=>entry.name);}", context);
  let write = body(parser, "handle_modbus_multi_write")
    .replaceAll("entry = find_entry_at_address(expected, &table_index);", "[entry, table_index] = find_entry_at_address(expected);")
    .replaceAll("scratch_reset(&front, &back)", "scratch_reset()")
    .replaceAll("scratch_allocate(entry, &front, &back)", "scratch_allocate(entry)")
    .replace("entry_data = &data[(uint16_t)(expected - start_addr) * 2U];", "entry_data = data.subarray((expected-start_addr)*2);")
    .replace("snapshot_initialize(&snapshot)", "snapshot_initialize(snapshot)")
    .replace("snapshot_set_after_pointer(&snapshot,", "snapshot_set_after_pointer(snapshot,");
  vm.runInContext("function handle_modbus_multi_write(start_addr,num_regs,data) {" + declarations(expressions(write)) + "}", context);
  for (const name of ["modbus_reg_update_notify_master_write", "modbus_reg_update_notify_internal_set"]) {
    const args = name.endsWith("master_write") ? "start_addr,num_regs" : "table_index";
    vm.runInContext("function " + name + "(" + args + "){" + declarations(expressions(body(files["modbus_reg_update_notify_slave.c"], name))) + "}", context);
  }
  const nvm = files["modbus_reg_nvm_slave.c"];
  for (const [, name, values] of nvm.matchAll(/static const uint16_t (s_reset_group_\d+)\[\] = \{([^}]+)\};/g)) {
    context[name] = values.split(",").map(value => value.trim()).filter(Boolean).map(name => context[name]);
  }
  vm.runInContext("var s_nvm_dirty=0;", context);
  for (const [name, args] of [["modbus_reg_nvm_mark_dirty", ""], ["modbus_reg_load_defaults", ""],
    ["modbus_reg_reset_defaults", "group"],
    ["modbus_reg_nvm_capture_if_changed", "dst,capacity"], ["modbus_reg_nvm_restore", "src,size"]]) {
    let c = body(nvm, name).replaceAll("&g_reg_table_slave[i]", "g_reg_table_slave[i]")
      .replace("&dst[entry->nvm_offset]", "dst.subarray(entry->nvm_offset)")
      .replace("&src[entry->nvm_offset]", "src.subarray(entry->nvm_offset)")
      .replace(/sizeof\((s_reset_group_\d+)\) \/ sizeof\(\1\[0\]\)/g, "$1.length");
    vm.runInContext("function " + name + "(" + args + "){" + declarations(expressions(c)) + "}", context);
  }
  const access = files["modbus_reg_access_slave.c"];
  let setter = body(access, "reg_slave_set_uint16")
    .replaceAll("&g_reg_table_slave[table_index]", "g_reg_table_slave[table_index]")
    .replace("*((uint16_t *)entry->ram_ptr) = value;", "write16(entry.ram_ptr,value);")
    .replace(/\*\(\(const uint16_t \*\)(entry->\w+)\)/g, "read16($1)")
    .replace("sizeof(value)", "2");
  vm.runInContext("function reg_slave_set_uint16(table_index,value){" + declarations(expressions(setter)) + "}", context);
  context.write_nvm_if_used = offset => {if (offset !== 256) context.modbus_reg_nvm_mark_dirty();};
  for (const entry of entries.filter(entry => entry.internal)) {
    for (const prefix of ["get_", "set_"]) {
      const name = prefix + entry.name;
      vm.runInContext("function " + name + "(" + (prefix === "set_" ? "value" : "") + "){" +
        declarations(expressions(body(access, name))) + "}", context);
    }
  }
  return {context, table, notifications, read16, bytes};
}

test("addressless RAM and saved fields roundtrip with schema 6 and retain named APIs", () => {
  const {files, doc} = generate();
  assert.equal(doc.schemaVersion, 6);
  assert.equal(doc.registers[0].address, "-");
  assert.equal(doc.registers[0].access, "-");
  assert.deepEqual(generate(core.decodeProject(doc).project).doc, doc);
  assert.match(files["modbus_reg_access_slave.h"], /uint16_t get_private_saved\(void\);/);
  assert.match(files["modbus_reg_access_slave.h"], /int set_private_saved\(uint16_t value\);/);
  assert.match(files["modbus_reg_map_slave_internal.h"], /ACCESS_READWRITE,\s+ACCESS_INTERNAL/);
  assert.equal((files["modbus_reg_map_slave.c"].match(/ACCESS_INTERNAL/g) || []).length, 2);
  assert.match(files["modbus_reg_nvm_slave.c"], /MODBUS_IDX_private_saved/);
});

test("numeric arrays, strings, enums and bitsets also support addressless fields", () => {
  for (const [type, length, initial] of [["uint16_t", 3, 1], ["uint32_t", 1, 1], ["float", 1, 1.5], ["string", 8, "VALUE"]]) {
    const p = fixture();
    p.registers = [core.draftRow({name: "private_value", address: "-", access: "-", type, length, default: initial, nvmOffset: 0})];
    assert.equal(generate(p).doc.registers[0].address, "-");
  }
  const p = core.sampleProject();
  p.registers[2].address = "-"; p.registers[2].access = "-"; p.registers[2].writeCheck = false;
  assert.equal(generate(p).doc.registers[2].valueDomain.kind, "enum");
  p.bitsetDefs = [{id: "local_bits", label: "Local bits", width: 32, bits: [{bit: 31, id: "top", label: "Top"}]}];
  p.registers.push({...core.draftRow({name: "private_bits", address: "-", access: "-", type: "uint32_t", nvmOffset: "-"}),
    bitsetDomain: {kind: "bitset", bitsetId: "local_bits", default: 0x80000000}});
  assert.match(generate(p).files["modbus_reg_access_slave.h"], /set_private_bits_top/);
});

test("invalid addresses, reserved fields and contradictory communication settings are rejected", () => {
  for (const mutate of [
    p => {p.registers[0].address = "";}, p => {p.registers[0].address = "65536";},
    p => {p.registers[0].type = "reserved";}, p => {p.registers[0].access = "RW";},
    p => {p.registers[0].busyReject = true;}, p => {p.registers[0].writeCheck = true;},
    p => {p.registers[0].groupValidate = "pair";}, p => {p.registers[0].nvmOffset = "2";},
    p => {p.registers[0].name = "public_first";}, p => {p.registers[0].default = "10000";},
    p => {p.registers[0].name = "ACCESS_INTERNAL";},
    p => {p.lengthDefs.push({name: "ACCESS_INTERNAL", length: "2"});},
    p => {p.enums.push({id: "access", label: "Access", members: [{id: "internal", value: 0, label: "Internal"}]});}
  ]) {const p = fixture(); mutate(p); assert.equal(core.inspectProject(p).validated, null, mutate.toString());}
  const p = fixture(); p.registers[0].address = " - ";
  assert.equal(generate(p).doc.registers[0].address, "-");
  p.registers[3].address = "65535";
  assert.equal(generate(p).doc.registers[3].address, 65535);
});

test("internal entries never join single or range reads, including a real address zero", () => {
  const {context: c} = runtime();
  assert.deepEqual(plain(c.select_read(0, 1)), ["public_first"]);
  assert.deepEqual(plain(c.select_read(0, 2)), ["public_first", "public_second"]);
  assert.equal(c.select_read(0, 3), -1);
  assert.equal(c.select_read(2, 1), -1);
  assert.equal(c.find_entry_at_address(0)[0].name, "public_first");
  assert.equal(c.find_entry_at_address(2)[0], null);
  const p = fixture(); p.registers = p.registers.filter(row => row.address === "-");
  const internal = runtime(p).context;
  assert.equal(internal.select_read(0, 1), -1);
  assert.equal(internal.find_entry_at_address(0)[0], null);
});

test("single and multi writes reach only public RAM; an invalid range commits nothing", () => {
  const {context: c, table, read16} = runtime();
  assert.equal(c.handle_modbus_multi_write(0, 1, Uint8Array.of(0, 11)), 0);
  assert.equal(read16(table[1].ram_ptr), 11);
  assert.equal(c.handle_modbus_multi_write(0, 2, Uint8Array.of(0, 12, 0, 13)), 0);
  assert.equal(read16(table[1].ram_ptr), 12); assert.equal(read16(table[3].ram_ptr), 13);
  assert.equal(c.handle_modbus_multi_write(0, 3, Uint8Array.of(0, 20, 0, 21, 0, 22)), 2);
  assert.equal(read16(table[1].ram_ptr), 12); assert.equal(read16(table[3].ram_ptr), 13);
  assert.equal(read16(table[0].ram_ptr), 123); assert.equal(read16(table[2].ram_ptr), 456);
  const p = fixture(); p.registers = p.registers.filter(row => row.address === "-");
  assert.equal(runtime(p).context.handle_modbus_multi_write(0, 1, Uint8Array.of(0, 9)), 2);
});

test("internal setters keep range checks, RAM/NVM policy and internal-only notification", () => {
  const {context: c, notifications} = runtime();
  assert.equal(c.set_private_saved(9999), 1); assert.equal(c.get_private_saved(), 9999);
  assert.equal(c.set_private_saved(10000), 0); assert.equal(c.get_private_saved(), 9999);
  assert.deepEqual(notifications, [["private_saved", 2]]);
  notifications.length = 0;
  c.modbus_reg_update_notify_master_write(0, 125);
  assert.deepEqual(notifications, [["public_first", 1]]);
  c.set_private_ram(777); assert.equal(c.get_private_ram(), 777);
  assert.deepEqual(notifications.at(-1), ["private_ram", 2]);
  const image = new Uint8Array(256);
  assert.equal(c.modbus_reg_nvm_capture_if_changed(image, 256), c.MODBUS_NVM_CAPTURE_CAPTURED);
  assert.equal(image[0] | image[1] << 8, 9999);
  c.set_private_ram(888);
  assert.equal(c.modbus_reg_nvm_capture_if_changed(image, 256), c.MODBUS_NVM_CAPTURE_UNCHANGED);
  c.set_private_saved(25);
  assert.equal(c.modbus_reg_nvm_restore(image, 256), c.MODBUS_NVM_RESTORE_OK);
  assert.equal(c.get_private_saved(), 9999); assert.equal(c.get_private_ram(), 888);
  image[0] = 255; image[1] = 255;
  assert.equal(c.modbus_reg_nvm_restore(image, 256), c.MODBUS_NVM_RESTORE_REPAIRED);
  assert.equal(c.get_private_saved(), 123);
  c.set_private_saved(45);
  assert.equal(c.modbus_reg_reset_defaults(c.MODBUS_RESET_GROUP_SETTINGS), c.MODBUS_RESET_OK);
  assert.equal(c.get_private_saved(), 123); assert.equal(c.get_private_ram(), 888);
  c.modbus_reg_load_defaults(); assert.equal(c.get_private_ram(), 456);
});

test("the actual address input handler updates R/W and preserves input focus", () => {
  const html = fs.readFileSync(path.join(__dirname, "../modbus-regmap-editor.html"), "utf8");
  const script = [...html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/gi)].find(m => !m[1].includes("application/json"))[2];
  class Input {
    constructor() {this.dataset = {field: "address"}; this.selectionStart = 1; this.value = "-"; this.focused = false;}
    focus() {this.focused = true;}
    setSelectionRange(start, end) {this.selectionStart = start; this.selectionEnd = end;}
  }
  const input = new Input(), p = fixture(); p.registers = [p.registers[1]];
  let handler, renders = 0, edits = 0;
  const element = {addEventListener: (_event, callback) => {handler = callback;}, querySelector: () => input};
  const c = vm.createContext({project: p, TABLE_FIELDS: plain(vm.runInContext("TABLE_FIELDS", core)),
    ACCESS: ["RO", "RW", "WO"], UNUSED: "-", HTMLInputElement: Input, HTMLSelectElement: class {},
    isOneOf: core.isOneOf, rowIndex: () => 0, $: () => element,
    renderTable: () => renders++, recordEdit: () => edits++});
  const start = script.indexOf('$("register-body").addEventListener("input"');
  const end = script.indexOf('$("register-body").addEventListener("click"', start);
  vm.runInContext(script.slice(start, end), c);
  handler({target: input});
  assert.equal(p.registers[0].address, "-"); assert.equal(p.registers[0].access, "-");
  assert.equal(input.focused, true); assert.equal(input.selectionStart, 1);
  input.value = "12"; handler({target: input});
  assert.equal(p.registers[0].address, "12"); assert.equal(p.registers[0].access, "RO");
  assert.equal(renders, 2); assert.equal(edits, 2);
});

test("schema 5 public definitions remain importable and HTML saved drafts retain addressless fields", () => {
  const legacy = generate(core.sampleProject()).doc; legacy.schemaVersion = 5;
  assert.equal(generate(core.decodeProject(legacy).project).doc.schemaVersion, 6);
  const html = fs.readFileSync(path.join(__dirname, "../modbus-regmap-editor.html"), "utf8");
  const source = [...html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/gi)].find(m => !m[1].includes("application/json"))[2];
  const parse = source.slice(source.indexOf("function parseHtmlDraft("), source.indexOf("function currentHtmlDraft("));
  const c = vm.createContext({isObject: vm.runInContext("isObject", core), isList: Array.isArray, decodeEnum: core.decodeEnum,
    decodeBitset: core.decodeBitset, TEXT_FIELDS: plain(vm.runInContext("TEXT_FIELDS", core)), FLAGS: ["updateNotify", "busyReject", "writeCheck"]});
  vm.runInContext(parse, c);
  const draft = {version: 1, sourceName: "local.json", project: plain(fixture()), enumForm: null, bitsetForm: null};
  assert.deepEqual(plain(c.parseHtmlDraft(JSON.stringify(draft))), draft);
});

module.exports = {fixture, generate, runtime};
