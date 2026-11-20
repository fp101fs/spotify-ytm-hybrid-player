"use strict";
// Item 16: YouTube music videos. ytdl is mocked; nothing here touches the network.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const { Readable } = require("node:stream");

const YT = require("../youtube.js");
const Server = require("../api/_lib/yt-server.js");
const { createShellSandbox, ROOT_DIR, manifest } = require("./helpers.js");

const read = (f) => fs.readFileSync(path.join(ROOT_DIR, f), "utf8");
const ALLOWLIST = JSON.parse(read("yt-allowlist.json"));
const ID = ALLOWLIST.videos[0].id;

// Formats shaped like @distube/ytdl-core 5.x returns them (visionos client: no progressive itag 18)
const f = (o) => ({ isDrc: false, isLive: false, isHLS: false, unusable: false, hasAudio: false, hasVideo: false, bitrate: 0, audioBitrate: 0, contentLength: 1000, ...o });
const FORMATS = [
    f({ itag: 398, mimeType: 'video/mp4; codecs="av01.0.05M.08"', container: "mp4", videoCodec: "av01.0.05M.08", hasVideo: true, height: 720, bitrate: 900 }),
    f({ itag: 136, mimeType: 'video/mp4; codecs="avc1.4D401F"', container: "mp4", videoCodec: "avc1.4D401F", hasVideo: true, height: 720, bitrate: 800 }),
    f({ itag: 299, mimeType: 'video/mp4; codecs="avc1.64002A"', container: "mp4", videoCodec: "avc1.64002A", hasVideo: true, height: 1080, bitrate: 2000 }),
    f({ itag: 135, mimeType: 'video/mp4; codecs="avc1.4D401F"', container: "mp4", videoCodec: "avc1.4D401F", hasVideo: true, height: 480, bitrate: 400 }),
    f({ itag: 247, mimeType: 'video/webm; codecs="vp9"', container: "webm", videoCodec: "vp9", hasVideo: true, height: 720, bitrate: 700 }),
    f({ itag: 139, mimeType: 'audio/mp4; codecs="mp4a.40.5"', container: "mp4", audioCodec: "mp4a.40.5", hasAudio: true, audioBitrate: 49 }),
    f({ itag: 140, mimeType: 'audio/mp4; codecs="mp4a.40.2"', container: "mp4", audioCodec: "mp4a.40.2", hasAudio: true, audioBitrate: 130 }),
    f({ itag: 140, mimeType: 'audio/mp4; codecs="mp4a.40.2"', container: "mp4", audioCodec: "mp4a.40.2", hasAudio: true, audioBitrate: 131, isDrc: true }),
    f({ itag: 251, mimeType: 'audio/webm; codecs="opus"', container: "webm", audioCodec: "opus", hasAudio: true, audioBitrate: 149 }),
];

test("parseYouTubeId accepts watch, youtu.be, Shorts, embed, live and music links; rejects the rest", () => {
    const id = "owrhKIN3Y90";
    for (const input of [
        id,
        `https://www.youtube.com/watch?v=${id}`,
        `https://www.youtube.com/watch?feature=share&v=${id}&t=42s`,
        `youtube.com/watch?v=${id}`,
        `https://m.youtube.com/watch?v=${id}`,
        `https://youtu.be/${id}?si=abc`,
        `https://www.youtube.com/shorts/${id}`,
        `https://www.youtube.com/embed/${id}?start=3`,
        `https://www.youtube-nocookie.com/embed/${id}`,
        `https://www.youtube.com/live/${id}`,
        `https://music.youtube.com/watch?v=${id}&list=RDAMVM${id}`,
        `  ${id}  `,
    ]) {
        assert.strictEqual(YT.parseYouTubeId(input), id, input);
    }
    for (const input of [
        "",
        null,
        "hello",
        "owrhKIN3Y9", // 10 chars
        "https://www.youtube.com/playlist?list=PL123",
        "https://www.youtube.com/@channel",
        `https://evil.example.com/watch?v=${id}`,
        `https://youtube.com.evil.example/watch?v=${id}`,
        `javascript:alert(1)//${id}`,
        `https://www.youtube.com/watch?v=${id}x`,
    ]) {
        assert.strictEqual(YT.parseYouTubeId(input), null, String(input));
    }
});

