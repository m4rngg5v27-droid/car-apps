# M Setup (draft)

The iDrive 8 M Setup page as a renderer app, on the SETUP, M1 and M2 pages:

| Row | Options | |
|---|---|---|
| Engine | Efficient · Sport · Sport Plus | dummy |
| Steering | Comfort · Sport | dummy |
| Gearbox | Comfort · Sport · Sport Plus | dummy |
| M xDrive | 4WD · 2WD | dummy |
| Exhaust | Open · Closed · OEM | **real**: drives the electric exhaust flap |

A dummy tap only changes the screen and the app's `data/msetup.json`; nothing goes to the car. Each page keeps its
own dummy choices. Exhaust is one live state for every page and starts as OEM after every app start.

![preview](preview.png)

## Exhaust

BMW's own DME job (EL_AGK, the one Live Adjustments uses): `2F 60FD 03 03E8` open (10 %), `2F 60FD 03 2328` closed
(90 %), `2F 60FD 00` back to the DME, over the head unit's diagnostic link (TASU) to the DME `0x12`. What this app
adds over Live Adjustments (`src/exhaust.js`):

- **Held.** The DME ends an override by itself after ~20 s; the app sends Open / Closed again every 15 s, so it
  stays while the app runs. If the app stops or crashes the override runs out and the DME takes the flap back.
- **Closed is guarded.** At 4500 rpm or more, or without a fresh engine speed (OBD `01 0C`, read every second while
  Closed is chosen), the flap goes back to the DME; it closes again under 4000 rpm. Open is not limited.
- **Read back.** `22 64FD` every 2 s while the screen shows or the flap is held: the line under *Exhaust* says where
  the flap is. A DME that refuses `22 64FD` has no electric flap, and nothing is sent to it.
- **Handed back** at once when the app shuts down, and on OEM.
- Only the flap job may go out (the guard refuses every other write); reads are OBD `01 0C` and `22 64FD`.

Not used: MHD's own flap control (`2F 02 00/01/02`, from a capture of MHD's app) keeps its state in the tune, has no
read-back and nothing that would open a closed flap again once the app is gone.

Tested: the open / close / OEM commands were confirmed on one car with a Bosch MG1 by cauliflowermossgrape/idrive7-apps
(2026-10-29); in this repository's Live Adjustments the flap is not car-tested yet. Not car-tested at all: the 15 s
hold, the rpm guard and this app. Only on the host: `test/` (fake DME).

## Files

- `layout.js` builds the screen (`renderer/screens.json`); `src/rows.js` the rows and pages.
- `src/main.js` the app; `src/exhaust.js` the flap; `src/diag.js`, `src/tasu-guard.js` from Live Adjustments 1.0.5.
- `runtime/` the renderer runtime (as in Tailscale 1.0.4); `pkg/` manifest and permissions (as in Live Adjustments).
- `node drafts/iteriodev_msetup/build.js` writes `apps/iteriodev_msetup/` (package, `app.json`, icon) and `preview.png`.
- `node drafts/iteriodev_msetup/test/test_exhaust.js` (15 checks) and `test/test_app.js` (10 checks, the built
  package with a fake renderer, HMI and DME).

Next: capture what the stock M Setup page sends (SOME/IP, parked) and wire the dummy rows to it one at a time.
M xDrive 2WD can reuse the xDrive-off job (`2E DB E1 00`, stationary in P) where the car's DSC variant takes it.
