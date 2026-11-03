export const VOICE_RADIUS = 480;

export function proximityAudio(listener, speaker, radius = VOICE_RADIUS) {
    if (![listener?.x, listener?.y, speaker?.x, speaker?.y, radius].every(Number.isFinite) || radius <= 0) return { gain: 0, pan: 0 };
    const distance = Math.hypot(speaker.x - listener.x, speaker.y - listener.y);
    const fullVolume = radius * 0.15;
    const fade = Math.max(0, Math.min(1, (radius - distance) / (radius - fullVolume)));
    return { gain: fade * fade * (3 - 2 * fade), pan: Math.max(-1, Math.min(1, (speaker.x - listener.x) / radius)) };
}

export function validateIceServers(servers) {
    if (!Array.isArray(servers) || !servers.length || servers.length > 12) throw new Error("The voice server did not supply valid Cloudflare connection credentials.");
    return servers.map((server) => {
        const urls = Array.isArray(server.urls) ? server.urls : [server.urls];
        if (!urls.length || urls.some((url) => typeof url !== "string" || !/^(?:stun|turn|turns):(?:stun|turn)\.cloudflare\.com:(?:3478|5349|443)(?:\?transport=(?:tcp|udp))?$/.test(url))) throw new Error("The voice server supplied an unsupported media relay.");
        return { urls, ...(typeof server.username === "string" ? { username: server.username } : {}), ...(typeof server.credential === "string" ? { credential: server.credential } : {}) };
    });
}

function waitForPeer(peer, event, ready, failed, signal, timeoutMs, timeoutMessage = "Voice media connection timed out after signaling. Your network may block WebRTC or TURN.") {
    return new Promise((resolve, reject) => {
        const finish = (error) => {
            clearTimeout(timer);
            peer.removeEventListener(event, changed);
            signal.removeEventListener("abort", abort);
            error ? reject(error) : resolve();
        };
        const abort = () => finish(new Error("Voice operation cancelled."));
        const check = (timedOut = false) => {
            if (signal.aborted) abort();
            else if (failed()) finish(new Error("The voice connection failed. Check your network and enable voice again."));
            else if (ready(timedOut)) finish();
            else if (timedOut) finish(new Error(timeoutMessage));
        };
        const changed = () => check();
        const timer = setTimeout(() => check(true), timeoutMs);
        peer.addEventListener(event, changed);
        signal.addEventListener("abort", abort, { once: true });
        check();
    });
}

async function localDescription(peer, signal) {
    const gatheringError = "Voice could not gather any network candidates. Your network may block WebRTC or TURN.";
    const hasCandidates = () => /^a=candidate:/m.test(peer.localDescription?.sdp ?? "");
    // Unresponsive transports can keep gathering after a working relay is available.
    await waitForPeer(peer, "icegatheringstatechange", (timedOut) => peer.iceGatheringState === "complete" || (timedOut && hasCandidates()),
        () => peer.connectionState === "failed" || peer.connectionState === "closed", signal, 12_000, gatheringError);
    if (!hasCandidates()) throw new Error(gatheringError);
    return { type: peer.localDescription.type, sdp: peer.localDescription.sdp };
}

function voiceError(error) {
    if (error?.name === "NotAllowedError") return "Microphone permission was denied. Enable access in Windows privacy settings, then try again.";
    if (["NotFoundError", "OverconstrainedError"].includes(error?.name)) return "The selected microphone is unavailable. Choose another microphone and try again.";
    if (error?.name === "NotReadableError") return "The microphone could not be opened. Check whether another app or Windows is blocking access.";
    return error?.message || "Voice disconnected. Enable voice to retry.";
}

