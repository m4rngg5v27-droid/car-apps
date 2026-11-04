'use strict';
/*
 * UDS over TASU for iteriodev_dtcscan (Node 8, only the 'events' builtin).
 * Ported from cauliflowermossgrape/idrive7-apps kit/runtime/diag.js (MIT, (c) 2026 cauliflowermossgrape),
 * changed to take the SDK's typed InternalTasu proxy (the one oap-cardash uses on this car).
 *
 * request: sendTasuRequest{ sourceAddress 0xF2, targetAddress (0xDF = all units), serviceID, udsData }
 * reply  : event sendTasuResponse{ errorCode, udsResponse }; [2] 0x7F = refused by the transport
 *          (code in [4]), [6] = unit that answered, UDS reply from [9]. Same layout as BMW's
 *          ts_diagnostic_service 6.26.2 on this car (sourceAddress = response[6], functional = 223).
 * A functional request gets one reply per unit; collect until none came for a while. 7F xx 78 =
 * "response pending" (BMW waits 10 s for those).
 */
const EventEmitter = require('events');

const TESTER = 0xF2;
const ALL = 0xDF;

const hex = (n, w) => { let s = n.toString(16).toUpperCase(); while (s.length < (w || 2)) s = `0${s}`; return s; };

const NRC = {
    0x10: 'general reject', 0x11: 'service not supported', 0x12: 'sub-function not supported', 0x13: 'bad length',
    0x21: 'busy', 0x22: 'conditions not correct', 0x31: 'out of range', 0x33: 'security access denied',
    0x72: 'programming failure', 0x78: 'pending', 0x7E: 'not supported in session', 0x7F: 'not supported in session',
};

// diagnostic address -> unit. G20 SVT names from idrive7-apps (35 units); 0x10 is the gateway (ZGW/BDC)
// on this car (vsomeip_hsfz.json). Unknown ones show as "ECU 0x..".
const ECU = {
    0x01: 'ACSM airbag', 0x06: 'ICAM cameras', 0x07: 'SME HV battery', 0x08: 'SRR corner radar',
    0x0D: 'HKFM tailgate', 0x10: 'Gateway', 0x12: 'DME engine', 0x13: 'DME 2', 0x14: 'OBC charger',
    0x18: 'EGS gearbox', 0x1D: 'TFM fuel tank', 0x20: 'SRR corner radar', 0x21: 'FRR front radar',
    0x23: 'SAS assist sensors', 0x28: 'SRR corner radar', 0x29: 'DSC brakes', 0x2A: 'SRR corner radar',
    0x2C: 'USS park sensors', 0x30: 'EPS steering', 0x37: 'RAM audio', 0x38: 'VTG xDrive',
    0x39: 'DSC brake booster', 0x3A: 'EME e-motor', 0x40: 'BDC body', 0x43: 'FLM headlight',
    0x44: 'FLM headlight', 0x45: 'DCS driver camera', 0x56: 'FZD roof', 0x5D: 'KAFAS camera',
    0x5E: 'GWS gear selector', 0x60: 'KOMBI cluster', 0x61: 'ATM telematics', 0x63: 'Head unit',
    0x64: 'PDC parking', 0x67: 'ZBE controller', 0x6D: 'SM seat module', 0x76: 'VDP dampers',
    0x78: 'IHKA climate',
};
const ecuName = (a) => ECU[a] || `ECU 0x${hex(a)}`;

class Diag extends EventEmitter {
    /** guard = apps/oap-shared/tasu-guard createGuard(): every request is checked right before it goes out */
    constructor(log, guard) { super(); this.log = log || (() => {}); this.guard = guard; this.p = null; }

    /** proxy = someipBuilders.buildAndInitTypedProxy(InternalTasu, 'SystemFunctionsInternalTasuInst1') */
    attach(proxy) {
        return proxy.sendTasuResponse.subscribe((ev) => this._onResponse(ev)).then(() => { this.p = proxy; });
    }

    _onResponse(ev) {
        if (!ev || ev.errorCode !== 'NO_ERROR') { this.emit('tasError', String(ev && ev.errorCode)); return; }
        const b = Array.from(ev.udsResponse || []);
        if (b.length >= 5 && b[2] === 0x7F) { this.emit('tasReject', b[4]); return; }
        if (b.length < 10) return;
        this.emit('frame', { ecu: b[6], uds: b.slice(9) });
    }

    /** One request; resolves with the transport's verdict. Busy verdicts are retried (1, 2, 3, 4 s). */
    send(target, sid, data, attempt) {
        if (!this.p) return Promise.reject(new Error('no diagnostic link'));
        const d = data || [];
        const g = this.guard ? this.guard.check(sid, d) : { ok: false, why: 'no TASU guard' };
        if (!g.ok) { this.log(`blocked ${hex(sid)} to ${hex(target)}: ${g.why}`); return Promise.reject(new Error(g.why)); }
        return Promise.resolve(this.p.sendTasuRequest({
            sourceAddress: TESTER, targetAddress: target, serviceID: sid, subroutineID: 0,
            udsDataLength: d.length, udsData: Buffer.from(d), deadlockTime: 0,
        })).then((r) => {
            const verdict = r && r.TasuErrorEnum !== undefined ? String(r.TasuErrorEnum) : 'NO_ERROR';
            const n = attempt || 0;
            if (!/TEMPORARILY_NOT_ACCEPTED|BUSY/i.test(verdict) || n >= 4) return verdict;
            this.log(`transport busy (${verdict}), retrying`);
            return new Promise((res) => setTimeout(res, 1000 * (n + 1))).then(() => this.send(target, sid, d, n + 1));
        });
    }

