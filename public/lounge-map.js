// The Lounge office map: the team floor plan as a tile grid, collision, the dead-zone camera, and parallax helpers.
// The plan below is authored north-up, exactly like the floor plan drawing, then rotated 180° so the camera looks south,
// out the main window wall. Pixel art for the map and the Indianapolis skyline lives in lounge-art.js.
//
// Grid codes: # wall, B window, D doorway, F wall face (the visible, solid front of a wall), . floor, c chair (walkable),
// N desk or table top, S counter, K cabinet or shelf, R couch or armchair, T round or low table, P plant,
// M machine (server rack, fridge, printer), o open outdoors (scenery shows through), x building core (other tenants).
export const TILE = 20;
const PLAN_COLS = 158;
const PLAN_ROWS = 63;
export const ROWS = 64;
export const COLS = PLAN_COLS;
export const WORLD = { width: COLS * TILE, height: ROWS * TILE };
export const SPAWN = { x: 1600, y: 780 };
export const DEAD_ZONE = { x: 0.3, y: 0.3 };

const FLIP = { n: "s", s: "n", e: "w", w: "e" };

/** Builds the north-up plan: cells, floor zones, and furniture props, all in plan tile coordinates. */
function buildPlan() {
    const cells = Array.from({ length: PLAN_ROWS }, () => Array(PLAN_COLS).fill("x"));
    const zones = Array.from({ length: PLAN_ROWS }, () => Array(PLAN_COLS).fill(""));
    const props = [];
    const box = (x0, y0, x1, y1, ch) => {
        for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (y >= 0 && y < PLAN_ROWS && x >= 0 && x < PLAN_COLS) cells[y][x] = ch;
    };
    const room = (zone, x0, y0, x1, y1) => {
        box(x0, y0, x1, y1, ".");
        for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) zones[y][x] = zone;
    };
    const wall = (x0, y0, x1, y1) => box(x0, y0, x1, y1, "#");
    const door = (x0, y0, x1, y1) => box(x0, y0, x1, y1, "D");
    const glass = (x0, y0, x1, y1) => box(x0, y0, x1, y1, "B");
    // Solid furniture fills whole tiles; rect props are inclusive plan tiles.
    const item = (type, ch, x0, y0, x1, y1, extra = {}) => { box(x0, y0, x1, y1, ch); props.push({ type, x0, y0, x1, y1, ...extra }); };
    const desk = (x0, y0, x1, y1, material = "walnut") => item("surface", "N", x0, y0, x1, y1, { material });
    const counter = (x0, y0, x1, y1) => item("surface", "S", x0, y0, x1, y1, { material: "stone" });
    const cabinet = (x0, y0, x1, y1, kind, facing = "n") => item(kind, "K", x0, y0, x1, y1, { facing });
    const couch = (x0, y0, x1, y1, facing, color) => item("couch", "R", x0, y0, x1, y1, { facing, color });
    const machine = (x0, y0, x1, y1, kind, facing = "n") => item(kind, "M", x0, y0, x1, y1, { facing });
    const plant = (x, y, kind = "fig") => item("plant", "P", x, y, x, y, { kind });
    const rug = (x0, y0, x1, y1, color) => props.push({ type: "rug", x0, y0, x1, y1, color });
    const decor = (type, x0, y0, x1, y1, extra = {}) => props.push({ type, x0, y0, x1, y1, ...extra });
    // Chairs and round tables use tile-center coordinates and may sit between tiles.
    const chair = (x, y, facing, style = "office") => {
        const tx = Math.round(x), ty = Math.round(y);
        if (cells[ty][tx] === ".") cells[ty][tx] = "c";
        props.push({ type: "chair", cx: x, cy: y, facing, style });
    };
    const roundTable = (x, y, r, style = "walnut") => {
        for (let ty = Math.floor(y - r); ty <= Math.ceil(y + r); ty++) for (let tx = Math.floor(x - r); tx <= Math.ceil(x + r); tx++) {
            if (Math.hypot(tx - x, ty - y) <= r + 0.05) cells[ty][tx] = "T";
        }
        props.push({ type: "roundTable", cx: x, cy: y, r, style });
    };

    // Rooms. Later rooms win where rectangles overlap; walls are carved afterwards.
    room("hall", 2, 17, 34, 20);
    room("lounge", 15, 17, 34, 33);
    for (const [x0, x1] of [[2, 9], [11, 18], [20, 26], [28, 34]]) room("office", x0, 8, x1, 15);
    room("office", 2, 22, 13, 33);
    room("office", 15, 35, 26, 42);
    room("office", 19, 33, 26, 34);
    room("server", 28, 28, 34, 34);
    room("hall", 36, 22, 121, 26);
    room("hall", 36, 28, 39, 35);
    room("wellness", 41, 28, 49, 34);
    room("office", 51, 28, 59, 34);
    room("office", 61, 28, 71, 34);
    room("hall", 73, 28, 84, 39);
    room("hall", 28, 36, 72, 39);
    room("office", 28, 41, 36, 51);
    room("office", 38, 41, 46, 51);
    room("conference", 48, 41, 71, 51);
    room("break", 73, 41, 84, 46);
    room("lobby", 73, 1, 84, 21);
    room("bullpen", 86, 28, 129, 51);
    room("bullpen", 123, 19, 155, 33);
    room("bullpen", 130, 34, 142, 42);
    room("standup", 123, 8, 131, 17);
    room("nook", 133, 8, 138, 18);
    room("office", 140, 8, 147, 17);
    room("office", 149, 8, 155, 17);

    // Exterior glazing (south, west and east faces), with structural pillars at every corner.
    const runs = [
        [1, 7, 1, 34], [1, 34, 14, 34], [14, 34, 14, 43], [14, 43, 27, 43], [27, 43, 27, 52], [27, 52, 72, 52],
        [72, 47, 72, 52], [72, 47, 85, 47], [85, 47, 85, 52], [85, 52, 130, 52], [130, 43, 130, 52], [130, 43, 143, 43],
        [143, 34, 143, 43], [143, 34, 156, 34], [156, 7, 156, 34],
    ];
    for (const run of runs) glass(...run);
    for (const [x0, y0, x1, y1] of runs) { wall(x0, y0, x0, y0); wall(x1, y1, x1, y1); }

    // Northwest offices, west office, lounge and southwest office.
    wall(1, 7, 35, 7);
    for (const x of [10, 19, 27]) wall(x, 7, x, 16);
    wall(1, 16, 35, 16);
    wall(35, 7, 35, 35);
    wall(1, 21, 14, 21);
    wall(14, 21, 14, 34);
    wall(14, 34, 18, 34);
    wall(18, 32, 18, 34);
    wall(18, 32, 27, 32);
    wall(27, 27, 27, 43);
    // Server room, corridor, wellness and middle offices.
    wall(27, 27, 35, 27);
    wall(27, 35, 35, 35);
    wall(35, 21, 72, 21);
    wall(85, 21, 122, 21);
    wall(35, 27, 122, 27);
    wall(122, 7, 122, 27);
    wall(40, 27, 40, 35);
    for (const x of [50, 60, 72]) wall(x, 27, x, 35);
    wall(40, 35, 72, 35);
    // South offices, conference and break room.
    wall(27, 40, 85, 40);
    wall(37, 40, 37, 52);
    wall(47, 40, 47, 52);
    wall(72, 40, 72, 47);
    wall(85, 27, 85, 47);
    // Elevator lobby.
    wall(72, 0, 72, 21);
    wall(85, 0, 85, 21);
    wall(72, 0, 85, 0);
    // Northeast standup room, couch nook and offices.
    wall(122, 7, 156, 7);
    wall(132, 7, 132, 18);
    wall(122, 18, 132, 18);
    wall(139, 7, 139, 18);
    wall(148, 7, 148, 18);
    wall(139, 18, 156, 18);

    // Doorways (yellow on the plan).
    door(2, 16, 4, 16); door(11, 16, 13, 16); door(20, 16, 22, 16); door(28, 16, 30, 16);
    door(14, 23, 14, 25);
    door(15, 34, 17, 34);
    door(35, 23, 35, 25);
    door(35, 32, 35, 33);
    door(40, 32, 40, 33);
    door(37, 27, 39, 27);
    door(76, 27, 81, 27);
    door(118, 27, 120, 27);
    door(55, 35, 57, 35); door(61, 35, 63, 35);
    door(32, 40, 34, 40); door(41, 40, 43, 40); door(67, 40, 70, 40);
    door(85, 28, 85, 30);
    door(85, 43, 85, 45);
    door(128, 18, 130, 18);
    door(145, 18, 147, 18); door(150, 18, 152, 18);

    // Open outdoors beyond the glass.
    box(0, 53, 157, 62, "o");
    box(0, 35, 13, 52, "o");
    box(14, 44, 26, 52, "o");
    box(73, 48, 84, 52, "o");
    box(131, 44, 143, 52, "o");
    box(144, 35, 157, 52, "o");
    box(0, 7, 0, 34, "o");
    box(157, 7, 157, 34, "o");

    // Northwest offices: desks against the east walls, chairs facing the windows like the plan.
    desk(8, 8, 9, 12); desk(5, 11, 7, 12);
    chair(6, 10, "s"); chair(6, 13, "n", "guest");
    cabinet(7, 14, 9, 14, "bookshelf");
    plant(2, 8, "snake");
    desk(13, 11, 18, 12, "oak");
    chair(16, 10, "s"); chair(15, 13, "n", "guest");
    cabinet(16, 14, 18, 14, "credenza");
    plant(11, 8);
    desk(22, 11, 26, 12);
    chair(24, 10, "s"); chair(24, 13, "n", "guest");
    plant(26, 14, "snake");
    cabinet(20, 8, 21, 8, "filing", "s");
    desk(30, 11, 34, 12, "oak");
    chair(32, 10, "s"); chair(32, 13, "n", "guest");
    cabinet(32, 14, 34, 14, "bookshelf");
    plant(28, 8);

    // West corner office: meeting table, couch on the glass, L-desk in the corner.
    roundTable(7, 24, 1.5);
    chair(4.6, 24, "e", "guest"); chair(9.4, 24, "w", "guest"); chair(7, 26.4, "n", "guest");
    couch(2, 27, 3, 32, "e", "red");
    desk(8, 28, 13, 29); desk(12, 30, 13, 33);
    chair(10, 30, "n");
    plant(2, 22);
    rug(5, 22, 9, 26, "blue");

    // Lounge: couches around a coffee table on a rug.
    rug(19, 23, 26, 30, "rust");
    couch(20, 24, 24, 25, "s", "red");
    item("coffeeTable", "T", 21, 27, 23, 28);
    couch(17, 27, 18, 30, "e", "red");
    plant(15, 17); plant(34, 17, "snake"); plant(26, 28, "palm");
    decor("lamp", 19, 24, 19, 24);

    // Southwest office.
    desk(20, 35, 24, 36);
    chair(22, 34, "s"); chair(22, 37, "n", "guest");
    roundTable(16, 40, 1.2);
    chair(16, 37.9, "s", "guest"); chair(18.1, 40, "w", "guest");
    couch(19, 41, 23, 42, "n", "red");
    cabinet(25, 37, 26, 42, "bookshelf", "w");
    plant(26, 35, "palm");

    // Server room: a rack row with its lit fronts toward the camera, plus cooling.
    machine(29, 30, 33, 31, "rack", "n");
    machine(28, 33, 29, 33, "crac", "n");
    decor("cableTray", 29, 29, 33, 29);

    // Wellness room.
    counter(41, 28, 46, 29);
    decor("sink", 43, 28, 43, 29);
    machine(47, 28, 47, 28, "minifridge", "s");
    couch(47, 31, 48, 32, "w", "sage");
    item("sideTable", "T", 49, 33, 49, 33);
    plant(49, 28, "palm");
    rug(42, 31, 46, 33, "sage");

    // Middle offices.
    desk(51, 28, 52, 31); desk(53, 30, 55, 31);
    chair(54, 29, "s"); chair(54, 32, "n", "guest");
    cabinet(58, 33, 59, 33, "bookshelf");
    plant(59, 28, "snake");
    desk(65, 30, 71, 31, "oak");
    chair(68, 29, "s"); chair(66.5, 32, "n", "guest"); chair(69.5, 32, "n", "guest");
    cabinet(64, 33, 67, 33, "credenza");
    plant(61, 28);

    // Vestibule: the suite entrance off the elevator corridor.
    rug(76, 28, 81, 29, "logo");
    plant(75, 28, "palm"); plant(82, 28, "palm");
    plant(73, 38, "snake");

    // Corridor art and plants.
    plant(121, 22, "fig");
    for (const [x0, x1] of [[42, 45], [50, 53], [60, 63], [68, 71], [86, 89], [95, 98], [104, 107], [112, 115]]) decor("art", x0, 26, x1, 26);
    for (const [x0, x1] of [[31, 34], [44, 47], [59, 62]]) decor("art", x0, 39, x1, 39);
    decor("clock", 50, 39, 50, 39);

    // South offices with a shared T-desk at the divider.
    couch(28, 41, 31, 42, "s", "red");
    desk(32, 45, 36, 46); desk(35, 47, 36, 51);
    chair(34, 47, "n"); chair(33, 44, "s", "guest");
    plant(28, 48, "fig");
    desk(38, 45, 43, 46, "oak"); desk(38, 47, 39, 51, "oak");
    chair(41, 47, "n"); chair(41, 44, "s", "guest");
    plant(46, 41, "snake");

    // Conference room.
    desk(52, 44, 66, 47, "conference");
    for (const x of [53, 56, 59, 62, 65]) { chair(x, 43, "s", "conference"); chair(x, 48, "n", "conference"); }
    chair(51, 45.5, "e", "conference"); chair(67, 45.5, "w", "conference");
    cabinet(48, 43, 48, 48, "media", "e");
    plant(48, 41, "palm"); plant(71, 50, "fig"); plant(48, 50, "snake");

    // Break room: counter with appliances, bistro tables along the window.
    counter(73, 41, 83, 42);
    machine(84, 41, 84, 42, "fridge", "w");
    decor("sink", 77, 41, 77, 42);
    decor("coffee", 74, 41, 74, 42);
    decor("microwave", 81, 41, 81, 42);
    decor("fruit", 79, 41, 79, 42);
    for (const x of [74.5, 78.5, 82.5]) { roundTable(x, 44.5, 0.8, "bistro"); chair(x - 1.4, 44.5, "e", "stool"); chair(x + 1.4, 44.5, "w", "stool"); }

    // Elevator lobby.
    for (const y of [3, 8, 13]) { decor("elevator", 72, y, 72, y + 2, { side: "w" }); decor("elevator", 85, y, 85, y + 2, { side: "e" }); }
    item("bench", "K", 77, 9, 80, 9);
    plant(73, 1, "palm"); plant(84, 1, "palm");
    rug(75, 17, 82, 20, "lobby");

    // Bullpen: fishbone desk clusters with a planted storage spine; everyone faces the windows.
    const cluster = (cx, top, arms) => {
        item("spine", "K", cx - 1, top, cx + 1, arms.at(-1) + 1);
        for (const ay of arms) {
            desk(cx - 4, ay, cx + 4, ay + 1, "white");
            chair(cx - 3, ay - 1, "s"); chair(cx + 3, ay - 1, "s");
        }
    };
    cluster(93, 33, [35, 40, 45, 50]);
    cluster(106, 33, [35, 40, 45, 50]);
    cluster(119, 33, [35, 40, 45, 50]);
    cluster(136, 22, [24, 29, 34, 39]);
    cluster(149, 22, [24, 29]);
    desk(123, 21, 124, 26, "oak");
    machine(123, 23, 124, 24, "printer", "e");
    plant(86, 33, "fig"); plant(129, 28, "palm"); plant(155, 19, "fig"); plant(142, 41, "snake"); plant(86, 50, "palm");
    machine(123, 19, 123, 19, "waterCooler", "e");

    // Standup room, couch nook and northeast offices.
    roundTable(127, 12, 1.9);
    for (const [dx, dy] of [[-2.4, -2.2], [2.4, -2.2], [-2.4, 2.2], [2.4, 2.2]]) chair(127 + dx, 12 + dy, dx < 0 ? "e" : "w", "conference");
    decor("whiteboard", 123, 17, 126, 17);
    decor("tv", 123, 8, 123, 10, { side: "w" });
    couch(137, 9, 138, 14, "w", "red");
    item("coffeeTable", "T", 135, 11, 135, 12);
    plant(133, 8, "palm"); plant(137, 16, "snake");
    rug(134, 9, 136, 14, "rust");
    desk(140, 11, 145, 12);
    chair(142, 10, "s"); chair(142, 13, "n", "guest");
    cabinet(140, 16, 142, 16, "bookshelf");
    plant(147, 8);
    desk(149, 11, 153, 12, "oak");
    chair(151, 10, "s"); chair(151, 13, "n", "guest");
    plant(155, 16, "snake");
    cabinet(153, 8, 155, 8, "filing", "s");

    return { cells, zones, props };
}

