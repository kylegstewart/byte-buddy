// Pixel art for the Lounge, painted procedurally into RGBA buffers (one art pixel per world unit) so it is
// deterministic, testable in Node, and cheap to pan. paintMap() is the office floor; paintScenery() is the
// downtown Indianapolis view in three parallax layers behind the window glass.
import { TILE, GRID, ROWS, COLS, ZONES, PROPS } from "./lounge-map.js";

// ---------- raster + colour helpers ----------

const LITTLE_ENDIAN = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;

export function createCanvas(width, height) {
    const data = new Uint8ClampedArray(width * height * 4);
    const buf = new Uint32Array(data.buffer);
    const pack = LITTLE_ENDIAN
        ? (c, a) => ((a << 24) | ((c & 255) << 16) | (c & 0xff00) | ((c >> 16) & 255)) >>> 0
        : (c, a) => (((c & 0xffffff) << 8) | a) >>> 0;
    const unpack = LITTLE_ENDIAN
        ? (v) => [v & 255, (v >> 8) & 255, (v >> 16) & 255, v >>> 24]
        : (v) => [v >>> 24, (v >> 16) & 255, (v >> 8) & 255, v & 255];
    const ok = (x, y) => x >= 0 && y >= 0 && x < width && y < height;
    const canvas = {
        width, height, data,
        set(x, y, c) { x = Math.floor(x); y = Math.floor(y); if (ok(x, y)) buf[y * width + x] = pack(c, 255); },
        clear(x, y) { x = Math.floor(x); y = Math.floor(y); if (ok(x, y)) buf[y * width + x] = 0; },
        get(x, y) { if (!ok(x, y)) return 0; const [r, g, b] = unpack(buf[y * width + x]); return (r << 16) | (g << 8) | b; },
        alpha(x, y) { return ok(x, y) ? unpack(buf[y * width + x])[3] : 0; },
        /** Source-over blend of colour c at opacity a (0..1). */
        blend(x, y, c, a) {
            x = Math.floor(x); y = Math.floor(y);
            if (!ok(x, y) || a <= 0) return;
            if (a >= 1) { buf[y * width + x] = pack(c, 255); return; }
            const [dr, dg, db, da8] = unpack(buf[y * width + x]);
            const da = da8 / 255, oa = a + da * (1 - a);
            const ch = (s, d) => Math.round((s * a + d * da * (1 - a)) / oa);
            buf[y * width + x] = pack((ch((c >> 16) & 255, dr) << 16) | (ch((c >> 8) & 255, dg) << 8) | ch(c & 255, db), Math.round(oa * 255));
        },
        /** Multiplies the colour already there (keeps alpha); k < 1 darkens, k > 1 brightens. */
        tint(x, y, k) {
            x = Math.floor(x); y = Math.floor(y);
            if (!ok(x, y)) return;
            const [r, g, b, a] = unpack(buf[y * width + x]);
            if (!a) return;
            const f = (v) => Math.max(0, Math.min(255, Math.round(v * k)));
            buf[y * width + x] = pack((f(r) << 16) | (f(g) << 8) | f(b), a);
        },
        rect(x, y, w, h, c) { for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) canvas.set(x + i, y + j, c); },
        rectA(x, y, w, h, c, a) { for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) canvas.blend(x + i, y + j, c, a); },
        shade(x, y, w, h, k) { for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) canvas.tint(x + i, y + j, k); },
        fill(x, y, w, h, fn) { for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) { const c = fn(x + i, y + j); if (c !== null) canvas.set(x + i, y + j, c); } },
        hline(x, y, w, c) { canvas.rect(x, y, w, 1, c); },
        vline(x, y, h, c) { canvas.rect(x, y, 1, h, c); },
        disc(cx, cy, r, c) {
            for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++) for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) {
                if ((x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2 <= r * r) canvas.set(x, y, c);
            }
        },
        ellipse(cx, cy, rx, ry, c, a = 1) {
            for (let y = Math.floor(cy - ry); y <= Math.ceil(cy + ry); y++) for (let x = Math.floor(cx - rx); x <= Math.ceil(cx + rx); x++) {
                if (((x + 0.5 - cx) / rx) ** 2 + ((y + 0.5 - cy) / ry) ** 2 <= 1) canvas.blend(x, y, c, a);
            }
        },
        /** Outlined, optionally rounded box: the pixel-art workhorse for furniture. */
        box(x, y, w, h, c, outline = null, round = 1) {
            for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
                const corner = round && (i < round || i >= w - round) && (j < round || j >= h - round);
                if (corner && round === 1) continue;
                const edge = i === 0 || j === 0 || i === w - 1 || j === h - 1 || (round > 1 && corner);
                canvas.set(x + i, y + j, edge && outline !== null ? outline : c);
            }
            if (round === 1 && outline !== null) {
                canvas.set(x + 1, y + 1, outline); canvas.set(x + w - 2, y + 1, outline);
                canvas.set(x + 1, y + h - 2, outline); canvas.set(x + w - 2, y + h - 2, outline);
            }
        },
    };
    return canvas;
}

export function shadeColor(c, k) {
    const f = (v) => Math.max(0, Math.min(255, Math.round(k >= 0 ? v + (255 - v) * k : v * (1 + k))));
    return (f((c >> 16) & 255) << 16) | (f((c >> 8) & 255) << 8) | f(c & 255);
}

export function mixColor(a, b, t) {
    const f = (s) => Math.round(((a >> s) & 255) + (((b >> s) & 255) - ((a >> s) & 255)) * t);
    return (f(16) << 16) | (f(8) << 8) | f(0);
}

/** Stable per-pixel noise in [0, 1). */
export function hash(x, y, seed = 0) {
    let h = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(seed | 0, 1442695041)) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
}

export function seeded(seed) {
    return () => {
        seed = (seed + 0x6d2b79f5) | 0;
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
const dither = (x, y) => (BAYER[(y & 3) * 4 + (x & 3)] + 0.5) / 16;

// ---------- floors ----------

const T = TILE;
const jitter = (c, x, y, amount, seed = 0) => shadeColor(c, (hash(x, y, seed) - 0.5) * amount);

function carpetTiles(a, b, size, seed) {
    return (x, y) => {
        const odd = ((Math.floor(x / size) + Math.floor(y / size)) & 1) === 1;
        let c = odd ? b : a;
        const rib = odd ? (x & 1) : (y & 1);
        if (rib) c = shadeColor(c, -0.035);
        if (x % size === 0 || y % size === 0) c = shadeColor(c, -0.05);
        return jitter(c, x, y, 0.07, seed);
    };
}

function speckleCarpet(base, seed) {
    return (x, y) => {
        const n = hash(x, y, seed);
        if (n < 0.07) return shadeColor(base, -0.12);
        if (n > 0.95) return shadeColor(base, 0.1);
        return jitter(base, x >> 1, y >> 1, 0.05, seed + 1);
    };
}

function planks(colors, height, length, gap, seed) {
    return (x, y) => {
        const row = Math.floor(y / height);
        const shift = Math.floor(hash(row, 3, seed) * length);
        const index = Math.floor((x + shift) / length);
        if (y % height === height - 1 || (x + shift) % length === 0) return gap;
        let c = colors[Math.floor(hash(index, row, seed) * colors.length)];
        const grain = hash(Math.floor((x + shift) / 7), y, seed + 5);
        if (grain < 0.18) c = shadeColor(c, -0.07);
        else if (grain > 0.9) c = shadeColor(c, 0.05);
        return c;
    };
}

function checker(a, b, size, grout) {
    return (x, y) => {
        if (x % size === 0 || y % size === 0) return grout;
        const c = ((Math.floor(x / size) + Math.floor(y / size)) & 1) ? b : a;
        return jitter(c, x, y, 0.04, 9);
    };
}

function raisedFloor(x, y) {
    const size = 40;
    const lx = x % size, ly = y % size;
    if (lx === 0 || ly === 0) return 0x7d838b;
    if (lx === 1 || ly === 1) return 0xd9dde1;
    const perforated = (Math.floor(x / size) + Math.floor(y / size) * 3) % 4 === 0;
    if (perforated && lx > 5 && ly > 5 && lx < size - 4 && ly < size - 4 && lx % 4 === 2 && ly % 4 === 2) return 0x8d939a;
    return jitter(0xc2c7cc, x, y, 0.03, 4);
}

function terrazzo(x, y) {
    const size = 60;
    if (x % size === 0 || y % size === 0) return 0xb9b2a6;
    const n = hash(x, y, 21);
    if (n < 0.025) return [0x8a8073, 0x6f7a84, 0xa86c50, 0xe9e4da][Math.floor(hash(y, x, 22) * 4)];
    return jitter(0xd8d2c7, x >> 1, y >> 1, 0.05, 23);
}

const FLOORS = {
    hall: carpetTiles(0xb9b1a3, 0xb3ab9c, 40, 1),
    lounge: carpetTiles(0xb9b1a3, 0xb3ab9c, 40, 1),
    nook: carpetTiles(0xb9b1a3, 0xb3ab9c, 40, 1),
    office: speckleCarpet(0x7b879b, 2),
    standup: speckleCarpet(0x4e8582, 3),
    bullpen: carpetTiles(0x5b6676, 0x56606f, 40, 4),
    conference: planks([0xa8774f, 0xb27f55, 0x9d6d47, 0xa47350], 8, 72, 0x6e4a2f, 5),
    wellness: planks([0xc9a77e, 0xd1b087, 0xc19f76], 8, 64, 0x9b7b56, 6),
    break: checker(0xece7dd, 0xd9d1c3, 20, 0xc7bfb1),
    server: raisedFloor,
    lobby: terrazzo,
};

// ---------- walls, windows and faces ----------

const WALL_TOP = 0x4d525e;
const WALL_EDGE = 0x2b2e36;
const WALL_LIGHT = 0x666c79;
const FRAME = 0x8a95a2;
const FRAME_DARK = 0x5e6874;
const GLASS = 0xa9d3f2;

const FACES = {
    hall: { base: 0xdcd4c6, trim: 0xc4bba9, board: 0x6e655a },
    lounge: { base: 0xdcd4c6, trim: 0xc4bba9, board: 0x6e655a },
    nook: { base: 0xdcd4c6, trim: 0xc4bba9, board: 0x6e655a },
    office: { base: 0xe6e2d9, trim: 0xcfc9bd, board: 0x777065 },
    bullpen: { base: 0x3a7480, trim: 0x2f5f69, board: 0x1f3f46 },
    conference: { base: 0x8b5e3c, trim: 0x6f4a2f, board: 0x3f2a1b, slats: 0x7a5233 },
    break: { base: 0xf0ede6, trim: 0xd8d3c8, board: 0x8b8478, tile: 0xd2ccc0 },
    server: { base: 0x9ea5ad, trim: 0x858c95, board: 0x50565e },
    wellness: { base: 0xa9bda2, trim: 0x93a88c, board: 0x5d6b58 },
    lobby: { base: 0xcdc5b7, trim: 0xb3aa9a, board: 0x6b6458, seams: 0xb9b0a1 },
    standup: { base: 0xe8dfca, trim: 0xd2c8b1, board: 0x7a705f },
};

const at = (c, r) => (r >= 0 && r < ROWS && c >= 0 && c < COLS ? GRID[r][c] : "x");
const isWall = (ch) => ch === "#" || ch === "B";
const isOpen = (ch) => ch === "o" || ch === "x";
/** Tiles that show the front of the wall directly above them. */
const hasFace = (c, r) => isWall(at(c, r - 1)) && !isWall(at(c, r)) && !isOpen(at(c, r)) && at(c, r) !== "D";

function windowRun(c, r) {
    const horizontal = at(c - 1, r) === "B" || at(c + 1, r) === "B";
    const vertical = at(c, r - 1) === "B" || at(c, r + 1) === "B";
    return horizontal && !vertical ? "h" : vertical && !horizontal ? "v" : isWall(at(c - 1, r)) && isWall(at(c + 1, r)) ? "h" : "v";
}

/** Glass: a faint sky tint with diagonal reflections; mostly transparent so the skyline shows through. */
function glassPixel(canvas, x, y, strength = 1) {
    canvas.clear(x, y);
    const streak = (x + y * 0.6) % 90;
    const shine = streak < 7 ? 0.22 : streak < 11 ? 0.12 : streak > 52 && streak < 55 ? 0.14 : 0;
    canvas.blend(x, y, GLASS, 0.14 * strength);
    if (shine) canvas.blend(x, y, 0xffffff, shine * strength);
}

function paintWalls(canvas) {
    for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) {
        const ch = at(c, r);
        const x = c * T, y = r * T;
        if (ch === "#") {
            const exterior = [at(c - 1, r), at(c + 1, r), at(c, r - 1), at(c, r + 1)].some((n) => n === "B" || n === "o");
            canvas.rect(x, y, T, T, exterior ? 0x5f6672 : WALL_TOP);
            if (exterior) { canvas.rect(x + 3, y + 3, T - 6, T - 6, 0x6f7783); canvas.hline(x + 3, y + 3, T - 6, 0x8a929d); }
            else for (let j = 0; j < T; j++) for (let i = 0; i < T; i++) if (hash(x + i, y + j, 31) < 0.06) canvas.set(x + i, y + j, 0x535865);
            if (!isWall(at(c, r - 1))) { canvas.hline(x, y, T, WALL_EDGE); canvas.hline(x, y + 1, T, WALL_LIGHT); }
            if (!isWall(at(c, r + 1))) canvas.hline(x, y + T - 1, T, WALL_EDGE);
            if (!isWall(at(c - 1, r))) canvas.vline(x, y, T, WALL_EDGE);
            if (!isWall(at(c + 1, r))) canvas.vline(x + T - 1, y, T, WALL_EDGE);
        } else if (ch === "B") {
            if (windowRun(c, r) === "h") {
                for (let j = 0; j < T; j++) for (let i = 0; i < T; i++) glassPixel(canvas, x + i, y + j);
                canvas.rect(x, y, T, 3, FRAME); canvas.hline(x, y, T, FRAME_DARK); canvas.hline(x, y + 1, T, 0xb7c0ca);
            } else {
                for (let j = 0; j < T; j++) for (let i = 3; i < T - 3; i++) glassPixel(canvas, x + i, y + j, 1.3);
                canvas.rect(x, y, 3, T, FRAME); canvas.rect(x + T - 3, y, 3, T, FRAME);
                canvas.vline(x, y, T, FRAME_DARK); canvas.vline(x + T - 1, y, T, FRAME_DARK);
                if (r % 3 === 0) { canvas.rect(x, y, T, 2, FRAME); canvas.hline(x, y + 2, T, FRAME_DARK); }
            }
        }
    }
}

/** Vertical mullions every three tiles along each horizontal window run, carried down the glass face below. */
function paintMullions(canvas) {
    for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) {
        if (at(c, r) !== "B" || windowRun(c, r) !== "h" || c % 3 !== 0) continue;
        const x = c * T;
        canvas.rect(x - 1, r * T, 3, T * 2 - 4, FRAME);
        canvas.vline(x - 1, r * T, T * 2 - 4, 0xb7c0ca);
        canvas.vline(x + 1, r * T, T * 2 - 4, FRAME_DARK);
    }
}

