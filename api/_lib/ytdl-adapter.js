"use strict";
/**
 * Item 16: the only file that knows about the YouTube library. To swap libraries, write another
 * adapter with the same three methods and pass it to `createYtHandler({ adapter })`.
 *
 *   getInfo(id, { signal, cookie })  → { id, title, channel, duration, thumbnails, formats, captions, expiresAt, raw }
 *   openStream(info, format, opts)   → Node Readable of bytes opts.start..opts.end (inclusive)
 *   getCaptions(info, lang)          → WebVTT text
 *   search(query, { limit })         → YouTube Music songs [{ id, title, artist, duration, thumbnail }]
 *   suggest(query)                   → autocomplete strings
 *   radio(id, { limit })             → the song's YouTube Music radio, same shape as search
 *
 * `formats` are plain objects: { itag, mimeType, container, hasAudio, hasVideo, audioCodec, videoCodec,
 * audioBitrate, bitrate, width, height, contentLength, isDrc, isLive, isHLS, raw }.
 */

const LIBRARY = "@distube/ytdl-core";

let modulePromise = null;
function loadLibrary() {
    // The library is ESM-only; a literal specifier keeps Vercel's file tracing able to find it.
    if (!modulePromise) modulePromise = import("@distube/ytdl-core");
    return modulePromise;
}

function libraryVersion() {
    try {
        return require("@distube/ytdl-core/package.json").version;
    } catch (_) {
        return "unknown";
    }
}

function normalizeFormat(f) {
    return {
        itag: f.itag,
        mimeType: f.mimeType || "",
        container: f.container || "",
        hasAudio: Boolean(f.hasAudio),
        hasVideo: Boolean(f.hasVideo),
        audioCodec: f.audioCodec || "",
        videoCodec: f.videoCodec || "",
        audioBitrate: Number(f.audioBitrate) || 0,
        bitrate: Number(f.bitrate) || 0,
        width: Number(f.width) || 0,
        height: Number(f.height) || 0,
        contentLength: Number(f.contentLength) || 0,
        isDrc: Boolean(f.isDrc),
        isLive: Boolean(f.isLive),
        isHLS: Boolean(f.isHLS),
        unusable: Boolean(f.isDrm || f.isOtf),
        raw: f,
    };
}

function cleanArtist(name) {
    return String(name || "").replace(/ - Topic$/, "").trim();
}

/** True when two artist credits ("A, B & C") name a common artist. */
function sharesArtist(a, b) {
    const split = (x) => String(x || "").toLowerCase().split(/\s*(?:,|&|\band\b|\bfeat\.?|\bx\b)\s*/).map((t) => t.trim()).filter(Boolean);
    const left = new Set(split(a));
    return split(b).some((t) => left.has(t));
}

/** Library VideoSummary list → [{ id, title, artist, duration, thumbnail }], leaving out live/upcoming entries. */
function summarizeSongs(list) {
    return (list || [])
        .filter((v) => v && v.id && !v.isLive && !v.isUpcoming)
        .map((v) => {
            const thumbs = (v.thumbnails || []).slice().sort((a, b) => (a.width || 0) - (b.width || 0));
            const thumb = thumbs.find((t) => (t.width || 0) >= 96) || thumbs[thumbs.length - 1];
            return {
                id: v.id,
                title: v.title || "",
                artist: (v.author && v.author.name) || "",
                duration: Number(v.lengthSeconds) || 0,
                thumbnail: thumb ? thumb.url : "",
            };
        });
}

