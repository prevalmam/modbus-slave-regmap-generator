
/* Generate C90-compatible slave code from the validated JSON definition. */
type GeneratedFiles = Record<string, string>;
type GeneratorEntry = Omit<RegisterDefinition, "valueDomain"> & {
  min: number | Unused;
  max: number | Unused;
  default: number | string;
  definition?: RegisterEnum;
  bitsetDefinition?: BitsetDefinition;
  count: number;
  bytes: number;
  registerCount: number;
  array: boolean;
  enumType: string;
};
type NumericEntry = GeneratorEntry & {
  type: NumericType;
  min: number;
  max: number;
  default: number;
};

const C_ACCESS: Record<RegisterDefinition["access"], string> = {
  RO: "ACCESS_READ", WO: "ACCESS_WRITE", RW: "ACCESS_READWRITE", "-": "ACCESS_READ"
};
const C_TYPES: Record<RegisterType, string> = {
  uint16_t: "REG_TYPE_UINT16", uint32_t: "REG_TYPE_UINT32", float: "REG_TYPE_FLOAT",
  string: "REG_TYPE_STRING", reserved: "REG_TYPE_RESERVED"
};
const SCALAR_SUFFIX: Record<NumericType, string> = {uint16_t: "uint16", uint32_t: "uint32", float: "float"};
const indexMacro = (entry: GeneratorEntry) => "MODBUS_IDX_" + entry.name;
const tableEntry = (entry: GeneratorEntry) => "g_reg_table_slave[" + indexMacro(entry) + "]";
const isNumericEntry = (entry: GeneratorEntry): entry is NumericEntry =>
  isOneOf(NUMERIC_TYPES, entry.type) && typeof entry.min === "number" &&
  typeof entry.max === "number" && typeof entry.default === "number";
const hasGroup = (entry: GeneratorEntry) => entry.type !== "reserved" && entry.groupValidate !== UNUSED;
const hex = (value: number, width: number) => value.toString(16).toUpperCase().padStart(width, "0");

function generatorEntries(project: ValidatedProject): GeneratorEntry[] {
  const {lengthDefs, registers, enums, bitsetDefs} = project.documentValue;
  const lengths = new Map(lengthDefs.map(entry => [entry.name, entry.length]));
  const definitions = new Map(enums.map(definition => [definition.id, definition]));
  const bitsById = new Map(bitsetDefs.map(definition => [definition.id, definition]));
  return registers.map(row => {
    const count = typeof row.length === "number" ? row.length : lengths.get(row.length);
    if (count === undefined) throw Error("配列長定義が見つかりません。" + row.name);
    const bytes = TYPE_BYTES[row.type] * count;
    const array = isOneOf(NUMERIC_TYPES, row.type) && count > 1;
    const {valueDomain, ...fields} = row;
    let definition: RegisterEnum | undefined;
    let bitsetDefinition: BitsetDefinition | undefined;
    let values: Pick<GeneratorEntry, "min" | "max" | "default">;
    if (valueDomain.kind === "enum") {
      definition = definitions.get(valueDomain.enumId);
      const range = definition && enumRange(definition, valueDomain.defaultMemberId);
      if (!range) throw Error("列挙型または初期値が見つかりません。" + row.name);
      values = range;
    } else if (valueDomain.kind === "bitset") {
      bitsetDefinition = bitsById.get(valueDomain.bitsetId);
      if (!bitsetDefinition) throw Error("Missing bitset definition: " + row.name);
      values = {min: 0, max: bitsetDefinition.width === 32 ? 4294967295 : 65535, default: valueDomain.default};
    } else if (valueDomain.kind === "range") {
      values = {min: valueDomain.min, max: valueDomain.max, default: valueDomain.default};
    } else {
      values = {min: UNUSED, max: UNUSED, default: valueDomain.kind === "string" ? valueDomain.default : UNUSED};
    }
    return {...fields, ...values, definition, bitsetDefinition, groupValidate: row.groupValidate.toLowerCase(), count, bytes, array,
      registerCount: bytes / 2,
      enumType: C_TYPES[row.type] + (array ? "_ARRAY" : "")};
  });
}

function scalarLiteral(type: NumericType, value: number): string {
  if (type !== "float") return String(value) + (type === "uint32_t" ? "UL" : "U");
  if (Number.isInteger(value)) return BigInt(value).toString() + ".0f";
  // Python uses exponent notation below 1e-4 and pads the exponent to two digits.
  const text = Math.abs(value) < 0.0001 ? value.toExponential() : String(value);
  return text.replace(/e([+-])(\d)$/, (_, sign: string, digit: string) => "e" + sign + "0" + digit) + "f";
}

