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

function createTestQueueManager(extraOptions = {}) {
    const map = new Map();
    const storage = SpotTubeStorage.createStorageStore({
        storageKey: `test_queue_${Date.now()}_${Math.random()}`,
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

test("queue.js starts a nonstop radio mix from any single track, artist, album, mood chip, search result set, or Supermix", () => {
    const { qm, storage } = createTestQueueManager();

    // 1. Single Track Radio Mix
    const trackMix = qm.startMix({
        type: "track",
        trackId: "not-like-us-kendrick-lamar",
    });
    assert.equal(trackMix.mixSession.type, "track");
    assert.equal(trackMix.mixSession.badge, "TRACK RADIO");
    assert.ok(trackMix.mixSession.label.includes("Not Like Us"));
    assert.equal(trackMix.currentTrack.id, "not-like-us-kendrick-lamar");
    assert.equal(trackMix.queue.length, CATALOG.length - 1);
    assert.ok(!trackMix.queue.some((q) => q.trackId === "not-like-us-kendrick-lamar"));
    // Top recommendation for "Not Like Us" should be "Like That" (Kendrick feature + Hip-Hop)
    assert.equal(trackMix.queue[0].trackId, "like-that-future");

    // 2. Artist Radio Mix (Mohit Chauhan has 2 tracks: "Matargashti" and "Tum Ho")
    const artistMix = qm.startMix({
        type: "artist",
        artist: "Mohit Chauhan",
    });
    assert.equal(artistMix.mixSession.type, "artist");
    assert.equal(artistMix.mixSession.badge, "ARTIST RADIO");
    assert.equal(artistMix.mixSession.label, "Mohit Chauhan Radio");
    assert.equal(artistMix.currentTrack.primaryArtist, "Mohit Chauhan");
    // The other Mohit Chauhan track should be included in the upcoming radio queue
    const otherMohitInQueue = artistMix.queue.find(
        (item) => item.track.primaryArtist === "Mohit Chauhan"
    );
    assert.ok(otherMohitInQueue, "Other tracks by the seeded artist must appear in the upcoming artist mix queue");

    // 3. Album Radio Mix ("UTOPIA" -> "MY EYES" by Travis Scott)
    const albumMix = qm.startMix({
        type: "album",
        album: "UTOPIA",
    });
    assert.equal(albumMix.mixSession.type, "album");
    assert.equal(albumMix.mixSession.badge, "ALBUM RADIO");
    assert.equal(albumMix.mixSession.label, "UTOPIA Radio");
    assert.equal(albumMix.currentTrack.album, "UTOPIA");
    assert.equal(albumMix.queue.length, CATALOG.length - 1);

    // 4. Mood Chip Radio Mix ("Upbeat")
    const moodMix = qm.startMix({
        type: "mood",
        mood: "Upbeat",
    });
    assert.equal(moodMix.mixSession.type, "mood");
    assert.equal(moodMix.mixSession.badge, "MOOD MIX");
    assert.equal(moodMix.mixSession.label, "Upbeat Vibe Radio");
    assert.ok(
        moodMix.currentTrack.moods.includes("Upbeat"),
        "Lead track of Upbeat mood mix must carry the Upbeat mood tag"
    );

    // 5. Active Search Result Set / Query Mix ("Arijit Singh" matches "Binte Dil" and "Ve Kamleya")
    const searchMix = qm.startMix({
        type: "search",
        query: "Arijit Singh",
    });
    assert.equal(searchMix.mixSession.type, "search");
    assert.equal(searchMix.mixSession.badge, "SEARCH MIX");
    assert.equal(searchMix.mixSession.label, 'Search Mix: "Arijit Singh"');
    assert.ok(searchMix.currentTrack.artistDisplay.includes("Arijit Singh"));
    assert.ok(
        searchMix.queue.some((item) => item.track.artistDisplay.includes("Arijit Singh")),
        "Remaining matching search result tracks must be included in the upcoming Search Mix"
    );

    // 6. Supermix seeded by user's liked songs
    storage.setLike("espresso-sabrina-carpenter", true);
    const supermix = qm.startMix({ type: "supermix" });
    assert.equal(supermix.mixSession.type, "supermix");
    assert.equal(supermix.mixSession.badge, "SUPERMIX");
    assert.equal(supermix.currentTrack.id, "espresso-sabrina-carpenter");
});

test("queue.js supports Play Next, Add to Queue, manual reorder, moveUp/moveDown, promoteToPlayNext, and removal", () => {
    const { qm } = createTestQueueManager();
    qm.startMix("espresso-sabrina-carpenter");

    const initialLength = qm.getQueue().length;
    assert.equal(initialLength, CATALOG.length - 1);

    // 1. "Play Next" inserts at index 0 with source="manual", manualType="play-next"
    // and deduplicates any existing auto-mix entry for the same track
    const playNextEntry = qm.playNext("my-eyes-travis-scott");
    assert.ok(playNextEntry);
    assert.equal(playNextEntry.source, "manual");
    assert.equal(playNextEntry.manualType, "play-next");

    let queue = qm.getQueue();
    assert.equal(queue[0].trackId, "my-eyes-travis-scott");
    assert.equal(
        queue.filter((item) => item.trackId === "my-eyes-travis-scott").length,
        1,
        "playNext should deduplicate the auto-mix copy of the track"
    );

    // A second "Play Next" pushes directly to index 0 ahead of the previous one (LIFO at top)
    qm.playNext("softly-karan-aujla");
    queue = qm.getQueue();
    assert.equal(queue[0].trackId, "softly-karan-aujla");
    assert.equal(queue[1].trackId, "my-eyes-travis-scott");

    // 2. "Add to Queue" appends to the manual priority block (FIFO after existing manual items, before auto-mix items)
    const addedFirst = qm.addToQueue("ajab-si-kk");
    const addedSecond = qm.addToQueue("chashni-abhijeet-srivastava");
    assert.equal(addedFirst.source, "manual");
    assert.equal(addedFirst.manualType, "add-to-queue");
    assert.equal(addedSecond.source, "manual");

    queue = qm.getQueue();
    assert.deepEqual(
        queue.slice(0, 4).map((item) => item.trackId),
        [
            "softly-karan-aujla",
            "my-eyes-travis-scott",
            "ajab-si-kk",
            "chashni-abhijeet-srivastava",
        ]
    );
    assert.equal(queue[4].source, "mix", "Auto-mix tracks must follow the manual priority block");

    // 3. Manual Reorder (drag / drop from index 3 to index 1)
    qm.reorderQueue(3, 1);
    queue = qm.getQueue();
    assert.deepEqual(
        queue.slice(0, 4).map((item) => item.trackId),
        [
            "softly-karan-aujla",
            "chashni-abhijeet-srivastava",
            "my-eyes-travis-scott",
            "ajab-si-kk",
        ]
    );
    assert.equal(queue[1].userReordered, true);

    // 4. moveUp and moveDown
    qm.moveDown(0); // moves "softly-karan-aujla" from 0 to 1
    queue = qm.getQueue();
    assert.equal(queue[0].trackId, "chashni-abhijeet-srivastava");
    assert.equal(queue[1].trackId, "softly-karan-aujla");

    qm.moveUp(1); // moves "softly-karan-aujla" back from 1 to 0
    queue = qm.getQueue();
    assert.equal(queue[0].trackId, "softly-karan-aujla");

    // 5. promoteToPlayNext moves a lower item directly to index 0 as a manual Play Next item
    const mixItemAt5 = queue[5];
    qm.promoteToPlayNext(mixItemAt5.queueId);
    queue = qm.getQueue();
    assert.equal(queue[0].queueId, mixItemAt5.queueId);
    assert.equal(queue[0].source, "manual");
    assert.equal(queue[0].manualType, "play-next");

    // 6. Removal by queueId, index, or trackId
    const removedByQueueId = qm.removeFromQueue(mixItemAt5.queueId);
    assert.equal(removedByQueueId.trackId, mixItemAt5.trackId);
    assert.ok(!qm.getQueue().some((item) => item.queueId === mixItemAt5.queueId));

    const removedByTrackId = qm.removeFromQueue("my-eyes-travis-scott");
    assert.equal(removedByTrackId.trackId, "my-eyes-travis-scott");
    assert.ok(!qm.getQueue().some((item) => item.trackId === "my-eyes-travis-scott"));

    // 7. Clear only manual queue items while preserving auto-mix tracks
    qm.clearQueue({ onlyManual: true });
    queue = qm.getQueue();
    assert.ok(queue.length > 0);
    assert.ok(queue.every((item) => item.source === "mix"));
});

test("queue.js maintains nonstop playback with automatic queue replenishment, playback history, and dynamic mix mode retuning", () => {
    const { qm } = createTestQueueManager({ minQueueSize: 3 });
    qm.startMix("espresso-sabrina-carpenter");

    // Queue a manual track to Play Next and verify advanceNext plays it first
    qm.playNext("binte-dil-arijit-singh");
    const firstNext = qm.advanceNext();
    assert.equal(firstNext.id, "binte-dil-arijit-singh");
    assert.equal(qm.getCurrentTrack().id, "binte-dil-arijit-singh");
    assert.ok(qm.getHistory().length >= 1);
    assert.equal(qm.getHistory()[qm.getHistory().length - 1].id, "espresso-sabrina-carpenter");

    // Step backward via previous() -> restores "espresso-sabrina-carpenter" and puts "binte-dil-arijit-singh" back at index 0
    const steppedBack = qm.previous();
    assert.equal(steppedBack.id, "espresso-sabrina-carpenter");
    assert.equal(qm.getQueue()[0].trackId, "binte-dil-arijit-singh");

    // Advance 25 tracks in a row across a 12-track catalog: automatic replenishment must keep the queue non-empty forever
    for (let step = 0; step < 25; step++) {
        const nextTrack = qm.advanceNext();
        assert.ok(nextTrack && nextTrack.id, `Expected valid track at nonstop step ${step}`);
        assert.ok(
            qm.getQueue().length >= 3,
            `Queue must auto-replenish to at least minQueueSize (3) at step ${step}, got ${qm.getQueue().length}`
        );
    }

    // Dynamic mix mode retuning (`setMixMode`) preserves manual queue items while re-ranking auto-mix tracks
    qm.playNext("ajab-si-kk");
    qm.setMixMode("upbeat");
    const upbeatQueue = qm.getUpcomingTracks();
    assert.equal(upbeatQueue[0].id, "ajab-si-kk", "Manual Play Next track must remain at index 0 after mix mode retuning");
    const mixOnly = upbeatQueue.slice(1);
    assert.ok(
        mixOnly[0].energy >= mixOnly[mixOnly.length - 1].energy,
        "Auto-mix tracks after manual block must be re-ranked for upbeat mode"
    );
});

test("index.html and script.js integrate SpotTubeQueue for universal Start Mix, Play Next, Add to Queue, reorder, and removal", () => {
    const html = fs.readFileSync(path.join(ROOT_DIR, "index.html"), "utf8");
    const storageIdx = html.indexOf('src="storage.js"');
    const recommenderIdx = html.indexOf('src="recommender.js"');
    const queueIdx = html.indexOf('src="queue.js"');
    const scriptIdx = html.indexOf('src="script.js"');

    assert.ok(queueIdx !== -1, "index.html must load queue.js");
    assert.ok(
        storageIdx < recommenderIdx && recommenderIdx < queueIdx && queueIdx < scriptIdx,
        "index.html must load storage.js -> recommender.js -> queue.js -> script.js in order"
    );
    assert.ok(
        html.includes('id="queue-live-status"'),
        "index.html must include #queue-live-status polite live region for queue accessibility"
    );

    const storageJs = fs.readFileSync(path.join(ROOT_DIR, "storage.js"), "utf8");
    const recommenderJs = fs.readFileSync(path.join(ROOT_DIR, "recommender.js"), "utf8");
    const queueJs = fs.readFileSync(path.join(ROOT_DIR, "queue.js"), "utf8");
    const scriptJs = fs.readFileSync(path.join(ROOT_DIR, "script.js"), "utf8");

    const elementsById = new Map();
    const makeEl = (id = "") => ({
        id,
        hidden: false,
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
    vm.runInNewContext(scriptJs, sandbox);

    const shell = sandbox.SpotTubeShell;
    assert.ok(sandbox.SpotTubeQueue, "SpotTubeQueue must be registered on window");
    assert.ok(shell, "SpotTubeShell must be registered on window");

    shell.setState({ songs: CATALOG, currentTrackIndex: 0 });

    // 1. Start Artist Radio Mix through SpotTubeShell
    const artistMix = shell.startRadioMix({
        type: "artist",
        artist: "Mohit Chauhan",
    });
    assert.equal(artistMix.mixSession.badge, "ARTIST RADIO");
    assert.equal(elementsById.get("mix-active-badge").textContent, "ARTIST RADIO");
    assert.equal(elementsById.get("mix-seed-label").textContent, "Mohit Chauhan Radio");
    assert.ok(
        elementsById.get("queue-live-status").textContent.includes("ARTIST RADIO"),
        "Starting a radio mix should announce the station in #queue-live-status"
    );

    // 2. Play Next & Add to Queue through SpotTubeShell
    shell.playTrackNext("espresso-sabrina-carpenter");
    shell.addTrackToQueue("ve-kamleya-pritam");

    let upcoming = shell.getUpcomingQueueTracks();
    assert.equal(upcoming[0].id, "espresso-sabrina-carpenter");
    assert.equal(upcoming[0].queueMeta.manualType, "play-next");
    assert.equal(upcoming[1].id, "ve-kamleya-pritam");
    assert.equal(upcoming[1].queueMeta.manualType, "add-to-queue");
    assert.equal(
        elementsById.get("clear-manual-queue-btn").hidden,
        false,
        "Clear Manual button should unhide when manual tracks are queued"
    );

    // 3. Reorder queue items through SpotTubeShell
    shell.reorderQueueItems(1, 0);
    upcoming = shell.getUpcomingQueueTracks();
    assert.equal(upcoming[0].id, "ve-kamleya-pritam");
    assert.equal(upcoming[1].id, "espresso-sabrina-carpenter");

    // 4. Remove item from queue through SpotTubeShell
    shell.removeTrackFromQueue(upcoming[0].queueMeta.queueId);
    upcoming = shell.getUpcomingQueueTracks();
    assert.equal(upcoming[0].id, "espresso-sabrina-carpenter");

    // 5. Advance to next track from queue
    const nextPlayed = shell.playNextFromQueue();
    assert.equal(nextPlayed.id, "espresso-sabrina-carpenter");
    assert.equal(
        CATALOG[shell.getState().currentTrackIndex].id,
        "espresso-sabrina-carpenter"
    );
});

test("queue.js youtube-radio mixes keep YouTube Music's order, extend in order, and end when an outside track is picked", () => {
    const { qm } = createTestQueueManager();
    const yt = (n) => ({ ...CATALOG[0], id: `yt-video${String(n).padStart(6, "0")}`, source: "youtube", title: `YT ${n}` });
    const radio = [1, 2, 3, 4, 5].map(yt);
    const catalog = [...CATALOG, ...radio];
    const started = qm.startMix({ type: "youtube-radio", tracks: radio, label: "YT 1 Mix" }, { catalog });
    assert.equal(started.mixSession.type, "youtube-radio");
    assert.equal(started.currentTrack.id, radio[0].id);
    assert.deepEqual(started.queue.map((e) => e.trackId), radio.slice(1).map((t) => t.id));

    // Re-syncing on the same track (what the app does when the catalog grows) keeps the order
    qm.setCurrentTrack(radio[0], { catalog, regenerateMix: true, recordHistory: false, silent: true });
    assert.deepEqual(qm.getQueue().map((e) => e.trackId), radio.slice(1).map((t) => t.id));

    // Advancing walks the list in order; extending appends new songs once
    assert.equal(qm.advanceNext().id, radio[1].id);
    const more = [6, 7, 2].map(yt);
    assert.equal(qm.extendMix(more, { catalog: [...catalog, ...more] }), 2);
    assert.deepEqual(qm.getQueue().map((e) => e.trackId), [3, 4, 5, 6, 7].map((n) => yt(n).id));

    // Picking a library track that isn't in the radio ends it
    qm.setCurrentTrack(CATALOG[3], { regenerateMix: true, silent: true });
    assert.notEqual(qm.getMixSession().type, "youtube-radio");
    assert.equal(qm.extendMix([yt(9)]), 0);
});
