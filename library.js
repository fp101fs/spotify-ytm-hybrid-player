/**
 * SpotTube Local Library (Item 11)
 *
 * Browser-side local audio import + playlist helpers:
 *  - Supported file detection (.mp3 / .flac / .wav / .m4a / .ogg / .opus / .aac)
 *  - Filename + folder metadata parsing ("Artist - Title", catalog "Title-Artist", "01. Title", feat. credits)
 *  - Client-side tag parsing: ID3v2.2/2.3/2.4 (+ embedded APIC/PIC cover), ID3v1, FLAC Vorbis comments
 *    (+ PICTURE block + STREAMINFO duration), WAV RIFF LIST/INFO (+ fmt/data duration), MP3 frame/Xing duration
 *  - Deterministic generated SVG cover art when a file has no embedded artwork
 *  - Deterministic audio-feature / mood inference from genre keywords so the recommender can rank imports
 *  - Drag-and-drop (DataTransfer entries, recursive folders) and directory-handle file collection
 *  - importAudioFiles(): parse + persist every file into SpotTubeStorage (IndexedDB) with de-duplication
 *  - Playlist helpers: resolvePlaylistTracks, nextDefaultPlaylistName, buildCollectionCovers
 *
 * Universal module: window.SpotTubeLibrary in the browser, module.exports in Node (tests).
 */
