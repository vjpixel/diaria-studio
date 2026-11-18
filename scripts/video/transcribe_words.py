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
`diaria-whisper-cuda-probe.json` (fora do Windows, `diaria-whisper-cuda-probe-{uid}.json`) no
diretório temporário do sistema (`DIARIA_WHISPER_PROBE_CACHE_DIR` troca o diretório), chaveado por
`sys.executable` + versões do CTranslate2 e dos pacotes nvidia-* (cuBLAS, cuDNN, runtime, NVRTC) +
mtime/tamanho do driver (nvcuda.dll ou libcuda.so.1) + modelo: instalar ou remover as DLLs pelo pip,
ou atualizar o driver, troca a chave. O ok vale 6 h, o falho 10 min, e falha passageira (falta de
memória na GPU, timeout, sonda que não rodou) não vai para o cache. Só a 1ª chamada da janela paga
a sonda (~10 s); veredito falho cacheado vai direto para a CPU. Se a sonda
passou e a carga ou o encode na GPU falharem no processo principal, a entrada é apagada e a próxima
chamada sonda de novo. Arquivo ilegível = sem cache. `DIARIA_WHISPER_PROBE_CACHE=0` desliga.

Processo residente (#13506): por padrão a 1ª chamada sobe `transcribe_words.py --serve`, que
carrega o modelo uma vez e atende as chamadas seguintes por um socket local (127.0.0.1, token no
arquivo de estado `diaria-whisper-server[-{uid}].json`, no mesmo diretório do cache da sonda) até
ficar ocioso por `DIARIA_WHISPER_RESIDENT_IDLE_S` (900 s). Qualquer falha do residente cai na carga
local de sempre, com [aviso]. `DIARIA_WHISPER_RESIDENT=0` desliga.

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
PROBE_CACHE_TTL_S = 6 * 3600  # veredito ok
PROBE_CACHE_FAIL_TTL_S = 10 * 60  # veredito falho: curto, a GPU pode voltar
# Falha passageira da sonda (GPU sem memória com o Premiere aberto, timeout, subprocesso que não
# subiu) nunca vai para o cache: a chamada seguinte sonda de novo.
PROBE_TRANSIENT_MARKERS = ("out of memory", "não rodou", "timed out", "timeout")
# Caminho do driver CUDA (nvcuda.dll/libcuda.so.1) para a chave do cache; só os testes sobrepõem.
DRIVER_PATH_ENV = "DIARIA_WHISPER_CUDA_DRIVER_PATH"
LINUX_LIBCUDA_CANDIDATES = (
    "/usr/lib/x86_64-linux-gnu/libcuda.so.1",
    "/usr/lib64/libcuda.so.1",
    "/usr/lib/wsl/lib/libcuda.so.1",
    "/usr/lib/libcuda.so.1",
    "/usr/local/cuda/compat/libcuda.so.1",
)


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
    return os.path.join(d, probe_cache_filename())


def probe_cache_filename() -> str:
    """Fora do Windows o /tmp é compartilhado entre usuários: o uid entra no nome."""
    if os.name != "nt" and hasattr(os, "getuid"):
        stem, ext = os.path.splitext(PROBE_CACHE_FILE)
        return f"{stem}-{os.getuid()}{ext}"
    return PROBE_CACHE_FILE


def cuda_driver_fingerprint() -> str:
    """mtime + tamanho do driver CUDA (nvcuda.dll no Windows, libcuda.so.1 no Linux); "none" se ausente.

    Atualizar o driver da GPU troca a chave do cache, e o veredito ok antigo deixa de valer.
    """
    override = os.environ.get(DRIVER_PATH_ENV, "").strip()
    if override:
        candidates = (override,)
    elif os.name == "nt":
        root = os.environ.get("SystemRoot") or os.environ.get("SYSTEMROOT") or r"C:\Windows"
        candidates = (os.path.join(root, "System32", "nvcuda.dll"),)
    else:
        candidates = LINUX_LIBCUDA_CANDIDATES
    for c in candidates:
        try:
            real = os.path.realpath(c)
            st = os.stat(real)
        except OSError:
            continue
        return f"{real}:{int(st.st_mtime)}:{st.st_size}"
    return "none"


def _dist_version(name: str) -> str:
    """Versão do pacote pelos metadados (sem carregar código nativo); "none" se não instalado."""
    try:
        from importlib.metadata import version

        return version(name)
    except Exception:  # noqa: BLE001 — pacote ausente ou metadados ilegíveis
        return "none"


# Pacotes cuja troca muda o veredito da GPU: instalar ou desinstalar as DLLs/runtime CUDA pelo
# pip muda a chave e a próxima chamada sonda de novo.
PROBE_CACHE_KEY_DISTS = (
    "ctranslate2",
    "nvidia-cublas-cu12",
    "nvidia-cudnn-cu12",
    "nvidia-cuda-runtime-cu12",
    "nvidia-cuda-nvrtc-cu12",
)


def probe_cache_key(model_name: str) -> str:
    dists = "|".join(f"{d}={_dist_version(d)}" for d in PROBE_CACHE_KEY_DISTS)
    return f"{sys.executable}|{dists}|driver={cuda_driver_fingerprint()}|{model_name}"


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
    tmp = f"{path}.{os.getpid()}.tmp"
    try:
        os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False)
        os.replace(tmp, path)
    except Exception:  # noqa: BLE001
        try:
            os.remove(tmp)
        except OSError:
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
    if age < 0 or age >= (PROBE_CACHE_TTL_S if ok else PROBE_CACHE_FAIL_TTL_S):
        return None
    return ok, str(why)


