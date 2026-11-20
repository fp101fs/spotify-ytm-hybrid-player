#!/usr/bin/env node
/**
 * Static-First Catalog Indexer (`scripts/build-catalog.js`)
 *
 * Scans `/songs` and `/Images` to generate a rich `tracks.json` manifest
 * containing title, parsed primary/featured artists, album, year, duration,
 * genre, mood tags, BPM/energy/valence audio features, and relative URLs.
 *
 * Works 100% statically on Vercel and on any local static server (port 5500, etc.)
 * without hardcoded `127.0.0.1` URLs or native binary dependencies.
 */

const fs = require("node:fs");
const path = require("node:path");

const AUDIO_EXTENSIONS = new Set([".mp3", ".flac", ".wav", ".ogg", ".m4a"]);
const IMAGE_EXTENSIONS = [".jpeg", ".jpg", ".png", ".webp"];
const DEFAULT_COVER = "Images/spotify-white-logo-symbol-icon-hd-png-11661570403q5drcznuwu.png";

// MPEG Layer III bitrate lookup tables (kbps)
const BITRATES_V1_L3 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0];
const BITRATES_V2_L3 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0];
const SAMPLERATES_V1 = [44100, 48000, 32000, 0];
const SAMPLERATES_V2 = [22050, 24000, 16000, 0];
const SAMPLERATES_V25 = [11025, 12000, 8000, 0];

/**
 * Curated enrichment metadata for the bundled library tracks.
 * Newly added tracks in `/songs` automatically fall back to ID3v2 tags + deterministic heuristics.
 */
