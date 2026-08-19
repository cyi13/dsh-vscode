import * as vscode from "vscode";
import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { DshClient, DshSessionSummary, DshWorkspace } from "./dshClient";

const execFileAsync = promisify(execFile);

/**
 * Read a PNG from the system clipboard on macOS via osascript
 * (NSPasteboard -> base64). VS Code's `vscode.env.clipboard` API is
 * text-only, so this is the only way to move clipboard images into the
 * embedded GUI. Returns a data URL, or undefined when the clipboard holds no
 * image (or this is not macOS).
 */
async function readClipboardImage(): Promise<string | undefined> {
  if (process.platform !== "darwin") return undefined;
  try {
    // macOS screenshots and image copies land on the pasteboard as TIFF
    // (public.tiff), not PNG, so first try public.png and then convert the
    // TIFF to PNG with NSBitmapImageRep before base64-encoding it.
    const script = [
      'use framework "Foundation"',
      "set p to (current application's NSPasteboard's generalPasteboard)",
      'set pngData to (p\'s dataForType:"public.png")',
      "if pngData is not missing value then",
      "  return (pngData's base64EncodedStringWithOptions:0) as text",
      "end if",
      'set tiffData to (p\'s dataForType:"public.tiff")',
      'if tiffData is missing value then return ""',
      "set rep to (current application's NSBitmapImageRep's imageRepWithData:tiffData)",
      "if rep is missing value then return \"\"",
      "set outData to (rep's representationUsingType:(current application's NSPNGFileType) |properties|:(missing value))",
      "if outData is missing value then return \"\"",
      "return (outData's base64EncodedStringWithOptions:0) as text",
    ].join("\n");
    // Each call spawns a fresh osascript process that must load the AppKit
    // framework; give it generous time on the first cold start.
    const { stdout, stderr } = await execFileAsync("osascript", ["-e", script], {
      timeout: 10000,
      maxBuffer: 8 * 1024 * 1024,
    });
    if (stderr !== "") console.error("[dsh] osascript stderr:", stderr);
    const b64 = stdout.trim();
    if (b64 === "") return undefined;
    return `data:image/png;base64,${b64}`;
  } catch (err) {
    console.error("[dsh] readClipboardImage failed:", err);
    return undefined;
  }
}

/**
 * DSH as a docked WebviewView in the secondary side bar (right side), like
 * Codex's chat panel.
 *
 * Two-layer UX in one document (no full-page reload when switching):
 * - List layer (default): the current workspace's session list, fetched from
 *   the DSH API by the extension host and posted in. Running sessions show a
 *   spinner. Clicking a session switches to the GUI layer.
 * - GUI layer: the real DSH web GUI embedded in an iframe at the session's
 *   deep link (?session=...). A back button returns to the list; the loaded
 *   page is kept so returning to the same session is instant.
 *
 * Why an iframe works: the DSH GUI is served at http://127.0.0.1:3080 and talks
 * to /api/* same-origin. The webview's top frame lives on the
 * vscode-webview:// scheme, but the iframe keeps its real origin
 * (http://127.0.0.1:3080) because we grant `allow-same-origin`, so the /api
 * requests from inside the iframe carry Origin: http://127.0.0.1:3080 and pass
 * the DSH browser-trust fence (loopback host + matching Origin).
 *
 * CSP notes (this bit us before): all inline scripts carry a per-load nonce
 * allowed by `script-src 'nonce-...'`. `default-src 'none'` without an
 * explicit `script-src` would block every inline script.
 *
 * Clipboard: the sandboxed iframe needs `allow-clipboard-read
 * allow-clipboard-write` and the dsh-clipboard plugin for copy/paste to work
 * (VS Code webviews deny clipboard access to cross-origin iframes).
 */

/** One row the list layer renders. */
export interface SessionRow {
  sessionId: string;
  title: string;
  updatedAt: number;
  running: boolean;
  blank: boolean;
}

export type ListStatus = "ok" | "offline" | "notRegistered" | "noFolder" | "error";

