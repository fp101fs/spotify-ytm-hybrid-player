const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT_DIR = path.resolve(__dirname, "..");
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, "tracks.json"), "utf8"));
const CATALOG = manifest.tracks;

function createSmartMixesTestSandbox() {
    const storageJs = fs.readFileSync(path.join(ROOT_DIR, "storage.js"), "utf8");
    const recommenderJs = fs.readFileSync(path.join(ROOT_DIR, "recommender.js"), "utf8");
    const queueJs = fs.readFileSync(path.join(ROOT_DIR, "queue.js"), "utf8");
    const playerJs = fs.readFileSync(path.join(ROOT_DIR, "player.js"), "utf8");
    const scriptJs = fs.readFileSync(path.join(ROOT_DIR, "script.js"), "utf8");

    const elementsById = new Map();

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
            focus() {},
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
    };
}

test("index.html and style.css include Home Dashboard shelves for Your Supermix, Daily Mix 1–3, Jump Back In, On Repeat, and Rediscover", () => {
    const html = fs.readFileSync(path.join(ROOT_DIR, "index.html"), "utf8");
    const css = fs.readFileSync(path.join(ROOT_DIR, "style.css"), "utf8");

    for (const id of [
        "home-shelves",
        "shelf-smart-mixes",
        "shelf-smart-mixes-title",
        "shelf-smart-mixes-meta",
        "shelf-supermix-btn",
        "smart-mixes-grid",
        "shelf-jump-back-in",
        "shelf-jump-back-in-title",
        "shelf-jump-back-in-meta",
        "shelf-jump-back-in-mix-btn",
        "jump-back-in-grid",
        "shelf-on-repeat",
        "shelf-on-repeat-title",
        "shelf-on-repeat-meta",
        "shelf-on-repeat-mix-btn",
        "on-repeat-grid",
        "shelf-rediscover",
        "shelf-rediscover-title",
        "shelf-rediscover-meta",
        "shelf-rediscover-mix-btn",
        "rediscover-grid",
    ]) {
        assert.ok(html.includes(`id="${id}"`), `index.html must include #${id} in Home Shelves`);
    }

    for (const selector of [
        ".home-shelves",
        ".home-shelf",
        ".smart-mixes-grid",
        ".smart-mix-card",
        ".smart-mix-collage",
        ".smart-mix-preview-list",
        ".shelf-track-grid",
        ".shelf-track-card",
        "content-visibility: auto",
    ]) {
        assert.ok(css.includes(selector), `style.css must define ${selector}`);
    }
});