def is_transient_probe_failure(why: str) -> bool:
    w = (why or "").lower()
    return any(m in w for m in PROBE_TRANSIENT_MARKERS)


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
        return ok, (f"{why} [veredito em cache, {probe_cache_filename()}]" if not ok else "")
    ok, why = cuda_usable(model_name)
    if ok or not is_transient_probe_failure(why):
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


class CudaRequiredError(RuntimeError):
    """`--device cuda` explícito e a CUDA falhou: sai 1, sem cair na CPU."""


class Engine:
    """O modelo carregado (GPU com queda para a CPU, #13477) e as transcrições sobre ele.

    Usado pela chamada avulsa (carrega, transcreve, sai) e pelo processo residente
    (#13506), que carrega uma vez e atende várias chamadas.
    """

    def __init__(self, model_name: str, device_req: str):
        from faster_whisper import WhisperModel  # ImportError sobe para o chamador

        self._WhisperModel = WhisperModel
        self.model_name = model_name
        self.device_req = device_req
        self.model = None
        self.device = "cpu"
        self.fell_back = False
        self.avisos = []
        if device_req == "auto":
            register_nvidia_dll_dirs()
            ok, why = gpu_verdict(model_name)
            if not ok:
                self._fall_back_to_cpu(why)
            else:
                try:
                    self._load("cuda")
                except Exception as e:  # noqa: BLE001 — a sonda passou; qualquer falha aqui ainda cai na CPU
                    invalidate_probe_verdict(model_name)
                    self._fall_back_to_cpu(e)
        elif device_req == "cuda":
            register_nvidia_dll_dirs()
            try:
                self._load("cuda")
            except Exception as e:  # noqa: BLE001
                raise CudaRequiredError(f"--device cuda pedido e a CUDA falhou: {e}") from e
        else:
            self._load("cpu")

    def _load(self, device):
        compute = "int8_float16" if device == "cuda" else "int8"
        self.model = self._WhisperModel(self.model_name, device=device, compute_type=compute)
        self.device = device

    def _fall_back_to_cpu(self, e):
        msg = f"[aviso] transcribe_words: CUDA indisponível ({e}); seguindo na CPU em int8"
        print(msg, file=sys.stderr)
        self.avisos.append(msg)
        self._load("cpu")

    def segments_of(self, job, audio, offset=0.0):
        try:
            return self._segments_of(job, audio, offset)
        except RuntimeError as e:
            # A falta de cublas64_12.dll só aparece no primeiro encode, não na carga.
            # Sem memória na GPU também cai aqui: o arquivo é refeito do zero na CPU (correto, mais lento).
            if self.device == "cuda" and self.device_req == "auto" and is_cuda_error(e):
                invalidate_probe_verdict(self.model_name)
                self._fall_back_to_cpu(e)
                self.fell_back = True
                return self._segments_of(job, audio, offset)
            raise

    def _segments_of(self, job, audio, offset=0.0):
        segs, info = self.model.transcribe(
            audio,
            language=job["language"],
            vad_filter=job["vad"],
            beam_size=5,
            word_timestamps=True,
            initial_prompt=job["initial_prompt"] or None,
            condition_on_previous_text=not job["no_condition"],
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

    def run_job(self, job) -> dict:
        """Transcreve `job` (o que a linha de comando pede) e grava a saída de forma atômica."""
        self.fell_back = False
        start_avisos = len(self.avisos)
        if job.get("windows"):
            from faster_whisper import decode_audio

            with open(job["windows"], encoding="utf-8") as f:
                windows = json.load(f)
            sr = 16000
            audio = decode_audio(job["audio"], sampling_rate=sr)
            out = {"model": self.model_name, "windows": []}
            for w in windows:
                start, end = float(w["start"]), float(w["end"])
                piece = audio[int(start * sr) : int(end * sr)]
                segs = self.segments_of(job, piece, start)[0] if len(piece) > sr // 10 else []
                out["windows"].append({"key": w["key"], "start": start, "end": end, "segments": segs})
            _write_json_atomic(job["out"], out)
            res = {"ok": True, "windows": len(out["windows"]), "device": self.device, "fallback": self.fell_back}
        else:
            segs, info = self.segments_of(job, job["audio"])
            out = {"duration": info.duration, "model": self.model_name, "segments": segs}
            _write_json_atomic(job["out"], out)
            res = {"ok": True, "duration": info.duration, "segments": len(out["segments"]), "device": self.device, "fallback": self.fell_back}
        new_avisos = self.avisos[start_avisos:]
        if new_avisos:
            res["avisos"] = new_avisos
        return res


def _write_json_atomic(path, data) -> None:
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False)
    os.replace(tmp, path)


