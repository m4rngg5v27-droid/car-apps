# What to find out on the car

Each item makes a row more certain or turns a dummy into a real switch. Everything here is reading or watching,
parked, unless it says otherwise. The app logs what it sees to `data/msetup.log`; over Tailscale:

```sh
ssh root@mgu 'tail -f /var/opt/public/oap/oap_*/data/msetup.log'     # the app's folder: the uid MainApp gave it
scp root@mgu:/etc/oap/someip/someip-interfaces.json .               # the SOME/IP catalog (items 3, 4, 7, 8)
```

## M xDrive

1. **Your DSC and transfer case.** The xDrive line shows the DSC variant once read; the log line
   `xdrive: DSC 0F.... (DSC_...) DBE1 . LMV 0F....` has both SGBD indexes. Tells which upstream results apply.
2. **What the G42's DSC needs.** Try 2WD (two taps) with the ignition just on, then in the diagnostic state
   (Start 3x without the brake), and note the DSC's answer in the log (`2E DB E1 00 -> ...`: `6E` taken, `7F 2E 33` /
   `7F 2E 22` refused). Once off: does it stay 2WD after an engine start in the same ignition cycle (the line and the
   red 2WD after the start)? And the front-axle torque on a short closed-area launch, before and after.
3. **4WD without a restart.** Upstream measured `2E DB E1 01` only on DSC_G30N. With xDrive off and the car parked, the
   same write with `01` would show whether the G42's DSC takes it (the ignition cycle brings xDrive back anyway).
   Not in the app: it needs a deliberate one-off test.
4. **The parking brake.** The one check the app can't make. Look in the catalog for a parking-brake / EPB field
   (`grep -io '"[^"]*\(parkingbrake\|parkbrake\|epb\|feststell\)[^"]*"' someip-interfaces.json | sort -u`).
5. **The ignition state.** `de.bmw.infrastructure.VehicleCondition` (upstream's "ignition on / READY") is not used: an
   interface the unit lacks makes the install fail. If the catalog has it, the engine-off check can use it instead of
   engine speed alone.
6. **The selector at start.** The log says `selector P` when the app gets it. If it only comes after a shift, the
   field has no getter on this firmware and the row asks for a D-and-back-to-P first.

## Exhaust

7. **How the flap moves.** The log has `exhaust: flap NN % (NNN ms after OPEN)` for every move: how long it takes
   (the row is red once the flap reads where it was sent), and where the DME keeps it at idle and under load.
8. **What 22 62FD says** (the % a tester commands) after Open, Closed and OEM: if it reads "none" after the hand-back,
   OEM can be confirmed by the car instead of by the hand-back's answer and the 20 s timer.
9. **The 510 s override.** Capture BMW's own EL_AGK job with a duration (Tool32 / ISTA on a laptop) to see where the
   time byte goes. Only for Open: Closed stays on the 15 s hold so the rpm guard keeps working.
10. **The rpm limit.** 4500 rpm (back to the DME) / 4000 (closed again) is a guess. What the DME itself does with the
    flap under load in Sport (item 7's log while driving, closed area) gives a better limit.

## The dummy rows (Engine, Steering, Gearbox)

11. **What the stock menu sends.** Capture the head unit's traffic while changing one setting at a time in the stock
    drive-mode menu, parked (`tcpdump -i any -w /tmp/mode.pcap` around each change), and match it to the catalog.
12. **The car's M Drive service.** Car Data already reads `de.bmw.infotainment.misc.MDrive` (`statusMSystem`, the
    gearbox's Drivelogic). Its fields and methods in the catalog: a setter there would be the stock way to set a mode.
13. **The current mode.** `FES.statusFESVehicleDynamicSwitchHMI` (Sport, Sport Plus, Comfort, Eco Pro, Individual):
    showing it lets the rows follow the car, and Exhaust could follow the mode later (idrive7-apps issue #48).
