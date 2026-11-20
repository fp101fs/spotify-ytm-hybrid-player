"use strict";
// Auto-downloads: server-side file saving + disk checks, /api/yt routes, and the browser module. No network.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { Readable } = require("node:stream");

const D = require("../api/_lib/downloads.js");
const Server = require("../api/_lib/yt-server.js");
const Client = require("../downloads.js");

const GB = D.GB;
const ID = "dQw4w9WgXcQ";
const ID2 = "abcdefghijk";
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "spottube-dl-"));
const roomy = async () => ({ free: 500 * GB, total: 1000 * GB });
const audio = (bytes, container = "mp4") => async () => ({ stream: Readable.from([bytes]), size: bytes.length, container });

test("file names: Artist - Title [id].ext, sanitized, no doubled artist, parse back", () => {
    assert.strictEqual(D.fileNameFor({ id: ID, artist: "Rick Astley", title: "Never Gonna Give You Up" }), `Rick Astley - Never Gonna Give You Up [${ID}].m4a`);
    assert.strictEqual(D.fileNameFor({ id: ID, artist: "AC/DC", title: 'Back: In "Black"?' }), `AC DC - Back In Black [${ID}].m4a`);
    assert.strictEqual(D.fileNameFor({ id: ID, artist: "Daft Punk", title: "Daft Punk - One More Time" }), `Daft Punk - One More Time [${ID}].m4a`);
    assert.strictEqual(D.fileNameFor({ id: ID, artist: "", title: "", ext: ".webm" }), `YouTube [${ID}].webm`);
    assert.deepStrictEqual(D.parseFileName(`Rick Astley - Never Gonna [${ID}].m4a`), { id: ID, artist: "Rick Astley", title: "Never Gonna" });
    assert.strictEqual(D.parseFileName("notes.txt"), null);
});

test("limits: defaults, and the free-space floor can't be set below 1 GB", () => {
    assert.deepStrictEqual(D.clampLimits(), D.DEFAULT_LIMITS);
    assert.strictEqual(D.clampLimits({ minFreeBytes: 0 }).minFreeBytes, D.MIN_FREE_FLOOR);
    assert.strictEqual(D.clampLimits({ maxBytes: "-5" }).maxBytes, D.DEFAULT_LIMITS.maxBytes);
});

test("download: saves a playable file once, skips existing, finds it, survives a rescan", async () => {
    const dir = tmpDir();
    const dl = D.createDownloads({ dir, statfs: roomy, tag: false });
    const bytes = Buffer.alloc(4000, 7);
    const first = await dl.download({ id: ID, artist: "Rick Astley", title: "Never Gonna" }, {}, audio(bytes));
    assert.strictEqual(first.status, "saved");
    const file = path.join(dir, `Rick Astley - Never Gonna [${ID}].m4a`);
    assert.deepStrictEqual(fs.readFileSync(file), bytes);
    assert.deepStrictEqual(fs.readdirSync(dir), [path.basename(file)], "no .part files left");

    let opened = false;
    const again = await dl.download({ id: ID, artist: "x", title: "y" }, {}, async () => ((opened = true), audio(bytes)()));
    assert.strictEqual(again.status, "exists");
    assert.strictEqual(opened, false, "an existing song never asks YouTube again");

    const found = await dl.find(ID);
    assert.strictEqual(found.size, 4000);
    assert.strictEqual(found.contentType, "audio/mp4");

    fs.writeFileSync(path.join(dir, `.${ID2}.part`), "crash leftovers");
    const fresh = D.createDownloads({ dir, statfs: roomy });
    const status = await fresh.status();
    assert.strictEqual(status.count, 1);
    assert.strictEqual(status.usedBytes, 4000);
    assert.deepStrictEqual(status.songs, [{ id: ID, artist: "Rick Astley", title: "Never Gonna", size: 4000 }]);
    assert.ok(!fs.existsSync(path.join(dir, `.${ID2}.part`)), "stale partial files are cleaned up");

    fs.rmSync(file);
    assert.strictEqual(await fresh.find(ID), null, "a file deleted by hand is forgotten");
});

