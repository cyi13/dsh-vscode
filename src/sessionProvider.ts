import * as vscode from "vscode";
import {
  DshApiError,
  DshClient,
  DshSessionSummary,
  DshWorkspace,
} from "./dshClient";
import { dshWorkspaceRoot } from "./dshFolder";

export type DshTreeItem = WorkspaceRootItem | SessionItem | StatusItem;

export class WorkspaceRootItem extends vscode.TreeItem {
  constructor(
    readonly workspace: DshWorkspace,
    readonly folderPath: string,
  ) {
    super(workspace.title, vscode.TreeItemCollapsibleState.Expanded);
    this.id = `ws:${workspace.workspaceId}`;
    this.contextValue = "dshWorkspace";
    this.description = workspace.path;
    this.tooltip = `${workspace.title}\n${workspace.path}\n${workspace.sessionIds.length} sessions`;
    this.iconPath = new vscode.ThemeIcon("folder");
  }
}

export class SessionItem extends vscode.TreeItem {
  constructor(readonly session: DshSessionSummary) {
    const title = sessionTitle(session);
    super(title, vscode.TreeItemCollapsibleState.None);
    this.id = `session:${session.sessionId}`;
    this.contextValue = "dshSession";
    this.description = session.running ? "running" : undefined;
    this.tooltip = [
      title,
      `ID: ${session.sessionId}`,
      session.cwd ? `cwd: ${session.cwd}` : undefined,
      session.running ? "Running" : undefined,
    ]
      .filter(Boolean)
      .join("\n");
    this.iconPath = session.running
      ? new vscode.ThemeIcon("loading~spin", new vscode.ThemeColor("charts.blue"))
      : new vscode.ThemeIcon("comment-discussion");
    this.command = {
      command: "dshSessions.openSession",
      title: "Open session",
      arguments: [this],
    };
  }
}

export class StatusItem extends vscode.TreeItem {
  constructor(
    label: string,
    readonly kind: "error" | "info" | "noWorkspace" | "notRegistered",
  ) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.id = `status:${kind}:${label}`;
    this.contextValue = `dshStatus-${kind}`;
    this.iconPath =
      kind === "error"
        ? new vscode.ThemeIcon("error")
        : kind === "info"
          ? new vscode.ThemeIcon("loading~spin", new vscode.ThemeColor("charts.blue"))
          : new vscode.ThemeIcon("info");
  }
}

function sessionTitle(session: DshSessionSummary): string {
  const title = session.projections?.values?.title;
  if (typeof title === "string" && title.trim() !== "") return title;
  if (session.blank) return "New session";
  return `Session ${session.sessionId.slice(0, 8)}`;
}

function lastPrompt(session: DshSessionSummary): number {
  const meta = session.projections?.values?.sessionListMetadata as
    | { lastPromptAt?: number }
    | undefined;
  return meta?.lastPromptAt ?? session.updatedAt;
}

