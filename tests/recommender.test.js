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

function findTrack(id) {
    const t = CATALOG.find((item) => item.id === id);
    assert.ok(t, `Track not found in catalog: ${id}`);
    return t;
}

function createIsolatedStorage() {
    const map = new Map();
    return SpotTubeStorage.createStorageStore({
        storageKey: `test_recommender_${Date.now()}_${Math.random()}`,
        localStorage: {
            getItem: (k) => (map.has(k) ? map.get(k) : null),
            setItem: (k, v) => map.set(k, String(v)),
            removeItem: (k) => map.delete(k),
        },
    });
}

test("recommender.js computes artist and collaborator network affinity (primary, featured, and 1-hop graph)", () => {
    const graph = SpotTubeRecommender.buildCollaboratorGraph(CATALOG);

    // 1. Same primary artist: Mohit Chauhan ("Matargashti" -> "Tum Ho")
    const matargashti = findTrack("matargashti-mohit-chauhan");
    const tumHo = findTrack("tum-ho-mohit-chauhan");
    const samePrimary = SpotTubeRecommender.computeArtistCollaboratorAffinity(
        tumHo,
        [matargashti],
        graph
    );
    assert.equal(samePrimary.score, 1.0);
    assert.equal(samePrimary.matchType, "same-primary-artist");

    // 2. Primary-featured crossover:
    // "Like That" (Future, Metro Boomin, Kendrick Lamar) <-> "Not Like Us" (Kendrick Lamar)
    const likeThat = findTrack("like-that-future");
    const notLikeUs = findTrack("not-like-us-kendrick-lamar");
    const crossover = SpotTubeRecommender.computeArtistCollaboratorAffinity(
        notLikeUs,
        [likeThat],
        graph
    );
    assert.equal(crossover.score, 0.86);
    assert.equal(crossover.matchType, "primary-featured-crossover");

    // Another primary-featured crossover:
    // "Binte Dil" (Arijit Singh) <-> "Ve Kamleya" (Pritam, Arijit Singh, Shreya Ghoshal)
    const binteDil = findTrack("binte-dil-arijit-singh");
    const veKamleya = findTrack("ve-kamleya-pritam");
    const arijitCrossover = SpotTubeRecommender.computeArtistCollaboratorAffinity(
        veKamleya,
        [binteDil],
        graph
    );
    assert.equal(arijitCrossover.score, 0.86);
    assert.equal(arijitCrossover.matchType, "primary-featured-crossover");

    // 3. Unrelated artist should have 0 artist affinity
    const espresso = findTrack("espresso-sabrina-carpenter");
    const unrelated = SpotTubeRecommender.computeArtistCollaboratorAffinity(
        espresso,
        [binteDil],
        graph
    );
    assert.equal(unrelated.score, 0);
    assert.equal(unrelated.matchType, "none");
});

test("recommender.js computes genre, subgenre, album, language, and era clustering", () => {
    const ajabSi = findTrack("ajab-si-kk"); // Bollywood Romance, Hindi, 2007
    const chashni = findTrack("chashni-abhijeet-srivastava"); // Bollywood Romance, Hindi, 2019
    const notLikeUs = findTrack("not-like-us-kendrick-lamar"); // Hip-Hop, English, 2024

    const sameCluster = SpotTubeRecommender.computeGenreAlbumEraCluster(chashni, [ajabSi]);
    const diffCluster = SpotTubeRecommender.computeGenreAlbumEraCluster(notLikeUs, [ajabSi]);

    assert.equal(sameCluster.sameGenre, true);
    assert.equal(sameCluster.sameLanguage, true);
    assert.ok(sameCluster.subgenreOverlap > 0.3, "Expected shared Bollywood/Melody subgenres");
    assert.ok(
        sameCluster.score > diffCluster.score + 0.35,
        `Same genre/language cluster (${sameCluster.score}) must score significantly higher than cross-genre/language (${diffCluster.score})`
    );
});

