"use strict";
const assert=require("node:assert/strict"),{test}=require("node:test"),core=require("./editor-core.cjs");
function generate(project=core.sampleProject()) {
 const result=core.inspectProject(project);assert.equal(result.errors.length,0,JSON.stringify(result.errors));
 return core.generateModbusFiles(result.validated);
}
function headerClosure(files,name,seen=new Set()) {
 if(seen.has(name))return "";
 seen.add(name);const text=files[name];assert.equal(typeof text,"string","missing include "+name);
 return text+"\n"+[...text.matchAll(/^#include "([^"]+)"/gm)].map(m=>headerClosure(files,m[1],seen)).join("\n");
}
test("normal accessor headers expose enum types and typed APIs without codec or wire-validator declarations",()=>{
 const files=generate(),types=files["modbus_reg_enums_slave.h"];
 assert.match(types,/typedef enum/);assert.match(types,/MODBUS_PARITY_ODD = 1/);
 assert.doesNotMatch(types,/#include|_from_register|_to_register|wire_value_is_valid/);
 const closure=headerClosure(files,"modbus_reg_access_slave.h");
 assert.match(closure,/int get_ModbusParityBit\(modbus_parity_t \*out_value\)/);
 assert.match(closure,/int set_ModbusParityBit\(modbus_parity_t value\)/);
 assert.doesNotMatch(closure,/_from_register|_to_register|wire_value_is_valid|enum_codec|enum_internal/);
 for(const name of Object.keys(files).filter(name=>name.endsWith(".h")&&!name.endsWith("_internal_slave.h")&&!name.endsWith("_internal.h")))
  assert.doesNotMatch(headerClosure(files,name),/_from_register|_to_register|wire_value_is_valid|enum_codec|enum_internal/);
});
test("one internal header declares conversions and validation with its direct type dependencies",()=>{
 const files=generate(),internal=files["modbus_reg_enum_internal_slave.h"];
 assert.ok(!Object.hasOwn(files,"modbus_reg_enum_codec_slave.h"));
 assert.match(internal,/^#include <stdint.h>$/m);assert.match(internal,/^#include "modbus_reg_enums_slave.h"$/m);
 assert.match(internal,/int modbus_parity_from_register\(uint16_t raw, modbus_parity_t \*out_value\);/);
 assert.match(internal,/int modbus_parity_to_register\(modbus_parity_t value, uint16_t \*out_raw\);/);
 assert.match(internal,/int modbus_reg_enum_wire_value_is_valid\(uint16_t table_index, uint16_t raw\);/);
 for(const [name,text] of Object.entries(files)) {
  assert.doesNotMatch(text,/modbus_reg_enum_codec_slave\.h/,name);
  if(name.endsWith(".h")&&name!=="modbus_reg_enum_internal_slave.h")
   assert.doesNotMatch(text,/_from_register|_to_register|wire_value_is_valid/,name);
 }
});
test("generated implementations directly include the enum headers they use",()=>{
 const files=generate();
 for(const name of ["modbus_reg_access_slave.c","modbus_reg_nvm_slave.c","modbus_parser.c","modbus_reg_enums_slave.c"])
  assert.equal((files[name].match(/^#include "modbus_reg_enum_internal_slave.h"$/gm)||[]).length,1,name);
});
test("unused enum definitions keep internal conversions and projects without enums keep their outputs",()=>{
 const p=core.sampleProject();for(const row of p.registers)row.enumDomain=null;
 const unused=generate(p);assert.match(unused["modbus_reg_enum_internal_slave.h"],/modbus_parity_from_register/);
 assert.ok(!Object.hasOwn(unused,"modbus_reg_enum_codec_slave.h"));
 assert.doesNotMatch(unused["modbus_reg_enum_internal_slave.h"],/wire_value_is_valid/);
 assert.match(unused["modbus_reg_enums_slave.c"],/^#include "modbus_reg_enum_internal_slave.h"$/m);
 assert.doesNotMatch(headerClosure(unused,"modbus_reg_access_slave.h"),/_from_register|_to_register|enum_internal/);
 p.enums=[];const plain=generate(p);
 assert.ok(!Object.hasOwn(plain,"modbus_reg_enum_codec_slave.h"));assert.ok(!Object.hasOwn(plain,"modbus_reg_enum_internal_slave.h"));
});
