"use strict";
/**
 * One-click updates for a git clone run with `npm start` (local only — never part of the Vercel deploy).
 *
 *   check()  → { supported, behind, ahead, branch, message }   (runs `git fetch` first)
 *   apply()  → { ok, updated, restart, message }                (`git pull --ff-only`, then `npm install` if deps changed)
 *
 * Safe by design: fast-forward only, so local edits/commits are never overwritten or merged — git refuses and
 * we pass its reason back. Only one check/apply runs at a time.
 */
const { execFile, exec } = require("node:child_process");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const ENV = { ...process.env, GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" }; // never hang on a password prompt

function run(file, args, timeout = 60_000) {
    return new Promise((resolve, reject) => {
        execFile(file, args, { cwd: ROOT, env: ENV, timeout, windowsHide: true }, (err, stdout, stderr) => {
            if (err) {
                err.detail = String(stderr || stdout || err.message).trim();
                return reject(err);
            }
            resolve(String(stdout).trim());
        });
    });
}
const git = (...args) => run("git", args);

// npm is npm.cmd on Windows, which execFile can't launch without a shell; the command is a fixed string.
function npmInstall() {
    return new Promise((resolve, reject) => {
        exec("npm install --no-audit --no-fund", { cwd: ROOT, timeout: 300_000, windowsHide: true }, (err, stdout, stderr) => {
            if (err) {
                err.detail = String(stderr || err.message).trim();
                return reject(err);
            }
            resolve();
        });
    });
}

function firstLine(text) {
    return String(text || "").split("\n").map((l) => l.trim()).find(Boolean) || "Unknown error";
}

let busy = null;
function once(fn) {
    if (busy) return busy;
    busy = fn().finally(() => {
        busy = null;
    });
    return busy;
}

async function readState() {
    try {
        await git("rev-parse", "--is-inside-work-tree");
    } catch (err) {
        const message = err.code === "ENOENT"
            ? "Install Git to get updates (git-scm.com), then restart the app."
            : "This copy wasn't downloaded with git clone, so it can't update itself.";
        return { supported: false, message };
    }
    const branch = await git("rev-parse", "--abbrev-ref", "HEAD").catch(() => "");
    try {
        await git("rev-parse", "--abbrev-ref", "@{u}");
    } catch (_) {
        return { supported: false, branch, message: `Branch "${branch}" isn't linked to GitHub, so there's nothing to update from.` };
    }
    return { supported: true, branch };
}

async function counts() {
    const [behind, ahead] = (await git("rev-list", "--left-right", "--count", "@{u}...HEAD")).split(/\s+/).map(Number);
    return { behind: behind || 0, ahead: ahead || 0 };
}

function check() {
    return once(async () => {
        const state = await readState();
        if (!state.supported) return state;
        try {
            await git("fetch", "--quiet");
        } catch (err) {
            return { ...state, ...(await counts()), offline: true, message: `Couldn't reach GitHub: ${firstLine(err.detail)}` };
        }
        const c = await counts();
        const message = c.behind
            ? `${c.behind} update${c.behind === 1 ? "" : "s"} available.`
            : "You're up to date.";
        return { ...state, ...c, message };
    });
}

function apply() {
    return once(async () => {
        const state = await readState();
        if (!state.supported) return { ok: false, updated: false, message: state.message };
        const before = await git("rev-parse", "HEAD");
        try {
            await git("pull", "--ff-only", "--quiet");
        } catch (err) {
            return { ok: false, updated: false, message: `Update stopped, nothing was changed: ${firstLine(err.detail)}` };
        }
        const after = await git("rev-parse", "HEAD");
        if (after === before) return { ok: true, updated: false, message: "You're up to date." };

        const changed = (await git("diff", "--name-only", before, after)).split("\n");
        if (changed.some((f) => f === "package.json" || f === "package-lock.json")) {
            try {
                await npmInstall();
            } catch (err) {
                return {
                    ok: false,
                    updated: true,
                    restart: false,
                    message: `Updated, but "npm install" failed: ${firstLine(err.detail)}. Run it yourself, then restart.`,
                };
            }
        }
        return { ok: true, updated: true, restart: true, message: "Updated. Restarting…" };
    });
}

module.exports = { check, apply };
