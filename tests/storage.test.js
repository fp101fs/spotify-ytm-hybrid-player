const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT_DIR = path.resolve(__dirname, "..");
const SpotTubeStorage = require("../storage.js");

function createMockLocalStorage() {
    const map = new Map();
    return {
        getItem(k) {
            return map.has(k) ? map.get(k) : null;
        },
        setItem(k, v) {
            map.set(k, String(v));
        },
        removeItem(k) {
            map.delete(k);
        },
        _map: map,
    };
}

function createMockIndexedDB() {
    const stores = new Map();
    const db = {
        objectStoreNames: {
            contains(name) {
                return stores.has(name);
            },
        },
        createObjectStore(name, opts = {}) {
            const storeMap = new Map();
            storeMap._keyPath = opts.keyPath || "id";
            stores.set(name, storeMap);
            return storeMap;
        },
        transaction(storeName) {
            if (!stores.has(storeName)) {
                this.createObjectStore(storeName, {
                    keyPath: storeName === "analyzerCache" ? "trackId" : "id",
                });
            }
            const storeMap = stores.get(storeName);
            const tx = {
                oncomplete: null,
                onerror: null,
                objectStore() {
                    return {
                        put(record) {
                            const key = String(record[storeMap._keyPath]);
                            storeMap.set(key, record);
                            queueMicrotask(() => {
                                if (typeof tx.oncomplete === "function") tx.oncomplete();
                            });
                        },
                        get(key) {
                            const req = { onsuccess: null, onerror: null, result: null };
                            queueMicrotask(() => {
                                req.result = storeMap.get(String(key)) || null;
                                if (typeof req.onsuccess === "function") req.onsuccess();
                            });
                            return req;
                        },
                        getAll() {
                            const req = { onsuccess: null, onerror: null, result: [] };
                            queueMicrotask(() => {
                                req.result = Array.from(storeMap.values());
                                if (typeof req.onsuccess === "function") req.onsuccess();
                            });
                            return req;
                        },
                        delete(key) {
                            storeMap.delete(String(key));
                            queueMicrotask(() => {
                                if (typeof tx.oncomplete === "function") tx.oncomplete();
                            });
                        },
                    };
                },
            };
            return tx;
        },
    };

    return {
        open() {
            const req = { onupgradeneeded: null, onsuccess: null, onerror: null, result: db };
            queueMicrotask(() => {
                if (typeof req.onupgradeneeded === "function") {
                    req.onupgradeneeded({ target: { result: db } });
                }
                if (typeof req.onsuccess === "function") {
                    req.onsuccess();
                }
            });
            return req;
        },
        _stores: stores,
    };
}

