'use strict';
/*
 * iteriodev_msetup ("M Setup"), DRAFT: the iDrive 8 M Setup page. Engine, Steering and Gearbox are dummy switches on
 * three pages (SETUP, M1, M2): a tap only changes the screen and data/msetup.json, nothing goes to the car.
 * Two rows are real, one state for every page:
 *   M xDrive  4WD / 2WD: xDrive off until the car is switched off, the DSC's LMV_FUNKTION job (xdrive.js), parked only
 *   Exhaust   OPEN / CLOSED / OEM: the electric exhaust flap, BMW's DME job, held and rpm-guarded (exhaust.js);
 *             a fresh start is always OEM
 *
 * Screen: drawn by the GPU renderer from renderer/screens.json (made by drafts/iteriodev_msetup/layout.js).
 * Start, tile and shutdown on iDrive 7 and 8: the shared OnlineApp host (online-host.js).
 */
const fs = require('fs');
const path = require('path');
const util = require('util');
const someipBuilders                   = require('oap-sdk/src/someip/someipBuilders');
const { createHost }                   = require('./online-host.js');
const { Diag }                         = require('./diag.js');
const { createGuard }                  = require('./tasu-guard.js');
const { Exhaust }                      = require('./exhaust.js');
const { XDrive, xdriveJob }           = require('./xdrive.js');
const { ROWS, PAGES }                  = require('./rows.js');

const LOG = '[iteriodev_msetup]';
const STATES = ['home'];          // screens = their RHMI host states, the entry state first

// the linked bundle is javascript/app.js: the package root is one up, the app's data folder beside it (the Store's)
const SOURCE = typeof __dirname === 'string' ? path.join(__dirname, '..') : `/var/opt/public/oap/oap_${process.getuid()}/source`;
const DATA = path.join(__dirname, '..', '..', 'data');
const LOG_FILE = `${DATA}/msetup.log`;
const SAVE_FILE = `${DATA}/msetup.json`;
const TASU_IF = 'com.harman.infotainment.systemfunctions.tasu.tasu.InternalTasu';
const TASU_INST = 'SystemFunctionsInternalTasuInst1';
const RED = '#ff3b30', OPTION = '#c9ced6', TEXT = '#e8ecf2', DIM = '#8a95a6', AMBER = '#ffb020';

const errText = (e) => String(e && e.message || e).slice(0, 120);
function log() {
    const line = [new Date().toISOString()].concat([].slice.call(arguments)
        .map((x) => (typeof x === 'string' ? x : util.inspect(x, { depth: 4 }).slice(0, 2000)))).join(' ');
    console.error(LOG, line);
    try { if (fs.statSync(LOG_FILE).size > 256 * 1024) fs.writeFileSync(LOG_FILE, ''); } catch (e) { /* no file yet */ }
    try { fs.appendFileSync(LOG_FILE, `${line}\n`); } catch (e) { /* no data folder */ }
}

// ---- dummy rows: one set of choices per page ------------------------------------------------------------------
const DUMMY = ROWS.filter((r) => !r.live);
const DEFAULTS = {
    setup: { engine: 0, steering: 0, gearbox: 0 },
    m1: { engine: 1, steering: 1, gearbox: 1 },
    m2: { engine: 2, steering: 1, gearbox: 2 },
};
let state = load();
let page = 'setup';
let focus = ROWS[0].key;          // the row last touched (the HMI's focus bar)

function load() {
    const s = JSON.parse(JSON.stringify(DEFAULTS));
    try {
        const saved = JSON.parse(fs.readFileSync(SAVE_FILE, 'utf8'));
        Object.keys(s).forEach((p) => DUMMY.forEach((r) => {
            const v = saved && saved[p] && saved[p][r.key];
            if (typeof v === 'number' && v >= 0 && v < r.options.length) s[p][r.key] = v;
        }));
    } catch (e) { /* none yet: the defaults */ }
    return s;
}
function save() {
    try { fs.writeFileSync(`${SAVE_FILE}.tmp`, JSON.stringify(state)); fs.renameSync(`${SAVE_FILE}.tmp`, SAVE_FILE); }
    catch (e) { log('save failed:', errText(e)); }
}

