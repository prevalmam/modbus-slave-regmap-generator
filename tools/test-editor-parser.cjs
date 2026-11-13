"use strict";
const assert = require("node:assert/strict");
const {test} = require("node:test");
const vm = require("node:vm");
const core = require("./editor-core.cjs");
const inspection = core.inspectProject(core.sampleProject());
assert.equal(inspection.errors.length, 0);
const parser = core.generateModbusFiles(inspection.validated)["modbus_parser.c"];

function definition(name) {
  const match = new RegExp("(?:^|\\n)(?:static\\s+)?(?:void|int|uint16_t)\\s+" + name + "\\([^;{]*\\)\\s*\\{", "m").exec(parser);
  assert.ok(match, "Missing C function: " + name);
  let end = match.index + match[0].length, depth = 1;
  while (depth) {
    if (parser[end] === "{") depth++;
    else if (parser[end] === "}") depth--;
    end++;
  }
  return parser.slice(match.index, end);
}

// Execute the emitted algorithms in JS after adapting C declarations/casts.
// C89 syntax and target-specific types are checked separately with Clang.
function expressions(c) {
  return c.replace(/\(const uint8_t\s*\*\)0/g, "null")
    .replace(/->/g, ".")
    .replace(/\(uint(?:8|16|32)_t\)/g, "")
    .replace(/sizeof\(frame\)/g, "frame.length")
    .replace(/\b(0x[\da-f]+|\d+)(?:UL|U)\b/gi, "$1");
}
function jsFunction(name, parameters) {
  return expressions(definition(name)
    .replace(/^[\s\S]*?\)\s*\{/, "function " + name + "(" + parameters + ") {")
    .replace(/\buint8_t\s+(\w+)\[(\d+)\];/g, "let $1 = new Uint8Array($2);")
    .replace(/\b(?:uint(?:8|16|32)_t|int)\s+(\w+)(\s*=\s*[^;]+)?;/g, "let $1$2;"));
}

const decoded = definition("decode_entry_after_value");
const floatCase = decoded.slice(decoded.indexOf("case REG_TYPE_FLOAT:"), decoded.indexOf("case REG_TYPE_STRING:"));
const floatLoop = floatCase.slice(floatCase.indexOf("for ("));
const decodeFloat = new Function("data", "min_float", "max_float", "dst_float", `
  const entry = {length: min_float.length};
  const view = new DataView(new ArrayBuffer(4));
  const conv = {u32: 0, get f() { view.setUint32(0, this.u32, false); return view.getFloat32(0, false); }};
  let i;
  ${expressions(floatLoop)}
`);
const bytes = bits => [bits >>> 24, (bits >>> 16) & 255, (bits >>> 8) & 255, bits & 255];
function bits(value) {
  const v = new DataView(new ArrayBuffer(4));
  v.setFloat32(0, value, false);
  return v.getUint32(0, false);
}
function decode(values) {
  return decodeFloat(values.flatMap(bytes), values.map(() => -100), values.map(() => 100), new Float32Array(values.length));
}

test("generated float decoder accepts finite bounds and normal values", () => {
  for (const value of [-100, -1, 0, 1, 100]) assert.equal(decode([bits(value)]), 0);
  assert.equal(decode([-100, 0, 100].map(bits)), 0);
});
test("generated float decoder rejects positive, negative and signaling NaN encodings", () => {
  for (const value of [0x7fc00000, 0xffc00000, 0x7f800001, 0xff800001, 0x7fffffff]) {
    assert.equal(decode([value]), -1, value.toString(16));
  }
});
test("generated float-array decoder rejects NaN in every element position", () => {
  for (let i = 0; i < 3; i++) {
    const values = [bits(-1), bits(0), bits(1)];
    values[i] = 0x7fc00000;
    assert.equal(decode(values), -1);
  }
});
test("generated float decoder retains range and infinity rejection", () => {
  for (const value of [-101, 101, -Infinity, Infinity]) assert.equal(decode([bits(value)]), -1);
});

const sent = [];
const echo = vm.runInNewContext(
  jsFunction("modbus_append_crc", "frame, len_without_crc") + "\n" +
  jsFunction("modbus_send_frame", "slave_addr, frame, length") + "\n" +
  jsFunction("modbus_send_echo_response", "slave_addr, rx_buf, len") +
  "\n({append: modbus_append_crc, reply: modbus_send_echo_response});",
  {Uint8Array, MODBUS_MIN_FRAME_LENGTH: 8, ModbusPort_RequestSend(frame, length) { sent.push(Array.from(frame.slice(0, length))); }});
function frame(length, addr = 1) {
  const data = Uint8Array.from({length}, (_, i) => i & 255);
  data.set([addr, 8, 0, 0]);
  assert.equal(echo.append(data, length - 2), length);
  return data;
}
test("emitted CRC helper matches the known Modbus CRC check vector", () => {
  const data = new Uint8Array(11);
  data.set(Buffer.from("123456789"));
  assert.equal(echo.append(data, 9), 11);
  assert.deepEqual(Array.from(data.slice(9)), [0x37, 0x4b]);
});
test("diagnostic echo preserves frame length and data including at buffer boundaries", () => {
  for (const length of [8, 12, 254, 256]) {
    sent.length = 0;
    const data = frame(length);
    echo.reply(data[0], data, length);
    assert.deepEqual(sent, [Array.from(data)]);
  }
});
test("diagnostic echo recalculates CRC when the response slave address changes", () => {
  sent.length = 0;
  const input = frame(8), expected = input.slice();
  expected[0] = 7;
  echo.append(expected, expected.length - 2);
  echo.reply(7, input, input.length);
  assert.deepEqual(sent, [Array.from(expected)]);
  assert.equal(input[0], 1);
});
test("diagnostic echo stays silent for broadcast address 0", () => {
  sent.length = 0;
  const data = frame(8, 0);
  echo.reply(0, data, data.length);
  assert.deepEqual(sent, []);
});
test("diagnostic echo rejects null, short and oversized frames", () => {
  sent.length = 0;
  echo.reply(1, null, 8);
  for (let length = 0; length < 8; length++) echo.reply(1, new Uint8Array(length), length);
  echo.reply(1, new Uint8Array(257), 257);
  assert.deepEqual(sent, []);
});