function paintFaces(canvas) {
    for (let r = 1; r < ROWS; r++) for (let c = 0; c < COLS; c++) {
        if (!hasFace(c, r)) continue;
        const x = c * T, y = r * T;
        if (at(c, r - 1) === "B" && windowRun(c, r - 1) === "h") {
            for (let j = 0; j < T - 4; j++) for (let i = 0; i < T; i++) glassPixel(canvas, x + i, y + j);
            canvas.hline(x, y + 9, T, FRAME);
            canvas.hline(x, y + 10, T, FRAME_DARK);
            canvas.rect(x, y + T - 4, T, 2, 0xdfe3e8);
            canvas.rect(x, y + T - 2, T, 2, 0x99a2ac);
            continue;
        }
        const f = FACES[ZONES[r][c]] || FACES.office;
        for (let j = 0; j < T; j++) for (let i = 0; i < T; i++) {
            const px = x + i, py = y + j;
            let col = f.base;
            if (f.slats && px % 6 >= 4) col = f.slats;
            if (f.tile && (j % 5 === 4 || (px + (Math.floor(j / 5) & 1) * 5) % 10 === 0)) col = f.tile;
            if (f.seams && px % 40 === 0) col = f.seams;
            col = jitter(col, px >> 1, py, 0.03, 40);
            if (j < 2) col = f.trim;
            else if (j < 4) col = mixColor(col, f.trim, 0.45);
            if (j >= T - 4) col = j === T - 4 ? shadeColor(f.board, 0.25) : f.board;
            canvas.set(px, py, col);
        }
    }
}

/** Soft contact shadows where floors meet walls, so rooms read with depth. */
function paintOcclusion(canvas) {
    for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) {
        const ch = at(c, r);
        if (isWall(ch) || isOpen(ch)) continue;
        const x = c * T, y = r * T;
        if (hasFace(c, r - 1) || (isWall(at(c, r - 1)) && ch === "D")) for (let j = 0; j < 4; j++) canvas.shade(x, y + j, T, 1, 0.78 + j * 0.055);
        if (isWall(at(c - 1, r))) for (let i = 0; i < 4; i++) canvas.shade(x + i, y, 1, T, 0.8 + i * 0.05);
        if (isWall(at(c + 1, r))) for (let i = 0; i < 3; i++) canvas.shade(x + T - 1 - i, y, 1, T, 0.86 + i * 0.045);
    }
}

function paintDoors(canvas) {
    const jamb = (ch) => isWall(ch) || ch === "D";
    for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) {
        if (at(c, r) !== "D") continue;
        const x = c * T, y = r * T;
        if (jamb(at(c - 1, r)) || jamb(at(c + 1, r))) {
            canvas.rect(x, y + 8, T, 4, 0xa9a49a); canvas.hline(x, y + 8, T, 0xcfcac0); canvas.hline(x, y + 11, T, 0x77716a);
            if (isWall(at(c - 1, r))) { canvas.rect(x, y, 3, T, 0x8f8778); canvas.vline(x + 2, y, T, 0x6b6458); }
            if (isWall(at(c + 1, r))) { canvas.rect(x + T - 3, y, 3, T, 0x8f8778); canvas.vline(x + T - 3, y, T, 0xb3ab9b); }
        } else {
            canvas.rect(x + 8, y, 4, T, 0xa9a49a); canvas.vline(x + 8, y, T, 0xcfcac0); canvas.vline(x + 11, y, T, 0x77716a);
            if (isWall(at(c, r - 1))) canvas.rect(x, y, T, 3, 0x8f8778);
            if (isWall(at(c, r + 1))) canvas.rect(x, y + T - 3, T, 3, 0x8f8778);
        }
    }
    // Door casings on the wall faces that flank each opening.
    for (let r = 1; r < ROWS; r++) for (let c = 0; c < COLS; c++) {
        if (!hasFace(c, r)) continue;
        const x = c * T, y = r * T;
        if (at(c + 1, r - 1) === "D") { canvas.rect(x + T - 3, y, 3, T, 0x9a9283); canvas.vline(x + T - 3, y, T, 0x6f685c); }
        if (at(c - 1, r - 1) === "D") { canvas.rect(x, y, 3, T, 0x9a9283); canvas.vline(x + 2, y, T, 0x6f685c); }
    }
}

function paintFloors(canvas) {
    for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) {
        const ch = at(c, r);
        const x = c * T, y = r * T;
        if (ch === "o") continue;
        if (ch === "x") {
            canvas.fill(x, y, T, T, (px, py) => ((px + py) % 12 === 0 ? 0x1f232b : jitter(0x181b21, px >> 2, py >> 2, 0.1, 50)));
            continue;
        }
        if (isWall(ch)) continue;
        canvas.fill(x, y, T, T, FLOORS[ZONES[r][c]] || FLOORS.hall);
    }
}

/** Afternoon sun through the south glass: pale panes skewed across the floor below each window. */
function paintSunlight(canvas) {
    for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) {
        if (at(c, r) !== "B" || windowRun(c, r) !== "h") continue;
        const x0 = c * T, top = (r + 2) * T;
        for (let j = 0; j < 70; j++) {
            const y = top + j;
            const fade = 1 - j / 70;
            for (let i = 0; i < T; i++) {
                const x = x0 + i - Math.round(j * 0.45);
                const ch = at(Math.floor(x / T), Math.floor(y / T));
                if (isWall(ch) || isOpen(ch) || (x0 + i) % (T * 3) < 3) continue;
                canvas.blend(x, y, 0xfff1c9, 0.1 * fade);
            }
        }
    }
}

export function paintMap() {
    const canvas = createCanvas(COLS * T, ROWS * T);
    paintFloors(canvas);
    paintRugs(canvas);
    paintSunlight(canvas);
    paintOcclusion(canvas);
    paintWalls(canvas);
    paintFaces(canvas);
    paintMullions(canvas);
    paintDoors(canvas);
    paintProps(canvas);
    return canvas;
}

// ---------- props ----------

function paintRugs(canvas) {
    for (const rug of PROPS.filter((p) => p.type === "rug")) {
        const x = rug.x * T + 4, y = rug.y * T + 4, w = rug.w * T - 8, h = rug.h * T - 8;
        const palette = {
            rust: [0xa4553a, 0xc9814f, 0xe8c89a], blue: [0x3f5b82, 0x6d8bb3, 0xd9cfb8], sage: [0x7d9174, 0xa9b99a, 0xe9e1c9],
            logo: [0x2b3140, 0x3b4458, 0xf2c14e], lobby: [0x5a4a3c, 0x8a6f55, 0xd8c39b],
        }[rug.color] || [0x8a6f55, 0xb59772, 0xe8d8b6];
        canvas.fill(x, y, w, h, (px, py) => {
            const i = px - x, j = py - y;
            const edge = Math.min(i, j, w - 1 - i, h - 1 - j);
            if (edge < 2) return palette[0];
            if (edge < 4) return palette[2];
            if (edge < 6) return palette[0];
            if (rug.color === "logo") return (i + j) % 6 < 1 ? palette[1] : jitter(palette[0], px, py, 0.08, 61);
            const diamond = (Math.abs(((i - w / 2) % 16 + 16) % 16 - 8) + Math.abs(((j - h / 2) % 16 + 16) % 16 - 8));
            const c = diamond < 3 ? palette[2] : diamond < 5 ? palette[1] : palette[0];
            return jitter(c, px, py, 0.1, 60);
        });
        if (rug.color === "logo") paintLogo(canvas, x + w / 2, y + h / 2);
    }
}

/** The Byte Buddy mark: a little robot head, pixel by pixel. */
function paintLogo(canvas, cx, cy) {
    const x = Math.round(cx - 9), y = Math.round(cy - 7);
    canvas.box(x, y + 2, 18, 12, 0xf2c14e, 0xa87b1d, 2);
    canvas.rect(x + 4, y + 6, 3, 3, 0x2b3140); canvas.rect(x + 11, y + 6, 3, 3, 0x2b3140);
    canvas.rect(x + 6, y + 11, 6, 1, 0x2b3140);
    canvas.rect(x + 8, y - 1, 2, 3, 0xa87b1d); canvas.rect(x + 7, y - 2, 4, 2, 0xf2c14e);
}

const SURFACES = {
    walnut: { top: 0x8a5a3a, light: 0xa9774f, front: 0x6a4329, dark: 0x3b2414, grain: 0x7c5034 },
    oak: { top: 0xc39a65, light: 0xdcb985, front: 0x9a7447, dark: 0x5b4126, grain: 0xb48b58 },
    white: { top: 0xe6e3db, light: 0xf8f7f3, front: 0xb8b2a6, dark: 0x6c675d, grain: 0xdbd7ce },
    conference: { top: 0x5e3d26, light: 0x80583a, front: 0x43291a, dark: 0x1f120a, grain: 0x52341f, gloss: true },
    stone: { top: 0xcbc7bf, light: 0xe4e1db, front: 0x8b867c, dark: 0x55514a, grain: 0xbcb7ae, cabinet: true },
};
const FRONT = 6;

const CHAIRS = {
    office: { seat: 0x3b404b, back: 0x2b2f37, light: 0x5a616e, base: 0x1f2126, mesh: 0x353a44 },
    guest: { seat: 0x3f7a83, back: 0x2f5d65, light: 0x5d9aa3, base: 0x2a2c31, mesh: 0x36707a },
    conference: { seat: 0x2b2d33, back: 0x222429, light: 0x4b4f58, base: 0x9aa1aa, mesh: 0x26282e },
    stool: { seat: 0xb08657, back: 0x8a6440, light: 0xcfa676, base: 0x3d3f44, mesh: 0xa07a4e },
};

