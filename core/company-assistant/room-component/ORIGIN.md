# Secretary control component

This is a local integration candidate for the user-owned Mishu Terminator.
It reuses the v2.1.0 shell and the existing booking engine. The v2.1.1 code
package adds a local GUI-thread control adapter and preserves the browser
profile, original settings and post-booking behavior.

- `baseline.json`: original signed v2.1.0 release manifest, including the shell asset.
- `control.json`: signed v2.1.1 code manifest.
- `msz-code-2.1.1.zip`: original Python modules plus `hub_control.py` and the
  control-aware entry point. Inspectable with any ZIP reader.
- No private signing key is included.
- Both manifests are verified using the secretary's existing Ed25519 public key.
- The code package was built with the secretary's existing `tools/release.py`
  in an isolated source copy, without publishing.

Compatibility: shell 1; the GUI continues to own configuration and the
single-instance lock. A running old secretary must be exited normally before
the new control adapter can load. Hub does not terminate it.

The first release supports weekly rules for bookings seven days after the
opening day, matching the original engine. A one-off request for tomorrow is
not silently converted into a recurring rule.
