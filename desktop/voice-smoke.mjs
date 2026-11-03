export async function checkVoiceWindow(window) {
    return window.webContents.executeJavaScript(`(${(async () => {
        const { createProximityVoice } = await import("/static/lounge-voice.js");
        const peers = [];
        const contexts = [];
        const tracks = [];
        let captured = 0;
        let released = 0;
        let receiver = null;
        let subscriptionId = null;
        let controller;
        const wait = async (condition, label = "ICE gathering") => {
            const deadline = Date.now() + 8000;
            while (!condition()) {
                if (Date.now() > deadline) throw new Error("Synthetic voice test timed out: " + label);
                await new Promise((resolve) => setTimeout(resolve, 30));
            }
        };
        class LocalPeer extends RTCPeerConnection {
            constructor() { super({ iceServers: [] }); peers.push(this); }
        }
        class SilentAudio extends AudioContext {
            constructor(options) {
                super(options);
                this.sink = this.createGain();
                this.sink.gain.value = 0;
                this.sink.connect(super.destination);
                contexts.push(this);
            }
            get destination() { return this.sink || super.destination; }
        }
        const description = async (peer) => {
            await wait(() => peer.iceGatheringState === "complete");
            return { type: peer.localDescription.type, sdp: peer.localDescription.sdp };
        };
        let deniedWithoutLounge = false;
        try {
            const unexpected = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
            unexpected.getTracks().forEach((track) => track.stop());
        } catch (error) {
            if (error.name !== "NotAllowedError") throw new Error("Microphone permission smoke check expected NotAllowedError with a virtual input, received " + error.name + ": " + error.message);
            deniedWithoutLounge = true;
        }
        if (!deniedWithoutLounge) throw new Error("Microphone permission was unexpectedly granted outside a connected Lounge.");
        try {
            const source = new SilentAudio();
            await source.resume();
            const tone = (frequency) => {
                const oscillator = source.createOscillator();
                const destination = source.createMediaStreamDestination();
                oscillator.frequency.value = frequency;
                oscillator.connect(destination);
                oscillator.start();
                tracks.push(...destination.stream.getTracks());
                return destination.stream;
            };
            const microphone = tone(330);
            const remote = tone(550);
            controller = createProximityVoice({ PeerConnection: LocalPeer, AudioContext: SilentAudio, MediaStream,
                mediaDevices: { getUserMedia: async () => { captured++; return microphone; } }, releasePermission: () => { released++; },
                request: async (body) => {
                    if (body.action === "join") return { voiceId: "synthetic-voice", radius: 480, iceServers: [{ urls: "stun:stun.cloudflare.com:3478" }] };
                    if (body.action === "publish") {
                        const publisher = new LocalPeer();
                        await publisher.setRemoteDescription(body.sessionDescription);
                        await publisher.setLocalDescription(await publisher.createAnswer());
                        return { sessionDescription: await description(publisher) };
                    }
                    if (body.action === "status") return { peers: [{ id: 2, revision: "synthetic" }], subscriptionId };
                    if (body.action === "listen") {
                        receiver?.close();
                        receiver = new LocalPeer();
                        const transceiver = receiver.addTransceiver(remote.getAudioTracks()[0], { direction: "sendonly" });
                        await receiver.setLocalDescription(await receiver.createOffer());
                        subscriptionId = "synthetic-receiver";
                        return { subscriptionId, sessionDescription: await description(receiver), tracks: [{ mid: transceiver.mid, id: 2 }] };
                    }
                    if (body.action === "answer") { await receiver.setRemoteDescription(body.sessionDescription); return {}; }
                    if (body.action === "leave") { peers.forEach((peer) => peer.close()); return {}; }
                    throw new Error("Unknown synthetic voice request.");
                },
            });
            const room = { status: "connected", org: "synthetic", self: { id: 1 }, members: [{ id: 1, x: 100, y: 100 }, { id: 2, x: 160, y: 100 }] };
            controller.update(room);
            const noAutoCapture = captured === 0;
            await controller.start();
            if (controller.state.status !== "connected") throw new Error(controller.state.message);
            const microphoneInitiallyDisabled = !microphone.getAudioTracks()[0].enabled;
            await wait(() => controller.state.speaking.includes("2"), "remote speaking indicator");
            controller.talking(true);
            await wait(() => controller.state.speaking.includes("1"), "local push-to-talk indicator");
            const pushToTalk = microphone.getAudioTracks()[0].enabled;
            controller.talking(false);
            const releasedTalk = !microphone.getAudioTracks()[0].enabled;
            controller.deafen(true);
            await wait(() => controller.state.speaking.length === 0, "deafen");
            await controller.stop();
            return { noAutoCapture, deniedWithoutLounge, microphoneInitiallyDisabled, pushToTalk, releasedTalk,
                measuredRemoteAudio: true, stopped: microphone.getTracks().every((track) => track.readyState === "ended"),
                peersClosed: peers.every((peer) => peer.connectionState === "closed"), permissionReleased: released > 0,
                panelPresent: Boolean(document.getElementById("loungeVoice")) && !document.getElementById("loungeVoice").hidden };
        } finally {
            await controller?.stop();
            tracks.forEach((track) => track.stop());
            peers.forEach((peer) => peer.close());
            await Promise.all(contexts.map((context) => context.state === "closed" ? null : context.close()));
        }
    }).toString()})()`, true);
}
