'use strict';
/*
 * The M xDrive row: 2WD = xDrive off (rear-wheel drive) until the car is switched off, through the DSC's own
 * diagnostic job LMV_FUNKTION. Port of cauliflowermossgrape/idrive7-apps apps/live_adjustments/xdrive.js 0.7.7 (MIT),
 * the DSC path only (the VIP path of the G05 hybrid needs a security unlock that is not done here).
 *
 *   DSC 0x29   22 F1 50          SGBD index: which DSC (once)
 *              22 DB E1          LMV_FUNKTION: 1 = xDrive on, 0 = off (a DSC that refuses it has no xDrive: never written)
 *              2E DB E1 00       xDrive off -> 6E DB E1              (2WD, two taps)
 *              2E DB E1 01       xDrive on at once, only where measured (ON_INDEX); elsewhere an ignition cycle
 *              10 03             extended session, only after a write answered NRC 7E / 7F, then the write once more
 *   LMV 0x19   22 DB 32          LMV_MOMENT: front-axle torque; its requested-torque qualifier is the mode:
 *                                (q & 0xC0) == 0xC0 -> off (0x00E8), 0x0020 / 0x0021 -> on (engine on or off)
 *   DME 0x12   01 0C, 01 0D      engine speed and road speed (OBD) for the checks
 *
 * G42 (2 Series Coupe): IterioDev switched xDrive off this way on a 2023 230i xDrive (idrive7-apps issue #28): engine
 * stopped, P, ignition on. Its DSC family is DSC_G20 / IB_G2X, which takes the write only with the engine off and
 * brings xDrive back only with an ignition cycle (no "on" write there); on a G26 / G20 with DSC_G20 owners needed the
 * ignition-on "diagnostic" state (Start pressed 3x without the brake). While xDrive is off the DSC stores DTC 480724
 * (LMV function unavailable); it stays as a history entry.
 *
 * The app's checks before a write (the DSC has its own as well): the car stands still (fresh road speed under
 * 1 km/h), the selector is in P (VehicleInformation, the same signal Car Data reads), and the engine is off (fresh
 * engine speed under 120 rpm) except on the DSC variants measured to take it running. The parking brake cannot be
 * read: the DSC checks it. Two taps within 6 s. Nothing at all is sent while moving.
 */
const DSC = 0x29, LMV = 0x19, DME = 0x12;
const SGBD = [0xF1, 0x50], DBE1 = [0xDB, 0xE1], DB32 = [0xDB, 0x32];
const DBE1_UNITS = {                    // DSC variants with the LMV_FUNKTION job (upstream's list)
    '0F1970': 'DSC_I1', '0F1C50': 'DSC_I1', '0F1CE0': 'DSC_I1', '0F2100': 'DSC_G11',
    '0F2510': 'DSC_G20', '0F2850': 'DSC_G30N', '0F2CE0': 'IB_G2X',
};
const OTHER_UNITS = { '0F2500': 'IB_G05', '0F29F0': 'IB_I20', '0F2E70': 'IB_G70' };   // need the VIP path: not here
const TESTED_INDEX = ['0F2510', '0F2850'];
const ENGINE_RUNNING_OK = ['0F2850'];   // measured to take the write with the engine running (G01 X3 M40i)
const ON_INDEX = ['0F2850'];            // measured to come back on 2E DB E1 01 at once
const LMV_OFF_MASK = 0xC0;
const ENGINE_OFF_RPM = 120;             // under this the engine counts as off (some cars read 50-120 for a while)
const ENGINE_ON_RPM = 400;
const FRESH_MS = 3000;
const POLL_MS = 2000;
const CONFIRM_MS = 6000;
const MSG_MS = 9000;
const NRC = { 0x12: 'not supported', 0x13: 'not supported', 0x21: 'busy', 0x22: 'conditions not correct',
    0x31: 'not supported by this DSC', 0x33: 'security access denied', 0x7E: 'not in this session', 0x7F: 'not in this session' };

const hex = (b) => (b < 16 ? '0' : '') + b.toString(16).toUpperCase();
const sgbdIndex = (d) => d.map(hex).join('').replace(/^0+(?=.{6})/, '');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

