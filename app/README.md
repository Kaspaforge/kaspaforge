# Kaspa Safe — Android app (Tauri 2)

Wraps the Kaspa Safe web frontend (`web/` in this repo) into an Android APK with Tauri 2.
The `android-apk` GitHub Actions workflow in this repository builds an **unsigned** release
APK from these sources on every push and runs an emulator smoke test.

## How it works

- **All assets are bundled** — HTML/CSS/JS/WASM ship inside the APK: the app opens and signs
  transactions even if the website is unreachable (only a node/API endpoint is needed to
  broadcast).
- **API origin** — `web/assets/app.js` (`API_ORIGIN`): empty (same-origin) when served from
  the product hosts; any other context (APK = `tauri.localhost`, offline copy) uses the
  absolute public API base. CORS for `/api/safe/` is open (public API, no cookies; the
  access token travels in the query string).
- **WASM** — the bundled `vault-core` runs in the Android WebView (minSdk 24 = Android 7.0+).
  CSP includes `'wasm-unsafe-eval'`. Smoke marker: outside the website, `app.js` performs a
  `gen_keys()` after `init()` and logs `[ksafe-core] ok` — CI greps for it in the emulator
  logcat.
- **Not in the APK:** the service worker (hostname guard — the bundle is already offline)
  and the support chat widget (its captcha is hostname-bound).

## Release signing

CI produces an **unsigned** artifact (`KaspaSafe-android-unsigned`). Release APKs are
zipaligned, signed and published by the operator outside this repository — the signing key
never appears in CI or in this repo. The `release-apk` workflow then mirrors the signed APK
(sha256-verified) into GitHub Releases on `apk-v*` tags.

Android updates must be signed with the same key, otherwise a reinstall is required.

## Local build (not needed for releases; requires Android SDK/NDK)

```bash
npm install
cp -r ../web web            # stage web assets (not committed)
npx tauri android init
npx tauri icon app-icon.png
npx tauri android build --apk
```
