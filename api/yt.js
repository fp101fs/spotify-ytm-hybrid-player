"use strict";
/**
 * Item 16: Vercel Node function for /api/yt/* (vercel.json rewrites /api/yt/:action here).
 * Same handler the local dev server uses; see api/_lib/yt-server.js for the routes.
 */
const { createYtHandler } = require("./_lib/yt-server.js");
const { createYtdlAdapter } = require("./_lib/ytdl-adapter.js");

const handler = createYtHandler({ adapter: createYtdlAdapter() });

module.exports = handler;