class XDrive {
    /** opts: diag() -> Diag or null, guard (fed with road speed), stage() -> 'P'|'R'|'N'|'D'|null, log, now,
     *  onChange(), shown() -> the screen is up, sleep(ms) (tests) */
    constructor(opts) {
        this.o = opts;
        this.now = opts.now || (() => Date.now());
        this.sleep = opts.sleep || wait;
        this.index = null; this.lmvIndex = null;
        this.supported = null;          // true: the DSC answered DBE1; false: it refused (no xDrive switch)
        this.identified = false;
        this.dbe1 = null; this.dbe1Running = false;
        this.lmvState = null;           // 'on' | 'off' from the transfer case
        this.front = null;              // front-axle torque now, Nm (actual)
        this.rpm = null; this.rpmAt = 0; this.speed = null; this.speedAt = 0;
        this.requested = null;          // 'off' | 'on': accepted by the DSC, not read back yet
        this.confirm = null;            // { what, until }
        this.msg = null;
        this.busy = false; this.lastPoll = 0; this.timer = null;
    }

    start() { if (!this.timer) this.timer = setInterval(() => this.tick(), 1000); return this; }
    stop() { clearInterval(this.timer); this.timer = null; }

    unit() { return this.index ? DBE1_UNITS[this.index] || OTHER_UNITS[this.index] || null : null; }
    engineMayRun() { return !!this.index && ENGINE_RUNNING_OK.indexOf(this.index) >= 0; }
    onAvailable() { return !!this.index && ON_INDEX.indexOf(this.index) >= 0; }
    mode() {
        if (this.lmvState) return this.lmvState === 'off' ? '2WD' : '4WD';
        if (this.dbe1 !== null && this.dbe1Running) return this.dbe1 ? '4WD' : '2WD';
        return null;
    }

    // ---- reads (while the screen shows) -----------------------------------------------------------------------
    tick() {
        const d = this.o.diag();
        if (!d || this.busy || !(this.o.shown && this.o.shown()) || this.now() - this.lastPoll < POLL_MS) return Promise.resolve();
        this.busy = true; this.lastPoll = this.now();
        return (this.identified ? Promise.resolve() : this._identify(d))
            .then(() => this._readObd(d))
            .then(() => (this.supported ? this._readLmv(d) : null))
            .then(() => (this.supported && !this.lmvState ? this._readDbe1(d) : null))
            .catch((e) => this.o.log(`xdrive: ${String(e && e.message || e).slice(0, 100)}`))
            .then(() => { this.busy = false; this._changed(); });
    }

    _ask(d, ecu, sid, data, ms) {
        // a reply counts only when it answers this request (the exhaust row asks the DME at the same time)
        const ours = (u) => (u[0] === sid + 0x40 && (sid === 0x10 || u[1] === data[0]) && (sid === 0x10 || sid === 0x01 || u[2] === data[1]))
            || (u[0] === 0x7F && u[1] === sid);
        return d.physical(ecu, sid, data, ms || 2500, ours);
    }

    _identify(d) {
        return this._ask(d, DSC, 0x22, SGBD).then((u) => {
            if (u && u[0] === 0x62) this.index = sgbdIndex(u.slice(3));
            if (this.index && OTHER_UNITS[this.index]) { this.supported = false; this.identified = true; return null; }
            return this._readDbe1(d).then(() => (this.supported ? this._ask(d, LMV, 0x22, SGBD) : null)).then((v) => {
                if (v && v[0] === 0x62) this.lmvIndex = sgbdIndex(v.slice(3));
                if (this.supported !== null) this.identified = true;
                this.o.log(`xdrive: DSC ${this.index || '?'}${this.unit() ? ` (${this.unit()})` : ''} DBE1 ${this.supported === false ? 'refused' : this.dbe1}`
                    + `${this.lmvIndex ? ` LMV ${this.lmvIndex}` : ''}`);
            });
        });
    }

    _readDbe1(d) {
        return this._ask(d, DSC, 0x22, DBE1).then((u) => {
            if (u && u[0] === 0x62 && u.length >= 4) {
                this.supported = true; this.dbe1 = u[3] ? 1 : 0; this.dbe1Running = this._running() === true;
                if (this.dbe1Running && !this.lmvState && this.requested === (this.dbe1 ? 'on' : 'off')) this.requested = null;
            }
            else if (u && u[0] === 0x7F && u[2] !== 0x21 && u[2] !== 0x22 && u[2] !== 0x78) this.supported = false;
        });
    }