test("recommender.js computes 8D audio feature cosine similarity, tempo harmony, and live Web Audio analyzer integration", () => {
    const store = createIsolatedStorage();
    const notLikeUs = findTrack("not-like-us-kendrick-lamar"); // Hip-Hop, energy 0.88, danceability 0.91, acousticness 0.05
    const likeThat = findTrack("like-that-future"); // Hip-Hop, energy 0.89, danceability 0.82, acousticness 0.06
    const tumPremHo = findTrack("tum-prem-ho-mohit-lalwani"); // Devotional, energy 0.38, acousticness 0.82

    const simHipHop = SpotTubeRecommender.computeAudioFeatureSimilarity(likeThat, [notLikeUs], store);
    const simContrast = SpotTubeRecommender.computeAudioFeatureSimilarity(tumPremHo, [notLikeUs], store);

    assert.ok(
        simHipHop.cosine > simContrast.cosine,
        `Expected cosine(${simHipHop.cosine}) > cosine(${simContrast.cosine})`
    );
    assert.ok(
        simHipHop.featureProximity > simContrast.featureProximity,
        `Expected proximity(${simHipHop.featureProximity}) > proximity(${simContrast.featureProximity})`
    );
    assert.ok(
        simHipHop.score > simContrast.score + 0.25,
        `Overall audio similarity for matching profile (${simHipHop.score}) must exceed contrasting profile (${simContrast.score})`
    );

    // Verify octave / half-time tempo harmony (81 BPM vs 162 BPM)
    const harmonicTempo = SpotTubeRecommender.computeTempoHarmony(81, 162);
    const dissonantTempo = SpotTubeRecommender.computeTempoHarmony(81, 128);
    assert.ok(
        harmonicTempo > 0.8 && harmonicTempo > dissonantTempo,
        `Harmonic double-time tempo (${harmonicTempo}) must beat non-harmonic tempo (${dissonantTempo})`
    );

    // Verify real-time Web Audio API analyzer cache integration in extractAudioFeatureVector
    store.updateTrackAnalyzerFeatures(likeThat.id, {
        rmsEnergy: 0.95,
        bassEnergy: 0.92,
        midEnergy: 0.7,
        trebleEnergy: 0.65,
        spectralCentroidHz: 4800,
        spectralCentroidNormalized: 0.6,
        zeroCrossingRate: 0.4,
    });
    const vecWithLiveAnalyzer = SpotTubeRecommender.extractAudioFeatureVector(likeThat, store);
    assert.equal(vecWithLiveAnalyzer.length, 8);
    assert.equal(vecWithLiveAnalyzer[5], 0.92, "Bass energy dimension must reflect live Web Audio analyzer cache");
});

test("recommender.js incorporates Spotify-style user taste affinity (likes, completions, artist generalization, early skip decay, dislikes)", () => {
    const store = createIsolatedStorage();
    const espresso = findTrack("espresso-sabrina-carpenter");
    const matargashti = findTrack("matargashti-mohit-chauhan");
    const tumHo = findTrack("tum-ho-mohit-chauhan");
    const softly = findTrack("softly-karan-aujla");

    // Baseline score before telemetry
    const baseTaste = SpotTubeRecommender.computeUserTasteScore(espresso, {
        storage: store,
        catalog: CATALOG,
    });

    // Like and complete Espresso twice
    store.setLike(espresso.id, true);
    store.recordPlaybackOutcome(espresso.id, {
        listenedSeconds: 175,
        durationSeconds: 175,
        endedNaturally: true,
    });
    store.recordPlaybackOutcome(espresso.id, {
        listenedSeconds: 175,
        durationSeconds: 175,
        endedNaturally: true,
    });

    const likedTaste = SpotTubeRecommender.computeUserTasteScore(espresso, {
        storage: store,
        catalog: CATALOG,
    });
    assert.ok(
        likedTaste.score > baseTaste.score + 0.2,
        `Liked + completed track taste score (${likedTaste.score}) must exceed baseline (${baseTaste.score})`
    );

    // Artist taste generalization: liking and completing "Matargashti" (Mohit Chauhan)
    // boosts unplayed "Tum Ho" (also Mohit Chauhan)
    const tumHoBefore = SpotTubeRecommender.computeUserTasteScore(tumHo, {
        storage: store,
        catalog: CATALOG,
    });
    store.setLike(matargashti.id, true);
    store.recordPlaybackOutcome(matargashti.id, {
        listenedSeconds: 320,
        durationSeconds: 328,
        endedNaturally: true,
    });
    const tumHoAfter = SpotTubeRecommender.computeUserTasteScore(tumHo, {
        storage: store,
        catalog: CATALOG,
    });
    assert.ok(
        tumHoAfter.artistTasteBoost > 0 && tumHoAfter.score > tumHoBefore.score,
        "Liking and completing an artist's track must generalize a positive artistTasteBoost to their other tracks"
    );

    // Early skips penalize taste score
    const softlyBefore = SpotTubeRecommender.computeUserTasteScore(softly, {
        storage: store,
        catalog: CATALOG,
    });
    store.recordPlaybackOutcome(softly.id, {
        listenedSeconds: 5,
        durationSeconds: 155,
        endedNaturally: false,
    });
    store.recordPlaybackOutcome(softly.id, {
        listenedSeconds: 6,
        durationSeconds: 155,
        endedNaturally: false,
    });
    const softlyAfterSkips = SpotTubeRecommender.computeUserTasteScore(softly, {
        storage: store,
        catalog: CATALOG,
    });
    assert.ok(
        softlyAfterSkips.score < softlyBefore.score,
        `Repeated early skips must reduce taste score (${softlyAfterSkips.score} < ${softlyBefore.score})`
    );

    // Disliked track receives strong suppression in scoreCandidate
    store.setDislike(softly.id, true);
    const dislikedScored = SpotTubeRecommender.scoreCandidate(softly, {
        catalog: CATALOG,
        storage: store,
        seedTrack: espresso,
    });
    assert.ok(
        dislikedScored.totalScore < 0.2,
        `Disliked track totalScore (${dislikedScored.totalScore}) must be heavily suppressed`
    );
});

