# MovieStream

MovieStream is a private, local-network movie library. The Node.js server indexes video files inside one configured folder and streams them directly to browsers using HTTP byte ranges. Movie files stay where they are: MovieStream does not upload, move, rename, or delete them. No MongoDB account or cloud storage is required.

The interface features cinematic discovery, searchable movie rows, folder browsing, detected TV series with seasons and episodes, folder-based and custom collections, My List, and a native browser player. Movie artwork, genres, ratings, runtime, and descriptions come from optional TMDB metadata when configured; without it the library, details, and playback continue to work with locally scanned file information.

## Technology

- React, Vite, React Router, Tailwind CSS, and Lucide React
- Node.js ES modules, Express, dotenv, CORS, and native filesystem streams
- Bounded ZIP/XML parsing for XLSX reference imports (`fflate` and `fast-xml-parser`)
- Optional TMDB metadata lookup; the API key stays on the server
- Local JSON metadata for folder classifications, custom collections, and cross-device watch progress
- Browser local storage for My List and optional movie metadata cache

## Requirements

- Windows 11 (commands below use PowerShell)
- Node.js 22.12 LTS or newer, including npm (the test tooling requires Node 22.12+)
- Your own video files in `F:\Movies` (or another configured directory)

## Install

Open PowerShell in the project folder:

```powershell
cd "D:\My Code\MovieStream"
npm install
npm install --prefix server
npm install --prefix client
```

The project includes `server\.env` for the requested defaults. Check it before starting:

```dotenv
MOVIE_DIRECTORY=F:/Movies
PORT=5000
HOST=0.0.0.0
CLIENT_URL=http://localhost:5173
TMDB_API_KEY=
MOVIESTREAM_METADATA_FILE=
FFMPEG_PATH=ffmpeg
FFPROBE_PATH=ffprobe
MOVIESTREAM_TRANSCODE_DIRECTORY=
MOVIESTREAM_MAX_TRANSCODES=2
```

`server\.env.example` is a template. Do not commit `server\.env` or put secrets in `client`.

| Variable | Purpose |
| --- | --- |
| `MOVIE_DIRECTORY` | The only folder MovieStream scans and streams |
| `PORT` | Backend port, default `5000` |
| `HOST` | Listen address, use `0.0.0.0` for home-network access |
| `CLIENT_URL` | Allowed browser origin(s), comma-separated when using LAN addresses |
| `TMDB_API_KEY` | Optional server-side TMDB key; empty disables online metadata |
| `MOVIESTREAM_METADATA_FILE` | Optional location for MovieStream's JSON metadata; defaults to `server\data\library-state.json` |
| `FFMPEG_PATH` | FFmpeg executable name on `PATH` or its full path; required only for transcoding |
| `FFPROBE_PATH` | FFprobe executable name on `PATH` or its full path; required for media inspection |
| `MOVIESTREAM_TRANSCODE_DIRECTORY` | Optional dedicated temporary HLS directory outside the media library; defaults to the OS temp directory |
| `MOVIESTREAM_MAX_TRANSCODES` | Maximum simultaneous FFmpeg sessions, from 1 through 16; defaults to `2` |
| `VITE_API_BASE_URL` | Optional frontend API base. Leave unset for same-origin `/api` |

## Start MovieStream

For development, start the backend and Vite frontend together:

```powershell
cd "D:\My Code\MovieStream"
npm run dev
```

Open `http://localhost:5173`. To start either part separately, use two PowerShell windows:

```powershell
# Window 1 — backend
cd "D:\My Code\MovieStream"
npm run dev:server
```

```powershell
# Window 2 — frontend
cd "D:\My Code\MovieStream"
npm run dev:client
```

To run the production-built frontend through Express:

```powershell
cd "D:\My Code\MovieStream"
npm run build
npm --prefix server start
```

Then open `http://localhost:5000`. Keep the server process running while watching; closing its PowerShell window stops streaming.

## Add movies

Put supported videos in `F:\Movies` or any nested folder under it. In MovieStream select **Refresh** to rescan. The initial scan is cached in memory; normal library requests do not rescan the disk. Supported extensions: `.mp4`, `.mkv`, `.avi`, `.mov`, `.wmv`, `.webm`, `.m4v`, `.mpeg`, and `.mpg`. Empty nested folders are retained in the browser tree.

