'use strict';
/*
 * The M Setup screen (renderer/screens.json), built in code so the rows, columns and hit boxes line up.
 * Modelled on the iDrive 8 M Setup page: a side rail (home, SETUP, M1, M2), a SETUP title, rows of options
 * (Engine, Steering, Gearbox, M xDrive, Exhaust) with the chosen one in red, and the diagonal light bands on the
 * right. A live row (Exhaust) has a small line under its label for what the car does. Design pixels are iDrive 8's (2880 x 960, the app area y 76..840);
 * iDrive 7 gets the whole screen scaled by the renderer.
 *
 * Element names main.js sets: title, demo, rail_<page>_{bg,icon,label}, <row>_{focus,icon,label},
 * <row>_<i> (option text), <row>_<i>_{frame,fill} (focus box), <row>_sub (live rows).
 * Events: page_<page>, home (close), <row>_<i>.
 */
const zlib = require('zlib');

const { ROWS, PAGES } = require('./src/rows.js');
const COL = { text: '#e8ecf2', dim: '#8a95a6', option: '#c9ced6', red: '#ff3b30', line: '#1a2029', rail: '#080b10' };
const TOP = 76, BOTTOM = 840;                   // iDrive 8's app area
const RAIL_W = 300;
const X0 = 340, X1 = 2080;                      // the list
const OPT_X = 1080, OPT_W = 330;                // option columns
const ROW_Y = 150, ROW_H = 120;
const DECO_X = 2100;

// ---- pictures (PNG data URIs): the focus bar and the light bands ---------------------------------------------
function png(w, h, px) {
    const crc = (b) => { let c = ~0; for (const x of b) { c ^= x; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1)); } return ~c >>> 0; };
    const chunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]);
        const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
    const raw = Buffer.alloc((w * 4 + 1) * h);
    for (let y = 0; y < h; y++) { raw[y * (w * 4 + 1)] = 0; px.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4); }
    const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
    return 'data:image/png;base64,' + Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr),
        chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]).toString('base64');
}

/** The focused row: blue from the left, fading out; brighter at its left edge (the iDrive 8 focus). */
function focusBar() {
    const w = 256, h = 16, px = Buffer.alloc(w * h * 4);
    for (let x = 0; x < w; x++) for (let y = 0; y < h; y++) {
        const t = x / (w - 1), i = (y * w + x) * 4;
        const a = x < 3 ? 0.9 : 0.62 * Math.pow(1 - t, 1.6);
        px[i] = 0x1f + Math.round(40 * (1 - t)); px[i + 1] = 0x4f; px[i + 2] = 0xc8; px[i + 3] = Math.round(255 * a);
    }
    return png(w, h, px);
}

/** The light bands right of the list: slanted blue / violet strips with soft glow, fading to the left. */
function bands() {
    const w = 390, h = 382, px = Buffer.alloc(w * h * 4);
    const strips = [            // [x at the bottom, width, r, g, b, strength]
        [40, 60, 40, 70, 210, 0.55], [120, 26, 110, 80, 230, 0.75], [168, 90, 30, 50, 170, 0.45],
        [280, 34, 140, 90, 255, 0.8], [330, 110, 50, 60, 190, 0.4],
    ];
    const slant = 0.55;          // x shift per pixel up
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        let r = 0, g = 0, b = 0, a = 0;
        for (const [sx, sw, sr, sg, sb, k] of strips) {
            const u = x - (sx + (h - y) * slant);           // distance into the strip
            if (u < -10 || u > sw + 10) continue;
            const inside = u >= 0 && u <= sw ? 1 : Math.max(0, 1 - Math.min(Math.abs(u), Math.abs(u - sw)) / 10);
            const edge = Math.max(0, 1 - Math.min(Math.abs(u), Math.abs(u - sw)) / 3);   // bright rim
            const s = k * (0.55 * inside + 0.6 * edge) * (0.35 + 0.65 * (1 - y / h));
            r += sr * s; g += sg * s; b += sb * s; a += s;
        }
        const fade = Math.min(1, x / 120);                  // into black at the list's side
        a = Math.min(1, a * 0.75) * fade;
        const i = (y * w + x) * 4, n = Math.max(1e-6, a / 0.75 / Math.max(fade, 1e-6));
        px[i] = Math.min(255, Math.round(r / n)); px[i + 1] = Math.min(255, Math.round(g / n)); px[i + 2] = Math.min(255, Math.round(b / n));
        px[i + 3] = Math.round(255 * a);
    }
    return png(w, h, px);
}