test("storage.js tracks play counts, completion ratios, early vs late skip penalties, and persistence", () => {
    const mockLS = createMockLocalStorage();
    const store = SpotTubeStorage.createStorageStore({
        storageKey: "test_store_telemetry",
        localStorage: mockLS,
    });

    const trackId = "espresso-sabrina-carpenter";
    const t0 = 1700000000000;

    // 1. Start play
    store.recordPlayStart(trackId, t0);
    let stats = store.getTrackStats(trackId);
    assert.equal(stats.firstPlayedAt, t0);
    assert.equal(stats.lastPlayedAt, t0);

    // 2. Early skip (e.g. 10s out of 175s = 5.7% completion)
    stats = store.recordPlaybackOutcome(trackId, {
        listenedSeconds: 10,
        durationSeconds: 175,
        endedNaturally: false,
        timestamp: t0 + 10000,
    });
    assert.equal(stats.playCount, 1);
    assert.equal(stats.earlySkipCount, 1);
    assert.equal(stats.lateSkipCount, 0);
    assert.equal(stats.fullCompletions, 0);
    assert.ok(stats.skipPenalty >= 0.24, `Expected early skip penalty >= 0.24, got ${stats.skipPenalty}`);
    assert.ok(stats.lastCompletionRatio < 0.1);

    // 3. Late skip (e.g. 90s out of 175s = 51.4% completion)
    const penaltyAfterEarly = stats.skipPenalty;
    stats = store.recordPlaybackOutcome(trackId, {
        listenedSeconds: 90,
        durationSeconds: 175,
        endedNaturally: false,
        timestamp: t0 + 120000,
    });
    assert.equal(stats.playCount, 2);
    assert.equal(stats.earlySkipCount, 1);
    assert.equal(stats.lateSkipCount, 1);
    assert.ok(
        stats.skipPenalty > penaltyAfterEarly && stats.skipPenalty <= penaltyAfterEarly + 0.1,
        "Late skip should add a smaller penalty than early skip"
    );

    // 4. Full natural completion decays skip penalty
    const penaltyBeforeCompletion = stats.skipPenalty;
    stats = store.recordPlaybackOutcome(trackId, {
        listenedSeconds: 175,
        durationSeconds: 175,
        endedNaturally: true,
        timestamp: t0 + 300000,
    });
    assert.equal(stats.playCount, 3);
    assert.equal(stats.fullCompletions, 1);
    assert.equal(stats.lastCompletionRatio, 1);
    assert.ok(
        stats.skipPenalty < penaltyBeforeCompletion,
        `Completion must decay skip penalty (${stats.skipPenalty} < ${penaltyBeforeCompletion})`
    );
    assert.equal(stats.totalListenSeconds, 275);

    // 5. Recently played log order & outcomes
    const recent = store.getRecentlyPlayed(10);
    assert.equal(recent.length, 3);
    assert.equal(recent[0].outcome, "completed");
    assert.equal(recent[1].outcome, "late-skip");
    assert.equal(recent[2].outcome, "early-skip");
    assert.deepEqual(store.getRecentlyPlayedTrackIds(), [trackId]);

    // 6. Reloading a new store instance from the same localStorage preserves state
    const reloadedStore = SpotTubeStorage.createStorageStore({
        storageKey: "test_store_telemetry",
        localStorage: mockLS,
    });
    const reloadedStats = reloadedStore.getTrackStats(trackId);
    assert.equal(reloadedStats.playCount, 3);
    assert.equal(reloadedStats.fullCompletions, 1);
    assert.equal(reloadedStats.earlySkipCount, 1);
    assert.equal(reloadedStats.lateSkipCount, 1);
});

test("storage.js manages likes, dislikes, and computes Spotify-style user taste affinity scores", () => {
    const store = SpotTubeStorage.createStorageStore({
        storageKey: "test_store_taste",
        localStorage: createMockLocalStorage(),
    });

    const favTrack = "die-with-a-smile-lady-gaga";
    const skippedTrack = "like-that-future";
    const dislikedTrack = "husn-anuv-jain";

    // Baseline neutral track
    const neutralAffinity = store.computeTasteAffinity(favTrack);
    assert.equal(neutralAffinity.normalizedScore, 0.5);

    // Like and complete favTrack twice
    assert.equal(store.toggleLike(favTrack), true);
    assert.equal(store.isLiked(favTrack), true);
    store.recordPlaybackOutcome(favTrack, {
        listenedSeconds: 250,
        durationSeconds: 250,
        endedNaturally: true,
    });
    store.recordPlaybackOutcome(favTrack, {
        listenedSeconds: 245,
        durationSeconds: 250,
        endedNaturally: true,
    });

    const favAffinity = store.computeTasteAffinity(favTrack);
    assert.ok(favAffinity.score > 0.5, `Expected high positive score for liked+completed track, got ${favAffinity.score}`);
    assert.ok(favAffinity.normalizedScore > 0.75);

    // Repeated early skips on skippedTrack
    store.recordPlaybackOutcome(skippedTrack, {
        listenedSeconds: 6,
        durationSeconds: 267,
        endedNaturally: false,
    });
    store.recordPlaybackOutcome(skippedTrack, {
        listenedSeconds: 8,
        durationSeconds: 267,
        endedNaturally: false,
    });
    const skipAffinity = store.computeTasteAffinity(skippedTrack);
    assert.ok(
        skipAffinity.score < neutralAffinity.score,
        `Early-skipped track must score lower than neutral (${skipAffinity.score} < ${neutralAffinity.score})`
    );

    // Dislike mutual exclusivity with Like
    store.setLike(dislikedTrack, true);
    assert.equal(store.isLiked(dislikedTrack), true);
    store.toggleDislike(dislikedTrack);
    assert.equal(store.isDisliked(dislikedTrack), true);
    assert.equal(store.isLiked(dislikedTrack), false);

    const dislikedAffinity = store.computeTasteAffinity(dislikedTrack);
    assert.ok(dislikedAffinity.score <= -0.8);
    assert.ok(dislikedAffinity.normalizedScore < 0.15);
});

