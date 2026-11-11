"use strict";

const FORMAT = "modbus-slave-regmap";
const SCHEMA_VERSION = 3;
const UNUSED = "-";
const NUMERIC_TYPES = ["uint16_t", "uint32_t", "float"] as const;
const TYPES = [...NUMERIC_TYPES, "string", "reserved"] as const;
const TYPE_BYTES = {uint16_t: 2, uint32_t: 4, float: 4, string: 1, reserved: 2};
const ACCESS = ["RO", "RW", "WO"] as const;
const TABLE_FIELDS = ["address", "name", "type", "length", "access", "min", "max", "default", "nvmOffset"] as const;
const FLAGS = ["updateNotify", "busyReject", "writeCheck"] as const;
const NOTES = ["unit", "summary", "description", "spec", "notes"] as const;
const DETAIL_TEXT_FIELDS = ["groupValidate", ...NOTES] as const;
const TEXT_FIELDS = [...TABLE_FIELDS, ...DETAIL_TEXT_FIELDS] as const;

type Unused = typeof UNUSED;
type NumericType = typeof NUMERIC_TYPES[number];
type RegisterType = typeof TYPES[number];
type RegisterAccess = typeof ACCESS[number];
type TableField = typeof TABLE_FIELDS[number];
type RegisterFlags = Record<typeof FLAGS[number], boolean>;
type RegisterNotes = Record<typeof NOTES[number], string>;
type EnumMember = {id: string; value: number; label: string};
type RegisterEnum = {id: string; label: string; members: EnumMember[]};
type EnumDomain = {kind: "enum"; enumId: string; defaultMemberId: string};
type ValueDomain = EnumDomain | {kind: "range"; min: number; max: number; default: number} |
  {kind: "string"; default: string} | {kind: "reserved"};
type DraftRegister = RegisterFlags & Record<typeof TEXT_FIELDS[number], string> & {enumDomain: EnumDomain | null};
type DraftProject = {
  config: {slaveAddress: string; nvmSize: string};
  lengthDefs: {name: string; length: string}[];
  enums: RegisterEnum[];
  registers: DraftRegister[];
};
type RegisterDefinition = RegisterFlags & RegisterNotes & {
  address: number;
  name: string;
  type: RegisterType;
  length: number | string;
  access: RegisterAccess | Unused;
  valueDomain: ValueDomain;
  nvmOffset: number | Unused;
  groupValidate: string;
};
type RegmapDocument = {
  format: typeof FORMAT;
  schemaVersion: typeof SCHEMA_VERSION;
  config: {slaveAddress: number; nvmSize: number};
  lengthDefs: {name: string; length: number}[];
  enums: RegisterEnum[];
  registers: RegisterDefinition[];
};
type ValidatedProject = {documentValue: RegmapDocument; counts: number[]};
type Issue = {text: string; row: number | null; field: string};
type Inspection = {
  errors: Issue[];
  warnings: string[];
  counts: (number | null)[];
  validated: ValidatedProject | null;
};
type MemoryRange = {start: number; end: number; index: number; label: string};
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ENUM_ID = /^[a-z][a-z0-9_]*$/;
const C_KEYWORDS = new Set(
  "auto break case char const continue default do double else enum extern float for goto if int long register return short signed sizeof static struct switch typedef union unsigned void volatile while".split(" ")
);
const isName = (value: string): boolean => IDENTIFIER.test(value) && !C_KEYWORDS.has(value);
const scalarText = (value: unknown): string => value == null ? "" : String(value);
const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const isList = (value: unknown): value is unknown[] => Array.isArray(value);
const isScalar = (value: unknown): value is string | number | null =>
  value === null || typeof value === "string" || typeof value === "number";

function isOneOf<T extends string>(values: readonly T[], candidate: unknown): candidate is T {
  return values.some(value => value === candidate);
}

function unsigned(raw: string): number | null {
  const text = scalarText(raw).trim();
  if (!/^(?:[0-9]+|0x[0-9a-f]+)$/i.test(text)) return null;
  const value = Number(text);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function numeric(raw: string, type: NumericType): number | null {
  if (type !== "float") {
    const value = unsigned(raw);
    const max = type === "uint16_t" ? 65535 : 4294967295;
    return value !== null && value <= max ? value : null;
  }
  const text = scalarText(raw).trim();
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(text)) return null;
  const value = Number(text);
  return Number.isFinite(Math.fround(value)) ? value : null;
}

