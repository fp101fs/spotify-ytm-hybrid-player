// Item 13: instant folder import with progressive metadata
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT_DIR = path.resolve(__dirname, "..");
const Library = require(path.join(ROOT_DIR, "library.js"));
const Storage = require(path.join(ROOT_DIR, "storage.js"));
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, "tracks.json"), "utf8"));
const CATALOG = manifest.tracks;

// ---------- fixtures ----------

const {
    ascii, be32, le32, le16, buildMp3, sliceableFile, memoryStore, noProbe, createShellSandbox, folderFiles,
} = require("./helpers.js");

/** FLAC whose PICTURE block sits after a large PADDING block (so it lies beyond the first 64 KB). */
function buildFlac({ seconds = 30, sampleRate = 44100, title = "", artist = "", paddingBytes = 200000, audioBytes = 400000 } = {}) {
    const si = new Array(34).fill(0);
    si[10] = (sampleRate >> 12) & 0xff;
    si[11] = (sampleRate >> 4) & 0xff;
    si[12] = (sampleRate & 0x0f) << 4;
    si.splice(14, 4, ...be32(sampleRate * seconds));
    const vendor = ascii("v");
    const comments = [`TITLE=${title}`, `ARTIST=${artist}`].map((c) => ascii(c));
    let vorbis = [...le32(vendor.length), ...vendor, ...le32(comments.length)];
    for (const c of comments) vorbis = vorbis.concat([...le32(c.length), ...c]);
    const jpeg = [0xff, 0xd8, 0xff, 0xe0, 9, 9, 9, 0xff, 0xd9];
    const mime = ascii("image/jpeg");
    const pic = [...be32(3), ...be32(mime.length), ...mime, ...be32(0), ...new Array(16).fill(0), ...be32(jpeg.length), ...jpeg];
    const block = (type, body, last = false) => [(last ? 0x80 : 0) | type, (body.length >> 16) & 0xff, (body.length >> 8) & 0xff, body.length & 0xff];
    const head = [
        ...ascii("fLaC"),
        ...block(0, si), ...si,
        ...block(4, vorbis), ...vorbis,
        ...block(1, { length: paddingBytes }),
    ];
    const tail = [...block(6, pic, true), ...pic];
    const out = new Uint8Array(head.length + paddingBytes + tail.length + audioBytes);
    out.set(head, 0);
    out.set(tail, head.length + paddingBytes);
    return out;
}

/** WAV with the LIST/INFO chunk *after* a large data chunk. */
function buildWav({ title = "", seconds = 2, sampleRate = 8000 } = {}) {
    const byteRate = sampleRate * 2;
    const dataLen = byteRate * seconds;
    const fmt = [...le16(1), ...le16(1), ...le32(sampleRate), ...le32(byteRate), ...le16(2), ...le16(16)];
    const inam = [...ascii(title), 0];
    if (inam.length % 2) inam.push(0);
    const info = [...ascii("INFO"), ...ascii("INAM"), ...le32(inam.length), ...inam];
    const chunks = [...ascii("fmt "), ...le32(fmt.length), ...fmt];
    const out = new Uint8Array(12 + chunks.length + 8 + dataLen + 8 + info.length);
    out.set([...ascii("RIFF"), ...le32(out.length - 8), ...ascii("WAVE"), ...chunks, ...ascii("data"), ...le32(dataLen)], 0);
    out.set([...ascii("LIST"), ...le32(info.length), ...info], 12 + chunks.length + 8 + dataLen);
    return out;
}

// ---------- library.js: byte-range tag reading ----------

