'use strict';
/*
 * Gate for every TASU (UDS) request our apps send (Node 8, no requires). BMW's own filter
 * (EX_FACTORY_ODF.xml, speed / rpm conditions) runs inside BMW's diagnostic app, not in TASU, so
 * our apps must bring their own:
 *   read    - always: OBD reads (01 02 03 06 07 09 0A), 19 read DTCs, 22 read data, 3E tester present,
 *             10 01 back to the default session
 *   parked  - only with the car parked: fault clearing (14, OBD 04) and everything that changes state
 *             (sessions, reset, communication control, DTC setting, writes, routines, I/O control,
 *             security access, ...) and any service not listed here
 *   blocked - never: flash programming and memory writes (34 35 36 37 38 3D)
 * Parked = vehicle speed < 1 km/h AND engine speed < 50 rpm, both reported within freshMs. Unknown or
 * stale values count as NOT parked.
 * ponytail: no P-position signal works on this car yet, so a car stopped by auto start-stop also
 * reads as parked; add the selector position here once a source is found.
 */
const READ = [0x01, 0x02, 0x03, 0x06, 0x07, 0x09, 0x0A, 0x19, 0x22, 0x3E];
const BLOCKED = [0x34, 0x35, 0x36, 0x37, 0x38, 0x3D];

/** 'read' | 'parked' | 'blocked' for one request (data = bytes after the service id). */
function classify(sid, data) {
    if (BLOCKED.indexOf(sid) >= 0) return 'blocked';
    if (READ.indexOf(sid) >= 0) return 'read';
    if (sid === 0x10 && data && data[0] === 0x01) return 'read';
    return 'parked';
}

function createGuard(opts) {
    const o = opts || {};
    const now = o.now || (() => Date.now());
    const freshMs = o.freshMs || 2000;
    const last = { speed: null, rpm: null };     // { value, at }
    const put = (k, v) => { if (typeof v === 'number' && isFinite(v)) last[k] = { value: v, at: now() }; };
    const fresh = (k) => last[k] && now() - last[k].at <= freshMs;

    /** { ok, why } - why the car does not count as parked */
    function parked() {
        if (!fresh('speed')) return { ok: false, why: 'vehicle speed unknown' };
        if (last.speed.value >= 1) return { ok: false, why: 'the car is moving' };
        if (o.engineRunning) return { ok: true, why: '' };   // opts.engineRunning: standing still is enough
        if (!fresh('rpm')) return { ok: false, why: 'engine speed unknown' };
        if (last.rpm.value >= 50) return { ok: false, why: 'the engine is running' };
        return { ok: true, why: '' };
    }

    /** { ok, why } for one request; call right before sending it */
    function check(sid, data) {
        const c = classify(sid, data);
        if (c === 'read') return { ok: true, why: '' };
        const hex = (sid < 16 ? '0' : '') + sid.toString(16).toUpperCase();
        if (c === 'blocked') return { ok: false, why: `service ${hex} is never allowed from this app` };
        const p = parked();
        return p.ok ? p : { ok: false, why: `service ${hex} needs the car parked (${p.why})` };
    }

    return { speed: (kmh) => put('speed', kmh), rpm: (rpm) => put('rpm', rpm), parked, check };
}

module.exports = { createGuard, classify };
