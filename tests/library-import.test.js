const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT_DIR = path.resolve(__dirname, "..");
const Library = require(path.join(ROOT_DIR, "library.js"));
const Storage = require(path.join(ROOT_DIR, "storage.js"));
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, "tracks.json"), "utf8"));
const CATALOG = manifest.tracks;

// ---------- Synthetic audio file builders ----------

function syncSafe(n) {
    return [(n >> 21) & 0x7f, (n >> 14) & 0x7f, (n >> 7) & 0x7f, n & 0x7f];
}

function be32(n) {
    return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
}

function le32(n) {
    return [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];
}

function le16(n) {
    return [n & 0xff, (n >>> 8) & 0xff];
}

function ascii(str) {
    return Array.from(Buffer.from(str, "latin1"));
}

function id3TextFrame(id, text, { major = 3, encoding = 0 } = {}) {
    const payload = encoding === 3 ? Array.from(Buffer.from(text, "utf8")) : ascii(text);
    const body = [encoding, ...payload];
    const size = major === 4 ? syncSafe(body.length) : be32(body.length);
    return [...ascii(id), ...size, 0, 0, ...body];
}

const FAKE_JPEG = [0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5, 6, 7, 8, 0xff, 0xd9];

function buildMp3({ title, artist, album, year, genre, withCover = false, major = 3, encoding = 0, audioBytes = 16000 } = {}) {
    let frames = [];
    if (title) frames = frames.concat(id3TextFrame("TIT2", title, { major, encoding }));
    if (artist) frames = frames.concat(id3TextFrame("TPE1", artist, { major, encoding }));
    if (album) frames = frames.concat(id3TextFrame("TALB", album, { major, encoding }));
    if (year) frames = frames.concat(id3TextFrame(major === 4 ? "TDRC" : "TYER", year, { major, encoding }));
    if (genre) frames = frames.concat(id3TextFrame("TCON", genre, { major, encoding }));
    if (withCover) {
        const body = [0, ...ascii("image/jpeg"), 0, 3, ...ascii("cover"), 0, ...FAKE_JPEG];
        frames = frames.concat([...ascii("APIC"), ...(major === 4 ? syncSafe(body.length) : be32(body.length)), 0, 0, ...body]);
    }
    const padding = new Array(32).fill(0);
    const tagBody = [...frames, ...padding];
    const header = [...ascii("ID3"), major, 0, 0, ...syncSafe(tagBody.length)];
    // MPEG-1 Layer III, 128 kbps, 44.1 kHz, stereo frame header followed by zero audio payload
    const audio = new Array(audioBytes).fill(0);
    audio[0] = 0xff;
    audio[1] = 0xfb;
    audio[2] = 0x90;
    audio[3] = 0x00;
    return Uint8Array.from([...header, ...tagBody, ...audio]);
}

function buildFlac({ sampleRate = 44100, seconds = 10, comments = {}, withCover = false } = {}) {
    const totalSamples = sampleRate * seconds;
    const streamInfo = new Array(34).fill(0);
    streamInfo[10] = (sampleRate >> 12) & 0xff;
    streamInfo[11] = (sampleRate >> 4) & 0xff;
    streamInfo[12] = ((sampleRate & 0x0f) << 4) | (1 << 1); // channels/bps bits (irrelevant)
    streamInfo[13] = 0;
    streamInfo.splice(14, 4, ...be32(totalSamples));

    const vendor = ascii("test-vendor");
    const entries = Object.entries(comments).map(([k, v]) => Array.from(Buffer.from(`${k}=${v}`, "utf8")));
    let vorbis = [...le32(vendor.length), ...vendor, ...le32(entries.length)];
    for (const e of entries) vorbis = vorbis.concat([...le32(e.length), ...e]);

    const blocks = [{ type: 0, data: streamInfo }, { type: 4, data: vorbis }];
    if (withCover) {
        const mime = ascii("image/jpeg");
        const pic = [...be32(3), ...be32(mime.length), ...mime, ...be32(0), ...be32(1), ...be32(1), ...be32(24), ...be32(0), ...be32(FAKE_JPEG.length), ...FAKE_JPEG];
        blocks.push({ type: 6, data: pic });
    }
    let out = ascii("fLaC");
    blocks.forEach((b, i) => {
        const last = i === blocks.length - 1 ? 0x80 : 0;
        out = out.concat([last | b.type, (b.data.length >> 16) & 0xff, (b.data.length >> 8) & 0xff, b.data.length & 0xff, ...b.data]);
    });
    return Uint8Array.from(out.concat(new Array(64).fill(0)));
}

