'use strict';
/**
 * renderd.js - connection from an app to mgu-renderd (kit/renderd), the GPU renderer.
 *
 *   const gpu = new RenderClient('car_vitals', log);
 *   gpu.on('ready', () => gpu.place({ x, y, w, h, scale, ox, oy }));
 *   gpu.on('tick', () => { ...record a frame...; gpu.frame(recorder); });
 *   gpu.show(true);
 *
 * Touch (MGU7 workspace renderer, protocol 2, `mgu-renderd --touch`): gpu.claim([{ x, y, w, h }]) in logical px;
 * while shown, gestures that start there come as gpu.on('touch', (phase 'down'|'move'|'up', x, y)) instead of
 * going to the HMI. A touch on the HMI outside them closes the app: gpu.on('closed') (the renderer hid it).
 *
 * Fonts, colour ramps and cached layers a frame uses are uploaded once per connection
 * (again after a reconnect or a resize). With `file` instead of a socket path the messages
 * are written to that file (for `mgu-renderd --replay`).
 *
 * Pictures (protocol 3, record.js makeImage + Recorder.image) are uploaded when a frame first uses them. The
 * renderer holds at most IMG_MAX of them / IMG_BYTES of pixels per app, so this side keeps under that by dropping
 * the ones unused the longest (never one the current frame needs): a long scrolling list of icons only keeps the
 * recently shown ones on the GPU and re-sends the others when they scroll back in. A renderer older than
 * protocol 3 gets a plain tile where each picture would be.
 *
 * Videos (protocol 4, MGU7 workspace renderd 1.2.0): gpu.video(id, '/dev/shm/mgu-video-<name>') names the file another
 * program writes the frames to (renderd src/proto.h), Recorder.video(id, ...) draws it; the renderer shows each new
 * frame by itself. An older renderer gets a black tile there.
 */
const net = require('net');
const fs = require('fs');
const EventEmitter = require('events');
const rec = require('./record');

const SOCKET = process.env.MGU_RENDERD_SOCKET || '/run/mgu-renderd/renderd.sock';
const M = { HELLO: 1, PLACE: 2, SHOW: 3, ATLAS: 4, RAMP: 5, LAYER: 6, FRAME: 7, DROP_LAYER: 8, CLAIM: 9, IMAGE: 10, DROP_IMAGE: 11, FPS: 12,
    VIDEO: 13, DROP_VIDEO: 14 };
const E = { READY: 101, TICK: 102, ERROR: 103, STATS: 104, TOUCH: 105, CLOSED: 106 };
const PHASES = [null, 'down', 'move', 'up'];
const PROTO = 4;                                          // what this kit speaks (renderd src/proto.h)
const IMG_MAX = 64, IMG_BYTES = 32 << 20;                 // the renderer's per-app limits (gfx.c)
const PLACEHOLDER = rec.pack('#2a3341');                  // tile for a picture on an older renderer
const NO_VIDEO = rec.pack('#000000');                     // and for a video

/** Pictures straight -> premultiplied RGBA (what the renderer blends with). */
function premultiply(d) {
    const b = Buffer.allocUnsafe(d.length);
    for (let i = 0; i < d.length; i += 4) {
        const a = d[i + 3];
        b[i] = (d[i] * a + 127) / 255; b[i + 1] = (d[i + 1] * a + 127) / 255; b[i + 2] = (d[i + 2] * a + 127) / 255; b[i + 3] = a;
    }
    return b;
}
/** Older renderer: each OP.IMAGE / OP.VIDEO at those words becomes OP.RRECT (same layout; the id word becomes a colour). */
function placeholders(words, at, colour) {
    const u = words.slice();
    for (const i of at) { u[i] = rec.OP.RRECT; u[i + 6] = colour === undefined ? PLACEHOLDER : colour; }
    return u;
}

function msg(type, payload) {
    const len = payload ? payload.length : 0;
    const b = Buffer.allocUnsafe(8 + len + ((4 - (len & 3)) & 3));
    b.writeUInt32LE(type, 0); b.writeUInt32LE(b.length - 8, 4);
    if (len) payload.copy(b, 8);
    if (b.length > 8 + len) b.fill(0, 8 + len);
    return b;
}
function words(u32) { return Buffer.from(u32.buffer, u32.byteOffset, u32.byteLength); }

