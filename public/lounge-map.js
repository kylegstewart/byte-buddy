// The Lounge office map: the floor plan (rotated 180°) as a tile grid, collision, the dead-zone camera, and the Indianapolis scenery.
// Grid codes: # wall, B window, D doorway, R couch, N desk, S counter, c chair, . floor, o open outdoors (scenery shows), x rooftop.
export const TILE = 20;
export const GRID = [
    "oooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooo",
    "oooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooo",
    "oooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooo",
    "oooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooo",
    "oooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooo",
    "oooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooo",
    "oooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooo",
    "oooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooo",
    "oooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooo",
    "oooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooo",
    "oooooooooooooooooooooooooooBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBooooooooooooBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBoooooooooooooooooooooooooo",
    "oooooooooooooooooooooooooooBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBooooooooooooBBBBBBBBBBBBBBBBBBBBBBBBBB#BBBBBBBB#BBBBBBBBBBBoooooooooooooooooooooooooo",
    "oooooooooooooooooooooooooooB......NNNNNNNNN....NNNNNNNNN....NNNNNNNNN...BooooooooooooBB........................#......NN#NN.......BBoooooooooooooooooooooooooo",
    "oooooooooooooooooooooooooooB......NNNNNNNNN....NNNNNNNNN....NNNNNNNNN...BooooooooooooBB........................#......NN#NN.......BBoooooooooooooooooooooooooo",
    "oooooooooooooooooooooooooooB.......ccNNNNc.......cNNNNc.......cNNNNc....BooooooooooooBB...cc.cc..c...c...c.....#....c.NN#NNcc.....BBoooooooooooooooooooooooooo",
    "oooooooooooooooooooooooooooB......NNNNNNNNN....NNNNNNNNN....NNNNNNNNN...BBBBBBBBBBBBBBB...NNNNNNNNNNNNNNNNN....#..NNNNNN#NNNNN....BBoooooooooooooooooooooooooo",
    "oooooooooooooooooooooooooooB......NNNNNNNNN....NNNNNNNNN....NNNNNNNNN...D..NNN.NN.NNN##...NNNNNNNNNNNNNNNNN....#..NNNNNN#NNNNN....BBoooooooooooooooooooooooooo",
    "oooooooooooooooooooooooooooB......NNNNNNNNN....NNNNNNNNN....NNNNNNNNN...D..NNN.NN.NNN##..cNNNNNNNNNNNNNNNNNcc..#..NNNNNN#NNNNN....BBoooooooooooooooooooooooooo",
    "oooooooooooooooooooooooooooB.......ccNNNNc.......cNNNNc......ccNNNNc....D............##...NNNNNNNNNNNNNNNNNc...#..NNNNNN#NNNNN....BBoooooooooooooooooooooooooo",
    "ooooooooooooooBBBBBBBBBBBBBB.......ccNNNNc.......cNNNNc......ccNNNNc....#............##...NNNNNNNNNNNNNNNNN....#........#.........BBBBBBBBBBBBBBBooooooooooooo",
    "ooooooooooooooBBBBBBBBBBBBBB......NNNNNNNNN....NNNNNNNNN....NNNNNNNNN...#SSSSSSSSSSSS##....cc.c..cc..cc..c.....#........#.........##BBBBBBBBBBBBBooooooooooooo",
    "ooooooooooooooB...................NNNNNNNNN....NNNNNNNNN....NNNNNNNNN...#SSSSSSSSSSSS##........................#........#.....RRRR##NRRRRRRRNNNNBooooooooooooo",
    "ooooooooooooooB...................NNNNNNNNN....NNNNNNNNN....NNNNNNNNN...#SSSSSSSSSSSS##........................#........#.....RRRR##NN......NNNNBooooooooooooo",
    "ooooooooooooooB...NNNNNNNN.........ccNNNNc.......cNNNNc......ccNNNNc....###############DDDDD######################DDDD######DDD#####NN......NNNNBooooooooooooo",
    "ooooooooooooooB...NNNNNNNN........NNNNNNNNN....NNNNNNNNN....NNNNNNNNN...#.........................................................##NN......NNN.Booooooooooooo",
    "ooooooooooooooB...NNNNNNNN........NNNNNNNNN....NNNNNNNNN....NNNNNNNNN...#.........................................................##NN..........Booooooooooooo",
    "ooooooooooooooB....cNNNNcc........NNNNNNNNN....NNNNNNNNN....NNNNNNNNN...#.........................................................##NN..........Booooooooooooo",
    "ooooooooooooooB...NNNNNNNN.........ccNNNNc.....NNNNNNNNN....NNNNNNNNN...#.........................................................##NNNNNNN.....Booooooooooooo",
    "ooooooooooooooB...NNNNNNNN.........ccNNNNc.......cNNNNc......ccNNNNc....#............########DDDD####DDD###############...##########NNNNNNN.....Booooooooooooo",
    "oBBBBBBBBBBBBBB...NNNNNNNN...........NNNN.........NNNN.........NNNN.....#............##...........#........#..........D...D.......##NNNNNNN##DDD#BBBBBBBBBBBBB",
    "oB................ccNNNNcc..............................................#............##NNNNNNN....#........#..........D...D.SSSSS.##NNNNNNN#....#NN.......RRBB",
    "oB................ccNNNNcc..............................................#............##NNNNNNN....#...NNNNN#..........D...D.SSSSS.##########....#NNc......RRBB",
    "oB..NNNNNNNNN.....NNNNNNNN..............................................D............##NNNNNNN....#...NNNNNN..........#...#.SSSSS.##............#NNcc.....RRBB",
    "oB..NNNNNNNNN.....NNNNNNNN..............................................D............##..c........#....ccNNN...SSSSSS##...#.SSSSS.##......RRR...#NNNNNN...RRBB",
    "oB..NNNNNNNNN.....NNNNNNNN..............................................D............##...........#......NNN...SSSSSS##...#.......##..NRRNRRR...#NNNNNN...RRBB",
    "oB...ccNNNNcc......cNNNNcc..........#DDDD###################################DDDDDD#####################################DDD##########..NRRNRRR...#NNNNNN...RRBB",
    "oB..NNNNNNNNN.....NNNNNNNN.......NNN#DDDD###################################DDDDDD#####################################DDD##########......RRR...#.........RRBB",
    "oB..NNNNNNNNN.....NNNNNNNN.......NNN#.....................................................................................D..........RRRRRR.....D.........RRBB",
    "oB..NNNNNNNNN.....NNNNNNNN.......NNN#.....................................................................................D..........RRRRRR.....D....NNN....BB",
    "oB...ccNNNNcc......cNNNNc........NNN#.....................................................................................D..........RRRRRR.....D....NNNN...BB",
    "oB...ccNNNNcc......cNNNNc........NNN#.....................................................................................#.....................D....NNNN...BB",
    "oB.....NNNN.........NNNN.........NNN#####################################.............#####################################.....................D....NNNN...BB",
    "oB...............................NNN#xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx#.............#xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx#.....................#.....NN....BB",
    "oB..................................#xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx#.............#xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx#.....................#############B",
    "oB..................................#xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx#.............#xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx#.................................BB",
    "oB####DDD#DDD######......##DDDD######xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx#.............#xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx#.................................BB",
    "oB.......##.......#......#..........#xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx#.............#xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx#####DDD######DDD#####DDDD#####DDDDB",
    "oB.......##.......#......#..........#xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx#.............#xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx#.......#........#........#.......BB",
    "oB.......##.......#RRRR..#.ccNNNNc..#xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx#.............#xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx#.......#........#........#.......BB",
    "oB..NNNNN##..NNNNN#RRRR..#.cNNNNNN..#xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx#.............#xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx#.......#........#........#.......BB",
    "oB..NNNNNN...NNNNN#RRRR..#..NNNNNN..#xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx#.............#xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx#NNNNN..#NNNNN...#NNNNN...#NNNNN..BB",
    "oB..NNNNNN...NNNNN#RRRR..#..NNNNNN..#xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx#.............#xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx#NNNNN..NNNNNN...#NNNNN...#NNNNN..BB",
    "oB..NNNNN##..NNNNN#RRRR..#..NNNNNc..#xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx#.............#xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx#NNNNN..#NNNNN...#NNNNN...#NNNNN..BB",
    "oB....cc.##....cc.#RRRR..#..c.NNcc..#xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx#.............#xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx#.cc....#.cc.....#.cc.....#NNcc...BB",
    "oB.......##.......#RRRR..#..........#xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx#.............#xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx#.......#........#........#NN.....BB",
    "o##################......#..........#xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx#.............#xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx#.......#........#........#NN.....BB",
    "x####################################xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx#.............#xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx###################################B",
    "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx#.............#xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
    "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx#.............#xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
    "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx#.............#xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
    "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx#.............#xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
    "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx#.............#xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
    "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx#.............#xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
    "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx###############xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
];
export const ROWS = GRID.length;
export const COLS = GRID[0].length;
export const WORLD = { width: COLS * TILE, height: ROWS * TILE };
export const SPAWN = { x: 1600, y: 780 };
export const DEAD_ZONE = { x: 0.6, y: 0.6 };
export const LABELS = [
    { text: "Bullpen", x: 950, y: 375 },
    { text: "Bullpen", x: 350, y: 635 },
    { text: "Offices", x: 310, y: 975 },
    { text: "Offices", x: 2730, y: 995 },
    { text: "Conference", x: 1970, y: 295 },
    { text: "Server Room", x: 1570, y: 395 },
    { text: "Standup", x: 2470, y: 395 },
    { text: "Break Room", x: 2090, y: 615 },
    { text: "Wellness", x: 2830, y: 655 },
    { text: "Elevators", x: 1590, y: 1035 },
];

