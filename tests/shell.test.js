const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT_DIR = path.resolve(__dirname, "..");

test("index.html implements the 3-pane Spotify + YT Music hybrid shell structure", () => {
    const html = fs.readFileSync(path.join(ROOT_DIR, "index.html"), "utf8");

    // App shell & 3-pane landmarks
    assert.ok(html.includes('class="app-shell"'), "Must include .app-shell wrapper");
    assert.ok(html.includes('id="left-sidebar"'), "Must include Pane 1: #left-sidebar");
    assert.ok(html.includes('id="center-main"'), "Must include Pane 2: #center-main");
    assert.ok(html.includes('id="right-drawer"'), "Must include Pane 3: #right-drawer");
    assert.ok(html.includes('class="playbar"'), "Must include bottom .playbar");

    // Left Library Sidebar elements
    assert.ok(html.includes('id="library-filters"'), "Must include library filter chips container");
    for (const filter of ["all", "tracks", "artists", "albums", "playlists"]) {
        assert.ok(
            html.includes(`data-lib-filter="${filter}"`),
            `Left sidebar must include library filter pill: ${filter}`
        );
    }
    assert.ok(html.includes('id="lib-liked-songs"'), "Must include pinned Liked Songs item");
    assert.ok(html.includes('id="lib-supermix"'), "Must include pinned Your Supermix Radio item");
    assert.ok(html.includes('id="library-tracks-list"'), "Must include dynamic #library-tracks-list");

    // Center Main View: Navigation history, Omni-Search, and YT Music mood chips
    assert.ok(html.includes('id="nav-back"'), "Must include #nav-back history button");
    assert.ok(html.includes('id="nav-forward"'), "Must include #nav-forward history button");
    assert.ok(html.includes('id="search-input"'), "Must include top #search-input");
    assert.ok(html.includes('id="search-mix-btn"'), "Must include quick search mix button");
    assert.ok(html.includes('id="mood-chips-bar"'), "Must include YT Music #mood-chips-bar");

    for (const mood of [
        "All",
        "Upbeat",
        "Chill",
        "Energetic",
        "Feel Good",
        "Romantic",
        "Late Night",
        "Workout",
        "Focus",
        "Party",
        "Deep Cuts",
        "Soulful",
    ]) {
        assert.ok(
            html.includes(`data-mood="${mood}"`),
            `Center view must include YT Music mood chip: ${mood}`
        );
    }

    assert.ok(html.includes('id="hero-mix-banner"'), "Must include hybrid #hero-mix-banner");
    assert.ok(html.includes('class="spotify-playlist"'), "Must preserve .spotify-playlist track grid");

    // Collapsible Right Drawer: Up Next / Radio Mix / Track Info
    assert.ok(html.includes('id="toggle-drawer-btn"'), "Navbar must include #toggle-drawer-btn");
    assert.ok(html.includes('id="tab-up-next"'), "Right drawer must include #tab-up-next");
    assert.ok(html.includes('id="tab-track-info"'), "Right drawer must include #tab-track-info");
    assert.ok(html.includes('id="panel-up-next"'), "Right drawer must include #panel-up-next");
    assert.ok(html.includes('id="panel-track-info"'), "Right drawer must include #panel-track-info");
    assert.ok(html.includes('id="mix-tuning-chips"'), "Right drawer must include YT Music #mix-tuning-chips");

    for (const mode of ["all", "familiar", "discover", "deep-cuts", "upbeat", "chill"]) {
        assert.ok(
            html.includes(`data-mix-mode="${mode}"`),
            `Right drawer must include dynamic mix tuning chip: ${mode}`
        );
    }

    assert.ok(html.includes('id="drawer-now-playing"'), "Right drawer must include #drawer-now-playing");
    assert.ok(html.includes('id="queue-list"'), "Right drawer must include #queue-list");
    assert.ok(html.includes('id="info-features"'), "Right drawer must include #info-features");

    // Enhanced Bottom Playbar
    for (const id of [
        "playbar-cover",
        "playbar-meta-badge",
        "like-btn",
        "playbar-mix-btn",
        "shuffle",
        "previous",
        "play",
        "next",
        "repeat",
        "crossfade-badge",
        "volume-btn",
        "playbar-queue-btn",
        "queue-count-badge",
    ]) {
        assert.ok(html.includes(`id="${id}"`), `Playbar must include #${id}`);
    }
});

test("style.css implements full-viewport 3-pane grid, collapsible drawer state, and modern scrollbar rules", () => {
    const css = fs.readFileSync(path.join(ROOT_DIR, "style.css"), "utf8");

    assert.ok(css.includes("100dvh"), "Must use dynamic viewport height (100dvh) for full-viewport layout");
    assert.ok(css.includes(".app-shell"), "Must style .app-shell");
    assert.ok(css.includes(".container.drawer-collapsed"), "Must support collapsible right drawer state");
    assert.ok(css.includes("scrollbar-color:"), "Must use standard scrollbar-color property");
    assert.ok(css.includes("scrollbar-width: thin"), "Must use standard scrollbar-width: thin");
    assert.ok(
        css.includes("@supports not (scrollbar-color: auto)"),
        "Must wrap legacy ::-webkit-scrollbar rules in @supports not (scrollbar-color: auto)"
    );
    assert.ok(css.includes("@media screen and (max-width: 980px)"), "Must include tablet responsive breakpoint");
    assert.ok(css.includes("@media screen and (max-width: 740px)"), "Must include mobile responsive breakpoint");
});

