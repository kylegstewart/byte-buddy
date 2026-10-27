// Pixel-art renderer for Byte Buddy. Every function returns an SVG markup string built from whole-pixel rects.

export const W = 160;
export const H = 120;
export const FLOOR_Y = 104;

export const rect = (x, y, w, h, fill, extra = "") =>
    w > 0 && h > 0 ? `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${fill}"${extra}/>` : "";

const STEPS = { 0: [[0, 0]], 1: [[1, 0], [0, 1]], 2: [[2, 0], [1, 1], [0, 2]], 3: [[3, 0], [1, 1], [0, 3]] };

/** Rounded rectangle made of stacked rects (pixel corners). */
export function box(x, y, w, h, r, fill, extra = "") {
    return (STEPS[r] || STEPS[0]).map(([ix, iy]) => rect(x + ix, y + iy, w - 2 * ix, h - 2 * iy, fill, extra)).join("");
}

/** Outlined rounded box with a highlight row and a shaded bottom. */
function shell(x, y, w, h, r, fill, outline) {
    return box(x - 1, y - 1, w + 2, h + 2, r, outline) + box(x, y, w, h, r, fill)
        + rect(x + r + 1, y + 1, Math.max(0, w - 2 * r - 4), 1, shade(fill, 0.35))
        + rect(x + r, y + h - 2, Math.max(0, w - 2 * r), 2, shade(fill, -0.18));
}

export function shade(hex, amount) {
    const n = parseInt(hex.slice(1), 16);
    const mix = (c) => Math.round(amount >= 0 ? c + (255 - c) * amount : c * (1 + amount));
    const r = mix((n >> 16) & 255), g = mix((n >> 8) & 255), b = mix(n & 255);
    return `#${((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1)}`;
}

const SIZES = {
    1: { hw: 18, hh: 14, bw: 12, bh: 8, leg: 0, eye: 3, arm: 2 },
    2: { hw: 22, hh: 16, bw: 16, bh: 11, leg: 6, eye: 4, arm: 2 },
    3: { hw: 24, hh: 17, bw: 18, bh: 13, leg: 7, eye: 4, arm: 3 },
    4: { hw: 26, hh: 18, bw: 22, bh: 15, leg: 8, eye: 4, arm: 3 },
    5: { hw: 28, hh: 19, bw: 24, bh: 15, leg: 8, eye: 5, arm: 3 },
};
/** Key vertical positions (relative to the feet) used for effects and thumbnails. */
export function metrics(stage = 1, variant = "variant-classic") {
    const s = { ...SIZES[Math.min(5, Math.max(1, stage))] };
    if (variant === "variant-boxy") { s.hw += 2; s.hh -= 1; }
    if (variant === "variant-bubble") s.hh += 2;
    const bottom = stage === 1 ? -7 : -s.leg;
    const by = bottom - s.bh;
    const hy = by - 1 - s.hh;
    return { headTop: hy, headH: s.hh, headW: s.hw, bodyTop: by, mouthY: hy + Math.round(s.hh * 0.72) };
}

const METAL = "#5b6576";
const DARK = "#2a3140";
const GOLD = "#f2c14e";
const GOLD_DARK = "#a87b1d";

/**
 * Draws the robot with its feet at local (0, 0).
 * opts: { stage, variant, body, eye, hat, glasses, headphones, neck, expr, look, bob, pose, frame, still }
 */
export function robot(opts) {
    const stage = Math.min(5, Math.max(1, opts.stage || 1));
    const variant = opts.variant || "variant-classic";
    const s = { ...SIZES[stage] };
    let radius = 2;
    if (variant === "variant-boxy") { s.hw += 2; s.hh -= 1; radius = 0; }
    if (variant === "variant-bubble") { s.hh += 2; radius = 3; }
    const body = opts.body || "#3fb8af";
    const eye = opts.eye || "#7cf8ff";
    const gold = stage >= 5;
    const outline = gold ? GOLD_DARK : shade(body, -0.6);
    const frame = opts.frame || 0;
    const pose = opts.pose || "stand";
    const bob = opts.bob || 0;
    const out = [];

    // Locomotion: wheel for Sprout, legs afterwards.
    let bottom;
    if (stage === 1) {
        out.push(box(-5, -6, 10, 6, 2, DARK), rect(-1, -4, 2, 2, "#9aa4b2"), rect(-3, -8, 6, 2, METAL));
        if (!opts.still && pose === "walk") out.push(rect(frame % 2 ? -3 : 1, -2, 2, 1, "#9aa4b2"));
        bottom = -7;
    } else {
        const legW = stage >= 4 ? 4 : 3;
        const leg = pose === "sit" ? 2 : s.leg;
        const lx = -Math.round(s.bw / 4) - Math.floor(legW / 2);
        const rx = Math.round(s.bw / 4) - Math.ceil(legW / 2);
        const step = pose === "walk" && !opts.still ? (frame % 4 < 2 ? 1 : 0) : 0;
        out.push(rect(lx, -leg - step, legW, leg, shade(body, -0.35)), rect(rx, -leg - (1 - step) * (pose === "walk" ? 1 : 0), legW, leg, shade(body, -0.35)));
        const foot = gold ? GOLD : DARK;
        out.push(rect(lx - 1, -2, legW + 2, 2, foot), rect(rx - 1, -2, legW + 2, 2, foot));
        bottom = -leg;
    }

    const by = bottom - s.bh - bob;
    const bx = -s.bw / 2;

    // Stage 4+: jet boosters behind the body.
    if (opts.neck === "neck-cape") out.push(capeBack(bx, by, s, frame, opts.still));
    if (stage >= 4) {
        out.push(box(bx - 3, by + s.bh - 7, 3, 6, 1, METAL), box(bx + s.bw, by + s.bh - 7, 3, 6, 1, METAL));
        if (pose === "jump" || opts.expr === "excited") {
            const flame = frame % 2 ? "#ffd166" : "#ff8c42";
            out.push(rect(bx - 3, by + s.bh - 1, 3, 2 + (frame % 2), flame), rect(bx + s.bw, by + s.bh - 1, 3, 2 + ((frame + 1) % 2), flame));
        }
    }

    // Arms.
    const armH = Math.max(3, s.bh - 3);
    const armColor = shade(body, -0.25);
    const hand = gold ? GOLD : "#c9d1dc";
    if (stage === 1) {
        out.push(rect(bx - 2, by + 3, 2, 2, armColor), rect(bx + s.bw, by + 3, 2, 2, armColor));
    } else {
        out.push(rect(bx - s.arm - 1, by + 2, s.arm, armH, armColor), rect(bx - s.arm - 1, by + 2 + armH, s.arm, 2, hand));
        if (pose === "wave" || pose === "cheer") {
            const sway = opts.still ? 0 : frame % 4 < 2 ? 0 : 1;
            out.push(rect(bx + s.bw + 1 + sway, by - armH + 3, s.arm, armH, armColor), rect(bx + s.bw + 1 + sway, by - armH + 1, s.arm, 2, hand));
            if (pose === "cheer") out.push(rect(bx - s.arm - 1, by - armH + 3, s.arm, armH, armColor), rect(bx - s.arm - 1, by - armH + 1, s.arm, 2, hand));
        } else {
            out.push(rect(bx + s.bw + 1, by + 2, s.arm, armH, armColor), rect(bx + s.bw + 1, by + 2 + armH, s.arm, 2, hand));
        }
    }

    // Body.
    out.push(shell(bx, by, s.bw, s.bh, Math.min(radius, 2), body, outline));
    if (stage >= 2) out.push(box(bx + 3, by + 3, s.bw - 6, s.bh - 6, 1, shade(body, 0.22)));
    if (stage >= 3) {
        out.push(box(bx - 3, by - 1, 6, 4, 1, shade(body, -0.3)), box(bx + s.bw - 3, by - 1, 6, 4, 1, shade(body, -0.3)));
        if (gold) out.push(rect(bx - 3, by - 1, 6, 1, GOLD), rect(bx + s.bw - 3, by - 1, 6, 1, GOLD));
    }
    if (stage >= 4) {
        out.push(rect(bx + 1, by + s.bh - 4, s.bw - 2, 2, shade(body, -0.4)));
        const pulse = opts.still ? 0.9 : 0.6 + 0.4 * Math.abs(Math.sin(frame / 4));
        out.push(box(-3, by + 3, 6, 6, 1, "#0f1a2a"), box(-2, by + 4, 4, 4, 1, eye, ` opacity="${pulse.toFixed(2)}"`), rect(-1, by + 5, 1, 1, "#ffffff"));
    }
    if (gold) out.push(rect(bx, by + s.bh - 1, s.bw, 1, GOLD));

    // Neck + head.
    out.push(rect(-2, by - 2, 4, 2, gold ? GOLD_DARK : METAL));
    const hx = -s.hw / 2;
    const hy = by - 1 - s.hh;
    if (opts.headphones) out.push(...headphonesBack(opts.headphones, hx, hy, s));
    if (variant === "variant-boxy") out.push(rect(hx - 3, hy + Math.floor(s.hh / 2) - 2, 2, 4, METAL), rect(hx + s.hw + 1, hy + Math.floor(s.hh / 2) - 2, 2, 4, METAL));
    else out.push(rect(hx - 2, hy + 4, 1, s.hh - 8, shade(body, -0.3)), rect(hx + s.hw + 1, hy + 4, 1, s.hh - 8, shade(body, -0.3)));

    // Antenna / sprout.
    out.push(...antenna(stage, hy, eye, frame, opts.still));
    out.push(shell(hx, hy, s.hw, s.hh, radius, body, gold ? GOLD : outline));
    if (variant === "variant-bubble") out.push(rect(hx + 3, hy + 1, 3, 1, "#ffffff", ' opacity="0.7"'));

    // Face screen.
    const inset = s.hw >= 24 ? 3 : 2;
    const sx = hx + inset, sy = hy + 3, sw = s.hw - inset * 2, sh = s.hh - 6;
    out.push(box(sx, sy, sw, sh, 1, "#141b27"), rect(sx + 1, sy + 1, 2, 1, "#ffffff", ' opacity="0.18"'));
    const face = faceParts({ expr: opts.expr || "normal", look: opts.look || 0, e: s.eye, sx, sy, sw, sh, eye, stage, frame });
    out.push(face.svg);

    if (opts.glasses) out.push(glasses(opts.glasses, face, sx, sw, eye));
    if (opts.headphones) out.push(headphonesFront(opts.headphones, hx, hy, s));
    if (opts.hat) out.push(hat(opts.hat, hx, hy, s, frame, opts.still));
    if (opts.neck) out.push(neckwear(opts.neck, bx, by, s));

    // Stage 5 aura: orbiting sparkles.
    if (gold) {
        const cy = by - s.hh / 2;
        for (let i = 0; i < 3; i++) {
            const angle = (opts.still ? 0.8 : frame * 0.22) + (i * Math.PI * 2) / 3;
            const px = Math.round(Math.cos(angle) * (s.hw / 2 + 9));
            const py = Math.round(cy + Math.sin(angle) * 6);
            out.push(sparkle(px, py, Math.sin(angle) < 0 ? "#fff3b0" : GOLD, Math.sin(angle) < 0 ? 0.55 : 1));
        }
    }
    return out.join("");
}

const BUDDY_SIZES = {
    cat: [[20, 15, 12, 10, 2], [22, 16, 14, 13, 4], [24, 17, 16, 15, 6], [26, 18, 18, 16, 7], [28, 19, 20, 17, 8]],
    dog: [[20, 16, 14, 10, 3], [24, 17, 18, 13, 5], [24, 18, 18, 16, 7], [28, 19, 24, 17, 8], [28, 20, 24, 18, 9]],
    dragon: [[18, 15, 14, 10, 2], [22, 17, 16, 13, 4], [24, 18, 18, 15, 6], [26, 19, 20, 17, 8], [28, 20, 24, 19, 9]],
    slime: [[20, 13, 20, 6, 0], [24, 15, 26, 7, 0], [26, 16, 30, 9, 0], [28, 17, 32, 10, 0], [30, 18, 34, 11, 0]],
};

const buddyStage = (stage) => Number.isFinite(stage) ? Math.min(5, Math.max(1, Math.floor(stage))) : 1;
const buddyType = (type) => Object.hasOwn(BUDDY_SIZES, type) ? type : "robot";

