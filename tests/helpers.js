// Shared fixtures for the import tests (items 13 and 14): synthetic MP3s, slice()-able files, an in-memory
// storage store and a minimal DOM sandbox that runs the real browser scripts.
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT_DIR = path.resolve(__dirname, "..");
const Storage = require(path.join(ROOT_DIR, "storage.js"));
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, "tests", "fixtures", "sample-tracks.json"), "utf8"));
const CATALOG = manifest.tracks;

const ascii = (str) => Array.from(Buffer.from(str, "latin1"));
const syncSafe = (n) => [(n >> 21) & 0x7f, (n >> 14) & 0x7f, (n >> 7) & 0x7f, n & 0x7f];
const be32 = (n) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
const le32 = (n) => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];
const le16 = (n) => [n & 0xff, (n >>> 8) & 0xff];

function textFrame(id, text) {
    const body = [0, ...ascii(text)];
    return [...ascii(id), ...be32(body.length), 0, 0, ...body];
}

/** ID3v2.3 + one CBR frame header + `audioBytes` of silence (+ optional ID3v1 tail). */
function buildMp3({ title = "", artist = "", album = "", audioBytes = 4000, v1 = null } = {}) {
    let frames = [];
    if (title) frames = frames.concat(textFrame("TIT2", title));
    if (artist) frames = frames.concat(textFrame("TPE1", artist));
    if (album) frames = frames.concat(textFrame("TALB", album));
    const tagBody = [...frames, ...new Array(16).fill(0)];
    const out = new Uint8Array(10 + tagBody.length + audioBytes + (v1 ? 128 : 0));
    out.set([...ascii("ID3"), 3, 0, 0, ...syncSafe(tagBody.length), ...tagBody], 0);
    const a = 10 + tagBody.length;
    out.set([0xff, 0xfb, 0x90, 0x00], a); // MPEG-1 L3 128 kbps 44.1 kHz
    if (v1) {
        const t = out.length - 128;
        out.set(ascii("TAG"), t);
        out.set(ascii(v1.title || ""), t + 3);
        out.set(ascii(v1.artist || ""), t + 33);
    }
    return out;
}

/** Blob-like file with slice() that counts how many bytes were actually read. */
function sliceableFile(name, bytes, extra = {}) {
    const counter = extra.counter || { bytes: 0, reads: 0 };
    const make = (buf, start, end) => ({
        size: end - start,
        slice(s = 0, e = end - start) {
            return make(buf, start + s, start + Math.min(e, end - start));
        },
        async arrayBuffer() {
            if (extra.gate) await extra.gate();
            counter.bytes += end - start;
            counter.reads++;
            return buf.buffer.slice(buf.byteOffset + start, buf.byteOffset + end);
        },
    });
    const root = make(bytes, 0, bytes.length);
    return Object.assign(root, {
        name,
        type: extra.type || "",
        lastModified: Date.UTC(2024, 0, 1),
        webkitRelativePath: extra.webkitRelativePath || "",
        counter,
    });
}

function memoryStore() {
    let mem = {};
    return Storage.createStorageStore({
        storageKey: `instant-${Math.random()}`,
        localStorage: {
            getItem: (k) => (k in mem ? mem[k] : null),
            setItem: (k, v) => (mem[k] = String(v)),
            removeItem: (k) => delete mem[k],
        },
        indexedDB: null,
    });
}

const noProbe = async () => 0;

