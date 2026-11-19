let currentSong = new Audio();
let songs = [];
let currentTrackIndex = 0;

// 3-Pane Hybrid Shell State
let activeMoodFilter = "All";
let activeSearchQuery = "";
let activeLibraryFilter = "all";
let activeMixMode = "all";
let isDrawerOpen = true;
let activeDrawerTab = "up-next";
const likedTrackIds = new Set();
let activePlaybackTrackId = null;
let isShuffle = false;
let isRepeat = false;
let crossfadeSeconds = 0;
let isShortcutsModalOpen = false;
let playerEngineInstance = null;
let activeView = "home";
let activeDetail = null;
let activeSearchCategory = "all";
let activeSearchResults = null;
let activeHomeShelvesData = null;
const COLLECTION_DETAIL_TYPES = ["playlist", "liked", "local"];

function getStorage() {
    if (typeof window !== "undefined" && window.SpotTubeStorage) {
        return window.SpotTubeStorage;
    }
    if (typeof globalThis !== "undefined" && globalThis.SpotTubeStorage) {
        return globalThis.SpotTubeStorage;
    }
    return null;
}

function getRecommender() {
    if (typeof window !== "undefined" && window.SpotTubeRecommender) {
        return window.SpotTubeRecommender;
    }
    if (typeof globalThis !== "undefined" && globalThis.SpotTubeRecommender) {
        return globalThis.SpotTubeRecommender;
    }
    return null;
}

function getQueueManager() {
    if (typeof window !== "undefined" && window.SpotTubeQueue) {
        return window.SpotTubeQueue;
    }
    if (typeof globalThis !== "undefined" && globalThis.SpotTubeQueue) {
        return globalThis.SpotTubeQueue;
    }
    return null;
}

function getPlayerModule() {
    if (typeof window !== "undefined" && window.SpotTubePlayer) {
        return window.SpotTubePlayer;
    }
    if (typeof globalThis !== "undefined" && globalThis.SpotTubePlayer) {
        return globalThis.SpotTubePlayer;
    }
    return null;
}

function getPlayerEngine() {
    if (playerEngineInstance) return playerEngineInstance;
    const mod = getPlayerModule();
    if (!mod || typeof mod.createPlayerEngine !== "function") return null;

    playerEngineInstance = mod.createPlayerEngine({
        primaryAudio: currentSong,
        storage: getStorage(),
        getQueueManager,
        crossfadeSeconds,
        minQueueSize: 3,
        // Item 14: linked (no-copy) tracks get their blob: URL from the folder at play time
        resolveTrackUrl: (track, ctx = {}) => resolveTrackAudioUrl(track, { request: ctx.reason === "play" && ctx.userInitiated !== false }),
        onTrackUnavailable: (track) => handleUnavailableTrack(track),
        onTrackChange(nextTrack, detail = {}) {
            if (detail.activeDeck) {
                currentSong = detail.activeDeck;
            }
            if (nextTrack) {
                currentTrackIndex = resolveTrackIndex(nextTrack);
                activePlaybackTrackId = detail.paused ? null : nextTrack.id;
                updatePlaybarTrackMeta(nextTrack);
                updatePlayButtonIcon(Boolean(detail.paused));
                syncActiveTrackUI();
            }
        },
        onRequestNextTrack({ shuffle, repeat }) {
            const qm = getQueueManager();
            if (qm && typeof qm.advanceNext === "function") {
                ensureQueueCatalogSynced();
                return qm.advanceNext({ shuffle, repeat });
            }
            if (!songs.length) return null;
            const nextIdx = (currentTrackIndex + 1) % songs.length;
            return songs[nextIdx];
        },
        onRequestPreviousTrack() {
            const qm = getQueueManager();
            if (qm && typeof qm.previous === "function") {
                ensureQueueCatalogSynced();
                return qm.previous();
            }
            if (!songs.length) return null;
            const prevIdx = (currentTrackIndex - 1 + songs.length) % songs.length;
            return songs[prevIdx];
        },
    });

    crossfadeSeconds = playerEngineInstance.getCrossfadeSeconds();
    return playerEngineInstance;
}

function announceQueueStatus(message) {
    const statusEl = document.getElementById("queue-live-status");
    if (!statusEl || !message) return;
    statusEl.textContent = String(message);
}

function announceSearchStatus(message) {
    const statusEl = document.getElementById("search-live-status");
    if (!statusEl || !message) return;
    statusEl.textContent = String(message);
}

function hydrateFromStorage() {
    const store = getStorage();
    if (!store) return;

    likedTrackIds.clear();
    for (const id of store.getLikedTrackIds()) {
        likedTrackIds.add(id);
    }

    if (typeof store.getPreferences === "function") {
        const prefs = store.getPreferences();
        if (Number.isFinite(prefs?.crossfadeSeconds)) {
            crossfadeSeconds = Math.max(0, Math.min(12, Math.round(prefs.crossfadeSeconds)));
        }
    }

    const likedCountEl = document.getElementById("lib-liked-count");
    if (likedCountEl) {
        likedCountEl.textContent =
            likedTrackIds.size > 0
                ? `Auto-playlist • ${likedTrackIds.size} liked`
                : "Auto-playlist • Pin";
    }
}

// Simple Navigation History Stack for Top Navbar Back/Forward Buttons
const navHistory = [{ view: "home", detail: null, mood: "All", query: "", title: "Spotify Playlists" }];
let navHistoryIndex = 0;
let isRestoringHistory = false;

function secondsToMinutesSeconds(seconds) {
    if (isNaN(seconds) || seconds < 0) {
        return "0:00";
    }
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = Math.floor(seconds % 60);
    const formattedSeconds = String(remainingSeconds).padStart(2, "0");

    return `${minutes}:${formattedSeconds}`;
}

/**
 * Loads the static-first `tracks.json` manifest using a relative path so it works
 * identically on Vercel, GitHub Pages, or any local port (e.g. port 5500) without
 * hardcoded loopback URLs. Falls back to relative `./songs/` directory listing
 * only if `tracks.json` is unavailable.
 */
async function getSongs() {
    let baseTracks = [];
    try {
        const res = await fetch("./tracks.json");
        if (res.ok) {
            const manifest = await res.json();
            const tracks = Array.isArray(manifest) ? manifest : (manifest.tracks || []);
            window.TRACK_CATALOG = manifest;
            if (tracks.length > 0) {
                baseTracks = tracks.slice();
            }
        }
    } catch (err) {
        console.warn("Static tracks.json fetch failed, attempting relative /songs/ fallback:", err);
    }

    if (baseTracks.length === 0) {
        // Fallback for unindexed local directory listing using relative path
        const res = await fetch("./songs/");
        const html = await res.text();
        const div = document.createElement("div");
        div.innerHTML = html;
        const anchors = div.getElementsByTagName("a");

        for (let i = 0; i < anchors.length; i++) {
            const href = anchors[i].getAttribute("href") || "";
            if (href.toLowerCase().endsWith(".mp3")) {
                const rawFile = decodeURIComponent(href.split("/").pop());
                const [rawTitle, rawArtistPart = "Unknown Artist"] = rawFile.replace(/\.mp3$/i, "").split("-");
                const title = rawTitle.trim();
                const artistDisplay = rawArtistPart.trim();
                baseTracks.push({
                    id: `${title}-${artistDisplay}`.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
                    filename: rawFile,
                    title,
                    primaryArtist: artistDisplay.split(",")[0].trim(),
                    artists: artistDisplay.split(",").map((s) => s.trim()),
                    artistDisplay,
                    album: `${title} (Single)`,
                    year: 2024,
                    duration: 0,
                    durationFormatted: "0:00",
                    audioUrl: `songs/${encodeURIComponent(rawFile)}`,
                    coverUrl: `Images/${encodeURIComponent(title)}.jpeg`,
                    genre: "Pop",
                    language: "English",
                    moods: ["Chill"],
                    bpm: 110,
                    energy: 0.65,
                    valence: 0.6,
                    danceability: 0.65,
                    acousticness: 0.3,
                    popularity: 0.75,
                });
            }
        }
    }

    // Merge any IndexedDB user-imported local audio tracks
    const store = getStorage();
    if (store && typeof store.getImportedTracks === "function") {
        try {
            const imported = await store.getImportedTracks();
            if (Array.isArray(imported) && imported.length > 0) {
                const existingIds = new Set(baseTracks.map((t) => t.id));
                for (const imp of imported) {
                    if (!existingIds.has(imp.id)) {
                        useDisplayCover(imp);
                        baseTracks.push(imp);
                        existingIds.add(imp.id);
                    }
                }
            }
        } catch (err) {
            console.warn("Failed to hydrate IndexedDB imported tracks:", err);
        }
    }

    return baseTracks;
}

function resolveTrackIndex(trackOrIndex) {
    if (typeof trackOrIndex === "number") {
        return Math.max(0, Math.min(songs.length - 1, trackOrIndex));
    }
    if (trackOrIndex && typeof trackOrIndex === "object") {
        const idx = songs.findIndex((t) => t.id === trackOrIndex.id || t.filename === trackOrIndex.filename);
        return idx !== -1 ? idx : 0;
    }
    if (typeof trackOrIndex === "string") {
        const idx = songs.findIndex(
            (t) => t.id === trackOrIndex || t.filename === trackOrIndex || t.title === trackOrIndex
        );
        return idx !== -1 ? idx : 0;
    }
    return 0;
}

const PAUSE_SVG = `<svg data-encore-id="pause" role="img" aria-hidden="true" viewBox="0 0 16 16" class="Svg-sc-ytk21e-0 dYnaPI"><path d="M3 1.713a.7.7 0 0 1 1.05-.607l10.89 6.288a.7.7 0 0 1 0 1.212L4.05 14.894A.7.7 0 0 1 3 14.288V1.713z"></path></svg>`;
const PLAY_SVG = `<svg data-encore-id="icon" role="play" aria-hidden="true" viewBox="0 0 16 16" class="Svg-sc-ytk21e-0 dYnaPI"><path d="M2.7 1a.7.7 0 0 0-.7.7v12.6a.7.7 0 0 0 .7.7h2.6a.7.7 0 0 0 .7-.7V1.7a.7.7 0 0 0-.7-.7H2.7zm8 0a.7.7 0 0 0-.7.7v12.6a.7.7 0 0 0 .7.7h2.6a.7.7 0 0 0 .7-.7V1.7a.7.7 0 0 0-.7-.7h-2.6z"></path></svg>`;

function updatePlayButtonIcon(isPaused) {
    const playBtn = document.getElementById("play");
    if (!playBtn) return;
    playBtn.innerHTML = isPaused ? PAUSE_SVG : PLAY_SVG;
}

function syncActiveTrackUI() {
    const track = songs[currentTrackIndex];
    if (!track) return;

    // 1. Highlight active track card in main grid
    document.querySelectorAll(".spotify-playlist .card").forEach((card) => {
        card.classList.toggle("active-track", card.dataset.trackId === track.id);
    });

    // 2. Highlight active item in Left Library Sidebar
    document.querySelectorAll("#library-tracks-list .library-item").forEach((item) => {
        item.classList.toggle("active", item.dataset.trackId === track.id);
    });

    // 3. Update Playbar metadata badge & Like button state
    const metaBadge = document.getElementById("playbar-meta-badge");
    if (metaBadge) {
        const genre = track.genre || "Music";
        const bpm = track.bpm ? `${track.bpm} BPM` : "";
        metaBadge.textContent = bpm ? `${genre} • ${bpm}` : genre;
    }

    const likeBtn = document.getElementById("like-btn");
    if (likeBtn) {
        const isLiked = likedTrackIds.has(track.id);
        likeBtn.classList.toggle("liked", isLiked);
        likeBtn.setAttribute("aria-pressed", String(isLiked));
    }

    // 4. Update Right Drawer Now Playing, Up Next Queue, Track Info panel, and Home Smart Shelves
    renderDrawerNowPlaying(track);
    renderDrawerQueue();
    renderDrawerTrackInfo(track);
    renderHomeShelves();
    syncCrossfadeUI();

    // 5. Highlight active track rows/cards if Detail View or Omni-Search View is currently open
    if (activeView === "detail" && activeDetail) {
        document.querySelectorAll("#detail-view [data-track-id]").forEach((row) => {
            row.classList.toggle("active-track", row.dataset.trackId === track.id);
        });
    }
    if (activeView === "search") {
        document.querySelectorAll("#search-view [data-track-id]").forEach((row) => {
            row.classList.toggle("active-track", row.dataset.trackId === track.id);
        });
    }
}

function updatePlaybarTrackMeta(track) {
    if (!track) return;
    const titleEl = document.getElementsByClassName("song-title")[0];
    const artistEl = document.getElementsByClassName("artist-names")[0];
    const coverEl = document.getElementsByClassName("album-cover")[0];
    const currentTimeEl = document.getElementsByClassName("current-time")[0];
    const totalTimeEl = document.getElementsByClassName("total-time")[0];

    if (titleEl) titleEl.textContent = track.title;
    if (artistEl) artistEl.textContent = track.artistDisplay;
    if (coverEl) coverEl.src = track.coverUrl;
    if (currentTimeEl) currentTimeEl.textContent = "0:00";
    if (totalTimeEl) totalTimeEl.textContent = track.durationFormatted || "0:00";
}

const playMusic = (trackOrIndex, pause = false, options = {}) => {
    if (!songs || songs.length === 0) return;

    const store = getStorage();
    const qm = getQueueManager();
    const pe = getPlayerEngine();
    const prevTrack = songs.find((t) => t.id === activePlaybackTrackId);
    const nextIndex = resolveTrackIndex(trackOrIndex);
    const track = songs[nextIndex];
    if (!track) return;

    // Record telemetry outcome (skip or completion) for previous active playback session
    if (
        store &&
        prevTrack &&
        activePlaybackTrackId &&
        !options.skipTelemetryOutcome &&
        Number.isFinite(currentSong.currentTime) &&
        currentSong.currentTime >= 0.75
    ) {
        const prevDuration =
            Number.isFinite(currentSong.duration) && currentSong.duration > 0
                ? currentSong.duration
                : prevTrack.duration || 180;
        store.recordPlaybackOutcome(prevTrack.id, {
            listenedSeconds: currentSong.currentTime,
            durationSeconds: prevDuration,
            endedNaturally: false,
        });
    }

    currentTrackIndex = nextIndex;

    // Synchronize the live queue manager unless playMusic was invoked by startRadioMix or queue advance
    if (qm && !options.skipQueueSync) {
        qm.setCurrentTrack(track, {
            catalog: getQueueCatalog(),
            regenerateMix: true,
            preserveManual: true,
            silent: true,
        });
    }

    if (pe) {
        if (options.crossfade && crossfadeSeconds > 0 && !pause) {
            pe.beginCrossfade(track, {
                durationSeconds: options.crossfadeDuration ?? crossfadeSeconds,
            });
            currentSong = pe.getActiveDeck();
            return;
        }
        pe.loadAndPlayTrack(track, {
            pause,
            autoplay: !pause,
            useStandbyDeck: Boolean(options.useStandbyDeck),
        });
        currentSong = pe.getActiveDeck();
        return;
    }

    if (track.storageMode === "linked" && !track.audioUrl) {
        resolveTrackAudioUrl(track, { request: true }).then((url) => {
            if (url) playMusic(track, pause, options);
            else handleUnavailableTrack(track);
        });
        return;
    }
    currentSong.src = track.audioUrl;
    if (!pause) {
        activePlaybackTrackId = track.id;
        if (store) {
            store.recordPlayStart(track.id);
        }
        const playPromise = currentSong.play();
        if (playPromise && typeof playPromise.catch === "function") {
            playPromise.catch(() => {});
        }
        updatePlayButtonIcon(false);
    } else {
        activePlaybackTrackId = null;
        updatePlayButtonIcon(true);
    }

    updatePlaybarTrackMeta(track);
    syncActiveTrackUI();
};

/**
 * Universal "Start Mix" Radio Generator entry point:
 * Starts a nonstop radio mix from any single track, artist, album, mood chip,
 * active search result set, or full-catalog Supermix.
 */
function startRadioMix(seedSpec = null, options = {}) {
    if (!songs.length) return null;

    const qm = getQueueManager();
    if (options.openDrawer !== false) {
        toggleRightDrawer(true);
        switchDrawerTab("up-next");
    }

    if (qm && typeof qm.startMix === "function") {
        const result = qm.startMix(seedSpec, {
            catalog: getQueueCatalog(),
            mixMode: options.mixMode || activeMixMode,
            moodFilter: options.moodFilter || activeMoodFilter,
            keepCurrentTrack: Boolean(options.keepCurrentTrack),
            preserveManual: Boolean(options.preserveManual),
            startTrack: options.startTrack,
        });

        if (result.currentTrack) {
            playMusic(result.currentTrack.id, Boolean(options.pause), {
                skipQueueSync: true,
            });
        } else {
            renderDrawerQueue();
        }

        if (result.mixSession) {
            announceQueueStatus(
                `Started ${result.mixSession.badge}: ${result.mixSession.label} (${result.queue.length} upcoming tracks)`
            );
        }
        return result;
    }

    // Fallback when queue.js is not loaded
    const filtered = getFilteredSongs();
    const targetTrack =
        (seedSpec && typeof seedSpec === "object" && seedSpec.id ? seedSpec : null) ||
        (filtered.length > 0 ? filtered[0] : songs[currentTrackIndex]);
    if (targetTrack) {
        playMusic(targetTrack.id, Boolean(options.pause));
    }
    return {
        currentTrack: targetTrack,
        queue: getUpcomingQueueTracks(),
    };
}

function playTrackNext(trackOrIndex, options = {}) {
    if (!songs.length) return null;
    const idx = resolveTrackIndex(trackOrIndex);
    const track = songs[idx];
    if (!track) return null;

    const qm = getQueueManager();
    if (!qm) return null;

    ensureQueueCatalogSynced();
    const entry = qm.playNext(track, options);
    renderDrawerQueue();
    announceQueueStatus(`Queued ${track.title} by ${track.primaryArtist} to Play Next`);
    return entry;
}

function addTrackToQueue(trackOrIndex, options = {}) {
    if (!songs.length) return null;
    const idx = resolveTrackIndex(trackOrIndex);
    const track = songs[idx];
    if (!track) return null;

    const qm = getQueueManager();
    if (!qm) return null;

    ensureQueueCatalogSynced();
    const entry = qm.addToQueue(track, options);
    renderDrawerQueue();
    announceQueueStatus(`Added ${track.title} by ${track.primaryArtist} to Queue`);
    return entry;
}

function removeTrackFromQueue(target) {
    const qm = getQueueManager();
    if (!qm) return null;

    const removed = qm.removeFromQueue(target);
    if (removed) {
        renderDrawerQueue();
        announceQueueStatus(`Removed ${removed.track?.title || "track"} from queue`);
    }
    return removed;
}

function reorderQueueItems(fromIndex, toIndex) {
    const qm = getQueueManager();
    if (!qm) return [];

    const updated = qm.reorderQueue(fromIndex, toIndex);
    renderDrawerQueue();
    const movedTrack = updated[toIndex]?.track;
    if (movedTrack) {
        announceQueueStatus(
            `Moved ${movedTrack.title} to position ${toIndex + 1} of ${updated.length} in queue`
        );
    }
    return updated;
}

function moveQueueItemUp(target) {
    const qm = getQueueManager();
    if (!qm) return [];
    const updated = qm.moveUp(target);
    renderDrawerQueue();
    return updated;
}

function moveQueueItemDown(target) {
    const qm = getQueueManager();
    if (!qm) return [];
    const updated = qm.moveDown(target);
    renderDrawerQueue();
    return updated;
}

function playNextFromQueue(options = {}) {
    if (!songs.length) return null;
    const qm = getQueueManager();
    if (qm) {
        ensureQueueCatalogSynced();
        const nextTrack = qm.advanceNext(options);
        if (nextTrack) {
            playMusic(nextTrack.id, Boolean(options.pause), { skipQueueSync: true });
            return nextTrack;
        }
    }
    const nextIndex = (currentTrackIndex + 1) % songs.length;
    playMusic(nextIndex, Boolean(options.pause));
    return songs[nextIndex];
}

function playPreviousFromQueue(options = {}) {
    if (!songs.length) return null;
    const qm = getQueueManager();
    if (qm) {
        ensureQueueCatalogSynced();
        const prevTrack = qm.previous();
        if (prevTrack) {
            playMusic(prevTrack.id, Boolean(options.pause), { skipQueueSync: true });
            return prevTrack;
        }
    }
    const prevIndex = (currentTrackIndex - 1 + songs.length) % songs.length;
    playMusic(prevIndex, Boolean(options.pause));
    return songs[prevIndex];
}

function ensureQueueCatalogSynced() {
    const qm = getQueueManager();
    if (!qm || !songs.length) return;
    const state = qm.getState();
    const activeTrack = songs[currentTrackIndex] || songs[0];

    if (!state.catalog || state.catalog.length !== getQueueCatalog().length) {
        qm.setCatalog(getQueueCatalog(), { rebuildQueue: false, silent: true });
        qm.setCurrentTrack(activeTrack, {
            catalog: getQueueCatalog(),
            regenerateMix: true,
            recordHistory: false,
            silent: true,
        });
    } else if (!state.currentTrack || state.currentTrack.id !== activeTrack.id) {
        qm.setCurrentTrack(activeTrack, {
            catalog: getQueueCatalog(),
            regenerateMix: true,
            recordHistory: false,
            silent: true,
        });
    }
}

function getFilteredSongs() {
    return songs.filter((track) => {
        const matchesMood =
            activeMoodFilter === "All" ||
            (Array.isArray(track.moods) &&
                track.moods.some((m) => m.toLowerCase() === activeMoodFilter.toLowerCase())) ||
            (track.genre && track.genre.toLowerCase() === activeMoodFilter.toLowerCase()) ||
            (track.language && track.language.toLowerCase() === activeMoodFilter.toLowerCase());

        if (!matchesMood) return false;

        if (!activeSearchQuery) return true;
        const q = activeSearchQuery.trim().toLowerCase();
        if (!q) return true;
        const tokens = q.split(/\s+/).filter(Boolean);
        const haystacks = [
            track.title,
            track.artistDisplay,
            ...(Array.isArray(track.artists) ? track.artists : []),
            ...(Array.isArray(track.featuredArtists) ? track.featuredArtists : []),
            track.album,
            track.genre,
            track.language,
            track.year ? String(track.year) : "",
            ...(track.moods || []),
            ...(track.subgenres || []),
        ]
            .filter(Boolean)
            .join(" ")
            .toLowerCase();
        if (haystacks.includes(q)) return true;
        return tokens.length > 1 && tokens.every((token) => haystacks.includes(token));
    });
}

function renderCatalogGrid() {
    const songDiv = document.querySelector(".spotify-playlist");
    if (!songDiv) return;

    const filteredTracks = getFilteredSongs();

    const sectionTitle = document.getElementById("catalog-section-title");
    const countBadge = document.getElementById("catalog-count-badge");
    const statTrackCount = document.getElementById("stat-track-count");
    const statActiveMood = document.getElementById("stat-active-mood");

    if (sectionTitle) {
        if (activeSearchQuery) {
            sectionTitle.textContent = `Results for "${activeSearchQuery}"`;
        } else if (activeMoodFilter !== "All") {
            sectionTitle.textContent = `${activeMoodFilter} Mix`;
        } else {
            sectionTitle.textContent = "Spotify Playlists";
        }
    }

    if (countBadge) {
        countBadge.textContent = `${filteredTracks.length} ${filteredTracks.length === 1 ? "track" : "tracks"}`;
    }
    if (statTrackCount) {
        statTrackCount.textContent = String(filteredTracks.length);
    }
    if (statActiveMood) {
        statActiveMood.textContent = activeMoodFilter === "All" ? "All Vibes" : activeMoodFilter;
    }

    const activeTrack = songs[currentTrackIndex];
    const makeCard = (track) => {
        const fullIdx = resolveTrackIndex(track);
        const card = document.createElement("div");
        card.classList.add("card");
        if (activeTrack && activeTrack.id === track.id) {
            card.classList.add("active-track");
        }
        card.dataset.trackId = track.id;
        card.dataset.trackIndex = String(fullIdx);
        card.dataset.artist = track.primaryArtist;
        card.dataset.album = track.album;
        card.innerHTML = `<div class="card-media"><img alt="${track.title}"></div>
                        <div class="play"><button type="button" class="card-play-btn" aria-label="Play ${track.title}"><svg data-encore-id="icon" role="img" aria-hidden="true" viewBox="0 0 24 24" class="Svg-sc-ytk21e-0 bneLcE"><path d="m7.05 3.606 13.49 7.788a.7.7 0 0 1 0 1.212L7.05 20.394A.7.7 0 0 1 6 19.788V4.212a.7.7 0 0 1 1.05-.606z"></path></svg></button>
                        </div>
                        <div class="info">
                            <h4 title="View Song Details: ${track.title}"></h4>
                            <p title="View Artist Profile: ${track.primaryArtist}"></p>
                        </div>
                        <div class="card-badges">
                            <span class="card-badge-pill" data-open-album="${track.album}" title="View Album: ${track.album}">${track.genre || "Pop"}</span>
                            <span>${track.durationFormatted || "0:00"}</span>
                        </div>
                        <div class="card-quick-actions" role="group" aria-label="Queue and Radio Mix actions for ${track.title}">
                            <button type="button" class="card-action-btn" data-card-action="play-next" title="Play Next in Queue" aria-label="Play ${track.title} next">
                                <span>Play Next</span>
                            </button>
                            <button type="button" class="card-action-btn" data-card-action="add-to-queue" title="Add to Queue" aria-label="Add ${track.title} to queue">
                                <span>+ Queue</span>
                            </button>
                            <button type="button" class="card-action-btn mix-action-btn" data-card-action="start-mix" title="Start nonstop radio mix from ${track.title}" aria-label="Start radio mix from ${track.title}">
                                <span>Mix</span>
                            </button>
                            <button type="button" class="card-action-btn" data-card-action="add-to-playlist" title="Add to playlist" aria-label="Add ${track.title} to a playlist">
                                <span>+ List</span>
                            </button>
                        </div>`;
        card.querySelector("img").src = track.coverUrl;
        const h4El = card.querySelector("h4");
        const pEl = card.querySelector("p");
        const badgeEl = card.querySelector(".card-badge-pill");
        h4El.textContent = track.title;
        pEl.textContent = track.artistDisplay;

        if (h4El && typeof h4El.addEventListener === "function") {
            h4El.addEventListener("click", (e) => {
                e.stopPropagation();
                openSongDetail(track.id);
            });
        }
        if (pEl && typeof pEl.addEventListener === "function") {
            pEl.addEventListener("click", (e) => {
                e.stopPropagation();
                openArtistDetail(track.primaryArtist);
            });
        }
        if (badgeEl && typeof badgeEl.addEventListener === "function") {
            badgeEl.addEventListener("click", (e) => {
                e.stopPropagation();
                openAlbumDetail(track.album);
            });
        }

        card.querySelector("button").addEventListener("click", (e) => {
            e.stopPropagation();
            playMusic(fullIdx, false);
        });

        if (typeof card.querySelectorAll === "function") {
            card.querySelectorAll("[data-card-action]").forEach((actionBtn) => {
                actionBtn.addEventListener("click", (e) => {
                    e.stopPropagation();
                    const action = actionBtn.dataset.cardAction;
                    if (action === "play-next") {
                        playTrackNext(track.id);
                    } else if (action === "add-to-queue") {
                        addTrackToQueue(track.id);
                    } else if (action === "start-mix") {
                        startRadioMix({ type: "track", track });
                    } else if (action === "add-to-playlist") {
                        openPlaylistPicker(track.id);
                    } else if (action === "song-detail" || action === "open-detail") {
                        openSongDetail(track.id);
                    } else if (action === "artist-detail") {
                        openArtistDetail(track.primaryArtist);
                    } else if (action === "album-detail") {
                        openAlbumDetail(track.album);
                    }
                });
            });
        }

        card.addEventListener("click", () => {
            playMusic(fullIdx, false);
        });
        return card;
    };

    renderInChunks(songDiv, filteredTracks, makeCard, {
        chunk: 60,
        stateId: "catalog-grid",
        key: `${activeMoodFilter}|${activeSearchQuery}`,
    });
}

function renderLibrarySidebar() {
    const listContainer = document.getElementById("library-tracks-list");
    if (!listContainer || !songs.length) return;

    const activeTrack = songs[currentTrackIndex];
    const nodes = [];
    let trackNodeFactory = null;

    if (activeLibraryFilter === "artists") {
        const seenArtists = new Map();
        for (const track of songs) {
            const trackArtists = getTrackArtistList(track);
            for (const artistName of trackArtists) {
                if (artistName && !seenArtists.has(artistName)) {
                    seenArtists.set(artistName, track);
                }
            }
        }
        for (const [artistName, sampleTrack] of seenArtists.entries()) {
            const btn = document.createElement("button");
            btn.type = "button";
            btn.className = "library-item";
            btn.dataset.artist = artistName;
            btn.innerHTML = `
                <div class="lib-item-art"><img src="${sampleTrack.coverUrl}" alt="${artistName}"></div>
                <div class="lib-item-meta">
                    <span class="lib-item-title">${artistName}</span>
                    <span class="lib-item-sub">Artist Profile &bull; ${sampleTrack.genre || "Music"}</span>
                </div>
                <div class="lib-item-actions">
                    <span class="lib-mini-btn" data-lib-action="start-mix" title="Start ${artistName} Radio Mix" aria-label="Start ${artistName} Radio Mix">
                        <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1zm0 4a3 3 0 1 1 0 6 3 3 0 0 1 0-6z"/></svg>
                    </span>
                </div>`;
            const mixMiniBtn = btn.querySelector('[data-lib-action="start-mix"]');
            if (mixMiniBtn && typeof mixMiniBtn.addEventListener === "function") {
                mixMiniBtn.addEventListener("click", (e) => {
                    e.stopPropagation();
                    startRadioMix({ type: "artist", artist: artistName });
                });
            }
            btn.addEventListener("click", () => {
                openArtistDetail(artistName);
            });
            nodes.push(btn);
        }
    } else if (activeLibraryFilter === "albums") {
        const seenAlbums = new Map();
        for (const track of songs) {
            if (track.album && !seenAlbums.has(track.album)) {
                seenAlbums.set(track.album, track);
            }
        }
        for (const [albumName, track] of seenAlbums.entries()) {
            const btn = document.createElement("button");
            btn.type = "button";
            btn.className = "library-item";
            btn.dataset.album = albumName;
            btn.innerHTML = `
                <div class="lib-item-art"><img src="${track.coverUrl}" alt="${albumName}"></div>
                <div class="lib-item-meta">
                    <span class="lib-item-title">${albumName}</span>
                    <span class="lib-item-sub">Album &bull; ${track.primaryArtist} (${track.year || 2024})</span>
                </div>
                <div class="lib-item-actions">
                    <span class="lib-mini-btn" data-lib-action="start-mix" title="Start ${albumName} Radio Mix" aria-label="Start ${albumName} Radio Mix">
                        <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1zm0 4a3 3 0 1 1 0 6 3 3 0 0 1 0-6z"/></svg>
                    </span>
                </div>`;
            const mixMiniBtn = btn.querySelector('[data-lib-action="start-mix"]');
            if (mixMiniBtn && typeof mixMiniBtn.addEventListener === "function") {
                mixMiniBtn.addEventListener("click", (e) => {
                    e.stopPropagation();
                    startRadioMix({ type: "album", album: albumName });
                });
            }
            btn.addEventListener("click", () => {
                openAlbumDetail(albumName);
            });
            nodes.push(btn);
        }
    } else if (activeLibraryFilter === "playlists") {
        const shelvesData = buildHomeShelvesData();
        const smartMixItems = [
            ...(shelvesData?.smartMixes || []),
            shelvesData?.onRepeat
                ? {
                      id: "on-repeat",
                      title: "On Repeat Mix",
                      vibeTitle: "Heavy Rotation",
                      coverUrl: shelvesData.onRepeat.tracks[0]?.coverUrl || songs[0]?.coverUrl,
                  }
                : null,
            shelvesData?.rediscover
                ? {
                      id: "rediscover",
                      title: "Rediscover Mix",
                      vibeTitle: "Forgotten Favorites",
                      coverUrl: shelvesData.rediscover.tracks[0]?.coverUrl || songs[0]?.coverUrl,
                  }
                : null,
        ].filter(Boolean);

        for (const mix of smartMixItems) {
            const btn = document.createElement("button");
            btn.type = "button";
            btn.className = "library-item";
            btn.dataset.smartMixId = mix.id;
            btn.innerHTML = `
                <div class="lib-item-art"><img src="${mix.coverUrl}" alt="${mix.title}"></div>
                <div class="lib-item-meta">
                    <span class="lib-item-title">${mix.title}</span>
                    <span class="lib-item-sub">Smart Mix &bull; ${mix.vibeTitle || "Auto-Station"}</span>
                </div>`;
            btn.addEventListener("click", () => {
                startSmartMix(mix.id);
            });
            nodes.push(btn);
        }

        const moodMixes = ["Upbeat", "Chill", "Romantic", "Late Night", "Deep Cuts"];
        for (const mood of moodMixes) {
            const match = songs.find((t) => (t.moods || []).includes(mood)) || songs[0];
            const btn = document.createElement("button");
            btn.type = "button";
            btn.className = "library-item";
            btn.dataset.moodMix = mood;
            btn.innerHTML = `
                <div class="lib-item-art"><img src="${match.coverUrl}" alt="${mood} Mix"></div>
                <div class="lib-item-meta">
                    <span class="lib-item-title">${mood} Radio Mix</span>
                    <span class="lib-item-sub">Auto-Mix &bull; YT Music Vibe</span>
                </div>`;
            btn.addEventListener("click", () => {
                setMoodFilter(mood);
                startRadioMix({ type: "mood", mood });
            });
            nodes.push(btn);
        }
    } else {
        trackNodeFactory = (track) => {
            const btn = document.createElement("button");
            btn.type = "button";
            btn.className = "library-item";
            btn.dataset.trackId = track.id;
            if (activeTrack && activeTrack.id === track.id) {
                btn.classList.add("active");
            }
            btn.innerHTML = `
                <div class="lib-item-art"><img src="${track.coverUrl}" alt="${track.title}"></div>
                <div class="lib-item-meta">
                    <span class="lib-item-title">${track.title}</span>
                    <span class="lib-item-sub">${track.artistDisplay} &bull; ${track.durationFormatted || "0:00"}</span>
                </div>
                <div class="lib-item-actions">
                    <span class="lib-mini-btn" data-lib-action="open-detail" title="View Song Details: ${track.title}" aria-label="View Song Details for ${track.title}">
                        <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13zM0 8a8 8 0 1 1 16 0A8 8 0 0 1 0 8zm7.25-2.25a.75.75 0 1 1 1.5 0 .75.75 0 0 1-1.5 0zM7.25 7.5a.75.75 0 0 1 1.5 0v3.75a.75.75 0 0 1-1.5 0V7.5z"/></svg>
                    </span>
                    <span class="lib-mini-btn" data-lib-action="start-mix" title="Start ${track.title} Radio Mix" aria-label="Start ${track.title} Radio Mix">
                        <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1zm0 4a3 3 0 1 1 0 6 3 3 0 0 1 0-6z"/></svg>
                    </span>
                </div>`;
            const detailMiniBtn = btn.querySelector('[data-lib-action="open-detail"]');
            if (detailMiniBtn && typeof detailMiniBtn.addEventListener === "function") {
                detailMiniBtn.addEventListener("click", (e) => {
                    e.stopPropagation();
                    openSongDetail(track.id);
                });
            }
            const mixMiniBtn = btn.querySelector('[data-lib-action="start-mix"]');
            if (mixMiniBtn && typeof mixMiniBtn.addEventListener === "function") {
                mixMiniBtn.addEventListener("click", (e) => {
                    e.stopPropagation();
                    startRadioMix({ type: "track", track });
                });
            }
            btn.addEventListener("click", () => {
                playMusic(track.id, false);
            });
            return btn;
        };
    }

    if (trackNodeFactory) {
        renderInChunks(listContainer, songs, trackNodeFactory, { chunk: 80, stateId: "library-tracks", key: "tracks" });
    } else {
        listContainer.replaceChildren(...nodes);
    }
    renderUserPlaylistsSidebar();
}

function renderDrawerNowPlaying(track) {
    const container = document.getElementById("drawer-now-playing");
    const bpmBadge = document.getElementById("now-playing-bpm-badge");
    const seedLabel = document.getElementById("mix-seed-label");
    const activeBadge = document.getElementById("mix-active-badge");
    const autoplayPill = document.getElementById("mix-autoplay-pill");
    if (!container || !track) return;

    const qm = getQueueManager();
    const mixSession = qm && typeof qm.getMixSession === "function" ? qm.getMixSession() : null;

    if (bpmBadge) {
        bpmBadge.textContent = track.bpm ? `${track.bpm} BPM` : track.genre || "Pop";
    }
    if (activeBadge && mixSession?.badge) {
        activeBadge.textContent = mixSession.badge;
    }
    if (seedLabel) {
        seedLabel.textContent =
            mixSession?.label && mixSession.label !== "Catalog Supermix"
                ? mixSession.label
                : `${track.title} • ${track.primaryArtist}`;
    }
    if (autoplayPill && mixSession?.autoplayLabel) {
        autoplayPill.textContent = mixSession.autoplayLabel;
    }

    container.innerHTML = `
        <img src="${track.coverUrl}" alt="${track.title}" class="queue-item-cover">
        <div class="queue-item-meta">
            <span class="queue-item-title">${track.title}</span>
            <span class="queue-item-artist">${track.artistDisplay}</span>
        </div>
        <span class="queue-item-duration">${track.durationFormatted || "0:00"}</span>
    `;
}

const VALID_MIX_MODES = ["all", "familiar", "discover", "deep-cuts", "upbeat", "chill"];

function normalizeMixMode(mode) {
    const clean = String(mode || "all")
        .trim()
        .toLowerCase();
    return VALID_MIX_MODES.includes(clean) ? clean : "all";
}

function getUpcomingQueueTracks() {
    if (!songs.length) return [];

    const qm = getQueueManager();
    if (qm && typeof qm.getUpcomingTracks === "function") {
        ensureQueueCatalogSynced();
        return qm.getUpcomingTracks();
    }

    const recommender = getRecommender();
    const activeTrack = songs[currentTrackIndex] || songs[0];

    // If SpotTubeRecommender is loaded (and queue.js is not), use the multi-signal hybrid recommendation engine
    if (recommender && typeof recommender.recommendTracks === "function" && activeTrack) {
        const recommended = recommender.recommendTracks(songs, {
            seedTrack: activeTrack,
            mixMode: activeMixMode,
            moodFilter: activeMoodFilter,
            storage: getStorage(),
            includeSeedTracks: false,
        });

        if (activeMixMode === "upbeat") {
            return recommended
                .slice()
                .sort(
                    (a, b) =>
                        (b.energy || 0) - (a.energy || 0) ||
                        (b.recommendation?.totalScore || 0) - (a.recommendation?.totalScore || 0)
                );
        }
        if (activeMixMode === "chill") {
            return recommended
                .slice()
                .sort(
                    (a, b) =>
                        (b.acousticness || 0) - (a.acousticness || 0) ||
                        (b.recommendation?.totalScore || 0) - (a.recommendation?.totalScore || 0)
                );
        }
        if (activeMixMode === "deep-cuts") {
            return recommended
                .slice()
                .sort(
                    (a, b) =>
                        (a.popularity || 0.5) - (b.popularity || 0.5) ||
                        (b.recommendation?.totalScore || 0) - (a.recommendation?.totalScore || 0)
                );
        }

        return recommended;
    }

    const ordered = [];
    for (let offset = 1; offset < songs.length; offset++) {
        ordered.push(songs[(currentTrackIndex + offset) % songs.length]);
    }

    // Fallback when recommender.js is not loaded in isolated shell unit tests
    if (activeMixMode === "upbeat") {
        return ordered.slice().sort((a, b) => (b.energy || 0) - (a.energy || 0));
    }
    if (activeMixMode === "chill") {
        return ordered.slice().sort((a, b) => (b.acousticness || 0) - (a.acousticness || 0));
    }
    if (activeMixMode === "deep-cuts") {
        return ordered.slice().sort((a, b) => (a.popularity || 0.5) - (b.popularity || 0.5));
    }
    if (activeMixMode === "familiar") {
        return ordered.slice().sort((a, b) => (b.popularity || 0.5) - (a.popularity || 0.5));
    }
    if (activeMixMode === "discover") {
        const currentGenre = songs[currentTrackIndex]?.genre;
        return ordered
            .slice()
            .sort((a, b) => Number(a.genre === currentGenre) - Number(b.genre === currentGenre));
    }
    return ordered;
}

function syncMixTuningChipsUI() {
    document.querySelectorAll("#mix-tuning-chips .tuning-chip").forEach((chip) => {
        const isSelected = chip.dataset.mixMode === activeMixMode;
        chip.classList.toggle("active", isSelected);
        chip.setAttribute("aria-pressed", String(isSelected));
    });
}

function getQueueVibeMetrics(upcomingTracks) {
    const qm = getQueueManager();
    if (qm && typeof qm.getQueueVibeMetrics === "function") {
        return qm.getQueueVibeMetrics();
    }
    const recommender = getRecommender();
    const list = Array.isArray(upcomingTracks) ? upcomingTracks : getUpcomingQueueTracks();
    if (recommender && typeof recommender.computeQueueVibeMetrics === "function") {
        return recommender.computeQueueVibeMetrics(list, {
            mixMode: activeMixMode,
            storage: getStorage(),
        });
    }
    const n = list.length;
    const avgBpm = n ? Math.round(list.reduce((s, t) => s + Number(t.bpm || 110), 0) / n) : 0;
    const avgEnergyPct = n
        ? Math.round((list.reduce((s, t) => s + Number(t.energy ?? 0.65), 0) / n) * 100)
        : 0;
    return {
        mixMode: activeMixMode,
        trackCount: n,
        avgBpm,
        avgEnergyPct,
        summaryText: `${activeMixMode.toUpperCase()} • ${avgEnergyPct}% Energy • ${avgBpm} BPM`,
    };
}

function renderMixTuningInsight(upcomingTracks) {
    const captionEl = document.getElementById("mix-tuning-caption");
    const autoplayPill = document.getElementById("mix-autoplay-pill");
    const metrics = getQueueVibeMetrics(upcomingTracks);
    if (captionEl && metrics?.summaryText) {
        captionEl.textContent = metrics.summaryText;
    }
    if (autoplayPill && metrics?.profile) {
        autoplayPill.textContent =
            activeMixMode === "all" ? "Endless Auto" : `${metrics.profile.shortLabel} Auto`;
    }
    return metrics;
}

/**
 * Reorders existing DOM nodes inside a container without recreating them,
 * using `Element.prototype.moveBefore` when available (preserving focus, state,
 * and View Transition identity) with safe fallback to `append` / `replaceChildren`.
 */
function reorderContainerNodes(container, orderedNodes) {
    const hasMoveBefore =
        typeof Element !== "undefined" &&
        Object.hasOwn(Element.prototype, "moveBefore") &&
        typeof container.moveBefore === "function";
    const hasAppend = typeof container.append === "function";

    if (hasMoveBefore) {
        for (const node of orderedNodes) {
            container.moveBefore(node, null);
        }
    } else if (hasAppend) {
        for (const node of orderedNodes) {
            container.append(node);
        }
    } else if (typeof container.replaceChildren === "function") {
        container.replaceChildren(...orderedNodes);
    }

    if (Array.isArray(container.children)) {
        container.children = orderedNodes;
    }
}

function runQueueViewTransition(queueList, updateFn, shouldAnimate = false) {
    if (!shouldAnimate) {
        updateFn();
        return;
    }
    if (typeof queueList.startViewTransition === "function") {
        queueList.startViewTransition(updateFn);
    } else if (
        typeof document !== "undefined" &&
        typeof document.startViewTransition === "function"
    ) {
        document.startViewTransition(updateFn);
    } else {
        updateFn();
    }
}

let draggedQueueIndex = null;

function updateQueueItemNode(item, track, idx, totalCount) {
    const isManual = track.queueMeta?.source === "manual";
    const isPlayNext = track.queueMeta?.manualType === "play-next";
    const queueId = track.queueMeta?.queueId || `q-idx-${idx}-${track.id}`;

    item.className = isManual ? "queue-item manual-queue-item" : "queue-item";
    item.dataset.trackId = track.id;
    item.dataset.queueId = queueId;
    item.dataset.queueIndex = String(idx);

    const reason = track.recommendation?.primaryReason;
    const scorePct =
        typeof track.recommendation?.totalScore === "number" && !isManual
            ? `${Math.round(track.recommendation.totalScore * 100)}% match`
            : "";
    item.title = reason ? (scorePct ? `${reason} • ${scorePct}` : reason) : "";

    const subText = reason ? `${track.artistDisplay} • ${reason}` : track.artistDisplay;
    const sourcePillHtml = isManual
        ? `<span class="queue-source-pill ${isPlayNext ? "play-next-pill" : ""}">${
              isPlayNext ? "NEXT" : "QUEUED"
          }</span>`
        : "";

    if (typeof item.querySelector === "function") {
        const artistEl = item.querySelector(".queue-item-artist");
        if (artistEl) artistEl.textContent = subText;
        const titleRowEl = item.querySelector(".queue-item-title-row");
        if (titleRowEl) {
            titleRowEl.innerHTML = `<span class="queue-item-title">${track.title}</span>${sourcePillHtml}`;
        }
        const upBtn = item.querySelector('[data-queue-action="move-up"]');
        if (upBtn) {
            upBtn.disabled = idx === 0;
            if (idx === 0) upBtn.setAttribute("disabled", "");
            else if (typeof upBtn.removeAttribute === "function") upBtn.removeAttribute("disabled");
        }
        const downBtn = item.querySelector('[data-queue-action="move-down"]');
        if (downBtn) {
            downBtn.disabled = idx === totalCount - 1;
            if (idx === totalCount - 1) downBtn.setAttribute("disabled", "");
            else if (typeof downBtn.removeAttribute === "function") downBtn.removeAttribute("disabled");
        }
    }
    return item;
}

function createQueueItemNode(track, idx, totalCount) {
    const item = document.createElement("div");
    const isManual = track.queueMeta?.source === "manual";
    const isPlayNext = track.queueMeta?.manualType === "play-next";
    const queueId = track.queueMeta?.queueId || `q-idx-${idx}-${track.id}`;

    item.className = isManual ? "queue-item manual-queue-item" : "queue-item";
    item.setAttribute("role", "listitem");
    item.setAttribute("draggable", "true");
    item.dataset.trackId = track.id;
    item.dataset.queueId = queueId;
    item.dataset.queueIndex = String(idx);

    const reason = track.recommendation?.primaryReason;
    const scorePct =
        typeof track.recommendation?.totalScore === "number" && !isManual
            ? `${Math.round(track.recommendation.totalScore * 100)}% match`
            : "";
    if (reason) {
        item.title = scorePct ? `${reason} • ${scorePct}` : reason;
    }
    const subText = reason ? `${track.artistDisplay} • ${reason}` : track.artistDisplay;
    const sourcePillHtml = isManual
        ? `<span class="queue-source-pill ${isPlayNext ? "play-next-pill" : ""}">${
              isPlayNext ? "NEXT" : "QUEUED"
          }</span>`
        : "";

    item.innerHTML = `
        <button type="button" class="queue-drag-handle" aria-label="Reorder ${track.title} in queue" title="Drag or use arrows to reorder">
            <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M5 3.5a1.25 1.25 0 1 1 0 2.5 1.25 1.25 0 0 1 0-2.5zm6 0a1.25 1.25 0 1 1 0 2.5 1.25 1.25 0 0 1 0-2.5zM5 7a1.25 1.25 0 1 1 0 2.5A1.25 1.25 0 0 1 5 7zm6 0a1.25 1.25 0 1 1 0 2.5A1.25 1.25 0 0 1 11 7zm-6 3.5a1.25 1.25 0 1 1 0 2.5 1.25 1.25 0 0 1 0-2.5zm6 0a1.25 1.25 0 1 1 0 2.5 1.25 1.25 0 0 1 0-2.5z"/></svg>
        </button>
        <img src="${track.coverUrl}" alt="${track.title}" class="queue-item-cover">
        <div class="queue-item-meta">
            <div class="queue-item-title-row">
                <span class="queue-item-title">${track.title}</span>
                ${sourcePillHtml}
            </div>
            <span class="queue-item-artist">${subText}</span>
        </div>
        <div class="queue-item-right">
            <div class="queue-item-actions" role="group" aria-label="Queue actions for ${track.title}">
                <button type="button" class="queue-action-btn" data-queue-action="move-up" title="Move up" aria-label="Move ${track.title} up in queue" ${idx === 0 ? "disabled" : ""}>
                    <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 3.5 2.5 9l1.06 1.06L8 5.62l4.44 4.44L13.5 9 8 3.5z"/></svg>
                </button>
                <button type="button" class="queue-action-btn" data-queue-action="move-down" title="Move down" aria-label="Move ${track.title} down in queue" ${idx === totalCount - 1 ? "disabled" : ""}>
                    <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 12.5 2.5 7l1.06-1.06L8 10.38l4.44-4.44L13.5 7 8 12.5z"/></svg>
                </button>
                <button type="button" class="queue-action-btn" data-queue-action="play-next" title="Promote to Play Next" aria-label="Play ${track.title} next">
                    <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M2 3.75A.75.75 0 0 1 2.75 3h7.5a.75.75 0 0 1 0 1.5h-7.5A.75.75 0 0 1 2 3.75zm0 4A.75.75 0 0 1 2.75 7h5.5a.75.75 0 0 1 0 1.5h-5.5A.75.75 0 0 1 2 7.75zm9.5-.5v2.25H9.25a.75.75 0 0 0 0 1.5h2.25v2.25a.75.75 0 0 0 1.5 0V11h2.25a.75.75 0 0 0 0-1.5H13V7.25a.75.75 0 0 0-1.5 0z"/></svg>
                </button>
                <button type="button" class="queue-action-btn remove-btn" data-queue-action="remove" title="Remove from queue" aria-label="Remove ${track.title} from queue">
                    <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M3.72 3.72a.75.75 0 0 1 1.06 0L8 6.94l3.22-3.22a.75.75 0 1 1 1.06 1.06L9.06 8l3.22 3.22a.75.75 0 1 1-1.06 1.06L8 9.06l-3.22 3.22a.75.75 0 0 1-1.06-1.06L6.94 8 3.72 4.78a.75.75 0 0 1 0-1.06z"/></svg>
                </button>
            </div>
            <span class="queue-item-duration">${track.durationFormatted || "0:00"}</span>
        </div>
    `;

    if (typeof item.querySelectorAll === "function") {
        item.querySelectorAll("[data-queue-action]").forEach((btn) => {
            btn.addEventListener("click", (e) => {
                e.stopPropagation();
                const action = btn.dataset.queueAction;
                const currentIdx = Number(item.dataset.queueIndex);
                const currentQueueId = item.dataset.queueId;
                const currentTrackId = item.dataset.trackId;
                const qm = getQueueManager();
                const currentUpcoming = getUpcomingQueueTracks();
                if (action === "move-up") {
                    reorderQueueItems(currentIdx, Math.max(0, currentIdx - 1));
                } else if (action === "move-down") {
                    reorderQueueItems(
                        currentIdx,
                        Math.min(currentUpcoming.length - 1, currentIdx + 1)
                    );
                } else if (action === "play-next") {
                    if (qm && typeof qm.promoteToPlayNext === "function") {
                        qm.promoteToPlayNext(currentQueueId);
                        renderDrawerQueue({ animateReorder: true });
                        announceQueueStatus(`Promoted ${track.title} to Play Next`);
                    } else {
                        playTrackNext(currentTrackId);
                    }
                } else if (action === "remove") {
                    removeTrackFromQueue(currentQueueId);
                }
            });
        });
    }

    // Keyboard arrow reordering on drag handle
    const dragHandle = item.querySelector(".queue-drag-handle");
    if (dragHandle && typeof dragHandle.addEventListener === "function") {
        dragHandle.addEventListener("click", (e) => e.stopPropagation());
        dragHandle.addEventListener("keydown", (e) => {
            const currentIdx = Number(item.dataset.queueIndex);
            const currentUpcoming = getUpcomingQueueTracks();
            if (e.key === "ArrowUp" && currentIdx > 0) {
                e.preventDefault();
                e.stopPropagation();
                reorderQueueItems(currentIdx, currentIdx - 1);
            } else if (e.key === "ArrowDown" && currentIdx < currentUpcoming.length - 1) {
                e.preventDefault();
                e.stopPropagation();
                reorderQueueItems(currentIdx, currentIdx + 1);
            }
        });
    }

    // HTML5 / Pointer Drag-and-Drop Reordering
    item.addEventListener("dragstart", (e) => {
        const currentIdx = Number(item.dataset.queueIndex);
        draggedQueueIndex = currentIdx;
        item.classList.add("dragging");
        if (e.dataTransfer) {
            e.dataTransfer.effectAllowed = "move";
            e.dataTransfer.setData("text/plain", String(currentIdx));
        }
    });
    item.addEventListener("dragend", () => {
        draggedQueueIndex = null;
        item.classList.remove("dragging");
    });
    item.addEventListener("dragover", (e) => {
        e.preventDefault();
        if (e.dataTransfer) {
            e.dataTransfer.dropEffect = "move";
        }
    });
    item.addEventListener("drop", (e) => {
        e.preventDefault();
        e.stopPropagation();
        const targetIdx = Number(item.dataset.queueIndex);
        const fromIdx =
            draggedQueueIndex !== null
                ? draggedQueueIndex
                : Number(e.dataTransfer?.getData("text/plain"));
        if (Number.isInteger(fromIdx) && fromIdx >= 0 && fromIdx !== targetIdx) {
            reorderQueueItems(fromIdx, targetIdx);
        }
        draggedQueueIndex = null;
    });

    item.addEventListener("click", () => {
        const currentQueueId = item.dataset.queueId;
        const currentTrackId = item.dataset.trackId;
        const qm = getQueueManager();
        if (qm && typeof qm.jumpToQueueItem === "function") {
            const targetTrack = qm.jumpToQueueItem(currentQueueId);
            if (targetTrack) {
                playMusic(targetTrack.id, false, { skipQueueSync: true });
                return;
            }
        }
        playMusic(currentTrackId, false);
    });
    return item;
}

function renderDrawerQueue(options = {}) {
    const queueList = document.getElementById("queue-list");
    const queueSummary = document.getElementById("drawer-queue-summary");
    const queueBadge = document.getElementById("queue-count-badge");
    const clearManualBtn = document.getElementById("clear-manual-queue-btn");
    if (!queueList) return;

    syncMixTuningChipsUI();

    const upcoming = getUpcomingQueueTracks();
    const manualCount = upcoming.filter((t) => t.queueMeta?.source === "manual").length;

    if (queueSummary) {
        queueSummary.textContent =
            manualCount > 0
                ? `${upcoming.length} upcoming (${manualCount} queued)`
                : `${upcoming.length} upcoming`;
    }
    if (queueBadge) {
        queueBadge.textContent = String(upcoming.length);
    }
    if (clearManualBtn) {
        clearManualBtn.hidden = manualCount === 0;
    }

    renderMixTuningInsight(upcoming);

    // Check if existing DOM nodes in `#queue-list` represent the same set of tracks
    // so we can reorder existing nodes in-place via `moveBefore` + View Transitions
    const existingChildren = Array.from(queueList.children || []);
    const existingPoolsByTrackId = new Map();
    for (const child of existingChildren) {
        const tid = child?.dataset?.trackId;
        if (tid) {
            if (!existingPoolsByTrackId.has(tid)) {
                existingPoolsByTrackId.set(tid, []);
            }
            existingPoolsByTrackId.get(tid).push(child);
        }
    }

    const canReorderExisting =
        existingChildren.length === upcoming.length &&
        upcoming.length > 0 &&
        upcoming.every((t) => {
            const pool = existingPoolsByTrackId.get(t.id);
            return pool && pool.length > 0;
        });

    if (canReorderExisting) {
        const orderedExistingNodes = upcoming.map((track, idx) => {
            const pool = existingPoolsByTrackId.get(track.id);
            const node = pool.shift();
            return updateQueueItemNode(node, track, idx, upcoming.length);
        });

        runQueueViewTransition(
            queueList,
            () => reorderContainerNodes(queueList, orderedExistingNodes),
            Boolean(options.animateReorder)
        );
        return;
    }

    renderInChunks(queueList, upcoming, (track, idx) => createQueueItemNode(track, idx, upcoming.length), {
        chunk: 50,
        stateId: "queue-list",
    });
}

function renderDrawerTrackInfo(track) {
    if (!track) return;
    const coverEl = document.getElementById("info-cover");
    const titleEl = document.getElementById("info-title");
    const artistsEl = document.getElementById("info-artists");
    const albumYearEl = document.getElementById("info-album-year");
    const genreEl = document.getElementById("info-genre");
    const langEl = document.getElementById("info-language");
    const qualityEl = document.getElementById("info-quality");
    const moodTagsEl = document.getElementById("info-mood-tags");
    const featuresEl = document.getElementById("info-features");

    if (coverEl) coverEl.src = track.coverUrl;
    if (titleEl) titleEl.textContent = track.title;
    if (artistsEl) artistsEl.textContent = track.artistDisplay;
    if (albumYearEl) albumYearEl.textContent = `${track.album || "Single"} • ${track.year || 2024}`;
    if (genreEl) genreEl.textContent = track.genre || "Pop";
    if (langEl) langEl.textContent = track.language || "English";
    if (qualityEl) qualityEl.textContent = `${track.bitrateKbps || 320} kbps`;

    if (moodTagsEl) {
        const moods = Array.isArray(track.moods) ? track.moods : ["Chill"];
        moodTagsEl.innerHTML = moods
            .map((mood) => `<span class="mood-tag-pill">${mood}</span>`)
            .join("");
    }

    if (featuresEl) {
        const store = getStorage();
        const effective = store ? store.getEffectiveAudioFeatures(track) : null;
        const stats = store ? store.getTrackStats(track.id) : null;
        const affinity = store ? store.computeTasteAffinity(track.id) : null;

        const metrics = [
            { label: "Energy", value: Math.round(((effective?.energy ?? track.energy) ?? 0.7) * 100) },
            { label: "Valence (Mood)", value: Math.round((track.valence ?? 0.65) * 100) },
            { label: "Danceability", value: Math.round((track.danceability ?? 0.7) * 100) },
            { label: "Acousticness", value: Math.round((track.acousticness ?? 0.25) * 100) },
            {
                label: "Spectral Brightness",
                value: Math.round(((effective?.spectralCentroidNormalized ?? track.energy) ?? 0.6) * 100),
            },
            {
                label: "Taste Affinity",
                value: Math.round(((affinity?.normalizedScore ?? track.popularity) ?? 0.75) * 100),
            },
        ];

        const telemetrySummary =
            stats && stats.playCount > 0
                ? `<div class="feature-row">
                    <div class="feature-row-header">
                        <span>Plays: ${stats.playCount} &bull; Avg Completion</span>
                        <span>${Math.round(stats.avgCompletionRatio * 100)}%</span>
                    </div>
                </div>`
                : "";

        featuresEl.innerHTML =
            telemetrySummary +
            metrics
                .map(
                    (m) => `
            <div class="feature-row">
                <div class="feature-row-header">
                    <span>${m.label}</span>
                    <span>${m.value}%</span>
                </div>
                <div class="feature-bar-track">
                    <div class="feature-bar-fill" style="width: ${m.value}%"></div>
                </div>
            </div>`
                )
                .join("");
    }
}

function pushNavState() {
    if (isRestoringHistory) return;
    const current = navHistory[navHistoryIndex];
    const currentDetailType = current?.detail?.type || null;
    const currentDetailTarget = current?.detail?.target || null;
    const nextDetailType = activeDetail?.type || null;
    const nextDetailTarget = activeDetail?.target || null;

    if (
        current &&
        (current.view || "home") === activeView &&
        currentDetailType === nextDetailType &&
        currentDetailTarget === nextDetailTarget &&
        current.mood === activeMoodFilter &&
        current.query === activeSearchQuery &&
        (current.searchCategory || "all") === activeSearchCategory
    ) {
        return;
    }
    navHistory.splice(navHistoryIndex + 1);
    navHistory.push({
        view: activeView,
        detail: activeDetail
            ? {
                  type: activeDetail.type,
                  target: activeDetail.target,
                  title: activeDetail.title,
              }
            : null,
        mood: activeMoodFilter,
        query: activeSearchQuery,
        searchCategory: activeSearchCategory,
    });
    navHistoryIndex = navHistory.length - 1;
}

function restoreNavSnapshot(snap) {
    if (!snap) return null;
    isRestoringHistory = true;
    const searchInput = document.getElementById("search-input");
    const searchClearBtn = document.getElementById("search-clear-btn");
    activeSearchQuery = snap.query || "";
    activeSearchCategory = snap.searchCategory || "all";
    if (searchInput) searchInput.value = activeSearchQuery;
    if (searchClearBtn) searchClearBtn.hidden = !activeSearchQuery;

    activeMoodFilter = snap.mood || "All";
    document.querySelectorAll("#mood-chips-bar .mood-chip").forEach((chip) => {
        chip.classList.toggle("active", chip.dataset.mood === activeMoodFilter);
    });
    const qm = getQueueManager();
    if (qm && typeof qm.setMoodFilter === "function") {
        qm.setMoodFilter(activeMoodFilter, { retune: true, silent: true });
    }

    if (snap.view === "detail" && snap.detail) {
        openDetailView(snap.detail, { skipHistory: true });
    } else if (snap.view === "search") {
        openSearchView(activeSearchQuery, {
            category: activeSearchCategory,
            skipHistory: true,
            skipFocus: true,
        });
    } else {
        closeDetailView({ skipHistory: true });
        renderCatalogGrid();
    }
    renderDrawerQueue();
    isRestoringHistory = false;
    return snap;
}

function navigateBack() {
    if (navHistoryIndex > 0) {
        navHistoryIndex--;
        return restoreNavSnapshot(navHistory[navHistoryIndex]);
    }
    if (activeView === "detail") {
        closeDetailView();
        return navHistory[navHistoryIndex];
    }
    if (activeView === "search") {
        closeSearchView();
        return navHistory[navHistoryIndex];
    }
    return null;
}

function navigateForward() {
    if (navHistoryIndex < navHistory.length - 1) {
        navHistoryIndex++;
        return restoreNavSnapshot(navHistory[navHistoryIndex]);
    }
    return null;
}

// ==================== ARTIST, ALBUM & SONG DETAIL VIEWS (ITEM 8) ====================

function getTrackArtistList(track) {
    if (!track) return [];
    const list = [];
    const add = (name) => {
        const clean = String(name || "").trim();
        if (clean && !list.some((a) => a.toLowerCase() === clean.toLowerCase())) {
            list.push(clean);
        }
    };
    if (track.primaryArtist) add(track.primaryArtist);
    if (Array.isArray(track.featuredArtists)) {
        track.featuredArtists.forEach(add);
    }
    if (Array.isArray(track.artists)) {
        track.artists.forEach(add);
    }
    if (list.length === 0 && track.artistDisplay) {
        String(track.artistDisplay)
            .split(",")
            .forEach(add);
    }
    return list;
}

function formatTotalDuration(totalSeconds) {
    const secs = Math.max(0, Math.round(Number(totalSeconds) || 0));
    const mins = Math.floor(secs / 60);
    const rem = secs % 60;
    if (mins === 0) return `${rem} sec`;
    if (mins >= 60) {
        const hrs = Math.floor(mins / 60);
        const remMins = mins % 60;
        return `${hrs} hr ${remMins} min`;
    }
    return rem > 0 ? `${mins} min ${rem} sec` : `${mins} min`;
}

function runMainViewTransition(updateFn, focusTargetId) {
    const focusTarget = () => {
        if (!focusTargetId) return;
        const el = document.getElementById(focusTargetId);
        if (el && typeof el.focus === "function") {
            try {
                el.focus();
            } catch (_) {}
        }
    };

    if (
        typeof document !== "undefined" &&
        typeof document.startViewTransition === "function"
    ) {
        const transition = document.startViewTransition(() => {
            updateFn();
        });
        focusTarget();
        if (transition && transition.finished && typeof transition.finished.finally === "function") {
            transition.finished.finally(() => {
                focusTarget();
            });
        }
        return;
    }

    updateFn();
    focusTarget();
}

function setHomeSectionsHidden(isHidden) {
    homeSectionsHidden = Boolean(isHidden);
    if (typeof updateHomeAddMusicCard === "function") updateHomeAddMusicCard();
    for (const id of ["hero-mix-banner", "home-shelves", "catalog-section"]) {
        const el = document.getElementById(id);
        if (el) {
            el.hidden = Boolean(isHidden);
            if (isHidden) {
                el.setAttribute("aria-hidden", "true");
            } else if (typeof el.removeAttribute === "function") {
                el.removeAttribute("aria-hidden");
            } else {
                el.setAttribute("aria-hidden", "false");
            }
        }
    }
    const catalogFallback = document.querySelector(".catalog-section");
    if (catalogFallback) {
        catalogFallback.hidden = Boolean(isHidden);
    }
}

function computeFallbackSimilarTracks(seedTracks, excludeIds, limit = 6) {
    const seedList = Array.isArray(seedTracks) && seedTracks.length ? seedTracks : [songs[0]].filter(Boolean);
    const seedGenres = new Set(seedList.map((t) => String(t?.genre || "").toLowerCase()).filter(Boolean));
    const seedMoods = new Set(
        seedList.flatMap((t) => (Array.isArray(t?.moods) ? t.moods : [])).map((m) => String(m).toLowerCase())
    );
    const avgEnergy =
        seedList.reduce((s, t) => s + Number(t?.energy ?? 0.65), 0) / Math.max(1, seedList.length);
    const avgBpm =
        seedList.reduce((s, t) => s + Number(t?.bpm ?? 110), 0) / Math.max(1, seedList.length);

    return songs
        .filter((t) => t && !excludeIds.has(t.id))
        .map((t) => {
            const sameGenre = seedGenres.has(String(t.genre || "").toLowerCase());
            const moodHits = (Array.isArray(t.moods) ? t.moods : []).filter((m) =>
                seedMoods.has(String(m).toLowerCase())
            ).length;
            const energyProx = 1 - Math.min(1, Math.abs(Number(t.energy ?? 0.65) - avgEnergy));
            const bpmProx = 1 - Math.min(1, Math.abs(Number(t.bpm ?? 110) - avgBpm) / 80);
            const score = Math.min(
                0.98,
                Math.max(0.45, (sameGenre ? 0.35 : 0.1) + moodHits * 0.1 + energyProx * 0.3 + bpmProx * 0.25)
            );
            const primaryReason = sameGenre
                ? `${t.genre} vibe`
                : moodHits > 0
                  ? "Shared mood & sonic profile"
                  : `Sonic match (${Math.round(score * 100)}%)`;
            return {
                ...t,
                recommendation: {
                    totalScore: Number(score.toFixed(3)),
                    primaryReason,
                    reasons: [primaryReason],
                },
            };
        })
        .sort((a, b) => (b.recommendation?.totalScore || 0) - (a.recommendation?.totalScore || 0))
        .slice(0, limit);
}

function buildAlbumSummaryObject(albumName, albumTracks, relationLabel = "Album / Single", isCurrentAlbum = false) {
    const first = albumTracks[0] || {};
    const artists = [];
    for (const t of albumTracks) {
        for (const a of getTrackArtistList(t)) {
            if (!artists.some((x) => x.toLowerCase() === a.toLowerCase())) {
                artists.push(a);
            }
        }
    }
    const totalDuration = albumTracks.reduce((sum, t) => sum + Number(t.duration || 0), 0);
    return {
        album: albumName,
        year: first.year || 2024,
        coverUrl: first.coverUrl || "Images/Espresso.jpeg",
        primaryArtist: first.primaryArtist || artists[0] || "Unknown Artist",
        artists,
        artistDisplay: artists.join(", "),
        genre: first.genre || "Music",
        trackCount: albumTracks.length,
        tracks: albumTracks,
        totalDuration,
        totalDurationFormatted: formatTotalDuration(totalDuration),
        relationLabel,
        isCurrentAlbum,
    };
}

function buildArtistDetailData(artistNameInput, options = {}) {
    if (!songs.length) return null;
    const rawTarget = String(artistNameInput || "").trim();
    const targetLower = rawTarget.toLowerCase();

    // Match tracks where artist appears as primary or featured artist
    let matchedTracks = songs.filter((t) =>
        getTrackArtistList(t).some((a) => a.toLowerCase() === targetLower)
    );
    if (matchedTracks.length === 0 && targetLower) {
        matchedTracks = songs.filter(
            (t) =>
                getTrackArtistList(t).some((a) => a.toLowerCase().includes(targetLower)) ||
                String(t.artistDisplay || "")
                    .toLowerCase()
                    .includes(targetLower)
        );
    }
    if (matchedTracks.length === 0) {
        const fallbackArtist = (songs[currentTrackIndex] || songs[0]).primaryArtist;
        matchedTracks = songs.filter((t) =>
            getTrackArtistList(t).some((a) => a.toLowerCase() === String(fallbackArtist).toLowerCase())
        );
    }

    // Resolve canonical artist name with original casing
    let canonicalArtist = rawTarget || (matchedTracks[0]?.primaryArtist ?? "Artist");
    for (const t of matchedTracks) {
        const exact = getTrackArtistList(t).find((a) => a.toLowerCase() === targetLower);
        if (exact) {
            canonicalArtist = exact;
            break;
        }
    }
    if (!rawTarget && matchedTracks[0]) {
        canonicalArtist = matchedTracks[0].primaryArtist;
    }

    const store = getStorage();
    const recommender = getRecommender();

    // Rank Top Tracks by primary credit + user taste affinity + likes + playCount + popularity
    const topTracks = matchedTracks
        .slice()
        .sort((a, b) => {
            const aPrimary = String(a.primaryArtist || "").toLowerCase() === canonicalArtist.toLowerCase() ? 1 : 0;
            const bPrimary = String(b.primaryArtist || "").toLowerCase() === canonicalArtist.toLowerCase() ? 1 : 0;
            const aAffinity =
                store && typeof store.computeTasteAffinity === "function"
                    ? store.computeTasteAffinity(a.id).normalizedScore
                    : 0.5;
            const bAffinity =
                store && typeof store.computeTasteAffinity === "function"
                    ? store.computeTasteAffinity(b.id).normalizedScore
                    : 0.5;
            const aScore = aPrimary * 0.15 + aAffinity * 0.5 + Number(a.popularity ?? 0.75) * 0.35;
            const bScore = bPrimary * 0.15 + bAffinity * 0.5 + Number(b.popularity ?? 0.75) * 0.35;
            return bScore - aScore;
        });

    // Build Collaborators (co-credited artists + 1-hop collaborator graph)
    const collaborators = [];
    const addCollab = (name) => {
        const clean = String(name || "").trim();
        if (
            clean &&
            clean.toLowerCase() !== canonicalArtist.toLowerCase() &&
            !collaborators.some((c) => c.toLowerCase() === clean.toLowerCase())
        ) {
            collaborators.push(clean);
        }
    };
    for (const t of matchedTracks) {
        getTrackArtistList(t).forEach(addCollab);
    }
    if (recommender && typeof recommender.buildCollaboratorGraph === "function") {
        const graph = recommender.buildCollaboratorGraph(songs);
        const neighbors = graph.get(canonicalArtist.toLowerCase());
        if (neighbors) {
            for (const neighborLower of neighbors) {
                for (const t of songs) {
                    const matchName = getTrackArtistList(t).find((a) => a.toLowerCase() === neighborLower);
                    if (matchName) addCollab(matchName);
                }
            }
        }
    }

    // Build Discography: Artist's own albums/singles + collaborator releases + related genre releases
    const albumGroups = new Map();
    for (const t of songs) {
        const alb = t.album || `${t.title} (Single)`;
        if (!albumGroups.has(alb)) albumGroups.set(alb, []);
        albumGroups.get(alb).push(t);
    }

    const discography = [];
    const seenAlbums = new Set();

    // 1. Direct artist releases (primary or featured)
    for (const t of topTracks) {
        const alb = t.album || `${t.title} (Single)`;
        if (!seenAlbums.has(alb)) {
            seenAlbums.add(alb);
            const albTracks = albumGroups.get(alb) || [t];
            const isPrimary =
                String(albTracks[0]?.primaryArtist || "").toLowerCase() === canonicalArtist.toLowerCase();
            discography.push(
                buildAlbumSummaryObject(
                    alb,
                    albTracks,
                    isPrimary ? "Artist Release" : `Featured with ${albTracks[0]?.primaryArtist || "Artist"}`,
                    false
                )
            );
        }
    }

    // 2. Collaborator releases
    for (const collab of collaborators) {
        for (const t of songs) {
            const alb = t.album || `${t.title} (Single)`;
            if (
                !seenAlbums.has(alb) &&
                getTrackArtistList(t).some((a) => a.toLowerCase() === collab.toLowerCase())
            ) {
                seenAlbums.add(alb);
                discography.push(
                    buildAlbumSummaryObject(
                        alb,
                        albumGroups.get(alb) || [t],
                        `Collaborator • ${collab}`,
                        false
                    )
                );
            }
        }
    }

    // 3. Same-genre catalog releases if fewer than 4 items
    const artistGenres = Array.from(new Set(topTracks.map((t) => t.genre).filter(Boolean)));
    if (discography.length < 4) {
        for (const t of songs) {
            const alb = t.album || `${t.title} (Single)`;
            if (!seenAlbums.has(alb) && artistGenres.includes(t.genre)) {
                seenAlbums.add(alb);
                discography.push(
                    buildAlbumSummaryObject(
                        alb,
                        albumGroups.get(alb) || [t],
                        `Related in ${t.genre}`,
                        false
                    )
                );
                if (discography.length >= 4) break;
            }
        }
    }

    // Build Similar in Your Library recommendations
    const artistTrackIds = new Set(topTracks.map((t) => t.id));
    const similarLimit = options.similarLimit || 6;
    let similarTracks = [];
    if (recommender && typeof recommender.recommendTracks === "function") {
        similarTracks = recommender.recommendTracks(songs, {
            seed: { artist: canonicalArtist },
            excludeTrackIds: Array.from(artistTrackIds),
            includeSeedTracks: false,
            limit: similarLimit,
            storage: store,
            mixMode: activeMixMode,
        });
    } else {
        similarTracks = computeFallbackSimilarTracks(topTracks, artistTrackIds, similarLimit);
    }

    const totalDuration = topTracks.reduce((sum, t) => sum + Number(t.duration || 0), 0);
    const avgBpm = Math.round(
        topTracks.reduce((sum, t) => sum + Number(t.bpm || 110), 0) / Math.max(1, topTracks.length)
    );
    const avgEnergyPct = Math.round(
        (topTracks.reduce((sum, t) => sum + Number(t.energy ?? 0.65), 0) / Math.max(1, topTracks.length)) * 100
    );
    const moods = Array.from(
        new Set(topTracks.flatMap((t) => (Array.isArray(t.moods) ? t.moods : [])))
    );

    let totalPlays = 0;
    let likedCount = 0;
    for (const t of topTracks) {
        if (likedTrackIds.has(t.id)) likedCount++;
        if (store && typeof store.getTrackStats === "function") {
            const st = store.getTrackStats(t.id);
            totalPlays += st?.playCount || 0;
        }
    }

    const leadTrack = topTracks[0] || songs[0];
    const directAlbumCount = new Set(topTracks.map((t) => t.album).filter(Boolean)).size;

    return {
        type: "artist",
        id: canonicalArtist,
        target: canonicalArtist,
        artist: canonicalArtist,
        title: canonicalArtist,
        badge: "ARTIST",
        eyebrow: `ARTIST PROFILE • ${artistGenres.join(" / ") || "HYBRID CATALOG"}`,
        coverUrl: leadTrack?.coverUrl || "Images/Espresso.jpeg",
        subtitle: `${topTracks.length} ${topTracks.length === 1 ? "song" : "songs"} in your library • ${directAlbumCount} ${directAlbumCount === 1 ? "release" : "releases"}${collaborators.length ? ` • Collaborates with ${collaborators.join(", ")}` : ""}`,
        genres: artistGenres,
        moods,
        collaborators,
        trackCount: topTracks.length,
        albumCount: directAlbumCount,
        totalDuration,
        totalDurationFormatted: formatTotalDuration(totalDuration),
        avgBpm,
        avgEnergyPct,
        likedCount,
        totalPlays,
        topTracks,
        discography,
        similarTracks,
        seedSpec: { type: "artist", artist: canonicalArtist },
    };
}

function buildAlbumDetailData(albumNameInput, options = {}) {
    if (!songs.length) return null;
    const rawTarget = String(albumNameInput || "").trim();
    const targetLower = rawTarget.toLowerCase();

    let albumTracks = songs.filter(
        (t) => String(t.album || "").toLowerCase() === targetLower
    );
    if (albumTracks.length === 0 && targetLower) {
        albumTracks = songs.filter((t) =>
            String(t.album || "")
                .toLowerCase()
                .includes(targetLower)
        );
    }
    if (albumTracks.length === 0) {
        const fallbackAlbum = (songs[currentTrackIndex] || songs[0]).album;
        albumTracks = songs.filter(
            (t) => String(t.album || "").toLowerCase() === String(fallbackAlbum || "").toLowerCase()
        );
    }

    albumTracks = albumTracks
        .slice()
        .sort((a, b) => (a.trackNumber || 0) - (b.trackNumber || 0));

    const first = albumTracks[0] || songs[0];
    const canonicalAlbum = first.album || rawTarget || "Album";
    const year = first.year || 2024;
    const genre = first.genre || "Music";
    const language = first.language || "English";

    const artists = [];
    for (const t of albumTracks) {
        for (const a of getTrackArtistList(t)) {
            if (!artists.some((x) => x.toLowerCase() === a.toLowerCase())) {
                artists.push(a);
            }
        }
    }

    const store = getStorage();
    const recommender = getRecommender();

    // Group all albums in catalog for discography shelf
    const albumGroups = new Map();
    for (const t of songs) {
        const alb = t.album || `${t.title} (Single)`;
        if (!albumGroups.has(alb)) albumGroups.set(alb, []);
        albumGroups.get(alb).push(t);
    }

    const discography = [];
    const seenAlbums = new Set([canonicalAlbum]);
    discography.push(
        buildAlbumSummaryObject(canonicalAlbum, albumTracks, `Current Album • ${year}`, true)
    );

    // More by the album's credited artists
    for (const artist of artists) {
        for (const t of songs) {
            const alb = t.album || `${t.title} (Single)`;
            if (
                !seenAlbums.has(alb) &&
                getTrackArtistList(t).some((a) => a.toLowerCase() === artist.toLowerCase())
            ) {
                seenAlbums.add(alb);
                discography.push(
                    buildAlbumSummaryObject(
                        alb,
                        albumGroups.get(alb) || [t],
                        `More by ${artist}`,
                        false
                    )
                );
            }
        }
    }

    // Other albums in the same genre or language
    for (const t of songs) {
        const alb = t.album || `${t.title} (Single)`;
        if (!seenAlbums.has(alb) && (t.genre === genre || t.language === language)) {
            seenAlbums.add(alb);
            discography.push(
                buildAlbumSummaryObject(
                    alb,
                    albumGroups.get(alb) || [t],
                    `Related • ${t.genre || genre}`,
                    false
                )
            );
            if (discography.length >= 6) break;
        }
    }

    // Build Similar in Your Library recommendations
    const albumTrackIds = new Set(albumTracks.map((t) => t.id));
    const similarLimit = options.similarLimit || 6;
    let similarTracks = [];
    if (recommender && typeof recommender.recommendTracks === "function") {
        similarTracks = recommender.recommendTracks(songs, {
            seed: { album: canonicalAlbum },
            excludeTrackIds: Array.from(albumTrackIds),
            includeSeedTracks: false,
            limit: similarLimit,
            storage: store,
            mixMode: activeMixMode,
        });
    } else {
        similarTracks = computeFallbackSimilarTracks(albumTracks, albumTrackIds, similarLimit);
    }

    const totalDuration = albumTracks.reduce((sum, t) => sum + Number(t.duration || 0), 0);
    const avgBpm = Math.round(
        albumTracks.reduce((sum, t) => sum + Number(t.bpm || 110), 0) / Math.max(1, albumTracks.length)
    );
    const avgEnergyPct = Math.round(
        (albumTracks.reduce((sum, t) => sum + Number(t.energy ?? 0.65), 0) / Math.max(1, albumTracks.length)) * 100
    );
    const moods = Array.from(
        new Set(albumTracks.flatMap((t) => (Array.isArray(t.moods) ? t.moods : [])))
    );
    const subgenres = Array.from(
        new Set(albumTracks.flatMap((t) => (Array.isArray(t.subgenres) ? t.subgenres : [])))
    );

    let totalPlays = 0;
    let likedCount = 0;
    for (const t of albumTracks) {
        if (likedTrackIds.has(t.id)) likedCount++;
        if (store && typeof store.getTrackStats === "function") {
            const st = store.getTrackStats(t.id);
            totalPlays += st?.playCount || 0;
        }
    }

    return {
        type: "album",
        id: canonicalAlbum,
        target: canonicalAlbum,
        album: canonicalAlbum,
        title: canonicalAlbum,
        primaryArtist: first.primaryArtist,
        artists,
        collaborators: artists,
        year,
        genre,
        subgenres,
        language,
        moods,
        badge: "ALBUM",
        eyebrow: `ALBUM • ${year} • ${genre.toUpperCase()}`,
        coverUrl: first.coverUrl || "Images/Espresso.jpeg",
        subtitle: `By ${artists.join(", ")} • ${albumTracks.length} ${albumTracks.length === 1 ? "track" : "tracks"} (${formatTotalDuration(totalDuration)})`,
        trackCount: albumTracks.length,
        totalDuration,
        totalDurationFormatted: formatTotalDuration(totalDuration),
        avgBpm,
        avgEnergyPct,
        likedCount,
        totalPlays,
        topTracks: albumTracks,
        tracks: albumTracks,
        discography,
        similarTracks,
        seedSpec: { type: "album", album: canonicalAlbum },
    };
}

function buildSongDetailData(trackOrId, options = {}) {
    if (!songs.length) return null;
    const idx = resolveTrackIndex(trackOrId);
    const track = songs[idx] || songs[0];
    if (!track) return null;

    const store = getStorage();
    const recommender = getRecommender();
    const artists = getTrackArtistList(track);

    const effective =
        store && typeof store.getEffectiveAudioFeatures === "function"
            ? store.getEffectiveAudioFeatures(track)
            : null;
    const stats =
        store && typeof store.getTrackStats === "function"
            ? store.getTrackStats(track.id)
            : null;
    const affinity =
        store && typeof store.computeTasteAffinity === "function"
            ? store.computeTasteAffinity(track.id)
            : null;

    const audioProfile = {
        bpm: track.bpm || 110,
        bitrateKbps: track.bitrateKbps || 320,
        sampleRate: track.sampleRate || 44100,
        hasLiveAnalyzer: Boolean(effective?.hasLiveAnalyzer),
        playCount: stats?.playCount || 0,
        fullCompletions: stats?.fullCompletions || 0,
        avgCompletionPct: Math.round((stats?.avgCompletionRatio || 0) * 100),
        liked: likedTrackIds.has(track.id) || Boolean(stats?.liked),
        metrics: [
            { label: "Energy", value: Math.round(((effective?.energy ?? track.energy) ?? 0.7) * 100) },
            { label: "Valence (Mood)", value: Math.round((track.valence ?? 0.65) * 100) },
            { label: "Danceability", value: Math.round((track.danceability ?? 0.7) * 100) },
            { label: "Acousticness", value: Math.round((track.acousticness ?? 0.25) * 100) },
            {
                label: "Spectral Brightness",
                value: Math.round(((effective?.spectralCentroidNormalized ?? track.energy) ?? 0.6) * 100),
            },
            {
                label: "Taste Affinity",
                value: Math.round(((affinity?.normalizedScore ?? track.popularity) ?? 0.75) * 100),
            },
            {
                label: "Catalog Popularity",
                value: Math.round((track.popularity ?? 0.8) * 100),
            },
        ],
    };

    // Top tracks: this song + other tracks by any of this song's artists
    const topTracks = [track];
    for (const candidate of songs) {
        if (candidate.id === track.id) continue;
        const candArtists = getTrackArtistList(candidate);
        if (
            candArtists.some((ca) =>
                artists.some((ta) => ta.toLowerCase() === ca.toLowerCase())
            )
        ) {
            topTracks.push(candidate);
        }
    }

    // Discography: featured album + other releases by the track's artists + same genre
    const albumGroups = new Map();
    for (const t of songs) {
        const alb = t.album || `${t.title} (Single)`;
        if (!albumGroups.has(alb)) albumGroups.set(alb, []);
        albumGroups.get(alb).push(t);
    }

    const discography = [];
    const seenAlbums = new Set();
    const primaryAlbum = track.album || `${track.title} (Single)`;
    seenAlbums.add(primaryAlbum);
    discography.push(
        buildAlbumSummaryObject(
            primaryAlbum,
            albumGroups.get(primaryAlbum) || [track],
            `Featured on Album • ${track.year || 2024}`,
            true
        )
    );

    for (const artist of artists) {
        for (const t of songs) {
            const alb = t.album || `${t.title} (Single)`;
            if (
                !seenAlbums.has(alb) &&
                getTrackArtistList(t).some((a) => a.toLowerCase() === artist.toLowerCase())
            ) {
                seenAlbums.add(alb);
                discography.push(
                    buildAlbumSummaryObject(
                        alb,
                        albumGroups.get(alb) || [t],
                        `More by ${artist}`,
                        false
                    )
                );
            }
        }
    }

    for (const t of songs) {
        const alb = t.album || `${t.title} (Single)`;
        if (!seenAlbums.has(alb) && t.genre === track.genre) {
            seenAlbums.add(alb);
            discography.push(
                buildAlbumSummaryObject(
                    alb,
                    albumGroups.get(alb) || [t],
                    `Related in ${track.genre}`,
                    false
                )
            );
            if (discography.length >= 4) break;
        }
    }

    // Similar in Your Library via SpotTubeRecommender.getSimilarTracks
    const similarLimit = options.similarLimit || 6;
    let similarTracks = [];
    if (recommender && typeof recommender.getSimilarTracks === "function") {
        similarTracks = recommender.getSimilarTracks(songs, track, {
            limit: similarLimit,
            storage: store,
            mixMode: activeMixMode,
        });
    } else if (recommender && typeof recommender.recommendTracks === "function") {
        similarTracks = recommender.recommendTracks(songs, {
            seed: track,
            includeSeedTracks: false,
            limit: similarLimit,
            storage: store,
            mixMode: activeMixMode,
        });
    } else {
        similarTracks = computeFallbackSimilarTracks([track], new Set([track.id]), similarLimit);
    }

    return {
        type: "song",
        id: track.id,
        target: track.id,
        track,
        title: track.title,
        primaryArtist: track.primaryArtist,
        artists,
        collaborators: artists,
        album: primaryAlbum,
        year: track.year || 2024,
        genre: track.genre || "Music",
        subgenres: track.subgenres || [],
        language: track.language || "English",
        moods: track.moods || [],
        badge: "SONG",
        eyebrow: `SONG • ${(track.genre || "MUSIC").toUpperCase()} • ${track.year || 2024}`,
        coverUrl: track.coverUrl || "Images/Espresso.jpeg",
        subtitle: `${artists.join(", ")} • Album: ${primaryAlbum} (${track.year || 2024}) • ${track.durationFormatted || "0:00"}`,
        trackCount: topTracks.length,
        totalDuration: track.duration || 0,
        totalDurationFormatted: track.durationFormatted || "0:00",
        avgBpm: track.bpm || 110,
        avgEnergyPct: Math.round((track.energy ?? 0.65) * 100),
        likedCount: audioProfile.liked ? 1 : 0,
        totalPlays: audioProfile.playCount,
        audioProfile,
        topTracks,
        discography,
        similarTracks,
        seedSpec: { type: "track", track },
    };
}

function toggleLikeTrackById(trackId) {
    if (!trackId) return false;
    const store = getStorage();
    let nowLiked = false;
    if (store && typeof store.toggleLike === "function") {
        nowLiked = store.toggleLike(trackId);
        if (nowLiked) likedTrackIds.add(trackId);
        else likedTrackIds.delete(trackId);
    } else if (likedTrackIds.has(trackId)) {
        likedTrackIds.delete(trackId);
        nowLiked = false;
    } else {
        likedTrackIds.add(trackId);
        nowLiked = true;
    }
    const likedCountEl = document.getElementById("lib-liked-count");
    if (likedCountEl) {
        likedCountEl.textContent =
            likedTrackIds.size > 0
                ? `Auto-playlist • ${likedTrackIds.size} liked`
                : "Auto-playlist • Pin";
    }
    syncActiveTrackUI();
    return nowLiked;
}

function createDetailTrackRowNode(track, idx, rowOptions = {}) {
    const collection = rowOptions.collection || null;
    const row = document.createElement("div");
    const activeTrack = songs[currentTrackIndex];
    const isPlaying = activeTrack && activeTrack.id === track.id;
    const isLiked = likedTrackIds.has(track.id);
    const artists = getTrackArtistList(track);

    // Item 13: rows from an instant import show shimmer placeholders until their tags are read
    const isPending = track.importStatus === "pending";
    row.className = `${isPlaying ? "detail-track-row active-track" : "detail-track-row"}${isPending ? " is-pending" : ""}`;
    row.setAttribute("role", "listitem");
    if (isPending) row.setAttribute("aria-busy", "true");
    row.dataset.trackId = track.id;
    row.dataset.artist = track.primaryArtist;
    row.dataset.album = track.album;

    const artistButtonsHtml = artists
        .map(
            (a) =>
                `<button type="button" class="detail-inline-link" data-open-artist="${a}" title="Open Artist: ${a}">${a}</button>`
        )
        .join("<span>, </span>");

    const matchBadgeHtml = track.searchMatch?.matchReason
        ? `<span class="queue-source-pill play-next-pill">${track.searchMatch.matchReason}</span>`
        : "";

    row.innerHTML = `
        <span class="detail-track-num">${idx + 1}</span>
        ${
            isPending
                ? `<span class="detail-track-cover import-shimmer" aria-hidden="true"></span>`
                : `<img src="${track.coverUrl}" alt="${track.title}" class="detail-track-cover" loading="lazy" decoding="async">`
        }
        <div class="detail-track-main">
            <div class="detail-track-title-row">
                <span class="detail-track-title" data-open-song="${track.id}" title="Open Song Detail: ${track.title}">${track.title}</span>
                ${matchBadgeHtml}
                ${isPending ? `<span class="import-reading-tag">reading tags…</span>` : ""}
            </div>
            <div class="detail-track-artists">${artistButtonsHtml}</div>
        </div>
        <div class="detail-track-album-col">
            ${
                isPending
                    ? `<span class="import-shimmer import-shimmer-line" aria-hidden="true"></span><span class="import-shimmer import-shimmer-line short" aria-hidden="true"></span>`
                    : `<button type="button" class="detail-inline-link" data-open-album="${track.album}" title="Open Album: ${track.album}">${track.album}</button>
            <span class="detail-track-telemetry">${track.genre || "Music"} &bull; ${track.bpm || 110} BPM &bull; ${Math.round((track.energy ?? 0.65) * 100)}% Energy</span>`
            }
        </div>
        <div class="detail-track-actions" role="group" aria-label="Actions for ${track.title}">
            <button type="button" class="detail-row-btn ${isLiked ? "liked" : ""}" data-detail-track-action="like" aria-pressed="${isLiked}" title="Like ${track.title}">
                <span>${isLiked ? "♥ Liked" : "♡ Like"}</span>
            </button>
            <button type="button" class="detail-row-btn" data-detail-track-action="play-next" title="Play ${track.title} Next">
                <span>Play Next</span>
            </button>
            <button type="button" class="detail-row-btn" data-detail-track-action="add-to-queue" title="Add ${track.title} to Queue">
                <span>+ Queue</span>
            </button>
            <button type="button" class="detail-row-btn mix-btn" data-detail-track-action="start-mix" title="Start Radio Mix from ${track.title}">
                <span>Start Mix</span>
            </button>
            <button type="button" class="detail-row-btn" data-detail-track-action="add-to-playlist" title="Add ${track.title} to a playlist">
                <span>+ Playlist</span>
            </button>
            ${buildCollectionRowActionsHtml(track, idx, collection)}
            ${
                isPending
                    ? `<span class="detail-track-duration import-shimmer import-shimmer-dur" aria-hidden="true"></span>`
                    : `<span class="detail-track-duration">${track.durationFormatted || "0:00"}</span>`
            }
        </div>
    `;

    const songTitleEl = row.querySelector("[data-open-song]");
    if (songTitleEl && typeof songTitleEl.addEventListener === "function") {
        songTitleEl.addEventListener("click", (e) => {
            e.stopPropagation();
            openSongDetail(track.id);
        });
    }

    if (typeof row.querySelectorAll === "function") {
        row.querySelectorAll("[data-open-artist]").forEach((btn) => {
            btn.addEventListener("click", (e) => {
                e.stopPropagation();
                openArtistDetail(btn.dataset.openArtist);
            });
        });

        row.querySelectorAll("[data-open-album]").forEach((btn) => {
            btn.addEventListener("click", (e) => {
                e.stopPropagation();
                openAlbumDetail(btn.dataset.openAlbum);
            });
        });

        row.querySelectorAll("[data-detail-track-action]").forEach((btn) => {
            btn.addEventListener("click", (e) => {
                e.stopPropagation();
                const action = btn.dataset.detailTrackAction;
                if (action === "like") {
                    const liked = toggleLikeTrackById(track.id);
                    btn.classList.toggle("liked", liked);
                    btn.setAttribute("aria-pressed", String(liked));
                    btn.innerHTML = `<span>${liked ? "♥ Liked" : "♡ Like"}</span>`;
                    if (collection && collection.type === "liked") {
                        refreshActiveCollectionView();
                    }
                } else if (handleCollectionRowAction(action, track, idx, collection)) {
                    // handled by Item 11 collection actions
                } else if (action === "play-next") {
                    playTrackNext(track.id);
                } else if (action === "add-to-queue") {
                    addTrackToQueue(track.id);
                } else if (action === "start-mix") {
                    startRadioMix({ type: "track", track });
                } else if (action === "song-detail") {
                    openSongDetail(track.id);
                }
            });
        });
    }

    row.addEventListener("click", () => {
        playMusic(track.id, false);
    });
    return row;
}

function createDetailDiscographyCardNode(albumItem) {
    const card = document.createElement("div");
    card.className = albumItem.isCurrentAlbum
        ? "detail-album-card current-album-card"
        : "detail-album-card";
    card.setAttribute("role", "listitem");
    card.dataset.album = albumItem.album;
    card.dataset.artist = albumItem.primaryArtist;

    card.innerHTML = `
        <div class="detail-card-cover-wrap">
            <img src="${albumItem.coverUrl}" alt="${albumItem.album}" class="detail-card-cover">
        </div>
        <span class="detail-card-relation">${albumItem.relationLabel || "Album / Single"}</span>
        <h4 class="detail-card-title">${albumItem.album}</h4>
        <p class="detail-card-sub">
            <button type="button" class="detail-inline-link" data-open-artist="${albumItem.primaryArtist}">${albumItem.primaryArtist}</button>
            &bull; ${albumItem.year} &bull; ${albumItem.trackCount} ${albumItem.trackCount === 1 ? "track" : "tracks"}
        </p>
        <div class="card-quick-actions" role="group" aria-label="Album actions for ${albumItem.album}">
            <button type="button" class="card-action-btn" data-discog-action="play-album" title="Play ${albumItem.album}">
                <span>Play</span>
            </button>
            <button type="button" class="card-action-btn" data-discog-action="open-album" title="Open ${albumItem.album} Detail View">
                <span>View Album</span>
            </button>
            <button type="button" class="card-action-btn mix-action-btn" data-discog-action="start-mix" title="Start Album Radio Mix for ${albumItem.album}">
                <span>Start Mix</span>
            </button>
        </div>
    `;

    const artistBtn = card.querySelector("[data-open-artist]");
    if (artistBtn && typeof artistBtn.addEventListener === "function") {
        artistBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            openArtistDetail(albumItem.primaryArtist);
        });
    }

    if (typeof card.querySelectorAll === "function") {
        card.querySelectorAll("[data-discog-action]").forEach((btn) => {
            btn.addEventListener("click", (e) => {
                e.stopPropagation();
                const action = btn.dataset.discogAction;
                if (action === "play-album") {
                    const tracks = albumItem.tracks || [];
                    if (tracks.length > 0) {
                        playMusic(tracks[0].id, false);
                        for (let i = 1; i < tracks.length; i++) {
                            addTrackToQueue(tracks[i].id);
                        }
                    }
                } else if (action === "open-album") {
                    openAlbumDetail(albumItem.album);
                } else if (action === "start-mix") {
                    startRadioMix({ type: "album", album: albumItem.album });
                }
            });
        });
    }

    card.addEventListener("click", () => {
        openAlbumDetail(albumItem.album);
    });
    return card;
}

function createDetailSimilarTrackCardNode(simTrack) {
    const card = document.createElement("div");
    const activeTrack = songs[currentTrackIndex];
    const isPlaying = activeTrack && activeTrack.id === simTrack.id;

    card.className = isPlaying ? "detail-similar-card active-track" : "detail-similar-card";
    card.setAttribute("role", "listitem");
    card.dataset.trackId = simTrack.id;
    card.dataset.artist = simTrack.primaryArtist;
    card.dataset.album = simTrack.album;

    const reason = simTrack.recommendation?.primaryReason || `${simTrack.genre || "Sonic"} match`;
    const scorePct =
        typeof simTrack.recommendation?.totalScore === "number"
            ? `${Math.round(simTrack.recommendation.totalScore * 100)}%`
            : "";

    card.innerHTML = `
        <div class="detail-card-cover-wrap">
            <img src="${simTrack.coverUrl}" alt="${simTrack.title}" class="detail-card-cover">
        </div>
        <div class="detail-similarity-reason">
            <span>${reason}</span>
            ${scorePct ? `<span>${scorePct}</span>` : ""}
        </div>
        <h4 class="detail-card-title" data-open-song="${simTrack.id}" title="View Song Details: ${simTrack.title}">${simTrack.title}</h4>
        <p class="detail-card-sub">
            <button type="button" class="detail-inline-link" data-open-artist="${simTrack.primaryArtist}">${simTrack.artistDisplay}</button>
            &bull;
            <button type="button" class="detail-inline-link" data-open-album="${simTrack.album}">${simTrack.album}</button>
        </p>
        <div class="card-quick-actions" role="group" aria-label="Actions for similar track ${simTrack.title}">
            <button type="button" class="card-action-btn" data-similar-action="play" title="Play ${simTrack.title}">
                <span>Play</span>
            </button>
            <button type="button" class="card-action-btn" data-similar-action="play-next" title="Play ${simTrack.title} Next">
                <span>Play Next</span>
            </button>
            <button type="button" class="card-action-btn" data-similar-action="add-to-queue" title="Add ${simTrack.title} to Queue">
                <span>+ Queue</span>
            </button>
            <button type="button" class="card-action-btn mix-action-btn" data-similar-action="start-mix" title="Start Radio Mix from ${simTrack.title}">
                <span>Mix</span>
            </button>
            ${
                activeDetail && activeDetail.type === "playlist"
                    ? `<button type="button" class="card-action-btn add-to-collection-btn" data-similar-action="add-to-active-playlist" title="Add ${simTrack.title} to this playlist"><span>+ Add</span></button>`
                    : ""
            }
        </div>
    `;

    const songHeading = card.querySelector("[data-open-song]");
    if (songHeading && typeof songHeading.addEventListener === "function") {
        songHeading.addEventListener("click", (e) => {
            e.stopPropagation();
            openSongDetail(simTrack.id);
        });
    }

    const artistBtn = card.querySelector("[data-open-artist]");
    if (artistBtn && typeof artistBtn.addEventListener === "function") {
        artistBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            openArtistDetail(simTrack.primaryArtist);
        });
    }

    const albumBtn = card.querySelector("[data-open-album]");
    if (albumBtn && typeof albumBtn.addEventListener === "function") {
        albumBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            openAlbumDetail(simTrack.album);
        });
    }

    if (typeof card.querySelectorAll === "function") {
        card.querySelectorAll("[data-similar-action]").forEach((btn) => {
            btn.addEventListener("click", (e) => {
                e.stopPropagation();
                const action = btn.dataset.similarAction;
                if (action === "add-to-active-playlist") {
                    if (activeDetail && activeDetail.type === "playlist") {
                        addTrackToUserPlaylist(activeDetail.id, simTrack.id);
                    }
                } else if (action === "play") {
                    playMusic(simTrack.id, false);
                } else if (action === "play-next") {
                    playTrackNext(simTrack.id);
                } else if (action === "add-to-queue") {
                    addTrackToQueue(simTrack.id);
                } else if (action === "start-mix") {
                    startRadioMix({ type: "track", track: simTrack });
                }
            });
        });
    }

    card.addEventListener("click", () => {
        playMusic(simTrack.id, false);
    });
    return card;
}

const DETAIL_TRACKLIST_CHUNK = 150;
const chunkedListState = new Map(); // container id -> { key, rendered, observer }

/**
 * Renders `items` into `container` in chunks: the first chunk right away, the next ones as a sentinel
 * after the last node nears the viewport (scrolling, or keyboard focus reaching the end). Big libraries
 * (1,000+ songs) otherwise put ~100k nodes in the page and every layout / view transition froze it.
 * Re-rendering with the same `key` keeps at least as many items as were shown before.
 * Without IntersectionObserver everything renders at once.
 */
function renderInChunks(container, items, makeNode, options = {}) {
    const chunk = Math.max(1, options.chunk || 100);
    const stateId = container.id || options.stateId || "list";
    const prev = chunkedListState.get(stateId);
    if (prev && typeof prev.stop === "function") prev.stop();
    const makeRange = (from, to) => items.slice(from, to).map((item, i) => makeNode(item, from + i));
    const canChunk =
        items.length > chunk &&
        typeof IntersectionObserver === "function" &&
        typeof container.append === "function";
    const key = options.key || "";
    let rendered = Math.min(
        items.length,
        canChunk && prev && key && prev.key === key ? Math.max(chunk, prev.rendered) : canChunk ? chunk : items.length
    );
    const state = { key, rendered, stop: null };
    chunkedListState.set(stateId, state);
    if (rendered >= items.length) {
        container.replaceChildren(...makeRange(0, items.length));
        return items.length;
    }
    const sentinel = document.createElement("div");
    sentinel.className = "chunk-sentinel";
    sentinel.setAttribute("aria-hidden", "true");
    container.replaceChildren(...makeRange(0, rendered), sentinel);
    const loadMore = () => {
        if (rendered >= items.length) return;
        const next = Math.min(items.length, rendered + chunk);
        sentinel.before(...makeRange(rendered, next));
        rendered = next;
        state.rendered = rendered;
        if (rendered >= items.length) stop();
    };
    const sentinelIsNear = () => {
        if (!sentinel.isConnected || typeof sentinel.getBoundingClientRect !== "function") return false;
        const r = sentinel.getBoundingClientRect();
        const vh = (typeof window !== "undefined" && window.innerHeight) || 800;
        const vw = (typeof window !== "undefined" && window.innerWidth) || 1200;
        // above or inside the viewport (+800px): a jump to the end (End key, scrollbar drag) skips past it
        return r.top < vh + 800 && r.left < vw + 800;
    };
    const observer = new IntersectionObserver(
        (entries) => {
            if (entries.some((e) => e.isIntersecting)) loadMore();
        },
        { rootMargin: "800px 800px" }
    );
    let scrollFrame = 0;
    const onScroll = () => {
        if (scrollFrame) return;
        scrollFrame = requestAnimationFrame(() => {
            scrollFrame = 0;
            let guard = 0;
            while (rendered < items.length && sentinelIsNear() && guard++ < 200) loadMore();
        });
    };
    function stop() {
        observer.disconnect();
        if (typeof document.removeEventListener === "function") document.removeEventListener("scroll", onScroll, true);
        if (sentinel.isConnected) sentinel.remove();
        state.stop = null;
    }
    observer.observe(sentinel);
    if (typeof document.addEventListener === "function") document.addEventListener("scroll", onScroll, { capture: true, passive: true });
    state.stop = stop;
    return rendered;
}

function renderDetailTracklistChunked(container, tracks, rowOptions = {}) {
    return renderInChunks(container, tracks, (t, i) => createDetailTrackRowNode(t, i, rowOptions), {
        chunk: DETAIL_TRACKLIST_CHUNK,
        key: rowOptions.listKey || "",
    });
}

function renderDetailView(detailData) {
    if (!detailData) return null;
    const detailView = document.getElementById("detail-view");
    const heroEl = document.getElementById("detail-hero");
    const coverEl = document.getElementById("detail-cover");
    const badgeEl = document.getElementById("detail-type-badge");
    const eyebrowEl = document.getElementById("detail-eyebrow");
    const headingEl = document.getElementById("detail-heading");
    const subtitleEl = document.getElementById("detail-subtitle");
    const breadcrumbsEl = document.getElementById("detail-breadcrumbs");
    const metaPillsEl = document.getElementById("detail-meta-pills");
    const collabsEl = document.getElementById("detail-collaborators");
    const startMixBtn = document.getElementById("detail-start-mix-btn");
    const startMixLabel = document.getElementById("detail-start-mix-label");
    const playAllLabel = document.getElementById("detail-play-all-label");

    const topTracksTitle = document.getElementById("detail-top-tracks-title");
    const topTracksCount = document.getElementById("detail-top-tracks-count");
    const topTracksContainer = document.getElementById("detail-top-tracks");

    const audioProfileSection = document.getElementById("detail-audio-profile-section");
    const audioProfileContainer = document.getElementById("detail-audio-profile");

    const discographyTitle = document.getElementById("detail-discography-title");
    const discographyCount = document.getElementById("detail-discography-count");
    const discographyContainer = document.getElementById("detail-discography");

    const similarTitle = document.getElementById("detail-similar-title");
    const similarSubtitle = document.getElementById("detail-similar-subtitle");
    const similarContainer = document.getElementById("detail-similar-tracks");

    if (detailView) {
        detailView.dataset.detailType = detailData.type;
        detailView.dataset.detailId = detailData.id;
    }
    if (heroEl) {
        heroEl.dataset.detailType = detailData.type;
    }
    if (coverEl) {
        coverEl.src = detailData.coverUrl;
        coverEl.alt = detailData.title;
    }
    if (badgeEl) {
        badgeEl.textContent = detailData.badge;
    }
    if (eyebrowEl) {
        eyebrowEl.textContent = detailData.eyebrow;
    }
    if (headingEl) {
        headingEl.textContent = detailData.title;
        headingEl.setAttribute("tabindex", "-1");
    }
    if (subtitleEl) {
        subtitleEl.textContent = detailData.subtitle;
    }

    const isCollection = COLLECTION_DETAIL_TYPES.includes(detailData.type);
    const mixBtnText = isCollection
        ? detailData.mixLabel || "Start Playlist Mix"
        : detailData.type === "artist"
          ? `Start ${detailData.title} Mix`
          : detailData.type === "album"
            ? "Start Album Mix"
            : "Start Song Mix";
    if (startMixLabel) {
        startMixLabel.textContent = mixBtnText;
    }
    if (startMixBtn) {
        startMixBtn.dataset.detailType = detailData.type;
        startMixBtn.dataset.detailTarget = detailData.id;
    }
    if (playAllLabel) {
        playAllLabel.textContent = isCollection
            ? "Play"
            : detailData.type === "artist"
                ? "Play Top Tracks"
                : detailData.type === "album"
                  ? "Play Album"
                  : "Play Song";
    }

    // Breadcrumbs
    if (breadcrumbsEl) {
        const crumbs = [];
        const homeCrumb = document.createElement("button");
        homeCrumb.type = "button";
        homeCrumb.className = "detail-breadcrumb-btn";
        homeCrumb.textContent = isCollection ? "Your Library" : "Catalog";
        homeCrumb.addEventListener("click", () => closeDetailView());
        crumbs.push(homeCrumb);

        if (detailData.type === "album" && detailData.primaryArtist) {
            const artistCrumb = document.createElement("button");
            artistCrumb.type = "button";
            artistCrumb.className = "detail-breadcrumb-btn";
            artistCrumb.dataset.openArtist = detailData.primaryArtist;
            artistCrumb.textContent = detailData.primaryArtist;
            artistCrumb.addEventListener("click", () => openArtistDetail(detailData.primaryArtist));
            crumbs.push(artistCrumb);
        } else if (detailData.type === "song") {
            if (detailData.primaryArtist) {
                const artistCrumb = document.createElement("button");
                artistCrumb.type = "button";
                artistCrumb.className = "detail-breadcrumb-btn";
                artistCrumb.dataset.openArtist = detailData.primaryArtist;
                artistCrumb.textContent = detailData.primaryArtist;
                artistCrumb.addEventListener("click", () =>
                    openArtistDetail(detailData.primaryArtist)
                );
                crumbs.push(artistCrumb);
            }
            if (detailData.album) {
                const albumCrumb = document.createElement("button");
                albumCrumb.type = "button";
                albumCrumb.className = "detail-breadcrumb-btn";
                albumCrumb.dataset.openAlbum = detailData.album;
                albumCrumb.textContent = detailData.album;
                albumCrumb.addEventListener("click", () => openAlbumDetail(detailData.album));
                crumbs.push(albumCrumb);
            }
        }
        breadcrumbsEl.replaceChildren(...crumbs);
    }

    // Meta Stat Pills
    if (metaPillsEl) {
        const pills = [
            `<span class="detail-meta-pill accent-pill">${detailData.trackCount} ${detailData.trackCount === 1 ? "Track" : "Tracks"}</span>`,
            `<span class="detail-meta-pill">${detailData.totalDurationFormatted}</span>`,
            `<span class="detail-meta-pill">${detailData.avgBpm} BPM Avg</span>`,
            `<span class="detail-meta-pill">${detailData.avgEnergyPct}% Energy</span>`,
        ];
        if (detailData.totalPlays > 0) {
            pills.push(
                `<span class="detail-meta-pill accent-pill">${detailData.totalPlays} ${detailData.totalPlays === 1 ? "Play" : "Plays"}</span>`
            );
        }
        if (detailData.likedCount > 0) {
            pills.push(
                `<span class="detail-meta-pill accent-pill">♥ ${detailData.likedCount} Liked</span>`
            );
        }
        for (const mood of (detailData.moods || []).slice(0, 4)) {
            pills.push(`<span class="detail-meta-pill">${mood}</span>`);
        }
        metaPillsEl.innerHTML = pills.join("");
    }

    // Collaborator / Artist / Album Chips
    if (collabsEl) {
        const chipNodes = [];
        for (const artistName of detailData.collaborators || []) {
            const chip = document.createElement("button");
            chip.type = "button";
            chip.className = "detail-collab-chip";
            chip.dataset.openArtist = artistName;
            chip.textContent =
                detailData.type === "artist" ? `Collab: ${artistName}` : `Artist: ${artistName}`;
            chip.addEventListener("click", () => openArtistDetail(artistName));
            chipNodes.push(chip);
        }
        if (detailData.type === "song" && detailData.album) {
            const albumChip = document.createElement("button");
            albumChip.type = "button";
            albumChip.className = "detail-collab-chip";
            albumChip.dataset.openAlbum = detailData.album;
            albumChip.textContent = `Album: ${detailData.album}`;
            albumChip.addEventListener("click", () => openAlbumDetail(detailData.album));
            chipNodes.push(albumChip);
        }
        collabsEl.replaceChildren(...chipNodes);
    }

    // 1. Top Tracks / Album Tracklist
    if (topTracksTitle) {
        topTracksTitle.textContent = isCollection
            ? detailData.tracklistTitle || "Tracks"
            : detailData.type === "artist"
                ? `Top Tracks by ${detailData.title}`
                : detailData.type === "album"
                  ? "Album Tracklist"
                  : `Featured Song & More by ${detailData.primaryArtist}`;
    }
    if (topTracksCount) {
        topTracksCount.textContent = `${detailData.topTracks.length} ${detailData.topTracks.length === 1 ? "track" : "tracks"}`;
    }
    if (topTracksContainer) {
        renderDetailTracklistChunked(topTracksContainer, detailData.topTracks || [], {
            collection: detailData.collection || null,
            listKey: `${detailData.type}:${detailData.id}`,
        });
    }

    // 2. Song Audio Profile & Taste Telemetry
    if (audioProfileSection && audioProfileContainer) {
        if (detailData.type === "song" && detailData.audioProfile) {
            audioProfileSection.hidden = false;
            const ap = detailData.audioProfile;
            audioProfileContainer.innerHTML = ap.metrics
                .map(
                    (m) => `
                <div class="feature-row">
                    <div class="feature-row-header">
                        <span>${m.label}</span>
                        <span>${m.value}%</span>
                    </div>
                    <div class="feature-bar-track">
                        <div class="feature-bar-fill" style="width: ${m.value}%"></div>
                    </div>
                </div>`
                )
                .join("");
        } else {
            audioProfileSection.hidden = true;
            audioProfileContainer.innerHTML = "";
        }
    }

    renderDetailCollectionChrome(detailData);

    // 3. Discography & Albums
    if (discographyTitle) {
        discographyTitle.textContent =
            detailData.type === "artist"
                ? "Discography & Collaborator Releases"
                : detailData.type === "album"
                  ? `More by ${detailData.primaryArtist} & Related Albums`
                  : "Featured Album & Artist Discography";
    }
    if (discographyCount) {
        discographyCount.textContent = `${detailData.discography.length} ${detailData.discography.length === 1 ? "release" : "releases"}`;
    }
    if (discographyContainer) {
        const albumNodes = (detailData.discography || []).map((alb) =>
            createDetailDiscographyCardNode(alb)
        );
        discographyContainer.replaceChildren(...albumNodes);
    }

    // 4. Similar in Your Library Recommendations
    if (similarTitle) {
        similarTitle.textContent = isCollection ? "Recommended Songs" : "Similar in Your Library";
    }
    if (similarSubtitle) {
        similarSubtitle.textContent = `${detailData.similarTracks.length} sonic & collaborator matches`;
    }
    if (similarContainer) {
        const similarNodes = (detailData.similarTracks || []).map((sim) =>
            createDetailSimilarTrackCardNode(sim)
        );
        similarContainer.replaceChildren(...similarNodes);
    }

    return detailData;
}

function openDetailView(spec = {}, options = {}) {
    if (!songs.length) return null;
    // A fresh open starts the track list at its first chunk; only in-place refreshes keep the rows shown
    const prevTracklist = chunkedListState.get("detail-top-tracks");
    if (prevTracklist && typeof prevTracklist.stop === "function") prevTracklist.stop();
    chunkedListState.delete("detail-top-tracks");

    let type = "artist";
    let target = null;

    if (typeof spec === "string") {
        // Resolve whether string matches an artist, album, or track
        const lower = spec.trim().toLowerCase();
        if (songs.some((t) => getTrackArtistList(t).some((a) => a.toLowerCase() === lower))) {
            type = "artist";
            target = spec;
        } else if (songs.some((t) => String(t.album || "").toLowerCase() === lower)) {
            type = "album";
            target = spec;
        } else {
            type = "song";
            target = spec;
        }
    } else if (spec && typeof spec === "object") {
        const rawType = String(spec.type || "").toLowerCase();
        if (COLLECTION_DETAIL_TYPES.includes(rawType)) {
            type = rawType;
            target = spec.playlistId || spec.target || spec.id || rawType;
        } else if (rawType === "album" || (!rawType && spec.album && !spec.artist && !spec.track && !spec.trackId)) {
            type = "album";
            target = spec.album || spec.target || spec.id;
        } else if (
            rawType === "song" ||
            rawType === "track" ||
            (!rawType && (spec.track || spec.trackId))
        ) {
            type = "song";
            target = spec.track || spec.trackId || spec.target || spec.id;
        } else {
            type = "artist";
            target = spec.artist || spec.target || spec.id;
        }
    }

    let detailData = null;
    if (COLLECTION_DETAIL_TYPES.includes(type)) {
        detailData = buildCollectionDetailData({ type, id: target });
    } else if (type === "album") {
        detailData = buildAlbumDetailData(target, options);
    } else if (type === "song") {
        detailData = buildSongDetailData(target, options);
    } else {
        detailData = buildArtistDetailData(target, options);
    }
    if (!detailData) return null;

    activeView = "detail";
    activeDetail = {
        type: detailData.type,
        target: detailData.id,
        id: detailData.id,
        title: detailData.title,
        data: detailData,
    };

    if (!options.skipHistory) {
        pushNavState();
    }

    const detailView = document.getElementById("detail-view");
    const searchView = document.getElementById("search-view");

    runMainViewTransition(() => {
        setHomeSectionsHidden(true);
        if (searchView) searchView.hidden = true;
        if (detailView) {
            detailView.hidden = false;
            detailView.setAttribute("aria-hidden", "false");
            if (typeof detailView.removeAttribute === "function") {
                detailView.removeAttribute("inert");
            }
        }
        // View Transition callbacks run asynchronously in browsers; render the newest data for this
        // detail (e.g. a playlist edited right after opening) rather than the snapshot captured above.
        const latest =
            activeDetail && activeDetail.type === detailData.type && activeDetail.id === detailData.id
                ? activeDetail.data
                : detailData;
        renderDetailView(latest);
    }, "detail-heading");

    return detailData;
}

function openArtistDetail(artistName, options = {}) {
    return openDetailView({ type: "artist", artist: artistName }, options);
}

function openAlbumDetail(albumName, options = {}) {
    return openDetailView({ type: "album", album: albumName }, options);
}

function openSongDetail(trackOrId, options = {}) {
    return openDetailView({ type: "song", track: trackOrId }, options);
}

function closeDetailView(options = {}) {
    activeView = "home";
    updateImportProgressUi();
    activeDetail = null;

    if (!options.skipHistory) {
        pushNavState();
    }

    const detailView = document.getElementById("detail-view");
    const searchView = document.getElementById("search-view");
    runMainViewTransition(() => {
        if (detailView) {
            detailView.hidden = true;
            detailView.setAttribute("aria-hidden", "true");
            detailView.setAttribute("inert", "inert");
        }
        if (searchView) {
            searchView.hidden = true;
            searchView.setAttribute("aria-hidden", "true");
            searchView.setAttribute("inert", "inert");
        }
        setHomeSectionsHidden(false);
    }, options.skipFocus ? null : "catalog-section-title");

    syncPrimaryNavUI();
    return true;
}

function startDetailMix(options = {}) {
    if (!activeDetail || !activeDetail.data) {
        return startRadioMix({ type: "supermix" }, options);
    }
    return startRadioMix(activeDetail.data.seedSpec, options);
}

// ==================== INSTANT OMNI-SEARCH & SEARCH RADIO MIX (ITEM 9) ====================

const VALID_SEARCH_CATEGORIES = ["all", "songs", "artists", "albums", "moods"];

function normalizeSearchCategory(category) {
    const clean = String(category || "all")
        .trim()
        .toLowerCase();
    return VALID_SEARCH_CATEGORIES.includes(clean) ? clean : "all";
}

function syncPrimaryNavUI() {
    const navHome = document.getElementById("nav-home");
    const navSearch = document.getElementById("nav-search");
    if (navHome) {
        navHome.classList.toggle("active", activeView === "home");
    }
    if (navSearch) {
        navSearch.classList.toggle("active", activeView === "search");
    }
}

function scoreSearchFieldMatch(value, queryLower, tokens) {
    if (!queryLower) {
        return { matched: true, score: 0.5, matchType: "explore" };
    }
    const text = String(value || "")
        .trim()
        .toLowerCase();
    if (!text) {
        return { matched: false, score: 0, matchType: null };
    }
    if (text === queryLower) {
        return { matched: true, score: 1.0, matchType: "exact" };
    }
    if (text.startsWith(queryLower)) {
        return { matched: true, score: 0.92, matchType: "prefix" };
    }
    const words = text.split(/[\s,\-()/&•]+/).filter(Boolean);
    if (words.some((w) => w === queryLower)) {
        return { matched: true, score: 0.88, matchType: "word-exact" };
    }
    if (words.some((w) => w.startsWith(queryLower))) {
        return { matched: true, score: 0.83, matchType: "word-prefix" };
    }
    if (text.includes(queryLower)) {
        return { matched: true, score: 0.75, matchType: "substring" };
    }
    if (tokens.length > 1) {
        const hitCount = tokens.filter((tk) => text.includes(tk)).length;
        if (hitCount === tokens.length) {
            return { matched: true, score: 0.8, matchType: "all-tokens" };
        }
        if (hitCount > 0) {
            return {
                matched: true,
                score: Number((0.42 + (hitCount / tokens.length) * 0.3).toFixed(3)),
                matchType: "partial-tokens",
            };
        }
    }
    return { matched: false, score: 0, matchType: null };
}

/**
 * Live Instant Omni-Search across songs, artists, albums, and genres/moods/languages.
 * Returns structured results with a "Top Result" hero descriptor and a tailored `seedSpec`
 * for turning any search query into an endless radio station.
 */
function buildOmniSearchResults(queryInput, options = {}) {
    const rawQuery = String(
        queryInput !== undefined ? queryInput : activeSearchQuery || ""
    ).trim();
    const qLower = rawQuery.toLowerCase();
    const tokens = qLower.split(/\s+/).filter(Boolean);
    const moodFilter = options.moodFilter !== undefined ? options.moodFilter : activeMoodFilter;
    const category = normalizeSearchCategory(options.category || activeSearchCategory);
    const isExploreMode = qLower.length === 0;

    const store = getStorage();
    const recommender = getRecommender();

    // Filter candidate pool by active mood chip if requested
    const moodFilteredPool = songs.filter((track) => {
        if (!moodFilter || moodFilter === "All" || options.ignoreMoodFilter) return true;
        return (
            (Array.isArray(track.moods) &&
                track.moods.some((m) => m.toLowerCase() === moodFilter.toLowerCase())) ||
            (track.genre && track.genre.toLowerCase() === moodFilter.toLowerCase()) ||
            (track.language && track.language.toLowerCase() === moodFilter.toLowerCase())
        );
    });
    const basePool = moodFilteredPool.length > 0 ? moodFilteredPool : songs;

    // 1. Score & filter Songs
    const matchedSongs = [];
    for (const track of basePool) {
        const trackArtists = getTrackArtistList(track);
        const moods = Array.isArray(track.moods) ? track.moods : [];
        const subgenres = Array.isArray(track.subgenres) ? track.subgenres : [];

        const affinity =
            store && typeof store.computeTasteAffinity === "function"
                ? store.computeTasteAffinity(track.id).normalizedScore
                : 0.5;
        const popularity = Number(track.popularity ?? 0.75);
        const tastePrior = affinity * 0.1 + popularity * 0.06;

        if (isExploreMode) {
            matchedSongs.push({
                ...track,
                searchMatch: {
                    score: Number((0.65 + tastePrior).toFixed(3)),
                    directFieldScore: 0.5,
                    matchedField: "explore",
                    matchReason:
                        likedTrackIds.has(track.id)
                            ? "♥ Liked Favorite"
                            : `${track.genre || "Pop"} • ${track.bpm || 110} BPM`,
                },
            });
            continue;
        }

        const titleRes = scoreSearchFieldMatch(track.title, qLower, tokens);
        const artistMatches = trackArtists.map((a) => ({
            artist: a,
            ...scoreSearchFieldMatch(a, qLower, tokens),
        }));
        artistMatches.sort((a, b) => b.score - a.score);
        const bestArtistRes = artistMatches[0] || { score: 0, matched: false, artist: track.primaryArtist };
        const displayArtistRes = scoreSearchFieldMatch(track.artistDisplay, qLower, tokens);
        const artistScore = Math.max(bestArtistRes.score, displayArtistRes.score);

        const albumRes = scoreSearchFieldMatch(track.album, qLower, tokens);
        const genreRes = scoreSearchFieldMatch(track.genre, qLower, tokens);
        const subgenreMatches = subgenres.map((sg) => ({
            subgenre: sg,
            ...scoreSearchFieldMatch(sg, qLower, tokens),
        }));
        subgenreMatches.sort((a, b) => b.score - a.score);
        const bestSubgenreRes = subgenreMatches[0] || { score: 0, matched: false };

        const moodMatches = moods.map((m) => ({
            mood: m,
            ...scoreSearchFieldMatch(m, qLower, tokens),
        }));
        moodMatches.sort((a, b) => b.score - a.score);
        const bestMoodRes = moodMatches[0] || { score: 0, matched: false };

        const langRes = scoreSearchFieldMatch(track.language, qLower, tokens);
        const yearRes = scoreSearchFieldMatch(String(track.year || ""), qLower, tokens);

        const combinedHaystack = [
            track.title,
            track.artistDisplay,
            ...trackArtists,
            track.album,
            track.genre,
            ...subgenres,
            ...moods,
            track.language,
            track.year ? String(track.year) : "",
        ]
            .filter(Boolean)
            .join(" ")
            .toLowerCase();

        const allTokensInCombined =
            tokens.length > 0 && tokens.every((tk) => combinedHaystack.includes(tk));
        const directSubstringInCombined = combinedHaystack.includes(qLower);

        if (!allTokensInCombined && !directSubstringInCombined) {
            continue;
        }

        // Determine highest-scoring field and human-readable matchReason
        const candidates = [
            {
                field: "title",
                rawScore: titleRes.score,
                weighted: titleRes.score * 1.06,
                reason:
                    titleRes.matchType === "exact"
                        ? "Exact Song Match"
                        : "Title Match",
            },
            {
                field: "artist",
                rawScore: artistScore,
                weighted: artistScore * 0.98,
                reason: `Artist • ${bestArtistRes.artist || track.primaryArtist}`,
            },
            {
                field: "album",
                rawScore: albumRes.score,
                weighted: albumRes.score * 0.92,
                reason: `Album • ${track.album}`,
            },
            {
                field: "genre",
                rawScore: Math.max(genreRes.score, bestSubgenreRes.score),
                weighted: Math.max(genreRes.score, bestSubgenreRes.score) * 0.88,
                reason:
                    genreRes.score >= bestSubgenreRes.score
                        ? `Genre • ${track.genre}`
                        : `Subgenre • ${bestSubgenreRes.subgenre}`,
            },
            {
                field: "mood",
                rawScore: bestMoodRes.score,
                weighted: bestMoodRes.score * 0.88,
                reason: `Mood • ${bestMoodRes.mood || moods[0] || "Vibe"}`,
            },
            {
                field: "language",
                rawScore: Math.max(langRes.score, yearRes.score),
                weighted: Math.max(langRes.score, yearRes.score) * 0.84,
                reason:
                    langRes.score >= yearRes.score
                        ? `Language • ${track.language}`
                        : `Year • ${track.year}`,
            },
        ];

        candidates.sort((a, b) => b.weighted - a.weighted);
        const topField = candidates[0];
        const multiFieldHits = candidates.filter((c) => c.rawScore >= 0.7).length;
        const multiFieldBonus = multiFieldHits > 1 ? Math.min(0.12, (multiFieldHits - 1) * 0.05) : 0;
        const baseScore = topField.weighted > 0 ? topField.weighted : 0.68;
        const totalScore = Math.min(1, Number((baseScore + multiFieldBonus + tastePrior * 0.5).toFixed(3)));

        matchedSongs.push({
            ...track,
            searchMatch: {
                score: totalScore,
                titleScore: titleRes.score,
                artistScore,
                albumScore: albumRes.score,
                genreScore: Math.max(genreRes.score, bestSubgenreRes.score),
                moodScore: bestMoodRes.score,
                matchedField: topField.rawScore > 0 ? topField.field : "combined",
                matchReason:
                    multiFieldHits > 1 && topField.rawScore > 0
                        ? `${topField.reason} + Multi-Match`
                        : topField.rawScore > 0
                          ? topField.reason
                          : "Catalog Match",
            },
        });
    }

    matchedSongs.sort((a, b) => (b.searchMatch?.score || 0) - (a.searchMatch?.score || 0));
    const matchedSongIds = new Set(matchedSongs.map((t) => t.id));

    // 2. Score & filter Artists across primary + featured artists
    const artistMap = new Map();
    for (const track of songs) {
        for (const artistName of getTrackArtistList(track)) {
            const key = artistName.toLowerCase();
            if (!artistMap.has(key)) {
                artistMap.set(key, {
                    artist: artistName,
                    tracks: [],
                    genres: new Set(),
                    moods: new Set(),
                    albums: new Set(),
                    languages: new Set(),
                });
            }
            const entry = artistMap.get(key);
            entry.tracks.push(track);
            if (track.genre) entry.genres.add(track.genre);
            if (track.album) entry.albums.add(track.album);
            if (track.language) entry.languages.add(track.language);
            for (const m of track.moods || []) entry.moods.add(m);
        }
    }

    const matchedArtists = [];
    for (const entry of artistMap.values()) {
        const nameRes = scoreSearchFieldMatch(entry.artist, qLower, tokens);
        const genresArr = Array.from(entry.genres);
        const moodsArr = Array.from(entry.moods);
        const albumsArr = Array.from(entry.albums);
        const langsArr = Array.from(entry.languages);

        const matchingArtistTracks = entry.tracks.filter((t) => matchedSongIds.has(t.id));
        const genreScore = Math.max(
            0,
            ...genresArr.map((g) => scoreSearchFieldMatch(g, qLower, tokens).score)
        );
        const moodScore = Math.max(
            0,
            ...moodsArr.map((m) => scoreSearchFieldMatch(m, qLower, tokens).score)
        );
        const langScore = Math.max(
            0,
            ...langsArr.map((l) => scoreSearchFieldMatch(l, qLower, tokens).score)
        );

        if (!isExploreMode && !nameRes.matched && matchingArtistTracks.length === 0 && genreScore === 0 && moodScore === 0 && langScore === 0) {
            continue;
        }

        const leadTrack =
            entry.tracks.find(
                (t) => String(t.primaryArtist || "").toLowerCase() === entry.artist.toLowerCase()
            ) || entry.tracks[0];

        const avgPopularity =
            entry.tracks.reduce((s, t) => s + Number(t.popularity ?? 0.75), 0) /
            Math.max(1, entry.tracks.length);

        let artistScore = 0.6 + avgPopularity * 0.1;
        let matchReason = `${genresArr.join(" / ") || "Artist"} • ${entry.tracks.length} ${entry.tracks.length === 1 ? "song" : "songs"}`;

        if (!isExploreMode) {
            if (nameRes.matched) {
                artistScore = Math.min(1, Number((nameRes.score * 1.04 + avgPopularity * 0.05).toFixed(3)));
                matchReason =
                    nameRes.matchType === "exact" ? "Exact Artist Match" : "Artist Match";
            } else if (genreScore >= 0.75 || moodScore >= 0.75 || langScore >= 0.75) {
                const topTagScore = Math.max(genreScore, moodScore, langScore);
                artistScore = Number((topTagScore * 0.8 + avgPopularity * 0.06).toFixed(3));
                matchReason = `${genresArr[0] || "Vibe"} Artist`;
            } else {
                artistScore = Number((0.64 + Math.min(0.15, matchingArtistTracks.length * 0.05)).toFixed(3));
                matchReason = `Featured on ${matchingArtistTracks[0]?.title || "matching song"}`;
            }
        }

        matchedArtists.push({
            type: "artist",
            id: entry.artist,
            artist: entry.artist,
            title: entry.artist,
            coverUrl: leadTrack?.coverUrl || "Images/Espresso.jpeg",
            trackCount: entry.tracks.length,
            albumCount: albumsArr.length,
            genres: genresArr,
            moods: moodsArr,
            albums: albumsArr,
            languages: langsArr,
            tracks: entry.tracks,
            score: artistScore,
            nameScore: isExploreMode ? 0.5 : nameRes.score,
            matchReason,
            seedSpec: { type: "artist", artist: entry.artist },
        });
    }
    matchedArtists.sort((a, b) => b.score - a.score || b.trackCount - a.trackCount);

    // 3. Score & filter Albums
    const albumMap = new Map();
    for (const track of songs) {
        const albName = track.album || `${track.title} (Single)`;
        if (!albumMap.has(albName)) {
            albumMap.set(albName, []);
        }
        albumMap.get(albName).push(track);
    }

    const matchedAlbums = [];
    for (const [albName, albTracks] of albumMap.entries()) {
        const summary = buildAlbumSummaryObject(albName, albTracks, "Album / Single", false);
        const albumRes = scoreSearchFieldMatch(albName, qLower, tokens);
        const artistRes = Math.max(
            0,
            ...summary.artists.map((a) => scoreSearchFieldMatch(a, qLower, tokens).score)
        );
        const genreRes = scoreSearchFieldMatch(summary.genre, qLower, tokens);
        const yearRes = scoreSearchFieldMatch(String(summary.year || ""), qLower, tokens);
        const hasMatchedSong = albTracks.some((t) => matchedSongIds.has(t.id));

        if (!isExploreMode && !albumRes.matched && artistRes === 0 && !genreRes.matched && !yearRes.matched && !hasMatchedSong) {
            continue;
        }

        let albumScore = 0.58;
        let matchReason = `${summary.year} • ${summary.genre}`;
        if (!isExploreMode) {
            if (albumRes.matched && albumRes.score >= artistRes) {
                albumScore = Math.min(1, Number((albumRes.score * 1.03).toFixed(3)));
                matchReason =
                    albumRes.matchType === "exact" ? "Exact Album Match" : "Album Match";
            } else if (artistRes > 0) {
                albumScore = Number((artistRes * 0.86).toFixed(3));
                matchReason = `By ${summary.artistDisplay}`;
            } else if (genreRes.matched || yearRes.matched) {
                albumScore = Number((Math.max(genreRes.score, yearRes.score) * 0.8).toFixed(3));
                matchReason = `${summary.genre} • ${summary.year}`;
            } else {
                albumScore = 0.65;
                matchReason = `Includes ${albTracks.find((t) => matchedSongIds.has(t.id))?.title || "matching track"}`;
            }
        }

        matchedAlbums.push({
            ...summary,
            type: "album",
            id: albName,
            title: albName,
            score: albumScore,
            albumNameScore: isExploreMode ? 0.5 : albumRes.score,
            matchReason,
            seedSpec: { type: "album", album: albName },
        });
    }
    matchedAlbums.sort((a, b) => b.score - a.score || b.year - a.year);

    // 4. Score & filter Genres, Moods & Languages
    const categoryCatalog = new Map();
    const registerCategory = (name, categoryType, track) => {
        const clean = String(name || "").trim();
        if (!clean) return;
        const key = `${categoryType}:${clean.toLowerCase()}`;
        if (!categoryCatalog.has(key)) {
            categoryCatalog.set(key, {
                id: clean,
                name: clean,
                categoryType,
                badge:
                    categoryType === "genre"
                        ? "GENRE RADIO"
                        : categoryType === "language"
                          ? "LANGUAGE MIX"
                          : categoryType === "subgenre"
                            ? "SUBGENRE VIBE"
                            : "MOOD VIBE",
                tracks: [],
                artists: new Set(),
            });
        }
        const entry = categoryCatalog.get(key);
        if (!entry.tracks.some((t) => t.id === track.id)) {
            entry.tracks.push(track);
        }
        if (track.primaryArtist) entry.artists.add(track.primaryArtist);
    };

    for (const track of songs) {
        if (track.genre) registerCategory(track.genre, "genre", track);
        if (track.language) registerCategory(track.language, "language", track);
        for (const m of track.moods || []) registerCategory(m, "mood", track);
        for (const sg of track.subgenres || []) registerCategory(sg, "subgenre", track);
    }

    const matchedMoods = [];
    const seenMoodNames = new Set();
    for (const entry of categoryCatalog.values()) {
        const lowerName = entry.name.toLowerCase();
        if (seenMoodNames.has(lowerName)) continue;

        const tagRes = scoreSearchFieldMatch(entry.name, qLower, tokens);
        const overlapWithMatchedSongs = entry.tracks.filter((t) => matchedSongIds.has(t.id)).length;

        if (!isExploreMode && !tagRes.matched && overlapWithMatchedSongs === 0) {
            continue;
        }

        let tagScore = 0.5 + Math.min(0.2, entry.tracks.length * 0.02);
        let matchReason = `${entry.tracks.length} ${entry.tracks.length === 1 ? "track" : "tracks"}`;

        if (!isExploreMode) {
            if (tagRes.matched) {
                tagScore = Math.min(1, Number((tagRes.score * 1.02).toFixed(3)));
                matchReason =
                    tagRes.matchType === "exact"
                        ? `Exact ${entry.categoryType.toUpperCase()} Match`
                        : `${entry.badge}`;
            } else {
                tagScore = Number((0.55 + Math.min(0.2, overlapWithMatchedSongs * 0.08)).toFixed(3));
                matchReason = `Related Vibe (${overlapWithMatchedSongs} matching ${overlapWithMatchedSongs === 1 ? "song" : "songs"})`;
            }
        }

        seenMoodNames.add(lowerName);
        const sampleArtists = Array.from(entry.artists).slice(0, 3);
        matchedMoods.push({
            type: entry.categoryType === "genre" ? "genre" : "mood",
            id: entry.name,
            name: entry.name,
            title: entry.name,
            categoryType: entry.categoryType,
            badge: entry.badge,
            trackCount: entry.tracks.length,
            tracks: entry.tracks,
            sampleArtists,
            subtitle: sampleArtists.length
                ? `Feat. ${sampleArtists.join(", ")}`
                : `${entry.tracks.length} tracks in catalog`,
            coverUrl: entry.tracks[0]?.coverUrl || "Images/Espresso.jpeg",
            score: tagScore,
            tagScore: isExploreMode ? 0.5 : tagRes.score,
            matchReason,
            seedSpec: {
                type: "mood",
                mood: entry.name,
                badge: entry.badge,
                label: `${entry.name} Vibe Radio`,
                tracks: entry.tracks,
            },
        });
    }
    matchedMoods.sort((a, b) => b.score - a.score || b.trackCount - a.trackCount);

    // 5. Build Tailored Search Radio Seed Tracks (even if 0 literal substring matches!)
    let seedTracks = matchedSongs.slice(0, 6);
    if (seedTracks.length === 0 && songs.length > 0) {
        if (recommender && typeof recommender.recommendTracks === "function") {
            seedTracks = recommender.recommendTracks(songs, {
                seed: rawQuery ? { query: rawQuery } : { mood: moodFilter || "All" },
                limit: 6,
                storage: store,
                mixMode: activeMixMode,
            });
        }
        if (seedTracks.length === 0) {
            seedTracks = songs.slice(0, 4);
        }
    }

    const searchSeedSpec = isExploreMode
        ? moodFilter && moodFilter !== "All"
            ? { type: "mood", mood: moodFilter }
            : { type: "supermix" }
        : {
              type: "search",
              query: rawQuery,
              tracks: seedTracks,
              badge: "SEARCH MIX",
              label: `Search Mix: "${rawQuery}"`,
          };

    // 6. Select the "Top Result" Hero Card across Song, Artist, Album, and Genre/Mood
    const topSong = matchedSongs[0] || null;
    const topArtist = matchedArtists[0] || null;
    const topAlbum = matchedAlbums[0] || null;
    const topMood = matchedMoods[0] || null;

    let topResult = null;

    if (isExploreMode) {
        const heroTrack = topSong || songs[currentTrackIndex] || songs[0];
        if (moodFilter && moodFilter !== "All") {
            topResult = {
                type: "mood",
                id: moodFilter,
                mood: moodFilter,
                title: `${moodFilter} Vibe Radio`,
                subtitle: `${basePool.length} matching tracks • Dynamic mood station`,
                badge: "TOP RESULT • MOOD STATION",
                coverUrl: heroTrack?.coverUrl || "Images/Espresso.jpeg",
                score: 1,
                matchReason: "Active Mood Filter",
                pills: [
                    `${basePool.length} Tracks`,
                    `${heroTrack?.bpm || 110} BPM`,
                    "Nonstop Radio",
                ],
                tracks: basePool,
                seedSpec: { type: "mood", mood: moodFilter },
                playLabel: `Play ${moodFilter}`,
                mixLabel: `Start ${moodFilter} Mix`,
                detailLabel: "Filter Catalog",
            };
        } else if (heroTrack) {
            topResult = {
                type: "song",
                id: heroTrack.id,
                track: heroTrack,
                title: heroTrack.title,
                subtitle: `Song • ${heroTrack.artistDisplay} • ${heroTrack.album}`,
                badge: "TOP RESULT • FEATURED TRACK",
                coverUrl: heroTrack.coverUrl,
                score: heroTrack.searchMatch?.score || 0.95,
                matchReason: heroTrack.searchMatch?.matchReason || "Featured Pick",
                pills: [
                    heroTrack.genre || "Pop",
                    `${heroTrack.bpm || 110} BPM`,
                    `${Math.round((heroTrack.energy ?? 0.7) * 100)}% Energy`,
                    heroTrack.durationFormatted || "0:00",
                ],
                tracks: [heroTrack],
                seedSpec: { type: "track", track: heroTrack },
                playLabel: "Play Song",
                mixLabel: "Start Song Mix",
                detailLabel: "Song Details",
            };
        }
    } else {
        const songDirectScore = topSong?.searchMatch?.titleScore || 0;
        const artistDirectScore = topArtist?.nameScore || 0;
        const albumDirectScore = topAlbum?.albumNameScore || 0;
        const moodDirectScore = topMood?.tagScore || 0;

        // Pick best entity type based on direct name/title match strength
        let winningType = "song";
        let bestDirect = songDirectScore;

        if (artistDirectScore >= 0.83 && artistDirectScore >= bestDirect) {
            winningType = "artist";
            bestDirect = artistDirectScore;
        }
        if (albumDirectScore >= 0.83 && albumDirectScore > bestDirect) {
            winningType = "album";
            bestDirect = albumDirectScore;
        }
        if (moodDirectScore >= 0.88 && moodDirectScore > bestDirect) {
            winningType = "mood";
            bestDirect = moodDirectScore;
        }

        if (bestDirect < 0.7) {
            // Fall back to highest overall score among available entities
            const rankedEntities = [
                topSong ? { type: "song", score: topSong.searchMatch?.score || 0 } : null,
                topArtist ? { type: "artist", score: topArtist.score || 0 } : null,
                topAlbum ? { type: "album", score: topAlbum.score || 0 } : null,
                topMood ? { type: "mood", score: topMood.score || 0 } : null,
            ].filter(Boolean);
            rankedEntities.sort((a, b) => b.score - a.score);
            winningType = rankedEntities[0]?.type || "search";
        }

        if (winningType === "artist" && topArtist) {
            topResult = {
                type: "artist",
                id: topArtist.artist,
                artist: topArtist.artist,
                title: topArtist.artist,
                subtitle: `Artist • ${topArtist.trackCount} ${topArtist.trackCount === 1 ? "song" : "songs"} • ${topArtist.genres.join(", ") || "Music"}`,
                badge: "TOP RESULT • ARTIST",
                coverUrl: topArtist.coverUrl,
                score: topArtist.score,
                matchReason: topArtist.matchReason,
                pills: [
                    `${topArtist.trackCount} ${topArtist.trackCount === 1 ? "Track" : "Tracks"}`,
                    `${topArtist.albumCount} ${topArtist.albumCount === 1 ? "Release" : "Releases"}`,
                    ...(topArtist.genres || []).slice(0, 2),
                ],
                tracks: topArtist.tracks,
                seedSpec: { type: "artist", artist: topArtist.artist },
                playLabel: "Play Top Tracks",
                mixLabel: `Start ${topArtist.artist} Mix`,
                detailLabel: "Artist Profile",
            };
        } else if (winningType === "album" && topAlbum) {
            topResult = {
                type: "album",
                id: topAlbum.album,
                album: topAlbum.album,
                title: topAlbum.album,
                subtitle: `Album • ${topAlbum.artistDisplay} • ${topAlbum.year}`,
                badge: "TOP RESULT • ALBUM",
                coverUrl: topAlbum.coverUrl,
                score: topAlbum.score,
                matchReason: topAlbum.matchReason,
                pills: [
                    `${topAlbum.trackCount} ${topAlbum.trackCount === 1 ? "Track" : "Tracks"}`,
                    topAlbum.genre || "Music",
                    String(topAlbum.year || 2024),
                    topAlbum.totalDurationFormatted,
                ],
                tracks: topAlbum.tracks,
                seedSpec: { type: "album", album: topAlbum.album },
                playLabel: "Play Album",
                mixLabel: "Start Album Mix",
                detailLabel: "View Album",
            };
        } else if (winningType === "mood" && topMood) {
            topResult = {
                type: topMood.type,
                id: topMood.name,
                mood: topMood.name,
                title: `${topMood.name}`,
                subtitle: `${topMood.badge} • ${topMood.trackCount} tracks • ${topMood.subtitle}`,
                badge: `TOP RESULT • ${topMood.badge}`,
                coverUrl: topMood.coverUrl,
                score: topMood.score,
                matchReason: topMood.matchReason,
                pills: [
                    `${topMood.trackCount} Tracks`,
                    topMood.categoryType.toUpperCase(),
                    ...topMood.sampleArtists.slice(0, 2),
                ],
                tracks: topMood.tracks,
                seedSpec: topMood.seedSpec,
                playLabel: `Play ${topMood.name}`,
                mixLabel: `Start ${topMood.name} Mix`,
                detailLabel: "Apply Filter",
            };
        } else if (topSong) {
            topResult = {
                type: "song",
                id: topSong.id,
                track: topSong,
                title: topSong.title,
                subtitle: `Song • ${topSong.artistDisplay} • ${topSong.album}`,
                badge: "TOP RESULT • SONG",
                coverUrl: topSong.coverUrl,
                score: topSong.searchMatch?.score || 0.9,
                matchReason: topSong.searchMatch?.matchReason || "Song Match",
                pills: [
                    topSong.genre || "Pop",
                    `${topSong.bpm || 110} BPM`,
                    `${Math.round((topSong.energy ?? 0.7) * 100)}% Energy`,
                    topSong.durationFormatted || "0:00",
                ],
                tracks: [topSong],
                seedSpec: { type: "track", track: topSong },
                playLabel: "Play Song",
                mixLabel: "Start Song Mix",
                detailLabel: "Song Details",
            };
        } else {
            // Custom Vibe Fallback when 0 literal matches exist
            const fallbackLead = seedTracks[0] || songs[0];
            topResult = {
                type: "search",
                id: rawQuery,
                query: rawQuery,
                title: `Search Mix: "${rawQuery}"`,
                subtitle: `Custom AI/Sonic Radio Station seeded by your taste & audio features`,
                badge: "TOP RESULT • CUSTOM SEARCH STATION",
                coverUrl: fallbackLead?.coverUrl || "Images/Espresso.jpeg",
                score: 0.75,
                matchReason: "Sonic Fallback Station",
                pills: [
                    `${seedTracks.length} Seed Tracks`,
                    "Endless Auto-Queue",
                    "Multi-Signal Match",
                ],
                tracks: seedTracks,
                seedSpec: searchSeedSpec,
                playLabel: "Start Station",
                mixLabel: "Start Search Mix",
                detailLabel: "Explore All",
            };
        }
    }

    const hasExactMatches =
        matchedSongs.length > 0 ||
        matchedArtists.length > 0 ||
        matchedAlbums.length > 0 ||
        matchedMoods.length > 0;

    return {
        query: rawQuery,
        normalizedQuery: qLower,
        tokens,
        category,
        moodFilter,
        isExploreMode,
        hasExactMatches,
        totalMatches:
            matchedSongs.length +
            matchedArtists.length +
            matchedAlbums.length +
            matchedMoods.length,
        topResult,
        songs: matchedSongs,
        artists: matchedArtists,
        albums: matchedAlbums,
        moods: matchedMoods,
        seedTracks,
        seedSpec: searchSeedSpec,
    };
}

function searchCatalog(queryInput, options = {}) {
    return buildOmniSearchResults(queryInput, options);
}

function createSearchArtistCardNode(artistItem) {
    const card = document.createElement("div");
    card.className = "detail-album-card search-artist-card";
    card.setAttribute("role", "listitem");
    card.dataset.artist = artistItem.artist;

    card.innerHTML = `
        <div class="detail-card-cover-wrap">
            <img src="${artistItem.coverUrl}" alt="${artistItem.artist}" class="detail-card-cover">
        </div>
        <span class="detail-card-relation">${artistItem.matchReason || "Artist Profile"}</span>
        <h4 class="detail-card-title">${artistItem.artist}</h4>
        <p class="detail-card-sub">
            ${artistItem.trackCount} ${artistItem.trackCount === 1 ? "song" : "songs"} &bull; ${(artistItem.genres || []).join(", ") || "Music"}
        </p>
        <div class="card-quick-actions" role="group" aria-label="Artist actions for ${artistItem.artist}">
            <button type="button" class="card-action-btn" data-search-artist-action="open-artist" title="Open ${artistItem.artist} Profile">
                <span>Profile</span>
            </button>
            <button type="button" class="card-action-btn" data-search-artist-action="play-artist" title="Play top songs by ${artistItem.artist}">
                <span>Play</span>
            </button>
            <button type="button" class="card-action-btn mix-action-btn" data-search-artist-action="start-mix" title="Start ${artistItem.artist} Radio Mix">
                <span>Start Mix</span>
            </button>
        </div>
    `;

    if (typeof card.querySelectorAll === "function") {
        card.querySelectorAll("[data-search-artist-action]").forEach((btn) => {
            btn.addEventListener("click", (e) => {
                e.stopPropagation();
                const action = btn.dataset.searchArtistAction;
                if (action === "open-artist") {
                    openArtistDetail(artistItem.artist);
                } else if (action === "play-artist") {
                    const tracks = artistItem.tracks || [];
                    if (tracks.length > 0) {
                        playMusic(tracks[0].id, false);
                        for (let i = 1; i < tracks.length; i++) {
                            addTrackToQueue(tracks[i].id);
                        }
                    }
                } else if (action === "start-mix") {
                    startRadioMix({ type: "artist", artist: artistItem.artist });
                }
            });
        });
    }

    card.addEventListener("click", () => {
        openArtistDetail(artistItem.artist);
    });
    return card;
}

function createSearchMoodCardNode(moodItem) {
    const card = document.createElement("div");
    card.className = "search-mood-card";
    card.setAttribute("role", "listitem");
    card.dataset.mood = moodItem.name;
    card.dataset.categoryType = moodItem.categoryType;

    card.innerHTML = `
        <div class="search-mood-card-header">
            <span class="search-mood-type-pill">${moodItem.badge}</span>
            <span class="search-mood-count">${moodItem.trackCount} ${moodItem.trackCount === 1 ? "track" : "tracks"}</span>
        </div>
        <div>
            <h4 class="search-mood-title">${moodItem.name}</h4>
            <p class="search-mood-sub">${moodItem.subtitle}</p>
        </div>
        <div class="card-quick-actions" role="group" aria-label="Vibe actions for ${moodItem.name}">
            <button type="button" class="card-action-btn" data-search-mood-action="filter" title="Filter by ${moodItem.name}">
                <span>Explore</span>
            </button>
            <button type="button" class="card-action-btn mix-action-btn" data-search-mood-action="start-mix" title="Start ${moodItem.name} Radio Mix">
                <span>Start Mix</span>
            </button>
        </div>
    `;

    if (typeof card.querySelectorAll === "function") {
        card.querySelectorAll("[data-search-mood-action]").forEach((btn) => {
            btn.addEventListener("click", (e) => {
                e.stopPropagation();
                const action = btn.dataset.searchMoodAction;
                if (action === "start-mix") {
                    startRadioMix(moodItem.seedSpec);
                } else {
                    setSearchQuery(moodItem.name);
                }
            });
        });
    }

    card.addEventListener("click", () => {
        startRadioMix(moodItem.seedSpec);
    });
    return card;
}

function triggerTopResultPrimaryAction(topResult) {
    if (!topResult) return null;
    if (topResult.type === "song" && topResult.track) {
        playMusic(topResult.track.id, false);
        return topResult.track;
    }
    if (topResult.type === "artist" && topResult.tracks?.length) {
        playMusic(topResult.tracks[0].id, false);
        for (let i = 1; i < topResult.tracks.length; i++) {
            addTrackToQueue(topResult.tracks[i].id);
        }
        return topResult.tracks[0];
    }
    if (topResult.type === "album" && topResult.tracks?.length) {
        playMusic(topResult.tracks[0].id, false);
        for (let i = 1; i < topResult.tracks.length; i++) {
            addTrackToQueue(topResult.tracks[i].id);
        }
        return topResult.tracks[0];
    }
    return startRadioMix(topResult.seedSpec);
}

function triggerTopResultDetailAction(topResult) {
    if (!topResult) return null;
    if (topResult.type === "artist" && topResult.artist) {
        return openArtistDetail(topResult.artist);
    }
    if (topResult.type === "album" && topResult.album) {
        return openAlbumDetail(topResult.album);
    }
    if (topResult.type === "song" && topResult.track) {
        return openSongDetail(topResult.track.id);
    }
    if ((topResult.type === "mood" || topResult.type === "genre") && topResult.mood) {
        setMoodFilter(topResult.mood);
        return topResult;
    }
    return startRadioMix(topResult.seedSpec);
}

function renderSearchView(resultsInput) {
    const results = resultsInput || buildOmniSearchResults(activeSearchQuery);
    activeSearchResults = results;

    const searchView = document.getElementById("search-view");
    const headingEl = document.getElementById("search-heading");
    const eyebrowEl = document.getElementById("search-eyebrow");
    const summaryEl = document.getElementById("search-summary");
    const startMixBtn = document.getElementById("search-start-mix-btn");
    const startMixLabel = document.getElementById("search-start-mix-label");
    const playAllLabel = document.getElementById("search-play-all-label");

    const topGridEl = document.getElementById("search-top-grid");
    const topResultSection = document.getElementById("search-top-result-section");
    const topResultScoreEl = document.getElementById("search-top-result-score");
    const topResultCard = document.getElementById("search-top-result-card");
    const topResultCover = document.getElementById("search-top-result-cover");
    const topResultBadge = document.getElementById("search-top-result-badge");
    const topResultTitle = document.getElementById("search-top-result-title");
    const topResultSubtitle = document.getElementById("search-top-result-subtitle");
    const topResultPills = document.getElementById("search-top-result-pills");
    const topResultPlayLabel = document.getElementById("search-top-result-play-label");
    const topResultMixLabel = document.getElementById("search-top-result-mix-label");
    const topResultDetailLabel = document.getElementById("search-top-result-detail-label");

    const songsSection = document.getElementById("search-songs-section");
    const songsCountEl = document.getElementById("search-songs-count");
    const songsListEl = document.getElementById("search-songs-list");

    const artistsSection = document.getElementById("search-artists-section");
    const artistsCountEl = document.getElementById("search-artists-count");
    const artistsGridEl = document.getElementById("search-artists-grid");

    const albumsSection = document.getElementById("search-albums-section");
    const albumsCountEl = document.getElementById("search-albums-count");
    const albumsGridEl = document.getElementById("search-albums-grid");

    const moodsSection = document.getElementById("search-moods-section");
    const moodsCountEl = document.getElementById("search-moods-count");
    const moodsGridEl = document.getElementById("search-moods-grid");

    const emptyStateEl = document.getElementById("search-empty-state");
    const emptyTitleEl = document.getElementById("search-empty-title");

    if (searchView) {
        searchView.dataset.query = results.query;
        searchView.dataset.category = activeSearchCategory;
    }

    // Sync category tab buttons
    document.querySelectorAll("#search-category-tabs .search-cat-tab").forEach((tab) => {
        const isSelected = (tab.dataset.searchTab || "all") === activeSearchCategory;
        tab.classList.toggle("active", isSelected);
        tab.setAttribute("aria-selected", String(isSelected));
    });

    // Header copy & Start Search Mix button label
    if (eyebrowEl) {
        eyebrowEl.textContent = results.isExploreMode
            ? "OMNI-SEARCH & VIBE EXPLORER • HYBRID RADIO"
            : `INSTANT OMNI-SEARCH • ${results.songs.length} SONGS • ${results.artists.length} ARTISTS • ${results.albums.length} ALBUMS`;
    }
    if (headingEl) {
        headingEl.textContent = results.isExploreMode
            ? "Explore & Search Catalog"
            : `Results for "${results.query}"`;
        headingEl.setAttribute("tabindex", "-1");
    }
    if (summaryEl) {
        summaryEl.textContent = results.isExploreMode
            ? `Browse all ${results.songs.length} tracks, ${results.artists.length} artists, ${results.albums.length} albums, and ${results.moods.length} genres & moods — or type above to filter live.`
            : results.hasExactMatches
              ? `Found ${results.songs.length} ${results.songs.length === 1 ? "song" : "songs"}, ${results.artists.length} ${results.artists.length === 1 ? "artist" : "artists"}, ${results.albums.length} ${results.albums.length === 1 ? "album" : "albums"}, and ${results.moods.length} ${results.moods.length === 1 ? "vibe" : "vibes"} — click Start Search Mix for a tailored endless station.`
              : `No exact literal match for "${results.query}", but our hybrid engine prepared a ${results.seedTracks.length}-track sonic radio station for this query.`;
    }
    if (startMixLabel) {
        startMixLabel.textContent = results.isExploreMode
            ? "Start Supermix Radio"
            : `Start "${results.query}" Mix`;
    }
    if (startMixBtn) {
        startMixBtn.dataset.query = results.query;
    }
    if (playAllLabel) {
        playAllLabel.textContent =
            results.songs.length > 0
                ? `Play Top ${Math.min(results.songs.length, 6)} Matches`
                : "Play Recommended";
    }

    // Top Result Hero Card
    const top = results.topResult;
    if (top && topResultCard) {
        topResultCard.dataset.topType = top.type;
        topResultCard.dataset.topId = top.id;
        if (topResultCover) {
            topResultCover.src = top.coverUrl;
            topResultCover.alt = top.title;
        }
        if (topResultBadge) {
            topResultBadge.textContent = top.badge;
        }
        if (topResultTitle) {
            topResultTitle.textContent = top.title;
        }
        if (topResultSubtitle) {
            topResultSubtitle.textContent = top.subtitle;
        }
        if (topResultScoreEl) {
            topResultScoreEl.textContent = top.matchReason || "Top match";
        }
        if (topResultPills) {
            topResultPills.innerHTML = (top.pills || [])
                .map((p) => `<span class="detail-meta-pill">${p}</span>`)
                .join("");
        }
        if (topResultPlayLabel) {
            topResultPlayLabel.textContent = top.playLabel || "Play";
        }
        if (topResultMixLabel) {
            topResultMixLabel.textContent = top.mixLabel || "Start Mix";
        }
        if (topResultDetailLabel) {
            topResultDetailLabel.textContent = top.detailLabel || "Details";
        }
    }

    // Category visibility rules
    const showTopResult = activeSearchCategory === "all" && Boolean(top);
    const showSongs =
        (activeSearchCategory === "all" || activeSearchCategory === "songs") &&
        results.songs.length > 0;
    const showArtists =
        (activeSearchCategory === "all" || activeSearchCategory === "artists") &&
        results.artists.length > 0;
    const showAlbums =
        (activeSearchCategory === "all" || activeSearchCategory === "albums") &&
        results.albums.length > 0;
    const showMoods =
        (activeSearchCategory === "all" || activeSearchCategory === "moods") &&
        results.moods.length > 0;

    if (topResultSection) {
        topResultSection.hidden = !showTopResult;
    }
    if (songsSection) {
        songsSection.hidden = !showSongs;
    }
    if (topGridEl) {
        topGridEl.hidden = !showTopResult && !showSongs;
        topGridEl.classList.toggle("single-col", !showTopResult || !showSongs);
    }

    // Render Matching Songs List
    const maxSongs = activeSearchCategory === "songs" ? results.songs.length : 6;
    const visibleSongs = results.songs.slice(0, maxSongs);
    if (songsCountEl) {
        songsCountEl.textContent = `${results.songs.length} ${results.songs.length === 1 ? "song" : "songs"}`;
    }
    if (songsListEl) {
        const songNodes = visibleSongs.map((t, idx) => createDetailTrackRowNode(t, idx));
        songsListEl.replaceChildren(...songNodes);
    }

    // Render Matching Artists Grid
    if (artistsSection) {
        artistsSection.hidden = !showArtists;
    }
    if (artistsCountEl) {
        artistsCountEl.textContent = `${results.artists.length} ${results.artists.length === 1 ? "artist" : "artists"}`;
    }
    if (artistsGridEl) {
        const artistNodes = results.artists.map((a) => createSearchArtistCardNode(a));
        artistsGridEl.replaceChildren(...artistNodes);
    }

    // Render Matching Albums Grid
    if (albumsSection) {
        albumsSection.hidden = !showAlbums;
    }
    if (albumsCountEl) {
        albumsCountEl.textContent = `${results.albums.length} ${results.albums.length === 1 ? "album" : "albums"}`;
    }
    if (albumsGridEl) {
        const albumNodes = results.albums.map((alb) =>
            createDetailDiscographyCardNode({
                ...alb,
                relationLabel: alb.matchReason || `${alb.year} • ${alb.genre}`,
            })
        );
        albumsGridEl.replaceChildren(...albumNodes);
    }

    // Render Matching Genres & Moods Grid
    if (moodsSection) {
        moodsSection.hidden = !showMoods;
    }
    if (moodsCountEl) {
        moodsCountEl.textContent = `${results.moods.length} ${results.moods.length === 1 ? "vibe" : "vibes"}`;
    }
    if (moodsGridEl) {
        const moodNodes = results.moods.map((m) => createSearchMoodCardNode(m));
        moodsGridEl.replaceChildren(...moodNodes);
    }

    // Empty state fallback
    if (emptyStateEl) {
        emptyStateEl.hidden = results.hasExactMatches;
        if (!results.hasExactMatches && emptyTitleEl) {
            emptyTitleEl.textContent = `No exact catalog match for "${results.query}"`;
        }
    }

    // Also update top navbar search mix button pill label
    const navbarSearchMixBtn = document.getElementById("search-mix-btn");
    if (navbarSearchMixBtn) {
        navbarSearchMixBtn.title = results.query
            ? `Start a nonstop radio mix from "${results.query}"`
            : "Start a radio mix from current search or filter";
    }

    return results;
}

function openSearchView(queryInput, options = {}) {
    if (queryInput !== undefined && queryInput !== null) {
        activeSearchQuery = String(queryInput).trim();
    }
    if (options.category) {
        activeSearchCategory = normalizeSearchCategory(options.category);
    }

    const searchInput = document.getElementById("search-input");
    const searchClearBtn = document.getElementById("search-clear-btn");
    if (searchInput && searchInput.value !== activeSearchQuery) {
        searchInput.value = activeSearchQuery;
    }
    if (searchClearBtn) {
        searchClearBtn.hidden = activeSearchQuery.length === 0;
    }

    activeView = "search";
    updateImportProgressUi();
    activeDetail = null;

    if (!options.skipHistory) {
        pushNavState();
    }

    const detailView = document.getElementById("detail-view");
    const searchView = document.getElementById("search-view");
    const results = buildOmniSearchResults(activeSearchQuery);

    const updateDom = () => {
        setHomeSectionsHidden(true);
        if (detailView) {
            detailView.hidden = true;
            detailView.setAttribute("aria-hidden", "true");
            detailView.setAttribute("inert", "inert");
        }
        if (searchView) {
            searchView.hidden = false;
            searchView.setAttribute("aria-hidden", "false");
            if (typeof searchView.removeAttribute === "function") {
                searchView.removeAttribute("inert");
            }
        }
        renderSearchView(results);
        renderCatalogGrid();
    };

    if (options.instant) {
        updateDom();
    } else {
        const focusTargetId = options.skipFocus
            ? null
            : options.focusHeading
              ? "search-heading"
              : "search-input";
        runMainViewTransition(updateDom, focusTargetId);
    }

    syncPrimaryNavUI();
    return results;
}

function closeSearchView(options = {}) {
    if (options.clearQuery !== false) {
        activeSearchQuery = "";
        const searchInput = document.getElementById("search-input");
        const searchClearBtn = document.getElementById("search-clear-btn");
        if (searchInput) searchInput.value = "";
        if (searchClearBtn) searchClearBtn.hidden = true;
    }

    activeView = "home";
    updateImportProgressUi();
    activeDetail = null;

    if (!options.skipHistory) {
        pushNavState();
    }

    const detailView = document.getElementById("detail-view");
    const searchView = document.getElementById("search-view");

    runMainViewTransition(() => {
        if (searchView) {
            searchView.hidden = true;
            searchView.setAttribute("aria-hidden", "true");
            searchView.setAttribute("inert", "inert");
        }
        if (detailView) {
            detailView.hidden = true;
            detailView.setAttribute("aria-hidden", "true");
            detailView.setAttribute("inert", "inert");
        }
        setHomeSectionsHidden(false);
        renderCatalogGrid();
    }, options.skipFocus ? null : "catalog-section-title");

    syncPrimaryNavUI();
    return true;
}

function setSearchQuery(queryInput, options = {}) {
    const cleanQuery = String(queryInput ?? "").trim();
    activeSearchQuery = cleanQuery;

    const searchInput = document.getElementById("search-input");
    const searchClearBtn = document.getElementById("search-clear-btn");
    if (searchInput && !options.fromInput && searchInput.value !== cleanQuery) {
        searchInput.value = cleanQuery;
    }
    if (searchClearBtn) {
        searchClearBtn.hidden = cleanQuery.length === 0;
    }

    if (cleanQuery.length > 0 || options.keepSearchViewOpen) {
        const results = openSearchView(cleanQuery, {
            instant: true,
            skipFocus: true,
            skipHistory: Boolean(options.skipHistory),
            category: options.category,
        });
        if (!options.silent) {
            announceSearchStatus(
                cleanQuery
                    ? `Showing ${results.songs.length} songs, ${results.artists.length} artists, ${results.albums.length} albums, and ${results.moods.length} genres or moods for "${cleanQuery}"`
                    : "Explore all songs, artists, albums, and moods"
            );
        }
        return results;
    }

    // Query was cleared -> return to Home view unless explicitly staying in search
    if (activeView === "search") {
        closeSearchView({
            clearQuery: true,
            skipFocus: Boolean(options.fromInput || options.skipFocus),
            skipHistory: Boolean(options.skipHistory),
        });
    } else {
        if (!options.skipHistory) pushNavState();
        renderCatalogGrid();
    }
    return buildOmniSearchResults("");
}

function setSearchCategory(category, options = {}) {
    activeSearchCategory = normalizeSearchCategory(category);
    if (!options.skipHistory && activeView === "search") {
        pushNavState();
    }
    const results = renderSearchView(activeSearchResults || buildOmniSearchResults(activeSearchQuery));
    if (!options.silent) {
        announceSearchStatus(`Filtered search results to ${activeSearchCategory} category`);
    }
    return results;
}

/**
 * Turns any active or provided search query into an endless tailored radio station.
 */
function startSearchMix(queryOrOptions, options = {}) {
    let targetQuery = activeSearchQuery;
    let mixOptions = { ...options };

    if (typeof queryOrOptions === "string") {
        targetQuery = queryOrOptions.trim();
    } else if (queryOrOptions && typeof queryOrOptions === "object") {
        if (typeof queryOrOptions.query === "string") {
            targetQuery = queryOrOptions.query.trim();
        }
        mixOptions = { ...queryOrOptions, ...options };
    }

    const results = buildOmniSearchResults(targetQuery, {
        moodFilter: mixOptions.moodFilter !== undefined ? mixOptions.moodFilter : activeMoodFilter,
    });
    activeSearchResults = results;

    if (targetQuery) {
        const seedTracks =
            Array.isArray(mixOptions.tracks) && mixOptions.tracks.length > 0
                ? mixOptions.tracks
                : results.seedTracks;
        return startRadioMix(
            {
                type: "search",
                query: targetQuery,
                tracks: seedTracks,
                badge: "SEARCH MIX",
                label: `Search Mix: "${targetQuery}"`,
            },
            mixOptions
        );
    }

    if (activeMoodFilter && activeMoodFilter !== "All") {
        return startRadioMix({ type: "mood", mood: activeMoodFilter }, mixOptions);
    }
    return startRadioMix({ type: "supermix" }, mixOptions);
}

function playTopSearchResult() {
    const results = activeSearchResults || buildOmniSearchResults(activeSearchQuery);
    return triggerTopResultPrimaryAction(results.topResult);
}

// ==================== SMART AUTO-MIXES & HOME DASHBOARD SHELVES (ITEM 10) ====================

function getTrackTelemetryContext(track, store, now = Date.now()) {
    const stats =
        store && typeof store.getTrackStats === "function"
            ? store.getTrackStats(track.id)
            : null;
    const affinityObj =
        store && typeof store.computeTasteAffinity === "function"
            ? store.computeTasteAffinity(track.id, now)
            : null;
    const isLiked =
        likedTrackIds.has(track.id) ||
        Boolean(stats?.liked) ||
        Boolean(store && typeof store.isLiked === "function" && store.isLiked(track.id));
    const isDisliked =
        Boolean(stats?.disliked) ||
        Boolean(store && typeof store.isDisliked === "function" && store.isDisliked(track.id));

    return {
        stats,
        affinityScore: Number(affinityObj?.normalizedScore ?? 0.5),
        rawAffinity: Number(affinityObj?.score ?? 0),
        playCount: Number(stats?.playCount || 0),
        fullCompletions: Number(stats?.fullCompletions || 0),
        avgCompletionRatio: Number(stats?.avgCompletionRatio || 0),
        lastCompletionRatio: Number(stats?.lastCompletionRatio || 0),
        earlySkipCount: Number(stats?.earlySkipCount || 0),
        lateSkipCount: Number(stats?.lateSkipCount || 0),
        skipPenalty: Number(stats?.skipPenalty || 0),
        firstPlayedAt: stats?.firstPlayedAt || null,
        lastPlayedAt: stats?.lastPlayedAt || null,
        isLiked,
        isDisliked,
    };
}

function matchesActiveMoodChip(track, moodFilter) {
    if (!moodFilter || moodFilter === "All") return true;
    const target = String(moodFilter).trim().toLowerCase();
    return (
        (Array.isArray(track.moods) &&
            track.moods.some((m) => String(m).toLowerCase() === target)) ||
        String(track.genre || "").toLowerCase() === target ||
        String(track.language || "").toLowerCase() === target
    );
}

function collectDistinctCovers(trackList = [], fallbackTracks = [], count = 4) {
    const covers = [];
    for (const list of [trackList, fallbackTracks]) {
        for (const t of list || []) {
            if (t?.coverUrl && !covers.includes(t.coverUrl)) {
                covers.push(t.coverUrl);
                if (covers.length >= count) return covers;
            }
        }
    }
    while (covers.length < count && covers.length > 0) {
        covers.push(covers[covers.length % covers.length]);
    }
    return covers.length > 0 ? covers : ["Images/Espresso.jpeg"];
}

function collectDistinctArtists(trackList = [], limit = 4) {
    const artists = [];
    for (const t of trackList) {
        for (const a of getTrackArtistList(t)) {
            if (!artists.some((x) => x.toLowerCase() === a.toLowerCase())) {
                artists.push(a);
                if (artists.length >= limit) return artists;
            }
        }
    }
    return artists;
}

/**
 * Automatically builds the YT Music + Spotify Hybrid "Your Supermix" station descriptor.
 * Blends the user's liked songs, high-completion favorites, top taste-affinity tracks,
 * and sonic bridges across the entire catalog.
 */
function buildSupermixData(catalogInput, options = {}) {
    const catalog = Array.isArray(catalogInput) && catalogInput.length > 0 ? catalogInput : songs;
    if (!catalog.length) return null;

    const store = options.storage !== undefined ? options.storage : getStorage();
    const recommender = options.recommender !== undefined ? options.recommender : getRecommender();
    const now = options.now || Date.now();
    const moodFilter = options.moodFilter !== undefined ? options.moodFilter : activeMoodFilter;

    const scored = catalog.map((track, idx) => {
        const ctx = getTrackTelemetryContext(track, store, now);
        const popularity = Number(track.popularity ?? 0.75);
        const moodMatchBoost =
            moodFilter && moodFilter !== "All" && matchesActiveMoodChip(track, moodFilter)
                ? 0.18
                : 0;
        const supermixScore =
            ctx.affinityScore * 0.48 +
            (ctx.isLiked ? 0.26 : 0) +
            Math.min(0.18, ctx.playCount * 0.05 + ctx.fullCompletions * 0.05) +
            ctx.avgCompletionRatio * 0.1 +
            popularity * 0.16 +
            moodMatchBoost -
            ctx.skipPenalty * 0.42 -
            (ctx.isDisliked ? 0.75 : 0);

        return {
            track,
            idx,
            ctx,
            supermixScore: Number(supermixScore.toFixed(4)),
        };
    });

    scored.sort((a, b) => b.supermixScore - a.supermixScore || a.idx - b.idx);

    // Pick diverse top seed tracks across distinct genres/artists so Supermix bridges the whole library
    const seedTracks = [];
    const seenSeedGenres = new Set();
    const seenSeedArtists = new Set();

    for (const item of scored) {
        if (item.ctx.isDisliked && scored.some((s) => !s.ctx.isDisliked)) continue;
        const genreKey = String(item.track.genre || "").toLowerCase();
        const artistKey = String(item.track.primaryArtist || "").toLowerCase();
        const isFavorite = item.ctx.isLiked || item.ctx.fullCompletions > 0 || item.ctx.playCount > 0;
        if (
            seedTracks.length === 0 ||
            isFavorite ||
            !seenSeedGenres.has(genreKey) ||
            !seenSeedArtists.has(artistKey)
        ) {
            seedTracks.push(item.track);
            if (genreKey) seenSeedGenres.add(genreKey);
            if (artistKey) seenSeedArtists.add(artistKey);
        }
        if (seedTracks.length >= 4) break;
    }
    if (seedTracks.length === 0 && scored[0]) {
        seedTracks.push(scored[0].track);
    }

    let orderedTracks = [];
    if (recommender && typeof recommender.recommendTracks === "function") {
        orderedTracks = recommender.recommendTracks(catalog, {
            seed: seedTracks,
            storage: store,
            mixMode: options.mixMode || activeMixMode || "all",
            moodFilter: moodFilter || "All",
            includeSeedTracks: true,
            limit: catalog.length,
            now,
        });
    }
    if (orderedTracks.length === 0) {
        orderedTracks = scored.map((item) => item.track);
    }

    // Ensure the highest-scoring Supermix lead track is first
    const leadTrack = seedTracks[0] || orderedTracks[0] || catalog[0];
    if (leadTrack) {
        orderedTracks = [
            leadTrack,
            ...orderedTracks.filter((t) => t.id !== leadTrack.id),
        ];
    }

    const artists = collectDistinctArtists(orderedTracks, 4);
    const genres = Array.from(new Set(orderedTracks.map((t) => t.genre).filter(Boolean))).slice(0, 3);
    const moods = Array.from(
        new Set(orderedTracks.flatMap((t) => (Array.isArray(t.moods) ? t.moods : [])))
    ).slice(0, 4);
    const avgBpm = Math.round(
        orderedTracks.reduce((s, t) => s + Number(t.bpm || 110), 0) /
            Math.max(1, orderedTracks.length)
    );
    const avgEnergyPct = Math.round(
        (orderedTracks.reduce((s, t) => s + Number(t.energy ?? 0.65), 0) /
            Math.max(1, orderedTracks.length)) *
            100
    );
    const likedCount = scored.filter((s) => s.ctx.isLiked).length;
    const playedCount = scored.filter((s) => s.ctx.playCount > 0).length;
    const collageCovers = collectDistinctCovers(orderedTracks, catalog, 4);

    return {
        id: "supermix",
        smartMixId: "supermix",
        type: "supermix",
        theme: "supermix",
        badge: "YT MUSIC SUPERMIX",
        shortBadge: "SUPERMIX",
        title: "Your Supermix",
        vibeTitle:
            moodFilter && moodFilter !== "All"
                ? `${moodFilter} Hybrid Supermix`
                : "All-in-One Hybrid Station",
        subtitle: `Feat. ${artists.slice(0, 3).join(", ")}${artists.length > 3 ? " & more" : ""}`,
        description:
            likedCount > 0 || playedCount > 0
                ? `Tailored from ${likedCount} liked & ${playedCount} played tracks • ${avgEnergyPct}% Energy • ${avgBpm} BPM`
                : `Nonstop multi-genre blend across ${genres.join(", ")} • ${avgEnergyPct}% Energy • ${avgBpm} BPM`,
        coverUrl: leadTrack?.coverUrl || "Images/Espresso.jpeg",
        collageCovers,
        artists,
        genres,
        moods,
        avgBpm,
        avgEnergyPct,
        likedCount,
        playedCount,
        trackCount: orderedTracks.length,
        tracks: orderedTracks,
        previewTracks: orderedTracks.slice(0, 4),
        recommendedMixMode: "all",
        seedSpec: {
            type: "supermix",
            smartMixId: "supermix",
            badge: "SUPERMIX",
            label: "Your Nonstop Supermix",
            tracks: seedTracks,
        },
    };
}

const DAILY_MIX_CLUSTER_PROFILES = [
    {
        id: "daily-mix-1",
        mixNumber: 1,
        title: "Daily Mix 1",
        vibeTitle: "Bollywood Romance & Soul",
        badge: "DAILY MIX 01",
        shortBadge: "DAILY MIX 1",
        theme: "daily-1",
        recommendedMixMode: "familiar",
        targetGenres: [
            "bollywood romance",
            "bollywood soul",
            "bollywood arabic fusion",
            "devotional / spiritual",
        ],
        targetSubgenres: [
            "romantic ballad",
            "sufi romance",
            "sufi / orchestral",
            "filmi ballad",
            "alternative ballad",
            "acoustic melody",
            "devotional",
            "melody",
        ],
        targetMoods: ["romantic", "soulful", "melancholic", "peaceful", "nostalgic", "chill"],
        targetLanguages: ["hindi"],
        audioMatcher(track) {
            const acoustic = Number(track.acousticness ?? 0.4);
            const energy = Number(track.energy ?? 0.6);
            const bpm = Number(track.bpm ?? 105);
            return acoustic * 0.45 + (1 - Math.min(1, Math.max(0, energy - 0.35))) * 0.3 + (bpm <= 105 ? 0.25 : 0.05);
        },
    },
    {
        id: "daily-mix-2",
        mixNumber: 2,
        title: "Daily Mix 2",
        vibeTitle: "Hip-Hop & High-Voltage Trap",
        badge: "DAILY MIX 02",
        shortBadge: "DAILY MIX 2",
        theme: "daily-2",
        recommendedMixMode: "upbeat",
        targetGenres: ["hip-hop", "rap", "trap"],
        targetSubgenres: [
            "trap",
            "southern hip-hop",
            "west coast hip-hop",
            "hyphy",
            "psychedelic trap",
            "alternative rap",
            "club rap",
            "hardcore hip-hop",
            "rap",
        ],
        targetMoods: ["hype", "workout", "energetic", "late night", "upbeat"],
        targetLanguages: ["english"],
        audioMatcher(track) {
            const energy = Number(track.energy ?? 0.6);
            const dance = Number(track.danceability ?? 0.6);
            const acoustic = Number(track.acousticness ?? 0.3);
            return energy * 0.5 + dance * 0.3 + (1 - acoustic) * 0.2;
        },
    },
    {
        id: "daily-mix-3",
        mixNumber: 3,
        title: "Daily Mix 3",
        vibeTitle: "Pop, Punjabi & Feel-Good Grooves",
        badge: "DAILY MIX 03",
        shortBadge: "DAILY MIX 3",
        theme: "daily-3",
        recommendedMixMode: "all",
        targetGenres: ["pop", "punjabi pop", "bollywood pop"],
        targetSubgenres: [
            "dance pop",
            "nu-disco",
            "synth pop",
            "funk pop",
            "punjabi",
            "desi hip-hop",
            "r&b fusion",
            "world fusion",
            "upbeat filmi",
            "indie pop",
        ],
        targetMoods: ["feel good", "party", "happy", "upbeat"],
        targetLanguages: ["english", "punjabi", "hindi"],
        audioMatcher(track) {
            const valence = Number(track.valence ?? 0.6);
            const dance = Number(track.danceability ?? 0.6);
            const energy = Number(track.energy ?? 0.6);
            return valence * 0.45 + dance * 0.35 + energy * 0.2;
        },
    },
];

function scoreTrackForDailyCluster(track, profile) {
    const genreLower = String(track.genre || "").trim().toLowerCase();
    const langLower = String(track.language || "").trim().toLowerCase();
    const subgenresLower = (Array.isArray(track.subgenres) ? track.subgenres : []).map((s) =>
        String(s).trim().toLowerCase()
    );
    const moodsLower = (Array.isArray(track.moods) ? track.moods : []).map((m) =>
        String(m).trim().toLowerCase()
    );

    const exactGenreMatch = profile.targetGenres.includes(genreLower);
    const partialGenreMatch =
        !exactGenreMatch &&
        profile.targetGenres.some((tg) => genreLower.includes(tg) || tg.includes(genreLower));
    const subgenreHits = subgenresLower.filter((sg) => profile.targetSubgenres.includes(sg)).length;
    const moodHits = moodsLower.filter((m) => profile.targetMoods.includes(m)).length;
    const langMatch = profile.targetLanguages.includes(langLower);
    const audioFit = typeof profile.audioMatcher === "function" ? profile.audioMatcher(track) : 0.5;

    const genreScore = exactGenreMatch ? 0.52 : partialGenreMatch ? 0.28 : 0;
    const subgenreScore = Math.min(0.24, subgenreHits * 0.1);
    const moodScore = Math.min(0.16, moodHits * 0.05);
    const langScore = langMatch ? 0.08 : 0;
    const totalClusterFit = genreScore + subgenreScore + moodScore + langScore + audioFit * 0.18;

    return {
        isCoreMatch: exactGenreMatch || subgenreHits >= 2,
        totalClusterFit: Number(totalClusterFit.toFixed(4)),
    };
}

/**
 * Automatically clusters the catalog by genre, artist, language, and sonic vibe
 * into Spotify-style Daily Mix 1, Daily Mix 2, and Daily Mix 3.
 */
function buildDailyMixes(catalogInput, options = {}) {
    const catalog = Array.isArray(catalogInput) && catalogInput.length > 0 ? catalogInput : songs;
    if (!catalog.length) return [];

    const store = options.storage !== undefined ? options.storage : getStorage();
    const recommender = options.recommender !== undefined ? options.recommender : getRecommender();
    const now = options.now || Date.now();
    const moodFilter = options.moodFilter !== undefined ? options.moodFilter : activeMoodFilter;
    const mixTrackLimit = options.limit || Math.min(6, catalog.length);

    // Partition each track into its strongest primary cluster while also allowing sonic expansion
    const primaryBuckets = new Map(DAILY_MIX_CLUSTER_PROFILES.map((p) => [p.id, []]));

    for (const track of catalog) {
        let bestProfileId = DAILY_MIX_CLUSTER_PROFILES[0].id;
        let bestScore = -Infinity;
        for (const profile of DAILY_MIX_CLUSTER_PROFILES) {
            const fit = scoreTrackForDailyCluster(track, profile);
            if (fit.totalClusterFit > bestScore) {
                bestScore = fit.totalClusterFit;
                bestProfileId = profile.id;
            }
        }
        primaryBuckets.get(bestProfileId).push(track);
    }

    const usedLeadTrackIds = new Set();

    return DAILY_MIX_CLUSTER_PROFILES.map((profile) => {
        const scoredCandidates = catalog.map((track, idx) => {
            const fit = scoreTrackForDailyCluster(track, profile);
            const ctx = getTrackTelemetryContext(track, store, now);
            const isPrimaryBucket = primaryBuckets
                .get(profile.id)
                .some((t) => t.id === track.id);
            const moodChipBoost =
                moodFilter && moodFilter !== "All" && matchesActiveMoodChip(track, moodFilter)
                    ? 0.14
                    : 0;
            const tasteWeight =
                ctx.affinityScore * 0.34 +
                (ctx.isLiked ? 0.2 : 0) +
                Math.min(0.14, ctx.playCount * 0.05) +
                Number(track.popularity ?? 0.75) * 0.12 -
                ctx.skipPenalty * 0.35 -
                (ctx.isDisliked ? 0.65 : 0);

            const rankScore =
                fit.totalClusterFit * 0.65 +
                (isPrimaryBucket ? 0.25 : 0) +
                tasteWeight +
                moodChipBoost;

            return {
                track,
                idx,
                fit,
                ctx,
                isPrimaryBucket,
                rankScore: Number(rankScore.toFixed(4)),
            };
        });

        scoredCandidates.sort((a, b) => b.rankScore - a.rankScore || a.idx - b.idx);

        let coreTracks = scoredCandidates
            .filter((item) => item.isPrimaryBucket || item.fit.isCoreMatch)
            .map((item) => item.track);

        if (coreTracks.length === 0) {
            coreTracks = scoredCandidates.slice(0, Math.min(3, scoredCandidates.length)).map((i) => i.track);
        }

        // Ensure each Daily Mix 1–3 has a distinct lead track even on very small catalogs
        const distinctLead =
            coreTracks.find((t) => !usedLeadTrackIds.has(t.id)) ||
            scoredCandidates.map((i) => i.track).find((t) => !usedLeadTrackIds.has(t.id)) ||
            coreTracks[0];
        if (distinctLead) {
            usedLeadTrackIds.add(distinctLead.id);
            coreTracks = [
                distinctLead,
                ...coreTracks.filter((t) => t.id !== distinctLead.id),
            ];
        }

        // Expand cluster tracklist with recommender sonic bridges up to mixTrackLimit
        let expandedTracks = coreTracks.slice();
        if (expandedTracks.length < mixTrackLimit) {
            if (recommender && typeof recommender.recommendTracks === "function") {
                const bridgeTracks = recommender.recommendTracks(catalog, {
                    seed: coreTracks.slice(0, 3),
                    excludeTrackIds: coreTracks.map((t) => t.id),
                    includeSeedTracks: false,
                    storage: store,
                    mixMode: profile.recommendedMixMode,
                    limit: mixTrackLimit - expandedTracks.length,
                    now,
                });
                expandedTracks.push(...bridgeTracks);
            } else {
                for (const item of scoredCandidates) {
                    if (!expandedTracks.some((t) => t.id === item.track.id)) {
                        expandedTracks.push(item.track);
                        if (expandedTracks.length >= mixTrackLimit) break;
                    }
                }
            }
        }

        const mixTracks = expandedTracks.slice(0, mixTrackLimit);
        const coreArtists = collectDistinctArtists(coreTracks, 4);
        const genres = Array.from(new Set(coreTracks.map((t) => t.genre).filter(Boolean)));
        const moods = Array.from(
            new Set(coreTracks.flatMap((t) => (Array.isArray(t.moods) ? t.moods : [])))
        ).slice(0, 4);
        const avgBpm = Math.round(
            coreTracks.reduce((s, t) => s + Number(t.bpm || 110), 0) /
                Math.max(1, coreTracks.length)
        );
        const avgEnergyPct = Math.round(
            (coreTracks.reduce((s, t) => s + Number(t.energy ?? 0.65), 0) /
                Math.max(1, coreTracks.length)) *
                100
        );
        const collageCovers = collectDistinctCovers(coreTracks, mixTracks, 4);

        return {
            id: profile.id,
            smartMixId: profile.id,
            mixNumber: profile.mixNumber,
            type: "daily-mix",
            theme: profile.theme,
            badge: profile.badge,
            shortBadge: profile.shortBadge,
            title: profile.title,
            vibeTitle: profile.vibeTitle,
            subtitle: `${coreArtists.slice(0, 3).join(", ")}${coreArtists.length > 3 ? " & more" : ""}`,
            description: `${genres.slice(0, 2).join(" • ") || profile.vibeTitle} • ${avgEnergyPct}% Energy • ${avgBpm} BPM`,
            coverUrl: distinctLead?.coverUrl || "Images/Espresso.jpeg",
            collageCovers,
            artists: coreArtists,
            genres,
            moods,
            avgBpm,
            avgEnergyPct,
            coreTrackCount: coreTracks.length,
            trackCount: mixTracks.length,
            coreTracks,
            tracks: mixTracks,
            previewTracks: mixTracks.slice(0, 4),
            recommendedMixMode: profile.recommendedMixMode,
            seedSpec: {
                type: "daily-mix",
                smartMixId: profile.id,
                badge: profile.shortBadge,
                label: `${profile.title}: ${profile.vibeTitle}`,
                tracks: coreTracks,
            },
        };
    });
}

/**
 * Automatically generates the "On Repeat" shelf:
 * Surfaces songs with high play counts, full completions, high completion ratios, and likes.
 */
function buildOnRepeatShelf(catalogInput, options = {}) {
    const catalog = Array.isArray(catalogInput) && catalogInput.length > 0 ? catalogInput : songs;
    const store = options.storage !== undefined ? options.storage : getStorage();
    const now = options.now || Date.now();
    const moodFilter = options.moodFilter !== undefined ? options.moodFilter : activeMoodFilter;
    const limit = options.limit || 6;

    const scored = catalog.map((track, idx) => {
        const ctx = getTrackTelemetryContext(track, store, now);
        const popularity = Number(track.popularity ?? 0.75);
        const moodBoost =
            moodFilter && moodFilter !== "All" && matchesActiveMoodChip(track, moodFilter)
                ? 0.15
                : 0;

        const playBoost = Math.min(
            0.56,
            ctx.playCount * 0.16 + ctx.fullCompletions * 0.14
        );
        const completionBoost = ctx.avgCompletionRatio * 0.22;
        const likeBoost = ctx.isLiked ? 0.3 : 0;
        const basePrior = ctx.affinityScore * 0.24 + popularity * 0.18;
        const penalty = ctx.skipPenalty * 0.45 + (ctx.isDisliked ? 0.85 : 0);

        const score = Number(
            (playBoost + completionBoost + likeBoost + basePrior + moodBoost - penalty).toFixed(4)
        );

        const avgCompletionPct = Math.round(ctx.avgCompletionRatio * 100);
        let badgeText = "TOP ROTATION";
        let reasonText = `${Math.round(popularity * 100)}% catalog affinity • ${track.genre || "Music"}`;

        if (ctx.playCount >= 2 || ctx.fullCompletions >= 1) {
            badgeText = `ON REPEAT • ${ctx.playCount} ${ctx.playCount === 1 ? "PLAY" : "PLAYS"}`;
            reasonText = `${avgCompletionPct || 100}% completion${ctx.isLiked ? " • ♥ Liked" : ""} • Heavy rotation`;
        } else if (ctx.isLiked && ctx.playCount === 1) {
            badgeText = "♥ LIKED • 1 PLAY";
            reasonText = `Saved favorite • ${avgCompletionPct || 100}% completion`;
        } else if (ctx.isLiked) {
            badgeText = "♥ LIKED FAVORITE";
            reasonText = `Saved in Liked Songs • ${track.genre || "Music"}`;
        } else if (ctx.playCount === 1) {
            badgeText = "IN ROTATION • 1 PLAY";
            reasonText = `Recently spun • ${avgCompletionPct}% completion`;
        }

        return {
            track: {
                ...track,
                shelfMeta: {
                    shelfId: "on-repeat",
                    score,
                    badgeText,
                    reasonText,
                    playCount: ctx.playCount,
                    fullCompletions: ctx.fullCompletions,
                    avgCompletionPct,
                    isLiked: ctx.isLiked,
                },
            },
            ctx,
            score,
            idx,
        };
    });

    scored.sort((a, b) => b.score - a.score || b.ctx.playCount - a.ctx.playCount || a.idx - b.idx);

    const selectedTracks = scored.slice(0, limit).map((item) => item.track);
    const totalPlaysInShelf = scored.reduce((s, item) => s + item.ctx.playCount, 0);
    const totalLikedInShelf = scored.filter((item) => item.ctx.isLiked).length;

    return {
        id: "on-repeat",
        type: "shelf",
        title: "On Repeat",
        eyebrow: "HEAVY ROTATION • HIGH AFFINITY",
        subtitle:
            totalPlaysInShelf > 0 || totalLikedInShelf > 0
                ? `${totalPlaysInShelf} total plays & ${totalLikedInShelf} liked favorites in heavy rotation`
                : "Your highest-affinity rotation picks & signature anthems",
        tracks: selectedTracks,
        seedSpec: {
            type: "on-repeat",
            smartMixId: "on-repeat",
            badge: "ON REPEAT MIX",
            label: "On Repeat Heavy Rotation",
            tracks: selectedTracks.slice(0, 4),
        },
    };
}

/**
 * Automatically generates the "Rediscover & Forgotten Favorites" shelf:
 * Surfaces tracks that were liked or completed in the past (not in the immediate last 1-2 plays)
 * alongside unplayed hidden gems, classic deep cuts, and overlooked tracks by favorite artists.
 */
function buildRediscoverShelf(catalogInput, options = {}) {
    const catalog = Array.isArray(catalogInput) && catalogInput.length > 0 ? catalogInput : songs;
    const store = options.storage !== undefined ? options.storage : getStorage();
    const now = options.now || Date.now();
    const moodFilter = options.moodFilter !== undefined ? options.moodFilter : activeMoodFilter;
    const limit = options.limit || 6;

    const rawRecentEntries =
        store && typeof store.getRecentlyPlayed === "function"
            ? store.getRecentlyPlayed(20)
            : [];
    const sortedRecentNonSkipped = rawRecentEntries
        .filter((e) => e && e.trackId && e.outcome !== "early-skip")
        .slice()
        .sort((a, b) => (b.playedAt || 0) - (a.playedAt || 0));
    const recentIdsList = [];
    for (const entry of sortedRecentNonSkipped) {
        if (!recentIdsList.includes(entry.trackId)) {
            recentIdsList.push(entry.trackId);
        }
    }
    const immediateRecentIds = new Set(recentIdsList.slice(0, 2));

    // Find artists the user has shown positive affinity for (liked or completed at least once)
    const favoredArtists = new Set();
    for (const track of catalog) {
        const ctx = getTrackTelemetryContext(track, store, now);
        if (ctx.isLiked || ctx.fullCompletions > 0 || ctx.playCount > 0) {
            for (const a of getTrackArtistList(track)) {
                favoredArtists.add(a.toLowerCase());
            }
        }
    }

    const scored = catalog.map((track, idx) => {
        const ctx = getTrackTelemetryContext(track, store, now);
        const popularity = Number(track.popularity ?? 0.8);
        const year = Number(track.year || 2024);
        const moodsLower = (Array.isArray(track.moods) ? track.moods : []).map((m) =>
            String(m).toLowerCase()
        );
        const isImmediateRecent = immediateRecentIds.has(track.id);
        const hasFavoredArtist = getTrackArtistList(track).some((a) =>
            favoredArtists.has(a.toLowerCase())
        );

        const isDeepCutMood =
            moodsLower.includes("deep cuts") ||
            moodsLower.includes("nostalgic") ||
            moodsLower.includes("soulful") ||
            moodsLower.includes("peaceful");
        const hiddenGemBonus = (1 - popularity) * 0.42 + (isDeepCutMood ? 0.2 : 0);
        const classicEraBonus = year <= 2015 ? 0.22 : year <= 2019 ? 0.16 : year <= 2022 ? 0.1 : 0.03;
        const moodFilterBoost =
            moodFilter && moodFilter !== "All" && matchesActiveMoodChip(track, moodFilter)
                ? 0.15
                : 0;

        let category = "hidden-gem";
        let score = 0.4 + hiddenGemBonus + classicEraBonus + moodFilterBoost;
        let badgeText = "HIDDEN GEM • UNPLAYED";
        let reasonText = `Unplayed ${track.genre || "catalog"} gem • ${year}`;

        const ageMs = ctx.lastPlayedAt ? Math.max(0, now - ctx.lastPlayedAt) : 0;
        const ageHours = ageMs / (1000 * 60 * 60);
        const isForgottenFavorite =
            (ctx.isLiked || ctx.fullCompletions > 0 || (ctx.playCount > 0 && ctx.avgCompletionRatio >= 0.6)) &&
            (!isImmediateRecent || ageHours >= 1);

        if (isForgottenFavorite) {
            category = "forgotten-favorite";
            const timeElapsedBonus = Math.min(0.28, ageHours * 0.04 + (!isImmediateRecent ? 0.16 : 0));
            score =
                0.68 +
                (ctx.isLiked ? 0.22 : 0) +
                Math.min(0.18, ctx.fullCompletions * 0.08 + ctx.playCount * 0.04) +
                timeElapsedBonus +
                moodFilterBoost -
                ctx.skipPenalty * 0.4;
            badgeText = ctx.isLiked ? "FORGOTTEN FAVORITE • ♥" : "FORGOTTEN FAVORITE";
            reasonText =
                ctx.playCount > 0
                    ? `Played ${ctx.playCount}x earlier • Ready to rediscover`
                    : `Liked favorite waiting for a spin • ${track.album}`;
        } else if (ctx.playCount === 0) {
            if (hasFavoredArtist) {
                category = "artist-discovery";
                score += 0.2;
                badgeText = "UNPLAYED • FAVORITE ARTIST";
                reasonText = `More by ${track.primaryArtist} you haven't played yet`;
            } else if (year <= 2019 || isDeepCutMood) {
                category = "classic-deep-cut";
                badgeText = `DEEP CUT • ${year}`;
                reasonText = `${track.album} (${year}) • ${isDeepCutMood ? "Deep Cuts vibe" : track.genre}`;
            }
        } else if (isImmediateRecent) {
            // Recently played just now belongs in Jump Back In, so deprioritize in Rediscover
            score -= 0.38;
            badgeText = `REVISIT • ${year}`;
            reasonText = `${track.album} • ${track.genre}`;
        }

        if (ctx.isDisliked || ctx.skipPenalty >= 0.45) {
            score -= 0.75;
        }

        score = Number(score.toFixed(4));

        return {
            track: {
                ...track,
                shelfMeta: {
                    shelfId: "rediscover",
                    category,
                    score,
                    badgeText,
                    reasonText,
                    playCount: ctx.playCount,
                    isLiked: ctx.isLiked,
                },
            },
            ctx,
            score,
            idx,
        };
    });

    scored.sort((a, b) => b.score - a.score || a.idx - b.idx);
    const selectedTracks = scored.slice(0, limit).map((item) => item.track);
    const forgottenCount = selectedTracks.filter(
        (t) => t.shelfMeta?.category === "forgotten-favorite"
    ).length;
    const unplayedCount = selectedTracks.filter((t) => (t.shelfMeta?.playCount || 0) === 0).length;

    return {
        id: "rediscover",
        type: "shelf",
        title: "Rediscover & Forgotten Favorites",
        eyebrow: "DEEP CUTS • FORGOTTEN FAVORITES",
        subtitle:
            forgottenCount > 0
                ? `${forgottenCount} forgotten ${forgottenCount === 1 ? "favorite" : "favorites"} & ${unplayedCount} unplayed ${unplayedCount === 1 ? "gem" : "gems"}`
                : `Unplayed catalog deep cuts & nostalgic classics (${unplayedCount} waiting to be discovered)`,
        tracks: selectedTracks,
        seedSpec: {
            type: "rediscover",
            smartMixId: "rediscover",
            badge: "REDISCOVER MIX",
            label: "Rediscover & Forgotten Favorites",
            tracks: selectedTracks.slice(0, 4),
        },
    };
}

function formatRelativeRecencyBadge(playedAt, now = Date.now()) {
    if (!Number.isFinite(playedAt) || playedAt <= 0) return "RECENT SESSION";
    const diffSec = Math.max(0, Math.round((now - playedAt) / 1000));
    if (diffSec < 90) return "JUST PLAYED";
    const diffMin = Math.floor(diffSec / 60);
    if (diffMin < 60) return `PLAYED ${diffMin}M AGO`;
    const diffHr = Math.floor(diffMin / 60);
    if (diffHr < 24) return `PLAYED ${diffHr}H AGO`;
    const diffDays = Math.floor(diffHr / 24);
    return `PLAYED ${diffDays}D AGO`;
}

/**
 * Automatically generates the "Jump Back In" shelf:
 * Surfaces the user's most recent listening sessions from `SpotTubeStorage.getRecentlyPlayed()`,
 * active playback track, and high-affinity quick-resume picks across distinct artists and albums.
 */
function buildJumpBackInShelf(catalogInput, options = {}) {
    const catalog = Array.isArray(catalogInput) && catalogInput.length > 0 ? catalogInput : songs;
    const store = options.storage !== undefined ? options.storage : getStorage();
    const now = options.now || Date.now();
    const moodFilter = options.moodFilter !== undefined ? options.moodFilter : activeMoodFilter;
    const limit = options.limit || 6;

    const rawRecentHistory =
        store && typeof store.getRecentlyPlayed === "function"
            ? store.getRecentlyPlayed(40)
            : [];
    const recentHistory = rawRecentHistory
        .slice()
        .sort((a, b) => (b.playedAt || 0) - (a.playedAt || 0));

    const jumpTracks = [];
    const seenTrackIds = new Set();

    // 1. Add unique tracks from `recentlyPlayed` (most recent timestamp first, skipping early-skipped tracks)
    for (const entry of recentHistory) {
        if (!entry || !entry.trackId || seenTrackIds.has(entry.trackId)) continue;
        const track = catalog.find((t) => t.id === entry.trackId);
        if (!track) continue;
        if (
            moodFilter &&
            moodFilter !== "All" &&
            !matchesActiveMoodChip(track, moodFilter) &&
            catalog.some((t) => matchesActiveMoodChip(t, moodFilter))
        ) {
            continue;
        }
        const ctx = getTrackTelemetryContext(track, store, now);
        if (ctx.isDisliked) continue;
        if (entry.outcome === "early-skip" && ctx.fullCompletions === 0 && !ctx.isLiked) {
            continue;
        }

        const completionPct = Math.round(
            Number(entry.completionRatio ?? ctx.lastCompletionRatio ?? 1) * 100
        );
        const recencyBadge = formatRelativeRecencyBadge(entry.playedAt, now);
        const reasonText =
            entry.outcome === "completed" || completionPct >= 85
                ? `Completed ${completionPct}% • ${track.album}`
                : `Recent session (${completionPct}%) • ${track.album}`;

        seenTrackIds.add(track.id);
        jumpTracks.push({
            ...track,
            shelfMeta: {
                shelfId: "jump-back-in",
                isFromHistory: true,
                playedAt: entry.playedAt || ctx.lastPlayedAt,
                outcome: entry.outcome || "played",
                completionPct,
                badgeText: recencyBadge,
                reasonText,
            },
        });
        if (jumpTracks.length >= limit) break;
    }

    // 2. If activePlaybackTrackId or current active track is not yet in jumpTracks, include it
    const currentActive = catalog.find((t) => t.id === activePlaybackTrackId) || songs[currentTrackIndex];
    if (
        currentActive &&
        !seenTrackIds.has(currentActive.id) &&
        jumpTracks.length < limit &&
        matchesActiveMoodChip(currentActive, moodFilter)
    ) {
        const ctx = getTrackTelemetryContext(currentActive, store, now);
        if (ctx.playCount > 0 || activePlaybackTrackId === currentActive.id) {
            seenTrackIds.add(currentActive.id);
            jumpTracks.unshift({
                ...currentActive,
                shelfMeta: {
                    shelfId: "jump-back-in",
                    isFromHistory: true,
                    playedAt: ctx.lastPlayedAt || now,
                    outcome: "active",
                    completionPct: Math.round((ctx.avgCompletionRatio || 1) * 100),
                    badgeText: "NOW IN SESSION",
                    reasonText: `Active deck • ${currentActive.album} (${currentActive.year || 2024})`,
                },
            });
        }
    }

    // 3. Fill remaining slots up to `limit` with liked songs and distinct-artist quick-resume picks
    if (jumpTracks.length < limit) {
        const fallbackCandidates = catalog
            .filter((t) => !seenTrackIds.has(t.id) && matchesActiveMoodChip(t, moodFilter))
            .map((track, idx) => {
                const ctx = getTrackTelemetryContext(track, store, now);
                const score =
                    (ctx.isLiked ? 0.35 : 0) +
                    (ctx.lastPlayedAt ? 0.3 : 0) +
                    ctx.affinityScore * 0.25 +
                    Number(track.popularity ?? 0.75) * 0.15 -
                    (ctx.isDisliked ? 0.8 : 0);
                return { track, ctx, score, idx };
            })
            .sort((a, b) => b.score - a.score || a.idx - b.idx);

        const seenFallbackArtists = new Set(
            jumpTracks.map((t) => String(t.primaryArtist || "").toLowerCase())
        );

        for (const item of fallbackCandidates) {
            if (jumpTracks.length >= limit) break;
            const artistKey = String(item.track.primaryArtist || "").toLowerCase();
            if (seenFallbackArtists.has(artistKey) && fallbackCandidates.length > limit) {
                continue;
            }
            seenFallbackArtists.add(artistKey);
            seenTrackIds.add(item.track.id);
            jumpTracks.push({
                ...item.track,
                shelfMeta: {
                    shelfId: "jump-back-in",
                    isFromHistory: Boolean(item.ctx.lastPlayedAt),
                    playedAt: item.ctx.lastPlayedAt || null,
                    outcome: item.ctx.isLiked ? "liked" : "ready",
                    completionPct: Math.round((item.ctx.avgCompletionRatio || 0) * 100),
                    badgeText: item.ctx.lastPlayedAt
                        ? formatRelativeRecencyBadge(item.ctx.lastPlayedAt, now)
                        : item.ctx.isLiked
                          ? "♥ SAVED VIBES"
                          : `JUMP IN • ${(item.track.genre || "MIX").toUpperCase()}`,
                    reasonText: `${item.track.album} (${item.track.year || 2024}) • ${item.track.bpm || 110} BPM`,
                },
            });
        }
    }

    const historyCount = jumpTracks.filter((t) => t.shelfMeta?.isFromHistory).length;

    return {
        id: "jump-back-in",
        type: "shelf",
        title: "Jump Back In",
        eyebrow: "RECENT SESSIONS • INSTANT RESUME",
        subtitle:
            historyCount > 0
                ? `Pick up right where you left off (${historyCount} recent ${historyCount === 1 ? "session" : "sessions"})`
                : "Instant one-click resume across your top artists, albums, and vibes",
        hasRecentHistory: historyCount > 0,
        tracks: jumpTracks.slice(0, limit),
        seedSpec: {
            type: "jump-back-in",
            smartMixId: "jump-back-in",
            badge: "JUMP BACK IN",
            label: "Jump Back In Radio",
            tracks: jumpTracks.slice(0, 4),
        },
    };
}

/**
 * Master builder for all Item 10 Home Dashboard Smart Auto-Mixes & Personalized Shelves:
 * - `supermix` (*Your Supermix*)
 * - `dailyMixes` (*Daily Mix 1–3*, clustered by genre/artist/vibe)
 * - `jumpBackIn` (*Jump Back In*)
 * - `onRepeat` (*On Repeat*)
 * - `rediscover` (*Rediscover / Forgotten Favorites*)
 */
function buildHomeShelvesData(options = {}) {
    const catalog =
        Array.isArray(options.catalog) && options.catalog.length > 0 ? options.catalog : songs;
    if (!catalog.length) {
        return {
            moodFilter: activeMoodFilter,
            supermix: null,
            dailyMixes: [],
            smartMixes: [],
            jumpBackIn: null,
            onRepeat: null,
            rediscover: null,
            shelves: [],
        };
    }

    const supermix = buildSupermixData(catalog, options);
    const dailyMixes = buildDailyMixes(catalog, options);
    const smartMixes = [supermix, ...dailyMixes].filter(Boolean);
    const jumpBackIn = buildJumpBackInShelf(catalog, options);
    const onRepeat = buildOnRepeatShelf(catalog, options);
    const rediscover = buildRediscoverShelf(catalog, options);

    const data = {
        moodFilter: options.moodFilter !== undefined ? options.moodFilter : activeMoodFilter,
        supermix,
        dailyMixes,
        smartMixes,
        jumpBackIn,
        onRepeat,
        rediscover,
        shelves: [
            {
                id: "smart-mixes",
                type: "smart-mixes",
                title: "Your Supermix & Daily Mixes",
                items: smartMixes,
            },
            jumpBackIn,
            onRepeat,
            rediscover,
        ].filter(Boolean),
    };

    activeHomeShelvesData = data;
    return data;
}

/**
 * Starts an endless radio mix from any Smart Auto-Mix or Home Shelf ID
 * (`"supermix"`, `"daily-mix-1"`, `"daily-mix-2"`, `"daily-mix-3"`, `"on-repeat"`, `"rediscover"`, `"jump-back-in"`).
 */
function startSmartMix(mixIdOrSpec = "supermix", options = {}) {
    if (!songs.length) return null;
    const shelvesData = buildHomeShelvesData(options);

    let targetMix = null;
    if (typeof mixIdOrSpec === "string") {
        const cleanId = mixIdOrSpec.trim().toLowerCase();
        targetMix =
            shelvesData.smartMixes.find((m) => m.id.toLowerCase() === cleanId) ||
            (cleanId === "on-repeat" ? shelvesData.onRepeat : null) ||
            (cleanId === "rediscover" || cleanId === "forgotten-favorites"
                ? shelvesData.rediscover
                : null) ||
            (cleanId === "jump-back-in" ? shelvesData.jumpBackIn : null) ||
            shelvesData.supermix;
    } else if (mixIdOrSpec && typeof mixIdOrSpec === "object") {
        if (mixIdOrSpec.seedSpec) {
            targetMix = mixIdOrSpec;
        } else if (mixIdOrSpec.id || mixIdOrSpec.smartMixId) {
            const cleanId = String(mixIdOrSpec.id || mixIdOrSpec.smartMixId)
                .trim()
                .toLowerCase();
            targetMix =
                shelvesData.smartMixes.find((m) => m.id.toLowerCase() === cleanId) ||
                (cleanId === "on-repeat" ? shelvesData.onRepeat : null) ||
                (cleanId === "rediscover" ? shelvesData.rediscover : null) ||
                (cleanId === "jump-back-in" ? shelvesData.jumpBackIn : null) ||
                { seedSpec: mixIdOrSpec };
        } else {
            targetMix = { seedSpec: mixIdOrSpec };
        }
    }

    if (!targetMix) {
        return startRadioMix({ type: "supermix" }, options);
    }

    if (options.applyRecommendedMixMode && targetMix.recommendedMixMode) {
        activeMixMode = normalizeMixMode(targetMix.recommendedMixMode);
    }

    const result = startRadioMix(targetMix.seedSpec || { type: "supermix" }, {
        ...options,
        mixMode: options.mixMode || activeMixMode,
    });
    renderHomeShelves();
    return result;
}

function createSmartMixCardNode(mix, activeMixSession = null) {
    const card = document.createElement("article");
    const isActiveStation =
        activeMixSession &&
        (activeMixSession.smartMixId === mix.id ||
            (mix.id === "supermix" && activeMixSession.type === "supermix"));

    card.className = isActiveStation
        ? "smart-mix-card active-mix-station"
        : "smart-mix-card";
    if (card.classList && typeof card.classList.add === "function") {
        card.classList.add("smart-mix-card");
        if (isActiveStation) {
            card.classList.add("active-mix-station");
        }
    }
    card.setAttribute("role", "listitem");
    card.id = `smart-mix-card-${mix.id}`;
    card.dataset.smartMixId = mix.id;
    card.dataset.mixType = mix.type;
    card.dataset.mixTheme = mix.theme || "supermix";

    const covers = Array.isArray(mix.collageCovers) && mix.collageCovers.length > 0
        ? mix.collageCovers.slice(0, 4)
        : [mix.coverUrl || "Images/Espresso.jpeg"];
    while (covers.length < 4) {
        covers.push(covers[0]);
    }

    const previewButtonsHtml = (mix.previewTracks || [])
        .slice(0, 4)
        .map(
            (t) =>
                `<button type="button" class="smart-mix-preview-track" data-preview-track-id="${t.id}" title="Play ${t.title} in ${mix.title}">${t.title}</button>`
        )
        .join("");

    card.innerHTML = `
        <div class="smart-mix-top-row">
            <div class="smart-mix-collage" aria-hidden="true">
                ${covers.map((src, i) => `<img src="${src}" alt="${mix.title} cover ${i + 1}">`).join("")}
            </div>
            <div class="smart-mix-badges-col">
                <span class="smart-mix-badge">${mix.badge}</span>
                <span class="smart-mix-telemetry-pill">${mix.avgEnergyPct}% Energy &bull; ${mix.avgBpm} BPM</span>
            </div>
        </div>
        <div class="smart-mix-body">
            <h3 class="smart-mix-title">${mix.title}</h3>
            <span class="smart-mix-vibe">${mix.vibeTitle}</span>
            <p class="smart-mix-artists">${mix.subtitle}</p>
        </div>
        <div class="smart-mix-preview-list" role="group" aria-label="Featured tracks in ${mix.title}">
            ${previewButtonsHtml}
        </div>
        <div class="smart-mix-actions">
            <button type="button" class="smart-mix-start-btn" data-smart-mix-action="start-mix" aria-label="Start ${mix.title}">
                <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="m7.05 3.606 13.49 7.788a.7.7 0 0 1 0 1.212L7.05 20.394A.7.7 0 0 1 6 19.788V4.212a.7.7 0 0 1 1.05-.606z"/></svg>
                <span>Start ${mix.id === "supermix" ? "Supermix" : `Mix ${mix.mixNumber || ""}`.trim()}</span>
            </button>
            <button type="button" class="smart-mix-queue-btn" data-smart-mix-action="queue-mix" title="Add ${mix.title} tracks to queue" aria-label="Queue ${mix.title}">
                <span>+ Queue</span>
            </button>
        </div>
    `;

    if (typeof card.querySelectorAll === "function") {
        card.querySelectorAll("[data-preview-track-id]").forEach((btn) => {
            btn.addEventListener("click", (e) => {
                e.stopPropagation();
                const previewTrackId = btn.dataset.previewTrackId;
                startSmartMix(mix.id, { startTrack: previewTrackId });
            });
        });

        card.querySelectorAll("[data-smart-mix-action]").forEach((btn) => {
            btn.addEventListener("click", (e) => {
                e.stopPropagation();
                const action = btn.dataset.smartMixAction;
                if (action === "start-mix") {
                    startSmartMix(mix.id);
                } else if (action === "queue-mix") {
                    for (const t of (mix.tracks || []).slice(0, 5)) {
                        addTrackToQueue(t.id);
                    }
                }
            });
        });
    }

    card.addEventListener("click", () => {
        startSmartMix(mix.id);
    });

    return card;
}

function createShelfTrackCardNode(track, shelfId) {
    const card = document.createElement("article");
    const activeTrack = songs[currentTrackIndex];
    const isPlaying = activeTrack && activeTrack.id === track.id;
    const meta = track.shelfMeta || {};

    card.className = isPlaying
        ? "shelf-track-card active-track"
        : "shelf-track-card";
    if (card.classList && typeof card.classList.add === "function") {
        card.classList.add("shelf-track-card");
        if (isPlaying) {
            card.classList.add("active-track");
        }
    }
    card.setAttribute("role", "listitem");
    card.dataset.trackId = track.id;
    card.dataset.shelfId = shelfId;
    card.dataset.artist = track.primaryArtist;
    card.dataset.album = track.album;

    const badgeText = meta.badgeText || `${track.genre || "Music"} • ${track.bpm || 110} BPM`;
    const reasonText =
        meta.reasonText ||
        `${track.album} (${track.year || 2024}) • ${Math.round((track.energy ?? 0.65) * 100)}% Energy`;

    card.innerHTML = `
        <div class="shelf-card-top">
            <img src="${track.coverUrl}" alt="${track.title}" class="shelf-card-cover">
            <div class="shelf-card-headings">
                <span class="shelf-card-pill">${badgeText}</span>
                <h4 class="shelf-card-title" data-open-song="${track.id}" title="View Song Details: ${track.title}">${track.title}</h4>
                <div class="shelf-card-artist">
                    <button type="button" class="detail-inline-link" data-open-artist="${track.primaryArtist}" title="Open Artist: ${track.primaryArtist}">${track.artistDisplay}</button>
                </div>
            </div>
        </div>
        <p class="shelf-card-reason" title="${reasonText}">${reasonText}</p>
        <div class="card-quick-actions" role="group" aria-label="Shelf actions for ${track.title}">
            <button type="button" class="card-action-btn" data-shelf-action="play" title="Play ${track.title}">
                <span>Play</span>
            </button>
            <button type="button" class="card-action-btn" data-shelf-action="play-next" title="Play ${track.title} Next">
                <span>Play Next</span>
            </button>
            <button type="button" class="card-action-btn" data-shelf-action="add-to-queue" title="Add ${track.title} to Queue">
                <span>+ Queue</span>
            </button>
            <button type="button" class="card-action-btn mix-action-btn" data-shelf-action="start-mix" title="Start Radio Mix from ${track.title}">
                <span>Mix</span>
            </button>
        </div>
    `;

    const songHeading = card.querySelector("[data-open-song]");
    if (songHeading && typeof songHeading.addEventListener === "function") {
        songHeading.addEventListener("click", (e) => {
            e.stopPropagation();
            openSongDetail(track.id);
        });
    }

    const artistBtn = card.querySelector("[data-open-artist]");
    if (artistBtn && typeof artistBtn.addEventListener === "function") {
        artistBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            openArtistDetail(track.primaryArtist);
        });
    }

    if (typeof card.querySelectorAll === "function") {
        card.querySelectorAll("[data-shelf-action]").forEach((btn) => {
            btn.addEventListener("click", (e) => {
                e.stopPropagation();
                const action = btn.dataset.shelfAction;
                if (action === "play") {
                    playMusic(track.id, false);
                } else if (action === "play-next") {
                    playTrackNext(track.id);
                } else if (action === "add-to-queue") {
                    addTrackToQueue(track.id);
                } else if (action === "start-mix") {
                    startRadioMix({ type: "track", track });
                }
            });
        });
    }

    card.addEventListener("click", () => {
        playMusic(track.id, false);
    });

    return card;
}

/**
 * Renders the Home Dashboard Smart Auto-Mixes & Personalized Shelves (`#home-shelves`):
 * 1. *Your Supermix* & *Daily Mix 1–3* (`#smart-mixes-grid`)
 * 2. *Jump Back In* (`#jump-back-in-grid`)
 * 3. *On Repeat* (`#on-repeat-grid`)
 * 4. *Rediscover / Forgotten Favorites* (`#rediscover-grid`)
 */
function renderHomeShelves(options = {}) {
    if (!songs.length) return null;
    const data = options.data || buildHomeShelvesData(options);
    const qm = getQueueManager();
    const activeMixSession =
        qm && typeof qm.getMixSession === "function" ? qm.getMixSession() : null;

    const smartMixesGrid = document.getElementById("smart-mixes-grid");
    const smartMixesMeta = document.getElementById("shelf-smart-mixes-meta");
    if (smartMixesMeta) {
        smartMixesMeta.textContent =
            activeMoodFilter !== "All"
                ? `4 stations tuned for ${activeMoodFilter}`
                : `${data.smartMixes.length} personalized stations`;
    }
    if (smartMixesGrid && typeof smartMixesGrid.replaceChildren === "function") {
        const mixCardNodes = data.smartMixes.map((mix) =>
            createSmartMixCardNode(mix, activeMixSession)
        );
        smartMixesGrid.replaceChildren(...mixCardNodes);
    }

    const jumpBackInGrid = document.getElementById("jump-back-in-grid");
    const jumpBackInMeta = document.getElementById("shelf-jump-back-in-meta");
    if (jumpBackInMeta && data.jumpBackIn) {
        jumpBackInMeta.textContent = data.jumpBackIn.subtitle;
    }
    if (jumpBackInGrid && data.jumpBackIn && typeof jumpBackInGrid.replaceChildren === "function") {
        const jumpNodes = data.jumpBackIn.tracks.map((t) =>
            createShelfTrackCardNode(t, "jump-back-in")
        );
        jumpBackInGrid.replaceChildren(...jumpNodes);
    }

    const onRepeatGrid = document.getElementById("on-repeat-grid");
    const onRepeatMeta = document.getElementById("shelf-on-repeat-meta");
    if (onRepeatMeta && data.onRepeat) {
        onRepeatMeta.textContent = data.onRepeat.subtitle;
    }
    if (onRepeatGrid && data.onRepeat && typeof onRepeatGrid.replaceChildren === "function") {
        const repeatNodes = data.onRepeat.tracks.map((t) =>
            createShelfTrackCardNode(t, "on-repeat")
        );
        onRepeatGrid.replaceChildren(...repeatNodes);
    }

    const rediscoverGrid = document.getElementById("rediscover-grid");
    const rediscoverMeta = document.getElementById("shelf-rediscover-meta");
    if (rediscoverMeta && data.rediscover) {
        rediscoverMeta.textContent = data.rediscover.subtitle;
    }
    if (rediscoverGrid && data.rediscover && typeof rediscoverGrid.replaceChildren === "function") {
        const rediscoverNodes = data.rediscover.tracks.map((t) =>
            createShelfTrackCardNode(t, "rediscover")
        );
        rediscoverGrid.replaceChildren(...rediscoverNodes);
    }

    const homeShelvesContainer = document.getElementById("home-shelves");
    if (homeShelvesContainer) {
        homeShelvesContainer.dataset.shelfCount = String(data.shelves.length);
        homeShelvesContainer.dataset.activeMood = activeMoodFilter;
    }

    return data;
}

function setMoodFilter(mood) {
    activeMoodFilter = mood || "All";
    document.querySelectorAll("#mood-chips-bar .mood-chip").forEach((chip) => {
        chip.classList.toggle("active", chip.dataset.mood === activeMoodFilter);
    });
    const qm = getQueueManager();
    if (qm && typeof qm.setMoodFilter === "function") {
        qm.setMoodFilter(activeMoodFilter, { retune: true, silent: true });
    }
    if (activeView === "detail" && !isRestoringHistory) {
        closeDetailView({ skipHistory: true });
    }
    pushNavState();
    renderCatalogGrid();
    renderHomeShelves();
    if (activeView === "search") {
        renderSearchView(buildOmniSearchResults(activeSearchQuery));
    }
    renderDrawerQueue();
}

/**
 * Dynamically switches the YT Music Mix Mode inside the "Up Next / Mix" drawer
 * (`all`, `familiar`, `discover`, `deep-cuts`, `upbeat`, `chill`), re-ranking and regenerating
 * upcoming auto-queued tracks without interrupting current playback.
 */
function setMixMode(mode, options = {}) {
    activeMixMode = normalizeMixMode(mode);
    syncMixTuningChipsUI();

    const qm = getQueueManager();
    if (qm && typeof qm.setMixMode === "function") {
        ensureQueueCatalogSynced();
        qm.setMixMode(activeMixMode, {
            silent: true,
            preserveUserReordered: options.preserveUserReordered,
            seedTracks: options.seedTracks,
        });
    }

    renderDrawerQueue({ animateReorder: options.animate !== false });

    const upcoming = getUpcomingQueueTracks();
    const recommender = getRecommender();
    const profile =
        qm && typeof qm.getMixModeProfile === "function"
            ? qm.getMixModeProfile(activeMixMode)
            : recommender && typeof recommender.getMixModeProfile === "function"
              ? recommender.getMixModeProfile(activeMixMode)
              : { label: activeMixMode, shortLabel: activeMixMode };

    if (!options.silent) {
        announceQueueStatus(
            `Tuned upcoming radio mix to ${profile.label || activeMixMode} mode (${upcoming.length} upcoming tracks)`
        );
    }
    return upcoming;
}

function retuneRadioMix(options = {}) {
    return setMixMode(activeMixMode, {
        ...options,
        animate: options.animate !== false,
    });
}

function toggleRightDrawer(forceState) {
    const container = document.getElementById("app-container");
    const navToggleBtn = document.getElementById("toggle-drawer-btn");
    const playbarQueueBtn = document.getElementById("playbar-queue-btn");
    if (!container) return;

    isDrawerOpen = typeof forceState === "boolean" ? forceState : !isDrawerOpen;
    container.classList.toggle("drawer-collapsed", !isDrawerOpen);

    if (navToggleBtn) {
        navToggleBtn.setAttribute("aria-expanded", String(isDrawerOpen));
        navToggleBtn.classList.toggle("active", isDrawerOpen);
    }
    if (playbarQueueBtn) {
        playbarQueueBtn.setAttribute("aria-expanded", String(isDrawerOpen));
        playbarQueueBtn.classList.toggle("active", isDrawerOpen);
    }
}

function switchDrawerTab(tabName) {
    activeDrawerTab = tabName === "track-info" ? "track-info" : "up-next";
    const tabUpNext = document.getElementById("tab-up-next");
    const tabTrackInfo = document.getElementById("tab-track-info");
    const panelUpNext = document.getElementById("panel-up-next");
    const panelTrackInfo = document.getElementById("panel-track-info");

    if (tabUpNext && tabTrackInfo && panelUpNext && panelTrackInfo) {
        const isUpNext = activeDrawerTab === "up-next";
        tabUpNext.classList.toggle("active", isUpNext);
        tabUpNext.setAttribute("aria-selected", String(isUpNext));
        tabTrackInfo.classList.toggle("active", !isUpNext);
        tabTrackInfo.setAttribute("aria-selected", String(!isUpNext));
        panelUpNext.hidden = !isUpNext;
        panelTrackInfo.hidden = isUpNext;
    }
}

// ==================== CROSSFADE (0–12s), SHORTCUTS MODAL & TRANSPORT HELPERS ====================

function syncCrossfadeUI() {
    const badgeEl = document.getElementById("crossfade-badge");
    const sliderEl = document.getElementById("crossfade-slider");
    const sliderValueEl = document.getElementById("crossfade-slider-value");

    if (badgeEl) {
        badgeEl.innerHTML = `<span>XFADE ${crossfadeSeconds}s</span>`;
        badgeEl.textContent = `XFADE ${crossfadeSeconds}s`;
        badgeEl.classList.toggle("active", crossfadeSeconds > 0);
    }
    if (sliderEl) {
        sliderEl.value = String(crossfadeSeconds);
    }
    if (sliderValueEl) {
        sliderValueEl.textContent =
            crossfadeSeconds === 0 ? "0s (Gapless)" : `${crossfadeSeconds}s Crossfade`;
    }
    document.querySelectorAll("[data-xfade-preset]").forEach((btn) => {
        const presetVal = Number(btn.dataset.xfadePreset);
        btn.classList.toggle("active", presetVal === crossfadeSeconds);
    });
}

function setCrossfadeDuration(seconds, options = {}) {
    const clamped = Math.max(0, Math.min(12, Math.round(Number(seconds) || 0)));
    crossfadeSeconds = clamped;

    const pe = getPlayerEngine();
    if (pe && typeof pe.setCrossfadeSeconds === "function") {
        crossfadeSeconds = pe.setCrossfadeSeconds(clamped);
    } else {
        const store = getStorage();
        if (store && typeof store.setPreferences === "function") {
            store.setPreferences({ crossfadeSeconds });
        }
    }

    syncCrossfadeUI();
    if (!options.silent) {
        announceQueueStatus(
            crossfadeSeconds === 0
                ? "Crossfade set to 0s (Gapless playback)"
                : `Crossfade set to ${crossfadeSeconds} seconds`
        );
    }
    return crossfadeSeconds;
}

function cycleCrossfadeDuration() {
    const pe = getPlayerEngine();
    if (pe && typeof pe.cycleCrossfadeSeconds === "function") {
        crossfadeSeconds = pe.cycleCrossfadeSeconds();
        syncCrossfadeUI();
        announceQueueStatus(
            crossfadeSeconds === 0
                ? "Crossfade set to 0s (Gapless playback)"
                : `Crossfade set to ${crossfadeSeconds} seconds`
        );
        return crossfadeSeconds;
    }
    const presets = [0, 2, 4, 6, 8, 12];
    const idx = presets.indexOf(crossfadeSeconds);
    const nextVal = idx === -1 ? 0 : presets[(idx + 1) % presets.length];
    return setCrossfadeDuration(nextVal);
}

function getCrossfadeDuration() {
    const pe = getPlayerEngine();
    if (pe && typeof pe.getCrossfadeSeconds === "function") {
        crossfadeSeconds = pe.getCrossfadeSeconds();
    }
    return crossfadeSeconds;
}

function toggleShortcutsModal(forceState) {
    const modal = document.getElementById("shortcuts-modal");
    isShortcutsModalOpen =
        typeof forceState === "boolean" ? forceState : !isShortcutsModalOpen;
    if (!modal) return isShortcutsModalOpen;

    setDialogOpen(modal, isShortcutsModalOpen);
    if (isShortcutsModalOpen) {
        syncCrossfadeUI();
        if (!modal.__spotTubeCloseSync && typeof modal.addEventListener === "function") {
            // Native Esc / form[method=dialog] closes bypass this toggle; keep state in sync
            modal.addEventListener("close", () => {
                isShortcutsModalOpen = false;
                modal.hidden = true;
            });
            modal.__spotTubeCloseSync = true;
        }
    }
    return isShortcutsModalOpen;
}

function toggleLikeCurrentTrack() {
    const track = songs[currentTrackIndex];
    if (!track) return false;
    const store = getStorage();
    let nowLiked = false;
    if (store) {
        nowLiked = store.toggleLike(track.id);
        if (nowLiked) likedTrackIds.add(track.id);
        else likedTrackIds.delete(track.id);
    } else if (likedTrackIds.has(track.id)) {
        likedTrackIds.delete(track.id);
        nowLiked = false;
    } else {
        likedTrackIds.add(track.id);
        nowLiked = true;
    }
    const likedCountEl = document.getElementById("lib-liked-count");
    if (likedCountEl) {
        likedCountEl.textContent =
            likedTrackIds.size > 0
                ? `Auto-playlist • ${likedTrackIds.size} liked`
                : "Auto-playlist • Pin";
    }
    syncActiveTrackUI();
    return nowLiked;
}

function togglePlayPause() {
    const activeTrack = songs[currentTrackIndex];
    const store = getStorage();
    const pe = getPlayerEngine();
    if (pe) {
        const nowPlaying = pe.togglePlay();
        currentSong = pe.getActiveDeck();
        activePlaybackTrackId = nowPlaying && activeTrack ? activeTrack.id : null;
        updatePlayButtonIcon(!nowPlaying);
        return nowPlaying;
    }
    if (currentSong.paused) {
        if (activeTrack) {
            activePlaybackTrackId = activeTrack.id;
            if (store) store.recordPlayStart(activeTrack.id);
        }
        const p = currentSong.play();
        if (p && typeof p.catch === "function") p.catch(() => {});
        updatePlayButtonIcon(false);
        return true;
    } else {
        currentSong.pause();
        updatePlayButtonIcon(true);
        return false;
    }
}

function toggleShuffleState(forceState) {
    isShuffle = typeof forceState === "boolean" ? forceState : !isShuffle;
    const pe = getPlayerEngine();
    if (pe) pe.setShuffle(isShuffle);
    const shuffleEl = document.getElementById("shuffle");
    if (shuffleEl) {
        shuffleEl.classList.toggle("active", isShuffle);
        const svg = shuffleEl.getElementsByTagName("svg")[0];
        if (svg && svg.style) svg.style.fill = isShuffle ? "#1db954" : "#b3b3b3";
    }
    return isShuffle;
}

function toggleRepeatState(forceState) {
    isRepeat = typeof forceState === "boolean" ? forceState : !isRepeat;
    const pe = getPlayerEngine();
    if (pe) pe.setRepeat(isRepeat);
    const repeatEl = document.getElementById("repeat");
    if (repeatEl) {
        repeatEl.classList.toggle("active", isRepeat);
        const svg = repeatEl.getElementsByTagName("svg")[0];
        if (svg && svg.style) svg.style.fill = isRepeat ? "#1db954" : "#b3b3b3";
    }
    return isRepeat;
}

function seekPlaybackTo(targetSeconds) {
    const pe = getPlayerEngine();
    if (pe) {
        const t = pe.seekTo(targetSeconds);
        currentSong = pe.getActiveDeck();
        return t;
    }
    const activeTrack = songs[currentTrackIndex];
    const dur =
        Number.isFinite(currentSong.duration) && currentSong.duration > 0
            ? currentSong.duration
            : activeTrack?.duration || 0;
    const clamped = dur > 0 ? Math.max(0, Math.min(dur, targetSeconds)) : Math.max(0, targetSeconds);
    currentSong.currentTime = clamped;
    return clamped;
}

function seekPlaybackBy(deltaSeconds) {
    const pe = getPlayerEngine();
    if (pe) {
        const t = pe.seekBy(deltaSeconds);
        currentSong = pe.getActiveDeck();
        return t;
    }
    return seekPlaybackTo((Number(currentSong.currentTime) || 0) + Number(deltaSeconds || 0));
}

function syncVolumeBarUI(vol, muted) {
    const volumeBar = document.querySelector(".volume-bar");
    const volumeBtn = document.getElementById("volume-btn");
    const displayPercent = muted ? 0 : Math.round(Math.max(0, Math.min(1, vol)) * 100);
    if (volumeBar && volumeBar.style && typeof volumeBar.style.setProperty === "function") {
        volumeBar.style.setProperty("--volume-width", `${displayPercent}%`);
    }
    if (volumeBtn) {
        volumeBtn.innerHTML = muted
            ? `<svg data-encore-id="mute" role="presentation" aria-label="Volume off" aria-hidden="true" id="volume-icon" viewBox="0 0 16 16" class="Svg-sc-ytk21e-0 kcUFwU">
                    <path d="M13.86 5.47a.75.75 0 0 0-1.061 0l-1.47 1.47-1.47-1.47A.75.75 0 0 0 8.8 6.53L10.269 8l-1.47 1.47a.75.75 0 1 0 1.06 1.06l1.47-1.47 1.47 1.47a.75.75 0 0 0 1.06-1.06L12.39 8l1.47-1.47a.75.75 0 0 0 0-1.06z"></path>
                    <path d="M10.116 1.5A.75.75 0 0 0 8.991.85l-6.925 4a3.642 3.642 0 0 0-1.33 4.967 3.639 3.639 0 0 0 1.33 1.332l6.925 4a.75.75 0 0 0 1.125-.649v-1.906a4.73 4.73 0 0 1-1.5-.694v1.3L2.817 9.852a2.141 2.141 0 0 1-.781-2.92c.187-.324.456-.594.78-.782l5.8-3.35v1.3c.45-.313.956-.55 1.5-.694V1.5z"></path>
                </svg>`
            : `<svg data-encore-id="unmute" role="presentation" aria-label="Volume high" aria-hidden="true" id="volume-icon" viewBox="0 0 16 16" class="Svg-sc-ytk21e-0 kcUFwU">
                    <path d="M9.741.85a.75.75 0 0 1 .375.65v13a.75.75 0 0 1-1.125.65l-6.925-4a3.642 3.642 0 0 1-1.33-4.967 3.639 3.639 0 0 1 1.33-1.332l6.925-4a.75.75 0 0 1 .75 0zm-6.924 5.3a2.139 2.139 0 0 0 0 3.7l5.8 3.35V2.8l-5.8 3.35zm8.683 4.29V5.56a2.75 2.75 0 0 1 0 4.88z"></path>
                    <path d="M11.5 13.614a5.752 5.752 0 0 0 0-11.228v1.55a4.252 4.252 0 0 1 0 8.127v1.55z"></path>
                </svg>`;
    }
}

function handleShellKeyDown(event) {
    const pe = getPlayerEngine();
    const callbacks = {
        onTogglePlay: () => togglePlayPause(),
        onNext: () => playNextFromQueue({ shuffle: isShuffle, pause: false }),
        onPrevious: () => playPreviousFromQueue({ pause: false }),
        onSeekBy: (delta) => seekPlaybackBy(delta),
        onAdjustVolume: (delta) => {
            if (pe) {
                const v = pe.adjustVolume(delta);
                syncVolumeBarUI(v, pe.getState().muted);
                return v;
            }
            const nextV = Math.max(0, Math.min(1, (currentSong.muted ? 0 : currentSong.volume) + delta));
            currentSong.volume = nextV;
            currentSong.muted = nextV === 0;
            syncVolumeBarUI(nextV, currentSong.muted);
            return nextV;
        },
        onToggleMute: () => {
            if (pe) {
                const m = pe.toggleMute();
                syncVolumeBarUI(pe.getState().volume, m);
                return m;
            }
            currentSong.muted = !currentSong.muted;
            syncVolumeBarUI(currentSong.volume, currentSong.muted);
            return currentSong.muted;
        },
        onToggleDrawer: () => toggleRightDrawer(),
        onToggleShuffle: () => toggleShuffleState(),
        onToggleRepeat: () => toggleRepeatState(),
        onToggleLike: () => toggleLikeCurrentTrack(),
        onCycleCrossfade: () => cycleCrossfadeDuration(),
        onFocusSearch: () => {
            const searchInput = document.getElementById("search-input");
            if (searchInput && typeof searchInput.focus === "function") {
                searchInput.focus();
            }
        },
        onToggleShortcutsModal: () => toggleShortcutsModal(),
        onEscape: () => {
            if (isShortcutsModalOpen) {
                toggleShortcutsModal(false);
            } else if (activeView === "detail") {
                closeDetailView();
            } else if (activeView === "search") {
                closeSearchView();
            }
        },
    };

    if (pe && typeof pe.handleKeyDown === "function") {
        return pe.handleKeyDown(event, callbacks);
    }

    const mod = getPlayerModule();
    if (mod && typeof mod.handleKeyDown === "function") {
        return mod.handleKeyDown(event, callbacks);
    }
    return { handled: false };
}

function initShellControls() {
    // 1. Mood & Activity Filter Chips
    document.querySelectorAll("#mood-chips-bar .mood-chip").forEach((chip) => {
        chip.addEventListener("click", () => {
            setMoodFilter(chip.dataset.mood || "All");
        });
    });

    // 2. Top Search Input & Clear Button (Instant Omni-Search)
    const searchInput = document.getElementById("search-input");
    const searchClearBtn = document.getElementById("search-clear-btn");
    if (searchInput) {
        searchInput.addEventListener("input", () => {
            setSearchQuery(searchInput.value, { fromInput: true });
        });
        if (typeof searchInput.addEventListener === "function") {
            searchInput.addEventListener("keydown", (e) => {
                if (e.key === "Enter") {
                    e.preventDefault();
                    if (e.shiftKey) {
                        startSearchMix();
                    } else if (activeSearchResults?.topResult) {
                        triggerTopResultPrimaryAction(activeSearchResults.topResult);
                    } else {
                        startSearchMix();
                    }
                } else if (e.key === "Escape") {
                    if (activeSearchQuery.length > 0 || activeView === "search") {
                        e.preventDefault();
                        closeSearchView({ clearQuery: true });
                    }
                }
            });
        }
    }
    if (searchClearBtn && searchInput) {
        searchClearBtn.addEventListener("click", () => {
            closeSearchView({ clearQuery: true });
        });
    }

    // 2b. Omni-Search View Controls (Back, Category Tabs, Start Search Mix, Play All, Queue All, Top Result Card)
    const searchBackBtn = document.getElementById("search-back-btn");
    if (searchBackBtn) {
        searchBackBtn.addEventListener("click", () => {
            closeSearchView({ clearQuery: true });
        });
    }

    const searchCatTabs = Array.from(
        document.querySelectorAll("#search-category-tabs .search-cat-tab")
    );
    searchCatTabs.forEach((tab, idx) => {
        tab.addEventListener("click", () => {
            setSearchCategory(tab.dataset.searchTab || "all");
        });
        if (typeof tab.addEventListener === "function") {
            tab.addEventListener("keydown", (e) => {
                if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
                    e.preventDefault();
                    const dir = e.key === "ArrowRight" ? 1 : -1;
                    const nextIdx = (idx + dir + searchCatTabs.length) % searchCatTabs.length;
                    const nextTab = searchCatTabs[nextIdx];
                    if (nextTab) {
                        if (typeof nextTab.focus === "function") nextTab.focus();
                        setSearchCategory(nextTab.dataset.searchTab || "all");
                    }
                }
            });
        }
    });

    const searchStartMixBtn = document.getElementById("search-start-mix-btn");
    if (searchStartMixBtn) {
        searchStartMixBtn.addEventListener("click", () => {
            startSearchMix();
        });
    }

    const searchPlayAllBtn = document.getElementById("search-play-all-btn");
    if (searchPlayAllBtn) {
        searchPlayAllBtn.addEventListener("click", () => {
            const results = activeSearchResults || buildOmniSearchResults(activeSearchQuery);
            const tracks = results.songs.length > 0 ? results.songs : results.seedTracks;
            if (tracks.length > 0) {
                playMusic(tracks[0].id, false);
                for (let i = 1; i < Math.min(tracks.length, 6); i++) {
                    addTrackToQueue(tracks[i].id);
                }
            }
        });
    }

    const searchQueueAllBtn = document.getElementById("search-queue-all-btn");
    if (searchQueueAllBtn) {
        searchQueueAllBtn.addEventListener("click", () => {
            const results = activeSearchResults || buildOmniSearchResults(activeSearchQuery);
            const tracks = results.songs.length > 0 ? results.songs : results.seedTracks;
            for (const t of tracks.slice(0, 8)) {
                addTrackToQueue(t.id);
            }
        });
    }

    const topResultCard = document.getElementById("search-top-result-card");
    const topResultPlayBtn = document.getElementById("search-top-result-play-btn");
    const topResultMixBtn = document.getElementById("search-top-result-mix-btn");
    const topResultDetailBtn = document.getElementById("search-top-result-detail-btn");

    if (topResultPlayBtn) {
        topResultPlayBtn.addEventListener("click", (e) => {
            if (e && typeof e.stopPropagation === "function") e.stopPropagation();
            const results = activeSearchResults || buildOmniSearchResults(activeSearchQuery);
            triggerTopResultPrimaryAction(results.topResult);
        });
    }
    if (topResultMixBtn) {
        topResultMixBtn.addEventListener("click", (e) => {
            if (e && typeof e.stopPropagation === "function") e.stopPropagation();
            const results = activeSearchResults || buildOmniSearchResults(activeSearchQuery);
            startRadioMix(results.topResult?.seedSpec || results.seedSpec);
        });
    }
    if (topResultDetailBtn) {
        topResultDetailBtn.addEventListener("click", (e) => {
            if (e && typeof e.stopPropagation === "function") e.stopPropagation();
            const results = activeSearchResults || buildOmniSearchResults(activeSearchQuery);
            triggerTopResultDetailAction(results.topResult);
        });
    }
    if (topResultCard) {
        topResultCard.addEventListener("click", () => {
            const results = activeSearchResults || buildOmniSearchResults(activeSearchQuery);
            triggerTopResultDetailAction(results.topResult);
        });
    }

    const searchEmptyMixBtn = document.getElementById("search-empty-mix-btn");
    if (searchEmptyMixBtn) {
        searchEmptyMixBtn.addEventListener("click", () => {
            startSearchMix();
        });
    }

    const searchEmptyResetBtn = document.getElementById("search-empty-reset-btn");
    if (searchEmptyResetBtn) {
        searchEmptyResetBtn.addEventListener("click", () => {
            openSearchView("", { keepSearchViewOpen: true });
        });
    }

    // 3. Navigation History Back / Forward
    const navBack = document.getElementById("nav-back");
    const navForward = document.getElementById("nav-forward");
    if (navBack) {
        navBack.addEventListener("click", () => {
            navigateBack();
        });
    }
    if (navForward) {
        navForward.addEventListener("click", () => {
            navigateForward();
        });
    }

    // 4. Left Library Filter Pills
    document.querySelectorAll("#library-filters .lib-chip").forEach((chip) => {
        chip.addEventListener("click", () => {
            activeLibraryFilter = chip.dataset.libFilter || "all";
            document.querySelectorAll("#library-filters .lib-chip").forEach((c) => {
                const isSelected = c === chip;
                c.classList.toggle("active", isSelected);
                c.setAttribute("aria-selected", String(isSelected));
            });
            renderLibrarySidebar();
        });
    });

    // 5. Left Primary Navigation Links (Home, Explore & Search, Start Supermix)
    const navHome = document.getElementById("nav-home");
    const navSearch = document.getElementById("nav-search");
    const navSupermix = document.getElementById("nav-supermix");
    const brandLogoLink = document.getElementById("brand-logo-link");
    if (navHome) {
        navHome.addEventListener("click", (e) => {
            e.preventDefault();
            if (searchInput) searchInput.value = "";
            activeSearchQuery = "";
            if (searchClearBtn) searchClearBtn.hidden = true;
            closeDetailView({ skipHistory: true });
            setMoodFilter("All");
        });
    }
    if (brandLogoLink) {
        brandLogoLink.addEventListener("click", (e) => {
            e.preventDefault();
            closeDetailView();
        });
    }
    if (navSearch) {
        navSearch.addEventListener("click", (e) => {
            e.preventDefault();
            openSearchView(activeSearchQuery);
            if (searchInput && typeof searchInput.focus === "function") {
                searchInput.focus();
            }
        });
    }
    if (navSupermix) {
        navSupermix.addEventListener("click", (e) => {
            e.preventDefault();
            startRadioMix({ type: "supermix" });
        });
    }

    // 5b. Detail View Hero & Action Buttons (Item 8)
    const detailBackBtn = document.getElementById("detail-back-btn");
    if (detailBackBtn) {
        detailBackBtn.addEventListener("click", () => {
            closeDetailView();
        });
    }

    const detailStartMixBtn = document.getElementById("detail-start-mix-btn");
    if (detailStartMixBtn) {
        detailStartMixBtn.addEventListener("click", () => {
            startDetailMix();
        });
    }

    const detailPlayAllBtn = document.getElementById("detail-play-all-btn");
    if (detailPlayAllBtn) {
        detailPlayAllBtn.addEventListener("click", () => {
            if (!activeDetail || !activeDetail.data) return;
            const tracks = activeDetail.data.topTracks || [];
            if (tracks.length > 0) {
                playMusic(tracks[0].id, false);
                for (let i = 1; i < tracks.length; i++) {
                    addTrackToQueue(tracks[i].id);
                }
            }
        });
    }

    const detailShuffleBtn = document.getElementById("detail-shuffle-btn");
    if (detailShuffleBtn) {
        detailShuffleBtn.addEventListener("click", () => {
            if (!activeDetail || !activeDetail.data) return;
            const tracks = activeDetail.data.topTracks || [];
            const pick =
                tracks.length > 0
                    ? tracks[Math.floor(Math.random() * tracks.length)]
                    : songs[currentTrackIndex];
            startRadioMix(activeDetail.data.seedSpec, { startTrack: pick });
        });
    }

    const detailQueueAllBtn = document.getElementById("detail-queue-all-btn");
    if (detailQueueAllBtn) {
        detailQueueAllBtn.addEventListener("click", () => {
            if (!activeDetail || !activeDetail.data) return;
            const tracks = activeDetail.data.topTracks || [];
            for (const t of tracks) {
                addTrackToQueue(t.id);
            }
        });
    }

    // 5c. Playbar & Track Info Drawer Entity Detail Links
    const infoTitleEl = document.getElementById("info-title");
    const infoCoverEl = document.getElementById("info-cover");
    const infoArtistsEl = document.getElementById("info-artists");
    const infoAlbumYearEl = document.getElementById("info-album-year");
    const playbarCoverEl = document.getElementById("playbar-cover");
    const playbarTitleEl = document.getElementsByClassName("song-title")[0];
    const playbarArtistEl = document.getElementsByClassName("artist-names")[0];

    for (const el of [infoTitleEl, infoCoverEl, playbarCoverEl, playbarTitleEl]) {
        if (el && typeof el.addEventListener === "function") {
            el.addEventListener("click", () => {
                const track = songs[currentTrackIndex] || songs[0];
                if (track) openSongDetail(track.id);
            });
        }
    }
    for (const el of [infoArtistsEl, playbarArtistEl]) {
        if (el && typeof el.addEventListener === "function") {
            el.addEventListener("click", () => {
                const track = songs[currentTrackIndex] || songs[0];
                if (track) openArtistDetail(track.primaryArtist);
            });
        }
    }
    if (infoAlbumYearEl && typeof infoAlbumYearEl.addEventListener === "function") {
        infoAlbumYearEl.addEventListener("click", () => {
            const track = songs[currentTrackIndex] || songs[0];
            if (track) openAlbumDetail(track.album);
        });
    }

    // 6. Collapsible Right Drawer Toggles & Tabs
    const toggleDrawerBtn = document.getElementById("toggle-drawer-btn");
    const playbarQueueBtn = document.getElementById("playbar-queue-btn");
    const drawerCloseBtn = document.getElementById("drawer-close-btn");

    if (toggleDrawerBtn) {
        toggleDrawerBtn.addEventListener("click", () => toggleRightDrawer());
    }
    if (playbarQueueBtn) {
        playbarQueueBtn.addEventListener("click", () => toggleRightDrawer());
    }
    if (drawerCloseBtn) {
        drawerCloseBtn.addEventListener("click", () => toggleRightDrawer(false));
    }

    document.querySelectorAll("[data-drawer-tab]").forEach((tabBtn) => {
        tabBtn.addEventListener("click", () => {
            switchDrawerTab(tabBtn.dataset.drawerTab);
        });
    });

    // 7. YT Music Dynamic Mix Tuning Chips inside Right Drawer
    const tuningChips = Array.from(
        document.querySelectorAll("#mix-tuning-chips .tuning-chip")
    );
    tuningChips.forEach((chip, chipIdx) => {
        chip.addEventListener("click", () => {
            setMixMode(chip.dataset.mixMode || "all");
        });
        if (typeof chip.addEventListener === "function") {
            chip.addEventListener("keydown", (e) => {
                if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
                    e.preventDefault();
                    const dir = e.key === "ArrowRight" ? 1 : -1;
                    const nextIdx = (chipIdx + dir + tuningChips.length) % tuningChips.length;
                    const nextChip = tuningChips[nextIdx];
                    if (nextChip) {
                        if (typeof nextChip.focus === "function") nextChip.focus();
                        setMixMode(nextChip.dataset.mixMode || "all");
                    }
                }
            });
        }
    });

    const retuneMixBtn = document.getElementById("retune-mix-btn");
    if (retuneMixBtn) {
        retuneMixBtn.addEventListener("click", () => {
            retuneRadioMix();
        });
    }

    // 8. Universal Start Mix Triggers (Search Mix, Track Mix, Mood Mix, and Supermix)
    const searchMixBtn = document.getElementById("search-mix-btn");
    if (searchMixBtn) {
        searchMixBtn.addEventListener("click", () => {
            startSearchMix();
        });
    }

    const trackMixTriggers = ["playbar-mix-btn", "info-start-mix-btn"];
    for (const id of trackMixTriggers) {
        const el = document.getElementById(id);
        if (el) {
            el.addEventListener("click", () => {
                const activeTrack = songs[currentTrackIndex] || songs[0];
                if (activeTrack) {
                    startRadioMix({ type: "track", track: activeTrack });
                }
            });
        }
    }

    const supermixTriggers = ["hero-start-mix-btn", "header-start-mix-btn", "lib-supermix"];
    for (const id of supermixTriggers) {
        const el = document.getElementById(id);
        if (el) {
            el.addEventListener("click", () => {
                startSearchMix();
            });
        }
    }

    // 8b. Home Dashboard Shelf-Header Smart Mix Triggers (Item 10)
    const shelfMixTriggers = [
        { id: "shelf-supermix-btn", mixId: "supermix" },
        { id: "shelf-jump-back-in-mix-btn", mixId: "jump-back-in" },
        { id: "shelf-on-repeat-mix-btn", mixId: "on-repeat" },
        { id: "shelf-rediscover-mix-btn", mixId: "rediscover" },
    ];
    for (const { id, mixId } of shelfMixTriggers) {
        const el = document.getElementById(id);
        if (el) {
            el.addEventListener("click", () => {
                startSmartMix(mixId);
            });
        }
    }

    const clearManualBtn = document.getElementById("clear-manual-queue-btn");
    if (clearManualBtn) {
        clearManualBtn.addEventListener("click", () => {
            const qm = getQueueManager();
            if (qm && typeof qm.clearQueue === "function") {
                qm.clearQueue({ onlyManual: true });
                renderDrawerQueue();
                announceQueueStatus("Cleared manually queued tracks");
            }
        });
    }

    const heroShuffleBtn = document.getElementById("hero-shuffle-all-btn");
    if (heroShuffleBtn) {
        heroShuffleBtn.addEventListener("click", () => {
            if (!songs.length) return;
            const randomIdx = Math.floor(Math.random() * songs.length);
            startRadioMix({ type: "track", track: songs[randomIdx] });
        });
    }

    // 9. Like / Heart Button in Playbar
    const likeBtn = document.getElementById("like-btn");
    if (likeBtn) {
        likeBtn.addEventListener("click", () => {
            toggleLikeCurrentTrack();
        });
    }

    // 10. Crossfade Badge, Slider, Presets & Keyboard Shortcuts Dialog
    const crossfadeBadge = document.getElementById("crossfade-badge");
    if (crossfadeBadge) {
        crossfadeBadge.addEventListener("click", (e) => {
            if (e && e.shiftKey) {
                toggleShortcutsModal(true);
            } else {
                cycleCrossfadeDuration();
            }
        });
    }

    const crossfadeSlider = document.getElementById("crossfade-slider");
    if (crossfadeSlider) {
        crossfadeSlider.addEventListener("input", () => {
            setCrossfadeDuration(Number(crossfadeSlider.value));
        });
    }

    document.querySelectorAll("[data-xfade-preset]").forEach((btn) => {
        btn.addEventListener("click", () => {
            setCrossfadeDuration(Number(btn.dataset.xfadePreset));
        });
    });

    const shortcutsLink = document.getElementById("shortcuts-link");
    if (shortcutsLink) {
        shortcutsLink.addEventListener("click", (e) => {
            if (e && typeof e.preventDefault === "function") e.preventDefault();
            toggleShortcutsModal();
        });
    }

    const shortcutsCloseBtn = document.getElementById("shortcuts-close-btn");
    if (shortcutsCloseBtn) {
        shortcutsCloseBtn.addEventListener("click", () => {
            toggleShortcutsModal(false);
        });
    }

    // 11. Global Keyboard Shortcuts & MediaSession API
    document.addEventListener("keydown", handleShellKeyDown);

    const pe = getPlayerEngine();
    if (pe && typeof pe.registerMediaSessionHandlers === "function") {
        pe.registerMediaSessionHandlers({
            onPlay: () => {
                if (currentSong.paused) togglePlayPause();
            },
            onPause: () => {
                if (!currentSong.paused) togglePlayPause();
            },
            onPrevious: () => playPreviousFromQueue({ pause: false }),
            onNext: () => playNextFromQueue({ shuffle: isShuffle, pause: false }),
            onSeekBackward: (offset) => seekPlaybackBy(-offset),
            onSeekForward: (offset) => seekPlaybackBy(offset),
            onSeekTo: (time) => seekPlaybackTo(time),
            onStop: () => {
                if (!currentSong.paused) togglePlayPause();
                seekPlaybackTo(0);
            },
        });
    }

    syncCrossfadeUI();
}

function bindAudioDeckListeners(deckEl) {
    if (!deckEl || typeof deckEl.addEventListener !== "function") return;

    deckEl.addEventListener("timeupdate", () => {
        // Only update playbar progress from the currently active deck
        if (deckEl !== currentSong) return;

        const store = getStorage();
        const pe = getPlayerEngine();
        const activeTrack = songs[currentTrackIndex];
        const totalDuration =
            Number.isFinite(currentSong.duration) && currentSong.duration > 0
                ? currentSong.duration
                : activeTrack
                  ? activeTrack.duration
                  : 0;
        document.getElementsByClassName("current-time")[0].textContent = secondsToMinutesSeconds(
            currentSong.currentTime
        );
        document.getElementsByClassName("total-time")[0].textContent = secondsToMinutesSeconds(
            totalDuration
        );
        if (totalDuration > 0) {
            document.getElementsByClassName("progress")[0].style.width =
                (currentSong.currentTime / totalDuration) * 100 + "%";
        }

        // Evaluate crossfade window (0–12s), gapless preload, MediaSession position, and < 3 queue replenishment
        if (pe && typeof pe.evaluatePlaybackTick === "function") {
            pe.evaluatePlaybackTick(currentSong.currentTime, totalDuration);
        }
    });

    deckEl.addEventListener("ended", () => {
        if (deckEl !== currentSong) return;

        const store = getStorage();
        const finishedTrack = songs[currentTrackIndex];
        if (store && finishedTrack) {
            const totalDuration =
                Number.isFinite(currentSong.duration) && currentSong.duration > 0
                    ? currentSong.duration
                    : finishedTrack.duration || 180;
            store.recordPlaybackOutcome(finishedTrack.id, {
                listenedSeconds: totalDuration,
                durationSeconds: totalDuration,
                endedNaturally: true,
            });
            activePlaybackTrackId = null;
        }

        if (isRepeat) {
            currentSong.currentTime = 0;
            if (store && finishedTrack) {
                activePlaybackTrackId = finishedTrack.id;
                store.recordPlayStart(finishedTrack.id);
            }
            const p = currentSong.play();
            if (p && typeof p.catch === "function") p.catch(() => {});
        } else {
            playNextFromQueue({
                shuffle: isShuffle,
                repeat: false,
                pause: false,
                useStandbyDeck: true,
                skipTelemetryOutcome: true,
            });
        }
    });
}

async function main() {
    hydrateFromStorage();
    songs = await getSongs();
    const songDiv = document.querySelector(".spotify-playlist");
    if (!songs.length || !songDiv) return;

    const store = getStorage();
    const pe = getPlayerEngine();

    if (store && typeof store.attachAudioAnalyzer === "function") {
        store.attachAudioAnalyzer(currentSong, {
            getActiveTrackId: () => songs[currentTrackIndex]?.id || null,
        });
    }

    const qm = getQueueManager();
    if (qm && typeof qm.setCatalog === "function") {
        qm.setCatalog(getQueueCatalog(), { rebuildQueue: true, silent: true });
    }

    renderCatalogGrid();
    renderHomeShelves();
    renderLibrarySidebar();
    initShellControls();
    initLibraryImportControls();
    await initFolderSources();
    playMusic(0, true);

    const playBtn = document.getElementById("play");
    playBtn.addEventListener("click", () => {
        togglePlayPause();
    });

    const repeat = document.getElementById("repeat");
    repeat.addEventListener("click", () => {
        toggleRepeatState();
    });

    const shuffle = document.getElementById("shuffle");
    shuffle.addEventListener("click", () => {
        toggleShuffleState();
    });

    if (pe) {
        const { deckA, deckB } = pe.getDecks();
        bindAudioDeckListeners(deckA);
        bindAudioDeckListeners(deckB);
    } else {
        bindAudioDeckListeners(currentSong);
    }

    const progressBar = document.querySelector(".progress-bar");
    const progressHandle = document.querySelector(".progress");
    let isDraggingProgress = false;

    document.addEventListener("mousemove", (e) => {
        if (isDraggingProgress) {
            const rect = progressBar.getBoundingClientRect();
            const offsetX = e.clientX - rect.left;
            const percent = Math.max(0, Math.min(100, (offsetX / rect.width) * 100));
            progressBar.style.setProperty("--progress-width", percent + "%");
        }
    });

    document.addEventListener("mouseup", (e) => {
        if (isDraggingProgress) {
            const rect = progressBar.getBoundingClientRect();
            const offsetX = e.clientX - rect.left;
            const percent = Math.max(0, Math.min(100, (offsetX / rect.width) * 100));
            if (Number.isFinite(currentSong.duration)) {
                seekPlaybackTo((currentSong.duration * percent) / 100);
            }
        }
        isDraggingProgress = false;
    });

    progressBar.addEventListener("click", (e) => {
        const percent = (e.offsetX / progressBar.offsetWidth) * 100;
        progressBar.style.setProperty("--progress-width", percent + "%");
        if (Number.isFinite(currentSong.duration)) {
            seekPlaybackTo((currentSong.duration * percent) / 100);
        }
    });

    progressHandle.addEventListener("mousedown", () => {
        isDraggingProgress = true;
    });

    document.getElementById("previous").addEventListener("click", () => {
        playPreviousFromQueue({ pause: currentSong.paused });
    });

    document.getElementById("next").addEventListener("click", () => {
        playNextFromQueue({ shuffle: isShuffle, pause: currentSong.paused });
    });

    const volumeBar = document.querySelector(".volume-bar");
    const volumeHandle = document.querySelector(".volume");
    currentSong.volume = 1;
    volumeBar.style.setProperty("--volume-width", "100%");

    let isDragging = false;

    volumeHandle.addEventListener("mousedown", () => {
        isDragging = true;
    });

    document.addEventListener("mousemove", (e) => {
        if (isDragging) {
            const rect = volumeBar.getBoundingClientRect();
            const offsetX = e.clientX - rect.left;
            const percent = Math.max(0, Math.min(100, (offsetX / rect.width) * 100));
            volumeBar.style.setProperty("--volume-width", percent + "%");
            if (pe) {
                pe.setVolume(percent / 100);
            } else {
                currentSong.volume = percent / 100;
            }
        }
    });

    document.addEventListener("mouseup", () => {
        isDragging = false;
    });

    const muteButton = document.querySelector(".mute");
    let lastVolume = currentSong.volume;

    volumeBar.addEventListener("click", (e) => {
        const percent = (e.offsetX / volumeBar.offsetWidth) * 100;
        const vol = Math.max(0, Math.min(percent / 100, 1));
        volumeBar.style.setProperty("--volume-width", percent + "%");
        if (pe) {
            pe.setVolume(vol);
        } else {
            currentSong.volume = vol;
            currentSong.muted = vol === 0;
        }
        if (vol > 0) {
            lastVolume = vol;
        }
    });

    muteButton.addEventListener("click", () => {
        if (pe) {
            const nowMuted = pe.toggleMute();
            syncVolumeBarUI(pe.getState().volume, nowMuted);
            return;
        }
        if (currentSong.muted) {
            currentSong.muted = false;
            currentSong.volume = lastVolume;
            syncVolumeBarUI(lastVolume, false);
        } else {
            lastVolume = currentSong.volume;
            currentSong.muted = true;
            currentSong.volume = 0;
            syncVolumeBarUI(0, true);
        }
    });
}

// ==================== LOCAL AUDIO IMPORT & CUSTOM PLAYLISTS (ITEM 11) ====================

let libraryToastTimer = null;
let playlistPickerTrackId = null;
let playlistEditTargetId = null;
let dropDragDepth = 0;

function getLibraryModule() {
    if (typeof window !== "undefined" && window.SpotTubeLibrary) {
        return window.SpotTubeLibrary;
    }
    if (typeof globalThis !== "undefined" && globalThis.SpotTubeLibrary) {
        return globalThis.SpotTubeLibrary;
    }
    return null;
}

function escapeHtml(value) {
    return String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

function setDialogOpen(dialogEl, open) {
    if (!dialogEl) return;
    dialogEl.hidden = !open;
    if (open) {
        // showModal() throws if the [open] attribute is already present, so try it first
        let shownModally = false;
        if (typeof dialogEl.showModal === "function") {
            try {
                if (!dialogEl.open) dialogEl.showModal();
                shownModally = true;
            } catch (_) {}
        }
        if (!shownModally) dialogEl.setAttribute("open", "");
    } else {
        if (typeof dialogEl.removeAttribute === "function") dialogEl.removeAttribute("open");
        if (typeof dialogEl.close === "function") {
            try {
                dialogEl.close();
            } catch (_) {}
        }
    }
}

function getUserPlaylists() {
    const store = getStorage();
    if (!store || typeof store.getPlaylists !== "function") return [];
    return store.getPlaylists();
}

function getImportedLocalTracks() {
    return songs.filter((t) => t && t.isLocalImport);
}

function getLikedSongsTracks() {
    const store = getStorage();
    const ids =
        store && typeof store.getLikedTrackIds === "function"
            ? store.getLikedTrackIds()
            : Array.from(likedTrackIds);
    const byId = new Map(songs.map((t) => [t.id, t]));
    return ids.map((id) => byId.get(id)).filter(Boolean);
}

function updateLocalFilesCount() {
    const el = document.getElementById("lib-local-count");
    if (!el) return;
    const count = getImportedLocalTracks().length;
    const needsReconnect = folderSources.some((src) => getFolderSourceStatus(src.id) !== "granted");
    el.textContent =
        count > 0
            ? `Local • ${count} ${count === 1 ? "file" : "files"}${needsReconnect ? " · reconnect needed" : ""}`
            : "Drop MP3, FLAC or WAV to import";
}

/** Adds newly imported tracks to the in-memory catalog (deduplicated). Returns the tracks actually added. */
function mergeImportedTracks(tracks = []) {
    const existing = new Set(songs.map((t) => t.id));
    const added = [];
    for (const track of tracks) {
        if (track && track.id && !existing.has(track.id)) {
            songs.push(track);
            existing.add(track.id);
            added.push(track);
        }
    }
    return added;
}

function refreshLibraryViews(options = {}) {
    const qm = getQueueManager();
    if (qm && typeof qm.setCatalog === "function" && songs.length) {
        qm.setCatalog(getQueueCatalog(), { rebuildQueue: false, silent: true });
    }
    renderCatalogGrid();
    // Home shelves run the recommender over the whole catalog; an instant import skips them until it finishes
    if (!options.skipShelves) renderHomeShelves();
    renderLibrarySidebar();
    updateLocalFilesCount();
    updateHomeAddMusicCard();
    refreshActiveCollectionView();
}

/**
 * Imports local audio files (File objects, { file, relativePath } entries, or a FileList).
 * Item 13: rows appear immediately from file names (playable right away), then tags, duration and cover art
 * fill in through a background worker pool. Resolves when every file has been read and saved.
 */
async function importLocalAudioFiles(fileInputs, options = {}) {
    const lib = getLibraryModule();
    const empty = { imported: [], duplicates: [], skipped: [], removed: [], added: [] };
    if (!lib) return { ...empty, summary: "Import unavailable" };
    const list = Array.isArray(fileInputs) ? fileInputs : Array.from(fileInputs || []);
    if (!list.length) return { ...empty, summary: "No files selected" };
    const sourceName = options.sourceName || lib.guessImportSourceName(list) || "your files";

    const job = {
        sourceName,
        controller: null,
        lastQuarter: 0,
    };
    const controller = lib.startInstantImport(list, {
        storage: getStorage(),
        existingKeys: getExistingImportKeys(),
        existingIds: songs.map((t) => t.id),
        probeDuration: options.probeDuration,
        concurrency: options.concurrency,
        linkSource: options.linkSource || null,
        onTrackUpdated: (track) => queueImportRowUpdate(track),
        onTrackFailed: (track) => {
            removeTracksFromCatalog([track.id]);
            queueImportRowUpdate(null);
        },
        onProgress: () => scheduleImportFlush(),
    });
    job.controller = controller;

    if (controller.total === 0) {
        const result = {
            imported: [],
            duplicates: controller.duplicates,
            skipped: controller.skipped,
            removed: [],
            cancelled: false,
            total: 0,
        };
        const details = [...controller.skipped, ...controller.duplicates];
        let summary;
        if (controller.duplicates.length && !controller.skipped.length) {
            summary = lib.summarizeInstantImport(result);
            showLibraryToast(summary, { action: { label: "View details", onClick: () => openImportDetailsDialog(details) } });
        } else {
            summary = `No music found in “${sourceName}”. Supported formats: ${lib.SUPPORTED_FORMATS_LABEL}.`;
            showLibraryToast(summary, {
                error: true,
                timeoutMs: 0,
                action: details.length ? { label: "View details", onClick: () => openImportDetailsDialog(details) } : null,
            });
        }
        return { ...result, added: [], summary };
    }

    activeImportJobs.push(job);
    mergeImportedTracks(controller.tracks);
    // Light refresh while the rows are new; the full refresh (grid, shelves, sidebar) runs when tags are done
    const qmNow = getQueueManager();
    if (qmNow && typeof qmNow.setCatalog === "function") qmNow.setCatalog(getQueueCatalog(), { rebuildQueue: false, silent: true });
    updateLocalFilesCount();
    updateHomeAddMusicCard();
    if (options.openCollection === false) refreshActiveCollectionView();
    announceImport(`Adding ${controller.total} ${controller.total === 1 ? "song" : "songs"} from “${sourceName}”`);
    if (options.openCollection !== false) {
        openLocalFilesDetail();
    }
    updateImportProgressUi();

    const result = await controller.done;
    activeImportJobs = activeImportJobs.filter((j) => j !== job);
    if (result.removed.length) removeTracksFromCatalog(result.removed.map((t) => t.id));
    flushImportUpdates({ force: true });
    refreshLibraryViews();
    updateImportProgressUi();

    if (options.linkSource) refreshFolderSourcesUi();
    const summary = typeof options.summarize === "function" ? options.summarize(result) : lib.summarizeInstantImport(result);
    const details = [...result.skipped, ...result.duplicates];
    showLibraryToast(summary, {
        error: result.imported.length === 0 && details.length > 0,
        action: details.length ? { label: "View details", onClick: () => openImportDetailsDialog(details) } : null,
    });
    // The toast (role="status") announces the finish; the import live region only did start + quarters
    importLastQuarter = 0;
    return { ...result, added: result.imported, summary };
}

async function importFromDataTransfer(dataTransfer, options = {}) {
    const lib = getLibraryModule();
    if (!lib || !dataTransfer) return null;
    const entries = await lib.collectFilesFromDataTransfer(dataTransfer);
    return importLocalAudioFiles(entries, options);
}

/** True where the browser can pick a whole folder (desktop Chrome/Edge/Firefox/Safari; not iOS or most Android browsers). */
function canPickFolders() {
    if (typeof window === "undefined") return false;
    const nav = window.navigator || {};
    const ua = String(nav.userAgent || "");
    const isMobile = /Android|iPhone|iPad|iPod|Mobile/i.test(ua) || (/Macintosh/.test(ua) && Number(nav.maxTouchPoints) > 1);
    if (isMobile) return false;
    if (typeof window.showDirectoryPicker === "function") return true;
    const input = document.getElementById("import-folder-input");
    return Boolean(input && ("webkitdirectory" in input || input.webkitdirectory !== undefined));
}

function showFolderPermissionError() {
    const message = "Couldn't open that folder because the browser didn't allow access.";
    showLibraryToast(message, {
        error: true,
        timeoutMs: 0,
        action: { label: "Try again", onClick: () => openImportPicker({ folder: true }) },
    });
    announceImport(message);
}

function openImportPicker(options = {}) {
    const wantsFolder = Boolean(options.folder) && canPickFolders();
    if (wantsFolder && typeof window !== "undefined" && typeof window.showDirectoryPicker === "function") {
        const lib = getLibraryModule();
        let pickedName = "";
        return window
            .showDirectoryPicker({ id: "spottube-import", mode: "read" })
            .then((handle) => {
                pickedName = handle && handle.name ? String(handle.name) : "";
                return importFromFolderHandle(handle, { sourceName: pickedName || undefined });
            })
            .catch((err) => {
                const name = err && err.name;
                if (name === "AbortError") return null; // picker cancelled: nothing happens
                if (name === "NotAllowedError" || name === "SecurityError") {
                    showFolderPermissionError();
                    return null;
                }
                // Fall back to the <input webkitdirectory> picker
                const folderInput = document.getElementById("import-folder-input");
                if (folderInput && typeof folderInput.click === "function") folderInput.click();
                return null;
            });
    }
    const input = document.getElementById(wantsFolder ? "import-folder-input" : "import-file-input");
    if (input && typeof input.click === "function") {
        input.value = "";
        input.click();
    }
    return Promise.resolve(null);
}

async function removeImportedTrack(trackId) {
    const track = songs.find((t) => t.id === trackId);
    if (!track || !track.isLocalImport) return false;
    const store = getStorage();
    if (store && typeof store.deleteImportedTrack === "function") {
        await store.deleteImportedTrack(trackId);
    }
    for (const pl of getUserPlaylists()) {
        if (pl.trackIds.includes(trackId)) store.removeTrackFromPlaylist(pl.id, trackId);
    }
    const qm = getQueueManager();
    if (qm && typeof qm.removeFromQueue === "function") {
        try {
            const upcoming = typeof qm.getUpcomingTracks === "function" ? qm.getUpcomingTracks() : [];
            if (upcoming.some((t) => t.id === trackId)) qm.removeFromQueue(trackId);
        } catch (_) {}
    }

    const activeId = songs[currentTrackIndex]?.id;
    songs = songs.filter((t) => t.id !== trackId);
    if (activeId === trackId) {
        currentTrackIndex = Math.min(currentTrackIndex, Math.max(0, songs.length - 1));
    } else {
        currentTrackIndex = Math.max(0, songs.findIndex((t) => t.id === activeId));
    }
    refreshLibraryViews();
    showLibraryToast(`Removed "${track.title}" from this browser`);
    return true;
}

// ---------- Custom playlists ----------

function createUserPlaylist(fields = {}, options = {}) {
    const store = getStorage();
    if (!store || typeof store.createPlaylist !== "function") return null;
    const lib = getLibraryModule();
    const name =
        String(fields.name || "").trim() ||
        (lib ? lib.nextDefaultPlaylistName(getUserPlaylists()) : "My Playlist");
    const playlist = store.createPlaylist({
        name,
        description: fields.description || "",
        trackIds: Array.isArray(fields.trackIds) ? fields.trackIds : [],
        coverUrl: "",
    });
    renderUserPlaylistsSidebar();
    if (options.open !== false) {
        openPlaylistDetail(playlist.id);
    }
    showLibraryToast(`Created "${playlist.name}"`);
    return playlist;
}

function updateUserPlaylist(playlistId, patch = {}) {
    const store = getStorage();
    if (!store || typeof store.updatePlaylist !== "function") return null;
    const updated = store.updatePlaylist(playlistId, patch);
    renderUserPlaylistsSidebar();
    refreshActiveCollectionView();
    return updated;
}

function deleteUserPlaylist(playlistId) {
    const store = getStorage();
    if (!store || typeof store.deletePlaylist !== "function") return false;
    const playlist = store.getPlaylist(playlistId);
    const removed = store.deletePlaylist(playlistId);
    if (removed) {
        renderUserPlaylistsSidebar();
        if (activeDetail && activeDetail.type === "playlist" && activeDetail.id === playlistId) {
            closeDetailView();
        }
        showLibraryToast(`Deleted "${playlist?.name || "playlist"}"`);
    }
    return removed;
}

function addTrackToUserPlaylist(playlistId, trackId) {
    const store = getStorage();
    if (!store || !playlistId || !trackId) return { playlist: null, added: false };
    const before = store.getPlaylist(playlistId);
    if (!before) return { playlist: null, added: false };
    const alreadyIn = before.trackIds.includes(trackId);
    const playlist = alreadyIn ? before : store.addTrackToPlaylist(playlistId, trackId);
    const track = songs.find((t) => t.id === trackId);
    showLibraryToast(
        alreadyIn
            ? `Already in "${playlist.name}"`
            : `Added "${track?.title || "track"}" to "${playlist.name}"`
    );
    renderUserPlaylistsSidebar();
    refreshActiveCollectionView();
    return { playlist, added: !alreadyIn };
}

function removeTrackFromUserPlaylist(playlistId, trackId) {
    const store = getStorage();
    if (!store) return null;
    const playlist = store.removeTrackFromPlaylist(playlistId, trackId);
    renderUserPlaylistsSidebar();
    refreshActiveCollectionView();
    return playlist;
}

function moveUserPlaylistTrack(playlistId, fromIndex, toIndex) {
    const store = getStorage();
    if (!store) return null;
    const playlist = store.reorderPlaylistTracks(playlistId, fromIndex, toIndex);
    refreshActiveCollectionView();
    return playlist;
}

// ---------- Collection detail views (playlist / Liked Songs / Local Files) ----------

function buildCollectionDetailData(spec = {}) {
    const lib = getLibraryModule();
    const store = getStorage();
    const recommender = getRecommender();
    const type = COLLECTION_DETAIL_TYPES.includes(spec.type) ? spec.type : "playlist";

    let tracks = [];
    let id = type;
    let title = "";
    let description = "";
    let badge = "";
    let eyebrow = "";
    let tracklistTitle = "Tracks";
    let emptyHint = "";
    let mixLabel = "Start Playlist Mix";

    if (type === "playlist") {
        const playlist = store && typeof store.getPlaylist === "function" ? store.getPlaylist(spec.id) : null;
        if (!playlist) return null;
        id = playlist.id;
        tracks = lib ? lib.resolvePlaylistTracks(playlist, songs) : [];
        title = playlist.name;
        description = playlist.description;
        badge = "PLAYLIST";
        eyebrow = "YOUR PLAYLIST";
        tracklistTitle = "Playlist Tracks";
        emptyHint = "This playlist is empty. Use “+ Playlist” on any song, or add from the recommendations below.";
    } else if (type === "liked") {
        tracks = getLikedSongsTracks();
        id = "liked";
        title = "Liked Songs";
        description = "Every song you've hearted, in one place.";
        badge = "LIKED SONGS";
        eyebrow = "AUTO-PLAYLIST";
        tracklistTitle = "Liked Songs";
        mixLabel = "Start Liked Mix";
        emptyHint = "Songs you like will appear here. Tap ♡ on any song or press F while it plays.";
    } else {
        // Newest first, so a folder being added shows at the top of the list while its tags fill in
        tracks = getImportedLocalTracks()
            .map((t, i) => [t, i])
            .sort((a, b) => (Number(b[0].createdAt) || 0) - (Number(a[0].createdAt) || 0) || a[1] - b[1])
            .map(([t]) => t);
        id = "local";
        title = "Local Files";
        description = "Songs from your device. Linked folders play straight from your disk; added files are copied into this browser. Nothing is uploaded.";
        badge = "LOCAL FILES";
        eyebrow = "FROM YOUR DEVICE";
        tracklistTitle = "Imported Files";
        mixLabel = "Start Local Mix";
        emptyHint = "Use “+ Add Music” to pick a folder or files, or drag MP3, FLAC or WAV files (or whole folders) anywhere onto the app.";
    }

    const totalDuration = tracks.reduce((sum, t) => sum + Number(t.duration || 0), 0);
    const avgBpm = tracks.length
        ? Math.round(tracks.reduce((sum, t) => sum + Number(t.bpm || 110), 0) / tracks.length)
        : 0;
    const avgEnergyPct = tracks.length
        ? Math.round((tracks.reduce((sum, t) => sum + Number(t.energy ?? 0.65), 0) / tracks.length) * 100)
        : 0;
    const moods = Array.from(new Set(tracks.flatMap((t) => (Array.isArray(t.moods) ? t.moods : []))));
    let totalPlays = 0;
    let likedCount = 0;
    for (const t of tracks) {
        if (likedTrackIds.has(t.id)) likedCount++;
        if (store && typeof store.getTrackStats === "function") {
            totalPlays += store.getTrackStats(t.id)?.playCount || 0;
        }
    }

    // "Recommended" songs to add, seeded by the collection (or the current track when empty)
    let similarTracks = [];
    const seedTracks = tracks.length ? tracks : [songs[currentTrackIndex] || songs[0]].filter(Boolean);
    // Audio similarity is O(seeds x catalog); a big Local Files collection uses an even sample as seeds
    const recSeeds =
        seedTracks.length > 24
            ? Array.from({ length: 24 }, (_, i) => seedTracks[Math.floor((i * seedTracks.length) / 24)])
            : seedTracks;
    if (recommender && typeof recommender.recommendTracks === "function" && seedTracks.length) {
        try {
            similarTracks = recommender.recommendTracks(songs, {
                seed: recSeeds,
                excludeTrackIds: tracks.map((t) => t.id),
                includeSeedTracks: false,
                limit: 6,
                storage: store,
                mixMode: activeMixMode,
            });
        } catch (_) {
            similarTracks = [];
        }
    }

    const covers = lib ? lib.buildCollectionCovers(tracks, title) : [songs[0]?.coverUrl];
    const artists = Array.from(new Set(tracks.map((t) => t.primaryArtist).filter(Boolean)));
    const countLabel = `${tracks.length} ${tracks.length === 1 ? "song" : "songs"}`;

    return {
        type,
        id,
        target: id,
        title,
        description,
        badge,
        eyebrow,
        coverUrl: covers[0],
        collageCovers: covers,
        subtitle: description ? `${description} • ${countLabel}` : countLabel,
        trackCount: tracks.length,
        totalDuration,
        totalDurationFormatted: formatTotalDuration(totalDuration),
        avgBpm,
        avgEnergyPct,
        likedCount,
        totalPlays,
        moods,
        artists,
        collaborators: [],
        topTracks: tracks,
        tracks,
        discography: [],
        similarTracks,
        tracklistTitle,
        emptyHint,
        mixLabel,
        collection: { type, id },
        seedSpec: {
            type: "playlist",
            id: `collection-${id}`,
            smartMixId: `collection-${id}`,
            badge: type === "local" ? "LOCAL FILES MIX" : type === "liked" ? "LIKED SONGS MIX" : "PLAYLIST RADIO",
            label: `${title} Radio`,
            tracks: seedTracks,
        },
    };
}

function openPlaylistDetail(playlistId, options = {}) {
    return openDetailView({ type: "playlist", id: playlistId }, options);
}

function openLikedSongsDetail(options = {}) {
    return openDetailView({ type: "liked" }, options);
}

function openLocalFilesDetail(options = {}) {
    return openDetailView({ type: "local" }, options);
}

function refreshActiveCollectionView() {
    if (activeView !== "detail" || !activeDetail || !COLLECTION_DETAIL_TYPES.includes(activeDetail.type)) {
        return null;
    }
    const data = buildCollectionDetailData({ type: activeDetail.type, id: activeDetail.id });
    if (!data) {
        closeDetailView();
        return null;
    }
    activeDetail.data = data;
    activeDetail.title = data.title;
    renderDetailView(data);
    return data;
}

function renderDetailCollectionChrome(detailData) {
    const isCollection = COLLECTION_DETAIL_TYPES.includes(detailData.type);
    const actions = document.getElementById("detail-collection-actions");
    const editBtn = document.getElementById("detail-edit-playlist-btn");
    const deleteBtn = document.getElementById("detail-delete-playlist-btn");
    const importBtn = document.getElementById("detail-import-more-btn");
    const importFolderBtn = document.getElementById("detail-import-folder-btn");
    const emptyHint = document.getElementById("detail-empty-hint");
    const discographySection = document.getElementById("detail-discography-section");
    const similarSection = document.getElementById("detail-similar-section");

    if (actions) actions.hidden = !isCollection;
    if (editBtn) editBtn.hidden = detailData.type !== "playlist";
    if (deleteBtn) deleteBtn.hidden = detailData.type !== "playlist";
    if (importBtn) importBtn.hidden = detailData.type !== "local";
    if (importFolderBtn) importFolderBtn.hidden = detailData.type !== "local" || importFolderBtn.dataset.unsupported === "true";
    if (emptyHint) {
        const showHint = isCollection && detailData.trackCount === 0;
        emptyHint.hidden = !showHint;
        emptyHint.textContent = showHint ? detailData.emptyHint || "" : "";
    }
    if (discographySection) discographySection.hidden = isCollection;
    updateImportProgressUi();
    renderLocalSourcesPanel();
    if (similarSection) similarSection.hidden = isCollection && !(detailData.similarTracks || []).length;
}

function buildCollectionRowActionsHtml(track, idx, collection) {
    if (!collection) return "";
    const title = escapeHtml(track.title);
    if (collection.type === "playlist") {
        return `
            <button type="button" class="detail-row-btn" data-detail-track-action="playlist-up" title="Move ${title} up" aria-label="Move ${title} up">↑</button>
            <button type="button" class="detail-row-btn" data-detail-track-action="playlist-down" title="Move ${title} down" aria-label="Move ${title} down">↓</button>
            <button type="button" class="detail-row-btn danger-btn" data-detail-track-action="playlist-remove" title="Remove ${title} from this playlist">
                <span>Remove</span>
            </button>`;
    }
    if (collection.type === "local" && track.isLocalImport) {
        return `
            <button type="button" class="detail-row-btn danger-btn" data-detail-track-action="remove-import" title="Delete ${title} from this browser">
                <span>Delete</span>
            </button>`;
    }
    return "";
}

function handleCollectionRowAction(action, track, idx, collection) {
    if (action === "add-to-playlist") {
        openPlaylistPicker(track.id);
        return true;
    }
    if (!collection) return false;
    if (collection.type === "playlist") {
        if (action === "playlist-up") {
            if (idx > 0) moveUserPlaylistTrack(collection.id, idx, idx - 1);
            return true;
        }
        if (action === "playlist-down") {
            moveUserPlaylistTrack(collection.id, idx, idx + 1);
            return true;
        }
        if (action === "playlist-remove") {
            removeTrackFromUserPlaylist(collection.id, track.id);
            return true;
        }
    }
    if (action === "remove-import") {
        removeImportedTrack(track.id);
        return true;
    }
    return false;
}

function renderUserPlaylistsSidebar() {
    const container = document.getElementById("library-user-playlists");
    updateLocalFilesCount();
    if (!container) return;
    const lib = getLibraryModule();
    const nodes = getUserPlaylists().map((pl) => {
        const tracks = lib ? lib.resolvePlaylistTracks(pl, songs) : [];
        const cover = lib ? lib.buildCollectionCovers(tracks, pl.name)[0] : "";
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "library-item user-playlist-item";
        btn.setAttribute("role", "listitem");
        btn.dataset.playlistId = pl.id;
        if (activeView === "detail" && activeDetail?.type === "playlist" && activeDetail.id === pl.id) {
            btn.classList.add("active");
        }
        btn.innerHTML = `
            <div class="lib-item-art"><img alt=""></div>
            <div class="lib-item-meta">
                <span class="lib-item-title"></span>
                <span class="lib-item-sub">Playlist &bull; ${tracks.length} ${tracks.length === 1 ? "song" : "songs"}</span>
            </div>`;
        const img = btn.querySelector("img");
        if (img) img.src = cover;
        const titleEl = btn.querySelector(".lib-item-title");
        if (titleEl) titleEl.textContent = pl.name;
        btn.addEventListener("click", () => openPlaylistDetail(pl.id));
        return btn;
    });
    container.replaceChildren(...nodes);
}

// ---------- Add-to-playlist picker & edit dialog ----------

function renderPlaylistPickerList() {
    const list = document.getElementById("playlist-picker-list");
    const trackLabel = document.getElementById("playlist-picker-track");
    const track = songs.find((t) => t.id === playlistPickerTrackId);
    if (trackLabel) {
        trackLabel.textContent = track ? `${track.title} • ${track.primaryArtist}` : "ADD TO PLAYLIST";
    }
    if (!list) return [];
    const playlists = getUserPlaylists();
    const nodes = playlists.map((pl) => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "playlist-picker-item";
        btn.setAttribute("role", "listitem");
        btn.dataset.playlistId = pl.id;
        const has = track ? pl.trackIds.includes(track.id) : false;
        btn.classList.toggle("contains-track", has);
        btn.textContent = `${pl.name} (${pl.trackIds.length})${has ? " ✓" : ""}`;
        btn.addEventListener("click", () => {
            if (playlistPickerTrackId) addTrackToUserPlaylist(pl.id, playlistPickerTrackId);
            closePlaylistPicker();
        });
        return btn;
    });
    if (!nodes.length) {
        const empty = document.createElement("p");
        empty.className = "playlist-picker-empty";
        empty.textContent = "No playlists yet — create one to start collecting songs.";
        nodes.push(empty);
    }
    list.replaceChildren(...nodes);
    return playlists;
}

function openPlaylistPicker(trackId) {
    const track = songs.find((t) => t.id === trackId) || songs[currentTrackIndex];
    if (!track) return false;
    playlistPickerTrackId = track.id;
    renderPlaylistPickerList();
    setDialogOpen(document.getElementById("playlist-picker-dialog"), true);
    return true;
}

function closePlaylistPicker() {
    setDialogOpen(document.getElementById("playlist-picker-dialog"), false);
    playlistPickerTrackId = null;
}

function createPlaylistFromPicker() {
    const trackId = playlistPickerTrackId;
    const playlist = createUserPlaylist({ trackIds: trackId ? [trackId] : [] }, { open: false });
    closePlaylistPicker();
    if (playlist) {
        const track = songs.find((t) => t.id === trackId);
        showLibraryToast(`Created "${playlist.name}" with "${track?.title || "track"}"`);
    }
    return playlist;
}

function openPlaylistEditDialog(playlistId) {
    const store = getStorage();
    const playlist = store && store.getPlaylist(playlistId);
    if (!playlist) return false;
    playlistEditTargetId = playlistId;
    const nameInput = document.getElementById("playlist-name-input");
    const descInput = document.getElementById("playlist-desc-input");
    if (nameInput) nameInput.value = playlist.name;
    if (descInput) descInput.value = playlist.description || "";
    setDialogOpen(document.getElementById("playlist-edit-dialog"), true);
    if (nameInput && typeof nameInput.focus === "function") nameInput.focus();
    return true;
}

function closePlaylistEditDialog() {
    setDialogOpen(document.getElementById("playlist-edit-dialog"), false);
    playlistEditTargetId = null;
}

function savePlaylistEditDialog() {
    if (!playlistEditTargetId) return null;
    const nameInput = document.getElementById("playlist-name-input");
    const descInput = document.getElementById("playlist-desc-input");
    const name = String(nameInput?.value || "").trim();
    if (!name) return null;
    const updated = updateUserPlaylist(playlistEditTargetId, {
        name: name.slice(0, 80),
        description: String(descInput?.value || "").slice(0, 300),
    });
    closePlaylistEditDialog();
    return updated;
}

// ---------- Wiring ----------

function dataTransferHasFiles(dt) {
    if (!dt) return false;
    const types = Array.from(dt.types || []);
    return types.includes("Files");
}

function setDropOverlayVisible(visible) {
    const overlay = document.getElementById("drop-overlay");
    if (!overlay) return;
    overlay.hidden = !visible;
    overlay.setAttribute("aria-hidden", String(!visible));
}

function initLibraryImportControls() {
    initFolderSourceControls();
    const fileInput = document.getElementById("import-file-input");
    const folderInput = document.getElementById("import-folder-input");
    const onInputChange = (e) => {
        const files = Array.from(e.target?.files || []);
        if (files.length) importLocalAudioFiles(files);
        if (e.target) e.target.value = ""; // picking the same folder again still fires "change"
    };
    if (fileInput) fileInput.addEventListener("change", onInputChange);
    if (folderInput) folderInput.addEventListener("change", onInputChange);

    for (const id of ["sidebar-import-audio-cta", "detail-import-more-btn"]) {
        const el = document.getElementById(id);
        if (el) el.addEventListener("click", () => openImportPicker());
    }
    const folderBtn = document.getElementById("detail-import-folder-btn");
    if (folderBtn) folderBtn.addEventListener("click", () => openImportPicker({ folder: true }));

    for (const id of ["sidebar-create-playlist-cta"]) {
        const el = document.getElementById(id);
        if (el) el.addEventListener("click", () => createUserPlaylist());
    }

    const likedBtn = document.getElementById("lib-liked-songs");
    if (likedBtn) likedBtn.addEventListener("click", () => openLikedSongsDetail());
    const localBtn = document.getElementById("lib-local-files");
    if (localBtn) localBtn.addEventListener("click", () => openLocalFilesDetail());

    const editBtn = document.getElementById("detail-edit-playlist-btn");
    if (editBtn) {
        editBtn.addEventListener("click", () => {
            if (activeDetail?.type === "playlist") openPlaylistEditDialog(activeDetail.id);
        });
    }
    const deleteBtn = document.getElementById("detail-delete-playlist-btn");
    if (deleteBtn) {
        deleteBtn.addEventListener("click", () => {
            if (activeDetail?.type !== "playlist") return;
            // Two-step confirm without a blocking window.confirm()
            if (deleteBtn.dataset.confirming === "true") {
                deleteBtn.dataset.confirming = "false";
                deleteBtn.textContent = "Delete playlist";
                deleteUserPlaylist(activeDetail.id);
            } else {
                deleteBtn.dataset.confirming = "true";
                deleteBtn.textContent = "Click again to delete";
                if (typeof setTimeout === "function") setTimeout(() => {
                    deleteBtn.dataset.confirming = "false";
                    deleteBtn.textContent = "Delete playlist";
                }, 3500);
            }
        });
    }

    const playbarAddBtn = document.getElementById("playbar-add-to-playlist-btn");
    if (playbarAddBtn) {
        playbarAddBtn.addEventListener("click", () => openPlaylistPicker(songs[currentTrackIndex]?.id));
    }

    const pickerClose = document.getElementById("playlist-picker-close-btn");
    if (pickerClose) pickerClose.addEventListener("click", () => closePlaylistPicker());
    const pickerNew = document.getElementById("playlist-picker-new-btn");
    if (pickerNew) pickerNew.addEventListener("click", () => createPlaylistFromPicker());
    const pickerDialog = document.getElementById("playlist-picker-dialog");
    if (pickerDialog) pickerDialog.addEventListener("close", () => (pickerDialog.hidden = true));

    const editForm = document.getElementById("playlist-edit-form");
    if (editForm) {
        editForm.addEventListener("submit", (e) => {
            e.preventDefault();
            savePlaylistEditDialog();
        });
    }
    for (const id of ["playlist-edit-close-btn", "playlist-edit-cancel-btn"]) {
        const el = document.getElementById(id);
        if (el) el.addEventListener("click", () => closePlaylistEditDialog());
    }
    const editDialog = document.getElementById("playlist-edit-dialog");
    if (editDialog) editDialog.addEventListener("close", () => (editDialog.hidden = true));

    // Drag & drop anywhere on the app
    document.addEventListener("dragenter", (e) => {
        if (!dataTransferHasFiles(e.dataTransfer)) return;
        e.preventDefault();
        dropDragDepth++;
        setDropOverlayVisible(true);
    });
    document.addEventListener("dragover", (e) => {
        if (!dataTransferHasFiles(e.dataTransfer)) return;
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    });
    document.addEventListener("dragleave", (e) => {
        if (!dataTransferHasFiles(e.dataTransfer)) return;
        dropDragDepth = Math.max(0, dropDragDepth - 1);
        if (dropDragDepth === 0) setDropOverlayVisible(false);
    });
    document.addEventListener("drop", (e) => {
        if (!dataTransferHasFiles(e.dataTransfer)) return;
        e.preventDefault();
        dropDragDepth = 0;
        setDropOverlayVisible(false);
        importFromDataTransfer(e.dataTransfer);
    });

    initAddMusicControls();
    renderUserPlaylistsSidebar();
    updateLocalFilesCount();
}

// ---------- Item 13: instant import progress, batched row updates, Add Music menu ----------

const displayCoverUrlCache = new Map();

/**
 * Embedded covers are stored as data: URLs (they persist in IndexedDB). Rendering hundreds of 30 KB-1 MB
 * base64 strings through innerHTML froze the page, so tracks display a blob: URL instead, one per distinct
 * image (an album's tracks share it). The data: URL stays on `coverDataUrl` for anything that needs it.
 */
function useDisplayCover(track) {
    if (!track || typeof track.coverUrl !== "string") return track;
    const url = track.coverUrl;
    if (!url.startsWith("data:image/") || url.startsWith("data:image/svg")) return track;
    if (typeof URL === "undefined" || typeof URL.createObjectURL !== "function" || typeof Blob === "undefined" || typeof atob !== "function") {
        return track;
    }
    let blobUrl = displayCoverUrlCache.get(url);
    if (!blobUrl) {
        try {
            const comma = url.indexOf(",");
            const mime = url.slice(5, url.indexOf(";")) || "image/jpeg";
            const binary = atob(url.slice(comma + 1));
            const bytes = new Uint8Array(binary.length);
            for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
            blobUrl = URL.createObjectURL(new Blob([bytes], { type: mime }));
            displayCoverUrlCache.set(url, blobUrl);
        } catch (_) {
            return track;
        }
    }
    track.coverDataUrl = url;
    track.coverUrl = blobUrl;
    return track;
}

let activeImportJobs = [];
let importFlushScheduled = false;
let importRowsNeedRebuild = false;
let importLastQuarter = 0;
let libraryToastTimeoutMs = 4200;
let importDetailsReturnFocus = null;
let homeSectionsHidden = false;
const pendingImportRowUpdates = new Map();
const addMusicMenuState = { open: false, anchor: null };

function getExistingImportKeys() {
    const lib = getLibraryModule();
    if (!lib || typeof lib.importFileKey !== "function") return [];
    return getImportedLocalTracks()
        .filter((t) => t.filename)
        .map((t) => t.importKey || lib.importFileKey(t.filename, t.size));
}

/** Removes tracks from the live catalog (and upcoming queue) while keeping the playing track's index right. */
function removeTracksFromCatalog(trackIds = []) {
    const ids = new Set(trackIds);
    if (!ids.size) return;
    const qm = getQueueManager();
    if (qm && typeof qm.removeFromQueue === "function") {
        try {
            const upcoming = typeof qm.getUpcomingTracks === "function" ? qm.getUpcomingTracks() : [];
            for (const t of upcoming) if (ids.has(t.id)) qm.removeFromQueue(t.id);
        } catch (_) {}
    }
    const activeId = songs[currentTrackIndex]?.id;
    songs = songs.filter((t) => !ids.has(t.id));
    const nextIndex = songs.findIndex((t) => t.id === activeId);
    currentTrackIndex = nextIndex >= 0 ? nextIndex : Math.min(currentTrackIndex, Math.max(0, songs.length - 1));
    importRowsNeedRebuild = true;
}

function queueImportRowUpdate(track) {
    if (track) useDisplayCover(track);
    if (track && track.id) pendingImportRowUpdates.set(track.id, track);
    scheduleImportFlush();
}

/** Batches re-renders to one per animation frame (setTimeout fallback) no matter how many tags finish. */
function scheduleImportFlush() {
    if (importFlushScheduled) return;
    importFlushScheduled = true;
    const run = () => flushImportUpdates();
    if (typeof window !== "undefined" && typeof window.requestAnimationFrame === "function") {
        window.requestAnimationFrame(run);
    } else if (typeof setTimeout === "function") {
        setTimeout(run, 32);
    } else {
        run();
    }
}

function cssEscapeValue(value) {
    if (typeof CSS !== "undefined" && CSS && typeof CSS.escape === "function") return CSS.escape(value);
    return String(value).replace(/["\\]/g, "\\$&");
}

/** Swaps updated rows in place in Local Files so scroll position and keyboard focus survive tag updates. */
function patchLocalFileRows(tracks) {
    const container = document.getElementById("detail-top-tracks");
    if (!container || typeof container.querySelector !== "function") return false;
    const collection = (activeDetail && activeDetail.data && activeDetail.data.collection) || { type: "local", id: "local" };
    const active = typeof document !== "undefined" ? document.activeElement : null;
    for (const track of tracks) {
        const row = container.querySelector(`[data-track-id="${cssEscapeValue(track.id)}"]`);
        if (!row || !row.parentNode || typeof row.replaceWith !== "function") continue;
        const idx = Array.prototype.indexOf.call(container.children, row);
        const next = createDetailTrackRowNode(track, Math.max(0, idx), { collection });
        const hadFocus = active && typeof row.contains === "function" && row.contains(active);
        const focusAction = hadFocus && active.dataset ? active.dataset.detailTrackAction : "";
        row.replaceWith(next);
        if (hadFocus) {
            const target =
                (focusAction && next.querySelector(`[data-detail-track-action="${focusAction}"]`)) ||
                next.querySelector("button") ||
                next;
            if (target && typeof target.focus === "function") target.focus({ preventScroll: true });
        }
    }
    return true;
}

function flushImportUpdates(options = {}) {
    importFlushScheduled = false;
    const updated = Array.from(pendingImportRowUpdates.values());
    pendingImportRowUpdates.clear();
    const onLocalFiles = activeView === "detail" && activeDetail && activeDetail.type === "local";
    if (onLocalFiles && !options.force) {
        if (importRowsNeedRebuild) {
            importRowsNeedRebuild = false;
            refreshActiveCollectionView();
        } else if (updated.length) {
            patchLocalFileRows(updated);
        }
    } else if (options.force) {
        importRowsNeedRebuild = false;
    }
    updateLocalFilesCount();
    updateImportProgressUi();
}

function getImportTotals() {
    let completed = 0;
    let total = 0;
    for (const job of activeImportJobs) {
        completed += job.controller.completed;
        total += job.controller.total;
    }
    return { completed, total };
}

function announceImport(message) {
    const live = document.getElementById("import-live");
    if (!live || !message) return;
    live.textContent = "";
    live.textContent = String(message);
}

/** Progress header in Local Files + the pill above the playbar + polite announcements about every 25%. */
function updateImportProgressUi() {
    const running = activeImportJobs.length > 0;
    const { completed, total } = getImportTotals();
    const latest = activeImportJobs[activeImportJobs.length - 1];
    const onLocalFiles = activeView === "detail" && activeDetail && activeDetail.type === "local";
    const pct = total > 0 ? Math.round((completed / total) * 100) : 0;
    const label = running ? `Adding “${latest.sourceName}” · ${completed} of ${total}` : "";

    const header = document.getElementById("import-progress");
    if (header) header.hidden = !(running && onLocalFiles);
    const headerLabel = document.getElementById("import-progress-label");
    if (headerLabel) headerLabel.textContent = label;

    for (const id of ["import-progress-bar", "import-pill-bar"]) {
        const bar = document.getElementById(id);
        if (!bar) continue;
        bar.setAttribute("aria-valuemin", "0");
        bar.setAttribute("aria-valuemax", String(Math.max(total, 1)));
        bar.setAttribute("aria-valuenow", String(completed));
        bar.setAttribute("aria-valuetext", `${completed} of ${total} songs`);
        const fill = bar.querySelector ? bar.querySelector(".import-progress-fill") : null;
        if (fill && fill.style) fill.style.width = `${pct}%`;
    }

    const pill = document.getElementById("import-progress-pill");
    const pillVisible = running && !onLocalFiles;
    if (pill) pill.hidden = !pillVisible;
    const pillLabel = document.getElementById("import-pill-label");
    if (pillLabel) pillLabel.textContent = running ? `Adding songs · ${completed} of ${total}` : "";
    if (document.body && document.body.classList) document.body.classList.toggle("has-import-pill", pillVisible);

    if (running && total > 0) {
        const quarter = Math.floor((completed / total) * 4);
        if (quarter > importLastQuarter && quarter < 4) {
            importLastQuarter = quarter;
            announceImport(`${quarter * 25}% added · ${completed} of ${total} songs`);
        }
    } else {
        importLastQuarter = 0;
    }
}

function cancelActiveImports() {
    if (!activeImportJobs.length) return false;
    for (const job of activeImportJobs) job.controller.cancel();
    announceImport("Stopping the import…");
    return true;
}

function hideLibraryToast() {
    const toast = document.getElementById("library-toast");
    if (toast) toast.hidden = true;
    if (libraryToastTimer && typeof clearTimeout === "function") clearTimeout(libraryToastTimer);
    libraryToastTimer = null;
}

function startLibraryToastTimer() {
    if (libraryToastTimer && typeof clearTimeout === "function") clearTimeout(libraryToastTimer);
    libraryToastTimer = null;
    if (libraryToastTimeoutMs > 0 && typeof setTimeout === "function") {
        libraryToastTimer = setTimeout(hideLibraryToast, libraryToastTimeoutMs);
    }
}

/**
 * Status toast (role="status"). options: { error, timeoutMs (0 = stays until dismissed), action: { label, onClick } }.
 * Toasts with an action stay longer and pause while hovered or focused.
 */
function showLibraryToast(message, options = {}) {
    const toast = document.getElementById("library-toast");
    if (!toast || !message) return;
    toast.textContent = String(message);
    toast.hidden = false;
    toast.classList.toggle("is-error", Boolean(options.error));
    const action = options.action && options.action.label && typeof options.action.onClick === "function" ? options.action : null;
    const persistent = options.timeoutMs === 0;
    if (action && typeof toast.append === "function") {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "library-toast-action";
        btn.textContent = action.label;
        btn.addEventListener("click", () => {
            hideLibraryToast();
            action.onClick();
        });
        toast.append(btn);
    }
    if (persistent && typeof toast.append === "function") {
        const close = document.createElement("button");
        close.type = "button";
        close.className = "library-toast-close";
        close.setAttribute("aria-label", "Dismiss message");
        close.textContent = "×";
        close.addEventListener("click", () => hideLibraryToast());
        toast.append(close);
    }
    libraryToastTimeoutMs = persistent ? 0 : options.timeoutMs || (action ? 10000 : 4200);
    startLibraryToastTimer();
}

function openImportDetailsDialog(entries = []) {
    const dialog = document.getElementById("import-details-dialog");
    const list = document.getElementById("import-details-list");
    const count = document.getElementById("import-details-count");
    if (!dialog || !list) return false;
    const active = document.activeElement;
    const toast = document.getElementById("library-toast");
    importDetailsReturnFocus =
        active && active !== document.body && !(toast && typeof toast.contains === "function" && toast.contains(active))
            ? active
            : document.getElementById("lib-local-files");
    const nodes = entries.map((entry) => {
        const li = document.createElement("li");
        li.className = "import-details-item";
        const name = document.createElement("span");
        name.className = "import-details-name";
        name.textContent = entry.relativePath || entry.name || "file";
        const reason = document.createElement("span");
        reason.className = "import-details-reason";
        reason.textContent = entry.reason || "Skipped";
        li.append(name);
        li.append(reason);
        return li;
    });
    list.replaceChildren(...nodes);
    if (count) count.textContent = `${entries.length} ${entries.length === 1 ? "file wasn't" : "files weren't"} added`;
    setDialogOpen(dialog, true);
    const closeBtn = document.getElementById("import-details-close-btn");
    if (closeBtn && typeof closeBtn.focus === "function") closeBtn.focus();
    return true;
}

function closeImportDetailsDialog() {
    setDialogOpen(document.getElementById("import-details-dialog"), false);
    const target = importDetailsReturnFocus;
    importDetailsReturnFocus = null;
    if (target && target.isConnected !== false && typeof target.focus === "function") target.focus();
}

// Add Music menu: "+ Add Music" in the left nav and the "+" (Create) in Your Library share one menu.

function getAddMusicMenuItems() {
    const menu = document.getElementById("add-music-menu");
    if (!menu || typeof menu.querySelectorAll !== "function") return [];
    return Array.from(menu.querySelectorAll('[role="menuitem"]')).filter((el) => !el.hidden);
}

function isSheetLayout() {
    return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(max-width: 740px)").matches;
}

function openAddMusicMenu(anchor, options = {}) {
    const menu = document.getElementById("add-music-menu");
    if (!menu || !anchor) return false;
    if (addMusicMenuState.open) closeAddMusicMenu({ returnFocus: false });
    const playlistItem = document.getElementById("add-music-playlist-item");
    if (playlistItem) playlistItem.hidden = !options.withPlaylist;
    const title = document.getElementById("add-music-menu-title");
    if (title) title.textContent = options.withPlaylist ? "Create" : "Add music";
    if (anchor.id) menu.setAttribute("aria-labelledby", anchor.id);
    menu.hidden = false;
    const backdrop = document.getElementById("add-music-backdrop");
    if (backdrop) backdrop.hidden = !isSheetLayout();
    anchor.setAttribute("aria-expanded", "true");
    addMusicMenuState.open = true;
    addMusicMenuState.anchor = anchor;

    if (menu.style) {
        if (isSheetLayout() || typeof anchor.getBoundingClientRect !== "function") {
            menu.style.top = "";
            menu.style.left = "";
        } else {
            const rect = anchor.getBoundingClientRect();
            const vw = window.innerWidth || 1024;
            const vh = window.innerHeight || 768;
            const width = menu.offsetWidth || 260;
            const height = menu.offsetHeight || 180;
            const top = rect.bottom + 6 + height > vh ? Math.max(8, rect.top - height - 6) : rect.bottom + 6;
            menu.style.top = `${Math.round(top)}px`;
            menu.style.left = `${Math.round(Math.max(8, Math.min(rect.left, vw - width - 8)))}px`;
        }
    }
    const items = getAddMusicMenuItems();
    const first = items[0];
    if (first && typeof first.focus === "function") first.focus();
    return true;
}

function closeAddMusicMenu(options = {}) {
    const menu = document.getElementById("add-music-menu");
    const anchor = addMusicMenuState.anchor;
    if (menu) menu.hidden = true;
    const backdrop = document.getElementById("add-music-backdrop");
    if (backdrop) backdrop.hidden = true;
    if (anchor) anchor.setAttribute("aria-expanded", "false");
    addMusicMenuState.open = false;
    addMusicMenuState.anchor = null;
    if (options.returnFocus !== false && anchor && typeof anchor.focus === "function") anchor.focus();
}

function runAddMusicAction(action) {
    closeAddMusicMenu({ returnFocus: true });
    if (action === "folder") return openImportPicker({ folder: true });
    if (action === "files") return openImportPicker({ folder: false });
    if (action === "playlist") return createUserPlaylist();
    return null;
}

function handleAddMusicMenuKeydown(e) {
    const items = getAddMusicMenuItems();
    if (!items.length) return;
    const current = items.indexOf(document.activeElement);
    let next = -1;
    if (e.key === "ArrowDown") next = current < 0 ? 0 : (current + 1) % items.length;
    else if (e.key === "ArrowUp") next = current <= 0 ? items.length - 1 : current - 1;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = items.length - 1;
    else if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        closeAddMusicMenu({ returnFocus: true });
        return;
    } else if (e.key === "Tab") {
        e.preventDefault();
        closeAddMusicMenu({ returnFocus: true });
        return;
    }
    if (next >= 0) {
        e.preventDefault();
        items[next].focus();
    }
}

function updateHomeAddMusicCard() {
    const card = document.getElementById("home-add-music-card");
    if (!card) return;
    card.hidden = homeSectionsHidden || getImportedLocalTracks().length > 0;
}

function applyFolderPickingSupport() {
    const folders = canPickFolders();
    const folderItem = document.getElementById("add-music-folder-item");
    if (folderItem) folderItem.hidden = !folders;
    const note = document.getElementById("add-music-folder-note");
    if (note) note.hidden = folders;
    const dragHint = document.getElementById("add-music-hint");
    if (dragHint) dragHint.hidden = !folders;
    const detailFolderBtn = document.getElementById("detail-import-folder-btn");
    if (detailFolderBtn) detailFolderBtn.dataset.unsupported = folders ? "false" : "true";
    const homeBtn = document.getElementById("home-add-music-btn");
    if (homeBtn) {
        homeBtn.textContent = folders ? "Add a folder…" : "Add files…";
        homeBtn.dataset.addMusic = folders ? "folder" : "files";
    }
    return folders;
}

function initAddMusicControls() {
    applyFolderPickingSupport();
    const menu = document.getElementById("add-music-menu");
    const toggle = (anchor, opts) => {
        if (addMusicMenuState.open && addMusicMenuState.anchor === anchor) closeAddMusicMenu({ returnFocus: true });
        else openAddMusicMenu(anchor, opts);
    };
    const navBtn = document.getElementById("add-music-btn");
    if (navBtn) navBtn.addEventListener("click", () => toggle(navBtn, { withPlaylist: false }));
    const createBtn = document.getElementById("create-playlist-btn");
    if (createBtn) createBtn.addEventListener("click", () => toggle(createBtn, { withPlaylist: true }));
    const mobileBtn = document.getElementById("mobile-add-music-btn");
    if (mobileBtn) mobileBtn.addEventListener("click", () => toggle(mobileBtn, { withPlaylist: false }));
    for (const btn of [navBtn, createBtn, mobileBtn]) {
        if (!btn) continue;
        btn.addEventListener("keydown", (e) => {
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                e.preventDefault();
                openAddMusicMenu(btn, { withPlaylist: btn === createBtn });
                if (e.key === "ArrowUp") {
                    const items = getAddMusicMenuItems();
                    if (items.length) items[items.length - 1].focus();
                }
            }
        });
    }
    if (menu) {
        menu.addEventListener("keydown", handleAddMusicMenuKeydown);
        if (typeof menu.querySelectorAll === "function") {
            for (const item of Array.from(menu.querySelectorAll('[role="menuitem"]'))) {
                item.addEventListener("click", () => runAddMusicAction(item.dataset.addMusic));
            }
        }
    }
    const backdrop = document.getElementById("add-music-backdrop");
    if (backdrop) backdrop.addEventListener("click", () => closeAddMusicMenu({ returnFocus: true }));
    document.addEventListener("pointerdown", (e) => {
        if (!addMusicMenuState.open) return;
        const target = e.target;
        const anchor = addMusicMenuState.anchor;
        if (menu && typeof menu.contains === "function" && menu.contains(target)) return;
        if (anchor && typeof anchor.contains === "function" && anchor.contains(target)) return;
        closeAddMusicMenu({ returnFocus: false });
    });

    const homeBtn = document.getElementById("home-add-music-btn");
    if (homeBtn) homeBtn.addEventListener("click", () => openImportPicker({ folder: homeBtn.dataset.addMusic !== "files" }));

    const pill = document.getElementById("import-progress-pill");
    if (pill) pill.addEventListener("click", () => openLocalFilesDetail());
    const cancelBtn = document.getElementById("import-cancel-btn");
    if (cancelBtn) cancelBtn.addEventListener("click", () => cancelActiveImports());

    const toast = document.getElementById("library-toast");
    if (toast) {
        const pause = () => {
            if (libraryToastTimer && typeof clearTimeout === "function") clearTimeout(libraryToastTimer);
            libraryToastTimer = null;
        };
        toast.addEventListener("mouseenter", pause);
        toast.addEventListener("focusin", pause);
        toast.addEventListener("mouseleave", () => startLibraryToastTimer());
        toast.addEventListener("focusout", () => startLibraryToastTimer());
    }

    const detailsClose = document.getElementById("import-details-close-btn");
    if (detailsClose) detailsClose.addEventListener("click", () => closeImportDetailsDialog());
    const detailsDialog = document.getElementById("import-details-dialog");
    if (detailsDialog) {
        detailsDialog.addEventListener("close", () => {
            detailsDialog.hidden = true;
            if (importDetailsReturnFocus) closeImportDetailsDialog();
        });
    }
    updateHomeAddMusicCard();
}


// ==================== ITEM 14: PLAY STRAIGHT FROM THE PICKED FOLDER (NO COPY) ====================
// Where showDirectoryPicker exists, a picked folder is saved as a FileSystemDirectoryHandle and its songs keep
// only metadata + a relative path. Audio is read from disk at play time. After a reload the browser forgets the
// permission, so Local Files and the Add Music menu offer "Reconnect", plus "Rescan" for added/removed files.
// Drag-and-drop, <input> pickers and Safari/Firefox keep copying into IndexedDB.

let folderSources = []; // { id, name, handle, createdAt } from storage
const folderSourceStatus = new Map(); // id -> "granted" | "prompt" | "denied" | "missing"
const forgetConfirmTimers = new Map();

function getFolderSourceStatus(sourceId) {
    return folderSourceStatus.get(sourceId) || "prompt";
}

function getFolderSourceTracks(sourceId) {
    return songs.filter((t) => t && t.isLocalImport && t.storageMode === "linked" && t.sourceId === sourceId);
}

/** A linked track whose folder isn't readable right now can't autoplay, so mixes and the queue leave it out. */
function isTrackWaitingForFolder(track) {
    return Boolean(track && track.storageMode === "linked" && !track.audioUrl && getFolderSourceStatus(track.sourceId) !== "granted");
}

let queueCatalogCache = { songsRef: null, length: -1, statusKey: "", catalog: null };
function getQueueCatalog() {
    const statusKey = Array.from(folderSourceStatus.entries()).map(([k, v]) => `${k}:${v}`).join(",");
    if (
        queueCatalogCache.songsRef === songs &&
        queueCatalogCache.length === songs.length &&
        queueCatalogCache.statusKey === statusKey
    ) {
        return queueCatalogCache.catalog;
    }
    const waiting = songs.some(isTrackWaitingForFolder);
    const catalog = waiting ? songs.filter((t) => !isTrackWaitingForFolder(t)) : songs;
    queueCatalogCache = { songsRef: songs, length: songs.length, statusKey, catalog };
    return catalog;
}

function syncQueueCatalog() {
    const qm = getQueueManager();
    if (qm && typeof qm.setCatalog === "function" && songs.length) {
        qm.setCatalog(getQueueCatalog(), { rebuildQueue: false, silent: true });
    }
}

function setFolderSourceStatus(sourceId, status) {
    const before = folderSourceStatus.get(sourceId);
    folderSourceStatus.set(sourceId, status);
    if (before !== status) {
        syncQueueCatalog();
        refreshFolderSourcesUi();
    }
}

/** Loads saved folders and asks (without prompting) whether each one is still readable. Called from main(). */
async function initFolderSources() {
    const store = getStorage();
    if (!store || typeof store.getFolderSources !== "function") return [];
    try {
        folderSources = await store.getFolderSources();
    } catch (_) {
        folderSources = [];
    }
    for (const source of folderSources) {
        let status = "prompt";
        try {
            status = await store.getFolderPermission(source);
        } catch (_) {}
        folderSourceStatus.set(source.id, status);
    }
    // Linked tracks whose folder record is gone can never play again
    for (const t of getImportedLocalTracks()) {
        if (t.storageMode === "linked" && !folderSources.some((src) => src.id === t.sourceId)) {
            folderSourceStatus.set(t.sourceId, "missing");
        }
    }
    syncQueueCatalog();
    refreshFolderSourcesUi();
    return folderSources;
}

/**
 * Item 14 entry for showDirectoryPicker: reuse the saved source when the same folder is picked again
 * (that becomes a Rescan), otherwise save the handle and import without copying.
 */
async function importFromFolderHandle(handle, options = {}) {
    const lib = getLibraryModule();
    const store = getStorage();
    if (!lib || !handle) return null;
    const canLink = store && typeof store.saveFolderSource === "function";
    if (!canLink) {
        const entries = await lib.collectFilesFromDirectoryHandle(handle);
        return importLocalAudioFiles(entries, { sourceName: options.sourceName });
    }
    const existing = await store.findFolderSourceForHandle(handle);
    if (existing) {
        // The user just picked it, so it's readable; keep the newest handle
        const updated = await store.saveFolderSource({ ...existing, handle, name: handle.name || existing.name });
        upsertFolderSource(updated);
        folderSourceStatus.set(updated.id, "granted");
        return rescanFolderSource(updated.id, { skipPermission: true, openCollection: true });
    }
    const source = await store.saveFolderSource({ name: String(handle.name || options.sourceName || "Folder"), handle });
    upsertFolderSource(source);
    folderSourceStatus.set(source.id, "granted");
    const entries = await lib.collectFilesFromDirectoryHandle(handle);
    const result = await importLocalAudioFiles(entries, {
        ...options,
        sourceName: options.sourceName || source.name,
        linkSource: source,
    });
    // Nothing usable in it: don't keep an empty folder link around
    if (result && !getFolderSourceTracks(source.id).length) {
        await store.deleteFolderSource(source.id);
        folderSources = folderSources.filter((src) => src.id !== source.id);
        folderSourceStatus.delete(source.id);
        refreshFolderSourcesUi();
    }
    return result;
}

function upsertFolderSource(source) {
    if (!source) return;
    const idx = folderSources.findIndex((src) => src.id === source.id);
    if (idx >= 0) folderSources[idx] = source;
    else folderSources.push(source);
}

/** Resolves (and caches on the track) a playable URL. Returns the URL or null. */
async function resolveTrackAudioUrl(track, options = {}) {
    if (!track) return null;
    if (track.audioUrl) return track.audioUrl;
    if (track.storageMode !== "linked") return null;
    const store = getStorage();
    if (!store || typeof store.resolveLinkedTrackUrl !== "function") return null;
    const result = await store.resolveLinkedTrackUrl(track, { request: Boolean(options.request) });
    const catalogTrack = songs.find((t) => t.id === track.id);
    if (result.status === "ok" && result.url) {
        track.audioUrl = result.url;
        if (catalogTrack && catalogTrack !== track) catalogTrack.audioUrl = result.url;
        setFolderSourceStatus(track.sourceId, "granted");
        return result.url;
    }
    track.unavailableReason = result.status;
    if (catalogTrack && catalogTrack !== track) catalogTrack.unavailableReason = result.status;
    if (result.status === "prompt" || result.status === "denied" || result.status === "missing") {
        setFolderSourceStatus(track.sourceId, result.status);
    }
    return null;
}

function handleUnavailableTrack(track) {
    if (!track) return;
    const source = folderSources.find((src) => src.id === track.sourceId);
    const name = source ? source.name : "its folder";
    const reason = track.unavailableReason;
    if (reason === "not-found") {
        const message = `Couldn't find “${track.title}” in “${name}”. It may have been moved or deleted.`;
        showLibraryToast(message, {
            error: true,
            timeoutMs: 0,
            action: source ? { label: "Rescan folder", onClick: () => rescanFolderSource(source.id) } : null,
        });
        announceImport(message);
        return;
    }
    if (reason === "missing" || !source) {
        const message = `“${track.title}” can't play because its folder is no longer linked. Add the folder again.`;
        showLibraryToast(message, { error: true, timeoutMs: 0, action: { label: "Add a folder…", onClick: () => openImportPicker({ folder: true }) } });
        announceImport(message);
        return;
    }
    const message =
        reason === "denied"
            ? `The browser blocked access to “${name}”. Allow it to play these songs.`
            : `“${name}” needs your permission again to play its songs.`;
    showLibraryToast(message, {
        error: true,
        timeoutMs: 0,
        action: { label: "Reconnect folder", onClick: () => reconnectFolderSource(source.id) },
    });
    announceImport(message);
}

/** Asks the browser for read access again (needs the click that called it). Returns the new status. */
async function reconnectFolderSource(sourceId, options = {}) {
    const store = getStorage();
    const source = folderSources.find((src) => src.id === sourceId);
    if (!store || !source) return "missing";
    announceImport(`Asking the browser for access to “${source.name}”…`);
    let status = "prompt";
    try {
        status = await store.getFolderPermission(source, { request: true });
    } catch (_) {}
    setFolderSourceStatus(sourceId, status);
    const count = getFolderSourceTracks(sourceId).length;
    if (status === "granted") {
        const message = `Reconnected “${source.name}”. ${count} ${count === 1 ? "song is" : "songs are"} ready to play.`;
        announceImport(message);
        showLibraryToast(message);
        updateLocalFilesCount();
        refreshFolderSourcesUi();
        focusFolderSourceControl(sourceId, "rescan", options.returnFocus);
    } else {
        const message =
            status === "denied"
                ? `The browser blocked access to “${source.name}”. Allow file access for this site in the browser's site settings, then try again.`
                : `“${source.name}” is still waiting for permission.`;
        announceImport(message);
        showLibraryToast(message, {
            error: true,
            timeoutMs: 0,
            action: { label: "Try again", onClick: () => reconnectFolderSource(sourceId, options) },
        });
        focusFolderSourceControl(sourceId, "reconnect", options.returnFocus);
    }
    return status;
}

/** Re-walks a linked folder: imports new files, drops ones that are gone. Resolves to the diff. */
async function rescanFolderSource(sourceId, options = {}) {
    const lib = getLibraryModule();
    const store = getStorage();
    const source = folderSources.find((src) => src.id === sourceId);
    if (!lib || !store || !source || !source.handle) return null;
    if (!options.skipPermission) {
        const status = await store.getFolderPermission(source, { request: true });
        setFolderSourceStatus(sourceId, status);
        if (status !== "granted") {
            handleUnavailableTrack({ title: source.name, sourceId, unavailableReason: status });
            return null;
        }
    }
    announceImport(`Rescanning “${source.name}”…`);
    let entries = [];
    try {
        entries = await lib.collectFilesFromDirectoryHandle(source.handle);
    } catch (err) {
        const message = `Couldn't read “${source.name}”. It may have been moved or renamed.`;
        showLibraryToast(message, { error: true, timeoutMs: 0 });
        announceImport(message);
        return null;
    }
    const existing = getFolderSourceTracks(sourceId);
    const diff = lib.diffFolderScan(existing, entries);
    if (diff.removed.length) {
        const ids = diff.removed.map((t) => t.id);
        if (typeof store.forgetLinkedTrackUrls === "function") store.forgetLinkedTrackUrls(ids);
        // Playlists and likes keep the ids, so a moved file that comes back with the same id reappears in them
        for (const id of ids) await store.deleteImportedTrack(id);
        removeTracksFromCatalog(ids);
    }
    const summarize = () => lib.summarizeRescan(source.name, diff);
    if (diff.added.length) {
        await importLocalAudioFiles(diff.added, {
            sourceName: source.name,
            linkSource: source,
            openCollection: options.openCollection === true,
            summarize,
        });
    } else {
        flushImportUpdates({ force: true });
        refreshLibraryViews();
        const message = summarize();
        showLibraryToast(message);
        if (options.openCollection) openLocalFilesDetail();
    }
    refreshFolderSourcesUi();
    focusFolderSourceControl(sourceId, "rescan", options.returnFocus);
    return diff;
}

/** Removes a linked folder and its songs from the library (files on disk are untouched). */
async function forgetFolderSource(sourceId) {
    const store = getStorage();
    const source = folderSources.find((src) => src.id === sourceId);
    if (!store || !source) return false;
    const ids = getFolderSourceTracks(sourceId).map((t) => t.id);
    if (typeof store.forgetLinkedTrackUrls === "function") store.forgetLinkedTrackUrls(ids);
    for (const id of ids) await store.deleteImportedTrack(id);
    const idSet = new Set(ids);
    for (const pl of getUserPlaylists()) {
        for (const id of pl.trackIds) if (idSet.has(id)) store.removeTrackFromPlaylist(pl.id, id);
    }
    removeTracksFromCatalog(ids);
    await store.deleteFolderSource(sourceId);
    folderSources = folderSources.filter((src) => src.id !== sourceId);
    folderSourceStatus.delete(sourceId);
    flushImportUpdates({ force: true });
    refreshLibraryViews();
    refreshFolderSourcesUi();
    const message = `Removed “${source.name}” from your library. The files on your computer weren't touched.`;
    showLibraryToast(message);
    announceImport(message);
    const heading = document.getElementById("local-sources-title");
    if (heading && typeof heading.focus === "function") heading.focus();
    return true;
}

/** Describes each source for the Local Files panel and the Add Music menu. */
function buildFolderSourceSummaries() {
    const summaries = folderSources.map((src) => {
        const status = getFolderSourceStatus(src.id);
        const count = getFolderSourceTracks(src.id).length;
        return {
            id: src.id,
            kind: "linked",
            name: src.name,
            count,
            status,
            modeLabel: "Linked folder · plays from your disk, nothing copied",
            statusLabel:
                status === "granted"
                    ? "Connected"
                    : status === "denied"
                      ? "Access blocked by the browser"
                      : status === "missing"
                        ? "Folder no longer available"
                        : "Needs permission after reload",
        };
    });
    const copied = getImportedLocalTracks().filter((t) => t.storageMode !== "linked");
    if (copied.length) {
        summaries.push({
            id: "copied",
            kind: "copy",
            name: "Added files",
            count: copied.length,
            status: "granted",
            modeLabel: "Copied into this browser's storage",
            statusLabel: "",
        });
    }
    return summaries;
}

function refreshFolderSourcesUi() {
    renderLocalSourcesPanel();
    renderFolderSourceMenuItems();
    updateLocalFilesCount();
}

function renderLocalSourcesPanel() {
    const panel = document.getElementById("local-sources");
    const list = document.getElementById("local-sources-list");
    if (!panel || !list) return;
    const onLocal = activeView === "detail" && activeDetail && activeDetail.type === "local";
    const summaries = buildFolderSourceSummaries();
    panel.hidden = !onLocal || summaries.length === 0;
    if (panel.hidden) return;
    list.innerHTML = summaries
        .map((s) => {
            const name = escapeHtml(s.name);
            const songsLabel = `${s.count} ${s.count === 1 ? "song" : "songs"}`;
            let actions = "";
            if (s.kind === "linked") {
                const primary =
                    s.status === "granted"
                        ? `<button type="button" class="detail-row-btn" data-source-action="rescan" data-source-id="${escapeHtml(s.id)}" aria-label="Rescan ${name} for added or removed songs">Rescan</button>`
                        : s.status === "missing"
                          ? ""
                          : `<button type="button" class="detail-row-btn local-source-reconnect" data-source-action="reconnect" data-source-id="${escapeHtml(s.id)}" aria-label="Reconnect folder ${name}">Reconnect folder</button>`;
                actions = `${primary}<button type="button" class="detail-row-btn danger-btn" data-source-action="forget" data-source-id="${escapeHtml(s.id)}" aria-label="Remove ${name} from your library">Remove</button>`;
            }
            const statusHtml = s.statusLabel
                ? `<span class="local-source-status is-${escapeHtml(s.status)}">${escapeHtml(s.statusLabel)}</span>`
                : "";
            return `<li class="local-source" data-source-id="${escapeHtml(s.id)}" data-source-kind="${s.kind}">
                <span class="local-source-icon" aria-hidden="true">${s.kind === "linked" ? "📁" : "💾"}</span>
                <div class="local-source-text">
                    <span class="local-source-name">${name}</span>
                    <span class="local-source-meta">${escapeHtml(s.modeLabel)} · ${songsLabel}</span>
                    ${statusHtml}
                </div>
                <div class="local-source-actions">${actions}</div>
            </li>`;
        })
        .join("");
}

function focusFolderSourceControl(sourceId, action, fallback) {
    const list = document.getElementById("local-sources-list");
    let target = null;
    if (list && typeof list.querySelector === "function") {
        try {
            target = list.querySelector(`[data-source-id="${sourceId}"][data-source-action="${action}"]`);
        } catch (_) {
            target = null;
        }
    }
    if (target && typeof target.focus === "function" && target.dataset && target.dataset.sourceAction === action) {
        target.focus();
        return target;
    }
    if (fallback && fallback.isConnected !== false && typeof fallback.focus === "function") {
        fallback.focus();
        return fallback;
    }
    return null;
}

function handleSourceAction(action, sourceId, button) {
    if (action === "reconnect") return reconnectFolderSource(sourceId, { returnFocus: button });
    if (action === "rescan") return rescanFolderSource(sourceId, { returnFocus: button });
    if (action === "forget") {
        // Two-step confirm without a blocking window.confirm()
        if (button && button.dataset && button.dataset.confirming === "true") {
            return forgetFolderSource(sourceId);
        }
        if (button && button.dataset) {
            button.dataset.confirming = "true";
            button.textContent = "Click again to remove";
            const source = folderSources.find((src) => src.id === sourceId);
            announceImport(`Press again to remove “${source ? source.name : "this folder"}” and its songs from your library.`);
            if (typeof setTimeout === "function") {
                clearTimeout(forgetConfirmTimers.get(sourceId));
                forgetConfirmTimers.set(
                    sourceId,
                    setTimeout(() => {
                        button.dataset.confirming = "false";
                        button.textContent = "Remove";
                    }, 4000)
                );
            }
        }
        return null;
    }
    return null;
}

/** "Reconnect “X”" / "Rescan “X”" items in the shared Add Music menu, one per linked folder. */
function renderFolderSourceMenuItems() {
    const group = document.getElementById("add-music-source-items");
    if (!group) return;
    const linked = buildFolderSourceSummaries().filter((s) => s.kind === "linked" && s.status !== "missing");
    group.hidden = linked.length === 0;
    group.innerHTML = linked
        .map((s) => {
            const action = s.status === "granted" ? "rescan" : "reconnect";
            const label = action === "rescan" ? `Rescan “${escapeHtml(s.name)}”` : `Reconnect “${escapeHtml(s.name)}”`;
            const icon =
                action === "rescan"
                    ? '<path d="M17.65 6.35A7.96 7.96 0 0 0 12 4a8 8 0 1 0 7.73 10h-2.08A6 6 0 1 1 12 6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"/>'
                    : '<path d="M3.9 12a3.1 3.1 0 0 1 3.1-3.1h4V7H7a5 5 0 0 0 0 10h4v-1.9H7A3.1 3.1 0 0 1 3.9 12zM8 13h8v-2H8v2zm9-6h-4v1.9h4a3.1 3.1 0 0 1 0 6.2h-4V17h4a5 5 0 0 0 0-10z"/>';
            return `<button type="button" class="add-music-item" role="menuitem" tabindex="-1" data-add-music="source-${action}" data-source-id="${escapeHtml(s.id)}"><svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">${icon}</svg><span>${label}</span></button>`;
        })
        .join("");
}

function initFolderSourceControls() {
    const list = document.getElementById("local-sources-list");
    if (list) {
        list.addEventListener("click", (e) => {
            const btn = e.target && typeof e.target.closest === "function" ? e.target.closest("[data-source-action]") : null;
            if (!btn || !btn.dataset) return;
            handleSourceAction(btn.dataset.sourceAction, btn.dataset.sourceId, btn);
        });
    }
    const group = document.getElementById("add-music-source-items");
    if (group) {
        group.addEventListener("click", (e) => {
            const item = e.target && typeof e.target.closest === "function" ? e.target.closest("[data-add-music]") : null;
            if (!item || !item.dataset) return;
            const anchor = addMusicMenuState.anchor;
            closeAddMusicMenu({ returnFocus: true });
            const id = item.dataset.sourceId;
            if (item.dataset.addMusic === "source-reconnect") reconnectFolderSource(id, { returnFocus: anchor });
            else if (item.dataset.addMusic === "source-rescan") rescanFolderSource(id, { returnFocus: anchor });
        });
    }
}

window.SpotTubeShell = {
    initFolderSources,
    importFromFolderHandle,
    reconnectFolderSource,
    rescanFolderSource,
    forgetFolderSource,
    resolveTrackAudioUrl,
    handleUnavailableTrack,
    getQueueCatalog,
    getFolderSources: () => folderSources.slice(),
    getFolderSourceStatus,
    buildFolderSourceSummaries,
    renderLocalSourcesPanel,
    handleSourceAction,
    canPickFolders,
    renderInChunks,
    useDisplayCover,
    openAddMusicMenu,
    closeAddMusicMenu,
    runAddMusicAction,
    cancelActiveImports,
    flushImportUpdates,
    updateImportProgressUi,
    openImportDetailsDialog,
    closeImportDetailsDialog,
    showLibraryToast,
    getActiveImportJobs: () => activeImportJobs.slice(),
    toggleLikeTrackById,
    importLocalAudioFiles,
    importFromDataTransfer,
    openImportPicker,
    removeImportedTrack,
    getImportedLocalTracks,
    getLikedSongsTracks,
    getUserPlaylists,
    createUserPlaylist,
    updateUserPlaylist,
    deleteUserPlaylist,
    addTrackToUserPlaylist,
    removeTrackFromUserPlaylist,
    moveUserPlaylistTrack,
    buildCollectionDetailData,
    openPlaylistDetail,
    openLikedSongsDetail,
    openLocalFilesDetail,
    refreshActiveCollectionView,
    renderUserPlaylistsSidebar,
    openPlaylistPicker,
    closePlaylistPicker,
    createPlaylistFromPicker,
    openPlaylistEditDialog,
    savePlaylistEditDialog,
    initLibraryImportControls,

    getSongs,
    playMusic,
    resolveTrackIndex,
    getFilteredSongs,
    getUpcomingQueueTracks,
    getQueueVibeMetrics,
    getPlayerEngine,
    startRadioMix,
    playTrackNext,
    addTrackToQueue,
    removeTrackFromQueue,
    reorderQueueItems,
    moveQueueItemUp,
    moveQueueItemDown,
    playNextFromQueue,
    playPreviousFromQueue,
    setMoodFilter,
    setMixMode,
    retuneRadioMix,
    setCrossfadeDuration,
    cycleCrossfadeDuration,
    getCrossfadeDuration,
    toggleShortcutsModal,
    togglePlayPause,
    toggleShuffleState,
    toggleRepeatState,
    toggleLikeCurrentTrack,
    seekPlaybackTo,
    seekPlaybackBy,
    handleShellKeyDown,
    toggleRightDrawer,
    switchDrawerTab,
    renderCatalogGrid,
    renderLibrarySidebar,
    renderDrawerNowPlaying,
    renderDrawerQueue,
    renderDrawerTrackInfo,
    renderMixTuningInsight,
    reorderContainerNodes,
    syncActiveTrackUI,
    syncMixTuningChipsUI,
    syncCrossfadeUI,
    buildArtistDetailData,
    buildAlbumDetailData,
    buildSongDetailData,
    openDetailView,
    openArtistDetail,
    openAlbumDetail,
    openSongDetail,
    closeDetailView,
    renderDetailView,
    startDetailMix,
    buildOmniSearchResults,
    searchCatalog,
    renderSearchView,
    openSearchView,
    closeSearchView,
    setSearchQuery,
    setSearchCategory,
    startSearchMix,
    playTopSearchResult,
    buildSupermixData,
    buildDailyMixes,
    buildOnRepeatShelf,
    buildRediscoverShelf,
    buildJumpBackInShelf,
    buildHomeShelvesData,
    renderHomeShelves,
    startSmartMix,
    navigateBack,
    navigateForward,
    getState: () => ({
        songs,
        currentTrackIndex,
        activeMoodFilter,
        activeSearchQuery,
        activeSearchCategory,
        activeSearchResults,
        activeHomeShelvesData,
        activeLibraryFilter,
        activeMixMode,
        isDrawerOpen,
        activeDrawerTab,
        isShuffle,
        isRepeat,
        crossfadeSeconds,
        isShortcutsModalOpen,
        activeView,
        activeDetail,
        navHistory: navHistory.slice(),
        navHistoryIndex,
        likedTrackIds: Array.from(likedTrackIds),
    }),
    setState: (patch = {}) => {
        if (Array.isArray(patch.songs)) songs = patch.songs;
        if (typeof patch.currentTrackIndex === "number") currentTrackIndex = patch.currentTrackIndex;
        if (typeof patch.activeMoodFilter === "string") activeMoodFilter = patch.activeMoodFilter;
        if (typeof patch.activeSearchQuery === "string") activeSearchQuery = patch.activeSearchQuery;
        if (typeof patch.activeSearchCategory === "string") {
            activeSearchCategory = normalizeSearchCategory(patch.activeSearchCategory);
        }
        if (typeof patch.activeLibraryFilter === "string") activeLibraryFilter = patch.activeLibraryFilter;
        if (typeof patch.activeMixMode === "string") activeMixMode = normalizeMixMode(patch.activeMixMode);
        if (typeof patch.isDrawerOpen === "boolean") isDrawerOpen = patch.isDrawerOpen;
        if (typeof patch.activeDrawerTab === "string") activeDrawerTab = patch.activeDrawerTab;
        if (typeof patch.isShuffle === "boolean") isShuffle = patch.isShuffle;
        if (typeof patch.isRepeat === "boolean") isRepeat = patch.isRepeat;
        if (typeof patch.crossfadeSeconds === "number") {
            setCrossfadeDuration(patch.crossfadeSeconds, { silent: true });
        }

        const qm = getQueueManager();
        if (qm && songs.length > 0) {
            if (Array.isArray(patch.songs)) {
                qm.setCatalog(getQueueCatalog(), { rebuildQueue: false, silent: true });
            }
            if (typeof patch.activeMoodFilter === "string") {
                qm.setMoodFilter(activeMoodFilter, { retune: false, silent: true });
            }
            if (typeof patch.currentTrackIndex === "number" || Array.isArray(patch.songs)) {
                const track = songs[currentTrackIndex] || songs[0];
                if (track) {
                    qm.setCurrentTrack(track, {
                        catalog: getQueueCatalog(),
                        regenerateMix: true,
                        recordHistory: false,
                        silent: true,
                    });
                }
            }
            if (typeof patch.activeMixMode === "string") {
                qm.setMixMode(activeMixMode, { silent: true });
            }
        }
    },
};

if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", main);
} else {
    main();
}