    _readLmv(d) {
        return this._ask(d, LMV, 0x22, DB32).then((u) => {
            if (!u || u[0] !== 0x62 || u.length < 11) return;
            const s16 = (h, l) => { const v = (h << 8) | l; return v > 0x7FFF ? v - 0x10000 : v; };
            const q = (u[9] << 8) | u[10];
            const state = (q & LMV_OFF_MASK) === LMV_OFF_MASK ? 'off' : 'on';
            if (state !== this.lmvState) this.o.log(`xdrive: transfer case qualifier ${hex(u[9])}${hex(u[10])} -> xDrive ${state}`);
            this.lmvState = state; this.front = s16(u[3], u[4]) / 4;
            if (this.requested === state) this.requested = null;
        });
    }

    _readObd(d) {
        const obd = (pid, n) => this._ask(d, DME, 0x01, [pid], 1200).then((u) => (u && u[0] === 0x41 && u[1] === pid && u.length >= 2 + n ? u : null), () => null);
        return obd(0x0C, 2).then((u) => { if (u) { this.rpm = Math.round(((u[2] << 8) | u[3]) / 4); this.rpmAt = this.now(); } })
            .then(() => obd(0x0D, 1)).then((u) => { if (u) { this.speed = u[2]; this.speedAt = this.now(); if (this.o.guard) this.o.guard.speed(u[2]); } });
    }

    _fresh(at) { return at && this.now() - at <= FRESH_MS; }
    _running() { return this._fresh(this.rpmAt) ? this.rpm >= ENGINE_ON_RPM : null; }

    // ---- the checks and the write ---------------------------------------------------------------------------------
    /** Why a write may not go now, or null. */
    blocker(what) {
        if (!this.o.diag()) return 'No diagnostic link yet';
        if (this.index && OTHER_UNITS[this.index]) return `Not on this car (${this.unit()}: needs the VIP and a security unlock)`;
        if (this.supported === false) return 'This car\'s DSC has no xDrive switch';
        if (this.supported !== true) return 'Reading the DSC…';
        if (what === 'on' && !this.onAvailable()) return null;               // handled as a hint, nothing sent
        if (!this._fresh(this.speedAt)) return 'Road speed unknown · switch the ignition on (Start 3× without the brake)';
        if (this.speed >= 1) return 'Stand still first';
        const stage = this.o.stage ? this.o.stage() : null;
        if (!stage) return 'Selector position unknown · shift to D and back to P';
        if (stage !== 'P') return 'Selector in P first';
        if (!this.engineMayRun()) {
            if (!this._fresh(this.rpmAt)) return 'Engine speed unknown · ignition on: Start 3× without the brake';
            if (this.rpm >= ENGINE_OFF_RPM) return 'Switch the engine off first (ignition stays on)';
        }
        return null;
    }

    /** A tap on 4WD ('on') or 2WD ('off'); the second tap within CONFIRM_MS sends. */
    tap(what) {
        const d = this.o.diag();
        this.msg = null;
        if (what === 'on' && !this.onAvailable() && this.supported) {
            this._say(this.mode() === '2WD' ? '4WD comes back when the car is switched off and on again' : 'xDrive is on', false);
            return Promise.resolve();
        }
        const why = this.blocker(what);
        if (why) { this.confirm = null; this._say(why, true); return Promise.resolve(); }
        if (!this.confirm || this.confirm.what !== what || this.now() > this.confirm.until) {
            this.confirm = { what, until: this.now() + CONFIRM_MS };
            this._changed();
            return Promise.resolve();
        }
        this.confirm = null;
        return this._write(d, what === 'on' ? 1 : 0);
    }