test("recommender.js applies recency and variety anti-repetition penalties to prevent artist streaks and immediate replays", () => {
    const store = createIsolatedStorage();
    const now = 1700000500000;
    const matargashti = findTrack("matargashti-mohit-chauhan");
    const tumHo = findTrack("tum-ho-mohit-chauhan");

    // 1. Immediate recency penalty when a track was just played 2 minutes ago
    store.recordPlaybackOutcome(tumHo.id, {
        listenedSeconds: 318,
        durationSeconds: 318,
        endedNaturally: true,
        timestamp: now - 2 * 60 * 1000,
    });

    const recentPenalty = SpotTubeRecommender.computeVarietyAndRecencyPenalty(tumHo, {
        storage: store,
        now,
    });
    assert.ok(
        recentPenalty.recencyPenalty >= 0.25,
        `Recently played track should incur recencyPenalty >= 0.25, got ${recentPenalty.recencyPenalty}`
    );

    // 2. Back-to-back same artist penalty in queueContext
    const artistStreakPenalty = SpotTubeRecommender.computeVarietyAndRecencyPenalty(tumHo, {
        queueContext: [matargashti], // Same primary artist: Mohit Chauhan
    });
    assert.ok(
        artistStreakPenalty.artistFatiguePenalty >= 0.2,
        `Back-to-back same artist should incur artistFatiguePenalty >= 0.2, got ${artistStreakPenalty.artistFatiguePenalty}`
    );
});