test("suggestions: the shipped yt-allowlist.json is valid; license is a credit, not a requirement", () => {
    const shipped = YT.validateAllowlist(ALLOWLIST);
    assert.deepStrictEqual(shipped.errors, []);
    assert.ok(shipped.entries.length >= 3);
    for (const e of shipped.entries) assert.match(e.source, /^https:\/\//);
    assert.strictEqual(YT.isAllowedLicense, undefined, "no license check any more");
    assert.match(YT.RIGHTS_NOTICE, /^Notice: only add videos you have the right to play/);

    const base = { title: "T", artist: "A", license: "CC BY 4.0", source: "https://example.org/proof" };
    const { entries, errors } = YT.validateAllowlist({
        videos: [
            { id: "aaaaaaaaaaa", ...base },
            { id: "aaaaaaaaaaa", ...base }, // duplicate
            { id: "short", ...base },
            { id: "bbbbbbbbbbb", ...base, license: "Standard YouTube License" },
            { id: "eeeeeeeeeee", title: "T", artist: "A" }, // no license or source: fine
            { id: "ccccccccccc", ...base, source: "not a link" },
            { id: "ddddddddddd", ...base, artist: "" },
        ],
    });
    assert.deepStrictEqual(entries.map((e) => e.id), ["aaaaaaaaaaa", "bbbbbbbbbbb", "eeeeeeeeeee"]);
    assert.strictEqual(errors.length, 4);
    assert.ok(errors.some((e) => /listed twice/.test(e)));
    assert.ok(errors.some((e) => /source must be a link/.test(e)));

    const unlisted = YT.buildYouTubeTrack(YT.entryFromInfo("fffffffffff"));
    assert.strictEqual(unlisted.title, "YouTube video fffffffffff");
    assert.strictEqual(unlisted.artistDisplay, "YouTube");
    assert.strictEqual(unlisted.license, "");
    const filled = YT.buildYouTubeTrack(YT.entryFromInfo("fffffffffff", { title: "Real", channel: "Chan", duration: 61 }));
    assert.deepStrictEqual([filled.title, filled.artistDisplay, filled.durationFormatted], ["Real", "Chan", "1:01"]);
});

test("buildYouTubeTrack makes a same-origin catalog track; no embed helper; video sync helpers", () => {
    const entry = YT.validateAllowlist(ALLOWLIST).entries[0];
    const t = YT.buildYouTubeTrack(entry);
    assert.strictEqual(t.id, `yt-${entry.id}`);
    assert.strictEqual(t.source, "youtube");
    assert.strictEqual(t.audioUrl, `api/yt/stream?id=${entry.id}&kind=audio`);
    assert.strictEqual(t.videoUrl, `api/yt/stream?id=${entry.id}&kind=video`);
    assert.match(t.coverUrl, /^https:\/\/i\.ytimg\.com\/vi\/.+\/hqdefault\.jpg$/);
    assert.strictEqual(t.durationFormatted, "3:25");
    assert.ok(t.moods.length && t.genre && t.bpm && t.energy >= 0 && t.energy <= 1);
    assert.ok(YT.isYouTubeTrack(t));
    assert.ok(!YT.isYouTubeTrack({ source: "youtube", youtubeId: "bad" }));

    assert.strictEqual(YT.buildEmbedUrl, undefined, "YouTube's own player is never used");

    assert.deepStrictEqual(
        { ...YT.computeVideoSync({ audioTime: 10, videoTime: 10.2, audioPaused: false, videoPaused: false }), drift: 0 },
        { seek: null, play: false, pause: false, drift: 0 }
    );
    assert.strictEqual(YT.computeVideoSync({ audioTime: 30, videoTime: 12 }).seek, 30);
    assert.strictEqual(YT.computeVideoSync({ audioTime: 5, videoTime: 5, audioPaused: false, videoPaused: true }).play, true);
    assert.strictEqual(YT.computeVideoSync({ audioTime: 5, videoTime: 5, audioPaused: true, videoPaused: false }).pause, true);
});

test("format choice: m4a audio first, then webm; video = progressive mp4, else H.264 ≤720p, never AV1", () => {
    assert.strictEqual(Server.chooseAudioFormat(FORMATS).itag, 140);
    assert.strictEqual(Server.chooseAudioFormat(FORMATS).isDrc, false);
    assert.strictEqual(Server.chooseAudioFormat(FORMATS.filter((x) => x.container !== "mp4")).itag, 251);
    assert.strictEqual(Server.chooseAudioFormat(FORMATS.filter((x) => x.hasVideo)), null);
    // DRC copy only when it's the only audio
    assert.strictEqual(Server.chooseAudioFormat(FORMATS.filter((x) => x.isDrc)).isDrc, true);
    // Unknown size (no Range possible), live or DRM formats are skipped
    assert.strictEqual(Server.chooseAudioFormat([f({ itag: 1, hasAudio: true, container: "mp4", contentLength: 0 })]), null);

    const video = Server.chooseVideoFormat(FORMATS);
    assert.strictEqual(video.itag, 136, "720p H.264, not 1080p and not AV1");
    const progressive = f({ itag: 18, mimeType: 'video/mp4; codecs="avc1.42001E, mp4a.40.2"', container: "mp4", hasVideo: true, hasAudio: true, height: 360 });
    assert.strictEqual(Server.chooseVideoFormat([...FORMATS, progressive]).itag, 18);
    assert.strictEqual(Server.chooseVideoFormat(FORMATS.filter((x) => !/avc1/.test(x.videoCodec || ""))).itag, 247);
    assert.strictEqual(Server.contentTypeOf(video), "video/mp4");
    assert.strictEqual(Server.contentTypeOf(Server.chooseAudioFormat(FORMATS)), "audio/mp4");
});

test("parseRange: open, closed, suffix, multi-range, capped chunk and unsatisfiable", () => {
    const size = 10_000_000;
    const cap = 4 * 1024 * 1024;
    assert.strictEqual(Server.parseRange(undefined, size), null);
    assert.strictEqual(Server.parseRange("items=0-1", size), null);
    assert.deepStrictEqual(Server.parseRange("bytes=0-1", size), { start: 0, end: 1 });
    assert.deepStrictEqual(Server.parseRange("bytes=0-", size, cap), { start: 0, end: cap - 1 });
    assert.deepStrictEqual(Server.parseRange("bytes=9999000-", size, cap), { start: 9999000, end: size - 1 });
    assert.deepStrictEqual(Server.parseRange("bytes=-500", size), { start: size - 500, end: size - 1 });
    assert.deepStrictEqual(Server.parseRange("bytes=100-200, 300-400", size), { start: 100, end: 200 });
    assert.deepStrictEqual(Server.parseRange("bytes=5-99999999999", 100, 0), { start: 5, end: 99 });
    assert.deepStrictEqual(Server.parseRange(`bytes=${size}-`, size), { unsatisfiable: true });
    assert.deepStrictEqual(Server.parseRange("bytes=50-10", size), { unsatisfiable: true });
    assert.deepStrictEqual(Server.parseRange("bytes=-0", size), { unsatisfiable: true });
});

test("mapYtError: bot check, age/region blocks, removed videos and the rest get clear codes", () => {
    const cases = [
        [{ code: "BOT_CHECK", message: "x" }, "BOT_CHECK", 503, true],
        [new Error("Sign in to confirm you’re not a bot. This helps protect our community."), "BOT_CHECK", 503, true],
        [{ code: "AGE_RESTRICTED", message: "x" }, "AGE_RESTRICTED", 403, false],
        [new Error("Sign in to confirm your age"), "AGE_RESTRICTED", 403, false],
        [{ code: "REGION_BLOCKED", message: "x" }, "REGION_BLOCKED", 451, true],
        [new Error("The uploader has not made this video available in your country"), "REGION_BLOCKED", 451, true],
        [{ code: "NOT_FOUND", message: "x" }, "NOT_FOUND", 404, false],
        [{ code: "PRIVATE", message: "x" }, "NOT_FOUND", 404, false],
        [new Error("Video unavailable. This video has been removed by the uploader"), "NOT_FOUND", 404, false],
        [{ code: "RATE_LIMITED", message: "x" }, "RATE_LIMITED", 429, true],
        [{ code: "MEMBERS_ONLY", message: "x" }, "UNAVAILABLE", 403, false],
        [{ code: "NO_FORMAT", message: "x" }, "NO_FORMAT", 502, true],
        [{ code: "INVALID_URL", message: "x" }, "INVALID_ID", 400, false],
        [new Error("socket hang up"), "UPSTREAM", 502, true],
    ];
    for (const [err, code, status] of cases) {
        const m = Server.mapYtError(err);
        assert.strictEqual(m.code, code, String(err.message || err.code));
        assert.strictEqual(m.status, status, code);
        assert.strictEqual(m.embed, undefined, code);
        assert.ok(m.message.length > 20);
    }
    assert.match(Server.mapYtError({ code: "BOT_CHECK" }).message, /not a bot/);
});

// ---------- handler over a real local HTTP server with a fake adapter ----------

function fakeAdapter(overrides = {}) {
    const bytes = Buffer.from(Array.from({ length: 5000 }, (_, i) => i % 251));
    const calls = { getInfo: 0, open: [] };
    const adapter = {
        name: "fake-ytdl",
        version: "0.0.0",
        bytes,
        calls,
        async getInfo(id, opts = {}) {
            calls.getInfo++;
            calls.lastCookie = opts.cookie || "";
            if (overrides.infoError) throw overrides.infoError;
            return {
                id,
                title: "YouTube title",
                channel: "Some Channel",
                duration: 205,
                thumbnails: [{ url: "https://i.ytimg.com/vi/x/hq720.jpg", width: 1280, height: 720 }],
                formats: FORMATS.map((x) => ({ ...x, contentLength: bytes.length })),
                captions: [
                    { lang: "nl", name: "Dutch (auto-generated)", auto: true },
                    { lang: "en", name: "English", auto: false },
                ],
                expiresAt: Date.now() + 3600_000,
            };
        },
        async openStream(info, format, { start = 0, end = bytes.length - 1 } = {}) {
            calls.open.push({ itag: format.itag, start, end });
            if (overrides.streamError) {
                return new Readable({
                    read() {
                        this.destroy(overrides.streamError);
                    },
                });
            }
            return Readable.from([bytes.subarray(start, end + 1)]);
        },
        async getCaptions(info, lang) {
            return `WEBVTT\n\n00:00.000 --> 00:01.000\nhello ${lang}\n`;
        },
    };
    return adapter;
}

async function withServer(handler, fn) {
    const server = http.createServer(handler);
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
        return await fn(base);
    } finally {
        server.closeAllConnections?.();
        await new Promise((r) => server.close(r));
    }
}