function creatureSize(type, stage, variant) {
    let [hw, hh, bw, bh, leg] = BUDDY_SIZES[type][stage - 1];
    if (variant === "variant-boxy") { hw += 2; hh -= 1; bw += 2; }
    if (variant === "variant-bubble") { hw += 2; hh += 2; bw += 2; bh += 2; }
    return { hw, hh, bw, bh, leg, eye: stage === 1 ? 3 : 4, arm: 3 };
}

function oval(x, y, w, h, fill) {
    let svg = "";
    for (let row = 0; row < h; row++) {
        const inset = Math.floor(w / 2 * (1 - Math.sqrt(1 - ((row + 0.5) * 2 / h - 1) ** 2)));
        svg += rect(x + inset, y + row, w - inset * 2, 1, fill);
    }
    return svg;
}

function creatureShell(x, y, w, h, variant, fill, outline) {
    if (variant === "variant-bubble") {
        return oval(x - 1, y - 1, w + 2, h + 2, outline) + oval(x, y, w, h, fill)
            + rect(x + Math.floor(w / 3), y + 2, Math.max(2, Math.floor(w / 4)), 1, shade(fill, 0.35));
    }
    return shell(x, y, w, h, variant === "variant-boxy" ? 0 : 3, fill, outline);
}

/**
 * Feet-local geometry, compatible with metrics(). headTop excludes ears/horns/hats.
 * bounds conservatively includes all cosmetics and animated poses (bob +/- 2).
 * viewBox includes the complete silhouette, including wings, tails and satellites.
 */
export function buddyMetrics(stage = 1, variant = "variant-classic", type = "robot") {
    stage = buddyStage(stage);
    type = buddyType(type);
    let m;
    if (type === "robot") m = metrics(stage, variant);
    else {
        const s = creatureSize(type, stage, variant);
        const bodyTop = -s.leg - s.bh;
        const headTop = bodyTop - 1 - s.hh;
        const eyeY = headTop + 3 + Math.max(1, Math.floor((s.hh - 5) * 0.3));
        m = { headTop, headH: s.hh, headW: s.hw, bodyTop,
            mouthY: Math.min(headTop + s.hh - 5, eyeY + s.eye + (stage >= 2 ? 1 : 0) + 2) };
    }
    const bounds = { left: -44, right: 44, top: m.headTop - 22, bottom: 6 };
    return { ...m, bounds, viewBox: `${bounds.left} ${bounds.top} ${bounds.right - bounds.left} ${bounds.bottom - bounds.top}` };
}

/** Common renderer. Robot calls deliberately pass through without changing its artwork. */
export function buddy(opts = {}) {
    const type = buddyType(opts.type);
    return type === "robot" ? robot(opts) : creature({ ...opts, stage: buddyStage(opts.stage), type });
}

const EVO_ACCENT = [null, "#56d364", "#58a6ff", "#bc8cff", "#f2c94c"];

// Every stage after the first gains a coloured accent set so stages differ by more than size.
function evolutionRegalia(type, stage, { s, bx, by, hx, hy }) {
    let back = "", front = "";
    if (stage < 2) return { back, front };
    const c = EVO_ACCENT[stage - 1], cd = shade(c, -0.45), cl = shade(c, 0.45);
    const cx = Math.floor(s.hw / 2);
    if (stage === 4) {
        back += `<g opacity=".32">${oval(bx - 8, by - 12, s.bw + 16, s.bh + 14, c)}</g>`;
        for (let i = -2; i <= 2; i++) back += rect(i * 7 - 1, by - 8 - (3 - Math.abs(i)) * 3, 3, 8 + (3 - Math.abs(i)) * 3, c);
    }
    if (stage === 5) {
        back += `<g opacity=".28">${        oval(bx - 14, by - 18, s.bw + 28, s.bh + 16, c)}</g>`
                    + `<g opacity=".4">${oval(bx - 8, by - 12, s.bw + 16, s.bh + 14, c)}</g>`;
    }
    if (type !== "slime") {
        front += rect(-cx + 2, by - 1, s.hw - 4, 3, cd) + rect(-cx + 3, by - 1, s.hw - 6, 2, c);
        if (stage === 2) front += rect(-1, by + 2, 3, 3, cl);
    }
    if (stage >= 3) {
        const py = type === "slime" ? by + 1 : by;
        for (const x of [bx - 3, -bx - 3]) {
            front += box(x, py, 6, 5, 1, cd) + rect(x + 1, py + 1, 4, 3, c);
            if (stage >= 4) front += rect(x + 2, py - 4, 2, 4, cl);
        }
        const ey = by + Math.floor(s.bh / 2) - 1;
        front += rect(-1, ey - 2, 3, 7, cd) + rect(-3, ey, 7, 3, cd) + rect(-1, ey - 1, 3, 5, c) + rect(-2, ey + 1, 5, 1, c);
    }
    if (stage === 4) {
        front += rect(-8, hy - 11, 2, 5, c) + rect(-1, hy - 14, 3, 8, c) + rect(6, hy - 11, 2, 5, c)
            + rect(-8, hy - 7, 16, 2, cd) + rect(-7, hy - 7, 14, 1, cl);
    }
    if (stage === 5) {
        front += rect(-9, hy - 13, 18, 1, c) + rect(-11, hy - 12, 3, 3, c) + rect(8, hy - 12, 3, 3, c)
            + rect(-9, hy - 9, 18, 1, c) + rect(-10, hy - 11, 1, 2, cl) + rect(9, hy - 11, 1, 2, cl)
            + sparkle(-bx + 6, by - 4, cl) + sparkle(bx - 8, by - 2, cl) + sparkle(0, hy - 17, "#ffffff");
    }
    return { back, front };
}

function creature(opts) {
    const { type, stage, variant } = opts;
    const s = creatureSize(type, stage, variant);
    const boxy = variant === "variant-boxy", bubble = variant === "variant-bubble";
    const body = opts.body || "#3fb8af", eye = opts.eye || "#7cf8ff";
    const dark = shade(body, -0.6), light = shade(body, 0.5);
    const frame = opts.frame || 0, pose = opts.pose || "stand";
    const sitting = pose === "sit" && type !== "slime";
    const by = -(sitting ? Math.min(2, s.leg - 1) : s.leg) - s.bh - (opts.bob || 0);
    const hy = by - 1 - s.hh, hx = -s.hw / 2, bx = -s.bw / 2;
    const moving = !opts.still && pose === "walk";
    const wag = opts.still ? 0 : frame % 4 < 2 ? 0 : 2;
    const ctx = { ...opts, s, body, eye, dark, light, frame, pose, by, hy, hx, bx, wag };
    const out = [];
    if (opts.neck === "neck-cape") out.push(capeBack(bx, by, s, frame, opts.still));
    const regalia = evolutionRegalia(type, stage, { s, bx, by, hx, hy });
    out.push(regalia.back);
    if (type === "cat") out.push(catBack(ctx));
    if (type === "dog") out.push(dogBack(ctx));
    if (type === "dragon") out.push(dragonBack(ctx));
    if (type === "slime") out.push(slimeBody(ctx));
    else {
        if (type === "dragon") out.push(dragonBody(ctx));
        else {
            out.push(creatureShell(bx, by, s.bw, s.bh, variant, body, dark));
            out.push(box(-Math.floor(s.bw / 4), by + 3, Math.floor(s.bw / 2), s.bh - 3, boxy ? 0 : 2, light));
        }
        const stride = moving ? (frame % 4 < 2 ? 1 : -1) : 0;
        for (const side of [-1, 1]) {
            const x = side < 0 ? bx + 1 : -bx - 5;
            if (type === "dragon") {
                out.push(box(x - 1, by + s.bh - 4, 6, 6, boxy ? 0 : 3, shade(body, -0.15)),
                    box(x, -5 - Math.max(0, side * stride), 4, 4, boxy ? 0 : 2, body));
            } else out.push(box(x, by + s.bh - 1, 4, Math.max(2, -by - s.bh - (side * stride)), boxy ? 0 : 1, shade(body, -0.2)));
            out.push(box(x - 1, -3 - Math.max(0, side * stride), 6, 3, boxy ? 0 : 1, body),
                rect(x, -1 - Math.max(0, side * stride), 1, 1, light));
        }
        if (type === "dragon" && stage === 1) {
            out.push(box(bx - 2, -9, s.bw + 4, 8, 2, "#f5ebd7"),
                rect(bx - 1, -11, 4, 4, "#f5ebd7"), rect(1, -10, 4, 3, "#f5ebd7"),
                rect(-4, -5, 3, 2, shade(body, 0.15)), rect(3, -4, 2, 2, shade(body, 0.15)));
        }
    }

    // Forepaws and slime pseudopods keep gestures readable without moving the feet pivot.
    const pawY = by + 3, paw = type === "dragon" ? light : shade(body, -0.12);
    for (const side of [-1, 1]) {
        const raised = pose === "cheer" || (pose === "wave" && side === 1);
        const x = side < 0 ? bx - 4 : -bx;
        const y = raised ? by - 6 - wag : pawY;
        out.push(box(x, y, 4, raised ? 8 : 6, boxy ? 0 : 1, paw));
        if (type !== "slime") out.push(rect(x + 1, y + (raised ? 0 : 5), 2, 1, light));
    }

    if (opts.headphones) out.push(...headphonesBack(opts.headphones, hx, hy, s));
    if (type !== "slime") {
        if (type === "dragon" && (boxy || bubble)) {
            out.push(creatureShell(hx, hy, s.hw, s.hh, variant, body, dark));
        } else if (type === "dragon") {
            out.push(`<g data-dragon-head="rounded">` + dragonPixels([[hx + 5, hy], [hx + s.hw - 5, hy], [hx + s.hw - 2, hy + 2],
                [hx + s.hw, hy + 6], [hx + s.hw - 1, hy + s.hh - 4], [hx + s.hw - 5, hy + s.hh],
                [hx + 5, hy + s.hh], [hx + 1, hy + s.hh - 4], [hx, hy + 6], [hx + 2, hy + 2]], body, dark) + "</g>");
        } else out.push(creatureShell(hx, hy, s.hw, s.hh, variant, body, dark));
        if (type === "cat") out.push(catHead(ctx));
        if (type === "dog") out.push(dogHead(ctx));
        if (type === "dragon") out.push(dragonHead(ctx));
    }
    const sx = hx + 3, sy = hy + 3, sw = s.hw - 6, sh = s.hh - 5;
    const my = Math.min(sy + sh - 3, sy + Math.max(1, Math.floor(sh * 0.3)) + s.eye + (stage >= 2 ? 1 : 0) + 2);
    if (type === "dragon") {
        out.push(box(-6, my - 2, 12, 7, 3, dark), box(-5, my - 2, 10, 6, 3, light),
            rect(-4, my - 1, 2, 1, shade(body, -0.3)), rect(3, my - 1, 2, 1, shade(body, -0.3)));
    } else if (type !== "slime") out.push(box(-5, my - 2, 10, 6, 2, light));
    const face = faceParts({ expr: opts.expr || "normal", look: opts.look || 0, e: s.eye, sx, sy, sw, sh, eye, stage, frame });
    out.push(face.svg);
    if (!["blink", "sleep", "sleepy", "happy", "chomp"].includes(opts.expr)) {
        for (const x of [face.ex1, face.ex2]) out.push(rect(x + 1, face.ey + 1, 1, 2, dark));
    }
    if (type === "cat" || type === "dog") {
        out.push(box(-1, my - 2, 3, 2, 1, type === "cat" ? "#ff8fb1" : DARK));
        if (type === "cat") out.push(rect(hx - 3, my - 1, 5, 1, dark), rect(hx + s.hw - 2, my - 1, 5, 1, dark),
            rect(hx - 2, my + 2, 4, 1, dark), rect(hx + s.hw - 2, my + 2, 4, 1, dark));
        if (type === "dog" && ["happy", "excited", "chomp"].includes(opts.expr)) out.push(box(0, my + 2, 3, 3, 1, "#ff8fb1"));
    }
    out.push(regalia.front);
    if (opts.glasses) out.push(glasses(opts.glasses, face, sx, sw, eye));
    if (opts.headphones) out.push(headphonesFront(opts.headphones, hx, hy, s));
    if (opts.hat) out.push(hat(opts.hat, hx, hy, s, frame, opts.still));
    if (opts.neck) out.push(neckwear(opts.neck, bx, by, s));
    return `<g data-buddy-type="${type}" data-buddy-stage="${stage}">${out.join("")}</g>`;
}