const COUCHES = {
    red: { base: 0xa8423c, light: 0xc45b52, dark: 0x7c2d29, line: 0x4c1a18, pillow: 0xe8c36a },
    sage: { base: 0x7f9a7a, light: 0x9db695, dark: 0x5f7a5b, line: 0x37492f, pillow: 0xf0e6cf },
};

const LEAVES = [0x2e6a33, 0x3d873d, 0x58a04a, 0x2a582d, 0x4b9442];
const BOOKS = [0xb5463c, 0x3f6aa1, 0xd9a441, 0x4c8a5a, 0x7a4f8f, 0xe0dccf, 0x2f3540, 0xc96f3a, 0x5aa0a8];

function surfaceMasks() {
    const masks = new Map();
    for (const prop of PROPS) {
        if (prop.type !== "surface") continue;
        if (!masks.has(prop.material)) masks.set(prop.material, new Set());
        for (let r = prop.y; r < prop.y + prop.h; r++) for (let c = prop.x; c < prop.x + prop.w; c++) masks.get(prop.material).add(`${c},${r}`);
    }
    return masks;
}

function paintSurfaces(canvas, masks) {
    for (const [material, mask] of masks) {
        const m = SURFACES[material];
        const has = (c, r) => mask.has(`${c},${r}`);
        for (const key of mask) {
            const [c, r] = key.split(",").map(Number);
            const x = c * T, y = r * T;
            const top = !has(c, r - 1), bottom = !has(c, r + 1), left = !has(c - 1, r), right = !has(c + 1, r);
            const topH = bottom ? T - FRONT : T;
            for (let j = 0; j < topH; j++) for (let i = 0; i < T; i++) {
                const px = x + i, py = y + j;
                let col = hash(Math.floor(px / 9), py, 70) < 0.22 ? m.grain : m.top;
                if (material === "stone" && hash(px, py, 71) < 0.08) col = shadeColor(m.top, -0.12);
                if (m.gloss && (px + py * 2) % 46 < 3) col = shadeColor(col, 0.12);
                canvas.set(px, py, col);
            }
            if (top) { canvas.hline(x, y, T, m.dark); canvas.hline(x, y + 1, T, m.light); }
            if (bottom) {
                canvas.hline(x, y + topH - 1, T, m.light);
                if (m.cabinet) {
                    canvas.rect(x, y + topH, T, FRONT, m.front);
                    canvas.hline(x, y + T - 1, T, m.dark);
                    if (c % 2 === 0) canvas.vline(x, y + topH, FRONT - 1, m.dark);
                    canvas.rect(x + (c % 2 ? 3 : T - 5), y + topH + 2, 2, 1, 0xe7e7e7);
                } else {
                    canvas.rect(x, y + topH, T, 3, m.front);
                    canvas.hline(x, y + topH + 2, T, m.dark);
                    canvas.shade(x, y + topH + 3, T, FRONT - 3, 0.72);
                    if (left) canvas.rect(x + 1, y + topH + 3, 2, FRONT - 3, m.dark);
                    if (right) canvas.rect(x + T - 3, y + topH + 3, 2, FRONT - 3, m.dark);
                }
            }
            if (left) canvas.vline(x, y, topH + (bottom ? 3 : 0), m.dark);
            if (right) canvas.vline(x + T - 1, y, topH + (bottom ? 3 : 0), m.dark);
        }
    }
}

// Screens: a few believable things people leave open.
function screen(canvas, x, y, w, h, seed) {
    const kind = Math.floor(hash(seed, 7, 80) * 4);
    const bg = [0x1d2430, 0xf3f5f8, 0x14202a, 0xe9edf2][kind];
    canvas.rect(x, y, w, h, bg);
    for (let row = 1; row < h - 1; row += 2) {
        if (kind === 0) { const len = 2 + Math.floor(hash(seed, row, 81) * (w - 4)); canvas.hline(x + 1 + (row % 4 ? 2 : 0), y + row, Math.min(len, w - 3), [0x7fd1ff, 0xf2c14e, 0xa6e3a1, 0xf38ba8][Math.floor(hash(row, seed, 82) * 4)]); }
        if (kind === 2) { const bar = 1 + Math.floor(hash(seed, row, 83) * (h - 2)); canvas.vline(x + 1 + row, y + h - 1 - bar, bar, 0x47c97a); }
    }
    if (kind === 1) { canvas.hline(x, y, w, 0x3f6aa1); canvas.rect(x + 1, y + 2, w - 2, 1, 0xc9d3df); canvas.rect(x + 1, y + 4, Math.floor(w / 2), 1, 0xc9d3df); }
    if (kind === 3) for (let col = 0; col < 3; col++) for (let card = 0; card < 2; card++) canvas.rect(x + 1 + col * Math.floor(w / 3), y + 2 + card * 3, Math.floor(w / 3) - 1, 2, [0xf2c14e, 0x7fb6e8, 0xa6e3a1][(col + card) % 3]);
}

function monitorFront(canvas, cx, baseY, w = 16, seed = 0) {
    const x = Math.round(cx - w / 2), top = baseY - 12;
    canvas.rect(cx - 1, baseY - 2, 3, 3, 0x2a2d33);
    canvas.rect(cx - 4, baseY + 1, 9, 1, 0x2a2d33);
    canvas.box(x, top, w, 11, 0x1b1d22, 0x101114, 0);
    screen(canvas, x + 1, top + 1, w - 2, 8, seed);
    canvas.hline(x + 1, top + 1, w - 2, 0x3c4048);
}

function monitorBack(canvas, cx, baseY, w = 16) {
    const x = Math.round(cx - w / 2), top = baseY - 10;
    canvas.rect(cx - 4, baseY - 1, 9, 2, 0x2a2d33);
    canvas.box(x, top, w, 10, 0x3a3e46, 0x1c1e22, 0);
    canvas.hline(x + 1, top + 1, w - 2, 0x50555f);
    canvas.rect(cx - 3, top + 3, 6, 4, 0x30333a);
}

function keyboard(canvas, cx, y, vertical = false) {
    if (vertical) { canvas.box(cx - 2, y - 6, 4, 13, 0xd5d7da, 0x8b8f96, 0); return; }
    canvas.box(cx - 7, y, 14, 4, 0xd5d7da, 0x8b8f96, 0);
    canvas.hline(cx - 6, y + 1, 12, 0xb7bbc1);
    canvas.box(cx + 9, y, 3, 4, 0xe4e6e9, 0x8b8f96, 0);
}

function deskClutter(canvas, cx, y, seed) {
    const n = hash(seed, 3, 90);
    const side = hash(seed, 4, 90) < 0.5 ? -1 : 1;
    const x = cx + side * 13;
    if (n < 0.3) { canvas.disc(x, y + 2, 2.5, 0xf1efe9); canvas.disc(x, y + 2, 1.5, 0x5a3a24); }
    else if (n < 0.55) { canvas.rect(x - 3, y - 1, 7, 5, 0xf7f5ef); canvas.hline(x - 2, y + 1, 5, 0xc7c2b8); }
    else if (n < 0.75) { canvas.rect(x - 2, y + 1, 4, 3, 0xb5653f); canvas.disc(x, y, 3, 0x4b9442); canvas.set(x - 1, y - 1, 0x6fbf5f); }
    else { canvas.rect(x - 1, y - 6, 2, 8, 0x3a3e46); canvas.rect(x - 3, y - 7, 6, 2, 0xf2c14e); }
}

const DIRS = { n: [0, -1], s: [0, 1], e: [1, 0], w: [-1, 0] };

function paintWorkstation(canvas, chair, masks) {
    const material = [...masks.entries()].find(([name, mask]) => name !== "stone" && mask.has(`${Math.floor(chair.x) + DIRS[chair.facing][0]},${Math.floor(chair.y) + DIRS[chair.facing][1]}`));
    if (!material) return;
    const [name, mask] = material;
    const c = Math.floor(chair.x), r = Math.floor(chair.y);
    const cx = Math.round(chair.x * T);
    const seed = c * 131 + r;
    const dual = name === "white";
    if (chair.facing === "n") {
        const deep = mask.has(`${c},${r - 2}`) ? 2 : 1;
        const top = (r - deep) * T;
        const base = top + 9;
        if (dual) { monitorFront(canvas, cx - 8, base, 15, seed); monitorFront(canvas, cx + 8, base, 15, seed + 1); }
        else monitorFront(canvas, cx, base, 18, seed);
        keyboard(canvas, cx, r * T - FRONT - 6);
        deskClutter(canvas, cx, r * T - FRONT - 7, seed);
    } else if (chair.facing === "s") {
        const deep = mask.has(`${c},${r + 2}`) ? 2 : 1;
        const bottom = (r + 1 + deep) * T - FRONT - 2;
        keyboard(canvas, cx, (r + 1) * T + 2);
        monitorBack(canvas, cx, bottom, 18);
        deskClutter(canvas, cx, (r + 1) * T + 3, seed);
    } else {
        const dir = chair.facing === "e" ? 1 : -1;
        const x = (c + dir) * T + (dir > 0 ? 13 : 5);
        const cy = Math.round(chair.y * T);
        canvas.rect(x - 1, cy - 9, 3, 16, 0x1b1d22);
        canvas.vline(x + (dir > 0 ? -1 : 1), cy - 8, 14, 0x4fa3d9);
        keyboard(canvas, (c + dir) * T + (dir > 0 ? 6 : 13), cy, true);
    }
}

function paintChair(canvas, chair) {
    const p = CHAIRS[chair.style] || CHAIRS.office;
    const cx = Math.round(chair.x * T), cy = Math.round(chair.y * T);
    canvas.ellipse(cx + 1, cy + 6, 7, 3, 0x000000, 0.18);
    if (chair.style === "stool") {
        canvas.vline(cx - 3, cy, 6, p.base); canvas.vline(cx + 3, cy, 6, p.base);
        canvas.disc(cx, cy - 1, 5.5, p.back);
        canvas.disc(cx, cy - 2, 5, p.seat);
        canvas.hline(cx - 2, cy - 5, 4, p.light);
        return;
    }
    const base = () => {
        canvas.hline(cx - 6, cy + 6, 13, p.base); canvas.vline(cx, cy + 3, 4, p.base);
        for (const dx of [-6, 6]) canvas.set(cx + dx, cy + 7, 0x111214);
        canvas.set(cx, cy + 8, 0x111214);
    };
    if (chair.facing === "n") {
        base();
        canvas.rect(cx - 8, cy - 4, 2, 6, p.base); canvas.rect(cx + 7, cy - 4, 2, 6, p.base);
        canvas.box(cx - 7, cy - 6, 15, 7, p.seat, p.back, 1);
        canvas.box(cx - 6, cy - 9, 13, 13, p.back, 0x16171a, 1);
        for (let j = 0; j < 9; j++) for (let i = 0; i < 9; i++) if ((i + j) % 2) canvas.set(cx - 4 + i, cy - 7 + j, p.mesh);
        canvas.hline(cx - 5, cy - 8, 11, p.light);
    } else if (chair.facing === "s") {
        canvas.box(cx - 6, cy - 11, 13, 10, p.back, 0x16171a, 1);
        canvas.hline(cx - 5, cy - 10, 11, p.light);
        for (let j = 0; j < 6; j++) for (let i = 0; i < 9; i++) if ((i + j) % 2) canvas.set(cx - 4 + i, cy - 8 + j, p.mesh);
        base();
        canvas.box(cx - 7, cy - 3, 15, 9, p.seat, 0x16171a, 1);
        canvas.hline(cx - 5, cy - 2, 11, p.light);
        canvas.rect(cx - 9, cy - 4, 2, 7, p.back); canvas.rect(cx + 8, cy - 4, 2, 7, p.back);
    } else {
        const dir = chair.facing === "e" ? 1 : -1;
        base();
        canvas.box(cx - 6, cy - 3, 13, 8, p.seat, 0x16171a, 1);
        canvas.hline(cx - 4, cy - 2, 9, p.light);
        canvas.box(cx - dir * 7 - 2, cy - 11, 5, 15, p.back, 0x16171a, 1);
        canvas.vline(cx - dir * 7, cy - 10, 12, p.light);
        canvas.rect(cx - 4, cy - 5, 9, 2, p.back);
    }
}

