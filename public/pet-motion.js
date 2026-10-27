// Coordinates and velocities use the scene's SVG units, independent of display size.
export function createPetMotion({ now = () => performance.now(), schedule = setTimeout, cancel = clearTimeout,
    onPet = () => {}, onAbuse = () => {}, reduced = () => false } = {}) {
    const body = { phase: "idle", x: 80, y: 104, vx: 0, vy: 0, hold: 0, splat: 0, side: 0,
        angle: 0, angularVelocity: 0, gripX: 0, gripY: 0 };
    let press = null, timer = null, elapsed = 0, penalized = false;
    let bounds = { left: 18, right: 142, top: 48, bottom: 104 };
    const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
    const clear = () => { if (timer !== null) cancel(timer); timer = null; };
    const dragDirection = () => body.gripY <= (bounds.shape ? bounds.shape.y + bounds.shape.height / 2 : -16) ? 1 : -1;
    function abuse() { if (!penalized) { penalized = true; onAbuse(); } }
    function reset() {
        clear(); press = null; body.phase = "idle"; body.hold = 0; body.splat = 0;
        body.vx = body.vy = body.angle = body.angularVelocity = 0;
    }
    function down(point, position, limits) {
        if (press) return false;
        bounds = limits;
        Object.assign(body, position, { phase: "press", vx: 0, vy: 0, hold: 0, splat: 0,
            angle: 0, angularVelocity: 0, gripX: point.x - position.x, gripY: point.y - position.y });
        press = { id: point.id, x: point.x, y: point.y, dx: body.x - point.x, dy: body.y - point.y, start: now(), last: now() };
        penalized = false;
        timer = schedule(() => {
            timer = null;
            if (press && body.phase === "press") { body.phase = "held"; body.hold = 1; press.last = now(); }
        }, 1000);
        return true;
    }
    function move(point) {
        if (!press || point.id !== press.id) return;
        if (body.phase === "press") {
            if (Math.hypot(point.x - press.x, point.y - press.y) > 4) reset();
            return;
        }
        if (body.phase !== "held") return;
        const at = now(), dt = Math.max(0.008, (at - press.last) / 1000);
        const x = clamp(point.x + press.dx, bounds.left, bounds.right);
        const y = clamp(point.y + press.dy, bounds.top, bounds.bottom);
        const vx = clamp((x - body.x) / dt, -320, 320);
        if (!reduced()) {
            const impulse = vx * body.vx < 0 && Math.abs(vx) > 20
                ? vx * 0.7 * dragDirection()
                : body.angularVelocity + (vx - body.vx) * 0.35 * dragDirection();
            body.angularVelocity = clamp(impulse, -280, 280);
        }
        body.vx = vx;
        body.vy = clamp((y - body.y) / dt, -320, 320);
        body.x = x; body.y = y; press.last = at;
    }
    function up(point, cancelled = false) {
        if (!press || point.id !== press.id) return;
        clear();
        if (cancelled) { reset(); return; }
        if (body.phase === "press") { reset(); onPet(); return; }
        if (now() - press.last > 150) body.vx = body.vy = 0;
        press = null;
        body.phase = "flying"; body.hold = 0; elapsed = 0;
        if (Math.hypot(body.vx, body.vy) >= 70) abuse();
        if (reduced()) reset();
    }
    function confineSway() {
        if (!bounds.shape || !body.angle || body.splat > 0) return;
        const box = bounds.shape, radians = body.angle * Math.PI / 180;
        const c = Math.cos(radians), s = Math.sin(radians), scale = body.phase === "held" ? 1.03 : 1;
        const corners = [box.x, box.x + box.width].flatMap(x => [box.y, box.y + box.height].map(y => {
            const dx = (x - body.gripX) * scale, dy = (y - body.gripY) * scale;
            return { x: body.gripX + dx * c - dy * s, y: body.gripY + dx * s + dy * c };
        }));
        body.x = clamp(body.x, Math.max(bounds.left, 1 - Math.min(...corners.map(p => p.x))),
            Math.min(bounds.right, bounds.width - 1 - Math.max(...corners.map(p => p.x))));
        body.y = clamp(body.y, Math.max(bounds.top, 1 - Math.min(...corners.map(p => p.y))),
            Math.min(bounds.bottom, bounds.floor - Math.max(0, ...corners.map(p => p.y))));
    }
    function step(seconds) {
        if (body.phase === "press") body.hold = clamp((now() - press.start) / 1000, 0, 1);
        if (body.phase !== "flying" && body.phase !== "held") return body;
        if (reduced()) {
            body.angle = body.angularVelocity = 0;
            if (body.phase === "flying") reset();
            return body;
        }
        // Substeps keep both the pendulum and fast throws stable across frame rates.
        let remaining = Math.min(0.1, Math.max(0, seconds));
        while (remaining > 0) {
            const dt = Math.min(1 / 120, remaining); remaining -= dt;
            const target = body.phase === "held" && now() - press.last < 100 ? clamp(body.vx * 0.18 * dragDirection(), -42, 42) : 0;
            body.angularVelocity += ((target - body.angle) * 210 - body.angularVelocity * 16) * dt;
            body.angle = clamp(body.angle + body.angularVelocity * dt, -48, 48);
            if (Math.abs(body.angle) < 0.01 && Math.abs(body.angularVelocity) < 0.05) body.angle = body.angularVelocity = 0;
            if (body.phase === "held") continue;
            elapsed += dt;
            body.splat = Math.max(0, body.splat - dt);
            body.vy += 190 * dt;
            body.vx *= Math.exp(-0.8 * dt);
            body.x += body.vx * dt; body.y += body.vy * dt;
            if (body.x <= bounds.left || body.x >= bounds.right) {
                body.side = body.x <= bounds.left ? -1 : 1;
                body.x = clamp(body.x, bounds.left, bounds.right);
                if (Math.abs(body.vx) >= 90) { body.splat = 0.35; abuse(); }
                body.vx *= -0.48;
            }
            if (body.y < bounds.top) { body.y = bounds.top; body.vy = Math.abs(body.vy) * 0.4; }
            if (body.y >= bounds.bottom) {
                body.y = bounds.bottom; body.vy = Math.abs(body.vy) < 18 ? 0 : -Math.abs(body.vy) * 0.35;
                body.vx *= Math.exp(-7 * dt);
            }
        }
        confineSway();
        if (body.phase === "flying" && (elapsed > 5 || (body.y === bounds.bottom && Math.abs(body.vx) < 3 && Math.abs(body.vy) < 3 && !body.splat))) reset();
        return body;
    }
    return { body, down, move, up, step, reset };
}