    static check(verdict) {
        if (verdict !== 'NO_ERROR' && verdict !== 'REQUEST_PENDING') throw new Error(`transport refused: ${verdict}`);
    }

    /**
     * Functional request to all units -> Map(unit -> final UDS reply), once no reply came for idleMs.
     * opts.onReply(unit, count) on every final reply; opts.accept(uds) skips foreign replies.
     */
    functional(sid, data, opts) {
        const o = opts || {};
        const idleMs = o.idleMs || 4000, maxMs = o.maxMs || 25000;
        const ours = o.accept || ((u) => u[0] === sid + 0x40 || (u[0] === 0x7F && u[1] === sid));
        const replies = new Map();
        let idle = null, hard = null, finish, kick;
        const onFrame = (f) => {
            if (!ours(f.uds)) return;   // not ours
            const pending = f.uds[0] === 0x7F && f.uds[2] === 0x78;
            if (!pending || !replies.has(f.ecu)) replies.set(f.ecu, f.uds);
            if (o.onReply && !pending) o.onReply(f.ecu, replies.size);
            kick(pending ? 10000 : idleMs);
        };
        const done = new Promise((resolve) => {
            finish = () => { clearTimeout(idle); clearTimeout(hard); this.removeListener('frame', onFrame); resolve(replies); };
            kick = (ms) => { clearTimeout(idle); idle = setTimeout(finish, ms); };
        });
        this.on('frame', onFrame);
        return this.send(ALL, sid, data)
            .then(Diag.check)
            .then(() => {
                if (idle === null) kick(idleMs + 2000);     // first replies can take a moment
                hard = setTimeout(finish, maxMs);
                return done;
            }, (e) => { finish(); throw e; });
    }

    /** Physical request to one unit -> its UDS reply, or null on timeout. accept(uds) skips foreign replies. */
    physical(target, sid, data, timeoutMs, accept) {
        let t = null, finish;
        const ours = accept || ((u) => u[0] === sid + 0x40 || (u[0] === 0x7F && u[1] === sid));
        const onFrame = (f) => {
            if (f.ecu !== target || !ours(f.uds)) return;
            if (f.uds[0] === 0x7F && f.uds[2] === 0x78) { clearTimeout(t); t = setTimeout(() => finish(null), 10000); return; }
            finish(f.uds);
        };
        const got = new Promise((resolve) => {
            finish = (v) => { clearTimeout(t); this.removeListener('frame', onFrame); resolve(v); };
        });
        this.on('frame', onFrame);
        return this.send(target, sid, data)
            .then(Diag.check)
            .then(() => {
                if (t === null) t = setTimeout(() => finish(null), timeoutMs || 4000);
                return got;
            }, (e) => { finish(null); throw e; });
    }
}

/**
 * 0x19 reply -> { ok, nrc, dtcs: [{ code, status }] }. params = request bytes after 0x19 ([0x02, mask]).
 * Records start after the echoed sub-function + availability mask: 3-byte DTC + status byte.
 */
function parseDtcReply(uds, params) {
    if (!uds || !uds.length) return { ok: false, nrc: null, dtcs: [] };
    if (uds[0] === 0x7F) return { ok: false, nrc: uds[2], dtcs: [] };
    if (uds[0] !== 0x59 || uds[1] !== params[0]) return { ok: false, nrc: null, dtcs: [] };
    const out = [];
    for (let i = 1 + params.length; i + 4 <= uds.length; i += 4) {
        out.push({ code: hex(((uds[i] << 16) | (uds[i + 1] << 8) | uds[i + 2]) >>> 0, 6), status: uds[i + 3] });
    }
    return { ok: true, nrc: null, dtcs: out };
}

/**
 * 22 F1 50 reply -> the unit's SGBD index ("0F26E8"), else null. Every BMW UDS SGBD's IDENT job reads
 * this DID (result ID_SGBD_INDEX); ISTA / ecu.db pick the unit's SGBD by "<address> <index>".
 */
function parseSgbdIndex(uds) {
    if (!uds || uds.length < 6 || uds[0] !== 0x62 || uds[1] !== 0xF1 || uds[2] !== 0x50) return null;
    return hex(((uds[3] << 16) | (uds[4] << 8) | uds[5]) >>> 0, 6);
}
const isSgbdIndexReply = (u) => (u[0] === 0x62 && u[1] === 0xF1 && u[2] === 0x50) || (u[0] === 0x7F && u[1] === 0x22);

/** ISO 14229 status byte -> label + short column text (MediaEntry_1Row left column, ~5 characters). */
function statusInfo(b) {
    if (b & 0x01) return { label: 'active now', short: 'ACT' };
    if (b & 0x80) return { label: 'warning lamp', short: 'LAMP' };
    if (b & 0x04) return { label: 'pending', short: 'PEND' };
    if (b & 0x08) return { label: 'stored', short: 'STORE' };
    return { label: 'history', short: 'HIST' };
}

module.exports = { Diag, parseDtcReply, parseSgbdIndex, isSgbdIndexReply, statusInfo, ecuName, hex, NRC, ALL, TESTER };