function paintCouch(canvas, prop) {
    const p = COUCHES[prop.color] || COUCHES.red;
    const x = prop.x * T + 1, y = prop.y * T + 1, w = prop.w * T - 2, h = prop.h * T - 2;
    canvas.rectA(x + 3, y + 4, w, h, 0x000000, 0.16);
    canvas.box(x, y, w, h, p.base, p.line, 2);
    const cushions = (cx0, cy0, cw, ch, horizontal) => {
        const count = Math.max(1, Math.round((horizontal ? cw : ch) / 26));
        for (let k = 0; k < count; k++) {
            const a = Math.round(((horizontal ? cw : ch) * k) / count), b = Math.round(((horizontal ? cw : ch) * (k + 1)) / count);
            const bx = horizontal ? cx0 + a : cx0, by = horizontal ? cy0 : cy0 + a;
            const bw = horizontal ? b - a : cw, bh = horizontal ? ch : b - a;
            canvas.box(bx, by, bw, bh, p.light, p.dark, 2);
            canvas.hline(bx + 2, by + 1, bw - 4, shadeColor(p.light, 0.18));
        }
    };
    const arm = 6, back = 8;
    if (prop.facing === "s" || prop.facing === "n") {
        const backY = prop.facing === "s" ? y : y + h - back - 1;
        canvas.box(x, backY, w, back + 1, p.dark, p.line, 2);
        canvas.hline(x + 2, backY + 1, w - 4, p.base);
        const seatY = prop.facing === "s" ? y + back : y + 2;
        cushions(x + arm, seatY, w - arm * 2, h - back - 6, true);
        canvas.box(x, y, arm, h, p.base, p.line, 2); canvas.box(x + w - arm, y, arm, h, p.base, p.line, 2);
        canvas.vline(x + 2, y + 2, h - 4, p.light); canvas.vline(x + w - arm + 2, y + 2, h - 4, p.light);
        if (prop.facing === "s") {
            canvas.rect(x + arm, y + h - 5, w - arm * 2, 4, p.dark); canvas.hline(x + 1, y + h - 1, w - 2, p.line);
            canvas.box(x + arm + 2, y + back - 4, 8, 7, p.pillow, shadeColor(p.pillow, -0.35), 1);
            canvas.box(x + w - arm - 10, y + back - 4, 8, 7, 0xf0e6cf, 0xb7ab92, 1);
        }
    } else {
        const dir = prop.facing === "e" ? 1 : -1;
        const backX = dir > 0 ? x : x + w - back - 1;
        canvas.box(backX, y, back + 1, h, p.dark, p.line, 2);
        canvas.vline(backX + (dir > 0 ? 2 : back - 2), y + 2, h - 4, p.base);
        const seatX = dir > 0 ? x + back : x + 5;
        cushions(seatX, y + arm, w - back - 5, h - arm * 2, false);
        canvas.box(x, y, w, arm, p.base, p.line, 2); canvas.box(x, y + h - arm, w, arm, p.base, p.line, 2);
        canvas.hline(x + 2, y + 2, w - 4, p.light);
        canvas.rect(x + 1, y + h - 2, w - 2, 1, p.line);
        canvas.box(dir > 0 ? x + back - 3 : x + w - back - 4, y + arm + 3, 7, 8, p.pillow, shadeColor(p.pillow, -0.35), 1);
    }
}

function paintRoundTable(canvas, prop) {
    const cx = prop.x * T, cy = prop.y * T, rad = prop.r * T - 3;
    const top = prop.style === "bistro" ? 0xeeeae3 : SURFACES.walnut.top;
    const edge = prop.style === "bistro" ? 0xb9b2a6 : SURFACES.walnut.front;
    const line = prop.style === "bistro" ? 0x7e776c : SURFACES.walnut.dark;
    canvas.ellipse(cx + 3, cy + 5, rad, rad * 0.8, 0x000000, 0.18);
    canvas.disc(cx, cy + 3, rad + 1, line);
    canvas.disc(cx, cy + 2, rad, edge);
    canvas.disc(cx, cy - 1, rad + 1, line);
    canvas.disc(cx, cy - 1, rad, top);
    for (let a = 0; a < 18; a++) {
        const t = Math.PI * (1.05 + a * 0.03);
        canvas.set(cx + Math.cos(t) * (rad - 2), cy - 1 + Math.sin(t) * (rad - 2), shadeColor(top, 0.25));
    }
    if (prop.style === "bistro") { canvas.disc(cx + 2, cy - 2, 2.5, 0xffffff); canvas.disc(cx + 2, cy - 2, 1.5, 0x6b4428); return; }
    if (rad > 25) {
        canvas.rect(cx - 14, cy - 10, 10, 7, 0xf7f5ef); canvas.hline(cx - 13, cy - 8, 7, 0xc7c2b8);
        canvas.box(cx + 2, cy - 4, 14, 9, 0x9aa1aa, 0x5d636b, 0); canvas.rect(cx + 3, cy - 3, 12, 6, 0x3b4252);
        canvas.disc(cx - 6, cy + 8, 2.5, 0xffffff); canvas.disc(cx - 6, cy + 8, 1.5, 0x5a3a24);
        canvas.disc(cx + 10, cy - 14, 2.5, 0xe9e6df);
    } else {
        canvas.rect(cx - 6, cy - 5, 9, 6, 0xf7f5ef); canvas.disc(cx + 6, cy + 3, 2.5, 0xffffff); canvas.disc(cx + 6, cy + 3, 1.5, 0x5a3a24);
    }
}

function paintLowTable(canvas, prop, small = false) {
    const inset = small ? 3 : 2;
    const x = prop.x * T + inset, y = prop.y * T + inset + (small ? 2 : 0), w = prop.w * T - inset * 2, h = prop.h * T - inset * 2 - (small ? 2 : 0);
    const m = small ? SURFACES.walnut : SURFACES.oak;
    canvas.rectA(x + 3, y + 4, w, h, 0x000000, 0.16);
    canvas.box(x, y, w, h - 3, m.top, m.dark, 1);
    canvas.hline(x + 1, y + 1, w - 2, m.light);
    canvas.rect(x + 1, y + h - 4, w - 2, 3, m.front);
    canvas.hline(x, y + h - 1, w, m.dark);
    if (small) {
        canvas.disc(x + w / 2, y + h / 2 - 3, 4, 0xf6e3a6); canvas.disc(x + w / 2, y + h / 2 - 3, 2.5, 0xfff7d6);
        canvas.ellipse(x + w / 2, y + h / 2 - 3, 12, 10, 0xfff1c0, 0.15);
        return;
    }
    canvas.rect(x + 5, y + 5, 12, 9, 0xd9534f); canvas.rect(x + 7, y + 7, 12, 9, 0x3f6aa1); canvas.hline(x + 8, y + 9, 8, 0xe9e4d8);
    canvas.rect(x + w - 16, y + 8, 6, 5, 0xb5653f); canvas.disc(x + w - 13, y + 6, 4, 0x4b9442); canvas.set(x + w - 14, y + 4, 0x6fbf5f);
    canvas.disc(x + w / 2 + 4, y + h - 10, 2.5, 0xffffff); canvas.disc(x + w / 2 + 4, y + h - 10, 1.5, 0x5a3a24);
}

function paintPlant(canvas, prop) {
    const x = prop.x * T, y = prop.y * T;
    const cx = x + 10, seed = prop.x * 97 + prop.y * 13;
    const random = seeded(seed);
    const white = hash(seed, 1, 95) < 0.45;
    canvas.ellipse(cx + 2, y + 18, 8, 3, 0x000000, 0.2);
    canvas.box(cx - 6, y + 10, 12, 9, white ? 0xe8e5de : 0xb5653f, white ? 0x9c988f : 0x7a3f26, 1);
    canvas.hline(cx - 5, y + 11, 10, white ? 0xffffff : 0xd27e55);
    canvas.hline(cx - 5, y + 12, 10, 0x4a3526);
    canvas.vline(cx + 3, y + 13, 5, white ? 0xcfcbc3 : 0x95512f);
    if (prop.kind === "snake") {
        for (let k = 0; k < 7; k++) {
            const lx = cx - 5 + Math.round(k * 1.6 + random() * 1.5), height = 12 + Math.floor(random() * 14);
            for (let j = 0; j < height; j++) {
                const wide = j < height - 3 ? 2 : 1;
                canvas.rect(lx, y + 12 - j, wide, 1, j % 5 === 2 ? 0x3d7d45 : 0x2c6438);
                if (j < height - 3) canvas.set(lx + wide, y + 12 - j, 0xc4bd57);
            }
        }
    } else if (prop.kind === "palm") {
        canvas.vline(cx, y + 2, 10, 0x6b5233);
        for (let k = 0; k < 8; k++) {
            const angle = -Math.PI / 2 + (k - 3.5) * 0.36 + (random() - 0.5) * 0.15;
            const len = 13 + random() * 6;
            for (let s = 2; s < len; s++) {
                const droop = (s / len) ** 2 * 7;
                const px = cx + Math.cos(angle) * s, py = y + 2 + Math.sin(angle) * s + droop;
                canvas.set(px, py, 0x3a7d3a);
                if (s % 2 === 0) { canvas.set(px - 1, py + 1, 0x58a04a); canvas.set(px + 1, py + 1, 0x2e6a33); }
            }
        }
    } else {
        canvas.vline(cx, y - 2, 13, 0x6b5233);
        for (let k = 0; k < 13; k++) {
            const lx = cx + (random() - 0.5) * 15, ly = y - 9 + random() * 18;
            const col = LEAVES[Math.floor(random() * LEAVES.length)];
            canvas.ellipse(lx, ly, 3.6, 2.8, shadeColor(col, -0.25));
            canvas.ellipse(lx - 0.5, ly - 0.5, 3, 2.3, col);
            canvas.set(lx - 1, ly - 1, shadeColor(col, 0.3));
        }
    }
}

function paintBooks(canvas, x, y, w, h, seed) {
    const random = seeded(seed);
    for (let i = 0; i < w;) {
        if (random() < 0.12) { i += 4; continue; }
        const bw = 2 + Math.floor(random() * 2), bh = h - Math.floor(random() * 3);
        canvas.rect(x + i, y + h - bh, Math.min(bw, w - i), bh, BOOKS[Math.floor(random() * BOOKS.length)]);
        canvas.set(x + i, y + h - bh, 0xffffff);
        i += bw;
    }
}

