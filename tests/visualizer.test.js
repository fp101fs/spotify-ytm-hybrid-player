const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const Stage = require(path.join(ROOT, "visualizer.js"));
const { createPlayerEngine } = require(path.join(ROOT, "player.js"));

/** A 2D context that accepts every call and records how many things were drawn. */
function fakeCanvas() {
    const calls = { fill: 0, fillRect: 0, stroke: 0 };
    const gradient = { addColorStop() {} };
    const ctx = new Proxy(
        {},
        {
            get(target, prop) {
                if (prop in target) return target[prop];
                if (prop === "createLinearGradient" || prop === "createRadialGradient") return () => gradient;
                return (...args) => {
                    if (prop in calls) calls[prop] += 1;
                    return args;
                };
            },
            set(target, prop, value) {
                target[prop] = value;
                return true;
            },
        }
    );
    return { canvas: { width: 0, height: 0, getContext: () => ctx }, calls };
}

test("visualizer: Pulseon's five looks, Bars first (the default)", () => {
    assert.deepStrictEqual(
        Stage.PULSEON_LOOKS.map((l) => l.label),
        ["Bars", "Circle", "Waveform", "Particles", "Galaxy"]
    );
    assert.strictEqual(Stage.DEFAULT_LOOK, "pulseon:spectrum");
});

test("visualizer: every Pulseon look renders loud and silent frames at phone and desktop sizes", () => {
    const loud = new Uint8Array(1024).map((_, i) => 255 - (i % 200));
    const loudWave = new Uint8Array(1024).map((_, i) => 128 + Math.round(100 * Math.sin(i / 10)));
    const silent = new Uint8Array(1024);
    const flat = new Uint8Array(1024).fill(128);
    for (const [w, h] of [
        [343, 193],
        [960, 520],
    ]) {
        const { canvas, calls } = fakeCanvas();
        const renderer = Stage.createPulseonRenderer(canvas);
        renderer.resize(w, h, 2);
        assert.strictEqual(canvas.width, w * 2);
        assert.strictEqual(canvas.height, h * 2);
        for (const look of Stage.PULSEON_LOOKS) {
            const mode = look.id.slice("pulseon:".length);
            for (let i = 0; i < 3; i++) renderer.render(loud, loudWave, mode);
            renderer.render(silent, flat, mode);
        }
        assert.ok(calls.fill + calls.fillRect + calls.stroke > 100, "drew something");
    }
});

test("visualizer: init() is a no-op without the stage markup (tests, old pages)", () => {
    assert.strictEqual(Stage.init({}), null);
});

test("player: getVisualizerTap is null until the Web Audio graph exists", () => {
    const deck = { src: "", paused: true, currentTime: 0, duration: 0, volume: 1, addEventListener() {}, removeEventListener() {}, pause() {}, load() {} };
    const engine = createPlayerEngine({ primaryAudio: deck, secondaryAudio: { ...deck } });
    assert.strictEqual(typeof engine.getVisualizerTap, "function");
    assert.strictEqual(engine.getVisualizerTap(), null);
});

test("HTML/CSS: header row 2, stage overlay controls, Up Next rows never overflow", () => {
    const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
    const css = fs.readFileSync(path.join(ROOT, "style.css"), "utf8");
    // Start Mix / Settings / Up Next stay named when they go icon-only on phones
    assert.match(html, /id="header-start-mix-btn"[^>]*aria-label="Start Mix"/);
    assert.match(html, /id="toggle-drawer-btn"[^>]*aria-label="Up Next"/);
    assert.match(css, /\.rt \{[^}]*flex: 1 0 100%/);
    assert.match(css, /\.mood-chips-bar \{[^}]*inset-block-start: var\(--navbar-height/);
    // Queue titles shrink and clamp instead of spilling out of the row
    assert.match(css, /\.queue-item-title \{[^}]*min-inline-size: 0[^}]*-webkit-line-clamp: 2/);
    assert.match(css, /\.queue-item-meta \{[^}]*overflow: hidden/);
    // Bundled third-party code keeps its licenses
    for (const f of ["vendor/butterchurn/butterchurn.min.js", "vendor/butterchurn/butterchurnPresets.min.js", "vendor/butterchurn/LICENSE-butterchurn", "vendor/pulseon/LICENSE"]) {
        assert.ok(fs.existsSync(path.join(ROOT, f)), f);
    }
});