class RenderClient extends EventEmitter {
    constructor(appId, log, opts) {
        super();
        this.appId = appId;
        this.log = log || console;
        this.opts = opts || {};
        this.sock = null;
        this.connected = false;
        this.ready = false;
        this.screen = { w: 1920, h: 720 };
        this.placement = null;
        this.visible = false;
        this.claims = [];            // touch areas, logical px
        this.fps = 0;                // frame cap (maxFps), 0 = none
        this.touch = false;          // the renderer routes touch (READY)
        this.inbuf = Buffer.alloc(0);
        this.version = 0;            // the renderer's protocol (READY)
        this.sent = { atlas: new Set(), ramp: new Set(), layer: new Set(), image: new Map(), video: new Set() };   // image: id -> { bytes, used }
        this.videoFiles = new Map(); // video id -> frame file (video())
        this.imageBytes = 0;
        this.useSeq = 0;             // frame counter for the least-recently-used picture
        this.imgWarned = false;
        this.stats = null;
        this.waiting = false;        // a frame was sent, no tick back yet
        this.retry = null;
        this.closed = false;
        this.fd = null;              // file sink
    }

    /** Socket exists (the renderer is installed and running)? */
    static available(path) { try { return fs.statSync(path || SOCKET).isSocket(); } catch (e) { return false; } }

    connect() {
        if (this.opts.file) {
            this.fd = fs.openSync(this.opts.file, 'w');
            this.connected = this.ready = true;
            this.version = PROTO;
            this._write(msg(M.HELLO, Buffer.from(this.appId)));
            setImmediate(() => this.emit('ready', this.screen));
            return this;
        }
        const path = this.opts.socket || SOCKET;
        const s = net.createConnection(path);
        this.sock = s;
        s.on('connect', () => {
            this.connected = true;
            this._reset();
            s.setNoDelay && s.setNoDelay(true);
            this._write(msg(M.HELLO, Buffer.from(this.appId)));
            if (this.placement) this._sendPlace();
            if (this.claims.length) this._sendClaim();
            if (this.fps) this._write(this._u32msg(M.FPS, [this.fps]));
            if (this.visible) this._write(this._u32msg(M.SHOW, [1]));
        });
        s.on('data', (d) => this._data(d));
        s.on('error', (e) => { if (!this.errLogged) { this.errLogged = true; this.log.warn('renderd: ' + e.message); } });
        s.on('close', () => {
            const was = this.ready;
            this.connected = this.ready = false; this.sock = null; this.waiting = false;
            if (was) { this.log.warn('renderd: connection closed'); this.emit('close'); }
            if (!this.closed) this.retry = setTimeout(() => { this.retry = null; this.connect(); }, 3000);
        });
        return this;
    }
    close() {
        this.closed = true;
        if (this.retry) clearTimeout(this.retry);
        if (this.sock) this.sock.destroy();
        if (this.fd !== null) { fs.closeSync(this.fd); this.fd = null; }
    }
    _reset() {
        this.sent.atlas.clear(); this.sent.ramp.clear(); this.sent.layer.clear(); this.sent.image.clear(); this.sent.video.clear();
        this.imageBytes = 0; this.waiting = false;
    }
    /** The renderer draws pictures (protocol 3)? Otherwise they show as plain tiles. */
    get images() { return this.version >= 3; }
    /** The renderer shows videos (protocol 4)? Otherwise a black tile. */
    get videos() { return this.version >= 4; }

    /** Video id's frames come from file (/dev/shm/mgu-video-<name>, written by another program); null = forget it. */
    video(id, file) {
        id >>>= 0;
        if (!file) { this.videoFiles.delete(id); if (this.sent.video.delete(id) && this.ready) this._write(this._u32msg(M.DROP_VIDEO, [id])); return; }
        if (this.videoFiles.get(id) === file && this.sent.video.has(id)) return;
        this.videoFiles.set(id, file); this.sent.video.delete(id);
        if (this.ready && this.placement) this._ensureVideo(id);
    }
    _ensureVideo(id) {
        const file = this.videoFiles.get(id);
        if (!file || this.sent.video.has(id) || !this.videos) return;
        const head = Buffer.alloc(4); head.writeUInt32LE(id, 0);
        this._write(msg(M.VIDEO, Buffer.concat([head, Buffer.from(file)])));
        this.sent.video.add(id);
    }
    _write(b) {
        if (this.fd !== null) { fs.writeSync(this.fd, b); return true; }
        return this.sock && this.connected ? this.sock.write(b) : false;
    }
    _u32msg(type, arr) { const u = new Uint32Array(arr); return msg(type, words(u)); }

