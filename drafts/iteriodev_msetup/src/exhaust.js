'use strict';
/*
 * The Exhaust row: the electric exhaust flap through BMW's own DME job (SGBD dme8ff_r / dme_bx8 EL_AGK, the one
 * Live Adjustments uses), with what that app leaves to the DME made the app's job:
 *
 *   OPEN    2F 60FD 03 03E8  (10 %, BMW's 8-12 % open band)    held: sent again every HOLD_MS, so it stays open
 *   CLOSED  2F 60FD 03 2328  (90 %, BMW's 88-92 % close band)  held the same way, and guarded: above
 *                            CLOSED_MAX_RPM, or with no fresh engine speed, the flap goes back to the DME
 *                            (2F 60FD 00) and closes again once the engine is under CLOSED_RESUME_RPM
 *   OEM     2F 60FD 00       the DME drives the flap again (returnControlToECU)
 *
 * The DME ends an override by itself after ~20 s (BMW's default), so the hold is what keeps it; when the app stops
 * (or crashes) the override simply runs out and the DME takes the flap back - the safe direction. On shutdown the
 * app hands it back at once. Where the flap really is comes from 22 64FD (ASG_EL_AGK, duty cycle % x 100):
 * <= 20 % open, >= 80 % closed; a DME that refuses 22 64FD has no electric flap.
 *
 * Not used: MHD's own flap control (2F 02 00/01/02, from a capture of MHD's app) keeps its state in the tune, has no
 * read-back and nothing that opens a closed flap again once this app is gone. BMW's job works on every MG1 with the
 * flap, tuned or not, and its override always times out.
 */
const DME = 0x12;
const CMD = {
    open: [0x60, 0xFD, 0x03, 0x03, 0xE8],
    closed: [0x60, 0xFD, 0x03, 0x23, 0x28],
    oem: [0x60, 0xFD, 0x00],
};
const POS = [0x64, 0xFD];
const HOLD_MS = 15000;            // sent again before the DME's ~20 s override ends
const CLOSED_MAX_RPM = 4500;      // CLOSED hands the flap to the DME at or above this
const CLOSED_RESUME_RPM = 4000;   // ... and closes it again below this
const RPM_FRESH_MS = 3000;        // older engine speed counts as unknown (CLOSED: back to the DME)
const POS_MS = 2000;              // flap position read-back
const TICK_MS = 1000;
const MSG_MS = 8000;

const hex = (b) => (b < 16 ? '0' : '') + b.toString(16).toUpperCase();
const NRC = { 0x11: 'service not supported', 0x12: 'not supported', 0x13: 'bad length', 0x21: 'busy',
    0x22: 'conditions not correct', 0x31: 'out of range', 0x33: 'security access denied', 0x7E: 'not in this session',
    0x7F: 'not in this session' };

class Exhaust {
    /** opts: diag() -> Diag or null, log(...), now() -> ms, onChange() (redraw), shown() -> the screen is up */
    constructor(opts) {
        this.o = opts;
        this.now = opts.now || (() => Date.now());
        this.want = 'oem';        // the button chosen (a fresh start is always OEM: nothing is re-applied by itself)
        this.applied = null;      // what the DME last accepted from us: 'open' | 'closed' | 'oem' | null (nothing yet)
        this.sentAt = 0;
        this.acceptedAt = 0;      // when the DME first took the current OPEN / CLOSED (its read-back must be newer)
        this.overrideAt = 0;      // the last accepted OPEN / CLOSED: the DME has the flap back ~20 s after it at the latest
        this.paused = null;       // CLOSED handed to the DME: 'rpm' | 'unknown' | null
        this.rpm = null; this.rpmAt = 0;
        this.pos = null; this.posAt = 0; this.posOkAt = 0;   // posAt: last read asked, posOkAt: last one answered
        this.flap = null;         // true: the DME has the electric flap, false: it has none, null: not known yet
        this.msg = null;          // { text, at } a refusal or a failure, shown for MSG_MS
        this.busy = false;
        this.timer = null;
    }

