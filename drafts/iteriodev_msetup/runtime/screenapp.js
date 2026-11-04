'use strict';
/*
 * A renderer app's screens on mgu-renderd - car-portable (Node 8): the builder's emulator mode is one such app, an
 * app on the car the other (it ships this file with the builder's export, renderer/). Draws a design's screens
 * (gpu.js record) with the kit's RenderClient, claims their touch area and runs the touches like the builder's Try
 * mode (gpu.js touchElement: switches, sliders, tabs… -> 'change'; taps: open another screen, back, or an app
 * event -> 'event'). The app shows its own values with set(). It gets out of the HMI's way:
 *   - a "close the app" tap                                                  -> closed ('closed', 'app')
 *   - a touch on the HMI outside the claims: the renderer hid the app      -> closed ('closed', 'touch')
 *   - its RHMI host state hidden: HOME / BACK keys, voice, any HMI navigation -> closed ('closed', 'hmi')
 *   - the host state losing focus to an HMI popup (call, warning, options) -> hidden while it is up, then back
 * The last two need bindHosts() / bindHost(): only an RHMI app hears them (the renderer can't: the HMI draws its
 * popups and screens in its own surface, and the keys go to the HMI).
 *
 *   const app = new ScreenApp(gpu, design, { view: 'id8', log });     // design: renderer/screens.json
 *   // one RHMI host state per screen (the builder's export): the HMI's BACK goes back a screen
 *   app.bindHosts({ home: rhmiApp.getByName('home'), bests: rhmiApp.getByName('bests') },
 *       { open: (name) => rhmiApp.openState(name), close: (name) => rhmiApp.closeState(name) });
 *   app.on('event', (name) => ...);  app.on('change', (element, opts) => ...);
 *   app.on('show', (name) => ...);   // a screen is about to draw its first frame: set() its values here
 *   app.set('timeReadout', { value: 4.21 });                           // any element, by name
 */
const EventEmitter = require('events');
const { record, touchElement, elementAt, claims } = require('./gpu');
const E = require('./public/gpu-elements');
const W = require('./widgets');

const truthy = (v) => v === true || v === 'true' || v === 1;
const copy = (o) => JSON.parse(JSON.stringify(o));

class ScreenApp extends EventEmitter {
    constructor(gpu, project, opts) {
        super();
        opts = opts || {};
        // a builder project { states } or the export's renderer/screens.json { design, screens }
        this.gpu = gpu; this.project = project && project.screens ? { states: project.screens } : project || { states: [] };
        this.view = opts.view || 'id8'; this.log = opts.log || console;
        this.st = null;            // the screen shown (its page copy: touches and set() change it), null = closed
        this.pages = {};           // name -> page copy, kept while the app is open (back to a screen: as it was)
        this.back = [];            // without hosts: the screens a tap opened this one from
        this.paused = false;       // hidden for an HMI popup
        this.hosts = null; this.nav = null; this.up = [];   // bindHosts: host state per screen, the ones shown
        this.press = -1; this.animate = false; this.keep = null; this.anim = null; this.lastEvent = null; this.closedBy = null;
        this.drawing = false;
        if (opts.maxFps && gpu.maxFps) gpu.maxFps(opts.maxFps);    // renderer frame cap (renderd 1.1.2+, older ignore it)
        gpu.on('touch', (phase, x, y) => this._touch(phase, x, y));
        gpu.on('closed', () => this._closed('touch'));
        gpu.on('ready', () => { if (this.st) { this._place(); this._draw(); this._claim(); } });   // (re)connected
    }

    /** Show a screen (name, or a screen object: the builder) from its start; animate: demo values. */
    open(screen, animate) {
        const name = typeof screen === 'string' ? screen : screen && screen.name;
        if (typeof screen !== 'string' && screen) this.pages = {};
        const st = typeof screen === 'string' ? this._page(name) : screen && (this.pages[name] = copy(screen));
        if (!st) return false;
        this._stop();
        Object.assign(this, { st, back: [], paused: false, press: -1, animate: !!animate, closedBy: null });
        this.emit('show', name);       // the app sets this screen's values now: its first frame shows them, not the design's
        this._place();
        this._draw(animate ? 0 : undefined);
        this._claim();
        this.gpu.show(true);
        this._run();
        return true;
    }

    /** Leave: hidden, nothing claimed, the pages' state forgotten. */
    close() {
        this._stop();
        this.gpu.show(false);
        this.st = null; this.pages = {}; this.back = []; this.up = []; this.paused = false;
        this._claim();
    }