const parseDefinition = definition("modbus_parse_and_reply");
const maxFrameLength = /^#define MODBUS_MAX_FRAME_LENGTH\s+\((\d+)U\)$/m.exec(parser);
assert.ok(maxFrameLength, "Missing private parser frame limit");
assert.equal(Number(maxFrameLength[1]), 256);
assert.doesNotMatch(core.generateModbusFiles(inspection.validated)["modbus_parser.h"], /MODBUS_MAX_FRAME_LENGTH/);
const validationPrefix = expressions(parseDefinition.slice(
  parseDefinition.indexOf("{") + 1, parseDefinition.indexOf("if (valid_frame != 0)")))
  .replace(/\bfunction\b/g, "function_code")
  .replace(/const uint8_t\s*\*data\s*=\s*null;/g, "let data = null;")
  .replace(/\b(?:uint(?:8|16|32)_t|int)\s+(\w+)(\s*=\s*[^;]+)?;/g, "let $1$2;");
function addressGate(accept, crcResult = 1) {
  const calls = {addresses: [], crc: 0, exceptions: []};
  const events = [];
  const parse = new Function("rx_buf", "len", "modbus_user_accept_slave_address",
    "modbus_validate_crc", "modbus_send_exception_response",
    "MODBUS_MIN_FRAME_LENGTH", "MODBUS_MAX_FRAME_LENGTH", "MODBUS_EXC_ILLEGAL_DATA_VALUE",
    validationPrefix + "\nreturn valid_frame;");
  return {
    calls,
    events,
    parse(data, length) {
      return parse(data, length,
        address => { calls.addresses.push(address); events.push(["address", address]); return accept(address); },
        (_data, len) => { calls.crc++; events.push(["crc", len]); return crcResult; },
        (...args) => { calls.exceptions.push(args); events.push(["exception", ...args]); }, 8, Number(maxFrameLength[1]), 3);
    }
  };
}

test("parser rejects null, short and oversized frames before reading data or calling the address hook", () => {
  const gate = addressGate(() => 1);
  for (const length of [0, 7, 8, 256, 257]) assert.equal(gate.parse(null, length), 0);
  for (let n = 0; n < 8; n++) gate.parse(new Uint8Array(n), n);
  const unreadable = new Proxy({}, {get() { throw Error("Rejected input must not be read"); }});
  for (const length of [7, 257, 65535]) assert.equal(gate.parse(unreadable, length), 0);
  assert.deepEqual(gate.calls, {addresses: [], crc: 0, exceptions: []});
  assert.deepEqual(gate.events, []);
});

test("parser accepts lengths 8 and 256 with the address hook preceding CRC", () => {
  for (const length of [8, 256]) {
    const gate = addressGate(() => 1);
    assert.equal(gate.parse(frame(length, 7), length), 1);
    assert.deepEqual(gate.calls, {addresses: [7], crc: 1, exceptions: []});
    assert.deepEqual(gate.events, [["address", 7], ["crc", length]]);
  }
});

test("rejected addresses stop before CRC validation and exception responses", () => {
  const gate = addressGate(address => address === 1 ? 1 : 0, 0);
  for (const address of [0, 2, 241, 255]) {
    const data = frame(8, address), before = data.slice();
    assert.equal(gate.parse(data, data.length), undefined);
    assert.deepEqual(data, before);
  }
  assert.deepEqual(gate.calls, {addresses: [0, 2, 241, 255], crc: 0, exceptions: []});
  assert.deepEqual(gate.events, [0, 2, 241, 255].map(address => ["address", address]));
});

test("accepted addresses use the hook once; CRC errors are discarded without a response", () => {
  const gate = addressGate(() => 255);
  assert.equal(gate.parse(frame(8, 7), 8), 1);
  assert.deepEqual(gate.calls, {addresses: [7], crc: 1, exceptions: []});
  for (const length of [8, 256]) {
    const invalid = addressGate(() => 1, 0);
    assert.equal(invalid.parse(frame(length, 7), length), 0);
    assert.deepEqual(invalid.calls, {addresses: [7], crc: 1, exceptions: []});
    assert.deepEqual(invalid.events, [["address", 7], ["crc", length]]);
  }
});

test("address policy changes take effect on the next request without registration", () => {
  let currentAddress = 1;
  const gate = addressGate(address => address === currentAddress ? 1 : 0);
  assert.equal(gate.parse(frame(8, 1), 8), 1);
  currentAddress = 2;
  assert.equal(gate.parse(frame(8, 1), 8), undefined);
  assert.equal(gate.parse(frame(8, 2), 8), 1);
  assert.deepEqual(gate.calls, {addresses: [1, 1, 2], crc: 2, exceptions: []});
});