function paintCabinet(canvas, prop) {
    const x = prop.x * T, y = prop.y * T, w = prop.w * T, h = prop.h * T;
    const seed = prop.x * 31 + prop.y * 7;
    if (prop.type === "bench") {
        canvas.rectA(x + 4, y + 6, w - 4, h - 6, 0x000000, 0.18);
        canvas.box(x + 2, y + 3, w - 4, h - 8, 0x50617a, 0x2c3646, 2);
        for (let i = x + 10; i < x + w - 6; i += 12) canvas.set(i, y + 8, 0x3c4a5e);
        canvas.hline(x + 4, y + 4, w - 8, 0x6c7d96);
        canvas.rect(x + 4, y + h - 5, w - 8, 2, 0x2c3646);
        canvas.rect(x + 5, y + h - 3, 2, 3, 0x9aa1aa); canvas.rect(x + w - 7, y + h - 3, 2, 3, 0x9aa1aa);
        return;
    }
    if (prop.type === "spine") {
        for (let r = prop.y; r < prop.y + prop.h; r++) for (let c = prop.x; c < prop.x + prop.w; c++) {
            if (at(c, r) !== "K") continue;
            const tx = c * T, ty = r * T;
            const edgeL = c === prop.x, edgeR = c === prop.x + prop.w - 1;
            const openTop = at(c, r - 1) !== "K", openBottom = at(c, r + 1) !== "K";
            canvas.fill(tx, ty, T, T, (px, py) => {
                const leaf = hash(px >> 1, py >> 1, 99);
                return leaf < 0.18 ? 0x2a582d : leaf < 0.5 ? 0x3d873d : leaf < 0.8 ? 0x4b9442 : leaf < 0.93 ? 0x63aa52 : 0x3a2a1e;
            });
            if (edgeL) { canvas.rect(tx, ty, 3, T, SURFACES.oak.top); canvas.vline(tx, ty, T, SURFACES.oak.dark); }
            if (edgeR) { canvas.rect(tx + T - 3, ty, 3, T, SURFACES.oak.top); canvas.vline(tx + T - 1, ty, T, SURFACES.oak.dark); }
            if (openTop) { canvas.rect(tx, ty, T, 3, SURFACES.oak.top); canvas.hline(tx, ty, T, SURFACES.oak.dark); }
            if (openBottom) { canvas.rect(tx, ty + T - FRONT, T, FRONT, SURFACES.oak.front); canvas.hline(tx, ty + T - FRONT, T, SURFACES.oak.light); canvas.hline(tx, ty + T - 1, T, SURFACES.oak.dark); }
        }
        return;
    }
    const wood = prop.type === "filing" ? { top: 0xa3a9b1, light: 0xc3c8ce, front: 0x7f858d, dark: 0x4d5258 } : prop.type === "media" ? SURFACES.walnut : SURFACES.oak;
    if (prop.facing === "s" && (prop.type === "bookshelf" || prop.type === "credenza" || prop.type === "filing")) {
        const rise = prop.type === "bookshelf" ? 22 : prop.type === "credenza" ? 6 : 10;
        const top = y - rise + 2;
        canvas.rectA(x + 3, y + h - 3, w - 2, 4, 0x000000, 0.2);
        canvas.box(x + 1, top, w - 2, 6, wood.top, wood.dark, 0);
        canvas.hline(x + 2, top + 1, w - 4, wood.light);
        canvas.box(x + 1, top + 5, w - 2, h + rise - 7, wood.front, wood.dark, 0);
        if (prop.type === "bookshelf") {
            canvas.rect(x + 3, top + 6, w - 6, h + rise - 10, 0x4a2f1c);
            for (let shelf = 0; shelf < 3; shelf++) {
                const sy = top + 7 + shelf * 11;
                paintBooks(canvas, x + 3, sy, w - 6, 9, seed + shelf);
                canvas.hline(x + 3, sy + 9, w - 6, wood.top); canvas.hline(x + 3, sy + 10, w - 6, wood.dark);
            }
        } else if (prop.type === "credenza") {
            for (let i = x + 1; i < x + w - 2; i += 20) { canvas.vline(i, top + 6, h + rise - 9, wood.dark); canvas.rect(i + 9, top + 12, 3, 1, 0xd9d4c7); }
            canvas.rect(x + 8, top - 6, 7, 8, 0x2f3540); canvas.rect(x + 9, top - 5, 5, 6, 0x7fb6e8);
            paintBooks(canvas, x + w - 22, top - 7, 12, 8, seed);
        } else {
            for (let d = 0; d < 3; d++) { canvas.hline(x + 2, top + 9 + d * 7, w - 4, wood.dark); canvas.rect(x + w / 2 - 3, top + 11 + d * 7, 6, 1, 0xe3e6ea); }
        }
        return;
    }
    // Seen from above: a top surface with a short front lip.
    canvas.rectA(x + 3, y + 4, w - 2, h - 2, 0x000000, 0.18);
    canvas.box(x + 1, y + 1, w - 2, h - FRONT, wood.top, wood.dark, 0);
    canvas.hline(x + 2, y + 2, w - 4, wood.light);
    canvas.rect(x + 1, y + h - FRONT, w - 2, FRONT - 1, wood.front);
    canvas.hline(x + 1, y + h - 2, w - 2, wood.dark);
    if (prop.type === "bookshelf") {
        const open = prop.facing === "e" ? x + w - 7 : x + 3;
        for (let j = y + 4; j < y + h - FRONT - 2; j += 3) canvas.rect(open, j, 4, 2, BOOKS[Math.floor(hash(j, prop.x, 98) * BOOKS.length)]);
    } else if (prop.type === "media") {
        const screenX = prop.facing === "w" ? x + w - 7 : x + 3;
        canvas.rect(screenX, y + 6, 4, h - 14, 0x15171b);
        canvas.vline(prop.facing === "w" ? screenX - 1 : screenX + 4, y + 7, h - 16, 0x5fb2e8);
        canvas.rect(x + 5, y + h - 26, 7, 6, 0x4b9442);
    } else if (prop.type === "filing") {
        canvas.hline(x + 3, y + 8, w - 6, wood.dark);
    }
}

function paintMachine(canvas, prop) {
    const x = prop.x * T, y = prop.y * T, w = prop.w * T, h = prop.h * T;
    const random = seeded(prop.x * 17 + prop.y);
    if (prop.type === "rack") {
        const rise = 22;
        canvas.rectA(x + 3, y + h - 2, w, 5, 0x000000, 0.25);
        canvas.box(x, y - rise, w, 14, 0x3a3f48, 0x101216, 0);
        canvas.hline(x + 1, y - rise + 1, w - 2, 0x535a65);
        for (let u = 0; u < prop.w; u++) {
            const ux = x + u * T;
            canvas.box(ux, y - rise + 13, T, h + rise - 13, 0x1c1f25, 0x0c0d10, 0);
            for (let j = y - rise + 16; j < y + h - 3; j++) for (let i = ux + 3; i < ux + T - 3; i++) if ((i + j) % 3 === 0) canvas.set(i, j, 0x2b2f37);
            for (let j = y - rise + 17; j < y + h - 5; j += 4) {
                if (random() < 0.75) canvas.set(ux + 4, j, [0x47e07a, 0x47e07a, 0x4fb3ff, 0xffb347][Math.floor(random() * 4)]);
                if (random() < 0.4) canvas.set(ux + 6, j, 0x47e07a);
            }
            canvas.rect(ux + 8, y - rise + 15, 8, 2, 0xd9dde2);
        }
        return;
    }
    if (prop.type === "crac") {
        canvas.rectA(x + 3, y + h - 2, w, 4, 0x000000, 0.2);
        canvas.box(x + 1, y - 10, w - 2, 8, 0xdfe2e6, 0x6c727a, 0);
        canvas.box(x + 1, y - 3, w - 2, h + 2, 0xc8cdd2, 0x6c727a, 0);
        for (let j = y; j < y + h - 3; j += 2) canvas.hline(x + 4, j, w - 8, 0x9aa1a9);
        canvas.rect(x + w - 10, y - 8, 6, 3, 0x3b4252); canvas.set(x + w - 8, y - 7, 0x47e07a);
        return;
    }
    if (prop.type === "waterCooler") {
        canvas.ellipse(x + 11, y + 18, 7, 3, 0x000000, 0.2);
        canvas.box(x + 4, y + 2, 13, 16, 0xeceef0, 0x8b9096, 1);
        canvas.rect(x + 7, y + 8, 7, 3, 0x9aa1aa); canvas.set(x + 8, y + 9, 0x4fb3ff); canvas.set(x + 12, y + 9, 0xd9534f);
        canvas.box(x + 5, y - 10, 11, 13, 0x8fcdf2, 0x4f8fb8, 2);
        canvas.vline(x + 7, y - 8, 9, 0xd3edfb);
        return;
    }
    if (prop.type === "fridge") {
        const rise = 26;
        canvas.rectA(x + 3, y + 4, w, h, 0x000000, 0.2);
        canvas.box(x + 1, y - rise, w - 2, h + rise - 1, 0xb9c0c7, 0x5b636c, 0);
        canvas.rect(x + 2, y - rise + 1, w - 4, h - 4, 0xd9dee3);
        canvas.hline(x + 2, y - rise + 1, w - 4, 0xf1f3f5);
        for (let i = x + 3; i < x + w - 3; i += 3) canvas.vline(i, y + h - rise - 1, rise - 2, 0xaab1b9);
        canvas.hline(x + 1, y + h - rise + 10, w - 2, 0x5b636c);
        const handle = prop.facing === "w" ? x + 3 : x + w - 5;
        canvas.rect(handle, y + h - rise + 2, 2, 7, 0x6c737c); canvas.rect(handle, y + h - rise + 12, 2, 10, 0x6c737c);
        canvas.rect(x + 6, y - rise + 8, 3, 3, 0xd9534f); canvas.rect(x + 11, y - rise + 14, 3, 3, 0xf2c14e);
        return;
    }
    if (prop.type === "minifridge") {
        canvas.rectA(x + 3, y + 4, w - 2, h - 2, 0x000000, 0.2);
        canvas.box(x + 2, y - 2, w - 4, h - 2, 0xeef0f2, 0x7d838b, 1);
        canvas.hline(x + 3, y - 1, w - 6, 0xffffff);
        canvas.rect(x + w - 6, y + 6, 1, 7, 0x7d838b);
        return;
    }
    if (prop.type === "printer") {
        canvas.rectA(x + 4, y + 6, w - 4, h - 6, 0x000000, 0.2);
        canvas.box(x + 3, y + 1, w - 6, h - 10, 0xe3e5e8, 0x7b8088, 1);
        canvas.hline(x + 4, y + 2, w - 8, 0xf6f7f8);
        canvas.rect(x + 8, y + 8, w - 16, 8, 0xf7f7f2); canvas.hline(x + 8, y + 8, w - 16, 0xcfd2d6);
        canvas.rect(x + w - 14, y + 4, 8, 3, 0x2f6fa8);
        canvas.box(x + 3, y + h - 10, w - 6, 8, 0xc9ccd1, 0x7b8088, 0);
        canvas.hline(x + 6, y + h - 6, w - 12, 0x9aa0a8);
    }
}

