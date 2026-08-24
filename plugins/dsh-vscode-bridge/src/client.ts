/**
 * dsh-vscode-bridge client plugin: clear zoom and clipboard relay.
 *
 * VS Code webviews deny clipboard access to cross-origin iframes (even with
 * sandbox/allow attributes — microsoft/vscode#182642), and two keyboard
 * shortcuts are especially unreliable inside iframes:
 * - Cmd/Ctrl+C/X's DOM copy/cut events may not fire for a focused selection
 *   (VS Code's webview consumes the shortcut), and
 * - Cmd/Ctrl+V's DOM paste event is swallowed: VS Code/Electron runs its own
 *   programmatic paste, which does not dispatch a DOM paste event and is
 *   denied across origins.
 * Typing works (keyboard events DO reach the iframe), so we use the
 * keydown fallback to intercept Cmd/Ctrl+C/X/V, plus the DOM copy/cut/paste
 * events when they do fire. Both paths relay through the extension host,
 * which operates the system clipboard with the VS Code API.
 *
 * This plugin runs inside the DSH GUI, embedded as an iframe by the
 * dsh-sessions extension:
 * - listens for copy/cut/paste and keydown (capture phase, before React),
 * - forwards copied text / a read request to window.parent,
 * - patches `navigator.clipboard.writeText` so in-page "copy" buttons work,
 * - receives the host's clipboard text and injects it into the focused
 *   editable element via the NATIVE value setter on the element prototype
 *   (the React-compatible mutation; `document.execCommand` is disabled
 *   inside VS Code webviews).
 *
 * It only activates when embedded (window.parent differs); a normal browser
 * tab is untouched.
 */

interface HostMessage {
  source?: string;
  type?: string;
  text?: string;
  dataUrl?: string;
  scale?: number;
  requestId?: number;
}

/** Messages this plugin posts up to the embedding webview document. */
type BridgeMessage =
  | { source: "dsh-vscode-bridge"; type: "ready" }
  | { source: "dsh-vscode-bridge"; type: "write"; text: string }
  | { source: "dsh-vscode-bridge"; type: "read" }
  | {
      source: "dsh-vscode-bridge";
      type: "clearZoomApplied";
      scale: number;
      requestId: number;
    };

const BRIDGE_SOURCE = "dsh-vscode-bridge";
const HOST_SOURCE = "dsh-vscode-bridge-host";
// A single copy/paste gesture can reach several event paths (keydown, DOM
// copy/paste, VS Code's synthesized events). 800ms comfortably covers them
// without merging separate deliberate actions.
const DEDUPE_MS = 800;

/** The element that requested the paste, so we can inject into it later. */
let pasteTarget: Element | null = null;

/** Dedupe: several event paths (paste event + keydown) can fire per gesture. */
let lastReadAt = 0;
let lastWriteAt = 0;

function isEmbedded(): boolean {
  try {
    return window.parent !== window;
  } catch {
    return true; // cross-origin parent access throws; that means embedded
  }
}

function postToHost(message: BridgeMessage): void {
  try {
    window.parent.postMessage(message, "*");
  } catch {
    // ignore
  }
}

/** Set the value through the prototype's native setter (React-compatible). */
function setNativeValue(
  el: HTMLTextAreaElement | HTMLInputElement,
  value: string,
): void {
  const proto =
    el instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  if (typeof setter === "function") {
    setter.call(el, value);
  } else {
    el.value = value; // last resort
  }
}

/** Text currently selected in the focused editable element (textarea/input). */
function selectedEditableText(): string {
  const el = document.activeElement;
  if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) {
    const start = el.selectionStart ?? 0;
    const end = el.selectionEnd ?? 0;
    if (start !== end) return el.value.slice(start, end);
  }
  return "";
}

/** Current page selection as text (works for non-input selections too). */
function pageSelectionText(): string {
  const sel = window.getSelection();
  return sel === null ? "" : sel.toString();
}

/** Send a read request to the host (deduped across event paths). */
function requestRead(): void {
  const now = Date.now();
  if (now - lastReadAt < DEDUPE_MS) return;
  lastReadAt = now;
  pasteTarget = document.activeElement;
  postToHost({ source: BRIDGE_SOURCE, type: "read" });
}

/** Send copied text to the host (deduped across event paths). */
function requestWrite(text: string): void {
  if (text === "") return;
  const now = Date.now();
  if (now - lastWriteAt < DEDUPE_MS) return;
  lastWriteAt = now;
  postToHost({ source: BRIDGE_SOURCE, type: "write", text });
}

