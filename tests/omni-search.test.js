const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT_DIR = path.resolve(__dirname, "..");
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, "tracks.json"), "utf8"));
const CATALOG = manifest.tracks;

function createOmniSearchTestSandbox() {
    const storageJs = fs.readFileSync(path.join(ROOT_DIR, "storage.js"), "utf8");
    const recommenderJs = fs.readFileSync(path.join(ROOT_DIR, "recommender.js"), "utf8");
    const queueJs = fs.readFileSync(path.join(ROOT_DIR, "queue.js"), "utf8");
    const playerJs = fs.readFileSync(path.join(ROOT_DIR, "player.js"), "utf8");
    const scriptJs = fs.readFileSync(path.join(ROOT_DIR, "script.js"), "utf8");

    const elementsById = new Map();
    let focusedElementId = null;

    const makeEl = (id = "", tagName = "DIV") => {
        const listeners = new Map();
        const el = {
            id,
            tagName,
            hidden:
                id === "detail-view" ||
                id === "search-view" ||
                id === "search-empty-state" ||
                id === "search-clear-btn" ||
                id === "detail-audio-profile-section",
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

    const searchCatTabs = ["all", "songs", "artists", "albums", "moods"].map((cat) => {
        const tab = makeEl(`search-tab-${cat}`, "BUTTON");
        tab.dataset.searchTab = cat;
        tab.setAttribute("aria-selected", cat === "all" ? "true" : "false");
        return tab;
    });

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
            querySelectorAll(sel) {
                if (sel === "#search-category-tabs .search-cat-tab") {
                    return searchCatTabs;
                }
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
        searchCatTabs,
        getFocusedElementId: () => focusedElementId,
        setFocusedElementId: (id) => {
            focusedElementId = id;
        },
    };
}

test("index.html and style.css include Instant Omni-Search View structure, Top Result hero card, category tabs, and Start Search Mix button", () => {
    const html = fs.readFileSync(path.join(ROOT_DIR, "index.html"), "utf8");
    const css = fs.readFileSync(path.join(ROOT_DIR, "style.css"), "utf8");

    for (const id of [
        "search-view",
        "search-back-btn",
        "search-category-tabs",
        "search-hero-banner",
        "search-heading",
        "search-summary",
        "search-start-mix-btn",
        "search-start-mix-label",
        "search-play-all-btn",
        "search-queue-all-btn",
        "search-live-status",
        "search-top-grid",
        "search-top-result-section",
        "search-top-result-card",
        "search-top-result-cover",
        "search-top-result-badge",
        "search-top-result-title",
        "search-top-result-subtitle",
        "search-top-result-pills",
        "search-top-result-play-btn",
        "search-top-result-mix-btn",
        "search-top-result-detail-btn",
        "search-songs-section",
        "search-songs-list",
        "search-artists-section",
        "search-artists-grid",
        "search-albums-section",
        "search-albums-grid",
        "search-moods-section",
        "search-moods-grid",
        "search-empty-state",
    ]) {
        assert.ok(html.includes(`id="${id}"`), `index.html must include #${id} in Omni-Search View`);
    }

    for (const tab of ["all", "songs", "artists", "albums", "moods"]) {
        assert.ok(
            html.includes(`data-search-tab="${tab}"`),
            `index.html must include search category tab data-search-tab="${tab}"`
        );
    }

    for (const selector of [
        ".search-view",
        ".search-hero-banner",
        ".search-top-grid",
        ".search-top-result-card",
        ".search-entity-grid",
        ".search-moods-grid",
        ".search-mood-card",
    ]) {
        assert.ok(css.includes(selector), `style.css must define ${selector}`);
    }
});

test("buildOmniSearchResults performs live filtering across songs, artists, albums, and genres/moods and selects the right Top Result hero card", () => {
    const { shell } = createOmniSearchTestSandbox();

    // 1. Song title query -> Top Result is Song ("Espresso")
    const songRes = shell.buildOmniSearchResults("Espresso");
    assert.ok(songRes.hasExactMatches);
    assert.equal(songRes.topResult.type, "song");
    assert.equal(songRes.topResult.title, "Espresso");
    assert.equal(songRes.songs.length, 1);
    assert.equal(songRes.songs[0].id, "espresso-sabrina-carpenter");
    assert.ok(songRes.artists.some((a) => a.artist === "Sabrina Carpenter"));
    assert.ok(songRes.albums.some((alb) => alb.album.includes("Short n' Sweet")));

    // 2. Artist query -> Top Result is Artist ("Kendrick Lamar"), surfaces both primary & featured songs
    const artistRes = shell.buildOmniSearchResults("Kendrick Lamar");
    assert.ok(artistRes.hasExactMatches);
    assert.equal(artistRes.topResult.type, "artist");
    assert.equal(artistRes.topResult.title, "Kendrick Lamar");
    assert.equal(artistRes.songs.length, 2);
    const kendrickSongIds = artistRes.songs.map((s) => s.id);
    assert.ok(kendrickSongIds.includes("not-like-us-kendrick-lamar"));
    assert.ok(kendrickSongIds.includes("like-that-future"));
    assert.equal(artistRes.artists[0].artist, "Kendrick Lamar");

    // 3. Album query -> Top Result is Album ("Padmaavat")
    const albumRes = shell.buildOmniSearchResults("Padmaavat");
    assert.ok(albumRes.hasExactMatches);
    assert.equal(albumRes.topResult.type, "album");
    assert.equal(albumRes.topResult.title, "Padmaavat");
    assert.equal(albumRes.albums[0].album, "Padmaavat");
    assert.equal(albumRes.songs[0].id, "binte-dil-arijit-singh");

    // 4. Mood / Genre query -> Top Result is Mood/Genre ("Chill" & "Hip-Hop")
    const moodRes = shell.buildOmniSearchResults("Chill");
    assert.ok(moodRes.hasExactMatches);
    assert.equal(moodRes.topResult.type, "mood");
    assert.equal(moodRes.topResult.title, "Chill");
    assert.ok(moodRes.songs.length >= 4);
    assert.ok(moodRes.moods.some((m) => m.name === "Chill"));

    const genreRes = shell.buildOmniSearchResults("Hip-Hop");
    assert.ok(genreRes.hasExactMatches);
    assert.equal(genreRes.topResult.type, "genre");
    assert.equal(genreRes.topResult.title, "Hip-Hop");
    assert.ok(genreRes.songs.length >= 2);
    assert.ok(
        genreRes.songs.every(
            (t) =>
                t.genre === "Hip-Hop" ||
                (Array.isArray(t.subgenres) &&
                    t.subgenres.some((sg) => sg.toLowerCase().includes("hip-hop")))
        )
    );

    // 5. Multi-token query ("arijit romantic") -> matches across artist + mood
    const multiTokenRes = shell.buildOmniSearchResults("arijit romantic");
    assert.ok(multiTokenRes.hasExactMatches);
    assert.ok(multiTokenRes.songs.length >= 1);
    assert.ok(
        multiTokenRes.songs.every((t) =>
            t.artistDisplay.toLowerCase().includes("arijit") &&
            t.moods.some((m) => m.toLowerCase() === "romantic")
        )
    );

    // 6. Zero literal match query ("cyberpunk quantum 2099") -> fallback sonic station
    const zeroMatchRes = shell.buildOmniSearchResults("cyberpunk quantum 2099");
    assert.equal(zeroMatchRes.hasExactMatches, false);
    assert.equal(zeroMatchRes.songs.length, 0);
    assert.ok(zeroMatchRes.seedTracks.length >= 3, "Must still provide fallback sonic seed tracks for Start Search Mix");
    assert.equal(zeroMatchRes.topResult.type, "search");
});

test("live typing via setSearchQuery updates Omni-Search View DOM, supports category filtering, and preserves input focus", () => {
    const { shell, elementsById, searchCatTabs, getFocusedElementId, setFocusedElementId } =
        createOmniSearchTestSandbox();

    // Simulate user focusing #search-input and typing "Arijit"
    setFocusedElementId("search-input");
    const res = shell.setSearchQuery("Arijit", { fromInput: true });

    assert.equal(shell.getState().activeView, "search");
    assert.equal(shell.getState().activeSearchQuery, "Arijit");
    assert.equal(elementsById.get("search-view").hidden, false);
    assert.equal(elementsById.get("hero-mix-banner").hidden, true);
    assert.equal(elementsById.get("catalog-section").hidden, true);
    assert.equal(
        getFocusedElementId(),
        "search-input",
        "Live typing in #search-input must not steal focus away from #search-input"
    );

    assert.equal(elementsById.get("search-heading").textContent, 'Results for "Arijit"');
    assert.equal(elementsById.get("search-top-result-title").textContent, "Arijit Singh");
    assert.equal(elementsById.get("search-top-result-badge").textContent, "TOP RESULT • ARTIST");
    assert.equal(elementsById.get("search-songs-list").children.length, res.songs.length);
    assert.ok(elementsById.get("search-artists-grid").children.length >= 1);
    assert.ok(elementsById.get("search-albums-grid").children.length >= 1);
    assert.ok(elementsById.get("search-live-status").textContent.includes("Arijit"));

    // Filter by category tab ("artists" vs "songs" vs "all")
    shell.setSearchCategory("artists");
    assert.equal(shell.getState().activeSearchCategory, "artists");
    assert.equal(elementsById.get("search-top-result-section").hidden, true);
    assert.equal(elementsById.get("search-songs-section").hidden, true);
    assert.equal(elementsById.get("search-artists-section").hidden, false);
    assert.equal(elementsById.get("search-albums-section").hidden, true);
    assert.equal(searchCatTabs.find((t) => t.dataset.searchTab === "artists").getAttribute("aria-selected"), "true");

    shell.setSearchCategory("all");
    assert.equal(elementsById.get("search-top-result-section").hidden, false);
    assert.equal(elementsById.get("search-songs-section").hidden, false);
    assert.equal(elementsById.get("search-artists-section").hidden, false);

    // Clearing the query returns smoothly to Home view
    shell.setSearchQuery("", { fromInput: true });
    assert.equal(shell.getState().activeView, "home");
    assert.equal(elementsById.get("search-view").hidden, true);
    assert.equal(elementsById.get("hero-mix-banner").hidden, false);
    assert.equal(elementsById.get("catalog-section").hidden, false);
});

test("startSearchMix turns any search query into an endless tailored radio station and supports drill-down navigation", () => {
    const { shell, sandbox, elementsById } = createOmniSearchTestSandbox();

    // 1. Type "Bollywood" and start Search Mix
    shell.setSearchQuery("Bollywood");
    const mixResult = shell.startSearchMix();
    assert.ok(mixResult);
    assert.equal(mixResult.mixSession.type, "search");
    assert.equal(mixResult.mixSession.badge, "SEARCH MIX");
    assert.equal(mixResult.mixSession.label, 'Search Mix: "Bollywood"');
    assert.ok(mixResult.currentTrack);
    assert.ok(mixResult.queue.length >= 8, "Search Mix must populate an endless upcoming radio queue");
    assert.equal(elementsById.get("mix-active-badge").textContent, "SEARCH MIX");
    assert.equal(elementsById.get("mix-seed-label").textContent, 'Search Mix: "Bollywood"');

    // Verify nonstop replenishment works on the Search Mix station
    for (let i = 0; i < 15; i++) {
        const next = sandbox.SpotTubeQueue.advanceNext();
        assert.ok(next && next.id);
        assert.ok(sandbox.SpotTubeQueue.getQueue().length >= 3);
    }

    // 2. Even a zero-match custom query turns into a working Search Mix station
    const customMix = shell.startSearchMix("midnight lo-fi coding");
    assert.equal(customMix.mixSession.badge, "SEARCH MIX");
    assert.equal(customMix.mixSession.label, 'Search Mix: "midnight lo-fi coding"');
    assert.ok(customMix.currentTrack);
    assert.ok(customMix.queue.length >= 8);

    // 3. Drill-down from Search View -> Artist Detail View -> Back returns to Search View
    shell.openSearchView("Sabrina");
    assert.equal(shell.getState().activeView, "search");
    shell.openArtistDetail("Sabrina Carpenter");
    assert.equal(shell.getState().activeView, "detail");
    assert.equal(elementsById.get("detail-view").hidden, false);
    assert.equal(elementsById.get("search-view").hidden, true);

    shell.navigateBack();
    assert.equal(shell.getState().activeView, "search");
    assert.equal(shell.getState().activeSearchQuery, "Sabrina");
    assert.equal(elementsById.get("search-view").hidden, false);
    assert.equal(elementsById.get("detail-view").hidden, true);
});
