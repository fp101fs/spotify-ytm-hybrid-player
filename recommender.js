/**
 * SpotTube Hybrid Player — Multi-Signal Recommendation & Scoring Engine (`recommender.js`)
 *
 * Combines:
 * 1. Artist & Collaborator Affinity (primary/featured overlap + 1-hop collaborator graph)
 * 2. Genre, Subgenre, Album, Language & Era Clustering
 * 3. Audio Feature Vector Cosine Similarity + Tempo (BPM) & Mood Tag Harmony
 *    (integrating static manifest features and real-time Web Audio API spectral features from `storage.js`)
 * 4. Spotify-Style User Taste Affinity (completion ratios, likes/dislikes, play counts, skip decay)
 * 5. Recency & Variety Anti-Repetition Penalties (queue artist/album/genre streak saturation + recent play history)
 * 6. YT Music Dynamic Mix Mode Modifiers (`all`, `familiar`, `discover`, `deep-cuts`, `upbeat`, `chill`)
 *
 * Works in both Browser (`window.SpotTubeRecommender`) and Node.js CommonJS (`module.exports`).
 */
(function (root, factory) {
    if (typeof module === "object" && module.exports) {
        module.exports = factory(root);
    } else {
        root.SpotTubeRecommender = factory(root);
    }
})(typeof globalThis !== "undefined" ? globalThis : typeof window !== "undefined" ? window : this, function (globalScope) {
    const DEFAULT_WEIGHTS = {
        artistAffinity: 0.22,
        genreEraCluster: 0.22,
        audioSimilarity: 0.28,
        tasteAffinity: 0.28,
    };

    const VALID_MIX_MODES = ["all", "familiar", "discover", "deep-cuts", "upbeat", "chill"];

    const MIX_MODE_PROFILES = {
        all: {
            id: "all",
            label: "All",
            shortLabel: "Balanced",
            badge: "HYBRID MIX",
            description: "Balanced blend of your favorites, sonic matches, and fresh picks",
            weights: {
                artistAffinity: 0.22,
                genreEraCluster: 0.22,
                audioSimilarity: 0.28,
                tasteAffinity: 0.28,
            },
        },
        familiar: {
            id: "familiar",
            label: "Familiar",
            shortLabel: "Familiar",
            badge: "FAMILIAR MIX",
            description: "Prioritizes your liked songs, high-completion favorites, and signature hits",
            weights: {
                artistAffinity: 0.26,
                genreEraCluster: 0.18,
                audioSimilarity: 0.20,
                tasteAffinity: 0.36,
            },
        },
        discover: {
            id: "discover",
            label: "Discover",
            shortLabel: "Discover",
            badge: "DISCOVER MIX",
            description: "Surfaces unplayed tracks, new artists, and sonic bridges outside your usual loop",
            weights: {
                artistAffinity: 0.10,
                genreEraCluster: 0.16,
                audioSimilarity: 0.42,
                tasteAffinity: 0.32,
            },
        },
        "deep-cuts": {
            id: "deep-cuts",
            label: "Deep Cuts",
            shortLabel: "Deep Cuts",
            badge: "DEEP CUTS",
            description: "Digs into lower-popularity hidden gems, B-sides, and niche subgenres",
            weights: {
                artistAffinity: 0.18,
                genreEraCluster: 0.26,
                audioSimilarity: 0.32,
                tasteAffinity: 0.24,
            },
        },
        upbeat: {
            id: "upbeat",
            label: "Upbeat",
            shortLabel: "Upbeat",
            badge: "UPBEAT VIBE",
            description: "Boosts high-energy, danceable, fast-tempo tracks to lift the momentum",
            weights: {
                artistAffinity: 0.16,
                genreEraCluster: 0.18,
                audioSimilarity: 0.40,
                tasteAffinity: 0.26,
            },
        },
        chill: {
            id: "chill",
            label: "Chill",
            shortLabel: "Chill",
            badge: "CHILL VIBE",
            description: "Leans into acoustic textures, smooth tempos, and laid-back late-night vibes",
            weights: {
                artistAffinity: 0.16,
                genreEraCluster: 0.20,
                audioSimilarity: 0.40,
                tasteAffinity: 0.24,
            },
        },
    };

    function getMixModeProfile(mixMode = "all") {
        const key = String(mixMode || "all")
            .trim()
            .toLowerCase();
        return MIX_MODE_PROFILES[key] || MIX_MODE_PROFILES.all;
    }

    function clamp(value, min, max) {
        if (!Number.isFinite(value)) return min;
        return Math.max(min, Math.min(max, value));
    }

    function roundTo(value, decimals = 4) {
        const factor = Math.pow(10, decimals);
        return Math.round((Number(value) || 0) * factor) / factor;
    }

    function normalizeString(str) {
        return String(str || "")
            .trim()
            .toLowerCase();
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
     * Builds an undirected co-occurrence collaboration graph across a catalog of tracks.
     * Map<normalizedArtistName, Set<normalizedCollaboratorName>>
     */
    function buildCollaboratorGraph(catalog = []) {
        const graph = new Map();
        if (!Array.isArray(catalog)) return graph;

        for (const track of catalog) {
            const artists = getTrackArtists(track).map(normalizeString).filter(Boolean);
            for (const artist of artists) {
                if (!graph.has(artist)) {
                    graph.set(artist, new Set());
                }
            }
            for (let i = 0; i < artists.length; i++) {
                for (let j = i + 1; j < artists.length; j++) {
                    graph.get(artists[i]).add(artists[j]);
                    graph.get(artists[j]).add(artists[i]);
                }
            }
        }

        return graph;
    }

    /**
     * Computes standard cosine similarity between two numeric vectors of equal length.
     */
    function cosineSimilarity(vecA = [], vecB = []) {
        const len = Math.min(vecA.length, vecB.length);
        if (len === 0) return 0;

        let dot = 0;
        let magA = 0;
        let magB = 0;
        for (let i = 0; i < len; i++) {
            const a = Number(vecA[i]) || 0;
            const b = Number(vecB[i]) || 0;
            dot += a * b;
            magA += a * a;
            magB += b * b;
        }

        if (magA <= 1e-9 || magB <= 1e-9) return 0;
        return clamp(dot / (Math.sqrt(magA) * Math.sqrt(magB)), 0, 1);
    }

    /**
     * Extracts a normalized 8-dimensional audio feature vector for a track, merging
     * static manifest features with cached real-time Web Audio API spectral features if available.
     *
     * Dimensions:
     * [0] energy
     * [1] valence
     * [2] danceability
     * [3] acousticness
     * [4] normalizedTempo (BPM mapped onto [60..180] -> [0..1])
     * [5] bassEnergy
     * [6] trebleEnergy
     * [7] spectralCentroidNormalized
     */
    function extractAudioFeatureVector(track, storage = null) {
        if (!track) return [0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5];

        const effective =
            storage && typeof storage.getEffectiveAudioFeatures === "function"
                ? storage.getEffectiveAudioFeatures(track)
                : null;

        const energy = clamp(
            Number(effective?.energy ?? track.energy ?? track.audioFeatures?.energy ?? 0.65),
            0,
            1
        );
        const valence = clamp(
            Number(effective?.valence ?? track.valence ?? track.audioFeatures?.valence ?? 0.6),
            0,
            1
        );
        const danceability = clamp(
            Number(
                effective?.danceability ??
                    track.danceability ??
                    track.audioFeatures?.danceability ??
                    0.65
            ),
            0,
            1
        );
        const acousticness = clamp(
            Number(
                effective?.acousticness ??
                    track.acousticness ??
                    track.audioFeatures?.acousticness ??
                    0.25
            ),
            0,
            1
        );
        const bpm = Number(effective?.bpm ?? track.bpm ?? track.audioFeatures?.bpm ?? 110);
        const normalizedTempo = clamp((bpm - 60) / 120, 0, 1);

        const bassEnergy = clamp(
            Number(effective?.bassEnergy ?? danceability * 0.85),
            0,
            1
        );
        const trebleEnergy = clamp(
            Number(effective?.trebleEnergy ?? energy * (1 - acousticness * 0.5)),
            0,
            1
        );
        const spectralCentroid = clamp(
            Number(
                effective?.spectralCentroidNormalized ??
                    energy * 0.6 + (1 - acousticness) * 0.4
            ),
            0,
            1
        );

        return [
            roundTo(energy),
            roundTo(valence),
            roundTo(danceability),
            roundTo(acousticness),
            roundTo(normalizedTempo),
            roundTo(bassEnergy),
            roundTo(trebleEnergy),
            roundTo(spectralCentroid),
        ];
    }

    /**
     * 1. Artist & Collaborator Affinity [0..1]
     * Evaluates primary artist match, featured/co-artist overlap, and 1-hop collaborator graph edges.
     */
    function computeArtistCollaboratorAffinity(candidate, seedTracks = [], collaboratorGraph = null) {
        if (!candidate || !Array.isArray(seedTracks) || seedTracks.length === 0) {
            return {
                score: 0.35,
                matchType: "unseeded",
                matchedArtist: null,
            };
        }

        const candPrimary = normalizeString(candidate.primaryArtist);
        const candArtists = getTrackArtists(candidate).map(normalizeString).filter(Boolean);
        const candSet = new Set(candArtists);

        let bestScore = 0;
        let bestType = "none";
        let matchedArtist = null;

        for (const seed of seedTracks) {
            if (!seed) continue;
            const seedPrimary = normalizeString(seed.primaryArtist);
            const seedArtists = getTrackArtists(seed).map(normalizeString).filter(Boolean);
            const seedSet = new Set(seedArtists);

            // Exact primary artist match
            if (candPrimary && candPrimary === seedPrimary) {
                bestScore = 1.0;
                bestType = "same-primary-artist";
                matchedArtist = candidate.primaryArtist;
                break;
            }

            // Primary artist is featured on seed or vice-versa
            if (
                (candPrimary && seedSet.has(candPrimary)) ||
                (seedPrimary && candSet.has(seedPrimary))
            ) {
                if (0.86 > bestScore) {
                    bestScore = 0.86;
                    bestType = "primary-featured-crossover";
                    matchedArtist =
                        candPrimary && seedSet.has(candPrimary)
                            ? candidate.primaryArtist
                            : seed.primaryArtist;
                }
            }

            // Shared featured artist
            for (const art of candArtists) {
                if (seedSet.has(art) && 0.76 > bestScore) {
                    bestScore = 0.76;
                    bestType = "shared-featured-artist";
                    matchedArtist = art;
                }
            }

            // 1-hop collaborator in the catalog collaboration graph
            if (collaboratorGraph && bestScore < 0.56) {
                for (const cArt of candArtists) {
                    const neighbors = collaboratorGraph.get(cArt);
                    if (!neighbors) continue;
                    for (const sArt of seedArtists) {
                        if (neighbors.has(sArt)) {
                            bestScore = 0.56;
                            bestType = "collaborator-network";
                            matchedArtist = sArt;
                            break;
                        }
                    }
                }
            }
        }

        return {
            score: roundTo(bestScore),
            matchType: bestType,
            matchedArtist,
        };
    }

    /**
     * 2. Genre, Subgenre, Album, Language & Era Clustering [0..1]
     */
    function computeGenreAlbumEraCluster(candidate, seedTracks = []) {
        if (!candidate || !Array.isArray(seedTracks) || seedTracks.length === 0) {
            return {
                score: 0.5,
                sameGenre: false,
                sameAlbum: false,
                sameLanguage: false,
                subgenreOverlap: 0,
                eraSimilarity: 0.5,
            };
        }

        const candGenre = normalizeString(candidate.genre);
        const candGenreTokens = new Set(
            candGenre
                .split(/[^a-z0-9]+/)
                .map((t) => t.trim())
                .filter((t) => t.length > 2)
        );
        const candSubgenres = new Set(
            (Array.isArray(candidate.subgenres) ? candidate.subgenres : [])
                .map(normalizeString)
                .filter(Boolean)
        );
        const candAlbum = normalizeString(candidate.album);
        const candLang = normalizeString(candidate.language);
        const candYear = Number(candidate.year) || 2022;

        let totalScore = 0;
        let anySameGenre = false;
        let anySameAlbum = false;
        let anySameLanguage = false;
        let maxSubgenreOverlap = 0;
        let maxEraSim = 0;

        for (const seed of seedTracks) {
            if (!seed) continue;
            const seedGenre = normalizeString(seed.genre);
            const seedGenreTokens = new Set(
                seedGenre
                    .split(/[^a-z0-9]+/)
                    .map((t) => t.trim())
                    .filter((t) => t.length > 2)
            );
            const seedSubgenres = new Set(
                (Array.isArray(seed.subgenres) ? seed.subgenres : [])
                    .map(normalizeString)
                    .filter(Boolean)
            );
            const seedAlbum = normalizeString(seed.album);
            const seedLang = normalizeString(seed.language);
            const seedYear = Number(seed.year) || 2022;

            // Genre match (exact or family token match like "Bollywood")
            let genreSim = 0;
            if (candGenre && candGenre === seedGenre) {
                genreSim = 1.0;
                anySameGenre = true;
            } else if (candGenreTokens.size > 0 && seedGenreTokens.size > 0) {
                let sharedTokens = 0;
                for (const tok of candGenreTokens) {
                    if (seedGenreTokens.has(tok)) sharedTokens++;
                }
                if (sharedTokens > 0) {
                    genreSim = 0.68;
                }
            }

            // Subgenre Jaccard / overlap
            let sharedSub = 0;
            for (const sub of candSubgenres) {
                if (seedSubgenres.has(sub)) sharedSub++;
            }
            const unionSub = new Set([...candSubgenres, ...seedSubgenres]).size;
            const subgenreSim =
                unionSub > 0
                    ? clamp((sharedSub / Math.min(candSubgenres.size || 1, seedSubgenres.size || 1)) * 0.85, 0, 1)
                    : 0;
            if (subgenreSim > maxSubgenreOverlap) maxSubgenreOverlap = subgenreSim;

            // Album match
            const sameAlbum = Boolean(candAlbum && seedAlbum && candAlbum === seedAlbum);
            if (sameAlbum) anySameAlbum = true;
            const albumSim = sameAlbum ? 1.0 : 0;

            // Language affinity
            const sameLang = Boolean(candLang && seedLang && candLang === seedLang);
            if (sameLang) anySameLanguage = true;
            const langSim = sameLang ? 1.0 : 0.25;

            // Era proximity (Gaussian decay with sigma ~ 7 years)
            const yearDiff = Math.abs(candYear - seedYear);
            const eraSim = Math.exp(-(yearDiff * yearDiff) / (2 * 7 * 7));
            if (eraSim > maxEraSim) maxEraSim = eraSim;

            const pairClusterScore =
                genreSim * 0.36 +
                subgenreSim * 0.24 +
                langSim * 0.18 +
                eraSim * 0.14 +
                albumSim * 0.08;

            totalScore += pairClusterScore;
        }

        const avgScore = clamp(totalScore / Math.max(1, seedTracks.length), 0, 1);

        return {
            score: roundTo(avgScore),
            sameGenre: anySameGenre,
            sameAlbum: anySameAlbum,
            sameLanguage: anySameLanguage,
            subgenreOverlap: roundTo(maxSubgenreOverlap),
            eraSimilarity: roundTo(maxEraSim),
        };
    }

    /**
     * Computes BPM similarity including octave/half-time/double-time harmonic tempo matching
     * (e.g. 81 BPM and 162 BPM are harmonically locked in hip-hop/pop transitions).
     */
    function computeTempoHarmony(bpmA, bpmB) {
        const a = Number(bpmA) || 110;
        const b = Number(bpmB) || 110;
        const directDiff = Math.abs(a - b);
        const halfTimeDiff = Math.min(Math.abs(a * 2 - b), Math.abs(a - b * 2));

        const directSim = Math.exp(-(directDiff * directDiff) / (2 * 22 * 22));
        const harmonicSim = Math.exp(-(halfTimeDiff * halfTimeDiff) / (2 * 18 * 18)) * 0.88;
        return roundTo(clamp(Math.max(directSim, harmonicSim), 0, 1));
    }

    /**
     * 3. Audio Feature Vector Cosine Similarity + Tempo & Mood Tag Harmony [0..1]
     */
    function computeAudioFeatureSimilarity(candidate, seedTracks = [], storage = null) {
        if (!candidate || !Array.isArray(seedTracks) || seedTracks.length === 0) {
            return {
                score: 0.65,
                cosine: 0.65,
                featureProximity: 0.65,
                tempoHarmony: 0.65,
                moodOverlap: 0.5,
            };
        }

        const candVec = extractAudioFeatureVector(candidate, storage);
        const candMoods = new Set(
            (Array.isArray(candidate.moods) ? candidate.moods : [])
                .map(normalizeString)
                .filter(Boolean)
        );
        const candBpm = Number(candidate.bpm) || 110;

        let cosineSum = 0;
        let proximitySum = 0;
        let tempoSum = 0;
        let moodSum = 0;

        for (const seed of seedTracks) {
            if (!seed) continue;
            const seedVec = extractAudioFeatureVector(seed, storage);

            // Directional cosine similarity across the 8D audio feature space
            const cosSim = cosineSimilarity(candVec, seedVec);

            // Magnitude L1 proximity across key perceptual axes (energy, valence, danceability, acousticness, spectralCentroid)
            const axesWeights = [0.24, 0.20, 0.16, 0.16, 0.08, 0.05, 0.05, 0.06];
            let weightedDist = 0;
            for (let i = 0; i < candVec.length; i++) {
                weightedDist += Math.abs(candVec[i] - seedVec[i]) * (axesWeights[i] || 0.1);
            }
            const proximitySim = clamp(1 - weightedDist * 1.15, 0, 1);

            // Tempo harmony
            const tempoSim = computeTempoHarmony(candBpm, seed.bpm);

            // Mood tag overlap
            const seedMoods = new Set(
                (Array.isArray(seed.moods) ? seed.moods : [])
                    .map(normalizeString)
                    .filter(Boolean)
            );
            let sharedMoods = 0;
            for (const m of candMoods) {
                if (seedMoods.has(m)) sharedMoods++;
            }
            const minMoodLen = Math.max(1, Math.min(candMoods.size || 1, seedMoods.size || 1));
            const moodSim = clamp(sharedMoods / minMoodLen, 0, 1);

            cosineSum += cosSim;
            proximitySum += proximitySim;
            tempoSum += tempoSim;
            moodSum += moodSim;
        }

        const n = Math.max(1, seedTracks.length);
        const avgCosine = cosineSum / n;
        const avgProximity = proximitySum / n;
        const avgTempo = tempoSum / n;
        const avgMood = moodSum / n;

        // Combine directional cosine, perceptual distance proximity, tempo harmony, and mood overlap
        const combined =
            avgCosine * 0.32 +
            avgProximity * 0.34 +
            avgTempo * 0.16 +
            avgMood * 0.18;

        return {
            score: roundTo(clamp(combined, 0, 1)),
            cosine: roundTo(avgCosine),
            featureProximity: roundTo(avgProximity),
            tempoHarmony: roundTo(avgTempo),
            moodOverlap: roundTo(avgMood),
        };
    }

    /**
     * 4. Spotify-Style User Taste Affinity [0..1]
     * Pulls from `storage.computeTasteAffinity(trackId, now)` and blends with artist-level taste
     * (if the user has liked or repeatedly completed other songs by the candidate's artist)
     * plus catalog popularity prior.
     */
    function computeUserTasteScore(candidate, options = {}) {
        if (!candidate) {
            return {
                score: 0.5,
                trackAffinity: 0.5,
                artistTasteBoost: 0,
                liked: false,
                disliked: false,
                playCount: 0,
                avgCompletionRatio: 0,
                skipPenalty: 0,
            };
        }

        const storage = options.storage || null;
        const catalog = Array.isArray(options.catalog) ? options.catalog : [];
        const now = Number.isFinite(options.now) ? options.now : Date.now();
        const popularity = clamp(Number(candidate.popularity ?? 0.75), 0, 1);

        if (!storage || typeof storage.computeTasteAffinity !== "function") {
            const baseline = clamp(0.45 + popularity * 0.2, 0, 1);
            return {
                score: roundTo(baseline),
                trackAffinity: roundTo(baseline),
                artistTasteBoost: 0,
                liked: false,
                disliked: false,
                playCount: 0,
                avgCompletionRatio: 0,
                skipPenalty: 0,
            };
        }

        const affinity = storage.computeTasteAffinity(candidate.id, now);
        const stats =
            typeof storage.getTrackStats === "function"
                ? storage.getTrackStats(candidate.id)
                : { playCount: 0, avgCompletionRatio: 0, skipPenalty: 0, liked: false, disliked: false };

        if (stats.disliked) {
            return {
                score: roundTo(affinity.normalizedScore),
                trackAffinity: roundTo(affinity.normalizedScore),
                artistTasteBoost: 0,
                liked: false,
                disliked: true,
                playCount: stats.playCount || 0,
                avgCompletionRatio: stats.avgCompletionRatio || 0,
                skipPenalty: stats.skipPenalty || 0,
            };
        }

        // Artist-level taste generalization: if the user liked or completed other songs by this artist
        let artistTasteBoost = 0;
        const candArtists = new Set(getTrackArtists(candidate).map(normalizeString));
        if (catalog.length > 0 && candArtists.size > 0) {
            for (const other of catalog) {
                if (!other || other.id === candidate.id) continue;
                const otherArtists = getTrackArtists(other).map(normalizeString);
                if (!otherArtists.some((a) => candArtists.has(a))) continue;

                const otherStats = storage.getTrackStats(other.id);
                if (otherStats.liked) {
                    artistTasteBoost += 0.08;
                }
                if (otherStats.fullCompletions > 0 && otherStats.avgCompletionRatio >= 0.8) {
                    artistTasteBoost += 0.05;
                }
                if (otherStats.skipPenalty >= 0.35 && !otherStats.liked) {
                    artistTasteBoost -= 0.05;
                }
            }
        }
        artistTasteBoost = clamp(artistTasteBoost, -0.1, 0.14);

        // Mild popularity prior for unplayed tracks so well-loved tracks surface naturally
        const unplayedPrior = stats.playCount === 0 ? (popularity - 0.5) * 0.12 : 0;

        const combined = clamp(
            affinity.normalizedScore + artistTasteBoost + unplayedPrior,
            0,
            1
        );

        return {
            score: roundTo(combined),
            trackAffinity: roundTo(affinity.normalizedScore),
            artistTasteBoost: roundTo(artistTasteBoost),
            liked: Boolean(stats.liked),
            disliked: Boolean(stats.disliked),
            playCount: stats.playCount || 0,
            avgCompletionRatio: stats.avgCompletionRatio || 0,
            skipPenalty: affinity.skipPenalty || 0,
        };
    }

    /**
     * 5. Recency & Variety Anti-Repetition Penalty [0..0.75]
     * Penalizes:
     * - Tracks played very recently (exponential time decay + recent playback history index)
     * - Artist streak / saturation in the already-selected upcoming queue
     * - Same album or identical narrow genre cluster back-to-back saturation
     */
    function computeVarietyAndRecencyPenalty(candidate, options = {}) {
        if (!candidate) {
            return {
                penalty: 0,
                recencyPenalty: 0,
                artistFatiguePenalty: 0,
                albumClusterPenalty: 0,
            };
        }

        const storage = options.storage || null;
        const now = Number.isFinite(options.now) ? options.now : Date.now();
        const recentTrackIds = Array.isArray(options.recentTrackIds)
            ? options.recentTrackIds.map(String)
            : storage && typeof storage.getRecentlyPlayedTrackIds === "function"
              ? storage.getRecentlyPlayedTrackIds(10)
              : [];
        const queueContext = Array.isArray(options.queueContext) ? options.queueContext : [];

        // 1. Recency penalty from recentlyPlayed order & timestamp
        let recencyPenalty = 0;
        const recentIdx = recentTrackIds.indexOf(String(candidate.id));
        if (recentIdx !== -1) {
            // Position 0 (just played) => ~0.34 penalty, decaying with position
            recencyPenalty = Math.max(recencyPenalty, 0.34 * Math.pow(0.68, recentIdx));
        }

        if (storage && typeof storage.getTrackStats === "function") {
            const stats = storage.getTrackStats(candidate.id);
            if (stats && stats.lastPlayedAt && now >= stats.lastPlayedAt) {
                const minutesSincePlay = (now - stats.lastPlayedAt) / (1000 * 60);
                if (minutesSincePlay < 60) {
                    const timePenalty = 0.28 * Math.exp(-minutesSincePlay / 15);
                    recencyPenalty = Math.max(recencyPenalty, timePenalty);
                }
            }
        }

        // 2. Variety / anti-streak penalty relative to tracks already placed in the queue
        let artistFatiguePenalty = 0;
        let albumClusterPenalty = 0;

        if (queueContext.length > 0) {
            const candPrimary = normalizeString(candidate.primaryArtist);
            const candArtists = new Set(getTrackArtists(candidate).map(normalizeString));
            const candAlbum = normalizeString(candidate.album);
            const candGenre = normalizeString(candidate.genre);

            let sameArtistCount = 0;
            let sameAlbumCount = 0;

            for (let i = 0; i < queueContext.length; i++) {
                const prev = queueContext[i];
                if (!prev) continue;
                const distanceFromTail = queueContext.length - 1 - i; // 0 = immediately preceding track
                const prevPrimary = normalizeString(prev.primaryArtist);
                const prevArtists = getTrackArtists(prev).map(normalizeString);

                const sharesPrimaryArtist =
                    Boolean(candPrimary && candPrimary === prevPrimary);
                const sharesFeaturedArtist =
                    !sharesPrimaryArtist && prevArtists.some((a) => candArtists.has(a));

                if (sharesPrimaryArtist) {
                    sameArtistCount++;
                    if (distanceFromTail === 0) {
                        // Back-to-back same primary artist penalty
                        artistFatiguePenalty += 0.22;
                    } else if (distanceFromTail === 1) {
                        artistFatiguePenalty += 0.11;
                    } else {
                        artistFatiguePenalty += 0.05;
                    }
                } else if (sharesFeaturedArtist && distanceFromTail === 0 && queueContext.length > 1) {
                    // Only apply a mild collaborator fatigue penalty after the seed transition
                    artistFatiguePenalty += 0.04;
                }

                if (candAlbum && candAlbum === normalizeString(prev.album)) {
                    sameAlbumCount++;
                    albumClusterPenalty += distanceFromTail === 0 ? 0.14 : 0.06;
                } else if (distanceFromTail === 0 && candGenre && candGenre === normalizeString(prev.genre)) {
                    // Slight nudge for subgenre variety when several genres are available
                    albumClusterPenalty += 0.03;
                }
            }

            if (sameArtistCount >= 2) {
                artistFatiguePenalty += 0.08 * (sameArtistCount - 1);
            }
            if (sameAlbumCount >= 2) {
                albumClusterPenalty += 0.06;
            }
        }

        const totalPenalty = clamp(
            recencyPenalty + artistFatiguePenalty + albumClusterPenalty,
            0,
            0.75
        );

        return {
            penalty: roundTo(totalPenalty),
            recencyPenalty: roundTo(recencyPenalty),
            artistFatiguePenalty: roundTo(artistFatiguePenalty),
            albumClusterPenalty: roundTo(albumClusterPenalty),
        };
    }

    /**
     * 6. YT Music Dynamic Mix Mode Modifier & Mood Filter Alignment
     * Adjusts candidate score for active mix mode:
     * - `all`: balanced hybrid
     * - `familiar`: boosts liked tracks, played/completed favorites, and high-popularity tracks
     * - `discover`: boosts unplayed/low-play-count tracks and cross-artist/cross-genre exploration
     * - `deep-cuts`: boosts lower-popularity tracks, `"Deep Cuts"` mood tags, and niche subgenres
     * - `upbeat`: boosts high energy, high danceability, faster BPM, and `"Upbeat"`/`"Party"`/`"Energetic"` moods
     * - `chill`: boosts higher acousticness, lower/moderate energy, slower BPM, and `"Chill"`/`"Soulful"`/`"Romantic"` moods
     */
    function computeMixModeAdjustment(candidate, signals, options = {}) {
        const mode = normalizeString(options.mixMode || "all");
        const moodFilter = normalizeString(options.moodFilter || "all");
        const storage = options.storage || null;
        const effective =
            storage && typeof storage.getEffectiveAudioFeatures === "function"
                ? storage.getEffectiveAudioFeatures(candidate)
                : null;

        const energy = clamp(Number(effective?.energy ?? candidate.energy ?? 0.65), 0, 1);
        const valence = clamp(Number(effective?.valence ?? candidate.valence ?? 0.6), 0, 1);
        const danceability = clamp(Number(effective?.danceability ?? candidate.danceability ?? 0.65), 0, 1);
        const acousticness = clamp(Number(effective?.acousticness ?? candidate.acousticness ?? 0.25), 0, 1);
        const popularity = clamp(Number(candidate.popularity ?? 0.75), 0, 1);
        const bpm = Number(candidate.bpm || 110);
        const moods = new Set((Array.isArray(candidate.moods) ? candidate.moods : []).map(normalizeString));

        let delta = 0;

        if (mode === "familiar") {
            const familiarBonus =
                (signals.taste.liked ? 0.22 : 0) +
                Math.min(0.18, (signals.taste.playCount || 0) * 0.06) +
                (popularity - 0.7) * 0.35 +
                (signals.artist.score >= 0.75 ? 0.08 : 0);
            delta += familiarBonus;
        } else if (mode === "discover") {
            const playCount = signals.taste.playCount || 0;
            const unplayedBoost = playCount === 0 ? 0.22 : playCount === 1 ? 0.06 : -0.16;
            const differentPrimaryArtistBoost = signals.artist.score < 0.9 ? 0.10 : -0.14;
            const sonicBridgeBoost = signals.audio.score >= 0.6 ? 0.08 : 0;
            delta += unplayedBoost + differentPrimaryArtistBoost + sonicBridgeBoost;
        } else if (mode === "deep-cuts") {
            const hasDeepCutsTag = moods.has("deep cuts");
            // Lower popularity gets higher boost
            const rarityBoost = (0.92 - popularity) * 0.65;
            delta += (hasDeepCutsTag ? 0.22 : 0) + rarityBoost;
        } else if (mode === "upbeat") {
            const hasUpbeatMood =
                moods.has("upbeat") || moods.has("energetic") || moods.has("party") || moods.has("workout") || moods.has("hype");
            const energyDanceScore = energy * 0.55 + danceability * 0.30 + valence * 0.15;
            const tempoBoost = bpm >= 100 ? 0.08 : -0.08;
            delta += (energyDanceScore - 0.62) * 0.65 + (hasUpbeatMood ? 0.16 : -0.10) + tempoBoost;
        } else if (mode === "chill") {
            const hasChillMood =
                moods.has("chill") || moods.has("soulful") || moods.has("peaceful") || moods.has("romantic") || moods.has("late night");
            const chillFactor = acousticness * 0.50 + (1 - energy) * 0.35 + (bpm <= 102 ? 0.15 : 0);
            delta += (chillFactor - 0.45) * 0.65 + (hasChillMood ? 0.16 : -0.12);
        }

        // Optional active mood chip filter alignment
        if (moodFilter && moodFilter !== "all") {
            if (moods.has(moodFilter) || normalizeString(candidate.genre) === moodFilter) {
                delta += 0.15;
            } else {
                delta -= 0.12;
            }
        }

        return roundTo(clamp(delta, -0.45, 0.45));
    }

    /**
     * Generates human-readable explanation badges for UI tooltips / drawer insights.
     */
    function buildRecommendationReasons(candidate, signals, mixMode) {
        const reasons = [];
        const mode = normalizeString(mixMode || "all");
        const moods = Array.isArray(candidate.moods) ? candidate.moods : [];

        // Mode-specific primary reason when an explicit YT Music tuning mode is active
        if (mode === "familiar") {
            if (signals.taste.liked) {
                reasons.push("Familiar • Liked Song");
            } else if (signals.taste.playCount > 0 && signals.taste.avgCompletionRatio >= 0.75) {
                reasons.push("Familiar • High-completion favorite");
            } else if (signals.artist.score >= 0.75) {
                reasons.push(`Familiar • ${candidate.primaryArtist} favorite`);
            } else if ((candidate.popularity || 0) >= 0.85) {
                reasons.push("Familiar • Signature hit");
            }
        } else if (mode === "discover") {
            if (signals.taste.playCount === 0 && signals.artist.score < 0.75) {
                reasons.push("Discover • Fresh artist pick");
            } else if (signals.taste.playCount === 0) {
                reasons.push("Fresh discovery");
            } else if (signals.artist.score === 0) {
                reasons.push("Discover • Sonic bridge");
            }
        } else if (mode === "deep-cuts") {
            if (moods.includes("Deep Cuts")) {
                reasons.push("Deep Cut selection");
            } else if ((candidate.popularity || 1) <= 0.80) {
                reasons.push("Deep Cut • Hidden gem");
            }
        } else if (mode === "upbeat") {
            if ((candidate.energy || 0) >= 0.75 || moods.includes("Upbeat") || moods.includes("Energetic")) {
                reasons.push(`Upbeat • ${Math.round((candidate.energy || 0.75) * 100)}% energy`);
            }
        } else if (mode === "chill") {
            if ((candidate.acousticness || 0) >= 0.45 || moods.includes("Chill") || moods.includes("Soulful")) {
                reasons.push("Acoustic chill texture");
            }
        }

        if (signals.artist.matchType === "same-primary-artist") {
            reasons.push(`More from ${candidate.primaryArtist}`);
        } else if (
            signals.artist.matchType === "primary-featured-crossover" ||
            signals.artist.matchType === "shared-featured-artist"
        ) {
            reasons.push(`Features ${signals.artist.matchedArtist || candidate.primaryArtist}`);
        } else if (signals.artist.matchType === "collaborator-network") {
            reasons.push(`Collaborator network (${signals.artist.matchedArtist})`);
        }

        if (signals.cluster.sameGenre) {
            reasons.push(`${candidate.genre} vibe`);
        } else if (signals.cluster.subgenreOverlap >= 0.4) {
            reasons.push("Shared subgenre style");
        }

        if (signals.audio.score >= 0.78) {
            reasons.push(`High sonic match (${Math.round(signals.audio.score * 100)}%)`);
        } else if (signals.audio.tempoHarmony >= 0.85) {
            reasons.push(`Harmonic tempo (${candidate.bpm} BPM)`);
        }

        if (signals.taste.liked && !reasons.some((r) => r.includes("Liked"))) {
            reasons.push("In your Liked Songs");
        } else if (
            signals.taste.playCount > 0 &&
            signals.taste.avgCompletionRatio >= 0.85 &&
            !reasons.some((r) => r.includes("completion"))
        ) {
            reasons.push("High completion favorite");
        }

        if (reasons.length === 0) {
            reasons.push(`${candidate.genre || "Hybrid"} radio match`);
        }

        return reasons;
    }

    /**
     * Resolves any seed specification (single track, trackId, array of tracks, artist name,
     * album name, mood tag, or search query) into a concrete array of seed track objects.
     */
    function resolveSeedTracks(catalog = [], seedSpec = null) {
        if (!Array.isArray(catalog) || catalog.length === 0 || !seedSpec) return [];

        if (Array.isArray(seedSpec)) {
            return seedSpec
                .map((item) => {
                    if (item && typeof item === "object" && item.id) return item;
                    return catalog.find((t) => t.id === item || t.title === item) || null;
                })
                .filter(Boolean);
        }

        if (typeof seedSpec === "string") {
            const direct = catalog.find(
                (t) =>
                    t.id === seedSpec ||
                    normalizeString(t.title) === normalizeString(seedSpec)
            );
            if (direct) return [direct];

            const q = normalizeString(seedSpec);
            return catalog.filter(
                (t) =>
                    normalizeString(t.primaryArtist) === q ||
                    getTrackArtists(t).some((a) => normalizeString(a) === q) ||
                    normalizeString(t.album) === q ||
                    normalizeString(t.genre) === q ||
                    (Array.isArray(t.moods) && t.moods.some((m) => normalizeString(m) === q))
            );
        }

        if (typeof seedSpec === "object") {
            // Direct track object
            if (seedSpec.id && seedSpec.title) {
                return [seedSpec];
            }
            if (Array.isArray(seedSpec.seedTracks) && seedSpec.seedTracks.length > 0) {
                return resolveSeedTracks(catalog, seedSpec.seedTracks);
            }
            if (seedSpec.seedTrack) {
                return resolveSeedTracks(catalog, seedSpec.seedTrack);
            }
            if (seedSpec.trackId) {
                return resolveSeedTracks(catalog, seedSpec.trackId);
            }
            if (seedSpec.artist) {
                const targetArtist = normalizeString(seedSpec.artist);
                return catalog.filter((t) =>
                    getTrackArtists(t).some((a) => normalizeString(a) === targetArtist)
                );
            }
            if (seedSpec.album) {
                const targetAlbum = normalizeString(seedSpec.album);
                return catalog.filter((t) => normalizeString(t.album) === targetAlbum);
            }
            if (seedSpec.mood && normalizeString(seedSpec.mood) !== "all") {
                const targetMood = normalizeString(seedSpec.mood);
                return catalog.filter(
                    (t) =>
                        (Array.isArray(t.moods) && t.moods.some((m) => normalizeString(m) === targetMood)) ||
                        normalizeString(t.genre) === targetMood
                );
            }
            if (seedSpec.query) {
                const q = normalizeString(seedSpec.query);
                return catalog.filter((t) =>
                    [t.title, t.artistDisplay, t.album, t.genre, ...(t.moods || []), ...(t.subgenres || [])]
                        .filter(Boolean)
                        .join(" ")
                        .toLowerCase()
                        .includes(q)
                );
            }
        }

        return [];
    }

    /**
     * Core scoring function: computes the multi-signal recommendation breakdown and final score
     * for a single candidate track.
     */
    function scoreCandidate(candidate, context = {}) {
        if (!candidate) return null;

        const catalog = Array.isArray(context.catalog) ? context.catalog : [];
        const storage =
            context.storage !== undefined
                ? context.storage
                : globalScope && globalScope.SpotTubeStorage
                  ? globalScope.SpotTubeStorage
                  : null;
        const seedTracks = resolveSeedTracks(catalog, context.seedTracks || context.seedTrack || context.seed);
        const collaboratorGraph =
            context.collaboratorGraph || buildCollaboratorGraph(catalog);
        const mixMode = normalizeString(context.mixMode || "all");
        const weights = {
            ...DEFAULT_WEIGHTS,
            ...(context.weights && typeof context.weights === "object" ? context.weights : {}),
        };

        const artistSignal = computeArtistCollaboratorAffinity(
            candidate,
            seedTracks,
            collaboratorGraph
        );
        const clusterSignal = computeGenreAlbumEraCluster(candidate, seedTracks);
        const audioSignal = computeAudioFeatureSimilarity(candidate, seedTracks, storage);
        const tasteSignal = computeUserTasteScore(candidate, {
            storage,
            catalog,
            now: context.now,
        });
        const varietySignal = computeVarietyAndRecencyPenalty(candidate, {
            storage,
            now: context.now,
            recentTrackIds: context.recentTrackIds,
            queueContext: context.queueContext,
        });

        const signals = {
            artist: artistSignal,
            cluster: clusterSignal,
            audio: audioSignal,
            taste: tasteSignal,
            variety: varietySignal,
        };

        const mixModeDelta = computeMixModeAdjustment(candidate, signals, {
            mixMode,
            moodFilter: context.moodFilter,
            storage,
        });

        // Weighted base combination before penalties & mode adjustments
        const hasSeeds = seedTracks.length > 0;
        const baseScore = hasSeeds
            ? artistSignal.score * weights.artistAffinity +
              clusterSignal.score * weights.genreEraCluster +
              audioSignal.score * weights.audioSimilarity +
              tasteSignal.score * weights.tasteAffinity
            : audioSignal.score * 0.35 + tasteSignal.score * 0.65;

        // Disliked tracks are strongly suppressed even if audio/artist matches
        const dislikeSuppression = tasteSignal.disliked ? 0.55 : 0;

        const rawTotal =
            baseScore + mixModeDelta - varietySignal.penalty - dislikeSuppression;
        const totalScore = roundTo(clamp(rawTotal, 0, 1));

        const reasons = buildRecommendationReasons(candidate, signals, mixMode);

        return {
            trackId: candidate.id,
            track: candidate,
            totalScore,
            baseScore: roundTo(baseScore),
            mixMode,
            mixModeAdjustment: mixModeDelta,
            breakdown: {
                artistAffinity: artistSignal.score,
                artistMatchType: artistSignal.matchType,
                genreEraCluster: clusterSignal.score,
                audioSimilarity: audioSignal.score,
                audioCosine: audioSignal.cosine,
                tempoHarmony: audioSignal.tempoHarmony,
                moodOverlap: audioSignal.moodOverlap,
                tasteAffinity: tasteSignal.score,
                recencyPenalty: varietySignal.recencyPenalty,
                artistFatiguePenalty: varietySignal.artistFatiguePenalty,
                varietyPenalty: varietySignal.penalty,
                mixModeAdjustment: mixModeDelta,
            },
            reasons,
            primaryReason: reasons[0],
        };
    }

    /**
     * Ranks a pool of candidate tracks sequentially using greedy variety-aware selection
     * so that each chosen track updates the `queueContext` for subsequent candidates,
     * preventing artist/album clumping while preserving multi-signal relevance.
     *
     * @param {Array} catalog - Full track catalog
     * @param {Object} options
     * @param {Object|Array|string} [options.seed] - Track, trackId, array of tracks, or seed descriptor
     * @param {Object} [options.seedTrack] - Alias for single seed track
     * @param {Array} [options.seedTracks] - Alias for multiple seed tracks
     * @param {Array<string>} [options.excludeTrackIds] - Track IDs to exclude (e.g. currently playing track)
     * @param {boolean} [options.includeSeedTracks=false] - Whether seed tracks themselves can appear in results
     * @param {string} [options.mixMode="all"] - YT Music dynamic tuning mode
     * @param {string} [options.moodFilter="All"] - Optional mood filter
     * @param {number} [options.limit] - Max tracks to return
     * @param {Object} [options.storage] - SpotTubeStorage instance
     * @returns {Array<Object>} Ranked recommendation objects `{ trackId, track, totalScore, breakdown, reasons, primaryReason }`
     */
    function rankCandidates(catalog = [], options = {}) {
        if (!Array.isArray(catalog) || catalog.length === 0) return [];

        const storage =
            options.storage !== undefined
                ? options.storage
                : globalScope && globalScope.SpotTubeStorage
                  ? globalScope.SpotTubeStorage
                  : null;

        const seedTracks = resolveSeedTracks(
            catalog,
            options.seedTracks || options.seedTrack || options.seed
        );
        const seedIds = new Set(seedTracks.map((t) => String(t.id)));
        const excludeSet = new Set((options.excludeTrackIds || []).map(String));

        if (!options.includeSeedTracks) {
            for (const id of seedIds) {
                excludeSet.add(id);
            }
        }

        const collaboratorGraph =
            options.collaboratorGraph || buildCollaboratorGraph(catalog);

        const remainingPool = catalog.filter((t) => t && !excludeSet.has(String(t.id)));
        const targetCount = Number.isFinite(options.limit)
            ? Math.max(0, Math.min(options.limit, remainingPool.length))
            : remainingPool.length;

        // Seed the initial queueContext with the last seed track so the very first recommendation
        // immediately respects back-to-back variety rules if other strong candidates exist.
        const rollingQueueContext = Array.isArray(options.queueContext)
            ? options.queueContext.slice()
            : seedTracks.length > 0
              ? [seedTracks[0]]
              : [];

        const selected = [];
        const available = remainingPool.slice();

        while (selected.length < targetCount && available.length > 0) {
            let bestIdx = 0;
            let bestScored = null;

            for (let i = 0; i < available.length; i++) {
                const candidate = available[i];
                const scored = scoreCandidate(candidate, {
                    ...options,
                    catalog,
                    storage,
                    seedTracks,
                    collaboratorGraph,
                    queueContext: rollingQueueContext,
                });

                if (
                    !bestScored ||
                    scored.totalScore > bestScored.totalScore ||
                    (scored.totalScore === bestScored.totalScore &&
                        (candidate.popularity || 0) > (bestScored.track.popularity || 0))
                ) {
                    bestScored = scored;
                    bestIdx = i;
                }
            }

            const [chosenTrack] = available.splice(bestIdx, 1);
            selected.push(bestScored);
            rollingQueueContext.push(chosenTrack);
        }

        return selected;
    }

    /**
     * Convenience helper that returns the ordered array of recommended `track` objects
     * (with `.recommendation` metadata attached non-destructively).
     */
    function recommendTracks(catalog = [], options = {}) {
        const ranked = rankCandidates(catalog, options);
        return ranked.map((entry) => ({
            ...entry.track,
            recommendation: {
                totalScore: entry.totalScore,
                breakdown: entry.breakdown,
                reasons: entry.reasons,
                primaryReason: entry.primaryReason,
                mixMode: entry.mixMode,
            },
        }));
    }

    /**
     * Finds the top N tracks in the user's library most similar to a reference track,
     * used for Detail Views ("Similar in Your Library") and Track Info panels.
     */
    function getSimilarTracks(catalog = [], referenceTrackOrId, options = {}) {
        return recommendTracks(catalog, {
            ...options,
            seed: referenceTrackOrId,
            includeSeedTracks: false,
            limit: options.limit || 6,
        });
    }

    /**
     * Computes live aggregate vibe & tuning telemetry for an upcoming queue of tracks
     * so the Up Next drawer can display real-time feedback when switching YT Music tuning chips.
     */
    function computeQueueVibeMetrics(tracks = [], options = {}) {
        const list = Array.isArray(tracks)
            ? tracks.map((item) => (item && item.track ? item.track : item)).filter(Boolean)
            : [];
        const mixMode = normalizeString(options.mixMode || "all");
        const profile = getMixModeProfile(mixMode);
        const storage =
            options.storage !== undefined
                ? options.storage
                : globalScope && globalScope.SpotTubeStorage
                  ? globalScope.SpotTubeStorage
                  : null;

        if (list.length === 0) {
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

        let bpmSum = 0;
        let energySum = 0;
        let acousticSum = 0;
        let popSum = 0;
        let unplayedCount = 0;
        let familiarCount = 0;
        let deepCutsCount = 0;

        for (const t of list) {
            bpmSum += Number(t.bpm || 110);
            energySum += Number(t.energy ?? 0.65);
            acousticSum += Number(t.acousticness ?? 0.25);
            popSum += Number(t.popularity ?? 0.75);

            const stats =
                storage && typeof storage.getTrackStats === "function"
                    ? storage.getTrackStats(t.id)
                    : null;
            const playCount = stats ? stats.playCount || 0 : 0;
            const liked = stats ? Boolean(stats.liked) : false;

            if (playCount === 0) {
                unplayedCount++;
            }
            if (liked || playCount > 0 || Number(t.popularity ?? 0) >= 0.85) {
                familiarCount++;
            }
            if (
                (Array.isArray(t.moods) && t.moods.includes("Deep Cuts")) ||
                Number(t.popularity ?? 1) <= 0.78
            ) {
                deepCutsCount++;
            }
        }

        const n = list.length;
        const avgBpm = Math.round(bpmSum / n);
        const avgEnergyPct = Math.round((energySum / n) * 100);
        const avgAcousticPct = Math.round((acousticSum / n) * 100);
        const avgPopularityPct = Math.round((popSum / n) * 100);
        const discoveryRatioPct = Math.round((unplayedCount / n) * 100);

        let summaryText = `${profile.shortLabel} • ${avgEnergyPct}% Energy • ${avgBpm} BPM`;
        if (profile.id === "upbeat") {
            summaryText = `Upbeat • Avg ${avgEnergyPct}% Energy • ${avgBpm} BPM`;
        } else if (profile.id === "chill") {
            summaryText = `Chill • Avg ${avgAcousticPct}% Acoustic • ${avgBpm} BPM`;
        } else if (profile.id === "deep-cuts") {
            summaryText = `Deep Cuts • ${deepCutsCount} hidden gems • ${avgPopularityPct}% avg pop`;
        } else if (profile.id === "discover") {
            summaryText = `Discover • ${discoveryRatioPct}% fresh / unplayed picks`;
        } else if (profile.id === "familiar") {
            summaryText = `Familiar • ${familiarCount} favorites & signature hits`;
        } else {
            summaryText = `Balanced Hybrid • ${avgEnergyPct}% Energy • ${avgBpm} BPM`;
        }

        return {
            mixMode: profile.id,
            profile,
            trackCount: n,
            avgBpm,
            avgEnergyPct,
            avgAcousticPct,
            avgPopularityPct,
            discoveryRatioPct,
            familiarCount,
            deepCutsCount,
            summaryText,
        };
    }

    return {
        DEFAULT_WEIGHTS,
        VALID_MIX_MODES,
        MIX_MODE_PROFILES,
        getMixModeProfile,
        computeQueueVibeMetrics,
        getTrackArtists,
        buildCollaboratorGraph,
        cosineSimilarity,
        extractAudioFeatureVector,
        computeArtistCollaboratorAffinity,
        computeGenreAlbumEraCluster,
        computeTempoHarmony,
        computeAudioFeatureSimilarity,
        computeUserTasteScore,
        computeVarietyAndRecencyPenalty,
        computeMixModeAdjustment,
        resolveSeedTracks,
        scoreCandidate,
        rankCandidates,
        recommendTracks,
        getSimilarTracks,
    };
});