function stringInitializer(text: string, length: number): string {
  const bytes = Array.from(text, character => "0x" + hex(character.charCodeAt(0), 2));
  return "{" + bytes.concat(Array<string>(length - bytes.length).fill("0x00")).join(", ") + "}";
}

function generateRegisterIndex(entries: readonly GeneratorEntry[], slaveAddress: number): string {
  const definitions: string[] = [];
  entries.forEach((entry, index) => {
    const macro = indexMacro(entry);
    definitions.push(`#define ${macro}  (${index})`);
    if (entry.type !== "reserved" && entry.count > 1) {
      for (let i = 0; i < entry.count; i++) definitions.push(`#define ${macro}_${i}  (${i})`);
    }
  });
  return ["#ifndef MODBUS_REG_IDX_SLAVE_H", "#define MODBUS_REG_IDX_SLAVE_H", "",
    "#define MODBUS_SLAVE_ADDR " + slaveAddress, "", "/* Modbus register index definitions */",
    ...definitions, "", "#endif", ""].join("\n");
}

function generateRegisterMap(project: RegmapDocument, entries: readonly GeneratorEntry[]): GeneratedFiles {
  const lengthMacros = project.lengthDefs.map(({name,length}) => `#define ${name} (${length}U)\n`).join("");
  const maxEntrySize = entries.reduce((maximum, entry) =>
    entry.type !== "reserved" && entry.nvmOffset !== UNUSED ? Math.max(maximum, entry.bytes) : maximum, 0);
  const header = REGMAP_HEADER.replace("@NVM_SIZE@", String(project.config.nvmSize))
    .replace("@NVM_MAX_ENTRY_SIZE_BYTES@", String(maxEntrySize)).replace("@LENGTH_DEFS@", lengthMacros);
  const declarations: string[] = [];
  const tableRows: string[] = [];
  for (const entry of entries) {
    const {type, name, count} = entry;
    const offset = entry.nvmOffset === UNUSED ? "NVM_OFFSET_UNUSED" : "0x" + hex(entry.nvmOffset,4) + "U";
    let size, ram, defaults, minimum = "(const void *)0", maximum = minimum;
    if (type === "reserved") {
      size = entry.bytes + "U";
      ram = "(void *)0";
      defaults = "(const void *)0";
    } else if (type === "string" && typeof entry.default === "string") {
      size = "sizeof(char) * " + entry.length;
      ram = name;
      defaults = "default_" + name;
      const init = stringInitializer(entry.default, count);
      declarations.push(`static char ${name}[${count}] = ${init};`, `const char ${defaults}[${count}] = ${init};`);
    } else if (isNumericEntry(entry)) {
      size = "sizeof(" + type + ")" + (entry.array ? " * " + entry.length : "");
      ram = entry.array ? name : "&" + name;
      defaults = "default_" + name;
      minimum = "min_" + name;
      maximum = "max_" + name;
      const initArray = (value: number) => "{" + Array<string>(count).fill(scalarLiteral(entry.type, value)).join(", ") + "}";
      if (entry.array) declarations.push(`static ${type} ${name}[${count}] = ${initArray(entry.default)};`);
      else declarations.push(`static ${type} ${name} = ${scalarLiteral(entry.type,entry.default)};`);
      declarations.push(
        `const ${type} ${defaults}[${count}] = ${initArray(entry.default)};`,
        `const ${type} ${minimum}[${count}] = ${initArray(entry.min)};`,
        `const ${type} ${maximum}[${count}] = ${initArray(entry.max)};`
      );
    } else {
      throw Error("生成用の値と型が一致しません。" + name);
    }
    tableRows.push("    {", ...[entry.address, offset, size, defaults, minimum, maximum, ram,
      entry.enumType, count, C_ACCESS[entry.access]].map(value => "        " + value + ","), "    },");
  }
  return {
    "modbus_reg_map_slave.h": header,
    "modbus_reg_map_slave_internal.h": REGMAP_INTERNAL_HEADER,
    "modbus_reg_map_slave.c": ['#include "modbus_reg_map_slave_internal.h"', "", ...declarations, "",
      "const reg_table_entry_t g_reg_table_slave[] = {", ...tableRows, "};", "", REGMAP_FOOTER].join("\n")
  };
}


