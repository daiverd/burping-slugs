# Burping Slug's Retro CD Burner

A web-based audio CD burning application. Upload audio files, arrange tracks, and burn to CD-R.

## Features

- Drag-and-drop file upload
- Drag-and-drop track reordering
- Shuffle/randomize track order
- Real-time burn progress via SSE
- Automatic audio conversion to CD-compatible WAV (44.1kHz/16-bit stereo)
- CD capacity detection
- Optional 2-second gaps between tracks
- Dummy burn mode for testing

## Requirements

- Python 3.10+
- [uv](https://github.com/astral-sh/uv)
- `wodim` (CD burning)
- `ffmpeg` (audio conversion)

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

Burn parameters: `?dummy=true` for dry run, `?gaps=false` for gapless.