function catBack({ stage, s, bx, by, hy, body, dark, light, wag, eye }) {
    let svg = "";
    if (stage === 1) {
        // A kitten's curled tail wraps around the seated body.
        svg += box(bx + s.bw - 2, by + 4, 9, 9, 3, dark) + box(bx + s.bw, by + 5, 6, 5, 2, body);
    } else if (stage < 4) {
        svg += box(-bx + 1, by - 6 - wag, 5, s.bh + 3, 2, dark)
            + box(-bx + 2, by - 7 - wag, 7, 5, 2, body) + rect(-bx + 3, by - 6 - wag, 3, 2, light);
        if (stage === 3) svg += rect(-bx + 1, by + 2, 5, 2, light) + rect(-bx + 1, by + 7, 5, 2, light);
    } else {
        // Moon cat's crescent plume becomes three separate comet tails.
        const tails = stage === 5 ? 3 : 1;
        for (let i = 0; i < tails; i++) {
            const x = -bx + 3 + i * 6, y = by - 7 + i * 5 - wag;
            svg += box(x, y, 8, 16, 3, dark) + box(x + 1, y, 6, 12, 2, body)
                + rect(x - 2, y - 2, 6, 4, light) + rect(x - 3, y - 4, 3, 3, light);
        }
    }
    if (stage === 5) {
        for (const side of [-1, 1]) for (let i = 0; i < 3; i++) {
            svg += box(side < 0 ? -31 + i * 5 : 17 + i * 5, by - 6 + i * 3, 9, 3, 1, light);
        }
        svg += sparkle(-27, hy + 8, eye) + sparkle(29, hy + 3, GOLD);
    }
    return svg;
}

function catHead({ stage, hx, hy, s, body, dark, light }) {
    let svg = "";
    for (const x of [hx + 1, hx + s.hw - 7]) {
        svg += rect(x, hy - 4, 6, 6, dark) + rect(x + 1, hy - 7, 3, 4, dark)
            + rect(x + 1, hy - 3, 4, 5, body) + rect(x + 2, hy - 5, 1, 5, "#ffafcc");
        if (stage === 3) svg += rect(x, hy - 9, 1, 4, light) + rect(x + 3, hy - 8, 1, 3, light);
    }
    if (stage === 2 || stage === 3) svg += rect(-4, hy + 1, 2, 3, dark) + rect(2, hy + 1, 2, 3, dark);
    if (stage === 3) svg += rect(hx - 3, hy + s.hh - 5, 5, 4, light) + rect(hx + s.hw - 2, hy + s.hh - 5, 5, 4, light);
    if (stage === 4) svg += box(-3, hy + 1, 6, 5, 2, GOLD) + box(-1, hy, 5, 4, 2, body);
    if (stage === 5) svg += sparkle(0, hy + 3, GOLD) + rect(hx, hy + s.hh - 2, s.hw, 2, light);
    return svg;
}

function dogBack({ stage, s, bx, by, hy, body, dark, light, wag, eye }) {
    let svg = box(-bx, by + 3, 9, 5, 2, dark) + box(-bx + 6, by - 3 - wag, 5, 10, 2, body);
    if (stage === 1) return svg + rect(-bx + 7, by - 2 - wag, 2, 3, light);
    if (stage >= 3) svg += box(-bx + 5, by - 7 - wag, 8, 7, 2, light);
    if (stage === 3) {
        svg += box(bx - 5, by, 5, 11, 1, shade(body, -0.3)) + rect(bx - 4, by + 2, 3, 4, light);
    }
    if (stage >= 4) {
        for (const side of [-1, 1]) {
            for (let i = 0; i < 3; i++) svg += box(side < 0 ? bx - 6 + i * 2 : -bx - i * 2, by - 8 + i * 5, 6, 7, 1, i % 2 ? body : light);
        }
    }
    if (stage === 5) {
        svg += rect(bx - 6, hy - 3, s.bw + 12, 1, GOLD) + rect(bx - 8, hy - 1, 2, 3, GOLD)
            + rect(-bx + 6, hy - 1, 2, 3, GOLD) + sparkle(-bx + 12, by - 6 - wag, eye);
        for (let i = 0; i < 3; i++) svg += rect(-bx + 9 + i * 3, by - 5 - i * 3 - wag, 4, 3, light);
    }
    return svg;
}

function dogHead({ stage, hx, hy, s, body, dark, light, by, variant }) {
    let svg = "";
    const earBase = variant === "variant-bubble" ? 4 : 0;
    for (const side of [-1, 1]) {
        const x = side < 0 ? hx - 3 : hx + s.hw - 2;
        if (stage <= 2) svg += box(x, hy + 1, 6, s.hh - 2, 2, dark) + rect(x + 1, hy + 3, 2, s.hh - 7, shade(body, -0.2));
        else svg += rect(x, hy - 6, 5, 10 + earBase, dark) + rect(x + 1, hy - 9, 3, 4, dark)
            + rect(x + 1, hy - 4, 3, 5, light);
    }
    if (stage === 1) svg += box(hx + 2, hy + 3, 7, 7, 2, shade(body, -0.25));
    if (stage === 2) svg += rect(-2, hy, 4, 5, light);
    if (stage === 3) svg += rect(-2, hy - 3, 4, 6, light) + rect(-4, by + 2, 8, 2, dark);
    if (stage >= 4) {
        svg += rect(-2, hy + 1, 4, 4, light) + rect(-1, hy + 5, 2, 3, light);
        if (stage === 4) svg += box(-4, by + 3, 8, 7, 1, GOLD_DARK) + rect(-2, by + 4, 4, 4, GOLD) + rect(-1, by + 8, 2, 2, GOLD);
        else svg += sparkle(0, hy + 3, GOLD) + rect(hx - 1, hy + s.hh - 1, s.hw + 2, 2, light);
    }
    return svg;
}

// Scan-convert the dragon's organic contours to whole-pixel rows, including their outlines.
function dragonPixels(points, fill, outline) {
    const vertices = points.map(([x, y]) => [Math.round(x), Math.round(y)]);
    let svg = "";
    const ys = vertices.map(([, y]) => y);
    for (let y = Math.min(...ys); y < Math.max(...ys); y++) {
        const cuts = [];
        for (let i = 0; i < vertices.length; i++) {
            const [ax, ay] = vertices[i], [bx, by] = vertices[(i + 1) % vertices.length];
            if ((ay <= y + 0.5 && by > y + 0.5) || (by <= y + 0.5 && ay > y + 0.5)) {
                cuts.push(ax + (y + 0.5 - ay) * (bx - ax) / (by - ay));
            }
        }
        cuts.sort((a, b) => a - b);
        for (let i = 0; i + 1 < cuts.length; i += 2) {
            const left = Math.ceil(cuts[i]), right = Math.ceil(cuts[i + 1]);
            svg += rect(left, y, right - left, 1, fill);
        }
    }
    if (outline) for (let i = 0; i < vertices.length; i++) {
        svg += dragonBone(vertices[i], vertices[(i + 1) % vertices.length], outline);
    }
    return svg;
}

function dragonBone([ax, ay], [bx, by], color) {
    ax = Math.round(ax); ay = Math.round(ay); bx = Math.round(bx); by = Math.round(by);
    const steps = Math.max(Math.abs(bx - ax), Math.abs(by - ay));
    let svg = "";
    for (let i = 0; i <= steps; i++) {
        const t = steps ? i / steps : 0;
        svg += rect(Math.round(ax + (bx - ax) * t), Math.round(ay + (by - ay) * t), 1, 1, color);
    }
    return svg;
}

function dragonBody({ s, bx, by, body, dark, light, variant }) {
    const bottom = by + s.bh;
    if (variant === "variant-boxy" || variant === "variant-bubble") {
        const belly = variant === "variant-bubble" ? oval : (x, y, w, h, fill) => box(x, y, w, h, 0, fill);
        return box(-3, by - 3, 6, 6, 0, body) + creatureShell(bx, by, s.bw, s.bh, variant, body, dark)
            + belly(bx + 3, by + 3, s.bw - 6, s.bh - 4, light);
    }
    return `<g data-dragon-body="tapered">` + dragonPixels([[-3, by - 3], [3, by - 3], [s.bw / 2 - 1, by + 5],
        [s.bw / 2 + 1, bottom - 4], [s.bw / 2 - 3, bottom],
        [bx + 3, bottom], [bx - 1, bottom - 4], [bx + 1, by + 5]], body, dark)
        + dragonPixels([[-2, by + 2], [2, by + 2], [s.bw / 2 - 3, bottom - 4],
            [s.bw / 2 - 5, bottom - 1], [bx + 5, bottom - 1], [bx + 3, bottom - 4]], light)
        + rect(-2, bottom - 4, 5, 1, shade(body, 0.25)) + "</g>";
}

function dragonBack({ stage, bx, by, hy, s, body, dark, light, wag, pose, eye }) {
    const tailX = -bx - 2, tailY = by + s.bh - 4;
    let svg = dragonPixels([[tailX - 2, tailY], [tailX + 5, tailY + 1],
        [tailX + 12, tailY - 1 - wag], [tailX + 16, tailY - 6 - wag],
        [tailX + 17, tailY - 11 - wag], [tailX + 20, tailY - 7 - wag],
        [tailX + 18, tailY - 1 - wag], [tailX + 12, tailY + 4],
        [tailX + 5, tailY + 6], [tailX - 2, tailY + 4]], body, dark);
    svg += dragonBone([tailX + 4, tailY + 4], [tailX + 12, tailY + 2], light)
        + dragonPixels([[tailX + 15, tailY - 9 - wag], [tailX + 17, tailY - 14 - wag],
            [tailX + 20, tailY - 10 - wag], [tailX + 18, tailY - 7 - wag]], light, dark);
    for (const side of [-1, 1]) {
        const span = [7, 12, 18, 24, 29][stage - 1];
        const rise = [5, 9, 13, 17, 21][stage - 1];
        const rootX = s.bw / 2 - 2, rootY = by + 3;
        const lift = pose === "jump" || pose === "cheer" ? 3 : 0;
        const at = (x, y) => [side * Math.round(rootX + x), Math.round(rootY + y - lift)];
        const shoulder = at(0, 2), elbow = at(span * 0.35, -rise * 0.7), tip = at(span, -rise);
        const finger1 = at(span * 0.73, 2), finger2 = at(span * 0.35, 7);
        const contour = [shoulder, elbow, tip, at(span * 0.9, -rise + 5),
            at(span * 0.72, -rise + 4), finger1, at(span * 0.49, 1), finger2,
            at(span * 0.17, 4), at(0, 10)];
        svg += `<g data-dragon-wing="${side < 0 ? "left" : "right"}">`
            + dragonPixels(contour, shade(body, -0.14), dark)
            + dragonPixels([elbow, tip, at(span * 0.72, -rise + 4), finger1], shade(body, 0.22))
            + dragonPixels([elbow, finger1, at(span * 0.49, 1), finger2], shade(body, 0.06))
            + dragonBone(shoulder, elbow, light) + dragonBone(elbow, tip, light)
            + dragonBone(elbow, finger1, dark) + dragonBone(elbow, finger2, dark)
            + dragonBone(elbow, at(0, 10), dark)
            + rect(...tip, 2, 2, "#f5ebd7") + "</g>";
    }
    if (stage === 5) svg += sparkle(-35, hy + 1, eye) + sparkle(34, hy - 4, GOLD);
    return svg;
}