test("handler: status, info, any video ID and invalid IDs", async () => {
    const adapter = fakeAdapter();
    const handler = Server.createYtHandler({ adapter, allowlist: ALLOWLIST, log: null });
    await withServer(handler, async (base) => {
        const status = await (await fetch(`${base}/api/yt/status`)).json();
        assert.deepStrictEqual(status, { ok: true, backend: "fake-ytdl", version: "0.0.0", videos: ALLOWLIST.videos.length, signedIn: false, invalidEntries: [] });

        const res = await fetch(`${base}/api/yt/info?id=${ID}`);
        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.headers.get("cache-control"), "no-store");
        const info = await res.json();
        assert.strictEqual(info.title, ALLOWLIST.videos[0].title);
        assert.strictEqual(info.license, ALLOWLIST.videos[0].license);
        assert.strictEqual(info.duration, 205);
        assert.strictEqual(info.formats.audio.itag, 140);
        assert.strictEqual(info.formats.audio.contentType, "audio/mp4");
        assert.strictEqual(info.formats.video.itag, 136);
        assert.deepStrictEqual(info.captions.map((c) => c.lang), ["nl", "en"]);

        // A full link works as the id too (Vercel query or path routing)
        const viaLink = await fetch(`${base}/api/yt?action=info&id=${encodeURIComponent(`https://youtu.be/${ID}`)}`);
        assert.strictEqual(viaLink.status, 200);

        // Videos outside the suggestions are served too; title/artist come from YouTube, no license
        const unlisted = await fetch(`${base}/api/yt/info?id=dQw4w9WgXcQ`);
        assert.strictEqual(unlisted.status, 200);
        const unlistedInfo = await unlisted.json();
        assert.deepStrictEqual([unlistedInfo.title, unlistedInfo.artist, unlistedInfo.license], ["YouTube title", "Some Channel", null]);
        const unlistedStream = await fetch(`${base}/api/yt/stream?id=dQw4w9WgXcQ&kind=audio`, { method: "HEAD" });
        assert.strictEqual(unlistedStream.status, 200);
        const invalid = await fetch(`${base}/api/yt/info?id=nope`);
        assert.strictEqual(invalid.status, 400);
        assert.strictEqual((await invalid.json()).error.code, "INVALID_ID");
        assert.strictEqual((await fetch(`${base}/api/yt/other`)).status, 404);
        assert.strictEqual((await fetch(`${base}/api/yt/status`, { method: "POST" })).status, 405);
        // One lookup per video served all of the above (cached until the URLs expire)
        assert.strictEqual(adapter.calls.getInfo, 2);
    });
});