// ---- elements --------------------------------------------------------------------------------------------------
const el = (name, gpu, x, y, w, h, opts, extra) => Object.assign({ name, rtype: 'gpu', gpu, x, y, w, h, opts: opts || {} }, extra || {});
const text = (name, x, y, w, h, s, o) => el(name, 'text', x, y, w, h, Object.assign({ text: s, size: 32, font: 'label', align: 'left', color: COL.text, wrap: false }, o));
const rect = (name, x, y, w, h, color, radius, o, extra) => el(name, 'rect', x, y, w, h, Object.assign({ color, radius: radius || 0 }, o), extra);
const hit = (name, x, y, w, h, event) => rect(name, x, y, w, h, '#00000000', 0, {}, { onTap: event });

function design() {
    const c = [];
    const focus = focusBar();

    // side rail: home, then the pages
    c.push(rect('railBg', 0, TOP, RAIL_W, BOTTOM - TOP, COL.rail));
    c.push(rect('railEdge', RAIL_W - 2, TOP, 2, BOTTOM - TOP, '#1c222c'));
    c.push(el('homeIcon', 'icon', RAIL_W / 2 - 30, 104, 60, 60, { icon: 'GID_ICON_ADDRESSHOME_V01', color: COL.dim }));
    c.push(hit('homeHit', 0, TOP, RAIL_W, 120, 'close'));
    PAGES.forEach((p, i) => {
        const y = 210 + i * 200;
        c.push(rect(`rail_${p.key}_bg`, 14, y, RAIL_W - 28, 180, '#131a26', 14, { hidden: i !== 0 }));
        if (p.icon) c.push(el(`rail_${p.key}_icon`, 'icon', RAIL_W / 2 - 40, y + 26, 80, 80, { icon: p.icon, color: COL.text }));
        else c.push(text(`rail_${p.key}_icon`, 0, y + 30, RAIL_W, 80, p.mark, { size: 64, font: 'bold', align: 'center', color: COL.dim }));
        c.push(text(`rail_${p.key}_label`, 0, y + 120, RAIL_W, 40, p.label, { size: 28, align: 'center', color: i === 0 ? COL.text : COL.dim }));
        c.push(hit(`rail_${p.key}_hit`, 0, y, RAIL_W, 180, `event:page_${p.key}`));
    });

    // title and the demo line
    c.push(text('title', X0, 92, 900, 44, 'SETUP', { size: 30, font: 'bold', color: '#c8ced8' }));
    c.push(text('demo', X1 - 1000, 96, 1000, 36, 'DEMO switches · only Exhaust is sent to the car', { size: 24, align: 'right', color: '#ffb020' }));

    // option rows (a live row: its label a little higher, a line under it)
    ROWS.forEach((r, i) => {
        const y = ROW_Y + i * ROW_H, ly = r.live ? y + 22 : y + 38;
        c.push(el(`${r.key}_focus`, 'image', X0 - 10, y + 4, X1 - X0 + 10, ROW_H - 8, { src: focus, radius: 4, hidden: i !== 0 }));
        c.push(el(`${r.key}_icon`, 'icon', X0 + 10, y + 34, 52, 52, { icon: r.icon, color: '#d7dce4' }));
        c.push(text(`${r.key}_label`, X0 + 84, ly, OPT_X - X0 - 100, 50, r.label, { size: 38 }));
        if (r.live) c.push(text(`${r.key}_sub`, X0 + 84, y + 72, OPT_X - X0 - 100, 32, '', { size: 22, color: COL.dim }));
        r.options.forEach((o, j) => {
            const x = OPT_X + j * OPT_W;
            c.push(rect(`${r.key}_${j}_frame`, x + 8, y + 18, OPT_W - 16, ROW_H - 36, '#4a5a72', 8, { hidden: true }));
            c.push(rect(`${r.key}_${j}_fill`, x + 10, y + 20, OPT_W - 20, ROW_H - 40, '#0e1520', 7, { hidden: true }));
            c.push(text(`${r.key}_${j}`, x, y + 42, OPT_W, 42, o, { size: 32, font: 'bold', align: 'center', color: COL.option }));
            c.push(hit(`${r.key}_${j}_hit`, x, y, OPT_W, ROW_H, `event:${r.key}_${j}`));
        });
        c.push(rect(`${r.key}_line`, X0, y + ROW_H - 1, X1 - X0, 2, COL.line));
    });

    // the light bands
    c.push(el('deco', 'image', DECO_X, TOP, 2880 - DECO_X, BOTTOM - TOP, { src: bands(), radius: 0 }, { touch: false }));

    return {
        design: { w: 2880, h: 960 },
        screens: [{ kind: 'gpu', name: 'home', title: 'M Setup', entry: true, theme: 'm_tricolour', bg: '#03050a', bgArea: 'app', components: c }],
    };
}

module.exports = { design, ROWS, PAGES, COL };