function dragonHead({ stage, hx, hy, s, body, dark, light, eye, variant }) {
    let svg = "";
    const hornBase = variant === "variant-bubble" ? 4 : 0;
    for (const side of [-1, 1]) {
        const x = side < 0 ? hx + 1 : hx + s.hw - 5;
        if (stage === 1) svg += rect(x, hy - 2, 3, 4 + hornBase, light);
        else {
            svg += rect(x, hy - 5, 4, 6 + hornBase, light) + rect(x + (side < 0 ? 0 : 2), hy - 8, 2, 4, "#f5ebd7");
            if (stage >= 4) svg += rect(x + side * 3, hy - 6, 4, 2, light) + rect(x + side * 4, hy - 10, 2, 5, "#f5ebd7");
        }
        if (stage >= 3) svg += rect(side < 0 ? hx - 4 : hx + s.hw, hy + 7, 4, 5, dark)
            + rect(side < 0 ? hx - 6 : hx + s.hw + 2, hy + 6, 4, 2, light);
        if (stage === 5) svg += rect(side < 0 ? hx - 8 : hx + s.hw + 2, hy + s.hh - 4, 6, 1, GOLD);
    }
    if (stage === 2) svg += rect(-1, hy - 4, 3, 5, light);
    if (stage === 3) svg += rect(-2, hy, 5, 3, light) + rect(-1, hy - 2, 3, 2, light);
    if (stage === 4) svg += rect(-3, hy + 1, 7, 2, dark) + rect(-1, hy + 2, 3, 3, eye);
    if (stage === 5) svg += sparkle(0, hy + 3, GOLD) + rect(-1, hy - 5, 3, 5, GOLD);
    return svg + rect(hx + 4, hy + s.hh - 4, 2, 1, body) + rect(hx + s.hw - 6, hy + s.hh - 4, 2, 1, body);
}

function slimeBody({ stage, s, hx, hy, bx, by, body, dark, light, eye, wag, pose, variant }) {
    let svg = "";
    const squash = pose === "sit" ? 3 : 0;
    const boxy = variant === "variant-boxy", bubble = variant === "variant-bubble";
    if (stage === 1) {
        svg += rect(-1, hy - 5, 3, 5, dark) + rect(-3, hy - 2, 7, 5, body);
    }
    if (stage === 3) {
        svg += rect(0, hy - 10, 2, 11, "#4f9d5d") + box(-7, hy - 8, 7, 4, 2, "#7bd389")
            + box(2, hy - 11, 7, 4, 2, "#7bd389");
        for (const [x, y] of [[-3, -15], [2, -14], [-4, -10], [2, -9]]) svg += box(x, hy + y, 4, 4, 1, "#ff8fb1");
        svg += box(0, hy - 12, 3, 3, 1, GOLD);
    }
    if (stage === 4) {
        for (let i = 0; i < 5; i++) {
            const x = -14 + i * 6, rise = i % 2 ? 6 : 10;
            svg += rect(x, hy - rise, 3, rise + 4, dark) + rect(x + 1, hy - rise + 1, 2, rise + 3, eye);
        }
    }
    if (stage === 5) {
        svg += box(-32, hy + 8 - wag, 9, 7, 3, body) + rect(-30, hy + 9 - wag, 2, 1, light)
            + box(24, hy - 1 + wag, 8, 6, 2, body) + rect(26, hy + wag, 2, 1, light)
            + sparkle(-23, hy - 7, GOLD) + sparkle(20, hy - 10, eye);
    }
    if (bubble) {
        svg += oval(hx, hy + squash, s.hw, -hy - squash, dark)
            + oval(hx + 1, hy + 1 + squash, s.hw - 2, -hy - squash - 2, body)
            + oval(bx - 1, by - 2, s.bw + 2, -by + 2, dark) + oval(bx, by - 1, s.bw, -by, body);
    } else {
        svg += box(hx, hy + squash, s.hw, -hy - squash, boxy ? 0 : 3, dark)
            + box(hx + 1, hy + 1 + squash, s.hw - 2, -hy - squash - 2, boxy ? 0 : 3, body)
            + box(bx - 1, by, s.bw + 2, -by, boxy ? 0 : 3, dark) + box(bx, by, s.bw, -by - 1, boxy ? 0 : 2, body);
    }
    if (stage >= 2) {
        for (let i = 0; i < (stage === 2 ? 3 : 4); i++) {
            svg += box(bx - 2 + i * Math.floor(s.bw / (stage === 2 ? 3 : 4)), -5, 8, 5, 2, body);
        }
    }
    if (pose === "walk") svg += box(bx - 3 + wag, -4, 8, 4, 2, body) + box(-bx - 3 - wag, -3, 6, 3, 1, body);
    svg += rect(hx + 3, hy + 4 + squash, 2, 4, light) + rect(hx + 5, hy + 2 + squash, 4, 2, light);
    if (stage === 2) svg += box(5, by - 2, 4, 3, 1, light);
    if (stage === 3) svg += box(-9, by, 4, 3, 1, "#7bd389") + box(5, by + 2, 3, 3, 1, "#ff8fb1");
    if (stage === 4) svg += rect(-4, by - 2, 9, 2, light) + rect(-2, by, 5, 4, eye) + rect(0, by + 4, 1, 2, light);
    if (stage === 5) svg += box(-6, by - 2, 12, 8, 3, shade(body, -0.25)) + sparkle(0, by + 1, eye)
        + rect(-11, by + 4, 2, 1, GOLD) + rect(9, by - 1, 2, 1, GOLD);
    return svg;
}

function antenna(stage, hy, eye, frame, still) {
    if (stage === 1) {
        return [rect(0, hy - 4, 1, 4, "#4f9d5d"), rect(-3, hy - 5, 3, 2, "#7bd389"), rect(1, hy - 7, 3, 2, "#7bd389"), rect(-2, hy - 5, 1, 1, "#a8e6b0")];
    }
    if (stage === 2) return [rect(0, hy - 4, 1, 4, METAL), box(-1, hy - 6, 3, 2, 0, eye)];
    const glow = still ? 0.35 : 0.2 + 0.25 * Math.abs(Math.sin(frame / 3));
    return [rect(0, hy - 6, 1, 6, METAL), box(-3, hy - 12, 7, 6, 2, eye, ` opacity="${glow.toFixed(2)}"`), box(-2, hy - 11, 5, 4, 1, eye), rect(-1, hy - 10, 1, 1, "#ffffff")];
}

function faceParts({ expr, look, e, sx, sy, sw, sh, eye, stage, frame }) {
    const cx = sx + sw / 2;
    const ey = sy + Math.max(1, Math.floor(sh * 0.3));
    const tall = stage >= 2 ? 1 : 0;
    const ex1 = Math.round(cx - sw / 4 - e / 2) + look;
    const ex2 = Math.round(cx + sw / 4 - e / 2) + look;
    const my = Math.min(sy + sh - 3, ey + e + tall + 2);
    const mouthColor = eye;
    const parts = [];
    const open = (x) => [rect(x, ey, e, e + tall, eye), e >= 4 ? rect(x, ey, 1, 1, "#ffffff") : ""];
    switch (expr) {
        case "blink":
        case "sleep":
            for (const x of [ex1, ex2]) parts.push(rect(x, ey + e - 1 + tall, e, 1, eye));
            break;
        case "happy":
        case "chomp":
            for (const x of [ex1, ex2]) parts.push(rect(x, ey + 1, 1, 2, eye), rect(x + 1, ey, e - 2, 1, eye), rect(x + e - 1, ey + 1, 1, 2, eye));
            break;
        case "excited":
            for (const x of [ex1, ex2]) parts.push(rect(x - 1, ey - 1, e + 2, e + 1 + tall, eye), rect(x, ey, 1, 1, "#ffffff"), rect(x + e - 1, ey + e - 1, 1, 1, "#ffffff"));
            break;
        case "sleepy":
            for (const x of [ex1, ex2]) parts.push(rect(x, ey + Math.ceil(e / 2), e, Math.floor(e / 2) + tall, eye), rect(x - 1, ey + Math.ceil(e / 2) - 1, e + 2, 1, shade(eye, -0.5)));
            break;
        case "curious":
            parts.push(...open(ex1), rect(ex2 - 1, ey - 1, e + 1, e + 1 + tall, eye), rect(ex2 - 1, ey - 1, 1, 1, "#ffffff"));
            break;
        default:
            parts.push(...open(ex1), ...open(ex2));
    }
    const m = Math.round(cx);
    switch (expr) {
        case "excited":
            parts.push(rect(m - 2, my, 5, 2, mouthColor), rect(m - 1, my + 1, 3, 1, "#ff7a9a"));
            break;
        case "chomp":
            parts.push(frame % 4 < 2 ? rect(m - 2, my, 5, 2, mouthColor) : rect(m - 2, my + 1, 5, 1, mouthColor));
            break;
        case "happy":
        case "smile":
            parts.push(rect(m - 3, my, 1, 1, mouthColor), rect(m - 2, my + 1, 5, 1, mouthColor), rect(m + 3, my, 1, 1, mouthColor));
            break;
        case "curious":
            parts.push(rect(m, my, 2, 2, mouthColor));
            break;
        case "sleep":
        case "sleepy":
            parts.push(rect(m - 1, my + 1, 2, 1, mouthColor));
            break;
        default:
            parts.push(rect(m - 2, my, 1, 1, mouthColor), rect(m - 1, my + 1, 3, 1, mouthColor), rect(m + 2, my, 1, 1, mouthColor));
    }
    if (stage >= 3) {
        const bright = ["happy", "excited", "smile", "chomp"].includes(expr);
        parts.push(rect(sx + 1, my - 1, 2, 1, "#ff8fb1", ` opacity="${bright ? 1 : 0.5}"`), rect(sx + sw - 3, my - 1, 2, 1, "#ff8fb1", ` opacity="${bright ? 1 : 0.5}"`));
    }
    return { svg: parts.join(""), ex1, ex2, ey, e, tall };
}

function glasses(id, face, sx, sw, eye) {
    const { ex1, ex2, ey, e, tall } = face;
    const h = e + tall;
    const span = ex2 + e + 2 - (ex1 - 2);
    if (id === "glasses-shades") {
        return rect(ex1 - 2, ey - 1, span, h + 2, "#0b0d12") + rect(ex1 - 2, ey - 1, span, 1, "#3a3f4b") + rect(ex1 - 1, ey, 2, 1, "#6c7380") + rect(ex2 - 1, ey, 2, 1, "#6c7380");
    }
    if (id === "glasses-visor") {
        return rect(sx, ey - 1, sw, h + 2, eye, ' opacity="0.4"') + rect(sx, ey - 1, sw, 1, "#ffffff", ' opacity="0.6"');
    }
    if (id === "glasses-3d") {
        return rect(ex1 - 2, ey - 2, span, h + 4, "#f8f9fa") + rect(ex1 - 1, ey - 1, e + 2, h + 2, "#e63946", ' opacity="0.85"') + rect(ex2 - 1, ey - 1, e + 2, h + 2, "#4cc9f0", ' opacity="0.85"');
    }
    if (id === "glasses-hearts") {
        const heart = (x) => rect(x - 2, ey - 2, 3, 1, "#ff5d8f") + rect(x + e - 1, ey - 2, 3, 1, "#ff5d8f") + rect(x - 2, ey - 1, e + 4, h, "#ff5d8f", ' opacity="0.9"')
            + rect(x - 1, ey + h - 1, e + 2, 1, "#ff5d8f") + rect(x, ey + h, e, 1, "#ff5d8f") + rect(x - 1, ey - 1, 1, 1, "#ffc2d4");
        return heart(ex1) + heart(ex2) + rect(ex1 + e + 2, ey, ex2 - ex1 - e - 4, 1, "#ff5d8f");
    }
    if (id === "glasses-goggles") {
        const lens = (x) => box(x - 2, ey - 2, e + 4, h + 4, 1, "#adb5bd") + rect(x - 1, ey - 1, e + 2, h + 2, "#ffb703", ' opacity="0.75"') + rect(x - 1, ey - 1, 1, 1, "#ffffff");
        return rect(sx - 3, ey + Math.floor(h / 2), sw + 6, 2, "#5c4033") + lens(ex1) + lens(ex2);
    }
    const frame = id === "glasses-monocle" ? GOLD : "#e3e7ee";
    const ring = (x) => rect(x - 1, ey - 2, e + 2, 1, frame) + rect(x - 1, ey + h + 1, e + 2, 1, frame) + rect(x - 2, ey - 1, 1, h + 2, frame) + rect(x + e + 1, ey - 1, 1, h + 2, frame);
    if (id === "glasses-monocle") {
        return ring(ex2) + rect(ex2, ey - 1, e, h + 2, "#ffffff", ' opacity="0.25"') + rect(ex2 + e + 1, ey + h + 2, 1, 2, GOLD_DARK) + rect(ex2 + e + 2, ey + h + 4, 1, 2, GOLD_DARK);
    }
    return ring(ex1) + ring(ex2) + rect(ex1 + e + 2, ey, ex2 - ex1 - e - 4, 1, frame);
}

