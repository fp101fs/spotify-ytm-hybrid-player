/**
 * Auto-downloads (browser side). Once a YouTube song starts playing, it and the next song in the queue are saved
 * to disk by the local server (`api/_lib/downloads.js`), so they replay instantly and work offline.
 *
 * No DOM or app state of its own: script.js passes in how to find the current/next track and what to do when a
 * song is saved. `attach(document)` listens for any <audio> starting to play.
 */
(function (root, factory) {
    const api = factory();
    if (typeof module === "object" && module.exports) module.exports = api;
    if (root) root.SpotTubeDownloads = api;
})(typeof globalThis !== "undefined" ? globalThis : typeof window !== "undefined" ? window : this, function () {
    "use strict";

    const GB = 1024 ** 3;
    const DEFAULTS = Object.freeze({ enabled: true, maxGB: 5, minFreeGB: 10 });
    const LIMITS = Object.freeze({ maxGB: [1, 500], minFreeGB: [1, 500] });

    function clampNum(value, [lo, hi], fallback) {
        const n = Number(value);
        return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : fallback;
    }

    /** Saved settings (or nothing) → { enabled, maxGB, minFreeGB } within sane bounds. */
    function normalizeSettings(raw) {
        const s = raw && typeof raw === "object" ? raw : {};
        return {
            enabled: s.enabled !== false,
            maxGB: clampNum(s.maxGB, LIMITS.maxGB, DEFAULTS.maxGB),
            minFreeGB: clampNum(s.minFreeGB, LIMITS.minFreeGB, DEFAULTS.minFreeGB),
        };
    }

    function formatBytes(bytes) {
        const n = Number(bytes);
        if (!Number.isFinite(n) || n < 0) return "—";
        if (n >= GB) return `${(n / GB).toFixed(n >= 10 * GB ? 0 : 1)} GB`;
        if (n >= 1024 ** 2) return `${Math.round(n / 1024 ** 2)} MB`;
        return `${Math.max(0, Math.round(n / 1024))} KB`;
    }

    /**
     * @param {object} deps
     * @param {Function} deps.getCurrentTrack   () → track
     * @param {Function} deps.getNextTrack      () → track (first in Up Next)
     * @param {Function} deps.getSettings       () → { enabled, maxGB, minFreeGB }
     * @param {Function} [deps.onSaved]         (track, song) after a new file is written (or found already there)
     * @param {Function} [deps.onSkipped]       (track, reason) for "LIMIT" | "DISK_FULL"
     * @param {Function} [deps.fetch]
     * @param {number}   [deps.delayMs]         wait after playback starts, so the song's own buffering goes first
     */
    function createAutoDownloader(deps = {}) {
        const doFetch = deps.fetch || (typeof fetch === "function" ? fetch.bind(globalThis) : null);
        const delayMs = deps.delayMs == null ? 3000 : deps.delayMs;
        const saved = new Set(); // video IDs on disk
        const pending = new Map(); // video ID → promise
        let available = null; // null = not asked yet
        let lastStatus = null;
        let timer = null;

        const idOf = (track) =>
            track && track.source === "youtube" && /^[A-Za-z0-9_-]{11}$/.test(track.youtubeId || "") ? track.youtubeId : null;

        /** Asks the server what's on disk. Resolves the status ({ available:false } without the local server). */
        async function refresh() {
            try {
                const res = await doFetch("./api/yt/downloads", { cache: "no-store" });
                const type = (res.headers && res.headers.get && res.headers.get("content-type")) || "";
                lastStatus = res.ok && /json/.test(type) ? await res.json() : { available: false };
            } catch (_) {
                lastStatus = { available: false };
            }
            available = lastStatus.available === true;
            for (const song of lastStatus.songs || []) saved.add(song.id);
            return lastStatus;
        }

        /** Saves one track's audio (no-op for non-YouTube tracks or ones already saved/in progress). */
        function request(track) {
            const id = idOf(track);
            const settings = normalizeSettings(deps.getSettings && deps.getSettings());
            if (!id || !doFetch || !settings.enabled || available === false) return Promise.resolve(null);
            if (saved.has(id)) return Promise.resolve({ status: "exists" });
            if (pending.has(id)) return pending.get(id);
            const params = new URLSearchParams({
                id,
                artist: track.primaryArtist || track.artistDisplay || track.channel || "",
                title: track.title || "",
                maxBytes: String(settings.maxGB * GB),
                minFreeBytes: String(settings.minFreeGB * GB),
            });
            const job = (async () => {
                if (available === null) await refresh();
                if (!available) return null;
                if (saved.has(id)) return { status: "exists" };
                const res = await doFetch(`./api/yt/download?${params}`, { method: "POST" });
                const body = await res.json().catch(() => null);
                if (!res.ok || !body) return null;
                if (body.status === "saved" || body.status === "exists") {
                    saved.add(id);
                    if (deps.onSaved) deps.onSaved(track, body.song || null);
                } else if (body.status === "skipped" && deps.onSkipped && body.reason !== "UNAVAILABLE") {
                    deps.onSkipped(track, body.reason);
                }
                return body;
            })()
                .catch(() => null)
                .finally(() => pending.delete(id));
            pending.set(id, job);
            return job;
        }

        /** The playing song first, then the next one, in that order. */
        async function downloadNowAndNext() {
            const current = deps.getCurrentTrack && deps.getCurrentTrack();
            await request(current);
            const next = deps.getNextTrack && deps.getNextTrack();
            if (next && next !== current) await request(next);
        }

        function onPlaying() {
            if (timer) clearTimeout(timer);
            timer = setTimeout(() => {
                timer = null;
                downloadNowAndNext();
            }, delayMs);
        }

        /** Media events don't bubble, so listen in the capture phase for every deck at once. */
        function attach(target) {
            if (target && typeof target.addEventListener === "function") target.addEventListener("playing", onPlaying, true);
        }

        return {
            attach,
            refresh,
            request,
            downloadNowAndNext,
            isDownloaded: (id) => saved.has(id),
            getStatus: () => lastStatus,
        };
    }

    return { createAutoDownloader, normalizeSettings, formatBytes, DEFAULTS, LIMITS, GB };
});
