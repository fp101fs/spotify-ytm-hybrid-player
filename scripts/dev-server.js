#!/usr/bin/env node
"use strict";
/**
 * Item 16: local dev server (Node, no dependencies of its own). `npm start` → http://127.0.0.1:5500
 *
 * Serves the app's static files with `Cache-Control: no-store` (and Range support so audio can seek),
 * plus /api/* the same way Vercel does, so YouTube videos work locally. `python3 -m http.server`
 * can't run the API. Set PORT / HOST to change where it listens.
 */
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const PORT = Number(process.env.PORT) || 5500;
const HOST = process.env.HOST || "127.0.0.1";

const MIME = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".ico": "image/x-icon",
    ".mp3": "audio/mpeg",
    ".m4a": "audio/mp4",
    ".flac": "audio/flac",
    ".wav": "audio/wav",
    ".ogg": "audio/ogg",
    ".mp4": "video/mp4",
    ".webm": "video/webm",
    ".vtt": "text/vtt; charset=utf-8",
    ".txt": "text/plain; charset=utf-8",
    ".md": "text/markdown; charset=utf-8",
    ".woff2": "font/woff2",
};

// Never served: dependencies, git data, the server code itself.
const BLOCKED = /^\/(node_modules|\.git|\.vercel|api\/_lib)(\/|$)|\/\.(env|DS_Store)/;

function send(res, status, body, headers = {}) {
    res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", ...headers });
    res.end(body);
}

let apiHandlers = null;
function loadApi() {
    if (apiHandlers) return apiHandlers;
    apiHandlers = {};
    const dir = path.join(ROOT, "api");
    for (const file of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
        if (!file.endsWith(".js") || file.startsWith("_")) continue;
        const name = file.slice(0, -3);
        try {
            apiHandlers[name] = require(path.join(dir, file));
        } catch (err) {
            const message = /Cannot find module/.test(err.message)
                ? "Run npm install first: the YouTube API needs @distube/ytdl-core."
                : `api/${file} failed to load: ${err.message}`;
            console.warn(`[dev-server] ${message}`);
            apiHandlers[name] = (req, res) =>
                send(res, 503, JSON.stringify({ error: { code: "NO_SERVER", message } }), {
                    "Content-Type": "application/json; charset=utf-8",
                });
        }
    }
    return apiHandlers;
}

function serveApi(req, res, pathname) {
    // /api/yt, /api/yt/info … → api/yt.js, like vercel.json's rewrite
    const name = pathname.split("/")[2] || "";
    const handler = loadApi()[name];
    if (!handler) return send(res, 404, "No such API route");
    Promise.resolve(handler(req, res)).catch((err) => {
        console.error(err);
        if (!res.headersSent) send(res, 500, "API error");
        else res.destroy();
    });
}

function listDirectory(res, dirPath, urlPath) {
    const names = fs.readdirSync(dirPath).filter((n) => !n.startsWith("."));
    const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
    const links = names.map((n) => `<li><a href="${esc(encodeURIComponent(n))}">${esc(n)}</a></li>`).join("\n");
    send(res, 200, `<!doctype html><meta charset="utf-8"><title>${esc(urlPath)}</title><ul>\n${links}\n</ul>`, {
        "Content-Type": "text/html; charset=utf-8",
    });
}

function serveStatic(req, res, pathname) {
    let rel;
    try {
        rel = decodeURIComponent(pathname);
    } catch (_) {
        return send(res, 400, "Bad path");
    }
    if (rel.includes("\0") || BLOCKED.test(rel)) return send(res, 404, "Not found");
    let file = path.join(ROOT, path.normalize(rel));
    if (file !== ROOT && !file.startsWith(ROOT + path.sep)) return send(res, 403, "Forbidden");
    let stat;
    try {
        stat = fs.statSync(file);
    } catch (_) {
        // cleanUrls, like Vercel: /about → /about.html
        if (fs.existsSync(`${file}.html`)) {
            file = `${file}.html`;
            stat = fs.statSync(file);
        } else return send(res, 404, "Not found");
    }
    if (stat.isDirectory()) {
        if (!pathname.endsWith("/")) return send(res, 301, "", { Location: `${pathname}/` });
        const index = path.join(file, "index.html");
        if (fs.existsSync(index)) {
            file = index;
            stat = fs.statSync(file);
        } else return listDirectory(res, file, pathname);
    }

    const headers = {
        "Content-Type": MIME[path.extname(file).toLowerCase()] || "application/octet-stream",
        "Cache-Control": "no-store",
        "Accept-Ranges": "bytes",
        "X-Content-Type-Options": "nosniff",
    };
    const size = stat.size;
    const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || "");
    if (m && (m[1] || m[2])) {
        let start = m[1] === "" ? Math.max(0, size - Number(m[2])) : Number(m[1]);
        let end = m[1] === "" || m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
        if (start >= size || end < start) {
            res.writeHead(416, { ...headers, "Content-Range": `bytes */${size}` });
            return res.end();
        }
        res.writeHead(206, { ...headers, "Content-Range": `bytes ${start}-${end}/${size}`, "Content-Length": end - start + 1 });
        if (req.method === "HEAD") return res.end();
        return fs.createReadStream(file, { start, end }).pipe(res);
    }
    res.writeHead(200, { ...headers, "Content-Length": size });
    if (req.method === "HEAD") return res.end();
    fs.createReadStream(file).pipe(res);
}

function createServer() {
    return http.createServer((req, res) => {
        const { pathname } = new URL(req.url || "/", "http://localhost");
        if (pathname === "/api" || pathname.startsWith("/api/")) return serveApi(req, res, pathname);
        if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, "Method not allowed", { Allow: "GET, HEAD" });
        serveStatic(req, res, pathname);
    });
}

if (require.main === module) {
    createServer().listen(PORT, HOST, () => {
        console.log(`SpotTube dev server: http://${HOST}:${PORT}  (static files + /api/yt, no caching)`);
    });
}

module.exports = { createServer };