    /** An HMI popup is over the app: hide it (the popup must be seen and touched), keep its state. */
    pause() {
        if (!this.st || this.paused) return;
        this.paused = true;
        this._stop();
        this.gpu.show(false);
        this._claim();
    }

    resume() {
        if (!this.st || !this.paused) return;
        this.paused = false;
        this._draw();
        this._claim();
        this.gpu.show(true);
        this._run();
    }

    /** The shown screen was edited (the builder): draw it again. Another screen: false. */
    update(st) {
        if (!this.st || !st || st.name !== this.st.name) return false;
        this.st = this.pages[st.name] = st;
        this._draw();
        this._claim();
        return true;
    }

    /**
     * The app's values: merge opts into element `name` (names are unique in a design) - in the design and in
     * every page copy, so a screen opened later shows them too. Drawn once per turn, only when something changed.
     */
    set(name, opts, screen) {         // screen: only that screen's element (names may repeat across screens)
        let changed = false;
        // arrays / objects (a chart's points) count as changed only when their content did
        const same = (a, b) => a === b || (a !== null && b !== null && typeof a === 'object' && typeof b === 'object' && JSON.stringify(a) === JSON.stringify(b));
        // undefined = no value: null, which draws as '--' (page copies go through JSON, where an undefined
        // value would vanish and the element show its preview value)
        const val = (v) => (v === undefined ? null : v);
        const apply = (st) => (screen && st.name !== screen ? [] : st.components || []).forEach((c) => {
            if (c.name !== name) return;
            c.opts = c.opts || {};
            Object.keys(opts).forEach((k) => { if (!same(c.opts[k], val(opts[k]))) { c.opts[k] = val(opts[k]); if (st === this.st) changed = true; } });
        });
        (this.project.states || []).forEach(apply);
        Object.keys(this.pages).forEach((k) => apply(this.pages[k]));
        if (changed) this._soon();
        return this;
    }

    /**
     * A picture for elements that name it 'key:<key>' (record.js makeImage; null = none): drawn again when the
     * screen shown uses it.
     */
    setImage(key, img) {
        W.setPicture(key, img);
        const ref = `key:${key}`;
        const uses = (v) => v === ref || (Array.isArray(v) && v.some((x) => x && (x.icon === ref || x.src === ref)));
        if (this.st && (this.st.components || []).some((c) => c.opts && Object.keys(c.opts).some((k) => uses(c.opts[k])))) this._soon();
        return this;
    }

    /** Element `name`'s options on the shown screen (or the design). */
    get(name) {
        const find = (st) => st && (st.components || []).find((c) => c.name === name);
        const c = find(this.st) || (this.project.states || []).map(find).find(Boolean);
        return c ? c.opts : undefined;
    }

    /**
     * One RHMI host state per screen (oap-sdk components, the builder's export makes them): the screen shown is
     * the host state the HMI shows - so the HMI's BACK goes back a screen and HOME closes the app. nav: the app's
     * { open(name), close(name) } (rhmiApp.openState / closeState): taps open / leave screens through the HMI.
     */
    bindHosts(hosts, nav) {
        this.hosts = hosts; this.nav = nav;
        Object.keys(hosts).forEach((name) => {
            hosts[name].on('visible', (ev) => this._hostVisible(name, truthy((ev || {}).visible)));
            hosts[name].on('focus', (ev) => {
                if (truthy((ev || {}).focus)) { this.lost = null; if (!this.st || this.st.name === name) this.resume(); return; }
                // a host the HMI leaves (another screen, BACK) loses focus too: only a popup over the screen shown
                // pauses it - the host still shown, still this screen, focus not back a moment later
                const lost = this.lost = {};
                setTimeout(() => {
                    if (this.lost === lost && this.st && this.st.name === name && this.up.indexOf(name) >= 0) this.pause();
                }, 300);
            });
        });
    }

    /**
     * One RHMI host state for all screens (or a stand-in: the builder's emulator mode): hidden -> close, shown
     * again -> open `entry` (a screen name, or a function giving one) if closed; focus lost -> pause, back -> resume.
     */
    bindHost(state, entry) {
        state.on('visible', (ev) => {
            const name = typeof entry === 'function' ? entry() : entry;
            if (!truthy((ev || {}).visible)) { if (this.st) this._closed('hmi'); } else if (!this.st && name) this.open(name);
            else this.resume();
        });
        state.on('focus', (ev) => (truthy((ev || {}).focus) ? this.resume() : this.pause()));
    }

    status() { return { page: this.st && this.st.name, paused: this.paused, lastEvent: this.lastEvent, closedBy: this.closedBy }; }