const PLAN = buildPlan();
const WALLISH = new Set(["#", "B"]);

function rotateRows(source, blank) {
    const rows = [];
    for (let r = 0; r < ROWS; r++) {
        const y = PLAN_ROWS - 1 - r;
        rows.push(Array.from({ length: COLS }, (_, c) => (y >= 0 ? source[y][COLS - 1 - c] : blank)));
    }
    return rows;
}

/** World grid (camera looking south). Floor tiles directly below a wall or window become solid faces. */
export const GRID = (() => {
    const rows = rotateRows(PLAN.cells, "x");
    for (let r = ROWS - 1; r > 0; r--) for (let c = 0; c < COLS; c++) {
        if (WALLISH.has(rows[r - 1][c]) && (rows[r][c] === "." || rows[r][c] === "c")) rows[r][c] = "F";
    }
    return rows.map((row) => row.join(""));
})();

/** Floor material per world tile; doorways borrow a neighbouring room's floor. */
export const ZONES = (() => {
    const rows = rotateRows(PLAN.zones, "");
    for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) {
        if (rows[r][c] || GRID[r][c] !== "D") continue;
        for (const [dc, dr] of [[0, -1], [0, 1], [-1, 0], [1, 0]]) { const z = rows[r + dr]?.[c + dc]; if (z) { rows[r][c] = z; break; } }
    }
    return rows;
})();