    start() { if (!this.timer) this.timer = setInterval(() => this.tick(), TICK_MS); return this; }
    stop() { clearInterval(this.timer); this.timer = null; }

    /** A button: 'open' | 'closed' | 'oem'. */
    set(want) {
        if (['open', 'closed', 'oem'].indexOf(want) < 0) return Promise.resolve();
        this.o.log(`exhaust: ${want.toUpperCase()} chosen`);
        this.want = want;
        this.paused = null;
        this.msg = null;
        this._changed();
        return this.tick();
    }

    /** The app stops: hand the flap back now instead of waiting for the override to run out. */
    shutdown() {
        this.stop();
        if (!this.applied || this.applied === 'oem') return Promise.resolve();
        return this._send('oem').catch(() => {});
    }

    tick() {
        const d = this.o.diag();
        if (!d || this.busy) return Promise.resolve();
        const shown = !!(this.o.shown && this.o.shown());
        const t = this.now();
        // reads: engine speed while CLOSED is wanted (the guard) or the screen is up, the flap every POS_MS
        const reads = [];
        if (this.want === 'closed' || shown) reads.push(() => this._readRpm(d));
        if ((shown || this.want !== 'oem') && t - this.posAt >= POS_MS) reads.push(() => this._readPos(d));
        this.busy = true;
        return reads.reduce((p, r) => p.then(r), Promise.resolve())
            .then(() => this._decide())
            .catch((e) => this._say(`exhaust: ${String(e && e.message || e).slice(0, 100)}`))
            .then(() => { this.busy = false; this._changed(); });
    }

    _decide() {
        if (this.flap === false) return null;                        // no electric flap: nothing to drive
        const t = this.now(), held = this.applied === this.want && t - this.sentAt < HOLD_MS;
        if (this.want === 'oem') return this.applied && this.applied !== 'oem' ? this._send('oem') : null;
        if (this.want === 'open') return held ? null : this._send('open');
        // CLOSED: only with a fresh engine speed under the limit (and under the resume point after a pause)
        const fresh = this.rpm !== null && t - this.rpmAt <= RPM_FRESH_MS;
        const limit = this.paused ? CLOSED_RESUME_RPM : CLOSED_MAX_RPM;
        if (!fresh || this.rpm >= limit) {
            const why = fresh ? 'rpm' : 'unknown';
            if (this.paused !== why) this.o.log(`exhaust: CLOSED paused (${fresh ? `${this.rpm} rpm` : 'engine speed unknown'}), back to the DME`);
            this.paused = why;
            return this.applied && this.applied !== 'oem' ? this._send('oem') : null;
        }
        if (this.paused) this.o.log(`exhaust: CLOSED again at ${this.rpm} rpm`);
        this.paused = null;
        return held ? null : this._send('closed');
    }

    _send(k) {
        const d = this.o.diag();
        if (!d) return Promise.resolve(false);
        const ours = (u) => (u[0] === 0x6F && u[1] === 0x60 && u[2] === 0xFD) || (u[0] === 0x7F && u[1] === 0x2F);
        return d.physical(DME, 0x2F, CMD[k], 3000, ours).then((u) => {
            const again = this.applied === k && k !== 'oem';
            if (!again || !u || u[0] !== 0x6F) this.o.log(`exhaust: 2F ${CMD[k].map(hex).join(' ')} -> ${u ? u.map(hex).join(' ') : 'no reply'}`);
            if (u && u[0] === 0x6F) {
                if (this.applied !== k) { this.acceptedAt = this.now(); this.posAt = 0; }   // read the flap at the next tick
                this.applied = k; this.sentAt = this.now();
                if (k !== 'oem') this.overrideAt = this.now(); else this.overrideAt = 0;
                return true;
            }
            this._say(u ? `The DME refused: ${NRC[u[2]] || `NRC ${hex(u[2])}`}` : 'No answer from the DME');
            if (k === 'oem') this.applied = null;          // unknown: the override runs out by itself in ~20 s
            return false;
        });
    }