test("readTagBytes reads only the tag bytes of real catalog MP3s and parses them identically to a full read", async () => {
    const files = fs.readdirSync(path.join(ROOT_DIR, "songs")).filter((f) => f.endsWith(".mp3")).slice(0, 4);
    assert.ok(files.length > 0);
    for (const name of files) {
        const buf = new Uint8Array(fs.readFileSync(path.join(ROOT_DIR, "songs", name)));
        const full = Library.parseAudioMetadata(buf, name);
        const file = sliceableFile(name, buf);
        const { parsed, bytesRead } = await Library.readAudioMetadataFromFile(file, { probeDuration: null });
        assert.equal(parsed.tags.title, full.tags.title, name);
        assert.equal(parsed.tags.artist, full.tags.artist, name);
        assert.equal(Boolean(parsed.tags.picture), Boolean(full.tags.picture), name);
        assert.ok(Math.abs(parsed.duration - full.duration) < 0.01, `${name}: ${parsed.duration} vs ${full.duration}`);
        assert.equal(bytesRead, file.counter.bytes);
        assert.ok(bytesRead < buf.length * 0.1, `${name} read ${bytesRead} of ${buf.length} bytes`);
    }
});

test("readTagBytes uses the real file size for CBR duration and reads the ID3v1 tail", async () => {
    const bytes = buildMp3({ audioBytes: 1600000, v1: { title: "Tail Title", artist: "Tail Artist" } });
    const file = sliceableFile("x.mp3", bytes);
    const { parsed, bytesRead } = await Library.readAudioMetadataFromFile(file, { probeDuration: null });
    assert.equal(parsed.tags.title, "Tail Title");
    assert.equal(parsed.tags.artist, "Tail Artist");
    const full = Library.parseAudioMetadata(bytes, "x.mp3");
    assert.ok(Math.abs(parsed.duration - full.duration) < 0.01);
    assert.ok(parsed.duration > 90, "1.6 MB at 128 kbps is ~100 s");
    assert.ok(bytesRead < 100 * 1024);
});

test("readTagBytes walks FLAC metadata blocks past a big padding block and skips WAV audio data", async () => {
    const flacBytes = buildFlac({ title: "Far Picture", artist: "Flac Band", seconds: 30 });
    const flac = sliceableFile("a.flac", flacBytes);
    const f = await Library.readAudioMetadataFromFile(flac, { probeDuration: null });
    assert.equal(f.parsed.format, "flac");
    assert.equal(f.parsed.tags.title, "Far Picture");
    assert.equal(f.parsed.tags.artist, "Flac Band");
    assert.ok(f.parsed.tags.picture, "PICTURE block after padding is found");
    assert.ok(Math.abs(f.parsed.duration - 30) < 0.01);
    assert.ok(f.bytesRead < 100 * 1024, `FLAC read ${f.bytesRead} of ${flacBytes.length}`);

    const wavBytes = buildWav({ title: "Late Info", seconds: 20, sampleRate: 8000 });
    const wav = sliceableFile("b.wav", wavBytes);
    const w = await Library.readAudioMetadataFromFile(wav, { probeDuration: null });
    assert.equal(w.parsed.format, "wav");
    assert.equal(w.parsed.tags.title, "Late Info", "LIST chunk after the data chunk is read");
    assert.ok(Math.abs(w.parsed.duration - 20) < 0.01);
    assert.ok(w.bytesRead < 100 * 1024, `WAV read ${w.bytesRead} of ${wavBytes.length}`);
});

test("guessImportSourceName uses the picked folder name, the file name, or a count", () => {
    const f = (name, rel) => ({ file: { name, size: 1 }, relativePath: rel });
    assert.equal(Library.guessImportSourceName([f("a.mp3", "Road Trip/a.mp3"), f("b.mp3", "Road Trip/Disc 2/b.mp3")]), "Road Trip");
    assert.equal(Library.guessImportSourceName([f("a.mp3", "a.mp3")]), "a.mp3");
    assert.equal(Library.guessImportSourceName([f("a.mp3", "a.mp3"), f("b.mp3", "b.mp3")]), "2 files");
});

// ---------- library.js: startInstantImport ----------