# ── Processo residente por sessão (#13506) ───────────────────────────────────────────────
#
# Cada transcribe/retranscribe/roteiro/review/srt subia um Python novo e carregava o
# large-v3-turbo de novo (7,7 s na CPU, 8,3 s na CUDA no Neo, mais a sonda). Agora a 1ª
# chamada sobe um processo residente (`--serve`) que carrega o modelo uma vez e atende as
# seguintes por um socket local (127.0.0.1, token no arquivo de estado 0600); ele sai sozinho
# depois de `DIARIA_WHISPER_RESIDENT_IDLE_S` (900 s) sem chamada. Qualquer falha do residente
# (não subiu, não ficou pronto a tempo, outro modelo/device, outra versão deste arquivo,
# conexão recusada, erro na transcrição) cai na carga local de sempre, com [aviso].
# `DIARIA_WHISPER_RESIDENT=0` desliga (volta ao helper avulso).

RESIDENT_ENV = "DIARIA_WHISPER_RESIDENT"
SERVE_FLAG = "--serve"
SERVER_STATE_FILE = "diaria-whisper-server.json"
SERVER_IDLE_DEFAULT_S = 900
SERVER_WAIT_DEFAULT_S = 180
SERVER_MAX_REQUEST = 1024 * 1024


def _env_float(name: str, default: float) -> float:
    try:
        v = float(os.environ.get(name, "").strip() or default)
    except ValueError:
        return default
    return v if v > 0 else default