function fillC(template: string, bindings: Record<string, string | number>): string {
  return template.replace(/@([A-Z_]+)@/g, (_, key: string) => {
    if (!Object.hasOwn(bindings, key)) throw Error("Missing C template binding: " + key);
    return String(bindings[key]);
  });
}

function accessBindings(entry: GeneratorEntry) {
  const suffix = isOneOf(NUMERIC_TYPES, entry.type) ? SCALAR_SUFFIX[entry.type] : "";
  return {NAME: entry.name, BASE: entry.type, COUNT: entry.count, COUNT_PLUS_ONE: entry.count + 1,
    READ: "read_" + suffix, SET: "reg_slave_set_" + suffix,
    NOTIFY: entry.updateNotify ? `    modbus_reg_update_notify_internal_set(${indexMacro(entry)});\n` : ""};
}

const ENUM_INCLUDE = '#include "modbus_reg_enums_slave.h"';
const ENUM_INTERNAL_INCLUDE = '#include "modbus_reg_enum_internal_slave.h"';

function generateEnums(definitions: readonly RegisterEnum[], entries: readonly GeneratorEntry[]): GeneratedFiles {
  if (!definitions.length) return {};
  const assigned = entries.filter(entry => entry.definition);
  const header = ["#ifndef MODBUS_REG_ENUMS_SLAVE_H", "#define MODBUS_REG_ENUMS_SLAVE_H", ""];
  const internal = ["#ifndef MODBUS_REG_ENUM_INTERNAL_SLAVE_H", "#define MODBUS_REG_ENUM_INTERNAL_SLAVE_H", "",
    "#include <stdint.h>", ENUM_INCLUDE, ""];
  const source = [ENUM_INTERNAL_INCLUDE];
  if (assigned.length) source.push('#include "modbus_reg_idx_slave.h"');
  source.push("");
  for (const {id, members} of definitions) {
    const type = id + "_t";
    const constants = members.map((member, index) => "    " + enumMemberCName(id, member.id) + " = " + index);
    header.push("typedef enum", "{", constants.join(",\n"), "} " + type + ";", "");
    internal.push(
      `int ${id}_from_register(uint16_t raw, ${type} *out_value);`,
      `int ${id}_to_register(${type} value, uint16_t *out_raw);`, "");

    const table = "s_" + id + "_register_values";
    const values = members.map(member => member.value + "U");
    source.push(`static const uint16_t ${table}[${values.length}U] =
{
${values.map(value => "    " + value).join(",\n")}
};

int ${id}_from_register(uint16_t raw, ${type} *out_value)
{
    uint16_t index;

    if (out_value == (${type} *)0)
    {
        return 0;
    }
    for (index = 0U; index < ${values.length}U; ++index)
    {
        if (${table}[index] == raw)
        {
            *out_value = (${type})index;
            return 1;
        }
    }
    return 0;
}

int ${id}_to_register(${type} value, uint16_t *out_raw)
{
    unsigned long index;

    index = (unsigned long)value;
    if ((out_raw == (uint16_t *)0) || (index >= ${values.length}UL))
    {
        return 0;
    }
    *out_raw = ${table}[index];
    return 1;
}`, "");
  }
  if (assigned.length) {
    const check = "int modbus_reg_enum_wire_value_is_valid(uint16_t table_index, uint16_t raw)";
    internal.push(check + ";", "");
    source.push(check, "{", "    switch (table_index)", "    {");
    for (const entry of assigned) {
      const id = entry.definition!.id;
      source.push(`        case ${indexMacro(entry)}:
        {
            ${id}_t value;
            return ${id}_from_register(raw, &value);
        }`);
    }
    source.push("        default:", "            return 1;", "    }", "}", "");
  }
  header.push("#endif", "");
  internal.push("#endif", "");
  return {"modbus_reg_enums_slave.h": header.join("\n"),
    "modbus_reg_enum_internal_slave.h": internal.join("\n"), "modbus_reg_enums_slave.c": source.join("\n")};
}

function enumAccessSource(entry: GeneratorEntry, definition: RegisterEnum): string {
  const {name} = entry;
  const {id} = definition;
  const notify = entry.updateNotify ? `
    modbus_reg_update_notify_internal_set(${indexMacro(entry)});` : "";
  return `int get_${name}(${id}_t *out_value)
{
    return ${id}_from_register(read_uint16(${tableEntry(entry)}.ram_ptr),
                                 out_value);
}


int set_${name}(${id}_t value)
{
    uint16_t raw;

    if (${id}_to_register(value, &raw) == 0)
    {
        return 0;
    }
    if (reg_slave_set_uint16(${indexMacro(entry)}, raw) == 0)
    {
        return 0;
    }${notify}
    return 1;
}
`;
}

