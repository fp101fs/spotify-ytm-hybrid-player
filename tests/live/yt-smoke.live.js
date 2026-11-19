"use strict";
// Item 16: opt-in live check against YouTube (`npm run test:yt`). Not part of `npm test`, which stays offline.
// Uses the real @distube/ytdl-core adapter on one public-domain video from yt-allowlist.json.
const test = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const { createYtHandler } = require("../../api/_lib/yt-server.js");
const { createYtdlAdapter } = require("../../api/_lib/ytdl-adapter.js");
const allowlist = require("../../yt-allowlist.json");

const entry = allowlist.videos.find((v) => /^public domain/i.test(v.license)) || allowlist.videos[0];

test(`live: ${entry.title} (${entry.id}) info, audio range and video range through the proxy`, { timeout: 90_000 }, async () => {
    const server = http.createServer(createYtHandler({ adapter: createYtdlAdapter() }));
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${server.address().port}/api/yt`;
    try {
        const infoRes = await fetch(`${base}/info?id=${entry.id}`);
        const info = await infoRes.json();
        assert.strictEqual(infoRes.status, 200, JSON.stringify(info));
        assert.ok(info.duration > 30, "duration");
        assert.ok(info.formats.audio, "an audio format");
        assert.ok(info.formats.video, "a video format");
        console.log(`  ${info.youtubeTitle} · ${info.channel} · ${info.duration}s · audio itag ${info.formats.audio.itag} (${info.formats.audio.contentType}) · video itag ${info.formats.video.itag} ${info.formats.video.height}p · captions ${info.captions.map((c) => c.lang).join(",") || "none"}`);

        for (const kind of ["audio", "video"]) {
            const res = await fetch(`${base}/stream?id=${entry.id}&kind=${kind}`, { headers: { Range: "bytes=0-65535" } });
            const bytes = Buffer.from(await res.arrayBuffer());
            assert.strictEqual(res.status, 206, kind);
            assert.match(res.headers.get("content-range"), /^bytes 0-65535\/\d+$/);
            assert.strictEqual(bytes.length, 65536);
            if (res.headers.get("content-type").endsWith("/mp4")) assert.strictEqual(bytes.subarray(4, 8).toString("latin1"), "ftyp", `${kind} is MP4`);
        }

        // A later range (seeking) works too
        const size = info.formats.audio.contentLength;
        const tail = await fetch(`${base}/stream?id=${entry.id}&kind=audio`, { headers: { Range: `bytes=${size - 1000}-` } });
        assert.strictEqual(tail.status, 206);
        assert.strictEqual((await tail.arrayBuffer()).byteLength, 1000);
    } finally {
        server.closeAllConnections?.();
        await new Promise((r) => server.close(r));
    }
});
