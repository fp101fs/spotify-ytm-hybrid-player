const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT_DIR = path.resolve(__dirname, "..");
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, "tests", "fixtures", "sample-tracks.json"), "utf8"));
const CATALOG = manifest.tracks;
const SpotTubeStorage = require("../storage.js");
const SpotTubeRecommender = require("../recommender.js");
const SpotTubeQueue = require("../queue.js");

function createTestEnvironment(extraOptions = {}) {
    const map = new Map();
    const storage = SpotTubeStorage.createStorageStore({
        storageKey: `test_mix_tuning_${Date.now()}_${Math.random()}`,
        localStorage: {
            getItem: (k) => (map.has(k) ? map.get(k) : null),
            setItem: (k, v) => map.set(k, String(v)),
            removeItem: (k) => map.delete(k),
        },
    });

    const qm = SpotTubeQueue.createQueueManager({
        catalog: CATALOG,
        storage,
        recommender: SpotTubeRecommender,
        ...extraOptions,
    });

    return { qm, storage };
}

test("MIX_MODE_PROFILES and computeQueueVibeMetrics describe all 6 YT Music dynamic tuning modes", () => {
    const expectedModes = ["all", "familiar", "discover", "deep-cuts", "upbeat", "chill"];
    assert.deepEqual(SpotTubeRecommender.VALID_MIX_MODES, expectedModes);
    assert.deepEqual(SpotTubeQueue.VALID_MIX_MODES, expectedModes);

    for (const mode of expectedModes) {
        const recProfile = SpotTubeRecommender.getMixModeProfile(mode);
        const queueProfile = SpotTubeQueue.getMixModeProfile(mode);
        assert.equal(recProfile.id, mode);
        assert.equal(queueProfile.id, mode);
        assert.ok(recProfile.label && recProfile.shortLabel && recProfile.description);
    }

    // Fallback to 'all' for unknown mode strings
    assert.equal(SpotTubeRecommender.getMixModeProfile("unknown-vibe").id, "all");
    assert.equal(SpotTubeQueue.normalizeMixMode("UNKNOWN"), "all");
});

test("switching between All, Familiar, Discover, Deep Cuts, Upbeat, and Chill dynamically re-ranks upcoming auto-mix tracks", () => {
    const { qm, storage } = createTestEnvironment();

    // Seed playback with "Matargashti" (Mohit Chauhan)
    // Mark "Ajab Si" and "Espresso" as liked + heavily played/completed so they are familiar to the user
    storage.setLike("ajab-si-kk", true);
    storage.recordPlaybackOutcome("ajab-si-kk", {
        listenedSeconds: 242,
        durationSeconds: 245,
        endedNaturally: true,
    });
    storage.recordPlaybackOutcome("ajab-si-kk", {
        listenedSeconds: 240,
        durationSeconds: 245,
        endedNaturally: true,
    });
    storage.setLike("espresso-sabrina-carpenter", true);
    storage.recordPlaybackOutcome("espresso-sabrina-carpenter", {
        listenedSeconds: 170,
        durationSeconds: 175,
        endedNaturally: true,
    });
    // Also mark the other Mohit Chauhan track ("Tum Ho") as played 3 times so Discover mode deprioritizes it
    for (let i = 0; i < 3; i++) {
        storage.recordPlaybackOutcome("tum-ho-mohit-chauhan", {
            listenedSeconds: 310,
            durationSeconds: 318,
            endedNaturally: true,
        });
    }

    qm.startMix("matargashti-mohit-chauhan");
    assert.equal(qm.getCurrentTrack().id, "matargashti-mohit-chauhan");

    // 1. Familiar mode: prioritizes liked/played favorites & same-artist hits
    qm.setMixMode("familiar");
    assert.equal(qm.getMixMode(), "familiar");
    const familiarUpcoming = qm.getUpcomingTracks();
    const familiarTop3Ids = familiarUpcoming.slice(0, 3).map((t) => t.id);
    assert.ok(
        familiarTop3Ids.includes("ajab-si-kk") || familiarTop3Ids.includes("tum-ho-mohit-chauhan"),
        `Familiar mode top 3 (${familiarTop3Ids.join(", ")}) must surface liked/played favorites`
    );
    const familiarMetrics = qm.getQueueVibeMetrics();
    assert.equal(familiarMetrics.mixMode, "familiar");
    assert.ok(familiarMetrics.summaryText.includes("Familiar"));

    // 2. Discover mode: prioritizes unplayed (playCount === 0) tracks from different primary artists
    qm.setMixMode("discover");
    assert.equal(qm.getMixMode(), "discover");
    const discoverUpcoming = qm.getUpcomingTracks();
    const topDiscoverTrack = discoverUpcoming[0];
    const topDiscoverStats = storage.getTrackStats(topDiscoverTrack.id);
    assert.equal(
        topDiscoverStats.playCount,
        0,
        `Top Discover mode pick (${topDiscoverTrack.id}) must be an unplayed track`
    );
    assert.notEqual(
        topDiscoverTrack.primaryArtist,
        "Mohit Chauhan",
        "Top Discover mode pick should bridge to a different primary artist"
    );
    const discoverMetrics = qm.getQueueVibeMetrics();
    assert.equal(discoverMetrics.mixMode, "discover");
    assert.ok(discoverMetrics.summaryText.includes("Discover"));

    // 3. Deep Cuts mode: prioritizes lower-popularity hidden gems
    qm.setMixMode("deep-cuts");
    const deepCutsUpcoming = qm.getUpcomingTracks();
    assert.ok(
        deepCutsUpcoming[0].popularity <= deepCutsUpcoming[deepCutsUpcoming.length - 1].popularity,
        "Deep Cuts mode must order lower-popularity hidden gems ahead of mainstream hits"
    );
    const deepCutsMetrics = qm.getQueueVibeMetrics();
    assert.ok(deepCutsMetrics.summaryText.includes("Deep Cuts"));

    // 4. Upbeat mode: prioritizes high-energy tracks
    qm.setMixMode("upbeat");
    const upbeatUpcoming = qm.getUpcomingTracks();
    assert.ok(
        upbeatUpcoming[0].energy >= upbeatUpcoming[upbeatUpcoming.length - 1].energy,
        "Upbeat mode must rank highest-energy tracks first"
    );
    const upbeatTop3AvgEnergy =
        upbeatUpcoming.slice(0, 3).reduce((s, t) => s + t.energy, 0) / 3;

    // 5. Chill mode: prioritizes high-acousticness / chill texture tracks
    qm.setMixMode("chill");
    const chillUpcoming = qm.getUpcomingTracks();
    assert.ok(
        chillUpcoming[0].acousticness >= chillUpcoming[chillUpcoming.length - 1].acousticness,
        "Chill mode must rank highest-acousticness tracks first"
    );
    const chillTop3AvgEnergy =
        chillUpcoming.slice(0, 3).reduce((s, t) => s + t.energy, 0) / 3;
    const chillTop3AvgAcoustic =
        chillUpcoming.slice(0, 3).reduce((s, t) => s + t.acousticness, 0) / 3;
    const upbeatTop3AvgAcoustic =
        upbeatUpcoming.slice(0, 3).reduce((s, t) => s + t.acousticness, 0) / 3;

    assert.ok(
        upbeatTop3AvgEnergy > chillTop3AvgEnergy,
        `Upbeat top-3 energy (${upbeatTop3AvgEnergy}) must exceed Chill top-3 energy (${chillTop3AvgEnergy})`
    );
    assert.ok(
        chillTop3AvgAcoustic > upbeatTop3AvgAcoustic,
        `Chill top-3 acousticness (${chillTop3AvgAcoustic}) must exceed Upbeat top-3 acousticness (${upbeatTop3AvgAcoustic})`
    );

    // 6. All mode: returns to balanced hybrid ranking
    qm.setMixMode("all");
    assert.equal(qm.getMixMode(), "all");
    assert.equal(qm.getMixSession().autoplayLabel, "Endless Auto");
});

