// Item 15: optional online metadata lookup (MusicBrainz + Cover Art Archive + iTunes, no keys)
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { buildMp3, sliceableFile, memoryStore, createShellSandbox, ROOT_DIR, CATALOG } = require("./helpers.js");
const Library = require(path.join(ROOT_DIR, "library.js"));
const M = require(path.join(ROOT_DIR, "metadata-lookup.js"));

// ---------- fixtures shaped like the real service responses ----------

function mbResponse(recordings) {
    return { created: "2026-11-19T00:00:00Z", count: recordings.length, offset: 0, recordings };
}

function mbRecording({ id = "rec-1", title, artist, length, score = 100, releases }) {
    return {
        id,
        score,
        title,
        length,
        "artist-credit": [{ name: artist, artist: { id: `artist-${artist}`, name: artist } }],
        "first-release-date": "2024-04-12",
        releases: releases || [
            {
                id: "rel-live",
                title: `${title} (live)`,
                status: "Official",
                date: "2024-04-13",
                "release-group": { "primary-type": "Broadcast", "secondary-types": ["Live"] },
            },
            {
                id: "rel-album",
                title: "Short n' Sweet",
                status: "Official",
                date: "2024-08-23",
                "release-group": { "primary-type": "Album", "secondary-types": [] },
            },
        ],
    };
}

function itunesResponse(results) {
    return { resultCount: results.length, results };
}

function itunesSong({ title, artist, album = "Short n' Sweet", ms, genre = "Pop" }) {
    return {
        wrapperType: "track",
        kind: "song",
        trackId: 1739659142,
        trackName: title,
        artistName: artist,
        collectionName: album,
        trackTimeMillis: ms,
        primaryGenreName: genre,
        releaseDate: "2024-04-12T07:00:00Z",
        artworkUrl100: "https://is1-ssl.mzstatic.com/image/thumb/Music/x/100x100bb.jpg",
    };
}

/** A filename-only import: "Sabrina Carpenter - Espresso.mp3" with no tags, 175 s long. */
function weakTrack(extra = {}) {
    const meta = Library.buildImportedTrackMeta(
        { name: "Sabrina Carpenter - Espresso.mp3", size: 4000, relativePath: "Downloads/Sabrina Carpenter - Espresso.mp3" },
        { tags: {}, duration: 175.4 }
    );
    return { ...meta, ...extra };
}

/** fetch stub: routes by host, records calls with the fake clock time. */
function fakeNetwork(routes, clock) {
    const calls = [];
    const fetch = async (url, init) => {
        const host = new URL(url).host;
        calls.push({ url, host, at: clock ? clock.t : 0, init });
        const handler = routes[host];
        if (!handler) throw new TypeError("Failed to fetch");
        const out = await handler(url, calls.filter((c) => c.host === host).length);
        if (out instanceof Error) throw out;
        if (out && out.status) return { ok: false, status: out.status, json: async () => ({}) };
        return { ok: true, status: 200, json: async () => out };
    };
    return { fetch, calls };
}

function fakeClock() {
    const clock = { t: 1_000_000 };
    clock.now = () => clock.t;
    clock.sleep = async (ms) => {
        clock.t += ms;
    };
    return clock;
}

function memoryCache() {
    const map = new Map();
    return { map, get: async (id) => map.get(id) || null, set: async (rec) => map.set(rec.trackId, rec) };
}

// ---------- matching ----------

test("lookup: text normalising ignores video noise, feat. credits, accents and punctuation", () => {
    assert.equal(M.normalizeForMatch("Espresso (Official Music Video)"), "espresso");
    assert.equal(M.normalizeForMatch("Señorita (feat. Camila Cabello) [Lyrics]"), "senorita");
    assert.equal(M.normalizeForMatch("Don’t Stop Me Now - Remastered 2011"), "dont stop me now remastered 2011");
    assert.equal(M.similarity("Espresso", "ESPRESSO (Official Video)"), 1);
    assert.ok(M.similarity("Please Please Please", "Espresso") < 0.4);
    assert.ok(M.similarity("Sabrina Carpenter", "Sabrina Carpentar") > 0.85);
});

