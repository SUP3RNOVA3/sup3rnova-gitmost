import type { CapacitorConfig } from "@capacitor/cli";

// Capacitor configuration for the Gitmost mobile shell.
//
// AGPL / App Store note (see docs/mobile-app-plan.md section 9): the AGPL web
// client must NOT be bundled into the iOS .ipa. On iOS, point the shell at a
// hosted client via CAP_SERVER_URL (server.url) so the AGPL bytes are served
// from our own server rather than redistributed under Apple's DRM/usage-rules.
// Android may bundle the local web build (webDir) directly.
const serverUrl = process.env.CAP_SERVER_URL?.trim();

const config: CapacitorConfig = {
  appId: "xyz.vvzvlad.gitmost",
  appName: "Gitmost",
  // Web build output of apps/client (Android bundled mode / local assets).
  // Build it with `pnpm run client:build` before `cap sync`.
  webDir: "apps/client/dist",
  ...(serverUrl
    ? {
        // iOS / hosted mode: load the client from our server (AGPL-clean).
        server: {
          url: serverUrl,
          cleartext: false,
        },
      }
    : {}),
};

export default config;