test("buildSupermixData and buildDailyMixes generate Your Supermix and 3 distinct genre/artist/vibe Daily Mixes", () => {
    const { shell, sandbox } = createSmartMixesTestSandbox();

    // 1. Your Supermix
    const supermix = shell.buildSupermixData();
    assert.ok(supermix);
    assert.equal(supermix.id, "supermix");
    assert.equal(supermix.type, "supermix");
    assert.equal(supermix.title, "Your Supermix");
    assert.equal(supermix.tracks.length, CATALOG.length);
    assert.equal(supermix.previewTracks.length, 4);
    assert.equal(supermix.collageCovers.length, 4);
    assert.ok(supermix.artists.length >= 3);
    assert.ok(supermix.avgBpm > 60 && supermix.avgBpm < 180);
    assert.ok(supermix.avgEnergyPct > 20 && supermix.avgEnergyPct <= 100);

    // 2. Daily Mix 1–3 clustered by genre/artist/vibe
    const dailyMixes = shell.buildDailyMixes();
    assert.equal(dailyMixes.length, 3);

    const [dm1, dm2, dm3] = dailyMixes;
    assert.equal(dm1.id, "daily-mix-1");
    assert.equal(dm1.title, "Daily Mix 1");
    assert.equal(dm1.vibeTitle, "Bollywood Romance & Soul");
    assert.ok(
        dm1.coreTracks.some((t) => t.id === "ajab-si-kk" || t.id === "ve-kamleya-pritam"),
        "Daily Mix 1 must cluster Bollywood Romance & Soul tracks"
    );

    assert.equal(dm2.id, "daily-mix-2");
    assert.equal(dm2.title, "Daily Mix 2");
    assert.equal(dm2.vibeTitle, "Hip-Hop & High-Voltage Trap");
    assert.ok(
        dm2.coreTracks.some(
            (t) => t.id === "not-like-us-kendrick-lamar" || t.id === "like-that-future"
        ),
        "Daily Mix 2 must cluster Hip-Hop & Trap tracks"
    );

    assert.equal(dm3.id, "daily-mix-3");
    assert.equal(dm3.title, "Daily Mix 3");
    assert.equal(dm3.vibeTitle, "Pop, Punjabi & Feel-Good Grooves");
    assert.ok(
        dm3.coreTracks.some(
            (t) => t.id === "espresso-sabrina-carpenter" || t.id === "softly-karan-aujla"
        ),
        "Daily Mix 3 must cluster Pop, Punjabi & Feel-Good tracks"
    );

    // Verify all 3 Daily Mixes have distinct lead tracks and 4-cover collages
    const leadTrackIds = new Set(dailyMixes.map((m) => m.tracks[0].id));
    assert.equal(leadTrackIds.size, 3, "Daily Mix 1–3 must have 3 distinct lead tracks");
    for (const dm of dailyMixes) {
        assert.equal(dm.collageCovers.length, 4);
        assert.ok(dm.previewTracks.length >= 3);
    }

    // 3. Liking and completing a track promotes it to lead its cluster & Supermix
    sandbox.SpotTubeStorage.setLike("tum-ho-mohit-chauhan", true);
    for (let i = 0; i < 3; i++) {
        sandbox.SpotTubeStorage.recordPlaybackOutcome("tum-ho-mohit-chauhan", {
            listenedSeconds: 318,
            durationSeconds: 318,
            endedNaturally: true,
        });
    }
    const updatedSupermix = shell.buildSupermixData();
    assert.equal(
        updatedSupermix.tracks[0].id,
        "tum-ho-mohit-chauhan",
        "Heavily completed & liked track must lead Your Supermix"
    );
    const updatedDm1 = shell.buildDailyMixes()[0];
    assert.equal(
        updatedDm1.tracks[0].id,
        "tum-ho-mohit-chauhan",
        "Heavily completed & liked Bollywood Soul track must lead Daily Mix 1"
    );
});

