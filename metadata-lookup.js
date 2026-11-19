/**
 * SpotTube metadata lookup (item 15): optional online lookup for imported songs whose tags are missing or weak.
 *
 * Keyless services only:
 *  - MusicBrainz recording search (title / artist / album / year), at most 1 request per second
 *  - Cover Art Archive front covers for the matched MusicBrainz release
 *  - iTunes Search API (cover art + genre), fetch with CORS, JSONP fallback
 *
 * Only song title, artist and album text are sent. Audio is never uploaded. Nothing here runs unless the
 * shell calls it, and the shell only does that while the user's "Online lookup" setting is on.
 */
(function (root, factory) {
    const api = factory(root);
    if (typeof module === "object" && module.exports) module.exports = api;
    if (root) root.SpotTubeMetadataLookup = api;
})(typeof window !== "undefined" ? window : typeof globalThis !== "undefined" ? globalThis : this, function (globalScope) {
    "use strict";

    const APP_NAME = "SpotTube-Hybrid-Player";
    const APP_VERSION = "1.0";
    const APP_CONTACT = "https://github.com/fp101fs/spotify-ytm-hybrid-player";
    const USER_AGENT = `${APP_NAME}/${APP_VERSION} ( ${APP_CONTACT} )`;
    const MUSICBRAINZ_URL = "https://musicbrainz.org/ws/2/recording";
    const COVER_ART_URL = "https://coverartarchive.org/release";
    const ITUNES_URL = "https://itunes.apple.com/search";
    const CACHE_VERSION = 1;

    const DURATION_TOLERANCE_SEC = 3;
    const CONFIDENT_TITLE = 0.9;
    const CONFIDENT_ARTIST = 0.85;
    const SUGGEST_MIN_SCORE = 0.55;

    const PLACEHOLDER_ARTISTS = new Set(["unknown artist", "local artist", "unknown", "various artists", "artist"]);
    const FIELD_LABELS = { title: "Title", artist: "Artist", album: "Album", year: "Year", genre: "Genre", cover: "Cover" };
    const FIELD_ORDER = ["title", "artist", "album", "year", "genre", "cover"];

    // ==================== TEXT MATCHING ====================

    const NOISE_PARENS = /[([{][^)\]}]*\b(official|video|audio|lyrics?|lyric video|visuali[sz]er|remaster(ed)?|hd|hq|4k|explicit|clean|radio edit|mv|m\/v)\b[^)\]}]*[)\]}]/gi;

    function stripDiacritics(str) {
        return typeof str.normalize === "function" ? str.normalize("NFKD").replace(/[̀-ͯ]/g, "") : str;
    }

    /** Lower-case, no accents, no "(Official Video)"-style noise, no "feat. X", punctuation folded to spaces. */
    function normalizeForMatch(value) {
        let s = stripDiacritics(String(value || "")).toLowerCase();
        s = s.replace(NOISE_PARENS, " ");
        s = s.replace(/[([{]?\s*\b(feat|ft|featuring|with)\b\.?\s+[^)\]}]*[)\]}]?/g, " ");
        s = s.replace(/&/g, " and ");
        s = s.replace(/['’`]/g, "");
        s = s.replace(/[^a-z0-9]+/g, " ");
        return s.replace(/\s+/g, " ").trim();
    }

    function bigrams(s) {
        const out = new Map();
        const str = ` ${s} `;
        for (let i = 0; i < str.length - 1; i++) {
            const g = str.slice(i, i + 2);
            out.set(g, (out.get(g) || 0) + 1);
        }
        return out;
    }

    /** Sørensen–Dice on character bigrams of the normalised strings (0..1). */
    function similarity(a, b) {
        const x = normalizeForMatch(a);
        const y = normalizeForMatch(b);
        if (!x || !y) return 0;
        if (x === y) return 1;
        const bx = bigrams(x);
        const by = bigrams(y);
        let overlap = 0;
        let total = 0;
        for (const [g, n] of bx) {
            total += n;
            if (by.has(g)) overlap += Math.min(n, by.get(g));
        }
        for (const n of by.values()) total += n;
        return total ? (2 * overlap) / total : 0;
    }

    function isPlaceholderArtist(name) {
        return !name || PLACEHOLDER_ARTISTS.has(String(name).trim().toLowerCase());
    }

    function trackArtist(track) {
        return String((track && (track.primaryArtist || (track.artists && track.artists[0]) || track.artistDisplay)) || "").trim();
    }

    function isGeneratedCover(track) {
        if (!track) return true;
        if (track.tagSources && track.tagSources.cover) return track.tagSources.cover === "generated";
        if (track.hasEmbeddedCover) return false;
        const url = String(track.coverDataUrl || track.coverUrl || "");
        return !url || url.startsWith("data:image/svg");
    }

    /**
     * Which fields of an imported track are missing or weak. `tagSources` (set at import since item 15) says
     * where each value came from; older imports are judged by their placeholder values.
     */
    function getWeakFields(track) {
        if (!track || !track.isLocalImport) return [];
        const src = track.tagSources || {};
        const weak = [];
        const fromTag = (field) => src[field] === "tag" || src[field] === "online" || src[field] === "user";
        if (src.title ? !fromTag("title") : false) weak.push("title");
        const artist = trackArtist(track);
        if (isPlaceholderArtist(artist) || (src.artist && !fromTag("artist"))) weak.push("artist");
        const album = String(track.album || "");
        if (!album || / \(Local\)$/.test(album) || album === "Local Imports" || (src.album && !fromTag("album"))) weak.push("album");
        if (src.genre ? !fromTag("genre") : !track.genre || track.genre === "Local") weak.push("genre");
        if (src.year ? !fromTag("year") : false) weak.push("year");
        if (isGeneratedCover(track)) weak.push("cover");
        return weak;
    }

    /** Worth looking up: identity info is missing (artist / album / filename-only title) or the cover is generated. */
    function needsLookup(track) {
        if (!track || !track.isLocalImport || track.importStatus === "pending") return false;
        const weak = getWeakFields(track);
        return weak.some((f) => f === "artist" || f === "album" || f === "title" || f === "cover");
    }

    /** Changes when the values a lookup is based on change, so the cache is skipped for edited tracks. */
    function lookupSignature(track) {
        return [
            CACHE_VERSION,
            normalizeForMatch(track && track.title),
            normalizeForMatch(trackArtist(track)),
            normalizeForMatch(track && track.album),
            Math.round(Number(track && track.duration) || 0),
        ].join("|");
    }

    // ==================== QUERIES ====================

    /** Title as sent to the services: no "(Official Video)" / "[Lyrics]" / "feat. X" noise. */
    function cleanTitleForQuery(value) {
        const raw = String(value || "");
        const cleaned = raw
            .replace(NOISE_PARENS, " ")
            .replace(/[([{]\s*(feat|ft|featuring)\b\.?[^)\]}]*[)\]}]/gi, " ")
            .replace(/\s+(feat|ft|featuring)\.?\s+.*$/i, "")
            .replace(/\s+/g, " ")
            .trim();
        return cleaned || raw.trim();
    }

    function luceneEscape(value) {
        return String(value || "").replace(/([+\-!(){}[\]^"~*?:\\/]|&&|\|\|)/g, "\\$1");
    }

    function buildMusicBrainzQuery(track) {
        const title = cleanTitleForQuery(track && track.title);
        const artist = trackArtist(track);
        const album = String((track && track.album) || "");
        const parts = [`recording:"${luceneEscape(title)}"`];
        if (!isPlaceholderArtist(artist)) parts.push(`artist:"${luceneEscape(artist)}"`);
        const weakAlbum = !album || / \(Local\)$/.test(album) || album === "Local Imports";
        if (!weakAlbum && track.tagSources && track.tagSources.album === "tag") parts.push(`release:"${luceneEscape(album)}"`);
        return parts.join(" AND ");
    }

    function buildMusicBrainzUrl(track) {
        const q = encodeURIComponent(buildMusicBrainzQuery(track));
        return `${MUSICBRAINZ_URL}?query=${q}&fmt=json&limit=8`;
    }

    function buildItunesUrl(track, callback) {
        const artist = trackArtist(track);
        const term = [cleanTitleForQuery(track && track.title), isPlaceholderArtist(artist) ? "" : artist].filter(Boolean).join(" ");
        let url = `${ITUNES_URL}?term=${encodeURIComponent(term)}&entity=song&media=music&limit=8`;
        if (callback) url += `&callback=${encodeURIComponent(callback)}`;
        return url;
    }

    function coverArtUrl(releaseId) {
        return releaseId ? `${COVER_ART_URL}/${releaseId}/front-250` : "";
    }

    // ==================== RESPONSE PARSING ====================

    function releaseRank(rel) {
        const rg = rel["release-group"] || {};
        let rank = 0;
        if (rel.status === "Official") rank += 4;
        if (rg["primary-type"] === "Album") rank += 3;
        else if (rg["primary-type"] === "Single" || rg["primary-type"] === "EP") rank += 2;
        if (!(rg["secondary-types"] || []).length) rank += 3; // not Live / Compilation / Remix
        return rank;
    }

    function pickRelease(releases) {
        const list = (releases || []).slice();
        list.sort((a, b) => releaseRank(b) - releaseRank(a) || String(a.date || "9999").localeCompare(String(b.date || "9999")));
        return list[0] || null;
    }

    function parseYear(value) {
        const m = String(value || "").match(/\b(1[89]\d\d|20\d\d)\b/);
        return m ? Number(m[1]) : null;
    }

    function parseMusicBrainzRecordings(json) {
        const recordings = (json && json.recordings) || [];
        return recordings.map((rec) => {
            const credits = rec["artist-credit"] || [];
            const artists = credits.map((c) => c.name || (c.artist && c.artist.name)).filter(Boolean);
            const release = pickRelease(rec.releases);
            return {
                source: "musicbrainz",
                id: rec.id,
                title: rec.title || "",
                artists,
                artist: artists[0] || "",
                album: release ? release.title || "" : "",
                releaseId: release ? release.id : "",
                year: parseYear(rec["first-release-date"]) || (release ? parseYear(release.date) : null),
                durationSec: Number(rec.length) > 0 ? Number(rec.length) / 1000 : 0,
                genre: "",
                coverUrl: release ? coverArtUrl(release.id) : "",
                serviceScore: Number(rec.score) || 0,
                // 0..1: official studio album = 1, live/compilation/bootleg lower (tie-breaker only)
                releaseQuality: release ? releaseRank(release) / 10 : 0,
            };
        });
    }

    function parseItunesResults(json) {
        const results = (json && json.results) || [];
        return results
            .filter((r) => !r.kind || r.kind === "song")
            .map((r) => ({
                source: "itunes",
                id: String(r.trackId || ""),
                title: r.trackName || "",
                artists: r.artistName ? [r.artistName] : [],
                artist: r.artistName || "",
                album: r.collectionName || "",
                releaseId: "",
                year: parseYear(r.releaseDate),
                durationSec: Number(r.trackTimeMillis) > 0 ? Number(r.trackTimeMillis) / 1000 : 0,
                genre: r.primaryGenreName || "",
                coverUrl: r.artworkUrl100 ? String(r.artworkUrl100).replace(/\/\d+x\d+bb\./, "/600x600bb.") : "",
                serviceScore: 0,
                releaseQuality: /\b(hits|greatest|best of|collection|anthology|now that'?s|essentials|karaoke|tribute)\b/i.test(r.collectionName || "") ? 0.3 : 0.8,
            }));
    }

    // ==================== SCORING ====================

    /**
     * Title/artist similarity plus duration agreement. "confident" = safe to apply without asking: title and
     * artist both very close and the durations are within ±3 s (an unknown artist or duration is never confident).
     */
    function scoreCandidate(track, cand) {
        const titleSim = similarity(track.title, cand.title);
        const artist = trackArtist(track);
        const artistKnown = !isPlaceholderArtist(artist);
        const artistSim = artistKnown
            ? Math.max(0, ...[cand.artist, ...(cand.artists || []), (cand.artists || []).join(" ")].map((a) => similarity(artist, a)))
            : 0;
        const dur = Number(track.duration) || 0;
        const durationKnown = dur > 0 && cand.durationSec > 0;
        const durationDiff = durationKnown ? Math.abs(dur - cand.durationSec) : null;
        // Unknown length counts for less than a match, so a length-less live/bootleg entry can't win on it
        let durationScore = 0.3;
        if (durationKnown) durationScore = durationDiff <= DURATION_TOLERANCE_SEC ? 1 : durationDiff <= 10 ? 0.4 : 0;

        const score = artistKnown
            ? 0.5 * titleSim + 0.35 * artistSim + 0.15 * durationScore
            : 0.75 * titleSim + 0.25 * durationScore;
        const confident =
            artistKnown && durationKnown && titleSim >= CONFIDENT_TITLE && artistSim >= CONFIDENT_ARTIST && durationDiff <= DURATION_TOLERANCE_SEC;
        return {
            score: Math.round(score * 1000) / 1000,
            titleSim: Math.round(titleSim * 1000) / 1000,
            artistSim: Math.round(artistSim * 1000) / 1000,
            durationDiff: durationDiff === null ? null : Math.round(durationDiff * 10) / 10,
            confident,
        };
    }

    function rankKey(cand) {
        // Max swing 0.1 stays below what a matching length adds (0.15), so a real length match still wins
        return cand.match.score + 0.1 * (Number(cand.releaseQuality) || 0);
    }

    function rankCandidates(track, candidates) {
        return (candidates || [])
            .map((cand) => ({ ...cand, match: scoreCandidate(track, cand) }))
            // Near-equal matches: the original studio album beats compilations / live releases
            .sort((a, b) => rankKey(b) - rankKey(a) || b.serviceScore - a.serviceScore);
    }

    /**
     * Combines the best MusicBrainz and iTunes matches into one suggestion. Identity fields come from the best
     * match; genre comes from iTunes; the cover prefers iTunes artwork (always present) over Cover Art Archive.
     */
    function buildSuggestion(track, mbRanked, itRanked) {
        const mb = mbRanked && mbRanked[0];
        const it = itRanked && itRanked[0];
        const usable = (c) => c && c.match.score >= SUGGEST_MIN_SCORE;
        const primary = [mb, it].filter(usable).sort((a, b) => rankKey(b) - rankKey(a))[0];
        if (!primary) return null;
        // A second source agreeing with the first (same song) can fill genre / cover / year
        const agrees = (c) => usable(c) && c !== primary && similarity(c.title, primary.title) >= 0.85 && similarity(c.artist, primary.artist) >= 0.8;
        const other = [mb, it].find(agrees) || null;
        const itMatch = primary.source === "itunes" ? primary : other && other.source === "itunes" ? other : null;
        const mbMatch = primary.source === "musicbrainz" ? primary : other && other.source === "musicbrainz" ? other : null;
        const fields = {
            title: primary.title,
            artists: primary.artists && primary.artists.length ? primary.artists.slice() : [primary.artist],
            artist: primary.artist,
            album: primary.album || (other && other.album) || "",
            year: primary.year || (other && other.year) || null,
            genre: (itMatch && itMatch.genre) || "",
            coverUrl: (itMatch && itMatch.coverUrl) || (mbMatch && mbMatch.coverUrl) || "",
        };
        const confident = primary.match.confident || Boolean(other && other.match.confident && primary.match.score >= 0.8);
        return {
            fields,
            confident,
            score: primary.match.score,
            match: primary.match,
            sources: {
                primary: primary.source,
                musicbrainzId: mbMatch ? mbMatch.id : "",
                releaseId: mbMatch ? mbMatch.releaseId : "",
                itunesId: itMatch ? itMatch.id : "",
                cover: itMatch && itMatch.coverUrl ? "itunes" : mbMatch && mbMatch.coverUrl ? "coverartarchive" : "",
            },
        };
    }

    // ==================== CHANGES ====================

    function currentFieldValue(track, field) {
        if (field === "artist") return (track.artists && track.artists.length ? track.artists.join(", ") : trackArtist(track)) || "";
        if (field === "cover") return track.coverUrl || "";
        if (field === "year") return track.year ? String(track.year) : "";
        return String(track[field] || "");
    }

    function suggestedFieldValue(fields, field) {
        if (field === "artist") return (fields.artists && fields.artists.length ? fields.artists.join(", ") : fields.artist) || "";
        if (field === "cover") return fields.coverUrl || "";
        if (field === "year") return fields.year ? String(fields.year) : "";
        return String(fields[field] || "");
    }

    /**
     * What a suggestion would change. Fields the file already had (tags) are left out unless overwriteTags, and
     * are flagged `fromFile` so the review dialog can say so.
     */
    function computeChanges(track, suggestion, options = {}) {
        if (!track || !suggestion || !suggestion.fields) return [];
        const weak = new Set(getWeakFields(track));
        const out = [];
        for (const field of FIELD_ORDER) {
            const suggested = suggestedFieldValue(suggestion.fields, field);
            if (!suggested) continue;
            const current = currentFieldValue(track, field);
            const same = field === "cover" ? current === suggested : normalizeForMatch(current) === normalizeForMatch(suggested) && current === suggested;
            if (same) continue;
            const fromFile = !weak.has(field);
            if (fromFile && !options.overwriteTags) continue;
            out.push({ field, label: FIELD_LABELS[field], current, suggested, fromFile });
        }
        return out;
    }

    /** Builds the patch for the chosen changes; tagSources marks each applied field "online". */
    function buildPatch(track, suggestion, changes, meta = {}) {
        const patch = { tagSources: { ...(track.tagSources || {}) } };
        const fields = suggestion.fields;
        for (const change of changes) {
            const f = change.field;
            if (f === "title") patch.title = fields.title;
            else if (f === "artist") {
                const artists = fields.artists && fields.artists.length ? fields.artists.slice() : [fields.artist];
                patch.artists = artists;
                patch.primaryArtist = artists[0];
                patch.featuredArtists = artists.slice(1);
                patch.artistDisplay = artists.join(", ");
            } else if (f === "album") patch.album = fields.album;
            else if (f === "year") patch.year = Number(fields.year) || track.year;
            else if (f === "genre") patch.genre = fields.genre;
            else if (f === "cover") {
                patch.coverUrl = fields.coverUrl;
                patch.hasEmbeddedCover = false;
            }
            patch.tagSources[f] = "online";
        }
        patch.onlineMatch = {
            ...suggestion.sources,
            score: suggestion.score,
            appliedAt: meta.now || Date.now(),
            auto: Boolean(meta.auto),
            fields: changes.map((c) => c.field),
        };
        return patch;
    }

    // ==================== NETWORK ====================

    function defaultSleep(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    /** JSONP request (iTunes fallback when a CORS fetch is refused). Browser only. */
    function jsonpRequest(buildUrl, options = {}) {
        const doc = globalScope && globalScope.document;
        if (!doc || typeof doc.createElement !== "function") return Promise.reject(new Error("JSONP unavailable"));
        return new Promise((resolve, reject) => {
            const name = `__spottubeJsonp${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
            const script = doc.createElement("script");
            let timer = null;
            const cleanup = () => {
                if (timer) clearTimeout(timer);
                try {
                    delete globalScope[name];
                } catch (_) {
                    globalScope[name] = undefined;
                }
                if (script.parentNode) script.parentNode.removeChild(script);
            };
            globalScope[name] = (data) => {
                cleanup();
                resolve(data);
            };
            script.onerror = () => {
                cleanup();
                reject(new Error("JSONP failed"));
            };
            timer = setTimeout(() => {
                cleanup();
                reject(new Error("JSONP timed out"));
            }, options.timeoutMs || 15000);
            script.src = buildUrl(name);
            script.async = true;
            (doc.head || doc.body).appendChild(script);
        });
    }

    /**
     * Creates the lookup client. Requests to each service go through their own serial queue with a minimum
     * gap (MusicBrainz 1.1 s, iTunes 3 s) so a big library never bursts.
     *
     * options: { fetch, jsonp, cache: { get(trackId), set(record) }, sleep, now, musicBrainzIntervalMs, itunesIntervalMs }
     */
    function createLookupClient(options = {}) {
        const fetchFn = options.fetch || (globalScope && globalScope.fetch ? globalScope.fetch.bind(globalScope) : null);
        const jsonp = options.jsonp || jsonpRequest;
        const sleep = options.sleep || defaultSleep;
        const now = options.now || (() => Date.now());
        const cache = options.cache || null;
        const gaps = {
            musicbrainz: options.musicBrainzIntervalMs ?? 1100,
            itunes: options.itunesIntervalMs ?? 3000,
        };
        const lanes = { musicbrainz: { last: 0, chain: Promise.resolve() }, itunes: { last: 0, chain: Promise.resolve() } };
        let itunesMode = options.itunesMode || "fetch"; // flips to "jsonp" after a CORS failure
        const stats = { requests: { musicbrainz: 0, itunes: 0 } };

        function schedule(service, task) {
            const lane = lanes[service];
            const run = lane.chain.then(async () => {
                const wait = lane.last + gaps[service] - now();
                if (wait > 0) await sleep(wait);
                lane.last = now();
                stats.requests[service]++;
                return task();
            });
            lane.chain = run.catch(() => {});
            return run;
        }

        async function getJson(url, init) {
            if (!fetchFn) throw new Error("fetch unavailable");
            const res = await fetchFn(url, init);
            if (!res || !res.ok) {
                const err = new Error(`HTTP ${res ? res.status : "error"}`);
                err.status = res ? res.status : 0;
                throw err;
            }
            return typeof res.json === "function" ? res.json() : JSON.parse(await res.text());
        }

        async function searchMusicBrainz(track) {
            const url = buildMusicBrainzUrl(track);
            // Browsers may drop User-Agent; MusicBrainz's CORS allows it, so send it where it is honoured
            const init = { headers: { Accept: "application/json", "User-Agent": USER_AGENT }, mode: "cors", credentials: "omit", referrerPolicy: "origin" };
            for (let attempt = 0; attempt < 2; attempt++) {
                try {
                    return parseMusicBrainzRecordings(await schedule("musicbrainz", () => getJson(url, init)));
                } catch (err) {
                    // 503 = over the rate limit: back off once
                    if (err && err.status === 503 && attempt === 0) {
                        await sleep(2000);
                        continue;
                    }
                    throw err;
                }
            }
            return [];
        }

        async function searchItunes(track) {
            if (itunesMode === "fetch") {
                try {
                    return parseItunesResults(
                        await schedule("itunes", () => getJson(buildItunesUrl(track), { mode: "cors", credentials: "omit", referrerPolicy: "no-referrer" }))
                    );
                } catch (err) {
                    // TypeError = network/CORS refusal; switch to JSONP for the rest of the session
                    if (!(err && err.name === "TypeError")) throw err;
                    itunesMode = "jsonp";
                }
            }
            return parseItunesResults(await schedule("itunes", () => jsonp((cb) => buildItunesUrl(track, cb))));
        }

        /**
         * Looks one track up. Returns { trackId, signature, status: "confident"|"suggested"|"none"|"error", suggestion,
         * checkedAt, cached }. Results (not errors) are cached per track; `force` skips the cache.
         */
        async function lookupTrack(track, opts = {}) {
            const signature = lookupSignature(track);
            if (!opts.force && cache) {
                const hit = await cache.get(track.id);
                if (hit && hit.signature === signature) return { ...hit, cached: true };
            }
            let mb = [];
            let it = [];
            let firstError = null;
            try {
                mb = rankCandidates(track, await searchMusicBrainz(track));
            } catch (err) {
                firstError = err;
            }
            const weak = new Set(getWeakFields(track));
            const mbBest = mb[0];
            // iTunes is only asked when it can add something: genre/cover, or MusicBrainz found nothing usable
            const wantItunes = weak.has("cover") || weak.has("genre") || !mbBest || !mbBest.match.confident;
            if (wantItunes && opts.itunes !== false) {
                try {
                    it = rankCandidates(track, await searchItunes(track));
                } catch (err) {
                    firstError = firstError || err;
                }
            }
            if (firstError && !mb.length && !it.length) {
                return { trackId: track.id, signature, status: "error", error: String(firstError.message || firstError), checkedAt: now(), cached: false };
            }
            const suggestion = buildSuggestion(track, mb, it);
            const status = !suggestion ? "none" : suggestion.confident ? "confident" : "suggested";
            const record = { trackId: track.id, signature, status, suggestion, checkedAt: now(), version: CACHE_VERSION };
            if (cache) await cache.set(record);
            return { ...record, cached: false };
        }

        return { lookupTrack, searchMusicBrainz, searchItunes, stats, getItunesMode: () => itunesMode };
    }

    /** "Updated 18 songs · 6 to review · 16 not found" */
    function summarizeLookup(counts = {}) {
        const parts = [];
        const n = (x, one, many) => `${x} ${x === 1 ? one : many}`;
        if (counts.applied) parts.push(`Updated ${n(counts.applied, "song", "songs")}`);
        if (counts.suggested) parts.push(`${counts.suggested} to review`);
        if (counts.none) parts.push(`${counts.none} not found`);
        if (counts.errors) parts.push(`${n(counts.errors, "lookup", "lookups")} failed`);
        if (counts.cancelled) parts.unshift("Stopped");
        if (!parts.length) return "Nothing new to look up";
        return parts.join(" · ");
    }

    return {
        APP_NAME,
        USER_AGENT,
        FIELD_LABELS,
        DURATION_TOLERANCE_SEC,
        normalizeForMatch,
        cleanTitleForQuery,
        similarity,
        isPlaceholderArtist,
        getWeakFields,
        needsLookup,
        lookupSignature,
        buildMusicBrainzQuery,
        buildMusicBrainzUrl,
        buildItunesUrl,
        coverArtUrl,
        parseMusicBrainzRecordings,
        parseItunesResults,
        scoreCandidate,
        rankCandidates,
        buildSuggestion,
        computeChanges,
        buildPatch,
        createLookupClient,
        jsonpRequest,
        summarizeLookup,
    };
});