function buildWav({ seconds = 2, info = {} } = {}) {
    const sampleRate = 8000;
    const byteRate = sampleRate * 2; // mono 16-bit
    const fmt = [...ascii("fmt "), ...le32(16), ...le16(1), ...le16(1), ...le32(sampleRate), ...le32(byteRate), ...le16(2), ...le16(16)];
    let infoBody = ascii("INFO");
    for (const [k, v] of Object.entries(info)) {
        const val = [...ascii(v), 0];
        if (val.length % 2) val.push(0);
        infoBody = infoBody.concat([...ascii(k), ...le32(val.length), ...val]);
    }
    const list = [...ascii("LIST"), ...le32(infoBody.length), ...infoBody];
    const dataSize = byteRate * seconds;
    const data = [...ascii("data"), ...le32(dataSize), ...new Array(dataSize).fill(0)];
    const body = [...ascii("WAVE"), ...fmt, ...list, ...data];
    return Uint8Array.from([...ascii("RIFF"), ...le32(body.length), ...body]);
}

function fakeFile(name, bytes, extra = {}) {
    const buf = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes || []);
    return {
        name,
        size: buf.byteLength,
        type: extra.type || "",
        lastModified: extra.lastModified || Date.UTC(2023, 4, 1),
        webkitRelativePath: extra.webkitRelativePath || "",
        arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
    };
}

function createMemoryStore() {
    let mem = {};
    return Storage.createStorageStore({
        storageKey: `lib-test-${Math.random()}`,
        localStorage: {
            getItem: (k) => (k in mem ? mem[k] : null),
            setItem: (k, v) => {
                mem[k] = String(v);
            },
            removeItem: (k) => {
                delete mem[k];
            },
        },
        indexedDB: null,
    });
}

const noProbe = async () => 0;

// ---------- Pure library tests ----------

test("isSupportedAudioFile accepts mp3/flac/wav (+m4a/ogg) by extension or audio MIME and rejects others", () => {
    for (const name of ["a.mp3", "B.FLAC", "c.wav", "d.m4a", "e.ogg"]) {
        assert.ok(Library.isSupportedAudioFile({ name }), name);
    }
    assert.ok(Library.isSupportedAudioFile({ name: "noext", type: "audio/mpeg" }));
    for (const file of [{ name: "cover.jpg" }, { name: "notes.txt" }, { name: "list.m3u", type: "audio/x-mpegurl" }, null]) {
        assert.equal(Library.isSupportedAudioFile(file), false);
    }
});

test("parseFilenameMetadata handles 'Artist - Title', catalog 'Title-Artist', track numbers, feat. credits and folders", () => {
    const a = Library.parseFilenameMetadata("Daft Punk - Get Lucky (feat. Pharrell Williams).mp3");
    assert.equal(a.title, "Get Lucky");
    assert.deepEqual(a.artists, ["Daft Punk"]);
    assert.deepEqual(a.featuredFromTitle, ["Pharrell Williams"]);

    const b = Library.parseFilenameMetadata("Espresso-Sabrina Carpenter.mp3");
    assert.equal(b.title, "Espresso");
    assert.deepEqual(b.artists, ["Sabrina Carpenter"]);

    const c = Library.parseFilenameMetadata("03. Midnight_Drive.flac", "Neon Coast/Night Shift/03. Midnight_Drive.flac");
    assert.equal(c.title, "Midnight Drive");
    assert.equal(c.trackNumber, 3);
    assert.equal(c.album, "Night Shift");
    assert.deepEqual(c.artists, ["Neon Coast"]);

    const d = Library.parseFilenameMetadata("Track Without Artist.wav");
    assert.equal(d.title, "Track Without Artist");
    assert.deepEqual(d.artists, []);
});