test("startInstantImport returns 500 playable placeholders synchronously, then fills tags with at most 4 reads in flight", async () => {
    const store = memoryStore();
    let inFlight = 0;
    let maxInFlight = 0;
    const gate = async () => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setImmediate(r));
        inFlight--;
    };
    const files = [];
    for (let i = 0; i < 500; i++) {
        const n = String(i).padStart(3, "0");
        files.push({
            file: sliceableFile(`Artist ${i % 7} - Song ${n}.mp3`, buildMp3({ title: `Tagged ${n}`, artist: `Tag Artist ${i % 7}`, album: "Big Folder", audioBytes: 800 }), { gate }),
            relativePath: `Big Folder/Artist ${i % 7} - Song ${n}.mp3`,
        });
    }
    files.push({ file: sliceableFile("cover.jpg", new Uint8Array([1, 2, 3])), relativePath: "Big Folder/cover.jpg" });
    files.push({ file: sliceableFile(".DS_Store", new Uint8Array([1])), relativePath: "Big Folder/.DS_Store" });

    const updates = [];
    const progress = [];
    const t0 = Date.now();
    const ctl = Library.startInstantImport(files, {
        storage: store,
        probeDuration: noProbe,
        createObjectUrl: (file) => `blob:test/${file.name}`,
        onTrackUpdated: (t) => updates.push(t.id),
        onProgress: (p) => progress.push(p.completed),
    });
    const elapsed = Date.now() - t0;
    assert.ok(elapsed < 1000, `placeholders took ${elapsed} ms`);
    assert.equal(ctl.total, 500);
    assert.equal(ctl.tracks.length, 500);
    assert.equal(ctl.skipped.length, 2);
    assert.match(ctl.skipped.find((s) => s.name === "cover.jpg").reason, /Not a supported audio format/);
    const first = ctl.tracks[0];
    assert.equal(first.importStatus, "pending");
    assert.equal(first.title, "Song 000"); // from the file name
    assert.equal(first.primaryArtist, "Artist 0");
    assert.equal(first.album, "Big Folder"); // from the folder path
    assert.equal(first.audioUrl, "blob:test/Artist 0 - Song 000.mp3"); // playable right away
    assert.equal(first.durationFormatted, "");
    const placeholderId = first.id;

    const result = await ctl.done;
    assert.ok(maxInFlight <= 4, `max in flight ${maxInFlight}`);
    assert.ok(maxInFlight >= 2, "reads run in parallel");
    assert.equal(result.imported.length, 500);
    assert.equal(updates.length, 500);
    assert.equal(progress[progress.length - 1], 500);
    // Same object, same id, now with tag metadata
    assert.equal(ctl.tracks[0], first);
    assert.equal(first.id, placeholderId);
    assert.equal(first.importStatus, "ready");
    assert.equal(first.title, "Tagged 000");
    assert.equal(first.primaryArtist, "Tag Artist 0");
    assert.equal(first.audioUrl, "blob:test/Artist 0 - Song 000.mp3"); // session URL kept
    assert.equal((await store.getImportedTracks()).length, 500);
    assert.equal(Library.summarizeInstantImport(result), "Added 500 songs · 2 skipped");
});

test("startInstantImport dedupes by file name + size (within a batch and against the library) and keeps ids stable", async () => {
    const bytes = buildMp3({ title: "Same", artist: "Song" });
    const a = sliceableFile("dup.mp3", bytes);
    const b = sliceableFile("dup.mp3", bytes);
    const ctl = Library.startInstantImport([a, b], { storage: null, probeDuration: noProbe, createObjectUrl: () => "blob:x" });
    assert.equal(ctl.total, 1);
    assert.equal(ctl.duplicates.length, 1);
    assert.equal(ctl.duplicates[0].reason, "Already in your library");
    const done = await ctl.done;
    const key = Library.importFileKey("dup.mp3", bytes.length);
    assert.equal(done.imported[0].importKey, key);

    const again = Library.startInstantImport([a], { storage: null, existingKeys: [key], createObjectUrl: () => "blob:x" });
    assert.equal(again.total, 0);
    assert.equal(again.duplicates.length, 1);
    const result = await again.done;
    assert.equal(Library.summarizeInstantImport(result), "Nothing new to add · 1 skipped");
});