    _data(d) {
        this.inbuf = this.inbuf.length ? Buffer.concat([this.inbuf, d]) : d;
        while (this.inbuf.length >= 8) {
            const type = this.inbuf.readUInt32LE(0), len = this.inbuf.readUInt32LE(4);
            if (this.inbuf.length < 8 + len) break;
            const p = this.inbuf.slice(8, 8 + len);
            this.inbuf = this.inbuf.slice(8 + len);
            if (type === E.READY) {
                this.ready = true; this.errLogged = false;
                this.version = p.readUInt32LE(0);
                this.screen = { w: p.readUInt32LE(4), h: p.readUInt32LE(8) };
                this.touch = p.length >= 16 && p.readUInt32LE(12) === 1;
                this.log.info('renderd: connected, screen ' + this.screen.w + 'x' + this.screen.h + (this.touch ? ', touch' : ''));
                this.emit('ready', this.screen);
            } else if (type === E.TOUCH) {
                if (PHASES[p.readUInt32LE(0)]) this.emit('touch', PHASES[p.readUInt32LE(0)], p.readFloatLE(4), p.readFloatLE(8));
            } else if (type === E.CLOSED) {
                this.visible = false;
                this.emit('closed');
            } else if (type === E.TICK) {
                this.waiting = false;
                this.emit('tick', p.readUInt32LE(0), p.readUInt32LE(4));
            } else if (type === E.STATS) {
                this.stats = { fps: p.readUInt32LE(0), avgUs: p.readUInt32LE(4), maxUs: p.readUInt32LE(8) };
                this.emit('stats', this.stats);
            } else if (type === E.ERROR) {
                this.log.warn('renderd error: ' + p.toString());
            }
        }
    }

    /**
     * Where the surface goes: x, y, w, h in screen pixels; logical content is drawn at
     * device = logical * scale + (ox, oy) inside it.
     */
    place(pl) {
        const resize = !this.placement || pl.w !== this.placement.w || pl.h !== this.placement.h;
        if (this.placement && !resize && ['x', 'y', 'scale', 'ox', 'oy'].every((k) => pl[k] === this.placement[k])) return;
        const scaleChanged = this.placement && this.placement.scale !== pl.scale;
        this.placement = Object.assign({}, pl);
        if (resize || scaleChanged) this._reset();     // the renderer dropped our resources
        if (this.ready) this._sendPlace();
    }
    _sendPlace() {
        const p = this.placement, b = Buffer.alloc(28);
        b.writeInt32LE(p.x | 0, 0); b.writeInt32LE(p.y | 0, 4); b.writeInt32LE(p.w | 0, 8); b.writeInt32LE(p.h | 0, 12);
        b.writeFloatLE(p.scale, 16); b.writeFloatLE(p.ox || 0, 20); b.writeFloatLE(p.oy || 0, 24);
        this._write(msg(M.PLACE, b));
    }
    show(on) {
        on = !!on;
        if (on === this.visible) return;
        this.visible = on;
        if (this.ready) this._write(this._u32msg(M.SHOW, [on ? 1 : 0]));
    }

    /** At most n frames a second for this app (0 = as fast as the display): frames sent faster wait in the renderer,
     *  ticks come at that rate. MGU7 workspace renderd 1.1.2+; an older one ignores it. */
    maxFps(n) {
        this.fps = Math.max(0, Math.min(1000, n | 0));
        if (this.connected) this._write(this._u32msg(M.FPS, [this.fps]));
    }

    /** Touch areas, logical px ([] = none): while shown, touch there is this app's (renderer protocol 2). */
    claim(rects) {
        this.claims = (rects || []).slice(0, 16);
        if (this.ready) this._sendClaim();
    }
    _sendClaim() {
        const b = Buffer.alloc(4 + this.claims.length * 16);
        b.writeUInt32LE(this.claims.length, 0);
        this.claims.forEach((r, i) => [r.x, r.y, r.w, r.h].forEach((v, k) => b.writeFloatLE(v, 4 + i * 16 + k * 4)));
        this._write(msg(M.CLAIM, b));
    }

