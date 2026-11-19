// Item 14: play straight from the picked folder (no copy), Reconnect after reload, Rescan
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { buildMp3, sliceableFile, memoryStore, noProbe, createShellSandbox, ROOT_DIR, CATALOG } = require("./helpers.js");
const Library = require(path.join(ROOT_DIR, "library.js"));
const Player = require(path.join(ROOT_DIR, "player.js"));

// ---------- fake File System Access API ----------

/**
 * A FileSystemDirectoryHandle stand-in. `tree` maps names to Uint8Array (files) or nested objects (folders).
 * `perm` is shared by the whole tree: { state, onRequest, requests }.
 */
function fakeDir(name, tree, perm = { state: "granted", onRequest: "granted", requests: 0 }) {
    const handle = {
        kind: "directory",
        name,
        perm,
        tree,
        async *values() {
            for (const [childName, value] of Object.entries(tree)) {
                yield value instanceof Uint8Array ? fakeFile(childName, value) : fakeDir(childName, value, perm);
            }
        },
        async getDirectoryHandle(childName) {
            const value = tree[childName];
            if (!value || value instanceof Uint8Array) throw Object.assign(new Error("nf"), { name: "NotFoundError" });
            return fakeDir(childName, value, perm);
        },
        async getFileHandle(childName) {
            const value = tree[childName];
            if (!(value instanceof Uint8Array)) throw Object.assign(new Error("nf"), { name: "NotFoundError" });
            return fakeFile(childName, value);
        },
        async queryPermission() {
            return perm.state;
        },
        async requestPermission() {
            perm.requests = (perm.requests || 0) + 1;
            perm.state = perm.onRequest;
            return perm.state;
        },
        async isSameEntry(other) {
            return Boolean(other && other.tree === tree);
        },
    };
    return handle;
}

function fakeFile(name, bytes) {
    return { kind: "file", name, getFile: async () => sliceableFile(name, bytes) };
}

const song = (title, artist, extra = 2000) => buildMp3({ title, artist, audioBytes: extra });

function musicTree() {
    return {
        "Alpha - One.mp3": song("One", "Alpha"),
        "Beta - Two.mp3": song("Two", "Beta"),
        "cover.jpg": new Uint8Array([1, 2, 3]),
        "Live Album": { "Gamma - Three.mp3": song("Three", "Gamma") },
    };
}

const tick = () => new Promise((r) => setImmediate(r));

// ---------- storage.js ----------

test("storage: linked tracks save metadata + relative path only, never a blob or a URL", async () => {
    const store = memoryStore();
    const saved = await store.saveImportedTrack(
        { id: "local-x", title: "One", primaryArtist: "Alpha", storageMode: "linked", sourceId: "folder-1", relativePath: "Music/Alpha - One.mp3", audioUrl: "blob:session" },
        new Uint8Array([1, 2, 3])
    );
    assert.equal(saved.storageMode, "linked");
    assert.equal(saved.sourceId, "folder-1");
    assert.equal(saved.relativePath, "Music/Alpha - One.mp3");
    assert.equal(saved.audioUrl, "");
    assert.equal(await store.getAudioBlob("local-x"), null, "no copy of the audio");
    const [hydrated] = await store.getImportedTracks();
    assert.equal(hydrated.audioUrl, "", "no stale blob: URL after a reload");

    const copied = await store.saveImportedTrack({ id: "local-y", title: "Y" }, new Uint8Array([1]));
    assert.equal(copied.storageMode, "copy");
    assert.ok(await store.getAudioBlob("local-y"));
});

