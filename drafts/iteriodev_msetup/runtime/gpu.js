'use strict';
/*
 * Renderer screens (mgu-renderd, the idrive7-apps GPU overlay): drawn with the kit (kit/, MIT) the way an
 * app on the car draws them. One recording (kit/record.js draw commands) is
 *   - played back in software here (the renderer's own fallback path) -> PNG for the builder's preview
 *   - sent to the emulator's real mgu-renderd by emulator.js -> on the live HMI at the screen's resolution
 *
 * screen = { kind: 'gpu', name, theme: kit theme id, bg: 'theme' | 'none' | '#rrggbb',
 *            bgArea?: 'app' (bg fills only the head unit's app area, GPU.appArea: the HMI's menus show through),
 *            components: [ { name, rtype: 'gpu', gpu: <public/gpu-elements.js type>, x, y, w, h, opts: {...} } ] }
 * Positions are design pixels (iDrive 8, 2880 x 960). Other head units get the whole recording scaled
 * (renderer placement / browser): GPU.viewScale.
 */
const { Recorder, play } = require('./kit/record');
const { Canvas, withAlpha } = require('./kit/canvas');
const G = require('./kit/gauges');
const { theme: kitTheme } = require('./kit/themes');
const E = require('./public/gpu-elements');
const W = require('./widgets');
const S = require('./store-widgets');

const isNum = (x) => typeof x === 'number' && isFinite(x);
const list = (s) => String(s || '').split(',').map((x) => x.trim()).filter(Boolean);

// element box -> kit call. o = options with defaults filled in (colour '' = the template's own)
const DRAW = {
    radial: (cv, t, b, o) => G.radial(cv, t, b.x + b.w / 2, b.y + b.h / 2, Math.min(b.w, b.h) / 2,
        Object.assign({}, o, { zones: isNum(o.redFrom) && o.redFrom < o.max ? [{ from: o.redFrom, to: o.max, color: 'crit' }] : [] })),
    needle: (cv, t, b, o) => G.needle(cv, t, b.x + b.w / 2, b.y + b.h / 2, Math.min(b.w, b.h) / 2, o),
    ring: (cv, t, b, o) => G.ring(cv, t, b.x + b.w / 2, b.y + b.h / 2, Math.min(b.w, b.h) / 2, o),
    gmeter: (cv, t, b, o) => G.gmeter(cv, t, b.x + b.w / 2, b.y + b.h / 2, Math.min(b.w, b.h) / 2, Object.assign({ trail: [] }, o)),
    bar: (cv, t, b, o) => G.bar(cv, t, b.x, b.y, b.w, b.h, o),
    segBar: (cv, t, b, o) => G.segBar(cv, t, b.x, b.y, b.w, b.h, o),
    stat: (cv, t, b, o) => G.stat(cv, t, b.x, b.y, b.w, b.h, o),
    readout: (cv, t, b, o) => G.readout(cv, t, o.align === 'center' ? b.x + b.w / 2 : o.align === 'right' ? b.x + b.w : b.x, b.y, o),
    gear: (cv, t, b, o) => G.gear(cv, t, b.x + b.w / 2, b.y + b.h * 0.92, Object.assign({ size: b.h }, o)),
    shiftLights: (cv, t, b, o) => G.shiftLights(cv, t, b.x, b.y, b.w, b.h, o),
    chart: (cv, t, b, o) => {
        // the app's own lines: o.points / o.points2 = [[x, y], ...] (ScreenApp.set); not set: demo lines (the builder)
        const wave = (k) => Array.from({ length: 61 }, (_, i) => [(i / 60) * o.xMax, o.yMin + k(i) * (o.yMax - o.yMin)]);
        const ph = o.phase || 0, c = t[o.color] || o.color || t.accent;
        const series = [{ pts: Array.isArray(o.points) ? o.points : wave((i) => 0.5 + 0.35 * Math.sin(i / 7 + ph) + 0.1 * Math.sin(i / 2.3)),
            color: c, width: 3, fill: o.fill ? withAlpha(c, 0.18) : undefined }];
        if (o.target) series.push({ pts: Array.isArray(o.points2) ? o.points2 : wave((i) => 0.55 + 0.2 * Math.sin(i / 11 + ph * 0.5)), color: t.text, width: 2 });
        const names = list(o.legend);
        G.chart(cv, t, b.x, b.y, b.w, b.h, Object.assign({}, o, { xMin: 0, padTop: names.length ? 44 : o.yUnit ? 28 : 8, series }));
        if (names.length) W.legend(cv, t, b.x + b.w - 8, b.y + 16, names, series.map((s) => s.color), 20);
    },
    table: (cv, t, b, o) => {
        const cols = list(o.columns), w = cols.length ? b.w / cols.length : b.w;
        const rows = String(o.rows || '').split('\n').filter((r) => r.trim()).map(list);
        G.table(cv, t, b.x, b.y, b.w, cols.map((label, i) => ({ label, w, align: i ? 'right' : 'left' })), rows, o);
    },
    tyres: (cv, t, b, o) => G.tyres(cv, t, b.x, b.y, b.w, b.h, o),
    pill: (cv, t, b, o) => G.pill(cv, t, b.x, b.y, b.w, b.h, o.text, o),
    panel: (cv, t, b, o) => G.panel(cv, t, b.x, b.y, b.w, b.h, o.title),
    header: (cv, t, b, o) => G.header(cv, t, b.x, b.y, b.w, b.h, o.title, list(o.tabs), o.sel, []),
    menuBar: (cv, t, b, o) => {
        const names = list(o.buttons), bw = names.length ? b.w / names.length : b.w;
        G.menuBar(cv, t, b.x, b.y, b.w, b.h, names.map((label, i) => ({ label, x: b.x + i * bw, w: bw })), o.focus, o.variant);
    },
    text: (cv, t, b, o) => {
        const c = t[o.color] || o.color || t.text;
        if (!o.wrap) return cv.text(W.fit(cv, o.text, b.w, o.size, o.font), o.align === 'center' ? b.x + b.w / 2 : o.align === 'right' ? b.x + b.w : b.x,
            b.y + o.size * 0.8, o.size, c, { font: o.font, align: o.align });
        // wrapped (left aligned): each line of the text a paragraph, as many lines as the box holds
        let y = b.y;
        for (const para of String(o.text).split('\n')) {
            const room = Math.floor((b.y + b.h - y) / (o.size * 1.25));
            if (room < 1) break;
            y += Math.max(1, W.wrap(cv, para, b.x, y, b.w, o.size, c, room, o.font)) * o.size * 1.25;
        }
    },
    rect: (cv, t, b, o) => cv.roundRect(b.x, b.y, b.w, b.h, Math.min(o.radius || 0, b.w / 2, b.h / 2), t[o.color] || o.color || t.panelTop),
    line: (cv, t, b, o) => cv.line(b.x, b.y, b.x + b.w, b.y + b.h, o.width || 2, t[o.color] || o.color || t.dim),
    ...W.DRAW,
    ...S.DRAW,
};