test("download: size limit and free-disk floor skip the song without writing anything", async () => {
    const dir = tmpDir();
    const dl = D.createDownloads({ dir, statfs: roomy, tag: false });
    const big = Buffer.alloc(3000);
    const r1 = await dl.download({ id: ID, artist: "a", title: "b" }, { maxBytes: 2000 }, audio(big));
    assert.deepStrictEqual(r1, { status: "skipped", reason: "LIMIT" });

    const tight = D.createDownloads({ dir, statfs: async () => ({ free: 1.5 * GB, total: 100 * GB }), tag: false });
    const r2 = await tight.download({ id: ID, artist: "a", title: "b" }, { minFreeBytes: 2 * GB }, audio(big));
    assert.deepStrictEqual(r2, { status: "skipped", reason: "DISK_FULL" });
    assert.deepStrictEqual(fs.readdirSync(dir), []);
});

test("download: a truncated stream leaves no file; jobs run one at a time; disabled → unavailable", async () => {
    const dir = tmpDir();
    const dl = D.createDownloads({ dir, statfs: roomy, tag: false });
    const short = async () => ({ stream: Readable.from([Buffer.alloc(10)]), size: 100, container: "mp4" });
    await assert.rejects(dl.download({ id: ID, artist: "a", title: "b" }, {}, short), /incomplete/);
    assert.deepStrictEqual(fs.readdirSync(dir), []);

    const order = [];
    const slow = (tag) => async () => {
        order.push(`start ${tag}`);
        await new Promise((r) => setTimeout(r, 20));
        order.push(`end ${tag}`);
        return audio(Buffer.alloc(10))();
    };
    await Promise.all([dl.download({ id: ID, artist: "a", title: "1" }, {}, slow(1)), dl.download({ id: ID2, artist: "a", title: "2" }, {}, slow(2))]);
    assert.deepStrictEqual(order, ["start 1", "end 1", "start 2", "end 2"]);

    const off = D.createDownloads({ dir, enabled: false });
    assert.deepStrictEqual(await off.status(), { available: false });
    assert.strictEqual((await off.download({ id: ID }, {}, audio(Buffer.alloc(1)))).reason, "UNAVAILABLE");
});

// ---------- /api/yt routes ----------