test("lookup: imports record where each field came from (tags vs file name vs generated)", () => {
    const tagged = Library.buildImportedTrackMeta(
        { name: "x.mp3", size: 10 },
        { tags: { title: "One", artist: "Alpha", album: "First", genre: "Rock", year: "1999" }, duration: 100 }
    );
    assert.deepEqual(tagged.tagSources, { title: "tag", artist: "tag", album: "tag", year: "tag", genre: "tag", cover: "generated" });
    assert.deepEqual(M.getWeakFields(tagged), ["cover"]);
    assert.equal(M.needsLookup(tagged), true, "a generated cover is worth looking up");

    const weak = weakTrack();
    assert.equal(weak.primaryArtist, "Sabrina Carpenter");
    assert.equal(weak.tagSources.artist, "filename");
    assert.equal(weak.tagSources.album, "folder");
    assert.deepEqual(M.getWeakFields(weak), ["title", "artist", "album", "genre", "year", "cover"]);

    const noArtist = Library.buildImportedTrackMeta({ name: "track01.mp3", size: 10 }, { tags: {} });
    assert.equal(noArtist.tagSources.artist, "missing");
    assert.equal(M.needsLookup({ ...noArtist, importStatus: "pending" }), false, "pending rows wait for their tags");

    // Imports saved before item 15 have no tagSources: judged by placeholder values
    const legacy = { isLocalImport: true, title: "Song", primaryArtist: "Unknown Artist", album: "Song (Local)", genre: "Pop", hasEmbeddedCover: true, coverUrl: "data:image/jpeg;base64,AAAA" };
    assert.deepEqual(M.getWeakFields(legacy), ["artist", "album"]);
    assert.deepEqual(M.getWeakFields({ ...legacy, primaryArtist: "Alpha", album: "First" }), []);
    assert.equal(M.needsLookup(CATALOG[0]), false, "bundled catalog songs are never looked up");
});

test("lookup: MusicBrainz query escapes Lucene syntax and leaves out placeholder artists", () => {
    const q = M.buildMusicBrainzQuery({ title: 'Hello: "World" (Live)', primaryArtist: "AC/DC" });
    assert.equal(q, 'recording:"Hello\\: \\"World\\" \\(Live\\)" AND artist:"AC\\/DC"');
    assert.equal(M.buildMusicBrainzQuery({ title: "Intro", primaryArtist: "Unknown Artist" }), 'recording:"Intro"');
    assert.equal(M.cleanTitleForQuery("One More Time (Official Video)"), "One More Time");
    assert.equal(M.cleanTitleForQuery("Señorita (feat. Camila Cabello) [Lyrics]"), "Señorita");
    assert.equal(M.cleanTitleForQuery("Live (Official Video)"), "Live");
    assert.ok(M.buildItunesUrl({ title: "Song [HD]", primaryArtist: "X" }).includes("term=Song%20X"));
    const url = M.buildMusicBrainzUrl({ title: "Espresso", primaryArtist: "Sabrina Carpenter" });
    assert.ok(url.startsWith("https://musicbrainz.org/ws/2/recording?query="));
    assert.ok(url.includes("&fmt=json"));
    assert.ok(M.buildItunesUrl({ title: "Espresso", primaryArtist: "Sabrina Carpenter" }, "cb1").endsWith("&callback=cb1"));
    assert.ok(M.buildItunesUrl({ title: "Espresso" }).includes("entity=song"));
    assert.equal(M.coverArtUrl("abc"), "https://coverartarchive.org/release/abc/front-250");
});

test("lookup: response parsing prefers the official studio album and upsizes iTunes artwork", () => {
    const [mb] = M.parseMusicBrainzRecordings(mbResponse([mbRecording({ title: "Espresso", artist: "Sabrina Carpenter", length: 175000 })]));
    assert.equal(mb.album, "Short n' Sweet", "official album beats the live broadcast");
    assert.equal(mb.coverUrl, "https://coverartarchive.org/release/rel-album/front-250");
    assert.equal(mb.durationSec, 175);
    assert.equal(mb.year, 2024);
    const [it] = M.parseItunesResults(itunesResponse([itunesSong({ title: "Espresso", artist: "Sabrina Carpenter", ms: 175459 })]));
    assert.equal(it.genre, "Pop");
    assert.ok(it.coverUrl.endsWith("/600x600bb.jpg"));
    assert.deepEqual(M.parseMusicBrainzRecordings({}), []);
});

