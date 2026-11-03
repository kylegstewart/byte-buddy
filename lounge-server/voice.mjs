import { randomBytes } from "node:crypto";

export const VOICE_BODY_LIMIT = 128 * 1024;
export const VOICE_RADIUS = 480;
const MAX_PEERS = 12;
const SDP_LIMIT = 96 * 1024;
const API = "https://rtc.live.cloudflare.com/v1";
const opaqueId = () => randomBytes(24).toString("hex");
const validMid = (value) => typeof value === "string" && /^[a-zA-Z0-9_-]{1,64}$/.test(value);
const validId = (value) => typeof value === "string" && /^[a-zA-Z0-9_-]{1,256}$/.test(value);
const sdpMids = (description) => typeof description?.sdp === "string" ?
    [...description.sdp.matchAll(/^a=mid:([a-zA-Z0-9_-]{1,64})\r?$/gm)].map((match) => match[1]) : [];
const publicOfferSdp = (sdp) => sdp.split(/(?=^m=)/m).map((section) => {
    const trackId = "audio-" + (sdpMids({ sdp: section })[0] ?? "stream");
    return section.replace(/^a=msid:[^\r\n]*/gm, "a=msid:- " + trackId)
        .replace(/^a=msid-semantic:[^\r\n]*/gm, "a=msid-semantic: WMS *")
        .replace(/^(a=ssrc:[0-9]+ msid:)[^\r\n]*/gm, "$1- " + trackId)
        .replace(/^(a=ssrc:[0-9]+ (?:mslabel|label):)[^\r\n]*/gm, "$1" + trackId);
}).join("");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const ICE_URLS = new Set([
    "stun:stun.cloudflare.com:3478",
    "turn:turn.cloudflare.com:3478?transport=udp", "turn:turn.cloudflare.com:443?transport=udp",
    "turn:turn.cloudflare.com:3478?transport=tcp",
    "turns:turn.cloudflare.com:5349?transport=tcp", "turns:turn.cloudflare.com:443?transport=tcp",
]);
const PUBLIC_ERROR_CODES = new Set([
    "unauthorized", "not_found", "decoding_error", "invalid_params", "payload_too_large",
    "session_error", "invalid_session_description", "not_found_track_error", "empty_track_error",
    "repeated_local_track_error", "update_track_error", "close_track_error", "retryable_transient_error",
    "temporarily_unavailable_error", "transport_unavailable_error", "backend_error", "internal_error",
]);

function diagnostic(operation, reason, response = {}) {
    const codes = [response.body?.errorCode, ...(Array.isArray(response.body?.tracks) ?
        response.body.tracks.slice(0, MAX_PEERS).map((track) => track?.errorCode) : [])].filter(Boolean);
    console.error("lounge: voice diagnostic", JSON.stringify({
        operation, reason,
        ...(Number.isInteger(response.status) ? { status: response.status } : {}),
        ...(codes.length ? { errorCodes: [...new Set(codes.map((code) => PUBLIC_ERROR_CODES.has(code) ? code : "unknown"))] } : {}),
    }));
}

