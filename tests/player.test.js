const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT_DIR = path.resolve(__dirname, "..");
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, "tracks.json"), "utf8"));
const CATALOG = manifest.tracks;
const SpotTubeStorage = require("../storage.js");
const SpotTubeRecommender = require("../recommender.js");
const SpotTubeQueue = require("../queue.js");
const SpotTubePlayer = require("../player.js");

function createMockAudio(name = "deck") {
    const listeners = new Map();
    return {
        name,
        src: "",
        currentTime: 0,
        duration: 180,
        volume: 1,
        muted: false,
        paused: true,
        preload: "auto",
        dataset: {},
        playCalls: 0,
        pauseCalls: 0,
        loadCalls: 0,
        play() {
            this.paused = false;
            this.playCalls++;
            const fns = listeners.get("play") || [];
            for (const fn of fns) fn();
            return Promise.resolve();
        },
        pause() {
            this.paused = true;
            this.pauseCalls++;
            const fns = listeners.get("pause") || [];
            for (const fn of fns) fn();
        },
        load() {
            this.loadCalls++;
        },
        addEventListener(type, fn) {
            if (!listeners.has(type)) listeners.set(type, []);
            listeners.get(type).push(fn);
        },
        removeEventListener(type, fn) {
            const arr = listeners.get(type) || [];
            const idx = arr.indexOf(fn);
            if (idx !== -1) arr.splice(idx, 1);
        },
        emit(type) {
            const fns = listeners.get(type) || [];
            for (const fn of fns) fn();
        },
    };
}

function createMockAudioContext() {
    const createdGains = [];
    return class MockAudioContext {
        constructor() {
            this.state = "running";
            this.sampleRate = 44100;
            this.destination = { nodeType: "destination" };
        }
        resume() {
            this.state = "running";
            return Promise.resolve();
        }
        createGain() {
            const g = {
                gain: { value: 1 },
                connect() {},
            };
            createdGains.push(g);
            return g;
        }
        createAnalyser() {
            return {
                fftSize: 512,
                frequencyBinCount: 256,
                smoothingTimeConstant: 0.8,
                connect() {},
                getByteFrequencyData() {},
                getByteTimeDomainData() {},
            };
        }
        createMediaElementSource(el) {
            return {
                mediaElement: el,
                connect() {},
            };
        }
        static getCreatedGains() {
            return createdGains;
        }
    };
}

function createTestPlayerEnvironment(playerOptions = {}) {
    const map = new Map();
    const storage = SpotTubeStorage.createStorageStore({
        storageKey: `test_player_${Date.now()}_${Math.random()}`,
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
        minQueueSize: 3,
    });

    const deckA = createMockAudio("deckA");
    const deckB = createMockAudio("deckB");
    const MockAudioCtx = createMockAudioContext();

    const actionHandlers = new Map();
    let positionState = null;
    const mediaSession = {
        metadata: null,
        playbackState: "none",
        setActionHandler(action, fn) {
            actionHandlers.set(action, fn);
        },
        setPositionState(state) {
            positionState = state;
        },
        getActionHandler(action) {
            return actionHandlers.get(action);
        },
        getPositionState() {
            return positionState;
        },
    };

    const player = SpotTubePlayer.createPlayerEngine({
        primaryAudio: deckA,
        secondaryAudio: deckB,
        AudioContext: MockAudioCtx,
        storage,
        queueManager: qm,
        mediaSession,
        minQueueSize: 3,
        ...playerOptions,
    });

    return {
        player,
        qm,
        storage,
        deckA,
        deckB,
        MockAudioCtx,
        mediaSession,
    };
}

