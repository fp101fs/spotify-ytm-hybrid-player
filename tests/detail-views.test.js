const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT_DIR = path.resolve(__dirname, "..");
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, "tracks.json"), "utf8"));
const CATALOG = manifest.tracks;

function createDetailTestSandbox() {
    const storageJs = fs.readFileSync(path.join(ROOT_DIR, "storage.js"), "utf8");
    const recommenderJs = fs.readFileSync(path.join(ROOT_DIR, "recommender.js"), "utf8");
    const queueJs = fs.readFileSync(path.join(ROOT_DIR, "queue.js"), "utf8");
    const playerJs = fs.readFileSync(path.join(ROOT_DIR, "player.js"), "utf8");
    const scriptJs = fs.readFileSync(path.join(ROOT_DIR, "script.js"), "utf8");

    const elementsById = new Map();
    let focusedElementId = null;
    let viewTransitionCount = 0;

    const makeEl = (id = "", tagName = "DIV") => {
        const listeners = new Map();
        const el = {
            id,
            tagName,
            hidden: id === "detail-view" || id === "search-view" || id === "detail-audio-profile-section",
            disabled: false,
            textContent: "",
            innerHTML: "",
            title: "",
            value: "",
            src: "",
            alt: "",
            dataset: {},
            children: [],
            style: { setProperty() {} },
            attributes: new Map(),
            classList: {
                _set: new Set(),
                toggle(cls, force) {
                    const next = typeof force === "boolean" ? force : !this._set.has(cls);
                    if (next) this._set.add(cls);
                    else this._set.delete(cls);
                    return next;
                },
                contains(cls) {
                    return this._set.has(cls);
                },
                add(cls) {
                    this._set.add(cls);
                },
                remove(cls) {
                    this._set.delete(cls);
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
                focusedElementId = this.id || this.tagName;
            },
            addEventListener(type, fn) {
                if (!listeners.has(type)) listeners.set(type, []);
                listeners.get(type).push(fn);
            },
            trigger(type, eventPatch = {}) {
                const fns = listeners.get(type) || [];
                for (const fn of fns) {
                    fn({
                        preventDefault() {},
                        stopPropagation() {},
                        currentTarget: this,
                        target: this,
                        ...eventPatch,
                    });
                }
            },
            replaceChildren(...nodes) {
                this.children = nodes;
            },
            append(node) {
                this.children.push(node);
            },
            moveBefore(node) {
                const idx = this.children.indexOf(node);
                if (idx !== -1) this.children.splice(idx, 1);
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
        return el;
    };

    const sandbox = {
        window: {},
        globalThis: {},
        console,
        Audio: function () {
            this.paused = true;
            this.volume = 1;
            this.muted = false;
            this.currentTime = 0;
            this.duration = 200;
            this.play = () => {
                this.paused = false;
                return Promise.resolve();
            };
            this.pause = () => {
                this.paused = true;
            };
            this.addEventListener = () => {};
        },
        fetch: async () => ({
            ok: true,
            json: async () => manifest,
        }),
        document: {
            readyState: "loading",
            addEventListener() {},
            startViewTransition(cb) {
                viewTransitionCount++;
                cb();
                return {
                    finished: Promise.resolve(),
                };
            },
            getElementById(id) {
                if (!elementsById.has(id)) {
                    elementsById.set(id, makeEl(id));
                }
                return elementsById.get(id);
            },
            getElementsByClassName(cls) {
                const key = `class:${cls}`;
                if (!elementsById.has(key)) {
                    elementsById.set(key, makeEl(key));
                }
                return [elementsById.get(key)];
            },
            querySelector(sel) {
                if (sel.startsWith("#")) {
                    return this.getElementById(sel.slice(1));
                }
                return makeEl(sel);
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

    vm.runInNewContext(storageJs, sandbox);
    vm.runInNewContext(recommenderJs, sandbox);
    vm.runInNewContext(queueJs, sandbox);
    vm.runInNewContext(playerJs, sandbox);
    vm.runInNewContext(scriptJs, sandbox);

    const shell = sandbox.SpotTubeShell;
    shell.setState({ songs: CATALOG, currentTrackIndex: 0 });

    return {
        sandbox,
        shell,
        elementsById,
        getFocusedElementId: () => focusedElementId,
        getViewTransitionCount: () => viewTransitionCount,
    };
}

test("index.html and style.css include dedicated Artist, Album, and Song Detail View structure and hero Start Mix button", () => {
    const html = fs.readFileSync(path.join(ROOT_DIR, "index.html"), "utf8");
    const css = fs.readFileSync(path.join(ROOT_DIR, "style.css"), "utf8");

    for (const id of [
        "detail-view",
        "detail-back-btn",
        "detail-breadcrumbs",
        "detail-hero",
        "detail-cover",
        "detail-type-badge",
        "detail-heading",
        "detail-subtitle",
        "detail-meta-pills",
        "detail-collaborators",
        "detail-start-mix-btn",
        "detail-play-all-btn",
        "detail-shuffle-btn",
        "detail-queue-all-btn",
        "detail-top-tracks-section",
        "detail-top-tracks",
        "detail-audio-profile-section",
        "detail-audio-profile",
        "detail-discography-section",
        "detail-discography",
        "detail-similar-section",
        "detail-similar-tracks",
    ]) {
        assert.ok(html.includes(`id="${id}"`), `index.html must include #${id} in Detail View`);
    }

    assert.ok(
        html.includes('id="detail-heading" tabindex="-1"'),
        "#detail-heading must include tabindex=\"-1\" for View Transition accessibility focus routing"
    );

    for (const selector of [
        ".detail-view",
        ".detail-hero",
        ".detail-type-badge",
        ".detail-track-row",
        ".detail-discography-grid",
        ".detail-album-card",
        ".detail-similar-grid",
        ".detail-similar-card",
    ]) {
        assert.ok(css.includes(selector), `style.css must define ${selector}`);
    }
});

test("buildArtistDetailData aggregates primary & featured tracks, collaborators, discography, and Similar in Your Library recommendations", () => {
    const { shell, sandbox } = createDetailTestSandbox();

    // 1. Kendrick Lamar appears as primary artist on "Not Like Us" and featured artist on "Like That"
    const kendrickData = shell.buildArtistDetailData("Kendrick Lamar");
    assert.equal(kendrickData.type, "artist");
    assert.equal(kendrickData.artist, "Kendrick Lamar");
    assert.equal(kendrickData.trackCount, 2);
    const kendrickTrackIds = kendrickData.topTracks.map((t) => t.id);
    assert.ok(kendrickTrackIds.includes("not-like-us-kendrick-lamar"));
    assert.ok(kendrickTrackIds.includes("like-that-future"));
    assert.ok(kendrickData.collaborators.includes("Future"));
    assert.ok(kendrickData.collaborators.includes("Metro Boomin"));
    assert.ok(kendrickData.discography.length >= 2, "Must include direct and collaborator albums in discography");
    assert.ok(kendrickData.similarTracks.length > 0, "Must include Similar in Your Library recommendations");
    assert.ok(
        kendrickData.similarTracks.every((t) => !kendrickTrackIds.includes(t.id)),
        "Similar in Your Library must exclude the artist's own tracks"
    );
    assert.ok(
        kendrickData.similarTracks[0].recommendation?.primaryReason,
        "Each similar track must include a recommendation reason badge"
    );

    // 2. Mohit Chauhan has 2 tracks ("Matargashti" and "Tum Ho") and taste affinity ranking works
    sandbox.SpotTubeStorage.setLike("tum-ho-mohit-chauhan", true);
    sandbox.SpotTubeStorage.recordPlaybackOutcome("tum-ho-mohit-chauhan", {
        listenedSeconds: 318,
        durationSeconds: 318,
        endedNaturally: true,
    });
    const mohitData = shell.buildArtistDetailData("Mohit Chauhan");
    assert.equal(mohitData.trackCount, 2);
    assert.equal(
        mohitData.topTracks[0].id,
        "tum-ho-mohit-chauhan",
        "Liked and completed track should rank #1 in artist Top Tracks"
    );
    assert.ok(mohitData.collaborators.includes("A.R. Rahman"));
    assert.ok(mohitData.collaborators.includes("Suzanne D'Mello"));
});

test("buildAlbumDetailData and buildSongDetailData build complete tracklists, audio profiles, discography, and similar tracks", () => {
    const { shell } = createDetailTestSandbox();

    // 1. Album Detail View data for "WE DON'T TRUST YOU"
    const albumData = shell.buildAlbumDetailData("WE DON'T TRUST YOU");
    assert.equal(albumData.type, "album");
    assert.equal(albumData.album, "WE DON'T TRUST YOU");
    assert.equal(albumData.year, 2024);
    assert.equal(albumData.genre, "Hip-Hop");
    assert.ok(albumData.artists.includes("Future"));
    assert.ok(albumData.artists.includes("Metro Boomin"));
    assert.ok(albumData.artists.includes("Kendrick Lamar"));
    assert.equal(albumData.topTracks.length, 1);
    assert.equal(albumData.topTracks[0].id, "like-that-future");
    assert.ok(
        albumData.discography.some((d) => d.album === "Not Like Us (Single)"),
        "Album discography must include 'More by Kendrick Lamar' related releases"
    );
    assert.ok(albumData.similarTracks.length >= 4);
    assert.ok(albumData.similarTracks.every((t) => t.id !== "like-that-future"));

    // 2. Song Detail View data for "Ve Kamleya"
    const songData = shell.buildSongDetailData("ve-kamleya-pritam");
    assert.equal(songData.type, "song");
    assert.equal(songData.title, "Ve Kamleya");
    assert.equal(songData.album, "Rocky Aur Rani Kii Prem Kahaani");
    assert.ok(songData.artists.includes("Pritam"));
    assert.ok(songData.artists.includes("Arijit Singh"));
    assert.ok(songData.artists.includes("Shreya Ghoshal"));
    assert.ok(
        songData.topTracks.some((t) => t.id === "binte-dil-arijit-singh"),
        "Song detail topTracks should also surface other songs by co-credited artist Arijit Singh"
    );
    assert.ok(Array.isArray(songData.audioProfile.metrics));
    assert.equal(songData.audioProfile.metrics.length, 7);
    assert.ok(songData.similarTracks.length >= 4);
    assert.ok(songData.similarTracks.every((t) => t.id !== "ve-kamleya-pritam"));
});

test("opening Artist, Album, and Song Detail Views updates DOM, routes accessibility focus, triggers one-click Start Mix, and supports Back/Forward navigation", () => {
    const { shell, elementsById, getFocusedElementId, getViewTransitionCount } =
        createDetailTestSandbox();

    // 1. Open Artist Detail View for "Arijit Singh"
    const artistDetail = shell.openArtistDetail("Arijit Singh");
    assert.ok(artistDetail);
    assert.equal(shell.getState().activeView, "detail");
    assert.equal(shell.getState().activeDetail.type, "artist");
    assert.equal(shell.getState().activeDetail.id, "Arijit Singh");
    assert.equal(elementsById.get("detail-view").hidden, false);
    assert.equal(elementsById.get("hero-mix-banner").hidden, true);
    assert.equal(elementsById.get("catalog-section").hidden, true);
    assert.equal(elementsById.get("detail-heading").textContent, "Arijit Singh");
    assert.equal(elementsById.get("detail-type-badge").textContent, "ARTIST");
    assert.equal(
        getFocusedElementId(),
        "detail-heading",
        "Opening Detail View must route programmatic focus to #detail-heading"
    );
    assert.ok(getViewTransitionCount() >= 1, "Must use document.startViewTransition when supported");
    assert.equal(elementsById.get("detail-top-tracks").children.length, 2);
    assert.ok(elementsById.get("detail-discography").children.length >= 2);
    assert.ok(elementsById.get("detail-similar-tracks").children.length >= 4);

    // One-click "Start Mix" from Artist Detail View
    const artistMix = shell.startDetailMix();
    assert.equal(artistMix.mixSession.badge, "ARTIST RADIO");
    assert.equal(artistMix.mixSession.label, "Arijit Singh Radio");

    // 2. Navigate from Artist Detail -> Album Detail ("Padmaavat")
    const albumDetail = shell.openAlbumDetail("Padmaavat");
    assert.ok(albumDetail);
    assert.equal(shell.getState().activeDetail.type, "album");
    assert.equal(elementsById.get("detail-heading").textContent, "Padmaavat");
    assert.equal(elementsById.get("detail-type-badge").textContent, "ALBUM");
    assert.equal(elementsById.get("detail-start-mix-label").textContent, "Start Album Mix");

    // One-click "Start Mix" from Album Detail View
    const albumMix = shell.startDetailMix();
    assert.equal(albumMix.mixSession.badge, "ALBUM RADIO");
    assert.equal(albumMix.mixSession.label, "Padmaavat Radio");

    // 3. Navigate from Album Detail -> Song Detail ("binte-dil-arijit-singh")
    const songDetail = shell.openSongDetail("binte-dil-arijit-singh");
    assert.ok(songDetail);
    assert.equal(shell.getState().activeDetail.type, "song");
    assert.equal(elementsById.get("detail-heading").textContent, "Binte Dil");
    assert.equal(elementsById.get("detail-type-badge").textContent, "SONG");
    assert.equal(elementsById.get("detail-audio-profile-section").hidden, false);

    // One-click "Start Mix" from Song Detail View
    const songMix = shell.startDetailMix();
    assert.equal(songMix.mixSession.badge, "TRACK RADIO");
    assert.ok(songMix.mixSession.label.includes("Binte Dil"));

    // 4. Test Back & Forward history navigation across Detail Views and Home
    shell.navigateBack();
    assert.equal(shell.getState().activeView, "detail");
    assert.equal(shell.getState().activeDetail.type, "album");
    assert.equal(elementsById.get("detail-heading").textContent, "Padmaavat");

    shell.navigateBack();
    assert.equal(shell.getState().activeView, "detail");
    assert.equal(shell.getState().activeDetail.type, "artist");
    assert.equal(elementsById.get("detail-heading").textContent, "Arijit Singh");

    shell.navigateBack();
    assert.equal(shell.getState().activeView, "home");
    assert.equal(shell.getState().activeDetail, null);
    assert.equal(elementsById.get("detail-view").hidden, true);
    assert.equal(elementsById.get("hero-mix-banner").hidden, false);
    assert.equal(elementsById.get("catalog-section").hidden, false);
    assert.equal(
        getFocusedElementId(),
        "catalog-section-title",
        "Closing Detail View must return programmatic focus to #catalog-section-title"
    );

    // Forward navigation re-opens Artist Detail View
    shell.navigateForward();
    assert.equal(shell.getState().activeView, "detail");
    assert.equal(shell.getState().activeDetail.type, "artist");
    assert.equal(elementsById.get("detail-heading").textContent, "Arijit Singh");

    // Escape key closes Detail View back to Home
    shell.handleShellKeyDown({
        key: "Escape",
        target: { tagName: "BODY" },
        preventDefault() {},
    });
    assert.equal(shell.getState().activeView, "home");
    assert.equal(elementsById.get("detail-view").hidden, true);
});