To use a different library, edit `MOVIE_DIRECTORY` in `server\.env` and restart the server. Only this configured directory is scanned. APIs use opaque IDs and safe relative folder/movie identifiers; they never return the server's absolute media path. Symlinks are skipped.

## Browse, search, and save

- **Discover** features a movie from the scanned library and shows Continue Watching, Recently Added, and the full collection.
- **All movies** and **Recently added** provide direct views of the local catalog.
- **Search** matches scanned titles and years present in filenames; genres are searchable when metadata has been loaded and cached.
- Use a card's bookmark or the movie details page to add/remove it from **My List**. The list is stored in this browser's local storage and is not synced to other devices.
- Movie detail pages show file size and format even with no TMDB key. When metadata is available they also show artwork, synopsis, year, genres, rating, and runtime.
- **Folders** preserves the on-disk hierarchy and supports breadcrumbs and sorting. Folder classifications and artwork URLs are app metadata only.
- **Series** detects episode patterns such as `S01E02`, `1x02`, and `Season 01\Episode 02`; classify a folder manually when automatic detection does not fit its naming.
- **Collections** recognizes folders named as a collection/franchise/saga/trilogy or nested under a collection folder. Create personal collections and add/remove scanned movies without touching media files.
- Folder classifications, custom collections, and playback progress are stored in the local JSON metadata file, not in the media folders. Episode progress is keyed to each episode; an episode is marked complete after 90% playback.
- Genre rows appear only for genres available in cached TMDB metadata. Series descriptions and episode names use TMDB only when a server-side key is configured; playback never depends on it.

## Home-network access

1. Connect the server PC, TV, and phone to the same trusted home Wi-Fi/LAN.
2. Find the PC's Wi-Fi IPv4 address (replace `Wi-Fi` if Windows uses a different adapter name):

   ```powershell
   Get-NetIPAddress -AddressFamily IPv4 -InterfaceAlias "Wi-Fi" |
     Where-Object { $_.IPAddress -notlike '169.254.*' -and $_.AddressState -eq 'Preferred' } |
     Select-Object InterfaceAlias, IPAddress
   ```

3. Use a reserved/stable local address where possible. During Vite development, the proxy preserves the browser's LAN `Host` so a same-host frontend origin is accepted by the backend. Add a LAN origin to `CLIENT_URL` only when your proxy/frontend and backend use different hostnames or ports, for example:

   ```dotenv
   CLIENT_URL=http://localhost:5173,http://192.168.1.25:5173
   ```

   Restart the backend after changing the file. The Vite server listens on `0.0.0.0`, so on the TV browse to `http://192.168.1.25:5173`.

4. For the built app, run the production build and backend commands above. On the TV browse to `http://192.168.1.25:5000`. The frontend and API are then served from the same origin.
5. MovieStream listens on all interfaces as requested, so restrict its Node.js ports on Public networks. This machine currently has a broad Node.js Public-profile rule; run this in PowerShell **as Administrator** to block MovieStream's ports on Public networks without changing unrelated Node applications:

   ```powershell
   $nodePath = (Get-Command node).Source
   New-NetFirewallRule -DisplayName "MovieStream block public network" `
     -Direction Inbound -Action Block -Program $nodePath -Protocol TCP `
     -LocalPort 5000,5173 -Profile Public
   ```

6. Check the network category before adding private firewall access:

   ```powershell
   Get-NetConnectionProfile -InterfaceAlias "Wi-Fi"
   ```

   Only if this is your trusted home Wi-Fi, open PowerShell **as Administrator** and set it to Private:

   ```powershell
   Set-NetConnectionProfile -InterfaceAlias "Wi-Fi" -NetworkCategory Private
   ```

7. If Windows Firewall prompts you, allow Node.js only on **Private networks**. Otherwise, in PowerShell **as Administrator**, add a Private-profile inbound rule for the production server:

   ```powershell
   New-NetFirewallRule -DisplayName "MovieStream (private home network)" `
     -Direction Inbound -Action Allow -Protocol TCP -LocalPort 5000 `
     -Profile Private
   ```

   For development mode (`npm run dev`), the frontend also uses port 5173. Add a separate Private-only rule if Windows Firewall blocks it:

   ```powershell
   New-NetFirewallRule -DisplayName "MovieStream Vite (private home network)" `
     -Direction Inbound -Action Allow -Protocol TCP -LocalPort 5173 `
     -Profile Private
   ```

   Remove either rule when no longer needed:

   ```powershell
   Remove-NetFirewallRule -DisplayName "MovieStream (private home network)"
   Remove-NetFirewallRule -DisplayName "MovieStream Vite (private home network)"
   ```

   Keep the Public-profile block rule while using MovieStream:

   ```powershell
   Remove-NetFirewallRule -DisplayName "MovieStream block public network"
   ```