    _readRpm(d) {
        return d.physical(DME, 0x01, [0x0C], 1200, (u) => (u[0] === 0x41 && u[1] === 0x0C) || (u[0] === 0x7F && u[1] === 0x01))
            .then((u) => { if (u && u[0] === 0x41 && u.length >= 4) { this.rpm = Math.round(((u[2] << 8) | u[3]) / 4); this.rpmAt = this.now(); } },
                () => {});
    }

    _readPos(d) {
        this.posAt = this.now();
        const ours = (u) => (u[0] === 0x62 && u[1] === POS[0] && u[2] === POS[1]) || (u[0] === 0x7F && u[1] === 0x22);
        return d.physical(DME, 0x22, POS, 2000, ours).then((u) => {
            if (u && u[0] === 0x62 && u.length >= 5) {
                const raw = (u[3] << 8) | u[4];
                const pos = (raw > 0x7FFF ? raw - 0x10000 : raw) / 100;
                // research: each move of the flap, with the time since our last accepted command (how fast it moves)
                if (this.pos === null || Math.abs(pos - this.pos) >= 5) {
                    this.o.log(`exhaust: flap ${pos} %${this.sentAt ? ` (${this.now() - this.sentAt} ms after ${String(this.applied).toUpperCase()})` : ''}`);
                }
                this.pos = pos;
                this.posOkAt = this.now();
                this.flap = true;
            } else if (u && u[0] === 0x7F && u[2] !== 0x21 && u[2] !== 0x22) {
                if (this.flap !== false) this.o.log(`exhaust: the DME refuses 22 64FD (${hex(u[2])}): no electric flap`);
                this.flap = false; this.pos = null;
            }
        }, () => {});
    }

    _say(text) { this.msg = { text, at: this.now() }; this.o.log(text); }
    _changed() { if (this.o.onChange) this.o.onChange(); }

    /**
     * Applied, as the car confirms it: OPEN / CLOSED when the DME took the command and the flap position read after
     * that is open (<= 20 %) / closed (>= 80 %); OEM when no override of ours stands (none accepted, the hand-back
     * accepted, or the last one older than the DME's own ~20 s timer).
     */
    confirmed() {
        if (this.want === 'oem') return !this.overrideAt || this.now() - this.overrideAt > 22000;
        if (this.applied !== this.want || this.pos === null || this.posOkAt <= this.acceptedAt) return false;
        return this.want === 'open' ? this.pos <= 20 : this.pos >= 80;
    }

    /** What the row shows: the chosen button, whether the car confirms it, and one line under the label. */
    view() {
        const t = this.now();
        const where = this.pos === null ? '' : ` · flap ${this.pos <= 20 ? 'open' : this.pos >= 80 ? 'closed' : `${this.pos} %`}`;
        let line, warn = false;
        if (this.msg && t - this.msg.at <= MSG_MS) { line = this.msg.text; warn = true; }
        else if (!this.o.diag()) line = 'No diagnostic link yet';
        else if (this.flap === false) { line = 'This DME has no electric exhaust flap'; warn = true; }
        else if (this.want === 'oem') line = `The DME drives the flap${where}`;
        else if (this.want === 'open') line = this.applied === 'open' ? `Held open by the app${where}` : 'Opening…';
        else if (this.paused === 'rpm') { line = `Over ${CLOSED_MAX_RPM} rpm: the DME drives it, closes again under ${CLOSED_RESUME_RPM}`; warn = true; }
        else if (this.paused === 'unknown') { line = 'Engine speed unknown: the DME drives it until it is read'; warn = true; }
        else line = this.applied === 'closed' ? `Held closed · the DME takes over above ${CLOSED_MAX_RPM} rpm${where}` : 'Closing…';
        return { want: this.want, confirmed: this.confirmed(), line, warn, flap: this.flap };
    }
}

module.exports = { Exhaust, CMD, HOLD_MS, CLOSED_MAX_RPM, CLOSED_RESUME_RPM, RPM_FRESH_MS, DME };