def resident_enabled() -> bool:
    return os.environ.get(RESIDENT_ENV, "").strip() != "0"


def server_state_path() -> str:
    """Mesmo diretório do cache da sonda; fora do Windows o uid entra no nome (o /tmp é compartilhado)."""
    d = os.environ.get("DIARIA_WHISPER_PROBE_CACHE_DIR", "").strip() or tempfile.gettempdir()
    stem, ext = os.path.splitext(SERVER_STATE_FILE)
    name = f"{stem}-{os.getuid()}{ext}" if os.name != "nt" and hasattr(os, "getuid") else SERVER_STATE_FILE
    return os.path.join(d, name)


def helper_fingerprint() -> str:
    """Versão deste arquivo: um residente de código anterior (git pull no meio da sessão) não é usado."""
    try:
        st = os.stat(os.path.abspath(__file__))
        return f"{int(st.st_mtime)}:{st.st_size}"
    except OSError:
        return "?"


def read_server_state(path):
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
    except Exception:  # noqa: BLE001 — ausente, a meio da escrita, corrompido
        return None
    return data if isinstance(data, dict) else None


def pid_alive(pid) -> bool:
    """POSIX: sinal 0. No Windows `os.kill` com outro sinal mata o processo: sem checagem (True)."""
    if not isinstance(pid, int) or isinstance(pid, bool) or pid <= 0:
        return False
    if os.name == "nt":
        return True
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except OSError:
        return False
    return True


def _remove_state_if(path, pid) -> None:
    st = read_server_state(path)
    if st is not None and st.get("pid") == pid:
        try:
            os.remove(path)
        except OSError:
            pass


def _state_stale(st) -> bool:
    if not pid_alive(st.get("pid")):
        return True
    at = st.get("at")
    loading_too_long = not st.get("ready") and isinstance(at, (int, float)) and time.time() - at > SERVER_WAIT_DEFAULT_S * 2
    return bool(loading_too_long)


def claim_server_state(path, info) -> bool:
    """Cria o arquivo de estado com O_EXCL: um residente por usuário. Estado de processo morto é retomado."""
    for _ in range(2):
        try:
            os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
            fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        except FileExistsError:
            st = read_server_state(path)
            if st is not None and not _state_stale(st):
                return False
            try:
                os.remove(path)
            except OSError:
                return False
            continue
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(info, f)
        return True
    return False