test("storage: folder sources, same-folder lookup, permission query/request and on-demand URLs", async () => {
    const store = memoryStore();
    const perm = { state: "prompt", onRequest: "granted", requests: 0 };
    const handle = fakeDir("Music", musicTree(), perm);
    const source = await store.saveFolderSource({ name: "Music", handle });
    assert.match(source.id, /^folder-music-/);
    assert.equal((await store.getFolderSources()).length, 1);
    assert.equal((await store.findFolderSourceForHandle(fakeDir("Music", handle.tree))).id, source.id, "isSameEntry match");
    assert.equal(await store.findFolderSourceForHandle(fakeDir("Music", musicTree())), null);

    assert.equal(await store.getFolderPermission(source), "prompt");
    assert.equal(perm.requests, 0, "query never prompts");
    const track = { id: "t3", storageMode: "linked", sourceId: source.id, relativePath: "Music/Live Album/Gamma - Three.mp3" };
    assert.deepEqual(await store.resolveLinkedTrackUrl(track), { url: null, status: "prompt" });
    const ok = await store.resolveLinkedTrackUrl(track, { request: true });
    assert.equal(ok.status, "ok");
    assert.match(ok.url, /^blob:/);
    assert.equal(perm.requests, 1);
    assert.equal((await store.resolveLinkedTrackUrl(track)).url, ok.url, "cached for the session");

    const gone = await store.resolveLinkedTrackUrl({ ...track, id: "t9", relativePath: "Music/Nope.mp3" });
    assert.equal(gone.status, "not-found");
    const orphan = await store.resolveLinkedTrackUrl({ ...track, id: "t8", sourceId: "folder-gone" });
    assert.equal(orphan.status, "missing");

    perm.state = "prompt";
    perm.onRequest = "denied";
    store.forgetLinkedTrackUrls(["t3"]);
    assert.equal((await store.resolveLinkedTrackUrl(track, { request: true })).status, "denied");
    await store.deleteFolderSource(source.id);
    assert.equal((await store.getFolderSources()).length, 0);
});

// ---------- library.js ----------

test("startInstantImport with linkSource saves without the file and keeps the raw relative path", async () => {
    const saves = [];
    const sessionUrls = [];
    const storage = {
        saveImportedTrack: async (meta, blob) => {
            saves.push({ meta, blob });
            return { ...meta, audioUrl: "" };
        },
        setLinkedTrackUrl: (id, url) => sessionUrls.push([id, url]),
    };
    const items = [{ file: sliceableFile("A <b> - Song.mp3", song("Song", "A")), relativePath: 'Music/"Odd" <dir>/A <b> - Song.mp3' }];
    const ctl = Library.startInstantImport(items, { storage, probeDuration: noProbe, createObjectUrl: () => "blob:session/1", linkSource: { id: "folder-1" } });
    assert.equal(ctl.tracks[0].storageMode, "linked");
    assert.equal(ctl.tracks[0].relativePath, 'Music/"Odd" <dir>/A <b> - Song.mp3', "path stays exact so it can be walked");
    assert.deepEqual(sessionUrls, [[ctl.tracks[0].id, "blob:session/1"]]);
    const result = await ctl.done;
    assert.equal(result.imported.length, 1);
    assert.equal(saves[0].blob, null, "no copy");
    assert.equal(saves[0].meta.storageMode, "linked");
    assert.equal(saves[0].meta.sourceId, "folder-1");
    assert.equal(saves[0].meta.relativePath, 'Music/"Odd" <dir>/A <b> - Song.mp3');
    assert.ok(saves[0].meta.importKey);
    assert.equal(ctl.tracks[0].audioUrl, "blob:session/1", "playing row keeps its session URL");
    assert.equal(ctl.tracks[0].title, "Song");
});

test("diffFolderScan finds added, removed and changed files by relative path; summarizeRescan words it", () => {
    const existing = [
        { id: "a", relativePath: "M/a.mp3", size: 10 },
        { id: "b", relativePath: "M/b.mp3", size: 10 },
        { id: "c", relativePath: "M/c.mp3", size: 10 },
    ];
    const f = (name, size) => ({ name, size, type: name.endsWith(".mp3") ? "audio/mpeg" : "text/plain" });
    const scanned = [
        { file: f("a.mp3", 10), relativePath: "M/a.mp3" },
        { file: f("c.mp3", 99), relativePath: "M/c.mp3" }, // re-encoded: re-read tags
        { file: f("d.mp3", 10), relativePath: "M/sub/d.mp3" },
        { file: f("notes.txt", 1), relativePath: "M/notes.txt" },
        { file: f(".hidden.mp3", 1), relativePath: "M/.hidden.mp3" },
    ];
    const diff = Library.diffFolderScan(existing, scanned);
    assert.deepEqual(diff.kept.map((t) => t.id), ["a"]);
    assert.deepEqual(diff.removed.map((t) => t.id), ["b", "c"]);
    assert.deepEqual(diff.added.map((i) => i.relativePath), ["M/c.mp3", "M/sub/d.mp3"]);
    assert.equal(Library.summarizeRescan("Music", diff), "Rescanned “Music” · 2 added · 2 removed");
    assert.equal(Library.summarizeRescan("Music", { added: [], removed: [] }), "Rescanned “Music” · no changes");
});

