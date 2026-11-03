import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const assets = new URL("./desktop/assets/", import.meta.url);
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

test("desktop window artwork is a high-resolution transparent square PNG", () => {
    const artwork = readFileSync(new URL("icon.png", assets));
    assert.deepEqual(artwork.subarray(0, 8), pngSignature);
    assert.equal(artwork.toString("ascii", 12, 16), "IHDR");
    assert.equal(artwork.readUInt32BE(16), artwork.readUInt32BE(20));
    assert.ok(artwork.readUInt32BE(16) >= 256);
    assert.equal(artwork[24], 8);
    assert.equal(artwork[25], 6);
});

test("Windows icon includes complete 32-bit frames for common display sizes", () => {
    const icon = readFileSync(new URL("icon.ico", assets));
    const sizes = [16, 24, 32, 48, 64, 128, 256];
    assert.equal(icon.readUInt16LE(0), 0);
    assert.equal(icon.readUInt16LE(2), 1);
    assert.equal(icon.readUInt16LE(4), sizes.length);
    let nextOffset = 6 + sizes.length * 16;
    for (const [index, size] of sizes.entries()) {
        const directoryOffset = 6 + index * 16;
        assert.equal(icon[directoryOffset] || 256, size);
        assert.equal(icon[directoryOffset + 1] || 256, size);
        assert.equal(icon.readUInt16LE(directoryOffset + 4), 1);
        assert.equal(icon.readUInt16LE(directoryOffset + 6), 32);
        const length = icon.readUInt32LE(directoryOffset + 8);
        const offset = icon.readUInt32LE(directoryOffset + 12);
        assert.equal(offset, nextOffset);
        assert.ok(length >= 33);
        assert.ok(offset + length <= icon.length);
        const frame = icon.subarray(offset, offset + length);
        assert.deepEqual(frame.subarray(0, 8), pngSignature);
        assert.equal(frame.readUInt32BE(16), size);
        assert.equal(frame.readUInt32BE(20), size);
        assert.equal(frame[25], 6);
        nextOffset += length;
    }
    assert.equal(nextOffset, icon.length);
});

test("desktop packaging and native window use the supplied app icon", () => {
    const configuration = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));
    const main = readFileSync(new URL("./desktop/main.mjs", import.meta.url), "utf8");
    assert.equal(configuration.build.win.icon, "desktop/assets/icon.ico");
    assert.equal(configuration.build.nsis.installerIcon, configuration.build.win.icon);
    assert.equal(configuration.build.nsis.uninstallerIcon, configuration.build.win.icon);
    assert.ok(configuration.build.files.includes("desktop/**/*"));
    assert.match(main, /icon: join\(here, "assets", "icon\.png"\)/);
});
