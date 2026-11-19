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

    // 4. Update Right Drawer Now Playing, Up Next Queue, and Track Info panel
    renderDrawerNowPlaying(track);
    renderDrawerQueue();
    renderDrawerTrackInfo(track);
    syncCrossfadeUI();

    // 5. Highlight active track rows/cards if Detail View is currently open
    if (activeView === "detail" && activeDetail) {
        document.querySelectorAll("#detail-view [data-track-id]").forEach((row) => {
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
            catalog: songs,
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
            catalog: songs,
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

    if (!state.catalog || state.catalog.length !== songs.length) {
        qm.setCatalog(songs, { rebuildQueue: false, silent: true });
        qm.setCurrentTrack(activeTrack, {
            catalog: songs,
            regenerateMix: true,
            recordHistory: false,
            silent: true,
        });
    } else if (!state.currentTrack || state.currentTrack.id !== activeTrack.id) {
        qm.setCurrentTrack(activeTrack, {
            catalog: songs,
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
            (track.genre && track.genre.toLowerCase() === activeMoodFilter.toLowerCase());

        if (!matchesMood) return false;

        if (!activeSearchQuery) return true;
        const q = activeSearchQuery.toLowerCase();
        const haystacks = [
            track.title,
            track.artistDisplay,
            track.album,
            track.genre,
            ...(track.moods || []),
            ...(track.subgenres || []),
        ]
            .filter(Boolean)
            .join(" ")
            .toLowerCase();
        return haystacks.includes(q);
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
    const cardNodes = filteredTracks.map((track) => {
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
    });

    songDiv.replaceChildren(...cardNodes);
}

function renderLibrarySidebar() {
    const listContainer = document.getElementById("library-tracks-list");
    if (!listContainer || !songs.length) return;

    const activeTrack = songs[currentTrackIndex];
    const nodes = [];

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
        for (const track of songs) {
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
            nodes.push(btn);
        }
    }

    listContainer.replaceChildren(...nodes);
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

    const nodes = upcoming.map((track, idx) =>
        createQueueItemNode(track, idx, upcoming.length)
    );
    queueList.replaceChildren(...nodes);
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
        current.query === activeSearchQuery
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
    });
    navHistoryIndex = navHistory.length - 1;
}

function restoreNavSnapshot(snap) {
    if (!snap) return null;
    isRestoringHistory = true;
    const searchInput = document.getElementById("search-input");
    const searchClearBtn = document.getElementById("search-clear-btn");
    activeSearchQuery = snap.query || "";
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

function createDetailTrackRowNode(track, idx) {
    const row = document.createElement("div");
    const activeTrack = songs[currentTrackIndex];
    const isPlaying = activeTrack && activeTrack.id === track.id;
    const isLiked = likedTrackIds.has(track.id);
    const artists = getTrackArtistList(track);

    row.className = isPlaying ? "detail-track-row active-track" : "detail-track-row";
    row.setAttribute("role", "listitem");
    row.dataset.trackId = track.id;
    row.dataset.artist = track.primaryArtist;
    row.dataset.album = track.album;

    const artistButtonsHtml = artists
        .map(
            (a) =>
                `<button type="button" class="detail-inline-link" data-open-artist="${a}" title="Open Artist: ${a}">${a}</button>`
        )
        .join("<span>, </span>");

    row.innerHTML = `
        <span class="detail-track-num">${idx + 1}</span>
        <img src="${track.coverUrl}" alt="${track.title}" class="detail-track-cover">
        <div class="detail-track-main">
            <div class="detail-track-title-row">
                <span class="detail-track-title" data-open-song="${track.id}" title="Open Song Detail: ${track.title}">${track.title}</span>
            </div>
            <div class="detail-track-artists">${artistButtonsHtml}</div>
        </div>
        <div class="detail-track-album-col">
            <button type="button" class="detail-inline-link" data-open-album="${track.album}" title="Open Album: ${track.album}">${track.album}</button>
            <span class="detail-track-telemetry">${track.genre || "Music"} &bull; ${track.bpm || 110} BPM &bull; ${Math.round((track.energy ?? 0.65) * 100)}% Energy</span>
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
            <span class="detail-track-duration">${track.durationFormatted || "0:00"}</span>
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
                if (action === "play") {
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

    const mixBtnText =
        detailData.type === "artist"
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
        playAllLabel.textContent =
            detailData.type === "artist"
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
        homeCrumb.textContent = "Catalog";
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
        topTracksTitle.textContent =
            detailData.type === "artist"
                ? `Top Tracks by ${detailData.title}`
                : detailData.type === "album"
                  ? "Album Tracklist"
                  : `Featured Song & More by ${detailData.primaryArtist}`;
    }
    if (topTracksCount) {
        topTracksCount.textContent = `${detailData.topTracks.length} ${detailData.topTracks.length === 1 ? "track" : "tracks"}`;
    }
    if (topTracksContainer) {
        const rowNodes = (detailData.topTracks || []).map((t, i) => createDetailTrackRowNode(t, i));
        topTracksContainer.replaceChildren(...rowNodes);
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
        similarTitle.textContent = "Similar in Your Library";
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
        if (rawType === "album" || (!rawType && spec.album && !spec.artist && !spec.track && !spec.trackId)) {
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
    if (type === "album") {
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
        renderDetailView(detailData);
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
    activeDetail = null;

    if (!options.skipHistory) {
        pushNavState();
    }

    const detailView = document.getElementById("detail-view");
    runMainViewTransition(() => {
        if (detailView) {
            detailView.hidden = true;
            detailView.setAttribute("aria-hidden", "true");
            detailView.setAttribute("inert", "inert");
        }
        setHomeSectionsHidden(false);
    }, "catalog-section-title");

    return true;
}

function startDetailMix(options = {}) {
    if (!activeDetail || !activeDetail.data) {
        return startRadioMix({ type: "supermix" }, options);
    }
    return startRadioMix(activeDetail.data.seedSpec, options);
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

    modal.hidden = !isShortcutsModalOpen;
    if (isShortcutsModalOpen) {
        modal.setAttribute("open", "");
        if (typeof modal.showModal === "function") {
            try {
                if (!modal.open) modal.showModal();
            } catch (_) {}
        }
        syncCrossfadeUI();
    } else {
        if (typeof modal.removeAttribute === "function") {
            modal.removeAttribute("open");
        }
        if (typeof modal.close === "function") {
            try {
                modal.close();
            } catch (_) {}
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

    // 2. Top Search Input & Clear Button
    const searchInput = document.getElementById("search-input");
    const searchClearBtn = document.getElementById("search-clear-btn");
    if (searchInput) {
        searchInput.addEventListener("input", () => {
            activeSearchQuery = searchInput.value.trim();
            if (searchClearBtn) {
                searchClearBtn.hidden = activeSearchQuery.length === 0;
            }
            pushNavState();
            renderCatalogGrid();
        });
    }
    if (searchClearBtn && searchInput) {
        searchClearBtn.addEventListener("click", () => {
            searchInput.value = "";
            activeSearchQuery = "";
            searchClearBtn.hidden = true;
            pushNavState();
            renderCatalogGrid();
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
    if (navSearch && searchInput) {
        navSearch.addEventListener("click", (e) => {
            e.preventDefault();
            searchInput.focus();
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
            if (activeSearchQuery) {
                startRadioMix({
                    type: "search",
                    query: activeSearchQuery,
                    tracks: getFilteredSongs(),
                });
            } else if (activeMoodFilter && activeMoodFilter !== "All") {
                startRadioMix({
                    type: "mood",
                    mood: activeMoodFilter,
                });
            } else {
                startRadioMix({ type: "supermix" });
            }
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
                if (activeSearchQuery) {
                    startRadioMix({
                        type: "search",
                        query: activeSearchQuery,
                        tracks: getFilteredSongs(),
                    });
                } else if (activeMoodFilter && activeMoodFilter !== "All") {
                    startRadioMix({
                        type: "mood",
                        mood: activeMoodFilter,
                    });
                } else {
                    startRadioMix({ type: "supermix" });
                }
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
        qm.setCatalog(songs, { rebuildQueue: true, silent: true });
    }

    renderCatalogGrid();
    renderLibrarySidebar();
    initShellControls();
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

window.SpotTubeShell = {
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
    navigateBack,
    navigateForward,
    getState: () => ({
        songs,
        currentTrackIndex,
        activeMoodFilter,
        activeSearchQuery,
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
                qm.setCatalog(songs, { rebuildQueue: false, silent: true });
            }
            if (typeof patch.activeMoodFilter === "string") {
                qm.setMoodFilter(activeMoodFilter, { retune: false, silent: true });
            }
            if (typeof patch.currentTrackIndex === "number" || Array.isArray(patch.songs)) {
                const track = songs[currentTrackIndex] || songs[0];
                if (track) {
                    qm.setCurrentTrack(track, {
                        catalog: songs,
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