test("storage.js supports custom playlists CRUD and track reordering", () => {
    const store = SpotTubeStorage.createStorageStore({
        storageKey: "test_store_playlists",
        localStorage: createMockLocalStorage(),
    });

    const created = store.createPlaylist({
        name: "Late Night Coding",
        description: "Focus & synth vibes",
        trackIds: ["espresso-sabrina-carpenter", "husn-anuv-jain"],
    });
    assert.ok(created.id.startsWith("pl-late-night-coding-"));
    assert.equal(created.trackIds.length, 2);

    store.addTrackToPlaylist(created.id, "lover-diljit-dosanjh");
    let updated = store.getPlaylist(created.id);
    assert.deepEqual(updated.trackIds, [
        "espresso-sabrina-carpenter",
        "husn-anuv-jain",
        "lover-diljit-dosanjh",
    ]);

    // Reorder track from index 2 to index 0
    updated = store.reorderPlaylistTracks(created.id, 2, 0);
    assert.deepEqual(updated.trackIds, [
        "lover-diljit-dosanjh",
        "espresso-sabrina-carpenter",
        "husn-anuv-jain",
    ]);

    // Remove track
    updated = store.removeTrackFromPlaylist(created.id, "espresso-sabrina-carpenter");
    assert.deepEqual(updated.trackIds, ["lover-diljit-dosanjh", "husn-anuv-jain"]);

    // Update metadata
    updated = store.updatePlaylist(created.id, { name: "Midnight Flow" });
    assert.equal(updated.name, "Midnight Flow");

    // Delete playlist
    assert.equal(store.deletePlaylist(created.id), true);
    assert.equal(store.getPlaylists().length, 0);
});

test("storage.js persists and hydrates local user-imported audio blobs via IndexedDB", async () => {
    const mockIDB = createMockIndexedDB();
    const store = SpotTubeStorage.createStorageStore({
        storageKey: "test_store_idb",
        localStorage: createMockLocalStorage(),
        indexedDB: mockIDB,
    });

    const fakeMp3Bytes = new Uint8Array([0x49, 0x44, 0x33, 0x04, 0x00, 0xff, 0xfb, 0x90, 0x64]);
    const savedTrack = await store.saveImportedTrack(
        {
            title: "Neon Horizon",
            primaryArtist: "Synthwave Collective",
            album: "Cyber Dreams",
            duration: 214,
            durationFormatted: "3:34",
            genre: "Electronic",
            moods: ["Upbeat", "Focus", "Late Night"],
            bpm: 124,
            energy: 0.84,
        },
        fakeMp3Bytes
    );

    assert.equal(savedTrack.id, "local-neon-horizon-synthwave-collective");
    assert.equal(savedTrack.isLocalImport, true);
    assert.equal(savedTrack.title, "Neon Horizon");
    assert.ok(savedTrack.audioUrl.startsWith("blob:"));

    // Verify binary audio blob record in IndexedDB
    const blobRecord = await store.getAudioBlob(savedTrack.id);
    assert.ok(blobRecord, "Audio blob record must be stored in IndexedDB");
    assert.equal(blobRecord.size, fakeMp3Bytes.byteLength);

    // Verify listing imported tracks
    const importedList = await store.getImportedTracks();
    assert.equal(importedList.length, 1);
    assert.equal(importedList[0].id, savedTrack.id);

    // Delete imported track removes metadata and audio blob
    await store.deleteImportedTrack(savedTrack.id);
    assert.equal((await store.getImportedTracks()).length, 0);
    assert.equal(await store.getAudioBlob(savedTrack.id), null);
});

