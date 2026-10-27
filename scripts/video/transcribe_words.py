"""transcribe_words.py (#11208): transcrição com tempo por palavra para a montagem do vídeo diário.

Chamado por `scripts/video-montagem.ts` (subcomandos `transcribe`, `srt`, `review`), nunca
direto pelo editor. Modelo faster-whisper `large-v3-turbo` na CPU em int8 (a CUDA do Neo não
funciona: falta `cublas64_12.dll`, medido em 26/10/2026).

Rodar com `python -P` (não `-I`: `-I` esconde o site-packages do usuário, onde o
faster-whisper está instalado) e `HF_HUB_OFFLINE=1` (o modelo já está no cache do Hugging
Face; sem a variável o hub tenta a rede a cada carga). O TS passa os dois.

Uso:
    python -P scripts/video/transcribe_words.py AUDIO.wav SAIDA.json
        [--model large-v3-turbo] [--initial-prompt "..."] [--vad] [--language pt]

Saída (JSON, gravada de forma atômica):
    {"duration": s, "model": "...", "segments": [
        {"start": s, "end": s, "text": "...", "words": [{"start": s, "end": s, "text": "..."}]}]}
"""

import argparse
import json
import os
import sys


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("audio")
    ap.add_argument("out")
    ap.add_argument("--model", default="large-v3-turbo")
    ap.add_argument("--initial-prompt", default="")
    ap.add_argument("--vad", action="store_true", help="filtro VAD (bruto: sim; áudio já montado: não)")
    ap.add_argument("--language", default="pt")
    a = ap.parse_args()

    if not os.path.isfile(a.audio):
        print(f"transcribe_words: áudio não encontrado: {a.audio}", file=sys.stderr)
        return 1
    os.environ.setdefault("HF_HUB_OFFLINE", "1")
    try:
        from faster_whisper import WhisperModel
    except ImportError as e:
        print(f"transcribe_words: faster-whisper indisponível ({e}); instalar com pip install faster-whisper", file=sys.stderr)
        return 1

    model = WhisperModel(a.model, device="cpu", compute_type="int8")
    segs, info = model.transcribe(
        a.audio,
        language=a.language,
        vad_filter=a.vad,
        beam_size=5,
        word_timestamps=True,
        initial_prompt=a.initial_prompt or None,
    )
    out = {"duration": info.duration, "model": a.model, "segments": []}
    for s in segs:
        out["segments"].append(
            {
                "start": round(s.start, 3),
                "end": round(s.end, 3),
                "text": s.text.strip(),
                "words": [
                    {"start": round(w.start, 3), "end": round(w.end, 3), "text": w.word.strip()}
                    for w in (s.words or [])
                ],
            }
        )
    tmp = a.out + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False)
    os.replace(tmp, a.out)
    print(json.dumps({"ok": True, "duration": info.duration, "segments": len(out["segments"])}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