function draftRow(data: Record<string, unknown> = {}): DraftRegister {
  const row: DraftRegister = {
    address: "0", name: "", type: "uint16_t", length: "1",
    access: "RW", min: "0", max: "65535", default: "0", nvmOffset: "",
    updateNotify: false, busyReject: false, writeCheck: false, groupValidate: UNUSED,
    unit: UNUSED, summary: UNUSED, description: UNUSED, spec: UNUSED, notes: UNUSED, enumDomain: null
  };
  for (const key of FLAGS) {
    if (!Object.hasOwn(data, key)) continue;
    const value = data[key];
    if (typeof value !== "boolean") throw Error(key + " は true または false で指定してください。");
    row[key] = value;
  }
  for (const key of TEXT_FIELDS) {
    const value = Object.hasOwn(data, key) ? data[key] : row[key];
    if (!isScalar(value)) throw Error(key + " の値を読み取れません。");
    row[key] = key === "default" && data.type === "string" && typeof value === "string" ?
      JSON.stringify(value) : scalarText(value);
  }
  return row;
}

function sampleProject(): DraftProject {
  return {
    config: {slaveAddress: "1", nvmSize: "256"},
    lengthDefs: [{name: "NAME_LEN", length: "12"}],
    enums: [{
      id: "modbus_parity", label: "Modbusパリティ", members: [
        {id: "none", value: 0, label: "なし"},
        {id: "odd", value: 1, label: "奇数"},
        {id: "even", value: 2, label: "偶数"}
      ]
    }, {
      id: "modbus_operation_status", label: "運転状態", members: [
        {id: "init", value: 0, label: "初期化"},
        {id: "meas", value: 1, label: "測定"},
        {id: "stby", value: 2, label: "待機"},
        {id: "wash", value: 3, label: "洗浄"},
        {id: "cal", value: 4, label: "校正"},
        {id: "manual_cal", value: 5, label: "手動校正"}
      ]
    }],
    registers: [
      draftRow({address: 0, name: "Measurement", type: "float", access: "RO",
        min: -100, max: 100, default: 0, nvmOffset: UNUSED, summary: "測定値の表示例"}),
      draftRow({address: 32, name: "DeviceName", type: "string", access: "RO",
        length: "NAME_LEN", min: UNUSED, max: UNUSED, default: "MODBUS DEMO", nvmOffset: UNUSED}),
      {...draftRow({address: 56, name: "OperationStatus", max: 5, nvmOffset: UNUSED,
        updateNotify: true, writeCheck: true, summary: "運転状態の書き込み判定例"}),
        enumDomain: {kind: "enum", enumId: "modbus_operation_status", defaultMemberId: "init"}},
      draftRow({address: 106, name: "ModbusBaudrate", max: 2, default: 1, nvmOffset: "0x000C",
        updateNotify: true, groupValidate: "serial_settings", summary: "通信速度の設定例"}),
      {...draftRow({address: 107, name: "ModbusParityBit", max: 2, nvmOffset: "0x000E",
        updateNotify: true, groupValidate: "serial_settings", summary: "パリティの設定例"}),
        enumDomain: {kind: "enum", enumId: "modbus_parity", defaultMemberId: "none"}},
      draftRow({address: 108, name: "reserved_108", type: "reserved", length: 2,
        access: UNUSED, min: UNUSED, max: UNUSED, default: UNUSED, nvmOffset: UNUSED})
    ]
  };
}

function enumMemberCName(typeId: string, memberId: string) {
  return (typeId + "_" + memberId).toUpperCase();
}

function groupAfterType(group: string) {
  return "modbus_" + group + "_after_t";
}

function enumRange(definition: RegisterEnum, defaultMemberId: string) {
  let min = 65535, max = 0, initial: number | undefined;
  for (const member of definition.members) {
    min = Math.min(min, member.value);
    max = Math.max(max, member.value);
    if (member.id === defaultMemberId) initial = member.value;
  }
  return initial === undefined ? null : {min, max, default: initial};
}