test("cancel stops the pool, reports pending placeholders as removed; save failures become skipped entries", async () => {
    const files = Array.from({ length: 40 }, (_, i) =>
        sliceableFile(`Song ${i}.mp3`, buildMp3({ title: `T${i}`, artist: "A" }), { gate: () => new Promise((r) => setImmediate(r)) })
    );
    let ctl;
    let seen = 0;
    ctl = Library.startInstantImport(files, {
        storage: null,
        probeDuration: noProbe,
        createObjectUrl: () => "blob:x",
        onProgress: () => {
            seen++;
            if (seen === 6) ctl.cancel();
        },
    });
    const result = await ctl.done;
    assert.equal(result.cancelled, true);
    assert.ok(result.imported.length >= 6 && result.imported.length < 40, `imported ${result.imported.length}`);
    assert.equal(result.removed.length + result.imported.length, 40);
    assert.ok(result.removed.every((t) => t.importStatus === "pending"));
    assert.match(Library.summarizeInstantImport(result), /^Stopped · added \d+ of 40 songs$/);

    const failing = { saveImportedTrack: async () => { throw new Error("QuotaExceededError"); } };
    const failed = [];
    const ctl2 = Library.startInstantImport([sliceableFile("x.mp3", buildMp3({}))], {
        storage: failing,
        probeDuration: noProbe,
        createObjectUrl: () => "blob:x",
        onTrackFailed: (t, reason) => failed.push(reason),
    });
    const r2 = await ctl2.done;
    assert.equal(r2.imported.length, 0);
    assert.equal(r2.skipped.length, 1);
    assert.match(r2.skipped[0].reason, /Could not be saved in this browser \(QuotaExceededError\)/);
    assert.equal(failed.length, 1);
});

// ---------- Shell integration (sandbox in helpers.js) ----------

test("shell: rows appear before tags are read, Local Files shows progress, then a toast with View details", async () => {
    const { shell, el } = createShellSandbox();
    const before = shell.getState().songs.length;
    const entries = [...folderFiles(12), { file: sliceableFile("notes.txt", new Uint8Array([1])), relativePath: "Summer Mix/notes.txt" }];
    const pending = shell.importLocalAudioFiles(entries, { probeDuration: noProbe });

    // Synchronously: placeholders are in the catalog and Local Files is open with the progress header
    let state = shell.getState();
    assert.equal(state.songs.length, before + 12);
    const placeholder = state.songs.find((t) => t.title === "Track 0");
    assert.ok(placeholder, "placeholder uses the file name");
    assert.equal(placeholder.importStatus, "pending");
    assert.equal(state.activeView, "detail");
    assert.equal(state.activeDetail.type, "local");
    assert.equal(el("import-progress").hidden, false);
    assert.equal(el("import-progress-label").textContent, "Adding “Summer Mix” · 0 of 12");
    assert.equal(el("import-progress-bar").getAttribute("aria-valuemax"), "12");
    assert.equal(el("import-progress-pill").hidden, true, "pill hidden while Local Files is showing");
    assert.equal(el("import-live").textContent, "Adding 12 songs from “Summer Mix”");
    assert.equal(shell.getActiveImportJobs().length, 1);

    // Pending rows render shimmer placeholders
    const rows = el("detail-top-tracks").children;
    const pendingRow = rows.find((r) => r.dataset.trackId === placeholder.id);
    assert.ok(pendingRow.className.includes("is-pending"));
    assert.equal(pendingRow.getAttribute("aria-busy"), "true");
    assert.ok(pendingRow.innerHTML.includes("import-shimmer"));
    assert.ok(pendingRow.innerHTML.includes("reading tags…"));

    // Rows can be played right away
    shell.playMusic(placeholder.id, true);
    assert.equal(shell.getState().songs[shell.getState().currentTrackIndex].id, placeholder.id);

    const result = await pending;
    state = shell.getState();
    assert.equal(result.added.length, 12);
    assert.equal(placeholder.importStatus, "ready");
    assert.equal(placeholder.title, "Real Title 0");
    assert.equal(state.songs[state.currentTrackIndex].id, placeholder.id, "playing track kept its id");
    assert.equal(el("import-progress").hidden, true);
    assert.equal(el("import-progress-pill").hidden, true);
    assert.equal(shell.getActiveImportJobs().length, 0);
    assert.equal(el("library-toast").textContent, "Added 12 songs · 1 skipped");
    const viewDetails = el("library-toast").children.find((c) => c.textContent === "View details");
    assert.ok(viewDetails, "toast has a View details action");
    viewDetails.click();
    assert.equal(el("import-details-dialog").hidden, false);
    assert.equal(el("import-details-count").textContent, "1 file wasn't added");
    const item = el("import-details-list").children[0];
    assert.equal(item.children[0].textContent, "Summer Mix/notes.txt");
    assert.match(item.children[1].textContent, /Not a supported audio format/);
    shell.closeImportDetailsDialog();
    assert.equal(el("import-details-dialog").hidden, true);

    // Rendered rows are no longer pending
    const readyRow = el("detail-top-tracks").children.find((r) => r.dataset.trackId === placeholder.id);
    assert.ok(!readyRow.className.includes("is-pending"));
    assert.ok(readyRow.innerHTML.includes("Real Title 0"));
});

