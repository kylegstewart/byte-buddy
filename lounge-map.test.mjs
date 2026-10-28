import test from "node:test";
import assert from "node:assert/strict";
import {
    TILE, GRID, ROWS, COLS, WORLD, SPAWN, DEAD_ZONE, LABELS,
    tileAt, isSolid, moveWithCollision, nearestWalkable,
    viewSize, clampCamera, cameraFollow, centerCamera, smoothCamera, parallaxOffset,
    mapMarkup, labelsMarkup, sceneryMarkup,
} from "./public/lounge-map.js";

const center = (col, row) => ({ x: col * TILE + TILE / 2, y: row * TILE + TILE / 2 });

function reachableTiles() {
    const start = [Math.floor(SPAWN.x / TILE), Math.floor(SPAWN.y / TILE)];
    const seen = new Set([start.join(",")]);
    const queue = [start];
    while (queue.length) {
        const [c, r] = queue.shift();
        for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const key = `${c + dc},${r + dr}`;
            const p = center(c + dc, r + dr);
            if (seen.has(key) || isSolid(p.x, p.y)) continue;
            seen.add(key);
            queue.push([c + dc, r + dr]);
        }
    }
    return seen;
}

test("world is a rectangular grid larger than the view", () => {
    assert.ok(GRID.every((row) => row.length === COLS));
    assert.deepEqual(WORLD, { width: COLS * TILE, height: ROWS * TILE });
    const view = viewSize(1200, 700);
    assert.ok(WORLD.width > view.width * 2 && WORLD.height > view.height * 2);
    assert.equal(tileAt(-1, 0), "#");
    assert.equal(tileAt(0, ROWS), "#");
});

test("rotated layout puts the main window wall along the top", () => {
    const count = (rows) => rows.reduce((n, row) => n + [...row].filter((ch) => ch === "B").length, 0);
    const band = Math.floor(ROWS / 4);
    assert.ok(count(GRID.slice(0, band)) > count(GRID.slice(-band)) * 2, "windows concentrate in the top quarter");
});

test("spawn is walkable and every labelled room is reachable from it", () => {
    assert.equal(isSolid(SPAWN.x, SPAWN.y), false);
    const reachable = reachableTiles();
    assert.equal(LABELS.length, 10);
    for (const label of LABELS) {
        const key = `${Math.floor(label.x / TILE)},${Math.floor(label.y / TILE)}`;
        assert.ok(reachable.has(key), `${label.text} at ${label.x},${label.y} is reachable`);
    }
});

test("walls stop movement and the buddy never ends inside a solid tile", () => {
    let pos = { ...SPAWN };
    for (let i = 0; i < 200; i++) pos = moveWithCollision(pos, 0, -10);
    assert.equal(isSolid(pos.x, pos.y), false);
    assert.ok(pos.y > 0);
    assert.ok(isSolid(pos.x, pos.y - 2), "blocked by something directly above");
    const jump = moveWithCollision(SPAWN, 0, -2000);
    assert.equal(isSolid(jump.x, jump.y), false, "large steps cannot tunnel through walls");
});

test("doorways are passable in both directions", () => {
    let crossed = 0;
    for (let r = 2; r < ROWS - 2; r++) {
        for (let c = 2; c < COLS - 2; c++) {
            if (GRID[r][c] !== "D") continue;
            for (const [dc, dr] of [[0, 1], [1, 0]]) {
                const a = center(c - dc * 2, r - dr * 2), b = center(c + dc * 2, r + dr * 2);
                const door = center(c, r);
                if (isSolid(a.x, a.y) || isSolid(b.x, b.y) || isSolid(door.x, door.y)) continue;
                const there = moveWithCollision(a, b.x - a.x, b.y - a.y);
                const back = moveWithCollision(b, a.x - b.x, a.y - b.y);
                if (Math.hypot(there.x - b.x, there.y - b.y) < 1 && Math.hypot(back.x - a.x, back.y - a.y) < 1) crossed++;
            }
        }
    }
    assert.ok(crossed >= 10, `crossed ${crossed} door tiles`);
});

