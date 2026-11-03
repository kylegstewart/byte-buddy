import test from "node:test";
import assert from "node:assert/strict";
import { createLoungeVoiceView } from "./public/lounge-voice.js";

const room = () => ({ status: "connected", org: "fixture", self: { id: 1 }, members: [] });
const flush = () => new Promise((resolve) => setImmediate(resolve));
class Element {
    constructor(tagName = "BUTTON") { this.tagName = tagName; this.hidden = false; this.disabled = false; this.value = ""; this.textContent = ""; this.dataset = {}; this.attributes = {}; this.listeners = {}; this.options = []; }
    addEventListener(name, callback) { (this.listeners[name] ||= []).push(callback); }
    dispatch(name, values = {}) { const event = { target: this, preventDefault() {}, ...values }; for (const callback of this.listeners[name] || []) callback(event); }
    setAttribute(name, value) { this.attributes[name] = value; }
    replaceChildren() { this.options = []; }
    appendChild(option) { this.options.push(option); }
}

function harness(desktop = true) {
    const ids = ["loungeVoice", "loungeView", "loungeVoiceJoin", "loungeVoiceLeave", "loungeVoiceMic", "loungeVoiceRefresh", "loungeVoiceTalk", "loungeVoiceMute", "loungeVoiceDeafen", "loungeVoiceStatus"];
    const elements = Object.fromEntries(ids.map((id) => [id, new Element()]));
    elements.loungeVoice.hidden = true;
    const doc = Object.assign(new Element("DOCUMENT"), { getElementById: (id) => elements[id], createElement: (tag) => new Element(tag), defaultView: new Element("WINDOW"), hidden: false });
    let state = { status: "off", message: "Voice off", muted: false, deafened: false, talking: false, speaking: [], nearby: 0 };
    const calls = [];
    let notify, options;
    const emit = (patch) => { state = { ...state, ...patch }; notify?.(state); };
    const view = createLoungeVoiceView({ desktop, doc, api: async (_path, body) => ({ result: { echo: body.action } }),
        mediaDevices: { getUserMedia() {}, enumerateDevices: async () => [{ kind: "audioinput", deviceId: "fixture", label: "<unsafe microphone>" }] },
        controllerFactory: (settings) => {
            options = settings; notify = settings.onChange;
            return { get state() { return state; }, update: (value) => calls.push(["update", value]), position() {},
                start: async (device) => { calls.push(["start", device]); emit({ status: "connected" }); },
                stop: async () => { calls.push(["stop"]); emit({ status: "off", talking: false }); },
                talking: (value) => { calls.push(["talking", value]); emit({ talking: value }); },
                mute: (value) => emit({ muted: value }), deafen: (value) => emit({ deafened: value }) };
        },
    });
    return { view, elements, doc, calls, emit, get options() { return options; } };
}

test("voice stays hidden in Copilot and never captures on mount or room update", () => {
    const copilot = harness(false);
    assert.equal(copilot.elements.loungeVoice.hidden, true);
    assert.equal(copilot.options, undefined);
    const fixture = harness();
    fixture.view.update(room());
    assert.equal(fixture.elements.loungeVoice.hidden, false);
    assert.equal(fixture.elements.loungeVoiceJoin.disabled, false);
    assert.equal(fixture.elements.loungeVoiceTalk.disabled, true);
    assert.equal(fixture.calls.some(([name]) => name === "start"), false);
});

test("voice opt-in requires the visible Lounge and safely renders microphone labels", async () => {
    const fixture = harness();
    fixture.view.update(room());
    fixture.elements.loungeView.hidden = true;
    fixture.elements.loungeVoiceJoin.dispatch("click");
    assert.equal(fixture.calls.some(([name]) => name === "start"), false);
    fixture.elements.loungeView.hidden = false;
    fixture.elements.loungeVoiceJoin.dispatch("click");
    await flush();
    assert.equal(fixture.calls.filter(([name]) => name === "start").length, 1);
    assert.equal(fixture.elements.loungeVoiceMic.disabled, true);
    assert.equal(fixture.elements.loungeVoiceMic.options[1].textContent, "<unsafe microphone>");
    assert.deepEqual(await fixture.options.request({ action: "status" }), { echo: "status" });
});

test("push-to-talk releases correctly across keyboard/pointer overlap, cancellation, blur and hidden views", () => {
    const fixture = harness();
    fixture.view.update(room());
    fixture.emit({ status: "connected" });
    const button = fixture.elements.loungeVoiceTalk;
    fixture.doc.dispatch("keydown", { key: "V" });
    assert.equal(fixture.calls.at(-1)[1], true);
    button.dispatch("pointerdown", { button: 0, pointerId: 1 });
    fixture.doc.dispatch("keyup", { key: "v" });
    assert.equal(fixture.calls.at(-1)[1], true);
    button.dispatch("pointercancel");
    assert.equal(fixture.calls.at(-1)[1], false);
    fixture.doc.dispatch("keydown", { key: "v" });
    fixture.doc.defaultView.dispatch("blur");
    assert.equal(fixture.calls.at(-1)[1], false);
    const count = fixture.calls.length;
    fixture.doc.dispatch("keydown", { key: "v", target: { tagName: "INPUT" } });
    fixture.doc.dispatch("keydown", { key: "v", ctrlKey: true });
    assert.equal(fixture.calls.length, count);
    fixture.doc.hidden = true;
    fixture.doc.dispatch("visibilitychange");
    assert.equal(fixture.calls.at(-1)[0], "stop");
    fixture.doc.hidden = false;
    fixture.doc.defaultView.dispatch("pagehide");
    assert.equal(fixture.calls.at(-1)[0], "stop");
    fixture.view.deactivate();
    assert.equal(fixture.calls.at(-1)[0], "stop");
});
