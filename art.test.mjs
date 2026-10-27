import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { buddy, buddyMetrics, robot, metrics, W, H, FLOOR_Y } from './public/art.js';

const types = ['robot', 'cat', 'dog', 'dragon', 'slime'];
const variants = ['variant-classic', 'variant-boxy', 'variant-bubble'];
const expressions = ['normal', 'blink', 'sleep', 'happy', 'chomp', 'excited', 'sleepy', 'curious', 'smile'];
const hats = ['beanie', 'party', 'propeller', 'helmet', 'wizard', 'crown', 'headset', 'chef', 'cowboy', 'tophat', 'explorer', 'viking', 'detective', 'pirate', 'halo'].map(id => `hat-${id}`);
const eyewear = ['round', 'shades', 'visor', '3d', 'monocle', 'hearts', 'goggles'].map(id => `glasses-${id}`);
const headphones = ['classic', 'cat', 'earmuffs', 'dj'].map(id => `phones-${id}`);
const neckwear = ['bowtie', 'scarf', 'bugbadge', 'star', 'tie', 'lanyard', 'medal', 'bandana', 'cape', 'chain'].map(id => `neck-${id}`);
const cosmetics = { hat: hats, glasses: eyewear, headphones, neck: neckwear };

function rectangles(svg) {
    assert.doesNotMatch(svg, /NaN|undefined|Infinity/);
    const result = [...svg.matchAll(/<rect x="([^"]+)" y="([^"]+)" width="([^"]+)" height="([^"]+)" fill="([^"]+)"/g)]
        .map(([, x, y, w, h, fill]) => ({ x: Number(x), y: Number(y), w: Number(w), h: Number(h), fill }));
    assert.ok(result.length > 10, 'a visible pixel-art sprite');
    for (const r of result) {
        assert.ok([r.x, r.y, r.w, r.h].every(Number.isFinite));
        assert.ok(r.w > 0 && r.h > 0, 'all visible rectangles have positive dimensions');
        assert.match(r.fill, /^#[0-9a-f]{6}$/i);
    }
    return result;
}

function assertContained(svg, m, label) {
    const rs = rectangles(svg), b = m.bounds;
    for (const r of rs) {
        assert.ok(r.x >= b.left && r.x + r.w <= b.right, `${label}: horizontal bounds (${r.x}, ${r.w})`);
        assert.ok(r.y >= b.top && r.y + r.h <= b.bottom, `${label}: vertical bounds (${r.y}, ${r.h})`);
    }
    const [x, y, w, h] = m.viewBox.split(' ').map(Number);
    assert.deepEqual([x, y, x + w, y + h], [b.left, b.top, b.right, b.bottom]);
    assert.ok(W / 2 + b.left >= 0 && W / 2 + b.right <= W, `${label}: scene width`);
    assert.ok(FLOOR_Y + b.top >= 0 && FLOOR_Y + b.bottom <= H, `${label}: scene height`);
    return rs;
}

test('all five legacy robot renders are byte-for-byte unchanged', () => {
    const hashes = [
        '02e4b1728b0bab3a431485c8ea20e6a0938025a744dc65a04331a26c6e38e8f0',
        'c35de798da2451c73a6b09213a0a759ee0b94aa9686438a22e7d937328668e2b',
        '56e2fe809bfe730e5e037de4efdccab0321073adfc4dd9ebcf71da79c7c1dfbb',
        '9977766ef261f5ee6f4399e70ac4924e7d0b222d9562bba731576e8cb1c1513b',
        '01522d63bcab73680f427a086ac24add20a5059522542f174cd7ac767879a9e4',
    ];
    for (let stage = 1; stage <= 5; stage++) {
        assert.equal(createHash('sha256').update(robot({ stage, still: true })).digest('hex'), hashes[stage - 1]);
        for (const variant of variants) {
            const opts = { stage, variant, hat: 'hat-wizard', glasses: 'glasses-goggles', neck: 'neck-cape', headphones: 'phones-dj', pose: 'wave', frame: 3 };
            assert.equal(buddy(opts), robot(opts));
            assert.equal(buddy({ ...opts, type: 'robot' }), robot(opts));
            const { bounds, viewBox, ...m } = buddyMetrics(stage, variant);
            assert.deepEqual(m, metrics(stage, variant));
            assertContained(buddy(opts), { ...m, bounds, viewBox }, `robot ${stage} ${variant}`);
        }
    }
});

test('Classic artwork for all 20 creature stages stays byte-for-byte unchanged', () => {
    const hashes = {
        cat: [
            '9765af8bce76129862f833b670235823a06699f1c8be6b14a8707fb229e04a15',
            '3d941528244c03c57048aa9f8554278e542206c3dde69628ca3d967649a20116',
            '218b5af4862ece698a7181016fc2944b82dac2241a70310bb83712f63ced25b8',
            'e1b4c07092fc98d947b7ee8be3a9a84dca399f04ddba5a65515ee07640a5a37c',
            '025fee66e0b03f617e7910e47c05aeb6496abd001c45191afee07bbf1cb85b27',
        ],
        dog: [
            'dd54cbbd82ccb6d88a595230fe024e487cfe8112eba94a186936fd674c2ad776',
            '261cb57ae544e0c221e15df66a0d34b42c0f2454ced49cfe4a056df21f950e64',
            'e213f081554abee10fbcf41106ba0ee0e02810e1e5c04fb8ba2a2206ec97d257',
            '0e7e9660b930e93ce7dd129a6264070e031facc6d778bf3c3c5868842a25f3a1',
            '266bf6951bcdc3cdfbaf2f5207e2badbca79a9af3ab83f09baa2e89c01727f35',
        ],
        dragon: [
            '660458c91a2f8970b76e9537230b9522451a8fc07e143efbc36736436200377d',
            '27521a9046012f3f77a16abdf351fdffdc59ccbbb8392a6044b65e641e5d3be1',
            'e184e496ccbc9a0161afe24c40e2aca0f02a7467da27560c2a544cb90205639d',
            '8512698b7b8c01bed786fc2720835ccc6b7027904dd5844aa96956865801e845',
            'b8781b7b516bb41b438583ec3fb91e1992707f9df920ef8b3eeb917ce3e49736',
        ],
        slime: [
            '944921c2d1ec788df755ffd4c7ad074baf251761da16340e2be0b4d4bfb31780',
            '0a0ab705882ea633abc8eb7e50ca8607a54c28b67e7af8571a0b603b5eedeadc',
            '338b366f22931dcf8a8d42e6ffa5c29423468447678f3eaaf873a222fad0ae5b',
            '039486b9daabec725dfbc0e77769ddefbbdb8e079547d2f4ade05e66eba04d15',
            '9e73c7a4787b7dc788ce3e756a74d11627436614174d5d1a5224b19587c0ecc5',
        ],
    };
    for (const type of types.slice(1)) for (let stage = 1; stage <= 5; stage++) {
        const opts = { type, stage, still: true }, classic = buddy(opts);
        assert.equal(createHash('sha256').update(classic).digest('hex'), hashes[type][stage - 1]);
        assert.equal(buddy({ ...opts, variant: 'variant-classic' }), classic);
        assert.equal(buddy({ ...opts, variant: 'invalid' }), classic);
    }
});

function paintedPixels(svg) {
    const pixels = new Set();
    for (const r of rectangles(svg)) for (let y = r.y; y < r.y + r.h; y++) {
        for (let x = r.x; x < r.x + r.w; x++) pixels.add(`${x},${y}`);
    }
    return pixels;
}

test('all creature stages have visibly different Classic, Boxy and Bubble silhouettes', () => {
    for (const type of types.slice(1)) for (let stage = 1; stage <= 5; stage++) {
        const shapes = variants.map(variant => {
            const opts = { type, stage, variant, still: true }, m = buddyMetrics(stage, variant, type);
            const svg = buddy(opts);
            for (const r of assertContained(svg, m, `${type} ${stage} ${variant}`)) {
                assert.ok([r.x, r.y, r.w, r.h].every(Number.isInteger), 'whole-pixel geometry');
            }
            return paintedPixels(svg);
        });
        for (let i = 0; i < shapes.length; i++) for (let j = i + 1; j < shapes.length; j++) {
            const difference = [...shapes[i]].filter(pixel => !shapes[j].has(pixel)).length
                + [...shapes[j]].filter(pixel => !shapes[i].has(pixel)).length;
            assert.ok(difference > 30, `${type} ${stage}: silhouettes differ by ${difference} pixels`);
        }
        const classic = buddyMetrics(stage, variants[0], type), boxy = buddyMetrics(stage, variants[1], type), bubble = buddyMetrics(stage, variants[2], type);
        assert.ok(boxy.headW > classic.headW && boxy.headH < classic.headH, 'Boxy is broader and squatter');
        assert.ok(bubble.headW > classic.headW && bubble.headH > classic.headH, 'Bubble is puffier');
    }
});

test('Bubble ears and horns remain attached to the rounded head silhouette', () => {
    for (const type of ['cat', 'dog', 'dragon']) for (let stage = 1; stage <= 5; stage++) {
        const variant = 'variant-bubble', m = buddyMetrics(stage, variant, type);
        const pixels = paintedPixels(buddy({ type, stage, variant, still: true }));
        const seed = `0,${m.headTop + Math.floor(m.headH / 2)}`, connected = new Set([seed]), pending = [seed];
        while (pending.length) {
            const [x, y] = pending.pop().split(',').map(Number);
            for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
                const next = `${x + dx},${y + dy}`;
                if (pixels.has(next) && !connected.has(next)) { connected.add(next); pending.push(next); }
            }
        }
        const hx = -m.headW / 2, hy = m.headTop;
        const anchors = type === 'cat' ? [[hx + 3, hy - 5], [-hx - 4, hy - 5]]
            : type === 'dog' ? (stage <= 2 ? [[hx - 1, hy + 5], [-hx, hy + 5]] : [[hx - 1, hy - 7], [-hx, hy - 7]])
                : [[hx + 2, hy - 1], [-hx - 3, hy - 1]];
        for (const [x, y] of anchors) assert.ok(connected.has(`${x},${y}`), `${type} ${stage}: attached feature ${x},${y}`);
    }
});

