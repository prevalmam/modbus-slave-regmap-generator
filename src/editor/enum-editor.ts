type EditorTab = "register" | "enum";
const editorTabs: readonly EditorTab[] = ["register", "enum"];

function showEditorTab(active: EditorTab) {
  for (const name of editorTabs) {
    const tab = $(name + "-tab");
    tab.setAttribute("aria-selected", String(name === active));
    tab.tabIndex = name === active ? 0 : -1;
    $(name + "-panel").hidden = name !== active;
  }
  $("register-actions").hidden = active !== "register";
}

for (const name of editorTabs) {
  const tab = $(name + "-tab");
  tab.addEventListener("click", () => showEditorTab(name));
  tab.addEventListener("keydown", event => {
    let next: EditorTab;
    switch (event.key) {
      case "Home": next = "register"; break;
      case "End": next = "enum"; break;
      case "ArrowLeft":
      case "ArrowRight": next = name === "register" ? "enum" : "register"; break;
      default: return;
    }
    event.preventDefault();
    showEditorTab(next);
    $(next + "-tab").focus();
  });
}

const enumId = $("enum-id", HTMLInputElement);
const enumLabel = $("enum-label", HTMLInputElement);
const enumMembers = $("enum-members");
const enumList = $("enum-list");
let editedEnum: number | null = null;
let enumFormBaseline = "";
type EnumFormDraft = {
  index: number | null;
  id: string;
  label: string;
  members: {id: string; value: string; label: string}[];
};

function enumStatus(message: string, error = false) {
  const status = $("enum-status");
  status.textContent = message;
  status.classList.toggle("error", error);
}

function appendEnumMember(member?: EnumMember | EnumFormDraft["members"][number]) {
  enumMembers.insertAdjacentHTML("beforeend", `<tr>
    <td><input data-member="id" aria-label="選択肢ID" required pattern="[a-z][a-z0-9_]*" value="${escapeHtml(member?.id ?? "")}"></td>
    <td><input data-member="value" aria-label="Modbus値" type="number" min="0" max="65535" step="1" required value="${escapeHtml(String(member?.value ?? ""))}"></td>
    <td><input data-member="label" aria-label="選択肢の表示名" required value="${escapeHtml(member?.label ?? "")}"></td>
    <td><button type="button" class="small danger" data-remove-member>削除</button></td>
  </tr>`);
}

function renderEnumList() {
  enumList.innerHTML = project.enums.map((definition, index) => `<li>
    <button type="button" data-enum-index="${index}" aria-pressed="${editedEnum === index}">
      ${escapeHtml(definition.label)} <code>${escapeHtml(definition.id)}</code>
    </button>
  </li>`).join("") || "<li>登録済みの列挙型はありません。</li>";
}

function readEnumForm(): EnumFormDraft {
  const members = Array.from(enumMembers.querySelectorAll("tr"), row => {
    const value = (name: string) => row.querySelector<HTMLInputElement>(`[data-member="${name}"]`)!.value;
    return {id: value("id"), value: value("value"), label: value("label")};
  });
  return {index: editedEnum, id: enumId.value, label: enumLabel.value, members};
}

function pendingEnumForm(): EnumFormDraft | null {
  const form = readEnumForm();
  return JSON.stringify(form) === enumFormBaseline ? null : form;
}

function editEnum(index: number | null, draft?: EnumFormDraft) {
  const definition = index === null ? undefined : project.enums[index];
  editedEnum = index;
  enumId.value = definition?.id ?? "";
  enumLabel.value = definition?.label ?? "";
  enumMembers.replaceChildren();
  if (definition) definition.members.forEach(appendEnumMember);
  else appendEnumMember();
  enumFormBaseline = JSON.stringify(readEnumForm());
  if (draft) {
    enumId.value = draft.id;
    enumLabel.value = draft.label;
    enumMembers.replaceChildren();
    draft.members.forEach(appendEnumMember);
  }
  enumStatus("");
  renderEnumList();
}