test("sanitizeTagText strips markup and control characters from untrusted tag text", () => {
    assert.equal(Library.sanitizeTagText('<img src=x onerror="alert(1)">Song\u0000'), "img src=x onerror=”alert(1)”Song");
    assert.equal(Library.sanitizeTagText("  a   b  "), "a b");
    assert.equal(Library.sanitizeTagText("x".repeat(500)).length, 160);
});

test("parseAudioMetadata reads ID3v2.3 tags, numeric genre, APIC cover and MP3 CBR duration", () => {
    const bytes = buildMp3({ title: "Sunset Lover", artist: "Petit Biscuit & Friend", album: "Presence", year: "2017", genre: "(52)", withCover: true });
    const parsed = Library.parseAudioMetadata(bytes, "x.mp3");
    assert.equal(parsed.format, "mp3");
    assert.equal(parsed.tags.title, "Sunset Lover");
    assert.equal(parsed.tags.artist, "Petit Biscuit & Friend");
    assert.equal(parsed.tags.album, "Presence");
    assert.equal(parsed.tags.year, "2017");
    assert.equal(Library.normalizeGenre(parsed.tags.genre), "Electronic");
    assert.equal(parsed.tags.picture.mime, "image/jpeg");
    assert.deepEqual(Array.from(parsed.tags.picture.data), FAKE_JPEG);
    assert.equal(parsed.bitrateKbps, 128);
    assert.equal(parsed.sampleRate, 44100);
    assert.ok(Math.abs(parsed.duration - (16000 * 8) / 128000) < 0.01, `duration ${parsed.duration}`);

    const dataUrl = Library.pictureToDataUrl(parsed.tags.picture);
    assert.equal(dataUrl, `data:image/jpeg;base64,${Buffer.from(FAKE_JPEG).toString("base64")}`);
});

test("parseAudioMetadata reads ID3v2.4 UTF-8 frames with syncsafe sizes", () => {
    const bytes = buildMp3({ title: "Café Déjà Vu", artist: "Zoë", year: "2021-05-01", major: 4, encoding: 3 });
    const parsed = Library.parseAudioMetadata(bytes, "x.mp3");
    assert.equal(parsed.tags.title, "Café Déjà Vu");
    assert.equal(parsed.tags.artist, "Zoë");
    assert.equal(parsed.tags.year, "2021-05-01");
});

test("parseAudioMetadata estimates real catalog MP3 durations within 3% of tracks.json", () => {
    const sample = CATALOG.slice(0, 3);
    for (const track of sample) {
        const bytes = fs.readFileSync(path.join(ROOT_DIR, "songs", track.filename));
        const parsed = Library.parseAudioMetadata(bytes, track.filename);
        assert.equal(parsed.format, "mp3");
        const diff = Math.abs(parsed.duration - track.duration) / track.duration;
        assert.ok(diff < 0.03, `${track.filename}: ${parsed.duration} vs ${track.duration}`);
    }
});

test("parseAudioMetadata reads FLAC STREAMINFO duration, Vorbis comments and PICTURE block", () => {
    const bytes = buildFlac({
        seconds: 10,
        comments: { TITLE: "Clair de Lune", ARTIST: "Debussy", ALBUM: "Suite", DATE: "1905", GENRE: "Classical", TRACKNUMBER: "3/4" },
        withCover: true,
    });
    const parsed = Library.parseAudioMetadata(bytes, "x.flac");
    assert.equal(parsed.format, "flac");
    assert.equal(parsed.sampleRate, 44100);
    assert.ok(Math.abs(parsed.duration - 10) < 0.001);
    assert.equal(parsed.tags.title, "Clair de Lune");
    assert.equal(parsed.tags.artist, "Debussy");
    assert.equal(parsed.tags.track, "3/4");
    assert.deepEqual(Array.from(parsed.tags.picture.data), FAKE_JPEG);
});