function enumDefinitionError(definition: RegisterEnum): string {
  if (!ENUM_ID.test(definition.id) || !definition.label.trim()) return "型IDと表示名を入力してください。";
  if (!definition.members.length || definition.members.length > 32768) return "選択肢は1〜32768件にしてください。";
  const ids = new Set<string>(), values = new Set<number>();
  for (const member of definition.members) {
    if (!ENUM_ID.test(member.id) || !member.label.trim() || !Number.isInteger(member.value) ||
        member.value < 0 || member.value > 65535) return "選択肢ID、Modbus値（0〜65535の整数）、表示名を確認してください。";
    if (ids.has(member.id) || values.has(member.value)) return "選択肢IDとModbus値の重複を確認してください。";
    ids.add(member.id);
    values.add(member.value);
  }
  return "";
}

function decodeEnum(value: unknown, invalid: string): RegisterEnum {
  if (!isObject(value) || typeof value.id !== "string" || typeof value.label !== "string" || !isList(value.members)) {
    throw Error(invalid);
  }
  return {id: value.id, label: value.label, members: value.members.map(member => {
    if (!isObject(member) || typeof member.id !== "string" || typeof member.label !== "string" ||
        typeof member.value !== "number") throw Error(invalid);
    return {id: member.id, value: member.value, label: member.label};
  })};
}

function importTableRow(row: unknown): DraftRegister {
  if (!isObject(row) || !Object.hasOwn(row, "Reg_Addr") || !Object.hasOwn(row, "VarName")) {
    throw Error("RegisterTableのレジスタ行を読み取れません。");
  }
  const type = typeof row.Type === "string" && /^char$/i.test(row.Type) ? "string" : row.Type;
  const isString = type === "string";
  let initial = row.Default;
  if (isString && initial === "-") initial = "";
  else if (isString && typeof initial === "string" && /^".*"$/s.test(initial)) initial = initial.slice(1, -1);
  return draftRow({
    address: row.Reg_Addr, name: row.VarName, type, length: row.ArrayLen,
    access: row.Access === "R" ? "RO" : row.Access === "W" ? "WO" : row.Access,
    min: row.Min, max: row.Max, default: initial,
    nvmOffset: row.NVM_Offset,
    updateNotify: row.UPDATE_NOTIFY, busyReject: row.BUSY_REJECT, writeCheck: row.WRITE_CHECK,
    groupValidate: row.GROUP_VALIDATE,
    unit: scalarText(row.unit).trim() ? row.unit : UNUSED,
    summary: scalarText(row["概要"]).trim() ? row["概要"] : UNUSED,
    description: scalarText(row["詳細"]).trim() ? row["詳細"] : UNUSED,
    spec: scalarText(row["機能仕様番号"]).trim() ? row["機能仕様番号"] : UNUSED,
    notes: scalarText(row["備考"]).trim() ? row["備考"] : UNUSED
  });
}