export function createVoiceService({ env, fetchImpl, rooms, staleMs, ErrorType, timeoutMs = 8_000 }) {
    const voices = new Map();
    const resources = new Set();
    const tasks = new Set();
    const limits = new Map();
    const configured = ["CF_REALTIME_APP_ID", "CF_REALTIME_APP_SECRET", "CF_TURN_KEY_ID", "CF_TURN_API_TOKEN"]
        .every((key) => typeof env[key] === "string" && env[key].trim());
    let stopped = false;
    let blocked = false;
    const fail = (status, code, message) => new ErrorType(status, code, message);
    const upstreamError = () => fail(502, "voice_upstream", "The voice service could not complete signaling. Leave voice and retry.");
    const staleError = () => fail(409, "voice_stale", "Voice changed or ended. Leave voice and retry.");
    const trackTask = (promise) => {
        tasks.add(promise);
        promise.finally(() => tasks.delete(promise)).catch(() => {});
        return promise;
    };
    const active = (voice) => !stopped && voices.get(voice.id) === voice &&
        rooms.get(voice.org)?.get(voice.member.id) === voice.member &&
        voice.member.sessionId === voice.sessionId && Date.now() - voice.member.lastSeen <= staleMs;
    const ensureActive = (voice) => { if (!active(voice)) throw staleError(); };

    async function api(path, body, method = "POST", turn = false) {
        const operation = turn ? "turn_credentials" : path.endsWith("/sessions/new") ? "session_create" :
            path.endsWith("/tracks/new") ? "tracks_new" : path.endsWith("/tracks/close") ? "tracks_close" :
            path.endsWith("/renegotiate") ? "renegotiate" : method === "GET" ? "session_inspect" : "unknown";
        let status;
        let signal;
        let reason = "network_error";
        try {
            signal = AbortSignal.timeout(timeoutMs);
            const response = await fetchImpl(API + path, {
                method, redirect: "error", signal,
                headers: { Authorization: "Bearer " + (turn ? env.CF_TURN_API_TOKEN : env.CF_REALTIME_APP_SECRET),
                    "Content-Type": "application/json" },
                ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            });
            status = response.status;
            reason = "response_read_error";
            const text = await response.text();
            if (text.length > 256 * 1024) { reason = "response_too_large"; throw upstreamError(); }
            reason = "invalid_json";
            const result = { ok: response.ok, status, body: text ? JSON.parse(text) : {} };
            if (!result.body || typeof result.body !== "object" || Array.isArray(result.body)) diagnostic(operation, "invalid_response", result);
            else if (!result.ok || result.body.errorCode) diagnostic(operation, "request_error", result);
            else if (Array.isArray(result.body.tracks) && result.body.tracks.some((track) =>
                track?.errorCode && !(operation === "tracks_close" && track.errorCode === "close_track_error"))) diagnostic(operation, "item_error", result);
            return result;
        } catch (error) {
            diagnostic(operation, signal?.aborted || error?.name === "TimeoutError" ? "timeout" : reason, { status });
            throw upstreamError();
        }
    }

    const appPath = "/apps/" + encodeURIComponent(env.CF_REALTIME_APP_ID ?? "");
    const resourcePath = (resource) => appPath + "/sessions/" + encodeURIComponent(resource.sessionId);
    const success = (response) => response.ok && response.body && !response.body.errorCode;

    function description(value, type, expectedMids, direction) {
        const invalid = () => { throw fail(400, "bad_voice_sdp", "Expected bounded audio-only SDP with matching mids and direction."); };
        if (value?.type !== type || typeof value.sdp !== "string" || Buffer.byteLength(value.sdp) > SDP_LIMIT ||
            /[^\x09\x0a\x0d\x20-\x7e]/.test(value.sdp)) invalid();
        const lines = value.sdp.replace(/\r\n/g, "\n").trim().split("\n");
        if (lines[0] !== "v=0" || lines.some((line) => !/^[a-z]=[^\r\n]*$/.test(line)) ||
            !lines.some((line) => line.startsWith("o=")) || !lines.includes("t=0 0")) invalid();
        const sections = [];
        const directions = [];
        let section;
        for (const line of lines) {
            if (line.startsWith("m=")) {
                if (!/^m=audio [0-9]+ (?:UDP\/TLS\/RTP\/SAVPF|RTP\/SAVPF) [0-9 ]+$/.test(line)) invalid();
                section = { mids: [], directions: [], lines: [] };
                sections.push(section);
            }
            if (section) section.lines.push(line);
            if (line.startsWith("a=mid:")) {
                if (!section) invalid();
                section.mids.push(line.slice(6));
            }
            if (/^a=(sendonly|recvonly|sendrecv|inactive)$/.test(line)) {
                (section ? section.directions : directions).push(line.slice(2));
            }
        }
        if (sections.length !== expectedMids.length || directions.length > 1) invalid();
        for (const [index, media] of sections.entries()) {
            if (media.mids.length !== 1 || media.mids[0] !== expectedMids[index] || media.directions.length > 1 ||
                !media.lines.includes("a=rtcp-mux")) invalid();
            const mode = media.directions[0] ?? directions[0] ?? "sendrecv";
            if (direction === "publish" && !["sendonly", "sendrecv"].includes(mode)) invalid();
            if (direction === "receive" && !["recvonly", "inactive"].includes(mode)) invalid();
        }
        return { type, sdp: value.sdp };
    }

    function peersFor(voice) {
        if (!active(voice)) return [];
        return [...voices.values()].filter((peer) => peer !== voice && active(peer) && peer.org === voice.org &&
            peer.publisher && !peer.publisher.retired &&
            Math.hypot(peer.member.x - voice.member.x, peer.member.y - voice.member.y) <= VOICE_RADIUS)
            .sort((first, second) => Math.hypot(first.member.x - voice.member.x, first.member.y - voice.member.y) -
                Math.hypot(second.member.x - voice.member.x, second.member.y - voice.member.y) || first.member.id - second.member.id)
            .slice(0, MAX_PEERS).sort((first, second) => first.member.id - second.member.id);
    }
    const peerKey = (peers) => peers.map((peer) => peer.member.id + ":" + peer.publisher.revision).join(",");

    function resourceFor(voice, role, sources = []) {
        const resource = { voice, role, sources, sessionId: null, mids: new Set(), inFlight: true,
            retired: false, uncertain: false, cleanup: null, revision: opaqueId() };
        resources.add(resource);
        return resource;
    }

    function invalidate(voice) {
        if (voices.get(voice.id) !== voice) return;
        voices.delete(voice.id);
        for (const resource of resources) if (resource.voice === voice) retire(resource);
        voice.receiver = null;
        voice.publisher = null;
    }

    function compromise(resource) {
        invalidate(resource.voice);
        for (const source of resource.sources) invalidate(source.voice);
        reconcile(resource.voice.org);
    }

    function noteMids(resource, body) {
        for (const track of Array.isArray(body?.tracks) ? body.tracks : []) {
            if (validMid(track?.mid)) resource.mids.add(track.mid);
        }
        for (const mid of sdpMids(body?.sessionDescription)) resource.mids.add(mid);
    }

    function retire(resource) {
        resource.retired = true;
        if (resource.cleanup) return resource.cleanup;
        resource.cleanup = trackTask((async () => {
            let confirmed = !resource.uncertain;
            for (let attempt = 0; attempt < 3; attempt++) {
                if (!resource.sessionId) break;
                try {
                    if (resource.uncertain) {
                        const inspected = await api(resourcePath(resource), undefined, "GET");
                        if (!success(inspected)) throw upstreamError();
                        noteMids(resource, inspected.body);
                    }
                    const mids = [...resource.mids];
                    if (!mids.length) {
                        if (resource.uncertain && attempt < 2) { await sleep(50 * (attempt + 1)); continue; }
                        break;
                    }
                    const result = await api(resourcePath(resource) + "/tracks/close", {
                        force: true, tracks: mids.map((mid) => ({ mid })),
                    }, "PUT");
                    if (!success(result) || !Array.isArray(result.body.tracks) ||
                        result.body.tracks.some((track) => !track || typeof track !== "object" || Array.isArray(track))) {
                        if (success(result)) diagnostic("tracks_close", "invalid_response", result);
                        throw upstreamError();
                    }
                    for (const mid of mids) {
                        const item = result.body.tracks.find((track) => track.mid === mid);
                        if (item && (!item.errorCode || item.errorCode === "close_track_error")) resource.mids.delete(mid);
                    }
                    if (resource.mids.size) {
                        diagnostic("tracks_close", "incomplete_close_result", result);
                        throw upstreamError();
                    }
                    confirmed = !resource.uncertain;
                    break;
                } catch {
                    compromise(resource);
                    if (attempt < 2) await sleep(50 * (attempt + 1));
                }
            }
            if (!resource.inFlight && (!confirmed || resource.mids.size)) {
                blocked = true;
                compromise(resource);
                for (const voice of [...voices.values()]) invalidate(voice);
                console.error("lounge: voice cleanup unconfirmed; voice disabled until server restart", JSON.stringify({
                    role: resource.role, uncertainAllocation: resource.uncertain, remainingTracks: resource.mids.size,
                }));
            } else if (!resource.inFlight) {
                resources.delete(resource);
            }
        })()).finally(() => { resource.cleanup = null; });
        return resource.cleanup;
    }

    function reconcile(org) {
        const cleanup = [];
        for (const voice of [...voices.values()]) {
            if (voice.org !== org) continue;
            if (!active(voice)) { invalidate(voice); continue; }
            const receiver = voice.receiver;
            if (receiver && receiver.peerKey !== peerKey(peersFor(voice))) {
                voice.receiver = null;
                cleanup.push(retire(receiver));
            }
        }
        return Promise.all(cleanup);
    }

    async function allocate(resource, tracks, sessionDescription) {
        try {
            const session = await api(appPath + "/sessions/new");
            if (!success(session) || !validId(session.body.sessionId)) {
                if (success(session)) diagnostic("session_create", "invalid_response", session);
                throw upstreamError();
            }
            resource.sessionId = session.body.sessionId;
            if (resource.retired || !active(resource.voice)) throw staleError();
            for (const track of tracks) if (track.mid) resource.mids.add(track.mid);
            let result;
            try {
                result = await api(resourcePath(resource) + "/tracks/new", {
                    tracks, ...(sessionDescription ? { sessionDescription } : {}),
                });
            } catch (error) {
                resource.uncertain = true;
                throw error;
            }
            noteMids(resource, result.body);
            if (!result.ok || !Array.isArray(result.body?.tracks)) resource.uncertain = true;
            if (!success(result) || !Array.isArray(result.body.tracks) ||
                result.body.tracks.length !== tracks.length || result.body.tracks.some((track) => !track || track.errorCode)) {
                if (success(result) && (!Array.isArray(result.body.tracks) ||
                    result.body.tracks.length !== tracks.length || result.body.tracks.some((track) => !track))) diagnostic("tracks_new", "invalid_response", result);
                throw upstreamError();
            }
            return result.body;
        } finally {
            resource.inFlight = false;
            if (resource.retired) {
                if (resource.cleanup) await resource.cleanup;
                await retire(resource);
            }
        }
    }

    function rateLimit(member, action) {
        const now = Date.now();
        for (const [key, value] of limits) if (now - value.at >= 60_000) limits.delete(key);
        const key = member.org + ":" + member.id;
        let value = limits.get(key);
        if (!value) limits.set(key, value = { at: now, total: 0, join: 0, signal: 0 });
        if (++value.total > 120 || (action === "join" && ++value.join > 4) ||
            (["publish", "listen", "answer"].includes(action) && ++value.signal > 30)) {
            throw fail(429, "voice_rate_limited", "Too many voice requests. Wait a minute before retrying.");
        }
    }

    async function join(session, member) {
        const previous = new Set();
        for (const voice of [...voices.values()]) {
            if (voice.member.id === member.id && voice.org === session.org) {
                previous.add(voice);
                invalidate(voice);
            }
        }
        const voice = { id: opaqueId(), member, org: session.org, sessionId: session.sessionId,
            publisher: null, receiver: null, busy: false };
        voices.set(voice.id, voice);
        try {
            await reconcile(session.org);
            await Promise.all([...resources].filter((resource) => previous.has(resource.voice)).map(retire));
            ensureActive(voice);
            if (blocked) throw fail(503, "voice_unavailable", "Voice cleanup could not be confirmed. The service requires operator attention.");
            const result = await api("/turn/keys/" + encodeURIComponent(env.CF_TURN_KEY_ID) + "/credentials/generate-ice-servers",
                { ttl: 3600 }, "POST", true);
            if (!success(result) || !Array.isArray(result.body.iceServers)) throw upstreamError();
            const iceServers = result.body.iceServers.map((server) => {
                if (!server || typeof server !== "object") throw upstreamError();
                const urls = (Array.isArray(server.urls) ? server.urls : [server.urls]).filter((url) => ICE_URLS.has(url));
                if (!urls.length) return null;
                if (urls.some((url) => url.startsWith("turn"))) {
                    if (typeof server.username !== "string" || typeof server.credential !== "string" ||
                        server.username.length > 1024 || server.credential.length > 1024) throw upstreamError();
                    return { urls, username: server.username, credential: server.credential };
                }
                return { urls };
            }).filter(Boolean);
            if (!iceServers.some((server) => server.urls.includes("turns:turn.cloudflare.com:443?transport=tcp"))) throw upstreamError();
            ensureActive(voice);
            return { voiceId: voice.id, iceServers, radius: VOICE_RADIUS };
        } catch (error) {
            invalidate(voice);
            throw error;
        }
    }

    async function execute(session, body) {
        const member = rooms.get(session.org)?.get(session.userId);
        if (!member || member.sessionId !== session.sessionId || Date.now() - member.lastSeen > staleMs) {
            throw fail(409, "voice_not_in_room", "Voice requires this session's active Lounge stream.");
        }
        if (!configured) throw fail(503, "voice_not_configured", "Voice is disabled. Configure the Realtime SFU app and TURN credentials on the server.");
        if (!["join", "publish", "status", "listen", "answer", "leave"].includes(body.action)) {
            throw fail(400, "bad_voice_action", "Unknown voice action.");
        }
        if (stopped) throw staleError();
        const voice = voices.get(body.voiceId);
        if (body.action === "leave") {
            if (voice && (voice.member !== member || voice.sessionId !== session.sessionId)) throw staleError();
            if (voice) invalidate(voice);
            await reconcile(session.org);
            await Promise.all([...resources].filter((resource) => resource.voice === voice).map(retire));
            if (blocked) throw fail(503, "voice_unavailable", "Voice cleanup could not be confirmed. The service requires operator attention.");
            return {};
        }
        rateLimit({ id: member.id, org: session.org }, body.action);
        if (blocked) throw fail(503, "voice_unavailable", "Voice cleanup could not be confirmed. Voice is disabled until the service is restarted.");
        if (body.action === "join") return join(session, member);
        if (!voice || voice.member !== member || voice.sessionId !== session.sessionId) throw staleError();
        ensureActive(voice);
        await reconcile(session.org);
        ensureActive(voice);
        if (body.action === "status") return { peers: peersFor(voice).map((peer) => ({ id: peer.member.id,
            revision: peer.publisher.revision })), subscriptionId: voice.receiver?.id ?? null };
        if (voice.busy) throw fail(409, "voice_busy", "Another voice operation is in progress.");
        voice.busy = true;
        try {
            if (body.action === "publish") {
                if (!validMid(body.mid)) throw fail(400, "bad_voice_mid", "Invalid audio mid.");
                const offer = description(body.sessionDescription, "offer", [body.mid], "publish");
                if (voice.publisher) { await retire(voice.publisher); voice.publisher = null; }
                await reconcile(voice.org);
                ensureActive(voice);
                const publisher = resourceFor(voice, "publisher");
                publisher.trackName = opaqueId();
                try {
                    const result = await allocate(publisher, [{ location: "local", mid: body.mid,
                        trackName: publisher.trackName, kind: "audio" }], offer);
                    if (publisher.retired) throw staleError();
                    if (result.requiresImmediateRenegotiation || result.tracks[0].mid !== body.mid ||
                        result.tracks[0].trackName !== publisher.trackName) throw upstreamError();
                    let answer;
                    try { answer = description(result.sessionDescription, "answer", [body.mid]); }
                    catch { throw upstreamError(); }
                    ensureActive(voice);
                    voice.publisher = publisher;
                    await reconcile(voice.org);
                    ensureActive(voice);
                    return { sessionDescription: answer };
                } catch (error) { await retire(publisher); throw error; }
            }
            if (body.action === "listen") {
                if (voice.receiver) { await retire(voice.receiver); voice.receiver = null; }
                ensureActive(voice);
                const peers = peersFor(voice);
                if (!peers.length) return { subscriptionId: null, sessionDescription: null, tracks: [] };
                const receiver = resourceFor(voice, "receiver", peers.map((peer) => peer.publisher));
                Object.assign(receiver, { id: opaqueId(), peerKey: peerKey(peers), answered: false });
                voice.receiver = receiver;
                try {
                    const result = await allocate(receiver, peers.map((peer) => ({ location: "remote", kind: "audio",
                        sessionId: peer.publisher.sessionId, trackName: peer.publisher.trackName })));
                    if (receiver.retired || voice.receiver !== receiver || receiver.peerKey !== peerKey(peersFor(voice))) throw staleError();
                    const tracks = peers.map((peer) => {
                        const found = result.tracks.filter((track) => track.sessionId === peer.publisher.sessionId &&
                            track.trackName === peer.publisher.trackName);
                        if (found.length !== 1 || !validMid(found[0].mid)) throw upstreamError();
                        return { mid: found[0].mid, id: peer.member.id };
                    });
                    if (new Set(tracks.map((track) => track.mid)).size !== tracks.length) throw upstreamError();
                    receiver.answerMids = sdpMids(result.sessionDescription);
                    let offer;
                    try { offer = description(result.sessionDescription, "offer", receiver.answerMids); }
                    catch { throw upstreamError(); }
                    if (receiver.answerMids.length !== tracks.length ||
                        tracks.some((track) => !receiver.answerMids.includes(track.mid))) throw upstreamError();
                    offer.sdp = publicOfferSdp(offer.sdp);
                    ensureActive(voice);
                    return { subscriptionId: receiver.id, sessionDescription: offer, tracks };
                } catch (error) {
                    if (voice.receiver === receiver) voice.receiver = null;
                    await retire(receiver);
                    throw error;
                }
            }
            const receiver = voice.receiver;
            if (!receiver || receiver.retired || receiver.id !== body.subscriptionId || receiver.answered) throw staleError();
            const answer = description(body.sessionDescription, "answer", receiver.answerMids, "receive");
            try {
                const result = await api(resourcePath(receiver) + "/renegotiate", { sessionDescription: answer }, "PUT");
                if (!success(result)) throw upstreamError();
                ensureActive(voice);
                if (receiver.retired || voice.receiver !== receiver) throw staleError();
                receiver.answered = true;
                return {};
            } catch (error) {
                if (voice.receiver === receiver) voice.receiver = null;
                await retire(receiver);
                throw error;
            }
        } finally { voice.busy = false; }
    }

    return {
        handle: (session, body) => trackTask(execute(session, body).catch((error) => {
            throw error instanceof ErrorType ? error : upstreamError();
        })),
        moved: (org) => reconcile(org),
        removed(member, org) {
            for (const voice of [...voices.values()]) if (voice.member === member) invalidate(voice);
            return reconcile(org);
        },
        async close() {
            stopped = true;
            for (const voice of [...voices.values()]) invalidate(voice);
            while (tasks.size) await Promise.allSettled([...tasks]);
            await Promise.all([...resources].map(retire));
        },
    };
}
