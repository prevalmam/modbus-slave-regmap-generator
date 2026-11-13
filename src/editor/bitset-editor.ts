type BitsetFormDraft = {
  index: number | null;
  id: string;
  label: string;
  width: string;
  bits: {bit: string; id: string; label: string}[];
};

const bitsetId = $("bitset-id", HTMLInputElement);
const bitsetLabel = $("bitset-label", HTMLInputElement);
const bitsetWidth = $("bitset-width", HTMLSelectElement);
const bitsetRows = $("bitset-bits");
let editedBitset: number | null = null;
let bitsetFormBaseline = "";

function readBitsetForm(): BitsetFormDraft {
  return {index: editedBitset, id: bitsetId.value, label: bitsetLabel.value, width: bitsetWidth.value,
    bits: Array.from(bitsetRows.querySelectorAll("tr"), row => {
      const value = (key: string) => row.querySelector<HTMLInputElement>(`[data-bit="${key}"]`)!.value;
      return {bit: value("bit"), id: value("id"), label: value("label")};
    })};
}

function pendingBitsetForm(): BitsetFormDraft | null {
  const form = readBitsetForm();
  return JSON.stringify(form) === bitsetFormBaseline ? null : form;
}

function appendBitsetBit(bit?: RegisterBit | BitsetFormDraft["bits"][number]) {
  bitsetRows.insertAdjacentHTML("beforeend", `<tr>
    <td><input data-bit="bit" type="number" min="0" max="31" step="1" aria-label="ビット番号" required value="${escapeHtml(String(bit?.bit ?? ""))}"></td>
    <td><input data-bit="id" aria-label="ビット識別名" required value="${escapeHtml(bit?.id ?? "")}"></td>
    <td><input data-bit="label" aria-label="ビット表示名" required value="${escapeHtml(bit?.label ?? "")}"></td>
    <td><code data-bit-mask></code></td><td><button type="button" data-remove-bit class="small danger">削除</button></td>
  </tr>`);
  renderBitMasks();
}

function renderBitMasks() {
  const width = Number(bitsetWidth.value);
  for (const row of bitsetRows.querySelectorAll("tr")) {
    const bit = unsigned(row.querySelector<HTMLInputElement>('[data-bit="bit"]')!.value);
    row.querySelector<HTMLElement>("[data-bit-mask]")!.textContent = bit !== null && bit < width ? bitsetHex(2 ** bit, width) : "—";
  }
}

function editBitset(index: number | null, draft?: BitsetFormDraft) {
  const definition = index === null ? undefined : project.bitsetDefs[index];
  editedBitset = index;
  bitsetId.value = definition?.id ?? "";
  bitsetLabel.value = definition?.label ?? "";
  bitsetWidth.value = String(definition?.width ?? 16);
  bitsetRows.replaceChildren();
  if (definition) definition.bits.forEach(appendBitsetBit);
  else appendBitsetBit();
  bitsetFormBaseline = JSON.stringify(readBitsetForm());
  if (draft) {
    bitsetId.value = draft.id; bitsetLabel.value = draft.label; bitsetWidth.value = draft.width;
    bitsetRows.replaceChildren(); draft.bits.forEach(appendBitsetBit);
  }
  $("bitset-status").textContent = "";
  $("bitset-list").innerHTML = project.bitsetDefs.map((item, i) => `<li><button type="button" data-bitset-index="${i}" aria-pressed="${i === editedBitset}">${escapeHtml(item.label)} <code>${escapeHtml(item.id)} (${item.width} bit)</code></button></li>`).join("") || "<li>登録済みのビット定義はありません。</li>";
  renderBitMasks();
}