test("script.js wires 3-pane shell interactions (mood filtering, drawer toggle, tabs, queue, track info)", () => {
    const js = fs.readFileSync(path.join(ROOT_DIR, "script.js"), "utf8");
    const manifest = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, "tracks.json"), "utf8"));

    for (const fnName of [
        "getFilteredSongs",
        "renderCatalogGrid",
        "renderLibrarySidebar",
        "renderDrawerNowPlaying",
        "renderDrawerQueue",
        "renderDrawerTrackInfo",
        "setMoodFilter",
        "toggleRightDrawer",
        "switchDrawerTab",
        "initShellControls",
    ]) {
        assert.ok(js.includes(`function ${fnName}`), `script.js must define ${fnName}()`);
    }

    // Execute script.js in a minimal DOM sandbox and test SpotTubeShell runtime behavior
    const elementsById = new Map();
    const makeEl = (id = "") => ({
        id,
        hidden: false,
        textContent: "",
        innerHTML: "",
        value: "",
        src: "",
        dataset: {},
        style: { setProperty() {} },
         attributes: new Map(),
        classes: new Set(),
        classList: {
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
            _set: new Set(),
        },
        setAttribute(k, v) {
            this.attributes.set(k, v);
        },
        getAttribute(k) {
            return this.attributes.get(k);
        },
        addEventListener() {},
        replaceChildren() {},
        querySelector() {
            return makeEl();
        },
        getElementsByTagName() {
            return [makeEl()];
        },
    });

    for (const id of [
        "app-container",
        "toggle-drawer-btn",
        "playbar-queue-btn",
        "tab-up-next",
        "tab-track-info",
        "panel-up-next",
        "panel-track-info",
        "catalog-section-title",
        "catalog-count-badge",
        "stat-track-count",
        "stat-active-mood",
        "queue-list",
        "drawer-queue-summary",
        "queue-count-badge",
        "drawer-now-playing",
        "info-title",
        "info-artists",
        "info-album-year",
        "info-genre",
        "info-language",
        "info-quality",
        "info-mood-tags",
        "info-features",
    ]) {
        elementsById.set(id, makeEl(id));
    }

    const sandbox = {
        window: {},
        console,
        Audio: function () {
            this.paused = true;
            this.volume = 1;
            this.muted = false;
            this.play = () => Promise.resolve();
            this.pause = () => {};
            this.addEventListener = () => {};
        },
        fetch: async () => ({
            ok: true,
            json: async () => manifest,
        }),
        document: {
            readyState: "loading",
            addEventListener() {},
            getElementById(id) {
                if (!elementsById.has(id)) elementsById.set(id, makeEl(id));
                return elementsById.get(id);
            },
            getElementsByClassName() {
                return [makeEl()];
            },
            querySelector() {
                return makeEl();
            },
            querySelectorAll() {
                return [];
            },
            createElement() {
                return makeEl();
            },
        },
    };

    vm.runInNewContext(js, sandbox);
    const shell = sandbox.window.SpotTubeShell;
    assert.ok(shell, "window.SpotTubeShell must be exposed");

    shell.setState({ songs: manifest.tracks, currentTrackIndex: 0 });

    // Mood filtering
    shell.setMoodFilter("Upbeat");
    const upbeatTracks = shell.getFilteredSongs();
    assert.ok(upbeatTracks.length > 0 && upbeatTracks.length < manifest.tracks.length);
    assert.ok(upbeatTracks.every((t) => t.moods.includes("Upbeat")));

    // Search query filtering
    shell.setMoodFilter("All");
    shell.setState({ activeSearchQuery: "Sabrina" });
    const sabrinaTracks = shell.getFilteredSongs();
    assert.equal(sabrinaTracks.length, 1);
    assert.equal(sabrinaTracks[0].title, "Espresso");
    shell.setState({ activeSearchQuery: "" });

    // Dynamic mix tuning modes in Up Next drawer
    shell.setState({ activeMixMode: "upbeat" });
    const upbeatQueue = shell.getUpcomingQueueTracks();
    assert.equal(upbeatQueue.length, 11);
    assert.ok(upbeatQueue[0].energy >= upbeatQueue[upbeatQueue.length - 1].energy);

    shell.setState({ activeMixMode: "deep-cuts" });
    const deepCutsQueue = shell.getUpcomingQueueTracks();
    assert.ok(deepCutsQueue[0].popularity <= deepCutsQueue[deepCutsQueue.length - 1].popularity);

    // Drawer collapse / expand
    shell.toggleRightDrawer(false);
    assert.equal(shell.getState().isDrawerOpen, false);
    assert.ok(elementsById.get("app-container").classList.contains("drawer-collapsed"));
    assert.equal(elementsById.get("toggle-drawer-btn").getAttribute("aria-expanded"), "false");

    shell.toggleRightDrawer(true);
    assert.equal(shell.getState().isDrawerOpen, true);
    assert.ok(!elementsById.get("app-container").classList.contains("drawer-collapsed"));

    // Drawer tab switching
    shell.switchDrawerTab("track-info");
    assert.equal(shell.getState().activeDrawerTab, "track-info");
    assert.equal(elementsById.get("panel-up-next").hidden, true);
    assert.equal(elementsById.get("panel-track-info").hidden, false);

    shell.switchDrawerTab("up-next");
    assert.equal(shell.getState().activeDrawerTab, "up-next");
    assert.equal(elementsById.get("panel-up-next").hidden, false);
    assert.equal(elementsById.get("panel-track-info").hidden, true);
});