test("player.js computes equal-power crossfade curves and configures 0–12s crossfade with storage persistence", () => {
    const { player, storage } = createTestPlayerEnvironment();

    // 1. Equal-power crossfade curve math
    const startGains = SpotTubePlayer.computeCrossfadeGains(0);
    assert.equal(startGains.outgoingGain, 1);
    assert.equal(startGains.incomingGain, 0);

    const midGains = SpotTubePlayer.computeCrossfadeGains(0.5);
    assert.ok(
        Math.abs(midGains.outgoingGain - 0.7071) < 0.001 &&
            Math.abs(midGains.incomingGain - 0.7071) < 0.001,
        "At 50% crossfade, equal-power cosine/sine curve must be ~0.7071 on both decks"
    );

    const endGains = SpotTubePlayer.computeCrossfadeGains(1);
    assert.equal(endGains.outgoingGain, 0);
    assert.equal(endGains.incomingGain, 1);

    // 2. Configurable 0–12s crossfade + clamping + storage persistence
    assert.equal(player.getCrossfadeSeconds(), 0);
    assert.equal(player.setCrossfadeSeconds(6), 6);
    assert.equal(storage.getPreferences().crossfadeSeconds, 6);

    assert.equal(player.setCrossfadeSeconds(25), 12, "Crossfade must clamp at 12s max");
    assert.equal(player.setCrossfadeSeconds(-4), 0, "Crossfade must clamp at 0s min");

    // 3. Cycling presets: 0 -> 2 -> 4 -> 6 -> 8 -> 12 -> 0
    const cycled = [];
    for (let i = 0; i < 6; i++) {
        cycled.push(player.cycleCrossfadeSeconds());
    }
    assert.deepEqual(cycled, [2, 4, 6, 8, 12, 0]);
});

test("player.js performs dual-deck Web Audio crossfade transitions, gapless standby preloading, and endless queue replenishment", () => {
    const { player, qm, storage, deckA, deckB, MockAudioCtx } = createTestPlayerEnvironment({
        crossfadeSeconds: 6,
    });

    qm.startMix("espresso-sabrina-carpenter");
    const firstTrack = qm.getCurrentTrack();
    const expectedSecondTrack = qm.getQueue()[0].track;

    // 1. Load first track onto Deck A -> automatically preloads next queue track onto Standby Deck B
    player.loadAndPlayTrack(firstTrack, { autoplay: true });
    assert.equal(player.getState().activeDeckKey, "A");
    assert.equal(deckA.src, firstTrack.audioUrl);
    assert.equal(deckA.paused, false);
    assert.equal(
        deckB.src,
        expectedSecondTrack.audioUrl,
        "Standby Deck B must gaplessly preload the next track in queue"
    );

    // 2. Simulate playback tick at 150s of 175s (25s remaining > 6s crossfade window): no crossfade yet
    const earlyTick = player.evaluatePlaybackTick(150, 175);
    assert.equal(earlyTick.action, "none");
    assert.equal(player.getState().crossfadeState.active, false);

    // 3. Simulate playback tick entering the 6s crossfade window (171s of 175s => 4s remaining <= 6s)
    // Use manualStep via direct beginCrossfade or verify evaluatePlaybackTick triggers crossfade
    const windowTick = player.evaluatePlaybackTick(171, 175);
    assert.equal(windowTick.action, "crossfade");
    assert.equal(windowTick.nextTrack.id, expectedSecondTrack.id);

    const cfState = player.getState().crossfadeState;
    assert.equal(cfState.active, true);
    assert.equal(cfState.fromDeckKey, "A");
    assert.equal(cfState.toDeckKey, "B");
    assert.equal(deckB.paused, false, "Incoming Deck B must start playing immediately on crossfade start");

    // Outgoing track ("Espresso") should have its natural completion recorded in telemetry
    const espressoStats = storage.getTrackStats(firstTrack.id);
    assert.equal(espressoStats.fullCompletions, 1);

    // 4. Step the crossfade curve through 50% and 100% and verify both HTML5 volume and Web Audio GainNodes ramp
    const gainsAtHalf = player.stepCrossfade(0.5);
    assert.ok(Math.abs(deckA.volume - gainsAtHalf.outgoingGain) < 0.01);
    assert.ok(Math.abs(deckB.volume - gainsAtHalf.incomingGain) < 0.01);

    const webAudioGains = MockAudioCtx.getCreatedGains();
    assert.equal(webAudioGains.length, 2, "Web Audio graph must create GainNode A and GainNode B");
    assert.ok(Math.abs(webAudioGains[0].gain.value - gainsAtHalf.outgoingGain) < 0.01);
    assert.ok(Math.abs(webAudioGains[1].gain.value - gainsAtHalf.incomingGain) < 0.01);

    // Complete crossfade at progress = 1.0
    player.stepCrossfade(1.0);
    assert.equal(player.getState().crossfadeState.active, false);
    assert.equal(player.getState().activeDeckKey, "B");
    assert.equal(deckA.paused, true, "Outgoing Deck A must pause when crossfade completes");
    assert.equal(deckA.volume, 0);
    assert.equal(deckB.volume, 1);

    // 5. Verify automatic endless queue replenishment when fewer than 3 tracks remain
    while (qm.getQueue().length > 2) {
        qm.removeFromQueue(0, { autoReplenish: false });
    }
    assert.equal(qm.getQueue().length, 2);
    player.evaluatePlaybackTick(20, 180);
    assert.ok(
        qm.getQueue().length >= 3,
        `Player must automatically replenish queue when fewer than 3 tracks remain (got ${qm.getQueue().length})`
    );
});

