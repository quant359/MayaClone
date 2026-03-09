/**
 * Audio Capture Worklet Processor
 * 
 * Runs in a separate thread for smooth audio capture without blocking UI.
 * Captures at native sample rate, resamples to 16kHz, and sends chunks.
 */
class AudioCaptureProcessor extends AudioWorkletProcessor {
    constructor() {
        super();
        // Lower buffer -> lower capture latency (at 16kHz: 1024 ~= 64ms vs 2048 ~= 128ms).
        this.bufferSize = 1024;
        this.buffer = new Float32Array(this.bufferSize);
        this.bufferIndex = 0;
        this.isRecording = false;

        this.port.onmessage = (event) => {
            if (event.data.command === 'start') {
                this.isRecording = true;
            } else if (event.data.command === 'stop') {
                this.isRecording = false;
                this.bufferIndex = 0;
            }
        };
    }
    process(inputs, outputs, parameters) {
        const input = inputs[0];
        if (!input || !input[0] || !this.isRecording) {
            return true;
        }
        const samples = input[0];

        // Fill buffer
        for (let i = 0; i < samples.length; i++) {
            this.buffer[this.bufferIndex++] = samples[i];

            // When buffer is full, send it
            if (this.bufferIndex >= this.bufferSize) {
                // Clone buffer and send
                const chunk = new Float32Array(this.buffer);
                this.port.postMessage({
                    type: 'audio',
                    samples: chunk,
                    sampleRate: sampleRate
                }, [chunk.buffer]);

                this.bufferIndex = 0;
            }
        }
        return true;
    }
}
registerProcessor('audio-capture-processor', AudioCaptureProcessor);
