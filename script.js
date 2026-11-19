let currentSong = new Audio();
let songs = [];
let currentTrackIndex = 0;

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
    try {
        const res = await fetch("./tracks.json");
        if (res.ok) {
            const manifest = await res.json();
            const tracks = Array.isArray(manifest) ? manifest : (manifest.tracks || []);
            window.TRACK_CATALOG = manifest;
            if (tracks.length > 0) {
                return tracks;
            }
        }
    } catch (err) {
        console.warn("Static tracks.json fetch failed, attempting relative /songs/ fallback:", err);
    }

    // Fallback for unindexed local directory listing using relative path
    const res = await fetch("./songs/");
    const html = await res.text();
    const div = document.createElement("div");
    div.innerHTML = html;
    const anchors = div.getElementsByTagName("a");
    const fallbackTracks = [];

    for (let i = 0; i < anchors.length; i++) {
        const href = anchors[i].getAttribute("href") || "";
        if (href.toLowerCase().endsWith(".mp3")) {
            const rawFile = decodeURIComponent(href.split("/").pop());
            const [rawTitle, rawArtistPart = "Unknown Artist"] = rawFile.replace(/\.mp3$/i, "").split("-");
            const title = rawTitle.trim();
            const artistDisplay = rawArtistPart.trim();
            fallbackTracks.push({
                id: `${title}-${artistDisplay}`.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
                filename: rawFile,
                title,
                primaryArtist: artistDisplay.split(",")[0].trim(),
                artists: artistDisplay.split(",").map((s) => s.trim()),
                artistDisplay,
                album: `${title} (Single)`,
                duration: 0,
                durationFormatted: "0:00",
                audioUrl: `songs/${encodeURIComponent(rawFile)}`,
                coverUrl: `Images/${encodeURIComponent(title)}.jpeg`,
                genre: "Pop",
                moods: ["Chill"],
            });
        }
    }
    return fallbackTracks;
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

const playMusic = (trackOrIndex, pause = false) => {
    if (!songs || songs.length === 0) return;
    currentTrackIndex = resolveTrackIndex(trackOrIndex);
    const track = songs[currentTrackIndex];
    if (!track) return;

    currentSong.src = track.audioUrl;
    if (!pause) {
        currentSong.play();
        document.getElementById("play").innerHTML = `<svg data-encore-id="icon" role="play" aria-hidden="true" viewBox="0 0 16 16" class="Svg-sc-ytk21e-0 dYnaPI"><path d="M2.7 1a.7.7 0 0 0-.7.7v12.6a.7.7 0 0 0 .7.7h2.6a.7.7 0 0 0 .7-.7V1.7a.7.7 0 0 0-.7-.7H2.7zm8 0a.7.7 0 0 0-.7.7v12.6a.7.7 0 0 0 .7.7h2.6a.7.7 0 0 0 .7-.7V1.7a.7.7 0 0 0-.7-.7h-2.6z"></path></svg>`;
    }
    document.getElementsByClassName("song-title")[0].textContent = track.title;
    document.getElementsByClassName("artist-names")[0].textContent = track.artistDisplay;
    document.getElementsByClassName("album-cover")[0].src = track.coverUrl;
    document.getElementsByClassName("current-time")[0].textContent = "0:00";
    document.getElementsByClassName("total-time")[0].textContent = track.durationFormatted || "0:00";
};

async function main() {
    songs = await getSongs();
    const songDiv = document.querySelector(".spotify-playlist");
    if (!songs.length || !songDiv) return;

    playMusic(0, true);

    const cardNodes = songs.map((track, idx) => {
        const card = document.createElement("div");
        card.classList.add("card");
        card.dataset.trackId = track.id;
        card.dataset.trackIndex = String(idx);
        card.innerHTML = `<img alt="${track.title}">
                        <div class="play"><button class="card-play-btn" aria-label="Play ${track.title}"><svg data-encore-id="icon" role="img" aria-hidden="true" viewBox="0 0 24 24" class="Svg-sc-ytk21e-0 bneLcE"><path d="m7.05 3.606 13.49 7.788a.7.7 0 0 1 0 1.212L7.05 20.394A.7.7 0 0 1 6 19.788V4.212a.7.7 0 0 1 1.05-.606z"></path></svg></button>
                        </div>
                        <div class="info">
                        <h4></h4>
                        <p></p>
                        </div>`;
        card.querySelector("img").src = track.coverUrl;
        card.querySelector("h4").textContent = track.title;
        card.querySelector("p").textContent = track.artistDisplay;
        card.querySelector("button").addEventListener("click", () => {
            playMusic(idx, false);
        });
        return card;
    });

    songDiv.replaceChildren(...cardNodes);

    const playBtn = document.getElementById("play");
    playBtn.addEventListener("click", () => {
        if (currentSong.paused) {
            currentSong.play();
            playBtn.innerHTML = `<svg data-encore-id="icon" role="play" aria-hidden="true" viewBox="0 0 16 16" class="Svg-sc-ytk21e-0 dYnaPI"><path d="M2.7 1a.7.7 0 0 0-.7.7v12.6a.7.7 0 0 0 .7.7h2.6a.7.7 0 0 0 .7-.7V1.7a.7.7 0 0 0-.7-.7H2.7zm8 0a.7.7 0 0 0-.7.7v12.6a.7.7 0 0 0 .7.7h2.6a.7.7 0 0 0 .7-.7V1.7a.7.7 0 0 0-.7-.7h-2.6z"></path></svg>`;
        } else {
            currentSong.pause();
            playBtn.innerHTML = `<svg data-encore-id="pause" role="img" aria-hidden="true" viewBox="0 0 16 16" class="Svg-sc-ytk21e-0 dYnaPI"><path d="M3 1.713a.7.7 0 0 1 1.05-.607l10.89 6.288a.7.7 0 0 1 0 1.212L4.05 14.894A.7.7 0 0 1 3 14.288V1.713z"></path></svg>`;
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
        const totalDuration = Number.isFinite(currentSong.duration) && currentSong.duration > 0
            ? currentSong.duration
            : (activeTrack ? activeTrack.duration : 0);
        document.getElementsByClassName("current-time")[0].textContent = secondsToMinutesSeconds(currentSong.currentTime);
        document.getElementsByClassName("total-time")[0].textContent = secondsToMinutesSeconds(totalDuration);
        if (totalDuration > 0) {
            document.getElementsByClassName("progress")[0].style.width = (currentSong.currentTime / totalDuration) * 100 + "%";
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
        if (isRepeat) {
            currentSong.currentTime = 0;
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

if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", main);
} else {
    main();
}
