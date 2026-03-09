<p align="center">
  <img src="https://img.shields.io/badge/voice--first-companion-8b5cf6?style=for-the-badge" alt="Voice-First Companion" />
  <img src="https://img.shields.io/badge/runs_locally-Node.js-10b981?style=for-the-badge&logo=node.js" alt="Node.js" />
  <img src="https://img.shields.io/badge/license-MIT-blue?style=for-the-badge" alt="MIT License" />
</p>

# 🎙️ MayaClone

**Open-source, real-time voice companion that talks like a real person.**

MayaClone is a fully self-hostable voice chat app that clones Sesame's "Maya" experience. You speak into your browser — Maya listens, thinks, and talks back with natural, expressive speech. The whole pipeline runs locally on your machine with a single command.

> **Mic → Deepgram STT → LLM → Echo-TTS → Speaker** — all streamed in real time.

---

## ✨ What Makes This Different

| Feature | Details |
|---|---|
| **Real-time voice pipeline** | Full duplex — speak and interrupt naturally, no push-to-talk |
| **Barge-in / interruption** | Start talking mid-sentence and Maya stops, just like a real conversation |
| **Streaming TTS** | Audio plays sentence-by-sentence as the LLM generates, near-instant first response |
| **Browser-based** | Works in any modern browser. Beautiful dark UI with animated reactive orb |
| **Bring your own LLM** | Works with Groq, OpenRouter, OpenAI, Gemini, Ollama, vLLM — anything OpenAI-compatible |
| **Configurable persona** | Maya's personality lives in a single markdown file you can edit |
| **Conversation memory** | Remembers your name and conversation history across sessions (stored in browser) |
| **Silence awareness** | Maya notices when you go quiet and initiates conversation naturally |
| **One-command setup** | Interactive `start.sh` wizard handles everything |

---

## 🏗️ Architecture

```
┌──────────────────────────────────────────────────────────┐
│                     Browser (Client)                     │
│  ┌────────────┐  ┌──────────────┐  ┌──────────────────┐ │
│  │ Microphone  │  │ Animated Orb │  │ PCM Audio Player │ │
│  │ Capture     │  │ (state viz)  │  │ (streamed)       │ │
│  └──────┬─────┘  └──────────────┘  └───────▲──────────┘ │
│         │           Socket.IO               │            │
└─────────┼───────────────────────────────────┼────────────┘
          │ 16-bit PCM audio                  │ PCM audio chunks
          ▼                                   │
┌─────────────────────────────── server.js ──────────────────┐
│                                                            │
│  ┌─────────────────┐  ┌──────────────┐  ┌──────────────┐  │
│  │ Deepgram STT    │  │ LLM          │  │ Echo-TTS     │  │
│  │ (WebSocket)     │→ │ (streaming)  │→ │ (chunked)    │  │
│  │ Nova-3 / Flux   │  │ OpenAI-compat│  │ PCM output   │  │
│  └─────────────────┘  └──────────────┘  └──────────────┘  │
│                                                            │
│  VoiceSession: manages pipeline, history,                  │
│  barge-in, silence triggers, opening messages              │
└────────────────────────────────────────────────────────────┘
```

---

## 🚀 Quick Start

### Prerequisites