const PHONES = {
    "phones-classic": { band: "#2b2d42", cup: "#2b2d42", accent: "#ef476f" },
    "phones-cat": { band: "#ffafcc", cup: "#ffc8dd", accent: "#ff8fab" },
    "phones-earmuffs": { band: "#adb5bd", cup: "#f8f9fa", accent: "#dee2e6", fluffy: true },
    "phones-dj": { band: "#14161f", cup: "#14161f", accent: "#3ddc84", glow: true },
};
const phonesStyle = (id) => PHONES[id === "headphones-cat" ? "phones-cat" : id] || PHONES["phones-classic"];

function headphonesBack(id, hx, hy, s) {
    const { band } = phonesStyle(id);
    return [rect(hx - 1, hy - 3, s.hw + 2, 2, band), rect(hx - 2, hy - 2, 2, 4, band), rect(hx + s.hw, hy - 2, 2, 4, band)];
}

function headphonesFront(id, hx, hy, s) {
    const style = phonesStyle(id);
    const { cup, accent } = style;
    const cy = hy + Math.floor(s.hh / 2) - 4;
    if (style.fluffy) {
        const puff = (x) => box(x, cy - 1, 7, 11, 3, cup) + rect(x + 1, cy + 2, 1, 1, accent) + rect(x + 4, cy + 1, 1, 1, accent) + rect(x + 2, cy + 5, 1, 1, accent) + rect(x + 5, cy + 6, 1, 1, accent) + rect(x + 3, cy + 8, 1, 1, accent);
        return puff(hx - 5) + puff(hx + s.hw - 2);
    }
    if (style.glow) {
        const can = (x) => box(x, cy - 1, 6, 11, 1, cup) + rect(x + 1, cy + 1, 4, 7, "#22263a") + rect(x + 2, cy + 2, 2, 5, accent, ' class="led"') + rect(x, cy + 9, 6, 1, "#f72585");
        return can(hx - 5) + can(hx + s.hw - 1) + rect(hx + 1, hy - 3, s.hw - 2, 1, accent, ' class="led led1"');
    }
    let svg = box(hx - 4, cy, 5, 9, 1, cup) + rect(hx - 3, cy + 2, 2, 5, accent) + box(hx + s.hw - 1, cy, 5, 9, 1, cup) + rect(hx + s.hw + 1, cy + 2, 2, 5, accent);
    if (id === "phones-cat") {
        for (const ex of [hx + 2, hx + s.hw - 7]) svg += rect(ex, hy - 5, 5, 2, cup) + rect(ex + 1, hy - 7, 3, 2, cup) + rect(ex + 2, hy - 8, 1, 1, cup) + rect(ex + 2, hy - 6, 1, 2, accent);
    }
    return svg;
}

function cone(cx, baseY, rows, colors, tilt = 0) {
    let svg = "";
    for (let r = 0; r < rows; r++) {
        const w = 1 + Math.round((r * (rows + 1)) / rows);
        const color = colors[Math.floor(r / 3) % colors.length];
        svg += rect(Math.round(cx - w / 2 + ((rows - r) * tilt) / rows), baseY - rows + r, w, 1, color);
    }
    return svg;
}

function hat(id, hx, hy, s, frame, still) {
    const hw = s.hw;
    switch (id) {
        case "hat-beanie":
            return box(hx + 1, hy - 4, hw - 2, 6, 2, "#e05d5d") + rect(hx + 3, hy - 2, hw - 6, 1, "#f08a8a") + rect(hx, hy + 1, hw, 2, "#c44545") + box(-2, hy - 8, 4, 4, 1, "#fff3e0");
        case "hat-party":
            return cone(0, hy + 1, 12, ["#7c5cff", "#ffd23f"]) + box(-2, hy - 14, 4, 3, 1, "#ff6fb5");
        case "hat-propeller": {
            const wide = still || frame % 2 === 0;
            return box(hx + 3, hy - 3, hw - 6, 5, 2, "#3a86ff") + rect(-1, hy - 3, 2, 5, "#ffbe0b") + rect(hx + 1, hy + 1, 6, 1, "#2c6fd6")
                + rect(0, hy - 6, 1, 3, METAL) + (wide ? rect(-7, hy - 7, 15, 1, "#e63946") : rect(-3, hy - 7, 7, 1, "#e63946")) + rect(-1, hy - 8, 3, 2, "#ffbe0b");
        }
        case "hat-helmet":
            return box(hx - 1, hy - 4, hw + 2, 7, 2, "#d62828") + rect(hx - 3, hy + 2, hw + 6, 2, "#a4161a") + rect(-1, hy - 7, 2, 4, "#a4161a") + box(-3, hy - 3, 6, 4, 1, "#ffd166") + rect(-1, hy - 2, 2, 2, "#d62828");
        case "hat-wizard": {
            let svg = cone(0, hy + 1, 16, ["#5a4fcf", "#5a4fcf", "#4a3fb8"], 5) + rect(hx - 3, hy, hw + 6, 2, "#3f37a6");
            svg += rect(-2, hy - 6, 1, 1, "#ffd23f") + rect(1, hy - 10, 1, 1, "#ffd23f") + rect(-1, hy - 3, 1, 1, "#fff3b0") + rect(4, hy - 15, 2, 2, "#ffd23f");
            return svg;
        }
        case "hat-crown":
            return rect(hx + 4, hy - 3, hw - 8, 4, GOLD) + rect(hx + 4, hy, hw - 8, 1, GOLD_DARK)
                + rect(hx + 4, hy - 6, 2, 3, GOLD) + rect(-1, hy - 7, 2, 4, GOLD) + rect(hx + hw - 6, hy - 6, 2, 3, GOLD)
                + rect(-1, hy - 2, 2, 2, "#e63946") + rect(hx + 6, hy - 2, 2, 1, "#4cc9f0") + rect(hx + hw - 8, hy - 2, 2, 1, "#4cc9f0");
        case "hat-headset":
            return rect(hx - 1, hy - 3, hw + 2, 2, "#3a3f4b") + rect(hx - 2, hy - 2, 2, 4, "#3a3f4b") + rect(hx + hw, hy - 2, 2, 4, "#3a3f4b")
                + box(hx - 4, hy + 2, 5, 8, 1, "#2b2d42") + rect(hx - 3, hy + 4, 2, 4, "#3a86ff") + box(hx + hw - 1, hy + 2, 5, 8, 1, "#2b2d42")
                + rect(hx - 2, hy + 10, 1, s.hh - 13, "#3a3f4b") + rect(hx - 2, hy + s.hh - 3, 8, 1, "#3a3f4b") + rect(hx + 5, hy + s.hh - 4, 2, 2, "#ef476f");
        case "hat-chef":
            return rect(hx + 2, hy - 3, hw - 4, 4, "#f1f3f5") + rect(hx + 2, hy, hw - 4, 1, "#dee2e6")
                + box(hx, hy - 11, hw, 9, 3, "#ffffff") + box(hx - 2, hy - 9, 8, 7, 2, "#ffffff") + box(hx + hw - 6, hy - 9, 8, 7, 2, "#ffffff")
                + box(-5, hy - 14, 10, 6, 2, "#ffffff") + rect(-4, hy - 6, 1, 3, "#e9ecef") + rect(3, hy - 7, 1, 4, "#e9ecef");
        case "hat-cowboy":
            return rect(hx - 5, hy, hw + 10, 2, "#8b5a2b") + rect(hx - 7, hy - 2, 2, 2, "#8b5a2b") + rect(hx + hw + 5, hy - 2, 2, 2, "#8b5a2b")
                + box(hx + 3, hy - 8, hw - 6, 9, 2, "#a0522d") + rect(-1, hy - 8, 2, 2, "#7a3f1d") + rect(hx + 4, hy - 7, 1, 5, "#c47a45")
                + rect(hx + 3, hy - 3, hw - 6, 2, "#3b2416") + rect(-1, hy - 3, 2, 2, GOLD);
        case "hat-tophat":
            return rect(hx - 2, hy - 1, hw + 4, 2, "#1b1b1b") + rect(hx + 4, hy - 14, hw - 8, 13, "#212529") + rect(hx + 4, hy - 14, hw - 8, 1, "#343a40")
                + rect(hx + 5, hy - 13, 1, 9, "#495057") + rect(hx + 4, hy - 5, hw - 8, 3, "#e63946");
        case "hat-explorer":
            return rect(hx - 3, hy, hw + 6, 2, "#6f4e37") + box(hx + 3, hy - 7, hw - 6, 8, 2, "#8b6b4a") + rect(-2, hy - 7, 4, 2, "#6f4e37")
                + rect(hx + 3, hy - 2, hw - 6, 2, "#3b2416") + rect(hx + 4, hy - 6, 1, 3, "#a68a6d");
        case "hat-viking":
            return rect(hx - 3, hy - 3, 3, 2, "#f1e3c8") + rect(hx - 5, hy - 7, 2, 5, "#f1e3c8") + rect(hx - 5, hy - 9, 1, 2, "#e0cfa9")
                + rect(hx + hw, hy - 3, 3, 2, "#f1e3c8") + rect(hx + hw + 3, hy - 7, 2, 5, "#f1e3c8") + rect(hx + hw + 4, hy - 9, 1, 2, "#e0cfa9")
                + box(hx + 1, hy - 6, hw - 2, 8, 3, "#9aa4b2") + rect(hx + 4, hy - 4, 3, 1, "#c9d1dc") + rect(hx, hy, hw, 2, "#6c7380")
                + rect(-1, hy - 6, 2, 6, "#6c7380") + rect(-1, hy + 2, 2, 2, "#6c7380") + rect(hx + 3, hy, 1, 1, "#c9d1dc") + rect(hx + hw - 4, hy, 1, 1, "#c9d1dc");
        case "hat-detective": {
            let svg = box(hx + 1, hy - 6, hw - 2, 8, 3, "#8d6e4a") + rect(hx - 2, hy + 1, 7, 1, "#6b5235") + rect(hx + hw - 5, hy + 1, 7, 1, "#6b5235");
            for (let x = hx + 3; x < hx + hw - 2; x += 4) svg += rect(x, hy - 5, 1, 7, "#6b5235", ' opacity="0.55"');
            svg += rect(hx + 2, hy - 3, hw - 4, 1, "#6b5235", ' opacity="0.55"') + rect(-3, hy - 8, 6, 2, "#6b5235") + rect(-1, hy - 9, 2, 1, "#4a3825");
            return svg;
        }
        case "hat-pirate":
            return rect(hx - 3, hy - 5, 4, 4, "#212529") + rect(hx + hw - 1, hy - 5, 4, 4, "#212529") + box(hx + 1, hy - 8, hw - 2, 9, 2, "#212529")
                + rect(hx - 2, hy - 1, hw + 4, 2, "#1b1b1b") + rect(hx - 2, hy - 1, hw + 4, 1, GOLD)
                + box(-2, hy - 7, 5, 4, 1, "#f8f9fa") + rect(-1, hy - 6, 1, 1, "#1b1b1b") + rect(1, hy - 6, 1, 1, "#1b1b1b") + rect(-2, hy - 2, 1, 1, "#f8f9fa") + rect(2, hy - 2, 1, 1, "#f8f9fa");
        case "hat-halo": {
            const y = hy - 15 + (still ? 0 : frame % 12 < 6 ? 0 : 1);
            return rect(-7, y, 14, 1, "#fff3b0", ' opacity="0.6"') + rect(-6, y + 1, 12, 1, GOLD) + rect(-8, y + 2, 3, 1, GOLD) + rect(5, y + 2, 3, 1, GOLD)
                + rect(-6, y + 3, 12, 1, GOLD_DARK) + rect(-3, y + 1, 2, 1, "#fff3b0");
        }
        default:
            return "";
    }
}