const SOLID = new Set(["#", "B", "R", "N", "S", "x", "o"]);
const FOOT = { x: 8, y: 4 };
const MAX_STEP = 14;
const SLIDE = 6;
const EPSILON = 0.01;

export function tileAt(col, row) {
    return row >= 0 && row < ROWS && col >= 0 && col < COLS ? GRID[row][col] : "#";
}

/** True when a buddy's feet at (x, y) overlap a wall, window, solid furniture, or leave the world. */
export function isSolid(x, y) {
    if (x - FOOT.x < 0 || y - FOOT.y < 0 || x + FOOT.x > WORLD.width || y + FOOT.y > WORLD.height) return true;
    const c0 = Math.floor((x - FOOT.x) / TILE), c1 = Math.floor((x + FOOT.x - EPSILON) / TILE);
    const r0 = Math.floor((y - FOOT.y) / TILE), r1 = Math.floor((y + FOOT.y - EPSILON) / TILE);
    for (let row = r0; row <= r1; row++) for (let col = c0; col <= c1; col++) if (SOLID.has(tileAt(col, row))) return true;
    return false;
}

function stepAxis(pos, step, axis) {
    const other = axis === "x" ? "y" : "x";
    const half = FOOT[axis];
    const next = { ...pos, [axis]: pos[axis] + step };
    if (!isSolid(next.x, next.y)) return next;
    const edge = step > 0 ? Math.floor((next[axis] + half) / TILE) * TILE - half - EPSILON : (Math.floor((next[axis] - half) / TILE) + 1) * TILE + half;
    const flush = { ...pos, [axis]: step > 0 ? Math.max(pos[axis], edge) : Math.min(pos[axis], edge) };
    const held = isSolid(flush.x, flush.y) ? { ...pos } : flush;
    // Nudge around corners so a buddy brushing a door frame slides through instead of sticking.
    for (let offset = 1; offset <= SLIDE; offset++) {
        for (const sign of [-1, 1]) {
            const shifted = pos[other] + sign * offset;
            const probe = { [axis]: pos[axis] + step, [other]: shifted };
            if (!isSolid(probe.x, probe.y) && !isSolid(axis === "x" ? pos.x : shifted, axis === "y" ? pos.y : shifted)) {
                return { ...held, [other]: pos[other] + sign * Math.min(offset, Math.abs(step)) };
            }
        }
    }
    return held;
}

