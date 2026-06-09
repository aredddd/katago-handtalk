# KataGo Web

A web-based Go (Weiqi/Baduk) AI interface powered by [KataGo](https://github.com/lightvector/KataGo). Play and analyse against one of the strongest Go engines directly from your browser — desktop or mobile.

![Go Board](https://img.shields.io/badge/Game-Go%20%2F%20Weiqi-black) ![Python](https://img.shields.io/badge/Python-3.10%2B-blue) ![License](https://img.shields.io/badge/License-MIT-green)

## Features

- **KaTrain-style analysis UI** — move candidates with color-coded circles (green → purple gradient based on score difference), win rate bar, and score estimation
- **Multiple play modes** — Free play, play vs AI (Black or White), and AI vs AI
- **Move navigation** — full move history with slider, keyboard shortcuts (← → Home End), and branch navigation
- **Camera board recognition** — take a photo of a real Go board, recognize the position using a CNN deep learning model ([noword/image2sgf](https://github.com/noword/image2sgf)), and continue analysis from there
- **User accounts** — register / sign-in with JWT-based sessions; analysis features require login
- **Admin panel** (`/admin`) — manage users, toggle open registration, change the admin password
- **Multi-language UI** — switch between English and 中文 on the fly (preference saved locally)
- **Resilient engine layer** — a Circuit Breaker protects the server from a hung or crashed KataGo process, failing fast instead of blocking, and recovers automatically
- **Responsive analysis** — moving on the board cancels any in-flight analysis of the previous position so the engine always works on the latest board
- **Mobile-friendly** — responsive layout, pinch-to-zoom, two-step move confirmation to prevent misclicks
- **Real stone sounds** — KaTrain-style placement sounds with 5 random variations + capture sound
- **Configurable** — adjustable komi (7.5 / 6.5 / 0.5 / 0), search visits (100–10000), board size (9×9, 13×13, 19×19)

## Architecture

KataGo Web follows a **3-tier (n-layer) architecture**:

```
┌─────────────────────────────────────────────────────────────┐
│  Presentation   Browser — Canvas board, Socket.IO client,    │
│                 login / admin pages, i18n                    │
├─────────────────────────────────────────────────────────────┤
│  Application    Flask + Socket.IO server (app.py)            │
│                   ├── Proxy        — JWT auth (require_auth)  │
│                   └── Circuit Breaker — engine protection    │
├─────────────────────────────────────────────────────────────┤
│  Engine / Data  KataGoFacade → KataGoEngine → KataGo process │
│                 user_store (SQLite: users + settings)        │
└─────────────────────────────────────────────────────────────┘
```

### Project layout

```
katago-web/
├── server/
│   ├── app.py                # Entry point: build via factory, start engine, run
│   ├── app_factory.py        # create_app() — builds & wires Flask + Socket.IO
│   ├── analysis_service.py   # AnalysisService — application-logic service (RealSubject)
│   ├── engine_lifecycle.py   # Create / start the KataGo engine
│   ├── sockets.py            # Socket.IO event handlers (connect / analyze / play_ai …)
│   ├── routes/               # HTTP blueprints (pages, auth, admin, recognition)
│   ├── config.py             # Environment-backed configuration
│   ├── events.py             # WebSocket event-name constants
│   ├── exceptions.py         # Custom exception hierarchy
│   ├── katago_facade.py      # KataGoFacade — abstract engine interface (Façade)
│   ├── katago_engine.py      # KataGoEngine — concrete Façade over the subprocess
│   ├── circuit_breaker.py    # Circuit Breaker stability pattern
│   ├── demo_circuit_breaker.py  # Standalone Circuit Breaker demo (GPU-free)
│   ├── demo_engine.py        # Demo-only fault-injecting engine (web CB demo)
│   ├── auth.py               # JWT helpers + Proxy decorators (require_auth/admin)
│   ├── user_store.py         # SQLite persistence (users + settings)
│   └── noword_recognizer.py  # CNN board recognition (FCOS + EfficientNet)
├── static/
│   ├── index.html            # Main UI
│   ├── admin.html            # Admin panel
│   ├── css/
│   │   ├── style.css         # Main responsive styles
│   │   └── admin.css         # Admin panel styles
│   ├── js/
│   │   ├── app.js            # App logic, WebSocket, auth, i18n
│   │   ├── goboard.js        # Canvas board rendering, interaction, sounds
│   │   └── admin.js          # Admin panel logic
│   └── sounds/               # Stone placement & capture audio files
├── config/
│   └── default_gtp.cfg       # KataGo engine configuration
├── models/
│   └── image2sgf/            # CNN model weights (board.pth + stone.pth)
├── setup.ps1                 # One-click Windows setup script
├── demo_suspend_katago.ps1   # Suspend/resume KataGo for the Circuit Breaker demo
└── requirements.txt
```

### Design patterns

The server applies several classic patterns (used here for clean separation, substitutability, and resilience):

| Pattern | Where | Purpose |
|---------|-------|---------|
| **Façade** (GoF) | `KataGoFacade` / `KataGoEngine` | Hide the KataGo subprocess, stdin/stdout JSON protocol, and threading behind a small interface |
| **Proxy** (GoF) | `require_auth` / `require_admin` decorators | Intercept requests and enforce JWT authentication/authorisation before the real handler runs |
| **Observer** | Socket.IO (`emit` / `on`) | Server broadcasts analysis, AI moves, and engine status to subscribed browser clients |
| **Circuit Breaker** | `CircuitBreaker` | Fail fast and auto-recover when the KataGo engine is unresponsive |

## Prerequisites

- **Python 3.10+**
- **KataGo** — download from [KataGo releases](https://github.com/lightvector/KataGo/releases) (OpenCL or CUDA backend)
- **KataGo model weights** — download from [KataGo models](https://katagotraining.org/)
- **NVIDIA GPU** (recommended) — for both KataGo inference and CNN board recognition

## Installation

### Quick Setup (Windows)

Run the automated setup script:

```powershell
.\setup.ps1
```

This will download KataGo, model weights, install Python dependencies, generate tuning, and start the server.

### Manual Setup

1. **Install KataGo** somewhere on your system (e.g., `C:\katago\`):
   - `katago.exe` (OpenCL or CUDA build)
   - A model weights file (`.bin.gz`)

2. **Install Python dependencies**:

   ```bash
   pip install -r requirements.txt
   ```

   This includes Flask, Flask-SocketIO, eventlet, OpenCV, sgfmill, PyTorch, plus **PyJWT** and **bcrypt** for authentication.

   For a CUDA build of PyTorch (much faster board recognition):

   ```bash
   pip install torch torchvision --index-url https://download.pytorch.org/whl/cu124
   ```

3. **Download CNN models** for board recognition (optional):

   Download `board.pth` and `stone.pth` from [noword/image2sgf](https://github.com/noword/image2sgf) and place them in `models/image2sgf/`.

4. **Configure paths** via environment variables (see table below) or edit `server/config.py`.

## Usage

```bash
cd katago-web
python server/app.py
```

Open `http://localhost:5000` in your browser.

### Accounts & sign-in

Analysis features require a signed-in account.

- **First run** automatically creates a built-in admin account: **username `admin`, password `admin`** — change it from the admin panel after first login.
- Anyone can **register** a normal account from the sign-in dialog (unless the admin has closed registration).
- Sessions use a JWT stored in the browser's `localStorage` (24-hour lifetime).

### Admin panel

Visit `http://localhost:5000/admin` (or click your username in the header when signed in as admin). From there you can:

- View and delete user accounts (the `admin` account is protected)
- Open or close public registration
- Change the admin password

### Remote Access

To access from your phone or another device, use [Tailscale](https://tailscale.com/) or any VPN/tunneling solution, then visit `http://<your-ip>:5000`.

### Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `←` | Back 1 move |
| `→` | Forward 1 move |
| `Home` | Jump to start |
| `End` | Jump to latest |
| `Shift+←` | Back 10 moves |
| `Shift+→` | Forward 10 moves |

## Configuration

### KataGo Engine

Edit `config/default_gtp.cfg` to tune KataGo parameters:

- `numSearchThreads` — number of search threads (default: 16)
- Search visits are controlled from the web UI (100–10000, default: 3000)

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `KATAGO_PATH` | `C:\katago\katago.exe` | Path to KataGo executable |
| `KATAGO_MODEL` | `C:\katago\kata1-b18c384nbt-*.bin.gz` | Path to model weights |
| `KATAGO_CONFIG` | `config/default_gtp.cfg` | Path to KataGo config |
| `KATAGO_MAX_WAIT` | `300` | Per-query engine timeout, seconds (lower it, e.g. `5`, for a hung-engine demo) |
| `PORT` | `5000` | Server port |
| `DEFAULT_MAX_VISITS` | `3000` | Default analysis visits |
| `QUICK_MAX_VISITS` | `100` | Visits for quick analysis |
| `JWT_SECRET` | *(dev default)* | Secret used to sign JWT session tokens — **set a strong value in production** |
| `FLASK_SECRET_KEY` | *(dev default)* | Flask session secret — **set a strong value in production** |
| `CB_THRESHOLD` | `3` | Consecutive engine failures before the Circuit Breaker opens |
| `CB_RESET_TIMEOUT` | `30` | Seconds the breaker stays OPEN before a trial call (HALF_OPEN) |
| `CB_DEMO_FAULT_INJECTION` | *(unset)* | **Demo only** — replace the engine with a toggleable fault injector (see *Circuit Breaker demos*) |

> **Security note:** the default `JWT_SECRET`, the Flask `SECRET_KEY`, and the open CORS policy are convenient for local/LAN use and demos. For a public deployment, set a strong `JWT_SECRET`, restrict CORS origins, and serve over HTTPS.

### Circuit Breaker demos

Two ways to see the Circuit Breaker trip and recover:

- **Standalone (no GPU):** `python server/demo_circuit_breaker.py` drives the real
  `CircuitBreaker` through CLOSED → OPEN (fail-fast) → HALF_OPEN → CLOSED and prints
  a timestamped log.
- **Live web (no GPU):** start with `CB_DEMO_FAULT_INJECTION=1` (and a short
  `CB_RESET_TIMEOUT`, e.g. `8`) to replace the engine with a fault injector. A
  bottom-right button toggles failures; the status indicator cycles red → amber →
  green as the breaker opens and recovers. The toggle and the demo engine exist
  only when the flag is set.
- **Real fault (needs KataGo):** with the real engine running, set a short
  `KATAGO_MAX_WAIT` (e.g. `5`) and **freeze** the engine with
  `./demo_suspend_katago.ps1` (`-Resume` to unfreeze). Frozen, the engine stays
  "running" so requests reach the breaker and time out — a genuine hung-engine
  fault that trips it and then recovers. (Killing the process does *not* trip the
  breaker — a dead engine is caught by the `is_running()` check before the
  breaker.)

See `TP2/demo-circuit-breaker.md` for the full runbook.

## How It Works

1. **Backend**: Flask + Socket.IO server manages a KataGo subprocess via the Analysis JSON API. The `KataGoFacade` hides the subprocess and protocol; a `CircuitBreaker` wraps every engine call.
2. **Authentication**: `require_auth` (a Proxy) verifies a JWT on every analysis request; `require_admin` guards the admin API.
3. **Frontend**: Canvas-based Go board with real-time WebSocket updates and a zh/en i18n layer.
4. **Analysis**: KataGo returns top move candidates with win rates, scores, and principal variations — rendered as KaTrain-style colored circles. Win rate and score are normalised to Black's perspective. Moving on the board cancels the previous in-flight analysis.
5. **Recognition**: Photos of real boards are processed by a two-stage CNN pipeline:
   - **FCOS** (ResNet50-FPN) detects the four corners of the board
   - **EfficientNet-B3** classifies each intersection as empty / black / white

## Credits

- [KataGo](https://github.com/lightvector/KataGo) by lightvector — the Go engine
- [noword/image2sgf](https://github.com/noword/image2sgf) — CNN board recognition models
- [KaTrain](https://github.com/sanderland/katrain) — UI design inspiration and stone sounds

## License

MIT
