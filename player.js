/**
 * SpotTube Hybrid Player — Continuous Nonstop Playback & Gapless/Crossfade Audio Engine (`player.js`)
 *
 * Implements:
 * 1. Dual-Deck HTML5 Audio + Web Audio API Crossfader (`deckA` & `deckB`):
 *    - Equal-power cosine/sine crossfade curve configurable from 0 to 12 seconds (`0–12s`).
 *    - Web Audio API `GainNode` per deck + shared `AnalyserNode` when `AudioContext` is available,
 *      with automatic HTML5 `HTMLAudioElement.volume` crossfade fallback.
 *    - Gapless standby deck preloading (`preloadNextTrack`) so the upcoming track in the queue
 *      is buffered before the transition window begins.
 * 2. Automatic Endless Queue Replenishment:
 *    - Monitors `SpotTubeQueue` before, during, and after transitions and replenishes whenever
 *      fewer than `minQueueSize` (3) tracks remain.
 * 3. Keyboard Shortcuts Controller (`handleKeyDown`, `bindKeyboardShortcuts`):
 *    - Space / K (Play/Pause), N / Shift+Right (Next), P / Shift+Left (Previous),
 *      Left/Right or J/L (Seek -/+5s), Up/Down (Volume +/-5%), M (Mute), Q (Toggle Up Next Drawer),
 *      S (Shuffle), R (Repeat), F (Like), X (Cycle Crossfade 0–12s), / (Focus Search), ? (Shortcuts Modal).
 * 4. MediaSession API Integration (`syncMediaSession`, `registerMediaSessionHandlers`):
 *    - Hardware media key & OS lockscreen metadata (`title`, `artist`, `album`, `artwork`),
 *      `playbackState`, `setPositionState`, and action handlers (`play`, `pause`, `previoustrack`,
 *      `nexttrack`, `seekbackward`, `seekforward`, `seekto`, `stop`).
 *
 * Works in both Browser (`window.SpotTubePlayer`) and Node.js CommonJS (`module.exports`).
 */
