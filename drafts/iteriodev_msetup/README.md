# M Setup (draft)

The iDrive 8 M Setup page as a renderer app, on the SETUP, M1 and M2 pages:

| Row | Options | |
|---|---|---|
| Engine | Efficient · Sport · Sport Plus | dummy |
| Steering | Comfort · Sport | dummy |
| Gearbox | Comfort · Sport · Sport Plus | dummy |
| M xDrive | 4WD · 2WD | **real**: xDrive off until the car is switched off |
| Exhaust | Open · Closed · OEM | **real**: drives the electric exhaust flap |

A dummy tap only changes the screen and the app's `data/msetup.json`; nothing goes to the car. Each page keeps its
own dummy choices. M xDrive and Exhaust are one live state for every page; Exhaust starts as OEM after every app start.

## M xDrive (G42 and other G cars)

The DSC's own job LMV_FUNKTION (`src/xdrive.js`, a port of idrive7-apps Live Adjustments 0.7.7, the DSC path):
`2E DB E1 00` to the DSC `0x29` switches xDrive off until the next ignition cycle. The mode on the row is read from the
transfer case (`22 DB 32` to `0x19`, its requested-torque qualifier: `0x0020` on, `0x00E8` off).

- **2WD** takes two taps within 6 s, and only with: the car standing still (OBD road speed under 1 km/h, read within
  3 s), the selector in P (`VehicleInformation`, as Car Data reads it), the engine off (under 120 rpm). The parking
  brake can't be read; the DSC checks it. Nothing at all is sent while the car moves (the guard refuses it too).
- **G42** (2 Series Coupe): IterioDev switched xDrive off this way on a 2023 230i xDrive (idrive7-apps #28). Its DSC
  family (DSC_G20 / IB_G2X) takes the write only with the engine off, and 4WD comes back only with an ignition cycle:
  the 4WD button then says so and sends nothing. If the DSC refuses with "security access" / "conditions not
  correct", switch the ignition on without starting (Start 3x without the brake), as G26 / G20 owners needed.
- **DSC_G30N `0F2850`** (G01 X3 M40i): also with the engine running, and 4WD at once (`2E DB E1 01`).
- A first write answered "busy" is sent once more after 300 ms; "not in this session" opens `10 03` and sends it once
  more. A DSC that refuses `22 DB E1` (rear-wheel drive) is never written; the G05 hybrid (IB_G05) needs the VIP and a
  security unlock: not here.
- While xDrive is off the DSC stores DTC `480724` (LMV function unavailable); it stays as a history entry.
- Not established upstream: the physical clutch state, ABS / stability control in motion, prolonged use.

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
hold, the rpm guard, the xDrive row in this app (the job itself: see above) and this app. Only on the host: `test/` (fake DME).

## Files

- `layout.js` builds the screen (`renderer/screens.json`); `src/rows.js` the rows and pages.
- `src/main.js` the app; `src/exhaust.js` the flap; `src/xdrive.js` xDrive; `src/diag.js`, `src/tasu-guard.js` from Live Adjustments 1.0.5.
- `runtime/` the renderer runtime (as in Tailscale 1.0.4); `pkg/` manifest and permissions (as in Live Adjustments).
- `node drafts/iteriodev_msetup/build.js` writes `apps/iteriodev_msetup/` (package, `app.json`, icon) and `preview.png`.
- Tests (fake head unit and control units): `test/test_exhaust.js` (15 checks), `test/test_xdrive.js` (21: G42 and
  G01 DSCs, every check, refusals, the guard) and `test/test_app.js` (14, the built package on screen).

Next: capture what the stock M Setup page sends (SOME/IP, parked) and wire the dummy rows to it one at a time.
Lead: Car Data reads `de.bmw.infotainment.misc.MDrive` (`statusMSystem.statusAllWheelSetup`, the gearbox's Drivelogic),
the car's own M Drive service.