function paintDecor(canvas, prop) {
    const x = prop.x * T, y = prop.y * T, w = prop.w * T, h = prop.h * T;
    const random = seeded(prop.x * 53 + prop.y * 11);
    switch (prop.type) {
        case "sink": {
            canvas.box(x + 2, y + 4, T - 4, 14, 0xb7bec6, 0x6c737c, 1);
            canvas.rect(x + 4, y + 7, T - 8, 9, 0x8d959e); canvas.hline(x + 4, y + 7, T - 8, 0x6c737c);
            canvas.rect(x + 9, y + 1, 2, 6, 0xd7dce1); canvas.rect(x + 8, y + 1, 4, 2, 0xa9b0b8);
            break;
        }
        case "coffee": {
            canvas.rectA(x + 4, y + 10, 14, 10, 0x000000, 0.2);
            canvas.box(x + 2, y - 4, 16, 18, 0x2a2c31, 0x111214, 1);
            canvas.hline(x + 3, y - 3, 14, 0x4a4e57);
            canvas.rect(x + 5, y + 6, 10, 2, 0x9aa1aa); canvas.set(x + 14, y, 0xd9534f); canvas.set(x + 12, y, 0x47e07a);
            canvas.disc(x + 10, y + 16, 2.5, 0xffffff); canvas.disc(x + 10, y + 16, 1.5, 0x5a3a24);
            canvas.disc(x + 4, y + 22, 2.5, 0xe9e6df);
            break;
        }
        case "microwave": {
            canvas.rectA(x + 3, y + 10, 18, 10, 0x000000, 0.2);
            canvas.box(x, y - 2, 20, 16, 0xd5d8dc, 0x6c737c, 1);
            canvas.rect(x + 2, y + 5, 12, 7, 0x2a2e35); canvas.hline(x + 3, y + 6, 10, 0x464c57);
            canvas.rect(x + 15, y + 6, 3, 5, 0x9aa1aa);
            break;
        }
        case "fruit": {
            canvas.ellipse(x + 10, y + 12, 9, 6, 0xe8e3d8); canvas.ellipse(x + 10, y + 11, 8, 5, 0xc9c1b2);
            for (const [dx, dy, col] of [[-4, -1, 0xf29a38], [1, -2, 0xd9443a], [4, 0, 0xf29a38], [-1, 1, 0x7cbf4a], [5, -3, 0xf2d64e]]) canvas.disc(x + 10 + dx, y + 10 + dy, 2.5, col);
            break;
        }
        case "cableTray": {
            canvas.rect(x + 2, y + 13, w - 4, 4, 0x3b3f46);
            canvas.hline(x + 2, y + 13, w - 4, 0xe0b23a); canvas.hline(x + 2, y + 16, w - 4, 0xe0b23a);
            break;
        }
        case "lamp": {
            canvas.ellipse(x + 10, y + 10, 18, 14, 0xfff0c4, 0.12);
            canvas.ellipse(x + 10, y + 18, 5, 2, 0x000000, 0.2);
            canvas.disc(x + 10, y + 17, 3, 0x3a3e46); canvas.vline(x + 10, y - 2, 18, 0x3a3e46);
            canvas.disc(x + 10, y - 3, 6, 0xe9dcc0); canvas.disc(x + 10, y - 3, 4, 0xfff4d6);
            break;
        }
        case "art": {
            const frames = Math.max(1, Math.round(prop.w / 2));
            const slot = w / frames;
            for (let k = 0; k < frames; k++) {
                const fw = Math.min(24, Math.round(slot - 8)), fx = Math.round(x + slot * k + (slot - fw) / 2), fy = y + 3;
                canvas.box(fx, fy, fw, 12, 0x2b2620, 0x15120f, 0);
                const theme = Math.floor(random() * 4);
                canvas.fill(fx + 1, fy + 1, fw - 2, 10, (px, py) => {
                    const i = px - fx, j = py - fy;
                    if (theme === 0) return ((i >> 1) + (j >> 1)) % 2 ? 0x1d1f24 : 0xf4f4f0;
                    if (theme === 1) return j < 6 ? mixColor(0xf2a65a, 0x7a5aa6, j / 6) : j < 8 && (i * 7) % 5 < 3 ? 0x2a2e3a : 0x3d4a6b;
                    if (theme === 2) return i < fw / 3 ? 0xd9534f : j < 5 ? 0xf2c14e : 0x3f6aa1;
                    return j > 7 ? 0x4b9442 : j > 5 && Math.abs(i - fw / 2) < 2 ? 0xd8cfbd : 0x9fc6e6;
                });
                if (theme === 0) { canvas.rect(fx + 4, fy + 6, 8, 3, 0xd9443a); canvas.set(fx + 5, fy + 9, 0x111111); canvas.set(fx + 10, fy + 9, 0x111111); }
            }
            break;
        }
        case "clock": {
            canvas.disc(x + 10, y + 9, 6, 0x2b2e35); canvas.disc(x + 10, y + 9, 5, 0xf7f5ef);
            canvas.vline(x + 10, y + 5, 4, 0x2b2e35); canvas.hline(x + 10, y + 9, 3, 0x2b2e35); canvas.set(x + 10, y + 9, 0xd9443a);
            break;
        }
        case "whiteboard": {
            canvas.box(x + 2, y + 1, w - 4, 15, 0xfbfbf8, 0x9aa1aa, 0);
            for (let k = 0; k < 6; k++) {
                const lx = x + 6 + Math.floor(random() * (w - 24)), ly = y + 4 + Math.floor(random() * 8), len = 6 + Math.floor(random() * 12);
                canvas.hline(lx, ly, len, [0x2f6fa8, 0xd9443a, 0x2b2e35, 0x3d873d][k % 4]);
            }
            canvas.rect(x + w - 18, y + 4, 10, 7, 0xf2d64e);
            canvas.rect(x + 4, y + 16, w - 8, 2, 0x7d838b);
            break;
        }
        case "tv": {
            const sx = prop.side === "e" ? x - 5 : x + w;
            canvas.rect(sx, y + 4, 5, h - 8, 0x15171b);
            canvas.vline(prop.side === "e" ? sx : sx + 4, y + 5, h - 10, 0x5fb2e8);
            break;
        }
        case "elevator": {
            const inner = prop.side === "e" ? x : x + T - 9;
            canvas.rect(inner, y + 3, 9, h - 6, 0x8c949d);
            for (let j = y + 5; j < y + h - 5; j++) for (let i = inner + 1; i < inner + 8; i++) canvas.set(i, j, (i + j) % 4 ? 0xc3c9cf : 0xb2b9c0);
            canvas.hline(inner, y + h / 2, 9, 0x5d646c);
            canvas.rect(inner + 3, y + 1, 3, 2, 0xffc04d);
            const floor = prop.side === "e" ? x - 4 : x + T;
            canvas.rect(floor, y + 6, 4, h - 12, 0xa5adb5);
            canvas.rect(prop.side === "e" ? x + 12 : x + 4, y + h + 2, 3, 4, 0xd9dde1);
            canvas.set(prop.side === "e" ? x + 13 : x + 5, y + h + 3, 0xffc04d);
            break;
        }
        default: break;
    }
}

function paintShadows(canvas) {
    const mask = new Uint8Array(canvas.width * canvas.height);
    for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) {
        if (!"NSK".includes(at(c, r))) continue;
        for (let j = 3; j < T + 4; j++) for (let i = 3; i < T + 4; i++) {
            const x = c * T + i, y = r * T + j;
            if (x < canvas.width && y < canvas.height) mask[y * canvas.width + x] = 1;
        }
    }
    for (let i = 0; i < mask.length; i++) if (mask[i]) {
        const x = i % canvas.width, y = (i - x) / canvas.width;
        const ch = at(Math.floor(x / T), Math.floor(y / T));
        if (!isWall(ch) && !isOpen(ch)) canvas.tint(x, y, 0.84);
    }
}

function paintProps(canvas) {
    paintShadows(canvas);
    const masks = surfaceMasks();
    paintSurfaces(canvas, masks);
    const draws = [];
    const bottom = (p) => (p.h !== undefined ? (p.y + p.h) * T : p.y * T + 8);
    for (const prop of PROPS) {
        if (prop.type === "surface" || prop.type === "rug") continue;
        if (prop.type === "chair") {
            if (prop.style === "office") draws.push([bottom(prop) - 12, () => paintWorkstation(canvas, prop, masks)]);
            draws.push([bottom(prop), () => paintChair(canvas, prop)]);
        } else if (prop.type === "couch") draws.push([bottom(prop), () => paintCouch(canvas, prop)]);
        else if (prop.type === "roundTable") draws.push([prop.y * T + prop.r * T, () => paintRoundTable(canvas, prop)]);
        else if (prop.type === "coffeeTable") draws.push([bottom(prop), () => paintLowTable(canvas, prop)]);
        else if (prop.type === "sideTable") draws.push([bottom(prop), () => paintLowTable(canvas, prop, true)]);
        else if (prop.type === "plant") draws.push([bottom(prop), () => paintPlant(canvas, prop)]);
        else if (["bookshelf", "credenza", "filing", "media", "bench", "spine"].includes(prop.type)) draws.push([prop.type === "spine" ? -1 : bottom(prop), () => paintCabinet(canvas, prop)]);
        else if (["rack", "crac", "waterCooler", "fridge", "minifridge", "printer"].includes(prop.type)) draws.push([bottom(prop) + (prop.type === "printer" ? 1 : 0), () => paintMachine(canvas, prop)]);
        else draws.push([["art", "clock", "whiteboard", "tv", "elevator"].includes(prop.type) ? -2 : bottom(prop) + 1, () => paintDecor(canvas, prop)]);
    }
    draws.sort((a, b) => a[0] - b[0]);
    for (const [, draw] of draws) draw();
}

// ---------- Indianapolis scenery ----------
// Layer coordinates line up with the world at camera (0, 0). Vertical parallax is small, so a layer's y is close to
// screen height: the horizon sits around y 150, just above the window heads when you stand by the south glass.
// Facing south from the office, east is on the left and west (Lucas Oil, the Speedway) is on the right.

const HORIZON = 152;
const SKY_TOP = 0x3f7fc4;
const SKY_MID = 0x7fb3e2;
const SKY_LOW = 0xcfe3f0;
const HAZE = 0xc9d8e2;

const haze = (c, t) => mixColor(c, HAZE, t);

function windowsGrid(canvas, x, y, w, h, { glass = 0x8fb4cc, dark = 0x4d6478, lit = 0xffe6a6, cell = [4, 5], size = [2, 3], seed = 0, litChance = 0.05, frame = null }) {
    for (let wy = y + 3; wy + size[1] <= y + h - 2; wy += cell[1]) for (let wx = x + 2; wx + size[0] <= x + w - 2; wx += cell[0]) {
        const n = hash(wx, wy, seed);
        const c = n < litChance ? lit : n < 0.35 ? dark : n > 0.9 ? shadeColor(glass, 0.3) : glass;
        canvas.rect(wx, wy, size[0], size[1], c);
        if (frame !== null) canvas.hline(wx, wy + size[1], size[0], frame);
    }
}

/** A plain box building with a shaded left edge, sunlit right edge and a roof lip. */
function block(canvas, x, base, w, h, color, opts = {}) {
    const top = base - h;
    canvas.rect(x, top, w, h, color);
    canvas.rect(x, top, Math.max(2, Math.round(w * 0.18)), h, shadeColor(color, -0.16));
    canvas.vline(x + w - 1, top, h, shadeColor(color, 0.22));
    canvas.rect(x - 1, top - 2, w + 2, 2, shadeColor(color, -0.28));
    if (opts.windows !== false) windowsGrid(canvas, x + Math.round(w * 0.18), top + 2, w - Math.round(w * 0.18), h - 2, { seed: x * 7 + h, ...opts });
    if (opts.roof === "ac") { canvas.rect(x + 3, top - 5, 6, 3, 0xa7adb3); canvas.rect(x + w - 9, top - 4, 5, 2, 0x8e959c); }
    if (opts.roof === "tank") { canvas.rect(x + Math.round(w / 2) - 3, top - 9, 7, 7, 0x8a6a4a); canvas.rect(x + Math.round(w / 2) - 4, top - 10, 9, 2, 0x5e4a36); }
    if (opts.roof === "antenna") canvas.vline(x + Math.round(w * 0.6), top - 14, 12, 0x6b737c);
}

function paintSky(canvas) {
    const { width, height } = canvas;
    for (let y = 0; y < height; y++) {
        const t = y / HORIZON;
        for (let x = 0; x < width; x++) {
            let c;
            if (y < HORIZON) {
                const d = dither(x, y) * 0.12 - 0.06;
                const k = Math.min(1, Math.max(0, t + d));
                c = k < 0.55 ? mixColor(SKY_TOP, SKY_MID, Math.round((k / 0.55) * 6) / 6) : mixColor(SKY_MID, SKY_LOW, Math.round(((k - 0.55) / 0.45) * 6) / 6);
            } else {
                const g = Math.min(1, (y - HORIZON) / 140);
                c = mixColor(0xb7c6c9, 0x8fa496, Math.round(g * 5) / 5);
                if (hash(x >> 2, y >> 1, 140) < 0.15) c = shadeColor(c, -0.05);
            }
            canvas.set(x, y, c);
        }
    }
    // Afternoon sun to the southwest with a soft glow.
    const sun = { x: 860, y: 46 };
    for (let r = 46; r > 10; r -= 6) canvas.ellipse(sun.x, sun.y, r, r, 0xfff6d8, 0.07);
    canvas.disc(sun.x, sun.y, 11, 0xfff3c4); canvas.disc(sun.x, sun.y, 9, 0xfffbe6);
    // Clouds: stacked pixel puffs with a shaded underside.
    const random = seeded(77);
    for (const [cx, cy, s] of [[90, 38, 1.1], [300, 70, 0.8], [520, 28, 1.3], [700, 92, 0.7], [1000, 60, 1.2], [1180, 34, 0.9]]) {
        const puffs = 5 + Math.floor(random() * 4);
        for (let k = 0; k < puffs; k++) {
            const px = cx + (k - puffs / 2) * 9 * s + random() * 6, py = cy - Math.sin((k / (puffs - 1)) * Math.PI) * 7 * s;
            const r = (6 + random() * 5) * s;
            canvas.ellipse(px, py + 2, r * 1.3, r * 0.75, 0xc7d9e8, 0.95);
            canvas.ellipse(px, py, r * 1.25, r * 0.7, 0xf8fbfd, 0.97);
        }
        canvas.rectA(cx - 30 * s, cy + 4 * s, 60 * s, 2, 0xc7d9e8, 0.8);
    }
    // A few birds and an airliner with a contrail heading for IND.
    for (const [bx, by] of [[410, 104], [418, 100], [426, 105], [610, 118], [617, 115]]) { canvas.set(bx, by, 0x3b4656); canvas.set(bx - 1, by - 1, 0x3b4656); canvas.set(bx + 1, by - 1, 0x3b4656); }
    for (let i = 0; i < 150; i++) canvas.blend(200 + i, 22 + i * 0.12, 0xffffff, 0.35 * (i / 150));
    canvas.rect(350, 39, 5, 2, 0xe9eef3); canvas.set(352, 38, 0xe9eef3); canvas.set(351, 41, 0xb9c3cc);
}