function generateBitsetTypes(definitions: readonly BitsetDefinition[]): GeneratedFiles {
  if (!definitions.length) return {};
  const header = ["#ifndef MODBUS_REG_BITS_SLAVE_H", "#define MODBUS_REG_BITS_SLAVE_H", "", "#include <stdint.h>", "",
    "typedef enum", "{", "    MODBUS_BIT_OFF = 0,", "    MODBUS_BIT_ON = 1", "} modbus_bit_state_t;", ""];
  for (const definition of definitions) {
    for (const bit of definition.bits) {
      header.push(`#define ${bitMaskName(definition, bit)} (1${definition.width === 32 ? "UL" : "U"} << ${bit.bit})`);
    }
    header.push("", "typedef struct", "{", ...definition.bits.map(bit => `    modbus_bit_state_t ${bit.id};`),
      `} ${definition.id}_bits_t;`, "");
  }
  header.push("#endif", "");
  return {"modbus_reg_bits_slave.h": header.join("\n")};
}

function bitsetAccess(entry: GeneratorEntry, definition: BitsetDefinition): {header: string; source: string} {
  const {name, type} = entry;
  const bitsType = definition.id + "_bits_t";
  const raw = `read_${SCALAR_SUFFIX[type as "uint16_t" | "uint32_t"]}(${tableEntry(entry)}.ram_ptr)`;
  const set = `reg_slave_set_${SCALAR_SUFFIX[type as "uint16_t" | "uint32_t"]}`;
  const notify = entry.updateNotify ? `\n    modbus_reg_update_notify_internal_set(${indexMacro(entry)});` : "";
  const header = [`${type} get_${name}(void);`, `${type} get_${name}_default(void);`,
    `${bitsType} get_${name}_bits(void);`, `int set_${name}_bits(${bitsType} bits);`, `int clear_${name}_all(void);`];
  const source = [`${type} get_${name}(void)
{
    return ${raw};
}

${type} get_${name}_default(void)
{
    return *(const ${type} *)${tableEntry(entry)}.default_value;
}

static int apply_${name}_bits_raw(${type} raw)
{
    if (${set}(${indexMacro(entry)}, raw) == 0)
    {
        return 0;
    }${notify}
    return 1;
}

${bitsType} get_${name}_bits(void)
{
    ${bitsType} bits;
    ${type} raw;

    raw = get_${name}();
${definition.bits.map(bit => `    bits.${bit.id} = (raw & ${bitMaskName(definition, bit)}) != 0${definition.width === 32 ? "UL" : "U"} ? MODBUS_BIT_ON : MODBUS_BIT_OFF;`).join("\n")}
    return bits;
}

int set_${name}_bits(${bitsType} bits)
{
    ${type} raw;

${definition.bits.map(bit => `    if ((bits.${bit.id} != MODBUS_BIT_OFF) && (bits.${bit.id} != MODBUS_BIT_ON))
    {
        return 0;
    }`).join("\n")}
    raw = (${type})(get_${name}() & (${type})~(${definition.bits.map(bit => bitMaskName(definition, bit)).join(" | ")}));
${definition.bits.map(bit => `    if (bits.${bit.id} == MODBUS_BIT_ON)
    {
        raw = (${type})(raw | ${bitMaskName(definition, bit)});
    }`).join("\n")}
    return apply_${name}_bits_raw(raw);
}

int clear_${name}_all(void)
{
    return apply_${name}_bits_raw(0${definition.width === 32 ? "UL" : "U"});
}`];
  for (const bit of definition.bits) {
    const mask = bitMaskName(definition, bit);
    header.push(`modbus_bit_state_t get_${name}_${bit.id}(void);`, `int set_${name}_${bit.id}(modbus_bit_state_t on);`);
    source.push(`modbus_bit_state_t get_${name}_${bit.id}(void)
{
    return (get_${name}() & ${mask}) != 0${definition.width === 32 ? "UL" : "U"} ? MODBUS_BIT_ON : MODBUS_BIT_OFF;
}

int set_${name}_${bit.id}(modbus_bit_state_t on)
{
    ${type} raw;

    if ((on != MODBUS_BIT_OFF) && (on != MODBUS_BIT_ON))
    {
        return 0;
    }
    raw = (${type})(get_${name}() & (${type})~${mask});
    if (on == MODBUS_BIT_ON)
    {
        raw = (${type})(raw | ${mask});
    }
    return apply_${name}_bits_raw(raw);
}`);
  }
  return {header: header.join("\n") + "\n", source: source.join("\n\n") + "\n"};
}