test("storage.js computes real-time Web Audio API spectral features (RMS, bass/treble, spectral centroid) and caches per track", () => {
    const store = SpotTubeStorage.createStorageStore({
        storageKey: "test_store_analyzer",
        localStorage: createMockLocalStorage(),
        indexedDB: createMockIndexedDB(),
    });

    // Construct synthetic FFT frequency bins (256 bins at 44100 Hz => ~86.13 Hz per bin)
    const freqBins = new Uint8Array(256);
    // Strong bass (bins 0..3 => ~43..300 Hz)
    freqBins[0] = 240;
    freqBins[1] = 230;
    freqBins[2] = 210;
    // Moderate mids (bins 4..40)
    for (let i = 4; i <= 40; i++) freqBins[i] = 110;
    // Lower treble (bins 47..150)
    for (let i = 47; i <= 150; i++) freqBins[i] = 45;

    // Construct synthetic time-domain waveform oscillating around 128
    const timeBins = new Uint8Array(256);
    for (let i = 0; i < 256; i++) {
        timeBins[i] = i % 2 === 0 ? 192 : 64; // amplitude 0.5 around 128
    }

    const features = store.computeSpectralFeaturesFromBins(freqBins, timeBins, 44100);
    assert.ok(features.rmsEnergy > 0.5 && features.rmsEnergy <= 1, `Invalid rmsEnergy: ${features.rmsEnergy}`);
    assert.ok(
        features.bassEnergy > features.trebleEnergy,
        `Bass-heavy signal must have bassEnergy (${features.bassEnergy}) > trebleEnergy (${features.trebleEnergy})`
    );
    assert.ok(features.spectralCentroidHz > 500 && features.spectralCentroidHz < 6500);
    assert.ok(features.spectralCentroidNormalized > 0 && features.spectralCentroidNormalized < 1);
    assert.ok(features.zeroCrossingRate > 0.8);

    // Cache and blend multiple analyzer snapshots for a track
    const trackId = "winning-speech-karan-aujla";
    const first = store.updateTrackAnalyzerFeatures(trackId, features);
    assert.equal(first.sampleCount, 1);
    assert.equal(first.bassEnergy, features.bassEnergy);

    const brighterSnapshot = {
        rmsEnergy: 0.9,
        bassEnergy: 0.4,
        midEnergy: 0.75,
        trebleEnergy: 0.85,
        spectralCentroidHz: 5600,
        spectralCentroidNormalized: 0.7,
        zeroCrossingRate: 0.5,
    };
    const second = store.updateTrackAnalyzerFeatures(trackId, brighterSnapshot, 0.5);
    assert.equal(second.sampleCount, 2);
    assert.ok(second.trebleEnergy > first.trebleEnergy, "Blended treble energy should increase");
    assert.ok(second.spectralCentroidHz > first.spectralCentroidHz, "Blended spectral centroid should increase");

    // Verify getEffectiveAudioFeatures merges static catalog metadata with cached live analyzer data
    const effective = store.getEffectiveAudioFeatures({
        id: trackId,
        energy: 0.8,
        valence: 0.72,
        danceability: 0.78,
        acousticness: 0.15,
        bpm: 97,
    });
    assert.equal(effective.hasLiveAnalyzer, true);
    assert.equal(effective.sampleCount, 2);
    assert.equal(effective.bassEnergy, second.bassEnergy);
    assert.equal(effective.trebleEnergy, second.trebleEnergy);

    // Also test attachAudioAnalyzer with a mock AudioElement and mock AudioContext
    const listeners = {};
    const mockAudioEl = {
        paused: false,
        addEventListener(evt, fn) {
            listeners[evt] = fn;
        },
    };
    class MockAudioContext {
        constructor() {
            this.sampleRate = 44100;
            this.state = "running";
            this.destination = {};
        }
        createAnalyser() {
            return {
                fftSize: 512,
                frequencyBinCount: 256,
                smoothingTimeConstant: 0.8,
                connect() {},
                getByteFrequencyData(arr) {
                    arr.set(freqBins);
                },
                getByteTimeDomainData(arr) {
                    arr.set(timeBins);
                },
            };
        }
        createMediaElementSource() {
            return { connect() {} };
        }
    }

    const handle = store.attachAudioAnalyzer(mockAudioEl, {
        AudioContext: MockAudioContext,
        getActiveTrackId: () => "millionaire-yo-yo-honey-singh",
    });
    const liveSample = handle.sampleNow();
    assert.ok(liveSample, "sampleNow() should extract and cache analyzer features from mock AudioContext");
    assert.equal(liveSample.trackId, "millionaire-yo-yo-honey-singh");
    assert.equal(liveSample.sampleCount, 1);
    handle.detach();
});

