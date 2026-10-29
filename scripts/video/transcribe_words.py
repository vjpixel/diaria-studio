"""transcribe_words.py (#11208): transcrição com tempo por palavra para a montagem do vídeo diário.

Chamado por `scripts/video-montagem.ts` (subcomandos `transcribe`, `srt`, `review`), nunca
direto pelo editor. Modelo faster-whisper `large-v3-turbo` na CPU em int8 (a CUDA do Neo não
funciona: falta `cublas64_12.dll`, medido em 26/10/2026).

Rodar com `python -P` (não `-I`: `-I` esconde o site-packages do usuário, onde o
faster-whisper está instalado) e `HF_HUB_OFFLINE=1` (o modelo já está no cache do Hugging
Face; sem a variável o hub tenta a rede a cada carga). O TS passa os dois.

Uso:
    python -P scripts/video/transcribe_words.py AUDIO.wav SAIDA.json
        [--model large-v3-turbo] [--initial-prompt "..."] [--vad] [--language pt] [--no-condition]
        [--windows JANELAS.json]

Saída (JSON, gravada de forma atômica):
    {"duration": s, "model": "...", "segments": [
        {"start": s, "end": s, "text": "...", "words": [{"start": s, "end": s, "text": "..."}]}]}

Com `--windows` (#11500, refino dos cortes): JANELAS.json é uma lista de
`{"key": "...", "start": s, "end": s}` no tempo do AUDIO; cada janela é transcrita
sozinha com o modelo carregado uma vez só, e a saída vira
    {"model": "...", "windows": [{"key": "...", "start": s, "end": s, "segments": [...]}]}
com os tempos já no tempo do AUDIO (não da janela).
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
    ap.add_argument(
        "--no-condition",
        action="store_true",
        help="condition_on_previous_text=False (retranscrição de trecho curto, #11364)",
    )
    ap.add_argument("--windows", default=None, help="JSON com as janelas a transcrever, uma a uma (#11500)")
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

    def segments_of(audio, offset=0.0):
        segs, info = model.transcribe(
            audio,
            language=a.language,
            vad_filter=a.vad,
            beam_size=5,
            word_timestamps=True,
            initial_prompt=a.initial_prompt or None,
            condition_on_previous_text=not a.no_condition,
        )
        out_segs = []
        for s in segs:
            out_segs.append(
                {
                    "start": round(s.start + offset, 3),
                    "end": round(s.end + offset, 3),
                    "text": s.text.strip(),
                    "words": [
                        {"start": round(w.start + offset, 3), "end": round(w.end + offset, 3), "text": w.word.strip()}
                        for w in (s.words or [])
                    ],
                }
            )
        return out_segs, info

    if a.windows:
        from faster_whisper import decode_audio

        with open(a.windows, encoding="utf-8") as f:
            windows = json.load(f)
        sr = 16000
        audio = decode_audio(a.audio, sampling_rate=sr)
        out = {"model": a.model, "windows": []}
        for w in windows:
            start, end = float(w["start"]), float(w["end"])
            piece = audio[int(start * sr) : int(end * sr)]
            segs = segments_of(piece, start)[0] if len(piece) > sr // 10 else []
            out["windows"].append({"key": w["key"], "start": start, "end": end, "segments": segs})
        tmp = a.out + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(out, f, ensure_ascii=False)
        os.replace(tmp, a.out)
        print(json.dumps({"ok": True, "windows": len(out["windows"])}))
        return 0

    segs, info = segments_of(a.audio)
    out = {"duration": info.duration, "model": a.model, "segments": segs}
    tmp = a.out + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False)
    os.replace(tmp, a.out)
    print(json.dumps({"ok": True, "duration": info.duration, "segments": len(out["segments"])}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
