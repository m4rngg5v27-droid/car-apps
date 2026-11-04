'use strict';
// node drafts/iteriodev_msetup/test/test_xdrive.js - xdrive.js against a fake DSC (0x29), transfer case (0x19) and DME
// (0x12): what goes out, when, and what it refuses. Uses the same guard composition as main.js.
const path = require('path');
const src = process.argv[2] || path.join(__dirname, '..', 'src');
const { XDrive, xdriveJob } = require(path.join(src, 'xdrive.js'));
const { createGuard } = require(path.join(src, 'tasu-guard.js'));
const hex = (a) => a.map((b) => (b < 16 ? '0' : '') + b.toString(16).toUpperCase()).join(' ');
let failed = 0;
const check = (ok, what) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) failed++; };

/** car: dsc (SGBD index hex), rpm, speed, stage, awd (1/0), writes: [replies for 2E, in order], dbe1Refused */
function rig(car) {
    const c = Object.assign({ dsc: '0F2510', rpm: 0, speed: 0, stage: 'P', awd: 1, writes: [], dbe1Refused: false, session: true }, car);
    const r = { t: 1e6, sent: [], c };
    const base = createGuard({ engineRunning: true, freshMs: 3000, now: () => r.t });
    const flapJob = (sid, d) => sid === 0x2F && d[0] === 0x60 && d[1] === 0xFD;
    r.guard = Object.assign({}, base, { check: (sid, d) => {
        if (sid === 0x01 || sid === 0x22 || flapJob(sid, d)) return { ok: true };
        if (xdriveJob(sid, d)) return base.parked();
        return { ok: false, why: 'not allowed' };
    } });
    const idx = (h) => [0x00].concat(h.match(/../g).map((x) => parseInt(x, 16)));     // 22 F1 50 data: 00 0F 25 10
    const reply = (ecu, sid, d) => {
        if (sid === 0x01 && d[0] === 0x0C) return c.rpm === null ? null : [0x41, 0x0C, ((c.rpm * 4) >> 8) & 255, (c.rpm * 4) & 255];
        if (sid === 0x01 && d[0] === 0x0D) return c.speed === null ? null : [0x41, 0x0D, c.speed];
        if (ecu === 0x29 && sid === 0x22 && d[0] === 0xF1) return [0x62, 0xF1, 0x50].concat(idx(c.dsc));
        if (ecu === 0x29 && sid === 0x22 && d[0] === 0xDB) return c.dbe1Refused ? [0x7F, 0x22, 0x31] : [0x62, 0xDB, 0xE1, c.awd];
        if (ecu === 0x19 && sid === 0x22 && d[0] === 0xF1) return [0x62, 0xF1, 0x50, 0x00, 0x0F, 0x29, 0xE0];
        if (ecu === 0x19 && sid === 0x22 && d[0] === 0xDB) return [0x62, 0xDB, 0x32, 0x00, 0x9E, 0x00, 0x02, 0x00, 0x98, 0x00, c.awd ? 0x20 : 0xE8];
        if (ecu === 0x29 && sid === 0x10) return c.session ? [0x50, 0x03, 0, 0, 0, 0] : [0x7F, 0x10, 0x22];
        if (ecu === 0x29 && sid === 0x2E) {
            const w = c.writes.length ? c.writes.shift() : 'ok';
            if (w === 'ok') { c.awd = d[2]; return [0x6E, 0xDB, 0xE1]; }
            return [0x7F, 0x2E, w];
        }
        return null;
    };
    const diag = { physical: (ecu, sid, data) => {
        const g = r.guard.check(sid, data);
        if (!g.ok) return Promise.reject(new Error(g.why));
        if (sid !== 0x22 && sid !== 0x01) r.sent.push(hex([sid].concat(data)));
        return Promise.resolve(reply(ecu, sid, data));
    } };
    r.x = new XDrive({ diag: () => diag, guard: r.guard, stage: () => c.stage, log: () => {}, now: () => r.t,
        shown: () => true, sleep: () => Promise.resolve() });
    r.poll = async () => { r.t += 2500; await r.x.tick(); };
    r.tap = async (w) => { r.t += 500; await r.x.tap(w); };
    return r;
}
const OFF = '2E DB E1 00', ON = '2E DB E1 01';

