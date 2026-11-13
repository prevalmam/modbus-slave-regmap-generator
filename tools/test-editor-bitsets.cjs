"use strict";
const assert=require("node:assert/strict"),{test}=require("node:test"),fs=require("node:fs"),path=require("node:path"),vm=require("node:vm");
const core=require("./editor-core.cjs"),{loadBitsetApi}=require("./bitset-test-support.cjs");
const plain=value=>JSON.parse(JSON.stringify(value));
function editorSource(){const html=fs.readFileSync(path.join(__dirname,"../modbus-regmap-editor.html"),"utf8");return {html,source:[...html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/gi)].find(m=>!m[1].includes("application/json"))[2]};}
function editorFunction(source,name){const start=source.indexOf("function "+name+"(");assert.ok(start>=0,name);let end=source.indexOf("{",start)+1,depth=1;while(depth){if(source[end]==="{")depth++;if(source[end]==="}")depth--;end++;}return source.slice(start,end);}
function draft() {
 const p=core.sampleProject();p.enums=[];
 p.bitsetDefs=[{id:"flags_16",label:"Flags 16",width:16,bits:[{bit:0,id:"low",label:"Low"},{bit:15,id:"high",label:"High"}]},
 {id:"flags_32",label:"Flags 32",width:32,bits:[{bit:0,id:"low",label:"Low"},{bit:31,id:"high",label:"High"}]}];
 p.registers=[{...core.draftRow({address:0,name:"Flags16",type:"uint16_t",nvmOffset:0,updateNotify:true}),bitsetDomain:{kind:"bitset",bitsetId:"flags_16",default:0}},
 {...core.draftRow({address:2,name:"Flags32",type:"uint32_t",max:4294967295,nvmOffset:4,updateNotify:true}),bitsetDomain:{kind:"bitset",bitsetId:"flags_32",default:0}}];
 return p;
}
function generate(p=draft()) {const result=core.inspectProject(p);assert.equal(result.errors.length,0,JSON.stringify(result.errors));return {doc:result.validated.documentValue,files:core.generateModbusFiles(result.validated)};}