function handleCopyCut(event: ClipboardEvent): void {
  event.preventDefault();
  // Stop the event so DSH's own onCopy/onCut never sees it (it would write
  // the system clipboard through a blocked path or double-handle). We own
  // copy/cut entirely via the host bridge.
  event.stopPropagation();
  let text = "";
  try {
    text = event.clipboardData?.getData("text/plain") ?? "";
  } catch {
    text = "";
  }
  if (text === "") text = selectedEditableText();
  if (text === "") text = pageSelectionText();
  requestWrite(text);
}

function handlePaste(event: ClipboardEvent): void {
  // The system paste is blocked in webviews; read via the host instead.
  event.preventDefault();
  // Stop the event before it reaches DSH's React onPaste, which would insert
  // the text a second time and duplicate the paste.
  event.stopPropagation();
  requestRead();
}

/**
 * Keydown fallback for Cmd/Ctrl+C/X/V. DOM copy/cut/paste events do not
 * always fire inside VS Code webview iframes (the shortcuts are consumed
 * and replaced with a programmatic paste that never dispatches a DOM
 * event), but keydown itself reliably reaches the iframe — typing works.
 */
function handleKeyDown(event: KeyboardEvent): void {
  if (!(event.metaKey || event.ctrlKey)) return;
  const key = event.key.toLowerCase();
  const isPlain = !event.shiftKey && !event.altKey;
  if (key === "v" && isPlain) {
    // Take over paste: prevent the (broken) programmatic paste and read
    // the clipboard through the host instead.
    event.preventDefault();
    event.stopPropagation();
    requestRead();
  } else if (key === "c" && isPlain) {
    event.preventDefault();
    event.stopPropagation();
    requestWrite(selectedEditableText() || pageSelectionText());
  } else if (key === "x" && isPlain) {
    event.preventDefault();
    event.stopPropagation();
    const text = selectedEditableText() || pageSelectionText();
    requestWrite(text);
    // A real cut also removes the selected text from the editable element.
    // (VS Code's native cut path is denied across origins, so we perform
    // the deletion ourselves through the React-compatible native setter.)
    cutSelectedText();
  } else if (key === "a" && isPlain) {
    // Cmd/Ctrl+A: VS Code may swallow the shortcut (select-all in the
    // editor) before the iframe's textarea gets its native select-all.
    // When the focus is an editable element, take it over and select it.
    const el = document.activeElement;
    if (
      el instanceof HTMLTextAreaElement ||
      el instanceof HTMLInputElement ||
      (el instanceof HTMLElement && el.isContentEditable)
    ) {
      event.preventDefault();
      event.stopPropagation();
      if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) {
        el.select();
      } else {
        const range = document.createRange();
        range.selectNodeContents(el);
        const sel = window.getSelection();
        if (sel !== null) {
          sel.removeAllRanges();
          sel.addRange(range);
        }
      }
    }
  }
}

/** Find the editable element to inject into (paste target, focus, or composer). */
function resolveEditableTarget():
  | HTMLTextAreaElement
  | HTMLInputElement
  | HTMLElement
  | null {
  const candidates: (Element | null)[] = [document.activeElement, pasteTarget];
  for (const el of candidates) {
    if (el === null || !document.contains(el)) continue;
    if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) {
      if (!el.readOnly && !el.disabled) return el;
    } else if (el instanceof HTMLElement && el.isContentEditable) {
      return el;
    }
  }
  // Fallback: DSH's composer textarea (any enabled one).
  const ta = document.querySelector<HTMLTextAreaElement>(
    "textarea:not([readonly]):not([disabled])",
  );
  return ta;
}

function injectText(text: string): void {
  const el = resolveEditableTarget();
  if (el === null) return;
  el.focus();
  if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) {
    const start = el.selectionStart ?? el.value.length;
    const end = el.selectionEnd ?? el.value.length;
    const next = el.value.slice(0, start) + text + el.value.slice(end);
    // Native setter -> React's value tracker stays in sync -> UI updates.
    setNativeValue(el, next);
    const caret = start + text.length;
    el.setSelectionRange(caret, caret);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  } else if (el.isContentEditable) {
    document.execCommand("insertText", false, text);
  }
  el.focus();
}