test("player.js integrates with MediaSession API for metadata, playbackState, positionState, and hardware media key actions", () => {
    const { player, qm, mediaSession } = createTestPlayerEnvironment();
    qm.startMix("not-like-us-kendrick-lamar");
    const firstTrack = qm.getCurrentTrack();

    let customNextCalled = 0;
    let customPrevCalled = 0;
    player.registerMediaSessionHandlers({
        onNext: () => {
            customNextCalled++;
            player.next({ manualSkip: true });
        },
        onPrevious: () => {
            customPrevCalled++;
            player.previous({ forcePreviousTrack: true });
        },
    });

    player.loadAndPlayTrack(firstTrack, { autoplay: true });
    assert.ok(mediaSession.metadata, "MediaSession metadata must be populated on track load");
    assert.equal(mediaSession.metadata.title, firstTrack.title);
    assert.equal(mediaSession.metadata.artist, firstTrack.artistDisplay);
    assert.equal(mediaSession.playbackState, "playing");

    // Position state updates on playback tick / seek
    player.seekTo(48);
    const pos = mediaSession.getPositionState();
    assert.ok(pos);
    assert.equal(pos.position, 48);

    // Trigger hardware media key handlers
    mediaSession.getActionHandler("pause")();
    assert.equal(mediaSession.playbackState, "paused");

    mediaSession.getActionHandler("play")();
    assert.equal(mediaSession.playbackState, "playing");

    mediaSession.getActionHandler("seekforward")({ seekOffset: 12 });
    assert.equal(player.getState().currentTime, 60);

    mediaSession.getActionHandler("seekbackward")({ seekOffset: 15 });
    assert.equal(player.getState().currentTime, 45);

    mediaSession.getActionHandler("seekto")({ seekTime: 90 });
    assert.equal(player.getState().currentTime, 90);

    mediaSession.getActionHandler("nexttrack")();
    assert.equal(customNextCalled, 1);
    assert.notEqual(player.getState().activeTrack.id, firstTrack.id);

    mediaSession.getActionHandler("previoustrack")();
    assert.equal(customPrevCalled, 1);
});

