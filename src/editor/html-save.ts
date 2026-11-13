type EditorHtmlDraft = {
  version: 1;
  sourceName: string;
  project: DraftProject;
  enumForm: EnumFormDraft | null;
  bitsetForm?: BitsetFormDraft | null;
};
type SaveHtmlPicker = (options: {
  id: string;
  suggestedName: string;
  types: {description: string; accept: Record<string, string[]>}[];
}) => Promise<FileSystemFileHandle>;

const htmlTemplate = document.documentElement.cloneNode(true) as HTMLElement;
const embeddedHtmlDraft = htmlTemplate.querySelector<HTMLScriptElement>("#html-project-data")!;
const saveHtmlButton = $("save-html", HTMLButtonElement);
const restoreHtmlButton = $("restore-html", HTMLButtonElement);
const unsavedHtmlDialog = $("html-unsaved-dialog", HTMLDialogElement);
const saveLocationDialog = $("html-save-location", HTMLDialogElement);
const unsavedHtmlButtons = Array.from(unsavedHtmlDialog.querySelectorAll("button"));
let savedHtmlDraft = "";
let htmlFileHandle: FileSystemFileHandle | undefined;
let lastWrittenHtml: string | undefined;
let htmlDirty = false;
let htmlSaving = false;
let pendingReplacement: (() => void) | undefined;

function parseHtmlDraft(text: string): EditorHtmlDraft | null {
  const value: unknown = JSON.parse(text);
  if (value === null) return null;
  const invalid = "HTML内の編集データを読み込めませんでした。";
  const textFields = (input: unknown, fields: readonly string[]): input is Record<string, unknown> =>
    isObject(input) && fields.every(field => typeof input[field] === "string");
  if (!isObject(value) || value.version !== 1 || typeof value.sourceName !== "string" ||
      !isObject(value.project)) throw Error(invalid);
  const {config, enums, lengthDefs, registers} = value.project;
  if (!textFields(config, ["slaveAddress", "nvmSize"]) ||
      !isList(lengthDefs) || !lengthDefs.every(row => textFields(row, ["name", "length"])) ||
      !isList(enums) || !isList(registers)) throw Error(invalid);
  const groups = value.project.resetGroupDefs ?? [];
  if (!isList(groups) || !groups.every(group => textFields(group, ["id", "label"]))) throw Error(invalid);
  value.project.resetGroupDefs = groups;
  const bitsets = value.project.bitsetDefs ?? [];
  if (!isList(bitsets)) throw Error(invalid);
  bitsets.forEach(item => decodeBitset(item, invalid));
  value.project.bitsetDefs = bitsets;
  enums.forEach(item => decodeEnum(item, invalid));
  for (const row of registers) {
    if (!textFields(row, TEXT_FIELDS) || !FLAGS.every(key => typeof row[key] === "boolean")) throw Error(invalid);
    const memberships = row.resetGroups ?? [];
    if (!isList(memberships) || !memberships.every(id => typeof id === "string")) throw Error(invalid);
    row.resetGroups = memberships;
    const bitset = row.bitsetDomain ?? null;
    if (bitset !== null && (!isObject(bitset) || bitset.kind !== "bitset" ||
        typeof bitset.bitsetId !== "string" || typeof bitset.default !== "number")) throw Error(invalid);
    row.bitsetDomain = bitset;
    const domain = row.enumDomain;
    if (domain !== null && (!textFields(domain, ["enumId", "defaultMemberId"]) || domain.kind !== "enum")) {
      throw Error(invalid);
    }
  }
  const form = value.enumForm;
  if (form !== null && (!textFields(form, ["id", "label"]) ||
      (form.index !== null && (typeof form.index !== "number" || !Number.isInteger(form.index) ||
        form.index < 0 || form.index >= enums.length)) ||
      !isList(form.members) || !form.members.every(member => textFields(member, ["id", "value", "label"])))) {
    throw Error(invalid);
  }
  const bitsetForm = value.bitsetForm ?? null;
  if (bitsetForm !== null && (!textFields(bitsetForm, ["id", "label", "width"]) ||
      (bitsetForm.index !== null && (typeof bitsetForm.index !== "number" || !Number.isInteger(bitsetForm.index) ||
        bitsetForm.index < 0 || bitsetForm.index >= bitsets.length)) ||
      !isList(bitsetForm.bits) || !bitsetForm.bits.every(bit => textFields(bit, ["bit", "id", "label"])))) throw Error(invalid);
  value.bitsetForm = bitsetForm;
  return value as EditorHtmlDraft;
}