test("lookup: only close title + artist + duration within ±3 s is confident", () => {
    const track = weakTrack();
    const cand = { title: "Espresso", artist: "Sabrina Carpenter", artists: ["Sabrina Carpenter"], durationSec: 175 };
    const good = M.scoreCandidate(track, cand);
    assert.equal(good.confident, true);
    assert.ok(good.score > 0.95);
    assert.equal(M.scoreCandidate(track, { ...cand, durationSec: 178.3 }).confident, true, "3 s is the limit");
    assert.equal(M.scoreCandidate(track, { ...cand, durationSec: 183 }).confident, false, "8 s off = remix/live, ask");
    assert.equal(M.scoreCandidate({ ...track, duration: 0 }, cand).confident, false, "unknown length is never confident");
    assert.equal(M.scoreCandidate({ ...track, primaryArtist: "Unknown Artist", artists: [] }, cand).confident, false);
    assert.equal(M.scoreCandidate(track, { ...cand, artist: "Someone Else", artists: ["Someone Else"] }).confident, false);
});

// ---------- client ----------

test("lookup client: MusicBrainz requests are at least 1.1 s apart, results cached once per track", async () => {
    const clock = fakeClock();
    const cache = memoryCache();
    const net = fakeNetwork(
        {
            "musicbrainz.org": () => mbResponse([mbRecording({ title: "Espresso", artist: "Sabrina Carpenter", length: 175000 })]),
            "itunes.apple.com": () => itunesResponse([itunesSong({ title: "Espresso", artist: "Sabrina Carpenter", ms: 175459 })]),
        },
        clock
    );
    const client = M.createLookupClient({ fetch: net.fetch, cache, now: clock.now, sleep: clock.sleep });
    const tracks = [weakTrack({ id: "a" }), weakTrack({ id: "b" }), weakTrack({ id: "c" })];
    const results = await Promise.all(tracks.map((t) => client.lookupTrack(t)));
    const mbCalls = net.calls.filter((c) => c.host === "musicbrainz.org");
    assert.equal(mbCalls.length, 3);
    for (let i = 1; i < mbCalls.length; i++) assert.ok(mbCalls[i].at - mbCalls[i - 1].at >= 1100, "1 request per second");
    const itCalls = net.calls.filter((c) => c.host === "itunes.apple.com");
    for (let i = 1; i < itCalls.length; i++) assert.ok(itCalls[i].at - itCalls[i - 1].at >= 3000);
    assert.equal(mbCalls[0].init.headers["User-Agent"], M.USER_AGENT);
    assert.equal(mbCalls[0].init.credentials, "omit");

    assert.equal(results[0].status, "confident");
    const s = results[0].suggestion;
    assert.equal(s.fields.album, "Short n' Sweet");
    assert.equal(s.fields.genre, "Pop");
    assert.ok(s.fields.coverUrl.includes("mzstatic"), "iTunes artwork preferred (always present)");
    assert.equal(s.sources.musicbrainzId, "rec-1");

    // Second lookup: from the cache, no network
    const before = net.calls.length;
    const again = await client.lookupTrack(tracks[0]);
    assert.equal(again.cached, true);
    assert.equal(net.calls.length, before);
    // Edited title = different signature = looked up again; force always goes to the network
    await client.lookupTrack({ ...tracks[0], title: "Espresso (Remix)" });
    await client.lookupTrack(tracks[0], { force: true });
    assert.equal(net.calls.filter((c) => c.host === "musicbrainz.org").length, 5);
});

