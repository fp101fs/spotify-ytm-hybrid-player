"use strict";
/**
 * Auto-downloads: YouTube audio saved to disk as regular playable files, named
 * `Artist - Title [videoId].m4a`. The video ID in the name is the key, so an existing file is never fetched twice,
 * and /api/yt/stream plays a downloaded song straight from disk (instant start, works offline).
 *
 * Two limits come with each request (from Settings) and are checked against the real disk with statfs:
 *   maxBytes      the most the downloads folder may hold
 *   minFreeBytes  free space that must remain on the disk afterwards (never below MIN_FREE_FLOOR)
 * When a limit would be crossed the song is skipped; nothing is ever deleted automatically.
 *
 * Off on Vercel (read-only, throwaway disk). Only used by the local server (`npm start`).
 */
const fs = require("node:fs");
const fsp = fs.promises;
const path = require("node:path");
const { spawn } = require("node:child_process");

const GB = 1024 ** 3;
const DEFAULT_LIMITS = { maxBytes: 5 * GB, minFreeBytes: 10 * GB };
const MIN_FREE_FLOOR = 1 * GB; // a full disk breaks everything else on the machine; never go below this
const FILE_RE = /\[([A-Za-z0-9_-]{11})\]\.(m4a|webm|mp3|opus)$/i;
const ID_RE = /^[A-Za-z0-9_-]{11}$/;
const MIME = { ".m4a": "audio/mp4", ".webm": "audio/webm", ".mp3": "audio/mpeg", ".opus": "audio/ogg" };