test("player.js handles keyboard shortcuts and ignores key presses inside text/search inputs", () => {
    const { player, qm } = createTestPlayerEnvironment();
    qm.startMix("espresso-sabrina-carpenter");
    player.loadAndPlayTrack(qm.getCurrentTrack(), { autoplay: true });

    let drawerToggled = 0;
    let likeToggled = 0;
    let searchFocused = 0;
    let shortcutsModalToggled = 0;

    const callbacks = {
        onToggleDrawer: () => drawerToggled++,
        onToggleLike: () => likeToggled++,
        onFocusSearch: () => searchFocused++,
        onToggleShortcutsModal: () => shortcutsModalToggled++,
    };

    // 1. Typing inside <input type="search"> must NOT trigger player shortcuts
    const ignoredInSearch = player.handleKeyDown(
        {
            key: " ",
            target: { tagName: "INPUT", type: "search" },
            preventDefault() {},
        },
        callbacks
    );
    assert.equal(ignoredInSearch.handled, false);
    assert.equal(player.getState().paused, false);

    // 2. Space pauses/plays
    player.handleKeyDown({ key: " ", target: { tagName: "DIV" }, preventDefault() {} }, callbacks);
    assert.equal(player.getState().paused, true);
    player.handleKeyDown({ key: "k", target: { tagName: "DIV" }, preventDefault() {} }, callbacks);
    assert.equal(player.getState().paused, false);

    // 3. ArrowRight / ArrowLeft seek +5s / -5s
    player.seekTo(30);
    player.handleKeyDown(
        { key: "ArrowRight", target: { tagName: "DIV" }, preventDefault() {} },
        callbacks
    );
    assert.equal(player.getState().currentTime, 35);
    player.handleKeyDown(
        { key: "ArrowLeft", target: { tagName: "DIV" }, preventDefault() {} },
        callbacks
    );
    assert.equal(player.getState().currentTime, 30);

    // 4. ArrowDown / ArrowUp adjust volume, M toggles mute
    player.handleKeyDown(
        { key: "ArrowDown", target: { tagName: "DIV" }, preventDefault() {} },
        callbacks
    );
    assert.equal(player.getState().volume, 0.95);
    player.handleKeyDown({ key: "m", target: { tagName: "DIV" }, preventDefault() {} }, callbacks);
    assert.equal(player.getState().muted, true);
    player.handleKeyDown({ key: "m", target: { tagName: "DIV" }, preventDefault() {} }, callbacks);
    assert.equal(player.getState().muted, false);

    // 5. Q (drawer), S (shuffle), R (repeat), F (like), X (crossfade cycle), / (search), ? (modal)
    player.handleKeyDown({ key: "q", target: { tagName: "DIV" }, preventDefault() {} }, callbacks);
    assert.equal(drawerToggled, 1);

    player.handleKeyDown({ key: "s", target: { tagName: "DIV" }, preventDefault() {} }, callbacks);
    assert.equal(player.getState().shuffle, true);

    player.handleKeyDown({ key: "r", target: { tagName: "DIV" }, preventDefault() {} }, callbacks);
    assert.equal(player.getState().repeat, true);

    player.handleKeyDown({ key: "f", target: { tagName: "DIV" }, preventDefault() {} }, callbacks);
    assert.equal(likeToggled, 1);

    player.handleKeyDown({ key: "x", target: { tagName: "DIV" }, preventDefault() {} }, callbacks);
    assert.equal(player.getCrossfadeSeconds(), 2);

    player.handleKeyDown({ key: "/", target: { tagName: "DIV" }, preventDefault() {} }, callbacks);
    assert.equal(searchFocused, 1);

    player.handleKeyDown({ key: "?", target: { tagName: "DIV" }, preventDefault() {} }, callbacks);
    assert.equal(shortcutsModalToggled, 1);

    // 6. N advances to next track, P returns to previous track
    const beforeNextId = player.getState().activeTrack.id;
    player.handleKeyDown({ key: "n", target: { tagName: "DIV" }, preventDefault() {} }, callbacks);
    assert.notEqual(player.getState().activeTrack.id, beforeNextId);
    player.handleKeyDown({ key: "p", target: { tagName: "DIV" }, preventDefault() {} }, callbacks);
    assert.equal(player.getState().activeTrack.id, beforeNextId);
});