test("lookup client: 503 backs off and retries once; errors are not cached; iTunes skipped when it adds nothing", async () => {
    const clock = fakeClock();
    const cache = memoryCache();
    let mbStatus = 503;
    const net = fakeNetwork(
        {
            "musicbrainz.org": (url, n) => (n === 1 ? { status: mbStatus } : mbResponse([mbRecording({ title: "One", artist: "Alpha", length: 100000 })])),
            "itunes.apple.com": () => itunesResponse([]),
        },
        clock
    );
    const client = M.createLookupClient({ fetch: net.fetch, cache, now: clock.now, sleep: clock.sleep });
    // Tagged song (artist/title/genre/cover from the file) with only the album missing
    const tagged = {
        ...Library.buildImportedTrackMeta({ name: "x.mp3", size: 1 }, { tags: { title: "One", artist: "Alpha", genre: "Rock", picture: { mime: "image/jpeg", data: new Uint8Array([255, 216, 255, 1]) } }, duration: 101 }),
        id: "t1",
    };
    assert.deepEqual(M.getWeakFields(tagged), ["album", "year"]);
    const r = await client.lookupTrack(tagged);
    assert.equal(r.status, "confident");
    assert.equal(net.calls.filter((c) => c.host === "musicbrainz.org").length, 2, "503 then retry");
    assert.equal(net.calls.filter((c) => c.host === "itunes.apple.com").length, 0, "confident + no cover/genre needed = no iTunes call");

    // Network down: status error, nothing cached
    const down = M.createLookupClient({ fetch: async () => { throw new TypeError("offline"); }, jsonp: async () => { throw new Error("offline"); }, cache, now: clock.now, sleep: clock.sleep });
    const e = await down.lookupTrack(weakTrack({ id: "offline" }));
    assert.equal(e.status, "error");
    assert.equal(cache.map.has("offline"), false);
});

test("lookup client: iTunes falls back to JSONP when the CORS fetch is refused", async () => {
    const clock = fakeClock();
    const jsonpUrls = [];
    const client = M.createLookupClient({
        fetch: async (url) => {
            if (url.includes("itunes")) throw new TypeError("Failed to fetch");
            return { ok: true, json: async () => mbResponse([]) };
        },
        jsonp: async (buildUrl) => {
            jsonpUrls.push(buildUrl("cb_test"));
            return itunesResponse([itunesSong({ title: "Espresso", artist: "Sabrina Carpenter", ms: 175459 })]);
        },
        now: clock.now,
        sleep: clock.sleep,
    });
    const r = await client.lookupTrack(weakTrack({ id: "j1" }));
    assert.equal(client.getItunesMode(), "jsonp");
    assert.ok(jsonpUrls[0].includes("callback=cb_test"));
    assert.equal(r.suggestion.sources.primary, "itunes");
    assert.equal(r.suggestion.fields.genre, "Pop");
    await client.lookupTrack(weakTrack({ id: "j2" }));
    assert.equal(jsonpUrls.length, 2, "stays on JSONP for the session");
});

test("lookup: near-equal matches prefer the studio album over compilations and live releases", () => {
    const track = { ...weakTrack(), duration: 246 }; // file length doesn't match any release
    const recs = M.parseMusicBrainzRecordings(
        mbResponse([
            mbRecording({ id: "comp", title: "Espresso", artist: "Sabrina Carpenter", length: 0, releases: [{ id: "c", title: "100% Radio Hits", status: "Official", "release-group": { "primary-type": "Album", "secondary-types": ["Compilation"] } }] }),
            mbRecording({ id: "studio", title: "Espresso", artist: "Sabrina Carpenter", length: 0 }),
        ])
    );
    const ranked = M.rankCandidates(track, recs);
    assert.equal(ranked[0].id, "studio");
    // A length-less live bootleg doesn't beat the studio take whose length is merely off
    const bootleg = M.parseMusicBrainzRecordings(
        mbResponse([
            mbRecording({ id: "studio2", title: "Espresso", artist: "Sabrina Carpenter", length: 175000 }),
            mbRecording({ id: "boot", title: "Espresso", artist: "Sabrina Carpenter", length: 0, releases: [{ id: "b", title: "Live in Buenos Aires", status: "Bootleg", "release-group": { "primary-type": "Album", "secondary-types": ["Live"] } }] }),
        ])
    );
    assert.equal(M.rankCandidates(track, bootleg)[0].id, "studio2");
    // ...but a studio take whose length matches the file always beats one that doesn't
    const exact = M.rankCandidates({ ...track, duration: 175 }, bootleg);
    assert.equal(exact[0].id, "studio2");
    assert.equal(exact[0].match.confident, true);
    assert.equal(ranked[0].album, "Short n' Sweet");
    const it = M.parseItunesResults(itunesResponse([itunesSong({ title: "Espresso", artist: "Sabrina Carpenter", album: "Greatest Hits 2024", ms: 0 })]));
    assert.ok(it[0].releaseQuality < 0.5);
});

