"use strict";
/**
 * Item 16: Vercel Node function for /api/yt/* (vercel.json rewrites /api/yt/:action here).
 * Same handler the local dev server uses; see api/_lib/yt-server.js for the routes.
 */
const path = require("node:path");
const { createYtHandler } = require("./_lib/yt-server.js");
const { createYtdlAdapter } = require("./_lib/ytdl-adapter.js");
const { createDownloads } = require("./_lib/downloads.js");

// Auto-downloads go to ./downloads (or SPOTTUBE_DOWNLOADS_DIR). Off on Vercel: its disk is read-only and temporary.
const downloads = createDownloads({
    dir: process.env.SPOTTUBE_DOWNLOADS_DIR || path.join(__dirname, "..", "downloads"),
    enabled: !process.env.VERCEL,
});

const handler = createYtHandler({ adapter: createYtdlAdapter(), downloads });

module.exports = handler;