test("buildOnRepeatShelf, buildRediscoverShelf, and buildJumpBackInShelf dynamically adapt to user taste telemetry and play history", () => {
    const { shell, sandbox } = createSmartMixesTestSandbox();
    const store = sandbox.SpotTubeStorage;
    const baseNow = 1_800_000_000_000;

    // 1. Record historical plays for an older favorite ("ajab-si-kk" played 24 hours ago)
    store.setLike("ajab-si-kk", true);
    store.recordPlaybackOutcome("ajab-si-kk", {
        listenedSeconds: 246,
        durationSeconds: 246,
        endedNaturally: true,
        timestamp: baseNow - 24 * 60 * 60 * 1000,
    });

    // 2. Record heavy rotation plays for "softly-karan-aujla" (4 completions) and "espresso-sabrina-carpenter" (2 completions)
    store.setLike("softly-karan-aujla", true);
    for (let i = 0; i < 4; i++) {
        store.recordPlaybackOutcome("softly-karan-aujla", {
            listenedSeconds: 155,
            durationSeconds: 155,
            endedNaturally: true,
            timestamp: baseNow - (4 - i) * 60 * 1000,
        });
    }
    for (let i = 0; i < 2; i++) {
        store.recordPlaybackOutcome("espresso-sabrina-carpenter", {
            listenedSeconds: 175,
            durationSeconds: 175,
            endedNaturally: true,
            timestamp: baseNow - (2 - i) * 30 * 1000,
        });
    }

    // 3. Record early skip on "my-eyes-travis-scott"
    store.recordPlaybackOutcome("my-eyes-travis-scott", {
        listenedSeconds: 5,
        durationSeconds: 251,
        endedNaturally: false,
        timestamp: baseNow - 10 * 60 * 1000,
    });

    // Verify On Repeat Shelf
    const onRepeat = shell.buildOnRepeatShelf(CATALOG, { now: baseNow });
    assert.equal(onRepeat.id, "on-repeat");
    assert.equal(
        onRepeat.tracks[0].id,
        "softly-karan-aujla",
        "4x completed + liked track must rank #1 on On Repeat shelf"
    );
    assert.ok(
        onRepeat.tracks[0].shelfMeta.badgeText.includes("ON REPEAT • 4 PLAYS"),
        "On Repeat top card must display play count badge"
    );
    assert.ok(
        onRepeat.tracks.slice(0, 3).some((t) => t.id === "espresso-sabrina-carpenter"),
        "2x completed track must appear in top 3 of On Repeat shelf"
    );

    // Verify Jump Back In Shelf
    const jumpBackIn = shell.buildJumpBackInShelf(CATALOG, { now: baseNow });
    assert.equal(jumpBackIn.id, "jump-back-in");
    assert.equal(jumpBackIn.hasRecentHistory, true);
    assert.equal(
        jumpBackIn.tracks[0].id,
        "espresso-sabrina-carpenter",
        "Most recently played track must appear #1 in Jump Back In"
    );
    assert.equal(
        jumpBackIn.tracks[1].id,
        "softly-karan-aujla",
        "Second most recently played track must appear #2 in Jump Back In"
    );
    assert.equal(jumpBackIn.tracks[0].shelfMeta.badgeText, "JUST PLAYED");

    // Verify Rediscover & Forgotten Favorites Shelf
    const rediscover = shell.buildRediscoverShelf(CATALOG, { now: baseNow });
    assert.equal(rediscover.id, "rediscover");
    assert.equal(
        rediscover.tracks[0].id,
        "ajab-si-kk",
        "Liked & completed track from 24 hours ago (not in immediate last 2 plays) must surface #1 in Rediscover / Forgotten Favorites"
    );
    assert.equal(rediscover.tracks[0].shelfMeta.category, "forgotten-favorite");
    assert.ok(rediscover.tracks[0].shelfMeta.badgeText.includes("FORGOTTEN FAVORITE"));
    assert.ok(
        rediscover.tracks.some((t) => (t.shelfMeta?.playCount || 0) === 0),
        "Rediscover shelf must also surface unplayed hidden gems / classic deep cuts"
    );
    assert.ok(
        !rediscover.tracks.slice(0, 3).some((t) => t.id === "espresso-sabrina-carpenter"),
        "Track played 30 seconds ago must not dominate Rediscover shelf"
    );
});