(async () => {
    // G42 / G2x: DSC_G20 (0F2510) - engine off, P, standing: two taps
    let r = rig();
    await r.poll();
    check(r.x.index === '0F2510' && r.x.supported === true && r.x.view().chosen === 0, 'G42 DSC_G20: identified, reads 4WD from the transfer case');
    check(r.sent.length === 0, 'opening: reads only');
    await r.tap('off');
    check(r.sent.length === 0 && /Tap 2WD again/.test(r.x.view().line), 'first tap on 2WD: asks again, nothing sent');
    await r.tap('off');
    check(r.sent.join('|') === OFF && r.x.view().chosen === 1 && /transfer case reports it/.test(r.x.view().line), 'second tap: 2E DB E1 00, 2WD read back from the transfer case');
    await r.tap('on'); await r.tap('on');
    check(r.sent.length === 1 && /switched off and on again/.test(r.x.view().line), 'G42: 4WD sends nothing, says the ignition cycle brings it back');

    // the checks: each one stops the write before anything goes out
    const blocked = async (car, want, what) => { const b = rig(car); await b.poll(); await b.tap('off'); await b.tap('off');
        check(b.sent.length === 0 && want.test(b.x.view().line), `${what}: nothing sent ("${b.x.view().line}")`); };
    await blocked({ speed: 12 }, /Stand still/, 'moving at 12 km/h');
    await blocked({ rpm: 750 }, /engine off/, 'G42 with the engine running');
    await blocked({ stage: 'D' }, /Selector in P/, 'selector in D');
    await blocked({ stage: null }, /Selector position unknown/, 'selector unknown');
    await blocked({ rpm: null, speed: null }, /ignition on/i, 'no OBD answer (ignition off)');
    await blocked({ dbe1Refused: true }, /no xDrive switch/, 'rear-wheel-drive car (DSC refuses DBE1)');
    await blocked({ dsc: '0F2500' }, /VIP/, 'G05 hybrid (IB_G05)');
    r = rig(); await r.poll(); await r.tap('off'); r.t += 7000; await r.x.tap('off');
    check(r.sent.length === 0, 'second tap after 6 s: counts as a first tap again');

    // refusals
    r = rig({ writes: [0x33] }); await r.poll(); await r.tap('off'); await r.tap('off');
    check(r.sent.join('|') === OFF && /Start 3× without the brake/.test(r.x.view().line) && r.x.view().chosen === 0, 'NRC 33: the diagnostic-mode hint, still 4WD');
    r = rig({ writes: [0x7E] }); await r.poll(); await r.tap('off'); await r.tap('off');
    check(r.sent.join('|') === `${OFF}|10 03|${OFF}` && r.x.view().chosen === 1, 'NRC 7E: extended session, the write once more');

    // G01 X3 M40i: DSC_G30N (0F2850) - engine running OK, first write busy, 4WD at once
    r = rig({ dsc: '0F2850', rpm: 700, writes: [0x21] }); await r.poll(); await r.tap('off'); await r.tap('off');
    check(r.sent.join('|') === `${OFF}|${OFF}` && r.x.view().chosen === 1, 'DSC_G30N, engine running: busy once, sent again, 2WD');
    await r.tap('on'); await r.tap('on');
    check(r.sent[r.sent.length - 1] === ON && r.x.view().chosen === 0, 'DSC_G30N: 4WD (2E DB E1 01) after two taps');

    // the guard on its own: the xDrive write needs a fresh road speed under 1 km/h, other writes never
    r = rig(); await r.poll();
    check(r.guard.check(0x2E, [0xDB, 0xE1, 0x00]).ok, 'guard: xDrive write allowed standing still');
    r.c.speed = 30; await r.poll();
    check(!r.guard.check(0x2E, [0xDB, 0xE1, 0x00]).ok, 'guard: xDrive write refused at 30 km/h');
    r.t += 5000;
    check(!r.guard.check(0x2E, [0xDB, 0xE1, 0x00]).ok, 'guard: refused with a stale road speed');
    check(!r.guard.check(0x2E, [0xDB, 0xE1, 0x02]).ok && !r.guard.check(0x2E, [0xDB, 0x2F, 0x00]).ok && !r.guard.check(0x31, [0x01, 0x00, 0x00]).ok,
        'guard: other values, the VIP job and routines refused');
    process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
