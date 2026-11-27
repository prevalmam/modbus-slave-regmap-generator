"use strict";
const assert = require("node:assert/strict");
const vm = require("node:vm");

function definition(source, name) {
  const match = new RegExp("(?:^|\\n)(?:static\\s+)?(?:void|int|uint16_t|const reg_table_entry_t \\*)\\s*" +
    name + "\\([^;{]*\\)\\s*\\{", "m").exec(source);
  assert.ok(match, "Missing emitted C function: " + name);
  let end = match.index + match[0].length, depth = 1;
  while (depth) {
    if (source[end] === "{") depth++;
    else if (source[end] === "}") depth--;
    end++;
  }
  return source.slice(match.index, end);
}

function adapt(source, name, parameters) {
  return definition(source, name)
    .replace(/^[\s\S]*?\)\s*\{/, "function " + name + "(" + parameters + ") {")
    .replace(/uint8_t tx_buf\[256\];/, "let tx_buf = new Uint8Array(256);")
    .replace(/uint16_t cursor;/, "let cursor = {value: 0};")
    .replace(/\bcursor = (0U|first_index);/g, "cursor.value = $1;")
    .replace(/&cursor\b/g, "cursor")
    .replace(/\*cursor\b/g, "cursor.value")
    .replace(/\(cursor - 1U\)/g, "(cursor.value - 1U)")
    .replace(/union \{ float f; uint32_t u; \} u32f;/, "let u32f = {};")
    .replace(/memcpy\(&v, &src\[j \* 2\], sizeof\(v\)\);/g, "v = littleEndian(src, j * 2, 2);")
    .replace(/memcpy\(&v, &src\[j \* 4\], sizeof\(v\)\);/g, "v = littleEndian(src, j * 4, 4);")
    .replace(/memcpy\(&u32f\.f, &src\[j \* 4\], sizeof\(float\)\);/g, "u32f.u = littleEndian(src, j * 4, 4);")
    .replace(/\(const reg_table_entry_t \*\)0/g, "null")
    .replace(/\(const uint8_t \*\)/g, "")
    .replace(/&g_reg_table_slave\[/g, "g_reg_table_slave[")
    .replace(/p = &tx_buf\[0\];/g, "p = 0;")
    .replace(/\*p\+\+/g, "tx_buf[p++]")
    .replace(/p - tx_buf/g, "p")
    .replace(/\b(?:const )?(?:uint(?:8|16|32)_t|reg_table_entry_t|int)\s*\*?\s*(\w+)(\s*=\s*[^;]+)?;/g, "let $1$2;")
    .replace(/->/g, ".")
    .replace(/\(uint16_t\)\(([^()]*)\)/g, "(($1) & 65535)")
    .replace(/\(uint(?:8|16|32)_t\)/g, "")
    .replace(/\(void\)/g, "")
    .replace(/\b(0x[\da-f]+|\d+)(?:UL|U)\b/gi, "$1");
}

const constants = {
  ACCESS_READ: 0, ACCESS_WRITE: 1, ACCESS_READWRITE: 2, ACCESS_INTERNAL: 3,
  REG_TYPE_UINT16: 0, REG_TYPE_UINT16_ARRAY: 1, REG_TYPE_UINT32: 2,
  REG_TYPE_UINT32_ARRAY: 3, REG_TYPE_FLOAT: 4, REG_TYPE_FLOAT_ARRAY: 5,
  REG_TYPE_STRING: 6, REG_TYPE_RESERVED: 99, MODBUS_REG_SIZE_BYTES: 2
};

// Run the emitted lookup, range walk, serialization and CRC together. Adapt only
// C declarations, casts and byte/pointer operations; keep control flow intact.
function readRuntime(source, entries) {
  const sent = [], selected = [];
  let lookupVisits = 0;
  const table = entries.map(entry => new Proxy(entry, {get(target, key) {
    if (key === "modbus_addr") lookupVisits++;
    if (key === "ram_ptr") selected.push(target.name);
    return target[key];
  }}));
  const context = vm.createContext({
    ...constants, Uint8Array,
    g_reg_table_slave: table, g_reg_table_slave_size: table.length,
    littleEndian(src, offset, size) {
      assert.ok(offset >= 0 && offset + size <= src.length, "RAM read bounds");
      let value = 0;
      for (let i = 0; i < size; i++) value += src[offset + i] * 2 ** (8 * i);
      return value;
    },
    ModbusPort_RequestSend(data, length) {
      assert.ok(length <= data.length, "Response buffer bounds");
      sent.push(Array.from(data.slice(0, length)));
    }
  });
  for (const [name, args] of [
    ["find_read_entry_at_address", "address, end_addr, cursor"],
    ["modbus_append_crc", "frame, len_without_crc"],
    ["modbus_send_frame", "slave_addr, frame, length"],
    ["handle_modbus_read", "slave_addr, start_addr, num_regs"]
  ]) vm.runInContext(adapt(source, name, args), context);
  return {sent, selected,
    visits() { return lookupVisits; },
    read(address, start, quantity) {
      sent.length = 0; selected.length = 0;
      lookupVisits = 0;
      return context.handle_modbus_read(address, start, quantity);
    },
    select(start, quantity) {
      return this.read(1, start, quantity) === 0 ? [...selected] : -1;
    }
  };
}

module.exports = {constants, definition, readRuntime};
