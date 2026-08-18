/**
 * dsh-deeplink host plugin: a deliberate no-op row.
 *
 * The web GUI's deep-link behavior lives entirely in the browser half
 * (`./client`). This host row exists so the client-modules scan discovers
 * the `dsh.client` declaration in package.json and serves the client bundle
 * at /plugins/dsh-deeplink/client.js. No service, tool, or model surface is
 * provided from the host side.
 */

/** Cordis plugin name (the Loader entry and client bundle id). */
export const name = "dsh-deeplink";

/**
 * Mount the plugin. Nothing to do on the host plane — see the module doc.
 * @param ctx - host cordis context (unused).
 */
export function apply(ctx: unknown): void {
  // Deliberately empty: the client bundle carries all behavior.
  void ctx;
}