test('25 stages have distinct geometry, feet-local origins and compatible metrics', () => {
    const markups = new Set(), silhouettes = new Set();
    for (const type of types) for (let stage = 1; stage <= 5; stage++) {
        const svg = buddy({ type, stage, still: true });
        markups.add(svg.replace(/ data-buddy-[^=]+="[^"]+"/g, ''));
        const m = buddyMetrics(stage, undefined, type);
        for (const key of ['headTop', 'headH', 'headW', 'bodyTop', 'mouthY']) assert.ok(Number.isFinite(m[key]), key);
        assert.ok(m.headTop < m.bodyTop && m.headH > 0 && m.headW > 0);
        assert.ok(m.mouthY > m.headTop && m.mouthY < m.headTop + m.headH);
        const rs = assertContained(svg, m, `${type} ${stage}`);
        assert.ok(rs.some(r => r.y + r.h === 0 && r.x < 0), 'left foot/base at local floor');
        assert.ok(rs.some(r => r.y + r.h === 0 && r.x + r.w > 0), 'right foot/base at local floor');
        assert.doesNotMatch(svg, /transform=/, 'no translated root/pivot');
        const silhouette = new Set();
        for (const r of rs) for (let y = Math.floor(r.y); y < r.y + r.h; y++) {
            for (let x = Math.floor(r.x); x < r.x + r.w; x++) silhouette.add(`${x},${y}`);
        }
        silhouettes.add([...silhouette].sort().join(';'));
    }
    assert.equal(markups.size, 25, 'not differentiated by metadata alone');
    assert.equal(silhouettes.size, 25, 'not differentiated by color alone');
});

test('each species keeps both shared custom colors through every stage', () => {
    for (const type of types) for (let stage = 1; stage <= 5; stage++) {
        const opts = { type, stage, still: true };
        const base = buddy(opts), custom = buddy({ ...opts, body: '#ac42ef', eye: '#123abc' });
        assert.notEqual(base, custom);
        assert.match(custom, /fill="#ac42ef"/);
        assert.match(custom, /fill="#123abc"/);
        assert.doesNotMatch(custom, /fill="#3fb8af"|fill="#7cf8ff"/);
        for (const variant of variants) assertContained(buddy({ ...opts, variant }), buddyMetrics(stage, variant, type), `${type} ${stage} ${variant}`);
    }
});

test('every existing accessory renders on all 75 species/stage/style geometries without clipping', () => {
    for (const type of types) for (let stage = 1; stage <= 5; stage++) for (const variant of variants) {
        const opts = { type, stage, variant, still: true }, m = buddyMetrics(stage, variant, type);
        const base = buddy(opts);
        for (const [slot, ids] of Object.entries(cosmetics)) for (const id of ids) {
            const svg = buddy({ ...opts, [slot]: id });
            assert.notEqual(svg, base, `${type} ${stage}: ${id} is visible`);
            assertContained(svg, m, `${type} ${stage}: ${id}`);
        }
        for (let i = 0; i < hats.length; i++) {
            assertContained(buddy({ ...opts, hat: hats[i], glasses: eyewear[i % eyewear.length],
                headphones: headphones[i % headphones.length], neck: neckwear[i % neckwear.length] }), m, `${type} ${stage}: layered cosmetics ${i}`);
        }
    }
});

test('animal/slime expressions and gestures are distinct in every style; still freezes animation', () => {
    for (const type of types.slice(1)) for (let stage = 1; stage <= 5; stage++) for (const variant of variants) {
        const opts = { type, stage, variant, frame: 0 };
        const exprArt = expressions.map(expr => buddy({ ...opts, expr }));
        assert.ok(new Set(exprArt).size >= 7, `${type} ${stage}: expressive face`);
        const standing = buddy(opts);
        for (const pose of ['sit', 'wave', 'cheer', 'walk']) assert.notEqual(buddy({ ...opts, pose }), standing, `${type} ${stage}: ${pose}`);
        assert.notEqual(buddy({ ...opts, pose: 'walk', frame: 0 }), buddy({ ...opts, pose: 'walk', frame: 3 }));
        const still = { ...opts, still: true, pose: 'walk', hat: 'hat-propeller', neck: 'neck-cape' };
        assert.equal(buddy({ ...still, frame: 0 }), buddy({ ...still, frame: 3 }));
    }
});

test('poses, expressions and cosmetic animation remain inside all style scene/viewbox envelopes', () => {
    for (const type of types) for (let stage = 1; stage <= 5; stage++) for (const variant of variants) {
        const m = buddyMetrics(stage, variant, type);
        for (const pose of ['stand', 'sit', 'walk', 'wave', 'cheer', 'jump']) {
            for (let i = 0; i < expressions.length; i++) {
                for (const bob of [-2, 0, 2]) {
                    assertContained(buddy({ type, stage, variant, pose, expr: expressions[i], bob, frame: i,
                        look: i % 3 - 1, hat: hats[i], glasses: eyewear[i % eyewear.length],
                        headphones: headphones[i % headphones.length], neck: neckwear[i % neckwear.length] }), m,
                    `${type} ${stage} ${pose} ${expressions[i]} bob ${bob}`);
                }
            }
        }
    }
});

test('dragons have growing scalloped wings, finger bones and tapered organic silhouettes at every stage', () => {
    let previousSpan = 0;
    const oldAnchors = [[18, 15, -28, -12], [22, 17, -35, -17], [24, 18, -40, -21], [26, 19, -45, -25], [28, 20, -49, -28]];
    const rowExtent = (rs, y) => {
        const row = rs.filter(r => r.y <= y && r.y + r.h > y);
        return Math.max(...row.map(r => r.x + r.w)) - Math.min(...row.map(r => r.x));
    };
    for (let stage = 1; stage <= 5; stage++) {
        const svg = buddy({ type: 'dragon', stage, still: true });
        const m = buddyMetrics(stage, undefined, 'dragon');
        const [headW, headH, headTop, bodyTop] = oldAnchors[stage - 1];
        assert.deepEqual([m.headW, m.headH, m.headTop, m.bodyTop], [headW, headH, headTop, bodyTop], 'accessory anchors stay fixed');
        const head = rectangles(svg.match(/<g data-dragon-head="rounded">(.*?)<\/g>/)[1]);
        assert.ok(rowExtent(head, headTop) < rowExtent(head, headTop + 6), 'rounded crown instead of a square head');
        assert.ok(rowExtent(head, headTop + headH) < rowExtent(head, headTop + 6), 'tapered jaw');
        const body = rectangles(svg.match(/<g data-dragon-body="tapered">(.*?)<\/g>/)[1]);
        assert.ok(rowExtent(body, bodyTop - 2) < rowExtent(body, bodyTop + 6), 'neck tapers into a chubby belly');
        for (const side of ['left', 'right']) {
            const wing = rectangles(svg.match(new RegExp(`<g data-dragon-wing="${side}">(.*?)</g>`))[1]);
            const span = Math.max(...wing.map(r => r.x + r.w)) - Math.min(...wing.map(r => r.x));
            assert.ok(span > previousSpan, 'each stage grows its wings');
            assert.ok(new Set(wing.map(r => r.fill)).size >= 5, 'outlined bones, shaded membrane and pale claws');
            for (const r of wing) assert.ok([r.x, r.y, r.w, r.h].every(Number.isInteger), 'whole-pixel wings');
            if (stage >= 2) {
                const left = Math.min(...wing.map(r => r.x)), bottom = [];
                for (let x = left; x < left + span; x++) {
                    bottom.push(Math.max(...wing.filter(r => r.x <= x && r.x + r.w > x).map(r => r.y + r.h)));
                }
                const slopes = bottom.slice(1).map((v, i) => Math.sign(v - bottom[i])).filter(Boolean);
                assert.ok(slopes.filter((v, i) => i && v !== slopes[i - 1]).length >= 3, 'scalloped trailing edge, not a triangular fan');
            }
        }
        const right = rectangles(svg.match(/<g data-dragon-wing="right">(.*?)<\/g>/)[1]);
        previousSpan = Math.max(...right.map(r => r.x + r.w)) - Math.min(...right.map(r => r.x));
    }
});

test('dispatch defaults and untrusted species/stage inputs are safe', () => {
    assert.equal(buddy(), robot({}));
    assert.equal(buddy({ type: 'unknown' }), robot({ type: 'unknown' }));
    assert.equal(buddy({ type: '__proto__' }), robot({ type: '__proto__' }));
    for (const type of types.slice(1)) {
        for (const stage of [undefined, null, NaN, Infinity, -3, 0, 1.8, 8, '4']) {
            const m = buddyMetrics(stage, undefined, type);
            assertContained(buddy({ type, stage }), m, `${type}: stage ${stage}`);
        }
        assert.deepEqual(buddyMetrics(-3, undefined, type), buddyMetrics(1, undefined, type));
        assert.deepEqual(buddyMetrics(8, undefined, type), buddyMetrics(5, undefined, type));
        assert.equal(buddy({ type, stage: 1.8 }), buddy({ type, stage: 1 }));
    }
});
