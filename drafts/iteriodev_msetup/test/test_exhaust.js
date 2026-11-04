'use strict';
// node drafts/iteriodev_msetup/test/test_exhaust.js - exhaust.js against a fake DME (UDS replies) and a fake clock: what goes out, when, and what it holds back.
const path = require('path');
const src = process.argv[2] || path.join(__dirname, '..', 'src');
const { Exhaust, HOLD_MS } = require(path.join(src, 'exhaust.js'));
const { createGuard } = require(path.join(src, 'tasu-guard.js'));
const hex = (a) => a.map((b) => (b < 16 ? '0' : '') + b.toString(16).toUpperCase()).join(' ');
let failed = 0;
const check = (ok, what) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) failed++; };

function rig(opts) {
    const o = Object.assign({ flap: true, rpm: 900, refuse: null, pos: 9000, stuck: false }, opts);   // pos: duty cycle x 100
    const r = { t: 1e6, sent: [], o };
    // the same guard main.js uses: the flap job at any speed, reads always, anything else refused
    const base = createGuard({ engineRunning: true, freshMs: 3000 });
    const flapJob = (sid, d) => sid === 0x2F && d[0] === 0x60 && d[1] === 0xFD;
    const guard = { check: (sid, d) => (flapJob(sid, d) ? { ok: true } : base.check(sid, d)) };
    const diag = { physical: (ecu, sid, data) => {
        const g = guard.check(sid, data);
        if (!g.ok) return Promise.reject(new Error(g.why));
        if (sid !== 0x22 && sid !== 0x01) r.sent.push(hex([sid].concat(data)));
        if (sid === 0x01) return Promise.resolve(o.rpm === null ? null : [0x41, 0x0C, ((o.rpm * 4) >> 8) & 255, (o.rpm * 4) & 255]);
        if (sid === 0x22) return Promise.resolve(o.flap ? [0x62, 0x64, 0xFD, o.pos >> 8, o.pos & 255] : [0x7F, 0x22, 0x31]);
        if (sid === 0x2F) {
            if (o.refuse) return Promise.resolve([0x7F, 0x2F, o.refuse]);
            if (!o.stuck) o.pos = data[2] === 0x03 ? (data[3] << 8) | data[4] : 9000;   // the flap follows; back to the DME: closed at idle
            return Promise.resolve([0x6F].concat(data.slice(0, 2)));
        }
        return Promise.resolve(null);
    } };
    r.ex = new Exhaust({ diag: () => diag, log: () => {}, now: () => r.t, shown: () => false });
    r.guard = guard;
    r.step = async (ms) => { r.t += ms; await r.ex.tick(); };
    return r;
}
const OPEN = '2F 60 FD 03 03 E8', CLOSE = '2F 60 FD 03 23 28', OEM = '2F 60 FD 00';

(async () => {
    let r = rig();
    await r.ex.tick();
    check(r.sent.length === 0, 'start: OEM chosen, screen hidden: nothing sent');
    check(r.ex.view().confirmed, 'start: OEM confirmed (no override of ours) -> red');

    await r.ex.set('open');
    check(r.sent.join('|') === OPEN, 'OPEN: one open command');
    check(!r.ex.view().confirmed, 'OPEN accepted, flap not read since: not confirmed -> yellow');
    await r.step(1000);
    check(r.ex.view().confirmed, 'OPEN: the flap reads open (10 %) after the command -> red');
    for (let i = 0; i < 13; i++) await r.step(1000);
    check(r.sent.length === 1, 'OPEN: not sent again within 15 s');
    await r.step(1000);
    check(r.sent.length === 2 && r.sent[1] === OPEN, `OPEN: sent again at ${HOLD_MS / 1000} s (held under the DME's ~20 s)`);

    r = rig({ rpm: 3000 });
    await r.ex.set('closed');
    check(r.sent.join('|') === CLOSE, 'CLOSED at 3000 rpm: one close command');
    await r.step(1000);
    check(r.ex.view().confirmed, 'CLOSED: the flap reads closed (90 %) -> red');
    r.o.rpm = 4600; await r.step(1000);
    check(r.sent[r.sent.length - 1] === OEM && r.ex.view().warn && !r.ex.view().confirmed, 'CLOSED, 4600 rpm: handed back to the DME, warning, not applied -> yellow');
    r.o.rpm = 4200; await r.step(1000);
    check(r.sent[r.sent.length - 1] === OEM && r.sent.length === 2, 'CLOSED, 4200 rpm: stays with the DME (resumes only under 4000)');
    r.o.rpm = 3900; await r.step(1000);
    check(r.sent[r.sent.length - 1] === CLOSE, 'CLOSED, 3900 rpm: closed again');
    r.o.rpm = null; await r.step(4000);
    check(r.sent[r.sent.length - 1] === OEM && /unknown/.test(r.ex.view().line), 'CLOSED, engine speed unknown: back to the DME');

    r = rig({ rpm: 1000 });
    await r.ex.set('closed'); await r.ex.set('oem');
    check(r.sent.join('|') === `${CLOSE}|${OEM}`, 'OEM after CLOSED: hand-back sent');
    await r.step(20000);
    check(r.sent.length === 2, 'OEM: nothing more sent');

    r = rig({ stuck: true });
    await r.ex.set('open'); for (let i = 0; i < 5; i++) await r.step(1000);
    check(!r.ex.view().confirmed, 'OPEN accepted but the flap stays closed (stuck / no motor): never confirmed -> stays yellow');

    r = rig();
    await r.ex.set('open'); await r.step(1000); r.o.refuse = 0x22; await r.ex.set('oem');
    check(!r.ex.view().confirmed, 'OEM, hand-back refused: not confirmed while our override may still stand');
    r.t += 23000;
    check(r.ex.view().confirmed, 'OEM, 23 s after the last override: the DME has it back -> red');

    r = rig();
    await r.ex.set('open'); await r.ex.shutdown();
    check(r.sent.join('|') === `${OPEN}|${OEM}`, 'app shutdown while OPEN: hand-back sent');

    r = rig({ flap: false });
    r.ex.o.shown = () => true;
    await r.ex.tick(); await r.ex.set('open'); await r.step(1000);
    check(r.sent.length === 0 && /no electric exhaust flap/.test(r.ex.view().line), 'DME without the flap (22 64FD refused): nothing sent');

    r = rig({ refuse: 0x22 });
    await r.ex.set('open');
    check(/conditions not correct/.test(r.ex.view().line) && r.ex.view().warn, 'DME refuses: its reason is shown');

    r = rig();
    check(r.guard.check(0x2F, [0x60, 0xFD, 0x00]).ok && !r.guard.check(0x2F, [0x02, 0x01]).ok && !r.guard.check(0x2E, [0xDB, 0xE1, 0x00]).ok
        && !r.guard.check(0x14, [0xFF, 0xFF, 0xFF]).ok, 'guard: only the flap job may be sent (MHD 2F 02, xDrive 2E DBE1, clear DTCs refused)');
    process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
