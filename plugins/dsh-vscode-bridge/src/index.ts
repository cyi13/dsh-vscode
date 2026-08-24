/**
 * dsh-vscode-bridge host plugin: a deliberate no-op row.
 *
 * All behavior lives in the browser half (`./client`), which provides clear
 * in-page zoom and clipboard relay. This row lets client-modules serve the
 * bundle at /plugins/dsh-vscode-bridge/client.js.
 */

/** Cordis plugin name (the Loader entry and client bundle id). */
export const name = "dsh-vscode-bridge";

/**
 * Mount the plugin. Nothing to do on the host plane.
 * @param ctx - host cordis context (unused).
 */
export function apply(ctx: unknown): void {
  void ctx;
}