function createShellSandbox(options = {}) {
    const files = ["storage.js", "library.js", "recommender.js", "queue.js", "player.js", "metadata-lookup.js", "youtube.js", "script.js"].map((f) =>
        fs.readFileSync(path.join(ROOT_DIR, f), "utf8")
    );
    const elementsById = new Map();
    const sandbox = {};
    const makeEl = (id = "", tagName = "DIV") => {
        const listeners = new Map();
        const el = {
            id,
            tagName,
            hidden: [
                "detail-view", "search-view", "playlist-picker-dialog", "playlist-edit-dialog", "drop-overlay", "library-toast",
                "add-music-menu", "add-music-backdrop", "import-progress", "import-progress-pill", "home-add-music-card",
                "import-details-dialog", "add-music-playlist-item", "add-music-folder-note",
                "local-sources", "add-music-source-items",
                "settings-dialog", "match-review-dialog", "lookup-progress", "detail-lookup-btn", "detail-review-matches-btn",
                "settings-lookup-note", "match-review-empty", "match-review-overwrite-wrap",
                "yt-library-panel", "yt-video-panel", "playbar-video-btn", "yt-available", "yt-video-cc-btn",
            ].includes(id),
            textContent: "",
            innerHTML: "",
            value: "",
            src: "",
            dataset: {},
            children: [],
            style: { setProperty() {} },
            attributes: new Map(),
            classList: {
                _set: new Set(),
                toggle(c, f) {
                    const n = typeof f === "boolean" ? f : !this._set.has(c);
                    if (n) this._set.add(c);
                    else this._set.delete(c);
                    return n;
                },
                contains(c) {
                    return this._set.has(c);
                },
                add(c) {
                    this._set.add(c);
                },
                remove(c) {
                    this._set.delete(c);
                },
            },
            setAttribute(k, v) {
                this.attributes.set(k, String(v));
            },
            getAttribute(k) {
                return this.attributes.get(k);
            },
            removeAttribute(k) {
                this.attributes.delete(k);
            },
            focus() {
                sandbox.document.activeElement = this;
            },
            click() {
                this.clicked = (this.clicked || 0) + 1;
                this.trigger("click");
            },
            addEventListener(type, fn) {
                if (!listeners.has(type)) listeners.set(type, []);
                listeners.get(type).push(fn);
            },
            trigger(type, patch = {}) {
                for (const fn of listeners.get(type) || []) {
                    fn({ preventDefault() {}, stopPropagation() {}, currentTarget: this, target: this, ...patch });
                }
            },
            replaceChildren(...nodes) {
                this.children = nodes;
            },
            append(node) {
                this.children.push(node);
            },
            contains(node) {
                return node === this || this.children.includes(node);
            },
            querySelector() {
                return makeEl();
            },
            querySelectorAll() {
                return [];
            },
            getElementsByTagName() {
                return [makeEl()];
            },
        };
        return el;
    };
    const docListeners = new Map();
    Object.assign(sandbox, {
        console,
        setTimeout: () => 0,
        clearTimeout: () => {},
        URL: Object.assign(class extends URL {}, { createObjectURL: (f) => `blob:sandbox/${f && f.name}`, revokeObjectURL() {} }),
        URLSearchParams,
        navigator: { userAgent: options.userAgent || "Mozilla/5.0 (Macintosh) Chrome/130", maxTouchPoints: 0 },
        Audio: function () {
            this.paused = true;
            this.volume = 1;
            this.currentTime = 0;
            this.duration = 200;
            this.play = () => Promise.resolve();
            this.pause = () => {};
            this.addEventListener = () => {};
        },
        fetch: async () => ({ ok: true, json: async () => manifest }),
        document: {
            readyState: "loading",
            activeElement: null,
            body: makeEl("body"),
            addEventListener(type, fn) {
                if (!docListeners.has(type)) docListeners.set(type, []);
                docListeners.get(type).push(fn);
            },
            dispatch(type, ev) {
                for (const fn of docListeners.get(type) || []) fn(ev);
            },
            startViewTransition(cb) {
                cb();
                return { finished: Promise.resolve() };
            },
            getElementById(id) {
                if (!elementsById.has(id)) elementsById.set(id, makeEl(id));
                return elementsById.get(id);
            },
            getElementsByClassName(cls) {
                return [this.getElementById(`class:${cls}`)];
            },
            querySelector(sel) {
                return sel.startsWith("#") ? this.getElementById(sel.slice(1)) : makeEl(sel);
            },
            querySelectorAll() {
                return [];
            },
            createElement(tag) {
                return makeEl("", String(tag || "DIV").toUpperCase());
            },
        },
    });
    sandbox.window = sandbox;
    sandbox.globalThis = sandbox;
    if (options.showDirectoryPicker) sandbox.showDirectoryPicker = options.showDirectoryPicker;
    for (const src of files) vm.runInNewContext(src, sandbox);
    const el = (id) => sandbox.document.getElementById(id);

    // Menu items for the Add Music menu
    const items = ["add-music-folder-item", "add-music-files-item", "add-music-playlist-item"].map((id) => {
        const item = el(id);
        item.dataset.addMusic = id.replace("add-music-", "").replace("-item", "");
        return item;
    });
    el("add-music-menu").querySelectorAll = () => items;
    el("import-folder-input").webkitdirectory = false;

    const shell = sandbox.SpotTubeShell;
    shell.setState({ songs: CATALOG.slice(), currentTrackIndex: 0 });
    shell.initLibraryImportControls();
    return { sandbox, shell, el, items };
}

function folderFiles(n, folder = "Summer Mix", gate = undefined) {
    return Array.from({ length: n }, (_, i) => ({
        file: sliceableFile(`Band ${i} - Track ${i}.mp3`, buildMp3({ title: `Real Title ${i}`, artist: `Real Band ${i}` }), { gate }),
        relativePath: `${folder}/Band ${i} - Track ${i}.mp3`,
    }));
}

module.exports = { ascii, syncSafe, be32, le32, le16, textFrame, buildMp3, sliceableFile, memoryStore, noProbe, createShellSandbox, folderFiles, CATALOG, manifest, ROOT_DIR };
