import * as vscode from "vscode";
import { DshClient, DshSessionSummary } from "./dshClient";
import { dshWorkspaceRoot } from "./dshFolder";
import { DshSessionsProvider, SessionItem, StatusItem } from "./sessionProvider";
import { DshWebviewProvider } from "./webview";

const VIEW_ID = "dshSessionsView";
const CFG_SECTION = "dshSessions";
const CFG_BASE_URL = "baseUrl";

let provider: DshSessionsProvider | undefined;
let webviewProvider: DshWebviewProvider | undefined;
let context: vscode.ExtensionContext | undefined;

function baseUrl(): string {
  return vscode.workspace.getConfiguration(CFG_SECTION).get<string>(CFG_BASE_URL, "http://127.0.0.1:3080");
}

function openInBrowser(url: string): void {
  void vscode.env.openExternal(vscode.Uri.parse(url));
}

function guiUrl(): string {
  let raw = baseUrl().trim();
  if (!/^https?:\/\//i.test(raw)) raw = `http://${raw}`;
  const url = new URL(raw);
  url.search = "";
  url.hash = "";
  url.pathname = "/";
  return url.href;
}

async function configureDshUrl(): Promise<void> {
  const value = await vscode.window.showInputBox({
    title: "配置 DSH 认证 URL",
    prompt: "粘贴 dsh web 启动时打印的完整 URL（包括 ?token=...）",
    value: baseUrl(),
    ignoreFocusOut: true,
    validateInput: (input) => {
      try {
        const url = new URL(/^https?:\/\//i.test(input.trim()) ? input.trim() : `http://${input.trim()}`);
        if (url.protocol !== "http:" && url.protocol !== "https:") return "只支持 http 或 https URL";
        return undefined;
      } catch {
        return "请输入有效的 DSH URL";
      }
    },
  });
  if (value === undefined) return;
  await vscode.workspace
    .getConfiguration(CFG_SECTION)
    .update(CFG_BASE_URL, value.trim(), vscode.ConfigurationTarget.Global);
  void vscode.window.showInformationMessage("DSH URL 已更新，正在重新加载右侧面板。");
}

async function clientForAction(): Promise<DshClient | undefined> {
  const client = DshClient.fromRaw(baseUrl());
  if (await client.ping()) return client;
  const pick = await vscode.window.showErrorMessage(
    `DeepSeek Harness is not reachable at ${baseUrl()}. Start it with "dsh web".`,
    "Retry",
  );
  if (pick === "Retry") return clientForAction();
  return undefined;
}

async function registerCurrentWorkspace(): Promise<void> {
  // 打开多根 .code-workspace 时以 workspace 文件所在目录（DevDesk 需求根）为
  // DSH 工作区，而不是 folders[0] 的子目录（如 user），避免在子目录重复新建。
  const folderPath = dshWorkspaceRoot();
  if (folderPath === undefined) {
    void vscode.window.showWarningMessage("No workspace folder is open.");
    return;
  }
  const client = await clientForAction();
  if (!client) return;
  const existing = await client.resolveWorkspaceByPath(folderPath);
  if (existing) {
    void vscode.window.showInformationMessage(`Already registered: "${existing.title}" (${existing.path})`);
  } else {
    const res = await client.createWorkspace(folderPath);
    void vscode.window.showInformationMessage(
      `Registered "${folderPath}" as DSH workspace "${res.workspace.title}".`,
    );
  }
  provider?.refresh();
}

async function newSession(): Promise<void> {
  const ws = provider?.getWorkspace();
  if (!ws) {
    void vscode.window.showWarningMessage("This folder is not registered in DSH yet.");
    await registerCurrentWorkspace();
    provider?.refresh();
    return;
  }
  const client = await clientForAction();
  if (!client) return;
  try {
    const res = await client.createSession(ws.workspaceId);
    provider?.refresh();
    void vscode.window.showInformationMessage(`Created session ${res.sessionId}`);
    await webviewProvider?.openSession(res.sessionId);
  } catch (err) {
    void vscode.window.showErrorMessage(`Failed to create session: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function openSession(session: DshSessionSummary): Promise<void> {
  // Deep-link into the exact session via the dsh-deeplink plugin:
  // ?session= opens the conversation, ?workspace= is a forward hint.
  await webviewProvider?.openSession(session.sessionId);
}

export function activate(extContext: vscode.ExtensionContext): void {
  context = extContext;
  provider = new DshSessionsProvider(baseUrl());
  const view = vscode.window.createTreeView(VIEW_ID, {
    treeDataProvider: provider,
    showCollapseAll: false,
  });

  // The right-side DSH GUI panel (secondary side bar), like Codex's chat.
  webviewProvider = new DshWebviewProvider();
  // After a session mutation in the panel, refresh the left tree too.
  webviewProvider.onSessionsChanged = () => provider?.refresh();
  extContext.subscriptions.push(
    vscode.window.registerWebviewViewProvider(DshWebviewProvider.viewType, webviewProvider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );

  vscode.commands.registerCommand("dshSessions.refresh", () => provider?.refresh());
  vscode.commands.registerCommand("dshSessions.configureUrl", configureDshUrl);
  vscode.commands.registerCommand("dshSessions.checkConnection", async () => {
    const client = DshClient.fromRaw(baseUrl());
    const ok = await client.ping();
    if (ok) {
      void vscode.window.showInformationMessage(`DSH is reachable at ${baseUrl()}.`);
    } else {
      void vscode.window.showErrorMessage(
        `DSH is not reachable at ${baseUrl()}. Start it with "dsh web".`,
      );
    }
    provider?.refresh();
  });
  vscode.commands.registerCommand("dshSessions.registerWorkspace", registerCurrentWorkspace);
  vscode.commands.registerCommand("dshSessions.newSession", newSession);
  vscode.commands.registerCommand("dshSessions.openInVscode", () => {
    void webviewProvider?.reveal();
  });
  vscode.commands.registerCommand("dshSessions.openInWeb", () => openInBrowser(guiUrl()));

  // Session row actions (left tree context menu + right panel). The panel
  // implements the logic (shared with its own list menu); the tree delegates.
  vscode.commands.registerCommand("dshSessions.renameSession", async (item?: unknown) => {
    const session = item instanceof SessionItem ? item.session : undefined;
    if (session === undefined) return;
    const title = session.projections?.values?.title;
    await webviewProvider?.renameSession(
      session.sessionId,
      typeof title === "string" ? title : undefined,
    );
  });
  vscode.commands.registerCommand("dshSessions.forkSession", async (item?: unknown) => {
    const session = item instanceof SessionItem ? item.session : undefined;
    if (session === undefined) return;
    await webviewProvider?.forkSession(session.sessionId);
  });
  vscode.commands.registerCommand("dshSessions.archiveSession", async (item?: unknown) => {
    const session = item instanceof SessionItem ? item.session : undefined;
    if (session === undefined) return;
    await webviewProvider?.archiveSession(session.sessionId);
  });

  vscode.commands.registerCommand("dshSessions.openSession", async (item?: unknown) => {
    if (item instanceof SessionItem) await openSession(item.session);
    else if (item instanceof StatusItem) {
      // Clicking a status row: retry connection, or register the folder.
      if (item.kind === "notRegistered") await registerCurrentWorkspace();
      else provider?.refresh();
    } else {
      openInBrowser(guiUrl());
    }
  });

  // Keep the "New session" menu item in sync with registration state.
  const syncContext = (): void => {
    void vscode.commands.executeCommand(
      "setContext",
      "dshSessions.hasWorkspace",
      provider?.getWorkspace() !== undefined,
    );
  };
  provider.onDidChangeTreeData(() => syncContext());
  syncContext();

  vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration(`${CFG_SECTION}.${CFG_BASE_URL}`)) {
      provider?.setBaseUrl(baseUrl());
      webviewProvider?.reloadConfiguration();
    }
    if (e.affectsConfiguration("dshSessions.autoRegister")) provider?.refresh();
  });

  vscode.workspace.onDidChangeWorkspaceFolders(() => {
    provider?.setFolderPath(dshWorkspaceRoot());
  });

  provider.refresh();
  // Auto-refresh so running status (spinner) stays current without manual
  // refreshes. The provider only rebuilds the tree when state actually changes.
  provider.startAutoRefresh(5000);
}

export function deactivate(): void {
  provider?.stopAutoRefresh();
  provider = undefined;
  webviewProvider = undefined;
  context = undefined;
}
