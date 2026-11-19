/**
 * Item 16: YouTube public-domain / Creative Commons music videos.
 *
 * Shared by the browser (window.SpotTubeYouTube) and the Node server (`api/_lib/yt-server.js`):
 * link/ID parsing, allowlist validation, catalog tracks, error wording and video/audio sync.
 * Nothing here talks to YouTube; the server does that through `api/_lib/ytdl-adapter.js`.
 */
(function (root, factory) {
    const api = factory();
    if (typeof module === "object" && module.exports) module.exports = api;
    if (root) root.SpotTubeYouTube = api;
})(typeof globalThis !== "undefined" ? globalThis : typeof window !== "undefined" ? window : this, function () {
    "use strict";

    const ID_RE = /^[A-Za-z0-9_-]{11}$/;
    const YT_HOSTS = new Set([
        "youtube.com",
        "www.youtube.com",
        "m.youtube.com",
        "music.youtube.com",
        "youtube-nocookie.com",
        "www.youtube-nocookie.com",
    ]);
    // "Public domain", "CC0 (public domain)", "CC BY 4.0", "CC BY-SA 3.0"… The NC/ND variants don't allow this use.
    const LICENSE_RE = /^(public domain|cc0\b|cc by(?:-sa)?\b)/i;
    const NOT_OK_LICENSE_RE = /\b(nc|nd)\b/i;
    const API_BASE = "api/yt";

    function isVideoId(value) {
        return typeof value === "string" && ID_RE.test(value);
    }

    /**
     * The 11-character video ID from a bare ID or a watch, youtu.be, Shorts, embed, live or
     * music.youtube.com link. Anything else (playlists, channels, other sites) → null.
     */
    function parseYouTubeId(input) {
        if (typeof input !== "string") return null;
        const text = input.trim();
        if (!text) return null;
        if (isVideoId(text)) return text;
        let url;
        try {
            url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`);
        } catch (_) {
            return null;
        }
        if (!/^https?:$/.test(url.protocol)) return null;
        const host = url.hostname.toLowerCase();
        let candidate = null;
        if (host === "youtu.be" || host === "www.youtu.be") {
            candidate = url.pathname.split("/")[1] || null;
        } else if (YT_HOSTS.has(host)) {
            const parts = url.pathname.split("/").filter(Boolean);
            if (parts[0] === "watch" || url.pathname === "/watch") candidate = url.searchParams.get("v");
            else if (["shorts", "embed", "live", "v", "e"].includes(parts[0])) candidate = parts[1] || null;
            else if (!parts.length) candidate = url.searchParams.get("v");
        }
        return isVideoId(candidate) ? candidate : null;
    }

    function isAllowedLicense(license) {
        const text = String(license || "").trim();
        return LICENSE_RE.test(text) && !NOT_OK_LICENSE_RE.test(text.replace(/^cc0\b/i, ""));
    }

    function cleanText(value, max = 200) {
        return String(value == null ? "" : value).replace(/\s+/g, " ").trim().slice(0, max);
    }

    function isHttpUrl(value) {
        try {
            return /^https?:$/.test(new URL(String(value)).protocol);
        } catch (_) {
            return false;
        }
    }

    /**
     * Checks `yt-allowlist.json`. Each entry needs id, title, artist, a license that allows this use
     * ("Public domain", "CC0…", "CC BY…" / "CC BY-SA…") and a source link that proves it.
     * Returns `{ entries, errors }`; bad entries are left out, never served.
     */
    function validateAllowlist(json) {
        const list = Array.isArray(json) ? json : json && Array.isArray(json.videos) ? json.videos : [];
        const entries = [];
        const errors = [];
        const seen = new Set();
        list.forEach((raw, i) => {
            const where = `entry ${i + 1}`;
            if (!raw || typeof raw !== "object") return errors.push(`${where}: not an object`);
            const id = typeof raw.id === "string" ? raw.id.trim() : "";
            if (!isVideoId(id)) return errors.push(`${where}: "${raw.id}" is not an 11-character video ID`);
            if (seen.has(id)) return errors.push(`${where}: ${id} is listed twice`);
            const title = cleanText(raw.title);
            const artist = cleanText(raw.artist);
            if (!title || !artist) return errors.push(`${where} (${id}): needs a title and an artist`);
            if (!isAllowedLicense(raw.license)) {
                return errors.push(`${where} (${id}): license "${raw.license || ""}" must be Public domain, CC0 or CC BY`);
            }
            if (!isHttpUrl(raw.source)) return errors.push(`${where} (${id}): needs a source link that shows the license`);
            seen.add(id);
            entries.push({ ...raw, id, title, artist, license: cleanText(raw.license, 80), source: String(raw.source) });
        });
        return { entries, errors };
    }

    function formatDuration(seconds) {
        const s = Math.max(0, Math.round(Number(seconds) || 0));
        return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
    }

    function clamp01(value, fallback) {
        const n = Number(value);
        return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : fallback;
    }

    function streamUrl(id, kind = "audio") {
        return `${API_BASE}/stream?id=${encodeURIComponent(id)}&kind=${kind === "video" ? "video" : "audio"}`;
    }

    function thumbnailUrl(id) {
        return `https://i.ytimg.com/vi/${encodeURIComponent(id)}/hqdefault.jpg`;
    }

    /** A catalog track for one allowlist entry; it plays through the same-origin proxy like any song. */
    function buildYouTubeTrack(entry) {
        const id = entry.id;
        const artists = Array.isArray(entry.artists) && entry.artists.length
            ? entry.artists.map((a) => cleanText(a)).filter(Boolean)
            : [entry.artist];
        const duration = Math.max(0, Math.round(Number(entry.duration) || 0));
        const moods = Array.isArray(entry.moods) && entry.moods.length ? entry.moods.slice(0, 6) : ["Chill"];
        return {
            id: `yt-${id}`,
            source: "youtube",
            youtubeId: id,
            title: entry.title,
            primaryArtist: artists[0],
            artists,
            featuredArtists: artists.slice(1),
            artistDisplay: artists.join(", "),
            album: cleanText(entry.album) || "YouTube · Public-domain videos",
            year: Number.isFinite(Number(entry.year)) ? Number(entry.year) : null,
            duration,
            durationFormatted: formatDuration(duration),
            audioUrl: streamUrl(id, "audio"),
            videoUrl: streamUrl(id, "video"),
            coverUrl: thumbnailUrl(id),
            genre: cleanText(entry.genre) || "Instrumental",
            language: cleanText(entry.language) || "Instrumental",
            moods,
            bpm: Number(entry.bpm) || 100,
            energy: clamp01(entry.energy, 0.5),
            valence: clamp01(entry.valence, 0.55),
            danceability: clamp01(entry.danceability, 0.45),
            acousticness: clamp01(entry.acousticness, 0.6),
            popularity: clamp01(entry.popularity, 0.4),
            license: entry.license,
            licenseUrl: isHttpUrl(entry.licenseUrl) ? entry.licenseUrl : "",
            sourceUrl: entry.source,
            watchUrl: `https://www.youtube.com/watch?v=${id}`,
            channel: cleanText(entry.channel),
        };
    }

    function isYouTubeTrack(track) {
        return Boolean(track && track.source === "youtube" && isVideoId(track.youtubeId));
    }

    /** Privacy-friendly embed for the watch-only fallback (its audio can't go through the crossfade). */
    function buildEmbedUrl(id, startSeconds = 0, options = {}) {
        const params = new URLSearchParams({ rel: "0", modestbranding: "1", playsinline: "1" });
        const start = Math.floor(Number(startSeconds) || 0);
        if (start > 0) params.set("start", String(start));
        if (options.autoplay) params.set("autoplay", "1");
        if (options.captions) params.set("cc_load_policy", "1");
        if (options.mute) params.set("mute", "1");
        return `https://www.youtube-nocookie.com/embed/${encodeURIComponent(id)}?${params}`;
    }

    // Plain-language messages for the server's error codes (see api/_lib/yt-server.js mapYtError).
    const ERROR_MESSAGES = {
        NOT_ALLOWED:
            "That video isn't on this site's public-domain list, so it can't be played here. To add it, put its ID, title, artist, license (Public domain, CC0 or CC BY) and a link that shows the license in yt-allowlist.json, then reload or redeploy.",
        INVALID_ID: "That doesn't look like a YouTube video link. Paste a watch, youtu.be, Shorts or music.youtube.com link.",
        BOT_CHECK:
            "YouTube asked this server to confirm it isn't a bot (“Sign in to confirm you're not a bot”). This happens most on cloud hosts. Try again later, run the app on your own computer with npm start, or watch it in YouTube's player.",
        AGE_RESTRICTED: "YouTube has made this video age-restricted, so it can't be played without signing in.",
        REGION_BLOCKED: "This video isn't available in the server's country.",
        NOT_FOUND: "This video was removed from YouTube or made private.",
        RATE_LIMITED: "YouTube is limiting requests from this server right now. Wait a few minutes and try again.",
        UNAVAILABLE: "YouTube won't play this video here (members-only, Premium or not started yet).",
        NO_FORMAT: "YouTube didn't offer a playable audio or video stream for this video.",
        UPSTREAM: "Couldn't reach YouTube from the server. Check the connection and try again.",
        NO_SERVER:
            "YouTube videos need the app's small server, which isn't running here. Run npm start (it serves the app and /api), or deploy to Vercel. Until then videos open in YouTube's own player.",
    };

    function describeYtError(code, fallback = "") {
        return ERROR_MESSAGES[code] || fallback || "Something went wrong playing this YouTube video.";
    }

    /** Whether the code means "watch it with YouTube's own player instead" is worth offering. */
    function canFallBackToEmbed(code) {
        return ["BOT_CHECK", "RATE_LIMITED", "UPSTREAM", "NO_FORMAT", "NO_SERVER", "REGION_BLOCKED"].includes(code);
    }

    /**
     * Video follows the audio deck. Returns what to do to the muted <video>:
     * `{ seek: number|null, play: bool, pause: bool }`. Small drift is left alone to avoid stutter.
     */
    function computeVideoSync(state, threshold = 0.35) {
        const audioTime = Number(state && state.audioTime) || 0;
        const videoTime = Number(state && state.videoTime) || 0;
        const audioPaused = Boolean(state && state.audioPaused);
        const videoPaused = Boolean(state && state.videoPaused);
        const drift = Math.abs(audioTime - videoTime);
        return {
            seek: drift > threshold ? audioTime : null,
            play: !audioPaused && videoPaused,
            pause: audioPaused && !videoPaused,
            drift,
        };
    }

    return {
        API_BASE,
        isVideoId,
        parseYouTubeId,
        isAllowedLicense,
        validateAllowlist,
        buildYouTubeTrack,
        isYouTubeTrack,
        streamUrl,
        thumbnailUrl,
        buildEmbedUrl,
        describeYtError,
        canFallBackToEmbed,
        computeVideoSync,
        ERROR_MESSAGES,
    };
});
