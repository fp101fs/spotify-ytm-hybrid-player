/**
 * Item 16: YouTube music videos (any video; the app shows a notice about rights instead of enforcing a license).
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
    const API_BASE = "api/yt";
    // Shown next to the add box. A notice only: any video can be added.
    const RIGHTS_NOTICE =
        "Notice: only add videos you have the right to play. Public-domain and Creative Commons music is a safe choice.";

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
     * Checks `yt-allowlist.json`, the suggested videos shown under the add box. Each entry needs id, title
     * and artist; license and source (a link about the license) are optional and only shown as credits.
     * Returns `{ entries, errors }`; bad entries are left out of the suggestions.
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
            if (raw.source != null && raw.source !== "" && !isHttpUrl(raw.source)) {
                return errors.push(`${where} (${id}): source must be a link`);
            }
            seen.add(id);
            entries.push({ ...raw, id, title, artist, license: cleanText(raw.license, 80), source: raw.source ? String(raw.source) : "" });
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

    /**
     * Entry for a video that isn't in the suggestions, from saved details or `/api/yt/info`
     * (`{ title, channel, duration }`). Falls back to placeholders until the lookup arrives.
     */
    function entryFromInfo(id, info = {}) {
        const channel = cleanText(info.channel);
        return {
            id,
            title: cleanText(info.title) || `YouTube video ${id}`,
            artist: cleanText(info.artist) || channel || "YouTube",
            channel,
            duration: Number(info.duration) || 0,
            license: cleanText(info.license, 80),
            source: isHttpUrl(info.source) ? String(info.source) : "",
        };
    }

    /** A catalog track for one video entry; it plays through the same-origin proxy like any song. */
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
            album: cleanText(entry.album) || "YouTube",
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
            license: cleanText(entry.license, 80),
            licenseUrl: isHttpUrl(entry.licenseUrl) ? entry.licenseUrl : "",
            sourceUrl: isHttpUrl(entry.source) ? String(entry.source) : "",
            watchUrl: `https://www.youtube.com/watch?v=${id}`,
            channel: cleanText(entry.channel),
        };
    }

    function isYouTubeTrack(track) {
        return Boolean(track && track.source === "youtube" && isVideoId(track.youtubeId));
    }

    // Plain-language messages for the server's error codes (see api/_lib/yt-server.js mapYtError).
    const ERROR_MESSAGES = {
        INVALID_ID: "That doesn't look like a YouTube video link. Paste a watch, youtu.be, Shorts or music.youtube.com link.",
        BOT_CHECK:
            "YouTube asked this server to confirm it isn't a bot (“Sign in to confirm you're not a bot”). This happens on cloud hosts like Vercel. Add your YouTube cookies to fix it, or run the app on your own computer with npm start.",
        COOKIE_EXPIRED:
            "YouTube treated your cookies as signed out, so they were removed. This happens when the browser you exported from keeps using that sign-in. Export fresh ones from a private (Incognito) window, then close that window without signing out.",
        AGE_RESTRICTED: "YouTube has made this video age-restricted, so it can't be played without signing in.",
        REGION_BLOCKED: "This video isn't available in the server's country.",
        NOT_FOUND: "This video was removed from YouTube or made private.",
        RATE_LIMITED: "YouTube is limiting requests from this server right now. Wait a few minutes and try again.",
        UNAVAILABLE: "YouTube won't play this video here (members-only, Premium or not started yet).",
        NO_FORMAT: "YouTube didn't offer a playable audio or video stream for this video.",
        UPSTREAM: "Couldn't reach YouTube from the server. Check the connection and try again.",
        NO_SERVER:
            "YouTube videos need the app's small server, which isn't running here. Run npm start (it serves the app and /api), or deploy to Vercel.",
    };

    function describeYtError(code, fallback = "") {
        return ERROR_MESSAGES[code] || fallback || "Something went wrong playing this YouTube video.";
    }

    /** Whether adding YouTube sign-in cookies would fix this error. */
    function needsCookies(code) {
        return code === "BOT_CHECK" || code === "COOKIE_EXPIRED";
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
        RIGHTS_NOTICE,
        validateAllowlist,
        entryFromInfo,
        buildYouTubeTrack,
        isYouTubeTrack,
        streamUrl,
        thumbnailUrl,
        describeYtError,
        computeVideoSync,
        needsCookies,
        ERROR_MESSAGES,
    };
});
