/**
 * dsh-clipboard host plugin: a deliberate no-op row.
 *
 * All behavior lives in the browser half (`./client`), which bridges
 * copy/paste to the embedding host. This host row exists so the
 * client-modules scan serves the client bundle at
 * /plugins/dsh-clipboard/client.js.
 */

/** Cordis plugin name (the Loader entry and client bundle id). */
export const name = "dsh-clipboard";

/**
 * Mount the plugin. Nothing to do on the host plane.
 * @param ctx - host cordis context (unused).
 */
export function apply(ctx: unknown): void {
  void ctx;
}
