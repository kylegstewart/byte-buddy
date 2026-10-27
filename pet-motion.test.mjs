import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createPetMotion } from './public/pet-motion.js';
import { createStore } from './store.mjs';

function fixture(reduced = false) {
    let clock = 0, timer, pets = 0, penalties = 0;
    const motion = createPetMotion({ now: () => clock, schedule: (fn) => { timer = fn; return 1; },
        cancel: () => { timer = null; }, reduced: () => reduced, onPet: () => pets++, onAbuse: () => penalties++ });
    return { motion, advance(ms) { clock += ms; if (clock >= 1000 && timer) { const fn = timer; timer = null; fn(); } },
        down() { motion.down({ id: 1, x: 80, y: 80 }, { x: 80, y: 104 }, { left: 20, right: 140, top: 45, bottom: 104 }); },
        move(x, y = 80) { motion.move({ id: 1, x, y }); },
        up(cancelled = false) { motion.up({ id: 1 }, cancelled); },
        get pets() { return pets; }, get penalties() { return penalties; } };
}

test('short press pets once; only a full second enables pickup; wrong pointers do nothing', () => {
    const f = fixture(); f.down(); f.advance(999); f.motion.step(0);
    assert.equal(f.motion.body.phase, 'press');
    assert.equal(f.motion.body.hold, 0.999);
    f.motion.up({ id: 2 }); assert.equal(f.pets, 0);
    f.up(); f.up(); assert.equal(f.pets, 1);
    const g = fixture(); g.down(); g.advance(1000);
    assert.equal(g.motion.body.phase, 'held');
    for (let i = 0; i < 360; i++) { g.advance(16); g.motion.step(0.016); }
    assert.equal(g.motion.body.phase, 'held', 'an unmoving pickup stays held, even at floor height');
    g.up(); assert.equal(g.pets, 0); assert.equal(g.penalties, 0);
});

test('movement before pickup and pointer cancellation never pet or throw', () => {
    const f = fixture(); f.down(); f.move(90); f.advance(1500); f.up();
    assert.equal(f.motion.body.phase, 'idle'); assert.equal(f.pets, 0);
    const g = fixture(); g.down(); g.advance(1000); g.advance(20); g.move(130, 40); g.up(true);
    assert.equal(g.motion.body.phase, 'idle'); assert.equal(g.penalties, 0);
});

test('held motion clamps to stage; fast throws splat, bounce, settle and penalize only once', () => {
    const f = fixture(); f.down(); f.advance(1000); f.advance(20); f.move(1000, -1000);
    assert.equal(f.motion.body.x, 140); assert.equal(f.motion.body.y, 45);
    assert.equal(f.motion.body.vx, 320); assert.equal(f.motion.body.vy, -320);
    f.up(); assert.equal(f.penalties, 1);
    f.motion.step(1 / 60);
    assert.ok(f.motion.body.splat > 0); assert.ok(f.motion.body.vx < 0);
    for (let i = 0; i < 400; i++) {
        f.motion.step(1 / 60);
        assert.ok(f.motion.body.x >= 20 && f.motion.body.x <= 140);
        assert.ok(f.motion.body.y >= 45 && f.motion.body.y <= 104);
    }
    assert.equal(f.motion.body.phase, 'idle'); assert.equal(f.penalties, 1); assert.equal(f.pets, 0);
});

test('gentle pickup/drop and stale release velocity do not penalize', () => {
    const f = fixture(); f.down(); f.advance(1000); f.advance(100); f.move(82); f.up();
    for (let i = 0; i < 400; i++) f.motion.step(1 / 60);
    assert.equal(f.penalties, 0);
    const g = fixture(); g.down(); g.advance(1000); g.advance(20); g.move(120); g.advance(200); g.up();
    assert.equal(g.motion.body.vx, 0); assert.equal(g.penalties, 0);
});

test('reduced motion supports pickup but skips ballistics; abuse still has one consequence', () => {
    const f = fixture(true); f.down(); f.advance(1000); f.advance(20); f.move(130); f.up();
    assert.equal(f.motion.body.phase, 'idle'); assert.equal(f.penalties, 1);
    f.motion.step(10); assert.equal(f.penalties, 1);
});

test('slow and fast frame rates produce equivalent gravity/drag and long stalls are bounded', () => {
    const a = fixture(), b = fixture();
    for (const f of [a, b]) { f.down(); f.advance(1000); f.advance(40); f.move(90, 50); f.up(); }
    for (let i = 0; i < 6; i++) a.motion.step(1 / 60);
    b.motion.step(0.1);
    assert.ok(Math.abs(a.motion.body.x - b.motion.body.x) < 0.1);
    assert.ok(Math.abs(a.motion.body.y - b.motion.body.y) < 0.1);
    b.motion.step(60);
    assert.ok(Number.isFinite(b.motion.body.x)); assert.ok(b.motion.body.y <= 104);
});