function currentHtmlDraft(): string {
  const draft: EditorHtmlDraft = {version: 1, sourceName, project, enumForm: pendingEnumForm(), bitsetForm: pendingBitsetForm()};
  return JSON.stringify(draft);
}

function confirmLeavingHtml(event: BeforeUnloadEvent) {
  event.preventDefault();
  event.returnValue = true;
}

function refreshHtmlSaveState() {
  const dirty = currentHtmlDraft() !== savedHtmlDraft;
  if (dirty !== htmlDirty) {
    if (dirty) {
      window.addEventListener("beforeunload", confirmLeavingHtml);
      if (!htmlSaving) htmlSaveMessage("");
    } else window.removeEventListener("beforeunload", confirmLeavingHtml);
    htmlDirty = dirty;
  }
  const state = $("html-save-state");
  state.dataset.dirty = String(dirty);
  state.textContent = htmlSaving ? "保存中" : dirty ? "未保存" : "保存済み";
  saveHtmlButton.disabled = htmlSaving || !dirty;
  restoreHtmlButton.disabled = htmlSaving;
  $("open-json", HTMLButtonElement).disabled = htmlSaving;
  for (const button of unsavedHtmlButtons) button.disabled = htmlSaving;
}

function htmlSaveMessage(text: string, error = false) {
  const message = $(unsavedHtmlDialog.open ? "html-unsaved-message" : "html-save-message");
  message.textContent = text;
  message.classList.toggle("error", error);
}