    _write(d, v) {
        this.busy = true;
        const what = v ? 'on' : 'off';
        const send = () => this._ask(d, DSC, 0x2E, DBE1.concat([v]), 3000);
        const say = (u) => this.o.log(`xdrive: 2E DB E1 ${hex(v)} -> ${u ? u.map(hex).join(' ') : 'no reply'}`);
        return send().then((u) => { say(u); return u; })
            .then((u) => {
                if (u && u[0] === 0x7F && u[2] === 0x21) return this.sleep(300).then(send).then((r) => { say(r); return r; });  // G01: first write busy
                if (u && u[0] === 0x7F && (u[2] === 0x7E || u[2] === 0x7F)) {
                    return this._ask(d, DSC, 0x10, [0x03], 3000).then((s) => (s && s[0] === 0x50 ? send().then((r) => { say(r); return r; }) : s));
                }
                return u;
            })
            .then((u) => {
                if (u && u[0] === 0x6E) {
                    this.requested = what;
                    return this._readLmv(d).then(() => {
                        const ok = this.lmvState === what;
                        this._say(v ? (ok ? 'xDrive is back on · the transfer case reports it' : 'Accepted by the DSC')
                            : ok ? 'Rear-wheel drive · the transfer case reports it · drive without switching off'
                                : this._running() ? 'Accepted · drive without switching the ignition off'
                                    : 'Accepted · start the engine without switching the ignition off', false);
                    });
                }
                if (u && u[0] === 0x7F) {
                    const n = u[2];
                    this._say(n === 0x33 || n === 0x22
                        ? `The DSC refused (${NRC[n]}) · engine off, P, parking brake on, ignition on: Start 3× without the brake`
                        : `The DSC refused: ${NRC[n] || `NRC ${hex(n)}`}`, true);
                    return null;
                }
                this._say(u && u[0] === 0x50 ? 'The DSC took the session but not the write' : 'No answer from the DSC', true);
                return null;
            })
            .catch((e) => this._say(String(e && e.message || e).slice(0, 100), true))
            .then(() => { this.busy = false; this.lastPoll = 0; this._changed(); });
    }

    _say(text, warn) { this.msg = { text, warn: !!warn, at: this.now() }; this.o.log(`xdrive: ${text}`); this._changed(); }
    _changed() { if (this.o.onChange) this.o.onChange(); }

    /**
     * What the row shows: the option chosen, whether the car confirms it, and the line under the label. Confirmed =
     * read back from the transfer case (or the DSC's DBE1 with the engine running) and no accepted write still
     * waiting for its read-back; else the option asked for, not confirmed.
     */
    view() {
        const t = this.now(), mode = this.mode();
        const asked = this.requested === 'off' ? '2WD' : this.requested === 'on' ? '4WD' : null;
        const chosen = asked || mode;
        const confirmed = !asked && !!mode;
        const variant = this.index ? ` · ${this.unit() || 'DSC'} ${this.index}${TESTED_INDEX.indexOf(this.index) < 0 ? ' (untested)' : ''}` : '';
        let line, warn = false;
        if (this.confirm && t <= this.confirm.until) {
            line = this.confirm.what === 'off' ? `Tap 2WD again: rear-wheel drive until the car is switched off` : 'Tap 4WD again: xDrive back on';
            warn = true;
        } else if (this.msg && t - this.msg.at <= MSG_MS) { line = this.msg.text; warn = this.msg.warn; }
        else if (!this.o.diag()) line = 'No diagnostic link yet';
        else if (this.supported === false) { line = this.blocker('off'); warn = true; }
        else if (this.supported === null) line = 'Reading the DSC…';
        else if (mode === '2WD') line = `Rear-wheel drive · ${this.onAvailable() ? '4WD switches it back' : 'back to 4WD when the car is switched off'}${variant}`;
        else if (mode === '4WD') line = `xDrive active${this.front !== null && this._running() ? ` · front axle ${this.front.toFixed(0)} Nm` : ''}${variant}`;
        else line = `Mode not read yet${variant}`;
        return { chosen: chosen === '4WD' ? 0 : chosen === '2WD' ? 1 : -1, confirmed, line, warn };
    }
}

/** The writes this row may send: the DBE1 write and the extended session (the DSC's own job). */
const xdriveJob = (sid, d) => (sid === 0x2E && d[0] === 0xDB && d[1] === 0xE1 && d.length === 3 && (d[2] === 0 || d[2] === 1))
    || (sid === 0x10 && d[0] === 0x03 && d.length === 1);

module.exports = { XDrive, xdriveJob, DBE1_UNITS, OTHER_UNITS, TESTED_INDEX, ON_INDEX, ENGINE_RUNNING_OK, ENGINE_OFF_RPM };