    // ---- inside ----
    _find(name) { return (this.project.states || []).find((s) => s.kind === 'gpu' && s.name === name); }
    _page(name) {
        if (!this.pages[name]) { const st = this._find(name); if (!st) return null; this.pages[name] = copy(st); }
        return this.pages[name];
    }

    // design -> this screen: the design's app area fitted into the head unit's, top left. The head unit is told by its
    // screen: iDrive 8's 2880 x 960 (3:1) 1:1; iDrive 7's 1920 x 720 (8:3) right of the back arrow, under the title strip
    _place() {
        const g = this.gpu, hu = E.TARGETS[g.screen.w / g.screen.h > 2.8 ? 'id8' : 'id7'];
        const k = Math.min(g.screen.w / hu.w, g.screen.h / hu.h), from = E.appArea(this.view), to = hu.app;
        this.scale = k * Math.min(to.w / from.w, to.h / from.h);
        g.place({ x: 0, y: 0, w: g.screen.w, h: g.screen.h, scale: this.scale,
            ox: k * to.x - from.x * this.scale, oy: k * to.y - from.y * this.scale });
    }

    _draw(time) {
        if (this.st && !this.paused && this.gpu.ready) this.gpu.frame(record(this.st, { textScale: this.scale, time, view: this.view }));
    }
    _soon() {            // set() many values in one turn: one frame
        if (this.drawing) return;
        this.drawing = true;
        setImmediate(() => { this.drawing = false; if (!this.animate) this._draw(); });
    }

    /** The touch area (gpu.js claims, design px = logical px of the placement); nothing while closed or paused. */
    _claim() { this.gpu.claim(this.st && !this.paused ? claims(this.st, this.view) : []); }

    // animated: a frame per tick; static: one a second (the renderer hides an app silent for 3 s - and drops its claims)
    _run() {
        if (this.animate) { const t0 = Date.now(); this.anim = () => this._draw((Date.now() - t0) / 1000); this.gpu.on('tick', this.anim); }
        else this.keep = setInterval(() => this._draw(), 1000);
    }
    _stop() {
        if (this.anim) this.gpu.removeListener('tick', this.anim);
        clearInterval(this.keep);
        this.anim = this.keep = null;
    }

    _closed(why) {
        this.log.info(`screens closed (${{ touch: 'the HMI was touched', hmi: 'the HMI took over', app: 'a "close the app" tap' }[why]})`);
        if (why !== 'touch') this.gpu.show(false);  // 'touch': the renderer already hid it
        this._stop();
        this.st = null; this.pages = {}; this.back = []; this.up = []; this.paused = false; this.closedBy = why;
        this._claim();
        this.emit('closed', why);
    }

    // hosts: the screen shown follows the host states the HMI shows; none left (HOME, BACK out of the app) -> closed.
    // The HMI hides the old state and shows the new one in either order: wait a moment before closing.
    _hostVisible(name, on) {
        this.up = this.up.filter((n) => n !== name);
        if (on) {
            this.up.push(name);
            if (!this.st) this.open(name);
            else if (this.st.name !== name) this._show(name);
            return;
        }
        setTimeout(() => {
            if (!this.up.length) { if (this.st) this._closed('hmi'); } else if (this.st && this.st.name !== this.up[this.up.length - 1]) this._show(this.up[this.up.length - 1]);
        }, 300);
    }

    _show(name) {
        const st = this._page(name);
        if (!st) return;
        this.st = st; this.press = -1;
        this.emit('show', name);
        this._draw();
        this._claim();
    }

    _touch(phase, x, y) {
        if (!this.st || this.paused) return;
        const p = { x, y };
        if (phase === 'down') this.press = elementAt(this.st, p);
        if (this.press < 0) return;
        const c = this.st.components[this.press];
        const r = touchElement(this.st, this.press, phase, p);
        if (phase === 'up') this.press = -1;
        if (r.opts) { this._draw(); this.emit('change', c.name, c.opts); }
        if (r.action) this._tap(r.action);
    }

    /** A tap's onTap: another screen of the design, back, close the app, or an app event. */
    _tap(a) {
        if (a.event) { this.lastEvent = a.event; this.emit('event', a.event); return; }
        if (a.close) return this._closed('app');     // the car app closes its RHMI host state on 'closed' too
        if (this.nav) {                               // through the HMI: its host state becomes visible -> shown
            if (a.open && this._find(a.open)) this.nav.open(a.open);
            else if (a.back && this.st) this.nav.close(this.st.name);
            return;
        }
        const name = a.back ? this.back.pop() : a.open;
        if (!name || !this._find(name)) return;
        if (a.open) this.back.push(this.st.name);
        this._show(name);
    }
}

module.exports = { ScreenApp };
