"use strict";
/**
 * Item 16: request handling for /api/yt/* (Vercel function `api/yt.js` and `scripts/dev-server.js`).
 *
 *   GET /api/yt/status                      → { ok, backend, version, videos }
 *   GET /api/yt/info?id=                    → title, channel, duration, thumbnails, license, chosen formats, captions
 *   GET|HEAD /api/yt/stream?id=&kind=audio|video → bytes proxied from YouTube, Range/206 supported
 *   GET /api/yt/captions?id=&lang=          → WebVTT
 *   GET /api/yt/search?q=                   → YouTube Music songs [{ id, title, artist, duration, thumbnail }]
 *   GET /api/yt/suggest?q=                  → autocomplete strings
 *   POST /api/yt/cookies (export JSON/text) → saves YouTube sign-in cookies as HttpOnly cookies (see yt-cookies.js)
 *   DELETE /api/yt/cookies                  → forgets them
 *
 * Any valid video ID is served (the app shows a rights notice; yt-allowlist.json is only the suggestions and
 * their credits). The googlevideo URLs are tied to the server's IP and send no
 * CORS headers, and the crossfade engine needs same-origin audio, so bytes go through here.
 */
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const YT = require("../../youtube.js");
const Cookies = require("./yt-cookies.js");

const ALLOWLIST_PATH = path.join(__dirname, "..", "..", "yt-allowlist.json");
const DEFAULT_MAX_CHUNK = 4 * 1024 * 1024;

// ---------- allowlist ----------

let allowlistCache = { mtimeMs: -1, value: null };

/** Reads yt-allowlist.json (re-read when it changes, so the dev server needs no restart). */
function loadAllowlist(file = ALLOWLIST_PATH) {
    let mtimeMs = 0;
    try {
        mtimeMs = fs.statSync(file).mtimeMs;
    } catch (_) {
        return { entries: [], errors: [`${path.basename(file)} not found`], byId: new Map() };
    }
    if (allowlistCache.value && allowlistCache.mtimeMs === mtimeMs && allowlistCache.file === file) {
        return allowlistCache.value;
    }
    let value;
    try {
        const parsed = YT.validateAllowlist(JSON.parse(fs.readFileSync(file, "utf8")));
        value = { ...parsed, byId: new Map(parsed.entries.map((e) => [e.id, e])) };
    } catch (err) {
        value = { entries: [], errors: [`${path.basename(file)}: ${err.message}`], byId: new Map() };
    }
    allowlistCache = { mtimeMs, file, value };
    return value;
}

function toAllowlist(input) {
    if (!input) return loadAllowlist();
    if (typeof input === "function") return input();
    if (input.byId instanceof Map) return input;
    const parsed = YT.validateAllowlist(input);
    return { ...parsed, byId: new Map(parsed.entries.map((e) => [e.id, e])) };
}

// ---------- format choice ----------

function usable(f) {
    return f && !f.unusable && !f.isLive && !f.isHLS && Number(f.contentLength) > 0;
}

/**
 * Best audio-only format. m4a (AAC) first because every browser, Safari included, decodes it in
 * <audio> and Web Audio; webm/opus if there is no m4a. Stable-volume (DRC) copies only as a last resort.
 */
function chooseAudioFormat(formats = []) {
    const audioOnly = formats.filter((f) => usable(f) && f.hasAudio && !f.hasVideo);
    const pick = (list) =>
        list.slice().sort((a, b) => (b.audioBitrate || 0) - (a.audioBitrate || 0) || (b.bitrate || 0) - (a.bitrate || 0))[0];
    for (const drc of [false, true]) {
        const pool = audioOnly.filter((f) => Boolean(f.isDrc) === drc);
        const m4a = pick(pool.filter((f) => f.container === "mp4" || /^audio\/mp4/.test(f.mimeType)));
        if (m4a) return m4a;
        const webm = pick(pool.filter((f) => f.container === "webm" || /^audio\/webm/.test(f.mimeType)));
        if (webm) return webm;
    }
    return null;
}

/**
 * Video for the panel. The best progressive mp4 with sound when YouTube still offers one (itag 18/22);
 * most videos now only have video-only streams, so then H.264 mp4 up to 720p (plays everywhere and the
 * sound comes from the audio deck anyway), then VP9 webm. AV1 is skipped: older Safari can't decode it.
 */
