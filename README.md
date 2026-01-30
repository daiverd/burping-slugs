# Burping Slug's Retro CD Burner

A web-based audio CD burning application. Upload audio files or paste URLs, arrange tracks, preview, and burn to CD-R.

## Features

- Drag-and-drop file upload
- Paste URLs to download audio (YouTube, SoundCloud, Suno, etc.)
- Download caching - same URL won't re-download
- Track reordering with keyboard or mouse
- Shuffle/randomize track order
- Audio preview - play/stop tracks before burning
- Real-time burn progress via SSE
- Automatic audio conversion to CD-compatible WAV (44.1kHz/16-bit stereo)
- Two-pass EBU R128 loudness normalization (-14 LUFS) for consistent volume
- CD capacity detection
- Optional 2-second gaps between tracks
- Dummy burn mode for testing
- Persistent storage - tracks survive server restart
- Accessible - ARIA listbox pattern, keyboard navigation, screen reader support

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| Arrow Up/Down | Navigate tracks |
| Home/End | Jump to first/last track |
| Space | Play/stop selected track |
| Delete/Backspace | Remove selected track |
| Alt+Arrow Up/Down | Move track up/down |
| Alt+Home/End | Move track to top/bottom |

## Requirements

- Python 3.10+
- [uv](https://github.com/astral-sh/uv)
- `wodim` (CD burning)
- `ffmpeg` (audio conversion and probing)
- `yt-dlp` (URL downloads - installed via uv)

Install system dependencies (Debian/Ubuntu):

```bash
sudo apt install wodim ffmpeg
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

## Data Storage

Tracks and downloaded files are stored in `~/.local/share/burping-slugs/`:

```
~/.local/share/burping-slugs/
  playlist.json    # Track list
  files/           # Audio files
  cache/           # URL download cache
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
| `/cd-info` | GET | Get CD capacity |
| `/burn` | GET | Burn CD (SSE stream) |
| `/download` | POST | Download from URLs |
| `/download-progress` | GET | Download progress (SSE stream) |
| `/job/<id>` | GET | Get download job status |
| `/audio/<id>` | GET | Stream track audio |

Burn parameters: `?dummy=true` for dry run, `?gaps=false` for gapless.
