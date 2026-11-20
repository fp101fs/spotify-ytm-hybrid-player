# SpotTube — Spotify + YT Music Hybrid Player

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Ffp101fs%2Fspotify-ytm-hybrid-player&project-name=spotify-ytm-hybrid-player&repository-name=spotify-ytm-hybrid-player)

A static-first music player that mixes Spotify's 3-pane layout, Daily Mixes and crossfade with YouTube Music's one-click "Start Mix" radio, mood tuning chips and live Up Next queue. It ships with **0 bundled songs**—import your own local music folders/files or search and play via YouTube Music. Your taste profile, playlists and imported audio stay in the browser (localStorage + IndexedDB), and one small server function (`/api/yt`) handles YouTube playback, search and radio.

> The repository is private, so the Deploy button works for accounts that can read it. Vercel will ask you to connect GitHub and will create a copy of the repo in your account.

## Features

- **3-pane shell**: library sidebar, main view with search, Back/Forward history and mood chips, and a collapsible Up Next / Radio Mix / Track Info drawer.
- **Start Mix anywhere**: endless radio from a track, artist, album, mood chip, playlist or search query.
- **Mix tuning chips**: All, Familiar, Discover, Deep Cuts, Upbeat, Chill. Upcoming tracks re-rank without interrupting playback.
- **Recommender**: artist and collaborator affinity, genre/album/era clustering, audio-feature similarity, your plays/likes/skips, and anti-repetition.
- **Player**: dual-deck equal-power crossfade (0–12 s) with gapless standby preloading, automatic leading/trailing silence trimming when crossfade is active (via per-deck pre-gain Web Audio analysers, with native HTML5 volume fallback on Safari/WebKit), automatic queue replenishment when fewer than 3 tracks are left, keyboard shortcuts (press `?`), MediaSession controls.
- **Home dashboard**: Your Supermix, Daily Mix 1–3, On Repeat, Rediscover, Jump Back In.
- **Artist, album and song pages** with top tracks, discography and "Similar in Your Library".
- **Omni-search** over songs, artists, albums, genres and moods, with a Top Result card and "Start Search Mix".
- **Bring your own music**: "+ Add Music" in the sidebar (or the "+" in Your Library, or the Home empty state) adds a folder or files (`.mp3`, `.flac`, `.wav`, `.m4a`, `.ogg`, …); drag and drop works anywhere. Custom playlists and Liked Songs included. See [Your own music](#your-own-music).
- **YouTube music videos**: paste any YouTube link to add the video as a song; it crossfades and mixes like the rest, and the playbar's **Video** button shows the video in sync. See [YouTube videos](#youtube-videos).
- **Visualizer**: plays above the main view by default. Pulseon's five looks (Bars, Circle, Waveform, Particles, Galaxy; ported from [Pulseon](https://github.com/independent-coder/Pulseon), MIT) plus 100 MilkDrop presets via [butterchurn](https://github.com/jberg/butterchurn) (MIT, bundled in `vendor/`, loaded the first time you pick one; needs WebGL 2). Click or tap it for the next look (on touch, the first tap shows the controls). The overlay has previous/next, a look picker, play/pause, full screen, a draggable and resizable floating window, and ✕ to close. The switch under XFADE in the player flips between the visualizer (♪) and the YouTube video (▶︎) for YouTube songs. On Safari the visualizer animates but can't react to the music (Safari plays without Web Audio here).
- **Optional online lookup** (Settings, off by default): fills in missing artist, album and cover art for imported songs from MusicBrainz, Cover Art Archive and iTunes Search. No accounts or keys; your audio never leaves the device.

## Your own music

- **Instant import**: tracks show up straight away from their file names and can be played at once. Tags, duration and cover art fill in the background, reading only the bytes the tags need. A progress bar (and a pill above the playbar while you browse elsewhere) shows how far along it is, with Cancel; a summary toast lists any skipped or duplicate files.
- **No-copy folders (Chrome/Edge)**: "Add a folder…" keeps a handle to the folder and stores only metadata, so audio plays straight from disk. After a reload, use **Reconnect folder** to grant access again and **Rescan** to pick up added or removed files.
- **Copied imports (Safari, Firefox, drag and drop, "Add files…")**: the audio is copied into the browser's IndexedDB.
- Local Files shows which mode each source uses. Everything stays on your device.
- On phones the Add Music menu is a bottom sheet; "Add a folder…" is hidden where the browser can't pick folders.

## YouTube videos

- Open **YouTube videos** in Your Library and paste a watch, youtu.be, Shorts, embed, live or music.youtube.com link (or a bare video ID). Any video can be added. The title, channel and length are looked up from YouTube.
- **Notice:** only add videos you have the right to play. Public-domain and Creative Commons music is a safe choice. The app shows this as a notice and doesn't check licenses.
- A few public-domain and Creative Commons videos are offered as suggestions, with credits. They are listed in `yt-allowlist.json` (`id`, `title`, `artist`, plus optional `license`, `source`, `album`, `genre`, `moods`, …).
- Sound goes through the app's server (`/api/yt`, using `@distube/ytdl-core`), so crossfade, mixes and MediaSession work. **Video** shows a muted copy that follows the audio, with captions when YouTube has them.
- YouTube videos only ever play through the app's server (ytdl-core), never YouTube's own player. Without the server (plain static hosting), or when YouTube blocks it (for example "Sign in to confirm you're not a bot", which Vercel gets on every signed-out request), the app shows the error and, where cookies would help, an "Add YouTube cookies" button.
- **YouTube Music search.** Typing in the top search bar also searches YouTube Music songs (`/api/yt/search`), with autocomplete suggestions under the bar (`/api/yt/suggest`, arrow keys + Enter). Results show in a **YouTube Music** section. Tap a row to play it right away (it's added to YouTube videos). The ⋮ menu offers Play next, Add to YouTube videos, and Open on YouTube.
- **Audio only** (on by default, switch in the YouTube Music section) plays YouTube tracks as sound only. Turn it off to have the music video open with each YouTube track.
- **Bot check fix: YouTube cookies.** The bot-check error offers **Add YouTube cookies** (also a 🍪 button under "Add YouTube video"). The modal walks through installing [Cookie-Editor](https://chromewebstore.google.com/detail/cookie-editor/hlkenndednhfkekhgcdicdfddnkalmdm), signing in on YouTube, and clicking **Export → JSON**. Paste the export into the dashed box, or drop or choose a saved file. It also accepts a Netscape `cookies.txt` or a raw `Cookie` header. Use a spare Google account.
  - The server (`POST /api/yt/cookies`) keeps only the youtube.com sign-in cookies. It returns them to the browser as HttpOnly, SameSite=Strict cookies on `/api/yt`, and the server stores nothing, so it works the same on Vercel and with `npm start`. `DELETE /api/yt/cookies` (**Remove saved cookies**) forgets them.
  - Expired cookies give a `COOKIE_EXPIRED` error, which clears them and offers the modal again.
  - Avoid the extension named "EditThisCookie": the original was removed from the Chrome Web Store, and the one now using that name is a reported credential-stealing copycat.
- Only the added video IDs and their titles are saved in the browser. Thumbnails and the fallback player load from Google (`i.ytimg.com`, `youtube-nocookie.com`).

## Run locally

Needs Node 22.22.2 or newer.

```bash
npm install            # one dependency: @distube/ytdl-core (for YouTube videos)
npm run build          # regenerate tracks.json from songs/ and Images/
npm start              # app + /api on http://127.0.0.1:5500 (PORT/HOST to change)
```

`npm run start:static` (Python's static server) also works, without YouTube videos.

## Add songs to the built-in catalog (optional)

The repo ships with **0 included songs** (`songs/` is empty and `tracks.json` has `totalTracks: 0`). If you want to bundle static tracks into a deploy:

1. Put audio in `songs/` named `Title-Artist.mp3` (several artists: `Title-Artist A, Artist B.mp3`).
2. Put the cover in `Images/` named `Title.jpeg`.
3. Run `npm run build` to rebuild `tracks.json`. Vercel runs the same command on every deploy.

Songs you import in the browser don't need any of this; they stay on that device only.

## Deploy

Click the button above, or with the Vercel CLI: `vercel --prod`. `vercel.json` sets the build command (`node scripts/build-catalog.js`), serves the repo root as static output, and adds `Accept-Ranges` and long-cache headers for `songs/` and `Images/`. `api/yt.js` deploys as a Vercel function (60 s, 1 GB). YouTube bot-checks Vercel's servers, so YouTube playback there needs YouTube cookies (see above). Export them from a private window and close it afterwards, or YouTube signs them out.

## Tests

```bash
npm test               # node --test, YouTube is mocked (no network)
npm run test:yt        # optional live check against YouTube
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
| `metadata-lookup.js` | optional MusicBrainz / Cover Art Archive / iTunes lookup |
| `youtube.js` | YouTube link parsing, suggestions, tracks (browser + server) |
| `api/yt.js`, `api/_lib/` | `/api/yt` function: info, audio/video streams, captions, YouTube Music search/suggest, YouTube cookies (`yt-cookies.js`) |
| `yt-allowlist.json` | suggested YouTube videos and their credits |
| `scripts/dev-server.js` | local server for the app and `/api` |
| `scripts/build-catalog.js` | builds `tracks.json` |

## Credits

Built on [JustJ01/Spotify-UI-Clone](https://github.com/JustJ01/Spotify-UI-Clone). Not affiliated with Spotify or YouTube. No songs are bundled in this repository; you are responsible for the local files and YouTube videos you add.