test("renderHomeShelves and startSmartMix populate DOM grids, launch nonstop radio stations, and integrate with Left Sidebar Mixes filter", () => {
    const { shell, sandbox, elementsById } = createSmartMixesTestSandbox();

    const data = shell.renderHomeShelves();
    assert.ok(data);
    assert.equal(data.smartMixes.length, 4);
    assert.equal(elementsById.get("smart-mixes-grid").children.length, 4);
    assert.equal(elementsById.get("jump-back-in-grid").children.length, 6);
    assert.equal(elementsById.get("on-repeat-grid").children.length, 6);
    assert.equal(elementsById.get("rediscover-grid").children.length, 6);

    // 1. Start Daily Mix 2 ("Hip-Hop & High-Voltage Trap")
    const dm2Result = shell.startSmartMix("daily-mix-2");
    assert.ok(dm2Result);
    assert.equal(dm2Result.mixSession.type, "daily-mix");
    assert.equal(dm2Result.mixSession.smartMixId, "daily-mix-2");
    assert.equal(dm2Result.mixSession.badge, "DAILY MIX 2");
    assert.equal(dm2Result.mixSession.label, "Daily Mix 2: Hip-Hop & High-Voltage Trap");
    assert.equal(elementsById.get("mix-active-badge").textContent, "DAILY MIX 2");
    assert.equal(
        elementsById.get("mix-seed-label").textContent,
        "Daily Mix 2: Hip-Hop & High-Voltage Trap"
    );

    // Active station card in #smart-mixes-grid must receive .active-mix-station class
    const dm2Card = elementsById
        .get("smart-mixes-grid")
        .children.find((c) => c.dataset.smartMixId === "daily-mix-2");
    assert.ok(dm2Card.classList.contains("active-mix-station"));

    // 2. Start On Repeat Mix
    const onRepeatResult = shell.startSmartMix("on-repeat");
    assert.equal(onRepeatResult.mixSession.type, "on-repeat");
    assert.equal(onRepeatResult.mixSession.badge, "ON REPEAT MIX");
    assert.equal(onRepeatResult.mixSession.label, "On Repeat Heavy Rotation");
    assert.ok(onRepeatResult.queue.length >= 8);

    // 3. Start Rediscover Mix
    const rediscoverResult = shell.startSmartMix("rediscover");
    assert.equal(rediscoverResult.mixSession.type, "rediscover");
    assert.equal(rediscoverResult.mixSession.badge, "REDISCOVER MIX");
    assert.equal(rediscoverResult.mixSession.label, "Rediscover & Forgotten Favorites");

    // 4. Start Jump Back In Mix
    const jumpResult = shell.startSmartMix("jump-back-in");
    assert.equal(jumpResult.mixSession.type, "jump-back-in");
    assert.equal(jumpResult.mixSession.badge, "JUMP BACK IN");
    assert.equal(jumpResult.mixSession.label, "Jump Back In Radio");

    // 5. Start Your Supermix
    const supermixResult = shell.startSmartMix("supermix");
    assert.equal(supermixResult.mixSession.type, "supermix");
    assert.equal(supermixResult.mixSession.badge, "SUPERMIX");
    assert.equal(supermixResult.mixSession.label, "Your Nonstop Supermix");

    // 6. Left Library Sidebar "Mixes" filter includes Smart Auto-Mixes
    shell.setState({ activeLibraryFilter: "playlists" });
    shell.renderLibrarySidebar();
    const sidebarItems = elementsById.get("library-tracks-list").children;
    assert.ok(
        sidebarItems.some((item) => item.dataset.smartMixId === "supermix"),
        "Left Library Sidebar Mixes view must include Your Supermix"
    );
    assert.ok(
        sidebarItems.some((item) => item.dataset.smartMixId === "daily-mix-1"),
        "Left Library Sidebar Mixes view must include Daily Mix 1"
    );
    assert.ok(
        sidebarItems.some((item) => item.dataset.smartMixId === "on-repeat"),
        "Left Library Sidebar Mixes view must include On Repeat Mix"
    );
    assert.ok(
        sidebarItems.some((item) => item.dataset.smartMixId === "rediscover"),
        "Left Library Sidebar Mixes view must include Rediscover Mix"
    );
    assert.ok(
        sidebarItems.some((item) => item.dataset.moodMix === "Upbeat"),
        "Left Library Sidebar Mixes view must also preserve mood mixes"
    );

    // Verify endless nonstop queue replenishment on Daily Mix 1
    shell.startSmartMix("daily-mix-1");
    for (let i = 0; i < 12; i++) {
        const nextTrack = sandbox.SpotTubeQueue.advanceNext();
        assert.ok(nextTrack && nextTrack.id);
        assert.ok(sandbox.SpotTubeQueue.getQueue().length >= 3);
    }
});
