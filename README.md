# SpotTube — Spotify + YT Music Hybrid Player

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Ffp101fs%2Fspotify-ytm-hybrid-player&project-name=spotify-ytm-hybrid-player&repository-name=spotify-ytm-hybrid-player)

A static-first music player that mixes Spotify's 3-pane layout, Daily Mixes and crossfade with YouTube Music's one-click "Start Mix" radio, mood tuning chips and live Up Next queue. No backend: it runs from a pre-built `tracks.json` manifest, and keeps your taste profile, playlists and imported audio in the browser (localStorage + IndexedDB).

> The repository is private, so the Deploy button works for accounts that can read it. Vercel will ask you to connect GitHub and will create a copy of the repo in your account.

## Features

- **3-pane shell**: library sidebar, main view with search, Back/Forward history and mood chips, and a collapsible Up Next / Radio Mix / Track Info drawer.
- **Start Mix anywhere**: endless radio from a track, artist, album, mood chip, playlist or search query.
- **Mix tuning chips**: All, Familiar, Discover, Deep Cuts, Upbeat, Chill. Upcoming tracks re-rank without interrupting playback.
- **Recommender**: artist and collaborator affinity, genre/album/era clustering, audio-feature similarity, your plays/likes/skips, and anti-repetition.
- **Player**: dual-deck crossfade (0–12 s), the queue refills itself when fewer than 3 tracks are left, keyboard shortcuts (press `?`), MediaSession controls.
- **Home dashboard**: Your Supermix, Daily Mix 1–3, On Repeat, Rediscover, Jump Back In.
- **Artist, album and song pages** with top tracks, discography and "Similar in Your Library".
- **Omni-search** over songs, artists, albums, genres and moods, with a Top Result card and "Start Search Mix".
- **Bring your own music**: "+ Add Music" in the sidebar (or the "+" in Your Library, or the Home empty state) adds a folder or files (`.mp3`, `.flac`, `.wav`, `.m4a`, `.ogg`, …); drag and drop works anywhere. Custom playlists and Liked Songs included. See [Your own music](#your-own-music).

## Your own music

- **Instant import**: tracks show up straight away from their file names and can be played at once. Tags, duration and cover art fill in the background, reading only the bytes the tags need. A progress bar (and a pill above the playbar while you browse elsewhere) shows how far along it is, with Cancel; a summary toast lists any skipped or duplicate files.
- **No-copy folders (Chrome/Edge)**: "Add a folder…" keeps a handle to the folder and stores only metadata, so audio plays straight from disk. After a reload, use **Reconnect folder** to grant access again and **Rescan** to pick up added or removed files.
- **Copied imports (Safari, Firefox, drag and drop, "Add files…")**: the audio is copied into the browser's IndexedDB.
- Local Files shows which mode each source uses. Everything stays on your device.
- On phones the Add Music menu is a bottom sheet; "Add a folder…" is hidden where the browser can't pick folders.

## Run locally

Any static server works. No dependencies to install.

```bash
npm run build          # regenerate tracks.json from songs/ and Images/
python3 -m http.server 5500
# open http://localhost:5500
```

## Add songs to the built-in catalog

1. Put audio in `songs/` named `Title-Artist.mp3` (several artists: `Title-Artist A, Artist B.mp3`).
2. Put the cover in `Images/` named `Title.jpeg`.
3. Run `npm run build` to rebuild `tracks.json`. Vercel runs the same command on every deploy.

Songs you import in the browser don't need any of this; they stay on that device only.

## Deploy

Click the button above, or with the Vercel CLI: `vercel --prod`. `vercel.json` sets the build command (`node scripts/build-catalog.js`), serves the repo root as static output, and adds `Accept-Ranges` and long-cache headers for `songs/` and `Images/`.

## Tests

```bash
npm test               # node --test, no dependencies (Node 18+)
```

## Project layout

| File | Role |
| --- | --- |
| `index.html`, `style.css` | 3-pane shell and styles |
| `script.js` | UI wiring, views, `window.SpotTubeShell` |
| `player.js` | crossfade audio engine, shortcuts, MediaSession |
| `queue.js` | Start Mix radio generator and queue |
| `recommender.js` | scoring engine |
| `storage.js` | taste, telemetry, playlists, IndexedDB audio |
| `library.js` | local import, tag parsing, playlists |
| `scripts/build-catalog.js` | builds `tracks.json` |

## Credits

Built on [JustJ01/Spotify-UI-Clone](https://github.com/JustJ01/Spotify-UI-Clone). Not affiliated with Spotify or YouTube. The bundled songs are for personal demo use only.
