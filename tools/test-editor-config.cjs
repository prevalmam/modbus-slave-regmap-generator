"use strict";
const {test} = require("node:test");
const assert = require("node:assert/strict");
const core = require("./editor-core.cjs");
const plain = value => JSON.parse(JSON.stringify(value));

test("configuration contains only NVM size and emits no fixed slave address", () => {
  const result = core.inspectProject(core.sampleProject());
  assert.equal(result.errors.length, 0);
  const document = plain(result.validated.documentValue);
  assert.equal(document.schemaVersion, 7);
  assert.deepEqual(document.config, {nvmSize: 256});
  assert.deepEqual(plain(core.decodeProject(document).project.config), {nvmSize: "256"});
  const files = core.generateModbusFiles(result.validated);
  assert.doesNotMatch(files["modbus_reg_idx_slave.h"], /MODBUS_SLAVE_ADDR/);
  assert.match(files["modbus_parser.c"], /modbus_user_accept_slave_address\(rx_buf\[0\]\)/);
});

test("unknown configuration fields are rejected rather than silently retained", () => {
  for (const key of ["slaveAddress", "unknown"]) {
    const project = core.sampleProject();
    const document = plain(core.inspectProject(project).validated.documentValue);
    document.config[key] = 247;
    assert.throws(() => core.decodeProject(document));
    project.config[key] = "247";
    assert.equal(core.inspectProject(project).validated, null);
  }
});

test("RegisterTable import requests only the product's NVM size", () => {
  const imported = core.decodeProject({source: {sheet: "RegisterTable"}, rows: []});
  assert.deepEqual(plain(imported.project.config), {nvmSize: ""});
});
