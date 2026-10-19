# Burping Slug's Retro CD Burner

A web-based CD burning application. Upload audio files or folders, or paste URLs, arrange tracks, preview, and burn to CD-R as an audio CD or an MP3 data CD.

## Features

- Drag-and-drop file and folder upload
- Tracks shown as a collapsible folder tree
- Audio CD or MP3 CD mode (MP3 CDs keep the uploaded folder layout, with numbered folders and files)
- Paste URLs to download audio (YouTube, SoundCloud, Suno, etc.)
- Download caching - same URL won't re-download
- Track reordering with keyboard or mouse
- Shuffle/randomize track order
- Audio preview - play/stop tracks before burning
- Download tracks to local machine
- Burns run in the background on the server: closing or reloading the page doesn't interrupt them
- Every open tab or device shows the same live burn progress; reconnecting picks it back up
- Playlist changes are blocked while a burn is running
- Automatic audio conversion to CD-compatible WAV (44.1kHz/16-bit stereo), or MP3 (VBR ~192kbps) for MP3 CDs
- Converted files are cached per track, so re-burning skips conversion
- Two-pass EBU R128 loudness normalization (-14 LUFS) for consistent volume
- CD capacity detection (shown in page title)
- Auto-eject after successful burn
- Auto-eject non-writable discs (already burned/finalized)
- Optional 2-second gaps between tracks
- Dummy burn mode for testing
- Persistent storage - tracks survive server restart
- Accessible - ARIA tree pattern, keyboard navigation, screen reader support

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| Arrow Up/Down | Navigate tracks and folders |
| Home/End | Jump to first/last item |
| Enter / Arrow Right | Expand folder |
| Arrow Left | Collapse folder, or go to parent folder |
| Space | Play/stop selected track |
| Delete/Backspace | Remove selected track |
| Alt+Arrow Up/Down | Move track up/down |
| Alt+Home/End | Move track to top/bottom |

## Requirements

- Python 3.10+
- [uv](https://github.com/astral-sh/uv)
- `wodim` (CD burning)
- `genisoimage` (MP3 CD images)
- `ffmpeg` (audio conversion and probing)
- `yt-dlp` and `deno` (URL downloads - installed via uv; YouTube needs deno to solve its JavaScript challenges)

Install system dependencies (Debian/Ubuntu):

```bash
sudo apt install wodim genisoimage ffmpeg
```

If YouTube downloads start failing with "This video is not available" or HTTP 403, update yt-dlp:

```bash
uv lock --upgrade-package yt-dlp && uv sync && ./ctl.sh restart
```

## Usage

Start the server:

```bash
./ctl.sh start
```

Open http://localhost:3379 in your browser.

Other commands:

```bash
./ctl.sh stop      # Stop server
./ctl.sh restart   # Restart server
./ctl.sh status    # Check status
./ctl.sh logs      # Tail logs
```

Logs (including wodim burn output and failed download URLs) are written to `logs/cdburner.log`.

## Data Storage

Tracks and downloaded files are stored in `~/.local/share/burping-slugs/`:

```
~/.local/share/burping-slugs/
  playlist.json    # Track list and CD type
  files/           # Audio files
  cache/           # URL download cache
  wav/             # Converted WAV files (audio CD)
  mp3/             # Converted MP3 files (MP3 CD)
```

## API

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/` | GET | Web interface |
| `/upload` | POST | Upload audio files |
| `/tracks` | GET | List tracks |
| `/track/<id>` | DELETE | Remove track |
| `/reorder` | POST | Reorder tracks |
| `/randomize` | POST | Shuffle tracks |
| `/clear` | POST | Remove all tracks |
| `/cd-type` | POST | Set CD type (`audio` or `mp3`) |
| `/cd-info` | GET | Get CD capacity (cached values while burning) |
| `/burn` | POST | Start a burn in the background |
| `/burn-events` | GET | Shared burn state (SSE stream) |
| `/download` | POST | Download from URLs |
| `/download-progress` | GET | Download progress (SSE stream) |
| `/job/<id>` | GET | Get download job status |
| `/audio/<id>` | GET | Stream track audio (`?download=true` to download) |

`/burn` takes a JSON body: `{"cd_type": "audio" | "mp3", "dummy": false, "gaps": true}`. Set `dummy` for a dry run, and `gaps: false` for gapless audio CDs. It returns 409 if a burn is already running.

Playlist-changing endpoints (`/upload`, `/track/<id>`, `/reorder`, `/randomize`, `/clear`, `/cd-type`) return 409 while a burn is running.