export function createProximityVoice({ request, onChange = () => {}, releasePermission = () => {}, mediaDevices = globalThis.navigator?.mediaDevices,
    PeerConnection = globalThis.RTCPeerConnection, AudioContext = globalThis.AudioContext, MediaStream = globalThis.MediaStream, Audio = globalThis.Audio,
    schedule = globalThis.setTimeout, cancel = globalThis.clearTimeout, pollMs = 1500, meterMs = 80 } = {}) {
    let current = null;
    let lounge = null;
    let position = null;
    let state = { status: "off", message: "Voice is off. Enable it to talk with nearby players.", muted: false, deafened: false, talking: false, nearby: 0, speaking: [] };
    const emit = (patch = {}) => { state = { ...state, ...patch }; onChange({ ...state, speaking: [...state.speaking] }); };
    const valid = (session) => current === session && !session.abort.signal.aborted;
    const check = (session) => { if (!valid(session)) throw new Error("Voice operation cancelled."); };
    const call = (session, action, body = {}) => request({ action, voiceId: session.voiceId, ...body });

    function stop(message = "Voice is off. Enable it to talk with nearby players.", error = false) {
        const previous = current;
        current = null;
        if (previous) {
            previous.abort.abort();
            cancel(previous.poll);
            cancel(previous.meter);
            for (const timer of previous.disconnectTimers.values()) cancel(timer);
            previous.stream?.getTracks().forEach((track) => { track.enabled = false; track.stop(); });
            previous.sender?.close();
            previous.receiver?.close();
            for (const link of previous.links.values()) { link.audio?.pause(); if (link.audio) link.audio.srcObject = null; }
            previous.links.clear();
            void previous.context?.close().catch(() => {});
        }
        void Promise.resolve(releasePermission()).catch(() => {});
        emit({ status: error ? "error" : "off", message, talking: false, nearby: 0, speaking: [], muted: false, deafened: false });
        return previous?.voiceId ? call(previous, "leave").catch(() => {}) : Promise.resolve();
    }

    const fail = (session, error) => { if (valid(session)) void stop(voiceError(error), true); };

    function peerFor(session) {
        const peer = new PeerConnection({ iceServers: session.iceServers, bundlePolicy: "max-bundle" });
        peer.addEventListener("connectionstatechange", () => {
            if (!valid(session) || (peer !== session.sender && peer !== session.receiver)) return;
            cancel(session.disconnectTimers.get(peer));
            session.disconnectTimers.delete(peer);
            if (peer.connectionState === "failed") fail(session, new Error("The voice connection failed. Check your network and enable voice again."));
            else if (peer.connectionState === "disconnected") session.disconnectTimers.set(peer, schedule(() => fail(session, new Error("Voice lost its network connection. Enable voice to retry.")), 5000));
        });
        return peer;
    }

    function meter(session) {
        if (!valid(session)) return;
        const speaking = [];
        const activity = (analyser) => {
            const samples = new Float32Array(analyser.fftSize);
            analyser.getFloatTimeDomainData(samples);
            return Math.sqrt(samples.reduce((sum, value) => sum + value * value, 0) / samples.length) > 0.015;
        };
        if (state.talking && session.localAnalyser && activity(session.localAnalyser)) speaking.push(String(lounge.self.id));
        for (const [id, link] of session.links) if (link.level > 0.01 && !state.deafened && activity(link.analyser)) speaking.push(id);
        if (state.speaking.join(",") !== speaking.join(",")) emit({ speaking });
        session.meter = schedule(() => meter(session), meterMs);
    }

    function mix() {
        const session = current;
        if (!session) return;
        const listener = position || lounge?.members?.find((member) => String(member.id) === String(lounge.self?.id));
        for (const [id, link] of session.links) {
            const speaker = lounge?.members?.find((member) => String(member.id) === id);
            const { gain, pan } = proximityAudio(listener, speaker, session.radius);
            link.level = state.deafened ? 0 : gain;
            link.gain.gain.setTargetAtTime(link.level, session.context.currentTime, 0.04);
            link.panner.pan.setTargetAtTime(pan, session.context.currentTime, 0.04);
        }
    }

    function talking(value) {
        const enabled = Boolean(value && current && state.status === "connected" && !state.muted && !state.deafened);
        current?.stream?.getAudioTracks().forEach((track) => { track.enabled = enabled; });
        if (enabled !== state.talking) emit({ talking: enabled });
    }

    async function receive(session, peers) {
        cancel(session.disconnectTimers.get(session.receiver));
        session.disconnectTimers.delete(session.receiver);
        session.receiver?.close();
        session.receiver = null;
        for (const link of session.links.values()) {
            link.audio?.pause();
            if (link.audio) link.audio.srcObject = null;
            link.source.disconnect(); link.analyser.disconnect(); link.gain.disconnect(); link.panner.disconnect();
        }
        session.links.clear();
        const result = await call(session, "listen");
        check(session);
        session.subscriptionId = result.subscriptionId;
        session.peers = peers;
        if (!result.sessionDescription) {
            if (result.subscriptionId || result.tracks?.length) throw new Error("The voice server returned an incomplete subscription.");
            emit({ nearby: 0, speaking: [] });
            return;
        }
        if (result.sessionDescription.type !== "offer" || !result.subscriptionId || !Array.isArray(result.tracks) || result.tracks.length > 12) throw new Error("The voice server returned an invalid audio offer.");
        const identifiers = new Map(result.tracks.map((track) => [String(track.mid), String(track.id)]));
        if (identifiers.size !== result.tracks.length) throw new Error("The voice server returned duplicate audio tracks.");
        const receiver = peerFor(session);
        session.receiver = receiver;
        receiver.addEventListener("track", (event) => {
            if (!valid(session) || session.receiver !== receiver) { event.track.stop(); return; }
            const id = identifiers.get(String(event.transceiver.mid));
            if (!id || event.track.kind !== "audio") { event.track.stop(); fail(session, new Error("Unexpected media track received; voice was disconnected.")); return; }
            const stream = new MediaStream([event.track]);
            const audio = Audio ? new Audio() : null;
            if (audio) { audio.muted = true; audio.srcObject = stream; }
            const source = session.context.createMediaStreamSource(stream);
            const analyser = session.context.createAnalyser();
            analyser.fftSize = 256;
            const gain = session.context.createGain();
            gain.gain.value = 0;
            const panner = session.context.createStereoPanner();
            source.connect(analyser).connect(gain).connect(panner).connect(session.context.destination);
            session.links.set(id, { audio, source, analyser, gain, panner, level: 0 });
            if (audio) void audio.play().catch((error) => fail(session, error));
            mix();
        });
        await receiver.setRemoteDescription(result.sessionDescription);
        check(session);
        await receiver.setLocalDescription(await receiver.createAnswer());
        const description = await localDescription(receiver, session.abort.signal);
        check(session);
        await call(session, "answer", { subscriptionId: session.subscriptionId, sessionDescription: description });
        check(session);
        await waitForPeer(receiver, "connectionstatechange", () => receiver.connectionState === "connected", () => receiver.connectionState === "failed" || receiver.connectionState === "closed", session.abort.signal, 20_000);
        check(session);
        emit({ nearby: identifiers.size });
    }

    async function poll(session) {
        if (!valid(session)) return;
        try {
            const status = await call(session, "status");
            check(session);
            if (!Array.isArray(status.peers) || status.peers.length > 12) throw new Error("The voice server returned an invalid nearby-player list.");
            const peers = JSON.stringify(status.peers.map((peer) => [String(peer.id), peer.revision]).sort((left, right) => left[0].localeCompare(right[0])));
            if (peers !== session.peers || (session.subscriptionId || null) !== (status.subscriptionId || null)) await receive(session, peers);
            check(session);
            session.poll = schedule(() => { void poll(session); }, pollMs);
        } catch (error) { fail(session, error); }
    }

    async function start(deviceId = "") {
        if (current || lounge?.status !== "connected") return;
        if (!mediaDevices?.getUserMedia || !PeerConnection || !AudioContext || !MediaStream) { emit({ status: "error", message: "Voice is not supported in this application environment." }); return; }
        const session = { abort: new AbortController(), voiceId: null, links: new Map(), disconnectTimers: new Map(), peers: null, subscriptionId: null };
        current = session;
        emit({ status: "connecting", message: "Connecting voice. Approve microphone access when prompted.", muted: false, deafened: false, speaking: [], nearby: 0 });
        try {
            session.context = new AudioContext({ latencyHint: "interactive" });
            await session.context.resume();
            check(session);
            const joined = await request({ action: "join" });
            session.voiceId = joined.voiceId;
            if (!valid(session)) { if (session.voiceId) await call(session, "leave").catch(() => {}); return; }
            if (typeof session.voiceId !== "string" || !session.voiceId || session.voiceId.length > 128) throw new Error("The voice server did not create a valid session.");
            if (!Number.isFinite(joined.radius) || joined.radius <= 0) throw new Error("The voice server returned an invalid hearing radius.");
            session.radius = Math.min(VOICE_RADIUS, joined.radius);
            session.iceServers = validateIceServers(joined.iceServers);
            const stream = await mediaDevices.getUserMedia({ video: false, audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, ...(deviceId ? { deviceId: { exact: deviceId } } : {}) } });
            stream.getTracks().forEach((track) => { track.enabled = false; });
            if (!valid(session)) { stream.getTracks().forEach((track) => track.stop()); return; }
            session.stream = stream;
            const tracks = stream.getAudioTracks();
            if (tracks.length !== 1 || stream.getTracks().length !== 1) throw new Error("Voice requires one audio-only microphone track.");
            tracks[0].addEventListener("ended", () => fail(session, new Error("The microphone was disconnected. Select a microphone and enable voice again.")));
            session.localSource = session.context.createMediaStreamSource(stream);
            session.localAnalyser = session.context.createAnalyser();
            session.localAnalyser.fftSize = 256;
            session.localSource.connect(session.localAnalyser);
            session.localMonitor = session.context.createGain();
            session.localMonitor.gain.value = 0;
            session.localAnalyser.connect(session.localMonitor).connect(session.context.destination);
            const sender = peerFor(session);
            session.sender = sender;
            const transceiver = sender.addTransceiver(tracks[0], { direction: "sendonly", streams: [stream] });
            await sender.setLocalDescription(await sender.createOffer());
            const description = await localDescription(sender, session.abort.signal);
            check(session);
            const published = await call(session, "publish", { mid: transceiver.mid, sessionDescription: description });
            check(session);
            if (published.sessionDescription?.type !== "answer") throw new Error("The voice server did not return an audio answer.");
            await sender.setRemoteDescription(published.sessionDescription);
            await waitForPeer(sender, "connectionstatechange", () => sender.connectionState === "connected", () => sender.connectionState === "failed" || sender.connectionState === "closed", session.abort.signal, 20_000);
            check(session);
            emit({ status: "connected", message: "Voice connected. Hold V or the talk button while nearby." });
            meter(session);
            await poll(session);
        } catch (error) { fail(session, error); }
    }

    return {
        start, stop, talking,
        update(value) {
            const previous = lounge;
            lounge = value;
            if (current && (value?.status !== "connected" || value.org !== previous?.org || String(value.self?.id) !== String(previous?.self?.id))) void stop("Voice disconnected because the Lounge connection changed.");
            mix();
        },
        position(value) { position = value; mix(); },
        mute(value) { emit({ muted: Boolean(value) }); talking(false); },
        deafen(value) { emit({ deafened: Boolean(value) }); talking(false); mix(); },
        get state() { return { ...state, speaking: [...state.speaking] }; },
    };
}