- **Node.js** 18+
- **Deepgram API key** — [get one free](https://deepgram.com)
- **LLM API key** — Groq (free tier), OpenRouter, OpenAI, Gemini, or any OpenAI-compatible endpoint
- **Echo-TTS** — Docker container with an NVIDIA GPU (12 GB+ VRAM)

### 1. Clone & Run

```bash
git clone https://github.com/YOUR_USERNAME/MayaClone.git
cd MayaClone
./start.sh
```

That's it. The interactive launcher walks you through everything:

```
  ╔══════════════════════════════════════════╗
  ║          🎙️  MayaClone v1.0              ║
  ╚══════════════════════════════════════════╝

  ✓ Created .env from template
  ? Deepgram key: ••••••••••
  ? Provider [1-5]: 2  (Groq)
  ? Groq key: ••••••••••
  ✓ Groq configured
  ✓ TTS backend reachable at http://localhost:8002
  ✓ All checks passed

  🚀  Starting MayaClone on port 3000...
```

### 2. Open in Browser

```
http://localhost:3000
```

Tap the orb to start talking.

---

## 🔊 Echo-TTS Setup

MayaClone uses **Echo-TTS** for speech synthesis. The recommended Docker image ships with the Maya voice baked in.

### Requirements

- Docker
- NVIDIA Container Toolkit (`nvidia-docker`)
- NVIDIA GPU with ≥12 GB VRAM
- Host driver compatible with CUDA 12.8

### Run the Container

**24 GB GPU** (RTX 3090 / 4090 — higher quality):

```bash
docker run -d \
  --name echo-tts-maya \
  --restart unless-stopped \
  --gpus all \
  -p 8002:8002 \
  -v echo_tts_cache:/var/cache/echo-tts \
  -e ECHO_GPU_PROFILE=24gb \
  quant359/echo-tts-maya:latest
```

**12 GB GPU** (RTX 3060 / 4060 — lower VRAM):

```bash
docker run -d \
  --name echo-tts-maya \
  --restart unless-stopped \
  --gpus all \
  -p 8002:8002 \
  -v echo_tts_cache:/var/cache/echo-tts \
  -e ECHO_GPU_PROFILE=12gb \
  quant359/echo-tts-maya:latest
```

### Verify

```bash
curl http://127.0.0.1:8002/health
# → {"status":"ok"}
```

### Remote TTS

If your TTS server is on another machine, just set the endpoint in `.env`:

```env
TTS_ENDPOINT=https://your-tts-host.example
```

---

## 🧠 LLM Providers

MayaClone talks to any OpenAI-compatible chat completions API. The setup wizard lets you pick:

| # | Provider | Base URL | Notes |
|---|----------|----------|-------|
| 1 | **OpenRouter** | `https://openrouter.ai/api/v1` | Wide model selection |
| 2 | **Groq** | `https://api.groq.com/openai/v1` | Free tier, fast inference |
| 3 | **OpenAI** | `https://api.openai.com/v1` | GPT-4o and friends |
| 4 | **Gemini** | `https://generativelanguage.googleapis.com/v1beta/openai` | Google's OpenAI-compatible endpoint |
| 5 | **Custom** | your URL | Ollama, vLLM, or any compatible server |

The default recommended model is `moonshotai/kimi-k2-instruct-0905` on Groq.

---

## 🎤 Speech-to-Text (Deepgram)

MayaClone supports two Deepgram engines:

| Model | Protocol | Best For |
|-------|----------|----------|
| `flux-general-en` | v2 WebSocket | Lower latency, turn-aware endpointing |
| `nova-3` | v1 WebSocket | General purpose, wider language support |

Set in `.env`:

```env
DEEPGRAM_MODEL=flux-general-en
```

Shorthand `flux` is automatically normalized to `flux-general-en`.

### Flux Tuning (optional)

```env
FLUX_EAGER_EOT_THRESHOLD=0.45
FLUX_EOT_THRESHOLD=0.30
FLUX_EOT_TIMEOUT_MS=800
```

---

## ⚙️ Configuration Reference

All configuration lives in `.env`. The launcher creates it from `.env.example` on first run.

### Core

| Variable | Default | Description |
|----------|---------|-------------|
| `DEEPGRAM_API_KEY` | — | Your Deepgram API key |
| `DEEPGRAM_MODEL` | `flux-general-en` | STT model (`flux-general-en` or `nova-3`) |
| `LLM_BASE_URL` | `https://api.groq.com/openai/v1` | LLM endpoint |
| `LLM_API_KEY` | — | Your LLM API key |
| `LLM_MODEL` | `moonshotai/kimi-k2-instruct-0905` | Chat model name |
| `LLM_MAX_TOKENS` | `300` | Max tokens per response |
| `TTS_ENDPOINT` | `http://localhost:8002` | Echo-TTS endpoint |
| `TTS_VOICE` | `mayalong9` | TTS voice identifier |
| `PORT` | `3000` | Server port |

### TTS Tuning

These control how text is chunked and sent to Echo-TTS for optimal streaming latency:

| Variable | Default | Description |
|----------|---------|-------------|
| `TTS_BLOCK_SIZES` | `212,212,212` | Denoising block sizes |
| `TTS_NUM_STEPS` | `25,25,25` | Denoising steps per block |
| `TTS_FIRST_CHUNK_BLOCK_SIZES` | `32,128,480` | Smaller blocks for first chunk (faster TTFB) |
| `TTS_FIRST_CHUNK_NUM_STEPS` | `6,12,20` | Fewer steps for first chunk |
| `TTS_TOKEN_TARGETS` | `15,40,50,...,61` | Token count targets per TTS chunk |
| `TTS_CFG_SCALE_TEXT` | `2.5` | Text classifier-free guidance scale |
| `TTS_CFG_SCALE_SPEAKER` | `5` | Speaker classifier-free guidance scale |
| `TTS_TRUNCATION_FACTOR` | `0.9` | Audio truncation factor |
| `TTS_SEED` | `0` | Seed for deterministic generation |
| `DEBUG_TTS` | `0` | Set to `1` for verbose TTS logging |

---

## 🎨 The UI

MayaClone ships with a single-page browser UI featuring:

- **Reactive orb** — changes color and animation based on state (idle → listening → thinking → speaking)
- **Real-time transcript** — see what you said and what Maya says, token by token
- **Call timer** — tracks conversation duration
- **Mute toggle** — mute your mic without ending the session
- **Memory controls** — clear conversation history or reset your name
- **Mobile-first** — responsive design, works on phones and tablets

The orb visually responds to audio levels in real time — it breathes, pulses, and glows based on who's talking and how loud.

---

## 🗣️ Maya's Persona

Maya's personality is defined in [`prompts/maya.md`](prompts/maya.md). She's a 26-year-old freelance writer from Brooklyn with a psychology background, strong opinions, and a dry sense of humor. The prompt includes:

- Detailed backstory and identity
- Speech style rules (1-3 sentences, natural fillers, vocal reactions)
- Conversation approach (react, riff, challenge, tease)
- Technical rules for the TTS engine (action tags, number formatting)

**Want a different persona?** Edit `prompts/maya.md`. The system prompt is loaded at server startup.

---

## 💬 Silence Triggers

Maya doesn't just wait in silence — she reacts. Configured in [`config/silence-triggers.json`](config/silence-triggers.json):

- After **7 seconds** of silence: teases you, asks if your mic is broken, or jokes about the quiet
- After **14 seconds**: escalates playfully — narrates what she thinks you're doing

She also sends contextual **opening messages** when you connect, adapting based on whether she remembers you and knows your name.

---

## 🔒 HTTPS

Microphone access from non-localhost devices requires HTTPS. The launcher can generate self-signed certs:

```bash
# During start.sh:
? Generate self-signed SSL certs? [y/N]: y
✓ SSL certs generated in certs/
```

Then access at `https://localhost:3000` (accept the browser security warning).

---

## 📁 Project Structure

```
MayaClone/
├── server.js              # Voice pipeline server (Express + Socket.IO)
├── start.sh               # Interactive setup launcher
├── package.json
├── .env.example            # Configuration template
├── public/
│   ├── index.html          # Full UI (single-page app)
│   └── audio-worklet.js    # Web Audio worklet for mic capture
├── prompts/
│   └── maya.md             # Maya's personality prompt
├── config/
│   └── silence-triggers.json  # Silence detection + opening messages
├── voices/
│   └── maya-v2/            # Voice reference audio
├── certs/                  # Auto-generated SSL certs (gitignored)
└── logs/                   # Runtime logs (gitignored)
```

---

## 🚫 Do Not Commit

These are in `.gitignore` and should never be checked in:

- `.env` — contains your API keys
- `certs/` — generated SSL certificates
- `logs/` — runtime logs
- `node_modules/` — dependencies

---

## 📄 License

MIT — see [LICENSE](./LICENSE).