function createYtdlAdapter(options = {}) {
    // One instance per network identity: the anonymous one, plus one per signed-in cookie (few, so a small cap).
    const instances = new Map(); // cookie header ("" = signed out) → Ytdl
    async function ytdl(cookie = "") {
        const lib = await loadLibrary();
        let instance = instances.get(cookie);
        if (!instance) {
            const opts = { timeoutMs: options.timeoutMs || 20000 };
            if (cookie) opts.cookie = cookie;
            instance = new lib.Ytdl(opts);
            instances.set(cookie, instance);
            if (instances.size > 5) {
                const oldest = [...instances.keys()].find((k) => k !== "" && k !== cookie);
                if (oldest !== undefined) instances.delete(oldest);
            }
        }
        return { lib, instance };
    }

    return {
        name: LIBRARY,
        version: libraryVersion(),

        async getInfo(id, { signal, cookie } = {}) {
            const { instance: y } = await ytdl(cookie || "");
            const info = await y.getInfo(id, { signal });
            const d = info.videoDetails || {};
            return {
                id: d.id || id,
                title: d.title || "",
                channel: (d.author && d.author.name) || "",
                duration: Number(d.lengthSeconds) || 0,
                isLive: Boolean(d.isLive),
                thumbnails: (d.thumbnails || []).map((t) => ({ url: t.url, width: t.width, height: t.height })),
                formats: (info.formats || []).map(normalizeFormat),
                captions: (info.captionTracks || []).map((c) => ({
                    lang: c.languageCode,
                    name: String(c.name || c.languageCode),
                    auto: Boolean(c.isAutoGenerated),
                    isDefault: Boolean(c.isDefault),
                })),
                expiresAt: Number(info.expiresAt) || Date.now() + 5 * 60 * 1000,
                raw: info,
                cookie: cookie || "",
            };
        },

        async openStream(info, format, { start, end, signal } = {}) {
            const { instance: y } = await ytdl(info.cookie || "");
            const range = {};
            if (Number.isFinite(start)) range.start = start;
            if (Number.isFinite(end)) range.end = end;
            return y.open(info.raw, format.raw).read({ range, signal });
        },

        /** YouTube Music songs for `query` → [{ id, title, artist, duration, thumbnail }]. */
        async search(query, { signal, limit = 12 } = {}) {
            const { lib, instance: y } = await ytdl();
            const type = lib.SearchType ? lib.SearchType.Song : "song";
            const list = await y.search(query, { type, limit, signal });
            return summarizeSongs(list);
        },

        /**
         * The song's YouTube Music radio (no player lookup, so no bot check), without the song itself.
         * From some server IPs (Vercel) YouTube Music answers with a generic radio unrelated to the song; when none
         * of it shares the song's artist, the mix is built from the artist's songs plus related "- Topic" songs.
         */
        async radio(id, { signal, limit = 50, force } = {}) {
            const { lib, instance: y } = await ytdl();
            const [song, music] = await Promise.all([
                y.getSong(id, { signal }).catch(() => null),
                y.getRelated(id, { music: true, signal }).then(summarizeSongs).catch(() => []),
            ]);
            const artist = cleanArtist(song && song.author && song.author.name);
            const radio = music.filter((v) => v.id !== id);
            if (force !== "fallback" && radio.length && (!artist || radio.some((v) => sharesArtist(v.artist, artist)))) {
                return radio.slice(0, limit);
            }
            if (!artist) return radio.slice(0, limit);
            const type = lib.SearchType ? lib.SearchType.Song : "song";
            const [byArtist, related] = await Promise.all([
                y.search(artist, { type, limit: 20, signal }).then(summarizeSongs).catch(() => []),
                y.getRelated(id, { signal }).then(summarizeSongs).catch(() => []),
            ]);
            // Plain related videos include essays and full albums: keep auto-generated "Artist - Topic" songs only
            const songs = related
                .filter((v) => / - Topic$/.test(v.artist) && v.duration >= 60 && v.duration <= 600)
                .map((v) => ({ ...v, artist: cleanArtist(v.artist) }));
            const out = [];
            const seen = new Set([id]);
            for (let i = 0; out.length < limit && (i < byArtist.length || i < songs.length); i++) {
                for (const v of [byArtist[i], songs[i]]) {
                    if (v && !seen.has(v.id)) {
                        seen.add(v.id);
                        out.push(v);
                    }
                }
            }
            return out.length ? out.slice(0, limit) : radio.slice(0, limit);
        },

        /** YouTube Music autocomplete completions for `query`. */
        async suggest(query, { signal } = {}) {
            const { instance: y } = await ytdl();
            return (await y.getSuggestions(query, { music: true, signal })).slice(0, 8);
        },

        async getCaptions(info, lang) {
            const { lib, instance: y } = await ytdl(info.cookie || "");
            return y.getCaptions(info.raw, { lang, format: lib.CaptionFormat ? lib.CaptionFormat.Vtt : undefined });
        },
    };
}

module.exports = { createYtdlAdapter, LIBRARY };