// ---------- player.js ----------

test("player resolves a missing audioUrl at play time, preloads silently, and reports unplayable tracks", async () => {
    const decks = [0, 1].map(() => ({ src: "", currentTime: 0, duration: 100, paused: true, dataset: {}, play() { this.paused = false; return Promise.resolve(); }, pause() { this.paused = true; }, addEventListener() {}, load() {} }));
    const unavailable = [];
    const asked = [];
    const engine = Player.createPlayerEngine({
        primaryAudio: decks[0],
        secondaryAudio: decks[1],
        AudioContext: null,
        storage: null,
        queueManager: null,
        mediaSession: null,
        resolveTrackUrl: async (track, ctx) => {
            asked.push([track.id, ctx.reason]);
            return track.id === "bad" ? null : `blob:resolved/${track.id}`;
        },
        onTrackUnavailable: (track) => unavailable.push(track.id),
    });
    const linked = { id: "lnk", title: "L", audioUrl: "", storageMode: "linked" };
    engine.loadAndPlayTrack(linked);
    assert.equal(decks[0].src, "", "waits for the URL");
    await tick();
    await tick();
    assert.equal(linked.audioUrl, "blob:resolved/lnk");
    assert.equal(engine.getActiveDeck().src, "blob:resolved/lnk");
    assert.equal(engine.getActiveDeck().paused, false);

    engine.preloadNextTrack({ id: "bad", audioUrl: "" });
    await tick();
    await tick();
    assert.deepEqual(unavailable, [], "a failed preload stays quiet");
    engine.loadAndPlayTrack({ id: "bad", audioUrl: "" });
    await tick();
    await tick();
    assert.deepEqual(unavailable, ["bad"]);
    assert.deepEqual(asked.map((a) => a[1]), ["play", "preload", "play"]);
});

// ---------- shell ----------

function linkedShell(tree = musicTree(), perm = { state: "granted", onRequest: "granted", requests: 0 }) {
    const handle = fakeDir("Music", tree, perm);
    const env = createShellSandbox({ showDirectoryPicker: async () => handle });
    env.handle = handle;
    env.perm = perm;
    env.store = env.sandbox.SpotTubeStorage;
    return env;
}

const linkedTracks = (shell) => shell.getImportedLocalTracks().filter((t) => t.storageMode === "linked");

test("shell: picking a folder links it (no copy) and Local Files shows the mode with Rescan", async () => {
    const { shell, el, store } = linkedShell();
    const result = await shell.openImportPicker({ folder: true });
    assert.equal(result.imported.length, 3);
    assert.equal(result.skipped.length, 1, "cover.jpg");
    const tracks = linkedTracks(shell);
    assert.equal(tracks.length, 3);
    for (const t of tracks) {
        assert.equal(await store.getAudioBlob(t.id), null, `${t.title} is not copied`);
        assert.match(t.audioUrl, /^blob:/, "playable right away this session");
    }
    assert.deepEqual(tracks.map((t) => t.relativePath).sort(), ["Music/Alpha - One.mp3", "Music/Beta - Two.mp3", "Music/Live Album/Gamma - Three.mp3"]);
    const sources = shell.getFolderSources();
    assert.equal(sources.length, 1);
    assert.equal(shell.getFolderSourceStatus(sources[0].id), "granted");
    assert.equal(el("local-sources").hidden, false);
    const html = el("local-sources-list").innerHTML;
    assert.match(html, /Linked folder · plays from your disk, nothing copied · 3 songs/);
    assert.match(html, /data-source-action="rescan"/);
    assert.match(html, /aria-label="Rescan Music for added or removed songs"/);
    assert.match(el("add-music-source-items").innerHTML, /Rescan “Music”/);
    assert.equal(el("add-music-source-items").hidden, false);
});

