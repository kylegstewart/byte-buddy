import test from "node:test";
import assert from "node:assert/strict";
import { configureSmokeMedia } from "./desktop/smoke-config.mjs";

test("ordinary desktop launches never replace the real microphone", () => {
    for (const args of [["Byte Buddy.exe"], ["electron.exe", "byte-buddy"], ["Byte Buddy.exe", "--smoke-test-other"]]) {
        configureSmokeMedia({ appendSwitch() { assert.fail("Normal launches must not enable synthetic capture"); } }, args);
    }
});

test("development and packaged smoke launches provide virtual devices without granting media access", () => {
    for (const args of [["electron.exe", "byte-buddy", "--smoke-test"], ["Byte Buddy.exe", "--smoke-test"]]) {
        const switches = [];
        configureSmokeMedia({ appendSwitch: (...values) => switches.push(values) }, args);
        assert.deepEqual(switches, [["use-fake-device-for-media-stream"]]);
    }
});
