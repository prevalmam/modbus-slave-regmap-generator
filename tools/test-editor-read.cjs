"use strict";
const assert = require("node:assert/strict");
const {test} = require("node:test");
const core = require("./editor-core.cjs");
const {constants: C, definition, readRuntime} = require("./read-test-support.cjs");

function fixture(rows, reorder = table => table) {
  const project = core.sampleProject();
  project.registers = rows;
  const inspection = core.inspectProject(project);
  assert.equal(inspection.errors.length, 0, JSON.stringify(inspection.errors));
  const source = core.generateModbusFiles(inspection.validated)["modbus_parser.c"];
  const table = core.generatorEntries(inspection.validated).map(entry => {
    const ram = new Uint8Array(entry.bytes), view = new DataView(ram.buffer);
    for (let i = 0; i < entry.count; i++) {
      if (entry.type === "uint16_t") view.setUint16(i * 2, entry.default, true);
      else if (entry.type === "uint32_t") view.setUint32(i * 4, entry.default, true);
      else if (entry.type === "float") view.setFloat32(i * 4, entry.default, true);
    }
    if (entry.type === "string") ram.set(Buffer.from(entry.default, "ascii"));
    return {name: entry.name, modbus_addr: entry.address, size: entry.bytes, length: entry.count,
      access: entry.internal ? C.ACCESS_INTERNAL : {RO: C.ACCESS_READ, WO: C.ACCESS_WRITE,
        RW: C.ACCESS_READWRITE, "-": C.ACCESS_READ}[entry.access],
      type: C[entry.enumType], ram_ptr: ram};
  });
  return {...readRuntime(source, reorder(table)), source, table};
}
const row = (address, name, options = {}) => core.draftRow({
  address, name, access: "RO", nvmOffset: "-", default: 0x1234, ...options
});
function crc(data) {
  let value = 0xffff;
  for (const byte of data) {
    value ^= byte;
    for (let i = 0; i < 8; i++) value = value & 1 ? (value >>> 1) ^ 0xa001 : value >>> 1;
  }
  return [value & 255, value >>> 8];
}
function response(address, data) {
  const bytes = [address, 3, data.length, ...data];
  return [...bytes, ...crc(bytes)];
}

test("read walks shuffled definitions in address order and preserves bytes and CRC", () => {
  const f = fixture([row(12, "third", {default: 0x9abc}), row(10, "first"),
    row(11, "second", {default: 0x5678, access: "RW"})], table => table.reverse());
  assert.equal(f.read(7, 10, 3), 0);
  assert.deepEqual(f.selected, ["first", "second", "third"]);
  assert.deepEqual(f.sent, [response(7, [0x12, 0x34, 0x56, 0x78, 0x9a, 0xbc])]);
});

test("read retains scalar, array, float, string and reserved encodings", () => {
  const f = fixture([
    row(0, "word"), row(1, "words", {length: 2, default: 0xabcd}),
    row(3, "dword", {type: "uint32_t", default: 0x89abcdef, max: 4294967295}),
    row(5, "dwords", {type: "uint32_t", length: 2, default: 0x12345678, max: 4294967295}),
    row(9, "real", {type: "float", default: 1.5}),
    row(11, "reals", {type: "float", length: 2, default: -2.5, min: -100}),
    row(15, "text", {type: "string", length: 6, default: "ABCD"}),
    row(18, "reserved", {type: "reserved", length: 2, access: "-", min: "-", max: "-", default: "-"})
  ]);
  assert.equal(f.read(1, 0, 20), 0);
  assert.deepEqual(f.sent, [response(1, [
    0x12, 0x34, 0xab, 0xcd, 0xab, 0xcd, 0x89, 0xab, 0xcd, 0xef,
    0x12, 0x34, 0x56, 0x78, 0x12, 0x34, 0x56, 0x78,
    0x3f, 0xc0, 0, 0, 0xc0, 0x20, 0, 0, 0xc0, 0x20, 0, 0,
    65, 66, 67, 68, 0, 0, 0, 0, 0, 0
  ])]);
});