function paintFarSkyline(canvas) {
    const random = seeded(311);
    // Distant treeline and low suburbs.
    for (let x = 0; x < canvas.width; x++) {
        const h = 4 + Math.round(Math.sin(x / 23) * 2 + Math.sin(x / 7.3) * 1.5 + random() * 2);
        canvas.rect(x, HORIZON - h, 1, h + 2, haze(0x7f9a86, 0.55));
    }
    for (let x = -10; x < canvas.width; x += 14 + random() * 26) {
        const w = 10 + random() * 22, h = 6 + random() * 20;
        canvas.rect(Math.round(x), Math.round(HORIZON - h), Math.round(w), Math.round(h), haze(0x8d9aa6, 0.5 + random() * 0.2));
    }
    // Water towers.
    for (const wx of [180, 640]) {
        canvas.vline(wx - 3, HORIZON - 20, 18, haze(0x8d9aa6, 0.55)); canvas.vline(wx + 3, HORIZON - 20, 18, haze(0x8d9aa6, 0.55));
        canvas.ellipse(wx, HORIZON - 24, 7, 5, haze(0xa3adb6, 0.45));
    }
    // Indianapolis Motor Speedway Pagoda far to the west: stacked glass tiers.
    const px = 960;
    for (let tier = 0; tier < 9; tier++) {
        const w = 22 - tier * 1.4, y = HORIZON - 6 - tier * 4;
        canvas.rect(Math.round(px - w / 2 - 1), y - 1, Math.round(w + 2), 1, haze(0x6b7785, 0.35));
        canvas.rect(Math.round(px - w / 2), y, Math.round(w), 3, haze(tier % 2 ? 0x9fb7c9 : 0x8aa2b6, 0.35));
    }
    canvas.vline(px, HORIZON - 48, 10, haze(0x6b7785, 0.35));
    canvas.rect(px - 30, HORIZON - 5, 60, 5, haze(0x8d9aa6, 0.45));
}

// Landmarks are drawn bottom-up from the mid layer baseline; the near layer hides their feet.
const MID_BASE = 172;

function salesforceTower(canvas, x) {
    const w = 46, h = 150, top = MID_BASE - h;
    canvas.rect(x, top, w, h, 0x9aa9b6);
    canvas.rect(x, top, 9, h, 0x7c8b99);
    for (let i = x + 11; i < x + w - 2; i += 3) canvas.vline(i, top + 10, h - 10, 0xb7c6d2);
    for (let j = top + 12; j < MID_BASE; j += 6) canvas.hline(x + 9, j, w - 10, 0x8797a5);
    canvas.vline(x + w - 1, top, h, 0xc9d6e0);
    // Stepped crown with the open notch and twin spires.
    canvas.rect(x + 4, top - 10, w - 8, 10, 0x8c9bab);
    canvas.rect(x + 16, top - 10, w - 32, 7, 0xb3d4ee);
    canvas.rect(x + 8, top - 18, 8, 8, 0x8c9bab); canvas.rect(x + w - 16, top - 18, 8, 8, 0x8c9bab);
    canvas.rect(x + 11, top - 44, 2, 26, 0x6f7d8b); canvas.rect(x + w - 13, top - 44, 2, 26, 0x6f7d8b);
    canvas.set(x + 11, top - 45, 0xff6b5a); canvas.set(x + w - 12, top - 45, 0xff6b5a);
    // The blue cloud sign near the top.
    canvas.ellipse(x + 24, top + 8, 7, 4, 0x1798c1); canvas.ellipse(x + 20, top + 7, 4, 3, 0x1798c1); canvas.ellipse(x + 28, top + 7, 4, 3, 0x1798c1);
    canvas.hline(x + 19, top + 8, 10, 0xffffff);
}

function oneAmericaTower(canvas, x) {
    const w = 40, h = 124, top = MID_BASE - h;
    canvas.rect(x, top, w, h, 0xe7e2d7);
    canvas.rect(x, top, 8, h, 0xc9c3b6);
    for (let i = x + 10; i < x + w - 2; i += 4) canvas.rect(i, top + 6, 2, h - 6, 0x9eb3c3);
    canvas.vline(x + w - 1, top, h, 0xf7f4ee);
    for (let step = 0; step < 4; step++) canvas.rect(x + 4 + step * 4, top - 4 - step * 4, w - 8 - step * 8, 4, step % 2 ? 0xd8d2c5 : 0xe7e2d7);
    canvas.rect(x + 18, top - 20, 4, 4, 0xc9c3b6);
}

function marketTower(canvas, x) {
    const w = 34, h = 98, top = MID_BASE - h;
    canvas.rect(x, top, w, h, 0x5f8e8f);
    canvas.rect(x, top, 7, h, 0x4b7373);
    for (let j = top + 4; j < MID_BASE; j += 4) canvas.hline(x + 7, j, w - 7, 0x86b3b1);
    for (let k = 0; k < 14; k++) canvas.hline(x + k, top - k, w - 2 * k, k % 3 ? 0x6f9c9c : 0x557f80);
    canvas.vline(x + w / 2, top - 26, 12, 0x5d6b6f);
}

function meridian300(canvas, x) {
    const w = 32, h = 102, top = MID_BASE - h;
    canvas.rect(x, top, w, h, 0x9a6b5a);
    canvas.rect(x, top, 6, h, 0x7a5244);
    windowsGrid(canvas, x + 6, top, w - 6, h, { glass: 0x6c87a0, dark: 0x4a5c6e, cell: [3, 4], size: [2, 2], seed: 9 });
    for (let k = 0; k < 13; k++) canvas.hline(x + k + 1, top - k, w - 2 - 2 * k, 0x6d8f7e);
}

function regionsTower(canvas, x) {
    const w = 40, h = 108, top = MID_BASE - h;
    canvas.rect(x, top, w, h, 0x4c5866);
    canvas.rect(x, top, 7, h, 0x3a4450);
    for (let j = top + 3; j < MID_BASE; j += 5) canvas.rect(x + 7, j, w - 7, 2, 0x7d93a8);
    canvas.rect(x - 1, top - 3, w + 2, 3, 0x2f3740);
    canvas.rect(x + 8, top - 7, 10, 4, 0x6b737c);
}

function jwMarriott(canvas, x) {
    const w = 64, h = 112, top = MID_BASE - h;
    canvas.rect(x, top, w, h, 0x3a77b2);
    for (let i = 0; i < w; i++) {
        const curve = Math.round(Math.sin((i / w) * Math.PI) * 6);
        canvas.rect(x + i, top - curve, 1, curve + 1, 0x3a77b2);
        const light = i > w * 0.55 && i < w * 0.7 ? 0.35 : i < 8 ? -0.2 : 0;
        if (light) canvas.shade(x + i, top - curve, 1, h + curve, light > 0 ? 1.3 : 0.8);
    }
    for (let j = top + 4; j < MID_BASE; j += 4) canvas.hline(x, j, w, 0x2e6399);
    canvas.rect(x + 24, top - 1, 16, 5, 0x2e6399); canvas.rect(x + 26, top, 3, 3, 0xffffff); canvas.rect(x + 31, top, 6, 3, 0xffffff);
}

function capitalCenter(canvas, x) {
    block(canvas, x, MID_BASE, 26, 74, 0xa58d72, { glass: 0x6f8193, dark: 0x51606e, cell: [4, 4], seed: 31 });
    block(canvas, x + 30, MID_BASE, 26, 80, 0xa58d72, { glass: 0x6f8193, dark: 0x51606e, cell: [4, 4], seed: 32, roof: "ac" });
}

function monument(canvas, x) {
    const stone = 0xd9d0bf, shade = 0xb3a993;
    canvas.rect(x - 22, MID_BASE - 10, 44, 10, shade);
    canvas.rect(x - 18, MID_BASE - 16, 36, 6, stone);
    canvas.rect(x - 12, MID_BASE - 24, 24, 8, stone); canvas.rect(x - 12, MID_BASE - 24, 4, 8, shade);
    for (let j = 0; j < 70; j++) {
        const half = Math.round(6 - j * 0.04);
        canvas.rect(x - half, MID_BASE - 24 - j, half * 2, 1, stone);
        canvas.set(x - half, MID_BASE - 24 - j, shade);
    }
    canvas.rect(x - 7, MID_BASE - 98, 14, 4, shade); canvas.rect(x - 6, MID_BASE - 104, 12, 6, stone);
    canvas.rect(x - 3, MID_BASE - 108, 6, 4, shade);
    // Victory with her torch and sword, in bronze.
    canvas.rect(x - 1, MID_BASE - 116, 3, 8, 0x8a6a2e); canvas.set(x, MID_BASE - 117, 0x8a6a2e); canvas.set(x + 2, MID_BASE - 118, 0xffc24d);
    canvas.set(x - 2, MID_BASE - 113, 0x8a6a2e); canvas.set(x + 2, MID_BASE - 115, 0x8a6a2e);
    // Fountains at the foot of the Circle.
    canvas.ellipse(x - 28, MID_BASE - 4, 7, 3, 0x8fc6e6); canvas.ellipse(x + 28, MID_BASE - 4, 7, 3, 0x8fc6e6);
}

function statehouse(canvas, x) {
    const lime = 0xd8cfbb, shade = 0xb4aa94;
    canvas.rect(x - 50, MID_BASE - 28, 100, 28, lime);
    canvas.rect(x - 50, MID_BASE - 28, 100, 3, shade);
    for (let i = x - 46; i < x + 46; i += 5) canvas.vline(i, MID_BASE - 24, 22, shade);
    canvas.rect(x - 14, MID_BASE - 36, 28, 8, lime); canvas.rect(x - 14, MID_BASE - 36, 28, 2, shade);
    for (let i = x - 12; i < x + 12; i += 3) canvas.vline(i, MID_BASE - 34, 6, shade);
    canvas.ellipse(x, MID_BASE - 36, 16, 18, 0x8fb3a2);
    canvas.rect(x - 17, MID_BASE - 36, 34, 4, lime);
    for (let i = -12; i <= 12; i += 4) canvas.vline(x + i, MID_BASE - 52 + Math.abs(i) / 2, 14, 0x7a9d8c);
    canvas.rect(x - 4, MID_BASE - 60, 8, 8, lime); canvas.rect(x - 2, MID_BASE - 66, 4, 6, 0x8fb3a2); canvas.vline(x, MID_BASE - 71, 5, 0x6b7f75);
}

function lucasOil(canvas, x) {
    const w = 240, h = 46, top = MID_BASE - h;
    canvas.rect(x, top, w, h, 0xa35b43);
    canvas.rect(x, top, w, 3, 0x7f4433);
    for (let i = x + 8; i < x + w - 50; i += 12) { canvas.rect(i, top + 10, 6, 14, 0x6f8193); canvas.ellipse(i + 3, top + 10, 3, 3, 0x6f8193); }
    for (let i = x + 4; i < x + w; i += 2) if (hash(i, 3, 150) < 0.3) canvas.vline(i, top + 28, 14, 0x8f4e39);
    // The great window wall looking back at downtown, and the retractable roof.
    canvas.rect(x + w - 46, top + 4, 40, h - 8, 0x87aac2);
    for (let i = x + w - 46; i < x + w - 6; i += 5) canvas.vline(i, top + 4, h - 8, 0x5f7f96);
    for (let i = 0; i < w + 8; i++) {
        const arch = Math.round(Math.sin((i / (w + 8)) * Math.PI) * 16);
        canvas.rect(x - 4 + i, top - arch, 1, arch + 2, i % 20 < 1 ? 0x9aa3ab : 0xc9ced3);
    }
    canvas.rect(x + w / 2 - 50, top - 16, 100, 3, 0x9aa3ab);
    canvas.rect(x + 20, top + 30, 40, 5, 0xf5f2ea); canvas.rect(x + 22, top + 31, 36, 3, 0x2f5e9e);
}

function gainbridge(canvas, x) {
    const w = 110, h = 30, top = MID_BASE - h;
    canvas.rect(x, top, w, h, 0x9c5a44);
    for (let i = 0; i < w; i++) {
        const arch = Math.round(Math.sin((i / w) * Math.PI) * 14);
        canvas.rect(x + i, top - arch, 1, arch, 0x8c949c);
        if (i % 9 === 0) canvas.vline(x + i, top - arch, arch, 0x737b83);
    }
    canvas.ellipse(x + w / 2, top + 12, 22, 12, 0x7f9bb0);
    canvas.rect(x + w / 2 - 22, top + 12, 44, 12, 0x9c5a44);
    for (let i = x + w / 2 - 20; i < x + w / 2 + 20; i += 5) canvas.vline(i, top + 2, 10, 0x5f7a8e);
}

