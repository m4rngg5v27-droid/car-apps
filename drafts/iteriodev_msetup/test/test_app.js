'use strict';
// node drafts/iteriodev_msetup/test/test_app.js - the packaged app: the real ScreenApp, screens.json and Diag; a fake renderer, HMI and TASU (a DME with the flap).
const Module = require('module'), EventEmitter = require('events'), path = require('path'), fs = require('fs');
// unpack the built package (apps/iteriodev_msetup/*.tgz) as the Store would lay it out: the bundle in javascript/
const os = require('os'), { execFileSync } = require('child_process');
const OUT = path.join(__dirname, '..', '..', '..', 'apps', 'iteriodev_msetup');
const tgz = path.join(OUT, fs.readdirSync(OUT).find((f) => /\.tgz$/.test(f)));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'msetup-test-'));
execFileSync('tar', ['-xzf', tgz, '-C', root]);
const tree = path.join(root, fs.readdirSync(root).find((f) => /@/.test(f))), data = path.join(root, 'data');
fs.mkdirSync(data); fs.mkdirSync(path.join(tree, 'javascript'));
for (const f of fs.readdirSync(path.join(root, 'src'))) fs.copyFileSync(path.join(root, 'src', f), path.join(tree, 'javascript', f));
console.error = () => {};      // the app's own log lines (they go to data/msetup.log too)
let host = null; const sent = [];
class FakeGpu extends EventEmitter { constructor() { super(); this.screen = { w: 2880, h: 960 }; this.ready = true; }
    connect() {} show() {} claim() {} place() {} frame() {} maxFps() {} }
const hex = (a) => Array.from(a).map((b) => (b < 16 ? '0' : '') + b.toString(16).toUpperCase()).join(' ');
const tasu = { cb: null,
    sendTasuResponse: { subscribe: (cb) => { tasu.cb = cb; return Promise.resolve(); } },
    sendTasuRequest: (q) => {
        const d = Array.from(q.udsData), sid = q.serviceID;
        if (sid !== 0x01 && sid !== 0x22) sent.push(hex([sid].concat(d)));
        const uds = sid === 0x01 ? [0x41, 0x0C, 0x0D, 0xAC] : sid === 0x22 ? [0x62, 0x64, 0xFD, 0x23, 0x28] : sid === 0x2F ? [0x6F, d[0], d[1]] : [0x7F, sid, 0x11];
        setImmediate(() => tasu.cb({ errorCode: 'NO_ERROR', udsResponse: Buffer.from([0, 0, 0, 0, 0, 0, q.targetAddress, 0, 0].concat(uds)) }));
        return Promise.resolve({ TasuErrorEnum: 'NO_ERROR' });
    } };
const load = Module._load;
Module._load = function (req) {
    if (req === './online-host.js') return { createHost: (o) => { host = o; } };
    if (req === 'oap-sdk/src/someip/someipBuilders') return { buildAndInitTypedProxy: () => Promise.resolve(tasu) };
    if (/kit[\\/]renderd\.js$/.test(req)) return { RenderClient: FakeGpu };
    return load.apply(this, arguments);
};
require(path.join(tree, 'javascript', 'main.js'));
const st = () => ({ on: () => {}, updateResources: () => Promise.resolve() });
const hosts = { home: st() };
const rhmi = { getByName: () => hosts.home, openState: () => Promise.resolve(), closeState: () => Promise.resolve() };
const SA = require(path.join(tree, 'renderer', 'screenapp.js')).ScreenApp;
let app = null; const on = SA.prototype.on; SA.prototype.on = function () { app = this; return on.apply(this, arguments); };
host.onReady(rhmi, hosts);
app.open('home');
const design = JSON.parse(fs.readFileSync(path.join(tree, 'renderer', 'screens.json'), 'utf8')).screens[0];
const tap = (name) => { const c = design.components.find((x) => x.name === name); const x = c.x + c.w / 2, y = c.y + c.h / 2;
    app.gpu.emit('touch', 'down', x, y); app.gpu.emit('touch', 'up', x, y); };
const opt = (name) => (app.st.components.find((c) => c.name === name) || {}).opts;
const wait = (ms) => new Promise((r) => setTimeout(r, ms || 60));
let failed = 0;
const check = (ok, what) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) failed++; };
(async () => {
    await wait(300);
    check(opt('engine_0').color === '#ff3b30' && opt('exhaust_2').color === '#ff3b30', 'default: Engine EFFICIENT, Exhaust OEM');
    check(!design.components.some((c) => /traction|chassis|brake/.test(c.name)), 'no Chassis, Brake or Traction rows');
    check(sent.length === 0, 'opening the app sends nothing (reads only)');
    tap('gearbox_2_hit'); tap('xdrive_1_hit'); await wait();
    check(opt('gearbox_2').color === '#ff3b30' && opt('xdrive_1').color === '#ff3b30' && opt('xdrive_focus').hidden === false, 'Gearbox SPORT PLUS, xDrive 2WD chosen, focus on xDrive');
    check(sent.length === 0, 'dummy rows send nothing');
    tap('exhaust_0_hit'); await wait(200);
    check(sent.join('|') === '2F 60 FD 03 03 E8', 'Exhaust OPEN: 2F 60FD 03 03E8 sent (got ' + sent.join('|') + ')');
    check(opt('exhaust_0').color === '#ff3b30' && /Held open by the app/.test(opt('exhaust_sub').text), 'Exhaust row: OPEN red, "Held open by the app · flap closed" (read-back): ' + opt('exhaust_sub').text);
    tap('exhaust_2_hit'); await wait(200);
    check(sent[sent.length - 1] === '2F 60 FD 00', 'Exhaust OEM: hand-back sent');
    tap('rail_m1_hit'); await wait();
    check(opt('title').text === 'M1 CONFIGURATION' && opt('engine_1').color === '#ff3b30' && opt('exhaust_2').color === '#ff3b30', 'M1: own dummy defaults, Exhaust the same live state');
    const saved = JSON.parse(fs.readFileSync(path.join(data, 'msetup.json'), 'utf8'));
    check(saved.setup.gearbox === 2 && saved.setup.xdrive === 1 && saved.exhaust === undefined && saved.setup.exhaust === undefined, 'saved: the dummies, not the exhaust');
    process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
