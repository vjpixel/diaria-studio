"""transcribe_words.py (#11208): transcrição com tempo por palavra para a montagem do vídeo diário.

Chamado por `scripts/video-montagem.ts` (subcomandos `transcribe`, `srt`, `review`), nunca
direto pelo editor. Modelo faster-whisper `large-v3-turbo`. Device (#13477): `--device auto`
(default, ou `DIARIA_WHISPER_DEVICE`) tenta a GPU (`cuda`, `int8_float16`) e cai na CPU em int8 com
`[aviso]` no stderr se a CUDA não carregar, inclusive no primeiro `encode` (é ali que falta
`cublas64_12.dll`). No Windows a GPU precisa das DLLs do cuBLAS 12 e do cuDNN 9, que não vêm com o
driver: `pip install --user nvidia-cublas-cu12 "nvidia-cudnn-cu12>=9,<10"`; o helper registra os
diretórios `bin` desses pacotes com `os.add_dll_directory` antes de carregar o modelo.
`--device cpu` força o comportamento anterior.

Cache da sonda (#13504): o veredito da sonda da GPU (ok ou falho, com o motivo) fica em
`diaria-whisper-cuda-probe.json` no diretório temporário do sistema (`DIARIA_WHISPER_PROBE_CACHE_DIR`
troca o diretório), chaveado por `sys.executable` + versões do CTranslate2, do nvidia-cublas-cu12 e do nvidia-cudnn-cu12
+ modelo, por 6 h (instalar ou remover as DLLs pelo pip troca a chave). Só a 1ª
chamada da janela paga a sonda (~10 s); veredito falho cacheado vai direto para a CPU. Se a sonda
passou e a carga ou o encode na GPU falharem no processo principal, a entrada é apagada e a próxima
chamada sonda de novo. Arquivo ilegível = sem cache. `DIARIA_WHISPER_PROBE_CACHE=0` desliga.

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
import tempfile
import time

CUDA_ERROR_MARKERS = ("cuda", "cublas", "cudnn", "cudart")
PROBE_FLAG = "--probe-cuda"
PROBE_OK = "cuda-ok"
PROBE_TIMEOUT_S = 300
PROBE_CACHE_FILE = "diaria-whisper-cuda-probe.json"
PROBE_CACHE_TTL_S = 6 * 3600


def probe_cuda(model_name: str) -> int:
    """Modo sonda (#13477): carrega o modelo na GPU e transcreve 1 s de silêncio.

    Roda num subprocesso descartável porque a falta (ou versão errada) do cuDNN
    pode derrubar o processo no código nativo, sem exceção Python que o
    `try` do processo principal pegue.
    """
    register_nvidia_dll_dirs()
    os.environ.setdefault("HF_HUB_OFFLINE", "1")
    from faster_whisper import WhisperModel

    try:
        import numpy as np

        silence = np.zeros(16000, dtype=np.float32)
    except ImportError:
        silence = [0.0] * 16000
    model = WhisperModel(model_name, device="cuda", compute_type="int8_float16")
    segs, _ = model.transcribe(silence, language="pt")
    list(segs)
    print(PROBE_OK)
    return 0


def cuda_usable(model_name: str):
    """(ok, motivo): a GPU passa na sonda num subprocesso? Nunca lança."""
    import subprocess

    try:
        r = subprocess.run(
            [sys.executable, "-P", os.path.abspath(__file__), PROBE_FLAG, model_name],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=PROBE_TIMEOUT_S,
        )
    except Exception as e:  # noqa: BLE001 — timeout, executável ausente
        return False, f"sonda da GPU não rodou: {e}"
    if r.returncode == 0 and PROBE_OK in (r.stdout or ""):
        return True, ""
    tail = ((r.stderr or "").strip().splitlines() or [""])[-1]
    return False, f"sonda da GPU saiu {r.returncode}: {tail}"[:400]


def probe_cache_path():
    """Caminho do cache do veredito da sonda (#13504), ou None se desligado."""
    if os.environ.get("DIARIA_WHISPER_PROBE_CACHE", "").strip() == "0":
        return None
    d = os.environ.get("DIARIA_WHISPER_PROBE_CACHE_DIR", "").strip() or tempfile.gettempdir()
    return os.path.join(d, PROBE_CACHE_FILE)


def _dist_version(name: str) -> str:
    """Versão do pacote pelos metadados (sem carregar código nativo); "none" se não instalado."""
    try:
        from importlib.metadata import version

        return version(name)
    except Exception:  # noqa: BLE001 — pacote ausente ou metadados ilegíveis
        return "none"


# Pacotes cuja troca muda o veredito da GPU: instalar ou desinstalar as DLLs pelo pip
# (nvidia-cublas-cu12, nvidia-cudnn-cu12) muda a chave e a próxima chamada sonda de novo.
PROBE_CACHE_KEY_DISTS = ("ctranslate2", "nvidia-cublas-cu12", "nvidia-cudnn-cu12")


def probe_cache_key(model_name: str) -> str:
    dists = "|".join(f"{d}={_dist_version(d)}" for d in PROBE_CACHE_KEY_DISTS)
    return f"{sys.executable}|{dists}|{model_name}"


def _read_probe_cache(path) -> dict:
    """Entradas do cache; arquivo ausente, corrompido ou ilegível = {} (nunca lança)."""
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
    except Exception:  # noqa: BLE001
        return {}
    return data if isinstance(data, dict) else {}


def _write_probe_cache(path, data: dict) -> None:
    """Escrita atômica (tmp + os.replace); falha de escrita só perde o cache."""
    try:
        os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
        tmp = f"{path}.{os.getpid()}.tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False)
        os.replace(tmp, path)
    except Exception:  # noqa: BLE001
        pass


def cached_probe_verdict(model_name: str):
    """(ok, motivo) do cache ainda dentro do TTL, ou None (sem cache, vencido, malformado)."""
    path = probe_cache_path()
    if not path:
        return None
    entry = _read_probe_cache(path).get(probe_cache_key(model_name))
    if not isinstance(entry, dict):
        return None
    ok, at, why = entry.get("ok"), entry.get("at"), entry.get("why", "")
    if not isinstance(ok, bool) or not isinstance(at, (int, float)) or isinstance(at, bool):
        return None
    age = time.time() - at
    if age < 0 or age >= PROBE_CACHE_TTL_S:
        return None
    return ok, str(why)


def store_probe_verdict(model_name: str, ok: bool, why: str) -> None:
    path = probe_cache_path()
    if not path:
        return
    data = _read_probe_cache(path)
    data[probe_cache_key(model_name)] = {"ok": ok, "why": why, "at": time.time()}
    _write_probe_cache(path, data)


def invalidate_probe_verdict(model_name: str) -> None:
    """A GPU falhou depois de a sonda passar: apaga a entrada, a próxima chamada sonda de novo."""
    path = probe_cache_path()
    if not path:
        return
    data = _read_probe_cache(path)
    if data.pop(probe_cache_key(model_name), None) is not None:
        _write_probe_cache(path, data)


def gpu_verdict(model_name: str):
    """(ok, motivo): veredito do cache (#13504) ou, sem ele, da sonda, que é então cacheada."""
    cached = cached_probe_verdict(model_name)
    if cached is not None:
        ok, why = cached
        return ok, (f"{why} [veredito em cache, {PROBE_CACHE_FILE}]" if not ok else "")
    ok, why = cuda_usable(model_name)
    store_probe_verdict(model_name, ok, why)
    return ok, why


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

    state = {"model": None, "device": "cpu", "fell_back": False}

    def load(device):
        compute = "int8_float16" if device == "cuda" else "int8"
        state["model"] = WhisperModel(a.model, device=device, compute_type=compute)
        state["device"] = device

    def fall_back_to_cpu(e):
        print(f"[aviso] transcribe_words: CUDA indisponível ({e}); seguindo na CPU em int8", file=sys.stderr)
        load("cpu")

    if device_req == "auto":
        register_nvidia_dll_dirs()
        ok, why = gpu_verdict(a.model)
        if not ok:
            fall_back_to_cpu(why)
        else:
            try:
                load("cuda")
            except Exception as e:  # noqa: BLE001 — a sonda passou; qualquer falha aqui ainda cai na CPU
                invalidate_probe_verdict(a.model)
                fall_back_to_cpu(e)
    elif device_req == "cuda":
        register_nvidia_dll_dirs()
        try:
            load("cuda")
        except Exception as e:  # noqa: BLE001
            print(f"transcribe_words: --device cuda pedido e a CUDA falhou: {e}", file=sys.stderr)
            return 1
    else:
        load("cpu")

    def segments_of(audio, offset=0.0):
        try:
            return _segments_of(audio, offset)
        except RuntimeError as e:
            # A falta de cublas64_12.dll só aparece no primeiro encode, não na carga.
            # Sem memória na GPU também cai aqui: o arquivo é refeito do zero na CPU (correto, mais lento).
            if state["device"] == "cuda" and device_req == "auto" and is_cuda_error(e):
                invalidate_probe_verdict(a.model)
                fall_back_to_cpu(e)
                state["fell_back"] = True
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
        print(json.dumps({"ok": True, "windows": len(out["windows"]), "device": state["device"], "fallback": state["fell_back"]}))
        return 0

    segs, info = segments_of(a.audio)
    out = {"duration": info.duration, "model": a.model, "segments": segs}
    tmp = a.out + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False)
    os.replace(tmp, a.out)
    print(json.dumps({"ok": True, "duration": info.duration, "segments": len(out["segments"]), "device": state["device"], "fallback": state["fell_back"]}))
    return 0


if __name__ == "__main__":
    if sys.argv[1:2] == [PROBE_FLAG]:
        sys.exit(probe_cuda(sys.argv[2] if len(sys.argv) > 2 else "large-v3-turbo"))
    sys.exit(main())