function scottishRite(canvas, x) {
    const stone = 0xcdb68d, shade = 0xa8916a;
    canvas.rect(x - 34, MID_BASE - 34, 68, 34, stone);
    canvas.rect(x - 34, MID_BASE - 34, 68, 2, shade);
    for (let i = x - 30; i < x + 30; i += 8) { canvas.rect(i, MID_BASE - 26, 4, 12, 0x5b6778); canvas.set(i + 1, MID_BASE - 27, 0x5b6778); canvas.set(i + 2, MID_BASE - 27, 0x5b6778); }
    canvas.rect(x - 9, MID_BASE - 92, 18, 58, stone); canvas.rect(x - 9, MID_BASE - 92, 4, 58, shade);
    canvas.rect(x - 4, MID_BASE - 84, 8, 16, 0x5b6778);
    for (const dx of [-9, -4, 2, 7]) canvas.rect(x + dx, MID_BASE - 100, 2, 8, stone);
    for (let k = 0; k < 14; k++) canvas.rect(x - Math.max(1, 4 - (k >> 2)), MID_BASE - 100 - k, Math.max(2, 8 - (k >> 1)), 1, shade);
}

function paintMidSkyline(canvas) {
    const random = seeded(902);
    const fillers = [];
    // Background mass of downtown so the landmarks read as a city, not a lineup.
    for (let x = 60; x < 1680; x += 10 + random() * 22) {
        const dense = x > 360 && x < 1180;
        const h = dense ? 40 + random() * 60 : 18 + random() * 30;
        const w = 16 + random() * 24;
        fillers.push([Math.round(x), Math.round(w), Math.round(h)]);
    }
    for (const [x, w, h] of fillers) {
        const palette = [0x8c96a1, 0x9d958a, 0x7d8b98, 0xa8a196, 0x6f8090, 0xb3aa9b];
        block(canvas, x, MID_BASE + 4, w, h, haze(palette[Math.floor(hash(x, h, 160) * palette.length)], 0.32),
            { glass: haze(0x8fb4cc, 0.3), dark: haze(0x5a6f82, 0.3), lit: haze(0xffe6a6, 0.3), seed: x, roof: hash(x, 2, 161) < 0.3 ? "ac" : hash(x, 3, 161) < 0.2 ? "antenna" : null });
    }
    gainbridge(canvas, 120);
    scottishRite(canvas, 300);
    regionsTower(canvas, 430);
    capitalCenter(canvas, 486);
    marketTower(canvas, 560);
    oneAmericaTower(canvas, 610);
    salesforceTower(canvas, 676);
    meridian300(canvas, 740);
    block(canvas, 780, MID_BASE, 30, 66, 0xb9ad9a, { glass: 0x7a8fa3, seed: 41, roof: "ac" });
    monument(canvas, 812);
    statehouse(canvas, 950);
    block(canvas, 1030, MID_BASE, 26, 58, 0x8a97a5, { glass: 0x9fb8cc, seed: 51 });
    jwMarriott(canvas, 1080);
    block(canvas, 1160, MID_BASE, 30, 48, 0xa89e8e, { seed: 52, roof: "tank" });
    lucasOil(canvas, 1230);
    // Bodies continue below the skyline so nearer layers can slide over them without gaps.
    for (let y = MID_BASE; y < canvas.height; y++) for (let x = 40; x < 1700; x++) {
        if (canvas.alpha(x, y)) continue;
        canvas.set(x, y, haze(hash(x >> 3, y >> 3, 162) < 0.5 ? 0x7f8b96 : 0x8a8f94, 0.35));
    }
}

const TREE_GREENS = [0x3f7a3d, 0x4f8c45, 0x5c9a4c, 0x356b37, 0x6aa155];

function tree(canvas, x, y, r, seed) {
    const random = seeded(seed);
    canvas.ellipse(x + r * 0.4, y + r * 0.6, r, r * 0.45, 0x000000, 0.18);
    for (let k = 0; k < 6; k++) {
        const c = TREE_GREENS[Math.floor(random() * TREE_GREENS.length)];
        const px = x + (random() - 0.5) * r, py = y + (random() - 0.6) * r * 0.8;
        canvas.ellipse(px, py, r * 0.7, r * 0.62, shadeColor(c, -0.2));
        canvas.ellipse(px - 1, py - 1, r * 0.6, r * 0.52, c);
    }
    canvas.ellipse(x - r * 0.3, y - r * 0.4, r * 0.3, r * 0.22, 0x8cc070);
}

function car(canvas, x, y, s, dir, seed) {
    const colors = [0xd9443a, 0xf2f2f2, 0x2f3540, 0x3f6aa1, 0xb9c0c7, 0xe0b04a, 0x4c8a5a, 0x7a2f2f];
    const c = colors[Math.floor(hash(seed, 1, 170) * colors.length)];
    const w = Math.max(4, Math.round(7 * s)), h = Math.max(2, Math.round(3 * s));
    canvas.rect(x, y, w, h, c);
    canvas.hline(x, y + h, w, 0x2b2e33);
    const glass = dir > 0 ? x + w - Math.max(1, Math.round(w * 0.3)) : x + 1;
    canvas.rect(glass, y + 1, Math.max(1, Math.round(w * 0.22)), Math.max(1, h - 2), 0x6d8aa3);
}

function paintNearCity(canvas) {
    const random = seeded(4401);
    const W = canvas.width;
    // Neighbourhood skyline right below the horizon: mid-rises, steeples and tree canopy.
    for (let x = -10; x < W; x += 22 + random() * 46) {
        const w = 26 + random() * 50, h = 14 + random() * 40;
        const palette = [0xb5714f, 0xc9b79a, 0x9a8f86, 0xd8cdb8, 0x8c6b55, 0xa9b2ba];
        block(canvas, Math.round(x), 182, Math.round(w), Math.round(h), haze(palette[Math.floor(random() * palette.length)], 0.12),
            { glass: 0x86a3b8, dark: 0x4f6070, cell: [5, 6], size: [3, 3], seed: Math.round(x), roof: random() < 0.4 ? "ac" : random() < 0.3 ? "tank" : null });
    }
    for (const sx of [260, 1210, 1990]) {
        canvas.rect(sx - 6, 150, 12, 32, 0xd8cdb8); canvas.rect(sx - 6, 150, 3, 32, 0xb3a78f);
        for (let k = 0; k < 22; k++) canvas.rect(sx - Math.max(0, 5 - (k >> 2)), 150 - k, Math.max(1, 10 - (k >> 1)), 1, 0x6d7a84);
        canvas.rect(sx - 2, 158, 4, 6, 0x5b6778);
    }
    for (let x = 0; x < W; x += 9 + random() * 12) tree(canvas, x, 180 - random() * 8, 7 + random() * 5, Math.round(x) + 1);
    // Rows of city blocks seen from above, growing as they get closer, with streets between them.
    let y = 184;
    for (let row = 0; y < canvas.height; row++) {
        const s = 1 + row * 0.32;
        const streetH = Math.round(9 * s);
        const isHighway = row === 3, isCanal = row === 6;
        if (isCanal) {
            canvas.rect(0, y, W, Math.round(4 * s), 0xb9b2a4);
            canvas.fill(0, y + Math.round(4 * s), W, Math.round(10 * s), (px, py) => ((px + py * 3) % 23 < 2 ? 0x8fc3dd : 0x4f8fb3));
            canvas.rect(0, y + Math.round(14 * s), W, Math.round(4 * s), 0xb9b2a4);
            for (let x = 40; x < W; x += 260) { canvas.rect(x, y + Math.round(2 * s), Math.round(18 * s), Math.round(14 * s), 0xa39a8a); canvas.hline(x, y + Math.round(2 * s), Math.round(18 * s), 0xd2cbbd); }
            y += Math.round(18 * s);
        } else {
            const h = isHighway ? streetH * 2 : streetH;
            canvas.rect(0, y, W, h, isHighway ? 0x55595f : 0x60646b);
            canvas.hline(0, y, W, 0xb9b5ad); canvas.hline(0, y + h - 1, W, 0xb9b5ad);
            const lanes = isHighway ? 3 : 1;
            for (let lane = 1; lane <= lanes; lane++) {
                const ly = y + Math.round((h * lane) / (lanes + 1));
                for (let x = (row * 13) % 18; x < W; x += 18) canvas.hline(x, ly, Math.round(6 * s * 0.6), isHighway && lane === 2 ? 0xe8c44a : 0xd9d6cf);
            }
            for (let x = random() * 40; x < W; x += 30 + random() * 90 / (isHighway ? 3 : 1)) {
                const lane = Math.floor(random() * (lanes + 1));
                const cy = y + 2 + Math.round(((h - 4 - 3 * s) * lane) / Math.max(1, lanes));
                car(canvas, Math.round(x), Math.max(y + 1, Math.min(y + h - Math.round(3 * s) - 2, cy)), s, lane % 2 ? 1 : -1, Math.round(x) + row * 1000);
            }
            y += h;
        }
        // The block: sidewalk, then lots of rooftops, parks and parking.
        const blockH = Math.round(30 * s);
        canvas.rect(0, y, W, Math.round(2 * s), 0xc9c4b9);
        const lotTop = y + Math.round(2 * s);
        for (let x = random() * -30; x < W;) {
            const kind = random();
            const w = Math.round((22 + random() * 40) * s);
            const lx = Math.round(x);
            if (kind < 0.62) {
                const roofH = Math.round(blockH * (0.45 + random() * 0.15));
                const faceH = blockH - Math.round(2 * s) - roofH;
                const palette = [0x8e8f8c, 0x9c8676, 0x7f8a8e, 0xa89985, 0x6f7b74, 0xb0a698];
                const roof = palette[Math.floor(random() * palette.length)];
                canvas.rect(lx, lotTop, w - 2, roofH, roof);
                canvas.rect(lx, lotTop, w - 2, 1, shadeColor(roof, 0.2));
                canvas.vline(lx, lotTop, roofH, shadeColor(roof, -0.2));
                if (random() < 0.6) canvas.rect(lx + Math.round(4 * s), lotTop + Math.round(3 * s), Math.round(6 * s), Math.round(4 * s), 0xb3b9bf);
                if (random() < 0.3) canvas.rect(lx + w - Math.round(12 * s), lotTop + Math.round(2 * s), Math.round(8 * s), Math.round(5 * s), 0x7aa3c4);
                const facade = [0xb5714f, 0xc9b79a, 0x9a8f86, 0xd8cdb8, 0x8c6b55][Math.floor(random() * 5)];
                canvas.rect(lx, lotTop + roofH, w - 2, faceH, facade);
                windowsGrid(canvas, lx + 1, lotTop + roofH, w - 4, faceH, { glass: 0x86a3b8, dark: 0x4f6070, cell: [Math.max(3, Math.round(4 * s)), Math.max(3, Math.round(4 * s))], size: [Math.max(1, Math.round(2 * s)), Math.max(1, Math.round(2 * s))], seed: lx + row });
            } else if (kind < 0.85) {
                canvas.rect(lx, lotTop, w - 2, blockH - Math.round(2 * s), 0x6f9a55);
                for (let k = 0; k < w / (8 * s); k++) tree(canvas, lx + random() * w, lotTop + random() * blockH * 0.8, (4 + random() * 4) * s, lx + k + row * 77);
            } else {
                canvas.rect(lx, lotTop, w - 2, blockH - Math.round(2 * s), 0x707479);
                for (let i = lx + 2; i < lx + w - 4; i += Math.max(3, Math.round(5 * s))) canvas.vline(i, lotTop + 1, Math.round(5 * s), 0xd9d6cf);
                for (let k = 0; k < w / (9 * s); k++) if (random() < 0.6) car(canvas, lx + 2 + Math.round(k * 9 * s), lotTop + 2, s * 0.8, 1, lx + k);
            }
            x += w;
        }
        y += blockH;
    }
}

export function paintScenery() {
    const far = createCanvas(1120, 420);
    paintSky(far);
    paintFarSkyline(far);
    const mid = createCanvas(1720, 330);
    paintMidSkyline(mid);
    const near = createCanvas(2460, 1000);
    paintNearCity(near);
    return {
        far: { canvas: far, x: 0, y: 0, fill: 0x8fa496 },
        mid: { canvas: mid, x: 0, y: 0, fill: null },
        near: { canvas: near, x: 0, y: 0, fill: 0x6f9a55 },
    };
}
