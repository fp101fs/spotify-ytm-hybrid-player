# Spotify + YT Music Hybrid Player — Plan

## Concept
We are transforming `/Users/iandodge/Documents/Spotify-UI-Clone` from a static HTML/CSS/JS template into a full-featured, **Vercel-deployable** local + static music player web app that blends the best of Spotify (rich 3-pane layout, Daily Mixes, crossfade, smart playlists, library & album views) and YouTube Music (one-click "Start Mix" radio anywhere, dynamic mood/vibe tuning pills like *Familiar / Discover / Deep Cuts / Upbeat / Chill*, real-time "Up Next" queue drawer, and endless autoplay). It runs 100% statically out-of-the-box for 1-click Vercel deployment (via a pre-indexed `tracks.json` manifest + browser File System / Drag-and-Drop IndexedDB audio support), while also providing a dev script to auto-index any local `/songs` folder. When complete, it will be pushed to a new private GitHub repository (`main` branch) with a 1-click **"Deploy with Vercel"** button at the top of `README.md`.

## Workflow
- Do one item at a time.
- When an item is finished: tick it, add notes below, commit, then clear the context.
- After clearing, the next session reads this file and starts the next unticked item.

## Plan
- [x] 1. Build the static-first catalog indexer & Vercel-ready manifest (`scripts/build-catalog.js`, `tracks.json`, `vercel.json`): scan `/songs` and `/Images` to generate a rich `tracks.json` manifest (title, parsed primary/featured artists, album, duration, genre, mood tags, BPM/energy/valence attributes, relative URLs) so the app works 100% statically on Vercel and locally on port 5500 without hardcoded `127.0.0.1` URLs.
- [ ] 2. Modernize the 3-pane Spotify + YT Music hybrid shell (`index.html`, `style.css`): full-viewport responsive layout with Left Library Sidebar, Center Main View (with top search bar, navigation history, and YT Music mood/activity filter chips), collapsible Right "Up Next / Radio Mix / Track Info" Drawer, and enhanced bottom Playbar.
- [ ] 3. Build the persistent user taste, telemetry & IndexedDB store (`storage.js`): track play counts, completion ratios, skip penalties (early skip vs late skip), likes/dislikes, recently played timestamps, custom playlists, local user-imported audio blobs (via IndexedDB), and real-time Web Audio API analyzer features (RMS energy, bass/treble spectral centroid) cached per track.
- [ ] 4. Build the Hybrid Recommendation & Scoring Engine (`recommender.js`): combine artist/collaborator affinity, genre/album/era clustering, audio feature cosine similarity (energy, tempo, mood, spectral profile), Spotify-style user taste affinity (completion rate + likes - skip decay), and recency/variety anti-repetition penalties.
- [ ] 5. Implement the universal "Start Mix" Radio Generator & Queue Manager (`queue.js`): allow starting a nonstop radio mix from any single track, artist, album, mood chip, or active search result set, maintaining a live queue with manual reorder, "Play Next", "Add to Queue", and removal.
- [ ] 6. Add YT Music Dynamic Mix Tuning Chips inside the "Up Next / Mix" drawer: allow switching the active radio mix mode on the fly between *All*, *Familiar*, *Discover*, *Deep Cuts*, *Upbeat*, and *Chill*, dynamically re-ranking and regenerating upcoming auto-queued tracks without interrupting current playback.
- [ ] 7. Implement Continuous Nonstop Playback & Gapless/Crossfade Audio Engine (`player.js`): dual-deck HTML5 Audio + Web Audio API crossfader (configurable 0–12s crossfade), automatic endless queue replenishment when fewer than 3 tracks remain, keyboard shortcuts, and MediaSession API integration.
- [ ] 8. Build rich Artist, Album, and Song Detail Views with one-click "Start Mix" hero buttons: clicking any artist or album opens a dedicated header view showing top tracks, discography, "Similar in Your Library" recommendations, and a prominent "Start Mix" radio button.
- [ ] 9. Build Instant Omni-Search with "Start Mix from Search Results": live filtering across songs, artists, albums, and genres/moods as you type, featuring a "Top Result" hero card and a "Start Search Mix" button that turns any search query into an endless tailored radio station.
- [ ] 10. Implement Spotify-style Smart Auto-Mixes & YT Music "Supermix" on the Home Dashboard: automatically generate *Your Supermix*, *Daily Mix 1–3* (clustered by genre/artist/vibe), *On Repeat*, *Rediscover / Forgotten Favorites*, and *Jump Back In* shelves.
- [ ] 11. Add Browser Local Audio Import (Drag-and-Drop / Folder Picker) & Custom Playlists: allow users on Vercel or localhost to drag-and-drop or pick local `.mp3`/`.flac`/`.wav` files/folders directly in the browser (persisted in IndexedDB with client-side ID3/filename parsing and cover art generation), plus create/edit custom playlists and "Liked Songs".
- [ ] 12. Playtest, UI polish, create private GitHub repo, build `README.md` with 1-click "Deploy with Vercel" button at the top, commit & push to `main`: verify Vercel static deployment config (`vercel.json`, `package.json`), create a new private GitHub repository via `gh repo create`, wire the Vercel deploy button URL to the new repo, and push everything to `main`.

