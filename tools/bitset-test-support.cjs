"use strict";
const vm = require("node:vm");

function functionBody(source, name) {
  const match = source.match(new RegExp("(?:static )?[A-Za-z_][A-Za-z0-9_]* " + name + "\\(([^)]*)\\)\\n\\{"));
  if (!match) throw Error("Missing emitted C function: " + name);
  const start = match.index + match[0].length;
  let depth = 1, end = start;
  while (depth && end < source.length) {
    if (source[end] === "{") depth++;
    if (source[end] === "}") depth--;
    end++;
  }
  return {parameters:match[1], body:source.slice(start,end - 1)};
}

// Execute the emitted bit algorithms with declarations/casts adapted to JS.
// The private scalar RAM/NVM setter and notification boundary are mocked.
function loadBitsetApi(files, register, bitsetId, width) {
  const source = files["modbus_reg_access_slave.c"];
  const header = files["modbus_reg_bits_slave.h"];
  const state = {raw:0, attempts:0, dirty:0, notifications:0, reject:false};
  const context = vm.createContext({MODBUS_BIT_OFF:0, MODBUS_BIT_ON:1,
    ["MODBUS_IDX_" + register]:0,
    ["get_" + register]:()=>state.raw,
    ["reg_slave_set_uint" + width]:(_index, value)=>{
      state.attempts++;
      if(state.reject)return 0;
      value=width===16 ? value&65535 : value>>>0;
      if(value!==state.raw){state.raw=value;state.dirty++;}
      return 1;
    },
    modbus_reg_update_notify_internal_set:()=>{state.notifications++;}
  });
  for(const [,name,expression] of header.matchAll(/^#define (\w+_MASK) (.+)$/gm)) {
    vm.runInContext("var "+name+" = "+expression.replace(/(\d+)(?:UL|U)\b/g,"$1")+";",context);
  }
  const bits = [...header.matchAll(new RegExp("#define " + bitsetId.toUpperCase() + "_(\\w+)_MASK", "g"))].map(m=>m[1].toLowerCase());
  const names = ["apply_"+register+"_bits_raw", "get_"+register+"_bits", "set_"+register+"_bits", "clear_"+register+"_all",
    ...bits.flatMap(bit=>["get_"+register+"_"+bit,"set_"+register+"_"+bit])];
  for(const name of names) {
    const c=functionBody(source,name);
    const parameters=c.parameters==="void" ? "" : c.parameters.split(",").map(p=>p.trim().split(/\s+/).at(-1)).join(",");
    const body=c.body.replace(/\b\w+_bits_t bits;/g,"let bits = {};")
      .replace(/\b(?:uint16_t|uint32_t) (\w+);/g,"let $1;")
      .replace(/\((?:uint16_t|uint32_t)\)/g,"").replace(/(\d+)(?:UL|U)\b/g,"$1");
    vm.runInContext("function "+name+"("+parameters+") {"+body+"}",context);
  }
  return {api:context,state,bits};
}

module.exports={loadBitsetApi,functionBody};