export interface ListInitData {
  status: ListStatus;
  baseUrl: string;
  workspaceId?: string;
  workspaceTitle?: string;
  message?: string;
  sessions: SessionRow[];
}

type InMessage =
  | { type: "ready" }
  | { type: "refresh" }
  | { type: "register" }
  | { type: "openSession"; sessionId: string }
  | { type: "newSession" }
  | { type: "back" }
  // Session row actions from the right panel's list context menu.
  | { type: "renameSession"; sessionId: string; currentTitle?: string }
  | { type: "forkSession"; sessionId: string }
  | { type: "archiveSession"; sessionId: string }
  // Zoom diagnostics (log only).
  | { type: "zoomChanged"; scale: number }
  // Clipboard bridge: the iframe's dsh-clipboard plugin forwards copy/paste
  // here; the host reads/writes the system clipboard with vscode.env.clipboard
  // and posts the result back into the iframe.
  | { type: "clipboardWrite"; text: string }
  | { type: "clipboardRead" };

export class DshWebviewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "dshSessionsWebView";

  private view: vscode.WebviewView | undefined;
  private url: string | undefined;

  /** Called by VS Code when the view is created or recreated. */
  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.onDidReceiveMessage((msg: InMessage) => {
      void this.handleMessage(msg);
    });
    this.render();
    if (this.url !== undefined) {
      // A session was opened before the view existed (e.g. via the sidebar
      // tree): jump straight into the GUI layer.
      this.post({ type: "navigate", url: this.url });
    }
  }

  private async handleMessage(msg: InMessage): Promise<void> {
    switch (msg.type) {
      case "ready":
      case "refresh":
        await this.sendInit();
        break;
      case "register":
        await this.registerFolder();
        await this.sendInit();
        break;
      case "openSession":
        await this.navigateToSession(msg.sessionId);
        break;
      case "newSession":
        await this.createAndNavigate();
        break;
      case "back":
        this.url = undefined;
        break;
      case "renameSession":
        await this.renameSession(msg.sessionId, msg.currentTitle);
        break;
      case "forkSession":
        await this.forkSession(msg.sessionId);
        break;
      case "archiveSession":
        await this.archiveSession(msg.sessionId);
        break;
      case "zoomChanged":
        console.log(`[dsh] zoom changed -> ${Math.round(msg.scale * 100)}%`);
        break;
      case "clipboardWrite":
        await vscode.env.clipboard.writeText(msg.text);
        console.log(`[dsh] clipboardWrite ${msg.text.length} chars`);
        break;
      case "clipboardRead": {
        // Text first — the fast path. VS Code's clipboard API returns text
        // instantly; only when the clipboard holds no text do we pay for the
        // slower osascript image read (which spawns a process and loads
        // AppKit). Otherwise every text paste would wait for osascript too.
        const text = await vscode.env.clipboard.readText();
        if (text !== "") {
          console.log(`[dsh] clipboardRead -> ${text.length} chars`);
          this.post({ type: "clipboardInject", text });
          break;
        }
        // Clipboard is not text: try an image (PNG, or TIFF converted to PNG)
        // on macOS via osascript (NSPasteboard).
        const image = await readClipboardImage();
        if (image !== undefined) {
          console.log(`[dsh] clipboardRead -> image (${image.length} b64 chars)`);
          this.post({ type: "clipboardInjectImage", dataUrl: image });
          break;
        }
        // Neither text nor image: inject nothing so the GUI stays unchanged.
        console.log("[dsh] clipboardRead -> empty");
        this.post({ type: "clipboardInject", text: "" });
        break;
      }
    }
  }

  private static baseUrl(): string {
    return vscode.workspace
      .getConfiguration("dshSessions")
      .get<string>("dshSessions.baseUrl", "http://127.0.0.1:3080");
  }

  private static autoRegister(): boolean {
    return vscode.workspace
      .getConfiguration("dshSessions")
      .get<boolean>("dshSessions.autoRegister", true);
  }

  /** Fetch the current workspace's session rows from the DSH API. */
  private async loadListData(): Promise<ListInitData> {
    const baseUrl = DshWebviewProvider.baseUrl();
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const client = DshClient.fromRaw(baseUrl);
    if (folder === undefined) {
      return { status: "noFolder", baseUrl, sessions: [] };
    }
    const online = await client.ping();
    if (!online) {
      return { status: "offline", baseUrl, sessions: [] };
    }
    let workspace: DshWorkspace | undefined;
    try {
      workspace = await client.resolveWorkspaceByPath(folder);
      if (workspace === undefined && DshWebviewProvider.autoRegister()) {
        workspace = (await client.createWorkspace(folder)).workspace;
      }
    } catch (err) {
      return {
        status: "error",
        baseUrl,
        message: err instanceof Error ? err.message : String(err),
        sessions: [],
      };
    }
    if (workspace === undefined) {
      return { status: "notRegistered", baseUrl, sessions: [] };
    }
    const { items } = await client.listSessions();
    const idSet = new Set(workspace.sessionIds);
    const rows: SessionRow[] = items
      .filter((s) => idSet.has(s.sessionId) && s.origin !== "subagent")
      .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
      .map((s) => ({
        sessionId: s.sessionId,
        title: sessionTitle(s),
        updatedAt: s.updatedAt,
        running: s.running,
        blank: s.blank,
      }));
    return {
      status: "ok",
      baseUrl,
      workspaceId: workspace.workspaceId,
      workspaceTitle: workspace.title,
      sessions: rows,
    };
  }

  private post(message: unknown): void {
    this.view?.webview.postMessage(message);
  }

  private async sendInit(): Promise<void> {
    const data = await this.loadListData();
    this.post({ type: "init", data });
  }

  private guiUrl(sessionId?: string): string {
    const baseUrl = DshWebviewProvider.baseUrl().replace(/\/+$/, "");
    if (sessionId === undefined) return baseUrl;
    return `${baseUrl}/?session=${encodeURIComponent(sessionId)}`;
  }

  private async navigateToSession(sessionId: string): Promise<void> {
    const url = this.guiUrl(sessionId);
    this.url = url;
    this.post({ type: "navigate", url });
  }

  private async createAndNavigate(): Promise<void> {
    const client = DshClient.fromRaw(DshWebviewProvider.baseUrl());
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (folder === undefined) return;
    let workspace = await client.resolveWorkspaceByPath(folder);
    if (workspace === undefined) {
      workspace = (await client.createWorkspace(folder)).workspace;
    }
    const res = await client.createSession(workspace.workspaceId);
    await this.navigateToSession(res.sessionId);
  }

  private async registerFolder(): Promise<void> {
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (folder === undefined) return;
    const client = DshClient.fromRaw(DshWebviewProvider.baseUrl());
    await client.createWorkspace(folder);
  }

  /**
   * Open (or re-navigate) the DSH GUI in the right-side panel.
   * Reveals the view container when it is hidden.
   * @param url - the DSH GUI URL to load.
   */
  async open(url: string): Promise<void> {
    this.url = url;
    if (this.view !== undefined) {
      this.post({ type: "navigate", url });
      this.view.show?.(true);
      return;
    }
    // View container not opened yet: open it (resolveWebviewView posts the url).
    await vscode.commands.executeCommand("workbench.view.extension.dshSessionsWeb");
  }

  /** Open a session by id (used by the sidebar tree). */
  async openSession(sessionId: string): Promise<void> {
    await this.open(this.guiUrl(sessionId));
  }

  /** Called after any session mutation so the left tree can refresh. */
  onSessionsChanged: (() => void) | undefined;

  /** Rename a session (asks for the new title). Shared by tree + panel. */
  async renameSession(sessionId: string, currentTitle?: string): Promise<void> {
    const client = DshClient.fromRaw(DshWebviewProvider.baseUrl());
    const title = await vscode.window.showInputBox({
      prompt: "重命名会话",
      value: currentTitle ?? "",
      placeHolder: "输入新的会话标题",
      validateInput: (v) => (v.trim() === "" ? "标题不能为空" : undefined),
    });
    if (title === undefined) return; // cancelled
    try {
      const res = await client.renameSession(sessionId, title.trim());
      this.onSessionsChanged?.();
      void vscode.window.showInformationMessage(`已重命名为 "${res.title}"`);
    } catch (err) {
      void vscode.window.showErrorMessage(
        `重命名失败: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** Fork a session at its last completed turn; opens the child. */
  async forkSession(sessionId: string): Promise<void> {
    const client = DshClient.fromRaw(DshWebviewProvider.baseUrl());
    try {
      const childId = await client.forkSession(sessionId);
      this.onSessionsChanged?.();
      void vscode.window.showInformationMessage(`已分叉会话 ${childId}`);
      await this.openSession(childId);
    } catch (err) {
      void vscode.window.showErrorMessage(
        `分叉失败: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** Archive a session (keeps its log; hides it from grouping surfaces). */
  async archiveSession(sessionId: string): Promise<void> {
    const client = DshClient.fromRaw(DshWebviewProvider.baseUrl());
    const confirm = await vscode.window.showWarningMessage(
      "归档会话？归档只隐藏会话（保留日志和归属），不删除。",
      { modal: true },
      "归档",
    );
    if (confirm !== "归档") return;
    try {
      await client.archiveSession(sessionId);
      this.onSessionsChanged?.();
      void vscode.window.showInformationMessage("会话已归档");
    } catch (err) {
      void vscode.window.showErrorMessage(
        `归档失败: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private render(): void {
    if (this.view === undefined) return;
    const base = DshWebviewProvider.baseUrl().replace(/\/+$/, "");
    // Preload the GUI (already-open session if any, else the GUI root) in the
    // background so the first click into a session reuses warm caches.
    const preloadUrl = this.url ?? base;
    this.view.webview.html = htmlForPanel(preloadUrl, base);
  }
}

function sessionTitle(s: DshSessionSummary): string {
  const title = s.projections?.values?.title;
  if (typeof title === "string" && title.trim() !== "") return title;
  if (s.blank) return "新会话";
  return `Session ${s.sessionId.slice(0, 8)}`;
}

function htmlForPanel(preloadUrl: string, baseUrl: string): string {
  // frame-src is kept open to http(s) origins; the host only ever posts the
  // configured base URL, and the iframe src is only ever set from that base.
  const nonce = randomBytes(16).toString("base64");
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; frame-src http://127.0.0.1:* http://localhost:* https:; script-src 'nonce-${nonce}'; style-src 'unsafe-inline';" />
<style>
  *{box-sizing:border-box;}
  html,body{margin:0;padding:0;height:100%;overflow:hidden;
    background:var(--vscode-sideBar-background,#1e1e1e);
    color:var(--vscode-sideBar-foreground,#ccc);font-family:var(--vscode-font-family);}
  button{background:transparent;color:var(--vscode-descriptionForeground,#bbb);border:none;
         border-radius:4px;padding:3px 8px;cursor:pointer;font-size:13px;line-height:1;}
  button:hover{background:var(--vscode-toolbar-hoverBackground,#2a2d2e);color:#fff;}
  /* ── list layer ── */
  #bar{display:flex;align-items:center;gap:4px;padding:8px 12px;
       border-bottom:1px solid var(--vscode-sideBar-border,#3c3c3c);}
  #barTitle{font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.5px;
            color:var(--vscode-sideBarSectionTitle-foreground,#ccc);
            white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
  #bar .spacer{flex:1;}
  #status{padding:16px 12px;font-size:12.5px;line-height:1.7;
          color:var(--vscode-descriptionForeground,#bbb);}
  #status .act{margin-top:10px;}
  #rows{overflow-y:auto;}
  .row{display:flex;align-items:center;gap:8px;padding:7px 12px;cursor:pointer;
       border-left:2px solid transparent;}
  .row:hover{background:var(--vscode-list-hoverBackground,#2a2d2e);}
  .row .title{flex:1;font-size:12.5px;color:var(--vscode-list-foreground,#ccc);
              white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
  .row .time{flex:none;font-size:11px;color:var(--vscode-descriptionForeground,#888);}
  /* status: idle = hollow dot; running = spinning ring */
  .dot{flex:none;width:10px;height:10px;border-radius:50%;border:2px solid var(--vscode-descriptionForeground,#666);
       background:transparent;opacity:.5;}
  .row.running .dot{border-color:var(--vscode-panel-border,#3c3c3c);
       border-top-color:var(--vscode-charts-blue,#3794ff);
       background:transparent;opacity:1;
       animation:spin .8s linear infinite;}
  @keyframes spin{to{transform:rotate(360deg);}}
  .empty{padding:24px 12px;font-size:12.5px;color:var(--vscode-descriptionForeground,#888);}
  /* ── gui layer ── */
  #stage{display:none;flex-direction:column;width:100%;height:100%;}
  #stage.on{display:flex;}
  #guiBar{flex:none;display:flex;align-items:center;gap:2px;justify-content:flex-end;padding:2px 6px;
       background:var(--vscode-editor-background,#1e1e1e);
       border-bottom:1px solid var(--vscode-panel-border,#3c3c3c);}
  #zoomLabel{min-width:38px;text-align:center;font-size:11px;
             color:var(--vscode-descriptionForeground,#bbb);user-select:none;}
  #frameHost{flex:1;position:relative;overflow:hidden;}
  #frame{position:absolute;top:0;left:0;transform-origin:top left;border:none;
         background:var(--vscode-editor-background,#1e1e1e);}
  #loading{position:absolute;inset:0;display:none;align-items:center;justify-content:center;
           background:var(--vscode-editor-background,#1e1e1e);z-index:5;
           color:var(--vscode-descriptionForeground,#888);font-size:12px;gap:8px;}
  #loading.on{display:flex;}
  .spinner{width:14px;height:14px;border:2px solid var(--vscode-panel-border,#3c3c3c);
           border-top-color:var(--vscode-charts-blue,#3794ff);border-radius:50%;
           animation:spin .8s linear infinite;}
  /* ── row context menu ── */
  #ctxmenu{display:none;position:fixed;z-index:100;min-width:150px;
           background:var(--vscode-menu-background,#252526);
           border:1px solid var(--vscode-menu-border,#454545);
           border-radius:6px;padding:4px;box-shadow:0 4px 12px rgba(0,0,0,.4);}
  #ctxmenu.on{display:block;}
  #ctxmenu button{display:block;width:100%;text-align:left;font-size:12.5px;
           color:var(--vscode-menu-foreground,#ccc);padding:5px 10px;border-radius:4px;}
  #ctxmenu button:hover{background:var(--vscode-menu-selectionBackground,#094771);
           color:var(--vscode-menu-selectionForeground,#fff);}
</style>
</head>
<body>
  <div id="ctxmenu">
    <button data-act="openSession">打开会话</button>
    <button data-act="renameSession">重命名</button>
    <button data-act="forkSession">分叉会话</button>
    <button data-act="archiveSession">归档会话</button>
  </div>
  <div id="listLayer">
    <div id="bar">
      <span id="barTitle">DSH 会话</span>
      <span class="spacer"></span>
      <button id="newBtn" title="新建会话">&#43;</button>
      <button id="refreshBtn" title="刷新">&#8635;</button>
    </div>
    <div id="status" style="display:none"></div>
    <div id="rows"></div>
  </div>
  <div id="stage">
    <div id="guiBar">
      <button id="backBtn" title="返回会话列表">&#8592;</button>
      <span style="flex:1"></span>
      <button id="zoomOut" title="缩小">&#8722;</button>
      <span id="zoomLabel">100%</span>
      <button id="zoomIn" title="放大">&#43;</button>
      <button id="reload" title="重新加载">&#8635;</button>
    </div>
    <div id="frameHost">
      <div id="loading"><span class="spinner"></span><span>加载中…</span></div>
      <iframe id="frame" sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-downloads allow-modals allow-clipboard-read allow-clipboard-write"></iframe>
    </div>
  </div>
  <script nonce="${nonce}">
    (function () {
      var vscode = acquireVsCodeApi();
      var statusEl = document.getElementById('status');
      var rowsEl = document.getElementById('rows');
      var listLayer = document.getElementById('listLayer');
      var stage = document.getElementById('stage');
      var frame = document.getElementById('frame');
      var loading = document.getElementById('loading');
      var zoomLabel = document.getElementById('zoomLabel');
      var ctxMenu = document.getElementById('ctxmenu');
      var menuSessionId = null;
      var currentUrl = '';
      var scale = 0.8;
      var MIN = 0.6, MAX = 1.4, STEP = 0.1;
      var loadTimer = null;
      // Detect whether the engine applies CSS zoom to layout. Important:
      // zoom scales the VISUAL size, not the layout width — offsetWidth stays
      // at the unzoomed width, so it must NOT be used for detection. The
      // reliable signals are getComputedStyle().zoom (the applied value) and
      // getBoundingClientRect() (the visual, zoomed size). When zoom is
      // unsupported (some WKWebView builds), fall back to transform: scale().
      var ZOOM_SUPPORTED = (function () {
        try {
          var probe = document.createElement('div');
          probe.style.cssText = 'position:absolute;visibility:hidden;width:100px;height:10px;zoom:0.5;';
          document.body.appendChild(probe);
          var applied = getComputedStyle(probe).zoom;
          var visual = probe.getBoundingClientRect().width;
          var offset = probe.offsetWidth;
          document.body.removeChild(probe);
          console.log('[dsh-panel] zoom probe: applied=' + applied + ' visual=' + visual + ' offset=' + offset);
          // Zoom works if the computed value stayed 0.5 AND the visual width
          // shrank to ~50 (both hold in Chromium and WebKit).
          return applied === '0.5' && Math.abs(visual - 50) < 1;
        } catch (e) {
          console.log('[dsh-panel] zoom probe error:', e);
          return false;
        }
      })();
      console.log('[dsh-panel] zoom support =', ZOOM_SUPPORTED);
      // Warm the iframe in the background (not visible) so the first click
      // into a session reuses cached resources.
      var PRELOAD_URL = ${JSON.stringify(preloadUrl)};

      function esc(s) {
        return String(s).replace(/[&<>"']/g, function (c) {
          return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
      }
      function relTime(ts) {
        if (!ts) return '';
        var d = Date.now() - ts;
        var m = Math.floor(d / 60000);
        if (m < 1) return '刚刚';
        if (m < 60) return m + ' 分钟前';
        var h = Math.floor(m / 60);
        if (h < 24) return h + ' 小时前';
        var day = Math.floor(h / 24);
        if (day < 30) return day + ' 天前';
        return new Date(ts).toLocaleDateString();
      }

      function showStatus(text, action, actionType) {
        statusEl.style.display = 'block';
        rowsEl.style.display = 'none';
        statusEl.innerHTML = esc(text) + (action
          ? '<div class="act"><button data-act="' + esc(actionType) + '">' + esc(action) + '</button></div>'
          : '');
        var btn = statusEl.querySelector('button[data-act]');
        if (btn) btn.addEventListener('click', function () { vscode.postMessage({ type: btn.getAttribute('data-act') }); });
      }

      function render(data) {
        if (data.status !== 'ok') {
          if (data.status === 'offline') {
            showStatus('DeepSeek Harness 未运行。请先启动：dsh web', '重试', 'refresh');
          } else if (data.status === 'notRegistered') {
            showStatus('当前文件夹尚未注册为 DSH 工作区。', '注册当前文件夹', 'register');
          } else if (data.status === 'noFolder') {
            showStatus('请打开一个文件夹以查看其 DSH 会话。');
          } else {
            showStatus(data.message || '加载失败。', '重试', 'refresh');
          }
          return;
        }
        statusEl.style.display = 'none';
        rowsEl.style.display = 'block';
        document.getElementById('barTitle').textContent = data.workspaceTitle || 'DSH 会话';
        if (!data.sessions.length) {
          rowsEl.innerHTML = '<div class="empty">当前工作区还没有会话。点击右上角 + 新建，或从 DSH 网页发起会话。</div>';
          return;
        }
        rowsEl.innerHTML = data.sessions.map(function (s) {
          return '<div class="row' + (s.running ? ' running' : '') + '" data-id="' + esc(s.sessionId) + '">' +
            '<span class="dot"></span>' +
            '<span class="title">' + esc(s.title) + '</span>' +
            '<span class="time">' + esc(relTime(s.updatedAt)) + '</span>' +
            '</div>';
        }).join('');
        rowsEl.querySelectorAll('.row').forEach(function (row) {
          row.addEventListener('click', function () {
            vscode.postMessage({ type: 'openSession', sessionId: row.getAttribute('data-id') });
          });
          row.addEventListener('contextmenu', function (event) {
            event.preventDefault();
            menuSessionId = row.getAttribute('data-id');
            var w = ctxMenu.offsetWidth || 160;
            var h = ctxMenu.offsetHeight || 150;
            ctxMenu.style.left = Math.min(event.clientX, window.innerWidth - w - 4) + 'px';
            ctxMenu.style.top = Math.min(event.clientY, window.innerHeight - h - 4) + 'px';
            ctxMenu.classList.add('on');
          });
        });
      }

      // Row context menu: hide on outside click / Escape / scroll; dispatch
      // the chosen action to the host.
      function hideCtxMenu() {
        ctxMenu.classList.remove('on');
        menuSessionId = null;
      }
      ctxMenu.querySelectorAll('button').forEach(function (btn) {
        btn.addEventListener('click', function () {
          var act = btn.getAttribute('data-act');
          var sid = menuSessionId;
          hideCtxMenu();
          if (sid === null) return;
          vscode.postMessage({ type: act, sessionId: sid });
        });
      });
      document.addEventListener('click', function (event) {
        if (!ctxMenu.classList.contains('on')) return;
        if (!ctxMenu.contains(event.target)) hideCtxMenu();
      });
      document.addEventListener('contextmenu', function (event) {
        if (ctxMenu.classList.contains('on') && !ctxMenu.contains(event.target)) hideCtxMenu();
      });
      document.addEventListener('keydown', function (event) {
        if (event.key === 'Escape' && ctxMenu.classList.contains('on')) hideCtxMenu();
      });
      rowsEl.addEventListener('scroll', function () {
        if (ctxMenu.classList.contains('on')) hideCtxMenu();
      });

      // Zoom is applied INSIDE the DSH page by the dsh-clipboard plugin
      // (it sets zoom on document.documentElement, which is the only element
      // this engine scales via CSS zoom). The host relays the value to the
      // iframe; nothing on the iframe element itself is scaled, so there is
      // no compositor blur and no layout spill.
      function applyZoom() {
        var s = Math.round(scale * 100) / 100;
        zoomLabel.textContent = Math.round(s * 100) + '%';
        if (frame.contentWindow) {
          frame.contentWindow.postMessage(
            { source: 'dsh-clipboard-host', type: 'setZoom', value: s },
            '*'
          );
        }
      }

      function showLoading() {
        loading.classList.add('on');
        if (loadTimer) clearTimeout(loadTimer);
      }

      function hideLoading() {
        loading.classList.remove('on');
        if (loadTimer) { clearTimeout(loadTimer); loadTimer = null; }
      }

      function goGui(url) {
        url = String(url);
        currentUrl = url;
        listLayer.style.display = 'none';
        stage.classList.add('on');
        if (frame.getAttribute('data-loaded') === url) {
          // This exact page is already loaded (preloaded or previously
          // visited): show it immediately without reloading.
          return;
        }
        showLoading();
        frame.src = url;
        frame.setAttribute('data-loaded', url);
      }

      function goList() {
        stage.classList.remove('on');
        listLayer.style.display = '';
        hideLoading();
        // Keep the iframe page loaded so returning to the same session is
        // instant; a different session only swaps the src.
      }

      frame.addEventListener('load', function () {
        // Once the GUI's HTML/JS is in, its own dark boot screen covers the
        // iframe, so drop the overlay quickly.
        if (loadTimer) clearTimeout(loadTimer);
        loadTimer = setTimeout(hideLoading, 350);
        // Re-apply zoom after load so the freshly loaded DSH page (with the
        // dsh-clipboard plugin) receives the current zoom value.
        applyZoom();
      });

      // Background preload: warm the DSH GUI without showing it.
      if (PRELOAD_URL) {
        frame.src = PRELOAD_URL;
        frame.setAttribute('data-loaded', PRELOAD_URL);
      }

      document.getElementById('backBtn').addEventListener('click', function () {
        goList();
        vscode.postMessage({ type: 'back' });
      });
      document.getElementById('reload').addEventListener('click', function () {
        if (currentUrl) {
          frame.src = 'about:blank';
          frame.setAttribute('data-loaded', '');
          requestAnimationFrame(function () { goGui(currentUrl); });
        }
      });
      document.getElementById('zoomOut').addEventListener('click', function () {
        scale = Math.max(MIN, scale - STEP); applyZoom();
        vscode.postMessage({ type: 'zoomChanged', scale: scale });
      });
      document.getElementById('zoomIn').addEventListener('click', function () {
        scale = Math.min(MAX, scale + STEP); applyZoom();
        vscode.postMessage({ type: 'zoomChanged', scale: scale });
      });
      document.getElementById('refreshBtn').addEventListener('click', function () {
        vscode.postMessage({ type: 'refresh' });
      });
      document.getElementById('newBtn').addEventListener('click', function () {
        vscode.postMessage({ type: 'newSession' });
      });

      // Messages from the embedded DSH GUI (the iframe) carry the
      // dsh-clipboard source tag; messages from the extension host never do.
      // We distinguish by that tag instead of comparing event.source to
      // frame.contentWindow: across origins that comparison can fail while
      // the iframe is mid-load, silently dropping clipboard events.
      window.addEventListener('message', function (event) {
        var msg = event.data;
        if (!msg) return;
        if (msg.source === 'dsh-clipboard') {
          // From the iframe: dsh-clipboard bridge.
          if (msg.type === 'write' && typeof msg.text === 'string') {
            console.log('[dsh-panel] copy -> host', msg.text.length + ' chars');
            vscode.postMessage({ type: 'clipboardWrite', text: msg.text });
          } else if (msg.type === 'read') {
            console.log('[dsh-panel] paste <- host (read)');
            vscode.postMessage({ type: 'clipboardRead' });
          }
          return;
        }
        // From the extension host.
        if (msg.type === 'init' && msg.data) render(msg.data);
        else if (msg.type === 'navigate' && msg.url) goGui(msg.url);
        else if (msg.type === 'clipboardInject' && typeof msg.text === 'string') {
          console.log('[dsh-panel] host -> iframe inject', msg.text.length + ' chars');
          if (frame.contentWindow) {
            frame.contentWindow.postMessage(
              { source: 'dsh-clipboard-host', type: 'inject', text: msg.text },
              '*'
            );
          }
        } else if (msg.type === 'clipboardInjectImage' && typeof msg.dataUrl === 'string') {
          console.log('[dsh-panel] host -> iframe inject image', msg.dataUrl.length + ' chars');
          if (frame.contentWindow) {
            frame.contentWindow.postMessage(
              { source: 'dsh-clipboard-host', type: 'injectImage', dataUrl: msg.dataUrl },
              '*'
            );
          }
        }
      });

      applyZoom();
      vscode.postMessage({ type: 'ready' });
      // Auto-refresh the session list so running status (spinner) stays
      // current without manual refreshes.
      setInterval(function () {
        vscode.postMessage({ type: 'refresh' });
      }, 5000);
    })();
  </script>
</body>
</html>`;
}