function chooseVideoFormat(formats = [], maxHeight = 720) {
    const vids = formats.filter((f) => usable(f) && f.hasVideo);
    const byHeight = (list) => list.slice().sort((a, b) => (b.height || 0) - (a.height || 0) || (b.bitrate || 0) - (a.bitrate || 0))[0];
    const isMp4 = (f) => f.container === "mp4" || /^video\/mp4/.test(f.mimeType);
    const isAvc = (f) => /avc1/i.test(f.videoCodec || f.mimeType);
    const fits = (f) => !f.height || f.height <= maxHeight;
    return (
        byHeight(vids.filter((f) => f.hasAudio && isMp4(f))) ||
        byHeight(vids.filter((f) => !f.hasAudio && isMp4(f) && isAvc(f) && fits(f))) ||
        byHeight(vids.filter((f) => !f.hasAudio && /vp0?9/i.test(f.videoCodec || f.mimeType) && fits(f))) ||
        byHeight(vids.filter((f) => !f.hasAudio && isMp4(f) && isAvc(f))) ||
        null
    );
}

function chooseFormat(formats, kind) {
    return kind === "video" ? chooseVideoFormat(formats) : chooseAudioFormat(formats);
}

function describeFormat(f) {
    if (!f) return null;
    return {
        itag: f.itag,
        mimeType: f.mimeType,
        contentType: contentTypeOf(f),
        hasAudio: f.hasAudio,
        hasVideo: f.hasVideo,
        bitrate: f.bitrate || null,
        audioBitrate: f.audioBitrate || null,
        width: f.width || null,
        height: f.height || null,
        contentLength: f.contentLength || null,
    };
}

function contentTypeOf(f) {
    const base = String((f && f.mimeType) || "").split(";")[0].trim();
    if (base) return base;
    return f && f.hasVideo ? "video/mp4" : "audio/mp4";
}

// ---------- Range ----------

/**
 * Parses a `Range` header against a known size. Returns null (no/ignorable header → whole file),
 * `{ unsatisfiable: true }` (→ 416) or `{ start, end }` (inclusive). Only the first range of a
 * multi-range request is served. Ranges are capped at `maxChunk` bytes; browsers ask again for the rest.
 */
function parseRange(header, size, maxChunk = DEFAULT_MAX_CHUNK) {
    if (!header || typeof header !== "string") return null;
    const m = /^\s*bytes\s*=\s*(\d*)\s*-\s*(\d*)\s*(?:,.*)?$/i.exec(header);
    if (!m || (m[1] === "" && m[2] === "")) return null;
    let start;
    let end;
    if (m[1] === "") {
        const suffix = Number(m[2]);
        if (!suffix) return { unsatisfiable: true };
        start = Math.max(0, size - suffix);
        end = size - 1;
    } else {
        start = Number(m[1]);
        end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
    }
    if (!Number.isFinite(start) || start >= size || end < start) return { unsatisfiable: true };
    if (maxChunk > 0) end = Math.min(end, start + maxChunk - 1);
    return { start, end };
}

// ---------- errors ----------

class YtRequestError extends Error {
    constructor(code, status, detail) {
        super(detail || code);
        this.code = code;
        this.status = status;
    }
}

const STATUS = {
    INVALID_ID: 400,
    BOT_CHECK: 503,
    COOKIE_EXPIRED: 401,
    COOKIE_INVALID: 400,
    AGE_RESTRICTED: 403,
    REGION_BLOCKED: 451,
    NOT_FOUND: 404,
    RATE_LIMITED: 429,
    UNAVAILABLE: 403,
    NO_FORMAT: 502,
    UPSTREAM: 502,
};