test("lookup: changes never touch tag values unless asked; patches mark fields as online", () => {
    const track = {
        ...Library.buildImportedTrackMeta({ name: "Alpha - One.mp3", size: 1 }, { tags: { title: "One (Demo)", artist: "Alpha" }, duration: 100 }),
        id: "p1",
    };
    const suggestion = {
        fields: { title: "One", artists: ["Alpha", "Beta"], artist: "Alpha", album: "First", year: 2001, genre: "Rock", coverUrl: "https://x/600x600bb.jpg" },
        sources: { primary: "musicbrainz", musicbrainzId: "m1" },
        score: 0.9,
    };
    const safe = M.computeChanges(track, suggestion);
    assert.deepEqual(safe.map((c) => c.field), ["album", "year", "genre", "cover"], "title/artist came from the file's tags");
    const all = M.computeChanges(track, suggestion, { overwriteTags: true });
    assert.deepEqual(all.map((c) => c.field), ["title", "artist", "album", "year", "genre", "cover"]);
    assert.equal(all.find((c) => c.field === "title").fromFile, true);

    const patch = M.buildPatch(track, suggestion, all, { now: 5, auto: false });
    assert.equal(patch.title, "One");
    assert.deepEqual(patch.artists, ["Alpha", "Beta"]);
    assert.equal(patch.artistDisplay, "Alpha, Beta");
    assert.equal(patch.coverUrl, "https://x/600x600bb.jpg");
    assert.equal(patch.tagSources.album, "online");
    assert.equal(patch.onlineMatch.musicbrainzId, "m1");
    assert.deepEqual(M.getWeakFields({ ...track, ...patch }), [], "applied fields stop counting as weak");
    assert.equal(M.summarizeLookup({ applied: 18, suggested: 6, none: 16 }), "Updated 18 songs · 6 to review · 16 not found");
    assert.equal(M.summarizeLookup({ applied: 1, cancelled: true }), "Stopped · Updated 1 song");
});

// ---------- storage ----------

test("storage: tagSources persist, updateImportedTrack edits metadata only, lookup cache is per track", async () => {
    const store = memoryStore();
    const meta = weakTrack({ id: "s1" });
    const saved = await store.saveImportedTrack(meta, new Uint8Array([1, 2, 3]));
    assert.equal(saved.tagSources.artist, "filename");
    const updated = await store.updateImportedTrack("s1", { album: "Short n' Sweet", audioUrl: "https://evil", size: 1, coverUrl: "blob:page/1", tagSources: { album: "online" } });
    assert.equal(updated.album, "Short n' Sweet");
    assert.equal(updated.size, saved.size, "audio fields can't be patched");
    assert.equal(updated.audioUrl, saved.audioUrl);
    assert.equal(updated.coverUrl, saved.coverUrl, "page-only blob: covers are never persisted");
    assert.equal(await store.updateImportedTrack("missing", { album: "x" }), null);
    const [hydrated] = await store.getImportedTracks();
    assert.equal(hydrated.album, "Short n' Sweet");

    await store.saveMetadataLookup({ trackId: "s1", signature: "sig", status: "none" });
    assert.equal((await store.getMetadataLookup("s1")).status, "none");
    await store.deleteImportedTrack("s1");
    assert.equal(await store.getMetadataLookup("s1"), null, "deleting a song drops its cached lookup");
});

// ---------- shell ----------

function fakeLookupClient(byId) {
    const calls = [];
    return {
        calls,
        async lookupTrack(track, opts = {}) {
            calls.push({ id: track.id, force: Boolean(opts.force) });
            const r = byId[track.id];
            if (typeof r === "function") return r(track);
            return r || { status: "none", suggestion: null };
        },
    };
}

const SUGGESTION = (over = {}) => ({
    fields: { title: "Espresso", artists: ["Sabrina Carpenter"], artist: "Sabrina Carpenter", album: "Short n' Sweet", year: 2024, genre: "Pop", coverUrl: "https://is1-ssl.mzstatic.com/a/600x600bb.jpg" },
    sources: { primary: "musicbrainz", musicbrainzId: "m1", itunesId: "1", cover: "itunes" },
    score: 0.97,
    match: { score: 0.97, titleSim: 1, artistSim: 1, durationDiff: 0.4, confident: true },
    ...over,
});