// demo motion for "animate" on the emulator (the kit's own smoothing makes it glide)
function animate(type, o, s, i) {
    const wave = (speed, ph) => Math.sin(s * speed + i * 1.7 + (ph || 0));
    if (isNum(o.min) && isNum(o.max) && 'value' in o) o.value = o.min + (o.max - o.min) * (0.5 + 0.42 * wave(0.9));
    else if (isNum(o.value)) o.value = o.value * (1 + 0.08 * wave(1.1));
    if (type === 'shiftLights') { o.rpm = o.shift - o.range + (o.range + 500) * (0.5 + 0.5 * wave(1.4)); o.blink = Math.floor(s * 8) % 2 === 0; }
    if (type === 'gmeter') { o.lat = o.max * 0.6 * wave(0.8); o.long = o.max * 0.45 * wave(0.6, 1); }
    if (type === 'gear') o.gear = 1 + (Math.floor(s / 1.5 + i) % 7);
    if (type === 'tyres') for (const k of ['fl', 'fr', 'rl', 'rr']) if (isNum(o[k])) o[k] += 6 * wave(0.3, k.length);
    if (type === 'chart') o.phase = s * 2;
    if (type === 'waveform') o.phase = s * 5;
}

/**
 * Record one frame of a renderer screen. opts: { time (s, animate), textScale (device px per design px),
 * view (head unit 'id8' | 'id7': where its app area is) }.
 * Preview frames show the given values at once; animated ones glide with the kit's smoothing.
 */
function record(st, opts = {}) {
    const tg = E.DESIGN, t = kitTheme(st.theme);
    const rec = new Recorder(tg.w, tg.h, { textScale: opts.textScale || 1 });
    rec.clear([0, 0, 0, 0]);
    if (st.bg !== 'none') {
        const a = st.bgArea === 'app' ? E.appArea(opts.view) : { x: 0, y: 0, w: tg.w, h: tg.h };
        rec.fillRect(a.x, a.y, a.w, a.h, st.bg && st.bg !== 'theme' ? st.bg : t.bg);
    }
    (st.components || []).forEach((c, i) => {
        const def = E.ELEMENTS[c.gpu];
        if (!def || !DRAW[c.gpu] || (c.opts && c.opts.hidden)) return;       // hidden: the app's set(name, { hidden: true })
        const o = Object.assign(E.defaults(c.gpu), c.opts || {});
        for (const f of def.fields) if (f.kind === 'color' && !o[f.key]) delete o[f.key];
        if (opts.time != null) animate(c.gpu, o, opts.time, i); else o.smooth = false;
        o.area = E.appArea(opts.view);         // the head unit's app area (a sheet dims only that, never the HMI's menus)
        const b = { x: c.x || 0, y: c.y || 0, w: c.w || 0, h: c.h || 0 };
        try { DRAW[c.gpu](rec, t, b, o); } catch (e) {
            rec.errors = (rec.errors || []).concat(`${c.name}: ${e.message}`);
            rec.strokeRoundRect(b.x, b.y, Math.max(b.w, 40), Math.max(b.h, 40), 4, 3, '#ff3030');
            rec.text(`${c.name}: ${e.message}`, b.x + 8, b.y + 30, 22, '#ff3030');
        }
    });
    return rec;
}

