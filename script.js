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

function getStorage() {
    if (typeof window !== "undefined" && window.SpotTubeStorage) {
        return window.SpotTubeStorage;
    }
    if (typeof globalThis !== "undefined" && globalThis.SpotTubeStorage) {
        return globalThis.SpotTubeStorage;
    }
    return null;
}

function hydrateFromStorage() {
    const store = getStorage();
    if (!store) return;

    likedTrackIds.clear();
    for (const id of store.getLikedTrackIds()) {
        likedTrackIds.add(id);
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
const navHistory = [{ mood: "All", query: "", title: "Spotify Playlists" }];
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
}

const playMusic = (trackOrIndex, pause = false) => {
    if (!songs || songs.length === 0) return;

    const store = getStorage();
    const prevTrack = songs.find((t) => t.id === activePlaybackTrackId);
    const nextIndex = resolveTrackIndex(trackOrIndex);
    const track = songs[nextIndex];
    if (!track) return;

    // Record telemetry outcome (skip or completion) for previous active playback session
    if (
        store &&
        prevTrack &&
        activePlaybackTrackId &&
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

    syncActiveTrackUI();
};

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
        card.innerHTML = `<div class="card-media"><img alt="${track.title}"></div>
                        <div class="play"><button type="button" class="card-play-btn" aria-label="Play ${track.title}"><svg data-encore-id="icon" role="img" aria-hidden="true" viewBox="0 0 24 24" class="Svg-sc-ytk21e-0 bneLcE"><path d="m7.05 3.606 13.49 7.788a.7.7 0 0 1 0 1.212L7.05 20.394A.7.7 0 0 1 6 19.788V4.212a.7.7 0 0 1 1.05-.606z"></path></svg></button>
                        </div>
                        <div class="info">
                            <h4></h4>
                            <p></p>
                        </div>
                        <div class="card-badges">
                            <span class="card-badge-pill">${track.genre || "Pop"}</span>
                            <span>${track.durationFormatted || "0:00"}</span>
                        </div>`;
        card.querySelector("img").src = track.coverUrl;
        card.querySelector("h4").textContent = track.title;
        card.querySelector("p").textContent = track.artistDisplay;

        card.querySelector("button").addEventListener("click", (e) => {
            e.stopPropagation();
            playMusic(fullIdx, false);
        });
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
            if (!seenArtists.has(track.primaryArtist)) {
                seenArtists.set(track.primaryArtist, track);
            }
        }
        for (const [artistName, sampleTrack] of seenArtists.entries()) {
            const btn = document.createElement("button");
            btn.type = "button";
            btn.className = "library-item";
            btn.innerHTML = `
                <div class="lib-item-art"><img src="${sampleTrack.coverUrl}" alt="${artistName}"></div>
                <div class="lib-item-meta">
                    <span class="lib-item-title">${artistName}</span>
                    <span class="lib-item-sub">Artist &bull; ${sampleTrack.genre || "Music"}</span>
                </div>`;
            btn.addEventListener("click", () => {
                playMusic(sampleTrack.id, false);
            });
            nodes.push(btn);
        }
    } else if (activeLibraryFilter === "albums") {
        for (const track of songs) {
            const btn = document.createElement("button");
            btn.type = "button";
            btn.className = "library-item";
            btn.innerHTML = `
                <div class="lib-item-art"><img src="${track.coverUrl}" alt="${track.album}"></div>
                <div class="lib-item-meta">
                    <span class="lib-item-title">${track.album}</span>
                    <span class="lib-item-sub">Album &bull; ${track.primaryArtist} (${track.year || 2024})</span>
                </div>`;
            btn.addEventListener("click", () => {
                playMusic(track.id, false);
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
            btn.innerHTML = `
                <div class="lib-item-art"><img src="${match.coverUrl}" alt="${mood} Mix"></div>
                <div class="lib-item-meta">
                    <span class="lib-item-title">${mood} Radio Mix</span>
                    <span class="lib-item-sub">Auto-Mix &bull; YT Music Vibe</span>
                </div>`;
            btn.addEventListener("click", () => {
                setMoodFilter(mood);
                playMusic(match.id, false);
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
                </div>`;
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
    if (!container || !track) return;

    if (bpmBadge) {
        bpmBadge.textContent = track.bpm ? `${track.bpm} BPM` : track.genre || "Pop";
    }
    if (seedLabel) {
        seedLabel.textContent = `${track.title} • ${track.primaryArtist}`;
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

function getUpcomingQueueTracks() {
    if (!songs.length) return [];
    const ordered = [];
    for (let offset = 1; offset < songs.length; offset++) {
        ordered.push(songs[(currentTrackIndex + offset) % songs.length]);
    }

    // Apply YT Music Dynamic Mix Tuning mode filter/sort preview
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

function renderDrawerQueue() {
    const queueList = document.getElementById("queue-list");
    const queueSummary = document.getElementById("drawer-queue-summary");
    const queueBadge = document.getElementById("queue-count-badge");
    if (!queueList) return;

    const upcoming = getUpcomingQueueTracks();
    if (queueSummary) {
        queueSummary.textContent = `${upcoming.length} upcoming`;
    }
    if (queueBadge) {
        queueBadge.textContent = String(upcoming.length);
    }

    const nodes = upcoming.map((track) => {
        const item = document.createElement("div");
        item.className = "queue-item";
        item.setAttribute("role", "listitem");
        item.dataset.trackId = track.id;
        item.innerHTML = `
            <img src="${track.coverUrl}" alt="${track.title}" class="queue-item-cover">
            <div class="queue-item-meta">
                <span class="queue-item-title">${track.title}</span>
                <span class="queue-item-artist">${track.artistDisplay}</span>
            </div>
            <span class="queue-item-duration">${track.durationFormatted || "0:00"}</span>
        `;
        item.addEventListener("click", () => {
            playMusic(track.id, false);
        });
        return item;
    });

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
    if (current && current.mood === activeMoodFilter && current.query === activeSearchQuery) {
        return;
    }
    navHistory.splice(navHistoryIndex + 1);
    navHistory.push({
        mood: activeMoodFilter,
        query: activeSearchQuery,
    });
    navHistoryIndex = navHistory.length - 1;
}

function setMoodFilter(mood) {
    activeMoodFilter = mood || "All";
    document.querySelectorAll("#mood-chips-bar .mood-chip").forEach((chip) => {
        chip.classList.toggle("active", chip.dataset.mood === activeMoodFilter);
    });
    pushNavState();
    renderCatalogGrid();
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
            if (navHistoryIndex > 0) {
                isRestoringHistory = true;
                navHistoryIndex--;
                const snap = navHistory[navHistoryIndex];
                activeSearchQuery = snap.query;
                if (searchInput) searchInput.value = snap.query;
                if (searchClearBtn) searchClearBtn.hidden = !snap.query;
                setMoodFilter(snap.mood);
                isRestoringHistory = false;
            }
        });
    }
    if (navForward) {
        navForward.addEventListener("click", () => {
            if (navHistoryIndex < navHistory.length - 1) {
                isRestoringHistory = true;
                navHistoryIndex++;
                const snap = navHistory[navHistoryIndex];
                activeSearchQuery = snap.query;
                if (searchInput) searchInput.value = snap.query;
                if (searchClearBtn) searchClearBtn.hidden = !snap.query;
                setMoodFilter(snap.mood);
                isRestoringHistory = false;
            }
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
    if (navHome) {
        navHome.addEventListener("click", (e) => {
            e.preventDefault();
            if (searchInput) searchInput.value = "";
            activeSearchQuery = "";
            if (searchClearBtn) searchClearBtn.hidden = true;
            setMoodFilter("All");
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
            toggleRightDrawer(true);
            switchDrawerTab("up-next");
            playMusic(currentTrackIndex, false);
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
    document.querySelectorAll("#mix-tuning-chips .tuning-chip").forEach((chip) => {
        chip.addEventListener("click", () => {
            activeMixMode = chip.dataset.mixMode || "all";
            document.querySelectorAll("#mix-tuning-chips .tuning-chip").forEach((c) => {
                c.classList.toggle("active", c === chip);
            });
            renderDrawerQueue();
        });
    });

    // 8. Hero & Navbar Start Mix Buttons
    const startMixTriggers = [
        "hero-start-mix-btn",
        "header-start-mix-btn",
        "search-mix-btn",
        "playbar-mix-btn",
        "info-start-mix-btn",
        "lib-supermix",
    ];
    for (const id of startMixTriggers) {
        const el = document.getElementById(id);
        if (el) {
            el.addEventListener("click", () => {
                const filtered = getFilteredSongs();
                const targetTrack = filtered.length > 0 ? filtered[0] : songs[currentTrackIndex];
                toggleRightDrawer(true);
                switchDrawerTab("up-next");
                if (targetTrack) {
                    playMusic(targetTrack.id, false);
                }
            });
        }
    }

    const heroShuffleBtn = document.getElementById("hero-shuffle-all-btn");
    if (heroShuffleBtn) {
        heroShuffleBtn.addEventListener("click", () => {
            if (!songs.length) return;
            const randomIdx = Math.floor(Math.random() * songs.length);
            playMusic(randomIdx, false);
        });
    }

    // 9. Like / Heart Button in Playbar
    const likeBtn = document.getElementById("like-btn");
    if (likeBtn) {
        likeBtn.addEventListener("click", () => {
            const track = songs[currentTrackIndex];
            if (!track) return;
            const store = getStorage();
            if (store) {
                const nowLiked = store.toggleLike(track.id);
                if (nowLiked) likedTrackIds.add(track.id);
                else likedTrackIds.delete(track.id);
            } else if (likedTrackIds.has(track.id)) {
                likedTrackIds.delete(track.id);
            } else {
                likedTrackIds.add(track.id);
            }
            const likedCountEl = document.getElementById("lib-liked-count");
            if (likedCountEl) {
                likedCountEl.textContent =
                    likedTrackIds.size > 0
                        ? `Auto-playlist • ${likedTrackIds.size} liked`
                        : "Auto-playlist • Pin";
            }
            syncActiveTrackUI();
        });
    }
}

async function main() {
    hydrateFromStorage();
    songs = await getSongs();
    const songDiv = document.querySelector(".spotify-playlist");
    if (!songs.length || !songDiv) return;

    const store = getStorage();
    if (store && typeof store.attachAudioAnalyzer === "function") {
        store.attachAudioAnalyzer(currentSong, {
            getActiveTrackId: () => songs[currentTrackIndex]?.id || null,
        });
    }

    renderCatalogGrid();
    renderLibrarySidebar();
    initShellControls();
    playMusic(0, true);

    const playBtn = document.getElementById("play");
    playBtn.addEventListener("click", () => {
        const activeTrack = songs[currentTrackIndex];
        if (currentSong.paused) {
            if (activeTrack) {
                activePlaybackTrackId = activeTrack.id;
                if (store) store.recordPlayStart(activeTrack.id);
            }
            currentSong.play();
            updatePlayButtonIcon(false);
        } else {
            currentSong.pause();
            updatePlayButtonIcon(true);
        }
    });

    let isRepeat = false;
    const repeat = document.getElementById("repeat");
    repeat.addEventListener("click", () => {
        isRepeat = !isRepeat;
        repeat.classList.toggle("active", isRepeat);
        repeat.getElementsByTagName("svg")[0].style.fill = isRepeat ? "#1db954" : "#b3b3b3";
    });

    let isShuffle = false;
    const shuffle = document.getElementById("shuffle");
    shuffle.addEventListener("click", () => {
        isShuffle = !isShuffle;
        shuffle.classList.toggle("active", isShuffle);
        shuffle.getElementsByTagName("svg")[0].style.fill = isShuffle ? "#1db954" : "#b3b3b3";
    });

    currentSong.addEventListener("timeupdate", () => {
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
        document.getElementsByClassName("total-time")[0].textContent = secondsToMinutesSeconds(totalDuration);
        if (totalDuration > 0) {
            document.getElementsByClassName("progress")[0].style.width =
                (currentSong.currentTime / totalDuration) * 100 + "%";
        }
    });

    function getRandomIndex(min, max, excludedNumber) {
        if (max <= min) return min;
        let randomNum;
        do {
            randomNum = Math.floor(Math.random() * (max - min + 1)) + min;
        } while (randomNum === excludedNumber);
        return randomNum;
    }

    currentSong.addEventListener("ended", () => {
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
            currentSong.play();
        } else if (isShuffle) {
            const nextIndex = getRandomIndex(0, songs.length - 1, currentTrackIndex);
            playMusic(nextIndex, false);
        } else {
            const nextIndex = (currentTrackIndex + 1) % songs.length;
            playMusic(nextIndex, false);
        }
    });

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
                currentSong.currentTime = (currentSong.duration * percent) / 100;
            }
        }
        isDraggingProgress = false;
    });

    progressBar.addEventListener("click", (e) => {
        const percent = (e.offsetX / progressBar.offsetWidth) * 100;
        progressBar.style.setProperty("--progress-width", percent + "%");
        if (Number.isFinite(currentSong.duration)) {
            currentSong.currentTime = (currentSong.duration * percent) / 100;
        }
    });

    progressHandle.addEventListener("mousedown", () => {
        isDraggingProgress = true;
    });

    document.getElementById("previous").addEventListener("click", () => {
        const previousIndex = (currentTrackIndex - 1 + songs.length) % songs.length;
        playMusic(previousIndex, currentSong.paused);
    });

    document.getElementById("next").addEventListener("click", () => {
        const nextIndex = (currentTrackIndex + 1) % songs.length;
        playMusic(nextIndex, currentSong.paused);
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
            currentSong.volume = percent / 100;
        }
    });

    document.addEventListener("mouseup", () => {
        isDragging = false;
    });

    const muteButton = document.querySelector(".mute");
    let lastVolume = currentSong.volume;

    volumeBar.addEventListener("click", (e) => {
        const percent = (e.offsetX / volumeBar.offsetWidth) * 100;
        volumeBar.style.setProperty("--volume-width", percent + "%");
        currentSong.volume = Math.max(0, Math.min(percent / 100, 1));
        currentSong.muted = currentSong.volume === 0;

        if (!currentSong.muted) {
            lastVolume = currentSong.volume;
        }
    });

    muteButton.addEventListener("click", () => {
        if (currentSong.muted) {
            currentSong.muted = false;
            currentSong.volume = lastVolume;
            volumeBar.style.setProperty("--volume-width", lastVolume * 100 + "%");
            document.getElementById("volume-btn").innerHTML = `
                <svg data-encore-id="unmute" role="presentation" aria-label="Volume high" aria-hidden="true" id="volume-icon" viewBox="0 0 16 16" class="Svg-sc-ytk21e-0 kcUFwU">
                    <path d="M9.741.85a.75.75 0 0 1 .375.65v13a.75.75 0 0 1-1.125.65l-6.925-4a3.642 3.642 0 0 1-1.33-4.967 3.639 3.639 0 0 1 1.33-1.332l6.925-4a.75.75 0 0 1 .75 0zm-6.924 5.3a2.139 2.139 0 0 0 0 3.7l5.8 3.35V2.8l-5.8 3.35zm8.683 4.29V5.56a2.75 2.75 0 0 1 0 4.88z"></path>
                    <path d="M11.5 13.614a5.752 5.752 0 0 0 0-11.228v1.55a4.252 4.252 0 0 1 0 8.127v1.55z"></path>
                </svg>`;
        } else {
            lastVolume = currentSong.volume;
            currentSong.muted = true;
            currentSong.volume = 0;
            volumeBar.style.setProperty("--volume-width", "0%");
            document.getElementById("volume-btn").innerHTML = `
                <svg data-encore-id="mute" role="presentation" aria-label="Volume off" aria-hidden="true" id="volume-icon" viewBox="0 0 16 16" class="Svg-sc-ytk21e-0 kcUFwU">
                    <path d="M13.86 5.47a.75.75 0 0 0-1.061 0l-1.47 1.47-1.47-1.47A.75.75 0 0 0 8.8 6.53L10.269 8l-1.47 1.47a.75.75 0 1 0 1.06 1.06l1.47-1.47 1.47 1.47a.75.75 0 0 0 1.06-1.06L12.39 8l1.47-1.47a.75.75 0 0 0 0-1.06z"></path>
                    <path d="M10.116 1.5A.75.75 0 0 0 8.991.85l-6.925 4a3.642 3.642 0 0 0-1.33 4.967 3.639 3.639 0 0 0 1.33 1.332l6.925 4a.75.75 0 0 0 1.125-.649v-1.906a4.73 4.73 0 0 1-1.5-.694v1.3L2.817 9.852a2.141 2.141 0 0 1-.781-2.92c.187-.324.456-.594.78-.782l5.8-3.35v1.3c.45-.313.956-.55 1.5-.694V1.5z"></path>
                </svg>`;
        }
    });
}

window.SpotTubeShell = {
    getSongs,
    playMusic,
    resolveTrackIndex,
    getFilteredSongs,
    getUpcomingQueueTracks,
    setMoodFilter,
    toggleRightDrawer,
    switchDrawerTab,
    renderCatalogGrid,
    renderLibrarySidebar,
    renderDrawerNowPlaying,
    renderDrawerQueue,
    renderDrawerTrackInfo,
    syncActiveTrackUI,
    getState: () => ({
        songs,
        currentTrackIndex,
        activeMoodFilter,
        activeSearchQuery,
        activeLibraryFilter,
        activeMixMode,
        isDrawerOpen,
        activeDrawerTab,
        likedTrackIds: Array.from(likedTrackIds),
    }),
    setState: (patch = {}) => {
        if (Array.isArray(patch.songs)) songs = patch.songs;
        if (typeof patch.currentTrackIndex === "number") currentTrackIndex = patch.currentTrackIndex;
        if (typeof patch.activeMoodFilter === "string") activeMoodFilter = patch.activeMoodFilter;
        if (typeof patch.activeSearchQuery === "string") activeSearchQuery = patch.activeSearchQuery;
        if (typeof patch.activeLibraryFilter === "string") activeLibraryFilter = patch.activeLibraryFilter;
        if (typeof patch.activeMixMode === "string") activeMixMode = patch.activeMixMode;
        if (typeof patch.isDrawerOpen === "boolean") isDrawerOpen = patch.isDrawerOpen;
        if (typeof patch.activeDrawerTab === "string") activeDrawerTab = patch.activeDrawerTab;
    },
};

if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", main);
} else {
    main();
}
