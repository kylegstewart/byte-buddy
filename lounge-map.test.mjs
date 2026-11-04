import test from "node:test";
import assert from "node:assert/strict";
import {
    TILE, GRID, ROWS, COLS, WORLD, SPAWN, DEAD_ZONE, LABELS, ZONES, PROPS, PARALLAX,
    tileAt, isSolid, moveWithCollision, nearestWalkable,
    viewSize, clampCamera, cameraFollow, centerCamera, smoothCamera, parallaxOffset, labelsMarkup,
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

function zoneCentroid(zone) {
    let x = 0, y = 0, n = 0;
    for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) if (ZONES[r][c] === zone) { x += c; y += r; n++; }
    return { x: x / n, y: y / n, n };
}

test("world is a rectangular grid larger than the view and matches the relay's bounds", () => {
    assert.ok(GRID.every((row) => row.length === COLS));
    assert.equal(ZONES.length, ROWS);
    assert.deepEqual(WORLD, { width: COLS * TILE, height: ROWS * TILE });
    assert.deepEqual(WORLD, { width: 3160, height: 1280 }, "lounge-server clamps moves to 3160x1280");
    const view = viewSize(1200, 700);
    assert.ok(WORLD.width > view.width * 2 && WORLD.height > view.height * 2);
    assert.equal(tileAt(-1, 0), "#");
    assert.equal(tileAt(0, ROWS), "#");
});

test("rotated layout puts the main window wall along the top", () => {
    const count = (rows) => rows.reduce((n, row) => n + [...row].filter((ch) => ch === "B").length, 0);
    const band = Math.floor(ROWS / 4);
    assert.ok(count(GRID.slice(0, band)) > count(GRID.slice(-band)) * 2, "windows concentrate in the top quarter");
    assert.ok(GRID.slice(0, 10).every((row) => /^o+$/.test(row)), "open sky beyond the south glass");
});

test("the floor plan is rotated 180 degrees, not mirrored", () => {
    const bullpen = zoneCentroid("bullpen"), lobby = zoneCentroid("lobby"), conference = zoneCentroid("conference");
    const breakRoom = zoneCentroid("break"), standup = zoneCentroid("standup"), server = zoneCentroid("server");
    // On the plan the bullpen is east (right) and the elevators north; looking south puts them left and at the bottom.
    assert.ok(bullpen.x < COLS / 2, "bullpen on the left");
    assert.ok(lobby.y > ROWS * 0.7 && Math.abs(lobby.x - COLS / 2) < 10, "elevators at the bottom middle");
    assert.ok(breakRoom.x < conference.x, "break room between the bullpen and the conference room");
    assert.ok(standup.x < COLS / 4 && standup.y > ROWS * 0.7, "standup room in the bottom-left corner");
    assert.ok(server.x > COLS * 0.75, "server room in the west wing on the right");
});

test("the relay's spawn band lands in the open corridor", () => {
    for (let y = 750; y <= 810; y += 10) for (let x = 760; x <= 2420; x += 10) assert.equal(isSolid(x, y), false, `spawn ${x},${y}`);
    const reachable = reachableTiles();
    assert.ok(reachable.has(`${Math.floor(2420 / TILE)},${Math.floor(750 / TILE)}`));
});

test("spawn is walkable and every labelled room is reachable from it", () => {
    assert.equal(isSolid(SPAWN.x, SPAWN.y), false);
    const reachable = reachableTiles();
    assert.ok(LABELS.length >= 10);
    for (const label of LABELS) {
        const key = `${Math.floor(label.x / TILE)},${Math.floor(label.y / TILE)}`;
        assert.ok(reachable.has(key), `${label.text} at ${label.x},${label.y} is reachable`);
    }
});

test("wall faces are solid strips directly below walls and windows", () => {
    let faces = 0;
    for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) {
        if (GRID[r][c] !== "F") continue;
        faces++;
        assert.ok("#B".includes(GRID[r - 1][c]), `face at ${c},${r} hangs under a wall`);
        const p = center(c, r);
        assert.equal(isSolid(p.x, p.y), true);
    }
    assert.ok(faces > 300);
});

test("chairs stay walkable and office chairs face a desk", () => {
    const chairs = PROPS.filter((prop) => prop.type === "chair");
    assert.ok(chairs.length >= 80, `${chairs.length} chairs`);
    const step = { n: [0, -1], s: [0, 1], e: [1, 0], w: [-1, 0] };
    for (const chair of chairs) {
        // Chairs centred between two tiles (bistro stools, guest pairs) belong to the tile up and to the left.
        const c = Math.floor(chair.x - 1e-6), r = Math.floor(chair.y - 1e-6);
        assert.equal(GRID[r][c], "c", `chair at ${c},${r}`);
        if (chair.style !== "office") continue;
        const [dc, dr] = step[chair.facing];
        assert.equal(GRID[r + dr][c + dc], "N", `office chair at ${c},${r} faces its desk`);
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
    assert.ok(crossed >= 30, `crossed ${crossed} door tiles`);
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

test("camera follows before the buddy reaches the outer screen edges", () => {
    const view = { width: 720, height: 450 };
    const cam = centerCamera(SPAWN, view);
    const target = { x: SPAWN.x + view.width * 0.2, y: SPAWN.y + view.height * 0.2 };
    const moved = cameraFollow(cam, target, view);
    assert.ok(moved.x > cam.x, "horizontal tracking starts within 20% of center");
    assert.ok(moved.y > cam.y, "vertical tracking starts within 20% of center");
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

test("parallax: far layers pan less than near layers and the horizon holds near eye level", () => {
    const cam = { x: 1000, y: 400 };
    const shift = (layer) => cam.x - parallaxOffset(cam, layer).x;
    const lift = (layer) => cam.y - parallaxOffset(cam, layer).y;
    const [far, mid, near] = PARALLAX;
    assert.deepEqual(PARALLAX.map((layer) => layer.id), ["loungeSceneryFar", "loungeSceneryMid", "loungeSceneryNear"]);
    assert.ok(shift(far) < shift(mid) && shift(mid) < shift(near), "horizontal depth order");
    assert.ok(lift(far) <= lift(mid) && lift(mid) <= lift(near), "vertical depth order");
    for (const layer of PARALLAX) assert.ok(layer.y < 0.25 && layer.y < layer.x, `${layer.id} keeps a small vertical drift`);
    assert.deepEqual(parallaxOffset({ x: 0, y: 0 }, far), { x: 0, y: 0 });
    assert.deepEqual(parallaxOffset({ x: 100, y: 100 }, 0.5), { x: 50, y: 50 }, "a plain number still applies to both axes");
});

test("labels render upright with every room name", () => {
    const labels = labelsMarkup();
    for (const label of LABELS) assert.ok(labels.includes(label.text));
    assert.doesNotMatch(labels, /rotate\(/, "labels stay upright");
    for (const name of ["Bullpen", "Conference", "Break Room", "Wellness", "Server Room", "Standup", "Elevators", "Lounge", "Offices"]) {
        assert.ok(LABELS.some((label) => label.text === name), name);
    }
});
