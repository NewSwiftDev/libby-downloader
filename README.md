# Libby Downloader

Chrome extension and Safari Web Extension for saving a borrowed Libby audiobook as chapter MP3s. This repository is a Safari port of [pdugan20/libby-downloader](https://github.com/pdugan20/libby-downloader) (MIT). The original project’s copyright and the MIT terms are in [LICENSE](LICENSE).

The Chrome package still uses `chrome.downloads`. Safari has no downloads API, so the Mac or iOS app writes the files when the extension sends a native message.

## What gets saved

| Platform | Where chapters go |
| --- | --- |
| Chrome | `~/Downloads/libby-downloads/<title>/chapter-NNN.mp3` and `metadata.json`, via `chrome.downloads` |
| Safari on Mac | The same folder. The extension sends each chapter URL to the app, and the app downloads it into `~/Downloads` |
| Safari on iPhone or iPad | App Group `group.com.libbydownloader.safari`, under `libby-downloads/<title>/`. The app can copy that folder into Files |
| Safari fallback | If the app cannot fetch a chapter, the player saves a flat file through Safari and the app moves it into `libby-downloads/<title>/`. `metadata.json` is still written once, by the app |

`metadata.json` keeps the same `{ metadata, chapters }` shape the upstream tool uses.

## Chrome vs Safari

| | Chrome | Safari macOS | Safari iOS |
| --- | --- | --- | --- |
| Download button in the Libby player | Yes | Yes | Yes |
| Read `window.BIF` and the odread crypto parameters in the page MAIN world | Yes | Safari 18 or newer | Safari 18 or newer |
| Organized `chapter-NNN.mp3` folders | Yes | Yes, through the containing app | Yes, in the app group |
| `metadata.json` next to the chapters | Yes | Yes | Yes |
| Page fetch when the app cannot save a URL | Not used | App moves the flat download into the book folder | App group when native messaging works |
| Toolbar popup with save status | Yes | Yes | Yes |
| CLI tagging and M4B merge from the upstream project | Not in this port | No | No |

## Limitations

- MAIN-world capture is required to build chapter URLs. Safari added `world: "MAIN"` content scripts in Safari 18. Older Safari loads the rest of the extension, but extraction will not see Libby’s page objects.
- Let the audiobook play for a few seconds before downloading so Libby publishes its crypto parameters. This is the same requirement as the Chrome extension.
- The native app fetches the signed `https://*.libbyapp.com` chapter URL and follows its redirect to `https://*.cdn.overdrive.com`. Other hosts are refused. A page fetch cannot use cookies on that redirect: the CDN replies with `Access-Control-Allow-Origin: *`.
- iOS does not have a user-visible `~/Downloads` directory for the extension. Files go to the app group. Open the Libby Downloader app and tap **Show Downloaded Books** to copy them into the Files app. If the app group entitlement is missing, Safari saves flat files instead.
- Safari may ask before saving several files in a row when the fallback path is used.
- The upstream command-line tagger and M4B merger are not part of this port. `metadata.json` is still written so that tool can be pointed at a finished folder.
- This is for audiobooks your library has loaned you. You are responsible for following your library’s terms.

## Build and enable on a Mac

Xcode 16 or newer is required. This environment does not build the Xcode project; the project file, shared schemes, entitlements, and Swift sources are set up for you to build locally.

1. Open `libby-downloader.xcodeproj`.
2. Select the **libby-downloader (macOS)** scheme.
3. In Signing & Capabilities, choose your team for both the app and the extension. The project currently uses team `8DJHS9AWYU`. Change that if it is not your team.
4. Register the App Group `group.com.libbydownloader.safari` for these bundle IDs (the same IDs are used for iOS):
   - `com.renewalsoftware.libby-downloader`
   - `com.renewalsoftware.libby-downloader.Extension`
5. Run the macOS app.
6. Use **Quit and Open Safari Extensions Preferences…** and turn Libby Downloader on. Allow it on `libbyapp.com`.
7. Open a borrowed audiobook, play it briefly, and click the download button in the player bar.
8. Finder opens `~/Downloads/libby-downloads` from **Show Downloaded Books**. Each book is a folder of `chapter-001.mp3`, `chapter-002.mp3`, … and `metadata.json`.

The macOS extension is sandboxed with outgoing network access and read-write access to Downloads. Those entitlements are in `macOS (Extension)/LibbyDownloaderExtension.entitlements`.

### iPhone and iPad

1. Select the **libby-downloader (iOS)** scheme and run it on a device or a simulator that includes Safari.
2. Turn the extension on in Settings → Safari → Extensions, and allow `libbyapp.com`.
3. Download from the player the same way.
4. Open the Libby Downloader app and tap **Show Downloaded Books**. That copies the app-group folder into the app’s Documents directory and presents the share sheet. The iOS target also turns on file sharing so the copy is visible in Files.

If the app group is not on the provisioning profile, the extension replies `app-group-unavailable` and the player frame falls back to flat Safari downloads.

## Load the Chrome package

The Chrome extension stays in `chrome-extension/` and does not need the Xcode app.

1. `npm test` (or `npm run assemble`) refreshes `chrome-extension/` from `web/`.
2. Open `chrome://extensions`.
3. Turn on Developer mode.
4. Choose **Load unpacked** and select the `chrome-extension` folder.

Chrome saves with the downloads API. The same background script detects `chrome.downloads` and does not use native messaging there.

## Tests

```bash
npm test
```

Node’s built-in test runner covers path sanitizing, the Chrome filename layout, the native-message protocol, fallback decisions, and checks that the Xcode project still contains both app targets, both extension targets, the app group, and the Downloads entitlement. Xcode is not required for that run.

## Project map

- `web/` — extension source. `npm run assemble` copies it into `chrome-extension/` and `Shared (Extension)/Resources/`.
- `Shared (Extension)/DownloadStore.swift` — native save implementation used by both Safari extensions.
- `Shared (Extension)/SafariWebExtensionHandler.swift` — `browser.runtime.sendNativeMessage("application.id", …)` handler.
- `macOS (App)` and `iOS (App)` — containing apps that enable the extension and reveal saved books.
- `libby-downloader.xcodeproj` — macOS and iOS application targets, each embedding its Safari Web Extension.

## Native message actions

The background script sends JSON dictionaries. The app replies with `{ "ok": true, "path": "…" }` or `{ "ok": false, "error": "…" }`.

| Action | Purpose |
| --- | --- |
| `ping` | Reports `platform` (`macos` or `ios`) and whether storage is `downloads` or `app-group` |
| `saveFromUrl` | Downloads an allowed chapter URL to `<title>/chapter-NNN.mp3`, following the redirect onto the OverDrive CDN. An optional `cookie` header is sent only to the original Libby host |
| `saveText` | Writes `<title>/metadata.json` once per book |
| `moveFlat` | Moves a flat `Title - chapter-NNN.mp3` from `~/Downloads` into the book folder |

A transport failure or an HTTP error switches the remaining chapters to the in-page blob fallback. `invalid-url` and `invalid-path` do not.