test("parseAudioMetadata reads WAV fmt/data duration and LIST/INFO tags", () => {
    const bytes = buildWav({ seconds: 2, info: { INAM: "Field Recording", IART: "Ambient Lab", IGNR: "Ambient" } });
    const parsed = Library.parseAudioMetadata(bytes, "x.wav");
    assert.equal(parsed.format, "wav");
    assert.equal(parsed.sampleRate, 8000);
    assert.ok(Math.abs(parsed.duration - 2) < 0.001);
    assert.equal(parsed.tags.title, "Field Recording");
    assert.equal(parsed.tags.artist, "Ambient Lab");
    assert.equal(parsed.tags.genre, "Ambient");
});

test("generateCoverArt returns a deterministic, escaped SVG data URI", () => {
    const a = Library.generateCoverArt({ title: "<b>Hi</b>", artist: "X", seed: "s1" });
    const b = Library.generateCoverArt({ title: "<b>Hi</b>", artist: "X", seed: "s1" });
    const c = Library.generateCoverArt({ title: "Other", artist: "X", seed: "s1" });
    assert.ok(a.startsWith("data:image/svg+xml;charset=utf-8,"));
    assert.equal(a, b);
    assert.notEqual(a, c);
    const svg = decodeURIComponent(a.split(",")[1]);
    assert.ok(!svg.includes("<b>"));
    assert.ok(svg.includes("LOCAL FILE"));
});

test("buildImportedTrackMeta merges tags + filename into a catalog-schema track with inferred features", () => {
    const parsed = Library.parseAudioMetadata(buildMp3({ title: "Lose Control (feat. Guest Star)", artist: "Main Act", genre: "Hip-Hop" }), "x.mp3");
    const meta = Library.buildImportedTrackMeta({ name: "whatever.mp3", size: 1234, type: "audio/mpeg", lastModified: Date.UTC(2020, 0, 1) }, parsed);
    assert.equal(meta.title, "Lose Control");
    assert.equal(meta.primaryArtist, "Main Act");
    assert.deepEqual(meta.featuredArtists, ["Guest Star"]);
    assert.equal(meta.artistDisplay, "Main Act, Guest Star");
    assert.equal(meta.genre, "Hip-Hop");
    assert.ok(meta.moods.includes("Energetic"));
    assert.ok(meta.bpm >= 120 && meta.bpm <= 160);
    assert.equal(meta.year, 2020);
    assert.equal(meta.isLocalImport, true);
    assert.ok(meta.id.startsWith("local-lose-control-main-act-"));
    assert.ok(meta.coverUrl.startsWith("data:image/svg+xml"));
    assert.equal(meta.hasEmbeddedCover, false);
    for (const key of ["energy", "valence", "danceability", "acousticness"]) {
        assert.ok(meta[key] > 0 && meta[key] < 1, key);
        assert.equal(meta.audioFeatures[key], meta[key]);
    }
    // Same file -> same id (dedupe key)
    const again = Library.buildImportedTrackMeta({ name: "whatever.mp3", size: 1234 }, parsed);
    assert.equal(again.id, meta.id);
});

