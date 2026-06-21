/**
 * Detects whether the client is running inside a Capacitor native WebView
 * (native iOS/Android shell from the feature/mobile-app-bootstrap branch).
 *
 * This is a pure runtime check against the global `Capacitor` object that the
 * native bridge injects — no `@capacitor/*` dependency is added. On the plain
 * browser / installed-PWA path `window.Capacitor` is undefined, so this returns
 * false and the Workbox service worker registers normally.
 *
 * Inside the native WebView the SW must NOT register: it would layer a redundant
 * (and conflicting) cache over Capacitor's own asset serving and interfere with
 * the native auth/CORS flow.
 */
export function isCapacitorNativePlatform(): boolean {
  try {
    const cap = (globalThis as any)?.Capacitor;
    return !!(cap && typeof cap.isNativePlatform === "function"
      ? cap.isNativePlatform()
      : cap?.isNativePlatform);
  } catch {
    return false;
  }
}