test("index.html and script.js integrate SpotTubeStorage for likes, telemetry, and track info", () => {
    const html = fs.readFileSync(path.join(ROOT_DIR, "index.html"), "utf8");
    assert.ok(
        html.indexOf('src="storage.js"') !== -1 &&
            html.indexOf('src="storage.js"') < html.indexOf('src="script.js"'),
        "index.html must load storage.js before script.js"
    );

    const storageJs = fs.readFileSync(path.join(ROOT_DIR, "storage.js"), "utf8");
    const scriptJs = fs.readFileSync(path.join(ROOT_DIR, "script.js"), "utf8");
    const manifest = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, "tests", "fixtures", "sample-tracks.json"), "utf8"));

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
        },
        setAttribute(k, v) {
            this.attributes.set(k, v);
        },
        getAttribute(k) {
            return this.attributes.get(k);
        },
        addEventListener(evt, fn) {
            this[`_on_${evt}`] = fn;
        },
        replaceChildren() {},
        querySelector() {
            return makeEl();
        },
        getElementsByTagName() {
            return [makeEl()];
        },
    });

    const mockAudioInstance = {
        paused: true,
        currentTime: 0,
        duration: 180,
        volume: 1,
        muted: false,
        play() {
            this.paused = false;
            return Promise.resolve();
        },
        pause() {
            this.paused = true;
        },
        addEventListener() {},
    };

    const sandbox = {
        window: {},
        globalThis: {},
        localStorage: createMockLocalStorage(),
        indexedDB: createMockIndexedDB(),
        console,
        Audio: function () {
            return mockAudioInstance;
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
    vm.runInNewContext(scriptJs, sandbox);

    const store = sandbox.SpotTubeStorage;
    const shell = sandbox.SpotTubeShell;
    assert.ok(store, "SpotTubeStorage must be registered on window");
    assert.ok(shell, "SpotTubeShell must be registered on window");

    shell.setState({ songs: manifest.tracks, currentTrackIndex: 0 });

    // Start playing track 0
    shell.playMusic(0, false);
    const track0 = manifest.tracks[0];
    assert.ok(store.getTrackStats(track0.id).lastPlayedAt !== null, "playMusic should record play start");

    // Simulate user listening for 8 seconds and skipping early to track 1
    mockAudioInstance.currentTime = 8;
    mockAudioInstance.duration = track0.duration || 175;
    shell.playMusic(1, false);

    const track0StatsAfterSkip = store.getTrackStats(track0.id);
    assert.equal(track0StatsAfterSkip.playCount, 1);
    assert.equal(track0StatsAfterSkip.earlySkipCount, 1);
    assert.ok(track0StatsAfterSkip.skipPenalty > 0);
});