function generateAccess(entries: readonly GeneratorEntry[]): GeneratedFiles {
  const actual = entries.filter(entry => entry.type !== "reserved");
  const types = new Set(actual.map(entry => entry.type));
  const scalarTypes = new Set(actual.filter(entry => entry.count === 1).map(entry => entry.type));
  const header = [actual.some(entry => entry.definition) ?
    ACCESS_HEADER_START.replace("#include <stdint.h>", "#include <stdint.h>\n" + ENUM_INCLUDE) : ACCESS_HEADER_START];
  if (actual.some(entry => entry.bitsetDefinition)) header.push('#include "modbus_reg_bits_slave.h"');
  const source = [ACCESS_SOURCE_START];
  if (actual.some(entry => entry.definition)) source.push(ENUM_INTERNAL_INCLUDE);
  if (types.has("string")) source.push("#include <string.h>");
  source.push(ACCESS_NVM_HELPER);
  if (types.has("string")) source.push(ACCESS_STRING_HELPERS);
  if (types.has("uint16_t")) source.push("static uint16_t read_uint16(const void *ptr) { return *((const uint16_t *)ptr); }");
  if (types.has("uint32_t")) source.push("static uint32_t read_uint32(const void *ptr) { return *((const uint32_t *)ptr); }");
  if (types.has("float")) source.push("static float    read_float (const void *ptr) { return *((const float    *)ptr); }", "");
  for (const type of NUMERIC_TYPES) {
    if (scalarTypes.has(type)) source.push(fillC(ACCESS_SCALAR_CORE, {BASE: type, SET: "reg_slave_set_" + SCALAR_SUFFIX[type]}));
  }
  source.push("/* Access function implementations */");
  for (const entry of actual) {
    const bindings = accessBindings(entry);
    if (entry.definition) {
      const type = entry.definition.id + "_t";
      header.push(`int get_${entry.name}(${type} *out_value);\nint set_${entry.name}(${type} value);\n`);
      source.push(enumAccessSource(entry, entry.definition));
    } else if (entry.bitsetDefinition) {
      const bits = bitsetAccess(entry, entry.bitsetDefinition);
      header.push(bits.header);
      source.push(bits.source);
    } else if (entry.type === "string") {
      header.push(fillC(ACCESS_STRING_H, bindings));
      source.push(fillC(ACCESS_STRING_C, bindings));
    } else if (entry.array) {
      header.push(fillC(ACCESS_ARRAY_H, bindings));
      source.push(fillC(ACCESS_ARRAY_C, bindings));
    } else {
      const masked = entry.type === "uint16_t" || entry.type === "uint32_t";
      const declaration = masked ? ACCESS_SCALAR_H.replace("@MASK_DECL@", ACCESS_MASK_H) :
        ACCESS_SCALAR_H.replace("@MASK_DECL@\n", "");
      const setter = entry.updateNotify ? ACCESS_SCALAR_SET_NOTIFY : ACCESS_SCALAR_SET;
      const body = ACCESS_SCALAR_C.replace("@SETTER@", setter);
      header.push(fillC(declaration, bindings));
      source.push(fillC(masked ? body + ACCESS_MASK_C : body.slice(0, -1), bindings));
    }
  }
  header.push("#endif");
  return {"modbus_reg_access_slave.h": header.join("\n") + "\n",
    "modbus_reg_access_slave.c": source.join("\n").trimEnd() + "\n"};
}

