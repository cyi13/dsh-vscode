/**
 * dsh-deeplink client plugin: open the session named by the URL.
 *
 * The web GUI has no native deep links; this browser half fills the gap.
 * When the page loads with `?session=<id>` (optionally plus `?workspace=<id>`),
 * it waits for the session list baseline and opens that session, so an
 * external caller (e.g. the dsh-sessions VS Code extension) can jump straight
 * into a conversation instead of landing on the empty no-session state.
 *
 * The session list is a client-runtime service (`ctx.sessions`) whose `list`
 * is an observable snapshot store; `open(id)` selects the session. We wait for
 * `phase === 'ready'` and the id to be present in `byId` before opening —
 * `open()` fails loud on unknown ids, so we never call it against a stale list.
 */

/** Self-contained subset of the client-runtime surface this plugin uses. */
export interface SessionsService {
  list: {
    getSnapshot(): {
      phase: "pending" | "ready";
      byId: Record<string, { sessionId: string }>;
    };
    subscribe(fn: () => void): () => void;
  };
  open(id: string): void;
}

/** Plugin context (inject: sessions). */
export interface ClientContext {
  sessions: SessionsService;
}

/** Max time to wait for the session list baseline before giving up. */
const TIMEOUT_MS = 20_000;

/** Cordis services this client plugin requires before apply runs. */
export const inject = ["sessions"];

/**
 * Open the session named by `?session=` once the list baseline is ready.
 * @param ctx - client root context with the sessions service injected.
 */
export function apply(ctx: ClientContext): void {
  const params = new URLSearchParams(window.location.search);
  const sessionId = params.get("session");
  // `?workspace=` is accepted for forward compatibility; opening the session
  // is what matters. (A sidebar focus for the workspace is future work.)
  if (sessionId === null || sessionId === "") return;

  const sessions = ctx.sessions;
  const list = sessions.list;

  let done = false;
  let unsubscribe: () => void = () => {};
  const finish = (): void => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    unsubscribe();
  };

  const tryOpen = (): void => {
    const snap = list.getSnapshot();
    if (snap.phase !== "ready" || snap.byId[sessionId] === undefined) return;
    finish();
    try {
      sessions.open(sessionId);
    } catch (error) {
      console.error("[dsh-deeplink] failed to open session", sessionId, error);
    }
  };

  const timer = setTimeout(() => {
    console.warn(
      `[dsh-deeplink] session ${sessionId} did not appear in the list within ${TIMEOUT_MS}ms; giving up`,
    );
    finish();
  }, TIMEOUT_MS);

  unsubscribe = list.subscribe(tryOpen);
  tryOpen();
}
