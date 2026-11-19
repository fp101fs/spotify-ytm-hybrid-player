"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(root, f), "utf8");

test("README starts with a Deploy with Vercel button pointing at the GitHub repo", () => {
    const readme = read("README.md");
    const firstLines = readme.split("\n").slice(0, 5).join("\n");
    const m = firstLines.match(/\[!\[Deploy with Vercel\]\(https:\/\/vercel\.com\/button\)\]\((https:\/\/vercel\.com\/new\/clone\?[^)]+)\)/);
    assert.ok(m, "deploy button near the top");
    const url = new URL(m[1]);
    assert.strictEqual(
        url.searchParams.get("repository-url"),
        "https://github.com/fp101fs/spotify-ytm-hybrid-player"
    );
});

test("vercel.json builds the catalog and serves the repo root statically", () => {
    const cfg = JSON.parse(read("vercel.json"));
    assert.strictEqual(cfg.buildCommand, "node scripts/build-catalog.js");
    assert.strictEqual(cfg.outputDirectory, ".");
    assert.strictEqual(cfg.framework, null);
    const pkg = JSON.parse(read("package.json"));
    assert.strictEqual(pkg.scripts.build, cfg.buildCommand);
    assert.ok(!pkg.dependencies, "no runtime dependencies to install");
});

test(".vercelignore keeps build inputs and the app files deployed", () => {
    const ignored = read(".vercelignore").split("\n").map((l) => l.trim()).filter(Boolean);
    for (const needed of ["scripts/", "songs/", "Images/", "tracks.json", "index.html"]) {
        assert.ok(!ignored.includes(needed), `${needed} must not be ignored`);
    }
});

test("index.html references only relative, existing local assets", () => {
    const html = read("index.html");
    const refs = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1]);
    const local = refs.filter((r) => !/^(https?:|data:|#|mailto:|blob:)/.test(r));
    assert.ok(local.length > 5);
    for (const r of local) {
        assert.ok(!r.startsWith("/") || r.startsWith("./"), `relative path: ${r}`);
        assert.ok(!/127\.0\.0\.1|localhost/.test(r), `no local host: ${r}`);
        const file = path.join(root, decodeURIComponent(r.split(/[?#]/)[0]));
        assert.ok(fs.existsSync(file), `exists: ${r}`);
    }
});

test("no tracked file exceeds GitHub's 100 MB limit", () => {
    for (const dir of ["songs", "Images"]) {
        for (const f of fs.readdirSync(path.join(root, dir))) {
            const size = fs.statSync(path.join(root, dir, f)).size;
            assert.ok(size < 100 * 1024 * 1024, `${dir}/${f} is ${size} bytes`);
        }
    }
});

test("item 12 polish: chip rows don't shrink and the shortcuts dialog uses setDialogOpen", () => {
    const css = read("style.css");
    const block = css.slice(css.indexOf("Item 12 polish"));
    assert.match(block, /\.library-filters,\s*\.mood-chips-bar\s*\{[^}]*flex-shrink:\s*0/);
    const js = read("script.js");
    const fn = js.slice(js.indexOf("function toggleShortcutsModal"), js.indexOf("function toggleLikeCurrentTrack"));
    assert.match(fn, /setDialogOpen\(modal, isShortcutsModalOpen\)/);
    assert.doesNotMatch(fn, /setAttribute\("open"/);
});
