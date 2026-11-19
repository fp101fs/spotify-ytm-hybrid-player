/**
 * SpotTube Hybrid Player — Universal "Start Mix" Radio Generator & Queue Manager (`queue.js`)
 *
 * Implements:
 * 1. Universal "Start Mix" Radio Generator (`startMix`):
 *    - Start a nonstop radio mix from any single track, artist, album, mood chip,
 *      active search result set/query, or full-catalog Supermix.
 *    - Powered by `SpotTubeRecommender` multi-signal scoring + `SpotTubeStorage` taste telemetry.
 * 2. Live Queue Manager (`playNext`, `addToQueue`, `removeFromQueue`, `reorderQueue`, `moveUp`, `moveDown`, `promoteToPlayNext`, `clearQueue`):
 *    - Priority manual queue (`Play Next` inserts at index 0; `Add to Queue` appends to the manual priority block before auto-mix tracks).
 *    - Seamless drag/button reordering across the live queue.
 *    - Automatic nonstop queue replenishment (`replenishQueue`) when upcoming tracks run low.
 *    - Dynamic YT Music mix mode retuning (`setMixMode`) that re-ranks upcoming auto-mix tracks without interrupting playback or losing manual queue items.
 *
 * Works in both Browser (`window.SpotTubeQueue`) and Node.js CommonJS (`module.exports`).
 */