/** Library error (or any thrown error) → `{ status, code, message, embed }` for the JSON body. */
function mapYtError(err) {
    const libCode = err && typeof err.code === "string" ? err.code : "";
    const text = String((err && err.message) || "");
    let code;
    if (err instanceof YtRequestError || libCode === "COOKIE_INVALID") {
        code = err.code;
    } else if (libCode === "AUTH_FAILED" || (libCode === "INVALID_ARGUMENT" && /cookie/i.test(text))) {
        code = "COOKIE_EXPIRED";
    } else if (libCode === "BOT_CHECK" || /sign in to confirm you.?re not a bot|confirm (that )?you.?re not a bot/i.test(text)) {
        code = "BOT_CHECK";
    } else if (libCode === "AGE_RESTRICTED" || /age.?restricted|confirm your age|inappropriate for some users/i.test(text)) {
        code = "AGE_RESTRICTED";
    } else if (libCode === "REGION_BLOCKED" || /available in your country|blocked it in your country/i.test(text)) {
        code = "REGION_BLOCKED";
    } else if (libCode === "NOT_FOUND" || libCode === "PRIVATE" || /video unavailable|has been removed|private video|does not exist/i.test(text)) {
        code = "NOT_FOUND";
    } else if (libCode === "RATE_LIMITED" || /\b429\b|too many requests/i.test(text)) {
        code = "RATE_LIMITED";
    } else if (["MEMBERS_ONLY", "PREMIUM_ONLY", "NOT_STARTED"].includes(libCode)) {
        code = "UNAVAILABLE";
    } else if (libCode === "NO_FORMAT") {
        code = "NO_FORMAT";
    } else if (libCode === "INVALID_URL") {
        code = "INVALID_ID";
    } else {
        code = "UPSTREAM";
    }
    return {
        status: STATUS[code] || 502,
        code,
        message: code === "COOKIE_INVALID" ? text : YT.describeYtError(code),
        embed: YT.canFallBackToEmbed(code),
    };
}

// ---------- handler ----------

function sendJson(res, status, body, extraHeaders = {}) {
    if (res.headersSent) {
        res.destroy();
        return;
    }
    const json = JSON.stringify(body);
    res.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Length": Buffer.byteLength(json),
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        ...extraHeaders,
    });
    res.end(json);
}

function sendError(res, err, log, req) {
    const mapped = mapYtError(err);
    if (log && mapped.code !== "INVALID_ID") {
        log.warn(`[yt] ${mapped.code}: ${String((err && err.message) || err).slice(0, 300)}`);
    }
    const extra = mapped.code === "COOKIE_EXPIRED" && req ? { "Set-Cookie": Cookies.authSetCookies(req, "") } : {};
    sendJson(res, mapped.status, { error: { code: mapped.code, message: mapped.message, embed: mapped.embed } }, extra);
}

const MAX_BODY = 512 * 1024;

/** The request body as text; Vercel may have parsed it into `req.body` already. */
async function readBody(req) {
    if (req.body !== undefined && req.body !== null) {
        return typeof req.body === "string" || Buffer.isBuffer(req.body) ? req.body : JSON.stringify(req.body);
    }
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
        size += chunk.length;
        if (size > MAX_BODY) throw new YtRequestError("COOKIE_INVALID", 413, "That file is too big to be a cookie export.");
        chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString("utf8");
}

function routeOf(url) {
    const m = /\/api\/yt\/([a-z]+)\/?$/i.exec(url.pathname);
    return (m ? m[1] : url.searchParams.get("action") || "").toLowerCase();
}