export class DshSessionsProvider implements vscode.TreeDataProvider<DshTreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<DshTreeItem | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private client: DshClient;
  private folderPath: string | undefined;
  private workspace: DshWorkspace | undefined;
  private sessions: DshSessionSummary[] = [];
  private error: string | undefined;
  private notRegistered = false;
  private refreshing = false;
  /** Fingerprint of the last rendered state; the tree is rebuilt only on change. */
  private lastSnapshot = "";
  private autoTimer: ReturnType<typeof setInterval> | undefined;
  private _loadStartedAt = 0;

  constructor(baseUrl: string) {
    this.client = DshClient.fromRaw(baseUrl);
    this.folderPath = dshWorkspaceRoot();
  }

  setBaseUrl(raw: string): void {
    this.client = DshClient.fromRaw(raw);
    this.refresh();
  }

  setFolderPath(path: string | undefined): void {
    this.folderPath = path;
    this.refresh();
  }

  refresh(): void {
    // Manual refresh always rebuilds the tree.
    this.lastSnapshot = "";
    this._onDidChangeTreeData.fire();
    void this.load();
  }

  /** Periodically re-pull session state so running status stays current. */
  startAutoRefresh(intervalMs = 5000): void {
    if (this.autoTimer !== undefined) return;
    this.autoTimer = setInterval(() => {
      void this.load();
    }, intervalMs);
  }

  stopAutoRefresh(): void {
    if (this.autoTimer !== undefined) {
      clearInterval(this.autoTimer);
      this.autoTimer = undefined;
    }
  }

  /** Stable string summarizing everything the tree shows. */
  private fingerprint(): string {
    return JSON.stringify({
      error: this.error,
      workspaceId: this.workspace?.workspaceId,
      notRegistered: this.notRegistered,
      sessions: this.sessions.map((s) => ({
        id: s.sessionId,
        title: s.projections?.values?.title,
        running: s.running,
        updatedAt: s.updatedAt,
      })),
    });
  }

  /** Re-run the whole load: ping, resolve workspace, fetch sessions. */
  async load(): Promise<void> {
    if (this.refreshing) {
      // Safety net: if a previous load never settled (e.g. a hung call), do
      // not block auto-refresh forever.
      if (Date.now() - this._loadStartedAt > 30000) {
        this.refreshing = false;
        console.warn("[dsh-tree] reset stuck load (refreshing stuck >30s)");
      } else {
        return;
      }
    }
    this.refreshing = true;
    this._loadStartedAt = Date.now();
    const t0 = this._loadStartedAt;
    console.log(
      `[dsh-tree] load start folder=${this.folderPath ?? "(none)"} base=${this.client.baseUrl}`,
    );
    try {
      if (this.folderPath === undefined) {
        this.error = undefined;
        this.workspace = undefined;
        this.sessions = [];
        this.notRegistered = false;
      } else {
        const online = await this.client.ping();
        if (!online) {
          this.error = "DeepSeek Harness is not reachable.";
          this.workspace = undefined;
          this.sessions = [];
        } else {
          this.error = undefined;

          let workspace = await this.client.resolveWorkspaceByPath(this.folderPath);
          if (workspace === undefined) {
            const auto = vscode.workspace.getConfiguration("dshSessions").get<boolean>("autoRegister", true);
            if (auto) {
              try {
                const res = await this.client.createWorkspace(this.folderPath);
                workspace = res.workspace;
                this.notRegistered = false;
                void vscode.window.showInformationMessage(
                  `Registered "${this.folderPath}" as a DSH workspace.`,
                );
              } catch (err) {
                this.notRegistered = true;
                this.error = err instanceof Error ? err.message : String(err);
                workspace = undefined;
              }
            } else {
              this.notRegistered = true;
              workspace = undefined;
            }
          } else {
            this.notRegistered = false;
          }
          this.workspace = workspace;

          if (workspace !== undefined) {
            const { items } = await this.client.listSessions();
            const idSet = new Set(workspace.sessionIds);
            // Only sessions that belong to this workspace (by account), excluding
            // subagent-origin descendants which live under their parent.
            this.sessions = items
              .filter((s) => idSet.has(s.sessionId) && s.origin !== "subagent")
              .sort((a, b) => lastPrompt(b) - lastPrompt(a));
          } else {
            this.sessions = [];
          }
        }
      }
    } catch (err) {
      this.error = err instanceof Error ? err.message : String(err);
      if (err instanceof DshApiError) {
        this.error = `DSH API: ${err.message}`;
      }
      this.workspace = undefined;
      this.sessions = [];
    } finally {
      this.refreshing = false;
      const ms = Date.now() - t0;
      let snap: string;
      try {
        snap = this.fingerprint();
      } catch (err) {
        // fingerprint must never block the tree from refreshing.
        snap = `fingerprint-error:${String(err)}`;
        this._onDidChangeTreeData.fire();
      }
      console.log(
        `[dsh-tree] load done ${ms}ms workspace=${this.workspace?.workspaceId ?? "(none)"} ` +
          `sessions=${this.sessions.length} error=${this.error ?? "(none)"} fire=${snap !== this.lastSnapshot}`,
      );
      if (snap !== this.lastSnapshot) {
        this.lastSnapshot = snap;
        this._onDidChangeTreeData.fire();
      }
    }
  }

  async getChildren(element?: DshTreeItem): Promise<DshTreeItem[]> {
    if (element === undefined) {
      // Root
      if (this.folderPath === undefined) {
        return [new StatusItem("Open a folder to see its DSH sessions.", "noWorkspace")];
      }
      if (this.error !== undefined && this.workspace === undefined) {
        return [new StatusItem(this.error, "error")];
      }
      if (this.workspace === undefined) {
        if (this.notRegistered) {
          return [
            new StatusItem(
              `This folder is not registered in DSH. Run "Register this folder in DSH".`,
              "notRegistered",
            ),
          ];
        }
        return [new StatusItem("Loading…", "info")];
      }
      return [new WorkspaceRootItem(this.workspace, this.folderPath)];
    }
    if (element instanceof WorkspaceRootItem) {
      if (this.sessions.length === 0) {
        return [new StatusItem("No sessions yet. Create one.", "info")];
      }
      return this.sessions.map((s) => new SessionItem(s));
    }
    return [];
  }

  getTreeItem(element: DshTreeItem): vscode.TreeItem {
    return element;
  }

  getWorkspace(): DshWorkspace | undefined {
    return this.workspace;
  }

  getFolderPath(): string | undefined {
    return this.folderPath;
  }
}