export function createLoungeVoiceView({ api, doc, desktop, onSpeaking = () => {}, mediaDevices = globalThis.navigator?.mediaDevices,
    releasePermission = () => globalThis.byteBuddyDesktop?.releaseMicrophone?.(), controllerFactory = createProximityVoice } = {}) {
    const noop = { update() {}, position() {}, deactivate() {} };
    const panel = doc?.getElementById("loungeVoice");
    if (!desktop || !panel) return noop;
    panel.hidden = false;
    const $ = (id) => doc.getElementById(id);
    let lounge = null;
    let voiceState = null;
    let devicesVersion = 0;
    const held = new Set();
    const controller = controllerFactory({ request: async (body) => {
        const response = await api("/api/lounge/voice", body);
        return response.result ?? response;
    }, mediaDevices, releasePermission, onChange: render });

    function render(next = controller.state) {
        voiceState = next;
        const connected = next.status === "connected";
        const active = connected || next.status === "connecting";
        $("loungeVoiceJoin").disabled = active || lounge?.status !== "connected" || !mediaDevices?.getUserMedia;
        $("loungeVoiceJoin").textContent = next.status === "error" ? "Retry voice" : "Enable voice";
        $("loungeVoiceLeave").hidden = !active;
        $("loungeVoiceMic").disabled = active;
        $("loungeVoiceRefresh").disabled = active;
        $("loungeVoiceTalk").disabled = !connected || next.muted || next.deafened;
        $("loungeVoiceTalk").setAttribute("aria-pressed", String(next.talking));
        $("loungeVoiceTalk").textContent = next.talking ? "Talking — release to stop" : "Hold to talk (V)";
        for (const [id, pressed] of [["loungeVoiceMute", next.muted], ["loungeVoiceDeafen", next.deafened]]) {
            $(id).disabled = !connected;
            $(id).setAttribute("aria-pressed", String(pressed));
        }
        $("loungeVoiceMute").textContent = next.muted ? "Unmute microphone" : "Mute microphone";
        $("loungeVoiceDeafen").textContent = next.deafened ? "Undeafen" : "Deafen";
        const message = connected ? (next.deafened ? "Deafened: microphone and incoming audio are muted." : next.muted ? "Microphone muted. You can still hear nearby players." : next.message) + " Nearby voices: " + next.nearby + "." : next.message;
        if ($("loungeVoiceStatus").textContent !== message) $("loungeVoiceStatus").textContent = message;
        $("loungeVoiceStatus").dataset.status = next.status;
        onSpeaking(new Set(next.speaking));
    }

    async function devices() {
        if (!mediaDevices?.enumerateDevices) return;
        const version = ++devicesVersion;
        try {
            const microphones = (await mediaDevices.enumerateDevices()).filter((device) => device.kind === "audioinput" && device.deviceId && device.deviceId !== "default");
            if (version !== devicesVersion) return;
            const select = $("loungeVoiceMic");
            const previous = select.value;
            select.replaceChildren();
            for (const [value, label] of [["", "System default microphone"], ...microphones.map((device, index) => [device.deviceId, device.label || "Microphone " + (index + 1)])]) {
                const option = doc.createElement("option"); option.value = value; option.textContent = label; select.appendChild(option);
            }
            if ([...select.options].some((option) => option.value === previous)) select.value = previous;
        } catch { $("loungeVoiceStatus").textContent = "Microphone discovery is unavailable. You can try the system default microphone."; }
    }

    const release = () => { held.clear(); controller.talking(false); };
    const stop = () => { release(); void controller.stop(); };
    $("loungeVoiceJoin").addEventListener("click", () => {
        if (doc.hidden || $("loungeView").hidden || lounge?.status !== "connected") return;
        void controller.start($("loungeVoiceMic").value).then(devices);
    });
    $("loungeVoiceLeave").addEventListener("click", stop);
    $("loungeVoiceRefresh").addEventListener("click", () => { void devices(); });
    $("loungeVoiceMute").addEventListener("click", () => { release(); controller.mute(!voiceState.muted); });
    $("loungeVoiceDeafen").addEventListener("click", () => { release(); controller.deafen(!voiceState.deafened); });
    const button = $("loungeVoiceTalk");
    button.addEventListener("pointerdown", (event) => {
        if (button.disabled || (event.button !== undefined && event.button !== 0)) return;
        event.preventDefault(); held.add("pointer"); button.setPointerCapture?.(event.pointerId); controller.talking(true);
    });
    for (const name of ["pointerup", "pointercancel", "lostpointercapture"]) button.addEventListener(name, () => { held.delete("pointer"); controller.talking(held.size > 0); });
    doc.addEventListener("keydown", (event) => {
        const tag = event.target?.tagName?.toLowerCase();
        if (doc.hidden || $("loungeView").hidden || event.altKey || event.ctrlKey || event.metaKey || event.target?.isContentEditable || ["input", "select", "textarea"].includes(tag)) return;
        if (String(event.key).toLowerCase() !== "v" && !(event.target === button && [" ", "Enter"].includes(event.key))) return;
        event.preventDefault(); held.add(String(event.key).toLowerCase()); controller.talking(true);
    });
    doc.addEventListener("keyup", (event) => { if (held.delete(String(event.key).toLowerCase())) { event.preventDefault(); controller.talking(held.size > 0); } });
    doc.addEventListener("visibilitychange", () => { if (doc.hidden) stop(); });
    doc.defaultView?.addEventListener("blur", release);
    doc.defaultView?.addEventListener("pagehide", stop);
    render();
    return { update(value) { lounge = value; controller.update(value); render(); }, position: controller.position, deactivate: stop, controller };
}