(function (root, factory) {
    if (typeof module === "object" && module.exports) {
        module.exports = factory(root);
    } else {
        root.SpotTubeQueue = factory(root);
    }
})(typeof globalThis !== "undefined" ? globalThis : typeof window !== "undefined" ? window : this, function (globalScope) {
    const VALID_SEED_TYPES = ["track", "artist", "album", "mood", "search", "supermix", "playlist"];
    const VALID_MIX_MODES = ["all", "familiar", "discover", "deep-cuts", "upbeat", "chill"];

    const MIX_MODE_PROFILES = {
        all: {
            id: "all",
            label: "All",
            shortLabel: "Balanced",
            badge: "HYBRID MIX",
            description: "Balanced blend of your favorites, sonic matches, and fresh picks",
        },
        familiar: {
            id: "familiar",
            label: "Familiar",
            shortLabel: "Familiar",
            badge: "FAMILIAR MIX",
            description: "Prioritizes your liked songs, high-completion favorites, and signature hits",
        },
        discover: {
            id: "discover",
            label: "Discover",
            shortLabel: "Discover",
            badge: "DISCOVER MIX",
            description: "Surfaces unplayed tracks, new artists, and sonic bridges outside your usual loop",
        },
        "deep-cuts": {
            id: "deep-cuts",
            label: "Deep Cuts",
            shortLabel: "Deep Cuts",
            badge: "DEEP CUTS",
            description: "Digs into lower-popularity hidden gems, B-sides, and niche subgenres",
        },
        upbeat: {
            id: "upbeat",
            label: "Upbeat",
            shortLabel: "Upbeat",
            badge: "UPBEAT VIBE",
            description: "Boosts high-energy, danceable, fast-tempo tracks to lift the momentum",
        },
        chill: {
            id: "chill",
            label: "Chill",
            shortLabel: "Chill",
            badge: "CHILL VIBE",
            description: "Leans into acoustic textures, smooth tempos, and laid-back late-night vibes",
        },
    };

    function normalizeString(str) {
        return String(str || "")
            .trim()
            .toLowerCase();
    }

    function normalizeMixMode(mode) {
        const clean = normalizeString(mode || "all");
        return VALID_MIX_MODES.includes(clean) ? clean : "all";
    }

    function getMixModeProfile(mixMode = "all") {
        const key = normalizeMixMode(mixMode);
        return MIX_MODE_PROFILES[key] || MIX_MODE_PROFILES.all;
    }

    function getDefaultStorage(overrideStorage) {
        if (overrideStorage !== undefined) return overrideStorage;
        if (globalScope && globalScope.SpotTubeStorage) return globalScope.SpotTubeStorage;
        return null;
    }

    function getDefaultRecommender(overrideRecommender) {
        if (overrideRecommender !== undefined) return overrideRecommender;
        if (globalScope && globalScope.SpotTubeRecommender) return globalScope.SpotTubeRecommender;
        return null;
    }

    function getTrackArtists(track) {
        if (!track) return [];
        const list = [];
        if (Array.isArray(track.artists)) {
            for (const a of track.artists) {
                if (a && String(a).trim()) list.push(String(a).trim());
            }
        }
        if (track.primaryArtist && !list.includes(track.primaryArtist)) {
            list.unshift(String(track.primaryArtist).trim());
        }
        if (Array.isArray(track.featuredArtists)) {
            for (const f of track.featuredArtists) {
                if (f && String(f).trim() && !list.includes(String(f).trim())) {
                    list.push(String(f).trim());
                }
            }
        }
        if (list.length === 0 && track.artistDisplay) {
            for (const part of String(track.artistDisplay).split(",")) {
                const clean = part.trim();
                if (clean) list.push(clean);
            }
        }
        return list;
    }

    /**
     * Resolves a track reference (track object, track ID, filename, or title) against a catalog.
     */
    function findTrackInCatalog(catalog = [], trackOrId) {
        if (!trackOrId) return null;
        if (typeof trackOrId === "object" && trackOrId.id) {
            return catalog.find((t) => t.id === trackOrId.id) || trackOrId;
        }
        if (typeof trackOrId === "number") {
            return catalog[trackOrId] || null;
        }
        const target = normalizeString(trackOrId);
        return (
            catalog.find(
                (t) =>
                    normalizeString(t.id) === target ||
                    normalizeString(t.filename) === target ||
                    normalizeString(t.title) === target
            ) || null
        );
    }

    /**
     * Normalizes any seed specification into a structured descriptor:
     * `{ type, badge, label, seedTracks, moodFilter, searchQuery, rawSeed }`
     */
    function normalizeMixSeed(catalog = [], seedSpec = null, options = {}) {
        const recommender = getDefaultRecommender(options.recommender);
        const storage = getDefaultStorage(options.storage);

        if (!Array.isArray(catalog) || catalog.length === 0) {
            return {
                type: "supermix",
                badge: "SUPERMIX",
                label: "Catalog Supermix",
                autoplayLabel: "Endless Auto",
                seedTracks: [],
                moodFilter: options.moodFilter || "All",
                searchQuery: "",
            };
        }

        // 1. Explicit null / undefined / "supermix" -> Catalog Supermix
        if (
            !seedSpec ||
            seedSpec === "supermix" ||
            (typeof seedSpec === "object" && normalizeString(seedSpec.type) === "supermix")
        ) {
            // Seed Supermix with liked tracks + recently completed favorites, or top popular tracks
            let supermixSeeds = [];
            if (storage && typeof storage.getLikedTrackIds === "function") {
                const likedIds = new Set(storage.getLikedTrackIds());
                supermixSeeds = catalog.filter((t) => likedIds.has(t.id));
            }
            if (supermixSeeds.length === 0 && options.currentTrack) {
                const curr = findTrackInCatalog(catalog, options.currentTrack);
                if (curr) supermixSeeds = [curr];
            }
            if (supermixSeeds.length === 0) {
                supermixSeeds = catalog
                    .slice()
                    .sort((a, b) => (b.popularity || 0.5) - (a.popularity || 0.5))
                    .slice(0, 3);
            }
            return {
                type: "supermix",
                badge: "SUPERMIX",
                label: (seedSpec && seedSpec.label) || "Your Nonstop Supermix",
                autoplayLabel: "Endless Auto",
                seedTracks: supermixSeeds,
                moodFilter: options.moodFilter || "All",
                searchQuery: "",
            };
        }

        // 2. Direct track object or track ID string
        if (typeof seedSpec === "string") {
            const directTrack = findTrackInCatalog(catalog, seedSpec);
            if (directTrack) {
                return {
                    type: "track",
                    badge: "TRACK RADIO",
                    label: `${directTrack.title} • ${directTrack.primaryArtist}`,
                    autoplayLabel: "Endless Auto",
                    seedTracks: [directTrack],
                    moodFilter: options.moodFilter || "All",
                    searchQuery: "",
                };
            }
        }

        if (typeof seedSpec === "object" && seedSpec.id && seedSpec.title && !seedSpec.type) {
            const track = findTrackInCatalog(catalog, seedSpec) || seedSpec;
            return {
                type: "track",
                badge: "TRACK RADIO",
                label: `${track.title} • ${track.primaryArtist}`,
                autoplayLabel: "Endless Auto",
                seedTracks: [track],
                moodFilter: options.moodFilter || "All",
                searchQuery: "",
            };
        }

        // 3. Structured object `{ type, track, trackId, artist, album, mood, query, tracks }`
        if (typeof seedSpec === "object") {
            const explicitType = normalizeString(seedSpec.type);

            // Track seed
            if (explicitType === "track" || seedSpec.track || seedSpec.trackId) {
                const track =
                    findTrackInCatalog(catalog, seedSpec.track || seedSpec.trackId || seedSpec) ||
                    catalog[0];
                return {
                    type: "track",
                    badge: seedSpec.badge || "TRACK RADIO",
                    label: seedSpec.label || `${track.title} • ${track.primaryArtist}`,
                    autoplayLabel: "Endless Auto",
                    seedTracks: track ? [track] : [],
                    moodFilter: options.moodFilter || "All",
                    searchQuery: "",
                };
            }

            // Artist seed
            if (explicitType === "artist" || seedSpec.artist) {
                const artistName = String(seedSpec.artist || seedSpec.name || "").trim();
                const normArtist = normalizeString(artistName);
                const artistTracks = catalog.filter((t) =>
                    getTrackArtists(t).some((a) => normalizeString(a) === normArtist)
                );
                const partialMatches =
                    artistTracks.length > 0
                        ? artistTracks
                        : catalog.filter((t) =>
                              getTrackArtists(t).some((a) => normalizeString(a).includes(normArtist))
                          );
                const resolved = partialMatches.length > 0 ? partialMatches : [catalog[0]];
                const displayArtist =
                    artistName || resolved[0]?.primaryArtist || "Artist";
                return {
                    type: "artist",
                    badge: seedSpec.badge || "ARTIST RADIO",
                    label: seedSpec.label || `${displayArtist} Radio`,
                    autoplayLabel: "Endless Auto",
                    seedTracks: resolved,
                    artist: displayArtist,
                    moodFilter: options.moodFilter || "All",
                    searchQuery: "",
                };
            }

            // Album seed
            if (explicitType === "album" || seedSpec.album) {
                const albumName = String(seedSpec.album || seedSpec.name || "").trim();
                const normAlbum = normalizeString(albumName);
                const albumTracks = catalog.filter(
                    (t) =>
                        normalizeString(t.album) === normAlbum ||
                        normalizeString(t.album).includes(normAlbum)
                );
                const resolved = albumTracks.length > 0 ? albumTracks : [catalog[0]];
                const displayAlbum = albumName || resolved[0]?.album || "Album";
                return {
                    type: "album",
                    badge: seedSpec.badge || "ALBUM RADIO",
                    label: seedSpec.label || `${displayAlbum} Radio`,
                    autoplayLabel: "Endless Auto",
                    seedTracks: resolved,
                    album: displayAlbum,
                    moodFilter: options.moodFilter || "All",
                    searchQuery: "",
                };
            }

            // Mood chip seed
            if (explicitType === "mood" || seedSpec.mood) {
                const moodName = String(seedSpec.mood || seedSpec.name || "All").trim();
                const normMood = normalizeString(moodName);
                const moodTracks =
                    normMood === "all"
                        ? catalog.slice()
                        : catalog.filter(
                              (t) =>
                                  (Array.isArray(t.moods) &&
                                      t.moods.some((m) => normalizeString(m) === normMood)) ||
                                  normalizeString(t.genre) === normMood
                          );
                const resolved = moodTracks.length > 0 ? moodTracks : catalog.slice(0, 3);
                return {
                    type: "mood",
                    badge: seedSpec.badge || "MOOD MIX",
                    label:
                        seedSpec.label ||
                        (normMood === "all" ? "All Vibes Supermix" : `${moodName} Vibe Radio`),
                    autoplayLabel: "Endless Auto",
                    seedTracks: resolved,
                    mood: moodName,
                    moodFilter: moodName,
                    searchQuery: "",
                };
            }

            // Active search result set / query seed
            if (
                explicitType === "search" ||
                seedSpec.query !== undefined ||
                Array.isArray(seedSpec.tracks)
            ) {
                const query = String(seedSpec.query || "").trim();
                let searchTracks = [];
                if (Array.isArray(seedSpec.tracks) && seedSpec.tracks.length > 0) {
                    searchTracks = seedSpec.tracks
                        .map((item) => findTrackInCatalog(catalog, item))
                        .filter(Boolean);
                }
                if (searchTracks.length === 0 && query) {
                    const q = normalizeString(query);
                    searchTracks = catalog.filter((t) =>
                        [
                            t.title,
                            t.artistDisplay,
                            t.album,
                            t.genre,
                            ...(t.moods || []),
                            ...(t.subgenres || []),
                        ]
                            .filter(Boolean)
                            .join(" ")
                            .toLowerCase()
                            .includes(q)
                    );
                }
                if (searchTracks.length === 0) {
                    searchTracks = catalog.slice(0, 3);
                }
                return {
                    type: "search",
                    badge: seedSpec.badge || "SEARCH MIX",
                    label:
                        seedSpec.label ||
                        (query ? `Search Mix: "${query}"` : "Search Results Radio"),
                    autoplayLabel: "Endless Auto",
                    seedTracks: searchTracks,
                    moodFilter: options.moodFilter || "All",
                    searchQuery: query,
                };
            }
        }

        // 4. Fallback via recommender.resolveSeedTracks
        const fallbackSeeds =
            recommender && typeof recommender.resolveSeedTracks === "function"
                ? recommender.resolveSeedTracks(catalog, seedSpec)
                : [catalog[0]];
        const resolved = fallbackSeeds.length > 0 ? fallbackSeeds : [catalog[0]];
        return {
            type: "track",
            badge: "RADIO MIX",
            label: `${resolved[0].title} • ${resolved[0].primaryArtist}`,
            autoplayLabel: "Endless Auto",
            seedTracks: resolved,
            moodFilter: options.moodFilter || "All",
            searchQuery: "",
        };
    }

    /**
     * Applies deterministic mode ordering for explicit YT Music tuning modes
     * (`upbeat`, `chill`, `deep-cuts`, `familiar`, `discover`) while preserving recommendation metadata.
     */
    function applyMixModeSorting(tracks = [], mixMode = "all", currentTrack = null, options = {}) {
        const mode = normalizeMixMode(mixMode);
        const list = tracks.slice();
        const activeStorage = getDefaultStorage(options.storage);

        if (mode === "upbeat") {
            return list.sort(
                (a, b) =>
                    (b.energy || 0) - (a.energy || 0) ||
                    (b.recommendation?.totalScore || 0) - (a.recommendation?.totalScore || 0)
            );
        }
        if (mode === "chill") {
            return list.sort(
                (a, b) =>
                    (b.acousticness || 0) - (a.acousticness || 0) ||
                    (b.recommendation?.totalScore || 0) - (a.recommendation?.totalScore || 0)
            );
        }
        if (mode === "deep-cuts") {
            return list.sort(
                (a, b) =>
                    (a.popularity || 0.5) - (b.popularity || 0.5) ||
                    (b.recommendation?.totalScore || 0) - (a.recommendation?.totalScore || 0)
            );
        }
        if (mode === "familiar") {
            if (!tracks[0]?.recommendation) {
                return list.sort((a, b) => (b.popularity || 0.5) - (a.popularity || 0.5));
            }
            const getFamiliarScore = (t) => {
                const stats =
                    activeStorage && typeof activeStorage.getTrackStats === "function"
                        ? activeStorage.getTrackStats(t.id)
                        : null;
                const likedBonus = stats?.liked ? 0.35 : 0;
                const playedBonus =
                    stats?.playCount > 0 ? Math.min(0.25, stats.playCount * 0.08) : 0;
                const sameArtistBonus =
                    currentTrack &&
                    normalizeString(t.primaryArtist) === normalizeString(currentTrack.primaryArtist)
                        ? 0.22
                        : 0;
                const popScore = Number(t.popularity ?? 0.5) * 0.45;
                const recScore = Number(t.recommendation?.totalScore ?? 0) * 0.55;
                return likedBonus + playedBonus + sameArtistBonus + popScore + recScore;
            };
            return list.sort(
                (a, b) =>
                    getFamiliarScore(b) - getFamiliarScore(a) ||
                    (b.popularity || 0.5) - (a.popularity || 0.5)
            );
        }
        if (mode === "discover") {
            if (!tracks[0]?.recommendation && currentTrack) {
                const currentGenre = currentTrack.genre;
                return list.sort(
                    (a, b) => Number(a.genre === currentGenre) - Number(b.genre === currentGenre)
                );
            }
            const getDiscoverScore = (t) => {
                const stats =
                    activeStorage && typeof activeStorage.getTrackStats === "function"
                        ? activeStorage.getTrackStats(t.id)
                        : null;
                const playCount = stats ? stats.playCount || 0 : 0;
                const unplayedBonus = playCount === 0 ? 0.32 : -0.22 * Math.min(3, playCount);
                const diffArtistBonus =
                    currentTrack &&
                    normalizeString(t.primaryArtist) !== normalizeString(currentTrack.primaryArtist)
                        ? 0.22
                        : -0.22;
                const diffGenreBonus =
                    currentTrack &&
                    normalizeString(t.genre) !== normalizeString(currentTrack.genre)
                        ? 0.14
                        : 0;
                const recScore = Number(t.recommendation?.totalScore ?? 0.5) * 0.55;
                return unplayedBonus + diffArtistBonus + diffGenreBonus + recScore;
            };
            return list.sort(
                (a, b) =>
                    getDiscoverScore(b) - getDiscoverScore(a) ||
                    (b.recommendation?.totalScore || 0) - (a.recommendation?.totalScore || 0)
            );
        }
        return list;
    }

    /**
     * Creates a stateful Queue & Radio Mix Manager instance.
     */
    function createQueueManager(initialOptions = {}) {
        let catalog = Array.isArray(initialOptions.catalog) ? initialOptions.catalog.slice() : [];
        let storage = getDefaultStorage(initialOptions.storage);
        let recommender = getDefaultRecommender(initialOptions.recommender);

        let currentTrack = null;
        let queue = []; // Array of `{ queueId, trackId, track, source: "manual"|"mix", manualType, addedAt, recommendation, userReordered }`
        let history = []; // Stack of previously played tracks
        let mixMode = normalizeString(initialOptions.mixMode || "all") || "all";
        let moodFilter = initialOptions.moodFilter || "All";
        let autoplay = initialOptions.autoplay !== undefined ? Boolean(initialOptions.autoplay) : true;
        let minQueueSize = Number.isFinite(initialOptions.minQueueSize)
            ? Math.max(1, initialOptions.minQueueSize)
            : 3;

        let activeMixSession = {
            id: "mix-init",
            type: "supermix",
            badge: "RADIO MIX",
            label: "Catalog Supermix",
            autoplayLabel: "Endless Auto",
            seedTracks: [],
            startedAt: Date.now(),
        };

        let nextEntryCounter = 1;
        const listeners = new Set();

        function emitChange(eventType = "update", detail = {}) {
            const snapshot = getState();
            for (const fn of listeners) {
                try {
                    fn(snapshot, { type: eventType, ...detail });
                } catch (err) {
                    // Ignore listener errors to keep queue operations resilient
                }
            }
        }

        function createQueueEntry(track, options = {}) {
            if (!track) return null;
            const source = options.source === "manual" ? "manual" : "mix";
            const manualType =
                source === "manual" ? options.manualType || "add-to-queue" : null;
            const queueId =
                options.queueId || `q-${nextEntryCounter++}-${track.id}`;
            const recommendation =
                options.recommendation ||
                track.recommendation ||
                (source === "manual"
                    ? {
                          totalScore: 1,
                          primaryReason:
                              manualType === "play-next"
                                  ? "Queued to Play Next"
                                  : "Added to Queue",
                          reasons: [
                              manualType === "play-next"
                                  ? "Queued to Play Next"
                                  : "Added to Queue",
                          ],
                          mixMode,
                      }
                    : null);

            const enrichedTrack = {
                ...track,
                recommendation: recommendation || track.recommendation || undefined,
                queueMeta: {
                    queueId,
                    source,
                    manualType,
                    userReordered: Boolean(options.userReordered),
                },
            };

            return {
                queueId,
                trackId: track.id,
                track: enrichedTrack,
                source,
                manualType,
                userReordered: Boolean(options.userReordered),
                addedAt: options.addedAt || Date.now(),
                recommendation,
            };
        }

        /**
         * Generates ranked auto-mix candidate tracks for the current mix session and currentTrack.
         */
        function generateMixTracks(options = {}) {
            if (!catalog.length) return [];

            const activeRecommender = getDefaultRecommender(options.recommender ?? recommender);
            const activeStorage = getDefaultStorage(options.storage ?? storage);
            const excludeIds = new Set((options.excludeTrackIds || []).map(String));
            if (currentTrack && options.excludeCurrent !== false) {
                excludeIds.add(String(currentTrack.id));
            }

            const seeds =
                Array.isArray(options.seedTracks) && options.seedTracks.length > 0
                    ? options.seedTracks
                    : activeMixSession.seedTracks && activeMixSession.seedTracks.length > 0
                      ? activeMixSession.seedTracks
                      : currentTrack
                        ? [currentTrack]
                        : [catalog[0]];

            let recommended = [];

            if (activeRecommender && typeof activeRecommender.recommendTracks === "function") {
                // Include other seed tracks (for multi-track artist/album/mood/search seeds)
                // while excluding whatever is in excludeIds (such as currentTrack and existing queue items).
                recommended = activeRecommender.recommendTracks(catalog, {
                    seedTracks: seeds,
                    mixMode,
                    moodFilter,
                    storage: activeStorage,
                    includeSeedTracks: true,
                    excludeTrackIds: Array.from(excludeIds),
                    queueContext: currentTrack ? [currentTrack] : [],
                    limit: options.limit,
                });

                // Enhance primaryReason when a track is part of an explicit multi-track seed set
                const seedIdSet = new Set(seeds.map((t) => String(t.id)));
                recommended = recommended.map((t) => {
                    if (
                        seedIdSet.has(String(t.id)) &&
                        activeMixSession.type !== "track" &&
                        activeMixSession.type !== "supermix"
                    ) {
                        const seedBadgeReason =
                            activeMixSession.type === "artist"
                                ? `Artist Mix • ${activeMixSession.artist || t.primaryArtist}`
                                : activeMixSession.type === "album"
                                  ? `From ${activeMixSession.album || t.album}`
                                  : activeMixSession.type === "mood"
                                    ? `${activeMixSession.mood || moodFilter} Mix Seed`
                                    : activeMixSession.type === "search"
                                      ? "Top Search Match"
                                      : t.recommendation?.primaryReason;
                        if (seedBadgeReason && t.recommendation) {
                            return {
                                ...t,
                                recommendation: {
                                    ...t.recommendation,
                                    primaryReason: seedBadgeReason,
                                    reasons: [
                                        seedBadgeReason,
                                        ...(t.recommendation.reasons || []),
                                    ],
                                },
                            };
                        }
                    }
                    return t;
                });
            } else {
                // Fallback circular catalog order when recommender.js is not loaded
                const startIdx = currentTrack
                    ? Math.max(
                          0,
                          catalog.findIndex((t) => t.id === currentTrack.id)
                      )
                    : 0;
                for (let offset = 1; offset <= catalog.length; offset++) {
                    const candidate = catalog[(startIdx + offset) % catalog.length];
                    if (candidate && !excludeIds.has(String(candidate.id))) {
                        recommended.push(candidate);
                    }
                }
            }

            const sorted = applyMixModeSorting(recommended, mixMode, currentTrack, {
                storage: activeStorage,
            });
            if (Number.isFinite(options.limit) && options.limit > 0) {
                return sorted.slice(0, options.limit);
            }
            return sorted;
        }

        /**
         * Selects the best lead track when starting a radio mix from a multi-track seed
         * (e.g. Artist, Album, Mood Chip, Search Results, or Supermix).
         */
        function selectLeadTrackForSeed(seedTracks = [], options = {}) {
            if (!seedTracks.length) return catalog[0] || null;
            if (options.startTrack) {
                const explicit = findTrackInCatalog(catalog, options.startTrack);
                if (explicit) return explicit;
            }
            if (seedTracks.length === 1) {
                return seedTracks[0];
            }

            const activeStorage = getDefaultStorage(storage);
            const scoredSeeds = seedTracks.map((track, idx) => {
                const affinity =
                    activeStorage && typeof activeStorage.computeTasteAffinity === "function"
                        ? activeStorage.computeTasteAffinity(track.id).normalizedScore
                        : 0.5;
                const popularity = Number(track.popularity ?? 0.75);
                // Slightly penalize the currently playing track if starting a fresh multi-track mix
                const sameAsCurrentPenalty =
                    currentTrack && currentTrack.id === track.id && !options.preferCurrent
                        ? 0.08
                        : 0;
                return {
                    track,
                    idx,
                    leadScore: affinity * 0.6 + popularity * 0.4 - sameAsCurrentPenalty,
                };
            });

            scoredSeeds.sort((a, b) => b.leadScore - a.leadScore || a.idx - b.idx);
            return scoredSeeds[0].track;
        }

        /**
         * Starts a nonstop radio mix from any single track, artist, album, mood chip,
         * active search result set, or Supermix.
         */
        function startMix(seedSpec = null, options = {}) {
            if (Array.isArray(options.catalog) && options.catalog.length > 0) {
                catalog = options.catalog.slice();
            }
            if (options.mixMode) {
                mixMode = normalizeString(options.mixMode) || "all";
            }
            if (options.moodFilter) {
                moodFilter = options.moodFilter;
            }
            if (!catalog.length) {
                return {
                    mixSession: activeMixSession,
                    currentTrack: null,
                    queue: [],
                };
            }

            const normalized = normalizeMixSeed(catalog, seedSpec, {
                recommender,
                storage,
                moodFilter,
                currentTrack,
            });

            if (normalized.type === "mood" && normalized.mood) {
                moodFilter = normalized.mood;
            }

            const leadTrack =
                options.keepCurrentTrack && currentTrack
                    ? currentTrack
                    : selectLeadTrackForSeed(normalized.seedTracks, options);

            if (currentTrack && leadTrack && currentTrack.id !== leadTrack.id) {
                history.push(currentTrack);
                if (history.length > 50) history.shift();
            }
            currentTrack = leadTrack;

            activeMixSession = {
                id: `mix-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
                type: normalized.type,
                badge: normalized.badge,
                label: normalized.label,
                autoplayLabel: normalized.autoplayLabel || "Endless Auto",
                seedTracks: normalized.seedTracks.length > 0 ? normalized.seedTracks : leadTrack ? [leadTrack] : [],
                artist: normalized.artist || null,
                album: normalized.album || null,
                mood: normalized.mood || null,
                searchQuery: normalized.searchQuery || "",
                startedAt: Date.now(),
            };

            const preservedManual =
                options.preserveManual === true
                    ? queue.filter(
                          (item) =>
                              item.source === "manual" &&
                              (!currentTrack || item.trackId !== currentTrack.id)
                      )
                    : [];

            const excludeIds = [
                ...(currentTrack ? [currentTrack.id] : []),
                ...preservedManual.map((item) => item.trackId),
            ];

            const generatedTracks = generateMixTracks({
                seedTracks: activeMixSession.seedTracks,
                excludeTrackIds: excludeIds,
            });

            const mixEntries = generatedTracks.map((t) =>
                createQueueEntry(t, { source: "mix" })
            );

            queue = [...preservedManual, ...mixEntries];
            emitChange("start-mix", {
                mixSession: activeMixSession,
                currentTrack,
            });

            return {
                mixSession: activeMixSession,
                currentTrack,
                queue: getQueue(),
            };
        }

        /**
         * Inserts a track at the very top of the upcoming queue (`index 0`, "Play Next").
         */
        function playNext(trackOrId, options = {}) {
            const track = findTrackInCatalog(catalog, trackOrId) || (typeof trackOrId === "object" ? trackOrId : null);
            if (!track || !track.id) return null;

            // Remove any existing auto-mix duplicate or older manual entry for the same track
            // unless allowDuplicate is explicitly requested
            if (!options.allowDuplicate) {
                queue = queue.filter((item) => {
                    if (item.trackId !== track.id) return true;
                    if (item.source === "mix") return false;
                    return options.dedupeManual === false;
                });
            }

            const entry = createQueueEntry(track, {
                source: "manual",
                manualType: "play-next",
            });
            queue.unshift(entry);

            emitChange("play-next", { entry, track });
            return entry;
        }

        /**
         * Appends a track to the user's manual priority queue block (after any existing manual
         * items and before auto-generated radio mix items, or at the very end if `position: "end"`).
         */
        function addToQueue(trackOrId, options = {}) {
            const track = findTrackInCatalog(catalog, trackOrId) || (typeof trackOrId === "object" ? trackOrId : null);
            if (!track || !track.id) return null;

            // Remove any auto-mix duplicate of this track so it gets cleanly promoted into the manual queue
            if (!options.allowDuplicate) {
                queue = queue.filter(
                    (item) => !(item.trackId === track.id && item.source === "mix")
                );
            }

            const entry = createQueueEntry(track, {
                source: "manual",
                manualType: "add-to-queue",
            });

            if (options.position === "end") {
                queue.push(entry);
            } else {
                // Insert right after the last manual item at the front of the queue
                let insertIdx = 0;
                while (insertIdx < queue.length && queue[insertIdx].source === "manual") {
                    insertIdx++;
                }
                queue.splice(insertIdx, 0, entry);
            }

            emitChange("add-to-queue", { entry, track });
            return entry;
        }

        /**
         * Resolves a queue target (`queueId`, numeric index, or `trackId`) to an index in `queue`.
         */
        function resolveQueueIndex(target) {
            if (typeof target === "number" && Number.isInteger(target)) {
                return target >= 0 && target < queue.length ? target : -1;
            }
            if (typeof target === "string") {
                const byQueueId = queue.findIndex((item) => item.queueId === target);
                if (byQueueId !== -1) return byQueueId;
                return queue.findIndex((item) => item.trackId === target);
            }
            if (target && typeof target === "object") {
                if (target.queueId) {
                    return queue.findIndex((item) => item.queueId === target.queueId);
                }
                if (target.id || target.trackId) {
                    const id = target.id || target.trackId;
                    return queue.findIndex((item) => item.trackId === id);
                }
            }
            return -1;
        }

        /**
         * Removes an item from the upcoming queue by `queueId`, index, or `trackId`.
         */
        function removeFromQueue(target, options = {}) {
            const idx = resolveQueueIndex(target);
            if (idx === -1) return null;

            const [removed] = queue.splice(idx, 1);

            if (
                options.autoReplenish !== false &&
                autoplay &&
                queue.length < minQueueSize &&
                catalog.length > 1
            ) {
                replenishQueue({ silent: true, excludeTrackIds: [removed.trackId] });
            }

            emitChange("remove-from-queue", { removed, index: idx });
            return removed;
        }

        /**
         * Reorders an item in the upcoming queue from `fromIndex` to `toIndex`.
         */
        function reorderQueue(fromTarget, toIndex) {
            if (queue.length <= 1) return getQueue();

            const fromIdx =
                typeof fromTarget === "number"
                    ? fromTarget
                    : resolveQueueIndex(fromTarget);
            if (fromIdx < 0 || fromIdx >= queue.length) return getQueue();

            const clampedTo = Math.max(0, Math.min(queue.length - 1, Number(toIndex)));
            if (fromIdx === clampedTo) return getQueue();

            const [moved] = queue.splice(fromIdx, 1);
            moved.userReordered = true;
            if (moved.track && moved.track.queueMeta) {
                moved.track.queueMeta.userReordered = true;
            }
            queue.splice(clampedTo, 0, moved);

            emitChange("reorder-queue", {
                entry: moved,
                fromIndex: fromIdx,
                toIndex: clampedTo,
            });
            return getQueue();
        }

        function moveUp(target) {
            const idx = resolveQueueIndex(target);
            if (idx <= 0) return getQueue();
            return reorderQueue(idx, idx - 1);
        }

        function moveDown(target) {
            const idx = resolveQueueIndex(target);
            if (idx === -1 || idx >= queue.length - 1) return getQueue();
            return reorderQueue(idx, idx + 1);
        }

        /**
         * Promotes an existing item in the queue to index 0 ("Play Next").
         */
        function promoteToPlayNext(target) {
            const idx = resolveQueueIndex(target);
            if (idx === -1) return null;
            const [item] = queue.splice(idx, 1);
            item.source = "manual";
            item.manualType = "play-next";
            item.userReordered = true;
            item.recommendation = {
                ...(item.recommendation || {}),
                primaryReason: "Queued to Play Next",
            };
            item.track = {
                ...item.track,
                recommendation: item.recommendation,
                queueMeta: {
                    queueId: item.queueId,
                    source: "manual",
                    manualType: "play-next",
                    userReordered: true,
                },
            };
            queue.unshift(item);
            emitChange("promote-play-next", { entry: item, fromIndex: idx });
            return item;
        }

        /**
         * Clears the upcoming queue. If `onlyManual: true`, removes only manually added items.
         */
        function clearQueue(options = {}) {
            if (options.onlyManual) {
                queue = queue.filter((item) => item.source !== "manual");
            } else {
                queue = [];
            }
            emitChange("clear-queue", {});
            return getQueue();
        }

        /**
         * Replenishes the upcoming queue when fewer than `minQueueSize` tracks remain
         * (or up to `targetSize`), enabling endless nonstop radio playback.
         */
        function replenishQueue(options = {}) {
            if (!catalog.length) return getQueue();

            const targetSize = Number.isFinite(options.targetSize)
                ? options.targetSize
                : Math.max(minQueueSize, Math.min(catalog.length - 1, 11));

            if (queue.length >= targetSize && !options.force) {
                return getQueue();
            }

            const existingQueueTrackIds = new Set(queue.map((item) => String(item.trackId)));
            if (currentTrack) {
                existingQueueTrackIds.add(String(currentTrack.id));
            }
            if (Array.isArray(options.excludeTrackIds)) {
                for (const id of options.excludeTrackIds) {
                    existingQueueTrackIds.add(String(id));
                }
            }

            let freshTracks = generateMixTracks({
                excludeTrackIds: Array.from(existingQueueTrackIds),
            });

            // If catalog was exhausted (all tracks already in queue), allow cycling through
            // catalog tracks excluding only currentTrack and the last queued track so radio is truly endless!
            if (freshTracks.length === 0 && catalog.length > 1) {
                const tailTrackId = queue.length > 0 ? queue[queue.length - 1].trackId : null;
                const minimalExclude = [
                    ...(currentTrack ? [currentTrack.id] : []),
                    ...(tailTrackId ? [tailTrackId] : []),
                ];
                freshTracks = generateMixTracks({
                    excludeTrackIds: minimalExclude,
                });
            }

            const needed = Math.max(0, targetSize - queue.length);
            const toAppend = freshTracks.slice(0, needed > 0 ? needed : freshTracks.length);

            for (const track of toAppend) {
                queue.push(createQueueEntry(track, { source: "mix" }));
            }

            if (!options.silent) {
                emitChange("replenish-queue", { addedCount: toAppend.length });
            }
            return getQueue();
        }

        /**
         * Computes live queue vibe & tuning metrics for the active mix mode and upcoming queue.
         */
        function getQueueVibeMetrics() {
            const activeRecommender = getDefaultRecommender(recommender);
            const activeStorage = getDefaultStorage(storage);
            const upcoming = getUpcomingTracks();
            if (activeRecommender && typeof activeRecommender.computeQueueVibeMetrics === "function") {
                return activeRecommender.computeQueueVibeMetrics(upcoming, {
                    mixMode,
                    storage: activeStorage,
                });
            }
            const profile = getMixModeProfile(mixMode);
            if (!upcoming.length) {
                return {
                    mixMode: profile.id,
                    profile,
                    trackCount: 0,
                    avgBpm: 0,
                    avgEnergyPct: 0,
                    avgAcousticPct: 0,
                    avgPopularityPct: 0,
                    discoveryRatioPct: 0,
                    familiarCount: 0,
                    deepCutsCount: 0,
                    summaryText: `${profile.shortLabel} • ${profile.description}`,
                };
            }
            const n = upcoming.length;
            const avgBpm = Math.round(upcoming.reduce((s, t) => s + Number(t.bpm || 110), 0) / n);
            const avgEnergyPct = Math.round(
                (upcoming.reduce((s, t) => s + Number(t.energy ?? 0.65), 0) / n) * 100
            );
            const avgAcousticPct = Math.round(
                (upcoming.reduce((s, t) => s + Number(t.acousticness ?? 0.25), 0) / n) * 100
            );
            const avgPopularityPct = Math.round(
                (upcoming.reduce((s, t) => s + Number(t.popularity ?? 0.75), 0) / n) * 100
            );
            return {
                mixMode: profile.id,
                profile,
                trackCount: n,
                avgBpm,
                avgEnergyPct,
                avgAcousticPct,
                avgPopularityPct,
                discoveryRatioPct: 100,
                familiarCount: n,
                deepCutsCount: upcoming.filter((t) => Number(t.popularity ?? 1) <= 0.78).length,
                summaryText: `${profile.shortLabel} • ${avgEnergyPct}% Energy • ${avgBpm} BPM`,
            };
        }

        /**
         * Dynamically switches the YT Music Mix Mode (`all`, `familiar`, `discover`, `deep-cuts`, `upbeat`, `chill`),
         * re-ranking and regenerating upcoming auto-mix tracks while preserving manual queue items and current playback.
         */
        function setMixMode(newMixMode, options = {}) {
            const previousMixMode = mixMode;
            mixMode = normalizeMixMode(newMixMode);
            const profile = getMixModeProfile(mixMode);

            const preservedEntries = queue.filter(
                (item) =>
                    item.source === "manual" ||
                    (options.preserveUserReordered === true && item.userReordered === true)
            );
            const excludeIds = [
                ...(currentTrack ? [currentTrack.id] : []),
                ...preservedEntries.map((item) => item.trackId),
            ];

            const retunedMixTracks = generateMixTracks({
                excludeTrackIds: excludeIds,
                seedTracks: options.seedTracks,
            });

            const retunedEntries = retunedMixTracks.map((t) =>
                createQueueEntry(t, { source: "mix" })
            );

            queue = [...preservedEntries, ...retunedEntries];

            activeMixSession = {
                ...activeMixSession,
                mixMode,
                tuningProfile: profile,
                autoplayLabel:
                    mixMode === "all" ? "Endless Auto" : `${profile.shortLabel} Auto`,
            };

            const vibeMetrics = getQueueVibeMetrics();

            if (!options.silent) {
                emitChange("set-mix-mode", {
                    mixMode,
                    previousMixMode,
                    profile,
                    vibeMetrics,
                    preservedManualCount: preservedEntries.length,
                    retunedMixCount: retunedEntries.length,
                });
            }
            return getQueue();
        }

        /**
         * Jumps directly to a specific item in the upcoming queue and makes it `currentTrack`.
         */
        function jumpToQueueItem(target) {
            const idx = resolveQueueIndex(target);
            if (idx === -1) return null;

            const [chosen] = queue.splice(idx, 1);
            if (currentTrack && currentTrack.id !== chosen.track.id) {
                history.push(currentTrack);
                if (history.length > 50) history.shift();
            }
            currentTrack = chosen.track;

            if (autoplay && queue.length < minQueueSize) {
                replenishQueue({ silent: true });
            }

            emitChange("jump-to-item", { currentTrack, index: idx });
            return currentTrack;
        }

        /**
         * Advances playback to the next track in the queue, respecting manual "Play Next" priority,
         * shuffle/repeat modes, and automatic queue replenishment.
         */
        function advanceNext(options = {}) {
            if (!catalog.length) return null;

            if (options.repeat === true || options.repeat === "one") {
                return currentTrack || catalog[0];
            }

            if (queue.length === 0) {
                replenishQueue({ silent: true, force: true });
            }

            if (queue.length === 0) {
                return currentTrack || catalog[0];
            }

            let nextEntry = null;
            // Always honor manual "Play Next" / "Add to Queue" items at the front of the queue first
            if (queue[0].source === "manual" || !options.shuffle) {
                nextEntry = queue.shift();
            } else {
                const randIdx = Math.floor(Math.random() * queue.length);
                [nextEntry] = queue.splice(randIdx, 1);
            }

            if (currentTrack && nextEntry && currentTrack.id !== nextEntry.track.id) {
                history.push(currentTrack);
                if (history.length > 50) history.shift();
            }

            currentTrack = nextEntry ? nextEntry.track : catalog[0];

            if (autoplay && queue.length < minQueueSize) {
                replenishQueue({ silent: true });
            }

            emitChange("advance-next", { currentTrack });
            return currentTrack;
        }

        /**
         * Steps backward to the previously played track in history (putting the interrupted
         * current track back at the front of the upcoming queue).
         */
        function previous() {
            if (!catalog.length) return null;

            if (history.length > 0) {
                const prevTrack = history.pop();
                if (currentTrack && currentTrack.id !== prevTrack.id) {
                    // Put the current track back at the top of the queue so Next returns to it
                    queue = queue.filter((item) => item.trackId !== currentTrack.id);
                    queue.unshift(
                        createQueueEntry(currentTrack, {
                            source: "mix",
                        })
                    );
                }
                currentTrack = prevTrack;
                emitChange("previous", { currentTrack });
                return currentTrack;
            }

            // Fallback if no history stack yet: step backward in catalog
            const currIdx = currentTrack
                ? catalog.findIndex((t) => t.id === currentTrack.id)
                : 0;
            const prevIdx = (currIdx - 1 + catalog.length) % catalog.length;
            currentTrack = catalog[prevIdx];
            setCurrentTrack(currentTrack, { preserveManual: true, silent: true });
            emitChange("previous", { currentTrack });
            return currentTrack;
        }

        /**
         * Synchronizes the queue manager when a user directly clicks a track card to play it,
         * or when shell state is updated.
         */
        function setCurrentTrack(trackOrId, options = {}) {
            if (Array.isArray(options.catalog) && options.catalog.length > 0) {
                catalog = options.catalog.slice();
            }
            const resolved = findTrackInCatalog(catalog, trackOrId);
            if (!resolved) return null;

            // Check if the track was already at the front or inside the upcoming queue
            const existingIdx = queue.findIndex((item) => item.trackId === resolved.id);

            if (
                currentTrack &&
                currentTrack.id !== resolved.id &&
                options.recordHistory !== false
            ) {
                history.push(currentTrack);
                if (history.length > 50) history.shift();
            }

            currentTrack = resolved;

            if (existingIdx !== -1 && options.regenerateMix !== true) {
                // Remove the clicked track from upcoming queue while preserving the rest of the queue
                queue.splice(existingIdx, 1);
                if (autoplay && queue.length < minQueueSize) {
                    replenishQueue({ silent: true });
                }
            } else {
                // Rebuild auto-mix tail around the newly selected track while preserving manual queue items
                const manualEntries =
                    options.preserveManual !== false
                        ? queue.filter(
                              (item) =>
                                  item.source === "manual" && item.trackId !== currentTrack.id
                          )
                        : [];

                if (
                    options.updateSeed !== false &&
                    (activeMixSession.type === "track" ||
                        activeMixSession.seedTracks.length === 0)
                ) {
                    activeMixSession = {
                        ...activeMixSession,
                        type: "track",
                        badge: "RADIO MIX",
                        label: `${currentTrack.title} • ${currentTrack.primaryArtist}`,
                        seedTracks: [currentTrack],
                    };
                }

                const excludeIds = [
                    currentTrack.id,
                    ...manualEntries.map((item) => item.trackId),
                ];
                const mixTracks = generateMixTracks({
                    seedTracks:
                        options.updateSeed !== false
                            ? [currentTrack]
                            : activeMixSession.seedTracks,
                    excludeTrackIds: excludeIds,
                });

                queue = [
                    ...manualEntries,
                    ...mixTracks.map((t) => createQueueEntry(t, { source: "mix" })),
                ];
            }

            if (!options.silent) {
                emitChange("set-current-track", { currentTrack });
            }
            return currentTrack;
        }

        function setCatalog(newCatalog = [], options = {}) {
            catalog = Array.isArray(newCatalog) ? newCatalog.slice() : [];
            if (!currentTrack && catalog.length > 0) {
                currentTrack = catalog[0];
            }
            if (options.rebuildQueue !== false && catalog.length > 0) {
                setCurrentTrack(currentTrack || catalog[0], {
                    regenerateMix: true,
                    preserveManual: true,
                    silent: Boolean(options.silent),
                });
            }
            return catalog;
        }

        function setMoodFilter(newMood, options = {}) {
            moodFilter = newMood || "All";
            if (options.retune === true) {
                setMixMode(mixMode, { silent: Boolean(options.silent) });
            }
            return moodFilter;
        }

        function getQueue() {
            return queue.slice();
        }

        function getUpcomingTracks() {
            return queue.map((entry) => ({
                ...entry.track,
                recommendation: entry.recommendation || entry.track.recommendation,
                queueMeta: {
                    queueId: entry.queueId,
                    source: entry.source,
                    manualType: entry.manualType,
                    userReordered: entry.userReordered,
                    addedAt: entry.addedAt,
                },
            }));
        }

        function getCurrentTrack() {
            return currentTrack;
        }

        function getHistory() {
            return history.slice();
        }

        function getMixMode() {
            return mixMode;
        }

        function getMixSession() {
            return {
                ...activeMixSession,
                mixMode,
                tuningProfile: getMixModeProfile(mixMode),
            };
        }

        function getState() {
            return {
                catalog,
                currentTrack,
                queue: getQueue(),
                upcomingTracks: getUpcomingTracks(),
                history: getHistory(),
                mixMode,
                mixModeProfile: getMixModeProfile(mixMode),
                vibeMetrics: getQueueVibeMetrics(),
                moodFilter,
                autoplay,
                minQueueSize,
                mixSession: getMixSession(),
            };
        }

        function onChange(listener) {
            if (typeof listener === "function") {
                listeners.add(listener);
            }
            return () => listeners.delete(listener);
        }

        // Initialize if catalog was provided at creation
        if (catalog.length > 0) {
            const initialTrack =
                findTrackInCatalog(catalog, initialOptions.currentTrack) || catalog[0];
            setCurrentTrack(initialTrack, {
                regenerateMix: true,
                recordHistory: false,
                silent: true,
            });
        }

        return {
            startMix,
            playNext,
            addToQueue,
            removeFromQueue,
            reorderQueue,
            moveQueueItem: reorderQueue,
            moveUp,
            moveDown,
            promoteToPlayNext,
            clearQueue,
            replenishQueue,
            setMixMode,
            retuneQueue: setMixMode,
            getMixMode,
            getMixModeProfile: (targetMode) => getMixModeProfile(targetMode || mixMode),
            getQueueVibeMetrics,
            setMoodFilter,
            jumpToQueueItem,
            advanceNext,
            next: advanceNext,
            previous,
            setCurrentTrack,
            setCatalog,
            getQueue,
            getUpcomingTracks,
            getCurrentTrack,
            getHistory,
            getMixSession,
            getState,
            onChange,
        };
    }

    const defaultManager = createQueueManager();

    return {
        VALID_SEED_TYPES,
        VALID_MIX_MODES,
        MIX_MODE_PROFILES,
        normalizeMixMode,
        getMixModeProfile,
        normalizeMixSeed,
        findTrackInCatalog,
        applyMixModeSorting,
        createQueueManager,
        ...defaultManager,
    };
});