test("shell: progress pill shows while browsing elsewhere, cancel removes unread rows, live region announces quarters", async () => {
    const { sandbox, shell, el } = createShellSandbox();
    const before = shell.getState().songs.length;
    const waiting = [];
    const gate = () => new Promise((resolve) => waiting.push(resolve));
    const pending = shell.importLocalAudioFiles(folderFiles(20, "Big One", gate), { probeDuration: noProbe, openCollection: false });
    assert.equal(shell.getState().activeView, "home");
    assert.equal(el("import-progress-pill").hidden, false);
    assert.equal(el("import-pill-label").textContent, "Adding songs · 0 of 20");
    assert.ok(sandbox.document.body.classList.contains("has-import-pill"));

    // clicking the pill opens Local Files and hides the pill
    el("import-progress-pill").click();
    assert.equal(shell.getState().activeDetail.type, "local");
    assert.equal(el("import-progress-pill").hidden, true);
    assert.equal(el("import-progress").hidden, false);

    // Announce at ~25% steps, not per file
    const announcements = [];
    const live = el("import-live");
    let text = "";
    Object.defineProperty(live, "textContent", {
        get: () => text,
        set: (v) => {
            text = v;
            if (v) announcements.push(v);
        },
    });
    // let a few files finish, then flush and cancel
    const job = shell.getActiveImportJobs()[0];
    for (let i = 0; i < 200 && job.controller.completed < 6; i++) {
        while (waiting.length) waiting.shift()();
        await new Promise((r) => setImmediate(r));
    }
    assert.ok(job.controller.completed >= 6 && job.controller.completed < 20);
    shell.flushImportUpdates();
    el("import-cancel-btn").click();
    while (waiting.length) waiting.shift()(); // in-flight reads finish; no new ones start
    const result = await pending;
    assert.equal(result.cancelled, true);
    assert.ok(announcements.some((a) => /^25% added · \d+ of 20 songs$/.test(a)), announcements.join(" | "));
    assert.ok(announcements.length <= 6, `announced ${announcements.length} times`);
    assert.match(el("library-toast").textContent, /^Stopped · added \d+ of 20 songs$/);
    assert.equal(shell.getState().songs.length, before + result.imported.length, "unread placeholders removed");
    assert.ok(shell.getState().songs.every((t) => t.importStatus !== "pending"));
});

test("shell: empty folder and duplicate-only imports explain themselves; permission denied offers Try again", async () => {
    const { shell, el } = createShellSandbox({
        showDirectoryPicker: async () => {
            const err = new Error("denied");
            err.name = "NotAllowedError";
            throw err;
        },
    });
    const none = await shell.importLocalAudioFiles([{ file: sliceableFile("readme.txt", new Uint8Array([1])), relativePath: "Docs/readme.txt" }]);
    assert.equal(none.added.length, 0);
    assert.match(el("library-toast").textContent, /^No music found in “Docs”\. Supported formats: MP3, FLAC, WAV/);
    assert.ok(el("library-toast").classList.contains("is-error"));

    const files = folderFiles(2, "Again");
    await shell.importLocalAudioFiles(files, { probeDuration: noProbe });
    const dupes = await shell.importLocalAudioFiles(files, { probeDuration: noProbe });
    assert.equal(dupes.added.length, 0);
    assert.equal(dupes.duplicates.length, 2);
    assert.equal(el("library-toast").textContent, "Nothing new to add · 2 skipped");

    // Picker cancelled: nothing; permission denied: inline message + Try again
    await shell.openImportPicker({ folder: true });
    assert.equal(el("library-toast").textContent, "Couldn't open that folder because the browser didn't allow access.");
    assert.ok(el("library-toast").children.some((c) => c.textContent === "Try again"));
});