test("index.html and script.js integrate SpotTubePlayer for crossfade UI, keyboard shortcuts, and MediaSession", () => {
    const html = fs.readFileSync(path.join(ROOT_DIR, "index.html"), "utf8");
    const queueIdx = html.indexOf('src="queue.js"');
    const playerIdx = html.indexOf('src="player.js"');
    const scriptIdx = html.indexOf('src="script.js"');

    assert.ok(playerIdx !== -1, "index.html must load player.js");
    assert.ok(
        queueIdx < playerIdx && playerIdx < scriptIdx,
        "index.html must load queue.js -> player.js -> script.js in order"
    );
    assert.ok(html.includes('id="shortcuts-modal"'), "index.html must include #shortcuts-modal dialog");
    assert.ok(html.includes('id="crossfade-slider"'), "index.html must include #crossfade-slider");

    const storageJs = fs.readFileSync(path.join(ROOT_DIR, "storage.js"), "utf8");
    const recommenderJs = fs.readFileSync(path.join(ROOT_DIR, "recommender.js"), "utf8");
    const queueJs = fs.readFileSync(path.join(ROOT_DIR, "queue.js"), "utf8");
    const playerJs = fs.readFileSync(path.join(ROOT_DIR, "player.js"), "utf8");
    const scriptJs = fs.readFileSync(path.join(ROOT_DIR, "script.js"), "utf8");

    const elementsById = new Map();
    const makeEl = (id = "") => ({
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
    });

    const mediaSessionActions = new Map();
    const sandbox = {
        window: {},
        globalThis: {},
        console,
        navigator: {
            mediaSession: {
                metadata: null,
                playbackState: "none",
                setActionHandler(action, fn) {
                    mediaSessionActions.set(action, fn);
                },
                setPositionState() {},
            },
        },
        Audio: function () {
            return createMockAudio();
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
    sandbox.window = sandbox;
    sandbox.globalThis = sandbox;

    vm.runInNewContext(storageJs, sandbox);
    vm.runInNewContext(recommenderJs, sandbox);
    vm.runInNewContext(queueJs, sandbox);
    vm.runInNewContext(playerJs, sandbox);
    vm.runInNewContext(scriptJs, sandbox);

    const shell = sandbox.SpotTubeShell;
    assert.ok(sandbox.SpotTubePlayer, "SpotTubePlayer must be exposed on window");
    assert.ok(shell.getPlayerEngine(), "SpotTubeShell.getPlayerEngine() must return the dual-deck engine");

    shell.setState({ songs: CATALOG, currentTrackIndex: 0 });
    shell.playMusic("espresso-sabrina-carpenter", false);

    // Verify MediaSession metadata was populated by playMusic via SpotTubePlayer
    assert.equal(sandbox.navigator.mediaSession.metadata.title, "Espresso");
    assert.equal(sandbox.navigator.mediaSession.playbackState, "playing");

    // Verify crossfade duration configuration and badge UI sync
    assert.equal(shell.setCrossfadeDuration(4), 4);
    assert.equal(elementsById.get("crossfade-badge").textContent, "XFADE 4s");
    assert.equal(elementsById.get("crossfade-badge").classList.contains("active"), true);
    assert.equal(elementsById.get("crossfade-slider-value").textContent, "4s Crossfade");

    // Verify keyboard shortcuts through shell.handleShellKeyDown
    shell.handleShellKeyDown({
        key: "x",
        target: { tagName: "BODY" },
        preventDefault() {},
    });
    assert.equal(shell.getCrossfadeDuration(), 6);
    assert.equal(elementsById.get("crossfade-badge").textContent, "XFADE 6s");

    shell.handleShellKeyDown({
        key: "?",
        target: { tagName: "BODY" },
        preventDefault() {},
    });
    assert.equal(shell.getState().isShortcutsModalOpen, true);
    assert.equal(elementsById.get("shortcuts-modal").hidden, false);
});