function generateNotifications(entries: readonly GeneratorEntry[]): GeneratedFiles {
  const notified = entries.filter(entry => entry.updateNotify).sort((a,b) => a.address - b.address);
  const header = [`#ifndef MODBUS_REG_UPDATE_NOTIFY_SLAVE_H
#define MODBUS_REG_UPDATE_NOTIFY_SLAVE_H

#include <stdint.h>

typedef enum
{
    MODBUS_REG_UPDATE_SOURCE_MASTER_WRITE = 1,
    MODBUS_REG_UPDATE_SOURCE_INTERNAL_SET = 2
} modbus_reg_update_source_t;

void modbus_reg_update_notify_master_write(uint16_t start_addr,
                                           uint16_t num_regs);
void modbus_reg_update_notify_internal_set(uint16_t table_index);`];
  const source = [`#include "modbus_reg_idx_slave.h"
#include "modbus_reg_update_notify_slave.h"

void modbus_reg_update_notify_master_write(uint16_t start_addr,
                                           uint16_t num_regs)
{`];
  for (const entry of notified) {
    header.push("", `extern void modbus_user_${entry.name}_updated(`, "    modbus_reg_update_source_t source);");
  }
  if (notified.length) {
    source.push("    const uint32_t end_addr = (uint32_t)start_addr + num_regs;", "");
    for (const entry of notified) {
      source.push(`    if (((uint32_t)start_addr <= ${entry.address}UL) &&
        (end_addr >= ${entry.address + entry.registerCount}UL))
    {
        modbus_user_${entry.name}_updated(
            MODBUS_REG_UPDATE_SOURCE_MASTER_WRITE);
    }`);
    }
  } else {
    source.push("    (void)start_addr;", "    (void)num_regs;");
  }
  source.push("}", "", "void modbus_reg_update_notify_internal_set(uint16_t table_index)", "{");
  if (notified.length) {
    source.push("    switch (table_index)", "    {");
    for (const entry of notified) {
      source.push(`        case ${indexMacro(entry)}:
            modbus_user_${entry.name}_updated(
                MODBUS_REG_UPDATE_SOURCE_INTERNAL_SET);
            break;`);
    }
    source.push("        default:", "            break;", "    }");
  } else {
    source.push("    (void)table_index;");
  }
  source.push("}");
  header.push("", "#endif");
  return {"modbus_reg_update_notify_slave.c": source.join("\n"),
    "modbus_reg_update_notify_slave.h": header.join("\n") + "\n"};
}

type ValidationGroups = ReadonlyMap<string, readonly GeneratorEntry[]>;

function snapshotField(entry: GeneratorEntry) {
  return entry.type === "string" ? `    modbus_string_view_t ${entry.name};` :
    `    const ${entry.type} *${entry.name};`;
}

function validationValueField(entry: GeneratorEntry) {
  const type = entry.definition ? entry.definition.id + "_t" : entry.type === "string" ? "char" : entry.type;
  return `    ${type} ${entry.name}${entry.array || entry.type === "string" ? `[${entry.count}U]` : ""};`;
}

function generateWriteGuards(entries: readonly GeneratorEntry[], groups: ValidationGroups): GeneratedFiles {
  const busy = entries.filter(entry => entry.busyReject);
  const checked = entries.filter(entry => entry.writeCheck);
  const header = [`#ifndef MODBUS_REG_WRITE_GUARD_SLAVE_H
#define MODBUS_REG_WRITE_GUARD_SLAVE_H

#include <stdint.h>${entries.some(entry => entry.definition && (entry.writeCheck || hasGroup(entry))) ? "\n" + ENUM_INCLUDE : ""}

typedef uint8_t MB_BOOL;
typedef uint8_t modbus_write_result_t;

#define MB_FALSE ((MB_BOOL)0U)
#define MB_TRUE  ((MB_BOOL)1U)

#define MODBUS_WRITE_OK              ((modbus_write_result_t)0x00U)
#define MODBUS_WRITE_ILLEGAL_ADDRESS ((modbus_write_result_t)0x02U)
#define MODBUS_WRITE_ILLEGAL_VALUE   ((modbus_write_result_t)0x03U)
#define MODBUS_WRITE_DEVICE_FAILURE  ((modbus_write_result_t)0x04U)
#define MODBUS_WRITE_DEVICE_BUSY     ((modbus_write_result_t)0x06U)

typedef struct
{
    const char *data;
    uint16_t length;
} modbus_string_view_t;
`];
  header.push("/* Validation arguments own copies; valid only during the callback. */");
  for (const [group, groupEntries] of groups) {
    header.push("", "typedef struct", "{");
    for (const entry of groupEntries) {
      header.push(validationValueField(entry));
    }
    header.push(`} ${groupAfterType(group)};`);
  }
  header.push("", "/* User-provided synchronous BUSY_REJECT callbacks */");
  for (const entry of busy) {
    header.push(`MB_BOOL modbus_user_is_busy_${entry.name}(void);`);
  }
  if (!busy.length) header.push("/* No BUSY_REJECT entries. */");
  header.push("", "/* User-provided WRITE_CHECK callbacks */");
  for (const entry of checked) {
    header.push(`extern modbus_write_result_t modbus_user_write_check_${entry.name}(`);
    if (entry.type === "string") header.push("    const modbus_string_view_t *current_value,", "    const modbus_string_view_t *new_value);");
    else if (entry.array) header.push(`    const ${entry.type} current_value[],`, `    const ${entry.type} new_value[],`, "    uint16_t count);");
    else {
      const type = entry.definition ? entry.definition.id + "_t" : entry.type;
      header.push(`    ${type} current_value,`, `    ${type} new_value);`);
    }
  }
  if (!checked.length) header.push("/* No WRITE_CHECK callbacks. */");
  header.push("", "/* User-provided GROUP_VALIDATE callbacks */");
  for (const [group, groupEntries] of groups) {
    const afterType = groupAfterType(group);
    header.push(`extern modbus_write_result_t modbus_user_group_validate_${group}(`,
      `    const ${afterType} *after);`);
  }
  if (!groups.size) header.push("/* No GROUP_VALIDATE callbacks. */");
  header.push("", "MB_BOOL modbus_write_guard_entry_is_busy(uint16_t reg_table_index);", "", "#endif", "");

  const source = ['#include "modbus_reg_write_guard_slave.h"', '#include "modbus_reg_idx_slave.h"', ""];
  source.push("MB_BOOL modbus_write_guard_entry_is_busy(uint16_t reg_table_index)", "{", "    switch (reg_table_index)", "    {");
  for (const entry of busy) {
    source.push(`        case ${indexMacro(entry)}:`, `            return modbus_user_is_busy_${entry.name}();`);
  }
  source.push("        default:", "            return MB_FALSE;", "    }", "}", "");
  return {"modbus_reg_write_guard_slave.h": header.join("\n"), "modbus_reg_write_guard_slave.c": source.join("\n")};
}


