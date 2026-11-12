"""Speaker embeddings (who a voice sounds like), offline, with sherpa-onnx. JSON lines on stdio:
in  {"id": n, "pcm": "<base64 16 kHz mono PCM16>"}
out {"id": n, "ok": true, "embedding": [floats], "ms": n} or {"id": n, "ok": false, "error": "..."}."""
import argparse
import base64
import contextlib
import json
import sys
import time

parser = argparse.ArgumentParser()
parser.add_argument('--model', required=True)
parser.add_argument('--threads', type=int, default=2)
args = parser.parse_args()

# Native runtime diagnostics belong on stderr, never the response channel.
with contextlib.redirect_stdout(sys.stderr):
    import numpy as np
    import sherpa_onnx
    extractor = sherpa_onnx.SpeakerEmbeddingExtractor(
        sherpa_onnx.SpeakerEmbeddingExtractorConfig(model=args.model, num_threads=args.threads, provider='cpu')
    )

for line in sys.stdin:
    request = {}
    try:
        request = json.loads(line)
        pcm = base64.b64decode(request['pcm'], validate=True)
        if not pcm or len(pcm) % 2 or len(pcm) > 16000 * 2 * 60:
            raise ValueError('Expected up to 60 seconds of 16kHz mono PCM16 audio')
        started = time.perf_counter()
        samples = np.frombuffer(pcm, dtype='<i2').astype(np.float32) / 32768.0
        with contextlib.redirect_stdout(sys.stderr):
            stream = extractor.create_stream()
            stream.accept_waveform(16000, samples)
            stream.input_finished()
            if not extractor.is_ready(stream):
                raise ValueError('Too little audio for an embedding')
            embedding = extractor.compute(stream)
        reply = {'id': request['id'], 'ok': True, 'embedding': [float(x) for x in embedding],
                 'ms': round((time.perf_counter() - started) * 1000)}
    except Exception as error:
        reply = {'id': request.get('id'), 'ok': False, 'error': str(error)}
    print(json.dumps(reply, ensure_ascii=True), flush=True)