/** Furniture and decor in world tile units: rect props get {x, y, w, h}; point props get {x, y} centers. Facings are world directions. */
export const PROPS = PLAN.props.map((prop) => {
    const { x0, y0, x1, y1, cx, cy, facing, ...rest } = prop;
    const out = { ...rest };
    if (cx !== undefined) Object.assign(out, { x: PLAN_COLS - 0.5 - cx, y: PLAN_ROWS - 0.5 - cy });
    else Object.assign(out, { x: PLAN_COLS - 1 - x1, y: PLAN_ROWS - 1 - y1, w: x1 - x0 + 1, h: y1 - y0 + 1 });
    if (facing) out.facing = FLIP[facing];
    if (prop.side) out.side = prop.side === "w" ? "e" : "w";
    return out;
});

const label = (text, x, y) => ({ text, x: (PLAN_COLS - 1 - x) * TILE + TILE / 2, y: (PLAN_ROWS - 1 - y) * TILE + TILE / 2 });
export const LABELS = [
    label("Bullpen", 107, 30),
    label("Offices", 23, 14),
    label("Offices", 144, 14),
    label("Offices", 42, 49),
    label("Office", 6, 30),
    label("Office", 18, 38),
    label("Lounge", 28, 20),
    label("Server Room", 31, 28),
    label("Wellness", 44, 30),
    label("Conference", 59, 50),
    label("Break Room", 78, 43),
    label("Standup", 127, 16),
    label("Elevators", 78, 5),
];

const SOLID = new Set(["#", "B", "F", "R", "N", "S", "K", "T", "P", "M", "x", "o"]);
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

/**
 * Scenery layers behind the window glass. x is how fast a layer pans with the world (0 = pinned to the screen like the sky,
 * 1 = moves with the floor). y stays small for every layer so the horizon holds near eye level as you walk deeper inside.
 */
export const PARALLAX = [
    { id: "loungeSceneryFar", x: 0.15, y: 0.06 },
    { id: "loungeSceneryMid", x: 0.4, y: 0.1 },
    { id: "loungeSceneryNear", x: 0.7, y: 0.16 },
];

/** Translation for a scenery layer. factor is a number for both axes or {x, y}. */
export function parallaxOffset(cam, factor) {
    const fx = typeof factor === "number" ? factor : factor.x, fy = typeof factor === "number" ? factor : factor.y;
    return { x: cam.x * (1 - fx), y: cam.y * (1 - fy) };
}

export function labelsMarkup() {
    return LABELS.map((item) => `<text class="lounge-room-label" x="${item.x}" y="${item.y}" text-anchor="middle">${item.text}</text>`).join("");
}
