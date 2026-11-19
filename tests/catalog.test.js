const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  buildCatalog,
  parseTrackFilename,
  parseArtistList,
  encodeRelativePath,
  formatDuration,
} = require("../scripts/build-catalog.js");

const ROOT_DIR = path.resolve(__dirname, "..");

test("buildCatalog generates valid tracks.json manifest for all /songs and /Images", () => {
  const manifest = buildCatalog({ rootDir: ROOT_DIR, writeToFile: true });

  assert.equal(manifest.version, "1.0.0");
  assert.equal(manifest.totalTracks, 12);
  assert.equal(manifest.tracks.length, 12);
  assert.ok(manifest.genres.length >= 6);
  assert.ok(manifest.moods.includes("Upbeat"));
  assert.ok(manifest.moods.includes("Chill"));
  assert.ok(manifest.moods.includes("Deep Cuts"));

  for (const track of manifest.tracks) {
    assert.ok(track.id && typeof track.id === "string");
    assert.ok(track.title && typeof track.title === "string");
    assert.ok(track.primaryArtist && typeof track.primaryArtist === "string");
    assert.ok(Array.isArray(track.featuredArtists));
    assert.ok(Array.isArray(track.artists) && track.artists.length >= 1);
    assert.ok(track.artistDisplay && typeof track.artistDisplay === "string");
    assert.ok(track.album && typeof track.album === "string");
    assert.ok(Number.isInteger(track.year) && track.year >= 1950 && track.year <= 2030);
    assert.ok(typeof track.duration === "number" && track.duration > 120 && track.duration < 400);
    assert.match(track.durationFormatted, /^\d+:\d{2}$/);
    assert.ok(track.bitrateKbps === 192 || track.bitrateKbps === 320);

    // Relative URL checks (no leading slash, no hardcoded 127.0.0.1)
    assert.ok(!track.audioUrl.startsWith("/"), `audioUrl must be relative: ${track.audioUrl}`);
    assert.ok(!track.audioUrl.includes("127.0.0.1"));
    assert.ok(!track.coverUrl.startsWith("/"), `coverUrl must be relative: ${track.coverUrl}`);
    assert.ok(!track.coverUrl.includes("127.0.0.1"));

    // Verify decoded relative URLs resolve to real files on disk
    const decodedAudioPath = path.join(
      ROOT_DIR,
      ...track.audioUrl.split("/").map((s) => decodeURIComponent(s))
    );
    const decodedCoverPath = path.join(
      ROOT_DIR,
      ...track.coverUrl.split("/").map((s) => decodeURIComponent(s))
    );
    assert.ok(fs.existsSync(decodedAudioPath), `Missing audio file on disk: ${decodedAudioPath}`);
    assert.ok(fs.existsSync(decodedCoverPath), `Missing cover file on disk: ${decodedCoverPath}`);

    // Audio features & mood tags checks
    assert.ok(Array.isArray(track.moods) && track.moods.length >= 2);
    assert.ok(typeof track.bpm === "number" && track.bpm >= 60 && track.bpm <= 200);
    assert.ok(track.energy >= 0 && track.energy <= 1);
    assert.ok(track.valence >= 0 && track.valence <= 1);
    assert.ok(track.danceability >= 0 && track.danceability <= 1);
    assert.ok(track.acousticness >= 0 && track.acousticness <= 1);
    assert.ok(track.popularity >= 0 && track.popularity <= 1);
    assert.deepEqual(track.audioFeatures, {
      bpm: track.bpm,
      energy: track.energy,
      valence: track.valence,
      danceability: track.danceability,
      acousticness: track.acousticness,
      popularity: track.popularity,
    });
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