/** Moves the feet by (dx, dy), resolving x then y in small steps so walls block and edges slide. */
export function moveWithCollision(pos, dx, dy) {
    let current = { x: pos.x, y: pos.y };
    const steps = Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)) / MAX_STEP));
    for (let i = 0; i < steps; i++) {
        if (dx) current = stepAxis(current, dx / steps, "x");
        if (dy) current = stepAxis(current, dy / steps, "y");
    }
    return current;
}

/** Closest walkable tile center to a point, for spawns or stale positions that land inside furniture. */
export function nearestWalkable(point) {
    const col = Math.floor(point.x / TILE), row = Math.floor(point.y / TILE);
    const center = (c, r) => ({ x: c * TILE + TILE / 2, y: r * TILE + TILE / 2 });
    if (!isSolid(point.x, point.y)) return { x: point.x, y: point.y };
    for (let radius = 0; radius < Math.max(COLS, ROWS); radius++) {
        let best = null, bestDistance = Infinity;
        for (let r = row - radius; r <= row + radius; r++) {
            for (let c = col - radius; c <= col + radius; c++) {
                if (Math.max(Math.abs(r - row), Math.abs(c - col)) !== radius) continue;
                const p = center(c, r);
                if (isSolid(p.x, p.y)) continue;
                const distance = Math.hypot(p.x - point.x, p.y - point.y);
                if (distance < bestDistance) { best = p; bestDistance = distance; }
            }
        }
        if (best) return best;
    }
    return { ...SPAWN };
}