function decodeLocationPath(path: string) {
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

const localHtmlPath = location.protocol === "file:" ? location.pathname : "";
const slash = localHtmlPath.lastIndexOf("/");
const htmlFilename = decodeLocationPath(localHtmlPath.slice(slash + 1)) || "modbus-regmap-editor.html";
const localFolder = decodeLocationPath(localHtmlPath.slice(0, slash + 1));
const htmlFolder = location.protocol === "file:" && location.hostname
  ? ("//" + location.hostname + localFolder).replaceAll("/", "\\")
  : /^\/[a-z]:\//i.test(localFolder) ? localFolder.slice(1).replaceAll("/", "\\") : localFolder;
$("html-folder-path").textContent = htmlFolder;

async function chooseHtmlFile(picker: SaveHtmlPicker): Promise<FileSystemFileHandle> {
  const openPicker = () => picker.call(window, {
    id: "modbus-regmap-editor-html",
    suggestedName: htmlFilename,
    types: [{description: "HTMLファイル", accept: {"text/html": [".html", ".htm"]}}]
  });
  if (!htmlFolder) return openPicker();

  let copied = false;
  try {
    await navigator.clipboard.writeText(htmlFolder);
    copied = true;
  } catch {
    // The visible path can still be copied manually.
  }
  $("html-save-location-title").textContent = copied
    ? "フォルダーのパスをコピーしました"
    : "フォルダーのパスをコピーできませんでした";
  $("html-copy-fallback").hidden = copied;

  return new Promise((resolve, reject) => {
    const listeners = new AbortController();
    const options = {signal: listeners.signal};
    const close = () => {
      listeners.abort();
      saveLocationDialog.close();
    };
    const cancel = (event: Event) => {
      event.preventDefault();
      close();
      reject(new DOMException("Save cancelled", "AbortError"));
    };
    saveLocationDialog.addEventListener("cancel", cancel, options);
    $("html-cancel-picker").addEventListener("click", cancel, options);
    $("html-open-picker").addEventListener("click", async () => {
      close();
      try {
        resolve(await openPicker());
      } catch (error) {
        reject(error);
      }
    }, options);
    saveLocationDialog.showModal();
  });
}

async function saveEditorHtml(): Promise<boolean> {
  if (htmlSaving) return false;
  if (!htmlDirty) return true;
  const picker = (window as Window & {showSaveFilePicker?: SaveHtmlPicker}).showSaveFilePicker;
  if (!picker) {
    htmlSaveMessage("HTMLの上書き保存に対応したChromeまたはEdgeで開いてください。", true);
    return false;
  }

  htmlSaving = true;
  refreshHtmlSaveState();
  let stream: FileSystemWritableFileStream | undefined;
  try {
    const handle = htmlFileHandle ?? await chooseHtmlFile(picker);
    const existing = await (await handle.getFile()).text();
    if (existing && !/<html\b[^>]*\bdata-modbus-regmap-editor="1"/i.test(existing)) {
      throw Error("このエディターのHTMLか、新しいHTMLファイルを保存先に選んでください。");
    }
    if (htmlFileHandle && existing !== lastWrittenHtml) {
      htmlFileHandle = undefined;
      throw Error("保存先が別の画面で変更されています。次の保存で保存先を選び直してください。");
    }
    const draft = currentHtmlDraft();
    embeddedHtmlDraft.textContent = draft.replace(/</g, "\\u003c");
    const html = "<!doctype html>\n" + htmlTemplate.outerHTML + "\n";
    stream = await handle.createWritable();
    await stream.write(html);
    await stream.close();
    htmlFileHandle = handle;
    lastWrittenHtml = html;
    savedHtmlDraft = draft;
    htmlSaveMessage(handle.name + " に保存しました。");
    return currentHtmlDraft() === savedHtmlDraft;
  } catch (error) {
    if (stream) await stream.abort().catch(() => {});
    if (error instanceof DOMException && (error.name === "NotAllowedError" || error.name === "NotFoundError")) {
      htmlFileHandle = undefined;
    }
    const reason = error instanceof DOMException && error.name === "AbortError" ? "保存をキャンセルしました。" :
      error instanceof Error ? "保存できませんでした。 " + error.message : "保存できませんでした。";
    htmlSaveMessage(reason, true);
    return false;
  } finally {
    htmlSaving = false;
    refreshHtmlSaveState();
  }
}

function requestProjectReplacement(action: () => void) {
  if (htmlSaving || pendingReplacement) return;
  if (htmlDirty) {
    pendingReplacement = action;
    $("html-unsaved-message").textContent = "";
    unsavedHtmlDialog.showModal();
  } else {
    action();
    refreshHtmlSaveState();
  }
}

function finishProjectReplacement(proceed: boolean) {
  const action = pendingReplacement;
  pendingReplacement = undefined;
  unsavedHtmlDialog.close();
  if (proceed && action) {
    action();
    refreshHtmlSaveState();
  }
}

function applyHtmlDraft(draft: EditorHtmlDraft) {
  replaceProject(draft.project, draft.sourceName, draft.enumForm, draft.bitsetForm);
  showEditorTab(draft.bitsetForm ? "bitset" : draft.enumForm ? "enum" : "register");
}

function initializeHtmlSave() {
  let draft: EditorHtmlDraft | null = null;
  try {
    draft = parseHtmlDraft(embeddedHtmlDraft.textContent);
  } catch {
    htmlSaveMessage("HTML内の編集データを読み込めませんでした。", true);
  }
  if (draft) applyHtmlDraft(draft);
  else replaceProject(project, sourceName);
  savedHtmlDraft = currentHtmlDraft();
  refreshHtmlSaveState();
}

saveHtmlButton.addEventListener("click", () => { void saveEditorHtml(); });
restoreHtmlButton.addEventListener("click", () => requestProjectReplacement(() => {
  const draft = parseHtmlDraft(savedHtmlDraft);
  if (draft) applyHtmlDraft(draft);
  htmlSaveMessage("保存済みの内容を読み直しました。");
}));
$("html-save-and-continue").addEventListener("click", async () => {
  if (await saveEditorHtml()) finishProjectReplacement(true);
});
$("html-discard-and-continue").addEventListener("click", () => finishProjectReplacement(true));
$("html-unsaved-cancel").addEventListener("click", () => finishProjectReplacement(false));
unsavedHtmlDialog.addEventListener("cancel", event => {
  event.preventDefault();
  if (!htmlSaving) finishProjectReplacement(false);
});
window.addEventListener("keydown", event => {
  if (!event.ctrlKey || event.altKey || event.shiftKey || event.metaKey || event.key.toLowerCase() !== "s") return;
  event.preventDefault();
  if (!event.repeat && !unsavedHtmlDialog.open) void saveEditorHtml();
});