test("importAudioFiles persists supported files to storage, skips unsupported/hidden files and de-duplicates re-imports", async () => {
    const store = createMemoryStore();
    const files = [
        fakeFile("Artist One - First Song.mp3", buildMp3({ withCover: true })),
        fakeFile("Clair.flac", buildFlac({ comments: { TITLE: "Clair", ARTIST: "Debussy", GENRE: "Classical" } })),
        fakeFile("rain.wav", buildWav({ info: { INAM: "Rain" } })),
        fakeFile("cover.jpg", FAKE_JPEG),
        fakeFile(".DS_Store", [0, 1, 2]),
    ];
    const progress = [];
    const result = await Library.importAudioFiles(files, { storage: store, probeDuration: noProbe, onProgress: (p) => progress.push(p.status) });
    assert.equal(result.imported.length, 3);
    assert.equal(result.skipped.length, 2);
    assert.deepEqual(progress, ["imported", "imported", "imported", "skipped", "skipped"]);

    const [mp3, flac, wav] = result.imported;
    assert.equal(mp3.title, "First Song");
    assert.equal(mp3.primaryArtist, "Artist One");
    assert.ok(mp3.coverUrl.startsWith("data:image/jpeg;base64,"));
    assert.equal(flac.title, "Clair");
    assert.equal(flac.genre, "Classical");
    assert.ok(flac.moods.includes("Focus"));
    assert.ok(Math.abs(flac.duration - 10) < 0.01);
    assert.equal(wav.title, "Rain");
    assert.equal(wav.durationFormatted, "0:02");

    const persisted = await store.getImportedTracks();
    assert.equal(persisted.length, 3);
    const persistedFlac = persisted.find((t) => t.id === flac.id);
    assert.equal(persistedFlac.audioFeatures.acousticness, flac.acousticness);
    assert.equal(persistedFlac.isLocalImport, true);
    assert.ok(await store.getAudioBlob(flac.id));

    const second = await Library.importAudioFiles(files.slice(0, 2), {
        storage: store,
        existingIds: persisted.map((t) => t.id),
        probeDuration: noProbe,
    });
    assert.equal(second.imported.length, 0);
    assert.equal(second.duplicates.length, 2);
    assert.equal(Library.summarizeImportResult(second), "2 already in library");
    assert.equal(Library.summarizeImportResult(result), "Imported 3 tracks • 2 skipped");
});

test("collectFilesFromDataTransfer walks dropped folders recursively, including batched readEntries", async () => {
    const mkFile = (name) => ({ isFile: true, isDirectory: false, name, file: (ok) => ok(fakeFile(name, [1])) });
    const mkDir = (name, children) => ({
        isFile: false,
        isDirectory: true,
        name,
        createReader() {
            const batches = [children.slice(0, 1), children.slice(1), []];
            return { readEntries: (ok) => ok(batches.shift() || []) };
        },
    });
    const tree = mkDir("Music", [mkFile("a.mp3"), mkDir("Album", [mkFile("b.flac"), mkFile("c.wav")])]);
    const dt = {
        items: [
            { kind: "file", webkitGetAsEntry: () => tree },
            { kind: "file", webkitGetAsEntry: () => mkFile("loose.mp3") },
        ],
        files: [],
    };
    const collected = await Library.collectFilesFromDataTransfer(dt);
    assert.deepEqual(
        collected.map((c) => c.relativePath),
        ["Music/a.mp3", "Music/Album/b.flac", "Music/Album/c.wav", "loose.mp3"]
    );

    const plain = await Library.collectFilesFromDataTransfer({ items: [], files: [fakeFile("x.mp3", [1])] });
    assert.equal(plain.length, 1);
});

test("playlist helpers resolve ordered tracks, name new playlists and build collage covers", () => {
    const pl = { trackIds: [CATALOG[2].id, "missing", CATALOG[0].id] };
    assert.deepEqual([...Library.resolvePlaylistTracks(pl, CATALOG).map((t) => t.id)], [CATALOG[2].id, CATALOG[0].id]);
    assert.equal(Library.nextDefaultPlaylistName([]), "My Playlist #1");
    assert.equal(Library.nextDefaultPlaylistName([{ name: "My Playlist #4" }, { name: "Gym" }]), "My Playlist #5");
    assert.equal(Library.buildCollectionCovers(CATALOG.slice(0, 6)).length, 4);
    assert.ok(Library.buildCollectionCovers([], "Empty")[0].startsWith("data:image/svg+xml"));
});

