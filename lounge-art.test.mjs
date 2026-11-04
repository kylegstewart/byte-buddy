import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { GRID, ROWS, COLS, TILE, WORLD, PARALLAX } from "./public/lounge-map.js";
import { paintMap, paintScenery, createCanvas, mixColor, shadeColor } from "./public/lounge-art.js";
import { imageMarkup } from "./public/lounge.js";

const map = paintMap();
const scenery = paintScenery();
const alphaAt = (canvas, x, y) => canvas.data[(y * canvas.width + x) * 4 + 3];
const tileCenter = (ch) => {
    for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) if (GRID[r][c] === ch) return { x: c * TILE + TILE / 2, y: r * TILE + TILE / 2 };
    return null;
};

test("canvas helpers pack colours and blend with source-over", () => {
    const canvas = createCanvas(2, 1);
    canvas.set(0, 0, 0x336699);
    assert.deepEqual([...canvas.data.slice(0, 4)], [0x33, 0x66, 0x99, 255]);
    canvas.blend(1, 0, 0xffffff, 0.5);
    assert.equal(canvas.alpha(1, 0), 128, "blending over transparency keeps partial alpha");
    assert.equal(canvas.get(1, 0), 0xffffff);
    assert.equal(mixColor(0x000000, 0xffffff, 0.5), 0x808080);
    assert.equal(shadeColor(0x808080, -0.5), 0x404040);
});

test("the office is one pixel per world unit and deterministic", () => {
    assert.equal(map.width, WORLD.width);
    assert.equal(map.height, WORLD.height);
    const digest = (canvas) => createHash("sha1").update(canvas.data).digest("hex");
    assert.equal(digest(paintMap()), digest(map));
});

test("outdoors and glass let the skyline through; floors and walls are opaque", () => {
    assert.equal(alphaAt(map, 100, 40), 0, "open sky above the building");
    const wall = tileCenter("#"), floor = tileCenter(".");
    assert.equal(alphaAt(map, wall.x, wall.y), 255);
    assert.equal(alphaAt(map, floor.x, floor.y), 255);
    let glass = 0, total = 0;
    for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) {
        if (GRID[r][c] !== "B") continue;
        total++;
        const a = alphaAt(map, c * TILE + 10, r * TILE + 12);
        if (a > 0 && a < 160) glass++;
    }
    assert.ok(glass / total > 0.6, `most window tiles are see-through tinted glass (${glass}/${total})`);
});

test("the map is detailed pixel art, not flat fills", () => {
    const colours = new Set();
    for (let i = 0; i < map.data.length; i += 4 * 7) colours.add((map.data[i] << 16) | (map.data[i + 1] << 8) | map.data[i + 2]);
    assert.ok(colours.size > 2000, `${colours.size} distinct colours`);
});

test("scenery layers cover the whole parallax range and stack far to near", () => {
    const keys = { loungeSceneryFar: "far", loungeSceneryMid: "mid", loungeSceneryNear: "near" };
    for (const layer of PARALLAX) {
        const { canvas, x } = scenery[keys[layer.id]];
        const reach = layer.x * (WORLD.width - 720) + 720;
        assert.ok(x <= 0 && x + canvas.width >= reach, `${layer.id} spans ${reach} units of pan`);
    }
    const { far, mid, near } = scenery;
    for (let x = 0; x < far.canvas.width; x += 50) assert.equal(alphaAt(far.canvas, x, 5), 255, "the sky is solid");
    assert.equal(alphaAt(mid.canvas, 20, 10), 0, "the skyline layer is clear above the towers");
    assert.equal(alphaAt(near.canvas, 600, 400), 255, "the street grid below is solid");
    assert.equal(alphaAt(near.canvas, 600, 20), 0, "the near layer leaves the sky open");
    assert.ok(far.fill !== null && near.fill !== null, "solid layers extend below their images");
});

test("Salesforce Tower tops the downtown skyline", () => {
    const { canvas } = scenery.mid;
    const topAt = (x) => { for (let y = 0; y < canvas.height; y++) if (alphaAt(canvas, x, y)) return y; return canvas.height; };
    let tallest = { x: 0, y: Infinity };
    for (let x = 0; x < canvas.width; x++) { const y = topAt(x); if (y < tallest.y) tallest = { x, y }; }
    assert.ok(tallest.x >= 676 && tallest.x <= 722, `the twin spires stand tallest (x ${tallest.x})`);
});

test("image markup scales art with crisp pixels", () => {
    const markup = imageMarkup("blob:x", 0, 0, 3160, 1280);
    assert.match(markup, /<image href="blob:x"[^>]*width="3160"[^>]*height="1280"/);
    assert.match(markup, /preserveAspectRatio="none"/);
    assert.match(markup, /image-rendering: pixelated/);
});
