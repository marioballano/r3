# r3 for macOS

From this directory, run `make`. This produces `build/r3.app` and `build/r3.dmg`
with the r3 icon. Drag the app from the disk image into Applications, or run
`make run`. The app contains the WebGL UI, fonts, JavaScript, workers and the
latest published official radare2 WASI API build available on the first build.
The WASM backend needs neither Node, an installed r2, an HTTP server, nor
network access to analyze local files at runtime.

Building requires macOS 11 or later, Xcode command line tools, Node 22 or later,
and npm. The first build downloads npm dependencies and radare2 from
https://github.com/radareorg/radare2/releases. The WASM archive is verified with
GitHub's SHA-256 digest; `build/wasm/release.json` records its version, source
URL and archive/module checksums. Later builds reuse the cache. Run
`make update-wasm` to explicitly download the newest published WASI API release,
then `make` to repackage it. `make clean` removes the cache and build outputs.

Choose **Backend → WebAssembly (bundled)**, **r2pipe (spawn local r2)**, or
**Remote HTTP server** at startup. The start screen offers the same choices.
The selection applies to new sessions; existing tabs keep their own backend.
The local r2pipe option spawns an installed r2 over stdio, with no HTTP server.
It searches PATH, Homebrew and `~/.local/bin`, or uses the `R2` environment
variable. The open dialog also lets you select WASM or r2pipe for that file.

Open a binary with Cmd+O, Finder's Open With, or drag it into a window.
Cmd+T creates a blank tab where you can choose another backend or binary.
Dropping a file opens the file picker at its location. The following dialog
lets you open without analysis, use `aa`, use `aaa`, or select automatically
(`aaa` up to 4 MiB, otherwise `aa`). Click JACK IN to start the view and audio.
Each local tab has its own WebKit content, WASM worker/in-memory filesystem or
r2pipe process, analysis state and navigation history. Closing or reloading a
tab discards that session.

| Shortcut | Action |
| --- | --- |
| Cmd+N | New window |
| Cmd+O | Open a binary in a new window |
| Cmd+T | New blank tab |
| Cmd+L | Connect to a remote r2 HTTP server in a new tab |
| Cmd+W | Close the selected tab |
| Cmd+1 … Cmd+9 | Select a tab |
| Cmd+R | Reload the selected tab |
| Cmd++ / Cmd+- / Cmd+0 | Zoom in / out / reset |
| Cmd+F | Full screen |

For a remote session, start an r2 HTTP server with a binary already open:

```sh
r2 -e http.sandbox=false -c '=h' /path/to/binary
```

Choose **File → Connect to r2 Server…** and enter its HTTP(S) base URL, such as
`http://127.0.0.1:9090`. `/cmd/` URLs and reverse-proxy base paths are supported.
The default keeps the remote server's existing analysis; the connection dialog
also offers `aa` and `aaa`. The bundled UI stays in the app and commands use
UTF-8 `POST /cmd/` requests through native URLSession, so browser CORS settings
are unnecessary. HTTP Basic authentication is supported with a
`https://user:password@host:port` URL. HTTPS uses the system certificate checks.
Remote tabs share the remote server's r2 state if they connect to the same
server; use different r2 servers for independent remote sessions.

The ordinary `npm run dev` / `npm start` workflow remains available. Its stdio
r2pipe server and the native clients use the same analysis and inspection code
in `src/net/session.ts`, through the `R2Client` / `CommandTransport` interfaces.
Local assets use an in-process `r3://app/` WKURLSchemeHandler. The app never
starts a listening socket. It spawns r2 only when you select the r2pipe backend.

```sh
make check       # typecheck and real WASM backend integration
make check-ui    # WebKit/WASM integration and native keyboard shortcuts
make check-remote # requires installed r2; WASM + stdio + HTTP tabs
make run FILE=/bin/ls
```

Builds target the current machine's architecture. Override `SWIFTFLAGS` to
cross-compile the small Swift host. The default DMG build uses ad-hoc signing
unless you set `SIGN_IDENTITY`.

## Distribution DMG

Install your **Developer ID Application** certificate and private key in
Keychain. Run the setup once on the release Mac, then build the release DMG.

```sh
make notary-setup
make distdmg
```

Both commands work here or from the repository root. Setup creates the
`r3-notary` Keychain profile. For Apple Account authentication, it fills in the
Team ID from your Developer ID Application certificate and the Apple Account
from Xcode when it can match them. Apple prompts for the app-specific password
and for any missing fields. To create the password, sign in to
[your Apple Account](https://account.apple.com/) and select
**Sign-In and Security → App-Specific Passwords**.

`make distdmg` signs the app with the hardened runtime, signs the disk image,
and submits it for notarization. After stapling and validating the ticket, it
writes `app/mac/build/r3-release.dmg` relative to the repository root. It
preserves any previous release image if a step fails.

If you already have a profile, `make notary-profiles` opens Keychain Access.
Select **iCloud** or **Local Items**, search for `com.apple.gke.notary.tool`,
and open the matching item. The part of **Account** after
`com.apple.gke.notary.tool.saved-creds.` is the profile name.
Run `make distdmg NOTARY_PROFILE='profile name'` to use it.

If more than one Developer ID Application identity is available, select one
with `make distdmg SIGN_IDENTITY='Developer ID Application: Name (TEAMID)'`.
You can also set `SIGN_IDENTITY` to the certificate's SHA-1 fingerprint.

The native window/tab/drag-and-drop code is adapted from
`radare2-webui/src/macos` (LGPL-3.0); its attribution and license summary are
bundled in `Contents/Resources/licenses`, alongside radare2's license files.
