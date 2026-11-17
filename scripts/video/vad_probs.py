"""vad_probs.py: probabilidade de fala do Silero VAD por janela de 32 ms (#13369, R2 da #13199).

MEDIÇÃO: não entra no `build`. O voto é comparado com o corte que o editor
aprovou por `scripts/video-medicoes.ts vad` (lógica pura em
`scripts/lib/diaria/video-vad-vote.ts`). Usa o `silero_vad_v6.onnx` que já vem
no faster-whisper do venv da montagem (com o `onnxruntime`), sem dependência
nova.

Uso:
    python -P scripts/video/vad_probs.py AUDIO.wav SAIDA.json
      AUDIO: WAV PCM 16 bits, mono, 16 kHz (o `audio.wav` do `transcribe`).
      SAIDA: {"hopS": 0.032, "sampleRate": 16000, "probs": [0.012, ...]}
             (uma probabilidade por janela de 512 amostras, a partir de 0 s).
"""

import json
import os
import sys
import wave

WINDOW = 512
RATE = 16000


def main() -> int:
    if len(sys.argv) != 3:
        print(__doc__, file=sys.stderr)
        return 2
    try:
        import numpy as np
        from faster_whisper.vad import get_vad_model
    except ImportError as e:
        print(f"vad_probs: faster-whisper/onnxruntime indisponível neste Python ({e}); use o venv da montagem (scripts/video/montagem-requirements.txt)", file=sys.stderr)
        return 1
    try:
        w = wave.open(sys.argv[1], "rb")
    except (OSError, wave.Error) as e:
        print(f"vad_probs: não li {sys.argv[1]}: {e}", file=sys.stderr)
        return 1
    with w:
        if w.getsampwidth() != 2 or w.getframerate() != RATE:
            print(f"vad_probs: esperado PCM 16 bits a {RATE} Hz (o audio.wav do transcribe); veio {8 * w.getsampwidth()} bits a {w.getframerate()} Hz", file=sys.stderr)
            return 1
        ch = w.getnchannels()
        raw = np.frombuffer(w.readframes(w.getnframes()), dtype="<i2")
    audio = raw.reshape(-1, ch).mean(axis=1).astype("float32") / 32768.0 if ch > 1 else raw.astype("float32") / 32768.0
    if audio.size == 0:
        print("vad_probs: áudio vazio", file=sys.stderr)
        return 1
    pad = (-audio.size) % WINDOW
    if pad:
        audio = np.concatenate([audio, np.zeros(pad, dtype="float32")])
    probs = get_vad_model()(audio).reshape(-1)
    out = {"hopS": WINDOW / RATE, "sampleRate": RATE, "probs": [round(float(p), 3) for p in probs]}
    with open(sys.argv[2] + ".tmp", "w", encoding="utf-8") as f:
        json.dump(out, f)
    os.replace(sys.argv[2] + ".tmp", sys.argv[2])
    return 0


if __name__ == "__main__":
    sys.exit(main())