/** World units visible in a panel of the given pixel size; zooms so the office reads at small sizes. */
export function viewSize(panelWidth, panelHeight) {
    if (!(panelWidth > 0) || !(panelHeight > 0)) return { width: 720, height: 450 };
    const width = Math.min(WORLD.width, Math.min(720, Math.max(320, panelWidth / 1.6)));
    return { width: Math.round(width), height: Math.round(Math.min(WORLD.height, width * panelHeight / panelWidth)) };
}

export function clampCamera(cam, view) {
    return {
        x: Math.min(Math.max(0, WORLD.width - view.width), Math.max(0, cam.x)),
        y: Math.min(Math.max(0, WORLD.height - view.height), Math.max(0, cam.y)),
    };
}

/** Smallest camera shift that keeps the target inside the central dead zone, clamped to the world. */
export function cameraFollow(cam, target, view, deadZone = DEAD_ZONE) {
    const marginX = view.width * (1 - deadZone.x) / 2, marginY = view.height * (1 - deadZone.y) / 2;
    let { x, y } = cam;
    if (target.x < x + marginX) x = target.x - marginX;
    else if (target.x > x + view.width - marginX) x = target.x - view.width + marginX;
    if (target.y < y + marginY) y = target.y - marginY;
    else if (target.y > y + view.height - marginY) y = target.y - view.height + marginY;
    return clampCamera({ x, y }, view);
}

export function centerCamera(target, view) {
    return clampCamera({ x: target.x - view.width / 2, y: target.y - view.height / 2 }, view);
}

/** Frame-rate independent easing toward the goal; snaps once close so the camera settles. */
export function smoothCamera(cam, goal, dt, rate = 10) {
    const k = 1 - Math.exp(-rate * dt);
    const ease = (from, to) => (Math.abs(to - from) < 0.05 ? to : from + (to - from) * k);
    return { x: ease(cam.x, goal.x), y: ease(cam.y, goal.y) };
}

/** Translation for a scenery layer; factor 0 stays fixed on screen (infinitely far), 1 moves with the world. */
export function parallaxOffset(cam, factor) {
    return { x: cam.x * (1 - factor), y: cam.y * (1 - factor) };
}