test("handler: stream passes Range through with 206 headers, 200 without Range, HEAD, 416", async () => {
    const adapter = fakeAdapter();
    const handler = Server.createYtHandler({ adapter, allowlist: ALLOWLIST, log: null, maxChunkBytes: 2000 });
    await withServer(handler, async (base) => {
        const url = `${base}/api/yt/stream?id=${ID}&kind=audio`;
        let res = await fetch(url, { headers: { Range: "bytes=100-199" } });
        assert.strictEqual(res.status, 206);
        assert.strictEqual(res.headers.get("content-type"), "audio/mp4");
        assert.strictEqual(res.headers.get("content-range"), "bytes 100-199/5000");
        assert.strictEqual(res.headers.get("content-length"), "100");
        assert.strictEqual(res.headers.get("accept-ranges"), "bytes");
        assert.strictEqual(res.headers.get("cache-control"), "no-store");
        assert.deepStrictEqual(Buffer.from(await res.arrayBuffer()), adapter.bytes.subarray(100, 200));
        assert.deepStrictEqual(adapter.calls.open.at(-1), { itag: 140, start: 100, end: 199 });

        // Open-ended range: capped chunk, the browser asks again for the rest
        res = await fetch(url, { headers: { Range: "bytes=0-" } });
        assert.strictEqual(res.status, 206);
        assert.strictEqual(res.headers.get("content-range"), "bytes 0-1999/5000");
        assert.strictEqual((await res.arrayBuffer()).byteLength, 2000);

        res = await fetch(url);
        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.headers.get("content-length"), "5000");
        assert.strictEqual((await res.arrayBuffer()).byteLength, 5000);

        res = await fetch(url, { method: "HEAD", headers: { Range: "bytes=0-9" } });
        assert.strictEqual(res.status, 206);
        assert.strictEqual(res.headers.get("content-length"), "10");
        const opensBefore = adapter.calls.open.length;
        assert.strictEqual(adapter.calls.open.length, opensBefore, "HEAD doesn't open a stream");

        res = await fetch(url, { headers: { Range: "bytes=6000-" } });
        assert.strictEqual(res.status, 416);
        assert.strictEqual(res.headers.get("content-range"), "bytes */5000");

        res = await fetch(`${base}/api/yt/stream?id=${ID}&kind=video`, { headers: { Range: "bytes=0-9" } });
        assert.strictEqual(res.status, 206);
        assert.strictEqual(res.headers.get("content-type"), "video/mp4");
        assert.strictEqual(adapter.calls.open.at(-1).itag, 136);
    });
});

test("handler: YouTube errors become JSON with clear codes, even when the stream fails before any bytes", async () => {
    const bot = Object.assign(new Error("Sign in to confirm you're not a bot"), { code: "BOT_CHECK" });
    await withServer(Server.createYtHandler({ adapter: fakeAdapter({ infoError: bot }), allowlist: ALLOWLIST, log: null }), async (base) => {
        const res = await fetch(`${base}/api/yt/info?id=${ID}`);
        assert.strictEqual(res.status, 503);
        const body = await res.json();
        assert.strictEqual(body.error.code, "BOT_CHECK");
        assert.strictEqual(body.error.embed, undefined);
        assert.match(body.error.message, /not a bot/);
    });
    const age = Object.assign(new Error("age"), { code: "AGE_RESTRICTED" });
    await withServer(Server.createYtHandler({ adapter: fakeAdapter({ infoError: age }), allowlist: ALLOWLIST, log: null }), async (base) => {
        const res = await fetch(`${base}/api/yt/stream?id=${ID}&kind=audio`);
        assert.strictEqual(res.status, 403);
        assert.strictEqual((await res.json()).error.code, "AGE_RESTRICTED");
    });
    const removed = Object.assign(new Error("Video unavailable"), {});
    const adapter = fakeAdapter({ streamError: removed });
    await withServer(Server.createYtHandler({ adapter, allowlist: ALLOWLIST, log: null }), async (base) => {
        const res = await fetch(`${base}/api/yt/stream?id=${ID}&kind=audio`, { headers: { Range: "bytes=0-9" } });
        assert.strictEqual(res.status, 404);
        assert.strictEqual((await res.json()).error.code, "NOT_FOUND");
        // The failed lookup isn't reused
        await fetch(`${base}/api/yt/info?id=${ID}`);
        assert.strictEqual(adapter.calls.getInfo, 2);
    });
});