// ---------- Shell integration ----------

test("index.html and style.css include import inputs, drop overlay, Local Files, playlists sidebar and dialogs", () => {
    const html = fs.readFileSync(path.join(ROOT_DIR, "index.html"), "utf8");
    const css = fs.readFileSync(path.join(ROOT_DIR, "style.css"), "utf8");
    assert.ok(html.indexOf('src="library.js"') > html.indexOf('src="storage.js"'));
    assert.ok(html.indexOf('src="library.js"') < html.indexOf('src="script.js"'));
    for (const id of [
        "import-file-input",
        "import-folder-input",
        "drop-overlay",
        "library-toast",
        "lib-local-files",
        "lib-local-count",
        "library-user-playlists",
        "detail-collection-actions",
        "detail-edit-playlist-btn",
        "detail-delete-playlist-btn",
        "detail-import-more-btn",
        "detail-import-folder-btn",
        "detail-empty-hint",
        "playbar-add-to-playlist-btn",
        "playlist-edit-dialog",
        "playlist-name-input",
        "playlist-desc-input",
        "playlist-picker-dialog",
        "playlist-picker-list",
        "playlist-picker-new-btn",
    ]) {
        assert.ok(html.includes(`id="${id}"`), `index.html must include #${id}`);
    }
    assert.ok(/id="import-folder-input"[^>]*webkitdirectory/.test(html));
    assert.ok(/id="import-file-input"[^>]*accept="[^"]*\.flac/.test(html));
    for (const sel of [".drop-overlay", ".library-toast", ".playlist-picker-item", ".playlist-field", ".detail-collection-actions", ".local-files-gradient"]) {
        assert.ok(css.includes(sel), `style.css must define ${sel}`);
    }
});