test("recommender.js rankCandidates produces relevant radio queues and adapts across YT Music dynamic mix modes", () => {
    const store = createIsolatedStorage();
    const notLikeUs = findTrack("not-like-us-kendrick-lamar");

    // 1. Seeded from "Not Like Us" (Kendrick Lamar, Hip-Hop)
    const hipHopRadio = SpotTubeRecommender.rankCandidates(CATALOG, {
        seedTrack: notLikeUs,
        storage: store,
        mixMode: "all",
    });
    assert.equal(hipHopRadio.length, CATALOG.length - 1);
    assert.ok(
        !hipHopRadio.some((r) => r.trackId === notLikeUs.id),
        "Seed track should be excluded from upcoming radio recommendations by default"
    );
    // "Like That" features Kendrick Lamar & is Hip-Hop, so it should rank #1
    assert.equal(
        hipHopRadio[0].trackId,
        "like-that-future",
        `Expected "like-that-future" to rank #1 for "not-like-us-kendrick-lamar" seed, got ${hipHopRadio[0].trackId}`
    );
    assert.ok(hipHopRadio[0].reasons.length > 0);

    // 2. Compare "upbeat" vs "chill" mode rankings
    const upbeatRanked = SpotTubeRecommender.rankCandidates(CATALOG, {
        seedTrack: findTrack("espresso-sabrina-carpenter"),
        storage: store,
        mixMode: "upbeat",
        limit: 4,
    });
    const chillRanked = SpotTubeRecommender.rankCandidates(CATALOG, {
        seedTrack: findTrack("espresso-sabrina-carpenter"),
        storage: store,
        mixMode: "chill",
        limit: 4,
    });

    const avgUpbeatEnergy =
        upbeatRanked.reduce((sum, r) => sum + (r.track.energy || 0), 0) / upbeatRanked.length;
    const avgChillEnergy =
        chillRanked.reduce((sum, r) => sum + (r.track.energy || 0), 0) / chillRanked.length;
    const avgUpbeatAcoustic =
        upbeatRanked.reduce((sum, r) => sum + (r.track.acousticness || 0), 0) / upbeatRanked.length;
    const avgChillAcoustic =
        chillRanked.reduce((sum, r) => sum + (r.track.acousticness || 0), 0) / chillRanked.length;

    assert.ok(
        avgUpbeatEnergy > avgChillEnergy,
        `Upbeat mode avg energy (${avgUpbeatEnergy}) must exceed Chill mode avg energy (${avgChillEnergy})`
    );
    assert.ok(
        avgChillAcoustic > avgUpbeatAcoustic,
        `Chill mode avg acousticness (${avgChillAcoustic}) must exceed Upbeat mode avg acousticness (${avgUpbeatAcoustic})`
    );

    // 3. Compare "deep-cuts" vs "familiar" mode
    // Mark a couple tracks as liked & played so "familiar" prioritizes them
    store.setLike("ajab-si-kk", true);
    store.recordPlaybackOutcome("ajab-si-kk", {
        listenedSeconds: 240,
        durationSeconds: 246,
        endedNaturally: true,
    });

    const deepCutsRanked = SpotTubeRecommender.rankCandidates(CATALOG, {
        seedTrack: findTrack("ve-kamleya-pritam"),
        storage: store,
        mixMode: "deep-cuts",
        limit: 3,
    });
    const familiarRanked = SpotTubeRecommender.rankCandidates(CATALOG, {
        seedTrack: findTrack("ve-kamleya-pritam"),
        storage: store,
        mixMode: "familiar",
        limit: 3,
    });

    const avgDeepCutsPop =
        deepCutsRanked.reduce((sum, r) => sum + (r.track.popularity || 0), 0) / deepCutsRanked.length;
    const avgFamiliarPop =
        familiarRanked.reduce((sum, r) => sum + (r.track.popularity || 0), 0) / familiarRanked.length;

    assert.ok(
        avgDeepCutsPop < avgFamiliarPop,
        `Deep Cuts avg popularity (${avgDeepCutsPop}) must be lower than Familiar avg popularity (${avgFamiliarPop})`
    );
});

test("index.html and script.js integrate SpotTubeRecommender for multi-signal Up Next queue ranking", () => {
    const html = fs.readFileSync(path.join(ROOT_DIR, "index.html"), "utf8");
    const storageIdx = html.indexOf('src="storage.js"');
    const recommenderIdx = html.indexOf('src="recommender.js"');
    const scriptIdx = html.indexOf('src="script.js"');

    assert.ok(recommenderIdx !== -1, "index.html must load recommender.js");
    assert.ok(
        storageIdx < recommenderIdx && recommenderIdx < scriptIdx,
        "index.html must load storage.js -> recommender.js -> script.js in order"
    );

    const storageJs = fs.readFileSync(path.join(ROOT_DIR, "storage.js"), "utf8");
    const recommenderJs = fs.readFileSync(path.join(ROOT_DIR, "recommender.js"), "utf8");
    const scriptJs = fs.readFileSync(path.join(ROOT_DIR, "script.js"), "utf8");

    const makeEl = (id = "") => ({
        id,
        hidden: false,
        textContent: "",
        innerHTML: "",
        title: "",
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
        addEventListener() {},
        replaceChildren() {},
        querySelector() {
            return makeEl();
        },
        getElementsByTagName() {
            return [makeEl()];
        },
    });

    const sandbox = {
        window: {},
        globalThis: {},
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
                return makeEl(id);
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
    vm.runInNewContext(scriptJs, sandbox);

    assert.ok(sandbox.SpotTubeRecommender, "SpotTubeRecommender must attach to window");
    const shell = sandbox.SpotTubeShell;
    const nluIdx = CATALOG.findIndex((t) => t.id === "not-like-us-kendrick-lamar");
    shell.setState({
        songs: CATALOG,
        currentTrackIndex: nluIdx,
        activeMixMode: "all",
    });

    const upcoming = shell.getUpcomingQueueTracks();
    assert.equal(upcoming.length, CATALOG.length - 1);
    assert.equal(upcoming[0].id, "like-that-future");
    assert.ok(upcoming[0].recommendation, "Upcoming queue tracks should include .recommendation metadata");
    assert.ok(upcoming[0].recommendation.totalScore > 0);
    assert.ok(upcoming[0].recommendation.primaryReason);
});
