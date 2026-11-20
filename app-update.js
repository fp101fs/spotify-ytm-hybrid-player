/**
 * One-click app updates (browser side). Talks to the local server's /__update/* routes (scripts/updater.js).
 *
 * Self-contained: on load it checks for updates once; if the server can't update (Vercel, python http.server)
 * the Settings "Updates" section stays hidden and nothing else changes. When an update is available the
 * Settings button gets a dot and the section's button reads "Update now".
 */
(function () {
    "use strict";

    const HEADERS = { "X-SpotTube-Update": "1" };
    const $ = (id) => document.getElementById(id);

    async function call(path, method = "GET") {
        const res = await fetch(path, { method, headers: HEADERS, cache: "no-store" });
        if (res.status === 404 || res.status === 405) throw Object.assign(new Error("unsupported"), { unsupported: true });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body.message || `Server error ${res.status}`);
        return body;
    }

    const wait = (ms) => new Promise((r) => setTimeout(r, ms));

    /** After an update the server restarts; wait until it answers again (up to ~90 s), then reload. */
    async function reloadWhenBack() {
        await wait(1500);
        for (let i = 0; i < 90; i++) {
            try {
                const res = await fetch(`./?t=${Date.now()}`, { method: "HEAD", cache: "no-store" });
                if (res.ok) return location.reload();
            } catch (_) {
                /* still restarting */
            }
            await wait(1000);
        }
        throw new Error("The server didn't come back. Run npm start again.");
    }

    function init() {
        const section = $("settings-updates");
        const status = $("setting-update-status");
        const button = $("setting-update-btn");
        const gear = $("settings-btn");
        if (!section || !status || !button) return;

        let behind = 0;
        let working = false;

        function render(message, { busy = false } = {}) {
            working = busy;
            status.textContent = message;
            button.disabled = busy;
            button.textContent = busy ? "Working…" : behind > 0 ? "Update now" : "Check for updates";
            button.classList.toggle("hero-primary-btn", behind > 0 && !busy);
            button.classList.toggle("hero-secondary-btn", !(behind > 0) || busy);
            gear?.classList.toggle("has-update", behind > 0);
        }

        async function check() {
            render("Checking for updates…", { busy: true });
            try {
                const r = await call("./__update/status");
                section.hidden = false;
                behind = r.supported ? r.behind || 0 : 0;
                button.hidden = !r.supported;
                render(r.message || "");
            } catch (err) {
                if (err.unsupported) {
                    section.hidden = true;
                    gear?.classList.remove("has-update");
                    return;
                }
                section.hidden = false;
                render(`Couldn't check for updates: ${err.message}`);
            }
        }

        async function update() {
            render("Downloading the update…", { busy: true });
            try {
                const r = await call("./__update/apply", "POST");
                if (r.restart) {
                    render(r.message || "Restarting…", { busy: true });
                    await reloadWhenBack();
                    return;
                }
                if (r.ok || r.updated) behind = 0;
                render(r.message || "Done.");
            } catch (err) {
                render(err.unsupported ? "This server can't install updates." : err.message);
            }
        }

        button.addEventListener("click", () => {
            if (working) return;
            if (behind > 0) update();
            else check();
        });

        check();
    }

    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
    else init();
})();
