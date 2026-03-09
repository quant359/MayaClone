# Third-Party Licensing Notes

This repository is MIT-licensed. That applies to MayaClone's own code only.

MayaClone is commonly used with Echo-TTS as its speech synthesis backend. Echo-TTS has different upstream licensing terms than this repository.

## Echo-TTS

- Echo-TTS source code is MIT-licensed, except where individual source files state otherwise.
- Echo-TTS states that its model weights are licensed under `CC-BY-NC-SA-4.0`.
- Echo-TTS also states that generated outputs are `CC-BY-NC-SA-4.0` because it depends on Fish Audio's `S1-DAC` autoencoder.

## Practical effect for MayaClone users

If you run MayaClone with the recommended EchoTTS container, the app code here is still MIT, but the TTS backend you are using is subject to Echo-TTS and Fish Audio licensing terms.

That means you should assume:

- MayaClone application code: MIT
- Echo-TTS code: MIT, with possible file-level exceptions upstream
- Echo-TTS model weights: `CC-BY-NC-SA-4.0`
- Echo-TTS generated voice output: `CC-BY-NC-SA-4.0`

If you need commercial rights, verify the exact upstream model and backend licenses before deploying.

## Upstream references

- Echo-TTS package page: https://pypi.org/project/echo-tts/
- Fish Speech repository: https://github.com/fishaudio/fish-speech
- Fish `S1-DAC` weights mirror used by Echo-TTS packaging: https://huggingface.co/jordand/fish-s1-dac-min
- Creative Commons `CC-BY-NC-SA-4.0`: https://creativecommons.org/licenses/by-nc-sa/4.0/