Do not enable a Public-network firewall rule, configure router port forwarding, or expose MovieStream to the public internet. CORS is a browser control, not authentication; use this only on a trusted private network.

### Network troubleshooting

- Confirm the server terminal says it is listening and test `http://localhost:5000/api/health` on the PC.
- Verify the PC and TV are on the same Wi-Fi and the Wi-Fi is not using guest/client isolation.
- Check the current IPv4 again if the router address changes.
- Confirm Windows identifies the home network as **Private** before allowing the firewall rule.
- The default Vite proxy accepts its same-host LAN origin. Add the exact frontend origin (including scheme and port) to `CLIENT_URL` only when a custom proxy or separate frontend host changes the origin/Host relationship.
- Do not use `localhost` on the TV; it refers to the TV itself.

## Project structure

```text
MovieStream/
├── client/
│   ├── src/components/       # Navigation, movie, folder, series and collection cards
│   ├── src/context/          # Library data and watch progress
│   ├── src/pages/            # Discovery, folders, series, organizer, details and player
│   ├── src/services/         # Frontend API and browser capability detection
│   └── src/styles.css
├── server/
│   ├── controllers/          # Library, organizer and range-stream handlers
│   ├── routes/               # Movie, library and organizer API routes
│   ├── services/             # Catalog, organizer, path safety and playback services
│   ├── data/                 # Runtime JSON metadata (not media files)
│   ├── test/                 # Isolated temporary-fixture tests
│   ├── .env                  # Local configuration (not committed)
│   └── server.js
├── package.json
└── README.md
```

## API

- `GET /api/health` — server status
- `GET /api/system/diagnostics` — safe FFmpeg/FFprobe versions, required encoder and HLS muxer availability, and configuration errors (never returns executable paths)
- `GET /api/movies` — cached library and scan timestamp
- `POST /api/movies/refresh` — rescan the configured directory
- `GET /api/movies/:id` — safe movie details
- `GET /api/movies/:id/metadata` — optional TMDB information
- `GET /api/movies/:id/stream` — direct HTTP streaming with `Range` support
- `POST /api/movies/:id/playback` — choose direct play or a managed HLS transcode based on media and browser capabilities
- `GET /api/movies/:id/playback-sessions/:sessionId` — refresh the active-session lease and return its state
- `GET /api/movies/:id/playback-sessions/:sessionId/:filename` — retrieve an isolated HLS playlist or segment
- `DELETE /api/movies/:id/playback-sessions/:sessionId` — stop and clean up a transcode session
- `GET /api/library` — movies, folder summaries, series, collections and saved progress
- `GET /api/library/folders` and `GET /api/library/folders/:id` — hierarchical folder browsing
- `PATCH /api/library/folders/:id/classification` — set `series`, `collection`, `normal`, or `excluded`
- `GET /api/library/series` and `GET /api/library/series/:id` — detected series and episodes
- `GET /api/library/series/:id/seasons/:season` — season episodes, with optional TMDB episode titles
- `GET /api/library/collections`, `POST /api/library/collections`, and `PUT`/`DELETE /api/library/collections/:id` — browse and manage custom collections
- `PUT /api/library/progress/:id` — persist movie/episode watch position
- `GET /api/organizer/overview` — last organizer scan summary
- `POST /api/organizer/scan` — bounded, read-only scan of the configured media root
- `GET /api/organizer/scan/:scanId` — paginated relative-path scan results
- `PATCH /api/organizer/scan/:scanId/items/:itemId` — manually correct a scan classification/title
- `POST /api/organizer/import?scanId=…&filename=…` — compare a CSV or XLSX inventory with a scan
- `GET /api/organizer/proposals?scanId=…` — paginated read-only organization proposals
- `PATCH /api/organizer/proposals/:id` — save review status and an optional note

The organizer uses deterministic filename/folder patterns; it is not runtime generative AI. Inventory imports are reference-only. CSV/XLSX uploads are limited to 5 MB and 5,000 records, with bounded XLSX archive expansion and worksheet limits. Scan and review state is held in memory and is cleared when the server restarts. The service skips symbolic links, applies bounded scan/import limits, returns relative paths only, and does not provide any move, rename, copy, overwrite, or delete operation. A proposal is not an instruction to change files.