const TRACK_ENRICHMENTS = {
  "Ajab Si": {
    album: "Om Shanti Om",
    year: 2007,
    genre: "Bollywood Romance",
    subgenres: ["Bollywood", "Romantic Ballad", "Filmi", "Melody"],
    language: "Hindi",
    moods: ["Romantic", "Chill", "Soulful", "Feel Good", "Nostalgic"],
    bpm: 93,
    energy: 0.45,
    valence: 0.72,
    danceability: 0.54,
    acousticness: 0.62,
    popularity: 0.92,
  },
  "Binte Dil": {
    album: "Padmaavat",
    year: 2018,
    genre: "Bollywood Arabic Fusion",
    subgenres: ["Bollywood", "Sufi / Orchestral", "Filmi", "World"],
    language: "Hindi",
    moods: ["Energetic", "Passionate", "Deep Cuts", "Dramatic", "Late Night"],
    bpm: 102,
    energy: 0.74,
    valence: 0.48,
    danceability: 0.61,
    acousticness: 0.35,
    popularity: 0.81,
  },
  "Chashni": {
    album: "Bharat",
    year: 2019,
    genre: "Bollywood Romance",
    subgenres: ["Bollywood", "Modern Filmi", "Romantic", "Melody"],
    language: "Hindi",
    moods: ["Romantic", "Chill", "Feel Good", "Soulful"],
    bpm: 88,
    energy: 0.52,
    valence: 0.76,
    danceability: 0.58,
    acousticness: 0.55,
    popularity: 0.84,
  },
  "Espresso": {
    album: "Short n' Sweet",
    year: 2024,
    genre: "Pop",
    subgenres: ["Dance Pop", "Nu-Disco", "Synth Pop", "Funk Pop"],
    language: "English",
    moods: ["Upbeat", "Feel Good", "Party", "Energetic", "Workout"],
    bpm: 104,
    energy: 0.78,
    valence: 0.89,
    danceability: 0.86,
    acousticness: 0.14,
    popularity: 0.98,
  },
  "Like That": {
    extraArtists: ["Kendrick Lamar"],
    album: "WE DON'T TRUST YOU",
    year: 2024,
    genre: "Hip-Hop",
    subgenres: ["Trap", "Southern Hip-Hop", "Rap", "Hardcore Hip-Hop"],
    language: "English",
    moods: ["Upbeat", "Energetic", "Workout", "Party", "Hype"],
    bpm: 162,
    energy: 0.89,
    valence: 0.54,
    danceability: 0.82,
    acousticness: 0.06,
    popularity: 0.96,
  },
  "MY EYES": {
    album: "UTOPIA",
    year: 2023,
    genre: "Hip-Hop",
    subgenres: ["Psychedelic Trap", "Alternative Rap", "Experimental Hip-Hop"],
    language: "English",
    moods: ["Late Night", "Chill", "Energetic", "Deep Cuts", "Focus"],
    bpm: 119,
    energy: 0.71,
    valence: 0.39,
    danceability: 0.64,
    acousticness: 0.28,
    popularity: 0.93,
  },
  "Matargashti": {
    extraArtists: ["A.R. Rahman"],
    album: "Tamasha",
    year: 2015,
    genre: "Bollywood Pop",
    subgenres: ["Bollywood", "World Fusion", "Upbeat Filmi", "Indie Pop"],
    language: "Hindi",
    moods: ["Upbeat", "Feel Good", "Energetic", "Party", "Happy"],
    bpm: 115,
    energy: 0.81,
    valence: 0.91,
    danceability: 0.79,
    acousticness: 0.38,
    popularity: 0.89,
  },
  "Not Like Us": {
    album: "Not Like Us (Single)",
    year: 2024,
    genre: "Hip-Hop",
    subgenres: ["West Coast Hip-Hop", "Hyphy", "Rap", "Club Rap"],
    language: "English",
    moods: ["Upbeat", "Energetic", "Workout", "Party", "Hype"],
    bpm: 101,
    energy: 0.88,
    valence: 0.77,
    danceability: 0.91,
    acousticness: 0.05,
    popularity: 0.99,
  },
  "Softly": {
    album: "Making Memories",
    year: 2023,
    genre: "Punjabi Pop",
    subgenres: ["Punjabi", "Desi Hip-Hop", "R&B Fusion", "Pop"],
    language: "Punjabi",
    moods: ["Upbeat", "Chill", "Feel Good", "Party", "Late Night"],
    bpm: 96,
    energy: 0.68,
    valence: 0.82,
    danceability: 0.84,
    acousticness: 0.24,
    popularity: 0.91,
  },
  "Tum Ho": {
    album: "Rockstar",
    year: 2011,
    genre: "Bollywood Soul",
    subgenres: ["Bollywood", "Alternative Ballad", "Romantic", "Soft Rock"],
    language: "Hindi",
    moods: ["Chill", "Romantic", "Soulful", "Late Night", "Melancholic", "Deep Cuts"],
    bpm: 84,
    energy: 0.42,
    valence: 0.35,
    danceability: 0.41,
    acousticness: 0.74,
    popularity: 0.90,
  },
  "Tum Prem Ho": {
    album: "RadhaKrishn",
    year: 2022,
    genre: "Devotional / Spiritual",
    subgenres: ["Indian Classical Fusion", "Devotional", "Acoustic Melody", "Spiritual"],
    language: "Hindi",
    moods: ["Chill", "Soulful", "Focus", "Romantic", "Peaceful", "Deep Cuts"],
    bpm: 78,
    energy: 0.38,
    valence: 0.81,
    danceability: 0.43,
    acousticness: 0.82,
    popularity: 0.79,
  },
  "Ve Kamleya": {
    album: "Rocky Aur Rani Kii Prem Kahaani",
    year: 2023,
    genre: "Bollywood Romance",
    subgenres: ["Bollywood", "Sufi Romance", "Filmi Ballad", "Melody"],
    language: "Hindi",
    moods: ["Romantic", "Soulful", "Chill", "Feel Good", "Melancholic"],
    bpm: 90,
    energy: 0.56,
    valence: 0.64,
    danceability: 0.53,
    acousticness: 0.58,
    popularity: 0.94,
  },
};

/**
 * Formats seconds into M:SS (e.g. 175.46 -> "2:55")
 */
function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return "0:00";
  const totalSeconds = Math.round(seconds);
  const mins = Math.floor(totalSeconds / 60);
  const secs = totalSeconds % 60;
  return `${mins}:${String(secs).padStart(2, "0")}`;
}

/**
 * Converts a string into a deterministic URL-safe slug ID.
 */