function generateParser(entries: readonly GeneratorEntry[], groups: ValidationGroups): GeneratedFiles {
  const withEnums = entries.some(entry => entry.definition);
  const checks: string[] = [];
  for (const entry of entries.filter(row => row.writeCheck)) {
    const {name, type} = entry;
    checks.push(`        case ${indexMacro(entry)}:`);
    if (entry.definition) {
      const id = entry.definition.id;
      checks.push(`        {
            ${id}_t current_value;
            ${id}_t new_value;

            if (${id}_from_register(
                    *((const uint16_t *)after_value), &new_value) == 0)
            {
                return MODBUS_WRITE_ILLEGAL_VALUE;
            }
            if (${id}_from_register(
                    *((const uint16_t *)entry->ram_ptr), &current_value) == 0)
            {
                return MODBUS_WRITE_DEVICE_FAILURE;
            }
            return modbus_user_write_check_${name}(current_value, new_value);
        }`);
    } else if (type === "string") {
      checks.push(`        {
            char current_data[${entry.count}U];
            char new_data[${entry.count}U];
            modbus_string_view_t current_value;
            modbus_string_view_t new_value;

            (void)memcpy(current_data, entry->ram_ptr, sizeof(current_data));
            (void)memcpy(new_data, after_value, sizeof(new_data));
            current_value.data = current_data;
            current_value.length = modbus_string_field_length(
                current_value.data, entry->size);
            new_value.data = new_data;
            new_value.length = modbus_string_field_length(
                new_value.data, entry->size);
            return modbus_user_write_check_${name}(
                &current_value, &new_value);
        }`);
    } else if (entry.array) {
      checks.push(`        {
            ${type} current_value[${entry.count}U];
            ${type} new_value[${entry.count}U];

            (void)memcpy(current_value, entry->ram_ptr, sizeof(current_value));
            (void)memcpy(new_value, after_value, sizeof(new_value));
            return modbus_user_write_check_${name}(
                current_value, new_value, entry->length);
        }`);
    } else {
      checks.push(`            return modbus_user_write_check_${name}(
                *((const ${type} *)entry->ram_ptr),
                *((const ${type} *)after_value));`);
    }
  }

  const init: string[] = [], pointers: string[] = [];
  const snapshots = entries.filter(hasGroup);
  if (!snapshots.length) init.push("    snapshot->unused = (const uint8_t *)0;");
  for (const entry of snapshots) {
    const {name, type} = entry;
    const ref = tableEntry(entry);
    pointers.push(`        case ${indexMacro(entry)}:`);
    if (type === "string") {
      init.push(`    snapshot->${name}.data = (const char *)
        ${ref}.ram_ptr;
    snapshot->${name}.length = modbus_string_field_length(
        snapshot->${name}.data,
        ${ref}.size);`);
      pointers.push(`            snapshot->${name}.data = (const char *)after_value;
            snapshot->${name}.length =
                modbus_string_field_length(
                    snapshot->${name}.data,
                    ${ref}.size);`);
    } else {
      init.push(`    snapshot->${name} = (const ${type} *)${ref}.ram_ptr;`);
      pointers.push(`            snapshot->${name} = (const ${type} *)after_value;`);
    }
    pointers.push("            break;");
  }

  const flags: string[] = [], members: string[] = [], validation: string[] = [];
  for (const [group, groupEntries] of groups) {
    flags.push(`    MB_BOOL group_${group}_affected = MB_FALSE;`);
    const condition = groupEntries.map(entry => `table_index == ${indexMacro(entry)}`).join(" || ");
    if (condition) members.push(`        if (${condition})
        {
            group_${group}_affected = MB_TRUE;
        }`);
    validation.push(`    if (group_${group}_affected != MB_FALSE)`, "    {");
    const after = `validation_copy.${group}`;
    for (const {definition, name, array, type} of groupEntries) {
      if (definition) {
        validation.push(`        if (${definition.id}_from_register(
                *snapshot.${name}, &${after}.${name}) == 0)
        {
            return MODBUS_EXC_SLAVE_DEVICE_FAILURE;
        }`);
      } else if (array || type === "string") {
        validation.push(`        (void)memcpy(${after}.${name}, snapshot.${name}${type === "string" ? ".data" : ""}, sizeof(${after}.${name}));`);
      } else {
        validation.push(`        ${after}.${name} = *snapshot.${name};`);
      }
    }
    validation.push(`        user_result = normalize_user_write_result(
            modbus_user_group_validate_${group}(&${after}));
        if (user_result != MODBUS_WRITE_OK)
        {
            return (int)user_result;
        }
    }`);
  }

  const blocks: Record<string, string[]> = {
    "@SNAPSHOT_TYPE@": ["/* Internal pointers never cross the validation callback boundary. */", "typedef struct", "{",
      ...(snapshots.length ? snapshots.map(snapshotField) : ["    const uint8_t *unused;"]), "} modbus_reg_snapshot_t;", ""],
    "@GROUP_COPY_TYPE@": groups.size ? ["/* All group callbacks share storage for one isolated value copy. */", "typedef union", "{",
      ...Array.from(groups.keys(), group => `    ${groupAfterType(group)} ${group};`), "} modbus_validation_copy_t;", ""] : [],
    "@GROUP_COPY_VAR@": groups.size ? ["    modbus_validation_copy_t validation_copy;"] : [],
    "@CHECKS@": checks, "@INITIALIZE@": init, "@SET_POINTER@": pointers,
    "@GROUP_FLAGS@": flags, "@GROUP_MEMBERS@": members, "@GROUP_VALIDATE@": validation,
    "@DEFAULT_CHECK@": withEnums ? [`            if ((entry->type == REG_TYPE_UINT16) &&
                (modbus_reg_enum_wire_value_is_valid(table_index,
                    *((const uint16_t *)after_value)) == 0))
            {
                return MODBUS_WRITE_ILLEGAL_VALUE;
            }`] : []
  };
  const atomic = PARSER_ATOMIC.split("\n").flatMap(line => blocks[line] ?? [line]).join("\n");
  return {"modbus_parser.h": PARSER_HEADER, "modbus_parser.c": PARSER_SOURCE
    .replace("@ENUM_INCLUDE@\n", withEnums ? ENUM_INTERNAL_INCLUDE + "\n" : "").replace("@ATOMIC@", () => atomic)};
}

function generateModbusFiles(validated: ValidatedProject): GeneratedFiles {
  const entries = generatorEntries(validated);
  const groups = new Map<string, GeneratorEntry[]>();
  for (const entry of entries.filter(hasGroup)) {
    const members = groups.get(entry.groupValidate);
    if (members) members.push(entry);
    else groups.set(entry.groupValidate, [entry]);
  }
  const {enums} = validated.documentValue;
  const files: GeneratedFiles = {
    ...generateNvm(validated.documentValue, entries),
    ...generateEnums(enums, entries),
    ...generateBitsetTypes(validated.documentValue.bitsetDefs),
    ...generateRegisterMap(validated.documentValue, entries),
    "modbus_reg_idx_slave.h": generateRegisterIndex(entries, validated.documentValue.config.slaveAddress),
    ...generateAccess(entries),
    ...generateNotifications(entries),
    ...generateWriteGuards(entries, groups),
    ...generateParser(entries, groups)
  };
  for (const name of Object.keys(files)) {
    if (!files[name].endsWith("\n")) files[name] += "\n";
  }
  return files;
}