function createYtHandler(options = {}) {
    const adapter = options.adapter;
    const now = options.now || (() => Date.now());
    const maxChunk = options.maxChunkBytes === undefined ? DEFAULT_MAX_CHUNK : options.maxChunkBytes;
    const log = options.log === undefined ? console : options.log;
    const infoCache = new Map(); // id → { promise, expiresAt }
    const captionCache = new Map(); // `${id}|${lang}` → text
    const discoveryCache = new Map(); // `${kind}|${query}` → { promise, expiresAt }

    /** Search/suggest answers, cached for a few minutes per query (typing repeats them a lot). */
    function discover(kind, rawQuery) {
        const query = String(rawQuery || "").replace(/\s+/g, " ").trim().slice(0, 150);
        if (!query) return Promise.resolve([]);
        if (!adapter || typeof adapter[kind] !== "function") return Promise.resolve([]);
        const key = `${kind}|${query.toLowerCase()}`;
        const hit = discoveryCache.get(key);
        if (hit && hit.expiresAt > now()) return hit.promise;
        const promise = Promise.resolve(adapter[kind](query));
        const slot = { promise, expiresAt: now() + 5 * 60000 };
        discoveryCache.set(key, slot);
        promise.catch(() => {
            if (discoveryCache.get(key) === slot) discoveryCache.delete(key);
        });
        if (discoveryCache.size > 200) discoveryCache.delete(discoveryCache.keys().next().value);
        return promise;
    }

    function getAllowlist() {
        return toAllowlist(options.allowlist);
    }

    /** A valid ID; `entry` is its suggestion-list entry (title/artist/credits) or null. */
    function requireId(rawId) {
        const id = YT.parseYouTubeId(String(rawId || ""));
        if (!id) throw new YtRequestError("INVALID_ID", 400);
        return { id, entry: getAllowlist().byId.get(id) || null };
    }

    function getInfo(id, cookie = "") {
        // Signed-in and signed-out lookups can differ (bot check), so they're cached apart
        const key = cookie ? `${id}|${crypto.createHash("sha256").update(cookie).digest("hex").slice(0, 16)}` : id;
        const cached = infoCache.get(key);
        if (cached && cached.expiresAt > now()) return cached.promise;
        const promise = adapter.getInfo(id, cookie ? { cookie } : {}).then((info) => {
            // Refresh a minute before YouTube's URLs expire
            slot.expiresAt = Math.min(Number(info.expiresAt) || now() + 300000, now() + 6 * 3600000) - 60000;
            return info;
        });
        const slot = { promise, expiresAt: now() + 60000 };
        infoCache.set(key, slot);
        promise.catch(() => {
            if (infoCache.get(key) === slot) infoCache.delete(key);
        });
        if (infoCache.size > 64) infoCache.delete(infoCache.keys().next().value);
        return promise;
    }

    async function handleInfo(req, url, res) {
        const { id, entry } = requireId(url.searchParams.get("id"));
        const info = await getInfo(id, Cookies.readAuth(req));
        const thumbs = (info.thumbnails || []).slice().sort((a, b) => (b.width || 0) - (a.width || 0));
        sendJson(res, 200, {
            id,
            title: entry ? entry.title : info.title,
            artist: entry ? entry.artist : info.channel,
            youtubeTitle: info.title,
            channel: info.channel,
            duration: info.duration,
            thumbnail: thumbs[0] ? thumbs[0].url : YT.thumbnailUrl(id),
            thumbnails: thumbs,
            license: (entry && entry.license) || null,
            licenseUrl: (entry && entry.licenseUrl) || null,
            source: (entry && entry.source) || null,
            formats: {
                audio: describeFormat(chooseAudioFormat(info.formats)),
                video: describeFormat(chooseVideoFormat(info.formats)),
            },
            captions: (info.captions || []).map((c) => ({
                lang: c.lang,
                name: c.name,
                auto: Boolean(c.auto),
                url: `captions?id=${encodeURIComponent(id)}&lang=${encodeURIComponent(c.lang)}`,
            })),
        });
    }

    async function handleStream(req, url, res) {
        const { id } = requireId(url.searchParams.get("id"));
        const kind = url.searchParams.get("kind") === "video" ? "video" : "audio";
        const cookie = Cookies.readAuth(req);
        const info = await getInfo(id, cookie);
        const format = chooseFormat(info.formats, kind);
        if (!format) throw Object.assign(new Error(`no ${kind} format`), { code: "NO_FORMAT" });

        const size = Number(format.contentLength) || 0;
        const range = size ? parseRange(req.headers.range, size, maxChunk) : null;
        const headers = {
            "Content-Type": contentTypeOf(format),
            "Accept-Ranges": size ? "bytes" : "none",
            // Nothing from YouTube is kept on the device: no HTTP cache either.
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
        };
        if (range && range.unsatisfiable) {
            res.writeHead(416, { ...headers, "Content-Range": `bytes */${size}`, "Content-Length": 0 });
            res.end();
            return;
        }
        let status = 200;
        let start;
        let end;
        if (range) {
            status = 206;
            ({ start, end } = range);
            headers["Content-Range"] = `bytes ${start}-${end}/${size}`;
            headers["Content-Length"] = end - start + 1;
        } else if (size) {
            headers["Content-Length"] = size;
        }
        if (req.method === "HEAD") {
            res.writeHead(status, headers);
            res.end();
            return;
        }

        const controller = new AbortController();
        const onClose = () => {
            if (!res.writableEnded) controller.abort();
        };
        res.on("close", onClose);
        const stream = await adapter.openStream(info, format, { start, end, signal: controller.signal });
        // Wait for the first bytes (or an error) before sending headers, so a failure is still a JSON error.
        await new Promise((resolve, reject) => {
            const done = () => {
                stream.off("error", fail);
                resolve();
            };
            const fail = (err) => {
                stream.off("readable", done);
                stream.off("end", done);
                reject(err);
            };
            stream.once("readable", done);
            stream.once("end", done);
            stream.once("error", fail);
        }).catch((err) => {
            stream.destroy();
            if (controller.signal.aborted) return null;
            infoCache.forEach((slot, key) => {
                if (key === id || key.startsWith(`${id}|`)) infoCache.delete(key);
            });
            throw err;
        });
        if (controller.signal.aborted) {
            stream.destroy();
            return;
        }
        res.writeHead(status, headers);
        stream.on("error", (err) => {
            if (!controller.signal.aborted && log) log.warn(`[yt] stream ${id} broke: ${String(err && err.message).slice(0, 200)}`);
            res.destroy();
        });
        stream.pipe(res);
    }

    async function handleCaptions(req, url, res) {
        const { id } = requireId(url.searchParams.get("id"));
        const info = await getInfo(id, Cookies.readAuth(req));
        const lang = String(url.searchParams.get("lang") || "");
        const track = (info.captions || []).find((c) => c.lang === lang);
        if (!track) {
            sendJson(res, 404, { error: { code: "NO_CAPTIONS", message: "This video has no captions in that language." } });
            return;
        }
        const key = `${id}|${lang}`;
        if (!captionCache.has(key)) captionCache.set(key, await adapter.getCaptions(info, lang));
        const text = captionCache.get(key);
        res.writeHead(200, {
            "Content-Type": "text/vtt; charset=utf-8",
            "Content-Length": Buffer.byteLength(text),
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
        });
        res.end(text);
    }

    /** POST saves an exported cookie list as HttpOnly cookies on /api/yt; DELETE forgets it; GET says if one is saved. */
    async function handleCookies(req, res) {
        try {
            if (req.method === "GET") {
                sendJson(res, 200, { signedIn: Boolean(Cookies.readAuth(req)) });
                return;
            }
            if (req.method !== "POST" && req.method !== "DELETE") {
                sendJson(res, 405, { error: { code: "METHOD", message: "Use POST or DELETE." } }, { Allow: "GET, POST, DELETE" });
                return;
            }
            // Only this app's own pages may set or clear them
            const origin = req.headers.origin;
            const host = req.headers["x-forwarded-host"] || req.headers.host;
            if (origin && host && new URL(origin).host !== String(host).split(",")[0].trim()) {
                sendJson(res, 403, { error: { code: "ORIGIN", message: "Cross-site request refused." } });
                return;
            }
            if (req.method === "DELETE") {
                for (const slot of infoCache.keys()) if (slot.includes("|")) infoCache.delete(slot);
                sendJson(res, 200, { ok: true, signedIn: false }, { "Set-Cookie": Cookies.authSetCookies(req, "") });
                return;
            }
            const { header, count } = Cookies.toCookieHeader(await readBody(req));
            sendJson(res, 200, { ok: true, signedIn: true, count }, { "Set-Cookie": Cookies.authSetCookies(req, header) });
        } catch (err) {
            sendError(res, err, log, req);
        }
    }

    return async function ytHandler(req, res) {
        const url = new URL(req.url || "/", "http://localhost");
        const route = routeOf(url);
        if (route === "cookies") {
            await handleCookies(req, res);
            return;
        }
        if (req.method !== "GET" && req.method !== "HEAD") {
            sendJson(res, 405, { error: { code: "METHOD", message: "Use GET." } }, { Allow: "GET, HEAD" });
            return;
        }
        try {
            if (route === "status") {
                const list = getAllowlist();
                sendJson(res, 200, {
                    ok: true,
                    backend: adapter ? adapter.name : null,
                    version: adapter ? adapter.version : null,
                    videos: list.entries.length,
                    signedIn: Boolean(Cookies.readAuth(req)),
                    invalidEntries: list.errors,
                });
            } else if (route === "info") await handleInfo(req, url, res);
            else if (route === "stream") await handleStream(req, url, res);
            else if (route === "captions") await handleCaptions(req, url, res);
            else if (route === "search") sendJson(res, 200, { results: await discover("search", url.searchParams.get("q")) });
            else if (route === "suggest") sendJson(res, 200, { suggestions: await discover("suggest", url.searchParams.get("q")) });
            else sendJson(res, 404, { error: { code: "NO_ROUTE", message: "Unknown /api/yt route." } });
        } catch (err) {
            sendError(res, err, log, req);
        }
    };
}

module.exports = {
    createYtHandler,
    loadAllowlist,
    chooseAudioFormat,
    chooseVideoFormat,
    parseRange,
    mapYtError,
    YtRequestError,
    contentTypeOf,
    DEFAULT_MAX_CHUNK,
};