function slugify(input) {
  return String(input)
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Encodes a relative file path (e.g. "songs/Ajab Si-KK.mp3") for browser fetch/src usage
 * without adding a leading slash or hardcoded host.
 */
function encodeRelativePath(relPath) {
  return relPath
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

/**
 * Cleans watermark/promo strings and leading BOM characters from ID3 tag strings.
 */
function cleanId3Text(raw) {
  if (!raw) return "";
  let cleaned = String(raw)
    .replace(/^\uFEFF/, "")
    .replace(/\0/g, "")
    .trim();

  // Strip common download watermark suffixes
  cleaned = cleaned
    .replace(/\s*-\s*\(DJMaza\)/gi, "")
    .replace(/\s*-\s*www\.DJMaza\.[a-z]+/gi, "")
    .replace(/\s*\|\|\s*Naijaflavour\.com/gi, "")
    .replace(/\s*\|\s*JustNaija\.com/gi, "")
    .trim();

  if (/^(www\.)?(djmaza|naijaflavour|justnaija)\./i.test(cleaned)) {
    return "";
  }
  return cleaned;
}

/**
 * Splits a raw artist string (e.g. "Future and Metro Boomin", "Pritam, Arijit Singh, Shreya Ghoshal")
 * into normalized unique artist names.
 */
function parseArtistList(rawArtistStr, extraArtists = []) {
  if (!rawArtistStr && (!extraArtists || extraArtists.length === 0)) {
    return ["Unknown Artist"];
  }

  const tokens = String(rawArtistStr || "")
    .split(/\s*(?:,|\band\b|&|\bfeat\.?|\bft\.?)\s*/i)
    .map((name) => name.trim())
    .filter(Boolean);

  const seen = new Set();
  const artists = [];

  for (const candidate of [...tokens, ...extraArtists]) {
    const normalized = candidate.replace(/\s+/g, " ").trim();
    if (!normalized) continue;
    const key = normalized.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (!seen.has(key)) {
      seen.add(key);
      artists.push(normalized);
    }
  }

  return artists.length > 0 ? artists : ["Unknown Artist"];
}

/**
 * Parses `<Title>-<Artists>.<ext>` filename into structured title and artist list.
 */
function parseTrackFilename(filename) {
  const ext = path.extname(filename);
  const base = path.basename(filename, ext);
  const dashIndex = base.indexOf("-");

  let title = base.trim();
  let rawArtists = "Unknown Artist";

  if (dashIndex !== -1) {
    title = base.slice(0, dashIndex).trim();
    rawArtists = base.slice(dashIndex + 1).trim();
  }

  const enrichment = TRACK_ENRICHMENTS[title] || {};
  const artists = parseArtistList(rawArtists, enrichment.extraArtists || []);
  const primaryArtist = artists[0];
  const featuredArtists = artists.slice(1);

  return {
    title,
    rawArtists,
    primaryArtist,
    featuredArtists,
    artists,
    artistDisplay: artists.join(", "),
  };
}

/**
 * Parses ID3v2 tags and MPEG Layer III audio duration/bitrate/sampleRate from a Buffer.
 */
function parseMp3Metadata(buf) {
  let offset = 0;
  const id3Tags = {};

  if (buf.length >= 10 && buf.toString("ascii", 0, 3) === "ID3") {
    const ver = buf[3];
    const tagSize =
      ((buf[6] & 0x7f) << 21) |
      ((buf[7] & 0x7f) << 14) |
      ((buf[8] & 0x7f) << 7) |
      (buf[9] & 0x7f);
    offset = 10 + tagSize;

    let pos = 10;
    const limit = Math.min(buf.length, offset - 10);
    while (pos < limit) {
      const frameId = buf.toString("ascii", pos, pos + 4);
      if (!/^[A-Z0-9]{4}$/.test(frameId)) break;

      const frameSize =
        ver === 4
          ? ((buf[pos + 4] & 0x7f) << 21) |
            ((buf[pos + 5] & 0x7f) << 14) |
            ((buf[pos + 6] & 0x7f) << 7) |
            (buf[pos + 7] & 0x7f)
          : buf.readUInt32BE(pos + 4);

      if (frameSize <= 0 || pos + 10 + frameSize > buf.length) break;

      if (frameId.startsWith("T")) {
        const encoding = buf[pos + 10];
        const payload = buf.subarray(pos + 11, pos + 10 + frameSize);
        const text =
          encoding === 1 || encoding === 2
            ? payload.toString("utf16le")
            : payload.toString("utf8");
        const cleaned = cleanId3Text(text);
        if (cleaned) {
          id3Tags[frameId] = cleaned;
        }
      }
      pos += 10 + frameSize;
    }
  }

  // Locate first valid MPEG Layer III frame header
  let bitrateKbps = 320;
  let sampleRate = 44100;
  const scanLimit = Math.min(buf.length - 4, offset + 65536);

  for (let i = offset; i < scanLimit; i++) {
    if (buf[i] === 0xff && (buf[i + 1] & 0xe0) === 0xe0) {
      const b1 = buf[i + 1];
      const b2 = buf[i + 2];
      const versionBits = (b1 >> 3) & 0x03; // 3 = MPEG1, 2 = MPEG2, 0 = MPEG2.5
      const layerBits = (b1 >> 1) & 0x03; // 1 = Layer III
      const bitrateIdx = (b2 >> 4) & 0x0f;
      const srIdx = (b2 >> 2) & 0x03;

      if (
        versionBits === 1 ||
        layerBits !== 1 ||
        bitrateIdx === 0 ||
        bitrateIdx === 15 ||
        srIdx === 3
      ) {
        continue;
      }

      const br =
        versionBits === 3 ? BITRATES_V1_L3[bitrateIdx] : BITRATES_V2_L3[bitrateIdx];
      const sr =
        versionBits === 3
          ? SAMPLERATES_V1[srIdx]
          : versionBits === 2
            ? SAMPLERATES_V2[srIdx]
            : SAMPLERATES_V25[srIdx];

      if (br > 0 && sr > 0) {
        bitrateKbps = br;
        sampleRate = sr;
        offset = i;
        break;
      }
    }
  }

  // Check for trailing 128-byte ID3v1 tag ("TAG")
  let endOffset = buf.length;
  if (
    buf.length >= 128 &&
    buf.toString("ascii", buf.length - 128, buf.length - 125) === "TAG"
  ) {
    endOffset -= 128;
  }

  const audioBytes = Math.max(0, endOffset - offset);
  const duration = Number(((audioBytes * 8) / (bitrateKbps * 1000)).toFixed(2));

  return {
    duration,
    bitrateKbps,
    sampleRate,
    audioBytes,
    id3Tags,
  };
}

/**
 * Generates deterministic fallback audio features for any newly added local audio file
 * not in TRACK_ENRICHMENTS, based on a hash of its title + artist.
 */
function deriveFallbackAttributes(title, primaryArtist, id3Tags = {}) {
  const seedStr = `${title}:${primaryArtist}`;
  let hash = 2166136261;
  for (let i = 0; i < seedStr.length; i++) {
    hash ^= seedStr.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  const u = (shift) => ((hash >>> shift) & 0xff) / 255;

  let album = `${title} (Single)`;
  let year = 2024;

  if (id3Tags.TALB) {
    const yearMatch = id3Tags.TALB.match(/\((\d{4})\)/);
    if (yearMatch) {
      year = Number(yearMatch[1]);
    }
    album = id3Tags.TALB.replace(/\s*\(\d{4}\)\s*/, "").trim() || album;
  } else if (id3Tags.TYER && /^\d{4}$/.test(id3Tags.TYER)) {
    year = Number(id3Tags.TYER);
  }

  const genre = id3Tags.TCON || "Pop";
  const bpm = Math.round(85 + u(0) * 65);
  const energy = Number((0.4 + u(8) * 0.5).toFixed(2));
  const valence = Number((0.35 + u(16) * 0.55).toFixed(2));
  const danceability = Number((0.45 + u(24) * 0.45).toFixed(2));
  const acousticness = Number((1 - energy * 0.7).toFixed(2));
  const popularity = Number((0.65 + u(4) * 0.3).toFixed(2));

  const moods = [];
  if (energy >= 0.7) moods.push("Upbeat", "Energetic");
  else moods.push("Chill", "Soulful");
  if (valence >= 0.65) moods.push("Feel Good");
  else moods.push("Late Night");

  return {
    album,
    year,
    genre,
    subgenres: [genre],
    language: "English",
    moods,
    bpm,
    energy,
    valence,
    danceability,
    acousticness,
    popularity,
  };
}

/**
 * Resolves the best matching cover image in `/Images` for a given song title.
 */
function resolveCoverImage(title, imageFiles) {
  const normalizedTitle = title.toLowerCase().trim();

  for (const ext of IMAGE_EXTENSIONS) {
    const candidateName = `${normalizedTitle}${ext}`;
    const match = imageFiles.find((img) => img.toLowerCase() === candidateName);
    if (match) {
      return encodeRelativePath(`Images/${match}`);
    }
  }

  // Partial prefix match fallback
  const prefixMatch = imageFiles.find((img) =>
    img.toLowerCase().startsWith(normalizedTitle)
  );
  if (prefixMatch) {
    return encodeRelativePath(`Images/${prefixMatch}`);
  }

  return encodeRelativePath(DEFAULT_COVER);
}

/**
 * Scans `/songs` and `/Images` inside `rootDir` and builds the catalog manifest.
 */
function buildCatalog({
  rootDir = path.resolve(__dirname, ".."),
  writeToFile = true,
  outputPath = path.join(rootDir, "tracks.json"),
} = {}) {
  const songsDir = path.join(rootDir, "songs");
  const imagesDir = path.join(rootDir, "Images");

  const songFiles = fs.existsSync(songsDir)
    ? fs
        .readdirSync(songsDir)
        .filter((f) => AUDIO_EXTENSIONS.has(path.extname(f).toLowerCase()))
        .sort((a, b) => a.localeCompare(b, "en", { sensitivity: "base" }))
    : [];

  const imageFiles = fs.existsSync(imagesDir) ? fs.readdirSync(imagesDir) : [];

  const tracks = songFiles.map((filename, index) => {
    const filePath = path.join(songsDir, filename);
    const buffer = fs.readFileSync(filePath);
    const parsedName = parseTrackFilename(filename);
    const mp3Info = parseMp3Metadata(buffer);

    const enrichment =
      TRACK_ENRICHMENTS[parsedName.title] ||
      deriveFallbackAttributes(
        parsedName.title,
        parsedName.primaryArtist,
        mp3Info.id3Tags
      );

    const coverUrl = resolveCoverImage(parsedName.title, imageFiles);
    const audioUrl = encodeRelativePath(`songs/${filename}`);

    const audioFeatures = {
      bpm: enrichment.bpm,
      energy: enrichment.energy,
      valence: enrichment.valence,
      danceability: enrichment.danceability,
      acousticness: enrichment.acousticness,
      popularity: enrichment.popularity,
    };

    return {
      id: slugify(`${parsedName.title}-${parsedName.primaryArtist}`),
      trackNumber: index + 1,
      filename,
      title: parsedName.title,
      primaryArtist: parsedName.primaryArtist,
      featuredArtists: parsedName.featuredArtists,
      artists: parsedName.artists,
      artistDisplay: parsedName.artistDisplay,
      album: enrichment.album,
      year: enrichment.year,
      duration: mp3Info.duration,
      durationFormatted: formatDuration(mp3Info.duration),
      bitrateKbps: mp3Info.bitrateKbps,
      sampleRate: mp3Info.sampleRate,
      audioUrl,
      coverUrl,
      genre: enrichment.genre,
      subgenres: enrichment.subgenres,
      language: enrichment.language,
      moods: enrichment.moods,
      bpm: enrichment.bpm,
      energy: enrichment.energy,
      valence: enrichment.valence,
      danceability: enrichment.danceability,
      acousticness: enrichment.acousticness,
      popularity: enrichment.popularity,
      audioFeatures,
    };
  });

  const allArtists = Array.from(
    new Set(tracks.flatMap((t) => t.artists))
  ).sort((a, b) => a.localeCompare(b));
  const allAlbums = Array.from(new Set(tracks.map((t) => t.album))).sort((a, b) =>
    a.localeCompare(b)
  );
  const allGenres = Array.from(new Set(tracks.map((t) => t.genre))).sort((a, b) =>
    a.localeCompare(b)
  );
  const allMoods = Array.from(
    new Set(tracks.flatMap((t) => t.moods))
  ).sort((a, b) => a.localeCompare(b));

  const manifest = {
    version: "1.0.0",
    generatedBy: "scripts/build-catalog.js",
    totalTracks: tracks.length,
    genres: allGenres,
    moods: allMoods,
    artists: allArtists,
    albums: allAlbums,
    tracks,
  };

  if (writeToFile) {
    fs.writeFileSync(outputPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");
  }

  return manifest;
}

if (require.main === module) {
  const manifest = buildCatalog();
  console.log(
    `[build-catalog] Generated tracks.json with ${manifest.totalTracks} tracks (${manifest.artists.length} artists, ${manifest.genres.length} genres, ${manifest.moods.length} moods).`
  );
}

module.exports = {
  buildCatalog,
  parseTrackFilename,
  parseArtistList,
  parseMp3Metadata,
  encodeRelativePath,
  formatDuration,
  slugify,
};