test("diagonal movement slides along a wall instead of sticking", () => {
    let pos = { ...SPAWN };
    for (let i = 0; i < 200; i++) pos = moveWithCollision(pos, 0, -10);
    const slid = moveWithCollision(pos, 40, -40);
    assert.ok(slid.x > pos.x || slid.x < pos.x || slid.y !== pos.y || isSolid(pos.x + 40, pos.y), "moved along the wall when open");
    assert.equal(isSolid(slid.x, slid.y), false);
});

test("nearestWalkable rescues positions inside furniture or walls", () => {
    const wall = { x: 0, y: 0 };
    const fixed = nearestWalkable(wall);
    assert.equal(isSolid(fixed.x, fixed.y), false);
    assert.deepEqual(nearestWalkable(SPAWN), SPAWN);
});

test("dead zone holds the camera still, then scrolls minimally toward the edge", () => {
    const view = { width: 720, height: 450 };
    const cam = centerCamera(SPAWN, view);
    const marginX = view.width * (1 - DEAD_ZONE.x) / 2;
    const inside = { x: cam.x + marginX + 5, y: SPAWN.y };
    assert.deepEqual(cameraFollow(cam, inside, view), cam, "inside dead zone: no scroll");
    const right = { x: cam.x + view.width - marginX + 30, y: SPAWN.y };
    const moved = cameraFollow(cam, right, view);
    assert.equal(moved.x, cam.x + 30);
    assert.equal(moved.y, cam.y);
    const diag = cameraFollow(cam, { x: right.x, y: cam.y + 10 }, view);
    assert.ok(diag.x > cam.x && diag.y < cam.y, "diagonal scroll");
    assert.deepEqual(cameraFollow(moved, right, view), moved, "settled: stopping does not recenter");
});

test("camera clamps to world edges and settles without jitter", () => {
    const view = { width: 720, height: 450 };
    assert.deepEqual(cameraFollow({ x: 0, y: 0 }, { x: 5, y: 5 }, view), { x: 0, y: 0 });
    assert.deepEqual(clampCamera({ x: 99999, y: 99999 }, view), { x: WORLD.width - 720, y: WORLD.height - 450 });
    let cam = { x: 0, y: 0 };
    const goal = { x: 300, y: 120 };
    let last = -1;
    for (let i = 0; i < 120; i++) {
        cam = smoothCamera(cam, goal, 1 / 60);
        assert.ok(cam.x >= last, "monotonic, no overshoot");
        assert.ok(cam.x <= goal.x);
        last = cam.x;
    }
    assert.deepEqual(cam, goal);
});

test("viewport adapts to panel size", () => {
    assert.deepEqual(viewSize(0, 0), { width: 720, height: 450 });
    const small = viewSize(400, 300), wide = viewSize(1600, 600);
    assert.equal(small.width, 320);
    assert.equal(small.height, 240);
    assert.equal(wide.width, 720);
    assert.equal(wide.height, 270);
});

test("parallax: far layers move less than near layers", () => {
    const cam = { x: 1000, y: 400 };
    const far = parallaxOffset(cam, 0.15), mid = parallaxOffset(cam, 0.4), near = parallaxOffset(cam, 0.7);
    const shift = (o) => cam.x - o.x;
    assert.ok(shift(far) < shift(mid) && shift(mid) < shift(near));
    assert.deepEqual(parallaxOffset({ x: 0, y: 0 }, 0.15), { x: 0, y: 0 });
});

test("markup renders map, upright labels, and three scenery depth layers", () => {
    const map = mapMarkup(), labels = labelsMarkup(), scenery = sceneryMarkup();
    assert.ok(map.length > 1000 && labels.length > 100);
    for (const layer of ["far", "mid", "near"]) assert.ok(scenery[layer].length > 100, `${layer} layer`);
    for (const label of LABELS) assert.ok(labels.includes(label.text));
    assert.doesNotMatch(labels, /rotate\(/, "labels stay upright");
});
