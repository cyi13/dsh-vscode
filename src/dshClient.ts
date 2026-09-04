import { randomUUID } from "node:crypto";

/**
 * Minimal DeepSeek Harness web API client.
 *
 * DSH 0.1.2 exposes Typert Remote calls at /api/<namespace>/<method> and
 * wraps named arguments in payload.args. Workspace listing is a streaming-only
 * core API, so dsh-vscode-bridge supplies a one-shot compatibility endpoint at
 * /dsh-vscode/workspace.list.
 */

export interface DshWorkspace {
  workspaceId: string;
  path: string;
  title: string;
  sessionIds: string[];
  createdAt: string;
  updatedAt: string;
}

export interface DshSessionSummary {
  sessionId: string;
  updatedAt: number;
  running: boolean;
  blank: boolean;
  parentSessionId?: string;
  origin?: "subagent";
  cwd?: string;
  agentPreset?: string;
  projections?: {
    asOfSeq: number;
    values: Record<string, unknown>;
  };
}

export interface WorkspaceListResult {
  items: DshWorkspace[];
  archivedSessionIds: string[];
}

export interface SessionListResult {
  items: DshSessionSummary[];
}

export interface SessionCreateResult {
  sessionId: string;
  agentPreset?: string;
}

export interface WorkspaceCreateResult {
  workspace: DshWorkspace;
  created: boolean;
}

export class DshApiError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export class DshClient {
  private static readonly authCookies = new Map<string, string>();

  private constructor(
    public baseUrl: string,
    private readonly authenticationUrl?: string,
  ) {}

  /** Normalize the configured URL and retain a launch-token URL when present. */
  private static normalizeBaseUrl(raw: string): {
    baseUrl: string;
    authenticationUrl?: string;
  } {
    let value = raw.trim();
    if (!/^https?:\/\//i.test(value)) value = `http://${value}`;
    const parsed = new URL(value);
    const authenticationUrl = parsed.searchParams.has("token") ? parsed.href : undefined;
    parsed.search = "";
    parsed.hash = "";
    parsed.pathname = parsed.pathname.replace(/\/+$/, "");
    return { baseUrl: parsed.href.replace(/\/+$/, ""), authenticationUrl };
  }

  static fromRaw(raw: string): DshClient {
    const normalized = DshClient.normalizeBaseUrl(raw);
    return new DshClient(normalized.baseUrl, normalized.authenticationUrl);
  }

  private async requestCookie(): Promise<string | undefined> {
    const existing = DshClient.authCookies.get(this.baseUrl);
    if (existing !== undefined) return existing;
    if (this.authenticationUrl === undefined) return undefined;
    const response = await fetch(this.authenticationUrl, {
      redirect: "manual",
      signal: AbortSignal.timeout(2000),
    });
    const setCookie = response.headers.get("set-cookie");
    if (response.status !== 303 || setCookie === null) return undefined;
    const cookie = setCookie.split(";", 1)[0];
    DshClient.authCookies.set(this.baseUrl, cookie);
    return cookie;
  }

  /**
   * Probe reachability. Returns true when the GUI is served at baseUrl.
   * Any network error or non-2xx means the server is not reachable.
   */
  async ping(): Promise<boolean> {
    try {
      const cookie = await this.requestCookie();
      const res = await fetch(this.baseUrl + "/", {
        headers: cookie === undefined ? undefined : { cookie },
        signal: AbortSignal.timeout(2000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  private async call<T>(method: string, payload: unknown, signal?: AbortSignal): Promise<T> {
    const compatibilityCall = method === "workspace.list";
    const wireMethod = compatibilityCall ? method : method.replace(".", "/");
    const wirePayload = compatibilityCall
      ? payload
      : {
          args: {
            [method === "session.list" ? "_request" : "request"]: payload,
          },
        };
    const channel = compatibilityCall ? "dsh-vscode" : "api";
    const message = {
      type: "client-request",
      rpcId: randomUUID(),
      method: wireMethod,
      payload: wirePayload,
    };
    let res: Response;
    try {
      const cookie = await this.requestCookie();
      res = await fetch(`${this.baseUrl}/${channel}/${wireMethod}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(cookie === undefined ? {} : { cookie }),
        },
        body: JSON.stringify(message),
        signal: signal ?? AbortSignal.timeout(5000),
      });
    } catch (err) {
      throw new DshApiError("transport", `DSH unreachable at ${this.baseUrl}: ${String(err)}`);
    }
    if (!res.ok) {
      throw new DshApiError("http", `DSH API HTTP ${res.status} for ${method}`);
    }
    const body = (await res.json()) as {
      result?: { ok: boolean; value?: T; error?: { code: string; message: string } };
    };
    const result = body.result;
    if (!result) throw new DshApiError("malformed", `DSH API returned no result for ${method}`);
    if (!result.ok) {
      throw new DshApiError(
        result.error?.code ?? "rpc",
        result.error?.message ?? `DSH API error for ${method}`,
      );
    }
    return result.value as T;
  }

  listWorkspaces(signal?: AbortSignal): Promise<WorkspaceListResult> {
    return this.call<WorkspaceListResult>("workspace.list", {}, signal);
  }

  createWorkspace(path: string, signal?: AbortSignal): Promise<WorkspaceCreateResult> {
    return this.call<WorkspaceCreateResult>("workspace.create", { path }, signal);
  }

  listSessions(signal?: AbortSignal): Promise<SessionListResult> {
    return this.call<SessionListResult>("session.list", {}, signal);
  }

  createSession(workspaceId: string, signal?: AbortSignal): Promise<SessionCreateResult> {
    return this.call<SessionCreateResult>("session.create", { workspaceId }, signal);
  }

  /** Rename a session (normalized title returned by the host). */
  renameSession(
    sessionId: string,
    title: string,
    signal?: AbortSignal,
  ): Promise<{ title: string; seq: number }> {
    return this.call<{ title: string; seq: number }>(
      "session.rename",
      { sessionId, title },
      signal,
    );
  }

  /** Fork a session at its last completed turn; returns the child session id. */
  async forkSession(sessionId: string, signal?: AbortSignal): Promise<string> {
    const res = await this.call<{ sessionId: string }>(
      "session.fork",
      { sessionId },
      signal,
    );
    return res.sessionId;
  }

  /** Archive a session (keeps its log; hides it from grouping surfaces). */
  archiveSession(sessionId: string, signal?: AbortSignal): Promise<{ archivedSessionIds: string[] }> {
    return this.call<{ archivedSessionIds: string[] }>(
      "workspace.archiveSession",
      { sessionId },
      signal,
    );
  }

  /** Resolve the DSH workspace record for a local folder path (canonical match). */
  async resolveWorkspaceByPath(
    folderPath: string,
    signal?: AbortSignal,
  ): Promise<DshWorkspace | undefined> {
    const canonical = canonicalizePath(folderPath);
    const { items } = await this.listWorkspaces(signal);
    return items.find((w) => canonicalizePath(w.path) === canonical);
  }
}

/**
 * Best-effort canonicalization for path matching. DSH stores paths via
 * fs.realpath (resolving symlinks). VS Code's workspace path may be a
 * symlinked path (e.g. /tmp on macOS -> /private/tmp). We try realpathSync
 * and fall back to the raw path.
 */
export function canonicalizePath(p: string): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { realpathSync } = require("node:fs") as typeof import("node:fs");
    return realpathSync(p);
  } catch {
    return p;
  }
}
