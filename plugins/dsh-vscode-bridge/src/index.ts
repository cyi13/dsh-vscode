/**
 * DSH VS Code bridge host plugin.
 *
 * Besides serving the browser client bundle, the host exposes one small
 * compatibility RPC for the VS Code extension, and applies an in-memory
 * local-only bypass of DSH's browser authentication.
 *
 * WHY the bypass exists: dsh sets its auth cookie with SameSite=Strict. VS
 * Code's webview is a cross-site iframe (vscode-webview:// top level vs
 * http://127.0.0.1 iframe), so the browser never sends that cookie on iframe
 * navigations and the embedded GUI stays on "authentication required". The
 * desktop shell works around it by being a top-level http page; the VS Code
 * extension cannot.
 *
 * The bypass wraps ONLY browserAuth.isAuthenticated: requests from a loopback
 * Host authority are treated as authenticated in-process, everything else
 * (LAN/public) keeps the real cookie validation. DSH's Host/Origin fence in
 * requestRejection is left untouched, so malicious cross-site callers (a
 * local webpage embedding or fetching DSH) are still rejected with 403 before
 * authentication is consulted. This is memory only — no installed DSH file is
 * modified, and DSH updates cannot erase it (the plugin itself lives under the
 * profile and survives npm -g upgrades).
 *
 * Why not distinguish "VS Code iframe" from "local browser tab"? They are
 * indistinguishable at the HTTP layer: the DSH GUI inside the iframe talks to
 * http://127.0.0.1:3080 as a SAME-ORIGIN client (Origin: http://127.0.0.1:3080,
 * Sec-Fetch-Site: same-origin) — byte-for-byte the same request a normal local
 * browser tab sends. The only thing they both lack is the SameSite=Strict
 * cookie, so the cookie check itself is the single correct place to relax for
 * loopback.
 */

/** Cordis plugin name (the Loader entry and client bundle id). */
export const name = "dsh-vscode-bridge";

interface WorkspaceEntity {
  readonly id: string;
  readonly path: string;
  readonly title: string;
  readonly sessionIds: readonly string[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** Minimal shape of the connection service methods we wrap at runtime. */
interface ConnectionLike {
  browserAuth?: {
    isAuthenticated?: (request: unknown) => boolean;
  };
}

interface HostContext {
  inject(
    services: readonly string[],
    callback: (host: {
      connection: ConnectionLike & {
        rpc: {
          handle(
            channel: string,
            handler: (endpoint: string, payload: unknown) => Promise<unknown>,
          ): unknown;
        };
      };
      workspaceRegistry: {
        list(): WorkspaceEntity[];
        readonly archivedSessionIds: readonly string[];
      };
    }) => void,
  ): void;
}

function workspaceView(workspace: WorkspaceEntity): Record<string, unknown> {
  return {
    workspaceId: workspace.id,
    path: workspace.path,
    title: workspace.title,
    sessionIds: [...workspace.sessionIds],
    createdAt: workspace.createdAt,
    updatedAt: workspace.updatedAt,
  };
}

/** Read one header value from either a Fetch Headers object or a plain map. */
function headerOf(
  headers: unknown,
  name: string,
): string | undefined {
  if (!headers) return undefined;
  const maybeHeaders = headers as { get?: (n: string) => string | null };
  if (typeof maybeHeaders.get === "function") {
    const value = maybeHeaders.get(name);
    if (value !== null && value !== undefined) return value;
  }
  const record = headers as Record<string, unknown>;
  const value =
    record[name] ??
    record[name.toLowerCase()] ??
    record[name.toUpperCase()];
  if (value === undefined) return undefined;
  return Array.isArray(value) ? String(value[0]) : String(value);
}

/** Whether the request's Host header names a loopback authority. */
function isLoopbackHost(headers: unknown): boolean {
  const host = headerOf(headers, "host");
  if (typeof host !== "string" || host === "") return false;
  try {
    const hostname = new URL(`http://${host}`).hostname;
    return (
      hostname === "127.0.0.1" ||
      hostname === "localhost" ||
      hostname === "[::1]"
    );
  } catch {
    return false;
  }
}

/**
 * Why wrapping only `browserAuth.isAuthenticated` (instead of the outer
 * requestRejection / authorizeIndex gates) is the right shape:
 *
 *  - DSH's real security boundary is the Host/Origin fence inside
 *    requestRejection (host allow-list, Same-Origin check, cross-site 403).
 *    We keep that gate intact and never touch it, so a malicious local
 *    webpage that cross-site fetches DSH is still rejected with 403 before
 *    authentication is even consulted.
 *  - The fence passes for the legitimate requests the VS Code embedding needs:
 *    the DSH GUI inside the iframe talks to http://127.0.0.1:3080 as a
 *    SAME-ORIGIN client (Origin: http://127.0.0.1:3080), and the extension
 *    host is a headless client (no Origin / no Sec-Fetch-*). Both are
 *    indistinguishable from a normal local browser tab at the HTTP layer —
 *    which is exactly why a cookie/SameSite distinction can never work here.
 *    What those requests all lack is the SameSite=Strict cookie that the
 *    vscode-webview:// top-level context can never acquire.
 *  - So the only missing ingredient is the cookie check itself. Making
 *    isAuthenticated treat loopback authorities as authenticated lets the
 *    whole legitimate local path (iframe GUI + extension host + browser tab)
 *    work, while every request from a non-loopback host (LAN/public) still
 *    goes through the real cookie validation untouched.
 */
function applyVscodeAuthBypass(connection: ConnectionLike): void {
  const browserAuth = connection.browserAuth;
  const originalIsAuthenticated = browserAuth?.isAuthenticated?.bind(browserAuth);
  if (browserAuth === undefined || originalIsAuthenticated === undefined) {
    return;
  }
  browserAuth.isAuthenticated = (request) => {
    const headers = (request as { headers?: unknown })?.headers;
    if (isLoopbackHost(headers)) return true;
    return originalIsAuthenticated(request);
  };
}

/** Mount the host compatibility channel and the VS Code auth bypass. */
export function apply(ctx: HostContext): void {
  ctx.inject(["connection", "workspaceRegistry"], (host) => {
    applyVscodeAuthBypass(host.connection);

    host.connection.rpc.handle("/dsh-vscode", async (endpoint) => {
      if (endpoint !== "workspace.list") {
        return {
          ok: false,
          error: {
            code: "dsh-vscode/not-found",
            message: `Unknown DSH VS Code bridge endpoint: ${endpoint}`,
          },
        };
      }
      return {
        ok: true,
        value: {
          items: host.workspaceRegistry.list().map(workspaceView),
          archivedSessionIds: [...host.workspaceRegistry.archivedSessionIds],
        },
      };
    });
  });
}