(function (root, factory) {
    if (typeof module === "object" && module.exports) {
        module.exports = factory(root);
    } else {
        root.SpotTubeLibrary = factory(root);
    }
})(typeof globalThis !== "undefined" ? globalThis : typeof window !== "undefined" ? window : this, function (globalScope) {
    const SUPPORTED_AUDIO_EXTENSIONS = ["mp3", "flac", "wav", "m4a", "ogg", "oga", "opus", "aac"];
    const MIME_BY_EXTENSION = {
        mp3: "audio/mpeg",
        flac: "audio/flac",
        wav: "audio/wav",
        m4a: "audio/mp4",
        ogg: "audio/ogg",
        oga: "audio/ogg",
        opus: "audio/ogg",
        aac: "audio/aac",
    };
    const MAX_EMBEDDED_COVER_BYTES = 1.5 * 1024 * 1024;
    const MAX_FILE_BYTES = 400 * 1024 * 1024;

    // Small subset of the ID3v1 genre table (index -> name) for "(17)" / "17" style genre frames.
    const ID3_GENRES = [
        "Blues", "Classic Rock", "Country", "Dance", "Disco", "Funk", "Grunge", "Hip-Hop", "Jazz", "Metal",
        "New Age", "Oldies", "Other", "Pop", "R&B", "Rap", "Reggae", "Rock", "Techno", "Industrial",
        "Alternative", "Ska", "Death Metal", "Pranks", "Soundtrack", "Euro-Techno", "Ambient", "Trip-Hop",
        "Vocal", "Jazz+Funk", "Fusion", "Trance", "Classical", "Instrumental", "Acid", "House", "Game",
        "Sound Clip", "Gospel", "Noise", "Alternative Rock", "Bass", "Soul", "Punk", "Space", "Meditative",
        "Instrumental Pop", "Instrumental Rock", "Ethnic", "Gothic", "Darkwave", "Techno-Industrial",
        "Electronic", "Pop-Folk", "Eurodance", "Dream", "Southern Rock", "Comedy", "Cult", "Gangsta",
        "Top 40", "Christian Rap", "Pop/Funk", "Jungle", "Native American", "Cabaret", "New Wave",
        "Psychedelic", "Rave", "Showtunes", "Trailer", "Lo-Fi", "Tribal", "Acid Punk", "Acid Jazz", "Polka",
        "Retro", "Musical", "Rock & Roll", "Hard Rock",
    ];

    // Genre keyword -> audio feature profile used to give imports a sensible starting vector.
    const GENRE_PROFILES = [
        { match: /hip.?hop|rap|trap|drill|gangsta/, genre: "Hip-Hop", bpm: 140, energy: 0.78, valence: 0.52, danceability: 0.8, acousticness: 0.1, moods: ["Energetic", "Workout", "Party"] },
        { match: /metal|punk|hard rock|grunge/, genre: "Rock", bpm: 150, energy: 0.9, valence: 0.42, danceability: 0.45, acousticness: 0.05, moods: ["Energetic", "Workout"] },
        { match: /rock|alternative|indie/, genre: "Rock", bpm: 125, energy: 0.74, valence: 0.5, danceability: 0.52, acousticness: 0.18, moods: ["Energetic", "Feel Good"] },
        { match: /house|techno|trance|edm|electro|dance|rave|dubstep|drum/, genre: "Electronic", bpm: 126, energy: 0.84, valence: 0.6, danceability: 0.85, acousticness: 0.04, moods: ["Upbeat", "Party", "Workout"] },
        { match: /lo.?fi|ambient|chill|downtempo|new age|meditat|sleep/, genre: "Chill", bpm: 82, energy: 0.32, valence: 0.48, danceability: 0.5, acousticness: 0.62, moods: ["Chill", "Focus", "Late Night"] },
        { match: /classical|orchestra|piano|instrumental|soundtrack|score/, genre: "Classical", bpm: 90, energy: 0.28, valence: 0.4, danceability: 0.25, acousticness: 0.9, moods: ["Focus", "Chill"] },
        { match: /jazz|blues|soul|r&b|rnb|funk|gospel/, genre: "R&B", bpm: 96, energy: 0.52, valence: 0.6, danceability: 0.64, acousticness: 0.4, moods: ["Soulful", "Late Night", "Chill"] },
        { match: /folk|acoustic|country|singer/, genre: "Folk", bpm: 100, energy: 0.42, valence: 0.58, danceability: 0.5, acousticness: 0.78, moods: ["Chill", "Feel Good"] },
        { match: /bollywood|filmi|hindi|punjabi|bhangra|desi/, genre: "Bollywood", bpm: 105, energy: 0.6, valence: 0.62, danceability: 0.68, acousticness: 0.35, moods: ["Romantic", "Feel Good"] },
        { match: /reggae|latin|reggaeton|afro|dancehall/, genre: "Latin", bpm: 98, energy: 0.72, valence: 0.78, danceability: 0.84, acousticness: 0.2, moods: ["Upbeat", "Party", "Feel Good"] },
        { match: /pop|top 40|k-pop|kpop/, genre: "Pop", bpm: 118, energy: 0.7, valence: 0.68, danceability: 0.72, acousticness: 0.18, moods: ["Upbeat", "Feel Good"] },
    ];
    const DEFAULT_PROFILE = { genre: "Local", bpm: 112, energy: 0.6, valence: 0.6, danceability: 0.62, acousticness: 0.3, moods: ["Chill", "Feel Good"] };

    // ==================== GENERIC HELPERS ====================

    function clamp(value, min, max) {
        return Math.min(max, Math.max(min, value));
    }

    function hashString(input) {
        // FNV-1a 32-bit
        let hash = 0x811c9dc5;
        const str = String(input || "");
        for (let i = 0; i < str.length; i++) {
            hash ^= str.charCodeAt(i);
            hash = Math.imul(hash, 0x01000193) >>> 0;
        }
        return hash >>> 0;
    }

    function slugify(value) {
        return String(value || "")
            .normalize("NFKD")
            .replace(/[̀-ͯ]/g, "")
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-+|-+$/g, "");
    }

    /**
     * Tag text comes from arbitrary files and is later rendered through template strings in the shell,
     * so strip markup characters and control codes, normalise whitespace and cap the length.
     */
    function sanitizeTagText(value, maxLength = 160) {
        if (value === null || value === undefined) return "";
        return String(value)
            .replace(/[\u0000-\u001f\u007f﻿]/g, " ")
            .replace(/[<>]/g, "")
            .replace(/"/g, "”")
            .replace(/`/g, "'")
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, maxLength)
            .trim();
    }

    function formatDuration(seconds) {
        if (!Number.isFinite(seconds) || seconds <= 0) return "0:00";
        const mins = Math.floor(seconds / 60);
        const secs = Math.floor(seconds % 60);
        return `${mins}:${String(secs).padStart(2, "0")}`;
    }

    function getFileExtension(name) {
        const match = /\.([a-z0-9]+)$/i.exec(String(name || ""));
        return match ? match[1].toLowerCase() : "";
    }

    function isSupportedAudioFile(file) {
        if (!file) return false;
        const ext = getFileExtension(file.name);
        if (SUPPORTED_AUDIO_EXTENSIONS.includes(ext)) return true;
        const type = String(file.type || "").toLowerCase();
        return type.startsWith("audio/") && !type.includes("mpegurl") && !type.includes("x-scpls");
    }

    function isArrayBufferLike(value) {
        const tag = Object.prototype.toString.call(value);
        return tag === "[object ArrayBuffer]" || tag === "[object SharedArrayBuffer]";
    }

    function toUint8Array(input) {
        if (!input) return new Uint8Array(0);
        if (input instanceof Uint8Array) return input;
        // Tag checks instead of instanceof so buffers from other realms (iframes, workers, vm) still work
        if (isArrayBufferLike(input)) return new Uint8Array(input);
        if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
        return new Uint8Array(0);
    }

    function readAscii(bytes, offset, length) {
        let out = "";
        for (let i = 0; i < length && offset + i < bytes.length; i++) {
            out += String.fromCharCode(bytes[offset + i]);
        }
        return out;
    }

    function readUint32BE(bytes, offset) {
        return ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0;
    }

    function readUint32LE(bytes, offset) {
        return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0;
    }

    function readUint16LE(bytes, offset) {
        return bytes[offset] | (bytes[offset + 1] << 8);
    }

    function readSyncSafe(bytes, offset) {
        return ((bytes[offset] & 0x7f) << 21) | ((bytes[offset + 1] & 0x7f) << 14) | ((bytes[offset + 2] & 0x7f) << 7) | (bytes[offset + 3] & 0x7f);
    }

    function decodeLatin1(bytes) {
        let out = "";
        for (let i = 0; i < bytes.length; i++) out += String.fromCharCode(bytes[i]);
        return out;
    }

    function decodeUtf8(bytes) {
        if (typeof TextDecoder !== "undefined") {
            try {
                return new TextDecoder("utf-8").decode(bytes);
            } catch (_) {}
        }
        try {
            return decodeURIComponent(escape(decodeLatin1(bytes)));
        } catch (_) {
            return decodeLatin1(bytes);
        }
    }

    function decodeUtf16(bytes, bigEndianDefault) {
        let bigEndian = bigEndianDefault;
        let start = 0;
        if (bytes.length >= 2) {
            if (bytes[0] === 0xff && bytes[1] === 0xfe) {
                bigEndian = false;
                start = 2;
            } else if (bytes[0] === 0xfe && bytes[1] === 0xff) {
                bigEndian = true;
                start = 2;
            }
        }
        let out = "";
        for (let i = start; i + 1 < bytes.length; i += 2) {
            const code = bigEndian ? (bytes[i] << 8) | bytes[i + 1] : bytes[i] | (bytes[i + 1] << 8);
            out += String.fromCharCode(code);
        }
        return out;
    }

    function decodeId3Text(encoding, bytes) {
        let text;
        if (encoding === 1) text = decodeUtf16(bytes, false);
        else if (encoding === 2) text = decodeUtf16(bytes, true);
        else if (encoding === 3) text = decodeUtf8(bytes);
        else text = decodeLatin1(bytes);
        // ID3v2.4 allows NUL-separated multi-values; join them with ", "
        return text
            .split("\u0000")
            .map((s) => s.trim())
            .filter(Boolean)
            .join(", ");
    }

    /** Finds the end of a NUL-terminated string for the given ID3 text encoding. */
    function findTextTerminator(bytes, start, encoding) {
        const wide = encoding === 1 || encoding === 2;
        if (wide) {
            for (let i = start; i + 1 < bytes.length; i += 2) {
                if (bytes[i] === 0 && bytes[i + 1] === 0) return { end: i, next: i + 2 };
            }
        } else {
            for (let i = start; i < bytes.length; i++) {
                if (bytes[i] === 0) return { end: i, next: i + 1 };
            }
        }
        return { end: bytes.length, next: bytes.length };
    }

    function normalizeGenre(raw) {
        let value = String(raw || "").trim();
        if (!value) return "";
        // "(17)Rock", "(17)", "17"
        const paren = /^\((\d+)\)\s*(.*)$/.exec(value);
        if (paren) {
            value = paren[2] || ID3_GENRES[Number(paren[1])] || "";
        } else if (/^\d+$/.test(value)) {
            value = ID3_GENRES[Number(value)] || "";
        }
        return sanitizeTagText(value, 60);
    }

    function parseYear(raw) {
        const match = /(\d{4})/.exec(String(raw || ""));
        if (!match) return null;
        const year = Number(match[1]);
        return year >= 1900 && year <= 2100 ? year : null;
    }

    function parseTrackNumber(raw) {
        const match = /^\s*(\d{1,3})/.exec(String(raw || ""));
        return match ? Number(match[1]) : null;
    }

    // ==================== FILENAME / FOLDER METADATA ====================

    function splitArtistList(value) {
        return String(value || "")
            .split(/\s*(?:,|;|\s&\s|\sand\s|\sx\s|\s\/\s|\svs\.?\s)\s*/i)
            .map((s) => sanitizeTagText(s, 80))
            .filter(Boolean);
    }

    /** Pulls "(feat. X)" / "ft. X" credits out of a title string. */
    function extractFeaturedFromTitle(title) {
        const featRegex = /\s*[\(\[]?\s*(?:feat\.?|ft\.?|featuring)\s+([^\)\]]+)[\)\]]?\s*$/i;
        const match = featRegex.exec(String(title || ""));
        if (!match) return { title: String(title || "").trim(), featured: [] };
        return {
            title: String(title).slice(0, match.index).trim(),
            featured: splitArtistList(match[1]),
        };
    }

    /**
     * Parses metadata from a file name (and optional relative folder path).
     * Supports:
     *  - "Artist - Title.mp3" (spaced dash: the common download convention)
     *  - "Title-Artist.mp3" (this repo's /songs convention, unspaced dash)
     *  - "01 - Title.flac", "01. Title.wav", "01 Title.mp3" (leading track numbers)
     *  - "Artist/Album/03 Title.mp3" folder layouts (album + artist from parent folders)
     */
    function parseFilenameMetadata(filename, relativePath = "") {
        const base = String(filename || "").split(/[\\/]/).pop() || "";
        let stem = base.replace(/\.[a-z0-9]+$/i, "").replace(/_/g, " ").replace(/\s+/g, " ").trim();

        let trackNumber = null;
        const numMatch = /^(\d{1,3})(?:\s*[-.)]\s*|\s+)(.+)$/.exec(stem);
        if (numMatch && numMatch[2].trim()) {
            trackNumber = Number(numMatch[1]);
            stem = numMatch[2].trim();
        }

        let title = stem;
        let artistPart = "";
        if (/\s[-–—]\s/.test(stem)) {
            const parts = stem.split(/\s[-–—]\s/);
            artistPart = parts.shift();
            title = parts.join(" - ");
        } else if (/^[^-]+-[^-]+$/.test(stem)) {
            const [t, a] = stem.split("-");
            title = t;
            artistPart = a;
        }

        const pathParts = String(relativePath || "")
            .split(/[\\/]/)
            .map((p) => p.trim())
            .filter(Boolean);
        pathParts.pop(); // drop the file name itself
        const albumFolder = pathParts.length >= 1 ? pathParts[pathParts.length - 1] : "";
        const artistFolder = pathParts.length >= 2 ? pathParts[pathParts.length - 2] : "";

        const featuredFromTitle = extractFeaturedFromTitle(title);
        title = featuredFromTitle.title;
        const artistList = splitArtistList(artistPart || artistFolder);

        return {
            title: sanitizeTagText(title) || sanitizeTagText(stem) || "Untitled Track",
            artists: artistList,
            featuredFromTitle: featuredFromTitle.featured,
            album: sanitizeTagText(albumFolder),
            trackNumber,
        };
    }

    // ==================== ID3v2 / ID3v1 ====================

    function removeUnsynchronisation(bytes) {
        const out = [];
        for (let i = 0; i < bytes.length; i++) {
            out.push(bytes[i]);
            if (bytes[i] === 0xff && bytes[i + 1] === 0x00) i++;
        }
        return Uint8Array.from(out);
    }

    /** Returns { tags, tagSize } where tagSize is the total header + body length (0 when absent). */
    function parseId3v2(input) {
        const bytes = toUint8Array(input);
        if (bytes.length < 10 || readAscii(bytes, 0, 3) !== "ID3") {
            return { tags: null, tagSize: 0 };
        }
        const major = bytes[3];
        const flags = bytes[5];
        const bodySize = readSyncSafe(bytes, 6);
        const hasFooter = major === 4 && (flags & 0x10) !== 0;
        const tagSize = 10 + bodySize + (hasFooter ? 10 : 0);
        if (major < 2 || major > 4) return { tags: null, tagSize };

        let body = bytes.subarray(10, Math.min(bytes.length, 10 + bodySize));
        if ((flags & 0x80) !== 0 && major < 4) {
            body = removeUnsynchronisation(body);
        }
        let offset = 0;
        if ((flags & 0x40) !== 0 && major >= 3) {
            // Extended header
            const extSize = major === 4 ? readSyncSafe(body, 0) : readUint32BE(body, 0) + 4;
            offset += extSize;
        }

        const idLength = major === 2 ? 3 : 4;
        const headerLength = major === 2 ? 6 : 10;
        const tags = {};

        while (offset + headerLength <= body.length) {
            const frameId = readAscii(body, offset, idLength);
            if (!/^[A-Z0-9]+$/.test(frameId)) break;
            let frameSize;
            if (major === 2) {
                frameSize = (body[offset + 3] << 16) | (body[offset + 4] << 8) | body[offset + 5];
            } else if (major === 4) {
                frameSize = readSyncSafe(body, offset + 4);
            } else {
                frameSize = readUint32BE(body, offset + 4);
            }
            const frameStart = offset + headerLength;
            const frameEnd = frameStart + frameSize;
            if (frameSize <= 0 || frameEnd > body.length) break;
            let frame = body.subarray(frameStart, frameEnd);
            if (major === 4 && (body[offset + 9] & 0x02) !== 0) {
                frame = removeUnsynchronisation(frame);
            }

            const textField = {
                TIT2: "title", TT2: "title",
                TPE1: "artist", TP1: "artist",
                TPE2: "albumArtist", TP2: "albumArtist",
                TALB: "album", TAL: "album",
                TYER: "year", TYE: "year", TDRC: "year", TDOR: "year",
                TCON: "genre", TCO: "genre",
                TRCK: "track", TRK: "track",
                TBPM: "bpm", TBP: "bpm",
                TLEN: "lengthMs", TLE: "lengthMs",
            }[frameId];

            if (textField && frame.length > 1) {
                const value = decodeId3Text(frame[0], frame.subarray(1));
                if (value && !tags[textField]) tags[textField] = value;
            } else if ((frameId === "APIC" || frameId === "PIC") && !tags.picture && frame.length > 4) {
                const encoding = frame[0];
                let cursor = 1;
                let mime;
                if (frameId === "PIC") {
                    const fmt = readAscii(frame, 1, 3).toLowerCase();
                    mime = fmt === "png" ? "image/png" : "image/jpeg";
                    cursor = 4;
                } else {
                    const mimeEnd = findTextTerminator(frame, 1, 0);
                    mime = readAscii(frame, 1, mimeEnd.end - 1).toLowerCase() || "image/jpeg";
                    cursor = mimeEnd.next;
                }
                const pictureType = frame[cursor];
                cursor += 1;
                const descEnd = findTextTerminator(frame, cursor, encoding);
                cursor = descEnd.next;
                const data = frame.subarray(cursor);
                if (data.length > 0) {
                    if (!mime.includes("/")) mime = `image/${mime === "jpg" ? "jpeg" : mime}`;
                    tags.picture = { mime, pictureType, data };
                }
            }
            offset = frameEnd;
        }

        return { tags, tagSize };
    }

    function parseId3v1(input) {
        const bytes = toUint8Array(input);
        if (bytes.length < 128) return null;
        const start = bytes.length - 128;
        if (readAscii(bytes, start, 3) !== "TAG") return null;
        const field = (offset, length) =>
            decodeLatin1(bytes.subarray(start + offset, start + offset + length))
                .replace(/\u0000.*$/, "")
                .trim();
        const genreIndex = bytes[start + 127];
        const hasTrack = bytes[start + 125] === 0 && bytes[start + 126] !== 0;
        return {
            title: field(3, 30),
            artist: field(33, 30),
            album: field(63, 30),
            year: field(93, 4),
            track: hasTrack ? String(bytes[start + 126]) : "",
            genre: ID3_GENRES[genreIndex] || "",
        };
    }

    // ==================== MP3 FRAME DURATION ====================

    const MPEG_BITRATES = {
        // [version][layer] -> kbps table (index 1..14)
        V1L3: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
        V2L3: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
    };
    const MPEG_SAMPLE_RATES = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };

    function parseMp3Stream(input, startOffset = 0, totalBytes = 0) {
        const bytes = toUint8Array(input);
        const scanLimit = Math.min(bytes.length - 4, startOffset + 64 * 1024);
        for (let i = startOffset; i < scanLimit; i++) {
            if (bytes[i] !== 0xff || (bytes[i + 1] & 0xe0) !== 0xe0) continue;
            const versionBits = (bytes[i + 1] >> 3) & 0x03;
            const layerBits = (bytes[i + 1] >> 1) & 0x03;
            const bitrateIndex = (bytes[i + 2] >> 4) & 0x0f;
            const sampleIndex = (bytes[i + 2] >> 2) & 0x03;
            const channelMode = (bytes[i + 3] >> 6) & 0x03;
            if (versionBits === 1 || layerBits !== 1 || bitrateIndex === 0 || bitrateIndex === 15 || sampleIndex === 3) {
                continue;
            }
            const isV1 = versionBits === 3;
            const bitrateKbps = (isV1 ? MPEG_BITRATES.V1L3 : MPEG_BITRATES.V2L3)[bitrateIndex];
            const sampleRate = MPEG_SAMPLE_RATES[versionBits][sampleIndex];
            const samplesPerFrame = isV1 ? 1152 : 576;

            // Xing / Info VBR header gives an exact frame count
            const sideInfo = isV1 ? (channelMode === 3 ? 17 : 32) : channelMode === 3 ? 9 : 17;
            const xingOffset = i + 4 + sideInfo;
            const xingId = readAscii(bytes, xingOffset, 4);
            let duration = 0;
            if ((xingId === "Xing" || xingId === "Info") && (bytes[xingOffset + 7] & 0x01) !== 0) {
                const frames = readUint32BE(bytes, xingOffset + 8);
                duration = (frames * samplesPerFrame) / sampleRate;
            } else {
                // totalBytes lets a partial read (file.slice) estimate CBR duration from the real file size
                const audioBytes = Math.max(bytes.length, Number(totalBytes) || 0) - i;
                duration = (audioBytes * 8) / (bitrateKbps * 1000);
            }
            return { bitrateKbps, sampleRate, duration };
        }
        return null;
    }

    // ==================== FLAC ====================

    function parseVorbisComments(bytes) {
        const tags = {};
        if (bytes.length < 8) return tags;
        let offset = 0;
        const vendorLength = readUint32LE(bytes, offset);
        offset += 4 + vendorLength;
        if (offset + 4 > bytes.length) return tags;
        const count = readUint32LE(bytes, offset);
        offset += 4;
        const map = {
            TITLE: "title",
            ARTIST: "artist",
            ALBUMARTIST: "albumArtist",
            "ALBUM ARTIST": "albumArtist",
            ALBUM: "album",
            DATE: "year",
            YEAR: "year",
            GENRE: "genre",
            TRACKNUMBER: "track",
            BPM: "bpm",
        };
        for (let n = 0; n < count && offset + 4 <= bytes.length; n++) {
            const length = readUint32LE(bytes, offset);
            offset += 4;
            const comment = decodeUtf8(bytes.subarray(offset, offset + length));
            offset += length;
            const eq = comment.indexOf("=");
            if (eq <= 0) continue;
            const key = map[comment.slice(0, eq).toUpperCase()];
            const value = comment.slice(eq + 1).trim();
            if (!key || !value) continue;
            tags[key] = tags[key] && key === "artist" ? `${tags[key]}, ${value}` : tags[key] || value;
        }
        return tags;
    }

    function parseFlacPictureBlock(bytes) {
        let offset = 0;
        const pictureType = readUint32BE(bytes, offset);
        offset += 4;
        const mimeLength = readUint32BE(bytes, offset);
        offset += 4;
        const mime = readAscii(bytes, offset, mimeLength).toLowerCase() || "image/jpeg";
        offset += mimeLength;
        const descLength = readUint32BE(bytes, offset);
        offset += 4 + descLength + 16; // skip description + width/height/depth/colors
        const dataLength = readUint32BE(bytes, offset);
        offset += 4;
        const data = bytes.subarray(offset, offset + dataLength);
        return data.length ? { mime, pictureType, data } : null;
    }

    function parseFlac(input, totalBytes = 0) {
        const bytes = toUint8Array(input);
        let offset = 0;
        if (readAscii(bytes, 0, 3) === "ID3") {
            offset = parseId3v2(bytes).tagSize;
        }
        if (readAscii(bytes, offset, 4) !== "fLaC") return null;
        offset += 4;
        const result = { tags: {}, sampleRate: 0, duration: 0, bitrateKbps: 0 };
        let isLast = false;
        while (!isLast && offset + 4 <= bytes.length) {
            const header = bytes[offset];
            isLast = (header & 0x80) !== 0;
            const blockType = header & 0x7f;
            const length = (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3];
            const block = bytes.subarray(offset + 4, offset + 4 + length);
            if (blockType === 0 && block.length >= 18) {
                const sampleRate = (block[10] << 12) | (block[11] << 4) | (block[12] >> 4);
                const totalSamples = (block[13] & 0x0f) * 2 ** 32 + readUint32BE(block, 14);
                result.sampleRate = sampleRate;
                if (sampleRate > 0 && totalSamples > 0) {
                    result.duration = totalSamples / sampleRate;
                    result.bitrateKbps = Math.round((Math.max(bytes.length, Number(totalBytes) || 0) * 8) / result.duration / 1000);
                }
            } else if (blockType === 4) {
                Object.assign(result.tags, parseVorbisComments(block));
            } else if (blockType === 6 && !result.tags.picture) {
                const picture = parseFlacPictureBlock(block);
                if (picture) result.tags.picture = picture;
            }
            offset += 4 + length;
        }
        return result;
    }

    // ==================== WAV (RIFF) ====================

    function parseWav(input) {
        const bytes = toUint8Array(input);
        if (readAscii(bytes, 0, 4) !== "RIFF" || readAscii(bytes, 8, 4) !== "WAVE") return null;
        const result = { tags: {}, sampleRate: 0, duration: 0, bitrateKbps: 0 };
        let byteRate = 0;
        let offset = 12;
        while (offset + 8 <= bytes.length) {
            const chunkId = readAscii(bytes, offset, 4);
            const chunkSize = readUint32LE(bytes, offset + 4);
            const dataStart = offset + 8;
            if (chunkId === "fmt ") {
                result.sampleRate = readUint32LE(bytes, dataStart + 4);
                byteRate = readUint32LE(bytes, dataStart + 8);
                result.bitrateKbps = Math.round((byteRate * 8) / 1000);
            } else if (chunkId === "data") {
                if (byteRate > 0) result.duration = chunkSize / byteRate;
            } else if (chunkId === "LIST" && readAscii(bytes, dataStart, 4) === "INFO") {
                let sub = dataStart + 4;
                const end = Math.min(bytes.length, dataStart + chunkSize);
                const map = { INAM: "title", IART: "artist", IPRD: "album", ICRD: "year", IGNR: "genre", ITRK: "track" };
                while (sub + 8 <= end) {
                    const subId = readAscii(bytes, sub, 4);
                    const subSize = readUint32LE(bytes, sub + 4);
                    const key = map[subId];
                    if (key) {
                        result.tags[key] = decodeUtf8(bytes.subarray(sub + 8, sub + 8 + subSize))
                            .replace(/\u0000+$/, "")
                            .trim();
                    }
                    sub += 8 + subSize + (subSize % 2);
                }
            }
            offset = dataStart + chunkSize + (chunkSize % 2);
        }
        return result;
    }

    // ==================== UNIFIED METADATA PARSER ====================

    /**
     * Parses tags + technical info from raw audio bytes.
     * Returns { format, tags: { title, artist, albumArtist, album, year, genre, track, bpm, picture }, duration, sampleRate, bitrateKbps }.
     */
    function parseAudioMetadata(input, filename = "", options = {}) {
        const fileSize = Number(options && options.fileSize) || 0;
        const bytes = toUint8Array(input);
        const ext = getFileExtension(filename);
        const empty = { format: ext || "unknown", tags: {}, duration: 0, sampleRate: 0, bitrateKbps: 0 };
        if (!bytes.length) return empty;

        try {
            if (readAscii(bytes, 0, 4) === "RIFF") {
                const wav = parseWav(bytes);
                if (wav) return { format: "wav", ...wav };
            }
            const flac = parseFlac(bytes, fileSize);
            if (flac) return { format: "flac", ...flac };

            const id3 = parseId3v2(bytes);
            const v1 = parseId3v1(bytes);
            const tags = { ...(v1 || {}), ...Object.fromEntries(Object.entries(id3.tags || {}).filter(([, v]) => v)) };
            const mp3 = parseMp3Stream(bytes, id3.tagSize, fileSize);
            let duration = mp3 ? mp3.duration : 0;
            if (tags.lengthMs && Number(tags.lengthMs) > 0) {
                duration = Number(tags.lengthMs) / 1000;
            }
            return {
                format: mp3 ? "mp3" : ext || "unknown",
                tags,
                duration,
                sampleRate: mp3 ? mp3.sampleRate : 0,
                bitrateKbps: mp3 ? mp3.bitrateKbps : 0,
            };
        } catch (err) {
            return { ...empty, error: String((err && err.message) || err) };
        }
    }

    // ==================== COVER ART ====================

    const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

    function bytesToBase64(bytes) {
        const btoaFn =
            (globalScope && typeof globalScope.btoa === "function" && globalScope.btoa.bind(globalScope)) ||
            (typeof btoa === "function" ? btoa : null);
        if (btoaFn) {
            let binary = "";
            const chunk = 0x8000;
            for (let i = 0; i < bytes.length; i += chunk) {
                binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
            }
            return btoaFn(binary);
        }
        // Pure-JS fallback
        let out = "";
        for (let i = 0; i < bytes.length; i += 3) {
            const a = bytes[i];
            const b = i + 1 < bytes.length ? bytes[i + 1] : 0;
            const c = i + 2 < bytes.length ? bytes[i + 2] : 0;
            const triple = (a << 16) | (b << 8) | c;
            out += BASE64_ALPHABET[(triple >> 18) & 63] + BASE64_ALPHABET[(triple >> 12) & 63];
            out += i + 1 < bytes.length ? BASE64_ALPHABET[(triple >> 6) & 63] : "=";
            out += i + 2 < bytes.length ? BASE64_ALPHABET[triple & 63] : "=";
        }
        return out;
    }

    function pictureToDataUrl(picture) {
        if (!picture || !picture.data || !picture.data.length) return "";
        if (picture.data.length > MAX_EMBEDDED_COVER_BYTES) return "";
        const mime = /^image\/(jpeg|jpg|png|webp|gif)$/.test(picture.mime) ? picture.mime.replace("jpg", "jpeg") : "image/jpeg";
        return `data:${mime};base64,${bytesToBase64(picture.data)}`;
    }

    function getInitials(text) {
        const words = String(text || "")
            .replace(/[^\p{L}\p{N}\s]/gu, " ")
            .split(/\s+/)
            .filter(Boolean);
        if (!words.length) return "♪";
        return (words[0][0] + (words[1] ? words[1][0] : "")).toUpperCase();
    }

    /**
     * Deterministic generated cover: two-tone gradient (hue from a hash of title+artist), concentric
     * "vinyl" rings, and initials. Returned as an SVG data URI so it works offline and persists in IndexedDB.
     */
    function generateCoverArt({ title = "", artist = "", seed = "" } = {}) {
        const hash = hashString(`${seed}|${title}|${artist}`);
        const hueA = hash % 360;
        const hueB = (hueA + 40 + ((hash >>> 9) % 80)) % 360;
        const angle = (hash >>> 3) % 360;
        const initials = getInitials(title || artist)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;");
        const svg =
            `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 300">` +
            `<defs><linearGradient id="g" gradientTransform="rotate(${angle} .5 .5)">` +
            `<stop offset="0" stop-color="hsl(${hueA} 70% 45%)"/><stop offset="1" stop-color="hsl(${hueB} 75% 22%)"/>` +
            `</linearGradient></defs>` +
            `<rect width="300" height="300" fill="url(#g)"/>` +
            `<circle cx="230" cy="230" r="120" fill="none" stroke="rgba(255,255,255,.12)" stroke-width="18"/>` +
            `<circle cx="230" cy="230" r="70" fill="none" stroke="rgba(255,255,255,.1)" stroke-width="10"/>` +
            `<text x="28" y="88" font-family="Helvetica,Arial,sans-serif" font-size="72" font-weight="700" fill="#fff">${initials}</text>` +
            `<text x="30" y="270" font-family="Helvetica,Arial,sans-serif" font-size="18" fill="rgba(255,255,255,.75)">LOCAL FILE</text>` +
            `</svg>`;
        return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
    }

    // ==================== AUDIO FEATURE INFERENCE ====================

    function inferAudioProfile(genreText, seedHash) {
        const lower = String(genreText || "").toLowerCase();
        const profile = GENRE_PROFILES.find((p) => p.match.test(lower)) || DEFAULT_PROFILE;
        // Small deterministic jitter so imports of the same genre are not identical vectors
        const jitter = (shift, spread) => ((((seedHash >>> shift) % 1000) / 1000) - 0.5) * spread;
        return {
            genre: profile.genre,
            bpm: Math.round(clamp(profile.bpm + jitter(0, 16), 60, 190)),
            energy: Number(clamp(profile.energy + jitter(4, 0.12), 0.05, 0.98).toFixed(2)),
            valence: Number(clamp(profile.valence + jitter(8, 0.12), 0.05, 0.98).toFixed(2)),
            danceability: Number(clamp(profile.danceability + jitter(12, 0.1), 0.05, 0.98).toFixed(2)),
            acousticness: Number(clamp(profile.acousticness + jitter(16, 0.1), 0.01, 0.98).toFixed(2)),
            moods: profile.moods.slice(),
        };
    }

    // ==================== TRACK BUILDER ====================

    /**
     * Builds a catalog-schema track object for an imported file.
     * `fileInfo`: { name, relativePath, size, type, lastModified }
     * `parsed`: output of parseAudioMetadata()
     */
    function buildImportedTrackMeta(fileInfo = {}, parsed = {}) {
        const tags = parsed.tags || {};
        const fromName = parseFilenameMetadata(fileInfo.name, fileInfo.relativePath || fileInfo.webkitRelativePath || "");

        const titleSource = sanitizeTagText(tags.title) || fromName.title;
        const titleSplit = extractFeaturedFromTitle(titleSource);
        const title = sanitizeTagText(titleSplit.title) || fromName.title;

        let artists = splitArtistList(tags.artist);
        if (!artists.length) artists = splitArtistList(tags.albumArtist);
        if (!artists.length) artists = fromName.artists.slice();
        if (!artists.length) artists = ["Unknown Artist"];
        for (const feat of [...titleSplit.featured, ...fromName.featuredFromTitle]) {
            if (!artists.some((a) => a.toLowerCase() === feat.toLowerCase())) artists.push(feat);
        }
        const primaryArtist = artists[0];
        const featuredArtists = artists.slice(1);

        const fileKey = `${fileInfo.name || ""}|${fileInfo.size || 0}`;
        const seedHash = hashString(`${fileKey}|${title}|${primaryArtist}`);
        const genreRaw = normalizeGenre(tags.genre);
        const profile = inferAudioProfile(`${genreRaw} ${fromName.album}`, seedHash);
        const genre = genreRaw || profile.genre;
        const tagBpm = Number(tags.bpm);
        const bpm = Number.isFinite(tagBpm) && tagBpm >= 40 && tagBpm <= 250 ? Math.round(tagBpm) : profile.bpm;

        const album = sanitizeTagText(tags.album) || fromName.album || `${title} (Local)`;
        const year = parseYear(tags.year) || (fileInfo.lastModified ? new Date(fileInfo.lastModified).getFullYear() : new Date().getFullYear());
        const duration = Number.isFinite(parsed.duration) && parsed.duration > 0 ? Number(parsed.duration.toFixed(2)) : 0;
        const ext = getFileExtension(fileInfo.name);
        const coverUrl = pictureToDataUrl(tags.picture) || generateCoverArt({ title, artist: primaryArtist, seed: fileKey });

        const moods = profile.moods.slice();
        if (bpm >= 120 && !moods.includes("Upbeat")) moods.push("Upbeat");
        if (profile.energy <= 0.4 && !moods.includes("Chill")) moods.push("Chill");

        // Instant import passes the placeholder's id so a track keeps one id while its tags fill in
        const id =
            (fileInfo.id && String(fileInfo.id)) ||
            `local-${slugify(`${title}-${primaryArtist}`) || "track"}-${(hashString(fileKey) % 0xfffff).toString(36)}`;

        const audioFeatures = {
            bpm,
            energy: profile.energy,
            valence: profile.valence,
            danceability: profile.danceability,
            acousticness: profile.acousticness,
            popularity: 0.5,
        };

        // Item 15: where each value came from, so online lookup only fills what the file didn't have
        const tagArtist = splitArtistList(tags.artist).length || splitArtistList(tags.albumArtist).length;
        const tagSources = {
            title: sanitizeTagText(tags.title) ? "tag" : "filename",
            artist: tagArtist ? "tag" : fromName.artists.length ? "filename" : "missing",
            album: sanitizeTagText(tags.album) ? "tag" : fromName.album ? "folder" : "missing",
            year: parseYear(tags.year) ? "tag" : "missing",
            genre: genreRaw ? "tag" : "inferred",
            cover: coverUrl.startsWith("data:image/svg") ? "generated" : "embedded",
        };

        return {
            id,
            filename: sanitizeTagText(fileInfo.name, 240) || `${title}.${ext || "mp3"}`,
            title,
            primaryArtist,
            featuredArtists,
            artists,
            artistDisplay: artists.join(", "),
            album,
            year,
            trackNumber: parseTrackNumber(tags.track) || fromName.trackNumber || null,
            duration,
            durationFormatted: formatDuration(duration),
            bitrateKbps: parsed.bitrateKbps || 0,
            sampleRate: parsed.sampleRate || 0,
            format: parsed.format || ext,
            mimeType: fileInfo.type || MIME_BY_EXTENSION[ext] || "audio/mpeg",
            size: fileInfo.size || 0,
            coverUrl,
            hasEmbeddedCover: coverUrl.startsWith("data:image/") && !coverUrl.startsWith("data:image/svg"),
            genre,
            subgenres: ["Local Import"],
            language: "Unknown",
            moods,
            ...audioFeatures,
            audioFeatures,
            tagSources,
            isLocalImport: true,
        };
    }

    // ==================== FILE COLLECTION (DRAG & DROP / FOLDER PICKER) ====================

    function readAllDirectoryEntries(reader) {
        return new Promise((resolve) => {
            const all = [];
            const readBatch = () => {
                reader.readEntries(
                    (batch) => {
                        if (!batch || batch.length === 0) {
                            resolve(all);
                            return;
                        }
                        all.push(...batch);
                        readBatch(); // readEntries returns at most ~100 entries per call
                    },
                    () => resolve(all)
                );
            };
            readBatch();
        });
    }

    async function collectFromEntry(entry, prefix, out, depth) {
        if (!entry || depth > 12) return;
        if (entry.isFile) {
            const file = await new Promise((resolve) => entry.file(resolve, () => resolve(null)));
            if (file) out.push({ file, relativePath: `${prefix}${file.name}` });
        } else if (entry.isDirectory && typeof entry.createReader === "function") {
            const children = await readAllDirectoryEntries(entry.createReader());
            // Resolve siblings in parallel (one entry.file() round-trip each), then append in order
            const parts = await Promise.all(
                children.map(async (child) => {
                    const part = [];
                    await collectFromEntry(child, `${prefix}${entry.name}/`, part, depth + 1);
                    return part;
                })
            );
            for (const part of parts) out.push(...part);
        }
    }

    /** Collects { file, relativePath } from a drop event's DataTransfer, walking dropped folders recursively. */
    async function collectFilesFromDataTransfer(dataTransfer) {
        if (!dataTransfer) return [];
        const out = [];
        const items = dataTransfer.items ? Array.from(dataTransfer.items) : [];
        const entries = items
            .filter((item) => item.kind === "file")
            .map((item) => (typeof item.webkitGetAsEntry === "function" ? item.webkitGetAsEntry() : null));
        if (entries.length && entries.every(Boolean)) {
            // Entries must be captured synchronously above, before any await
            const parts = await Promise.all(
                entries.map(async (entry) => {
                    const part = [];
                    await collectFromEntry(entry, "", part, 0);
                    return part;
                })
            );
            for (const part of parts) out.push(...part);
            return out;
        }
        for (const file of Array.from(dataTransfer.files || [])) {
            out.push({ file, relativePath: file.webkitRelativePath || file.name });
        }
        return out;
    }

    /** Collects { file, relativePath } from a File System Access API directory handle (showDirectoryPicker). */
    async function collectFilesFromDirectoryHandle(handle, prefix = "", depth = 0) {
        const out = [];
        if (!handle || depth > 12 || typeof handle.values !== "function") return out;
        const pending = [];
        for await (const child of handle.values()) {
            // Start every getFile() / sub-folder walk right away; await them together, keeping order
            if (child.kind === "file") {
                pending.push(
                    Promise.resolve(child.getFile()).then(
                        (file) => [{ file, relativePath: `${prefix}${handle.name}/${file.name}` }],
                        () => []
                    )
                );
            } else if (child.kind === "directory") {
                pending.push(collectFilesFromDirectoryHandle(child, `${prefix}${handle.name}/`, depth + 1));
            }
        }
        for (const part of await Promise.all(pending)) out.push(...part);
        return out;
    }

    function normalizeFileInputs(input) {
        if (!input) return [];
        const list = Array.isArray(input) ? input : Array.from(input);
        return list
            .map((item) => {
                if (!item) return null;
                if (item.file) return { file: item.file, relativePath: item.relativePath || item.file.webkitRelativePath || item.file.name };
                return { file: item, relativePath: item.webkitRelativePath || item.relativePath || item.name };
            })
            .filter((item) => item && item.file);
    }

    async function readFileBytes(file) {
        if (typeof file.arrayBuffer === "function") return file.arrayBuffer();
        if (file.data || file.buffer) return toUint8Array(file.data || file.buffer);
        if (typeof FileReader !== "undefined") {
            return new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = () => resolve(reader.result);
                reader.onerror = () => reject(reader.error);
                reader.readAsArrayBuffer(file);
            });
        }
        throw new Error("Cannot read file bytes");
    }

    /** Fallback duration probe via a media element (formats whose headers we do not parse, e.g. m4a/ogg). */
    function probeDurationWithMediaElement(blob, timeoutMs = 4000) {
        const URLApi = globalScope && globalScope.URL;
        const AudioCtor = globalScope && globalScope.Audio;
        if (!URLApi || typeof URLApi.createObjectURL !== "function" || !AudioCtor) return Promise.resolve(0);
        return new Promise((resolve) => {
            let url = "";
            let done = false;
            const finish = (value) => {
                if (done) return;
                done = true;
                try {
                    URLApi.revokeObjectURL(url);
                } catch (_) {}
                resolve(Number.isFinite(value) && value > 0 ? value : 0);
            };
            try {
                url = URLApi.createObjectURL(blob);
                const audio = new AudioCtor();
                audio.preload = "metadata";
                audio.addEventListener("loadedmetadata", () => finish(audio.duration));
                audio.addEventListener("error", () => finish(0));
                audio.src = url;
                setTimeout(() => finish(0), timeoutMs);
            } catch (_) {
                finish(0);
            }
        });
    }

    /**
     * Parses and persists local audio files into SpotTubeStorage (IndexedDB).
     * options: { storage, existingIds: Set|Array, onProgress({ index, total, name, status }), probeDuration: fn(blob) => Promise<seconds> }
     * Returns { imported: Track[], duplicates: Track[], skipped: [{ name, reason }] }.
     */
    async function importAudioFiles(input, options = {}) {
        const storage = options.storage || (globalScope && globalScope.SpotTubeStorage) || null;
        const existingIds = new Set(options.existingIds ? Array.from(options.existingIds) : []);
        const probe = typeof options.probeDuration === "function" ? options.probeDuration : probeDurationWithMediaElement;
        const items = normalizeFileInputs(input);
        const result = { imported: [], duplicates: [], skipped: [] };

        for (let index = 0; index < items.length; index++) {
            const { file, relativePath } = items[index];
            const name = String(file.name || "file");
            const report = (status) => {
                if (typeof options.onProgress === "function") {
                    options.onProgress({ index, total: items.length, name, status });
                }
            };

            if (/^\./.test(name)) {
                result.skipped.push({ name, reason: "hidden file" });
                report("skipped");
                continue;
            }
            if (!isSupportedAudioFile(file)) {
                result.skipped.push({ name, reason: "unsupported type" });
                report("skipped");
                continue;
            }
            if (file.size > MAX_FILE_BYTES) {
                result.skipped.push({ name, reason: "file too large" });
                report("skipped");
                continue;
            }

            try {
                const bytes = await readFileBytes(file);
                const parsed = parseAudioMetadata(bytes, name);
                if (!(parsed.duration > 0)) {
                    parsed.duration = await probe(file);
                }
                const meta = buildImportedTrackMeta(
                    { name, relativePath, size: file.size, type: file.type, lastModified: file.lastModified },
                    parsed
                );
                if (existingIds.has(meta.id)) {
                    result.duplicates.push(meta);
                    report("duplicate");
                    continue;
                }
                let saved = meta;
                if (storage && typeof storage.saveImportedTrack === "function") {
                    const stored = await storage.saveImportedTrack(meta, file);
                    // storage normalizes core fields; keep the richer import-only fields
                    saved = { ...meta, ...stored };
                }
                existingIds.add(saved.id);
                result.imported.push(saved);
                report("imported");
            } catch (err) {
                result.skipped.push({ name, reason: `could not read (${(err && err.message) || err})` });
                report("error");
            }
        }
        return result;
    }

    // ==================== INSTANT IMPORT (ITEM 13) ====================
    //
    // Phase 1 (synchronous): every supported file becomes a playable placeholder track built from its file name
    // and folder path, with a session blob: URL. Phase 2 (background): a small worker pool reads only the bytes
    // the tags need (file.slice), fills in tags / duration / cover art, and persists each track to IndexedDB.

    const TAG_HEAD_BYTES = 64 * 1024;
    const MAX_TAG_BYTES = 12 * 1024 * 1024; // larger ID3 tags / FLAC blocks are not read (huge embedded art)
    const DEFAULT_IMPORT_CONCURRENCY = 4;
    const SUPPORTED_FORMATS_LABEL = "MP3, FLAC, WAV, M4A, OGG, OPUS and AAC";

    function concatBytes(parts) {
        const list = parts.filter((p) => p && p.length);
        const total = list.reduce((sum, p) => sum + p.length, 0);
        const out = new Uint8Array(total);
        let offset = 0;
        for (const p of list) {
            out.set(p, offset);
            offset += p.length;
        }
        return out;
    }

    /** Reads bytes [start, end) of a File/Blob with file.slice() so only that range is loaded. */
    async function readFileRange(file, start, end) {
        const size = Number(file && file.size) || 0;
        const s = clamp(Math.floor(start), 0, size);
        const e = clamp(Math.floor(end), s, size);
        if (e <= s) return new Uint8Array(0);
        if (typeof file.slice === "function") {
            const part = file.slice(s, e);
            if (part && typeof part.arrayBuffer === "function") return new Uint8Array(await part.arrayBuffer());
            if (part) return toUint8Array(await readFileBytes(part));
        }
        // Objects without slice() (test doubles): read everything, then cut the range out
        return toUint8Array(await readFileBytes(file)).subarray(s, e);
    }

    function importFileKey(name, size) {
        return `${sanitizeTagText(name, 240).toLowerCase()}|${Number(size) || 0}`;
    }

    async function compactFlac(head, start, size, read) {
        const parts = [head.subarray(start, start + 4)];
        let offset = start + 4;
        let isLast = false;
        let guard = 0;
        while (!isLast && offset + 4 <= size && guard++ < 128) {
            const header = offset + 4 <= head.length ? head.subarray(offset, offset + 4) : await read(offset, offset + 4);
            if (header.length < 4) break;
            isLast = (header[0] & 0x80) !== 0;
            const type = header[0] & 0x7f;
            const length = (header[1] << 16) | (header[2] << 8) | header[3];
            if ((type === 0 || type === 4 || type === 6) && length <= MAX_TAG_BYTES) {
                const end = offset + 4 + length;
                const block = end <= head.length ? head.subarray(offset + 4, end) : await read(offset + 4, end);
                parts.push(Uint8Array.of(type, header[1], header[2], header[3]), block);
            }
            offset += 4 + length;
        }
        if (parts.length > 1) {
            // flag the last kept block so the parser stops there
            const lastHeaderIndex = parts.length - 2;
            parts[lastHeaderIndex] = Uint8Array.from(parts[lastHeaderIndex]);
            parts[lastHeaderIndex][0] |= 0x80;
        }
        return concatBytes(parts);
    }

    async function compactWav(head, size, read) {
        const parts = [head.subarray(0, 12)];
        let dataHeader = null;
        let offset = 12;
        let guard = 0;
        while (offset + 8 <= size && guard++ < 128) {
            const header = offset + 8 <= head.length ? head.subarray(offset, offset + 8) : await read(offset, offset + 8);
            if (header.length < 8) break;
            const id = readAscii(header, 0, 4);
            const length = readUint32LE(header, 4);
            if (id === "data") {
                dataHeader = Uint8Array.from(header); // the size is all we need; skip the audio itself
            } else if ((id === "fmt " || id === "LIST") && length <= MAX_TAG_BYTES) {
                const end = offset + 8 + length;
                const body = end <= head.length ? head.subarray(offset + 8, end) : await read(offset + 8, end);
                parts.push(header, body);
                if (length % 2) parts.push(Uint8Array.of(0));
            }
            offset += 8 + length + (length % 2);
        }
        if (dataHeader) parts.push(dataHeader); // keep "data" last so the parser doesn't jump past later chunks
        return concatBytes(parts);
    }

    /**
     * Reads only the bytes the tag parsers need: the ID3v2 tag plus the first MP3 frames, the last 128 bytes
     * (ID3v1), FLAC metadata blocks (STREAMINFO / VORBIS_COMMENT / PICTURE) or WAV fmt/LIST chunks + data header.
     * Returns { bytes, fileSize, bytesRead } where `bytes` is a compact buffer parseAudioMetadata() understands.
     */
    async function readTagBytes(file) {
        const size = Number(file && file.size) || 0;
        let bytesRead = 0;
        const read = async (start, end) => {
            const chunk = await readFileRange(file, start, end);
            bytesRead += chunk.length;
            return chunk;
        };
        if (size <= TAG_HEAD_BYTES * 2) {
            const all = await read(0, size);
            return { bytes: all, fileSize: size, bytesRead };
        }
        let head = await read(0, TAG_HEAD_BYTES);
        if (readAscii(head, 0, 4) === "RIFF" && readAscii(head, 8, 4) === "WAVE") {
            return { bytes: await compactWav(head, size, read), fileSize: size, bytesRead };
        }
        let tagSize = 0;
        if (readAscii(head, 0, 3) === "ID3" && head.length >= 10) {
            const hasFooter = head[3] === 4 && (head[5] & 0x10) !== 0;
            tagSize = 10 + readSyncSafe(head, 6) + (hasFooter ? 10 : 0);
            const want = Math.min(size, Math.min(tagSize, MAX_TAG_BYTES) + TAG_HEAD_BYTES / 2);
            if (want > head.length) {
                head = concatBytes([head, await read(head.length, want)]);
            }
        }
        if (readAscii(head, tagSize, 4) === "fLaC") {
            const flac = await compactFlac(head, tagSize, size, read);
            return { bytes: flac, fileSize: size, bytesRead };
        }
        const tail = await read(size - 128, size);
        const bytes = readAscii(tail, 0, 3) === "TAG" ? concatBytes([head, tail]) : head;
        return { bytes, fileSize: size, bytesRead };
    }

    /** Tags + duration for one file, reading only the tag bytes; falls back to a media-element probe for duration. */
    async function readAudioMetadataFromFile(file, options = {}) {
        const probe = options.probeDuration === undefined ? probeDurationWithMediaElement : options.probeDuration;
        const { bytes, fileSize, bytesRead } = await readTagBytes(file);
        const parsed = parseAudioMetadata(bytes, String(file.name || ""), { fileSize });
        if (!(parsed.duration > 0) && typeof probe === "function") {
            parsed.duration = (await probe(file)) || 0;
        }
        return { parsed, bytesRead };
    }

    /** Runs `worker(item)` over `items` with at most `concurrency` in flight; stops picking new items once `isCancelled()`. */
    async function runWithConcurrency(items, worker, concurrency = DEFAULT_IMPORT_CONCURRENCY, isCancelled = () => false) {
        let next = 0;
        const lanes = Math.max(1, Math.min(Number(concurrency) || 1, items.length));
        const lane = async () => {
            while (next < items.length && !isCancelled()) {
                const item = items[next++];
                await worker(item);
            }
        };
        await Promise.all(Array.from({ length: lanes }, lane));
    }

    /** "Album Folder" for a picked/dropped folder, the file name for one file, else "N files". */
    function guessImportSourceName(input) {
        const items = normalizeFileInputs(input);
        if (!items.length) return "";
        const roots = new Set(
            items.map(({ relativePath }) => {
                const parts = String(relativePath || "").split("/").filter(Boolean);
                return parts.length > 1 ? parts[0] : "";
            })
        );
        if (roots.size === 1) {
            const [root] = roots;
            if (root) return sanitizeTagText(root, 80);
        }
        if (items.length === 1) return sanitizeTagText(items[0].file.name, 80);
        return `${items.length} files`;
    }

    /**
     * Starts an instant import. Returns synchronously with the placeholder tracks (playable right away) and a
     * `done` promise that resolves when every file's tags are read and persisted:
     *   { tracks, skipped, duplicates, total, completed, cancel(), done }
     * options: { storage, existingKeys, existingIds, concurrency, probeDuration, createObjectUrl,
     *            onTrackUpdated(track), onTrackFailed(track, reason), onProgress({ completed, total }) }
     * `done` resolves to { imported, duplicates, skipped, removed, cancelled, total }.
     */
    function startInstantImport(input, options = {}) {
        const storage = options.storage === undefined ? (globalScope && globalScope.SpotTubeStorage) || null : options.storage;
        const probe = options.probeDuration === undefined ? probeDurationWithMediaElement : options.probeDuration;
        const URLApi = globalScope && globalScope.URL;
        const makeUrl =
            typeof options.createObjectUrl === "function"
                ? options.createObjectUrl
                : (file) => (URLApi && typeof URLApi.createObjectURL === "function" ? URLApi.createObjectURL(file) : "");
        const existingKeys = new Set(options.existingKeys ? Array.from(options.existingKeys) : []);
        const existingIds = new Set(options.existingIds ? Array.from(options.existingIds) : []);
        const emit = (name, ...args) => {
            if (typeof options[name] === "function") {
                try {
                    options[name](...args);
                } catch (_) {}
            }
        };

        // Item 14: { linkSource: { id } } saves metadata + relative path only (no copy); audio stays in the folder
        const linkSourceId = options.linkSource && options.linkSource.id ? String(options.linkSource.id) : "";
        const tracks = [];
        const skipped = [];
        const duplicates = [];
        const jobs = [];
        const batchCreatedAt = Date.now(); // one timestamp per batch keeps folder order in "newest first" lists
        for (const { file, relativePath } of normalizeFileInputs(input)) {
            const name = String(file.name || "file");
            const entry = { name: sanitizeTagText(name, 240), relativePath: sanitizeTagText(relativePath || name, 400) };
            if (/^\./.test(name)) {
                skipped.push({ ...entry, reason: "Hidden file" });
                continue;
            }
            if (!isSupportedAudioFile(file)) {
                skipped.push({ ...entry, reason: `Not a supported audio format (${SUPPORTED_FORMATS_LABEL})` });
                continue;
            }
            if (file.size > MAX_FILE_BYTES) {
                skipped.push({ ...entry, reason: "File is larger than 400 MB" });
                continue;
            }
            const info = { name, relativePath, size: file.size, type: file.type, lastModified: file.lastModified };
            const key = importFileKey(name, file.size);
            const placeholder = buildImportedTrackMeta(info, {});
            if (existingKeys.has(key) || existingIds.has(placeholder.id)) {
                duplicates.push({ ...entry, reason: "Already in your library" });
                continue;
            }
            existingKeys.add(key);
            existingIds.add(placeholder.id);
            let audioUrl = "";
            try {
                audioUrl = makeUrl(file) || "";
            } catch (_) {}
            Object.assign(placeholder, {
                audioUrl: audioUrl || `blob:spottube-local/${encodeURIComponent(placeholder.id)}`,
                importStatus: "pending",
                importKey: key,
                duration: 0,
                durationFormatted: "",
                createdAt: batchCreatedAt,
                storageMode: linkSourceId ? "linked" : "copy",
            });
            if (linkSourceId) {
                placeholder.sourceId = linkSourceId;
                placeholder.relativePath = String(relativePath || name);
                if (storage && typeof storage.setLinkedTrackUrl === "function" && audioUrl) {
                    storage.setLinkedTrackUrl(placeholder.id, audioUrl);
                }
            }
            tracks.push(placeholder);
            jobs.push({ file, info, track: placeholder });
        }

        let cancelled = false;
        let completed = 0;
        const imported = [];
        const failed = [];
        const controller = {
            tracks,
            skipped,
            duplicates,
            total: jobs.length,
            get completed() {
                return completed;
            },
            get cancelled() {
                return cancelled;
            },
            cancel() {
                cancelled = true;
            },
            done: null,
        };

        const processJob = async (job) => {
            if (cancelled) return;
            const fileInfo = { ...job.info, id: job.track.id };
            let meta;
            try {
                const { parsed } = await readAudioMetadataFromFile(job.file, { probeDuration: probe });
                meta = buildImportedTrackMeta(fileInfo, parsed);
            } catch (_) {
                meta = buildImportedTrackMeta(fileInfo, {}); // unreadable tags: keep the file-name metadata
            }
            if (cancelled) return;
            try {
                if (storage && typeof storage.saveImportedTrack === "function") {
                    const record = {
                        ...meta,
                        createdAt: job.track.createdAt,
                        importKey: job.track.importKey,
                        lastModified: job.info.lastModified,
                    };
                    if (linkSourceId) {
                        record.storageMode = "linked";
                        record.sourceId = linkSourceId;
                        record.relativePath = job.track.relativePath;
                    }
                    const stored = await storage.saveImportedTrack(record, linkSourceId ? null : job.file);
                    meta = { ...meta, ...stored };
                }
            } catch (err) {
                const reason = `Could not be saved in this browser (${(err && err.message) || err})`;
                failed.push({ name: sanitizeTagText(job.info.name, 240), relativePath: sanitizeTagText(job.info.relativePath, 400), reason });
                job.track.importStatus = "failed";
                completed++;
                emit("onTrackFailed", job.track, reason);
                emit("onProgress", { completed, total: jobs.length });
                return;
            }
            // Keep the placeholder's session URL so a row that is already playing isn't reloaded
            const audioUrl = job.track.audioUrl;
            Object.assign(job.track, meta, {
                audioUrl,
                importStatus: "ready",
                importKey: job.track.importKey,
                storageMode: job.track.storageMode,
            });
            if (linkSourceId) {
                job.track.sourceId = linkSourceId;
                job.track.relativePath = job.track.relativePath || job.info.relativePath;
            }
            imported.push(job.track);
            completed++;
            emit("onTrackUpdated", job.track);
            emit("onProgress", { completed, total: jobs.length });
        };

        controller.done = (async () => {
            await Promise.resolve(); // let the caller render the placeholders first
            await runWithConcurrency(jobs, processJob, options.concurrency || DEFAULT_IMPORT_CONCURRENCY, () => cancelled);
            const removed = jobs.filter((j) => j.track.importStatus === "pending").map((j) => j.track);
            return { imported, duplicates, skipped: skipped.concat(failed), removed, cancelled, total: jobs.length };
        })();
        return controller;
    }

    /**
     * Item 14 Rescan: compares a linked folder's saved tracks with a fresh walk of the folder.
     * Matches by relative path; a file whose size changed counts as removed + added so its tags are re-read.
     * → { added: [{ file, relativePath }], removed: [track], kept: [track] }
     */
    function diffFolderScan(existingTracks = [], scannedEntries = []) {
        const scanned = new Map();
        for (const item of normalizeFileInputs(scannedEntries)) {
            if (!isSupportedAudioFile(item.file) || /^\./.test(String(item.file.name || ""))) continue;
            scanned.set(String(item.relativePath), item);
        }
        const kept = [];
        const removed = [];
        const keptPaths = new Set();
        for (const track of existingTracks) {
            const item = scanned.get(String(track.relativePath || ""));
            const sameSize = item && (!Number(track.size) || Number(item.file.size) === Number(track.size));
            if (item && sameSize) {
                kept.push(track);
                keptPaths.add(String(track.relativePath));
            } else {
                removed.push(track);
            }
        }
        const added = [];
        for (const [relativePath, item] of scanned) {
            if (!keptPaths.has(relativePath)) added.push(item);
        }
        return { added, removed, kept };
    }

    /** Toast text for a Rescan, e.g. "Rescanned “Music” · 3 added · 1 removed". */
    function summarizeRescan(sourceName, diff = {}) {
        const added = (diff.added || []).length;
        const removed = (diff.removed || []).length;
        const parts = [];
        if (added) parts.push(`${added} added`);
        if (removed) parts.push(`${removed} removed`);
        return `Rescanned “${sanitizeTagText(sourceName || "folder", 80)}” · ${parts.length ? parts.join(" · ") : "no changes"}`;
    }

    /** Toast text for a finished instant import, e.g. "Added 498 songs · 2 skipped". */
    function summarizeInstantImport(result = {}) {
        const added = (result.imported || []).length;
        const skippedCount = (result.skipped || []).length + (result.duplicates || []).length;
        const songsLabel = (n) => `${n} ${n === 1 ? "song" : "songs"}`;
        if (result.cancelled) {
            return `Stopped · added ${added} of ${songsLabel(result.total || added)}`;
        }
        if (!added) {
            return skippedCount ? `Nothing new to add · ${skippedCount} skipped` : "No music found";
        }
        return skippedCount ? `Added ${songsLabel(added)} · ${skippedCount} skipped` : `Added ${songsLabel(added)}`;
    }

    function summarizeImportResult(result) {
        const imported = (result && result.imported && result.imported.length) || 0;
        const dupes = (result && result.duplicates && result.duplicates.length) || 0;
        const skipped = (result && result.skipped && result.skipped.length) || 0;
        const parts = [];
        if (imported) parts.push(`Imported ${imported} ${imported === 1 ? "track" : "tracks"}`);
        if (dupes) parts.push(`${dupes} already in library`);
        if (skipped) parts.push(`${skipped} skipped`);
        return parts.length ? parts.join(" • ") : "No audio files found";
    }

    // ==================== PLAYLIST HELPERS ====================

    function resolvePlaylistTracks(playlist, catalog = []) {
        if (!playlist || !Array.isArray(playlist.trackIds)) return [];
        const byId = new Map(catalog.map((t) => [t.id, t]));
        return playlist.trackIds.map((id) => byId.get(id)).filter(Boolean);
    }

    function nextDefaultPlaylistName(playlists = []) {
        let max = 0;
        for (const pl of playlists) {
            const match = /^My Playlist #(\d+)$/.exec(String((pl && pl.name) || ""));
            if (match) max = Math.max(max, Number(match[1]));
        }
        return `My Playlist #${Math.max(max, playlists.length) + 1}`;
    }

    /** Up to 4 distinct covers for a 2x2 collage (Spotify playlist style). */
    function buildCollectionCovers(tracks = [], fallbackSeed = "") {
        const covers = [];
        for (const t of tracks) {
            if (t && t.coverUrl && !covers.includes(t.coverUrl)) covers.push(t.coverUrl);
            if (covers.length === 4) break;
        }
        if (!covers.length) covers.push(generateCoverArt({ title: fallbackSeed || "Playlist", seed: fallbackSeed }));
        return covers;
    }

    function sumDuration(tracks = []) {
        return tracks.reduce((acc, t) => acc + (Number(t.duration) || 0), 0);
    }

    return {
        SUPPORTED_AUDIO_EXTENSIONS,
        MIME_BY_EXTENSION,
        ID3_GENRES,
        hashString,
        slugify,
        sanitizeTagText,
        formatDuration,
        getFileExtension,
        isSupportedAudioFile,
        splitArtistList,
        extractFeaturedFromTitle,
        parseFilenameMetadata,
        parseId3v2,
        parseId3v1,
        parseMp3Stream,
        parseFlac,
        parseWav,
        parseVorbisComments,
        parseAudioMetadata,
        normalizeGenre,
        pictureToDataUrl,
        generateCoverArt,
        inferAudioProfile,
        buildImportedTrackMeta,
        collectFilesFromDataTransfer,
        collectFilesFromDirectoryHandle,
        diffFolderScan,
        summarizeRescan,
        probeDurationWithMediaElement,
        importAudioFiles,
        summarizeImportResult,
        TAG_HEAD_BYTES,
        SUPPORTED_FORMATS_LABEL,
        readFileRange,
        readTagBytes,
        readAudioMetadataFromFile,
        runWithConcurrency,
        importFileKey,
        guessImportSourceName,
        startInstantImport,
        summarizeInstantImport,
        resolvePlaylistTracks,
        nextDefaultPlaylistName,
        buildCollectionCovers,
        sumDuration,
    };
});