function neckwear(id, bx, by, s) {
    switch (id) {
        case "neck-bowtie":
            return rect(-5, by - 2, 4, 4, "#e63946") + rect(1, by - 2, 4, 4, "#e63946") + rect(-1, by - 1, 2, 2, "#9d0208");
        case "neck-scarf":
            return rect(bx + 1, by - 1, s.bw - 2, 3, "#f77f00") + rect(bx + 3, by, 2, 1, "#fcbf49") + rect(bx + 8, by, 2, 1, "#fcbf49")
                + rect(bx + s.bw - 6, by + 2, 3, 5, "#f77f00") + rect(bx + s.bw - 6, by + 6, 3, 1, "#fcbf49");
        case "neck-bugbadge":
            return box(bx + 1, by + 2, 6, 6, 1, "#2d6a4f") + rect(bx + 2, by + 3, 4, 4, "#e63946") + rect(bx + 4, by + 3, 1, 4, "#1b1b1b") + rect(bx + 2, by + 4, 1, 1, "#1b1b1b") + rect(bx + 5, by + 5, 1, 1, "#1b1b1b");
        case "neck-star":
            return sparkle(bx + s.bw - 4, by + 4, GOLD, 1) + rect(bx + s.bw - 4, by + 4, 1, 1, "#fff3b0");
        case "neck-tie":
            return rect(bx + 2, by - 1, s.bw - 4, 1, "#f8f9fa") + rect(-1, by - 1, 3, 2, "#1d3557") + rect(-1, by + 1, 3, s.bh - 4, "#457b9d")
                + rect(0, by + s.bh - 3, 1, 1, "#457b9d") + rect(-1, by + 3, 3, 1, "#a8dadc") + rect(-1, by + 6, 3, 1, "#a8dadc");
        case "neck-lanyard":
            return rect(-5, by - 1, 1, 3, "#3a86ff") + rect(-4, by + 2, 1, 2, "#3a86ff") + rect(4, by - 1, 1, 3, "#3a86ff") + rect(3, by + 2, 1, 2, "#3a86ff")
                + box(-3, by + 4, 7, 6, 1, "#ffffff") + rect(-2, by + 5, 5, 1, "#3a86ff") + rect(-2, by + 7, 2, 2, "#adb5bd") + rect(1, by + 7, 2, 1, "#adb5bd");
        case "neck-medal":
            return rect(-4, by - 1, 2, 4, "#e63946") + rect(3, by - 1, 2, 4, "#457b9d") + rect(-2, by + 2, 5, 2, "#e63946")
                + box(-2, by + 4, 5, 5, 2, GOLD) + rect(-1, by + 5, 3, 3, GOLD_DARK) + rect(0, by + 6, 1, 1, "#fff3b0");
        case "neck-bandana":
            return rect(bx + 1, by - 1, s.bw - 2, 2, "#d62828") + rect(-4, by + 1, 9, 2, "#d62828") + rect(-3, by + 3, 7, 1, "#d62828") + rect(-2, by + 4, 5, 1, "#d62828") + rect(-1, by + 5, 3, 1, "#d62828")
                + rect(bx + 3, by - 1, 1, 1, "#ffffff") + rect(-2, by + 1, 1, 1, "#ffffff") + rect(2, by + 2, 1, 1, "#ffffff") + rect(0, by + 4, 1, 1, "#ffffff") + rect(bx + s.bw - 4, by, 1, 1, "#ffffff");
        case "neck-cape":
            return rect(bx, by - 1, s.bw, 2, "#c1121f") + rect(bx, by - 1, s.bw, 1, "#e5383b") + box(bx + 1, by - 1, 3, 3, 1, GOLD) + box(bx + s.bw - 4, by - 1, 3, 3, 1, GOLD);
        case "neck-chain": {
            let svg = "";
            for (let i = 0; i < 4; i++) svg += rect(-6 + i, by - 1 + i, 1, 1, i % 2 ? GOLD_DARK : GOLD) + rect(5 - i, by - 1 + i, 1, 1, i % 2 ? GOLD_DARK : GOLD);
            return svg + box(-2, by + 3, 5, 6, 1, GOLD) + rect(-1, by + 4, 3, 3, "#4cc9f0") + rect(-1, by + 4, 1, 1, "#ffffff");
        }
        default:
            return "";
    }
}

function capeBack(bx, by, s, frame, still) {
    const flutter = still ? 0 : frame % 8 < 4 ? 0 : 1;
    const len = s.bh + 3;
    let svg = "";
    for (let r = 0; r < len; r++) {
        const spread = 2 + Math.floor((r * (s.arm + 5)) / len) + (r > len / 2 ? flutter : 0);
        svg += rect(bx - spread, by + r, s.bw + spread * 2, 1, "#9d0208") + rect(bx - spread, by + r, 1, 1, "#c1121f") + rect(bx + s.bw + spread - 1, by + r, 1, 1, "#6a040f");
    }
    return svg + rect(bx - s.arm - 7 - flutter, by + len, s.bw + (s.arm + 7 + flutter) * 2, 1, "#6a040f");
}

export function sparkle(x, y, color, opacity = 1) {
    const o = opacity < 1 ? ` opacity="${opacity}"` : "";
    return rect(x - 1, y, 3, 1, color, o) + rect(x, y - 1, 1, 3, color, o);
}

// ---------- Furniture ----------
export const FURNITURE = {
    "furn-rug": { x: 52, y: 99, w: 56, h: 11, layer: "floor", draw: () =>
        rect(8, 0, 40, 1, "#9c3d2e") + rect(3, 1, 50, 9, "#9c3d2e") + rect(0, 3, 56, 5, "#9c3d2e") + rect(8, 10, 40, 1, "#9c3d2e")
        + rect(9, 1, 38, 1, "#e76f51") + rect(4, 2, 48, 7, "#e76f51") + rect(1, 4, 54, 3, "#e76f51") + rect(9, 9, 38, 1, "#e76f51")
        + rect(10, 4, 36, 3, "#f4a261") + rect(14, 5, 28, 1, "#e9c46a") },
    "furn-shelf": { x: 112, y: 14, w: 36, h: 28, layer: "wall", draw: () => {
        let svg = rect(0, 0, 36, 28, "#6b4226") + rect(2, 2, 32, 11, "#4a2c19") + rect(2, 15, 32, 11, "#4a2c19") + rect(0, 13, 36, 2, "#8d5a3b");
        const books = ["#e63946", "#457b9d", "#f4a261", "#2a9d8f", "#e9c46a", "#8338ec", "#fb8500"];
        let x = 3;
        books.forEach((c, i) => { const h = 8 + (i % 3); svg += rect(x, 13 - h, 3, h, c) + rect(x, 13 - h + 2, 3, 1, shade(c, 0.4)); x += 4; });
        svg += box(4, 21, 8, 5, 1, "#c8553d") + rect(5, 18, 2, 3, "#5a9e4b") + rect(8, 17, 2, 4, "#7bd389");
        svg += rect(16, 20, 14, 6, "#e9ecef") + rect(17, 21, 12, 4, "#3d5a80") + rect(18, 22, 5, 1, "#98c1d9");
        return svg; } },
    "furn-trophy": { x: 50, y: 20, w: 22, h: 16, layer: "wall", draw: () =>
        rect(0, 13, 22, 3, "#8d5a3b") + rect(1, 16, 2, 0, "#6b4226")
        + box(3, 2, 8, 6, 1, GOLD) + rect(1, 3, 2, 3, GOLD_DARK) + rect(11, 3, 2, 3, GOLD_DARK) + rect(6, 8, 2, 3, GOLD_DARK) + rect(4, 11, 6, 2, GOLD_DARK) + rect(4, 3, 2, 2, "#fff3b0")
        + rect(15, 6, 5, 7, "#c0c7d1") + rect(16, 7, 3, 2, "#e9ecef") + rect(17, 10, 1, 2, "#e63946") },
    "furn-lamp": { x: 3, y: 50, w: 13, h: 54, layer: "back", draw: (ctx = {}) =>
        (ctx.night ? `<ellipse cx="6.5" cy="8" rx="16" ry="14" fill="#ffd166" opacity="0.22"/>` : "")
        + rect(2, 0, 9, 2, "#f6bd60") + rect(1, 2, 11, 3, "#f6bd60") + rect(0, 5, 13, 4, "#f7c873") + rect(1, 8, 11, 1, "#d99b3a")
        + rect(6, 9, 1, 41, "#4a4e5a") + rect(2, 50, 9, 2, "#4a4e5a") + rect(1, 52, 11, 2, "#33363f") },
    "furn-arcade": { x: 17, y: 62, w: 20, h: 42, layer: "back", draw: (ctx = {}) =>
        rect(0, 4, 20, 38, "#3a0ca3") + rect(0, 0, 20, 5, "#7209b7") + rect(2, 1, 16, 3, "#f72585") + rect(4, 2, 12, 1, "#ffd6ff")
        + rect(2, 7, 16, 12, "#14161f") + rect(3, 8, 14, 10, ctx.frameOdd ? "#3a86ff" : "#4cc9f0", ' class="flicker"')
        + rect(5, 11, 3, 3, "#ffd23f") + rect(11, 13, 2, 2, "#f72585") + rect(8, 10, 1, 1, "#ffffff")
        + rect(0, 20, 20, 6, "#560bad") + rect(4, 21, 1, 3, "#c0c7d1") + rect(3, 20, 3, 2, "#e63946") + rect(10, 22, 2, 2, "#ffd23f") + rect(14, 22, 2, 2, "#4cc9f0")
        + rect(2, 30, 16, 1, "#7209b7") + rect(7, 33, 6, 4, "#14161f") },
    "furn-plant": { x: 123, y: 76, w: 14, h: 28, layer: "back", draw: () =>
        rect(6, 0, 2, 6, "#5a9e4b") + rect(2, 3, 4, 3, "#7bd389") + rect(8, 1, 4, 3, "#7bd389") + rect(1, 7, 5, 3, "#5a9e4b") + rect(8, 6, 5, 4, "#5a9e4b")
        + rect(4, 9, 6, 5, "#7bd389") + rect(3, 12, 8, 4, "#4f8f42") + rect(5, 3, 1, 1, "#a8e6b0")
        + rect(1, 16, 12, 2, "#e07a5f") + rect(2, 18, 10, 8, "#c8553d") + rect(3, 26, 8, 2, "#a8432f") + rect(3, 19, 2, 5, "#e07a5f") },
    "furn-tank": { x: 138, y: 70, w: 20, h: 34, layer: "back", draw: () =>
        rect(0, 0, 20, 1, "#5b6576") + rect(0, 1, 20, 15, "#bde0fe", ' opacity="0.85"') + rect(1, 4, 18, 12, "#48cae4")
        + rect(1, 14, 18, 2, "#e9c46a") + rect(3, 10, 1, 4, "#2a9d8f") + rect(4, 8, 1, 6, "#40916c") + rect(15, 9, 1, 5, "#2a9d8f")
        + `<g class="fish">${rect(6, 7, 4, 3, "#fb8500") + rect(10, 8, 2, 1, "#fb8500") + rect(5, 7, 1, 1, "#ffffff")}</g>`
        + rect(2, 2, 1, 1, "#ffffff", ' opacity="0.8"') + rect(12, 5, 1, 1, "#ffffff", ' opacity="0.7"')
        + rect(0, 16, 20, 3, "#6b4226") + rect(2, 19, 2, 15, "#4a2c19") + rect(16, 19, 2, 15, "#4a2c19") + rect(2, 26, 16, 2, "#6b4226") },
    "furn-duck": { x: 108, y: 97, w: 8, h: 7, layer: "floor", draw: () =>
        rect(1, 3, 7, 4, "#ffd23f") + rect(3, 0, 4, 4, "#ffd23f") + rect(7, 1, 1, 2, "#fb8500") + rect(5, 1, 1, 1, "#1b1b1b") + rect(2, 4, 3, 1, "#f4b400") },
    "furn-bugjar": { x: 40, y: 94, w: 9, h: 11, layer: "floor", draw: () =>
        rect(1, 0, 7, 2, "#8d5a3b") + rect(0, 2, 9, 9, "#bde0fe", ' opacity="0.6"') + rect(0, 2, 1, 9, "#e3f2fd") + rect(8, 2, 1, 9, "#90caf9")
        + rect(3, 5, 3, 3, "#2d6a4f") + rect(2, 6, 1, 1, "#1b4332") + rect(6, 6, 1, 1, "#1b4332") + rect(4, 4, 1, 1, "#95d5b2") + rect(2, 9, 5, 1, "#74c69d") },
    "furn-lights": { x: 0, y: 1, w: 160, h: 8, layer: "wall", view: [-2, -2, 52, 12], draw: () => {
        const colors = ["#ff5d8f", "#ffd23f", "#3ddc84", "#4cc9f0", "#c77dff"];
        let svg = "";
        for (let x = 0, i = 0; x < 160; x += 8, i++) {
            const sag = [0, 1, 2, 2, 1][i % 5];
            svg += rect(x, sag, 8, 1, "#2d3436") + rect(x + 3, sag + 1, 1, 1, "#2d3436")
                + box(x + 2, sag + 2, 3, 4, 1, colors[i % colors.length], ` class="led led${i % 3}"`) + rect(x + 2, sag + 2, 1, 1, "#ffffff", ' opacity="0.7"');
        }
        return svg; } },
    "furn-poster": { x: 18, y: 44, w: 16, h: 16, layer: "wall", draw: () =>
        rect(0, 0, 16, 16, "#f8f9fa") + rect(1, 1, 14, 14, "#ffb4a2") + rect(1, 1, 14, 5, "#ffcdb2") + box(9, 3, 4, 4, 1, "#ffd23f")
        + rect(1, 10, 14, 5, "#5e548e") + rect(3, 8, 4, 2, "#5e548e") + rect(4, 7, 2, 1, "#5e548e") + rect(8, 9, 6, 1, "#9f86c0") + rect(10, 8, 3, 1, "#9f86c0") + rect(11, 7, 1, 1, "#ffffff")
        + rect(4, 7, 1, 1, "#ffffff") + rect(1, 13, 14, 2, "#231942") + rect(7, 0, 2, 1, "#e63946") },
    "furn-clock": { x: 78, y: 14, w: 12, h: 12, layer: "wall", draw: () => {
        const now = new Date();
        const hand = (frac, len, color) => {
            const a = frac * Math.PI * 2 - Math.PI / 2;
            return `<line x1="6" y1="6" x2="${(6 + Math.cos(a) * len).toFixed(1)}" y2="${(6 + Math.sin(a) * len).toFixed(1)}" stroke="${color}" stroke-width="1" stroke-linecap="square"/>`;
        };
        return box(0, 0, 12, 12, 3, "#8d5a3b") + box(1, 1, 10, 10, 3, "#fdfcf7")
            + rect(6, 2, 1, 1, "#495057") + rect(6, 10, 1, 1, "#495057") + rect(2, 6, 1, 1, "#495057") + rect(10, 6, 1, 1, "#495057")
            + hand(((now.getHours() % 12) + now.getMinutes() / 60) / 12, 2.5, "#212529") + hand(now.getMinutes() / 60, 3.8, "#e63946") + rect(6, 6, 1, 1, "#212529"); } },
    "furn-disco": { x: 98, y: 0, w: 11, h: 22, layer: "wall", draw: () => {
        let svg = rect(5, 0, 1, 9, "#6c7380") + box(0, 9, 11, 11, 3, "#9aa4b2");
        for (let y = 10; y < 19; y += 2) for (let x = 1 + ((y / 2) % 2); x < 10; x += 2) svg += rect(x, y, 1, 1, (x + y) % 3 ? "#e9ecef" : "#c0c7d1");
        return svg + rect(2, 11, 2, 2, "#ffffff") + sparkle(1, 9, "#ffffff", 0.9).replace(/<rect /g, '<rect class="twinkle" ')
            + sparkle(10, 18, "#bde0fe", 0.9).replace(/<rect /g, '<rect class="twinkle" '); } },
    "furn-neon": { x: 114, y: 48, w: 30, h: 12, layer: "wall", draw: () =>
        box(0, 0, 30, 12, 2, "#14161f") + rect(1, 1, 28, 10, "#1d1f2e")
        + bitmap(3, 1, ["..#", ".#.", "#..", ".#.", "..#"], "#ff5d8f", 2, ' class="led"')
        + bitmap(12, 1, ["..#", "..#", ".#.", "#..", "#.."], "#ffd6ff", 2)
        + bitmap(21, 1, ["#..", ".#.", "..#", ".#.", "#.."], "#4cc9f0", 2, ' class="led led1"') },
    "furn-cat": { x: 118, y: 106, w: 16, h: 10, layer: "floor", draw: () =>
        box(0, 3, 13, 7, 3, "#f4a261") + rect(1, 9, 11, 1, "#d98b4a") + rect(3, 4, 1, 3, "#d98b4a") + rect(6, 4, 1, 3, "#d98b4a")
        + box(9, 1, 7, 7, 2, "#f4a261") + rect(9, 0, 2, 2, "#f4a261") + rect(14, 0, 2, 2, "#f4a261") + rect(10, 1, 1, 1, "#ffb4a2") + rect(14, 1, 1, 1, "#ffb4a2")
        + rect(10, 4, 2, 1, "#5c3a1d") + rect(13, 4, 2, 1, "#5c3a1d") + rect(12, 6, 1, 1, "#ff8fab") + rect(0, 7, 4, 2, "#e07a3f") + rect(13, 8, 3, 1, "#fff3e0") },
    "furn-beanbag": { x: 2, y: 104, w: 24, h: 14, layer: "floor", draw: () =>
        box(1, 3, 22, 11, 3, "#5a189a") + box(0, 6, 24, 8, 3, "#7b2cbf") + box(4, 2, 16, 6, 3, "#9d4edd")
        + rect(7, 4, 6, 1, "#c77dff") + rect(5, 8, 3, 1, "#c77dff") + rect(10, 7, 4, 2, "#5a189a") + rect(3, 13, 18, 1, "#3c096c") },
    "furn-boombox": { x: 138, y: 107, w: 18, h: 11, layer: "floor", draw: () =>
        rect(4, 0, 10, 1, "#6c7380") + rect(4, 0, 1, 3, "#6c7380") + rect(13, 0, 1, 3, "#6c7380")
        + box(0, 3, 18, 8, 1, "#343a40") + rect(0, 3, 18, 1, "#495057")
        + box(1, 4, 6, 6, 2, "#14161f") + box(2, 5, 4, 4, 1, "#495057") + rect(3, 6, 2, 2, "#14161f")
        + box(11, 4, 6, 6, 2, "#14161f") + box(12, 5, 4, 4, 1, "#495057") + rect(13, 6, 2, 2, "#14161f")
        + rect(7, 5, 4, 3, "#adb5bd") + rect(8, 6, 2, 1, "#343a40") + rect(7, 9, 1, 1, "#3ddc84", ' class="led"') + rect(9, 9, 2, 1, "#ef476f") },
};