test("shell: after a reload linked songs wait for Reconnect, stay out of mixes, then play from the folder", async () => {
    const { shell, el, perm, sandbox } = linkedShell();
    await shell.openImportPicker({ folder: true });
    const ids = linkedTracks(shell).map((t) => t.id);

    // Simulate a reload: session URLs are gone and the browser forgot the permission
    perm.state = "prompt";
    for (const t of linkedTracks(shell)) t.audioUrl = "";
    sandbox.SpotTubeStorage.forgetLinkedTrackUrls(ids);
    await shell.initFolderSources();
    const [source] = shell.getFolderSources();
    assert.equal(shell.getFolderSourceStatus(source.id), "prompt");
    assert.ok(shell.getQueueCatalog().every((t) => !ids.includes(t.id)), "mixes skip songs that can't play yet");
    assert.equal(shell.getQueueCatalog().length, shell.getState().songs.length - 3);
    assert.match(el("local-sources-list").innerHTML, /Reconnect folder/);
    assert.match(el("local-sources-list").innerHTML, /Needs permission after reload/);
    assert.match(el("add-music-source-items").innerHTML, /Reconnect “Music”/);
    assert.match(el("lib-local-count").textContent, /reconnect needed/);

    // A play attempt without a user gesture can't prompt: it explains and offers Reconnect
    perm.onRequest = "prompt";
    const track = linkedTracks(shell)[0];
    assert.equal(await shell.resolveTrackAudioUrl(track, { request: true }), null);
    shell.handleUnavailableTrack(track);
    assert.equal(el("library-toast").textContent.startsWith("“Music” needs your permission again to play its songs."), true);
    assert.ok(el("library-toast").children.some((c) => c.textContent === "Reconnect folder"));
    await shell.reconnectFolderSource(source.id);
    assert.equal(el("library-toast").textContent.startsWith("“Music” is still waiting for permission."), true);
    assert.ok(el("library-toast").children.some((c) => c.textContent === "Try again"));

    // Reconnect with the user's click: permission granted, announced, mixes include the songs again
    perm.onRequest = "granted";
    const returnTo = el("some-button");
    const status = await shell.reconnectFolderSource(source.id, { returnFocus: returnTo });
    assert.equal(status, "granted");
    assert.equal(perm.requests, 3);
    assert.equal(el("import-live").textContent, "Reconnected “Music”. 3 songs are ready to play.");
    assert.equal(shell.getQueueCatalog().length, shell.getState().songs.length);
    assert.doesNotMatch(el("lib-local-count").textContent, /reconnect needed/);
    assert.match(el("local-sources-list").innerHTML, /Connected/);
    const url = await shell.resolveTrackAudioUrl(track);
    assert.match(url, /^blob:/);
    assert.equal(shell.getState().songs.find((t) => t.id === track.id).audioUrl, url);
});

test("shell: Rescan adds new files and drops removed ones; re-picking the same folder rescans it", async () => {
    const tree = musicTree();
    const { shell, el, handle } = linkedShell(tree);
    await shell.openImportPicker({ folder: true });
    const [source] = shell.getFolderSources();

    delete tree["Beta - Two.mp3"];
    tree["Delta - Four.mp3"] = song("Four", "Delta");
    tree["Live Album"]["Eps - Five.mp3"] = song("Five", "Eps");
    const diff = await shell.rescanFolderSource(source.id);
    assert.equal(diff.added.length, 2);
    assert.equal(diff.removed.length, 1);
    const titles = linkedTracks(shell).map((t) => t.title).sort();
    assert.deepEqual(titles, ["Five", "Four", "One", "Three"]);
    assert.equal(el("library-toast").textContent.startsWith("Rescanned “Music” · 2 added · 1 removed"), true);

    // Re-picking the same folder doesn't make a second source or duplicates
    const again = await shell.importFromFolderHandle(fakeDir("Music", handle.tree));
    assert.equal(again.added.length + again.removed.length, 0);
    assert.equal(shell.getFolderSources().length, 1);
    assert.equal(linkedTracks(shell).length, 4);
    assert.equal(el("library-toast").textContent.startsWith("Rescanned “Music” · no changes"), true);
});