function decodeProject(input: unknown): {project: DraftProject; hint: string} {
  const documentValue = isObject(input) ? input : {};
  const {source, rows} = documentValue;
  if (isObject(source) && source.sheet === "RegisterTable" && isList(rows)) {
    return {
      project: {config: {slaveAddress: "", nvmSize: ""}, lengthDefs: [], enums: [],
        registers: rows.map(importTableRow)},
      hint: "レジスタ表を読み込みました。スレーブアドレスとNVMサイズを入力してください。"
    };
  }
  const {format, schemaVersion, config, lengthDefs, registers, enums} = documentValue;
  const legacy = schemaVersion === 1;
  const hasDomains = schemaVersion === SCHEMA_VERSION;
  const invalid = "このエディターで保存したJSON、またはRegisterTable.jsonを選んでください。";
  const fields = legacy ? TABLE_FIELDS : [...TABLE_FIELDS.filter(field => !hasDomains ||
    (field !== "min" && field !== "max" && field !== "default")), ...FLAGS, ...DETAIL_TEXT_FIELDS];
  if (format !== FORMAT || (!legacy && schemaVersion !== 2 && !hasDomains) || !isObject(config) ||
      !isList(lengthDefs) || !isList(registers) ||
      !["slaveAddress", "nvmSize"].every(key => Object.hasOwn(config, key) && isScalar(config[key]))) {
    throw Error(invalid);
  }

  if (hasDomains && !isList(enums)) throw Error(invalid);
  const definitions = hasDomains && isList(enums) ? enums.map(value => decodeEnum(value, invalid)) : [];
  const project: DraftProject = {
    config: {slaveAddress: scalarText(config.slaveAddress), nvmSize: scalarText(config.nvmSize)},
    enums: definitions,
    lengthDefs: lengthDefs.map(row => {
      if (!isObject(row) || typeof row.name !== "string" || !isScalar(row.length)) throw Error(invalid);
      return {name: row.name, length: scalarText(row.length)};
    }),
    registers: registers.map(row => {
      if (!isObject(row) || !fields.every(key => Object.hasOwn(row, key))) throw Error(invalid);
      if (hasDomains) {
        const domain = row.valueDomain;
        if (!isObject(domain)) throw Error(invalid);
        if (domain.kind === "enum" && typeof domain.enumId === "string" && typeof domain.defaultMemberId === "string") {
          const definition = definitions.find(item => item.id === domain.enumId);
          const range = definition ? enumRange(definition, domain.defaultMemberId) : null;
          return {...draftRow({...row, ...range}), enumDomain: {kind: "enum", enumId: domain.enumId,
            defaultMemberId: domain.defaultMemberId}};
        }
        if (row.type === "string" && domain.kind === "string" && typeof domain.default === "string") {
          return draftRow({...row, default: domain.default});
        }
        if (row.type === "reserved" && domain.kind === "reserved") return draftRow(row);
        if (isOneOf(NUMERIC_TYPES, row.type) && domain.kind === "range" && typeof domain.min === "number" &&
            typeof domain.max === "number" && typeof domain.default === "number") {
          return draftRow({...row, min: domain.min, max: domain.max, default: domain.default});
        }
        throw Error(invalid);
      }
      if (!legacy) return draftRow(row);
      const notes = Object.fromEntries(NOTES.map(key => [key, scalarText(row[key]).trim() ? row[key] : UNUSED]));
      return draftRow({...row, groupValidate: row.groupValidate ?? null, ...notes});
    })
  };
  return {project, hint: legacy ? "旧版のJSONを読み込みました。NVM・グループ検証の未指定欄を確認してください。" : "JSONを読み込みました。"};
}

