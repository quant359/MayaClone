<p align="center">
  <img src="https://img.shields.io/badge/voice--first-companion-8b5cf6?style=for-the-badge" alt="Voice-First Companion" />
  <img src="https://img.shields.io/badge/runs_locally-Node.js-10b981?style=for-the-badge&logo=node.js" alt="Node.js" />
  <img src="https://img.shields.io/badge/license-MIT-blue?style=for-the-badge" alt="MIT License" />
</p>

# 🎙️ MayaClone

**Open-source voice chat app built to clone Sesame's Maya experience.**

MayaClone is a self-hosted browser voice app. You talk, it transcribes with Deepgram, generates replies with your LLM, and speaks back through EchoTTS with Maya's voice.

> **Mic → Deepgram STT → LLM → Echo-TTS → Speaker** — all streamed in real time.

---

## ✨ What It Does

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
| **One-command setup** | `./start.sh` creates `.env`, checks TTS, and starts the app |

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

## 🚀 Install

### 1. What you need

- **Node.js** 18+
- **Deepgram API key** — [get one free](https://deepgram.com)
- **LLM API key** — Groq (free tier), OpenRouter, OpenAI, Gemini, or any OpenAI-compatible endpoint
- **EchoTTS** — running locally or on another machine

### 2. Clone and start MayaClone

```bash
git clone https://github.com/quant359/MayaClone.git
cd MayaClone
./start.sh
```

`./start.sh` is the normal setup path. It asks:

- `Deepgram key`:
  Paste your Deepgram API key for speech-to-text.
- `Provider [1-5]`:
  Pick your LLM provider. `2` is Groq. `5` is any OpenAI-compatible endpoint.
- `... key`:
  Paste the API key for the provider you chose.
- `Model`:
  Press Enter to keep the default model, or type your own.
- `TTS Endpoint`:
  Use `http://localhost:8002` for a local EchoTTS container, or paste a remote URL like `https://your-tts-host`.
- `Generate self-signed SSL certs?`:
  Optional. Say `y` only if you need HTTPS for mic access from another device.

After that, the launcher checks the TTS server and starts MayaClone.

### 3. Open it

```
http://localhost:3000
```

Tap the orb to start talking.

---

## 🔊 EchoTTS Setup

MayaClone expects an EchoTTS-compatible backend at `TTS_ENDPOINT`. The recommended container already includes the Maya voice.

### Docker requirements

- Docker
- NVIDIA Container Toolkit (`nvidia-docker`)
- NVIDIA GPU with ≥12 GB VRAM
- Host driver that supports **CUDA 12.8** containers

### Start EchoTTS on a 24 GB GPU

Use this for cards like a `3090` or `4090`.

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

### Start EchoTTS on a 12 GB GPU

Use this for cards like a `3060` or `4060`.

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

### Check that EchoTTS is up

```bash
curl http://127.0.0.1:8002/health
# → {"status":"ok"}
```

If that works, leave `TTS_ENDPOINT=http://localhost:8002` in MayaClone.

### Use a remote TTS server

If EchoTTS is running on another machine, set:

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

The default setup uses Groq with `moonshotai/kimi-k2-instruct-0905`.

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

These are the current EchoTTS defaults used by MayaClone:

| Variable | Default | Description |
|----------|---------|-------------|
| `TTS_BLOCK_SIZES` | `32,128,480` | Default denoising block sizes |
| `TTS_NUM_STEPS` | `15,20,20` | Default denoising steps per block |
| `TTS_FIRST_CHUNK_BLOCK_SIZES` | `32,128,480` | First chunk block sizes |
| `TTS_FIRST_CHUNK_NUM_STEPS` | `6,12,20` | First chunk step profile |
| `TTS_TOKEN_TARGETS` | `15,40,50,...,61` | Token count targets per TTS chunk |
| `TTS_CHUNK_FLEX` | `1.0` | How far chunking can stretch for natural boundaries |
| `TTS_CFG_SCALE_TEXT` | `2.5` | Text classifier-free guidance scale |
| `TTS_CFG_SCALE_SPEAKER` | `5` | Speaker classifier-free guidance scale |
| `TTS_TRUNCATION_FACTOR` | `0.9` | Audio truncation factor |
| `TTS_SPEAKER_KV_SCALE` | `1` | Speaker KV scaling |
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
├── certs/                  # Auto-generated SSL certs (gitignored)
└── logs/                   # Runtime logs (gitignored)
```

---

## 📄 License

MIT — see [LICENSE](./LICENSE).