test("shell: Remove takes two clicks, drops the folder's songs only, and says the files weren't touched", async () => {
    const { shell, el } = linkedShell();
    await shell.openImportPicker({ folder: true });
    await shell.importLocalAudioFiles([{ file: sliceableFile("Zed - Copied.mp3", song("Copied", "Zed")), relativePath: "Zed - Copied.mp3" }], { probeDuration: noProbe });
    const [source] = shell.getFolderSources();
    const summaries = shell.buildFolderSourceSummaries();
    assert.equal(JSON.stringify(summaries.map((s) => [s.kind, s.count])), JSON.stringify([["linked", 3], ["copy", 1]]));
    assert.match(el("local-sources-list").innerHTML, /Copied into this browser(&#39;|')s storage · 1 song/);

    const btn = el("forget-btn");
    btn.dataset.sourceAction = "forget";
    await shell.handleSourceAction("forget", source.id, btn);
    assert.equal(btn.textContent, "Click again to remove");
    assert.equal(linkedTracks(shell).length, 3, "first click only asks");
    await shell.handleSourceAction("forget", source.id, btn);
    assert.equal(linkedTracks(shell).length, 0);
    assert.equal(shell.getImportedLocalTracks().length, 1, "copied file stays");
    assert.equal(shell.getFolderSources().length, 0);
    assert.equal(el("library-toast").textContent.startsWith("Removed “Music” from your library. The files on your computer weren't touched."), true);
    assert.equal(el("add-music-source-items").hidden, true);
});

test("shell: a file deleted from disk explains itself and offers Rescan; an empty folder isn't kept as a source", async () => {
    const tree = musicTree();
    const { shell, el, sandbox } = linkedShell(tree);
    await shell.openImportPicker({ folder: true });
    const track = linkedTracks(shell).find((t) => t.title === "One");
    track.audioUrl = "";
    sandbox.SpotTubeStorage.forgetLinkedTrackUrls([track.id]);
    delete tree["Alpha - One.mp3"];

    assert.equal(await shell.resolveTrackAudioUrl(track, { request: true }), null);
    assert.equal(track.unavailableReason, "not-found");
    shell.handleUnavailableTrack(track);
    assert.equal(el("library-toast").textContent.startsWith("Couldn't find “One” in “Music”. It may have been moved or deleted."), true);
    assert.ok(el("library-toast").children.some((c) => c.textContent === "Rescan folder"));

    const empty = createShellSandbox({ showDirectoryPicker: async () => fakeDir("Empty", { "a.txt": new Uint8Array([1]) }) });
    await empty.shell.openImportPicker({ folder: true });
    assert.equal(empty.shell.getFolderSources().length, 0);
    assert.match(empty.el("library-toast").textContent, /^No music found in “Empty”/);
});

test("index.html, style.css and README hooks for linked folders", () => {
    const html = fs.readFileSync(path.join(ROOT_DIR, "index.html"), "utf8");
    const css = fs.readFileSync(path.join(ROOT_DIR, "style.css"), "utf8");
    assert.match(html, /<section class="local-sources" id="local-sources" aria-labelledby="local-sources-title" hidden>/);
    assert.match(html, /id="local-sources-title" tabindex="-1"/);
    assert.match(html, /id="add-music-source-items" role="group" aria-label="Your linked folders" hidden/);
    assert.match(css, /Item 14: linked folders/);
    assert.match(css, /\.local-source-actions \.detail-row-btn \{\s*min-block-size: 44px;/);
    const script = fs.readFileSync(path.join(ROOT_DIR, "script.js"), "utf8");
    assert.match(script, /await initFolderSources\(\);/);
    assert.ok(CATALOG.length > 0);
});