// ---- the real rows over the head unit's diagnostic link ------------------------------------------------------
// What may go out: reads always; the flap job at any speed (as in Live Adjustments); the xDrive job (2E DBE1, and
// 10 03 for it) only with the car standing still (road speed read within 3 s, under 1 km/h); nothing else at all.
const base = createGuard({ engineRunning: true, freshMs: 3000 });
const flapJob = (sid, d) => sid === 0x2F && d[0] === 0x60 && d[1] === 0xFD;
const READS = [0x01, 0x22];
const guard = Object.assign({}, base, { check: (sid, d) => {
    if (READS.indexOf(sid) >= 0 || flapJob(sid, d)) return { ok: true, why: '' };
    if (xdriveJob(sid, d)) return base.parked();
    return { ok: false, why: 'only the exhaust flap and xDrive jobs are sent from this app' };
} });
let diag = null;
let screens = null;
const shown = () => !!(screens && screens.st && !screens.paused);
const exhaust = new Exhaust({ diag: () => diag, log, onChange: () => render(), shown });

// the selector (P R N D): VehicleInformation, as Car Data reads it (a number 1-4 or a name; sent on a change)
const STAGE = { 1: 'P', 2: 'R', 3: 'N', 4: 'D', P: 'P', R: 'R', N: 'N', D: 'D' };
let stage = null;
const xdrive = new XDrive({ diag: () => diag, guard, stage: () => stage, log, onChange: () => render(), shown });
function connectGearbox() {
    const put = (x) => { const s = x && STAGE[x.statusActualStageDrive]; if (s !== undefined && s !== stage) { stage = s || null; log(`selector ${stage}`); render(); } };
    return someipBuilders.buildAndInitTypedProxy('de.bmw.infrastructure.VehicleInformation', '1', { timeoutMs: 10000 })
        .then((p) => Promise.resolve(p.statusGearboxDrive.subscribe(put))
            .then(() => (typeof p.statusGearboxDrive.getValue === 'function' ? p.statusGearboxDrive.getValue().then(put) : null)))
        .then(() => log('selector signal connected'))
        .catch((e) => { log('selector signal failed:', e); setTimeout(connectGearbox, 30000); });
}

function connectTasu() {
    return someipBuilders.buildAndInitTypedProxy(TASU_IF, TASU_INST, { timeoutMs: 10000 })
        .then((proxy) => { const d = new Diag(log, guard); return d.attach(proxy).then(() => { diag = d; }); })
        .then(() => { log('TASU connected'); exhaust.start(); xdrive.start(); render(); xdrive.tick(); exhaust.tick(); })
        .catch((e) => { log('TASU failed:', e); setTimeout(connectTasu, 30000); render(); });
}

// ---- screens (the renderer) ----------------------------------------------------------------------------------
const RENDERER = path.join(SOURCE, 'renderer');
const runtime = (f) => require(path.join(RENDERER, f));

