const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const os = require("node:os");
const { buildMp3 } = require("./helpers.js");

const {
  buildCatalog,
  parseTrackFilename,
  parseArtistList,
  encodeRelativePath,
  formatDuration,
} = require("../scripts/build-catalog.js");

const ROOT_DIR = path.resolve(__dirname, "..");

test("buildCatalog generates a valid empty tracks.json manifest when /songs has 0 included songs", () => {
  const manifest = buildCatalog({ rootDir: ROOT_DIR, writeToFile: true });

  assert.equal(manifest.version, "1.0.0");
  assert.equal(manifest.totalTracks, 0);
  assert.deepEqual(manifest.tracks, []);
  assert.deepEqual(manifest.genres, []);
  assert.deepEqual(manifest.moods, []);
  assert.deepEqual(manifest.artists, []);
  assert.deepEqual(manifest.albums, []);
});

test("buildCatalog indexes audio files and matching covers when present in a songs/ directory", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "spottube-catalog-"));
  try {
    fs.mkdirSync(path.join(tmpDir, "songs"), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, "Images"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, "songs", "Espresso-Sabrina Carpenter.mp3"),
      buildMp3({ title: "Espresso", artist: "Sabrina Carpenter", audioBytes: 2_800_000 })
    );
    fs.writeFileSync(path.join(tmpDir, "Images", "Espresso.jpeg"), Buffer.from([0xff, 0xd8, 0xff, 0xd9]));

    const manifest = buildCatalog({ rootDir: tmpDir, writeToFile: true });
    assert.equal(manifest.version, "1.0.0");
    assert.equal(manifest.totalTracks, 1);
    assert.equal(manifest.tracks.length, 1);

    const track = manifest.tracks[0];
    assert.equal(track.id, "espresso-sabrina-carpenter");
    assert.equal(track.title, "Espresso");
    assert.equal(track.primaryArtist, "Sabrina Carpenter");
    assert.ok(track.duration > 120 && track.duration < 250);
    assert.match(track.durationFormatted, /^\d+:\d{2}$/);
    assert.ok(!track.audioUrl.startsWith("/") && !track.audioUrl.includes("127.0.0.1"));
    assert.equal(track.coverUrl, "Images/Espresso.jpeg");
    assert.deepEqual(track.audioFeatures, {
      bpm: track.bpm,
      energy: track.energy,
      valence: track.valence,
      danceability: track.danceability,
      acousticness: track.acousticness,
      popularity: track.popularity,
    });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("parseTrackFilename splits primary and featured artists across commas, 'and', and enrichment", () => {
  const likeThat = parseTrackFilename("Like That-Future and Metro Boomin.mp3");
  assert.equal(likeThat.title, "Like That");
  assert.equal(likeThat.primaryArtist, "Future");
  assert.deepEqual(likeThat.featuredArtists, ["Metro Boomin", "Kendrick Lamar"]);
  assert.deepEqual(likeThat.artists, ["Future", "Metro Boomin", "Kendrick Lamar"]);

  const veKamleya = parseTrackFilename("Ve Kamleya-Pritam, Arijit Singh, Shreya Ghoshal.mp3");
  assert.equal(veKamleya.title, "Ve Kamleya");
  assert.equal(veKamleya.primaryArtist, "Pritam");
  assert.deepEqual(veKamleya.featuredArtists, ["Arijit Singh", "Shreya Ghoshal"]);

  const custom = parseArtistList("Artist One & Artist Two feat. Artist Three");
  assert.deepEqual(custom, ["Artist One", "Artist Two", "Artist Three"]);
});

test("encodeRelativePath and formatDuration handle special characters and boundaries", () => {
  assert.equal(
    encodeRelativePath("songs/Tum Ho-Mohit Chauhan, Suzanne D'Mello.mp3"),
    "songs/Tum%20Ho-Mohit%20Chauhan%2C%20Suzanne%20D'Mello.mp3"
  );
  assert.equal(formatDuration(175.49), "2:55");
  assert.equal(formatDuration(0), "0:00");
  assert.equal(formatDuration(-5), "0:00");
});

test("vercel.json and script.js are configured for 100% static deployment without 127.0.0.1", () => {
  const vercelRaw = fs.readFileSync(path.join(ROOT_DIR, "vercel.json"), "utf8");
  const vercelConfig = JSON.parse(vercelRaw);
  assert.equal(vercelConfig.buildCommand, "node scripts/build-catalog.js");
  assert.equal(vercelConfig.outputDirectory, ".");

  const scriptJs = fs.readFileSync(path.join(ROOT_DIR, "script.js"), "utf8");
  assert.ok(!scriptJs.includes("127.0.0.1"), "script.js must not contain hardcoded 127.0.0.1 URLs");
  assert.ok(scriptJs.includes("./tracks.json"), "script.js must fetch relative ./tracks.json");
});

test("app boots cleanly with 0 included songs in tracks.json", async () => {
  const { createShellSandbox } = require("./helpers.js");
  const emptyManifest = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, "tracks.json"), "utf8"));
  assert.equal(emptyManifest.totalTracks, 0);
  assert.deepEqual(emptyManifest.tracks, []);

  const { sandbox, shell, el } = createShellSandbox();
  let fetchedSongsFallback = false;
  sandbox.fetch = async (url) => {
    const u = String(url);
    if (u.includes("songs/")) {
      fetchedSongsFallback = true;
      return { ok: false, status: 404 };
    }
    if (u.includes("yt-allowlist.json")) return { ok: true, json: async () => ({ videos: [] }) };
    if (u.includes("api/yt/status")) return { ok: false, status: 404, headers: { get: () => "text/html" }, json: async () => ({}) };
    return { ok: true, json: async () => emptyManifest };
  };

  const loaded = await shell.getSongs();
  assert.equal(loaded.length, 0);
  assert.equal(fetchedSongsFallback, false, "must not fall back to ./songs/ when tracks.json loads with 0 tracks");

  shell.setState({ songs: [] });
  shell.renderCatalogGrid();
  shell.renderHomeShelves();
  shell.renderLibrarySidebar();
  assert.equal(el("stat-track-count").textContent, "0");
  assert.equal(el("catalog-count-badge").textContent, "0 tracks");
  assert.equal(el("home-shelves").hidden, true);
});