function inspectProject(project: DraftProject): Inspection {
  const errors: Issue[] = [];
  const warnings: string[] = [];
  const issue = (text: string, row: number | null = null, field = "") => errors.push({text, row, field});
  const slaveAddress = unsigned(project.config.slaveAddress);
  const nvmSize = unsigned(project.config.nvmSize);
  if (slaveAddress === null || slaveAddress < 1 || slaveAddress > 247) {
    issue("スレーブアドレスは1〜247の整数を入力してください。", null, "slaveAddress");
  }
  if (nvmSize === null || nvmSize < 1 || nvmSize > 65535) {
    issue("NVMサイズは1〜65535 Bの整数を入力してください。", null, "nvmSize");
  }
  if (project.registers.length === 0) issue("レジスタを1件以上追加してください。");

  const lengths = new Map<string, number | null>();
  const lengthDefs: RegmapDocument["lengthDefs"] = [];
  project.lengthDefs.forEach((entry, index) => {
    const name = entry.name.trim();
    const length = unsigned(entry.length);
    if (!isName(name)) issue("配列長定義 " + (index + 1) + " 行目の名前が無効です。");
    else if (lengths.has(name)) issue("配列長定義 " + name + " が重複しています。");
    if (length === null || length < 1 || length > 65536) {
      issue("配列長定義 " + (index + 1) + " 行目の長さは1〜65536の整数にしてください。");
    }
    lengths.set(name, length);
    if (length !== null) lengthDefs.push({name, length});
  });

  const enumsById = new Map<string, RegisterEnum>();
  const enumSymbols = new Set<string>([
    "reg_type_t", "access_mode_t", "reg_table_entry_t", "modbus_write_result_t", "modbus_reg_snapshot_t",
    "modbus_string_view_t", "modbus_reg_update_source_t", "modbus_reg_enum_wire_value_is_valid",
    "MODBUS_REG_ENUMS_SLAVE_H", "MODBUS_SLAVE_ADDR", "NVM_TOTAL_SIZE", "NVM_MAX_OFFSET", "NVM_OFFSET_UNUSED",
    ...lengths.keys(), ...project.registers.map(row => row.name.trim())
  ]);
  for (const definition of project.enums) {
    const error = enumDefinitionError(definition);
    if (error) issue("列挙型 " + definition.id + "　" + error);
    if (enumsById.has(definition.id)) issue("列挙型ID " + definition.id + " が重複しています。");
    enumsById.set(definition.id, definition);
    for (const symbol of [definition.id + "_t", definition.id + "_from_register", definition.id + "_to_register",
      ...definition.members.map(member => enumMemberCName(definition.id, member.id))]) {
      if (enumSymbols.has(symbol) || symbol.startsWith("MODBUS_IDX_") || /^u?int(?:_fast|_least)?\d+_t$/.test(symbol)) {
        issue("生成するC識別子 " + symbol + " が重複しています。");
      }
      enumSymbols.add(symbol);
    }
  }

  const names = new Set<string>();
  const enumGroups = new Set<string>();
  const addressRanges: MemoryRange[] = [], nvmRanges: MemoryRange[] = [];
  const counts: Inspection["counts"] = [];
  const registerCounts: number[] = [];
  const registers: RegisterDefinition[] = [];
  project.registers.forEach((row, index) => {
    const errorCount = errors.length;
    const name = row.name.trim();
    const label = (index + 1) + " 行目" + (name ? " " + name : "");
    const fail = (field: string, message: string) => issue(label + "　" + message, index, field);
    const type = isOneOf(TYPES, row.type) ? row.type : null;
    const reserved = type === "reserved", string = type === "string";
    if (type === null) fail("type", "型を選んでください。");
    if (!isName(name)) fail("name", "変数名に有効なC識別子を入力してください。");
    else if (!reserved && names.has(name)) fail("name", "変数名が重複しています。");
    if (!reserved) names.add(name);

    const address = unsigned(row.address);
    if (address === null || address > 65535) fail("address", "アドレスは0〜65535の整数にしてください。");
    const literalLength = unsigned(row.length);
    const length = literalLength ?? (reserved ? null : lengths.get(row.length.trim())) ?? null;
    const validLength = length !== null && length >= 1 && length <= 65536 && (!string || (length >= 2 && length % 2 === 0));
    if (!validLength) fail("length", string ? "文字列の配列長は2以上の偶数にしてください。" :
      reserved ? "予約領域の配列長は1〜65536の整数にしてください。" : "配列長に1〜65536の整数か定義名を入力してください。");
    const bytes = validLength && type !== null ? length * TYPE_BYTES[type] : null;
    const registerCount = bytes === null ? null : bytes / 2;
    counts.push(registerCount);
    if (address !== null && address <= 65535 && registerCount !== null) {
      if (address + registerCount > 65536) fail("address", "占有する範囲が65535を超えています。");
      else addressRanges.push({start: address, end: address + registerCount, index, label});
    }

    const access = reserved ? UNUSED : isOneOf(ACCESS, row.access) ? row.access : null;
    if (access === null) fail("access", "アクセス権限を選んでください。");
    if (!reserved && access === "RO" && (row.busyReject || row.writeCheck)) {
      fail("detail", "ROの行ではBUSY拒否と書き込み判定を解除してください。");
    }
    const groupValidate = reserved ? UNUSED : row.groupValidate.trim();
    if (groupValidate !== UNUSED && !isName(groupValidate)) {
      fail("detail", "グループ検証名を指定してください。使わない場合は - を入力します。");
    }
    for (const key of NOTES) {
      if (row[key].trim() === "") {
        fail("detail", "付加情報の空欄を埋めてください。記載事項がない場合は - を入力します。");
        break;
      }
    }

    let valueDomain: ValueDomain | null = null;
    if (row.enumDomain) {
      const definition = enumsById.get(row.enumDomain.enumId);
      if (type !== "uint16_t" || length !== 1) fail("detail", "列挙型は配列長1のuint16_tで指定してください。");
      if (!definition) fail("detail", "列挙型を選択してください。");
      else if (!definition.members.some(member => member.id === row.enumDomain?.defaultMemberId)) {
        fail("detail", "列挙型の初期値を選択してください。");
      }
      if (groupValidate !== UNUSED && isName(groupValidate)) {
        const group = groupValidate.toLowerCase();
        const symbol = groupAfterType(group);
        if (!enumGroups.has(group) && enumSymbols.has(symbol)) {
          fail("detail", "生成するC識別子 " + symbol + " が重複しています。");
        }
        enumGroups.add(group);
      }
      valueDomain = {...row.enumDomain};
    } else if (string) {
      let initial: unknown;
      try {
        initial = JSON.parse(row.default);
      } catch {
        initial = null;
      }
      if (typeof initial !== "string" || !/^[\x20-\x7e]*$/.test(initial)) {
        fail("default", '文字列の初期値を引用符で囲んでください。空文字列は "" を入力します。');
      } else if (validLength && initial.length > length) {
        fail("default", "文字列の初期値が配列長を超えています。");
      } else valueDomain = {kind: "string", default: initial};
    } else if (isOneOf(NUMERIC_TYPES, type)) {
      const min = numeric(row.min, type);
      const max = numeric(row.max, type);
      const initial = numeric(row.default, type);
      if (min === null) fail("min", "型の範囲内の下限を入力してください。");
      if (max === null) fail("max", "型の範囲内の上限を入力してください。");
      if (initial === null) fail("default", "型の範囲内の初期値を入力してください。");
      if (min !== null && max !== null && min > max) fail("max", "上限は下限以上にしてください。");
      else if (min !== null && max !== null && typeof initial === "number" && (initial < min || initial > max)) {
        if (access === "RO") warnings.push(label + "　読取専用の初期値が下限〜上限の外にあります。");
        else fail("default", "初期値は下限〜上限に収めてください。");
      }
      if (min !== null && max !== null && initial !== null) valueDomain = {kind: "range", min, max, default: initial};
    } else if (reserved) valueDomain = {kind: "reserved"};

    const nvmInput = reserved ? UNUSED : row.nvmOffset.trim();
    let nvmOffset: RegisterDefinition["nvmOffset"] | null = UNUSED;
    if (nvmInput === "") {
      fail("nvmOffset", "NVMオフセットを指定してください。使わない場合は - を入力します。");
    } else if (nvmInput !== UNUSED) {
      nvmOffset = unsigned(nvmInput);
      if (nvmOffset === null || nvmOffset > 65535) fail("nvmOffset", "NVMオフセットは0〜65535の整数にしてください。");
      else if (bytes !== null) {
        if (nvmSize !== null && nvmOffset + bytes > nvmSize) fail("nvmOffset", "NVM領域を超えています。");
        nvmRanges.push({start: nvmOffset, end: nvmOffset + bytes, index, label});
        if (type !== null && nvmOffset % TYPE_BYTES[type] !== 0) {
          warnings.push(label + "　NVMオフセットが型サイズ境界にそろっていません。");
        }
      }
    }

    if (errors.length !== errorCount || address === null || type === null || access === null ||
        valueDomain === null || nvmOffset === null || registerCount === null) return;

    registers.push({
      address, name, type, length: literalLength ?? row.length.trim(), access, valueDomain, nvmOffset,
      updateNotify: !reserved && row.updateNotify, busyReject: !reserved && row.busyReject,
      writeCheck: !reserved && row.writeCheck, groupValidate,
      unit: row.unit, summary: row.summary, description: row.description, spec: row.spec, notes: row.notes
    });
    registerCounts.push(registerCount);
  });

  const valueGetters = new Set(registers.filter(row => row.type !== "string" && row.type !== "reserved")
    .map(row => "get_" + row.name));
  for (const row of registers.filter(row => row.valueDomain.kind === "range")) {
    const symbol = "get_" + row.name + "_default";
    if (valueGetters.has(symbol) || enumSymbols.has(symbol)) {
      issue("初期値取得APIのC識別子 " + symbol + " が重複しています。");
    }
  }

  function checkOverlap(ranges: MemoryRange[], field: string, label: string) {
    ranges.sort((a, b) => a.start - b.start || a.index - b.index);
    let furthest: MemoryRange | null = null;
    for (const range of ranges) {
      if (furthest && range.start < furthest.end) {
        issue(range.label + " と " + furthest.label + " の" + label + "が重複しています。", range.index, field);
      }
      if (!furthest || range.end > furthest.end) furthest = range;
    }
  }
  checkOverlap(addressRanges, "address", "アドレス範囲");
  checkOverlap(nvmRanges, "nvmOffset", "NVM範囲");
  if (errors.length || slaveAddress === null || nvmSize === null) {
    return {errors, warnings, counts, validated: null};
  }
  const documentValue: RegmapDocument = {
    format: FORMAT, schemaVersion: SCHEMA_VERSION, config: {slaveAddress, nvmSize}, lengthDefs, enums: project.enums, registers
  };
  return {errors, warnings, counts, validated: {documentValue, counts: registerCounts}};
}
