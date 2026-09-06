# Opera GX acceptance — September 6, 2026

The current OAuth-only local dashboard and private SuperGrok wizard passed the
Mac browser acceptance matrix. This is browser evidence using synthetic service
adapters, not a new provider test or native Windows acceptance.

## Observed checks

- Actual Opera GX executable with a separate temporary profile; no personal n8n
  tabs were navigated or refreshed. CDP user agent contains OPR/135.0.0.0.
- Dashboard and plan review at 390x844, 900x800 and 1440x900, light and dark.
  No document horizontal overflow. Narrow navigation has its own horizontal
  scroll area; Activity was reached through normal browser interaction.
- Healthy, stale, failed refresh, absent and unavailable inventory states.
  Stale/error preserves prior truth and disables maintenance. Recovery re-enables
  actions; absent shows first-connection setup. Deliberate error produces the
  expected failed HTTP response, with no observed JavaScript exceptions.
- Keyboard Tab after refresh reaches the service control with a visible solid
  outline. Native Opera zoom reached 200% (1440 outer width, 720 CSS inner width,
  device pixel ratio 2), with no horizontal document overflow.
- Reduced-motion media preference matched and animation durations were reduced
  to 0.00001s. Screenshots inspected for mobile, tablet, desktop and zoom.
- Official OAuth guidance is informational; no login or session change occurred.
- Private SuperGrok wizard: explicit target/network selection, unconfirmed install
  disabled, deliberate install failure, confirmation reset, reconfirmed retry,
  ready guidance, explicit removal confirmation, successful owned fixture removal.
- The server injected synthetic adapters for every operation. Unimplemented
  operations throw. Installation/removal only changed an in-memory fixture flag.
  Real Docker/n8n/OAuth actions were unavailable to this browser fixture.

## Evidence and limits

JSON observations and screenshots are in browser-evidence/ in the handoff packet.
The first dashboard mobile screenshot caught a transition; the settled capture
is dashboard-390-light-settled.png. A bootstrap was regenerated after an initial failed
attempt; subsequent navigation succeeded. Expiry was not independently proven. One helper wait used a capitalized
heading mismatch; it was corrected without changing production source. These
harness issues are not product failures.

Windows POSIX-test placement was corrected in test/supergrok-session.test.js:
three POSIX ownership tests skip only on Windows, token selection runs everywhere,
and a Windows-only direct-host rejection test protects the Linux-runtime boundary.
Focused Mac result: four pass, one expected platform skip. Fresh behavioral
read-only review accepted the change without findings; review surface reported
GPT-6 and did not expose effort. The filesystem was unrestricted, not isolated.
Native Windows execution remains pending. Earlier full-suite counts predate this
one added platform test; no new full-suite count is claimed.

No commit, push, release, version change, VPS write, credential reset or existing
n8n lifecycle/configuration change was performed. Protected release gates remain.