## Notes per item

### 1. Static-first catalog indexer & Vercel-ready manifest
- **Files created/updated**:
  - `scripts/build-catalog.js` (CLI + CommonJS module exporting `buildCatalog`, `parseTrackFilename`, `parseArtistList`, `parseMp3Metadata`, `encodeRelativePath`, `formatDuration`, `slugify`)
  - `tracks.json` (generated manifest at repo root)
  - `vercel.json` (Vercel v2 static config with `buildCommand: "node scripts/build-catalog.js"`, `outputDirectory: "."`, `Accept-Ranges: bytes` on `/songs/(.*)`, and caching headers)
  - `package.json` (`npm run build:catalog`, `npm run build`, `npm test` via `node --test tests/*.test.js`)
  - `script.js` (migrated away from hardcoded `http://127.0.0.1:5500/songs/` directory scraping to static-first `fetch("./tracks.json")` with relative `songs/...` and `Images/...` URLs and relative `./songs/` fallback)
  - `tests/catalog.test.js` (automated test suite for indexer, metadata schema, artist splitting, relative URLs, and Vercel config)
- **How it works & Schema/APIs for later steps**:
  - `tracks.json` top-level shape: `{ version: "1.0.0", generatedBy, totalTracks: 12, genres: [...8], moods: [...18], artists: [...17], albums: [...12], tracks: [...] }`.
  - Each track object in `manifest.tracks` (also cached on `window.TRACK_CATALOG` by `script.js`) has:
    - `id` (slug, e.g. `"espresso-sabrina-carpenter"`, `"like-that-future"`), `trackNumber` (1..12), `filename`
    - `title`, `primaryArtist`, `featuredArtists` (array), `artists` (`[primaryArtist, ...featuredArtists]`), `artistDisplay` (comma-joined)
    - `album`, `year`, `duration` (seconds float parsed directly from MPEG Layer III frame header + byte length after ID3v2/ID3v1 stripping), `durationFormatted` (`"M:SS"`), `bitrateKbps` (192 or 320), `sampleRate` (44100 or 48000)
    - `audioUrl` (relative URI-encoded path, e.g. `"songs/Espresso-Sabrina%20Carpenter.mp3"`) and `coverUrl` (e.g. `"Images/Espresso.jpeg"`)
    - `genre`, `subgenres` (array), `language` (`"English" | "Hindi" | "Punjabi"`), `moods` (array including YT Music tuning tags like `"Upbeat"`, `"Chill"`, `"Deep Cuts"`, `"Romantic"`, `"Energetic"`, `"Feel Good"`, `"Late Night"`, `"Workout"`, `"Focus"`, `"Party"`, `"Soulful"`)
    - `bpm`, `energy`, `valence`, `danceability`, `acousticness`, `popularity` (both top-level on track and nested under `track.audioFeatures`)
- **Deferred / Not done yet**:
  - 3-pane hybrid UI redesign (`index.html`, `style.css`) is Item 2.
  - Persistent taste store (`storage.js`), recommendation engine (`recommender.js`), queue manager (`queue.js`), and dual-deck crossfade (`player.js`) are Items 3–7.
- **Testing & verification**:
  - Ran `npm test` (`node --test tests/*.test.js`): all 4 test suites pass.
  - Verified against a zero-directory-listing Node `http.Server` that `/tracks.json` and all 12 relative `audioUrl` and `coverUrl` paths return HTTP 200.
  - Also fixed two latent bugs in `script.js`: off-by-one `getRandomIndex(0, songs.length - 1, currentTrackIndex)` on shuffle and missing `e` parameter in `mouseup` progress bar listener.