test("a gap or unreadable field rejects the full range before accessing RAM", () => {
  for (const middle of [[], [row(1, "write_only", {access: "WO"})],
    [row("-", "private", {access: "-"})]]) {
    const f = fixture([row(0, "first"), ...middle, row(2, "last")]);
    assert.equal(f.read(1, 0, 3), -1);
    assert.deepEqual(f.selected, []);
    assert.deepEqual(f.sent, []);
  }
});

test("partial scalar, array and string fields retain rejection", () => {
  for (const options of [{type: "uint32_t"}, {type: "float"},
    {length: 3}, {type: "string", length: 6, default: "AB"}]) {
    const f = fixture([row(10, "field", options)]);
    assert.equal(f.read(1, 10, 1), -1);
    assert.equal(f.read(1, 11, 1), -1);
    assert.deepEqual(f.selected, []);
    assert.deepEqual(f.sent, []);
  }
});

test("read supports the 125-register response boundary without a pointer list", () => {
  const f = fixture(Array.from({length: 125}, (_, i) => row(100 + i, "word_" + i, {default: i})));
  const expected = Array.from({length: 125}, (_, i) => [0, i]).flat();
  assert.equal(f.read(1, 100, 125), 0);
  assert.equal(f.sent[0].length, 255);
  assert.deepEqual(f.sent, [response(1, expected)]);
  assert.ok(f.visits() <= 250, "Contiguous read must not restart table search per field");
  assert.equal(f.read(1, 224, 1), 0);
  assert.deepEqual(f.sent, [response(1, [0, 124])]);
  assert.ok(f.visits() <= 126, "Serialization must reuse the validated first field position");
});

test("read cursor wraps repeatedly for a descending table and resets for each pass and request", () => {
  const f = fixture(Array.from({length: 8}, (_, i) => row(10 + i, "word_" + i, {default: i})),
    table => table.sort((a, b) => b.modbus_addr - a.modbus_addr));
  for (const [start, quantity] of [[10, 8], [13, 4], [10, 8]]) {
    assert.equal(f.read(1, start, quantity), 0);
    assert.deepEqual(f.selected, Array.from({length: quantity}, (_, i) => "word_" + (start - 10 + i)));
    assert.deepEqual(f.sent, [response(1, Array.from({length: quantity}, (_, i) => [0, start - 10 + i]).flat())]);
  }
});

test("response-boundary arrays and a complete field at address 65535 retain support", () => {
  const f = fixture([row(0, "large", {length: 125}), row(65535, "last")]);
  assert.equal(f.read(1, 0, 125), 0);
  assert.deepEqual(f.sent, [response(1, Array.from({length: 125}, () => [0x12, 0x34]).flat())]);
  assert.equal(f.read(1, 65535, 1), 0);
  assert.deepEqual(f.sent, [response(1, [0x12, 0x34])]);
});

test("broadcast reads remain silent and consecutive reads use current RAM", () => {
  const f = fixture([row(0, "word")]);
  assert.equal(f.read(0, 0, 1), 0);
  assert.deepEqual(f.sent, []);
  f.table[0].ram_ptr.set([0xef, 0xbe]);
  assert.equal(f.read(1, 0, 1), 0);
  assert.deepEqual(f.sent, [response(1, [0xbe, 0xef])]);
});

test("read removes the pointer list and sorter while keeping its transmit buffer local", () => {
  const {source} = fixture([row(0, "word")]);
  assert.doesNotMatch(source, /MAX_MATCHED_ENTRIES|sort_entries_by_address|\bmatched\[/);
  assert.match(definition(source, "handle_modbus_read"), /uint8_t tx_buf\[256\];/);
  assert.doesNotMatch(definition(source, "find_read_entry_at_address"),
    /^\s*(?:const\s+)?(?:uint\d+_t|reg_table_entry_t)\s+\*?\w+\[/m);
});
