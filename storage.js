/**
 * SpotTube Hybrid Player — Persistent User Taste, Telemetry, Playlists,
 * IndexedDB Audio Blob Store & Real-Time Web Audio API Feature Analyzer (`storage.js`)
 *
 * Works in both Browser (`window.SpotTubeStorage`) and Node.js CommonJS (`module.exports`)
 * for unit and integration testing.
 */
(function (root, factory) {
    if (typeof module === "object" && module.exports) {
        module.exports = factory(root);
    } else {
        root.SpotTubeStorage = factory(root);
    }
})(typeof globalThis !== "undefined" ? globalThis : typeof window !== "undefined" ? window : this, function (globalScope) {
    const STORAGE_KEY = "spottube_hybrid_store_v1";
    const IDB_NAME = "SpotTubeHybridDB";
    const IDB_VERSION = 1;
    const MAX_RECENT_HISTORY = 100;
    const MAX_TRACK_PLAY_TIMESTAMPS = 25;

    function clamp(value, min, max) {
        if (!Number.isFinite(value)) return min;
        return Math.max(min, Math.min(max, value));
    }

    function roundTo(value, decimals = 4) {
        const factor = Math.pow(10, decimals);
        return Math.round((Number(value) || 0) * factor) / factor;
    }

    function createDefaultTrackStats(trackId) {
        return {
            trackId: String(trackId),
            playCount: 0,
            fullCompletions: 0,
            totalListenSeconds: 0,
            avgCompletionRatio: 0,
            lastCompletionRatio: 0,
            earlySkipCount: 0,
            lateSkipCount: 0,
            skipPenalty: 0,
            liked: false,
            disliked: false,
            firstPlayedAt: null,
            lastPlayedAt: null,
            playHistory: [],
        };
    }

    function createDefaultState() {
        return {
            version: 1,
            updatedAt: Date.now(),
            likedTrackIds: [],
            dislikedTrackIds: [],
            trackStats: {},
            recentlyPlayed: [],
            playlists: [],
            analyzerCache: {},
            preferences: {
                volume: 1,
                muted: false,
                crossfadeSeconds: 0,
                activeMixMode: "all",
                isDrawerOpen: true,
            },
        };
    }

    /**
     * Pure spectral & time-domain feature extractor from Web Audio API AnalyserNode bins.
     * Can be invoked directly in unit tests with synthetic Uint8Arrays or live from AnalyserNode.
     *
     * @param {Uint8Array|number[]} frequencyBins - Bytes [0..255] from analyser.getByteFrequencyData()
     * @param {Uint8Array|number[]} timeDomainBins - Bytes [0..255] from analyser.getByteTimeDomainData()
     * @param {number} [sampleRate=44100] - AudioContext sampleRate in Hz
     */
    function computeSpectralFeaturesFromBins(frequencyBins, timeDomainBins, sampleRate = 44100) {
        const freqLen = frequencyBins ? frequencyBins.length : 0;
        const timeLen = timeDomainBins ? timeDomainBins.length : 0;
        const nyquist = Math.max(1, sampleRate / 2);
        const hzPerBin = freqLen > 0 ? nyquist / freqLen : 1;

        // 1. Time-domain RMS energy & zero-crossing rate
        let sumSquares = 0;
        let zeroCrossings = 0;
        let prevCentered = 0;

        if (timeLen > 0) {
            for (let i = 0; i < timeLen; i++) {
                const centered = ((Number(timeDomainBins[i]) || 128) - 128) / 128;
                sumSquares += centered * centered;
                if (i > 0 && ((centered >= 0 && prevCentered < 0) || (centered < 0 && prevCentered >= 0))) {
                    zeroCrossings++;
                }
                prevCentered = centered;
            }
        }

        let rmsEnergy = timeLen > 0 ? Math.sqrt(sumSquares / timeLen) : 0;
        const zeroCrossingRate = timeLen > 1 ? zeroCrossings / (timeLen - 1) : 0;

        // 2. Frequency-domain band energies (Bass: 20-250Hz, Mid: 250-4000Hz, Treble: 4000-16000Hz)
        // and Spectral Centroid (weighted average frequency)
        let bassSum = 0;
        let bassCount = 0;
        let midSum = 0;
        let midCount = 0;
        let trebleSum = 0;
        let trebleCount = 0;
        let weightedFreqSum = 0;
        let totalMagnitudeSum = 0;

        for (let i = 0; i < freqLen; i++) {
            const mag = clamp((Number(frequencyBins[i]) || 0) / 255, 0, 1);
            const freqHz = (i + 0.5) * hzPerBin;

            weightedFreqSum += freqHz * mag;
            totalMagnitudeSum += mag;

            if (freqHz >= 20 && freqHz <= 250) {
                bassSum += mag;
                bassCount++;
            } else if (freqHz > 250 && freqHz <= 4000) {
                midSum += mag;
                midCount++;
            } else if (freqHz > 4000 && freqHz <= 16000) {
                trebleSum += mag;
                trebleCount++;
            }
        }

        const bassEnergy = bassCount > 0 ? bassSum / bassCount : 0;
        const midEnergy = midCount > 0 ? midSum / midCount : 0;
        const trebleEnergy = trebleCount > 0 ? trebleSum / trebleCount : 0;
        const meanFreqEnergy = freqLen > 0 ? totalMagnitudeSum / freqLen : 0;

        // If time-domain waveform was silent/omitted, derive RMS estimate from frequency magnitudes
        if (rmsEnergy === 0 && meanFreqEnergy > 0) {
            rmsEnergy = clamp(meanFreqEnergy * 1.15, 0, 1);
        } else {
            // Boost slightly so typical mastered audio maps cleanly into [0, 1]
            rmsEnergy = clamp(rmsEnergy * 1.45, 0, 1);
        }

        const spectralCentroidHz =
            totalMagnitudeSum > 0.0001 ? weightedFreqSum / totalMagnitudeSum : 0;
        // Normalize centroid against 8000 Hz perceptual ceiling for musical brightness
        const spectralCentroidNormalized = clamp(spectralCentroidHz / 8000, 0, 1);

        return {
            rmsEnergy: roundTo(clamp(rmsEnergy, 0, 1)),
            bassEnergy: roundTo(clamp(bassEnergy, 0, 1)),
            midEnergy: roundTo(clamp(midEnergy, 0, 1)),
            trebleEnergy: roundTo(clamp(trebleEnergy, 0, 1)),
            spectralCentroidHz: Math.round(spectralCentroidHz),
            spectralCentroidNormalized: roundTo(spectralCentroidNormalized),
            zeroCrossingRate: roundTo(clamp(zeroCrossingRate, 0, 1)),
        };
    }

    /**
     * Factory to create an isolated or singleton SpotTubeStorage instance.
     */
    function createStorageStore(options = {}) {
        const storageKey = options.storageKey || STORAGE_KEY;
        const idbName = options.idbName || IDB_NAME;
        const memoryFallbackStorage = new Map();

        // Backing synchronous KV storage adapter (localStorage in browser, or memory fallback in Node)
        function resolveBrowserLocalStorage() {
            if (options.localStorage) return options.localStorage;
            if (!globalScope || typeof globalScope.document === "undefined") return null;
            try {
                return globalScope.localStorage || null;
            } catch (_) {
                return null;
            }
        }

        const kvAdapter = resolveBrowserLocalStorage() || {
            getItem(k) {
                return memoryFallbackStorage.has(k) ? memoryFallbackStorage.get(k) : null;
            },
            setItem(k, v) {
                memoryFallbackStorage.set(k, String(v));
            },
            removeItem(k) {
                memoryFallbackStorage.delete(k);
            },
        };

        // In-memory mirror for IndexedDB stores (always kept in sync & used when browser IDB is unavailable)
        const memoryIdb = {
            audioBlobs: new Map(),
            importedTracks: new Map(),
            analyzerCache: new Map(),
        };

        const objectUrlCache = new Map();
        const listeners = new Set();
        let activeSession = null;
        let state = loadState();
        let idbPromise = null;

        function emitChange(eventType, detail = {}) {
            for (const listener of listeners) {
                try {
                    listener({ type: eventType, detail, state });
                } catch (err) {
                    console.warn("SpotTubeStorage listener error:", err);
                }
            }
        }

        function subscribe(listener) {
            if (typeof listener !== "function") return () => {};
            listeners.add(listener);
            return () => listeners.delete(listener);
        }

        function normalizeLoadedState(raw) {
            const base = createDefaultState();
            if (!raw || typeof raw !== "object") return base;

            base.version = raw.version || 1;
            base.updatedAt = raw.updatedAt || Date.now();
            base.likedTrackIds = Array.isArray(raw.likedTrackIds)
                ? Array.from(new Set(raw.likedTrackIds.map(String)))
                : [];
            base.dislikedTrackIds = Array.isArray(raw.dislikedTrackIds)
                ? Array.from(new Set(raw.dislikedTrackIds.map(String)))
                : [];
            base.trackStats = raw.trackStats && typeof raw.trackStats === "object" ? { ...raw.trackStats } : {};
            base.recentlyPlayed = Array.isArray(raw.recentlyPlayed)
                ? raw.recentlyPlayed.slice(0, MAX_RECENT_HISTORY)
                : [];
            base.playlists = Array.isArray(raw.playlists) ? raw.playlists.slice() : [];
            base.analyzerCache =
                raw.analyzerCache && typeof raw.analyzerCache === "object" ? { ...raw.analyzerCache } : {};
            base.preferences = {
                ...base.preferences,
                ...(raw.preferences && typeof raw.preferences === "object" ? raw.preferences : {}),
            };

            // Ensure liked/disliked flags inside trackStats match top-level sets
            for (const id of base.likedTrackIds) {
                if (!base.trackStats[id]) base.trackStats[id] = createDefaultTrackStats(id);
                base.trackStats[id].liked = true;
                base.trackStats[id].disliked = false;
            }
            for (const id of base.dislikedTrackIds) {
                if (!base.trackStats[id]) base.trackStats[id] = createDefaultTrackStats(id);
                base.trackStats[id].disliked = true;
                base.trackStats[id].liked = false;
            }

            return base;
        }

        function loadState() {
            try {
                const rawJson = kvAdapter.getItem(storageKey);
                if (!rawJson) return createDefaultState();
                return normalizeLoadedState(JSON.parse(rawJson));
            } catch (err) {
                console.warn("SpotTubeStorage failed to parse persisted state, resetting:", err);
                return createDefaultState();
            }
        }

        function saveState(eventType = "state:updated", detail = {}) {
            state.updatedAt = Date.now();
            try {
                kvAdapter.setItem(storageKey, JSON.stringify(state));
            } catch (err) {
                memoryFallbackStorage.set(storageKey, JSON.stringify(state));
            }
            emitChange(eventType, detail);
            return state;
        }

        function resetState() {
            state = createDefaultState();
            activeSession = null;
            memoryIdb.audioBlobs.clear();
            memoryIdb.importedTracks.clear();
            memoryIdb.analyzerCache.clear();
            try {
                kvAdapter.removeItem(storageKey);
            } catch (_) {}
            saveState("state:reset");
            return state;
        }

        function ensureTrackStats(trackId) {
            const id = String(trackId);
            if (!state.trackStats[id]) {
                state.trackStats[id] = createDefaultTrackStats(id);
            } else {
                state.trackStats[id] = {
                    ...createDefaultTrackStats(id),
                    ...state.trackStats[id],
                    trackId: id,
                };
            }
            state.trackStats[id].liked = state.likedTrackIds.includes(id);
            state.trackStats[id].disliked = state.dislikedTrackIds.includes(id);
            return state.trackStats[id];
        }

        function getTrackStats(trackId) {
            if (!trackId) return createDefaultTrackStats("");
            const stats = ensureTrackStats(trackId);
            return {
                ...stats,
                playHistory: Array.isArray(stats.playHistory) ? stats.playHistory.slice() : [],
            };
        }

        function getAllTrackStats() {
            const copy = {};
            for (const id of Object.keys(state.trackStats)) {
                copy[id] = getTrackStats(id);
            }
            return copy;
        }

        /**
         * Records when a user starts playing a track.
         */
        function recordPlayStart(trackId, timestamp = Date.now()) {
            if (!trackId) return null;
            const id = String(trackId);
            const stats = ensureTrackStats(id);
            if (!stats.firstPlayedAt) {
                stats.firstPlayedAt = timestamp;
            }
            stats.lastPlayedAt = timestamp;
            activeSession = {
                trackId: id,
                startedAt: timestamp,
            };
            saveState("telemetry:play-start", { trackId: id, timestamp });
            return getTrackStats(id);
        }

        /**
         * Records the outcome of a playback session (natural completion, early skip, or late skip).
         *
         * @param {string} trackId
         * @param {object} params
         * @param {number} params.listenedSeconds - Seconds played before track change/end
         * @param {number} params.durationSeconds - Total track duration in seconds
         * @param {boolean} [params.endedNaturally=false] - Whether the track reached the end naturally
         * @param {number} [params.timestamp=Date.now()]
         */
        function recordPlaybackOutcome(trackId, params = {}) {
            if (!trackId) return null;
            const id = String(trackId);
            const stats = ensureTrackStats(id);

            const timestamp = Number.isFinite(params.timestamp) ? params.timestamp : Date.now();
            const durationSeconds = Math.max(1, Number(params.durationSeconds) || 180);
            const endedNaturally = Boolean(params.endedNaturally);
            const rawListened = Number.isFinite(params.listenedSeconds)
                ? Math.max(0, params.listenedSeconds)
                : endedNaturally
                  ? durationSeconds
                  : 0;

            // Ignore sub-1-second accidental double-clicks unless explicitly flagged
            if (!endedNaturally && rawListened < 0.75 && !params.forceRecord) {
                return getTrackStats(id);
            }

            const completionRatio = endedNaturally
                ? 1
                : clamp(rawListened / durationSeconds, 0, 1);

            let outcome = "partial";
            if (endedNaturally || completionRatio >= 0.85) {
                outcome = "completed";
                stats.fullCompletions += 1;
                // Completion decays accumulated skip penalty
                stats.skipPenalty = roundTo(clamp(stats.skipPenalty * 0.72 - 0.04, 0, 1));
            } else if (completionRatio < 0.25 || (durationSeconds >= 30 && rawListened < 15)) {
                outcome = "early-skip";
                stats.earlySkipCount += 1;
                // Early skip carries a strong skip penalty
                stats.skipPenalty = roundTo(clamp(stats.skipPenalty + 0.24, 0, 1));
            } else {
                outcome = "late-skip";
                stats.lateSkipCount += 1;
                // Late skip carries a lighter skip penalty
                stats.skipPenalty = roundTo(clamp(stats.skipPenalty + 0.09, 0, 1));
            }

            const prevPlayCount = stats.playCount;
            stats.playCount += 1;
            stats.totalListenSeconds = roundTo(stats.totalListenSeconds + rawListened, 2);
            stats.lastCompletionRatio = roundTo(completionRatio);

            if (prevPlayCount === 0) {
                stats.avgCompletionRatio = roundTo(completionRatio);
            } else {
                // Blend historical completion with 0.35 EMA weight for responsive taste adaptation
                const weight = Math.max(0.25, 1 / Math.min(stats.playCount, 4));
                stats.avgCompletionRatio = roundTo(
                    clamp(stats.avgCompletionRatio * (1 - weight) + completionRatio * weight, 0, 1)
                );
            }

            if (!stats.firstPlayedAt) {
                stats.firstPlayedAt = timestamp;
            }
            stats.lastPlayedAt = timestamp;
            stats.playHistory = [timestamp, ...(stats.playHistory || [])].slice(0, MAX_TRACK_PLAY_TIMESTAMPS);

            // Prepend to global recentlyPlayed log
            state.recentlyPlayed = [
                {
                    trackId: id,
                    playedAt: timestamp,
                    listenedSeconds: roundTo(rawListened, 2),
                    durationSeconds: roundTo(durationSeconds, 2),
                    completionRatio: roundTo(completionRatio),
                    outcome,
                },
                ...state.recentlyPlayed,
            ].slice(0, MAX_RECENT_HISTORY);

            if (activeSession && activeSession.trackId === id) {
                activeSession = null;
            }

            saveState("telemetry:outcome", {
                trackId: id,
                outcome,
                completionRatio: stats.lastCompletionRatio,
                skipPenalty: stats.skipPenalty,
            });

            return getTrackStats(id);
        }

        /**
         * Computes a Spotify + YT Music hybrid taste affinity score for a track
         * based on likes/dislikes, completion ratio, play counts, skip penalty decay, and recency.
         */
        function computeTasteAffinity(trackId, now = Date.now()) {
            const stats = getTrackStats(trackId);

            // Disliked tracks get a strong negative floor
            if (stats.disliked) {
                return {
                    trackId: stats.trackId,
                    score: -0.85,
                    normalizedScore: 0.075,
                    likeBoost: -0.65,
                    completionScore: 0,
                    playCountBoost: 0,
                    skipPenalty: stats.skipPenalty,
                    recencyFactor: 1,
                };
            }

            const likeBoost = stats.liked ? 0.38 : 0;
            const completionBaseline = stats.playCount > 0 ? stats.avgCompletionRatio : 0.5;
            const completionScore = (completionBaseline - 0.5) * 0.5; // [-0.25 .. +0.25]
            const playCountBoost = Math.min(0.24, Math.log2(1 + stats.playCount) * 0.075);

            // Decay skip penalty slightly over time if the track hasn't been skipped recently
            let effectiveSkipPenalty = stats.skipPenalty;
            if (stats.lastPlayedAt && now > stats.lastPlayedAt) {
                const hoursSincePlay = (now - stats.lastPlayedAt) / (1000 * 60 * 60);
                const timeDecay = Math.pow(0.95, Math.min(72, hoursSincePlay));
                effectiveSkipPenalty = roundTo(stats.skipPenalty * timeDecay);
            }

            const rawScore = clamp(
                likeBoost + completionScore + playCountBoost - effectiveSkipPenalty * 0.55,
                -1,
                1
            );
            const normalizedScore = roundTo(clamp((rawScore + 1) / 2, 0, 1));

            return {
                trackId: stats.trackId,
                score: roundTo(rawScore),
                normalizedScore,
                likeBoost: roundTo(likeBoost),
                completionScore: roundTo(completionScore),
                playCountBoost: roundTo(playCountBoost),
                skipPenalty: roundTo(effectiveSkipPenalty),
                recencyFactor: stats.lastPlayedAt ? Math.max(0, now - stats.lastPlayedAt) : null,
            };
        }

        // ==================== LIKES & DISLIKES ====================

        function isLiked(trackId) {
            return state.likedTrackIds.includes(String(trackId));
        }

        function isDisliked(trackId) {
            return state.dislikedTrackIds.includes(String(trackId));
        }

        function setLike(trackId, shouldLike) {
            if (!trackId) return false;
            const id = String(trackId);
            const stats = ensureTrackStats(id);
            const likedSet = new Set(state.likedTrackIds);
            const dislikedSet = new Set(state.dislikedTrackIds);

            if (shouldLike) {
                likedSet.add(id);
                dislikedSet.delete(id);
                stats.liked = true;
                stats.disliked = false;
                // Liking a track forgives half of prior skip penalty
                stats.skipPenalty = roundTo(stats.skipPenalty * 0.5);
            } else {
                likedSet.delete(id);
                stats.liked = false;
            }

            state.likedTrackIds = Array.from(likedSet);
            state.dislikedTrackIds = Array.from(dislikedSet);
            saveState("taste:like-changed", { trackId: id, liked: stats.liked });
            return stats.liked;
        }

        function toggleLike(trackId) {
            if (!trackId) return false;
            return setLike(trackId, !isLiked(trackId));
        }

        function setDislike(trackId, shouldDislike) {
            if (!trackId) return false;
            const id = String(trackId);
            const stats = ensureTrackStats(id);
            const likedSet = new Set(state.likedTrackIds);
            const dislikedSet = new Set(state.dislikedTrackIds);

            if (shouldDislike) {
                dislikedSet.add(id);
                likedSet.delete(id);
                stats.disliked = true;
                stats.liked = false;
            } else {
                dislikedSet.delete(id);
                stats.disliked = false;
            }

            state.likedTrackIds = Array.from(likedSet);
            state.dislikedTrackIds = Array.from(dislikedSet);
            saveState("taste:dislike-changed", { trackId: id, disliked: stats.disliked });
            return stats.disliked;
        }

        function toggleDislike(trackId) {
            if (!trackId) return false;
            return setDislike(trackId, !isDisliked(trackId));
        }

        function getLikedTrackIds() {
            return state.likedTrackIds.slice();
        }

        function getDislikedTrackIds() {
            return state.dislikedTrackIds.slice();
        }

        // ==================== RECENTLY PLAYED ====================

        function getRecentlyPlayed(limit = 50) {
            return state.recentlyPlayed.slice(0, Math.max(0, limit));
        }

        function getRecentlyPlayedTrackIds(limit = 20) {
            const seen = new Set();
            const result = [];
            for (const entry of state.recentlyPlayed) {
                if (!seen.has(entry.trackId)) {
                    seen.add(entry.trackId);
                    result.push(entry.trackId);
                    if (result.length >= limit) break;
                }
            }
            return result;
        }

        // ==================== CUSTOM PLAYLISTS ====================

        function getPlaylists() {
            return state.playlists.map((pl) => ({
                ...pl,
                trackIds: Array.isArray(pl.trackIds) ? pl.trackIds.slice() : [],
            }));
        }

        function getPlaylist(playlistId) {
            const found = state.playlists.find((pl) => pl.id === playlistId);
            return found ? { ...found, trackIds: found.trackIds.slice() } : null;
        }

        function createPlaylist({ name, description = "", trackIds = [], coverUrl = "" } = {}) {
            const cleanName = String(name || "New Playlist").trim() || "New Playlist";
            const slug = cleanName
                .toLowerCase()
                .replace(/[^a-z0-9]+/g, "-")
                .replace(/^-+|-+$/g, "");
            const id = `pl-${slug || "custom"}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
            const now = Date.now();
            const playlist = {
                id,
                name: cleanName,
                description: String(description || "").trim(),
                trackIds: Array.from(new Set((trackIds || []).map(String))),
                coverUrl: coverUrl || "Images/Espresso.jpeg",
                createdAt: now,
                updatedAt: now,
            };
            state.playlists.unshift(playlist);
            saveState("playlist:created", { playlist });
            return { ...playlist, trackIds: playlist.trackIds.slice() };
        }

        function updatePlaylist(playlistId, patch = {}) {
            const idx = state.playlists.findIndex((pl) => pl.id === playlistId);
            if (idx === -1) return null;
            const current = state.playlists[idx];
            const updated = {
                ...current,
                ...(typeof patch.name === "string" ? { name: patch.name.trim() || current.name } : {}),
                ...(typeof patch.description === "string" ? { description: patch.description.trim() } : {}),
                ...(typeof patch.coverUrl === "string" ? { coverUrl: patch.coverUrl } : {}),
                ...(Array.isArray(patch.trackIds)
                    ? { trackIds: Array.from(new Set(patch.trackIds.map(String))) }
                    : {}),
                updatedAt: Date.now(),
            };
            state.playlists[idx] = updated;
            saveState("playlist:updated", { playlist: updated });
            return { ...updated, trackIds: updated.trackIds.slice() };
        }

        function deletePlaylist(playlistId) {
            const initialLen = state.playlists.length;
            state.playlists = state.playlists.filter((pl) => pl.id !== playlistId);
            const removed = state.playlists.length < initialLen;
            if (removed) {
                saveState("playlist:deleted", { playlistId });
            }
            return removed;
        }

        function addTrackToPlaylist(playlistId, trackId) {
            const idx = state.playlists.findIndex((pl) => pl.id === playlistId);
            if (idx === -1 || !trackId) return null;
            const pl = state.playlists[idx];
            const id = String(trackId);
            if (!pl.trackIds.includes(id)) {
                pl.trackIds.push(id);
                pl.updatedAt = Date.now();
                saveState("playlist:track-added", { playlistId, trackId: id });
            }
            return getPlaylist(playlistId);
        }

        function removeTrackFromPlaylist(playlistId, trackId) {
            const idx = state.playlists.findIndex((pl) => pl.id === playlistId);
            if (idx === -1 || !trackId) return null;
            const pl = state.playlists[idx];
            const id = String(trackId);
            const nextIds = pl.trackIds.filter((t) => t !== id);
            if (nextIds.length !== pl.trackIds.length) {
                pl.trackIds = nextIds;
                pl.updatedAt = Date.now();
                saveState("playlist:track-removed", { playlistId, trackId: id });
            }
            return getPlaylist(playlistId);
        }

        function reorderPlaylistTracks(playlistId, fromIndex, toIndex) {
            const idx = state.playlists.findIndex((pl) => pl.id === playlistId);
            if (idx === -1) return null;
            const pl = state.playlists[idx];
            if (
                fromIndex < 0 ||
                fromIndex >= pl.trackIds.length ||
                toIndex < 0 ||
                toIndex >= pl.trackIds.length
            ) {
                return getPlaylist(playlistId);
            }
            const [moved] = pl.trackIds.splice(fromIndex, 1);
            pl.trackIds.splice(toIndex, 0, moved);
            pl.updatedAt = Date.now();
            saveState("playlist:reordered", { playlistId, fromIndex, toIndex });
            return getPlaylist(playlistId);
        }

        // ==================== INDEXEDDB AUDIO BLOB & IMPORTED TRACK STORE ====================

        function getIndexedDBFactory() {
            if (options.indexedDB) return options.indexedDB;
            if (globalScope && globalScope.indexedDB) return globalScope.indexedDB;
            return null;
        }

        function openDatabase() {
            if (idbPromise) return idbPromise;
            const idbFactory = getIndexedDBFactory();
            if (!idbFactory || typeof idbFactory.open !== "function") {
                idbPromise = Promise.resolve(null);
                return idbPromise;
            }

            idbPromise = new Promise((resolve) => {
                try {
                    const req = idbFactory.open(idbName, IDB_VERSION);
                    req.onupgradeneeded = (event) => {
                        const db = event.target.result;
                        if (!db.objectStoreNames.contains("audioBlobs")) {
                            db.createObjectStore("audioBlobs", { keyPath: "id" });
                        }
                        if (!db.objectStoreNames.contains("importedTracks")) {
                            db.createObjectStore("importedTracks", { keyPath: "id" });
                        }
                        if (!db.objectStoreNames.contains("analyzerCache")) {
                            db.createObjectStore("analyzerCache", { keyPath: "trackId" });
                        }
                    };
                    req.onsuccess = () => resolve(req.result);
                    req.onerror = () => resolve(null);
                } catch (_) {
                    resolve(null);
                }
            });

            return idbPromise;
        }

        async function idbPut(storeName, record) {
            const key = storeName === "analyzerCache" ? record.trackId : record.id;
            memoryIdb[storeName].set(String(key), record);

            const db = await openDatabase();
            if (!db) return record;

            return new Promise((resolve) => {
                try {
                    const tx = db.transaction(storeName, "readwrite");
                    const store = tx.objectStore(storeName);
                    store.put(record);
                    tx.oncomplete = () => resolve(record);
                    tx.onerror = () => resolve(record);
                } catch (_) {
                    resolve(record);
                }
            });
        }

        async function idbGet(storeName, key) {
            const strKey = String(key);
            const db = await openDatabase();
            if (!db) {
                return memoryIdb[storeName].get(strKey) || null;
            }

            return new Promise((resolve) => {
                try {
                    const tx = db.transaction(storeName, "readonly");
                    const store = tx.objectStore(storeName);
                    const req = store.get(strKey);
                    req.onsuccess = () => resolve(req.result || memoryIdb[storeName].get(strKey) || null);
                    req.onerror = () => resolve(memoryIdb[storeName].get(strKey) || null);
                } catch (_) {
                    resolve(memoryIdb[storeName].get(strKey) || null);
                }
            });
        }

        async function idbGetAll(storeName) {
            const db = await openDatabase();
            if (!db) {
                return Array.from(memoryIdb[storeName].values());
            }

            return new Promise((resolve) => {
                try {
                    const tx = db.transaction(storeName, "readonly");
                    const store = tx.objectStore(storeName);
                    const req = store.getAll();
                    req.onsuccess = () => {
                        const rows = Array.isArray(req.result) ? req.result : [];
                        if (rows.length > 0) {
                            for (const row of rows) {
                                const k = storeName === "analyzerCache" ? row.trackId : row.id;
                                memoryIdb[storeName].set(String(k), row);
                            }
                            resolve(rows);
                        } else {
                            resolve(Array.from(memoryIdb[storeName].values()));
                        }
                    };
                    req.onerror = () => resolve(Array.from(memoryIdb[storeName].values()));
                } catch (_) {
                    resolve(Array.from(memoryIdb[storeName].values()));
                }
            });
        }

        async function idbDelete(storeName, key) {
            const strKey = String(key);
            memoryIdb[storeName].delete(strKey);

            const db = await openDatabase();
            if (!db) return true;

            return new Promise((resolve) => {
                try {
                    const tx = db.transaction(storeName, "readwrite");
                    const store = tx.objectStore(storeName);
                    store.delete(strKey);
                    tx.oncomplete = () => resolve(true);
                    tx.onerror = () => resolve(true);
                } catch (_) {
                    resolve(true);
                }
            });
        }

        function createBlobObjectUrl(trackId, blobOrBuffer, mimeType = "audio/mpeg") {
            if (!blobOrBuffer) return null;
            if (objectUrlCache.has(trackId)) {
                return objectUrlCache.get(trackId);
            }
            const URLApi = (globalScope && globalScope.URL) || (typeof URL !== "undefined" ? URL : null);
            const BlobCtor = (globalScope && globalScope.Blob) || (typeof Blob !== "undefined" ? Blob : null);
            if (!URLApi || typeof URLApi.createObjectURL !== "function") {
                return `blob:spottube-local/${encodeURIComponent(trackId)}`;
            }
            try {
                let blob = blobOrBuffer;
                if (BlobCtor && !(blobOrBuffer instanceof BlobCtor)) {
                    blob = new BlobCtor([blobOrBuffer], { type: mimeType });
                }
                const url = URLApi.createObjectURL(blob);
                objectUrlCache.set(trackId, url);
                return url;
            } catch (_) {
                return `blob:spottube-local/${encodeURIComponent(trackId)}`;
            }
        }

        /**
         * Persists a user-imported local audio file (Blob or ArrayBuffer/Uint8Array) and its parsed
         * track metadata into IndexedDB ("importedTracks" + "audioBlobs").
         */
        async function saveImportedTrack(trackMeta = {}, audioBlobOrBuffer = null) {
            const now = Date.now();
            const title = String(trackMeta.title || "Untitled Track").trim();
            const primaryArtist = String(trackMeta.primaryArtist || trackMeta.artistDisplay || "Local Artist").trim();
            const id =
                trackMeta.id ||
                `local-${title}-${primaryArtist}`
                    .toLowerCase()
                    .replace(/[^a-z0-9]+/g, "-")
                    .replace(/^-+|-+$/g, "");

            const mimeType =
                (audioBlobOrBuffer && audioBlobOrBuffer.type) || trackMeta.mimeType || "audio/mpeg";
            const size =
                (audioBlobOrBuffer && (audioBlobOrBuffer.size || audioBlobOrBuffer.byteLength)) ||
                trackMeta.size ||
                0;

            let audioUrl = trackMeta.audioUrl || "";
            if (audioBlobOrBuffer) {
                await idbPut("audioBlobs", {
                    id,
                    blob: audioBlobOrBuffer,
                    mimeType,
                    filename: trackMeta.filename || `${title}.mp3`,
                    size,
                    updatedAt: now,
                });
                audioUrl = createBlobObjectUrl(id, audioBlobOrBuffer, mimeType) || audioUrl;
            }

            const normalizedTrack = {
                id,
                filename: trackMeta.filename || `${title}.mp3`,
                title,
                primaryArtist,
                featuredArtists: Array.isArray(trackMeta.featuredArtists) ? trackMeta.featuredArtists : [],
                artists: Array.isArray(trackMeta.artists) ? trackMeta.artists : [primaryArtist],
                artistDisplay: trackMeta.artistDisplay || primaryArtist,
                album: trackMeta.album || "Local Imports",
                year: Number(trackMeta.year) || new Date().getFullYear(),
                duration: Number(trackMeta.duration) || 0,
                durationFormatted: trackMeta.durationFormatted || "0:00",
                bitrateKbps: Number(trackMeta.bitrateKbps) || 320,
                sampleRate: Number(trackMeta.sampleRate) || 44100,
                audioUrl: audioUrl || `blob:spottube-local/${encodeURIComponent(id)}`,
                coverUrl: trackMeta.coverUrl || "Images/Espresso.jpeg",
                genre: trackMeta.genre || "Local",
                subgenres: Array.isArray(trackMeta.subgenres) ? trackMeta.subgenres : ["Imported"],
                language: trackMeta.language || "English",
                moods: Array.isArray(trackMeta.moods) && trackMeta.moods.length ? trackMeta.moods : ["Chill", "Feel Good"],
                bpm: Number(trackMeta.bpm) || 115,
                energy: clamp(Number(trackMeta.energy ?? 0.68), 0, 1),
                valence: clamp(Number(trackMeta.valence ?? 0.65), 0, 1),
                danceability: clamp(Number(trackMeta.danceability ?? 0.65), 0, 1),
                acousticness: clamp(Number(trackMeta.acousticness ?? 0.3), 0, 1),
                popularity: clamp(Number(trackMeta.popularity ?? 0.6), 0, 1),
                isLocalImport: true,
                createdAt: trackMeta.createdAt || now,
                updatedAt: now,
            };

            await idbPut("importedTracks", normalizedTrack);
            emitChange("idb:track-imported", { track: normalizedTrack });
            return normalizedTrack;
        }

        async function getAudioBlob(trackId) {
            if (!trackId) return null;
            return idbGet("audioBlobs", trackId);
        }

        async function getImportedTracks() {
            const tracks = await idbGetAll("importedTracks");
            const hydrated = [];
            for (const track of tracks) {
                let audioUrl = track.audioUrl;
                if (!objectUrlCache.has(track.id)) {
                    const blobRec = await idbGet("audioBlobs", track.id);
                    if (blobRec && blobRec.blob) {
                        audioUrl = createBlobObjectUrl(track.id, blobRec.blob, blobRec.mimeType) || audioUrl;
                    }
                } else {
                    audioUrl = objectUrlCache.get(track.id);
                }
                hydrated.push({
                    ...track,
                    audioUrl,
                });
            }
            return hydrated.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
        }

        async function deleteImportedTrack(trackId) {
            if (!trackId) return false;
            const id = String(trackId);
            const URLApi = (globalScope && globalScope.URL) || (typeof URL !== "undefined" ? URL : null);
            if (objectUrlCache.has(id)) {
                if (URLApi && typeof URLApi.revokeObjectURL === "function") {
                    try {
                        URLApi.revokeObjectURL(objectUrlCache.get(id));
                    } catch (_) {}
                }
                objectUrlCache.delete(id);
            }
            await idbDelete("importedTracks", id);
            await idbDelete("audioBlobs", id);
            emitChange("idb:track-deleted", { trackId: id });
            return true;
        }

        // ==================== WEB AUDIO API REAL-TIME ANALYZER CACHE ====================

        /**
         * Blends a new real-time Web Audio API spectral snapshot into the per-track analyzer cache.
         */
        function updateTrackAnalyzerFeatures(trackId, snapshot = {}, blendAlpha = 0.25) {
            if (!trackId) return null;
            const id = String(trackId);
            const existing = state.analyzerCache[id];
            const alpha = existing ? clamp(blendAlpha, 0.05, 1) : 1;

            const blend = (prev, next, fallback = 0) => {
                const nextVal = Number.isFinite(next) ? next : fallback;
                if (!existing || !Number.isFinite(prev)) return roundTo(clamp(nextVal, 0, 1));
                return roundTo(clamp(prev * (1 - alpha) + nextVal * alpha, 0, 1));
            };

            const nextCentroidHz = Number.isFinite(snapshot.spectralCentroidHz)
                ? snapshot.spectralCentroidHz
                : Number.isFinite(snapshot.spectralCentroidNormalized)
                  ? snapshot.spectralCentroidNormalized * 8000
                  : existing?.spectralCentroidHz || 2400;

            const blendedCentroidHz = existing
                ? Math.round(existing.spectralCentroidHz * (1 - alpha) + nextCentroidHz * alpha)
                : Math.round(nextCentroidHz);

            const record = {
                trackId: id,
                rmsEnergy: blend(existing?.rmsEnergy, snapshot.rmsEnergy, 0.65),
                bassEnergy: blend(existing?.bassEnergy, snapshot.bassEnergy, 0.55),
                midEnergy: blend(existing?.midEnergy, snapshot.midEnergy, 0.5),
                trebleEnergy: blend(existing?.trebleEnergy, snapshot.trebleEnergy, 0.35),
                spectralCentroidHz: blendedCentroidHz,
                spectralCentroidNormalized: blend(
                    existing?.spectralCentroidNormalized,
                    snapshot.spectralCentroidNormalized ?? blendedCentroidHz / 8000,
                    0.35
                ),
                zeroCrossingRate: blend(existing?.zeroCrossingRate, snapshot.zeroCrossingRate, 0.15),
                sampleCount: (existing?.sampleCount || 0) + 1,
                updatedAt: Date.now(),
            };

            state.analyzerCache[id] = record;
            saveState("analyzer:updated", { trackId: id, features: record });
            idbPut("analyzerCache", record).catch(() => {});
            return { ...record };
        }

        function getTrackAnalyzerFeatures(trackId) {
            if (!trackId) return null;
            const cached = state.analyzerCache[String(trackId)];
            return cached ? { ...cached } : null;
        }

        function getAllAnalyzerFeatures() {
            return { ...state.analyzerCache };
        }

        /**
         * Returns effective audio features for a track object by merging static manifest
         * features (`track.energy`, `track.bpm`, etc.) with real-time cached Web Audio API
         * analyzer measurements (`rmsEnergy`, `bassEnergy`, `trebleEnergy`, `spectralCentroidNormalized`).
         */
        function getEffectiveAudioFeatures(track) {
            if (!track) return null;
            const cached = getTrackAnalyzerFeatures(track.id);
            const staticEnergy = clamp(Number(track.energy ?? track.audioFeatures?.energy ?? 0.65), 0, 1);
            const staticValence = clamp(Number(track.valence ?? track.audioFeatures?.valence ?? 0.6), 0, 1);
            const staticDanceability = clamp(
                Number(track.danceability ?? track.audioFeatures?.danceability ?? 0.65),
                0,
                1
            );
            const staticAcousticness = clamp(
                Number(track.acousticness ?? track.audioFeatures?.acousticness ?? 0.25),
                0,
                1
            );

            if (!cached) {
                return {
                    trackId: track.id,
                    energy: staticEnergy,
                    rmsEnergy: staticEnergy,
                    bassEnergy: roundTo(clamp(staticDanceability * 0.85, 0, 1)),
                    midEnergy: roundTo(clamp((staticEnergy + staticValence) / 2, 0, 1)),
                    trebleEnergy: roundTo(clamp(staticEnergy * (1 - staticAcousticness * 0.5), 0, 1)),
                    spectralCentroidNormalized: roundTo(
                        clamp(staticEnergy * 0.6 + (1 - staticAcousticness) * 0.4, 0, 1)
                    ),
                    spectralCentroidHz: Math.round(
                        (staticEnergy * 0.6 + (1 - staticAcousticness) * 0.4) * 5200
                    ),
                    valence: staticValence,
                    danceability: staticDanceability,
                    acousticness: staticAcousticness,
                    bpm: Number(track.bpm || 110),
                    hasLiveAnalyzer: false,
                };
            }

            return {
                trackId: track.id,
                energy: roundTo(clamp(staticEnergy * 0.65 + cached.rmsEnergy * 0.35, 0, 1)),
                rmsEnergy: cached.rmsEnergy,
                bassEnergy: cached.bassEnergy,
                midEnergy: cached.midEnergy,
                trebleEnergy: cached.trebleEnergy,
                spectralCentroidNormalized: cached.spectralCentroidNormalized,
                spectralCentroidHz: cached.spectralCentroidHz,
                valence: staticValence,
                danceability: staticDanceability,
                acousticness: staticAcousticness,
                bpm: Number(track.bpm || 110),
                sampleCount: cached.sampleCount,
                hasLiveAnalyzer: true,
            };
        }

        /**
         * Attaches a non-intrusive Web Audio API AnalyserNode to an HTMLAudioElement
         * and periodically samples & caches RMS energy, bass/treble energy, and spectral centroid
         * for whichever track is currently playing.
         */
        function attachAudioAnalyzer(audioElement, analyzerOptions = {}) {
            if (!audioElement || typeof audioElement.addEventListener !== "function") {
                return { sampleNow: () => null, detach: () => {} };
            }

            const fftSize = analyzerOptions.fftSize || 512;
            const sampleIntervalMs = analyzerOptions.sampleIntervalMs || 1800;
            const getActiveTrackId =
                typeof analyzerOptions.getActiveTrackId === "function"
                    ? analyzerOptions.getActiveTrackId
                    : () => audioElement.dataset?.trackId || null;

            let audioCtx = null;
            let analyser = null;
            let freqBins = null;
            let timeBins = null;
            let intervalId = null;
            let graphConnected = false;

            function ensureAudioGraph() {
                if (graphConnected) return Boolean(analyser);
                const AudioCtx =
                    analyzerOptions.AudioContext ||
                    (globalScope && (globalScope.AudioContext || globalScope.webkitAudioContext));
                if (!AudioCtx) return false;

                try {
                    audioCtx = new AudioCtx();
                    analyser = audioCtx.createAnalyser();
                    analyser.fftSize = fftSize;
                    analyser.smoothingTimeConstant = 0.8;

                    const source = audioCtx.createMediaElementSource(audioElement);
                    source.connect(analyser);
                    analyser.connect(audioCtx.destination);

                    freqBins = new Uint8Array(analyser.frequencyBinCount);
                    timeBins = new Uint8Array(analyser.frequencyBinCount);
                    graphConnected = true;
                    return true;
                } catch (_) {
                    // If MediaElementSource is already connected or unsupported, degrade gracefully
                    graphConnected = true;
                    analyser = null;
                    return false;
                }
            }

            function sampleNow() {
                const trackId = getActiveTrackId();
                if (!trackId) return null;
                if (!ensureAudioGraph() || !analyser) return null;

                if (audioCtx && audioCtx.state === "suspended" && typeof audioCtx.resume === "function") {
                    audioCtx.resume().catch(() => {});
                }

                analyser.getByteFrequencyData(freqBins);
                analyser.getByteTimeDomainData(timeBins);

                // Check that bins aren't completely zeroed out (e.g. while paused)
                let nonZero = false;
                for (let i = 0; i < freqBins.length; i++) {
                    if (freqBins[i] > 2) {
                        nonZero = true;
                        break;
                    }
                }
                if (!nonZero) return null;

                const snapshot = computeSpectralFeaturesFromBins(
                    freqBins,
                    timeBins,
                    audioCtx ? audioCtx.sampleRate : 44100
                );
                return updateTrackAnalyzerFeatures(trackId, snapshot);
            }

            function startPolling() {
                if (intervalId) return;
                if (typeof setInterval === "function") {
                    intervalId = setInterval(() => {
                        if (!audioElement.paused) {
                            sampleNow();
                        }
                    }, sampleIntervalMs);
                }
            }

            function stopPolling() {
                if (intervalId && typeof clearInterval === "function") {
                    clearInterval(intervalId);
                    intervalId = null;
                }
            }

            audioElement.addEventListener("play", startPolling);
            audioElement.addEventListener("pause", stopPolling);
            audioElement.addEventListener("ended", stopPolling);

            return {
                sampleNow,
                detach() {
                    stopPolling();
                },
            };
        }

        // ==================== USER PREFERENCES ====================

        function getPreferences() {
            return { ...state.preferences };
        }

        function setPreferences(patch = {}) {
            state.preferences = {
                ...state.preferences,
                ...patch,
            };
            saveState("preferences:updated", { preferences: state.preferences });
            return getPreferences();
        }

        return {
            STORAGE_KEY: storageKey,
            IDB_NAME: idbName,
            createStorageStore,
            computeSpectralFeaturesFromBins,
            getState: () => JSON.parse(JSON.stringify(state)),
            resetState,
            subscribe,
            // Telemetry & Taste
            getTrackStats,
            getAllTrackStats,
            recordPlayStart,
            recordPlaybackOutcome,
            computeTasteAffinity,
            // Likes & Dislikes
            isLiked,
            isDisliked,
            setLike,
            toggleLike,
            setDislike,
            toggleDislike,
            getLikedTrackIds,
            getDislikedTrackIds,
            // Recently Played
            getRecentlyPlayed,
            getRecentlyPlayedTrackIds,
            // Custom Playlists
            getPlaylists,
            getPlaylist,
            createPlaylist,
            updatePlaylist,
            deletePlaylist,
            addTrackToPlaylist,
            removeTrackFromPlaylist,
            reorderPlaylistTracks,
            // IndexedDB Local Audio Blobs & Imported Metadata
            openDatabase,
            saveImportedTrack,
            getAudioBlob,
            getImportedTracks,
            deleteImportedTrack,
            // Real-Time Web Audio API Analyzer Cache
            updateTrackAnalyzerFeatures,
            getTrackAnalyzerFeatures,
            getAllAnalyzerFeatures,
            getEffectiveAudioFeatures,
            attachAudioAnalyzer,
            // Preferences
            getPreferences,
            setPreferences,
        };
    }

    return createStorageStore();
});