enumList.addEventListener("click", ({target}) => {
  if (!(target instanceof HTMLElement)) return;
  const button = target.closest<HTMLButtonElement>("[data-enum-index]");
  if (!button) return;
  editEnum(Number(button.dataset.enumIndex));
  refreshHtmlSaveState();
  enumList.querySelector<HTMLElement>('[aria-pressed="true"]')?.focus();
});
$("enum-add").addEventListener("click", () => {
  editEnum(null);
  refreshHtmlSaveState();
  enumId.focus();
});
$("enum-add-member").addEventListener("click", () => {
  appendEnumMember();
  refreshHtmlSaveState();
  enumMembers.querySelector<HTMLInputElement>("tr:last-child input")?.focus();
});
enumMembers.addEventListener("click", ({target}) => {
  if (target instanceof HTMLButtonElement && target.hasAttribute("data-remove-member")) {
    target.closest("tr")?.remove();
    refreshHtmlSaveState();
    $("enum-add-member").focus();
  }
});

const enumForm = $("enum-form", HTMLFormElement);
enumForm.addEventListener("input", () => refreshHtmlSaveState());
enumForm.addEventListener("submit", event => {
  event.preventDefault();
  const members = readEnumForm().members.map(member => ({
    id: member.id.trim(), value: Number(member.value), label: member.label.trim()
  }));
  const definition = {id: enumId.value, label: enumLabel.value.trim(), members};
  const error = enumDefinitionError(definition);
  if (error) {
    enumStatus(error, true);
    return;
  }
  if (project.enums.some((item, index) => index !== editedEnum && item.id === definition.id)) {
    enumStatus("型IDが重複しています。", true);
    return;
  }
  const index = editedEnum ?? project.enums.length;
  const previous = project.enums[index];
  if (previous && previous.id !== definition.id) {
    for (const row of project.registers) {
      if (row.enumDomain?.enumId === previous.id) row.enumDomain.enumId = definition.id;
    }
  }
  project.enums[index] = definition;
  editEnum(index);
  renderTable();
  recordEdit();
  enumStatus("登録しました。");
});

const detailKind = $("enum-detail-kind", HTMLSelectElement);
const detailEnum = $("enum-detail-type", HTMLSelectElement);
const detailDefault = $("enum-detail-default", HTMLSelectElement);

function renderEnumDetailMembers(defaultId = "") {
  const definition = project.enums.find(item => item.id === detailEnum.value);
  detailDefault.disabled = !definition;
  detailDefault.replaceChildren(new Option("初期値を選択", "", true, true),
    ...(definition?.members.map(member => new Option(member.label + "（" + member.value + "）", member.id)) ?? []));
  if (definition?.members.some(member => member.id === defaultId)) detailDefault.value = defaultId;
}

function renderEnumDetailMode() {
  document.querySelectorAll<HTMLElement>("[data-enum-detail]").forEach(label => {
    label.hidden = detailKind.value !== "enum";
  });
}

function supportsEnum(row: DraftRegister) {
  const length = unsigned(row.length) ?? unsigned(project.lengthDefs.find(entry => entry.name.trim() === row.length.trim())?.length ?? "");
  return row.type === "uint16_t" && length === 1;
}

function openEnumDetail(row: DraftRegister) {
  const selection = row.enumDomain;
  const eligible = supportsEnum(row);
  $("enum-detail").hidden = !eligible && !selection;
  detailKind.options[1].disabled = !eligible;
  detailKind.value = selection ? "enum" : "range";
  detailEnum.replaceChildren(new Option("列挙型を選択", "", true, true),
    ...project.enums.map(definition => new Option(definition.label, definition.id)));
  if (selection && project.enums.some(definition => definition.id === selection.enumId)) detailEnum.value = selection.enumId;
  renderEnumDetailMode();
  renderEnumDetailMembers(selection?.defaultMemberId);
}

function updateEnumSelection() {
  const row = project.registers[detailIndex];
  if (!row) return;
  row.enumDomain = detailKind.value === "enum" ?
    {kind: "enum", enumId: detailEnum.value, defaultMemberId: detailDefault.value} : null;
  recordEdit();
}

detailKind.addEventListener("change", () => {
  renderEnumDetailMode();
  updateEnumSelection();
});
detailEnum.addEventListener("change", () => {
  renderEnumDetailMembers();
  updateEnumSelection();
});
detailDefault.addEventListener("change", updateEnumSelection);
