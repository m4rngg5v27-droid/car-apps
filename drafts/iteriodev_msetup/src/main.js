'use strict';
/*
 * iteriodev_msetup ("M Setup"), DRAFT: the iDrive 8 M Setup page. Engine, Steering, Gearbox and M xDrive (4WD / 2WD)
 * are dummy switches on three pages (SETUP, M1, M2): a tap only changes the screen and data/msetup.json, nothing goes
 * to the car. Exhaust is real: OPEN / CLOSED / OEM drive the electric exhaust flap through BMW's own DME job, held
 * by the app and guarded (exhaust.js). It is one state for every page, and a fresh start is always OEM.
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
    setup: { engine: 0, steering: 0, gearbox: 0, xdrive: 0 },
    m1: { engine: 1, steering: 1, gearbox: 1, xdrive: 0 },
    m2: { engine: 2, steering: 1, gearbox: 2, xdrive: 1 },
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

// ---- the exhaust flap (real) over the head unit's diagnostic link ---------------------------------------------
// only the flap job may go out at any speed (as in Live Adjustments); reads always; anything else is refused
// (speed is never fed to this guard, so the car never counts as parked here)
const base = createGuard({ engineRunning: true, freshMs: 3000 });
const flapJob = (sid, d) => sid === 0x2F && d[0] === 0x60 && d[1] === 0xFD;
const guard = Object.assign({}, base, { check: (sid, d) => (flapJob(sid, d) ? { ok: true, why: '' } : base.check(sid, d)) });
let diag = null;
let screens = null;
const exhaust = new Exhaust({ diag: () => diag, log, onChange: () => render(), shown: () => !!(screens && screens.st && !screens.paused) });

function connectTasu() {
    return someipBuilders.buildAndInitTypedProxy(TASU_IF, TASU_INST, { timeoutMs: 10000 })
        .then((proxy) => { const d = new Diag(log, guard); return d.attach(proxy).then(() => { diag = d; }); })
        .then(() => { log('TASU connected'); exhaust.start(); render(); })
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
    const ex = exhaust.view();
    ROWS.forEach((r) => {
        const focused = r.key === focus;
        const chosen = r.key === 'exhaust' ? ['open', 'closed', 'oem'].indexOf(ex.want) : s[r.key];
        screens.set(`${r.key}_focus`, { hidden: !focused });
        r.options.forEach((o, j) => {
            const sel = chosen === j;
            screens.set(`${r.key}_${j}`, { color: sel ? RED : OPTION })
                .set(`${r.key}_${j}_frame`, { hidden: !(sel && focused) })
                .set(`${r.key}_${j}_fill`, { hidden: !(sel && focused) });
        });
    });
    screens.set('exhaust_sub', { text: ex.line, color: ex.warn ? AMBER : DIM });
}

function choose(row, j) {
    focus = row;
    if (row === 'exhaust') { exhaust.set(['open', 'closed', 'oem'][j]); render(); return; }
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
    screens.on('show', () => { render(); exhaust.tick(); });
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
    onReady: (rhmiApp, hosts) => { startScreens(rhmiApp, hosts); log('screens ready'); connectTasu(); },
    // the app stops: the flap goes back to the DME at once (it would anyway, ~20 s after the last hold)
    onShutdown: () => exhaust.shutdown(),
});