    _ensureAtlas(id) {
        if (this.sent.atlas.has(id)) return;
        const f = rec.atlasById(id);
        if (!f) return;
        const head = Buffer.alloc(12);
        head.writeUInt32LE(id, 0); head.writeUInt32LE(f.atlasW, 4); head.writeUInt32LE(f.atlasH, 8);
        this._write(msg(M.ATLAS, Buffer.concat([head, f.alpha])));
        this.sent.atlas.add(id);
    }
    _ensureRamp(id) {
        if (this.sent.ramp.has(id)) return;
        const stops = rec.rampList[id];
        if (!stops) return;
        const u = new Uint32Array(2 + stops.length);
        u[0] = id; u[1] = stops.length;
        stops.forEach((c, i) => { u[2 + i] = rec.pack(c); });
        this._write(msg(M.RAMP, words(u)));
        this.sent.ramp.add(id);
    }
    _ensureRes(r) {
        if (r.atlases) r.atlases.forEach((id) => this._ensureAtlas(id));
        if (r.ramps) r.ramps.forEach((id) => this._ensureRamp(id));
        if (r.images && this.images) r.images.forEach((id) => this._ensureImage(id, r.images));
        if (r.layersUsed || r.sublayers) (r.layersUsed || r.sublayers).forEach((id) => this._ensureLayer(id));
    }
    _ensureLayer(id) {
        if (this.sent.layer.has(id)) return;
        const L = rec.layerById.get(id);
        if (!L) return;
        this._ensureRes(L);
        const head = Buffer.alloc(12);
        head.writeUInt32LE(id, 0); head.writeFloatLE(L.w, 4); head.writeFloatLE(L.h, 8);
        const w = L.imageAt && !this.images ? placeholders(L.words, L.imageAt) : L.words;
        this._write(msg(M.LAYER, Buffer.concat([head, words(w)])));
        this.sent.layer.add(id);
    }
    dropLayer(id) {
        if (this.sent.layer.delete(id) && this.ready) this._write(this._u32msg(M.DROP_LAYER, [id]));
    }

    /** Upload picture id unless the renderer has it; keep: the ids the frame being sent needs. */
    _ensureImage(id, keep) {
        const have = this.sent.image.get(id);
        if (have) { have.used = this.useSeq; return; }
        const img = rec.imageById.get(id);
        if (!img) return;
        const bytes = img.w * img.h * 4;
        while (this.sent.image.size >= IMG_MAX || this.imageBytes + bytes > IMG_BYTES) {
            let old = null;
            for (const [k, v] of this.sent.image) {
                if (!keep.has(k) && !(this.frameImages && this.frameImages.has(k)) && (!old || v.used < old[1].used)) old = [k, v];
            }
            if (!old) {      // all held pictures are on this frame: this one is left out (draws nothing)
                if (!this.imgWarned) { this.imgWarned = true; this.log.warn(`renderd: more pictures on one frame than the renderer holds (${IMG_MAX} / ${IMG_BYTES >> 20} MB)`); }
                return;
            }
            this._dropSent(old[0]);
        }
        const head = Buffer.alloc(12);
        head.writeUInt32LE(id, 0); head.writeUInt32LE(img.w, 4); head.writeUInt32LE(img.h, 8);
        this._write(msg(M.IMAGE, Buffer.concat([head, premultiply(img.data)])));
        this.sent.image.set(id, { bytes, used: this.useSeq });
        this.imageBytes += bytes;
    }
    _dropSent(id) {
        const s = this.sent.image.get(id);
        if (!s) return;
        this.sent.image.delete(id); this.imageBytes -= s.bytes;
        if (this.ready) this._write(this._u32msg(M.DROP_IMAGE, [id]));
    }
    /** A picture is gone for good (after record.js dropImage): free it in the renderer now. */
    dropImage(img) { this._dropSent(img.imageId); }

    /** Send a recorded frame (record.js Recorder). Returns false if not connected. */
    frame(r) {
        if (!this.ready || !this.placement) return false;
        this.useSeq++;
        this.frameImages = r.images;          // a layer's upload must not evict these
        this._ensureRes(r);
        this.frameImages = null;
        if (r.videos) r.videos.forEach((id) => this._ensureVideo(id));
        this.waiting = true;
        let w = r.imageAt && !this.images ? placeholders(r.words(), r.imageAt) : r.words();
        if (r.videoAt && !this.videos) w = placeholders(w, r.videoAt, NO_VIDEO);
        return this._write(msg(M.FRAME, words(w)));
    }
}

module.exports = { RenderClient, SOCKET };