test("handler: captions are served as WebVTT for a listed language only", async () => {
    await withServer(Server.createYtHandler({ adapter: fakeAdapter(), allowlist: ALLOWLIST, log: null }), async (base) => {
        const res = await fetch(`${base}/api/yt/captions?id=${ID}&lang=en`);
        assert.strictEqual(res.status, 200);
        assert.match(res.headers.get("content-type"), /^text\/vtt/);
        assert.match(await res.text(), /^WEBVTT[\s\S]*hello en/);
        const missing = await fetch(`${base}/api/yt/captions?id=${ID}&lang=de`);
        assert.strictEqual(missing.status, 404);
    });
});

test("the only file that imports ytdl is the adapter; the Vercel function wires adapter + handler", () => {
    const apiFiles = ["api/yt.js", "api/_lib/yt-server.js", "youtube.js", "script.js", "scripts/dev-server.js"];
    for (const file of apiFiles) assert.doesNotMatch(read(file), /(require|import)\(\s*["']@distube\/ytdl-core/, file);
    assert.match(read("api/_lib/ytdl-adapter.js"), /import\("@distube\/ytdl-core"\)/);
    const fn = require("../api/yt.js");
    assert.strictEqual(typeof fn, "function");
});

test("dev server: static files with no-store and Range, /api/yt routed, private paths blocked", async () => {
    const { createServer } = require("../scripts/dev-server.js");
    const server = createServer();
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
        let res = await fetch(`${base}/`);
        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.headers.get("cache-control"), "no-store");
        assert.match(res.headers.get("content-type"), /text\/html/);
        assert.match(await res.text(), /<title>/);

        res = await fetch(`${base}/tracks.json`, { headers: { Range: "bytes=0-9" } });
        assert.strictEqual(res.status, 206);
        assert.strictEqual(res.headers.get("content-length"), "10");
        await res.arrayBuffer();

        res = await fetch(`${base}/api/yt/status`);
        assert.strictEqual(res.status, 200);
        const status = await res.json();
        assert.strictEqual(status.ok, true);
        assert.strictEqual(status.backend, "@distube/ytdl-core");

        for (const blocked of ["/node_modules/@distube/ytdl-core/package.json", "/api/_lib/yt-server.js", "/.git/config", "/%2e%2e/%2e%2e/etc/passwd"]) {
            res = await fetch(`${base}${blocked}`);
            assert.ok([403, 404].includes(res.status), `${blocked} → ${res.status}`);
            await res.arrayBuffer();
        }
    } finally {
        server.closeAllConnections?.();
        await new Promise((r) => server.close(r));
    }
});

test("package.json and vercel.json run the function and the dev server", () => {
    const pkg = JSON.parse(read("package.json"));
    assert.strictEqual(pkg.scripts.start, "node scripts/dev-server.js");
    assert.match(pkg.scripts["test:yt"], /yt-smoke/);
    assert.strictEqual(pkg.dependencies["@distube/ytdl-core"], "5.2.1");
    const cfg = JSON.parse(read("vercel.json"));
    assert.ok(cfg.rewrites.some((r) => r.source === "/api/yt/:action" && r.destination === "/api/yt?action=:action"));
    assert.match(cfg.functions["api/yt.js"].includeFiles, /yt-allowlist\.json/);
    assert.ok(cfg.functions["api/yt.js"].maxDuration >= 30);
});

// ---------- the app (shell) ----------

async function youtubeShell(options = {}) {
    const ctx = createShellSandbox();
    const { sandbox, shell } = ctx;
    sandbox.fetch = async (url) => {
        const u = String(url);
        if (u.includes("yt-allowlist.json")) return { ok: true, json: async () => ALLOWLIST };
        if (u.includes("api/yt/status")) {
            if (options.apiMissing) return { ok: false, status: 404, headers: { get: () => "text/html" }, json: async () => ({}) };
            return { ok: true, headers: { get: () => "application/json" }, json: async () => ({ ok: true }) };
        }
        if (u.includes("api/yt/info")) {
            if (options.infoError) {
                return { ok: false, status: 503, headers: { get: () => "application/json" }, json: async () => ({ error: { code: options.infoError } }) };
            }
            return {
                ok: true,
                headers: { get: () => "application/json" },
                json: async () => ({ title: "Looked-up title", artist: "Looked-up channel", channel: "Looked-up channel", duration: 200, captions: options.captions || [] }),
            };
        }
        return { ok: true, json: async () => manifest };
    };
    // Load the allowlist through the real getSongs() path
    await shell.getSongs();
    shell.initYouTubeControls();
    await shell.checkYouTubeApi();
    return ctx;
}

test("app: the Add YouTube video box adds any video link and shows a rights notice", async () => {
    const { shell, el, sandbox } = await youtubeShell();
    assert.strictEqual(shell.getYouTubeAllowlist().length, ALLOWLIST.videos.length);
    assert.strictEqual(shell.getYouTubeTracks().length, 0, "nothing added on first run");

    let r = shell.addYouTubeVideo(`https://music.youtube.com/watch?v=${ID}`);
    assert.strictEqual(r.status, "added");
    assert.match(r.message, /^Added “Carefree” by Kevin MacLeod \(CC BY 4\.0\)/);
    assert.strictEqual(shell.getYouTubeTracks().length, 1);
    assert.deepStrictEqual(Array.from(sandbox.SpotTubeStorage.getPreferences().youtubeVideoIds), [ID]);

    r = shell.addYouTubeVideo(`https://youtu.be/${ID}`);
    assert.strictEqual(r.status, "exists");

    // Not a suggestion: added anyway, then its title is looked up
    r = shell.addYouTubeVideo("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
    assert.strictEqual(r.status, "added");
    assert.match(r.message, /^Added video dQw4w9WgXcQ/);
    await new Promise((resolve) => setImmediate(resolve));
    assert.strictEqual(r.track.title, "Looked-up title");
    assert.strictEqual(r.track.artistDisplay, "Looked-up channel");
    assert.strictEqual(sandbox.SpotTubeStorage.getPreferences().youtubeVideoMeta.dQw4w9WgXcQ.title, "Looked-up title");
    assert.match(el("yt-add-status").textContent, /^Added “Looked-up title” by Looked-up channel/);
    assert.ok(shell.removeYouTubeVideo("yt-dQw4w9WgXcQ"));
    assert.strictEqual(sandbox.SpotTubeStorage.getPreferences().youtubeVideoMeta.dQw4w9WgXcQ, undefined);

    r = shell.addYouTubeVideo("https://vimeo.com/123");
    assert.strictEqual(r.status, "invalid");

    // The form: errors set aria-invalid and keep focus in the box; success clears it
    const input = el("yt-add-input");
    input.value = "not a link";
    shell.submitYouTubeAddForm();
    assert.strictEqual(input.getAttribute("aria-invalid"), "true");
    assert.match(el("yt-add-status").textContent, /doesn't look like a YouTube video link/);
    assert.strictEqual(sandbox.document.activeElement, input);
    input.value = `https://www.youtube.com/shorts/${ALLOWLIST.videos[1].id}`;
    shell.submitYouTubeAddForm();
    assert.strictEqual(input.getAttribute("aria-invalid"), undefined);
    assert.strictEqual(input.value, "");
    assert.match(el("yt-add-status").textContent, /^Added “Darkest Child”/);

    const added = shell.addAllYouTubeVideos();
    assert.strictEqual(added.length, ALLOWLIST.videos.length - 2);
    assert.strictEqual(shell.getYouTubeTracks().length, ALLOWLIST.videos.length);

    // The collection view lists them and a row can be removed
    const data = shell.buildCollectionDetailData({ type: "youtube" });
    assert.strictEqual(data.title, "YouTube videos");
    assert.strictEqual(data.trackCount, ALLOWLIST.videos.length);
    assert.strictEqual(data.seedSpec.badge, "YOUTUBE MIX");
    assert.ok(shell.removeYouTubeVideo(`yt-${ID}`));
    assert.ok(!sandbox.SpotTubeStorage.getPreferences().youtubeVideoIds.includes(ID));
    assert.match(el("yt-add-status").textContent, /Removed “Carefree”/);
});

test("app: added videos come back after a reload; mixes leave them out while the server is missing", async () => {
    const first = await youtubeShell({ apiMissing: true });
    assert.strictEqual(first.shell.getYouTubeApiState().status, "missing");
    first.shell.addYouTubeVideo(ID);
    const track = first.shell.getYouTubeTracks()[0];
    assert.ok(!first.shell.getQueueCatalog().includes(track), "can't autoplay without /api/yt");
    first.shell.setYouTubeApiStatus("ok");
    assert.ok(first.shell.getQueueCatalog().includes(track));

    // Reload: getSongs() rebuilds the track from the saved ID + allowlist
    const prefs = first.sandbox.SpotTubeStorage.getPreferences();
    const second = createShellSandbox();
    second.sandbox.SpotTubeStorage.setPreferences({
        youtubeVideoIds: prefs.youtubeVideoIds.concat("zzzzzzzzzzz"),
        youtubeVideoMeta: { zzzzzzzzzzz: { title: "Saved title", artist: "Saved artist", duration: 90 } },
    });
    second.sandbox.fetch = async (url) =>
        String(url).includes("yt-allowlist.json") ? { ok: true, json: async () => ALLOWLIST } : { ok: true, json: async () => manifest };
    const songs = await second.shell.getSongs();
    const yt = songs.filter((t) => t.source === "youtube");
    assert.deepStrictEqual(yt.map((t) => t.youtubeId), [ID, "zzzzzzzzzzz"], "videos outside the suggestions are kept");
    assert.deepStrictEqual([yt[1].title, yt[1].artistDisplay, yt[1].duration], ["Saved title", "Saved artist", 90]);
});

test("app: without the server, playing a YouTube track shows an error and never opens YouTube's player", async () => {
    const { shell, el } = await youtubeShell({ apiMissing: true });
    shell.addYouTubeVideo(ID);
    const track = shell.getYouTubeTracks()[0];
    shell.playMusic(track);
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
    assert.strictEqual(shell.getYouTubeVideoState().open, false);
    assert.strictEqual(el("yt-video-panel").hidden, true);
    assert.match(el("library-toast").textContent, /“Carefree”: YouTube videos need the app's small server/);
});

test("app: the playbar Video toggle shows the synced muted video, captions, and hides for other songs", async () => {
    const { shell, el } = await youtubeShell({ captions: [{ lang: "en", name: "English", auto: false }] });
    shell.addYouTubeVideo(ID);
    const track = shell.getYouTubeTracks()[0];
    shell.playMusic(track);
    const toggle = el("playbar-video-btn");
    assert.strictEqual(toggle.hidden, false);
    assert.strictEqual(toggle.getAttribute("aria-pressed"), "false");

    toggle.click();
    assert.strictEqual(toggle.getAttribute("aria-pressed"), "true");
    const video = el("yt-video");
    assert.strictEqual(video.src, `api/yt/stream?id=${ID}&kind=video`);
    assert.strictEqual(video.muted, true);
    assert.strictEqual(el("yt-video-panel").hidden, false);
    assert.match(el("yt-video-title").textContent, /Carefree — Kevin MacLeod/);
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(el("yt-video-cc-btn").hidden, false, "captions offered");
    assert.strictEqual(el("yt-video-cc-btn").getAttribute("aria-pressed"), "true", "written captions start on");
    el("yt-video-cc-btn").click();
    assert.strictEqual(el("yt-video-cc-btn").getAttribute("aria-pressed"), "false");

    // Sync: video jumps to the deck's position
    video.readyState = 4;
    video.currentTime = 0;
    video.paused = true;
    video.play = () => {
        video.paused = false;
        return Promise.resolve();
    };
    const deck = shell.getPlayerEngine().getActiveDeck();
    deck.currentTime = 42;
    deck.paused = false;
    const action = shell.syncYouTubeVideo();
    assert.strictEqual(action.seek, 42);
    assert.strictEqual(video.currentTime, 42);
    assert.strictEqual(video.paused, false);

    // A non-YouTube song hides the panel and the toggle; the next YouTube song brings the video back
    shell.playMusic(0);
    assert.strictEqual(el("yt-video-panel").hidden, true);
    assert.strictEqual(toggle.hidden, true);
    shell.playMusic(track);
    assert.strictEqual(el("yt-video-panel").hidden, false);
    assert.strictEqual(toggle.getAttribute("aria-pressed"), "true");

    // Hide video: focus goes back to the toggle, audio keeps going
    el("yt-video-close-btn").click();
    assert.strictEqual(el("yt-video-panel").hidden, true);
    assert.strictEqual(toggle.getAttribute("aria-pressed"), "false");
    assert.strictEqual(shell.getYouTubeVideoState().wanted, false);
});

test("app: a failing YouTube stream shows the mapped message and leaves mixes until reload", async () => {
    const { shell, el } = await youtubeShell({ infoError: "BOT_CHECK" });
    shell.addYouTubeVideo(ID);
    const track = shell.getYouTubeTracks()[0];
    assert.ok(shell.getQueueCatalog().includes(track));
    const code = await shell.handleYouTubePlaybackError(track);
    assert.strictEqual(code, "BOT_CHECK");
    assert.match(el("library-toast").textContent, /“Carefree”: YouTube asked this server to confirm it isn't a bot/);
    assert.ok(el("library-toast").classList.contains("is-error"));
    assert.ok(!shell.getQueueCatalog().includes(track));
});

test("HTML/CSS hooks: labelled add box, aria-pressed toggle, video panel, script order", () => {
    const html = read("index.html");
    assert.ok(html.indexOf('src="youtube.js"') < html.indexOf('src="script.js"'));
    assert.match(html, /<label[^>]*for="yt-add-input"[^>]*>Add YouTube video<\/label>/);
    assert.match(html, /id="yt-add-status" role="status"/);
    assert.match(html, /id="yt-add-notice">Notice: only add videos you have the right to play/);
    assert.match(html, /aria-describedby="yt-add-help yt-add-notice yt-add-status"/);
    assert.doesNotMatch(html, /Only videos on this site's public-domain list can play/);
    assert.match(html, /id="playbar-video-btn"[^>]*aria-pressed="false"[^>]*aria-controls="yt-video-panel"/);
    assert.match(html, /<video[^>]*id="yt-video"[^>]*muted[^>]*playsinline/);
    assert.match(html, /id="yt-video-cc-btn" aria-pressed="false"/);
    assert.match(html, /id="lib-youtube" data-collection="youtube"/);
    const css = read("style.css");
    const block = css.slice(css.indexOf("Item 16: YouTube"));
    assert.match(block, /\.playbar-video-btn:focus-visible/);
    assert.match(block, /@media \(max-width: 740px\)[\s\S]*min-block-size: 44px/);
});

test("resolveTrackIndex finds YouTube tracks by id (they have no filename)", async () => {
    const { shell } = await youtubeShell();
    shell.addAllYouTubeVideos();
    const tracks = shell.getYouTubeTracks();
    const songs = shell.getState().songs;
    for (const t of tracks) assert.strictEqual(songs[shell.resolveTrackIndex(t)].id, t.id);
    shell.playMusic(tracks[2]);
    assert.strictEqual(shell.getState().songs[shell.getState().currentTrackIndex].id, tracks[2].id);
});

// ---------- YouTube cookies ----------

const Cookies = require("../api/_lib/yt-cookies.js");

const COOKIE_EDITOR_EXPORT = [
    { domain: ".youtube.com", name: "SAPISID", value: "abc/DEF", httpOnly: false },
    { domain: ".youtube.com", name: "__Secure-3PAPISID", value: "x3p", httpOnly: false },
    { domain: ".youtube.com", name: "LOGIN_INFO", value: "AFmmF2sw:QUQ3MjNm=", httpOnly: true },
    { domain: ".youtube.com", name: "YSC", value: "notneeded" },
    { domain: ".google.com", name: "SID", value: "googleonly" },
];

test("cookies: Cookie-Editor JSON, cookies.txt and header → sign-in Cookie header", () => {
    const { header, count } = Cookies.toCookieHeader(JSON.stringify(COOKIE_EDITOR_EXPORT));
    assert.strictEqual(header, "SAPISID=abc/DEF; __Secure-3PAPISID=x3p; LOGIN_INFO=AFmmF2sw:QUQ3MjNm=");
    assert.strictEqual(count, 3);

    const txt = "# Netscape HTTP Cookie File\n.youtube.com\tTRUE\t/\tTRUE\t0\tSAPISID\tzz\n#HttpOnly_.youtube.com\tTRUE\t/\tTRUE\t0\tSID\tss\n";
    assert.strictEqual(Cookies.toCookieHeader(txt).header, "SAPISID=zz; SID=ss");
    assert.strictEqual(Cookies.toCookieHeader("Cookie: PREF=f6=1; SAPISID=q").header, "SAPISID=q; PREF=f6=1");

    for (const bad of ["", "hello", "[]", JSON.stringify([{ domain: ".youtube.com", name: "PREF", value: "1" }])]) {
        assert.throws(() => Cookies.toCookieHeader(bad), (e) => e.code === "COOKIE_INVALID");
    }
});

test("cookies: saved as chunked HttpOnly cookies and read back", () => {
    const big = `SAPISID=a; LOGIN_INFO=${"x".repeat(9000)}`;
    const set = Cookies.authSetCookies({ headers: { "x-forwarded-proto": "https" } }, big);
    assert.strictEqual(set.length, 4);
    assert.ok(set.every((c) => /HttpOnly; SameSite=Strict; Secure/.test(c) && /Path=\/api\/yt/.test(c)));
    const jar = set.map((c) => c.split(";")[0]).join("; ");
    assert.strictEqual(Cookies.readAuth({ headers: { cookie: jar } }), big);
    assert.ok(Cookies.authSetCookies({ headers: {} }, "").every((c) => /Max-Age=0/.test(c) && !/Secure/.test(c)));
});

test("handler: POST/DELETE /api/yt/cookies and signed-in lookups", async () => {
    const adapter = fakeAdapter();
    const handler = Server.createYtHandler({ adapter, allowlist: ALLOWLIST, log: null });
    await withServer(handler, async (base) => {
        let res = await fetch(`${base}/api/yt/cookies`, { method: "POST", body: "nope" });
        assert.strictEqual(res.status, 400);
        assert.strictEqual((await res.json()).error.code, "COOKIE_INVALID");

        res = await fetch(`${base}/api/yt/cookies`, { method: "POST", body: "x", headers: { Origin: "https://evil.example" } });
        assert.strictEqual(res.status, 403);

        res = await fetch(`${base}/api/yt/cookies`, { method: "POST", body: JSON.stringify(COOKIE_EDITOR_EXPORT) });
        assert.strictEqual(res.status, 200);
        assert.deepStrictEqual(await res.json(), { ok: true, signedIn: true, count: 3 });
        const jar = res.headers.getSetCookie().map((c) => c.split(";")[0]).filter((c) => !c.endsWith("=")).join("; ");

        const status = await (await fetch(`${base}/api/yt/status`, { headers: { cookie: jar } })).json();
        assert.strictEqual(status.signedIn, true);
        await fetch(`${base}/api/yt/info?id=${ID}`, { headers: { cookie: jar } });
        assert.strictEqual(adapter.calls.lastCookie, "SAPISID=abc/DEF; __Secure-3PAPISID=x3p; LOGIN_INFO=AFmmF2sw:QUQ3MjNm=");

        res = await fetch(`${base}/api/yt/cookies`, { method: "DELETE", headers: { cookie: jar } });
        assert.ok(res.headers.getSetCookie().every((c) => /Max-Age=0/.test(c)));
    });
});

test("handler: an expired cookie maps to COOKIE_EXPIRED and is cleared", async () => {
    const expired = Object.assign(new Error("YouTube treats the cookie as signed out"), { code: "AUTH_FAILED" });
    const handler = Server.createYtHandler({ adapter: fakeAdapter({ infoError: expired }), allowlist: ALLOWLIST, log: null });
    await withServer(handler, async (base) => {
        const res = await fetch(`${base}/api/yt/info?id=${ID}`, { headers: { cookie: "yt_auth_0=SAPISID%3Da" } });
        assert.strictEqual(res.status, 401);
        assert.strictEqual((await res.json()).error.code, "COOKIE_EXPIRED");
        assert.ok(res.headers.getSetCookie().some((c) => /^yt_auth_0=;/.test(c)));
    });
    assert.ok(YT.needsCookies("BOT_CHECK") && YT.needsCookies("COOKIE_EXPIRED") && !YT.needsCookies("NOT_FOUND"));
});

test("handler: /api/yt/search and /api/yt/suggest (cached per query)", async () => {
    const adapter = fakeAdapter();
    let searches = 0;
    adapter.search = async (q) => {
        searches++;
        return [{ id: ID, title: `Song for ${q}`, artist: "Artist", duration: 200, thumbnail: "https://x/t.jpg" }];
    };
    adapter.suggest = async (q) => [`${q} one`, `${q} two`];
    const handler = Server.createYtHandler({ adapter, allowlist: ALLOWLIST, log: null });
    await withServer(handler, async (base) => {
        const a = await (await fetch(`${base}/api/yt/search?q=sir%20duke`)).json();
        assert.strictEqual(a.results[0].title, "Song for sir duke");
        await fetch(`${base}/api/yt/search?q=Sir%20%20Duke`);
        assert.strictEqual(searches, 1, "same query (case/space) is cached");
        assert.deepStrictEqual((await (await fetch(`${base}/api/yt/search?q=`)).json()).results, []);
        const s = await (await fetch(`${base}/api/yt/suggest?q=stevie`)).json();
        assert.deepStrictEqual(s.suggestions, ["stevie one", "stevie two"]);
    });
});