test("Add Music menu: aria-expanded, New playlist only from the Library +, Esc returns focus, actions open pickers", () => {
    const { sandbox, shell, el, items } = createShellSandbox();
    const navBtn = el("add-music-btn");
    navBtn.click();
    assert.equal(el("add-music-menu").hidden, false);
    assert.equal(navBtn.getAttribute("aria-expanded"), "true");
    assert.equal(el("add-music-playlist-item").hidden, true);
    assert.equal(sandbox.document.activeElement, items[0], "focus moves to Add a folder…");

    // Arrow keys move focus, Esc closes and returns focus
    el("add-music-menu").trigger("keydown", { key: "ArrowDown" });
    assert.equal(sandbox.document.activeElement, items[1]);
    el("add-music-menu").trigger("keydown", { key: "ArrowDown" });
    assert.equal(sandbox.document.activeElement, items[0], "wraps (playlist item hidden)");
    el("add-music-menu").trigger("keydown", { key: "Escape" });
    assert.equal(el("add-music-menu").hidden, true);
    assert.equal(navBtn.getAttribute("aria-expanded"), "false");
    assert.equal(sandbox.document.activeElement, navBtn);

    // Library "+" adds New playlist
    el("create-playlist-btn").click();
    assert.equal(el("add-music-playlist-item").hidden, false);
    assert.equal(el("add-music-menu").getAttribute("aria-labelledby"), "create-playlist-btn");
    items[2].click();
    assert.equal(el("add-music-menu").hidden, true);
    assert.equal(shell.getState().activeDetail.type, "playlist");

    // Add files… opens the file input
    navBtn.click();
    const before = el("import-file-input").clicked || 0;
    items[1].click();
    assert.equal(el("import-file-input").clicked, before + 1);

    // Home empty state shows only while nothing is imported
    shell.closeDetailView();
    assert.equal(el("home-add-music-card").hidden, false);
});