function fakeAdapter(bytes) {
    const calls = { open: 0 };
    return {
        name: "fake",
        version: "0",
        calls,
        async getInfo(id) {
            return {
                id,
                title: "t",
                channel: "c",
                duration: 10,
                formats: [{ itag: 140, mimeType: "audio/mp4", container: "mp4", hasAudio: true, hasVideo: false, audioBitrate: 128, contentLength: bytes.length }],
                expiresAt: Date.now() + 3600_000,
            };
        },
        async openStream(info, format, { start = 0, end = bytes.length - 1 } = {}) {
            calls.open++;
            return Readable.from([bytes.subarray(start, end + 1)]);
        },
    };
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

test("handler: POST /download saves, GET /downloads lists it, /stream then plays from disk with Range", async () => {
    const bytes = Buffer.from(Array.from({ length: 3000 }, (_, i) => i % 251));
    const adapter = fakeAdapter(bytes);
    const downloads = D.createDownloads({ dir: tmpDir(), statfs: roomy, tag: false });
    const handler = Server.createYtHandler({ adapter, downloads, log: null });
    await withServer(handler, async (base) => {
        assert.strictEqual((await fetch(`${base}/api/yt/download?id=${ID}`)).status, 405);
        const cross = await fetch(`${base}/api/yt/download?id=${ID}`, { method: "POST", headers: { Origin: "https://evil.example" } });
        assert.strictEqual(cross.status, 403);

        const saved = await (await fetch(`${base}/api/yt/download?id=${ID}&artist=Rick%20Astley&title=Song`, { method: "POST" })).json();
        assert.strictEqual(saved.status, "saved");
        assert.strictEqual(saved.song.file, `Rick Astley - Song [${ID}].m4a`);

        const status = await (await fetch(`${base}/api/yt/downloads`)).json();
        assert.strictEqual(status.available, true);
        assert.strictEqual(status.count, 1);

        const opensBefore = adapter.calls.open;
        const res = await fetch(`${base}/api/yt/stream?id=${ID}`, { headers: { Range: "bytes=100-199" } });
        assert.strictEqual(res.status, 206);
        assert.strictEqual(res.headers.get("content-range"), "bytes 100-199/3000");
        assert.deepStrictEqual(Buffer.from(await res.arrayBuffer()), bytes.subarray(100, 200));
        assert.strictEqual(adapter.calls.open, opensBefore, "served from disk, not YouTube");
    });
});

test("handler: without downloads the routes answer unavailable", async () => {
    const handler = Server.createYtHandler({ adapter: fakeAdapter(Buffer.alloc(10)), log: null });
    await withServer(handler, async (base) => {
        assert.deepStrictEqual(await (await fetch(`${base}/api/yt/downloads`)).json(), { available: false });
        const r = await (await fetch(`${base}/api/yt/download?id=${ID}`, { method: "POST" })).json();
        assert.deepStrictEqual(r, { status: "skipped", reason: "UNAVAILABLE" });
    });
});

// ---------- browser module ----------

function fakeFetch(routes) {
    const calls = [];
    const fn = async (url, opts = {}) => {
        calls.push({ url, method: opts.method || "GET" });
        const key = Object.keys(routes).find((k) => url.includes(k));
        const body = typeof routes[key] === "function" ? routes[key](url) : routes[key];
        return { ok: true, headers: { get: () => "application/json" }, json: async () => body };
    };
    fn.calls = calls;
    return fn;
}

const yt = (id, extra = {}) => ({ source: "youtube", youtubeId: id, title: `Song ${id}`, primaryArtist: "Artist", ...extra });

test("client: downloads the current then the next song, skips local tracks and already-saved ones", async () => {
    const fetch = fakeFetch({
        "api/yt/downloads": { available: true, songs: [{ id: ID2 }] },
        "api/yt/download?": (url) => ({ status: "saved", song: { id: new URL(url, "http://x").searchParams.get("id") } }),
    });
    const saved = [];
    const current = yt(ID);
    const dl = Client.createAutoDownloader({
        fetch,
        delayMs: 0,
        getCurrentTrack: () => current,
        getNextTrack: () => yt(ID2),
        getSettings: () => ({ maxGB: 2, minFreeGB: 3 }),
        onSaved: (t) => saved.push(t.youtubeId),
    });
    await dl.downloadNowAndNext();
    const posts = fetch.calls.filter((c) => c.method === "POST");
    assert.strictEqual(posts.length, 1, "the next song was already on disk");
    const q = new URL(posts[0].url, "http://x").searchParams;
    assert.strictEqual(q.get("id"), ID);
    assert.strictEqual(q.get("artist"), "Artist");
    assert.strictEqual(q.get("maxBytes"), String(2 * GB));
    assert.strictEqual(q.get("minFreeBytes"), String(3 * GB));
    assert.deepStrictEqual(saved, [ID]);
    assert.ok(dl.isDownloaded(ID));

    assert.strictEqual(await dl.request({ source: "local", title: "x" }), null);
    await dl.request(current);
    assert.strictEqual(fetch.calls.filter((c) => c.method === "POST").length, 1, "never re-requested");
});

test("client: off in Settings or without the server → no downloads", async () => {
    const fetch = fakeFetch({ "api/yt/downloads": { available: false } });
    const off = Client.createAutoDownloader({ fetch, getSettings: () => ({ enabled: false }) });
    assert.strictEqual(await off.request(yt(ID)), null);
    const noServer = Client.createAutoDownloader({ fetch, getSettings: () => ({}) });
    assert.strictEqual(await noServer.request(yt(ID)), null);
    assert.strictEqual(fetch.calls.filter((c) => c.method === "POST").length, 0);
});

test("client: settings are clamped and bytes formatted", () => {
    assert.deepStrictEqual(Client.normalizeSettings(null), { enabled: true, maxGB: 5, minFreeGB: 10 });
    assert.deepStrictEqual(Client.normalizeSettings({ enabled: false, maxGB: 0, minFreeGB: 9999 }), { enabled: false, maxGB: 1, minFreeGB: 500 });
    assert.strictEqual(Client.formatBytes(1.5 * GB), "1.5 GB");
    assert.strictEqual(Client.formatBytes(5 * 1024 ** 2), "5 MB");
});

test("app wiring: Settings section, script order, gitignored folder", () => {
    const read = (f) => fs.readFileSync(path.join(__dirname, "..", f), "utf8");
    const html = read("index.html");
    for (const id of ["settings-downloads", "setting-auto-download", "setting-download-max", "setting-download-free", "setting-download-usage"]) {
        assert.ok(html.includes(`id="${id}"`), id);
    }
    assert.ok(html.indexOf('src="downloads.js"') < html.indexOf('src="script.js"'));
    assert.match(read(".gitignore"), /^downloads\/$/m);
    assert.match(read(".vercelignore"), /^downloads\/$/m);
});