/** PNG (RGBA, see-through where nothing is drawn) of a renderer screen at the design's pixel size. */
function renderPng(project, stateIndex, view) {
    const st = (project.states || [])[stateIndex];
    if (!st || st.kind !== 'gpu') throw { code: 400, msg: 'not a renderer screen' };
    const rec = record(st, { view }), cv = new Canvas(E.DESIGN.w, E.DESIGN.h);
    play(rec.words(), cv);
    return cv.png();
}

// Touch (the builder's Try mode, and the app on the emulator / car: mgu-renderd --touch, E_TOUCH): a press or drag at p
// (design px) on an element changes its state the way the app would. Kit elements here, the app widgets in
// widgets.js (W.TRY). drag: moves count too. A tap (released on the element) also runs its onTap.
const TRY = {
    header: (cv, b, o, p) => {       // the tabs where kit gauges.js header() puts them (no badges)
        const opt = { font: 'bold', spacing: 2 }, right = b.x + b.w - 16, titleW = o.title ? cv.textWidth(o.title, 38) : 0;
        const tw = list(o.tabs).map((n) => Math.max(170, cv.textWidth(n.toUpperCase(), 20, opt) + 64));
        let tx = b.x + 20 + (o.title && b.x + 20 + titleW + 40 + tw.reduce((a, w) => a + w, 0) <= right ? titleW + 40 : 0);
        const i = tw.findIndex((w) => (tx += w) > p.x);
        if (i < 0 || p.x < tx - tw[i] || tx > right) return false;
        o.sel = i;
    },
    menuBar: (cv, b, o, p) => { const n = list(o.buttons).length; if (!n) return false; o.focus = Math.min(n - 1, Math.floor((p.x - b.x) / (b.w / n))); },
    ...W.TRY,
    ...S.TRY,
};
const measure = new Recorder(E.DESIGN.w, E.DESIGN.h);     // text widths for TRY, as drawn
// which elements take touch, where a screen claims it, what a tap does: shared with the browser (gpu-elements.js)
const { box, inBox, interactive, elementAt, claims, claimed, tapAction } = E;

/**
 * Touch on element i of screen st: phase 'down' | 'move' | 'up' at p { x, y } (design px).
 * Returns { opts: the screen's new opts (one per element) or null = unchanged, action: tapAction() on a tap or null }.
 */
function touchElement(st, i, phase, p) {
    const c = (st.components || [])[i], h = c && TRY[c.gpu], r = { opts: null, action: null };
    if (!c || !interactive(c)) return r;
    if (phase === 'up') {
        if (h && h.up) {        // its own release: a list selects the row tapped; after a drag (scrolled) no tap at all
            const o = Object.assign(E.defaults(c.gpu), c.opts || {});
            if (h.up(measure, box(c), o, p) === false) return r;
            c.opts = o;
            r.opts = st.components.map((s) => s.opts);
        }
        if (inBox(box(c), p)) r.action = tapAction(c.onTap);
        return r;
    }
    if (!h || (phase === 'move' && !h.drag)) return r;
    const o = Object.assign(E.defaults(c.gpu), c.opts || {});
    if (h(measure, box(c), o, Object.assign({ move: phase === 'move' }, p)) === false) return r;
    c.opts = o;
    // choice cards / tiles: one of a kind is selected on a screen
    if (o.selected) for (const s of st.components) if (s !== c && s.gpu === c.gpu && s.opts) s.opts.selected = false;
    r.opts = st.components.map((s) => s.opts);
    return r;
}

/**
 * Touch at p (design px) on screen st as the renderer routes it: { outside: true } = not in the screen's claims
 * (the HMI gets it and the app closes); else the element it goes to (index, -1 = none) and touchElement's result.
 */
function touchAt(st, view, p) {
    if (!claimed(st, view, p)) return { outside: true, index: -1, opts: null, action: null };
    const index = elementAt(st, p);
    return Object.assign({ index }, index < 0 ? { opts: null, action: null } : touchElement(st, index, 'down', p));
}

// every element type with a touch behaviour here has its description in gpu-elements.js TOUCH (test_export.js)
module.exports = { record, renderPng, touchElement, touchAt, elementAt, claims, tapAction, TRY_TYPES: Object.keys(TRY), ICONS: W.ICONS };