function runs(test) {
    const rects = [];
    const open = new Map();
    for (let row = 0; row < ROWS; row++) {
        const seen = new Set();
        for (let col = 0; col < COLS;) {
            if (!test(GRID[row][col], col, row)) { col++; continue; }
            const start = col;
            while (col < COLS && test(GRID[row][col], col, row)) col++;
            const key = `${start}:${col}`;
            const rect = open.get(key);
            if (rect && rect.r1 === row) rect.r1 = row + 1;
            else { const fresh = { c0: start, c1: col, r0: row, r1: row + 1 }; rects.push(fresh); open.set(key, fresh); }
            seen.add(key);
        }
        for (const key of [...open.keys()]) if (!seen.has(key)) open.delete(key);
    }
    return rects.map(({ c0, c1, r0, r1 }) => ({ x: c0 * TILE, y: r0 * TILE, w: (c1 - c0) * TILE, h: (r1 - r0) * TILE }));
}

const rect = ({ x, y, w, h }, attrs) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" ${attrs}/>`;

function furniture(code, base, top, extra = () => "") {
    return runs((cell) => cell === code).map((r) => rect(r, `fill="${base}"`) + rect({ ...r, h: Math.min(5, r.h) }, `fill="${top}"`) + extra(r)).join("");
}

function monitors(r) {
    let out = "";
    const horizontal = r.w >= r.h;
    const length = horizontal ? r.w : r.h;
    for (let at = TILE; at < length; at += TILE * 3) {
        const x = horizontal ? r.x + at - 5 : r.x + r.w / 2 - 5;
        const y = horizontal ? r.y + r.h / 2 - 4 : r.y + at - 4;
        out += `<rect x="${x}" y="${y}" width="10" height="6" fill="#262c38"/><rect x="${x + 1}" y="${y + 1}" width="8" height="3" fill="#5fa8d3"/>`;
    }
    return out;
}

function windows() {
    return runs((cell) => cell === "B").map((r) => {
        let mullions = "";
        if (r.w >= r.h) for (let x = r.x + TILE * 3; x < r.x + r.w; x += TILE * 3) mullions += `<rect x="${x - 1}" y="${r.y}" width="2" height="${r.h}" fill="#8da2b8"/>`;
        else for (let y = r.y + TILE * 3; y < r.y + r.h; y += TILE * 3) mullions += `<rect x="${r.x}" y="${y - 1}" width="${r.w}" height="2" fill="#8da2b8"/>`;
        return rect(r, 'fill="rgba(170,210,255,.22)" stroke="#8da2b8" stroke-width="2"') + mullions;
    }).join("");
}

function elevatorDoors() {
    let out = "";
    for (const row of [44, 48, 52, 56]) {
        for (const [x, face] of [[73 * TILE - 6, 0], [86 * TILE, 1]]) {
            out += `<rect x="${x}" y="${row * TILE}" width="6" height="${TILE * 2}" fill="#aab3bd"/>`;
            out += `<rect x="${x + (face ? 0 : 4)}" y="${row * TILE + TILE - 0.5}" width="2" height="1" fill="#5b636d"/>`;
            out += `<rect x="${face ? x + 7 : x - 4}" y="${row * TILE + TILE - 3}" width="3" height="6" fill="#ffd84a" opacity=".7"/>`;
        }
    }
    return out;
}

/** Static office artwork in world coordinates. Opaque everywhere except open outdoors and window glass. */
export function mapMarkup() {
    const floor = runs((cell) => !"oxB#".includes(cell));
    const walls = runs((cell) => cell === "#");
    const faces = runs((cell, col, row) => cell === "#" && !"#xo".includes(tileAt(col, row + 1)));
    const chairs = [];
    for (let row = 0; row < ROWS; row++) for (let col = 0; col < COLS; col++) {
        if (GRID[row][col] === "c") chairs.push(`<rect x="${col * TILE + 4}" y="${row * TILE + 4}" width="12" height="12" rx="3" fill="#3f8f4f"/><rect x="${col * TILE + 6}" y="${row * TILE + 5}" width="8" height="3" rx="1" fill="#5fb06f"/>`);
    }
    return [
        '<defs><pattern id="loungeFloor" width="40" height="40" patternUnits="userSpaceOnUse"><rect width="40" height="40" fill="#cfc4ae"/><path d="M0 0H40M0 20H40M0 0V20M20 20V40" stroke="#bfb39b" stroke-width="1" fill="none"/></pattern></defs>',
        runs((cell) => cell === "x").map((r) => rect(r, 'fill="#20242c"')).join(""),
        floor.map((r) => rect(r, 'fill="url(#loungeFloor)"')).join(""),
        runs((cell) => cell === "D").map((r) => rect(r, 'fill="#ffd84a" opacity=".18"')).join(""),
        furniture("S", "#9aa0a8", "#c3c8ce"),
        furniture("N", "#8a5a36", "#a8744a", monitors),
        runs((cell) => cell === "R").map((r) => rect(r, 'rx="4" fill="#b0413e"') + rect({ x: r.x + 2, y: r.y + 2, w: r.w - 4, h: Math.min(6, r.h - 4) }, 'rx="2" fill="#c95a55"')).join(""),
        chairs.join(""),
        walls.map((r) => rect(r, 'fill="#3a3f4b"')).join(""),
        faces.map((r) => rect({ ...r, y: r.y + r.h - 6, h: 6 }, 'fill="#2a2e37"')).join(""),
        windows(),
        elevatorDoors(),
    ].join("");
}

