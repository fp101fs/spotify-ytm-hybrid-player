/**
 * Visualizer stage: the panel above the main view that shows a music visualizer by default, or the
 * YouTube music video when the playbar switch is on the video side (script.js decides which).
 *
 * - Looks: Pulseon's five canvas modes, ported from https://github.com/independent-coder/Pulseon
 *   (MIT, see vendor/pulseon/LICENSE), plus 100 MilkDrop presets rendered by butterchurn
 *   (MIT, vendor/butterchurn/), which load from this site the first time a MilkDrop look is picked.
 * - Audio: reads the player's shared AnalyserNode (`getVisualizerTap()` in player.js). It's built on
 *   first play; Safari plays without Web Audio, so there the visualizer animates without reacting.
 * - Chrome: auto-hiding overlay controls (look picker, play/pause, fullscreen, floating window, close),
 *   tap or click to cycle looks, fullscreen, and a draggable, resizable floating picture-in-picture.
 *
 * Exposes `window.SpotTubeStage.init(options)`; the instance is also kept at `SpotTubeStage.instance`.
 */
(function (root, factory) {
    const api = factory(root);
    if (typeof module === "object" && module.exports) module.exports = api;
    if (root) root.SpotTubeStage = api;
})(typeof window !== "undefined" ? window : globalThis, function (root) {
    "use strict";

    const PULSEON_LOOKS = [
        { id: "pulseon:spectrum", label: "Bars" },
        { id: "pulseon:circular", label: "Circle" },
        { id: "pulseon:waveform", label: "Waveform" },
        { id: "pulseon:particles", label: "Particles" },
        { id: "pulseon:galaxy", label: "Galaxy" },
    ];
    const DEFAULT_LOOK = PULSEON_LOOKS[0].id;
    const MILKDROP_PREFIX = "milkdrop:";
    const MILKDROP_LOAD = "milkdrop:*";
    const LOOK_KEY = "spottube-visualizer-look";
    const PIP_KEY = "spottube-stage-pip";
    const HIDE_DELAY_MS = 2600;
    const DRAG_THRESHOLD_PX = 6;
    const PIP_MIN_WIDTH = 200;
    const MAX_GL_PIXELS = 1600000; // keeps MilkDrop smooth on big or high-DPI screens

    function safeGet(key) {
        try {
            return root.localStorage ? root.localStorage.getItem(key) : null;
        } catch (_) {
            return null;
        }
    }

    function safeSet(key, value) {
        try {
            if (root.localStorage) root.localStorage.setItem(key, value);
        } catch (_) {}
    }

    function clamp(value, min, max) {
        return Math.min(Math.max(value, min), max);
    }

    // ---------- Pulseon renderer (Canvas 2D) ----------

    function createPulseonRenderer(canvas) {
        const ctx = canvas.getContext("2d");
        const saturation = 80; // Pulseon's colorSaturation 0.8
        let w = 1;
        let h = 1;
        let dpr = 1;
        let scale = 1; // Pulseon's sizes were tuned for a ~600px tall canvas
        let time = 0;
        let stars = [];
        let particles = [];
        let bass = 0;
        let mid = 0;
        let treble = 0;
        let overall = 0;

        function resize(cssWidth, cssHeight, ratio) {
            dpr = ratio;
            w = Math.max(1, Math.round(cssWidth * dpr));
            h = Math.max(1, Math.round(cssHeight * dpr));
            canvas.width = w;
            canvas.height = h;
            scale = Math.max(0.35, Math.min(w, h) / (600 * dpr)) * dpr;
            stars = Array.from({ length: 100 }, () => ({
                x: Math.random() * w,
                y: Math.random() * h,
                size: (Math.random() * 2 + 0.5) * dpr,
                brightness: Math.random() * 0.5 + 0.5,
                twinkleSpeed: Math.random() * 0.02 + 0.01,
            }));
            particles = [];
            ctx.fillStyle = "#05050f";
            ctx.fillRect(0, 0, w, h);
        }

        function updateIntensities(freq) {
            const len = freq.length;
            const bassEnd = Math.max(1, Math.floor(len * 0.1));
            const midEnd = Math.floor(len * 0.4);
            let bassSum = 0;
            let midSum = 0;
            let trebleSum = 0;
            for (let i = 0; i < bassEnd; i++) bassSum += freq[i];
            for (let i = bassEnd; i < midEnd; i++) midSum += freq[i];
            for (let i = midEnd; i < len; i++) trebleSum += freq[i];
            bass = bassSum / bassEnd / 255;
            mid = midSum / Math.max(1, midEnd - bassEnd) / 255;
            treble = trebleSum / Math.max(1, len - midEnd) / 255;
            overall = (bass + mid + treble) / 3;
        }

        function updateParticles() {
            if (overall > 0.3 && particles.length < 150) {
                const count = Math.floor(overall * 5);
                for (let i = 0; i < count; i++) {
                    particles.push({
                        x: w / 2 + (Math.random() - 0.5) * 100 * scale,
                        y: h / 2 + (Math.random() - 0.5) * 100 * scale,
                        vx: (Math.random() - 0.5) * overall * 10 * scale,
                        vy: (Math.random() - 0.5) * overall * 10 * scale,
                        size: (Math.random() * 3 + 1) * dpr,
                        life: 1,
                        hue: Math.random() * 360,
                        brightness: Math.random() * 0.5 + 0.5,
                    });
                }
            }
            particles = particles.filter((p) => {
                p.x += p.vx;
                p.y += p.vy;
                p.life -= 0.01;
                p.vx *= 0.98;
                p.vy *= 0.98;
                return p.life > 0 && p.x > 0 && p.x < w && p.y > 0 && p.y < h;
            });
        }

        function drawBackground() {
            for (const star of stars) {
                const twinkle = Math.sin(time * star.twinkleSpeed) * 0.5 + 0.5;
                ctx.fillStyle = `rgba(255, 255, 255, ${star.brightness * twinkle * 0.8})`;
                ctx.beginPath();
                ctx.arc(star.x, star.y, star.size, 0, Math.PI * 2);
                ctx.fill();
            }
            const gradient = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
            gradient.addColorStop(0, `hsla(${(time * 20) % 360}, 70%, 20%, 0.1)`);
            gradient.addColorStop(1, "rgba(5, 5, 15, 0.3)");
            ctx.fillStyle = gradient;
            ctx.fillRect(0, 0, w, h);
        }

        // The top quarter of a 2048-point FFT is above ~16 kHz and nearly always empty in music,
        // so the bar and circle looks spread the lower 75% of bins across the screen.
        function usableBins(freq) {
            return Math.max(1, Math.floor(freq.length * 0.75));
        }

        function drawSpectrumBars(freq) {
            const bins = usableBins(freq);
            const barCount = w / dpr < 420 ? 64 : 128;
            const barWidth = w / barCount;
            const gap = Math.min(2 * dpr, barWidth * 0.3);
            for (let i = 0; i < barCount; i++) {
                const value = freq[Math.floor((i * bins) / barCount)] / 255;
                const barHeight = value * h * 0.7;
                const x = i * barWidth;
                const y = h - barHeight;
                const hue = ((i / barCount) * 360 + time * 50) % 360;
                const gradient = ctx.createLinearGradient(x, y, x, h);
                gradient.addColorStop(0, `hsla(${hue}, ${saturation}%, 60%, 0.9)`);
                gradient.addColorStop(0.5, `hsla(${hue + 30}, ${saturation}%, 50%, 0.7)`);
                gradient.addColorStop(1, `hsla(${hue + 60}, ${saturation}%, 40%, 0.5)`);
                ctx.fillStyle = gradient;
                ctx.fillRect(x + gap / 2, y, barWidth - gap, barHeight);
                if (value > 0.7) {
                    ctx.shadowBlur = 20 * dpr;
                    ctx.shadowColor = `hsla(${hue}, 100%, 60%, ${value})`;
                    ctx.fillRect(x + gap / 2, y, barWidth - gap, barHeight);
                    ctx.shadowBlur = 0;
                }
            }
        }

        function drawCircularSpectrum(freq) {
            const bins = usableBins(freq);
            const cx = w / 2;
            const cy = h / 2;
            const radius = Math.min(cx, cy) * 0.3;
            const barCount = 180;
            const step = (Math.PI * 2) / barCount;
            ctx.lineCap = "round";
            for (let i = 0; i < barCount; i++) {
                const angle = step * i - Math.PI / 2;
                const value = freq[Math.floor((i * bins) / barCount)] / 255;
                const barHeight = value * radius * 2;
                const x1 = cx + Math.cos(angle) * radius;
                const y1 = cy + Math.sin(angle) * radius;
                const x2 = cx + Math.cos(angle) * (radius + barHeight);
                const y2 = cy + Math.sin(angle) * (radius + barHeight);
                const hue = ((i / barCount) * 360 + time * 50) % 360;
                const gradient = ctx.createLinearGradient(x1, y1, x2, y2);
                gradient.addColorStop(0, `hsla(${hue}, ${saturation}%, 50%, 0.8)`);
                gradient.addColorStop(1, `hsla(${hue + 60}, ${saturation}%, 70%, 1)`);
                ctx.strokeStyle = gradient;
                ctx.lineWidth = (2 + value * 3) * dpr;
                ctx.beginPath();
                ctx.moveTo(x1, y1);
                ctx.lineTo(x2, y2);
                ctx.stroke();
            }
            const core = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius);
            core.addColorStop(0, `hsla(${(time * 50) % 360}, 80%, 60%, 0.3)`);
            core.addColorStop(1, "rgba(255, 255, 255, 0.1)");
            ctx.fillStyle = core;
            ctx.beginPath();
            ctx.arc(cx, cy, radius * 0.8, 0, Math.PI * 2);
            ctx.fill();
        }

        function drawWaveform(wave) {
            const len = wave.length;
            const slice = w / len;
            for (let layer = 0; layer < 3; layer++) {
                ctx.beginPath();
                ctx.lineWidth = (3 - layer) * dpr;
                ctx.strokeStyle = `hsla(${(time * 30 + layer * 120) % 360}, ${saturation}%, 60%, ${0.7 - layer * 0.2})`;
                let x = 0;
                for (let i = 0; i < len; i++) {
                    const y = ((wave[i] / 128) * h) / 2 + (layer - 1) * overall * 50 * scale;
                    if (i === 0) ctx.moveTo(x, y);
                    else ctx.lineTo(x, y);
                    x += slice;
                }
                ctx.stroke();
            }
        }

        function drawParticleLook(freq) {
            const len = freq.length;
            const cx = w / 2;
            const cy = h / 2;
            for (let i = 0; i < len; i += 4) {
                const value = freq[i] / 255;
                if (value <= 0.1) continue;
                const angle = (i / len) * Math.PI * 2 + time;
                const distance = (100 + value * 200) * scale;
                const hue = ((i / len) * 360 + time * 50) % 360;
                ctx.shadowBlur = 20 * dpr;
                ctx.shadowColor = `hsla(${hue}, 100%, 60%, ${value})`;
                ctx.fillStyle = `hsla(${hue}, ${saturation}%, 60%, ${value})`;
                ctx.beginPath();
                ctx.arc(cx + Math.cos(angle) * distance, cy + Math.sin(angle) * distance, (2 + value * 8) * dpr, 0, Math.PI * 2);
                ctx.fill();
            }
            ctx.shadowBlur = 0;
        }

        function drawGalaxy(freq) {
            const len = freq.length;
            const cx = w / 2;
            const cy = h / 2;
            for (let i = 0; i < len; i += 2) {
                const value = freq[i] / 255;
                const angle = (i / len) * Math.PI * 4 + time;
                const distance = ((i / len) * 300 + value * 100) * scale;
                const hue = ((i / len) * 360 + time * 30 + distance * 0.5) % 360;
                ctx.fillStyle = `hsla(${hue}, ${saturation}%, 70%, ${value * 0.8})`;
                ctx.beginPath();
                ctx.arc(cx + Math.cos(angle) * distance, cy + Math.sin(angle) * distance, (1 + value * 4) * dpr, 0, Math.PI * 2);
                ctx.fill();
            }
            const r = 100 * scale;
            const core = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
            core.addColorStop(0, `hsla(${(time * 40) % 360}, 100%, 80%, ${overall})`);
            core.addColorStop(0.5, `hsla(${(time * 40 + 180) % 360}, 80%, 60%, ${overall * 0.5})`);
            core.addColorStop(1, "rgba(255, 255, 255, 0)");
            ctx.fillStyle = core;
            ctx.beginPath();
            ctx.arc(cx, cy, r, 0, Math.PI * 2);
            ctx.fill();
        }

        function drawParticles() {
            for (const p of particles) {
                ctx.globalAlpha = p.life;
                ctx.shadowBlur = 10 * dpr;
                ctx.shadowColor = `hsla(${p.hue}, 100%, 60%, ${p.life})`;
                ctx.fillStyle = `hsla(${p.hue}, ${saturation}%, 60%, ${p.life * p.brightness})`;
                ctx.beginPath();
                ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
                ctx.fill();
            }
            ctx.shadowBlur = 0;
            ctx.globalAlpha = 1;
        }

        function applyBloom() {
            ctx.globalCompositeOperation = "screen";
            ctx.globalAlpha = 0.45; // 0.3 * Pulseon's glowIntensity 1.5
            const hue = (time * 20) % 360;
            const gradient = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
            gradient.addColorStop(0, `hsla(${hue}, 100%, 50%, ${overall * 0.5})`);
            gradient.addColorStop(0.5, `hsla(${hue + 60}, 80%, 40%, ${overall * 0.3})`);
            gradient.addColorStop(1, "rgba(255, 255, 255, 0)");
            ctx.fillStyle = gradient;
            ctx.fillRect(0, 0, w, h);
            ctx.globalCompositeOperation = "source-over";
            ctx.globalAlpha = 1;
        }

        function render(freq, wave, mode) {
            time += 0.016;
            ctx.fillStyle = "rgba(5, 5, 15, 0.1)"; // trail effect
            ctx.fillRect(0, 0, w, h);
            updateIntensities(freq);
            updateParticles();
            drawBackground();
            if (mode === "circular") drawCircularSpectrum(freq);
            else if (mode === "waveform") drawWaveform(wave);
            else if (mode === "particles") drawParticleLook(freq);
            else if (mode === "galaxy") drawGalaxy(freq);
            else drawSpectrumBars(freq);
            drawParticles();
            applyBloom();
        }

        return { resize, render };
    }

    // ---------- butterchurn (MilkDrop, WebGL 2) ----------

    let butterchurnLoad = null;

    function loadScript(src) {
        return new Promise((resolve, reject) => {
            const script = root.document.createElement("script");
            script.src = src;
            script.async = true;
            script.onload = () => resolve();
            script.onerror = () => reject(new Error(`Couldn't load ${src}`));
            root.document.head.appendChild(script);
        });
    }

    function supportsWebGL2() {
        try {
            return Boolean(root.document.createElement("canvas").getContext("webgl2"));
        } catch (_) {
            return false;
        }
    }

    function loadButterchurn(base) {
        if (butterchurnLoad) return butterchurnLoad;
        butterchurnLoad = (async () => {
            if (!supportsWebGL2()) {
                throw Object.assign(new Error("MilkDrop looks need WebGL 2, which this browser doesn't have."), { code: "NO_WEBGL2" });
            }
            if (!root.butterchurn) await loadScript(`${base}butterchurn.min.js`);
            if (!root.butterchurnPresets) await loadScript(`${base}butterchurnPresets.min.js`);
            const lib = root.butterchurn && (root.butterchurn.default || root.butterchurn);
            const presetsModule = root.butterchurnPresets && (root.butterchurnPresets.default || root.butterchurnPresets);
            if (!lib || typeof lib.createVisualizer !== "function" || !presetsModule) throw new Error("MilkDrop didn't load.");
            const presets = presetsModule.getPresets();
            const names = Object.keys(presets).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
            return { lib, presets, names };
        })();
        butterchurnLoad.catch((err) => {
            // A network hiccup can be retried; a browser without WebGL 2 can't
            if (!err || err.code !== "NO_WEBGL2") butterchurnLoad = null;
        });
        return butterchurnLoad;
    }

    // ---------- visualizer engine ----------

    function createVisualizer({ canvas2d, canvasGl, getTap, vendorBase, onLooksChanged, onLookChanged, onMessage }) {
        const pulseon = createPulseonRenderer(canvas2d);
        let look = DEFAULT_LOOK;
        let lastPulseonMode = "spectrum";
        let running = false;
        let rafId = 0;
        let analyser = null;
        let boundNode = null;
        let freq = new Uint8Array(1024);
        let wave = new Uint8Array(1024).fill(128);
        let bc = null;
        let bcContext = null;
        let bcNode = null;
        let bcPresetName = null;
        let silentContext = null;
        let milkdrop = { state: "idle", lib: null, presets: null, names: [], error: "" }; // idle | loading | ready | failed
        let glSize = { w: 1, h: 1 };

        function bindTap() {
            const tap = typeof getTap === "function" ? getTap() : null;
            if (!tap || !tap.node || !tap.audioContext) return null;
            if (tap.node !== boundNode) {
                try {
                    analyser = tap.audioContext.createAnalyser();
                    analyser.fftSize = 2048; // Pulseon's resolution
                    analyser.smoothingTimeConstant = 0.85;
                    tap.node.connect(analyser);
                    boundNode = tap.node;
                    freq = new Uint8Array(analyser.frequencyBinCount);
                    wave = new Uint8Array(analyser.frequencyBinCount);
                } catch (_) {
                    analyser = null;
                    boundNode = null;
                }
            }
            return tap;
        }

        function isMilkdrop(id) {
            return typeof id === "string" && id.startsWith(MILKDROP_PREFIX);
        }

        function showCanvas(gl) {
            canvas2d.hidden = gl;
            if (canvasGl) canvasGl.hidden = !gl;
        }

        function ensureButterchurnInstance() {
            const tap = bindTap();
            let context = tap ? tap.audioContext : bcContext;
            if (!context) {
                // No music has played yet: render MilkDrop on a silent context until the player's exists
                const Ctx = root.AudioContext || root.webkitAudioContext;
                if (!Ctx) return null;
                if (!silentContext) silentContext = new Ctx();
                context = silentContext;
            }
            if (!bc || bcContext !== context) {
                bc = milkdrop.lib.createVisualizer(context, canvasGl, { width: glSize.w, height: glSize.h, pixelRatio: 1, textureRatio: 1 });
                bcContext = context;
                bcNode = null;
                bcPresetName = null;
            }
            if (tap && tap.node !== bcNode) {
                bc.connectAudio(tap.node);
                bcNode = tap.node;
            }
            const wanted = look.slice(MILKDROP_PREFIX.length);
            if (bcPresetName !== wanted && milkdrop.presets[wanted]) {
                bc.loadPreset(milkdrop.presets[wanted], bcPresetName ? 2.0 : 0);
                bcPresetName = wanted;
            }
            return bc;
        }

        function getLooks() {
            const looks = PULSEON_LOOKS.map((l) => ({ ...l, group: "Pulseon" }));
            if (milkdrop.state === "ready") {
                for (const name of milkdrop.names) looks.push({ id: MILKDROP_PREFIX + name, label: name, group: "MilkDrop" });
            } else if (milkdrop.state === "failed" && milkdrop.code === "NO_WEBGL2") {
                looks.push({ id: MILKDROP_LOAD, label: "MilkDrop (needs WebGL 2)", group: "MilkDrop", disabled: true });
            } else {
                looks.push({
                    id: MILKDROP_LOAD,
                    label: milkdrop.state === "loading" ? "Loading MilkDrop presets…" : "MilkDrop presets (100 looks)",
                    group: "MilkDrop",
                });
            }
            return looks;
        }

        function labelFor(id) {
            const found = getLooks().find((l) => l.id === id);
            return found ? found.label : "";
        }

        function loadMilkdrop() {
            if (milkdrop.state === "ready") return Promise.resolve(true);
            milkdrop.state = "loading";
            if (onLooksChanged) onLooksChanged();
            return loadButterchurn(vendorBase).then(
                (result) => {
                    milkdrop = { state: "ready", ...result, error: "" };
                    if (onLooksChanged) onLooksChanged();
                    return true;
                },
                (err) => {
                    milkdrop = { state: "failed", lib: null, presets: null, names: [], error: err.message, code: err.code };
                    if (onLooksChanged) onLooksChanged();
                    if (onMessage) onMessage(err.message);
                    return false;
                }
            );
        }

        function setLook(id, options = {}) {
            if (id === MILKDROP_LOAD) {
                return loadMilkdrop().then((ok) => {
                    if (!ok) return setLook(`pulseon:${lastPulseonMode}`, options);
                    const saved = safeGet(LOOK_KEY);
                    const name = isMilkdrop(saved) && milkdrop.presets[saved.slice(MILKDROP_PREFIX.length)] ? saved : MILKDROP_PREFIX + milkdrop.names[0];
                    return setLook(name, options);
                });
            }
            if (isMilkdrop(id)) {
                if (milkdrop.state !== "ready") {
                    return loadMilkdrop().then((ok) => (ok ? setLook(id, options) : setLook(`pulseon:${lastPulseonMode}`, options)));
                }
                if (!milkdrop.presets[id.slice(MILKDROP_PREFIX.length)]) id = MILKDROP_PREFIX + milkdrop.names[0];
                look = id;
                try {
                    ensureButterchurnInstance();
                    showCanvas(true);
                } catch (err) {
                    if (onMessage) onMessage("This MilkDrop look couldn't start here.");
                    return setLook(`pulseon:${lastPulseonMode}`, options);
                }
            } else {
                const found = PULSEON_LOOKS.find((l) => l.id === id) || PULSEON_LOOKS[0];
                look = found.id;
                lastPulseonMode = look.slice("pulseon:".length);
                showCanvas(false);
            }
            if (options.persist !== false) safeSet(LOOK_KEY, look);
            if (onLookChanged) onLookChanged(look, labelFor(look), options);
            return Promise.resolve(look);
        }

        function cycle(direction) {
            const looks = getLooks().filter((l) => !l.disabled);
            const current = isMilkdrop(look) && milkdrop.state !== "ready" ? MILKDROP_LOAD : look;
            let index = looks.findIndex((l) => l.id === current);
            if (index < 0) index = 0;
            const next = looks[(index + direction + looks.length) % looks.length];
            return setLook(next.id, { announce: true });
        }

        function frame() {
            rafId = root.requestAnimationFrame(frame);
            if (isMilkdrop(look) && milkdrop.state === "ready") {
                try {
                    ensureButterchurnInstance();
                    bc.render();
                    return;
                } catch (_) {
                    if (onMessage) onMessage("This MilkDrop look stopped working, so Bars is back.");
                    setLook(DEFAULT_LOOK);
                }
            }
            bindTap();
            if (analyser) {
                analyser.getByteFrequencyData(freq);
                analyser.getByteTimeDomainData(wave);
            } else {
                freq.fill(0);
                wave.fill(128);
            }
            pulseon.render(freq, wave, isMilkdrop(look) ? lastPulseonMode : look.slice("pulseon:".length));
        }

        function start() {
            if (running || typeof root.requestAnimationFrame !== "function") return;
            running = true;
            rafId = root.requestAnimationFrame(frame);
        }

        function stop() {
            if (!running) return;
            running = false;
            root.cancelAnimationFrame(rafId);
        }

        function resize(cssWidth, cssHeight) {
            if (!cssWidth || !cssHeight) return;
            const ratio = Math.min(root.devicePixelRatio || 1, 2);
            pulseon.resize(cssWidth, cssHeight, ratio);
            if (canvasGl) {
                let gw = Math.round(cssWidth * ratio);
                let gh = Math.round(cssHeight * ratio);
                const over = Math.sqrt((gw * gh) / MAX_GL_PIXELS);
                if (over > 1) {
                    gw = Math.round(gw / over);
                    gh = Math.round(gh / over);
                }
                glSize = { w: gw, h: gh };
                canvasGl.width = gw;
                canvasGl.height = gh;
                if (bc) bc.setRendererSize(gw, gh);
            }
        }

        return {
            start,
            stop,
            resize,
            setLook,
            cycle,
            getLooks,
            getLook: () => look,
            labelFor,
            isRunning: () => running,
        };
    }

    // ---------- stage controller (DOM) ----------

    function init(options = {}) {
        const doc = root.document;
        if (!doc) return null;
        if (api.instance) return api.instance;
        const $ = (id) => doc.getElementById(id);
        const panel = $("yt-video-panel");
        const frame = $("media-stage-frame");
        const canvas2d = $("viz-canvas");
        if (!panel || !frame || !canvas2d || typeof canvas2d.getContext !== "function") return null;
        const canvasGl = $("viz-canvas-gl");
        const select = $("stage-look-select");
        const prevBtn = $("stage-prev-btn");
        const nextBtn = $("stage-next-btn");
        const playBtn = $("stage-play-btn");
        const pipBtn = $("stage-pip-btn");
        const fsBtn = $("yt-video-fullscreen-btn");
        const hint = $("stage-hint");
        const resizeHandle = $("stage-resize-handle");
        const controls = $("stage-controls");

        let mode = "visualizer";
        let visible = !panel.hidden;
        let pip = false;
        let pseudoFullscreen = false;
        let placeholder = null;
        let hideTimer = 0;
        let hintTimer = 0;
        let pointerOverControls = false;
        let press = null;

        const viz = createVisualizer({
            canvas2d,
            canvasGl,
            getTap: options.getTap,
            vendorBase: options.vendorBase || "vendor/butterchurn/",
            onLooksChanged: renderLookOptions,
            onLookChanged(id, label, opts) {
                if (select) select.value = id;
                if (opts && opts.announce && label) showHint(label);
            },
            onMessage: (text) => showHint(text, 3200),
        });

        // ----- look picker -----
        function renderLookOptions() {
            if (!select) return;
            const looks = viz.getLooks();
            const groups = new Map();
            for (const look of looks) {
                if (!groups.has(look.group)) groups.set(look.group, []);
                groups.get(look.group).push(look);
            }
            select.textContent = "";
            for (const [name, items] of groups) {
                const group = doc.createElement("optgroup");
                group.label = name;
                for (const look of items) {
                    const option = doc.createElement("option");
                    option.value = look.id;
                    option.textContent = look.label;
                    option.disabled = Boolean(look.disabled);
                    group.append(option);
                }
                select.append(group);
            }
            const current = viz.getLook();
            select.value = current.startsWith(MILKDROP_PREFIX) && !looks.some((l) => l.id === current) ? MILKDROP_LOAD : current;
        }

        // ----- hint + controls visibility -----
        function showHint(text, ms = 1600) {
            if (!hint || !text) return;
            hint.textContent = text;
            hint.classList.add("is-visible");
            root.clearTimeout(hintTimer);
            hintTimer = root.setTimeout(() => hint.classList.remove("is-visible"), ms);
        }

        function controlsVisible() {
            return frame.classList.contains("controls-visible");
        }

        function keepControlsOpen() {
            const active = doc.activeElement;
            if (!active || !frame.contains(active)) return pointerOverControls;
            if (active === select) return true;
            let keyboard = false;
            try {
                keyboard = active.matches(":focus-visible");
            } catch (_) {}
            return keyboard || pointerOverControls;
        }

        function scheduleHide(ms = HIDE_DELAY_MS) {
            root.clearTimeout(hideTimer);
            hideTimer = root.setTimeout(() => {
                if (keepControlsOpen()) return scheduleHide();
                hideControls();
            }, ms);
        }

        function showControls() {
            frame.classList.add("controls-visible");
            syncPlayState();
            scheduleHide();
        }

        function hideControls() {
            root.clearTimeout(hideTimer);
            frame.classList.remove("controls-visible");
            const active = doc.activeElement;
            if (active && frame.contains(active) && typeof active.blur === "function") active.blur();
        }

        // ----- play / pause (the music) -----
        function syncPlayState() {
            if (!playBtn) return;
            const paused = typeof options.isPaused === "function" ? options.isPaused() : true;
            playBtn.classList.toggle("is-playing", !paused);
            playBtn.setAttribute("aria-label", paused ? "Play" : "Pause");
            playBtn.title = paused ? "Play" : "Pause";
        }

        // ----- fullscreen -----
        function fullscreenElement() {
            return doc.fullscreenElement || doc.webkitFullscreenElement || null;
        }

        function setPseudoFullscreen(on) {
            pseudoFullscreen = on;
            frame.classList.toggle("is-pseudo-fullscreen", on);
            syncFullscreenButton();
            measure();
        }

        function syncFullscreenButton() {
            const on = Boolean(fullscreenElement() === frame || pseudoFullscreen);
            frame.classList.toggle("is-fullscreen", on);
            if (fsBtn) {
                fsBtn.classList.toggle("is-on", on);
                fsBtn.setAttribute("aria-label", on ? "Exit full screen" : "Full screen");
                fsBtn.title = on ? "Exit full screen" : "Full screen";
            }
        }

        function toggleFullscreen() {
            if (fullscreenElement()) {
                const exit = doc.exitFullscreen || doc.webkitExitFullscreen;
                if (exit) {
                    const p = exit.call(doc);
                    if (p && typeof p.catch === "function") p.catch(() => {});
                }
                return true;
            }
            if (pseudoFullscreen) {
                setPseudoFullscreen(false);
                return true;
            }
            const request = frame.requestFullscreen || frame.webkitRequestFullscreen;
            if (request) {
                const p = request.call(frame);
                if (p && typeof p.catch === "function") p.catch(() => setPseudoFullscreen(true));
                return true;
            }
            // iPhone Safari: only a <video> can go truly full screen
            const video = $("yt-video");
            if (mode === "video" && video && typeof video.webkitEnterFullscreen === "function") {
                video.webkitEnterFullscreen();
                return true;
            }
            setPseudoFullscreen(true);
            return true;
        }

        // ----- floating picture-in-picture -----
        function viewport() {
            return { w: root.innerWidth || 1024, h: root.innerHeight || 768 };
        }

        function defaultPipRect() {
            const vp = viewport();
            const width = Math.min(360, vp.w - 24);
            const height = Math.round((width * 9) / 16);
            const playbar = doc.querySelector(".playbar");
            const bottomGap = (playbar ? playbar.getBoundingClientRect().height : 90) + 24;
            return { x: vp.w - width - 16, y: Math.max(8, vp.h - height - bottomGap), w: width };
        }

        function clampPipRect(rect) {
            const vp = viewport();
            const w = clamp(rect.w, Math.min(PIP_MIN_WIDTH, vp.w - 16), vp.w - 16);
            const h = Math.round((w * 9) / 16);
            return { w, x: clamp(rect.x, 8, Math.max(8, vp.w - w - 8)), y: clamp(rect.y, 8, Math.max(8, vp.h - h - 8)) };
        }

        function applyPipRect(rect) {
            const r = clampPipRect(rect);
            frame.style.left = `${r.x}px`;
            frame.style.top = `${r.y}px`;
            frame.style.width = `${r.w}px`;
            frame.style.height = `${Math.round((r.w * 9) / 16)}px`;
            return r;
        }

        function currentPipRect() {
            return { x: frame.offsetLeft, y: frame.offsetTop, w: frame.offsetWidth };
        }

        function savePipRect() {
            safeSet(PIP_KEY, JSON.stringify(currentPipRect()));
        }

        function loadPipRect() {
            try {
                const saved = JSON.parse(safeGet(PIP_KEY) || "null");
                if (saved && [saved.x, saved.y, saved.w].every(Number.isFinite)) return saved;
            } catch (_) {}
            return defaultPipRect();
        }

        function enterPip() {
            if (pip) return;
            if (fullscreenElement()) toggleFullscreen();
            if (pseudoFullscreen) setPseudoFullscreen(false);
            placeholder = doc.createComment("media-stage-frame");
            frame.parentNode.insertBefore(placeholder, frame);
            doc.body.appendChild(frame); // same task, so a playing <video> keeps playing
            pip = true;
            frame.classList.add("is-pip");
            panel.classList.add("is-pip-away");
            applyPipRect(loadPipRect());
            syncPipButton();
            measure();
            showControls();
        }

        function exitPip() {
            if (!pip) return;
            if (placeholder && placeholder.parentNode) {
                placeholder.parentNode.insertBefore(frame, placeholder);
                placeholder.remove();
            }
            placeholder = null;
            pip = false;
            frame.classList.remove("is-pip");
            panel.classList.remove("is-pip-away");
            for (const prop of ["left", "top", "width", "height"]) frame.style[prop] = "";
            syncPipButton();
            measure();
        }

        function syncPipButton() {
            if (!pipBtn) return;
            pipBtn.classList.toggle("is-on", pip);
            pipBtn.setAttribute("aria-label", pip ? "Put back in the page" : "Pop out into a floating window");
            pipBtn.title = pip ? "Put back in the page" : "Pop out into a floating window";
        }

        function togglePip() {
            if (pip) exitPip();
            else enterPip();
            return pip;
        }

        // ----- running state -----
        function measure() {
            const rect = frame.getBoundingClientRect();
            viz.resize(rect.width, rect.height);
        }

        function updateRunning() {
            const shouldRun = visible && mode === "visualizer" && !doc.hidden;
            if (shouldRun) viz.start();
            else viz.stop();
        }

        function sync(state = {}) {
            if (state.mode === "video" || state.mode === "visualizer") mode = state.mode;
            if (typeof state.visible === "boolean") visible = state.visible;
            frame.dataset.mode = mode;
            if (!visible) {
                exitPip();
                if (pseudoFullscreen) setPseudoFullscreen(false);
                if (fullscreenElement() === frame) toggleFullscreen();
            }
            updateRunning();
        }

        // ----- pointer: tap to cycle, drag the floating window -----
        function isControlTarget(target) {
            return Boolean(target && typeof target.closest === "function" && target.closest("button, select, a, input, label, .stage-resize"));
        }

        function canDrag() {
            return pip && !pseudoFullscreen && !fullscreenElement();
        }

        function handleTap(p) {
            if (mode === "visualizer") {
                if (p.type === "mouse") {
                    viz.cycle(1);
                    showControls();
                } else if (!p.controlsWereVisible) {
                    showControls();
                    showHint("Tap again for the next look", 2000);
                } else {
                    viz.cycle(1);
                    showControls();
                }
                return;
            }
            if (p.type !== "mouse" && p.controlsWereVisible) hideControls();
            else showControls();
        }

        frame.addEventListener("pointerdown", (e) => {
            if (e.pointerType === "mouse" && e.button !== 0) return;
            if (isControlTarget(e.target)) return;
            press = {
                id: e.pointerId,
                type: e.pointerType || "mouse",
                x: e.clientX,
                y: e.clientY,
                moved: false,
                controlsWereVisible: controlsVisible(),
                start: canDrag() ? currentPipRect() : null,
            };
            if (press.start && typeof frame.setPointerCapture === "function") {
                try {
                    frame.setPointerCapture(e.pointerId);
                } catch (_) {}
            }
        });

        frame.addEventListener("pointermove", (e) => {
            if (e.pointerType === "mouse" && !press) showControls();
            if (!press || press.id !== e.pointerId) return;
            const dx = e.clientX - press.x;
            const dy = e.clientY - press.y;
            if (!press.moved && Math.hypot(dx, dy) > DRAG_THRESHOLD_PX) press.moved = true;
            if (press.moved && press.start) {
                applyPipRect({ x: press.start.x + dx, y: press.start.y + dy, w: press.start.w });
            }
        });

        frame.addEventListener("pointerup", (e) => {
            if (!press || press.id !== e.pointerId) return;
            const p = press;
            press = null;
            if (p.moved) {
                if (p.start) savePipRect();
                return;
            }
            handleTap(p);
        });

        frame.addEventListener("pointercancel", () => {
            press = null;
        });

        frame.addEventListener("pointerleave", (e) => {
            if (e.pointerType === "mouse" && !press) scheduleHide(700);
        });

        frame.addEventListener("focusin", () => showControls());

        if (controls) {
            controls.addEventListener("pointerenter", (e) => {
                if (e.pointerType === "mouse") pointerOverControls = true;
            });
            controls.addEventListener("pointerleave", () => {
                pointerOverControls = false;
            });
        }

        if (resizeHandle) {
            let resize = null;
            resizeHandle.addEventListener("pointerdown", (e) => {
                if (!pip) return;
                e.preventDefault();
                e.stopPropagation();
                resize = { id: e.pointerId, x: e.clientX, start: currentPipRect() };
                try {
                    resizeHandle.setPointerCapture(e.pointerId);
                } catch (_) {}
            });
            resizeHandle.addEventListener("pointermove", (e) => {
                if (!resize || resize.id !== e.pointerId) return;
                applyPipRect({ x: resize.start.x, y: resize.start.y, w: resize.start.w + (e.clientX - resize.x) });
                measure();
            });
            const end = (e) => {
                if (!resize || resize.id !== e.pointerId) return;
                resize = null;
                savePipRect();
            };
            resizeHandle.addEventListener("pointerup", end);
            resizeHandle.addEventListener("pointercancel", end);
        }

        // ----- buttons -----
        if (prevBtn) prevBtn.addEventListener("click", () => viz.cycle(-1));
        if (nextBtn) nextBtn.addEventListener("click", () => viz.cycle(1));
        if (select) {
            select.addEventListener("change", () => {
                if (select.value === MILKDROP_LOAD) showHint("Loading MilkDrop presets…", 4000);
                viz.setLook(select.value, { announce: true });
            });
        }
        if (playBtn) {
            playBtn.addEventListener("click", () => {
                if (typeof options.togglePlay === "function") options.togglePlay();
                syncPlayState();
            });
        }
        if (pipBtn) pipBtn.addEventListener("click", () => togglePip());
        // The fullscreen button is wired by script.js (requestYouTubeFullscreen delegates here)

        doc.addEventListener("fullscreenchange", () => {
            syncFullscreenButton();
            measure();
        });
        doc.addEventListener("webkitfullscreenchange", () => {
            syncFullscreenButton();
            measure();
        });
        doc.addEventListener("visibilitychange", updateRunning);
        doc.addEventListener("keydown", (e) => {
            if (e.key === "Escape" && pseudoFullscreen) setPseudoFullscreen(false);
        });
        root.addEventListener("resize", () => {
            if (pip) applyPipRect(currentPipRect());
        });
        if (typeof root.ResizeObserver === "function") {
            new root.ResizeObserver(() => measure()).observe(frame);
        } else {
            root.addEventListener("resize", measure);
        }

        // ----- start -----
        renderLookOptions();
        measure();
        const saved = safeGet(LOOK_KEY);
        viz.setLook(saved || DEFAULT_LOOK, { persist: false });
        syncPlayState();
        syncPipButton();
        syncFullscreenButton();
        sync({ mode, visible });

        api.instance = {
            sync,
            toggleFullscreen,
            togglePip,
            exitPip,
            showHint,
            syncPlayState,
            setLook: (id) => viz.setLook(id, { announce: true }),
            cycle: (direction = 1) => viz.cycle(direction),
            getLook: () => viz.getLook(),
            getLooks: () => viz.getLooks(),
            isPip: () => pip,
            isRunning: () => viz.isRunning(),
        };
        return api.instance;
    }

    const api = { init, instance: null, PULSEON_LOOKS, DEFAULT_LOOK, createPulseonRenderer };
    return api;
});