function bitmap(x, y, rows, color, scale = 1, extra = "") {
    let svg = "";
    rows.forEach((row, r) => {
        for (let c = 0; c < row.length; c++) {
            if (row[c] !== "#") continue;
            let end = c;
            while (row[end + 1] === "#") end++;
            svg += rect(x + c * scale, y + r * scale, (end - c + 1) * scale, scale, color, extra);
            c = end;
        }
    });
    return svg;
}

const INVADER = ["..#.....#..", "...#...#...", "..#######..", ".##.###.##.", "###########", "#.#######.#", "#.#.....#.#", "...##.##..."];

// ---------- Rooms ----------
function sky(x, y, w, h, night) {
    if (night) {
        let svg = rect(x, y, w, h, "#1b2a4a") + rect(x, y + h - 4, w, 4, "#24365e");
        const stars = [[3, 3], [11, 6], [19, 2], [26, 9], [7, 12], [23, 15], [15, 11], [29, 4]];
        for (const [sx, sy] of stars) if (sx < w - 1 && sy < h - 1) svg += rect(x + sx, y + sy, 1, 1, "#fff9e6", ' class="twinkle"');
        svg += box(x + w - 10, y + 3, 6, 6, 2, "#f6f1d1") + rect(x + w - 9, y + 4, 2, 2, "#e6dfb5");
        return svg;
    }
    let svg = rect(x, y, w, h, "#9ad1f5") + rect(x, y + h - 5, w, 5, "#bfe3fa");
    svg += box(x + 3, y + 3, 7, 7, 2, "#ffe066") + rect(x + 5, y + 5, 2, 2, "#fff3b0");
    svg += `<g class="cloud">${box(x + 14, y + 8, 12, 4, 1, "#ffffff") + box(x + 17, y + 6, 6, 3, 1, "#ffffff")}</g>`;
    return svg;
}

function windowFrame(x, y, w, h, night) {
    return rect(x - 2, y - 2, w + 4, h + 4, "#7a4b2d") + sky(x, y, w, h, night)
        + rect(x + Math.floor(w / 2) - 1, y, 2, h, "#7a4b2d") + rect(x, y + Math.floor(h / 2) - 1, w, 2, "#7a4b2d")
        + rect(x - 3, y + h + 2, w + 6, 2, "#8d5a3b");
}

