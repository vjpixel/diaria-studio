"""transcribe_words.py (#11208): transcrição com tempo por palavra para a montagem do vídeo diário.

Chamado por `scripts/video-montagem.ts` (subcomandos `transcribe`, `srt`, `review`), nunca
direto pelo editor. Modelo faster-whisper `large-v3-turbo`. Device (#13477): `--device auto`
(default, ou `DIARIA_WHISPER_DEVICE`) tenta a GPU (`cuda`, `int8_float16`) e cai na CPU em int8 com
`[aviso]` no stderr se a CUDA não carregar, inclusive no primeiro `encode` (é ali que falta
`cublas64_12.dll`). No Windows a GPU precisa das DLLs do cuBLAS 12 e do cuDNN 9, que não vêm com o
driver: `pip install --user nvidia-cublas-cu12 "nvidia-cudnn-cu12>=9,<10"`; o helper registra os
diretórios `bin` desses pacotes com `os.add_dll_directory` antes de carregar o modelo.
`--device cpu` força o comportamento anterior.

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

CUDA_ERROR_MARKERS = ("cuda", "cublas", "cudnn", "cudart", "gpu")


def register_nvidia_dll_dirs() -> list:
    """No Windows, põe no caminho de DLLs os `bin` de nvidia-cublas-cu12/nvidia-cudnn-cu12 (#13477)."""
    if os.name != "nt" or not hasattr(os, "add_dll_directory"):
        return []
    try:
        import nvidia  # pacote namespace dos wheels da NVIDIA
    except ImportError:
        return []
    added = []
    for root in list(getattr(nvidia, "__path__", [])):
        for sub in ("cublas", "cudnn", "cuda_nvrtc", "cuda_runtime"):
            d = os.path.join(root, sub, "bin")
            if os.path.isdir(d):
                os.add_dll_directory(d)
                os.environ["PATH"] = d + os.pathsep + os.environ.get("PATH", "")
                added.append(d)
    return added


def is_cuda_error(e: BaseException) -> bool:
    msg = str(e).lower()
    return any(m in msg for m in CUDA_ERROR_MARKERS)


def resolve_device(requested: str) -> str:
    req = (requested or "auto").strip().lower()
    if req not in ("auto", "cpu", "cuda"):
        raise ValueError(f"--device inválido: {requested} (auto|cpu|cuda)")
    return req


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
    ap.add_argument(
        "--device",
        default=os.environ.get("DIARIA_WHISPER_DEVICE", "auto"),
        help="auto (GPU com queda para CPU), cpu ou cuda (#13477)",
    )
    a = ap.parse_args()
    try:
        device_req = resolve_device(a.device)
    except ValueError as e:
        print(f"transcribe_words: {e}", file=sys.stderr)
        return 2

    if not os.path.isfile(a.audio):
        print(f"transcribe_words: áudio não encontrado: {a.audio}", file=sys.stderr)
        return 1
    os.environ.setdefault("HF_HUB_OFFLINE", "1")
    try:
        from faster_whisper import WhisperModel
    except ImportError as e:
        print(f"transcribe_words: faster-whisper indisponível ({e}); instalar com pip install faster-whisper", file=sys.stderr)
        return 1

    state = {"model": None, "device": "cpu"}

    def load(device):
        compute = "int8_float16" if device == "cuda" else "int8"
        state["model"] = WhisperModel(a.model, device=device, compute_type=compute)
        state["device"] = device

    def fall_back_to_cpu(e):
        print(f"[aviso] transcribe_words: CUDA indisponível ({e}); seguindo na CPU em int8", file=sys.stderr)
        load("cpu")

    if device_req in ("auto", "cuda"):
        register_nvidia_dll_dirs()
        try:
            load("cuda")
        except Exception as e:  # noqa: BLE001 — qualquer falha de carga da GPU
            if device_req == "cuda":
                print(f"transcribe_words: --device cuda pedido e a CUDA falhou: {e}", file=sys.stderr)
                return 1
            fall_back_to_cpu(e)
    else:
        load("cpu")

    def segments_of(audio, offset=0.0):
        try:
            return _segments_of(audio, offset)
        except RuntimeError as e:
            # A falta de cublas64_12.dll só aparece no primeiro encode, não na carga.
            if state["device"] == "cuda" and device_req == "auto" and is_cuda_error(e):
                fall_back_to_cpu(e)
                return _segments_of(audio, offset)
            raise

    def _segments_of(audio, offset=0.0):
        model = state["model"]
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
                    "no_speech_prob": s.no_speech_prob,
                    "avg_logprob": s.avg_logprob,
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
        print(json.dumps({"ok": True, "windows": len(out["windows"]), "device": state["device"]}))
        return 0

    segs, info = segments_of(a.audio)
    out = {"duration": info.duration, "model": a.model, "segments": segs}
    tmp = a.out + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False)
    os.replace(tmp, a.out)
    print(json.dumps({"ok": True, "duration": info.duration, "segments": len(out["segments"]), "device": state["device"]}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