(function (root, factory) {
    if (typeof module === "object" && module.exports) {
        module.exports = factory(root);
    } else {
        root.SpotTubePlayer = factory(root);
    }
})(typeof globalThis !== "undefined" ? globalThis : typeof window !== "undefined" ? window : this, function (globalScope) {
    const MIN_CROSSFADE_SECONDS = 0;
    const MAX_CROSSFADE_SECONDS = 12;
    const CROSSFADE_PRESETS = [0, 2, 4, 6, 8, 12];
    const DEFAULT_MIN_QUEUE_SIZE = 3;

    function clamp(value, min, max) {
        if (!Number.isFinite(value)) return min;
        return Math.max(min, Math.min(max, value));
    }

    function roundTo(value, decimals = 4) {
        const factor = Math.pow(10, decimals);
        return Math.round((Number(value) || 0) * factor) / factor;
    }

    /**
     * Equal-power crossfade gain curve for progress `p` in `[0, 1]`.
     * At p = 0: outgoing = 1, incoming = 0.
     * At p = 0.5: outgoing = ~0.7071, incoming = ~0.7071 (constant perceptual power).
     * At p = 1: outgoing = 0, incoming = 1.
     */
    function computeCrossfadeGains(progress) {
        const p = clamp(Number(progress) || 0, 0, 1);
        const angle = p * Math.PI * 0.5;
        return {
            progress: roundTo(p),
            outgoingGain: roundTo(Math.cos(angle)),
            incomingGain: roundTo(Math.sin(angle)),
        };
    }

    function isEditableTarget(target) {
        if (!target || typeof target !== "object") return false;
        const tag = String(target.tagName || "").toUpperCase();
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") {
            // Allow range sliders (like crossfade slider) unless it's a text/search input
            const inputType = String(target.type || "").toLowerCase();
            if (tag === "INPUT" && inputType === "range") {
                return false;
            }
            return true;
        }
        if (target.isContentEditable || target.contentEditable === "true") {
            return true;
        }
        return false;
    }

    /**
     * Creates a Dual-Deck Gapless / Crossfade Player Engine instance.
     */
    function createPlayerEngine(options = {}) {
        const storage =
            options.storage !== undefined
                ? options.storage
                : globalScope && globalScope.SpotTubeStorage
                  ? globalScope.SpotTubeStorage
                  : null;
        const queueManager =
            options.queueManager !== undefined
                ? options.queueManager
                : globalScope && globalScope.SpotTubeQueue
                  ? globalScope.SpotTubeQueue
                  : null;

        const createAudioElement = () => {
            if (typeof options.createAudio === "function") {
                return options.createAudio();
            }
            if (globalScope && typeof globalScope.Audio === "function") {
                return new globalScope.Audio();
            }
            // Minimal fallback audio object for headless environments without Audio constructor
            return {
                src: "",
                currentTime: 0,
                duration: 0,
                volume: 1,
                muted: false,
                paused: true,
                preload: "auto",
                dataset: {},
                play() {
                    this.paused = false;
                    return Promise.resolve();
                },
                pause() {
                    this.paused = true;
                },
                addEventListener() {},
                removeEventListener() {},
            };
        };

        // Deck A & Deck B
        const deckA = options.primaryAudio || createAudioElement();
        const deckB = options.secondaryAudio || createAudioElement();
        deckA.preload = "auto";
        deckB.preload = "auto";

        let activeDeckKey = "A"; // "A" or "B"
        let activeTrack = null;
        let preloadedTrack = null;
        let masterVolume = clamp(Number(options.volume ?? 1), 0, 1);
        let isMuted = Boolean(options.muted ?? false);
        let lastUnmutedVolume = masterVolume > 0 ? masterVolume : 1;
        let isShuffle = Boolean(options.shuffle ?? false);
        let isRepeat = Boolean(options.repeat ?? false);
        let minQueueSize = Number.isFinite(options.minQueueSize)
            ? Math.max(1, options.minQueueSize)
            : DEFAULT_MIN_QUEUE_SIZE;

        // Hydrate crossfade duration preference (0–12s) from storage if available
        const savedCrossfade =
            storage && typeof storage.getPreferences === "function"
                ? storage.getPreferences()?.crossfadeSeconds
                : undefined;
        let crossfadeSeconds = clamp(
            Number(
                options.crossfadeSeconds !== undefined
                    ? options.crossfadeSeconds
                    : savedCrossfade !== undefined
                      ? savedCrossfade
                      : 0
            ),
            MIN_CROSSFADE_SECONDS,
            MAX_CROSSFADE_SECONDS
        );

        // Crossfade state machine
        let crossfadeState = {
            active: false,
            fromDeckKey: null,
            toDeckKey: null,
            fromTrack: null,
            toTrack: null,
            startedAt: 0,
            durationSeconds: 0,
            progress: 0,
            timerId: null,
        };

        // Web Audio API dual-deck graph state
        let audioCtx = null;
        let gainNodeA = null;
        let gainNodeB = null;
        let analyserNode = null;
        let webAudioInitialized = false;
        let webAudioSupported = false;

        const listeners = new Set();

        function emit(eventType, detail = {}) {
            const state = getState();
            for (const fn of listeners) {
                try {
                    fn(state, { type: eventType, ...detail });
                } catch (_) {
                    // Ignore listener errors
                }
            }
        }

        function getActiveDeck() {
            return activeDeckKey === "A" ? deckA : deckB;
        }

        function getStandbyDeck() {
            return activeDeckKey === "A" ? deckB : deckA;
        }

        function getDeckGainNode(deckKey) {
            return deckKey === "A" ? gainNodeA : gainNodeB;
        }

        function initWebAudioGraph() {
            if (webAudioInitialized) return webAudioSupported;
            webAudioInitialized = true;

            const AudioCtx =
                options.AudioContext ||
                (globalScope && (globalScope.AudioContext || globalScope.webkitAudioContext));
            if (!AudioCtx) {
                webAudioSupported = false;
                return false;
            }

            try {
                audioCtx = new AudioCtx();
                gainNodeA = audioCtx.createGain();
                gainNodeB = audioCtx.createGain();
                analyserNode = audioCtx.createAnalyser();
                analyserNode.fftSize = 512;
                analyserNode.smoothingTimeConstant = 0.8;

                const sourceA = audioCtx.createMediaElementSource(deckA);
                const sourceB = audioCtx.createMediaElementSource(deckB);

                sourceA.connect(gainNodeA);
                sourceB.connect(gainNodeB);
                gainNodeA.connect(analyserNode);
                gainNodeB.connect(analyserNode);
                analyserNode.connect(audioCtx.destination);

                webAudioSupported = true;
                return true;
            } catch (_) {
                // If MediaElementSource was already bound (e.g. by storage.attachAudioAnalyzer),
                // fall back cleanly to HTML5 Audio element volume crossfading.
                webAudioSupported = false;
                return false;
            }
        }

        function applyDeckGain(deckKey, gainMultiplier = 1) {
            const deck = deckKey === "A" ? deckA : deckB;
            const clampedGain = clamp(gainMultiplier, 0, 1);
            const effectiveVolume = isMuted ? 0 : roundTo(clamp(masterVolume * clampedGain, 0, 1));

            deck.muted = isMuted;
            deck.volume = effectiveVolume;

            if (webAudioSupported) {
                const gainNode = getDeckGainNode(deckKey);
                if (gainNode && gainNode.gain) {
                    gainNode.gain.value = effectiveVolume;
                }
            }
        }

        /**
         * Ensures the queue manager always has at least `minQueueSize` (3) upcoming tracks
         * for endless nonstop playback.
         */
        function ensureEndlessQueue() {
            const qm =
                typeof options.getQueueManager === "function"
                    ? options.getQueueManager()
                    : queueManager;
            if (!qm || typeof qm.getQueue !== "function" || typeof qm.replenishQueue !== "function") {
                return [];
            }

            const currentQueue = qm.getQueue();
            if (currentQueue.length < minQueueSize) {
                qm.replenishQueue({ silent: false });
            }
            const refreshed = qm.getUpcomingTracks ? qm.getUpcomingTracks() : qm.getQueue();

            // Gaplessly preload the very next track on the standby deck when not actively crossfading
            if (!crossfadeState.active && refreshed.length > 0) {
                const nextCandidate = refreshed[0].track || refreshed[0];
                preloadNextTrack(nextCandidate);
            }
            return refreshed;
        }

        /**
         * Preloads the next upcoming track onto the inactive standby deck for gapless or crossfaded start.
         */
        // ==================== ITEM 14: ON-DEMAND URLS FOR NO-COPY LINKED TRACKS ====================
        // A track linked to a picked folder has no audioUrl until it is played. `options.resolveTrackUrl(track, ctx)`
        // returns (a promise of) a blob: URL or null; the action then runs with the URL filled in.
        const pendingResolves = new Map();

        function needsResolvedUrl(track) {
            return Boolean(track && !track.audioUrl && typeof options.resolveTrackUrl === "function");
        }

        function resolveTrackUrlThen(track, run, ctx = {}) {
            const key = `${track.id}|${ctx.reason || "play"}`;
            if (pendingResolves.has(key)) return pendingResolves.get(key);
            const pending = Promise.resolve()
                .then(() => options.resolveTrackUrl(track, ctx))
                .catch(() => null)
                .then((url) => {
                    pendingResolves.delete(key);
                    if (url) {
                        track.audioUrl = url;
                        return run();
                    }
                    if (!ctx.silent) {
                        emit("track-unavailable", { track, reason: ctx.reason || "play" });
                        if (typeof options.onTrackUnavailable === "function") {
                            try {
                                options.onTrackUnavailable(track, ctx);
                            } catch (_) {}
                        }
                    }
                    return null;
                });
            pendingResolves.set(key, pending);
            return pending;
        }

        function preloadNextTrack(nextTrack) {
            if (needsResolvedUrl(nextTrack)) {
                resolveTrackUrlThen(nextTrack, () => preloadNextTrack(nextTrack), { reason: "preload", silent: true });
                return null;
            }
            if (!nextTrack || !nextTrack.audioUrl) return null;
            if (crossfadeState.active) return preloadedTrack;

            const standby = getStandbyDeck();
            if (standby.src !== nextTrack.audioUrl) {
                standby.src = nextTrack.audioUrl;
                standby.currentTime = 0;
                if (standby.dataset) {
                    standby.dataset.trackId = nextTrack.id || "";
                }
                if (typeof standby.load === "function") {
                    try {
                        standby.load();
                    } catch (_) {}
                }
            }
            preloadedTrack = nextTrack;
            emit("preload-next", { track: nextTrack, standbyDeck: activeDeckKey === "A" ? "B" : "A" });
            return nextTrack;
        }

        function cancelActiveCrossfade(resetOutgoing = true) {
            if (crossfadeState.timerId && typeof clearInterval === "function") {
                clearInterval(crossfadeState.timerId);
            }
            if (crossfadeState.active && resetOutgoing && crossfadeState.fromDeckKey) {
                const outgoingDeck = crossfadeState.fromDeckKey === "A" ? deckA : deckB;
                try {
                    outgoingDeck.pause();
                    outgoingDeck.currentTime = 0;
                } catch (_) {}
                applyDeckGain(crossfadeState.fromDeckKey, 0);
            }
            crossfadeState = {
                active: false,
                fromDeckKey: null,
                toDeckKey: null,
                fromTrack: null,
                toTrack: null,
                startedAt: 0,
                durationSeconds: 0,
                progress: 0,
                timerId: null,
            };
            applyDeckGain(activeDeckKey, 1);
        }

        /**
         * Steps an in-flight crossfade to a normalized progress `p` in `[0, 1]`.
         * Completes the transition when `p >= 1`.
         */
        function stepCrossfade(progress) {
            if (!crossfadeState.active) return null;
            const gains = computeCrossfadeGains(progress);
            crossfadeState.progress = gains.progress;

            applyDeckGain(crossfadeState.fromDeckKey, gains.outgoingGain);
            applyDeckGain(crossfadeState.toDeckKey, gains.incomingGain);

            emit("crossfade-step", {
                ...gains,
                fromTrack: crossfadeState.fromTrack,
                toTrack: crossfadeState.toTrack,
                fromDeck: crossfadeState.fromDeckKey,
                toDeck: crossfadeState.toDeckKey,
            });

            if (gains.progress >= 1) {
                completeCrossfade();
            }
            return gains;
        }

        /**
         * Finalizes an active crossfade, stopping the outgoing deck and locking the incoming deck at 100% gain.
         */
        function completeCrossfade() {
            if (!crossfadeState.active) return null;

            const finishedFromKey = crossfadeState.fromDeckKey;
            const finishedToKey = crossfadeState.toDeckKey;
            const outgoingTrack = crossfadeState.fromTrack;
            const incomingTrack = crossfadeState.toTrack;

            if (crossfadeState.timerId && typeof clearInterval === "function") {
                clearInterval(crossfadeState.timerId);
            }

            const outgoingDeck = finishedFromKey === "A" ? deckA : deckB;
            try {
                outgoingDeck.pause();
                outgoingDeck.currentTime = 0;
            } catch (_) {}

            applyDeckGain(finishedFromKey, 0);
            applyDeckGain(finishedToKey, 1);

            activeDeckKey = finishedToKey;
            activeTrack = incomingTrack;

            crossfadeState = {
                active: false,
                fromDeckKey: null,
                toDeckKey: null,
                fromTrack: null,
                toTrack: null,
                startedAt: 0,
                durationSeconds: 0,
                progress: 1,
                timerId: null,
            };

            ensureEndlessQueue();
            emit("crossfade-complete", {
                previousTrack: outgoingTrack,
                currentTrack: incomingTrack,
                activeDeck: activeDeckKey,
            });
            return incomingTrack;
        }

        /**
         * Initiates a dual-deck crossfade transition from the current active deck to the standby deck
         * playing `nextTrack`.
         */
        function beginCrossfade(nextTrack, optionsOverride = {}) {
            if (!nextTrack) return null;
            if (needsResolvedUrl(nextTrack)) {
                resolveTrackUrlThen(nextTrack, () => beginCrossfade(nextTrack, optionsOverride), { reason: "crossfade" });
                return null;
            }

            const fadeDuration = clamp(
                Number(optionsOverride.durationSeconds ?? crossfadeSeconds),
                MIN_CROSSFADE_SECONDS,
                MAX_CROSSFADE_SECONDS
            );

            // If crossfade is 0s, perform an immediate gapless deck switch
            if (fadeDuration <= 0) {
                return loadAndPlayTrack(nextTrack, {
                    autoplay: optionsOverride.autoplay !== false,
                    useStandbyDeck: true,
                    reason: "gapless-transition",
                });
            }

            if (crossfadeState.active) {
                completeCrossfade();
            }

            initWebAudioGraph();

            const fromKey = activeDeckKey;
            const toKey = activeDeckKey === "A" ? "B" : "A";
            const outgoingDeck = fromKey === "A" ? deckA : deckB;
            const incomingDeck = toKey === "A" ? deckA : deckB;
            const outgoingTrack = activeTrack;

            if (incomingDeck.src !== nextTrack.audioUrl) {
                incomingDeck.src = nextTrack.audioUrl;
            }
            incomingDeck.currentTime = 0;
            if (incomingDeck.dataset) {
                incomingDeck.dataset.trackId = nextTrack.id || "";
            }

            // Record natural completion telemetry for the outgoing track as it enters crossfade
            if (storage && outgoingTrack && typeof storage.recordPlaybackOutcome === "function") {
                const dur =
                    Number.isFinite(outgoingDeck.duration) && outgoingDeck.duration > 0
                        ? outgoingDeck.duration
                        : outgoingTrack.duration || 180;
                storage.recordPlaybackOutcome(outgoingTrack.id, {
                    listenedSeconds: dur,
                    durationSeconds: dur,
                    endedNaturally: true,
                });
            }

            // Switch active deck logical pointer to the incoming deck so UI & MediaSession reflect the new song
            activeDeckKey = toKey;
            activeTrack = nextTrack;
            preloadedTrack = null;

            crossfadeState = {
                active: true,
                fromDeckKey: fromKey,
                toDeckKey: toKey,
                fromTrack: outgoingTrack,
                toTrack: nextTrack,
                startedAt: Date.now(),
                durationSeconds: fadeDuration,
                progress: 0,
                timerId: null,
            };

            applyDeckGain(fromKey, 1);
            applyDeckGain(toKey, 0);

            if (storage && typeof storage.recordPlayStart === "function") {
                storage.recordPlayStart(nextTrack.id);
            }

            const playPromise = incomingDeck.play();
            if (playPromise && typeof playPromise.catch === "function") {
                playPromise.catch(() => {});
            }

            if (typeof options.onTrackChange === "function") {
                options.onTrackChange(nextTrack, {
                    previousTrack: outgoingTrack,
                    activeDeck: getActiveDeck(),
                    activeDeckKey,
                    crossfading: true,
                    crossfadeDuration: fadeDuration,
                });
            }

            syncMediaSession(nextTrack, "playing");
            ensureEndlessQueue();

            // Drive automatic crossfade curve timer in browser/runtime unless manual stepping is requested
            if (!optionsOverride.manualStep && typeof setInterval === "function") {
                const stepIntervalMs = 100;
                crossfadeState.timerId = setInterval(() => {
                    if (!crossfadeState.active) return;
                    const elapsedSeconds = (Date.now() - crossfadeState.startedAt) / 1000;
                    const progress = clamp(elapsedSeconds / fadeDuration, 0, 1);
                    stepCrossfade(progress);
                }, stepIntervalMs);
                if (
                    crossfadeState.timerId &&
                    typeof crossfadeState.timerId.unref === "function"
                ) {
                    crossfadeState.timerId.unref();
                }
            }

            emit("crossfade-start", {
                fromTrack: outgoingTrack,
                toTrack: nextTrack,
                fromDeck: fromKey,
                toDeck: toKey,
                durationSeconds: fadeDuration,
            });

            return {
                fromTrack: outgoingTrack,
                toTrack: nextTrack,
                fromDeck: fromKey,
                toDeck: toKey,
                durationSeconds: fadeDuration,
            };
        }

        /**
         * Loads and optionally plays a track on the active (or standby gapless) deck.
         */
        function loadAndPlayTrack(track, playOptions = {}) {
            if (!track) return null;
            if (needsResolvedUrl(track)) {
                resolveTrackUrlThen(track, () => loadAndPlayTrack(track, playOptions), {
                    reason: playOptions.reason || "play",
                    userInitiated: playOptions.userInitiated !== false,
                });
                return track;
            }

            cancelActiveCrossfade(true);

            // If the track was already preloaded on the standby deck, swap to the standby deck for zero-gap start
            const standby = getStandbyDeck();
            const isPreloadedOnStandby =
                playOptions.useStandbyDeck ||
                (preloadedTrack &&
                    preloadedTrack.id === track.id &&
                    standby.src === track.audioUrl);

            if (isPreloadedOnStandby) {
                const prevDeck = getActiveDeck();
                try {
                    prevDeck.pause();
                    prevDeck.currentTime = 0;
                } catch (_) {}
                applyDeckGain(activeDeckKey, 0);
                activeDeckKey = activeDeckKey === "A" ? "B" : "A";
            }

            const deck = getActiveDeck();
            if (deck.src !== track.audioUrl) {
                deck.src = track.audioUrl;
            }
            deck.currentTime = 0;
            if (deck.dataset) {
                deck.dataset.trackId = track.id || "";
            }

            const previousTrack = activeTrack;
            activeTrack = track;
            preloadedTrack = null;
            applyDeckGain(activeDeckKey, 1);

            const shouldPlay = playOptions.autoplay !== false && !playOptions.pause;
            if (shouldPlay) {
                initWebAudioGraph();
                if (audioCtx && audioCtx.state === "suspended" && typeof audioCtx.resume === "function") {
                    audioCtx.resume().catch(() => {});
                }
                if (storage && typeof storage.recordPlayStart === "function") {
                    storage.recordPlayStart(track.id);
                }
                const playPromise = deck.play();
                if (playPromise && typeof playPromise.catch === "function") {
                    playPromise.catch(() => {});
                }
                syncMediaSession(track, "playing");
            } else {
                try {
                    deck.pause();
                } catch (_) {}
                syncMediaSession(track, "paused");
            }

            if (typeof options.onTrackChange === "function") {
                options.onTrackChange(track, {
                    previousTrack,
                    activeDeck: deck,
                    activeDeckKey,
                    crossfading: false,
                    paused: !shouldPlay,
                });
            }

            ensureEndlessQueue();
            emit("track-change", {
                track,
                previousTrack,
                activeDeck: activeDeckKey,
                playing: shouldPlay,
            });
            return track;
        }

        /**
         * Evaluates the current playback position & total duration to trigger:
         * 1. Endless queue replenishment when fewer than 3 tracks remain
         * 2. Standby deck gapless preloading
         * 3. Automatic crossfade transition when `remainingSeconds <= crossfadeSeconds`
         */
        function evaluatePlaybackTick(currentTimeOverride, durationOverride) {
            const deck = getActiveDeck();
            const currentTime = Number.isFinite(currentTimeOverride)
                ? currentTimeOverride
                : Number(deck.currentTime || 0);
            const duration = Number.isFinite(durationOverride)
                ? durationOverride
                : Number.isFinite(deck.duration) && deck.duration > 0
                  ? deck.duration
                  : Number(activeTrack?.duration || 0);

            if (duration <= 0) return { action: "none" };

            const remainingSeconds = Math.max(0, duration - currentTime);

            // Keep queue replenished & next track preloaded
            const upcoming = ensureEndlessQueue();

            // Update MediaSession position state
            updateMediaSessionPosition(currentTime, duration);

            if (isRepeat || crossfadeState.active) {
                return { action: "none", remainingSeconds };
            }

            // Trigger crossfade when entering the [0, crossfadeSeconds] window at the end of a track
            if (
                crossfadeSeconds > 0 &&
                remainingSeconds > 0 &&
                remainingSeconds <= crossfadeSeconds &&
                duration > crossfadeSeconds + 2 &&
                !deck.paused
            ) {
                const nextTrack = pullNextTrackFromQueue();
                if (nextTrack) {
                    const fadeResult = beginCrossfade(nextTrack, {
                        durationSeconds: Math.min(crossfadeSeconds, remainingSeconds),
                    });
                    return {
                        action: "crossfade",
                        remainingSeconds,
                        nextTrack,
                        fadeResult,
                    };
                }
            }

            return {
                action: "none",
                remainingSeconds,
                preloadedTrack,
                upcomingCount: upcoming.length,
            };
        }

        function pullNextTrackFromQueue(nextOptions = {}) {
            const effectiveRepeat = nextOptions.manualSkip ? false : isRepeat;
            if (typeof options.onRequestNextTrack === "function") {
                return options.onRequestNextTrack({ shuffle: isShuffle, repeat: effectiveRepeat });
            }
            const qm =
                typeof options.getQueueManager === "function"
                    ? options.getQueueManager()
                    : queueManager;
            if (qm && typeof qm.advanceNext === "function") {
                const nextTrack = qm.advanceNext({ shuffle: isShuffle, repeat: effectiveRepeat });
                ensureEndlessQueue();
                return nextTrack;
            }
            return null;
        }

        function pullPreviousTrackFromQueue() {
            if (typeof options.onRequestPreviousTrack === "function") {
                return options.onRequestPreviousTrack();
            }
            const qm =
                typeof options.getQueueManager === "function"
                    ? options.getQueueManager()
                    : queueManager;
            if (qm && typeof qm.previous === "function") {
                return qm.previous();
            }
            return null;
        }

        // ==================== CROSSFADE CONFIGURATION (0–12s) ====================

        function setCrossfadeSeconds(seconds) {
            crossfadeSeconds = clamp(
                Math.round(Number(seconds) || 0),
                MIN_CROSSFADE_SECONDS,
                MAX_CROSSFADE_SECONDS
            );
            if (storage && typeof storage.setPreferences === "function") {
                storage.setPreferences({ crossfadeSeconds });
            }
            emit("crossfade-config", { crossfadeSeconds });
            return crossfadeSeconds;
        }

        function cycleCrossfadeSeconds() {
            const currentIdx = CROSSFADE_PRESETS.indexOf(crossfadeSeconds);
            const nextPreset =
                currentIdx === -1
                    ? CROSSFADE_PRESETS.find((p) => p > crossfadeSeconds) ?? 0
                    : CROSSFADE_PRESETS[(currentIdx + 1) % CROSSFADE_PRESETS.length];
            return setCrossfadeSeconds(nextPreset);
        }

        function getCrossfadeSeconds() {
            return crossfadeSeconds;
        }

        // ==================== PLAYBACK TRANSPORT CONTROLS ====================

        function play() {
            const deck = getActiveDeck();
            initWebAudioGraph();
            if (audioCtx && audioCtx.state === "suspended" && typeof audioCtx.resume === "function") {
                audioCtx.resume().catch(() => {});
            }
            if (activeTrack && storage && typeof storage.recordPlayStart === "function") {
                storage.recordPlayStart(activeTrack.id);
            }
            const res = deck.play();
            if (res && typeof res.catch === "function") {
                res.catch(() => {});
            }
            syncMediaSession(activeTrack, "playing");
            emit("play", { track: activeTrack, activeDeck: activeDeckKey });
            return true;
        }

        function pause() {
            cancelActiveCrossfade(true);
            const deck = getActiveDeck();
            try {
                deck.pause();
            } catch (_) {}
            syncMediaSession(activeTrack, "paused");
            emit("pause", { track: activeTrack, activeDeck: activeDeckKey });
            return true;
        }

        function togglePlay() {
            const deck = getActiveDeck();
            if (deck.paused) {
                play();
                return true;
            } else {
                pause();
                return false;
            }
        }

        function seekTo(targetSeconds) {
            const deck = getActiveDeck();
            const duration =
                Number.isFinite(deck.duration) && deck.duration > 0
                    ? deck.duration
                    : Number(activeTrack?.duration || 0);
            const clampedTime =
                duration > 0
                    ? clamp(Number(targetSeconds) || 0, 0, duration)
                    : Math.max(0, Number(targetSeconds) || 0);
            deck.currentTime = clampedTime;
            updateMediaSessionPosition(clampedTime, duration);
            emit("seek", { currentTime: clampedTime, duration });
            return clampedTime;
        }

        function seekBy(deltaSeconds) {
            const deck = getActiveDeck();
            return seekTo(Number(deck.currentTime || 0) + Number(deltaSeconds || 0));
        }

        function setVolume(newVolume) {
            masterVolume = roundTo(clamp(Number(newVolume), 0, 1));
            if (masterVolume > 0) {
                isMuted = false;
                lastUnmutedVolume = masterVolume;
            } else {
                isMuted = true;
            }
            if (crossfadeState.active) {
                const gains = computeCrossfadeGains(crossfadeState.progress);
                applyDeckGain(crossfadeState.fromDeckKey, gains.outgoingGain);
                applyDeckGain(crossfadeState.toDeckKey, gains.incomingGain);
            } else {
                applyDeckGain(activeDeckKey, 1);
            }
            emit("volume", { volume: masterVolume, muted: isMuted });
            return masterVolume;
        }

        function adjustVolume(delta) {
            const base = isMuted ? 0 : masterVolume;
            return setVolume(clamp(base + Number(delta || 0), 0, 1));
        }

        function toggleMute(forceMute) {
            isMuted = typeof forceMute === "boolean" ? forceMute : !isMuted;
            if (!isMuted && masterVolume === 0) {
                masterVolume = lastUnmutedVolume || 0.8;
            }
            if (crossfadeState.active) {
                const gains = computeCrossfadeGains(crossfadeState.progress);
                applyDeckGain(crossfadeState.fromDeckKey, gains.outgoingGain);
                applyDeckGain(crossfadeState.toDeckKey, gains.incomingGain);
            } else {
                applyDeckGain(activeDeckKey, 1);
            }
            emit("mute", { volume: isMuted ? 0 : masterVolume, muted: isMuted });
            return isMuted;
        }

        function setShuffle(forceShuffle) {
            isShuffle = typeof forceShuffle === "boolean" ? forceShuffle : !isShuffle;
            emit("shuffle", { shuffle: isShuffle });
            return isShuffle;
        }

        function setRepeat(forceRepeat) {
            isRepeat = typeof forceRepeat === "boolean" ? forceRepeat : !isRepeat;
            emit("repeat", { repeat: isRepeat });
            return isRepeat;
        }

        function next(nextOptions = {}) {
            const nextTrack = pullNextTrackFromQueue(nextOptions);
            if (!nextTrack) return null;

            const useCrossfade =
                nextOptions.crossfade === true ||
                (nextOptions.crossfade !== false &&
                    crossfadeSeconds > 0 &&
                    !getActiveDeck().paused &&
                    nextOptions.manualSkip !== true);

            if (useCrossfade) {
                beginCrossfade(nextTrack, {
                    durationSeconds: nextOptions.durationSeconds ?? crossfadeSeconds,
                });
                return nextTrack;
            }

            return loadAndPlayTrack(nextTrack, {
                autoplay: nextOptions.pause !== true,
                useStandbyDeck: true,
            });
        }

        function previous(prevOptions = {}) {
            const deck = getActiveDeck();
            // If more than 3.5 seconds into the song and not forced, restart current track
            if (Number(deck.currentTime || 0) > 3.5 && !prevOptions.forcePreviousTrack) {
                seekTo(0);
                return activeTrack;
            }
            const prevTrack = pullPreviousTrackFromQueue();
            if (!prevTrack) return activeTrack;
            return loadAndPlayTrack(prevTrack, {
                autoplay: prevOptions.pause !== true,
            });
        }

        // ==================== MEDIASESSION API INTEGRATION ====================

        function getMediaSession() {
            if (options.mediaSession) return options.mediaSession;
            if (globalScope && globalScope.navigator && globalScope.navigator.mediaSession) {
                return globalScope.navigator.mediaSession;
            }
            return null;
        }

        function syncMediaSession(track = activeTrack, playbackState = null) {
            const ms = getMediaSession();
            if (!ms) return false;

            if (track) {
                const MetadataCtor =
                    options.MediaMetadata ||
                    (globalScope && typeof globalScope.MediaMetadata === "function"
                        ? globalScope.MediaMetadata
                        : null);
                const metaPayload = {
                    title: track.title || "Unknown Title",
                    artist: track.artistDisplay || track.primaryArtist || "Unknown Artist",
                    album: track.album || "SpotTube Hybrid",
                    artwork: track.coverUrl
                        ? [
                              { src: track.coverUrl, sizes: "256x256", type: "image/jpeg" },
                              { src: track.coverUrl, sizes: "512x512", type: "image/jpeg" },
                          ]
                        : [],
                };
                try {
                    ms.metadata = MetadataCtor ? new MetadataCtor(metaPayload) : metaPayload;
                } catch (_) {
                    ms.metadata = metaPayload;
                }
            }

            if (playbackState) {
                try {
                    ms.playbackState = playbackState;
                } catch (_) {}
            } else {
                const deck = getActiveDeck();
                try {
                    ms.playbackState = deck.paused ? "paused" : "playing";
                } catch (_) {}
            }

            const deck = getActiveDeck();
            const duration =
                Number.isFinite(deck.duration) && deck.duration > 0
                    ? deck.duration
                    : Number(track?.duration || 0);
            updateMediaSessionPosition(Number(deck.currentTime || 0), duration);
            return true;
        }

        function updateMediaSessionPosition(position, duration) {
            const ms = getMediaSession();
            if (!ms || typeof ms.setPositionState !== "function") return false;
            if (!Number.isFinite(duration) || duration <= 0) return false;

            const safePosition = clamp(Number(position) || 0, 0, duration);
            try {
                ms.setPositionState({
                    duration,
                    playbackRate: 1,
                    position: safePosition,
                });
                return true;
            } catch (_) {
                return false;
            }
        }

        function registerMediaSessionHandlers(customHandlers = {}) {
            const ms = getMediaSession();
            if (!ms || typeof ms.setActionHandler !== "function") return false;

            const handlers = {
                play: () => {
                    if (typeof customHandlers.onPlay === "function") customHandlers.onPlay();
                    else play();
                },
                pause: () => {
                    if (typeof customHandlers.onPause === "function") customHandlers.onPause();
                    else pause();
                },
                previoustrack: () => {
                    if (typeof customHandlers.onPrevious === "function") {
                        customHandlers.onPrevious();
                    } else {
                        previous({ forcePreviousTrack: true });
                    }
                },
                nexttrack: () => {
                    if (typeof customHandlers.onNext === "function") customHandlers.onNext();
                    else next({ manualSkip: true });
                },
                seekbackward: (details) => {
                    const offset = Number(details?.seekOffset) || 10;
                    if (typeof customHandlers.onSeekBackward === "function") {
                        customHandlers.onSeekBackward(offset);
                    } else {
                        seekBy(-offset);
                    }
                },
                seekforward: (details) => {
                    const offset = Number(details?.seekOffset) || 10;
                    if (typeof customHandlers.onSeekForward === "function") {
                        customHandlers.onSeekForward(offset);
                    } else {
                        seekBy(offset);
                    }
                },
                seekto: (details) => {
                    if (Number.isFinite(details?.seekTime)) {
                        if (typeof customHandlers.onSeekTo === "function") {
                            customHandlers.onSeekTo(details.seekTime);
                        } else {
                            seekTo(details.seekTime);
                        }
                    }
                },
                stop: () => {
                    if (typeof customHandlers.onStop === "function") customHandlers.onStop();
                    else {
                        pause();
                        seekTo(0);
                    }
                },
            };

            for (const [action, fn] of Object.entries(handlers)) {
                try {
                    ms.setActionHandler(action, fn);
                } catch (_) {
                    // Some browsers do not support all actions (e.g. 'stop'); ignore gracefully
                }
            }
            return true;
        }

        // ==================== KEYBOARD SHORTCUTS CONTROLLER ====================

        function handleKeyDown(event, actionCallbacks = {}) {
            if (!event || typeof event !== "object") return { handled: false };
            if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) {
                return { handled: false };
            }

            const key = String(event.key || "");
            const lowerKey = key.toLowerCase();

            // Allow Escape even inside inputs to blur or close modals
            if (key === "Escape") {
                if (typeof actionCallbacks.onEscape === "function") {
                    actionCallbacks.onEscape(event);
                }
                if (event.target && typeof event.target.blur === "function" && isEditableTarget(event.target)) {
                    event.target.blur();
                }
                return { handled: true, action: "escape" };
            }

            if (isEditableTarget(event.target)) {
                return { handled: false, reason: "editable-target" };
            }

            const prevent = () => {
                if (typeof event.preventDefault === "function") event.preventDefault();
            };

            // 1. Space or K -> Play / Pause
            if (key === " " || key === "Spacebar" || lowerKey === "k") {
                prevent();
                if (typeof actionCallbacks.onTogglePlay === "function") {
                    actionCallbacks.onTogglePlay();
                } else {
                    togglePlay();
                }
                return { handled: true, action: "toggle-play" };
            }

            // 2. N or Shift+ArrowRight -> Next Track
            if (lowerKey === "n" || (key === "ArrowRight" && event.shiftKey)) {
                prevent();
                if (typeof actionCallbacks.onNext === "function") {
                    actionCallbacks.onNext();
                } else {
                    next({ manualSkip: true });
                }
                return { handled: true, action: "next-track" };
            }

            // 3. P or Shift+ArrowLeft -> Previous Track
            if (lowerKey === "p" || (key === "ArrowLeft" && event.shiftKey)) {
                prevent();
                if (typeof actionCallbacks.onPrevious === "function") {
                    actionCallbacks.onPrevious();
                } else {
                    previous({ forcePreviousTrack: true });
                }
                return { handled: true, action: "previous-track" };
            }

            // 4. ArrowRight or L -> Seek Forward +5s
            if ((key === "ArrowRight" && !event.shiftKey) || lowerKey === "l") {
                prevent();
                const seekTime =
                    typeof actionCallbacks.onSeekBy === "function"
                        ? actionCallbacks.onSeekBy(5)
                        : seekBy(5);
                return { handled: true, action: "seek-forward", currentTime: seekTime };
            }

            // 5. ArrowLeft or J -> Seek Backward -5s
            if ((key === "ArrowLeft" && !event.shiftKey) || lowerKey === "j") {
                prevent();
                const seekTime =
                    typeof actionCallbacks.onSeekBy === "function"
                        ? actionCallbacks.onSeekBy(-5)
                        : seekBy(-5);
                return { handled: true, action: "seek-backward", currentTime: seekTime };
            }

            // 6. ArrowUp -> Volume Up +5%
            if (key === "ArrowUp") {
                prevent();
                const vol =
                    typeof actionCallbacks.onAdjustVolume === "function"
                        ? actionCallbacks.onAdjustVolume(0.05)
                        : adjustVolume(0.05);
                return { handled: true, action: "volume-up", volume: vol };
            }

            // 7. ArrowDown -> Volume Down -5%
            if (key === "ArrowDown") {
                prevent();
                const vol =
                    typeof actionCallbacks.onAdjustVolume === "function"
                        ? actionCallbacks.onAdjustVolume(-0.05)
                        : adjustVolume(-0.05);
                return { handled: true, action: "volume-down", volume: vol };
            }

            // 8. M -> Mute / Unmute
            if (lowerKey === "m") {
                prevent();
                const mutedState =
                    typeof actionCallbacks.onToggleMute === "function"
                        ? actionCallbacks.onToggleMute()
                        : toggleMute();
                return { handled: true, action: "toggle-mute", muted: mutedState };
            }

            // 9. Q -> Toggle Up Next / Track Info Right Drawer
            if (lowerKey === "q") {
                prevent();
                if (typeof actionCallbacks.onToggleDrawer === "function") {
                    actionCallbacks.onToggleDrawer();
                }
                return { handled: true, action: "toggle-drawer" };
            }

            // 10. S -> Toggle Shuffle
            if (lowerKey === "s") {
                prevent();
                const shuf =
                    typeof actionCallbacks.onToggleShuffle === "function"
                        ? actionCallbacks.onToggleShuffle()
                        : setShuffle();
                return { handled: true, action: "toggle-shuffle", shuffle: shuf };
            }

            // 11. R -> Toggle Repeat
            if (lowerKey === "r") {
                prevent();
                const rep =
                    typeof actionCallbacks.onToggleRepeat === "function"
                        ? actionCallbacks.onToggleRepeat()
                        : setRepeat();
                return { handled: true, action: "toggle-repeat", repeat: rep };
            }

            // 12. F -> Toggle Like / Heart on Current Track
            if (lowerKey === "f") {
                prevent();
                if (typeof actionCallbacks.onToggleLike === "function") {
                    actionCallbacks.onToggleLike();
                }
                return { handled: true, action: "toggle-like" };
            }

            // 13. X -> Cycle Crossfade Duration (0–12s)
            if (lowerKey === "x") {
                prevent();
                const xfade =
                    typeof actionCallbacks.onCycleCrossfade === "function"
                        ? actionCallbacks.onCycleCrossfade()
                        : cycleCrossfadeSeconds();
                return { handled: true, action: "cycle-crossfade", crossfadeSeconds: xfade };
            }

            // 14. / -> Focus Top Omni-Search Input
            if (key === "/") {
                prevent();
                if (typeof actionCallbacks.onFocusSearch === "function") {
                    actionCallbacks.onFocusSearch();
                }
                return { handled: true, action: "focus-search" };
            }

            // 15. ? -> Toggle Keyboard Shortcuts Help Modal
            if (key === "?") {
                prevent();
                if (typeof actionCallbacks.onToggleShortcutsModal === "function") {
                    actionCallbacks.onToggleShortcutsModal();
                }
                return { handled: true, action: "toggle-shortcuts-modal" };
            }

            return { handled: false };
        }

        function bindKeyboardShortcuts(targetDoc, actionCallbacks = {}) {
            const doc =
                targetDoc ||
                (globalScope && globalScope.document ? globalScope.document : null);
            if (!doc || typeof doc.addEventListener !== "function") {
                return () => {};
            }
            const listener = (e) => handleKeyDown(e, actionCallbacks);
            doc.addEventListener("keydown", listener);
            return () => {
                if (typeof doc.removeEventListener === "function") {
                    doc.removeEventListener("keydown", listener);
                }
            };
        }

        function getState() {
            const deck = getActiveDeck();
            return {
                activeDeckKey,
                activeDeck: deck,
                standbyDeck: getStandbyDeck(),
                deckA,
                deckB,
                activeTrack,
                preloadedTrack,
                crossfadeSeconds,
                crossfadeState: { ...crossfadeState, timerId: Boolean(crossfadeState.timerId) },
                volume: masterVolume,
                muted: isMuted,
                shuffle: isShuffle,
                repeat: isRepeat,
                paused: Boolean(deck.paused),
                currentTime: Number(deck.currentTime || 0),
                duration: Number(deck.duration || activeTrack?.duration || 0),
                minQueueSize,
                webAudioSupported,
            };
        }

        function onChange(listener) {
            if (typeof listener === "function") {
                listeners.add(listener);
            }
            return () => listeners.delete(listener);
        }

        return {
            MIN_CROSSFADE_SECONDS,
            MAX_CROSSFADE_SECONDS,
            CROSSFADE_PRESETS,
            computeCrossfadeGains,
            getActiveDeck,
            getStandbyDeck,
            getDecks: () => ({ deckA, deckB, activeDeckKey }),
            loadAndPlayTrack,
            preloadNextTrack,
            ensureEndlessQueue,
            beginCrossfade,
            stepCrossfade,
            completeCrossfade,
            cancelActiveCrossfade,
            evaluatePlaybackTick,
            setCrossfadeSeconds,
            cycleCrossfadeSeconds,
            getCrossfadeSeconds,
            play,
            pause,
            togglePlay,
            seekTo,
            seekBy,
            setVolume,
            adjustVolume,
            toggleMute,
            setShuffle,
            setRepeat,
            next,
            previous,
            syncMediaSession,
            updateMediaSessionPosition,
            registerMediaSessionHandlers,
            handleKeyDown,
            bindKeyboardShortcuts,
            getState,
            onChange,
        };
    }

    const defaultPlayer = createPlayerEngine();

    return {
        MIN_CROSSFADE_SECONDS,
        MAX_CROSSFADE_SECONDS,
        CROSSFADE_PRESETS,
        DEFAULT_MIN_QUEUE_SIZE,
        computeCrossfadeGains,
        isEditableTarget,
        createPlayerEngine,
        ...defaultPlayer,
    };
});