test('held buddy sways with drag direction, reverses smoothly, and settles without care writes', () => {
    const f = fixture(); f.down(); f.advance(1000); f.advance(20); f.move(100, 60);
    for (let i = 0; i < 5; i++) { f.advance(16); f.motion.step(0.016); }
    assert.ok(f.motion.body.angle > 0, 'body trails a rightward drag');
    const before = f.motion.body.angle;
    f.advance(16); f.move(98, 60);
    assert.equal(f.motion.body.angle, before, 'pointer events do not snap rotation');
    for (let i = 0; i < 30; i++) { f.advance(16); f.move(98 - i * 2, 60); f.motion.step(0.016); }
    assert.ok(f.motion.body.angle < 0, 'sway reverses with a leftward drag');
    for (let i = 0; i < 240; i++) { f.advance(16); f.motion.step(0.016); assert.ok(Math.abs(f.motion.body.angle) <= 48); }
    assert.equal(f.motion.body.angle, 0); assert.equal(f.motion.body.angularVelocity, 0);
    assert.equal(f.penalties, 0); assert.equal(f.pets, 0);
    f.up(true); assert.equal(f.motion.body.angle, 0);
    const g = fixture(true); g.down(); g.advance(1000); g.advance(20); g.move(110, 60); g.motion.step(0.05);
    assert.equal(g.motion.body.phase, 'held'); assert.equal(g.motion.body.angle, 0);
});

test('sway scales with speed, reacts immediately to reversal, and depends on the pickup point', () => {
    const slow = fixture(), fast = fixture(), foot = fixture();
    for (const f of [slow, fast]) { f.down(); f.advance(1000); f.advance(20); }
    slow.move(81); fast.move(86);
    slow.motion.step(0.06); fast.motion.step(0.06);
    assert.ok(fast.motion.body.angle > slow.motion.body.angle * 3, 'fast drags lean much farther');
    const oldVelocity = fast.motion.body.angularVelocity;
    fast.advance(20); fast.move(80);
    assert.ok(fast.motion.body.angularVelocity < 0 && fast.motion.body.angularVelocity < oldVelocity,
        'direction reversal immediately changes angular momentum, without snapping the angle');
    fast.motion.step(0.1);
    assert.ok(fast.motion.body.angle < 0, 'the body follows the reversed drag within 100ms');
    foot.motion.down({ id: 1, x: 80, y: 100 }, { x: 80, y: 104 }, { left: 20, right: 140, top: 45, bottom: 104 });
    foot.advance(1000); foot.advance(20); foot.move(86, 100); foot.motion.step(0.06);
    assert.equal(foot.motion.body.gripY, -4);
    assert.ok(foot.motion.body.angle < 0, 'grabbing below the body reverses the lever arm');
});

test('sway uses stable substeps and keeps rotated sprite corners within the room', () => {
    const a = fixture(), b = fixture();
    for (const f of [a, b]) { f.down(); f.advance(1000); f.advance(20); f.move(100, 60); }
    for (let i = 0; i < 6; i++) a.motion.step(1 / 60);
    b.motion.step(0.1);
    assert.ok(Math.abs(a.motion.body.angle - b.motion.body.angle) < 0.01);
    const f = fixture(), shape = { x: -18, y: -50, width: 36, height: 50 };
    f.motion.down({ id: 1, x: 80, y: 64 }, { x: 80, y: 104 },
        { left: 20, right: 140, top: 57, bottom: 104, shape, width: 160, floor: 104 });
    f.advance(1000); f.advance(20); f.move(1000, -1000);
    for (let i = 0; i < 100; i++) {
        f.advance(16); f.motion.step(0.016);
        const p = f.motion.body, r = p.angle * Math.PI / 180;
        for (const x of [shape.x, shape.x + shape.width]) for (const y of [shape.y, shape.y + shape.height]) {
            const dx = (x - p.gripX) * 1.03, dy = (y - p.gripY) * 1.03;
            const sx = p.x + p.gripX + dx * Math.cos(r) - dy * Math.sin(r);
            const sy = p.y + p.gripY + dx * Math.sin(r) + dy * Math.cos(r);
            assert.ok(sx >= 0 && sx <= 160); assert.ok(sy >= 0 && sy <= 104);
        }
    }
});

test('affection penalty persists across restart, is server-limited, never grants XP, and leaves cold data unchanged', (t) => {
    const root = mkdtempSync(join(process.cwd(), '.pet-test-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const make = () => createStore({ root, userId: 'FIXTURE' });
    const store = make(); store.view();
    const before = store.view();
    const manifest = JSON.parse(readFileSync(store.file, 'utf8'));
    const result = store.interact('fling');
    assert.equal(result.care.affection, before.care.affection - 5);
    const after = JSON.parse(readFileSync(store.file, 'utf8'));
    const saved = readFileSync(store.file, 'utf8');
    for (let i = 0; i < 10; i++) store.interact('fling');
    assert.equal(readFileSync(store.file, 'utf8'), saved, 'cooldown does not write');
    assert.equal(make().interact('fling').care.affection, result.care.affection, 'restart retains cooldown');
    assert.deepEqual(after.storage.evidence, manifest.storage.evidence, 'evidence references are unchanged');
    assert.deepEqual(after.storage.projections, manifest.storage.projections, 'projection references are unchanged');
    assert.deepEqual(store.view().progress, before.progress);
    assert.deepEqual(store.view().achievements, before.achievements);
    assert.deepEqual(store.view().care.counts, before.care.counts);
    assert.equal(store.interact('pet').care.affection, result.care.affection + 8);
    store.load().care.lastFlingAt = new Date(Date.now() - 5001).toISOString();
    assert.equal(store.interact('fling').care.affection, result.care.affection + 3);
    assert.equal(make().view().care.affection, result.care.affection + 3);
    store.load().care.affection = 3;
    store.load().care.lastFlingAt = '1970-01-01';
    assert.equal(store.interact('fling').care.affection, 0, 'affection cannot become negative');
    store.load().care.updatedAt = new Date(Date.now() - 60000).toISOString();
    assert.equal(store.view().care.affection, 0, 'inactivity must not silently undo the penalty');
});