Only IDs from the in-memory scanner catalog are streamable. Symlinks are skipped, resolved file paths are checked against the configured root, and streamed files use bounded Node.js read streams rather than being loaded into memory.

## Playback compatibility

MovieStream probes each selected file and combines that metadata with the browser's reported capabilities. It prefers Direct Play, then stream-copy remuxing, audio-only conversion, and finally full H.264/AAC transcoding. The original file is never modified. Direct Play and existing byte-range seeking work without FFmpeg; FFprobe is needed for automatic decisions, and FFmpeg is needed only for a selected transcode. If either executable is unavailable, the player reports the limitation and offers the original file where possible.

FFmpeg and FFprobe are not bundled or downloaded by MovieStream. Install a trusted FFmpeg distribution yourself, then set `FFMPEG_PATH` and `FFPROBE_PATH` in your local `server\.env`. On Windows, either add the executables to `PATH` or use paths such as `C:/ffmpeg/bin/ffmpeg.exe` and `C:/ffmpeg/bin/ffprobe.exe`. Restart the server after changing them. Check `http://localhost:5000/api/system/diagnostics` to verify FFmpeg and FFprobe availability, versions, the required `libx264` and AAC encoders, and the HLS muxer. The report lists which strategies are available; for example, stream-copy remuxing does not require `libx264`. The response never includes configured executable paths. The default HLS output uses fragmented MP4 segments in a per-playback temporary directory to support incremental playback and seeking; the client uses native HLS when available and hls.js otherwise. Sessions are heartbeated while the player is open and expire after five minutes without activity. 4K content is preserved unless reported capability information indicates a 1080p fallback is appropriate. Browser and codec support varies by TV model and webOS version; LG compatibility is not guaranteed.

The player provides visible play/pause, 10-second seek, timeline, volume, fullscreen, subtitle, and audio-track controls. Seeking follows the video element's seekable ranges and its single synchronized audio/video clock; HLS.js handles out-of-buffer seeks against the active playlist, while unavailable native-HLS ranges are queued until they become seekable. Infinite HLS duration falls back to FFprobe metadata. Arrow keys move focus between visible controls; Space toggles playback, left/right seek when the player itself has focus, M toggles mute, F toggles fullscreen, and Escape exits fullscreen before returning to movie details. Text fields, selects, and sliders retain their native arrow-key behavior. Focus outlines are visible without hover, and reduced-motion preferences are respected. Playback progress is stored by the server so it can continue on another browser using the same server.

FFprobe lists embedded audio and subtitle streams. The audio menu shows language/title, codec, and channel count when available. Direct Play uses the browser's normal default audio; choosing another track creates an isolated HLS session with that stream mapped. Supported audio is copied, unsupported audio is converted to AAC while the video is copied, and video is transcoded only when required. External `.srt` and `.vtt` subtitle files sharing the movie's filename are listed alongside supported embedded text tracks. Subtitles are served as WebVTT and original subtitle/movie files are never changed. UTF-8/UTF-16 and common Windows-1252 text are supported for external SRT. Bitmap subtitle codecs (including PGS/DVD subtitles) are not selectable; ASS/SSA conversion may lose styling, fonts, or positioning. Actual subtitle rendering and audio selection still depend on the target browser.

The TV layout enlarges navigation, text, focus targets, and player controls for 1080p viewing. Arrow-key navigation is implemented for visible controls, but LG/webOS remote behavior, hardware decoding limits, HLS support, and subtitle rendering must still be verified on the actual TV; this project has not been tested on a physical LG TV.

## Tests and build

From the project directory:

```powershell
npm test
npm run build
```

The server tests create and clean up synthetic fixture files under the operating-system temp directory; they do not touch the configured movie library. They cover nested folder preservation, episode/season grouping, organizer classification/import/proposals, persistent metadata, folder exclusions, secure IDs, range streaming, playback decisions, FFprobe handling, subtitle conversion and serving, and managed transcode sessions using mocked processes. The frontend tests cover loading, empty, error, organizer review, playback fallback, selectable tracks, and remote focus navigation. Home-network and TV playback must be tried on your own devices; smart-TV playback has not been verified on a physical TV.