export function labelsMarkup() {
    return LABELS.map((label) => `<text class="lounge-room-label" x="${label.x}" y="${label.y}" text-anchor="middle">${label.text}</text>`).join("");
}

function seeded(seed) {
    return () => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t ^= t + Math.imul(t ^ (t >>> 7), 61 | t); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

function litWindows(x, y, w, h, random, color = "#ffe9a8") {
    let out = "";
    for (let wy = y + 6; wy < y + h - 4; wy += 8) for (let wx = x + 4; wx < x + w - 4; wx += 7) if (random() < 0.28) out += `<rect x="${wx}" y="${wy}" width="3" height="4" fill="${color}" opacity=".8"/>`;
    return out;
}

const HORIZON = 200;

/** Downtown Indianapolis in three parallax layers (layer coordinates; the view applies parallaxOffset). */
export function sceneryMarkup() {
    const random = seeded(317);
    let far = `<defs><linearGradient id="loungeSky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#5d9ed8"/><stop offset=".55" stop-color="#a9d2ef"/><stop offset="1" stop-color="#f2dcb5"/></linearGradient></defs>`;
    far += `<rect x="-400" y="-400" width="2400" height="${HORIZON + 400}" fill="url(#loungeSky)"/><rect x="-400" y="${HORIZON - 15}" width="2400" height="900" fill="#b9c6cf"/>`;
    far += `<circle cx="980" cy="70" r="22" fill="#fff4c4" opacity=".9"/>`;
    for (const [cx, cy, s] of [[120, 50, 1], [420, 90, 0.8], [700, 40, 1.2], [1250, 80, 0.9], [1550, 55, 1.1]]) {
        far += `<g fill="#fff" opacity=".75"><rect x="${cx}" y="${cy}" width="${60 * s}" height="${10 * s}" rx="5"/><rect x="${cx + 12 * s}" y="${cy - 7 * s}" width="${30 * s}" height="${10 * s}" rx="5"/></g>`;
    }
    for (let x = -300; x < 1900; x += 18 + random() * 24) {
        const h = 12 + random() * 34, w = 14 + random() * 22;
        far += `<rect x="${Math.round(x)}" y="${Math.round(HORIZON - 15 - h)}" width="${Math.round(w)}" height="${Math.round(h)}" fill="#9fb1bf"/>`;
    }

    let mid = "";
    const landmarks = [
        { x: 250, w: 90, h: 105, fill: "#3d6f9e", glass: true },
        { x: 420, w: 40, h: 120, fill: "#d9d3c7" },
        { x: 620, w: 46, h: 165, fill: "#6f8fa8", glass: true },
        { x: 760, w: 44, h: 140, fill: "#8996a3", spires: true },
        { x: 960, w: 70, h: 90, fill: "#7d8a96" },
        { x: 1110, w: 54, h: 112, fill: "#a7a093" },
    ];
    const occupied = (x, w) => landmarks.some((l) => x < l.x + l.w + 6 && x + w > l.x - 6) || (x < 1560 && x + w > 1290) || (x < 580 && x + w > 552);
    for (let x = -200; x < 2100; x += 26 + random() * 30) {
        const w = 24 + random() * 34, h = 30 + random() * 70;
        if (occupied(x, w)) continue;
        const shade = ["#7c8794", "#8a8f99", "#6f7a86", "#958e84"][Math.floor(random() * 4)];
        mid += `<rect x="${Math.round(x)}" y="${Math.round(HORIZON - h)}" width="${Math.round(w)}" height="${Math.round(h)}" fill="${shade}"/>${litWindows(Math.round(x), Math.round(HORIZON - h), Math.round(w), Math.round(h), random)}`;
    }
    for (const l of landmarks) {
        const top = HORIZON - l.h;
        mid += `<rect x="${l.x}" y="${top}" width="${l.w}" height="${l.h}" fill="${l.fill}"/>`;
        if (l.glass) for (let y = top + 6; y < HORIZON; y += 9) mid += `<rect x="${l.x + 3}" y="${y}" width="${l.w - 6}" height="2" fill="#a9d2ef" opacity=".45"/>`;
        else mid += litWindows(l.x, top, l.w, l.h, random);
        if (l.spires) mid += `<rect x="${l.x + 6}" y="${top - 30}" width="4" height="30" fill="${l.fill}"/><rect x="${l.x + l.w - 10}" y="${top - 30}" width="4" height="30" fill="${l.fill}"/><rect x="${l.x + 4}" y="${top - 4}" width="${l.w - 8}" height="4" fill="#6c7883"/>`;
    }
    // Salesforce Tower crown and the Soldiers' and Sailors' Monument on the Circle.
    mid += `<rect x="626" y="${HORIZON - 175}" width="34" height="10" fill="#52728c"/><rect x="641" y="${HORIZON - 190}" width="4" height="15" fill="#52728c"/>`;
    mid += `<rect x="552" y="${HORIZON - 12}" width="28" height="12" fill="#c8bfae"/><polygon points="559,${HORIZON - 12} 573,${HORIZON - 12} 568,${HORIZON - 90} 564,${HORIZON - 90}" fill="#d8cfbd"/><rect x="563" y="${HORIZON - 100}" width="6" height="10" fill="#c9a94a"/>`;
    // Lucas Oil Stadium with its retractable roof.
    mid += `<rect x="1300" y="${HORIZON - 34}" width="250" height="34" fill="#a2634a"/><path d="M1296 ${HORIZON - 34} Q1425 ${HORIZON - 64} 1554 ${HORIZON - 34} Z" fill="#c7ccd1"/><rect x="1418" y="${HORIZON - 58}" width="14" height="24" fill="#8d959c"/>`;

    let near = `<rect x="-400" y="${HORIZON + 5}" width="3600" height="1400" fill="#4a4f57"/>`;
    for (let y = HORIZON + 30; y < 1500; y += 90) {
        for (let x = -360; x < 3100; x += 110) {
            const roof = ["#6b7280", "#7a6f64", "#5f6b73", "#857a6a"][Math.floor(random() * 4)];
            near += `<rect x="${x}" y="${y}" width="86" height="66" fill="${roof}"/><rect x="${x + 4}" y="${y + 4}" width="${20 + Math.floor(random() * 40)}" height="${12 + Math.floor(random() * 20)}" fill="#9aa1a9" opacity=".5"/>`;
            if (random() < 0.25) near += `<rect x="${x + 10}" y="${y + 40}" width="16" height="16" rx="8" fill="#4f7a43"/>`;
        }
    }
    for (let x = -400; x < 3200; x += 34 + random() * 40) {
        const w = 30 + random() * 40, h = 14 + random() * 22;
        near += `<rect x="${Math.round(x)}" y="${Math.round(HORIZON + 5 - h)}" width="${Math.round(w)}" height="${Math.round(h)}" fill="#5a616b"/><rect x="${Math.round(x)}" y="${Math.round(HORIZON + 5 - h)}" width="${Math.round(w)}" height="3" fill="#737b86"/>`;
    }
    return { far, mid, near };
}