/** Text safe in a file name on macOS, Windows and Linux. */
function safePart(value, max = 80) {
    return String(value == null ? "" : value)
        .replace(/[\u0000-\u001f\u007f/\\:*?"<>|]/g, " ")
        .replace(/\s+/g, " ")
        .replace(/^[\s.]+|[\s.]+$/g, "")
        .slice(0, max)
        .trim();
}

/** `Artist - Title [id].ext`. A title that already starts with the artist ("Artist - Song") isn't doubled. */
function fileNameFor({ id, artist, title, ext = ".m4a" }) {
    const a = safePart(artist);
    let t = safePart(title, 120);
    if (a && t.toLowerCase().startsWith(`${a.toLowerCase()} - `)) t = t.slice(a.length + 3).trim();
    const label = [a, t].filter(Boolean).join(" - ") || "YouTube";
    return `${label} [${id}]${ext}`;
}

/** `Artist - Title [id].m4a` → { id, artist, title } (or null for files that aren't downloads). */
function parseFileName(name) {
    const m = FILE_RE.exec(name);
    if (!m) return null;
    const label = name.slice(0, m.index).trim();
    const dash = label.indexOf(" - ");
    return {
        id: m[1],
        artist: dash > 0 ? label.slice(0, dash).trim() : "",
        title: dash > 0 ? label.slice(dash + 3).trim() : label,
    };
}

function clampLimits(input = {}) {
    const num = (v, d) => (v != null && v !== "" && Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : d);
    return {
        maxBytes: num(input.maxBytes, DEFAULT_LIMITS.maxBytes),
        minFreeBytes: Math.max(MIN_FREE_FLOOR, num(input.minFreeBytes, DEFAULT_LIMITS.minFreeBytes)),
    };
}

let ffmpegPromise = null;
function hasFfmpeg() {
    if (!ffmpegPromise) {
        ffmpegPromise = new Promise((resolve) => {
            try {
                const p = spawn("ffmpeg", ["-version"], { stdio: "ignore" });
                p.on("error", () => resolve(false));
                p.on("close", (code) => resolve(code === 0));
            } catch (_) {
                resolve(false);
            }
        });
    }
    return ffmpegPromise;
}

/** Rewrites YouTube's fragmented m4a as a normal one with artist/title tags. Best effort: false → keep the raw file. */
function remuxWithTags(input, output, { artist, title }) {
    return new Promise((resolve) => {
        const args = ["-v", "error", "-y", "-i", input, "-map", "0:a", "-c", "copy", "-map_metadata", "-1"];
        if (artist) args.push("-metadata", `artist=${artist}`);
        if (title) args.push("-metadata", `title=${title}`);
        args.push("-movflags", "+faststart", "-f", "mp4", output);
        const p = spawn("ffmpeg", args, { stdio: "ignore" });
        p.on("error", () => resolve(false));
        p.on("close", (code) => resolve(code === 0));
    });
}

/**
 * @param {object} options
 * @param {string} options.dir        folder for the files (created on first download)
 * @param {boolean} [options.enabled] false → every call answers "unavailable"
 * @param {boolean} [options.tag]     remux + tag with ffmpeg when it's installed (default true)
 * @param {Function} [options.statfs] injectable for tests: (dir) → { free, total }
 */
function createDownloads(options = {}) {
    const dir = options.dir;
    const enabled = options.enabled !== false && Boolean(dir);
    const tag = options.tag !== false;
    const index = new Map(); // id → { file, size, artist, title }
    const inflight = new Map(); // id → promise
    let chain = Promise.resolve(); // one download at a time, so the playing song keeps the bandwidth
    let ready = null;

    async function diskSpace() {
        if (options.statfs) return options.statfs(dir);
        try {
            const s = await fsp.statfs(fs.existsSync(dir) ? dir : path.dirname(dir));
            return { free: s.bavail * s.bsize, total: s.blocks * s.bsize };
        } catch (_) {
            return { free: null, total: null };
        }
    }

    function scan() {
        if (!ready) {
            ready = (async () => {
                index.clear();
                if (!enabled) return;
                let names = [];
                try {
                    names = await fsp.readdir(dir);
                } catch (_) {
                    return;
                }
                for (const name of names) {
                    if (name.endsWith(".part")) {
                        await fsp.rm(path.join(dir, name), { force: true }).catch(() => {}); // left by a crash
                        continue;
                    }
                    const parsed = parseFileName(name);
                    if (!parsed) continue;
                    try {
                        const st = await fsp.stat(path.join(dir, name));
                        if (st.isFile() && st.size > 0) index.set(parsed.id, { file: name, size: st.size, artist: parsed.artist, title: parsed.title });
                    } catch (_) {
                        /* removed meanwhile */
                    }
                }
            })();
        }
        return ready;
    }

    function usedBytes() {
        let n = 0;
        for (const v of index.values()) n += v.size;
        return n;
    }

    /** The downloaded file for `id` (full path + type), or null. Drops entries whose file was deleted by hand. */
    async function find(id) {
        await scan();
        const hit = index.get(id);
        if (!hit) return null;
        const file = path.join(dir, hit.file);
        try {
            const st = await fsp.stat(file);
            return { path: file, size: st.size, contentType: MIME[path.extname(file).toLowerCase()] || "audio/mp4" };
        } catch (_) {
            index.delete(id);
            return null;
        }
    }

    async function status() {
        if (!enabled) return { available: false };
        await scan();
        const disk = await diskSpace();
        return {
            available: true,
            usedBytes: usedBytes(),
            count: index.size,
            freeBytes: disk.free,
            totalBytes: disk.total,
            floorBytes: MIN_FREE_FLOOR,
            songs: Array.from(index, ([id, v]) => ({ id, artist: v.artist, title: v.title, size: v.size })),
        };
    }

    /** Why a file of `size` bytes can't be saved right now, or null when it fits. */
    async function checkSpace(size, limits) {
        if (usedBytes() + size > limits.maxBytes) return "LIMIT";
        const disk = await diskSpace();
        if (disk.free != null && disk.free - size < limits.minFreeBytes) return "DISK_FULL";
        return null;
    }

    /**
     * Saves one song. `openAudio()` → { stream, size, container } (bytes from YouTube).
     * Resolves { status: "exists" | "saved" | "skipped", reason?, song? }.
     */
    function download({ id, artist, title }, limitsInput, openAudio) {
        if (!enabled) return Promise.resolve({ status: "skipped", reason: "UNAVAILABLE" });
        if (!ID_RE.test(String(id))) return Promise.resolve({ status: "skipped", reason: "INVALID_ID" });
        if (inflight.has(id)) return inflight.get(id);
        const limits = clampLimits(limitsInput);
        const job = async () => {
            await scan();
            if (await find(id)) return { status: "exists", song: { id, ...index.get(id) } };
            const pre = await checkSpace(0, limits); // cheap check before asking YouTube
            if (pre) return { status: "skipped", reason: pre };
            const { stream, size, container } = await openAudio();
            const tooBig = size ? await checkSpace(size, limits) : null;
            if (tooBig) {
                stream.destroy();
                return { status: "skipped", reason: tooBig };
            }
            await fsp.mkdir(dir, { recursive: true });
            const ext = container === "webm" ? ".webm" : ".m4a";
            const part = path.join(dir, `.${id}.part`);
            const tagged = path.join(dir, `.${id}.tagged.part`);
            try {
                let written = 0;
                stream.on("data", (c) => (written += c.length));
                await new Promise((resolve, reject) => {
                    const out = fs.createWriteStream(part);
                    stream.on("error", reject);
                    out.on("error", reject);
                    out.on("finish", resolve);
                    stream.pipe(out);
                });
                if (!written || (size && written !== size)) throw new Error(`incomplete download (${written}/${size} bytes)`);
                let source = part;
                if (tag && ext === ".m4a" && (await hasFfmpeg()) && (await remuxWithTags(part, tagged, { artist, title }))) source = tagged;
                const name = fileNameFor({ id, artist, title, ext });
                await fsp.rename(source, path.join(dir, name));
                const st = await fsp.stat(path.join(dir, name));
                const song = { file: name, size: st.size, artist: safePart(artist), title: safePart(title, 120) };
                index.set(id, song);
                return { status: "saved", song: { id, ...song } };
            } finally {
                await fsp.rm(part, { force: true }).catch(() => {});
                await fsp.rm(tagged, { force: true }).catch(() => {});
            }
        };
        // One at a time: this job starts when the previous one has finished (or failed)
        const run = chain.then(job);
        chain = run.catch(() => {});
        inflight.set(id, run);
        run.finally(() => inflight.delete(id)).catch(() => {});
        return run;
    }

    return { enabled, dir, scan, find, status, download };
}

module.exports = { createDownloads, fileNameFor, parseFileName, clampLimits, DEFAULT_LIMITS, MIN_FREE_FLOOR, GB };