test("switching mix tuning modes preserves manual queue items and never interrupts current playback", () => {
    const html = fs.readFileSync(path.join(ROOT_DIR, "index.html"), "utf8");
    const css = fs.readFileSync(path.join(ROOT_DIR, "style.css"), "utf8");

    // Verify HTML aria-pressed attributes and tuning insight elements
    assert.ok(
        html.includes('data-mix-mode="all" aria-pressed="true"'),
        "Default All tuning chip must declare aria-pressed=\"true\""
    );
    for (const mode of ["familiar", "discover", "deep-cuts", "upbeat", "chill"]) {
        assert.ok(
            html.includes(`data-mix-mode="${mode}" aria-pressed="false"`),
            `Inactive tuning chip ${mode} must declare aria-pressed="false"`
        );
    }
    assert.ok(html.includes('id="mix-tuning-caption"'), "Must include #mix-tuning-caption");
    assert.ok(html.includes('id="retune-mix-btn"'), "Must include #retune-mix-btn");
    assert.ok(
        css.includes("view-transition-name: match-element"),
        "style.css must set view-transition-name: match-element on .queue-item"
    );

    const storageJs = fs.readFileSync(path.join(ROOT_DIR, "storage.js"), "utf8");
    const recommenderJs = fs.readFileSync(path.join(ROOT_DIR, "recommender.js"), "utf8");
    const queueJs = fs.readFileSync(path.join(ROOT_DIR, "queue.js"), "utf8");
    const scriptJs = fs.readFileSync(path.join(ROOT_DIR, "script.js"), "utf8");

    const elementsById = new Map();
    const tuningChips = ["all", "familiar", "discover", "deep-cuts", "upbeat", "chill"].map(
        (mode) => {
            const el = makeEl(`chip-${mode}`);
            el.dataset.mixMode = mode;
            el.textContent = mode;
            if (mode === "all") {
                el.classList.add("active");
                el.setAttribute("aria-pressed", "true");
            } else {
                el.setAttribute("aria-pressed", "false");
            }
            return el;
        }
    );

    let moveBeforeCalls = 0;
    function ElementMock() {}
    ElementMock.prototype.moveBefore = function (node) {
        moveBeforeCalls++;
        return node;
    };

    function makeEl(id = "") {
        return {
            id,
            hidden: false,
            disabled: false,
            textContent: "",
            innerHTML: "",
            title: "",
            value: "",
            src: "",
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
                this.attributes.set(k, v);
            },
            getAttribute(k) {
                return this.attributes.get(k);
            },
            removeAttribute(k) {
                this.attributes.delete(k);
            },
            addEventListener() {},
            moveBefore(node) {
                moveBeforeCalls++;
                return node;
            },
            replaceChildren(...nodes) {
                this.children = nodes;
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
    }

    let playCalls = 0;
    let pauseCalls = 0;
    let activeAudioInstance = null;

    const sandbox = {
        window: {},
        globalThis: {},
        Element: ElementMock,
        console,
        Audio: function () {
            this.paused = false;
            this.currentTime = 42.5;
            this.duration = 175;
            this.src = "";
            this.volume = 1;
            this.muted = false;
            this.play = () => {
                playCalls++;
                this.paused = false;
                return Promise.resolve();
            };
            this.pause = () => {
                pauseCalls++;
                this.paused = true;
            };
            this.addEventListener = () => {};
            activeAudioInstance = this;
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
            querySelectorAll(selector) {
                if (selector === "#mix-tuning-chips .tuning-chip") {
                    return tuningChips;
                }
                return [];
            },
            createElement() {
                return makeEl();
            },
        },
    };
    sandbox.window = sandbox;
    sandbox.globalThis = sandbox;

    vm.runInNewContext(storageJs, sandbox);
    vm.runInNewContext(recommenderJs, sandbox);
    vm.runInNewContext(queueJs, sandbox);
    vm.runInNewContext(scriptJs, sandbox);

    const shell = sandbox.SpotTubeShell;
    shell.setState({ songs: CATALOG, currentTrackIndex: 0 });

    // Start playing track 0 ("Espresso") and simulate mid-song playback at 64.2s
    shell.playMusic("espresso-sabrina-carpenter", false);
    activeAudioInstance.currentTime = 64.2;
    const srcBeforeTuning = activeAudioInstance.src;
    const playCallsBeforeTuning = playCalls;
    const pauseCallsBeforeTuning = pauseCalls;

    // Queue a manual "Play Next" track and an "Add to Queue" track
    shell.playTrackNext("binte-dil-arijit-singh");
    shell.addTrackToQueue("ve-kamleya-pritam");

    // Capture the initial DOM nodes rendered inside #queue-list
    const queueListEl = elementsById.get("queue-list");
    const initialDomNodes = queueListEl.children.slice();
    assert.equal(initialDomNodes.length, CATALOG.length - 1);

    // Switch through all 6 YT Music Dynamic Mix Tuning Modes on the fly!
    for (const mode of ["upbeat", "chill", "deep-cuts", "discover", "familiar", "all"]) {
        const upcoming = shell.setMixMode(mode);

        // 1. Current playback MUST NOT be interrupted!
        assert.equal(
            CATALOG[shell.getState().currentTrackIndex].id,
            "espresso-sabrina-carpenter",
            `Current track must remain Espresso when switching to ${mode}`
        );
        assert.equal(activeAudioInstance.src, srcBeforeTuning);
        assert.equal(
            activeAudioInstance.currentTime,
            64.2,
            `Playback currentTime (64.2s) must not reset when switching to ${mode}`
        );
        assert.equal(playCalls, playCallsBeforeTuning, "setMixMode must not reload or restart audio");
        assert.equal(pauseCalls, pauseCallsBeforeTuning, "setMixMode must not pause audio");

        // 2. Manual priority queue items must stay locked at index 0 and index 1
        assert.equal(upcoming[0].id, "binte-dil-arijit-singh");
        assert.equal(upcoming[0].queueMeta.source, "manual");
        assert.equal(upcoming[1].id, "ve-kamleya-pritam");
        assert.equal(upcoming[1].queueMeta.source, "manual");

        // 3. Active tuning chip aria-pressed and class must be synced
        for (const chip of tuningChips) {
            const expectedActive = chip.dataset.mixMode === mode;
            assert.equal(chip.classList.contains("active"), expectedActive);
            assert.equal(chip.getAttribute("aria-pressed"), String(expectedActive));
        }

        // 4. Existing DOM nodes in #queue-list must be reordered in-place (preserving node identity)
        const currentDomNodes = queueListEl.children;
        assert.equal(currentDomNodes.length, initialDomNodes.length);
        for (const node of currentDomNodes) {
            assert.ok(
                initialDomNodes.includes(node),
                `DOM node for ${node.dataset.trackId} must be reused and reordered in-place, not recreated`
            );
        }
    }

    assert.ok(
        moveBeforeCalls > 0,
        "Reordering #queue-list across mix mode switches should invoke moveBefore when supported"
    );
    assert.ok(
        elementsById.get("mix-tuning-caption").textContent.length > 0,
        "#mix-tuning-caption should display live queue vibe summary"
    );
    assert.ok(
        elementsById.get("queue-live-status").textContent.includes("Tuned upcoming radio mix"),
        "#queue-live-status should announce the new tuning mode"
    );
});
