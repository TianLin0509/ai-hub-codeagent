# Secretary control component

This is the meeting-room component embedded in the company edition of Hub.
It reuses the v2.1.0 shell and the existing booking engine. The v2.1.1 code
package adds a local GUI-thread control adapter and preserves the browser
profile, original settings and post-booking behavior.

- `baseline.json`: original signed v2.1.0 release manifest, including the shell asset.
- `control.json`: signed v2.1.1 code manifest.
- `msz-code-2.1.1.zip`: original Python modules plus `hub_control.py` and the
  control-aware entry point. Inspectable with any ZIP reader.
- No private signing key is included.
- `runtime/MishuTerminator-2.1.0.exe` is a build artifact, excluded from Git.
  It is the original signed release asset: 80,568,759 bytes (76.84 MiB).
  **Since v3.1.3 (2026-10-22) the installer no longer carries it.** The app
  downloads it on first use of 「抢会议室」 from the official public release
  (`room-runtime-download.js`), verifies size and SHA-256 against this signed
  `baseline.json`, and caches it under `<Hub data>/company-assistant/room-runtime/<sha256>/`.
  An existing installation that still has the bundled copy reuses it, so users
  upgrading from 3.1.2 do not download it again. `build-runtime.js` is now only
  for e2e and offline staging; it is no longer a packaging hook.
- Both manifests are verified using the secretary's existing Ed25519 public key.
- The code package was built with the secretary's existing `tools/release.py`
  in an isolated source copy, without publishing.

Compatibility: shell 1; the GUI continues to own configuration and the
single-instance lock. A running old secretary must be exited normally before
the new control adapter can load. Hub does not terminate it.

Company source export remains usable for development without the large runtime.
To exercise the real exe locally (e2e), stage it from the official release:

```powershell
$env:AI_HUB_ROOM_RUNTIME_SOURCE = '<official release directory>\MishuTerminator-2.1.0.exe'
node core/company-assistant/room-component/build-runtime.js
```

Packaging deliberately does not stage it, and `target.json` excludes
`room-component/runtime/**` from the installer, so a locally staged copy never
ships by accident. A runtime change requires a new signed baseline under the
release policy; the downloader reads size and hash from that manifest, so the
download URL alone cannot change what gets installed.

At first use, Hub copies the verified exe to
`<Hub data>/company-assistant/room-runtime/<sha256>/` so running Windows handles
do not lock the installation during an update. The source copy is taken from the
installer tree (including `app.asar.unpacked` on installs from before v3.1.3);
when the machine has no copy at all, the user downloads it from the setting page
and the size and hash come from the signed `baseline.json`, not from the URL. New user state lives in
`<Hub data>/company-assistant/meeting-room/`; previously connected users keep
their data home, rules and browser profile. Hub sets `MSZ_HOME` and `MSZ_NO_TRAY=1`,
disables the component's own updater/autorun, and defaults booking to stopped.
Only a requested `start` command enables the existing weekly booking loop.

The original Qt window object still owns worker threads, configuration and
post-booking actions, but is hidden. No separate app installation or exe picker
is required. Normal booking uses existing Edge/Chrome in headless mode; explicit
login opens its browser and retains the profile. This browser login is separate
from the WeLink CLI login. Rewriting the engine in JavaScript is a different
project; this integration does not claim that migration or a real-company
booking acceptance test.

The first release supports weekly rules for bookings seven days after the
opening day, matching the original engine. A one-off request for tomorrow is
not silently converted into a recurring rule.
