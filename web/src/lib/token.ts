/**
 * WHERE THE TOKEN COMES FROM.
 *
 * The daemon authenticates every `/api/*` call and its contract says nothing
 * about how a browser gets the token (`docs/daemon/api.md` §2 — deliberately:
 * the token file is the source of truth). The panel therefore uses the two
 * places a browser can be handed one:
 *
 *   1. the URL fragment — `http://127.0.0.1:4597/#token=…` — which is read once
 *      and then REMOVED from the address bar, so it does not stay in the
 *      history entry, and
 *   2. `localStorage`, where that value is kept for the next visit.
 *
 * With neither, the panel shows a gate page naming `~/.pi/agent/rg-daemon.token`
 * instead of failing every request with a 401 nobody can read.
 */

const STORAGE_KEY = "rg-daemon-token";
const TOKEN_CHANGED_EVENT = "rg-token-changed";

function readFragmentToken(): string | null {
  const hash = window.location.hash;
  if (!hash.startsWith("#")) return null;
  const params = new URLSearchParams(hash.slice(1));
  const token = params.get("token");
  return token !== null && token.trim() !== "" ? token.trim() : null;
}

/** The token to authenticate with, or null when the panel has never been given one. */
export function readToken(): string | null {
  const fromFragment = readFragmentToken();
  if (fromFragment !== null) {
    storeToken(fromFragment);
    // Drop it from the address bar: a fragment survives a reload and a bookmark.
    window.history.replaceState(null, "", window.location.pathname + window.location.search);
    return fromFragment;
  }
  return window.localStorage.getItem(STORAGE_KEY);
}

export function storeToken(token: string): void {
  window.localStorage.setItem(STORAGE_KEY, token);
  window.dispatchEvent(new Event(TOKEN_CHANGED_EVENT));
}

export function clearToken(): void {
  window.localStorage.removeItem(STORAGE_KEY);
  window.dispatchEvent(new Event(TOKEN_CHANGED_EVENT));
}

/** Subscribe to token changes (gate page ⇄ app). Returns an unsubscribe. */
export function onTokenChange(listener: () => void): () => void {
  window.addEventListener(TOKEN_CHANGED_EVENT, listener);
  window.addEventListener("storage", listener);
  return () => {
    window.removeEventListener(TOKEN_CHANGED_EVENT, listener);
    window.removeEventListener("storage", listener);
  };
}
