const CODE_ZIP = "modbus-slave-generated.zip";
type TextControl = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;

const LABELS: Record<TableField, string> = {
  address: "アドレス", name: "変数名", type: "型", length: "配列長", access: "権限",
  min: "下限", max: "上限", default: "初期値", nvmOffset: "NVMオフセット"
};
const HTML_ENTITIES: Record<string, string> = {
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
};
const escapeHtml = (value: string): string => value.replace(/[&<>"']/g, char => HTML_ENTITIES[char]);

function $(id: string): HTMLElement;
function $<T extends HTMLElement>(id: string, type: new () => T): T;
function $(id: string, type = HTMLElement): HTMLElement {
  const element = document.getElementById(id);
  if (!(element instanceof type)) throw Error("Unexpected editor element: " + id);
  return element;
}

function rowIndex(element: HTMLElement): number | null {
  const index = element.closest("tr")?.dataset.index;
  return index === undefined ? null : unsigned(index);
}

function download(filename: string, data: BlobPart, contentType: string) {
  const url = URL.createObjectURL(new Blob([data], {type: contentType}));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

/* Store the generated text files in a ZIP without adding browser dependencies. */
function zipFiles(files: Record<string, string>): ArrayBuffer {
  const encoder = new TextEncoder();
  const records = Object.entries(files).map(([name, text]) => {
    const bytes = encoder.encode(text);
    let crc = 0xffffffff;
    for (const byte of bytes) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
    return {name: encoder.encode(name), bytes, crc: (crc ^ 0xffffffff) >>> 0};
  });
  const filesSize = records.reduce((sum, record) => sum + 30 + record.name.length + record.bytes.length, 0);
  const directorySize = records.reduce((sum, record) => sum + 46 + record.name.length, 0);
  const bytes = new Uint8Array(filesSize + directorySize + 22);
  const view = new DataView(bytes.buffer);
  let offset = 0, directory = filesSize;
  for (const record of records) {
    view.setUint32(offset, 0x04034b50, true);
    view.setUint16(offset + 4, 20, true);
    view.setUint16(offset + 12, 0x21, true);
    view.setUint32(offset + 14, record.crc, true);
    view.setUint32(offset + 18, record.bytes.length, true);
    view.setUint32(offset + 22, record.bytes.length, true);
    view.setUint16(offset + 26, record.name.length, true);
    bytes.set(record.name, offset + 30);
    bytes.set(record.bytes, offset + 30 + record.name.length);

    view.setUint32(directory, 0x02014b50, true);
    view.setUint16(directory + 4, 20, true);
    view.setUint16(directory + 6, 20, true);
    view.setUint16(directory + 14, 0x21, true);
    view.setUint32(directory + 16, record.crc, true);
    view.setUint32(directory + 20, record.bytes.length, true);
    view.setUint32(directory + 24, record.bytes.length, true);
    view.setUint16(directory + 28, record.name.length, true);
    view.setUint32(directory + 42, offset, true);
    bytes.set(record.name, directory + 46);

    offset += 30 + record.name.length + record.bytes.length;
    directory += 46 + record.name.length;
  }
  view.setUint32(directory, 0x06054b50, true);
  view.setUint16(directory + 8, records.length, true);
  view.setUint16(directory + 10, records.length, true);
  view.setUint32(directory + 12, directorySize, true);
  view.setUint32(directory + 16, filesSize, true);
  return bytes.buffer;
}

const fileInput = $("file", HTMLInputElement);
const searchInput = $("search", HTMLInputElement);
const typeFilter = $("type-filter", HTMLSelectElement);
const configInputs = {
  slaveAddress: $("slave-address", HTMLInputElement),
  nvmSize: $("nvm-size", HTMLInputElement)
};
const detailDialog = $("detail-dialog", HTMLDialogElement);
const codeDialog = $("code-dialog", HTMLDialogElement);
const codeSelection = $("code-selection", HTMLSelectElement);
const lengthDialog = $("length-dialog", HTMLDialogElement);
const issueDialog = $("issue-dialog", HTMLDialogElement);

let project = sampleProject();
let sourceName = "サンプル";
let inspection: Inspection;
let detailIndex = -1;
let codeFiles: GeneratedFiles = {};

function message(text = "", error = false) {
  const element = $("message");
  element.textContent = text;
  element.classList.toggle("error", error);
}

function renderSource() {
  const source = $("source");
  source.textContent = sourceName;
  source.title = source.textContent;
}

function updateValidation() {
  inspection = inspectProject(project);
  const {errors, warnings} = inspection;
  const button = $("validation-button");
  button.dataset.state = errors.length ? "bad" : "ok";
  button.textContent = errors.length ? "入力エラー " + errors.length + " 件" :
    warnings.length ? "検証済み · 注意 " + warnings.length + " 件" : "入力チェック OK";
  document.querySelectorAll('[aria-invalid="true"]').forEach(element => element.removeAttribute("aria-invalid"));
  for (const issue of errors) {
    if (issue.field === "slaveAddress" || issue.field === "nvmSize") {
      configInputs[issue.field].setAttribute("aria-invalid", "true");
    }
    if (issue.row !== null) {
      $("register-body").querySelector(`tr[data-index="${issue.row}"] [data-field="${issue.field}"]`)
        ?.setAttribute("aria-invalid", "true");
    }
  }
}

function recordEdit() {
  refreshHtmlSaveState();
  message();
  updateValidation();
}

function optionList(values: readonly string[], selected: string, display: Record<string, string> = {}) {
  const items = values.includes(selected) ? values : [selected, ...values];
  return items.map(value => `<option value="${escapeHtml(value)}"${value === selected ? " selected" : ""}>${escapeHtml(display[value] ?? (value || "—"))}</option>`).join("");
}

function registerMarkup(row: DraftRegister, index: number) {
  const reserved = row.type === "reserved", string = row.type === "string";
  const label = (key: TableField) => LABELS[key] + " " + (index + 1) + " 行目";
  const attrs = (key: TableField) => `data-field="${key}" aria-label="${label(key)}"`;
  const input = (key: TableField, disabled = false, placeholder = "未入力") => `<td><input ${attrs(key)} value="${disabled ? UNUSED : escapeHtml(row[key])}" placeholder="${escapeHtml(placeholder)}"${disabled ? " disabled" : ""}></td>`;
  const type = `<td><select ${attrs("type")}>${optionList(TYPES, row.type, {reserved: "予約領域"})}</select></td>`;
  const access = reserved ? input("access", true) :
    `<td><select ${attrs("access")}>${optionList(ACCESS, row.access)}</select></td>`;
  const selection = row.enumDomain;
  const definition = selection && project.enums.find(item => item.id === selection.enumId);
  const member = definition && definition.members.find(item => item.id === selection?.defaultMemberId);
  const valueCells = selection ? `<td colspan="2" class="enum-cell">
    <span class="badge">列挙型</span> ${escapeHtml(definition?.label ?? "列挙型を選択")}
    </td><td class="enum-cell">${member ? escapeHtml(member.label) + "（" + member.value + "）" : "初期値を選択"}</td>` :
    input("min", reserved || string) + input("max", reserved || string) + input("default", reserved);
  return `<tr data-index="${index}">
    ${input("address")}${input("name")}${type}${input("length")}${access}${valueCells}${input("nvmOffset", reserved)}
    <td><button type="button" class="small" data-field="detail" aria-label="詳細 ${index + 1} 行目">詳細</button></td>
  </tr>`;
}

function renderTable() {
  const search = searchInput.value.trim().toLowerCase();
  const type = typeFilter.value;
  const matches = project.registers.map((row, index) => ({row, index})).filter(({row}) => {
    const address = unsigned(row.address);
    return (!type || row.type === type) && (!search ||
      [row.address, row.name, row.summary, address === null ? "" : "0x" + address.toString(16)]
        .some(value => value.toLowerCase().includes(search)));
  });
  $("register-body").innerHTML = matches.length ?
    matches.map(({row, index}) => registerMarkup(row, index)).join("") :
    '<tr><td colspan="10" class="empty">該当するレジスタはありません。</td></tr>';
  $("row-count").textContent = matches.length === project.registers.length ? matches.length + " 件" :
    matches.length + " / " + project.registers.length + " 件";
  updateValidation();
}

function renderLengths() {
  $("length-count").textContent = "(" + project.lengthDefs.length + ")";
  $("length-body").innerHTML = project.lengthDefs.map((row, index) =>
    `<tr data-index="${index}"><td><input data-field="name" aria-label="配列長定義名 ${index + 1} 行目" value="${escapeHtml(row.name)}"></td>
      <td><input data-field="length" aria-label="配列長 ${index + 1} 行目" value="${escapeHtml(row.length)}"></td>
      <td><button type="button" class="small danger" data-delete-length>削除</button></td></tr>`).join("");
}

function replaceProject(next: DraftProject, name: string, enumForm: EnumFormDraft | null = null) {
  project = next;
  sourceName = name;
  configInputs.slaveAddress.value = project.config.slaveAddress;
  configInputs.nvmSize.value = project.config.nvmSize;
  searchInput.value = "";
  typeFilter.value = "";
  renderSource();
  renderLengths();
  const enumIndex = enumForm ? enumForm.index : next.enums.length ? 0 : null;
  editEnum(enumIndex, enumForm ?? undefined);
  renderTable();
}

function showIssues() {
  const {errors, warnings} = inspection;
  const descriptions = [...errors.map(issue => issue.text), ...warnings.map(text => "注意　" + text)];
  $("issue-list").innerHTML = (descriptions.length ? descriptions : ["入力エラーはありません。"])
    .map(text => "<li>" + escapeHtml(text) + "</li>").join("");
  issueDialog.showModal();
}

function validatedForExport(): ValidatedProject | null {
  updateValidation();
  if (inspection.validated) return inspection.validated;
  message("入力エラーを修正してください。", true);
  showIssues();
  return null;
}

function openDetail(index: number) {
  const row = project.registers[index];
  if (!row) return;
  detailIndex = index;
  $("detail-title").textContent = row.name.trim() || "レジスタの詳細";
  for (const control of $("detail-body").querySelectorAll<TextControl>("[data-detail]")) {
    const key = control.dataset.detail;
    if (!isOneOf(FLAGS, key) && !isOneOf(DETAIL_TEXT_FIELDS, key)) continue;
    control.disabled = row.type === "reserved" && (isOneOf(FLAGS, key) || key === "groupValidate");
    control.value = control.disabled ? UNUSED : String(row[key]);
  }
  openEnumDetail(row);
  detailDialog.showModal();
}

function showCode() {
  const code = $("code");
  code.textContent = codeFiles[codeSelection.value] ?? "";
  code.scrollTop = 0;
}

function nextAddress() {
  const ranges = project.registers.map((row, index) => ({
    start: unsigned(row.address), count: inspection.counts[index]
  })).filter((range): range is {start: number; count: number} => range.start !== null && range.start <= 65535 && range.count !== null)
    .sort((a, b) => a.start - b.start);
  const end = ranges.reduce((max, range) => Math.max(max, range.start + range.count), 0);
  if (end <= 65535) return end;
  let candidate = 0;
  for (const range of ranges) {
    if (range.start > candidate) return candidate;
    candidate = Math.max(candidate, range.start + range.count);
  }
  return "";
}

$("open-json").addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", async () => {
  const file = fileInput.files?.[0];
  fileInput.value = "";
  if (!file) return;
  try {
    const input: unknown = JSON.parse((await file.text()).replace(/^\ufeff/, ""));
    const {project: next, hint} = decodeProject(input);
    requestProjectReplacement(() => {
      replaceProject(next, file.name);
      showEditorTab("register");
      message(hint);
    });
  } catch (error) {
    const reason = error instanceof SyntaxError ? "JSONの構文を確認してください。" :
      error instanceof Error ? error.message : "JSONを読み込めませんでした。";
    showEditorTab("register");
    message(reason, true);
  }
});
$("reset-sample").addEventListener("click", () => requestProjectReplacement(() => {
  replaceProject(sampleProject(), "サンプル");
  message("サンプルを開きました。");
}));
$("save-json").addEventListener("click", () => {
  const validated = validatedForExport();
  if (!validated) return;
  const filename = sourceName === "サンプル" || sourceName === "RegisterTable.json" ?
    "modbus-regmap.json" : sourceName;
  download(filename, JSON.stringify(validated.documentValue, null, 2) + "\n", "application/json");
  message("JSONのダウンロードを開始しました。");
});
$("open-code").addEventListener("click", () => {
  const validated = validatedForExport();
  if (!validated) return;
  codeFiles = generateModbusFiles(validated);
  codeSelection.replaceChildren(...Object.keys(codeFiles).map(filename => new Option(filename, filename)));
  showCode();
  codeDialog.showModal();
});
codeSelection.addEventListener("change", showCode);
$("save-zip").addEventListener("click", () => {
  download(CODE_ZIP, zipFiles(codeFiles), "application/zip");
  message("C/HのZIPダウンロードを開始しました。");
});
$("validation-button").addEventListener("click", showIssues);
for (const field of ["slaveAddress", "nvmSize"] as const) {
  const input = configInputs[field];
  input.addEventListener("input", () => {
    project.config[field] = input.value;
    recordEdit();
  });
}
searchInput.addEventListener("input", renderTable);
typeFilter.addEventListener("change", renderTable);
$("add-row").addEventListener("click", () => {
  const index = project.registers.length;
  project.registers.push(draftRow({address: nextAddress()}));
  searchInput.value = "";
  typeFilter.value = "";
  renderTable();
  recordEdit();
  $("register-body").querySelector<HTMLInputElement>(`tr[data-index="${index}"] [data-field="name"]`)?.focus();
});
$("register-body").addEventListener("input", event => {
  const {target} = event;
  if (!(target instanceof HTMLInputElement || target instanceof HTMLSelectElement)) return;
  const field = target.dataset.field;
  const index = rowIndex(target);
  if (!isOneOf(TABLE_FIELDS, field) || index === null) return;
  const row = project.registers[index];
  if (!row) return;
  const previousType = row.type;
  row[field] = target.value;
  if (field === "type") {
    if (row.type !== "reserved" && (previousType === "string") !== (row.type === "string")) row.default = "";
    if (row.type !== "reserved" && !isOneOf(ACCESS, row.access)) row.access = "RW";
    renderTable();
    $("register-body").querySelector<HTMLSelectElement>(`tr[data-index="${index}"] [data-field="type"]`)?.focus({preventScroll: true});
  }
  recordEdit();
});
$("register-body").addEventListener("click", event => {
  const {target} = event;
  if (!(target instanceof HTMLButtonElement) || target.dataset.field !== "detail") return;
  const index = rowIndex(target);
  if (index !== null) openDetail(index);
});
$("detail-body").addEventListener("input", event => {
  const {target} = event;
  if (!(target instanceof HTMLInputElement || target instanceof HTMLSelectElement || target instanceof HTMLTextAreaElement)) return;
  const row = project.registers[detailIndex];
  if (!row) return;
  const key = target.dataset.detail;
  if (isOneOf(FLAGS, key)) row[key] = target.value === "true";
  else if (isOneOf(DETAIL_TEXT_FIELDS, key)) row[key] = target.value;
  else return;
  recordEdit();
});
detailDialog.addEventListener("close", renderTable);
$("delete-row").addEventListener("click", () => {
  project.registers.splice(detailIndex, 1);
  detailDialog.close();
  recordEdit();
  renderTable();
});
$("open-lengths").addEventListener("click", () => lengthDialog.showModal());
$("add-length").addEventListener("click", () => {
  project.lengthDefs.push({name: "", length: "1"});
  renderLengths();
  recordEdit();
  $("length-body").querySelector<HTMLInputElement>("tr:last-child input")?.focus();
});
$("length-body").addEventListener("input", event => {
  const {target} = event;
  if (!(target instanceof HTMLInputElement)) return;
  const field = target.dataset.field;
  const index = rowIndex(target);
  if ((field !== "name" && field !== "length") || index === null) return;
  const row = project.lengthDefs[index];
  if (!row) return;
  row[field] = target.value;
  recordEdit();
});
$("length-body").addEventListener("click", event => {
  const {target} = event;
  if (!(target instanceof HTMLButtonElement) || !Object.hasOwn(target.dataset, "deleteLength")) return;
  const index = rowIndex(target);
  if (index === null) return;
  project.lengthDefs.splice(index, 1);
  renderLengths();
  recordEdit();
});
document.querySelectorAll("[data-close]").forEach(button => {
  button.addEventListener("click", () => button.closest("dialog")?.close());
});
initializeHtmlSave();
