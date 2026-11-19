"use strict";
/**
 * YouTube sign-in cookies for the server, so cloud hosts get past "Sign in to confirm you're not a bot".
 *
 * The user exports their youtube.com cookies (Cookie-Editor JSON, a Netscape cookies.txt, or a raw
 * `Cookie` header) and POSTs them to /api/yt/cookies. We keep only the sign-in cookies, as one
 * `name=value; …` header, and hand it back to the browser as HttpOnly cookies on this app's /api/yt path.
 * Nothing is stored on the server, so it works the same on Vercel and with `npm start`.
 */

const COOKIE_PREFIX = "yt_auth_";
const COOKIE_PATH = "/api/yt";
const CHUNK = 3800; // stay under the ~4096-byte per-cookie limit
const MAX_CHUNKS = 4;
const MAX_AGE = 180 * 24 * 3600; // YouTube rotates them sooner; a stale one fails as COOKIE_EXPIRED

// What YouTube needs to treat requests as signed in, most important first (later ones are dropped if too big).
const KEEP = [
    "SAPISID",
    "__Secure-3PAPISID",
    "__Secure-1PAPISID",
    "APISID",
    "SID",
    "HSID",
    "SSID",
    "__Secure-1PSID",
    "__Secure-3PSID",
    "LOGIN_INFO",
    "__Secure-1PSIDTS",
    "__Secure-3PSIDTS",
    "SIDCC",
    "__Secure-1PSIDCC",
    "__Secure-3PSIDCC",
    "PREF",
    "VISITOR_INFO1_LIVE",
    "VISITOR_PRIVACY_METADATA",
];

function isYouTubeDomain(domain) {
    const host = String(domain || "")
        .trim()
        .replace(/^\./, "")
        .toLowerCase();
    return host === "youtube.com" || host.endsWith(".youtube.com");
}

const SAFE_VALUE = /^[\x21\x23-\x2B\x2D-\x3A\x3C-\x5B\x5D-\x7E]*$/; // RFC 6265 cookie-octet

/** Any supported export → Map(name → value) of youtube.com cookies. */
function parseExport(input) {
    const out = new Map();
    let data = input;
    if (Buffer.isBuffer(data)) data = data.toString("utf8");
    if (typeof data === "string") {
        const text = data.trim().replace(/^﻿/, "");
        if (text.startsWith("[") || text.startsWith("{")) {
            try {
                data = JSON.parse(text);
            } catch (_) {
                return out;
            }
        } else if (text.includes("\t")) {
            // Netscape cookies.txt
            for (const raw of text.split(/\r?\n/)) {
                const line = raw.startsWith("#HttpOnly_") ? raw.slice(10) : raw;
                if (!line.trim() || line.startsWith("#")) continue;
                const parts = line.split("\t");
                if (parts.length < 7 || !isYouTubeDomain(parts[0])) continue;
                out.set(parts[5], parts[6].trim());
            }
            return out;
        } else {
            // `Cookie:` header string (assumed to be youtube.com's)
            for (const part of text.replace(/^cookie:\s*/i, "").split(";")) {
                const eq = part.indexOf("=");
                if (eq > 0) out.set(part.slice(0, eq).trim(), part.slice(eq + 1).trim());
            }
            return out;
        }
    }
    const list = Array.isArray(data) ? data : data && Array.isArray(data.cookies) ? data.cookies : [];
    for (const c of list) {
        if (!c || typeof c.name !== "string" || c.value === undefined) continue;
        if (c.domain !== undefined && !isYouTubeDomain(c.domain)) continue;
        out.set(c.name, String(c.value));
    }
    return out;
}

/** → `{ header, count }`, or throws an Error with `.code` = "COOKIE_INVALID". */
function toCookieHeader(input) {
    const all = parseExport(input);
    const pairs = [];
    let size = 0;
    for (const name of KEEP) {
        const value = all.get(name);
        if (value === undefined || value === "" || !SAFE_VALUE.test(value)) continue;
        const pair = `${name}=${value}`;
        const cost = encodeURIComponent(`${pair}; `).length; // what it takes up once saved
        if (size + cost > CHUNK * MAX_CHUNKS) continue;
        pairs.push(pair);
        size += cost;
    }
    const names = new Set(pairs.map((p) => p.slice(0, p.indexOf("="))));
    if (!names.has("SAPISID") && !names.has("__Secure-3PAPISID")) {
        const why = all.size
            ? "These cookies aren't from a signed-in YouTube tab. Sign in on youtube.com, then export again."
            : "That isn't a cookie export. In Cookie-Editor on a youtube.com tab, click Export, then JSON.";
        throw Object.assign(new Error(why), { code: "COOKIE_INVALID" });
    }
    return { header: pairs.join("; "), count: pairs.length };
}

function parseRequestCookies(req) {
    const out = new Map();
    const raw = (req && req.headers && req.headers.cookie) || "";
    for (const part of String(raw).split(";")) {
        const eq = part.indexOf("=");
        if (eq > 0) out.set(part.slice(0, eq).trim(), part.slice(eq + 1).trim());
    }
    return out;
}

/** The saved YouTube `Cookie` header from this request, or "". */
function readAuth(req) {
    const jar = parseRequestCookies(req);
    let joined = "";
    for (let i = 0; i < MAX_CHUNKS; i++) {
        const part = jar.get(COOKIE_PREFIX + i);
        if (part === undefined) break;
        joined += part;
    }
    if (!joined) return "";
    try {
        return decodeURIComponent(joined);
    } catch (_) {
        return "";
    }
}

function isHttps(req) {
    const proto = String((req && req.headers && req.headers["x-forwarded-proto"]) || "").split(",")[0].trim();
    return proto === "https" || Boolean(req && req.socket && req.socket.encrypted);
}

/** `Set-Cookie` values that save `header` (or clear it when `header` is ""). */
function authSetCookies(req, header) {
    const attrs = `; Path=${COOKIE_PATH}; HttpOnly; SameSite=Strict${isHttps(req) ? "; Secure" : ""}`;
    const encoded = header ? encodeURIComponent(header) : "";
    const out = [];
    for (let i = 0; i < MAX_CHUNKS; i++) {
        const part = encoded.slice(i * CHUNK, (i + 1) * CHUNK);
        out.push(part ? `${COOKIE_PREFIX}${i}=${part}${attrs}; Max-Age=${MAX_AGE}` : `${COOKIE_PREFIX}${i}=${attrs}; Max-Age=0`);
    }
    return out;
}

module.exports = { toCookieHeader, parseExport, readAuth, authSetCookies, COOKIE_PREFIX };