function createShellSandbox() {
    const files = ["storage.js", "library.js", "recommender.js", "queue.js", "player.js", "script.js"].map((f) =>
        fs.readFileSync(path.join(ROOT_DIR, f), "utf8")
    );
    const elementsById = new Map();
    const makeEl = (id = "", tagName = "DIV") => {
        const listeners = new Map();
        return {
            id,
            tagName,
            hidden: ["detail-view", "search-view", "playlist-picker-dialog", "playlist-edit-dialog", "drop-overlay", "library-toast"].includes(id),
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
            focus() {},
            click() {
                this.clicked = (this.clicked || 0) + 1;
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
    };
    const docListeners = new Map();
    const sandbox = {
        console,
        setTimeout: () => 0,
        clearTimeout: () => {},
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
    };
    sandbox.window = sandbox;
    sandbox.globalThis = sandbox;
    for (const src of files) vm.runInNewContext(src, sandbox);
    const shell = sandbox.SpotTubeShell;
    shell.setState({ songs: CATALOG.slice(), currentTrackIndex: 0 });
    shell.initLibraryImportControls();
    return { sandbox, shell, el: (id) => sandbox.document.getElementById(id) };
}

test("importLocalAudioFiles merges imports into the live catalog, opens Local Files and supports deletion", async () => {
    const { shell, el } = createShellSandbox();
    const before = shell.getState().songs.length;
    const result = await shell.importLocalAudioFiles(
        [fakeFile("Neon Coast - Night Drive.mp3", buildMp3({ genre: "Synthwave Electronic" })), fakeFile("readme.txt", [1, 2])],
        { probeDuration: noProbe }
    );
    assert.equal(result.added.length, 1);
    assert.equal(result.summary, "Imported 1 track • 1 skipped");
    assert.equal(shell.getState().songs.length, before + 1);
    const imported = result.added[0];
    assert.equal(imported.title, "Night Drive");
    assert.ok(shell.getImportedLocalTracks().some((t) => t.id === imported.id));
    assert.equal(el("library-toast").textContent, "Imported 1 track • 1 skipped");
    assert.match(el("lib-local-count").textContent, /1 file/);

    // Local Files collection view
    const state = shell.getState();
    assert.equal(state.activeView, "detail");
    assert.equal(state.activeDetail.type, "local");
    assert.equal(state.activeDetail.data.trackCount, 1);
    assert.equal(el("detail-collection-actions").hidden, false);
    assert.equal(el("detail-import-more-btn").hidden, false);
    assert.equal(el("detail-edit-playlist-btn").hidden, true);
    assert.equal(el("detail-discography-section").hidden, true);

    // Imported track is playable, searchable and mixable
    shell.playMusic(imported.id, true);
    assert.equal(shell.getState().currentTrackIndex, shell.getState().songs.findIndex((t) => t.id === imported.id));
    const mix = shell.startRadioMix({ type: "track", track: imported });
    assert.ok(mix);

    // Re-importing the same file is a no-op
    const dupe = await shell.importLocalAudioFiles([fakeFile("Neon Coast - Night Drive.mp3", buildMp3({ genre: "Synthwave Electronic" }))], {
        probeDuration: noProbe,
        openCollection: false,
    });
    assert.equal(dupe.added.length, 0);
    assert.equal(dupe.duplicates.length, 1);

    // Delete it
    const playlist = shell.createUserPlaylist({ name: "With Import", trackIds: [imported.id] }, { open: false });
    assert.equal(await shell.removeImportedTrack(imported.id), true);
    assert.equal(shell.getState().songs.length, before);
    assert.equal(shell.getImportedLocalTracks().length, 0);
    assert.equal(shell.getUserPlaylists().find((p) => p.id === playlist.id).trackIds.length, 0);
});

test("drop events on the document show the overlay and import dropped files", async () => {
    const { sandbox, shell, el } = createShellSandbox();
    const dt = { types: ["Files"], items: [], files: [fakeFile("Drop Artist - Dropped.wav", buildWav({}))] };
    sandbox.document.dispatch("dragenter", { dataTransfer: dt, preventDefault() {} });
    assert.equal(el("drop-overlay").hidden, false);
    sandbox.document.dispatch("dragleave", { dataTransfer: dt, preventDefault() {} });
    assert.equal(el("drop-overlay").hidden, true);

    const before = shell.getState().songs.length;
    const imported = await shell.importFromDataTransfer(dt, { probeDuration: noProbe });
    assert.equal(imported.added.length, 1);
    assert.equal(shell.getState().songs.length, before + 1);
    assert.equal(imported.added[0].title, "Dropped");
    assert.equal(imported.added[0].primaryArtist, "Drop Artist");

    // Non-file drags (e.g. text) are ignored
    sandbox.document.dispatch("dragenter", { dataTransfer: { types: ["text/plain"] }, preventDefault() {} });
    assert.equal(el("drop-overlay").hidden, true);
});

test("custom playlists: create, add (deduped), reorder, remove, rename, picker and delete", () => {
    const { shell, el } = createShellSandbox();
    const [t0, t1, t2] = CATALOG;

    const pl = shell.createUserPlaylist();
    assert.equal(pl.name, "My Playlist #1");
    let state = shell.getState();
    assert.equal(state.activeDetail.type, "playlist");
    assert.equal(state.activeDetail.data.trackCount, 0);
    assert.equal(el("detail-empty-hint").hidden, false);
    assert.equal(el("detail-edit-playlist-btn").hidden, false);
    assert.ok(el("library-user-playlists").children.length >= 1);

    assert.equal(shell.addTrackToUserPlaylist(pl.id, t0.id).added, true);
    assert.equal(shell.addTrackToUserPlaylist(pl.id, t1.id).added, true);
    assert.equal(shell.addTrackToUserPlaylist(pl.id, t2.id).added, true);
    assert.equal(shell.addTrackToUserPlaylist(pl.id, t1.id).added, false);
    assert.match(el("library-toast").textContent, /Already in/);

    state = shell.getState();
    assert.deepEqual([...state.activeDetail.data.topTracks.map((t) => t.id)], [t0.id, t1.id, t2.id]);
    assert.equal(el("detail-empty-hint").hidden, true);
    assert.equal(el("detail-top-tracks").children.length, 3);
    assert.ok(state.activeDetail.data.similarTracks.every((t) => ![t0.id, t1.id, t2.id].includes(t.id)));

    shell.moveUserPlaylistTrack(pl.id, 2, 0);
    assert.deepEqual([...shell.getState().activeDetail.data.topTracks.map((t) => t.id)], [t2.id, t0.id, t1.id]);
    shell.removeTrackFromUserPlaylist(pl.id, t0.id);
    assert.deepEqual([...shell.getState().activeDetail.data.topTracks.map((t) => t.id)], [t2.id, t1.id]);

    // Playlist radio mix
    const session = shell.startDetailMix();
    assert.ok(session);

    // Edit dialog
    assert.equal(shell.openPlaylistEditDialog(pl.id), true);
    assert.equal(el("playlist-edit-dialog").hidden, false);
    assert.equal(el("playlist-name-input").value, "My Playlist #1");
    el("playlist-name-input").value = "Road Trip";
    el("playlist-desc-input").value = "Windows down";
    shell.savePlaylistEditDialog();
    assert.equal(el("playlist-edit-dialog").hidden, true);
    assert.equal(shell.getState().activeDetail.data.title, "Road Trip");
    assert.equal(el("detail-heading").textContent, "Road Trip");

    // Picker: new playlist seeded with the track
    assert.equal(shell.openPlaylistPicker(t0.id), true);
    assert.equal(el("playlist-picker-dialog").hidden, false);
    assert.equal(el("playlist-picker-list").children.length, 1);
    const created = shell.createPlaylistFromPicker();
    assert.deepEqual([...created.trackIds], [t0.id]);
    assert.equal(el("playlist-picker-dialog").hidden, true);
    assert.equal(shell.getUserPlaylists().length, 2);

    // Back/forward history restores the playlist view
    shell.navigateBack();
    shell.navigateForward();
    assert.equal(shell.getState().activeDetail.type, "playlist");

    // Delete closes the open view
    assert.equal(shell.deleteUserPlaylist(pl.id), true);
    assert.equal(shell.getState().activeView, "home");
    assert.equal(shell.getUserPlaylists().length, 1);
});

test("Liked Songs collection lists liked tracks and updates when a song is unliked", () => {
    const { shell, el } = createShellSandbox();
    const [t0, t1] = CATALOG;
    shell.toggleLikeTrackById(t0.id);
    shell.toggleLikeTrackById(t1.id);
    const data = shell.openLikedSongsDetail();
    assert.equal(data.type, "liked");
    assert.equal(data.trackCount, 2);
    assert.equal(el("detail-heading").textContent, "Liked Songs");
    assert.equal(el("detail-collection-actions").hidden, false);
    assert.equal(el("detail-delete-playlist-btn").hidden, true);

    shell.toggleLikeTrackById(t0.id);
    const refreshed = shell.refreshActiveCollectionView();
    assert.deepEqual([...refreshed.topTracks.map((t) => t.id)], [t1.id]);
});

test("playlist edits made before an async View Transition callback runs are not overwritten by stale data", () => {
    const { sandbox, shell, el } = createShellSandbox();
    const pending = [];
    sandbox.document.startViewTransition = (cb) => {
        pending.push(cb);
        return { finished: Promise.resolve() };
    };
    const pl = shell.createUserPlaylist({ name: "Async" });
    shell.addTrackToUserPlaylist(pl.id, CATALOG[0].id);
    shell.addTrackToUserPlaylist(pl.id, CATALOG[1].id);
    while (pending.length) pending.shift()();
    assert.equal(el("detail-top-tracks").children.length, 2);
    assert.match(el("detail-subtitle").textContent, /2 songs/);
});