export function room({ room = "room-cozy", wall = "#f3e9d2", night = false }) {
    const out = [];
    switch (room) {
        case "room-server": {
            out.push(rect(0, 0, W, 80, shade(wall, -0.62)), rect(0, 4, W, 2, shade(wall, -0.45)));
            for (let x = 0; x < W; x += 10) out.push(rect(x, 0, 1, 80, shade(wall, -0.68)));
            out.push(rect(10, 12, 34, 22, "#0d1117"), rect(11, 13, 32, 20, "#0f2a1d"));
            for (let i = 0; i < 6; i++) out.push(rect(13, 15 + i * 3, 6 + ((i * 7) % 20), 1, "#3ddc84"));
            out.push(rect(13, 32, 2, 1, "#3ddc84", ' class="cursor"'));
            for (const rx of [74, 94]) {
                out.push(rect(rx, 18, 16, 62, "#1f2430"), rect(rx + 1, 19, 14, 60, "#2b3242"));
                for (let r = 0; r < 9; r++) {
                    out.push(rect(rx + 2, 21 + r * 6, 12, 4, "#151a24"));
                    out.push(rect(rx + 3, 22 + r * 6, 1, 1, r % 3 ? "#3ddc84" : "#ffd166", ` class="led led${(r + rx) % 3}"`), rect(rx + 5, 22 + r * 6, 1, 1, "#4cc9f0", ` class="led led${(r + 1) % 3}"`));
                }
            }
            out.push(rect(0, 78, W, 3, "#3a4150"), rect(0, 81, W, 39, "#8d99ae"));
            for (let x = 0; x < W; x += 16) out.push(rect(x, 81, 1, 39, "#76839a"));
            for (let y = 88; y < H; y += 10) out.push(rect(0, y, W, 1, "#76839a"));
            out.push(rect(0, 81, W, 1, "#b8c1cf"));
            break;
        }
        case "room-garden": {
            out.push(sky(0, 0, W, 60, night));
            out.push(rect(0, 44, W, 36, "#3f7d3a"));
            for (let x = 0; x < W; x += 12) out.push(box(x - 2, 40 + ((x / 12) % 2) * 2, 16, 10, 3, "#4f9447"), rect(x + 3, 46, 2, 2, "#6fbf62"));
            for (let x = 4; x < W; x += 14) out.push(rect(x, 58, 4, 24, "#efe0b9"), rect(x + 1, 56, 2, 2, "#efe0b9"));
            out.push(rect(0, 64, W, 3, "#e0cc9a"), rect(0, 74, W, 3, "#e0cc9a"));
            out.push(rect(0, 80, W, 40, "#7cc66d"), rect(0, 80, W, 2, "#5aa84b"));
            for (let i = 0; i < 22; i++) out.push(rect((i * 37) % W, 86 + ((i * 13) % 30), 1, 2, "#5aa84b"), rect(((i * 37) % W) + 2, 87 + ((i * 13) % 30), 1, 1, "#5aa84b"));
            for (const [fx, fy, c] of [[12, 90, "#ff8fab"], [146, 112, "#ffd23f"], [30, 112, "#c9a7ff"], [150, 88, "#ff8fab"]]) out.push(rect(fx, fy, 3, 1, c), rect(fx + 1, fy - 1, 1, 3, c), rect(fx + 1, fy, 1, 1, "#fff3b0"));
            out.push(rect(66, 96, 28, 24, "#d9c9a3"), rect(70, 96, 1, 24, "#c4b38c"), rect(80, 96, 1, 24, "#c4b38c"));
            break;
        }
        case "room-space": {
            out.push(rect(0, 0, W, 80, "#1b1f3b"));
            for (let x = 0; x < W; x += 20) out.push(rect(x, 0, 1, 80, "#262b52"), rect(x + 2, 3, 1, 1, "#5a6199"), rect(x + 2, 74, 1, 1, "#5a6199"));
            out.push(rect(0, 40, W, 1, "#262b52"));
            out.push(box(6, 8, 42, 34, 3, "#9aa4c4"), box(8, 10, 38, 30, 3, "#05070f"));
            for (const [sx, sy] of [[12, 14], [20, 30], [40, 16], [30, 12], [16, 36], [42, 34], [26, 22]]) out.push(rect(sx, sy, 1, 1, "#ffffff", ' class="twinkle"'));
            out.push(box(30, 22, 12, 12, 3, "#e76f51"), rect(31, 26, 10, 2, "#f4a261"), rect(29, 28, 14, 1, "#ffd6a5"), rect(32, 24, 2, 1, "#ffd6a5"));
            out.push(rect(0, 78, W, 3, "#ffd23f"));
            for (let x = 0; x < W; x += 8) out.push(rect(x, 78, 4, 3, "#1b1b1b"));
            out.push(rect(0, 81, W, 39, "#4a5068"));
            for (let x = 0; x < W; x += 20) out.push(rect(x, 81, 1, 39, "#3b4057"));
            for (let y = 92; y < H; y += 14) out.push(rect(0, y, W, 1, "#3b4057"));
            break;
        }
        case "room-beach": {
            out.push(sky(0, 0, W, 52, night));
            out.push(rect(0, 50, W, 16, night ? "#1d3557" : "#219ebc"), rect(0, 50, W, 1, night ? "#457b9d" : "#8ecae6"));
            for (let i = 0; i < 9; i++) out.push(rect((i * 41) % W, 53 + ((i * 5) % 10), 6 + (i % 3) * 3, 1, night ? "#2b4c7e" : "#8ecae6"));
            out.push(rect(0, 64, W, 3, night ? "#a8dadc" : "#e0fbfc"));
            for (let x = 0; x < W; x += 10) out.push(rect(x + 3, 63, 4, 1, night ? "#a8dadc" : "#e0fbfc", ' class="twinkle"'));
            out.push(rect(0, 67, W, 53, "#f2d49b"), rect(0, 67, W, 3, "#e0bd7a"));
            for (let i = 0; i < 30; i++) out.push(rect((i * 29) % W, 74 + ((i * 17) % 44), 1, 1, i % 2 ? "#d9b26f" : "#fbe7c0"));
            const trunk = [[16, 98], [16, 92], [17, 86], [18, 80], [19, 74], [20, 68], [21, 62], [22, 56]];
            for (const [tx, ty] of trunk) out.push(rect(tx, ty, 4, 6, "#9c6644"), rect(tx, ty + 5, 4, 1, "#7f5539"));
            const fronds = [[[-2, -1], [-5, -2], [-8, -2], [-11, -1], [-13, 1], [-15, 3]], [[2, -1], [5, -2], [8, -2], [11, -1], [13, 1], [15, 3]],
                [[-2, -3], [-4, -5], [-7, -6], [-9, -6]], [[2, -3], [4, -5], [7, -6], [9, -6]], [[-1, 1], [-3, 4], [-5, 7]], [[1, 1], [3, 4], [5, 7]]];
            for (const frond of fronds) for (const [dx, dy] of frond) out.push(rect(23 + dx, 52 + dy, 3, 2, "#2d6a4f"), rect(23 + dx, 52 + dy, 2, 1, "#52b788"));
            out.push(box(20, 49, 7, 6, 2, "#40916c"), rect(21, 55, 2, 2, "#7f5539"), rect(24, 55, 2, 2, "#7f5539"));
            out.push(rect(34, 112, 1, 5, "#f28482"), rect(32, 114, 5, 1, "#f28482"), rect(33, 113, 1, 1, "#f28482"), rect(35, 113, 1, 1, "#f28482"), rect(33, 115, 1, 1, "#f28482"), rect(35, 115, 1, 1, "#f28482"));
            out.push(rect(150, 90, 4, 2, "#ffcad4"), rect(151, 89, 2, 1, "#ffcad4"), rect(151, 90, 1, 1, "#f4acb7"));
            break;
        }
        case "room-arcade": {
            out.push(rect(0, 0, W, 80, "#240046"));
            for (let x = 0; x < W; x += 16) out.push(rect(x, 0, 1, 76, "#3c096c"));
            out.push(rect(0, 8, W, 1, "#f72585", ' class="led"'), rect(0, 11, W, 1, "#4cc9f0", ' class="led led1"'));
            for (const [sx, sy] of [[6, 30], [48, 22], [70, 40], [96, 30], [150, 60], [104, 58], [60, 64]]) out.push(rect(sx, sy, 1, 1, "#e0aaff", ' class="twinkle"'));
            out.push(bitmap(14, 20, INVADER, "#3ddc84", 2, ' class="led led2"'));
            out.push(bitmap(78, 34, ["#.#", "###", ".#."], "#ffd23f", 1), bitmap(56, 50, ["#.#", "###", ".#."], "#ff5d8f", 1));
            out.push(rect(0, 76, W, 5, "#7209b7"), rect(0, 76, W, 1, "#f72585"));
            for (let y = 81, row = 0; y < H; y += 8, row++) for (let x = 0, col = 0; x < W; x += 8, col++) out.push(rect(x, y, 8, 8, (row + col) % 2 ? "#2b2d42" : "#d8d8e0"));
            out.push(rect(0, 81, W, 1, "#c77dff"));
            break;
        }
        case "room-cabin": {
            for (let y = 0, i = 0; y < 78; y += 6, i++) out.push(rect(0, y, W, 6, i % 2 ? "#7a4b25" : "#8b5a2b"), rect(0, y, W, 1, "#a0693a"), rect(0, y + 5, W, 1, "#5c3a1d"));
            for (let i = 0; i < 10; i++) out.push(rect((i * 53) % (W - 4), 2 + ((i * 7) % 13) * 6, 3, 2, "#5c3a1d"), rect((i * 53) % (W - 4) + 1, 2 + ((i * 7) % 13) * 6, 1, 1, "#7a4b25"));
            out.push(windowFrame(12, 12, 32, 26, night));
            out.push(rect(66, 0, 28, 40, "#7d7d7d"));
            for (let y = 0, row = 0; y < 40; y += 5, row++) for (let x = 66 + (row % 2) * 4; x < 94; x += 8) out.push(rect(x, y, 7, 4, row % 3 ? "#9a9a9a" : "#8a8a8a"));
            out.push(rect(58, 38, 44, 42, "#7d7d7d"));
            for (let y = 38, row = 0; y < 80; y += 5, row++) for (let x = 58 + (row % 2) * 4; x < 102; x += 8) out.push(rect(x, y, Math.min(7, 102 - x), 4, row % 3 ? "#9a9a9a" : "#8a8a8a"));
            out.push(rect(54, 46, 52, 4, "#5c3a1d"), rect(54, 46, 52, 1, "#7f5539"));
            out.push(box(66, 56, 28, 24, 3, "#1b1b1b"));
            if (night) out.push(`<ellipse cx="80" cy="74" rx="34" ry="18" fill="#ff9f1c" opacity="0.18"/>`);
            out.push(rect(68, 76, 24, 3, "#5c3a1d"), rect(70, 74, 20, 2, "#7f5539"));
            out.push(box(70, 64, 6, 11, 2, "#f77f00", ' class="led"'), box(76, 60, 8, 15, 2, "#fb8500", ' class="led led1"'), box(84, 65, 6, 10, 2, "#f77f00", ' class="led led2"'));
            out.push(box(72, 68, 3, 6, 1, "#ffd23f"), box(78, 65, 4, 9, 1, "#ffd23f", ' class="led"'), box(85, 69, 3, 5, 1, "#ffd23f"));
            out.push(rect(0, 76, W, 5, "#4a2c19"), rect(0, 81, W, 39, "#6b4226"));
            for (let y = 87; y < H; y += 7) out.push(rect(0, y, W, 1, "#55331c"));
            for (let y = 81, row = 0; y < H; y += 7, row++) for (let x = (row % 2) * 22; x < W; x += 44) out.push(rect(x, y, 1, 6, "#55331c"));
            out.push(rect(0, 81, W, 1, "#8d5a3b"));
            break;
        }
        default: {
            out.push(rect(0, 0, W, 80, wall));
            for (let x = 4; x < W; x += 12) out.push(rect(x, 0, 2, 78, shade(wall, -0.05)));
            out.push(rect(0, 60, W, 1, shade(wall, -0.18)), rect(0, 61, W, 17, shade(wall, -0.08)));
            out.push(windowFrame(12, 12, 32, 26, night));
            out.push(rect(0, 76, W, 5, shade(wall, -0.4)), rect(0, 76, W, 1, shade(wall, -0.25)));
            out.push(rect(0, 81, W, 39, "#c99d6b"));
            for (let y = 86; y < H; y += 6) out.push(rect(0, y, W, 1, "#b0844f"));
            for (let y = 81, row = 0; y < H; y += 6, row++) for (let x = (row % 2) * 18; x < W; x += 36) out.push(rect(x, y, 1, 5, "#b0844f"));
            out.push(rect(0, 81, W, 1, "#dcb788"));
        }
    }
    return out.join("");
}

export function furnitureLayer(ids, layer, ctx) {
    return ids.filter((id) => FURNITURE[id]?.layer === layer)
        .map((id) => { const f = FURNITURE[id]; return `<g transform="translate(${f.x} ${f.y})">${f.draw(ctx)}</g>`; }).join("");
}

// ---------- Particles ----------
export const sprites = {
    heart: (x, y, o = 1) => { const a = o < 1 ? ` opacity="${o.toFixed(2)}"` : ""; return rect(x, y, 2, 1, "#ff5d8f", a) + rect(x + 3, y, 2, 1, "#ff5d8f", a) + rect(x - 1, y + 1, 7, 2, "#ff5d8f", a) + rect(x, y + 3, 5, 1, "#ff5d8f", a) + rect(x + 1, y + 4, 3, 1, "#ff5d8f", a) + rect(x + 2, y + 5, 1, 1, "#ff5d8f", a) + rect(x, y + 1, 1, 1, "#ffc2d4", a); },
    treat: (x, y) => box(x, y, 6, 6, 2, "#e9a35b") + rect(x + 1, y + 2, 1, 1, "#7a4b2d") + rect(x + 4, y + 1, 1, 1, "#7a4b2d") + rect(x + 3, y + 4, 1, 1, "#7a4b2d") + rect(x + 1, y + 1, 1, 1, "#f6d0a0"),
    crumb: (x, y, o = 1) => rect(x, y, 1, 1, "#c98b4a", o < 1 ? ` opacity="${o.toFixed(2)}"` : ""),
    ball: (x, y) => box(x, y, 6, 6, 2, "#ef476f") + rect(x, y + 2, 6, 2, "#ffffff") + rect(x + 1, y + 1, 1, 1, "#ffc2d4"),
    z: (x, y, o = 1, big = false) => {
        const a = ` opacity="${o.toFixed(2)}"`;
        const s = big ? 5 : 4;
        let out = rect(x, y, s, 1, "#e8ecff", a) + rect(x, y + s - 1, s, 1, "#e8ecff", a);
        for (let i = 1; i < s - 1; i++) out += rect(x + s - 1 - i, y + i, 1, 1, "#e8ecff", a);
        return out;
    },
    spark: (x, y, color = "#ffd23f", o = 1) => sparkle(x, y, color, o),
    bang: (x, y) => rect(x, y, 2, 5, "#ffd23f") + rect(x, y + 6, 2, 2, "#ffd23f"),
    text: (x, y, label, color = "#ffd23f", o = 1) =>
        `<text x="${x}" y="${y}" fill="${color}" opacity="${o.toFixed(2)}" font-family="ui-monospace, Consolas, monospace" font-size="7" font-weight="700" text-anchor="middle" stroke="#1b1f3b" stroke-width="2" paint-order="stroke">${label}</text>`,
};