async function shellWithLocalTracks() {
    const env = createShellSandbox();
    const { shell, sandbox, el } = env;
    const store = sandbox.SpotTubeStorage;
    const local = [
        weakTrack({ id: "w-confident" }),
        { ...weakTrack({ id: "w-suggest" }), title: "Espreso", filename: "espreso.mp3" },
        { ...weakTrack({ id: "w-none" }), title: "Field Recording 3" },
        { ...Library.buildImportedTrackMeta({ name: "ok.mp3", size: 9 }, { tags: { title: "Fine", artist: "Band", album: "LP", genre: "Rock", year: "2000", picture: { mime: "image/jpeg", data: new Uint8Array([255, 216, 255, 1]) } }, duration: 90 }), id: "w-complete" },
    ];
    for (const t of local) await store.saveImportedTrack(t, new Uint8Array([1]));
    shell.setState({ songs: [...local.map((t) => ({ ...t, audioUrl: "blob:x" })), ...CATALOG] });
    const announcements = [];
    let live = "";
    Object.defineProperty(el("import-live"), "textContent", {
        get: () => live,
        set: (v) => {
            live = v;
            if (v) announcements.push(v);
        },
    });
    return { ...env, store, local, announcements };
}

test("shell: lookup is off by default; asking for it opens Settings, and closing with it on continues", async () => {
    const { shell, el, sandbox } = await shellWithLocalTracks();
    const client = fakeLookupClient({});
    shell.setMetadataLookupClient(client);
    assert.equal(shell.isOnlineLookupEnabled(), false);

    const btn = el("detail-lookup-btn");
    await shell.lookUpMissingInfo({ returnFocus: btn });
    assert.equal(client.calls.length, 0, "nothing is sent while the setting is off");
    assert.equal(el("settings-dialog").hidden, false);
    assert.equal(el("settings-lookup-note").hidden, false);
    assert.ok(el("settings-lookup-note").textContent.includes("Online lookup is off"));
    assert.equal(sandbox.document.activeElement, el("setting-online-lookup"), "focus starts on the switch");

    // Background (after-import) lookups never prompt
    shell.closeSettingsDialog();
    await shell.lookUpMissingInfo({ background: true });
    assert.equal(el("settings-dialog").hidden, true);

    await shell.lookUpMissingInfo({ returnFocus: btn });
    el("setting-online-lookup").checked = true;
    el("setting-online-lookup").trigger("change");
    assert.equal(shell.isOnlineLookupEnabled(), true);
    assert.equal(el("setting-online-lookup").getAttribute("aria-checked"), "true");
    assert.equal(el("setting-online-lookup-state").textContent, "On");
    el("settings-done-btn").click();
    assert.equal(sandbox.document.activeElement, btn, "focus goes back to the button");
    await shell.getLookupRun()?.promise;
    assert.ok(client.calls.length >= 3, "the pending lookup ran after closing Settings");
    assert.equal(sandbox.SpotTubeStorage.getPreferences().onlineLookup, true, "setting is saved");
});

test("shell: Look up missing info applies confident matches to missing fields only and queues the rest", async () => {
    const { shell, el, store, announcements, sandbox } = await shellWithLocalTracks();
    shell.setOnlineLookupEnabled(true);
    const client = fakeLookupClient({
        "w-confident": { status: "confident", suggestion: SUGGESTION() },
        "w-suggest": { status: "suggested", suggestion: SUGGESTION({ score: 0.71, match: { score: 0.71, durationDiff: 9 } }) },
        "w-none": { status: "none", suggestion: null },
    });
    shell.setMetadataLookupClient(client);
    shell.openLocalFilesDetail();
    const done = await shell.lookUpMissingInfo();

    assert.deepEqual(client.calls.map((c) => c.id).sort(), ["w-confident", "w-none", "w-suggest"], "complete songs aren't looked up");
    assert.deepEqual(JSON.parse(JSON.stringify(done.counts)), { applied: 1, suggested: 1, none: 1, errors: 0, cancelled: false });
    const t = shell.getImportedLocalTracks().find((x) => x.id === "w-confident");
    assert.equal(t.album, "Short n' Sweet");
    assert.equal(t.genre, "Pop");
    assert.equal(t.tagSources.album, "online");
    assert.equal(t.onlineMatch.auto, true);
    const [saved] = (await store.getImportedTracks()).filter((x) => x.id === "w-confident");
    assert.equal(saved.album, "Short n' Sweet", "saved to IndexedDB");
    assert.equal(saved.coverUrl, SUGGESTION().fields.coverUrl);
    assert.equal(shell.getImportedLocalTracks().find((x) => x.id === "w-suggest").album, "Downloads", "suggestions wait for review");

    assert.ok(el("library-toast").textContent.startsWith("Updated 1 song · 1 to review · 1 not found"));
    assert.ok(el("library-toast").children.some((b) => b.textContent === "Review suggestions"));
    assert.equal(el("detail-review-matches-btn").hidden, false);
    assert.equal(el("detail-review-matches-btn").textContent, "Review suggestions (1)");
    assert.equal(el("lookup-progress").hidden, true, "progress hides when done");
    assert.equal(announcements.length, 1, "polite start announcement only; no per-track chatter (the toast says the end)");
    assert.ok(announcements[0].includes("Looking up info for 3 songs"));
    assert.equal(sandbox.SpotTubeShell.getLookupRun(), null);
});

