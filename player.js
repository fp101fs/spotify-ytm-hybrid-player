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

    // Silence-aware crossfade thresholds & guardrails
    const SILENCE_RMS_THRESHOLD = 0.0056; // ~ -45 dBFS
    const TRAILING_WATCH_WINDOW_SECONDS = 18;
    const TRAILING_SILENCE_HOLD_MS = 500;
    const TRAILING_SILENCE_FADE_CAP_SECONDS = 1.5;
    const TRAILING_SILENCE_INCOMING_FADE_CAP_SECONDS = 4;
    const INCOMING_FADE_IN_EXPONENT = 1.6;
    const MAX_LEADING_TRIM_SECONDS = 10;
    const LEADING_TRIM_MIN_SECONDS = 0.25;
    // Slightly larger than one 4x * 35ms scan step (~0.14s) so the first transient is never clipped
    const LEADING_TRIM_PREROLL_SECONDS = 0.18;
    const LEADING_CUE_SCAN_RATE = 4;
    const LEADING_CUE_POLL_MS = 35;
    const LEADING_CUE_TIMEOUT_MS = 4000;
    const LEADING_CUE_CACHE_LIMIT = 200;

    function clamp(value, min, max) {
        if (!Number.isFinite(value)) return min;
        return Math.max(min, Math.min(max, value));
    }

    function roundTo(value, decimals = 4) {
        const factor = Math.pow(10, decimals);
        return Math.round((Number(value) || 0) * factor) / factor;
    }

    /**
     * Computes RMS loudness from time-domain PCM samples:
     * - Float32Array (or number array) in [-1, 1]
     * - Uint8Array in [0, 255] centered at 128
     */
    function computeRmsFromSamples(samples) {
        if (!samples || !samples.length) return 0;
        const isByte = typeof Uint8Array !== "undefined" && samples instanceof Uint8Array;
        let sumSq = 0;
        for (let i = 0; i < samples.length; i++) {
            const v = isByte ? (samples[i] - 128) / 128 : Number(samples[i]) || 0;
            sumSq += v * v;
        }
        return Math.sqrt(sumSq / samples.length);
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

    /**
     * Perceptually smooth fade-in gain for live crossfade playback.
     * Softens the initial steep slope of sin(p * pi/2) so incoming tracks clearly ramp up
     * instead of jumping loudly in the first few hundred milliseconds.
     */
    function computePerceptualFadeInGain(progress) {
        const p = clamp(Number(progress) || 0, 0, 1);
        if (p <= 0) return 0;
        if (p >= 1) return 1;
        return roundTo(Math.pow(Math.sin(p * Math.PI * 0.5), INCOMING_FADE_IN_EXPONENT));
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
            incomingStartedAt: null,
            incomingFadeDuration: 0,
            incomingReady: false,
            incomingStartTime: 0,
            outgoingPaused: false,
            outgoingGain: 0,
            incomingGain: 0,
            progress: 0,
            timerId: null,
            cleanupListeners: null,
        };

        // Web Audio API dual-deck graph state
        let audioCtx = null;
        let sourceNodeA = null;
        let sourceNodeB = null;
        let deckAnalyserA = null;
        let deckAnalyserB = null;
        let gainNodeA = null;
        let gainNodeB = null;
        let analyserNode = null;
        let webAudioInitialized = false;
        let webAudioSupported = false;
        const deckWebAudioBound = { A: false, B: false };
        let pendingCrossfadeTrackId = null;

        // Silence-aware crossfade state (only active when crossfadeSeconds > 0)
        const silenceOptions = {
            enabled: options.trimSilence !== false,
            rmsThreshold:
                Number.isFinite(options.silenceRmsThreshold) && options.silenceRmsThreshold > 0
                    ? options.silenceRmsThreshold
                    : SILENCE_RMS_THRESHOLD,
            trailingHoldMs:
                Number.isFinite(options.trailingSilenceHoldMs) && options.trailingSilenceHoldMs >= 0
                    ? options.trailingSilenceHoldMs
                    : TRAILING_SILENCE_HOLD_MS,
            maxLeadingTrimSeconds:
                Number.isFinite(options.maxLeadingTrimSeconds) && options.maxLeadingTrimSeconds >= 0
                    ? options.maxLeadingTrimSeconds
                    : MAX_LEADING_TRIM_SECONDS,
        };
        let trailingSilenceState = {
            trackId: null,
            hadAudibleSignal: false,
            silentSinceMs: null,
        };
        const leadingCueCache = new Map();
        let standbyCueState = {
            active: false,
            deckKey: null,
            trackId: null,
            timerId: null,
            startedAt: 0,
        };
        let analyserFloatBuf = null;
        let analyserByteBuf = null;

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

        function getDeckAnalyserNode(deckKey) {
            return deckKey === "A" ? deckAnalyserA : deckAnalyserB;
        }

        function measureDeckRms(deckKey) {
            if (!webAudioSupported || !deckWebAudioBound[deckKey]) return null;
            const node = getDeckAnalyserNode(deckKey);
            if (!node) return null;
            const size = Math.max(64, Number(node.fftSize) || 256);

            if (typeof node.getFloatTimeDomainData === "function") {
                if (!analyserFloatBuf || analyserFloatBuf.length !== size) {
                    analyserFloatBuf = new Float32Array(size);
                } else {
                    analyserFloatBuf.fill(0);
                }
                try {
                    node.getFloatTimeDomainData(analyserFloatBuf);
                    return computeRmsFromSamples(analyserFloatBuf);
                } catch (_) {
                    return null;
                }
            }
            if (typeof node.getByteTimeDomainData === "function") {
                if (!analyserByteBuf || analyserByteBuf.length !== size) {
                    analyserByteBuf = new Uint8Array(size);
                }
                // Center at 128 so a no-op mock reads as 0 RMS rather than full-scale DC
                analyserByteBuf.fill(128);
                try {
                    node.getByteTimeDomainData(analyserByteBuf);
                    return computeRmsFromSamples(analyserByteBuf);
                } catch (_) {
                    return null;
                }
            }
            return null;
        }

        function resetTrailingSilenceState(trackId = activeTrack ? activeTrack.id : null) {
            trailingSilenceState = {
                trackId: trackId || null,
                hadAudibleSignal: false,
                silentSinceMs: null,
            };
        }

        function cacheLeadingCue(trackId, seconds) {
            if (!trackId) return;
            if (leadingCueCache.size >= LEADING_CUE_CACHE_LIMIT && !leadingCueCache.has(trackId)) {
                const oldestKey = leadingCueCache.keys().next().value;
                if (oldestKey !== undefined) leadingCueCache.delete(oldestKey);
            }
            leadingCueCache.set(trackId, Math.max(0, roundTo(seconds, 3)));
        }

        function getLeadingCueSeconds(trackOrId) {
            const id = typeof trackOrId === "string" ? trackOrId : trackOrId && trackOrId.id;
            if (!id || !leadingCueCache.has(id)) return null;
            return leadingCueCache.get(id);
        }

        function stopStandbyCue({ pauseDeck = true, resetTime = false } = {}) {
            if (standbyCueState.timerId && typeof clearInterval === "function") {
                clearInterval(standbyCueState.timerId);
            }
            const cuedKey = standbyCueState.deckKey;
            standbyCueState = {
                active: false,
                deckKey: null,
                trackId: null,
                timerId: null,
                startedAt: 0,
            };
            if (cuedKey) {
                const deck = cuedKey === "A" ? deckA : deckB;
                try {
                    deck.playbackRate = 1;
                } catch (_) {}
                if (pauseDeck) {
                    try {
                        deck.pause();
                    } catch (_) {}
                }
                if (resetTime) {
                    try {
                        deck.currentTime = 0;
                    } catch (_) {}
                }
            }
        }

        /**
         * Silently scans past leading silence on the preloaded standby deck using its pre-gain
         * AnalyserNode (while GainNode = 0 keeps it completely inaudible), parking it right where
         * audible music begins so crossfade enters cleanly with zero dead air.
         */
        function maybeCueStandbyDeck(remainingSeconds) {
            if (
                !silenceOptions.enabled ||
                silenceOptions.maxLeadingTrimSeconds <= 0 ||
                crossfadeSeconds <= 0 ||
                crossfadeState.active ||
                standbyCueState.active ||
                !preloadedTrack ||
                !preloadedTrack.id ||
                leadingCueCache.has(preloadedTrack.id)
            ) {
                return false;
            }
            if (remainingSeconds > crossfadeSeconds + 12) return false;

            const standbyKey = activeDeckKey === "A" ? "B" : "A";
            const standby = standbyKey === "A" ? deckA : deckB;
            if (!standby || !isDeckLoadedWithUrl(standby, preloadedTrack.audioUrl)) return false;

            // Require decoded audio metadata/frames ready and Web Audio graph support so
            // gainNode = 0 guarantees complete silence while scanning
            if (Number(standby.readyState) < 2) return false;
            if (!initWebAudioGraph() || !ensureDeckWebAudioSource(standbyKey)) return false;
            const standbyAnalyser = getDeckAnalyserNode(standbyKey);
            if (!standbyAnalyser || typeof standbyAnalyser.getFloatTimeDomainData !== "function") {
                return false;
            }

            const standbyDuration =
                Number.isFinite(standby.duration) && standby.duration > 0
                    ? standby.duration
                    : Number(preloadedTrack.duration || 0);
            if (standbyDuration > 0 && standbyDuration <= silenceOptions.maxLeadingTrimSeconds + crossfadeSeconds) {
                cacheLeadingCue(preloadedTrack.id, 0);
                return false;
            }

            const targetTrack = preloadedTrack;
            applyDeckGain(standbyKey, 0);
            try {
                standby.currentTime = 0;
                standby.playbackRate = LEADING_CUE_SCAN_RATE;
            } catch (_) {}

            standbyCueState = {
                active: true,
                deckKey: standbyKey,
                trackId: targetTrack.id,
                timerId: null,
                startedAt: Date.now(),
            };

            const finishCue = (cueSeconds) => {
                if (!standbyCueState.active || standbyCueState.trackId !== targetTrack.id) return;
                cacheLeadingCue(targetTrack.id, cueSeconds);
                stopStandbyCue({ pauseDeck: true, resetTime: false });
                try {
                    standby.currentTime = cueSeconds;
                } catch (_) {}
                emit("standby-cued", {
                    track: targetTrack,
                    standbyDeck: standbyKey,
                    cueSeconds,
                });
            };

            const playPromise = standby.play();
            if (playPromise && typeof playPromise.catch === "function") {
                playPromise.catch(() => {
                    if (standbyCueState.active && standbyCueState.trackId === targetTrack.id) {
                        stopStandbyCue({ pauseDeck: true, resetTime: true });
                    }
                });
            }

            if (typeof setInterval === "function") {
                standbyCueState.timerId = setInterval(() => {
                    if (
                        !standbyCueState.active ||
                        crossfadeState.active ||
                        activeDeckKey === standbyKey ||
                        standbyCueState.trackId !== targetTrack.id
                    ) {
                        stopStandbyCue({ pauseDeck: activeDeckKey !== standbyKey, resetTime: false });
                        return;
                    }

                    const rms = measureDeckRms(standbyKey);
                    const pos = Number(standby.currentTime || 0);
                    const elapsedMs = Date.now() - standbyCueState.startedAt;

                    if (rms !== null && rms >= silenceOptions.rmsThreshold) {
                        const rawCue = Math.max(0, pos - LEADING_TRIM_PREROLL_SECONDS);
                        const cueSeconds =
                            rawCue >= LEADING_TRIM_MIN_SECONDS
                                ? Math.min(rawCue, silenceOptions.maxLeadingTrimSeconds)
                                : 0;
                        finishCue(cueSeconds);
                        return;
                    }

                    if (
                        pos >= silenceOptions.maxLeadingTrimSeconds ||
                        elapsedMs >= LEADING_CUE_TIMEOUT_MS ||
                        standby.ended
                    ) {
                        // Track exceeded leading silence cap (e.g. quiet ambient intro): keep 0:00
                        finishCue(0);
                    }
                }, LEADING_CUE_POLL_MS);
                if (standbyCueState.timerId && typeof standbyCueState.timerId.unref === "function") {
                    standbyCueState.timerId.unref();
                }
            }
            return true;
        }

        /**
         * Evaluates pre-gain RMS on the active deck to detect sustained trailing silence in the
         * final watch window of a track when crossfade is active.
         */
        function shouldTriggerTrailingSilenceCrossfade(remainingSeconds, duration, nowMs = Date.now()) {
            if (!silenceOptions.enabled || crossfadeSeconds <= 0) return false;
            const trackId = activeTrack ? activeTrack.id : null;
            if (trailingSilenceState.trackId !== trackId) {
                resetTrailingSilenceState(trackId);
            }

            const watchWindow = Math.min(
                TRAILING_WATCH_WINDOW_SECONDS,
                Math.max(crossfadeSeconds + 10, crossfadeSeconds * 2),
                duration * 0.45
            );
            // Once we know this track has audible signal, skip analyser polling until the outro window
            if (trailingSilenceState.hadAudibleSignal && remainingSeconds > watchWindow) {
                trailingSilenceState.silentSinceMs = null;
                return false;
            }

            const rms = measureDeckRms(activeDeckKey);
            if (rms === null) return false;

            if (rms >= silenceOptions.rmsThreshold) {
                trailingSilenceState.hadAudibleSignal = true;
                trailingSilenceState.silentSinceMs = null;
                return false;
            }

            // Never fire early before the track has actually produced audible signal
            if (!trailingSilenceState.hadAudibleSignal) return false;

            if (remainingSeconds > watchWindow || remainingSeconds <= 0) {
                trailingSilenceState.silentSinceMs = null;
                return false;
            }

            if (trailingSilenceState.silentSinceMs === null) {
                trailingSilenceState.silentSinceMs = nowMs;
                return false;
            }
            return nowMs - trailingSilenceState.silentSinceMs >= silenceOptions.trailingHoldMs;
        }

        function resolveAbsoluteUrl(url) {
            if (!url || typeof url !== "string") return "";
            try {
                const base =
                    globalScope && globalScope.location && globalScope.location.href
                        ? globalScope.location.href
                        : null;
                return base ? new URL(url, base).href : url;
            } catch (_) {
                return url;
            }
        }

        function isDeckLoadedWithUrl(deck, audioUrl) {
            if (!deck || !audioUrl) return false;
            if (deck.src === audioUrl) return true;
            if (deck.dataset && deck.dataset.loadedAudioUrl === audioUrl && deck.src) return true;
            const resolved = resolveAbsoluteUrl(audioUrl);
            return Boolean(resolved && deck.src === resolved);
        }

        function setDeckSource(deck, track) {
            if (!deck || !track || !track.audioUrl) return false;
            const changed = !isDeckLoadedWithUrl(deck, track.audioUrl);
            if (changed) {
                deck.src = track.audioUrl;
            }
            if (deck.dataset) {
                deck.dataset.trackId = track.id || "";
                deck.dataset.loadedAudioUrl = track.audioUrl;
            }
            return changed;
        }

        function isSafariWebKit() {
            // Respect explicit AudioContext injection (e.g. tests or custom hosts)
            if (options.AudioContext) return false;
            const nav = globalScope && globalScope.navigator;
            const ua = String((nav && nav.userAgent) || "");
            return /Safari/i.test(ua) && !/Chrome|Chromium|CriOS|Edg|OPR|Firefox|FxiOS/i.test(ua);
        }

        function resumeAudioContextIfNeeded() {
            if (audioCtx && audioCtx.state === "suspended" && typeof audioCtx.resume === "function") {
                try {
                    const p = audioCtx.resume();
                    if (p && typeof p.catch === "function") p.catch(() => {});
                } catch (_) {}
            }
        }

        function initWebAudioGraph() {
            if (webAudioInitialized) return webAudioSupported;
            webAudioInitialized = true;

            // WebKit/Safari frequently silences MediaElementAudioSourceNode when an <audio>
            // element's src is assigned or swapped after binding; use native HTML5 deck volume there.
            if (isSafariWebKit()) {
                webAudioSupported = false;
                return false;
            }

            const AudioCtx =
                options.AudioContext ||
                (globalScope && (globalScope.AudioContext || globalScope.webkitAudioContext));
            if (!AudioCtx) {
                webAudioSupported = false;
                return false;
            }

            try {
                audioCtx = new AudioCtx();
                deckAnalyserA = audioCtx.createAnalyser();
                deckAnalyserB = audioCtx.createAnalyser();
                deckAnalyserA.fftSize = 256;
                deckAnalyserB.fftSize = 256;
                deckAnalyserA.smoothingTimeConstant = 0;
                deckAnalyserB.smoothingTimeConstant = 0;

                gainNodeA = audioCtx.createGain();
                gainNodeB = audioCtx.createGain();
                analyserNode = audioCtx.createAnalyser();
                analyserNode.fftSize = 512;
                analyserNode.smoothingTimeConstant = 0.8;

                deckAnalyserA.connect(gainNodeA);
                deckAnalyserB.connect(gainNodeB);
                gainNodeA.connect(analyserNode);
                gainNodeB.connect(analyserNode);
                analyserNode.connect(audioCtx.destination);

                webAudioSupported = true;
                return true;
            } catch (_) {
                webAudioSupported = false;
                return false;
            }
        }

        /**
         * Lazily binds a deck's HTMLAudioElement to its Web Audio pre-gain AnalyserNode -> GainNode
         * only after the deck has a source URL loaded, keeping a strong reference to the
         * MediaElementAudioSourceNode so it cannot be garbage-collected while idle.
         */
        function ensureDeckWebAudioSource(deckKey) {
            if (!webAudioSupported || !audioCtx) return false;
            if (deckWebAudioBound[deckKey]) return true;

            const deck = deckKey === "A" ? deckA : deckB;
            const deckAnalyser = getDeckAnalyserNode(deckKey);
            const gainNode = getDeckGainNode(deckKey);
            if (!deck || !deck.src || !gainNode) return false;

            try {
                const source = audioCtx.createMediaElementSource(deck);
                if (deckAnalyser) {
                    source.connect(deckAnalyser);
                } else {
                    source.connect(gainNode);
                }
                if (deckKey === "A") sourceNodeA = source;
                else sourceNodeB = source;
                deckWebAudioBound[deckKey] = true;
                return true;
            } catch (_) {
                // If MediaElementSource was already bound elsewhere, keep this deck on HTML5 volume fallback.
                deckWebAudioBound[deckKey] = false;
                return false;
            }
        }

        function applyDeckGain(deckKey, gainMultiplier = 1, optionsGain = {}) {
            const deck = deckKey === "A" ? deckA : deckB;
            const clampedGain = clamp(gainMultiplier, 0, 1);
            const effectiveVolume = isMuted ? 0 : roundTo(clamp(masterVolume * clampedGain, 0, 1));

            if (webAudioSupported && deckWebAudioBound[deckKey]) {
                // Keep the underlying HTMLAudioElement unmuted at unity gain so it always feeds a
                // full-scale signal into MediaElementAudioSourceNode; GainNode exclusively controls level.
                // Setting deck.volume = 0 on a Web Audio-captured element double-attenuates (gain^2)
                // and can silence or starve audio capture during crossfade fade-in.
                deck.muted = false;
                deck.volume = 1;
                const gainNode = getDeckGainNode(deckKey);
                if (gainNode && gainNode.gain) {
                    const param = gainNode.gain;
                    const rampSeconds = Number(optionsGain.rampSeconds) || 0;
                    if (
                        typeof param.cancelScheduledValues === "function" &&
                        typeof param.setValueAtTime === "function" &&
                        audioCtx &&
                        Number.isFinite(audioCtx.currentTime)
                    ) {
                        try {
                            const now = audioCtx.currentTime;
                            param.cancelScheduledValues(now);
                            if (rampSeconds > 0 && typeof param.linearRampToValueAtTime === "function") {
                                param.setValueAtTime(Number.isFinite(param.value) ? param.value : 0, now);
                                param.linearRampToValueAtTime(effectiveVolume, now + rampSeconds);
                            } else {
                                param.setValueAtTime(effectiveVolume, now);
                                param.value = effectiveVolume;
                            }
                        } catch (_) {
                            param.value = effectiveVolume;
                        }
                    } else {
                        param.value = effectiveVolume;
                    }
                }
            } else {
                deck.muted = isMuted;
                deck.volume = effectiveVolume;
            }
        }

        /**
         * Ensures the queue manager always has at least `minQueueSize` (3) upcoming tracks
         * for endless nonstop playback.
         */
        function ensureEndlessQueue(ensureOptions = {}) {
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
            if (!ensureOptions.skipPreload && !crossfadeState.active && refreshed.length > 0) {
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
            if (setDeckSource(standby, nextTrack)) {
                stopStandbyCue({ pauseDeck: true, resetTime: false });
                standby.currentTime = 0;
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

        function makeIdleCrossfadeState(progress = 0) {
            return {
                active: false,
                fromDeckKey: null,
                toDeckKey: null,
                fromTrack: null,
                toTrack: null,
                startedAt: 0,
                durationSeconds: 0,
                incomingStartedAt: null,
                incomingFadeDuration: 0,
                incomingReady: false,
                incomingStartTime: 0,
                outgoingPaused: false,
                outgoingGain: 0,
                incomingGain: 0,
                progress,
                timerId: null,
                cleanupListeners: null,
            };
        }

        function cancelActiveCrossfade(resetOutgoing = true) {
            stopStandbyCue({ pauseDeck: true, resetTime: false });
            if (crossfadeState.timerId && typeof clearInterval === "function") {
                clearInterval(crossfadeState.timerId);
            }
            if (typeof crossfadeState.cleanupListeners === "function") {
                try {
                    crossfadeState.cleanupListeners();
                } catch (_) {}
            }
            if (crossfadeState.active && resetOutgoing && crossfadeState.fromDeckKey) {
                const outgoingDeck = crossfadeState.fromDeckKey === "A" ? deckA : deckB;
                try {
                    outgoingDeck.pause();
                    outgoingDeck.currentTime = 0;
                } catch (_) {}
                applyDeckGain(crossfadeState.fromDeckKey, 0);
            }
            crossfadeState = makeIdleCrossfadeState(0);
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
            crossfadeState.outgoingGain = gains.outgoingGain;
            crossfadeState.incomingGain = gains.incomingGain;

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
            if (typeof crossfadeState.cleanupListeners === "function") {
                try {
                    crossfadeState.cleanupListeners();
                } catch (_) {}
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

            crossfadeState = makeIdleCrossfadeState(1);

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
                const pendingKey = nextTrack.id || "__pending__";
                pendingCrossfadeTrackId = pendingKey;
                resolveTrackUrlThen(
                    nextTrack,
                    () => {
                        if (pendingCrossfadeTrackId === pendingKey) {
                            pendingCrossfadeTrackId = null;
                        }
                        return beginCrossfade(nextTrack, optionsOverride);
                    },
                    { reason: "crossfade" }
                ).then((res) => {
                    if (!res && pendingCrossfadeTrackId === pendingKey) {
                        pendingCrossfadeTrackId = null;
                    }
                });
                return null;
            }
            pendingCrossfadeTrackId = null;

            const fadeDuration = clamp(
                Number(optionsOverride.durationSeconds ?? crossfadeSeconds),
                MIN_CROSSFADE_SECONDS,
                MAX_CROSSFADE_SECONDS
            );
            const incomingFadeDuration = clamp(
                Number(optionsOverride.incomingDurationSeconds ?? fadeDuration),
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

            const fromKey = activeDeckKey;
            const toKey = activeDeckKey === "A" ? "B" : "A";
            const outgoingDeck = fromKey === "A" ? deckA : deckB;
            const incomingDeck = toKey === "A" ? deckA : deckB;
            const outgoingTrack = activeTrack;

            // Stop any active standby cue scan cleanly and restore normal playback rate
            const wasMidCueForThisTrack =
                standbyCueState.active &&
                standbyCueState.deckKey === toKey &&
                standbyCueState.trackId === nextTrack.id;
            stopStandbyCue({ pauseDeck: false, resetTime: false });

            const srcChanged = setDeckSource(incomingDeck, nextTrack);
            const cachedCue = getLeadingCueSeconds(nextTrack);
            const targetStart =
                cachedCue !== null
                    ? cachedCue
                    : wasMidCueForThisTrack && !srcChanged
                      ? clamp(Number(incomingDeck.currentTime || 0), 0, silenceOptions.maxLeadingTrimSeconds)
                      : 0;
            if (srcChanged || Math.abs(Number(incomingDeck.currentTime || 0) - targetStart) > 0.15) {
                incomingDeck.currentTime = targetStart;
            }
            resetTrailingSilenceState(nextTrack.id);

            // Initialize Web Audio after incomingDeck.src is set so createMediaElementSource
            // is never bound to an empty-src deck, and resume a suspended AudioContext.
            initWebAudioGraph();
            ensureDeckWebAudioSource(fromKey);
            ensureDeckWebAudioSource(toKey);
            resumeAudioContextIfNeeded();

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

            // On real browsers (where HTMLMediaElement.readyState is defined), wait until the
            // incoming deck actually begins playing audio before starting its fade-in clock.
            // Otherwise, buffering/seeking latency consumes the fade window and the incoming track
            // slams in at 100% volume as soon as its first audio frames arrive.
            const hasMediaReadyState = Number.isFinite(Number(incomingDeck.readyState));
            const nowMs = Date.now();
            crossfadeState = {
                active: true,
                fromDeckKey: fromKey,
                toDeckKey: toKey,
                fromTrack: outgoingTrack,
                toTrack: nextTrack,
                startedAt: nowMs,
                durationSeconds: fadeDuration,
                incomingStartedAt: hasMediaReadyState ? null : nowMs,
                incomingFadeDuration: incomingFadeDuration > 0 ? incomingFadeDuration : fadeDuration,
                incomingReady: !hasMediaReadyState,
                incomingStartTime: Number(incomingDeck.currentTime || targetStart || 0),
                outgoingPaused: false,
                outgoingGain: 1,
                incomingGain: 0,
                progress: 0,
                timerId: null,
                cleanupListeners: null,
            };

            applyDeckGain(fromKey, 1);
            applyDeckGain(toKey, 0);

            if (hasMediaReadyState && typeof incomingDeck.addEventListener === "function") {
                const markIncomingPlaying = () => {
                    if (!crossfadeState.active || crossfadeState.toDeckKey !== toKey) return;
                    if (!crossfadeState.incomingReady) {
                        crossfadeState.incomingReady = true;
                        crossfadeState.incomingStartedAt = Date.now();
                    }
                };
                incomingDeck.addEventListener("playing", markIncomingPlaying);
                crossfadeState.cleanupListeners = () => {
                    if (typeof incomingDeck.removeEventListener === "function") {
                        incomingDeck.removeEventListener("playing", markIncomingPlaying);
                    }
                };
            }

            if (storage && typeof storage.recordPlayStart === "function") {
                storage.recordPlayStart(nextTrack.id);
            }

            const playPromise = incomingDeck.play();
            if (playPromise && typeof playPromise.catch === "function") {
                playPromise.catch((err) => {
                    // Retry once on canplay if an overlapping preload load() caused an AbortError
                    if (
                        err &&
                        err.name === "AbortError" &&
                        typeof incomingDeck.addEventListener === "function"
                    ) {
                        const retryPlay = () => {
                            if (typeof incomingDeck.removeEventListener === "function") {
                                incomingDeck.removeEventListener("canplay", retryPlay);
                            }
                            if (activeDeckKey === toKey && activeTrack && activeTrack.id === nextTrack.id) {
                                const retry = incomingDeck.play();
                                if (retry && typeof retry.catch === "function") retry.catch(() => {});
                            }
                        };
                        incomingDeck.addEventListener("canplay", retryPlay);
                    }
                });
            }

            // Start the automatic crossfade curve timer BEFORE notifying UI listeners so an
            // exception in a UI callback can never leave the incoming deck stranded at gain 0.
            if (!optionsOverride.manualStep && typeof setInterval === "function") {
                const stepIntervalMs = 50;
                const rampSec = 0.045;
                const stallTimeoutSec = Math.max(fadeDuration * 2, 8);
                crossfadeState.timerId = setInterval(() => {
                    if (!crossfadeState.active) return;
                    const tickNow = Date.now();
                    const outgoingElapsed = (tickNow - crossfadeState.startedAt) / 1000;
                    const outgoingProgress = clamp(outgoingElapsed / fadeDuration, 0, 1);

                    // Latch incoming fade-in start once audio frames are actually advancing
                    if (
                        !crossfadeState.incomingReady &&
                        !incomingDeck.paused &&
                        !incomingDeck.seeking &&
                        Number(incomingDeck.readyState) >= 3 &&
                        Number(incomingDeck.currentTime || 0) > crossfadeState.incomingStartTime + 0.01
                    ) {
                        crossfadeState.incomingReady = true;
                        crossfadeState.incomingStartedAt = tickNow;
                    }

                    // Safety valve if incoming deck stalls indefinitely: finish cleanly rather than hanging
                    if (!crossfadeState.incomingReady && outgoingElapsed >= stallTimeoutSec) {
                        completeCrossfade();
                        return;
                    }

                    const incomingProgress = crossfadeState.incomingReady
                        ? clamp(
                              (tickNow - crossfadeState.incomingStartedAt) /
                                  1000 /
                                  crossfadeState.incomingFadeDuration,
                              0,
                              1
                          )
                        : 0;

                    const outgoingGain = computeCrossfadeGains(outgoingProgress).outgoingGain;
                    const incomingGain = computePerceptualFadeInGain(incomingProgress);

                    crossfadeState.outgoingGain = outgoingGain;
                    crossfadeState.incomingGain = incomingGain;
                    crossfadeState.progress = roundTo(Math.min(outgoingProgress, incomingProgress));

                    if (outgoingProgress >= 1 && !crossfadeState.outgoingPaused) {
                        crossfadeState.outgoingPaused = true;
                        try {
                            outgoingDeck.pause();
                            outgoingDeck.currentTime = 0;
                        } catch (_) {}
                        applyDeckGain(crossfadeState.fromDeckKey, 0);
                    } else if (!crossfadeState.outgoingPaused) {
                        applyDeckGain(crossfadeState.fromDeckKey, outgoingGain, { rampSeconds: rampSec });
                    }

                    if (incomingProgress === 0) {
                        applyDeckGain(crossfadeState.toDeckKey, 0);
                    } else {
                        applyDeckGain(crossfadeState.toDeckKey, incomingGain, { rampSeconds: rampSec });
                    }

                    emit("crossfade-step", {
                        progress: crossfadeState.progress,
                        outgoingProgress: roundTo(outgoingProgress),
                        incomingProgress: roundTo(incomingProgress),
                        outgoingGain,
                        incomingGain,
                        fromTrack: crossfadeState.fromTrack,
                        toTrack: crossfadeState.toTrack,
                        fromDeck: crossfadeState.fromDeckKey,
                        toDeck: crossfadeState.toDeckKey,
                    });

                    if (outgoingProgress >= 1 && incomingProgress >= 1) {
                        completeCrossfade();
                    }
                }, stepIntervalMs);
                if (
                    crossfadeState.timerId &&
                    typeof crossfadeState.timerId.unref === "function"
                ) {
                    crossfadeState.timerId.unref();
                }
            }

            if (typeof options.onTrackChange === "function") {
                try {
                    options.onTrackChange(nextTrack, {
                        previousTrack: outgoingTrack,
                        activeDeck: getActiveDeck(),
                        activeDeckKey,
                        crossfading: true,
                        crossfadeDuration: fadeDuration,
                    });
                } catch (_) {
                    // Never allow a UI listener failure to interrupt crossfade progression
                }
            }

            syncMediaSession(nextTrack, "playing");
            ensureEndlessQueue();

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

            pendingCrossfadeTrackId = null;
            cancelActiveCrossfade(true);

            // If the track was already preloaded on the standby deck, swap to the standby deck for zero-gap start
            const standby = getStandbyDeck();
            const isPreloadedOnStandby =
                playOptions.useStandbyDeck ||
                (preloadedTrack &&
                    preloadedTrack.id === track.id &&
                    isDeckLoadedWithUrl(standby, track.audioUrl));

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
            setDeckSource(deck, track);
            deck.currentTime = 0;

            const previousTrack = activeTrack;
            activeTrack = track;
            preloadedTrack = null;
            resetTrailingSilenceState(track.id);

            const shouldPlay = playOptions.autoplay !== false && !playOptions.pause;
            if (shouldPlay) {
                initWebAudioGraph();
                ensureDeckWebAudioSource(activeDeckKey);
                resumeAudioContextIfNeeded();
                applyDeckGain(activeDeckKey, 1);
                if (storage && typeof storage.recordPlayStart === "function") {
                    storage.recordPlayStart(track.id);
                }
                const playPromise = deck.play();
                if (playPromise && typeof playPromise.catch === "function") {
                    playPromise.catch(() => {});
                }
                syncMediaSession(track, "playing");
            } else {
                applyDeckGain(activeDeckKey, 1);
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

            if (isRepeat || crossfadeState.active || pendingCrossfadeTrackId) {
                return { action: "none", remainingSeconds };
            }

            // Trigger crossfade when entering the [0, crossfadeSeconds] window at the end of a track,
            // or earlier if sustained trailing silence is detected in the final watch window.
            if (crossfadeSeconds > 0 && remainingSeconds > 0 && !deck.paused) {
                // Silently cue the preloaded standby deck past any leading silence before crossfade starts
                maybeCueStandbyDeck(remainingSeconds);

                const inStandardWindow =
                    remainingSeconds <= crossfadeSeconds && duration > crossfadeSeconds + 2;
                const trailingSilenceDetected =
                    !inStandardWindow &&
                    duration > crossfadeSeconds + 2 &&
                    shouldTriggerTrailingSilenceCrossfade(remainingSeconds, duration);

                if (inStandardWindow || trailingSilenceDetected) {
                    const nextTrack = pullNextTrackFromQueue();
                    if (nextTrack) {
                        const targetFadeDuration = trailingSilenceDetected
                            ? Math.min(crossfadeSeconds, remainingSeconds, TRAILING_SILENCE_FADE_CAP_SECONDS)
                            : Math.min(crossfadeSeconds, remainingSeconds);
                        const incomingFadeDuration = trailingSilenceDetected
                            ? Math.min(crossfadeSeconds, TRAILING_SILENCE_INCOMING_FADE_CAP_SECONDS)
                            : targetFadeDuration;
                        const fadeResult = beginCrossfade(nextTrack, {
                            durationSeconds: targetFadeDuration,
                            incomingDurationSeconds: incomingFadeDuration,
                        });
                        return {
                            action: "crossfade",
                            reason: trailingSilenceDetected ? "trailing-silence" : "window",
                            remainingSeconds,
                            nextTrack,
                            fadeResult,
                        };
                    }
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
                // Replenish queue without overwriting the standby deck that is about to play nextTrack
                ensureEndlessQueue({ skipPreload: true });
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
            ensureDeckWebAudioSource(activeDeckKey);
            resumeAudioContextIfNeeded();
            if (!crossfadeState.active) {
                applyDeckGain(activeDeckKey, 1);
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
            trailingSilenceState.silentSinceMs = null;
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
            trailingSilenceState.silentSinceMs = null;
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
                applyDeckGain(crossfadeState.fromDeckKey, crossfadeState.outgoingGain);
                applyDeckGain(crossfadeState.toDeckKey, crossfadeState.incomingGain);
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
                applyDeckGain(crossfadeState.fromDeckKey, crossfadeState.outgoingGain);
                applyDeckGain(crossfadeState.toDeckKey, crossfadeState.incomingGain);
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
                crossfadeState: {
                    ...crossfadeState,
                    timerId: Boolean(crossfadeState.timerId),
                    cleanupListeners: undefined,
                },
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
            SILENCE_RMS_THRESHOLD,
            TRAILING_SILENCE_HOLD_MS,
            MAX_LEADING_TRIM_SECONDS,
            computeCrossfadeGains,
            computeRmsFromSamples,
            getLeadingCueSeconds,
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
        SILENCE_RMS_THRESHOLD,
        TRAILING_SILENCE_HOLD_MS,
        MAX_LEADING_TRIM_SECONDS,
        computeCrossfadeGains,
        computeRmsFromSamples,
        isEditableTarget,
        createPlayerEngine,
        ...defaultPlayer,
    };
});