test("schema 5 roundtrips bitsets and schema 4 preserves reset groups",()=>{
 const {doc}=generate();assert.equal(doc.schemaVersion,5);assert.deepEqual(plain(generate(core.decodeProject(plain(doc)).project).doc),plain(doc));
 const old=generate(core.sampleProject()).doc;old.schemaVersion=4;delete old.bitsetDefs;
 const loaded=core.decodeProject(plain(old)).project;assert.deepEqual(plain(loaded.bitsetDefs),[]);assert.deepEqual(plain(loaded.resetGroupDefs),plain(old.resetGroupDefs));
});
test("invalid widths, duplicate positions/names, fields, types and references are rejected",()=>{
 const changes=[p=>p.bitsetDefs[0].width=8,p=>p.bitsetDefs[0].bits[1].bit=16,p=>p.bitsetDefs[0].bits[0].bit=-1,
 p=>p.bitsetDefs[0].bits[0].bit=0.5,p=>p.bitsetDefs[0].bits[1].bit=0,p=>p.bitsetDefs[0].bits[1].id="low",
 p=>p.bitsetDefs[0].bits[0].id="int",p=>p.bitsetDefs[0].bits[0].id="bits",p=>p.bitsetDefs[0].bits[0].id="default",
 p=>p.bitsetDefs[0].bits=[],p=>p.bitsetDefs[0].bits[0].label="",p=>p.bitsetDefs.push({...p.bitsetDefs[0]}),
 p=>p.registers[0].type="float",p=>p.registers[0].type="uint32_t",p=>p.registers[0].length="2",
 p=>p.registers[0].bitsetDomain.bitsetId="missing",p=>p.registers[1].bitsetDomain.default=4294967296,
 p=>p.registers[1].bitsetDomain.default=-1,p=>p.registers[1].bitsetDomain.default=0.5,p=>p.registers[0].default="invalid",
 p=>p.registers.push(core.draftRow({address:20,name:"Flags16_low",nvmOffset:"-"}))];
 for(const change of changes){const p=draft();change(p);assert.equal(core.inspectProject(p).validated,null,change.toString());}
});
test("bit types and masks use ordinary structs and width-safe constants without raw setters",()=>{
 const {files}=generate(),h=files["modbus_reg_bits_slave.h"],api=files["modbus_reg_access_slave.h"];
 assert.match(h,/#define FLAGS_16_HIGH_MASK \(1U << 15\)/);assert.match(h,/#define FLAGS_32_HIGH_MASK \(1UL << 31\)/);
 assert.match(h,/modbus_bit_state_t low;/);assert.doesNotMatch(h,/\blow\s*:/);
 assert.match(api,/flags_32_bits_t get_Flags32_bits\(void\)/);assert.match(api,/int set_Flags32_bits\(flags_32_bits_t bits\)/);
 assert.doesNotMatch(api,/int set_Flags(?:16|32)\(/);assert.doesNotMatch(api,/int set_Flags(?:16|32)_masked\(/);
 assert.match(api,/uint32_t get_Flags32\(void\)/);assert.ok(!Object.hasOwn(files,"modbus_reg_bits_slave.c"));
 assert.ok(!h.includes("modbus_reg_access_slave.h"));
});
for(const width of [16,32])test("emitted "+width+" bit APIs preserve reserved bits, validate before commit and notify once",()=>{
 const {files}=generate(),name="Flags"+width,{api,state}=loadBitsetApi(files,name,"flags_"+width,width);
 state.raw=4;
 assert.equal(api["set_"+name+"_high"](1),1);assert.equal(state.raw,2**(width-1)+4);assert.equal(state.attempts,1);assert.equal(state.notifications,1);
 assert.equal(api["get_"+name+"_high"](),1);assert.equal(api["get_"+name+"_low"](),0);
 assert.deepEqual(plain(api["get_"+name+"_bits"]()),{low:0,high:1});
 for(const invalid of [-1,2,65535]){const before={...state};assert.equal(api["set_"+name+"_low"](invalid),0);assert.deepEqual(state,before);
  assert.equal(api["set_"+name+"_bits"]({low:1,high:invalid}),0);assert.deepEqual(state,before);}
 let before={...state};assert.equal(api["set_"+name+"_bits"]({low:1,high:0}),1);assert.equal(state.raw,5);assert.equal(state.attempts,before.attempts+1);assert.equal(state.notifications,before.notifications+1);
 before={...state};assert.equal(api["set_"+name+"_bits"]({low:1,high:0}),1);assert.equal(state.dirty,before.dirty);assert.equal(state.notifications,before.notifications+1);
 state.reject=true;before={...state};assert.equal(api["clear_"+name+"_all"](),0);assert.equal(state.raw,before.raw);assert.equal(state.notifications,before.notifications);
 state.reject=false;before={...state};assert.equal(api["clear_"+name+"_all"](),1);assert.equal(state.raw,0);assert.equal(state.notifications,before.notifications+1);
});
test("unnotified bit registers have no notification and unknown raw bits stay valid for RAM/NVM/parser",()=>{
 const p=draft();p.registers[1].updateNotify=false;p.registers[1].bitsetDomain.default=0xffffffff;
 const {files,doc}=generate(p);assert.equal(doc.registers[1].valueDomain.default,0xffffffff);
 const {api,state}=loadBitsetApi(files,"Flags32","flags_32",32);state.raw=0xffffffff;
 assert.equal(api.set_Flags32_low(0),1);assert.equal(state.raw,0xfffffffe);assert.equal(state.notifications,0);
 assert.match(files["modbus_reg_map_slave.c"],/max_Flags32\[1\] = \{4294967295UL\}/);
 assert.doesNotMatch(files["modbus_parser.c"],/FLAGS_32_(?:LOW|HIGH)_MASK/);
});

test("bitset detail uses numeric masks including bit 31 and refuses unsupported rows",()=>{
 const {html,source}=editorSource();
 assert.match(html,/id="bitset-tab"/);assert.match(html,/\.bitset-cell \{ white-space: nowrap;/);
 assert.match(html,/data-default-bit/);
 const c=vm.createContext({project:draft(),unsigned:core.unsigned});
 const take=name=>editorFunction(source,name);
 vm.runInContext([take("supportsBitset"),take("bitsetHex")].join("\n"),c);
 assert.equal(c.supportsBitset({type:"uint32_t",length:"1"}),true);assert.equal(c.supportsBitset({type:"uint16_t",length:"2"}),false);assert.equal(c.supportsBitset({type:"float",length:"1"}),false);
 assert.equal(c.bitsetHex(2**31,32),"0x80000000");assert.equal(c.bitsetHex(0xffffffff,32),"0xFFFFFFFF");
});

test("actual detail events synchronize hex and bit-31 checkbox while retaining reserved bits",()=>{
 const {source}=editorSource();
 class Input {constructor(){this.value="";this.dataset={};this.checked=false;this.events={};}addEventListener(name,fn){this.events[name]=fn;}}
 const field=new Input(),definition=new Input(),container=new Input();definition.value="flags_32";
 const p=draft(),row=p.registers[1];let edits=0;
 const c=vm.createContext({project:p,detailIndex:1,detailKind:{value:"bitset"},detailBitset:definition,detailBitsetHex:field,
  HTMLInputElement:Input,unsigned:core.unsigned,escapeHtml:value=>value,$:()=>container,recordEdit:()=>edits++});
 vm.runInContext(["bitsetHex","updateBitsetSelection","renderBitsetDefaultBits"].map(name=>editorFunction(source,name)).join("\n"),c);
 const start=source.indexOf('detailBitset.addEventListener("change"');const end=source.indexOf("const htmlTemplate",start);
 vm.runInContext(source.slice(start,end),c);
 field.value="0x80000004";field.events.input();assert.equal(row.bitsetDomain.default,0x80000004);assert.match(container.innerHTML,/data-default-bit="31" checked/);
 let checkbox=new Input();checkbox.dataset.defaultBit="31";checkbox.checked=false;container.events.input({target:checkbox});
 assert.equal(field.value,"0x00000004");assert.equal(row.bitsetDomain.default,4);
 checkbox.checked=true;container.events.input({target:checkbox});assert.equal(field.value,"0x80000004");
 field.value="0xFFFFFFFF";field.events.input();assert.equal(row.bitsetDomain.default,0xffffffff);
 assert.match(container.innerHTML,/data-default-bit="0" checked/);assert.match(container.innerHTML,/data-default-bit="31" checked/);
 checkbox.dataset.defaultBit="0";checkbox.checked=false;container.events.input({target:checkbox});assert.equal(field.value,"0xFFFFFFFE");
 field.value="invalid";field.events.input();assert.equal(core.inspectProject(p).validated,null);assert.equal(row.bitsetDomain.default,0xfffffffe);assert.ok(edits>=6);
});

test("HTML draft loader migrates old drafts and preserves unfinished bitset forms",()=>{
 const {source}=editorSource();
 const names=["isObject","isList","TEXT_FIELDS","FLAGS","decodeEnum","decodeBitset"];
 const c=vm.createContext(Object.fromEntries(names.map(name=>[name,vm.runInContext(name,core)])));
 vm.runInContext(editorFunction(source,"parseHtmlDraft"),c);
 const old={version:1,sourceName:"old.json",project:core.sampleProject(),enumForm:null};delete old.project.bitsetDefs;
 for(const row of old.project.registers)delete row.bitsetDomain;
 const migrated=c.parseHtmlDraft(JSON.stringify(old));assert.deepEqual(plain(migrated.project.bitsetDefs),[]);assert.ok(migrated.project.registers.every(row=>row.bitsetDomain===null));
 const current={version:1,sourceName:"bits.json",project:draft(),enumForm:null,bitsetForm:{index:null,id:"pending",label:"Pending",width:"32",bits:[{bit:"",id:"",label:""}]}};
 assert.deepEqual(plain(c.parseHtmlDraft(JSON.stringify(current)).bitsetForm),current.bitsetForm);
 current.bitsetForm.bits[0].bit=31;assert.throws(()=>c.parseHtmlDraft(JSON.stringify(current)));
});