test("shell: suggested match review — Accept, Skip, overwrite toggle, focus and full keyboard flow", async () => {
    const { shell, el, store, sandbox } = await shellWithLocalTracks();
    shell.setOnlineLookupEnabled(true);
    shell.setMetadataLookupClient(
        fakeLookupClient({
            "w-confident": { status: "suggested", suggestion: SUGGESTION({ score: 0.8 }) },
            "w-suggest": { status: "suggested", suggestion: SUGGESTION({ score: 0.7 }) },
        })
    );
    shell.openLocalFilesDetail();
    await shell.lookUpMissingInfo();
    assert.equal(shell.getLookupReviewQueue().length, 2);

    const reviewBtn = el("detail-review-matches-btn");
    reviewBtn.click();
    assert.equal(el("match-review-dialog").hidden, false);
    assert.equal(el("match-review-progress").textContent, "1 of 2");
    assert.ok(el("match-review-source").textContent.startsWith("From MusicBrainz + iTunes · 80% match"));
    const rows = el("match-review-rows").children;
    assert.ok(rows.length >= 4, "one row per changed field");
    assert.equal(el("match-review-accept-btn").textContent, `Accept ${rows.length} changes`);
    assert.equal(sandbox.document.activeElement, el("match-review-accept-btn"));

    // Keyboard shortcuts stay out of dialogs (Space must press the focused button, not toggle playback)
    const inDialog = { key: " ", target: { tagName: "BUTTON", closest: (sel) => (sel === "dialog[open]" ? { id: "match-review-dialog" } : null) }, preventDefault() {} };
    assert.equal(shell.handleShellKeyDown(inDialog).handled, false);

    el("match-review-accept-btn").click();
    await new Promise((r) => setImmediate(r));
    const first = shell.getImportedLocalTracks().find((x) => x.id === "w-confident");
    assert.equal(first.album, "Short n' Sweet");
    assert.equal(first.onlineMatch.auto, false);
    assert.equal(el("match-review-progress").textContent, "2 of 2");
    assert.ok(el("match-review-live").textContent.startsWith("Next: 2 of 2"));

    el("match-review-skip-btn").click();
    await new Promise((r) => setImmediate(r));
    assert.equal(el("match-review-dialog").hidden, true);
    assert.equal(sandbox.document.activeElement, reviewBtn, "focus returns to Review suggestions");
    assert.equal(el("library-toast").textContent, "All suggestions reviewed.");
    assert.equal(shell.getLookupReviewQueue().length, 0);
    assert.equal((await store.getMetadataLookup("w-suggest")), null, "fake client has no cache; decision write is a no-op");
    assert.equal(shell.getImportedLocalTracks().find((x) => x.id === "w-suggest").album, "Downloads", "skipped = unchanged");
});

