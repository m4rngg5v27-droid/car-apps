'use strict';
/*
 * iteriodev_msetup ("M Setup"), DRAFT: the iDrive 8 M Setup page with dummy switches. Engine, Chassis, Steering,
 * Brake, M xDrive and M Traction Control on three pages (SETUP, M1, M2), as the car's own page lays them out.
 * A tap only changes what this screen shows and keeps it in data/msetup.json: NOTHING is sent to the car.
 * The real calls come later, once it is known what the stock page sends (a SOME/IP capture of the menu).
 *
 * Screen: drawn by the GPU renderer from renderer/screens.json (made by drafts/iteriodev_msetup/layout.js).
 * Start, tile and shutdown on iDrive 7 and 8: the shared OnlineApp host (online-host.js).
 */
const fs = require('fs');
const path = require('path');
const util = require('util');
const { createHost }                   = require('./online-host.js');
const { ROWS, TRACTION, PAGES }        = require('./rows.js');

const LOG = '[iteriodev_msetup]';
const STATES = ['home'];          // screens = their RHMI host states, the entry state first

// the linked bundle is javascript/app.js: the package root is one up, the app's data folder beside it (the Store's)
const SOURCE = typeof __dirname === 'string' ? path.join(__dirname, '..') : `/var/opt/public/oap/oap_${process.getuid()}/source`;
const DATA = path.join(__dirname, '..', '..', 'data');
const LOG_FILE = `${DATA}/msetup.log`;
const SAVE_FILE = `${DATA}/msetup.json`;
const RED = '#ff3b30', OPTION = '#c9ced6', TEXT = '#e8ecf2', DIM = '#8a95a6';

const errText = (e) => String(e && e.message || e).slice(0, 120);
function log() {
    const line = [new Date().toISOString()].concat([].slice.call(arguments)
        .map((x) => (typeof x === 'string' ? x : util.inspect(x, { depth: 4 }).slice(0, 2000)))).join(' ');
    console.error(LOG, line);
    try { if (fs.statSync(LOG_FILE).size > 256 * 1024) fs.writeFileSync(LOG_FILE, ''); } catch (e) { /* no file yet */ }
    try { fs.appendFileSync(LOG_FILE, `${line}\n`); } catch (e) { /* no data folder */ }
}

// ---- dummy state: one set of choices per page ---------------------------------------------------------------
const DEFAULTS = {
    setup: { engine: 0, chassis: 0, steering: 0, brake: 0, xdrive: 0, traction: 0 },
    m1: { engine: 1, chassis: 1, steering: 1, brake: 1, xdrive: 1, traction: 5 },
    m2: { engine: 2, chassis: 2, steering: 1, brake: 1, xdrive: 2, traction: 10 },
};
let state = load();
let page = 'setup';
let focus = ROWS[0].key;          // the row last touched (the HMI's focus bar)

function load() {
    const s = JSON.parse(JSON.stringify(DEFAULTS));
    try {
        const saved = JSON.parse(fs.readFileSync(SAVE_FILE, 'utf8'));
        Object.keys(s).forEach((p) => Object.keys(s[p]).forEach((k) => {
            const v = saved && saved[p] && saved[p][k];
            if (typeof v === 'number' && isFinite(v)) s[p][k] = v;
        }));
    } catch (e) { /* none yet: the defaults */ }
    return s;
}
function save() {
    try { fs.writeFileSync(`${SAVE_FILE}.tmp`, JSON.stringify(state)); fs.renameSync(`${SAVE_FILE}.tmp`, SAVE_FILE); }
    catch (e) { log('save failed:', errText(e)); }
}

// ---- screens (the renderer) ----------------------------------------------------------------------------------
const RENDERER = path.join(SOURCE, 'renderer');
const runtime = (f) => require(path.join(RENDERER, f));
let screens = null;

const tractionText = (v) => (v <= 0 ? '0 (OFF)' : String(v));

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
    ROWS.forEach((r) => {
        const focused = r.key === focus;
        screens.set(`${r.key}_focus`, { hidden: !focused });
        r.options.forEach((o, j) => {
            const sel = s[r.key] === j;
            screens.set(`${r.key}_${j}`, { color: sel ? RED : OPTION })
                .set(`${r.key}_${j}_frame`, { hidden: !(sel && focused) })
                .set(`${r.key}_${j}_fill`, { hidden: !(sel && focused) });
        });
    });
    screens.set(`${TRACTION.key}_focus`, { hidden: focus !== TRACTION.key })
        .set('traction_slider', { value: s.traction })
        .set('traction_value', { text: tractionText(s.traction) });
}

function choose(row, j) {
    state[page][row] = j; focus = row;
    const r = ROWS.find((x) => x.key === row);
    log(`${page}: ${r.label} -> ${r.options[j]} (demo, nothing sent)`);
    save(); render();
}
function traction(v) {
    v = Math.max(TRACTION.min, Math.min(TRACTION.max, Math.round(v)));
    focus = TRACTION.key;
    if (state[page].traction === v) { render(); return; }
    state[page].traction = v;
    log(`${page}: ${TRACTION.label} -> ${tractionText(v)} (demo, nothing sent)`);
    save(); render();
}

const EVENTS = {
    traction_minus: () => traction(state[page].traction - 1),
    traction_plus: () => traction(state[page].traction + 1),
};
PAGES.forEach((p) => { EVENTS[`page_${p.key}`] = () => { page = p.key; render(); }; });
ROWS.forEach((r) => r.options.forEach((o, j) => { EVENTS[`${r.key}_${j}`] = () => choose(r.key, j); }));

const onEvent = (name) => { if (EVENTS[name]) Promise.resolve().then(EVENTS[name]).catch((e) => log(`${name} failed:`, e)); };
const onChange = (name, opts) => { if (name === 'traction_slider' && opts) traction(opts.value); };

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
    screens.on('change', onChange);
    screens.on('show', () => render());
    // the user left for the HMI (touched it): leave the host state too, or the HMI would show its empty page
    screens.on('closed', (why) => { if (why !== 'hmi') STATES.slice().reverse().forEach(closeScreen); });
    gpu.connect();
    render();
}

// ---- lifecycle: the shared OnlineApp host (start, tile, shutdown; iDrive 7 + 8) -----------------------------
log('start', process.getuid());
createHost({
    states: STATES,
    log,
    onReady: (rhmiApp, hosts) => { startScreens(rhmiApp, hosts); log('screens ready'); },
});