def write_server_state(path, info) -> None:
    tmp = f"{path}.{os.getpid()}.tmp"
    fd = os.open(tmp, os.O_CREAT | os.O_TRUNC | os.O_WRONLY, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        json.dump(info, f)
    os.replace(tmp, path)


def _recv_line(conn, limit=SERVER_MAX_REQUEST) -> bytes:
    buf = b""
    while b"\n" not in buf:
        chunk = conn.recv(65536)
        if not chunk:
            break
        buf += chunk
        if len(buf) > limit:
            raise ValueError("mensagem grande demais")
    return buf.split(b"\n", 1)[0]


def serve_main(argv) -> int:
    """`--serve`: carrega o modelo uma vez e atende as chamadas até ficar ocioso (#13506)."""
    import hmac
    import secrets
    import socket

    ap = argparse.ArgumentParser(description="transcribe_words.py residente (#13506)")
    ap.add_argument("--model", default="large-v3-turbo")
    ap.add_argument("--device", default=os.environ.get("DIARIA_WHISPER_DEVICE", "auto"))
    ap.add_argument("--idle-timeout", type=float, default=_env_float("DIARIA_WHISPER_RESIDENT_IDLE_S", SERVER_IDLE_DEFAULT_S))
    a = ap.parse_args(argv)
    try:
        device_req = resolve_device(a.device)
    except ValueError as e:
        print(f"transcribe_words --serve: {e}", file=sys.stderr)
        return 2
    os.environ.setdefault("HF_HUB_OFFLINE", "1")
    path = server_state_path()
    base = {"pid": os.getpid(), "model": a.model, "device_req": device_req, "helper": helper_fingerprint()}
    if not claim_server_state(path, {**base, "ready": False, "at": time.time()}):
        print("transcribe_words --serve: outro residente já está de pé (ou subindo); saindo", file=sys.stderr)
        return 0
    sock = None
    try:
        try:
            engine = Engine(a.model, device_req)
        except Exception as e:  # noqa: BLE001 — faster-whisper ausente, CUDA exigida e falha
            print(f"transcribe_words --serve: modelo não carregou: {e}", file=sys.stderr)
            return 1
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        sock.bind(("127.0.0.1", 0))
        sock.listen(16)
        token = secrets.token_hex(16)
        write_server_state(path, {**base, "ready": True, "at": time.time(), "port": sock.getsockname()[1], "token": token, "device": engine.device})
        print(f"transcribe_words --serve: pronto (pid {os.getpid()}, {engine.device}; encerra ocioso em {a.idle_timeout:.0f} s)", file=sys.stderr)
        sock.settimeout(a.idle_timeout)
        while True:
            try:
                conn, _ = sock.accept()
            except socket.timeout:
                print("transcribe_words --serve: ocioso; encerrando", file=sys.stderr)
                return 0
            with conn:
                try:
                    conn.settimeout(30)
                    req = json.loads(_recv_line(conn).decode("utf-8"))
                    if not isinstance(req, dict) or not hmac.compare_digest(str(req.get("token", "")), token):
                        resp = {"ok": False, "error": "token inválido"}
                    else:
                        conn.settimeout(None)
                        job = {k: req.get(k) for k in ("audio", "out", "windows", "initial_prompt", "vad", "language", "no_condition")}
                        job["vad"] = bool(job["vad"])
                        job["no_condition"] = bool(job["no_condition"])
                        job["language"] = job["language"] or "pt"
                        job["initial_prompt"] = job["initial_prompt"] or ""
                        if not isinstance(job["audio"], str) or not os.path.isfile(job["audio"]) or not isinstance(job["out"], str):
                            resp = {"ok": False, "error": f"áudio não encontrado: {job['audio']}"}
                        else:
                            resp = engine.run_job(job)
                            resp["resident"] = True
                except Exception as e:  # noqa: BLE001 — a chamada cai na carga local
                    resp = {"ok": False, "error": f"{type(e).__name__}: {e}"[:500]}
                try:
                    conn.sendall((json.dumps(resp, ensure_ascii=False) + "\n").encode("utf-8"))
                except OSError:
                    pass
    finally:
        if sock is not None:
            sock.close()
        _remove_state_if(path, os.getpid())


def spawn_server(model_name: str, device_req: str):
    """Sobe o residente desligado deste processo, sem herdar stdout/stderr (o spawnSync do TS não espera por ele)."""
    import subprocess

    log_path = os.path.splitext(server_state_path())[0] + ".log"
    try:
        log = open(log_path, "a", encoding="utf-8")
    except OSError:
        log = subprocess.DEVNULL
    kw = {"stdin": subprocess.DEVNULL, "stdout": log, "stderr": log, "close_fds": True}
    if os.name == "nt":
        kw["creationflags"] = getattr(subprocess, "DETACHED_PROCESS", 0) | getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
    else:
        kw["start_new_session"] = True
    try:
        return subprocess.Popen([sys.executable, "-P", os.path.abspath(__file__), SERVE_FLAG, "--model", model_name, "--device", device_req], **kw)
    except Exception as e:  # noqa: BLE001
        print(f"[aviso] transcribe_words: o processo residente não subiu ({e}); carga local (#13506)", file=sys.stderr)
        return None
    finally:
        if log is not subprocess.DEVNULL:
            log.close()


def wait_server_ready(path, proc, timeout_s: float):
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        st = read_server_state(path)
        if st is not None and st.get("ready"):
            return st
        if st is not None and not pid_alive(st.get("pid")):
            return None
        if proc is not None and proc.poll() is not None and (st is None or st.get("pid") == proc.pid):
            return None
        time.sleep(0.2)
    return None


def try_resident(job, model_name: str, device_req: str):
    """O resultado da transcrição feita pelo residente, ou None (cai na carga local)."""
    import socket

    path = server_state_path()
    st = read_server_state(path)
    proc = None
    if st is None or _state_stale(st):
        if st is not None:
            _remove_state_if(path, st.get("pid"))
        proc = spawn_server(model_name, device_req)
        if proc is None:
            return None
        st = None
    if st is None or not st.get("ready"):
        print("[video-montagem] transcribe_words: aguardando o processo residente do Whisper (#13506)…", file=sys.stderr)
        st = wait_server_ready(path, proc, _env_float("DIARIA_WHISPER_RESIDENT_WAIT_S", SERVER_WAIT_DEFAULT_S))
        if st is None:
            print("[aviso] transcribe_words: o processo residente não ficou pronto; carga local do modelo (#13506)", file=sys.stderr)
            return None
    if st.get("model") != model_name or st.get("device_req") != device_req or st.get("helper") != helper_fingerprint():
        return None
    port, token = st.get("port"), st.get("token")
    if not isinstance(port, int) or not isinstance(token, str):
        return None
    try:
        conn = socket.create_connection(("127.0.0.1", port), timeout=5)
    except OSError:
        # Ninguém escutando: residente morto sem limpar o estado. A próxima chamada sobe outro.
        _remove_state_if(path, st.get("pid"))
        print("[aviso] transcribe_words: o processo residente não atendeu; carga local (#13506)", file=sys.stderr)
        return None
    try:
        with conn:
            conn.sendall((json.dumps({**job, "token": token}, ensure_ascii=False) + "\n").encode("utf-8"))
            conn.settimeout(None)
            line = _recv_line(conn, limit=64 * 1024 * 1024)
        resp = json.loads(line.decode("utf-8")) if line else None
    except Exception as e:  # noqa: BLE001
        print(f"[aviso] transcribe_words: o processo residente falhou ({e}); carga local (#13506)", file=sys.stderr)
        return None
    if not isinstance(resp, dict) or not resp.get("ok"):
        err = resp.get("error") if isinstance(resp, dict) else "resposta vazia ou ilegível"
        print(f"[aviso] transcribe_words: o processo residente recusou a chamada ({err}); carga local (#13506)", file=sys.stderr)
        return None
    for aviso in resp.pop("avisos", None) or []:
        print(aviso, file=sys.stderr)
    return resp


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
    job = {
        "audio": os.path.abspath(a.audio),
        "out": os.path.abspath(a.out),
        "windows": os.path.abspath(a.windows) if a.windows else None,
        "initial_prompt": a.initial_prompt,
        "vad": a.vad,
        "language": a.language,
        "no_condition": a.no_condition,
    }
    if resident_enabled():
        res = try_resident(job, a.model, device_req)
        if res is not None:
            print(json.dumps(res))
            return 0
    try:
        engine = Engine(a.model, device_req)
    except ImportError as e:
        print(f"transcribe_words: faster-whisper indisponível ({e}); instalar com pip install faster-whisper", file=sys.stderr)
        return 1
    except CudaRequiredError as e:
        print(f"transcribe_words: {e}", file=sys.stderr)
        return 1
    res = engine.run_job(job)
    res.pop("avisos", None)
    print(json.dumps(res))
    return 0


if __name__ == "__main__":
    if sys.argv[1:2] == [SERVE_FLAG]:
        sys.exit(serve_main(sys.argv[2:]))
    if sys.argv[1:2] == [PROBE_FLAG]:
        sys.exit(probe_cuda(sys.argv[2] if len(sys.argv) > 2 else "large-v3-turbo"))
    sys.exit(main())
