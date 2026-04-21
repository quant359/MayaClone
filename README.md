# MayaClone

Browser voice chat app for talking to Maya with:

- your microphone
- Deepgram for speech-to-text
- your own LLM
- `quant359/voxmaya-v1` for voice output

This repo is now set up for **Vox only**.

If you want the shortest version:

1. Start the Vox Docker container.
2. Start MayaClone with `./start-vox.sh`.
3. Open `http://localhost:3000`.

Docker image for the voice server:
https://hub.docker.com/r/quant359/voxmaya-v1

## What You Need

Before you start, make sure you have:

- a computer with an NVIDIA GPU
- Docker installed
- Node.js 18 or newer installed
- a Deepgram API key
- an LLM API key

MayaClone does not include the LLM or speech-to-text service by itself. You bring those keys.

## Easy Setup

### Step 1: Start the Vox voice server

Run this in a terminal:

```bash
docker run -d \
  --name voxmaya-v1 \
  --restart unless-stopped \
  --gpus all \
  -p 8002:8002 \
  -v voxmaya_outputs:/data/outputs \
  quant359/voxmaya-v1:latest
```

What this does:

- downloads the Maya voice server if you do not already have it
- starts it in the background
- makes it available at `http://localhost:8002`

When it is running, you can open:

```text
http://localhost:8002/studio
```

That page is the built-in Vox studio UI.

### Step 2: Download and start MayaClone

```bash
git clone https://github.com/quant359/MayaClone.git
cd MayaClone
./start-vox.sh
```

On first run, MayaClone will create a `.env` file for you if it does not exist.

If `node_modules` are missing, it will also install them automatically.

### Step 3: Open MayaClone

Open this in your browser:

```text
http://localhost:3000
```

Then click the orb and start talking.

## First-Time Questions

The first time you run MayaClone, make sure these values are set in `.env`:

```env
DEEPGRAM_API_KEY=your_deepgram_key_here
LLM_API_KEY=your_llm_key_here
TTS_BACKEND=vox
TTS_ENDPOINT=http://localhost:8002
```

If you already have a `.env`, just check that `TTS_BACKEND` is `vox` and `TTS_ENDPOINT` points to `http://localhost:8002`.

## Recommended Defaults

These are the main Vox settings used by this repo:

```env
TTS_BACKEND=vox
TTS_ENDPOINT=http://localhost:8002
TTS_VOICE=step_0003500
VOX_CFG=2.0
VOX_MAX_LEN=384
VOX_SPLIT_STEERS=1
VOX_SEAM_MS=45
```

MayaClone is tuned around this Vox setup.

## If You Are New To This

Here is the plain-English version:

- `voxmaya-v1` is the voice server that actually generates Maya's audio
- MayaClone is the web app you open in your browser
- MayaClone sends text to the Vox server at port `8002`
- MayaClone itself runs on port `3000`

So:

- `http://localhost:8002` = the voice engine
- `http://localhost:3000` = the app you talk to

## Optional Vox Docker Settings

The Docker image also supports extra runtime settings.

Example:

```bash
docker run -d \
  --name voxmaya-v1 \
  --restart unless-stopped \
  --gpus all \
  -p 8002:8002 \
  -v voxmaya_outputs:/data/outputs \
  -e VOX_PREWARM=1 \
  -e VOX_CFG=1.3 \
  -e VOX_TEMPERATURE=0.90 \
  -e VOX_INFERENCE_TIMESTEPS=20 \
  -e VOX_MAX_GENERATE_LENGTH=512 \
  -e VOX_SEAM_MS=50 \
  quant359/voxmaya-v1:latest
```

Useful Vox container variables:

- `VOX_API_PORT` default `8002`
- `VOX_PREWARM` default `1`
- `VOX_CFG` default `1.3`
- `VOX_TEMPERATURE` default `0.90`
- `VOX_INFERENCE_TIMESTEPS` default `20`
- `VOX_MAX_GENERATE_LENGTH` default `512`
- `VOX_SEAM_MS` default `50`
- `VOX_API_OUTPUT_DIR` default `/data/outputs`

Source:
https://hub.docker.com/r/quant359/voxmaya-v1

## LLM Providers

MayaClone works with OpenAI-compatible chat APIs.

Examples:

- Groq
- OpenRouter
- OpenAI
- Gemini's OpenAI-compatible endpoint
- Ollama
- vLLM
- other compatible providers

Important `.env` values:

```env
LLM_BASE_URL=https://openrouter.ai/api/v1
LLM_API_KEY=your_key_here
LLM_MODEL=openai/gpt-4o-mini
LLM_MAX_TOKENS=300
LLM_MAX_CONTEXT_TOKENS=128000
```

## Speech-To-Text

MayaClone uses Deepgram for speech-to-text.

Supported models:

- `flux-general-en`
- `nova-3`

Example:

```env
DEEPGRAM_MODEL=flux-general-en
```

## What This Version Adds

This repo includes a Vox-focused MayaClone build with:

- Vox-only TTS setup
- in-browser provider settings
- editable system prompt
- text input mode
- silence trigger controls
- mic mute handling
- Vox-aware chunking and steer preservation

## Troubleshooting

### The app opens, but Maya does not speak

Check that the Vox container is running:

```bash
docker ps
```

You should see a container named `voxmaya-v1`.

Also test:

```bash
curl http://localhost:8002/health
```

### `./start-vox.sh` says Vox is not reachable

That usually means the Docker container is not started yet, or it is not using port `8002`.

Start it again with the command in Step 1.

### The microphone does not work

Try opening MayaClone at:

```text
http://localhost:3000
```

Most browsers allow microphone access on `localhost`.

### I changed machines or want to use another Vox server

Change this in `.env`:

```env
TTS_ENDPOINT=http://your-server-ip:8002
```

## Main Files

- `server.js` - main voice pipeline server
- `start-vox.sh` - easiest launcher for this Vox-based setup
- `public/index.html` - browser UI
- `prompts/maya.md` - default Maya prompt
- `config/silence-triggers.json` - silence behavior
- `.env.example` - sample configuration

## License

MayaClone code in this repository is released under the MIT license.

See:

- [LICENSE](./LICENSE)
- [THIRD_PARTY_LICENSES.md](./THIRD_PARTY_LICENSES.md)