test("shell: Fix info looks one song up fresh, offers tag overwrites behind a checkbox, toasts misses", async () => {
    const { shell, el } = await shellWithLocalTracks();
    shell.setOnlineLookupEnabled(true);
    const client = fakeLookupClient({
        "w-complete": { status: "confident", suggestion: SUGGESTION({ fields: { ...SUGGESTION().fields, title: "Fine (2019 Remaster)", artists: ["Band"], artist: "Band", album: "LP", genre: "Rock", year: 2000, coverUrl: "" } }) },
        "w-none": { status: "none", suggestion: null },
        "w-confident": { status: "error" },
    });
    shell.setMetadataLookupClient(client);

    await shell.fixTrackMetadata("w-none");
    assert.equal(el("library-toast").textContent, "No match found online for “Field Recording 3”.");
    await shell.fixTrackMetadata("w-confident");
    assert.ok(el("library-toast").textContent.startsWith("Couldn't reach the music info services"));

    await shell.fixTrackMetadata("w-complete");
    assert.equal(client.calls.at(-1).force, true, "Fix info skips the cache");
    assert.equal(el("match-review-dialog").hidden, false);
    assert.equal(el("match-review-overwrite-wrap").hidden, false, "the only change is a tag value, so the checkbox shows");
    assert.equal(el("match-review-overwrite").checked, true, "single-song fix with only tag changes starts checked");
    assert.equal(el("match-review-rows").children.length, 1);
    el("match-review-overwrite").checked = false;
    el("match-review-overwrite").trigger("change");
    assert.equal(el("match-review-rows").children.length, 0);
    assert.equal(el("match-review-empty").hidden, false);
    assert.equal(el("match-review-accept-btn").disabled, true);
    el("match-review-overwrite").checked = true;
    el("match-review-overwrite").trigger("change");
    el("match-review-accept-btn").click();
    await new Promise((r) => setImmediate(r));
    const t = shell.getImportedLocalTracks().find((x) => x.id === "w-complete");
    assert.equal(t.title, "Fine (2019 Remaster)");
    assert.equal(t.tagSources.title, "online");
    assert.equal(el("match-review-dialog").hidden, true);
    assert.equal(el("library-toast").textContent, "Updated “Fine (2019 Remaster)”.");
});

test("shell: Stop cancels a running lookup between songs", async () => {
    const { shell } = await shellWithLocalTracks();
    shell.setOnlineLookupEnabled(true);
    let release;
    const gate = new Promise((r) => (release = r));
    const client = fakeLookupClient({
        "w-confident": async () => {
            await gate;
            return { status: "none" };
        },
    });
    shell.setMetadataLookupClient(client);
    const run = shell.lookUpMissingInfo();
    await new Promise((r) => setImmediate(r));
    assert.ok(shell.getLookupRun());
    assert.equal(shell.cancelMetadataLookup(), true);
    release();
    const result = await run;
    assert.equal(result.counts.cancelled, true);
    assert.equal(client.calls.length, 1, "no more songs were looked up after Stop");
    assert.ok(result.summary.startsWith("Stopped"));
});

test("item 15 HTML/CSS hooks: settings + review dialogs, privacy text, keyless services only", () => {
    const html = fs.readFileSync(path.join(ROOT_DIR, "index.html"), "utf8");
    const css = fs.readFileSync(path.join(ROOT_DIR, "style.css"), "utf8");
    const js = fs.readFileSync(path.join(ROOT_DIR, "metadata-lookup.js"), "utf8");
    assert.ok(html.indexOf('src="metadata-lookup.js"') < html.indexOf('src="script.js"'));
    assert.ok(html.includes('id="settings-btn" aria-label="Settings"'));
    assert.match(html, /<input type="checkbox" role="switch" id="setting-online-lookup" aria-checked="false" aria-describedby="setting-online-lookup-desc">/);
    assert.ok(!/id="setting-online-lookup"[^>]*checked(?!=)/.test(html.replace('aria-checked="false"', "")), "off by default");
    for (const host of ["musicbrainz.org", "itunes.apple.com", "coverartarchive.org"]) assert.ok(html.includes(host), `says data goes to ${host}`);
    assert.ok(html.includes("Your audio files never leave this device"));
    assert.match(html, /<dialog[^>]*id="match-review-dialog"[^>]*aria-labelledby="match-review-title"/);
    assert.ok(html.includes('<th scope="col">Current</th><th scope="col">Suggested</th>'));
    assert.ok(html.includes('id="match-review-accept-btn"') && html.includes('id="match-review-skip-btn"'));
    assert.ok(html.includes('id="detail-lookup-btn"') && html.includes('id="lookup-progress-bar" role="progressbar"'));
    assert.match(css, /@media \(max-width: 740px\)[\s\S]*\.match-review-dialog \{[\s\S]*block-size: 100dvh/);
    assert.ok(css.includes("@media (prefers-reduced-motion: reduce)"));
    assert.ok(!/acoustid|api[_-]?key|apikey/i.test(js + html), "no AcoustID and no API keys");
});