/** Delete the selected text from the focused editable element (cut). */
function cutSelectedText(): void {
  const el = document.activeElement;
  if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) {
    const start = el.selectionStart ?? el.value.length;
    const end = el.selectionEnd ?? el.value.length;
    if (start === end) return;
    const next = el.value.slice(0, start) + el.value.slice(end);
    setNativeValue(el, next);
    el.setSelectionRange(start, start);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.focus();
  } else if (el instanceof HTMLElement && el.isContentEditable) {
    try {
      document.execCommand("cut");
    } catch {
      // ignore
    }
  }
}

function hideDocumentScrollbar(): void {
  if (document.getElementById("dsh-vscode-document-scrollbar") !== null) return;
  const style = document.createElement("style");
  style.id = "dsh-vscode-document-scrollbar";
  style.textContent = [
    "html{scrollbar-width:none}",
    "html::-webkit-scrollbar,body::-webkit-scrollbar{width:0!important;height:0!important;display:none!important}",
  ].join("");
  document.head.append(style);
}

function applyClearZoom(scale: number, requestId: number): void {
  if (!Number.isFinite(scale) || scale < 0.5 || scale > 2) return;
  const root = document.getElementById("root");
  if (root === null) return;

  // Keep the iframe at the real panel size. CSS zoom handles horizontal
  // layout; compensate #root vertically so the composer reaches the bottom.
  // The document remains scrollable (never clipped), but its scrollbar chrome
  // is hidden so only DSH's conversation scrollbar is visible.
  const inversePercent = `${(100 / scale).toFixed(4)}%`;
  hideDocumentScrollbar();
  root.style.setProperty("zoom", String(scale));
  root.style.width = "100%";
  root.style.height = inversePercent;
  postToHost({
    source: BRIDGE_SOURCE,
    type: "clearZoomApplied",
    scale,
    requestId,
  });
}

function handleHostMessage(event: MessageEvent): void {
  const msg = event.data as HostMessage | null;
  if (msg === null || typeof msg !== "object") return;
  if (msg.source !== HOST_SOURCE) return;
  if (msg.type === "inject" && typeof msg.text === "string") {
    injectText(msg.text);
  } else if (msg.type === "injectImage" && typeof msg.dataUrl === "string") {
    injectImage(msg.dataUrl);
  } else if (
    msg.type === "setClearZoom" &&
    typeof msg.scale === "number" &&
    typeof msg.requestId === "number"
  ) {
    applyClearZoom(msg.scale, msg.requestId);
  }
}

/**
 * Deliver a pasted image (data URL from the host) into the DSH composer.
 * DSH accepts images through a document-level `drop` event whose
 * dataTransfer carries files, so we synthesize one — the same path a real
 * drag-and-drop takes (intakeImages). This is the only cross-origin way to
 * hand a file to the React composer.
 */
function injectImage(dataUrl: string): void {
  try {
    const match = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.*)$/.exec(dataUrl);
    if (match === null) return;
    const bytes = Uint8Array.from(atob(match[2]), (c) => c.charCodeAt(0));
    const file = new File([bytes], "pasted-image", { type: match[1] });
    const dt = new DataTransfer();
    dt.items.add(file);
    document.dispatchEvent(
      new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt }),
    );
  } catch (error) {
    console.error("[dsh-vscode-bridge] injectImage failed:", error);
  }
}

/**
 * Patch navigator.clipboard.writeText so in-page "copy" buttons (which the
 * GUI calls directly) also route through the host clipboard.
 */
function patchNavigatorClipboard(): void {
  try {
    const nc = navigator.clipboard;
    if (nc === undefined) return;
    const original = nc.writeText.bind(nc);
    // @ts-expect-error - intentional override of the browser API
    nc.writeText = (text: string): Promise<void> => {
      requestWrite(text);
      return Promise.resolve();
    };
    void original;
  } catch {
    // ignore — clipboard API unavailable
  }
}

/**
 * Mount the clipboard bridge (client side).
 * @param ctx - client context (unused; no service injection needed).
 */
export function apply(ctx: unknown): void {
  void ctx;
  if (!isEmbedded()) return;

  patchNavigatorClipboard();
  document.addEventListener("keydown", handleKeyDown, true);
  document.addEventListener("copy", handleCopyCut, true);
  document.addEventListener("cut", handleCopyCut, true);
  document.addEventListener("paste", handlePaste, true);
  window.addEventListener("message", handleHostMessage);
  postToHost({ source: BRIDGE_SOURCE, type: "ready" });
}