$("bitset-list").addEventListener("click", ({target}) => {
  if (!(target instanceof HTMLElement)) return;
  const button = target.closest<HTMLElement>("[data-bitset-index]");
  if (!button) return;
  editBitset(Number(button.dataset.bitsetIndex)); refreshHtmlSaveState();
});
$("bitset-add").addEventListener("click", () => {editBitset(null); refreshHtmlSaveState(); bitsetId.focus();});
$("bitset-add-bit").addEventListener("click", () => {appendBitsetBit(); refreshHtmlSaveState();});
bitsetRows.addEventListener("click", ({target}) => {
  if (target instanceof HTMLButtonElement && target.hasAttribute("data-remove-bit")) {
    target.closest("tr")?.remove(); refreshHtmlSaveState();
  }
});
$("bitset-form").addEventListener("input", () => {renderBitMasks(); refreshHtmlSaveState();});
$("bitset-form").addEventListener("submit", event => {
  event.preventDefault();
  const form = readBitsetForm();
  const definition: BitsetDefinition = {id: form.id.trim(), label: form.label.trim(), width: Number(form.width) as 16 | 32,
    bits: form.bits.map(bit => ({bit: unsigned(bit.bit) ?? -1, id: bit.id.trim(), label: bit.label.trim()}))};
  const error = bitsetDefinitionError(definition) || (project.bitsetDefs.some((item, index) => index !== editedBitset && item.id === definition.id) ? "定義IDが重複しています。" : "");
  $("bitset-status").classList.toggle("error", Boolean(error));
  if (error) {$("bitset-status").textContent = error; return;}
  const index = editedBitset ?? project.bitsetDefs.length, previous = project.bitsetDefs[index];
  if (previous && previous.id !== definition.id) {
    for (const row of project.registers) if (row.bitsetDomain?.bitsetId === previous.id) row.bitsetDomain.bitsetId = definition.id;
  }
  project.bitsetDefs[index] = definition;
  editBitset(index); renderTable(); recordEdit(); $("bitset-status").textContent = "登録しました。";
});

const detailBitset = $("bitset-detail-type", HTMLSelectElement);
const detailBitsetHex = $("bitset-detail-default", HTMLInputElement);

function supportsBitset(row: DraftRegister) {
  const length = unsigned(row.length) ?? unsigned(project.lengthDefs.find(entry => entry.name.trim() === row.length.trim())?.length ?? "");
  return (row.type === "uint16_t" || row.type === "uint32_t") && length === 1;
}

function renderBitsetDetailMode() {
  document.querySelectorAll<HTMLElement>("[data-bitset-detail]").forEach(item => {item.hidden = detailKind.value !== "bitset";});
}

function renderBitsetDefaultBits() {
  const definition = project.bitsetDefs.find(item => item.id === detailBitset.value);
  const raw = unsigned(detailBitsetHex.value);
  $("bitset-detail-bits").innerHTML = definition?.bits.map(bit => `<label><input type="checkbox" data-default-bit="${bit.bit}"${raw !== null && Math.floor(raw / 2 ** bit.bit) % 2 === 1 ? " checked" : ""}> ${bit.bit}: ${escapeHtml(bit.label)}</label>`).join("") ?? "";
}

function openBitsetDetail(row: DraftRegister) {
  const width = row.type === "uint32_t" ? 32 : 16;
  detailBitset.replaceChildren(new Option("ビット定義を選択", "", true, true),
    ...project.bitsetDefs.filter(item => item.width === width).map(item => new Option(item.label, item.id)));
  if (row.bitsetDomain) detailBitset.value = row.bitsetDomain.bitsetId;
  detailBitsetHex.value = row.bitsetDomain ? row.default : bitsetHex(unsigned(row.default) ?? 0, width);
  renderBitsetDefaultBits();
}

function updateBitsetSelection() {
  const row = project.registers[detailIndex];
  if (!row || detailKind.value !== "bitset") return;
  row.default = detailBitsetHex.value;
  row.bitsetDomain = {kind: "bitset", bitsetId: detailBitset.value,
    default: unsigned(detailBitsetHex.value) ?? row.bitsetDomain?.default ?? 0};
}

detailBitset.addEventListener("change", () => {updateBitsetSelection(); renderBitsetDefaultBits(); recordEdit();});
detailBitsetHex.addEventListener("input", () => {updateBitsetSelection(); renderBitsetDefaultBits(); recordEdit();});
$("bitset-detail-bits").addEventListener("input", ({target}) => {
  if (!(target instanceof HTMLInputElement) || target.dataset.defaultBit === undefined) return;
  const bit = Number(target.dataset.defaultBit), raw = unsigned(detailBitsetHex.value) ?? 0, mask = 2 ** bit;
  const wasOn = Math.floor(raw / mask) % 2 === 1;
  const value = raw + (target.checked === wasOn ? 0 : target.checked ? mask : -mask);
  detailBitsetHex.value = bitsetHex(value, project.registers[detailIndex].type === "uint32_t" ? 32 : 16);
  updateBitsetSelection(); recordEdit();
});