function render() {
    if (!screens) return;
    const s = state[page];
    screens.set('title', { text: PAGES.find((p) => p.key === page).title });
    PAGES.forEach((p) => {
        const on = p.key === page;
        screens.set(`rail_${p.key}_bg`, { hidden: !on })
            .set(`rail_${p.key}_label`, { color: on ? TEXT : DIM })
            .set(`rail_${p.key}_icon`, { color: on ? TEXT : DIM });
    });
    const ex = exhaust.view(), xd = xdrive.view();
    ROWS.forEach((r) => {
        const focused = r.key === focus;
        const chosen = r.key === 'exhaust' ? ['open', 'closed', 'oem'].indexOf(ex.want) : r.key === 'xdrive' ? xd.chosen : s[r.key];
        // a live row: red only once the car confirms it, yellow while it is sent / waiting for that (dummies: red)
        const color = !r.live || (r.key === 'exhaust' ? ex.confirmed : xd.confirmed) ? RED : AMBER;
        screens.set(`${r.key}_focus`, { hidden: !focused });
        r.options.forEach((o, j) => {
            const sel = chosen === j;
            screens.set(`${r.key}_${j}`, { color: sel ? color : OPTION })
                .set(`${r.key}_${j}_frame`, { hidden: !(sel && focused) })
                .set(`${r.key}_${j}_fill`, { hidden: !(sel && focused) });
        });
    });
    screens.set('exhaust_sub', { text: ex.line, color: ex.warn ? AMBER : DIM })
        .set('xdrive_sub', { text: xd.line, color: xd.warn ? AMBER : DIM });
}

function choose(row, j) {
    focus = row;
    if (row === 'exhaust') { exhaust.set(['open', 'closed', 'oem'][j]); render(); return; }
    if (row === 'xdrive') { xdrive.tap(j === 0 ? 'on' : 'off'); render(); return; }
    state[page][row] = j;
    const r = ROWS.find((x) => x.key === row);
    log(`${page}: ${r.label} -> ${r.options[j]} (demo, nothing sent)`);
    save(); render();
}

const EVENTS = {};
PAGES.forEach((p) => { EVENTS[`page_${p.key}`] = () => { page = p.key; render(); }; });
ROWS.forEach((r) => r.options.forEach((o, j) => { EVENTS[`${r.key}_${j}`] = () => choose(r.key, j); }));
const onEvent = (name) => { if (EVENTS[name]) Promise.resolve().then(EVENTS[name]).catch((e) => log(`${name} failed:`, e)); };

// ---- RHMI: the host state (the OnlineApp host hands it over) ------------------------------------------------
let app = null;
const comp = (n) => app.getByName(n);
function showScreen(name) {
    return comp(name).updateResources().then(() => app.openState(name))
        .then(() => log(`opened ${name}`))
        .catch((e) => log(`open ${name} failed:`, e));
}
const closeScreen = (name) => app.closeState(name).catch((e) => log(`close ${name} failed:`, e));

function startScreens(rhmiApp, hosts) {
    app = rhmiApp;
    const design = JSON.parse(fs.readFileSync(path.join(RENDERER, 'screens.json'), 'utf8'));
    const { RenderClient } = runtime('kit/renderd.js');
    const { ScreenApp } = runtime('screenapp.js');
    const rlog = { info: (m) => log(m), warn: (m) => log(m), error: (m) => log(m) };
    const gpu = new RenderClient('iteriodev_msetup', rlog);
    screens = new ScreenApp(gpu, design, { view: 'id8', log: rlog });
    screens.bindHosts(hosts, { open: (name) => showScreen(name), close: closeScreen });
    screens.on('event', onEvent);
    screens.on('show', () => { render(); exhaust.tick(); xdrive.lastPoll = 0; xdrive.tick(); });
    // the user left for the HMI (touched it): leave the host state too, or the HMI would show its empty page.
    // The flap stays as chosen while the app runs (held, guarded); OEM hands it back.
    screens.on('closed', (why) => { if (why !== 'hmi') STATES.slice().reverse().forEach(closeScreen); });
    gpu.connect();
    render();
}

// ---- lifecycle: the shared OnlineApp host (start, tile, shutdown; iDrive 7 + 8) -----------------------------
log('start', process.getuid());
createHost({
    states: STATES,
    log,
    onReady: (rhmiApp, hosts) => { startScreens(rhmiApp, hosts); log('screens ready'); connectTasu(); connectGearbox(); },
    // the app stops: the flap goes back to the DME at once (it would anyway, ~20 s after the last hold)
    onShutdown: () => exhaust.shutdown(),
});