test("folder picking is hidden on phones, where Add files… is the main action and the sheet explains why", () => {
    const { el } = createShellSandbox({ userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) Mobile/15E148 Safari/604.1" });
    assert.equal(el("add-music-folder-item").hidden, true);
    assert.equal(el("add-music-folder-note").hidden, false);
    assert.equal(el("add-music-hint").hidden, true);
    assert.equal(el("home-add-music-btn").textContent, "Add files…");
    assert.equal(el("detail-import-folder-btn").dataset.unsupported, "true");
});

test("index.html and style.css: Add Music entry points, progress, pill, details dialog and accessibility hooks", () => {
    const html = fs.readFileSync(path.join(ROOT_DIR, "index.html"), "utf8");
    const css = fs.readFileSync(path.join(ROOT_DIR, "style.css"), "utf8");
    // + Add Music sits right after Start Supermix
    assert.ok(html.indexOf('id="add-music-btn"') > html.indexOf('id="nav-supermix"'));
    assert.ok(html.indexOf('id="add-music-btn"') < html.indexOf("library-card"));
    for (const id of ["add-music-btn", "create-playlist-btn", "mobile-add-music-btn"]) {
        assert.match(html, new RegExp(`id="${id}"[^>]*aria-haspopup="menu"[^>]*aria-expanded="false"`), id);
    }
    assert.match(html, /id="add-music-menu" role="menu"/);
    // The YouTube search row menu has its own items
    const withoutYtMenu = html.replace(/<div class="search-yt-menu"[\s\S]*?<\/div>/, "");
    assert.equal((withoutYtMenu.match(/role="menuitem"/g) || []).length, 3);
    assert.ok(html.indexOf("Add a folder…") < html.indexOf("Add files…"), "folder is the first item");
    assert.ok(html.includes("or drag and drop anywhere"));
    assert.match(html, /id="import-progress-bar" role="progressbar"/);
    assert.match(html, /id="import-pill-bar" role="progressbar"/);
    assert.match(html, /id="import-live" aria-live="polite"/);
    assert.match(html, /id="library-toast" role="status"/);
    assert.match(html, /<dialog[^>]*id="import-details-dialog"/);
    assert.match(html, /id="home-add-music-card"[^>]*hidden/);
    assert.ok(!html.includes('id="import-audio-btn"'), "the library header has a single + (Create) button");

    for (const sel of [".add-music-btn", ".add-music-menu", ".import-progress-pill", ".import-shimmer", ".home-add-music-card", ".library-toast-action"]) {
        assert.ok(css.includes(sel), sel);
    }
    const item13 = css.slice(css.indexOf("Item 13: instant folder import"));
    assert.match(item13, /@media \(prefers-reduced-motion: reduce\)\s*{\s*\.import-shimmer\s*{\s*animation: none;/);
    assert.match(item13, /@media \(max-width: 740px\)[\s\S]*\.add-music-menu\s*{\s*inset: auto 0 0 0 !important;/);
    assert.match(item13, /body\.has-import-pill[\s\S]*scroll-padding-block-end/);
});

test("recommender: the artist-taste index gives the same taste scores as the full catalog scan, and 500 extra tracks stay fast", () => {
    const Recommender = require(path.join(ROOT_DIR, "recommender.js"));
    const store = memoryStore();
    const catalog = CATALOG.slice();
    for (let i = 0; i < 500; i++) {
        catalog.push(Library.buildImportedTrackMeta({ name: `Band ${i % 9} - Song ${i}.mp3`, size: 1000 + i, relativePath: `F/Band ${i % 9} - Song ${i}.mp3` }, {}));
    }
    // likes, full listens and skips on a few artists
    store.toggleLike(catalog[0].id);
    store.toggleLike(catalog[CATALOG.length + 3].id);
    for (const t of catalog.slice(1, 6)) store.recordPlaybackOutcome(t.id, { durationSeconds: 200, endedNaturally: true });
    for (const t of catalog.slice(CATALOG.length + 10, CATALOG.length + 30)) store.recordPlaybackOutcome(t.id, { durationSeconds: 200, listenedSeconds: 3 });

    const index = Recommender.buildArtistTasteIndex(catalog, store);
    assert.ok(index.size > 0, "fixture produces taste signals");
    for (const candidate of catalog.slice(0, 40).concat(catalog.slice(CATALOG.length, CATALOG.length + 40))) {
        const scan = Recommender.computeUserTasteScore(candidate, { storage: store, catalog, now: 1e12 });
        const fast = Recommender.computeUserTasteScore(candidate, { storage: store, catalog, now: 1e12, tasteIndex: index });
        assert.deepEqual(fast, scan, candidate.id);
    }
    const t0 = Date.now();
    const recs = Recommender.recommendTracks(catalog, { seed: [catalog[0]], limit: 25, storage: store });
    const ms = Date.now() - t0;
    assert.equal(recs.length, 25);
    assert.ok(ms < 1500, `recommendTracks over ${catalog.length} tracks took ${ms} ms`);
});

test("recommender: the variety-index fast path matches the full queue walk", () => {
    const Recommender = require(path.join(ROOT_DIR, "recommender.js"));
    const pool = CATALOG.concat(CATALOG.map((t, i) => ({ ...t, id: `${t.id}-copy${i}`, album: i % 2 ? t.album : "Other" })));
    let rng = 7;
    const rand = () => ((rng = (rng * 16807) % 2147483647) / 2147483647);
    for (let trial = 0; trial < 60; trial++) {
        const queue = Array.from({ length: 1 + Math.floor(rand() * 14) }, () => pool[Math.floor(rand() * pool.length)]);
        const index = Recommender.createVarietyIndex(queue);
        for (const candidate of pool) {
            const slow = Recommender.computeVarietyAndRecencyPenalty(candidate, { queueContext: queue, recentTrackIds: [] });
            const fast = Recommender.computeVarietyAndRecencyPenalty(candidate, { queueContext: queue, recentTrackIds: [], varietyIndex: index });
            for (const k of Object.keys(slow)) assert.ok(Math.abs(slow[k] - fast[k]) < 0.0011, `${k}: ${slow[k]} vs ${fast[k]}`);
        }
    }
});

test("recommender: past greedyLimit picks the tail is ordered in one pass, keeping the greedy prefix and every track", () => {
    const Recommender = require(path.join(ROOT_DIR, "recommender.js"));
    const full = Recommender.recommendTracks(CATALOG, { seed: [CATALOG[0]], limit: CATALOG.length, storage: null });
    const capped = Recommender.recommendTracks(CATALOG, { seed: [CATALOG[0]], limit: CATALOG.length, storage: null, greedyLimit: 4 });
    assert.equal(capped.length, full.length);
    assert.deepEqual(capped.slice(0, 4).map((t) => t.id), full.slice(0, 4).map((t) => t.id));
    assert.deepEqual(new Set(capped.map((t) => t.id)), new Set(full.map((t) => t.id)));
});

test("renderInChunks renders the first chunk, loads more on intersection, and keeps the count on same-key refresh", () => {
    const { sandbox, shell } = createShellSandbox();
    const observers = [];
    sandbox.IntersectionObserver = function (cb) {
        this.cb = cb;
        this.observe = () => observers.push(this);
        this.disconnect = () => (this.disconnected = true);
    };
    sandbox.requestAnimationFrame = (fn) => fn();
    const container = {
        id: "list-x",
        children: [],
        replaceChildren(...n) {
            this.children = n;
            for (const c of n) c.parentList = this;
        },
        append() {},
    };
    sandbox.document.createElement = () => {
        const el = {
            isConnected: true,
            setAttribute() {},
            before(...nodes) {
                const list = this.parentList.children;
                list.splice(list.indexOf(this), 0, ...nodes);
            },
            remove() {
                const list = this.parentList.children;
                list.splice(list.indexOf(this), 1);
                this.isConnected = false;
            },
        };
        return el;
    };
    const items = Array.from({ length: 250 }, (_, i) => i);
    const make = (n) => ({ n });
    assert.equal(shell.renderInChunks(container, items, make, { chunk: 100, key: "k" }), 100);
    assert.equal(container.children.length, 101, "100 rows + sentinel");
    observers[0].cb([{ isIntersecting: true }]);
    observers[0].cb([{ isIntersecting: true }]);
    assert.equal(container.children.length, 250, "all rows, sentinel removed");
    assert.equal(observers[0].disconnected, true);
    // same key keeps everything rendered; a new key starts over
    assert.equal(shell.renderInChunks(container, items, make, { chunk: 100, key: "k" }), 250);
    assert.equal(shell.renderInChunks(container, items, make, { chunk: 100, key: "other" }), 100);
});

test("useDisplayCover swaps embedded data: covers for one shared blob: URL and keeps the data URL", () => {
    const { sandbox, shell } = createShellSandbox();
    let made = 0;
    sandbox.URL.createObjectURL = () => `blob:cover/${++made}`;
    sandbox.Blob = function () {};
    sandbox.atob = (b64) => Buffer.from(b64, "base64").toString("latin1");
    const dataUrl = `data:image/jpeg;base64,${Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString("base64")}`;
    const a = shell.useDisplayCover({ coverUrl: dataUrl });
    const b = shell.useDisplayCover({ coverUrl: dataUrl });
    assert.equal(a.coverUrl, "blob:cover/1");
    assert.equal(b.coverUrl, "blob:cover/1", "same image shares one blob URL");
    assert.equal(a.coverDataUrl, dataUrl);
    const svg = shell.useDisplayCover({ coverUrl: "data:image/svg+xml,<svg/>" });
    assert.equal(svg.coverUrl, "data:image/svg+xml,<svg/>", "small generated SVG covers stay inline");
});
