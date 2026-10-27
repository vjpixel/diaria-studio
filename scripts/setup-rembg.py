"""Ambiente de recorte das capas de vídeo: Neo (Windows x64, #11071) e 300 (Linux x86_64, #11223).

Nunca usa Python global para recortar."""
import argparse
import importlib.metadata
import os
from pathlib import Path
import platform
import shutil
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parent.parent
VENV = ROOT / ".venv-rembg"
# Layout do venv por plataforma: Windows usa Scripts\python.exe; Linux, bin/python.
PYTHON = VENV / "Scripts" / "python.exe" if sys.platform == "win32" else VENV / "bin" / "python"
LOCK = ROOT / "scripts" / "rembg-requirements.txt"
PYTHON_VERSION = (3, 11, 9)
MODEL = "birefnet-portrait"
HELP = (
    "No Neo (Windows x64), execute: py -3.11 scripts/setup-rembg.py. "
    "No 300 (Linux x86_64), com CPython 3.11.9 (ex.: uv python install 3.11.9): "
    "$(uv python find 3.11.9) scripts/setup-rembg.py. Veja docs/setup.md (rembg)."
)
# Plataformas suportadas: (sys.platform, platform.machine() em minúsculas).
SUPPORTED = {("win32", "amd64"), ("win32", "x86_64"), ("linux", "x86_64"), ("linux", "amd64")}


def supported_platform(plat=None, machine=None):
    plat = sys.platform if plat is None else plat
    machine = (platform.machine() if machine is None else machine).lower()
    return (plat, machine) in SUPPORTED


def write_output(output, data):
    """Grava o recorte num temporário fora do repo e move para o destino (#11370).

    No Neo, o Python do venv às vezes não enxerga um destino sob a junction
    `data/` (OneDrive) e `write_bytes` direto morre com `[Errno 2]` sem dizer
    qual parte do caminho falta. Aqui a pasta é conferida antes, o PNG nasce
    no temporário do sistema (que sempre funcionou) e só então vai para o
    destino; qualquer falha nos dois passos vira erro com a causa e o
    contorno, e o temporário nunca fica para trás."""
    output = Path(output)
    parent = output.parent if str(output.parent) else Path(".")
    if not parent.is_dir():
        raise RuntimeError(
            f"pasta de destino do --output inacessível pelo Python: {parent} "
            "(não existe ou, sob a junction data/ do OneDrive, não é visível pelo venv). "
            "Grave fora de data/ (ex.: --output retrato.png na raiz do repo) e copie depois."
        )
    fd, tmp = tempfile.mkstemp(suffix=output.suffix or ".png", prefix="rembg-")
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(data)
        try:
            shutil.move(tmp, str(output))
        except OSError as error:
            raise RuntimeError(
                f"destino do --output inacessível pelo Python: {output} ({error}). "
                "Se está em data/ (junction do OneDrive), grave fora de data/ e copie depois."
            ) from error
    finally:
        if os.path.exists(tmp):
            os.remove(tmp)


def check():
    if sys.version_info[:3] != PYTHON_VERSION or Path(sys.prefix).resolve() != VENV.resolve():
        raise RuntimeError("Python/venv do rembg incorreto. " + HELP)
    for line in LOCK.read_text().splitlines():
        if not line or line.startswith("#"):
            continue
        name, version = line.split("==")
        if importlib.metadata.version(name) != version:
            raise RuntimeError(f"Versão incorreta de {name}. " + HELP)
    # Detecta DLLs/dependências quebradas antes da composição da capa.
    import rembg  # noqa: F401
    import onnxruntime  # noqa: F401


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true")
    parser.add_argument("--input", type=Path)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    if args.check or args.input or args.output:
        check()
        if args.check:
            return
        if not args.input or not args.output:
            parser.error("recorte exige --input e --output")
        if args.input.resolve() == args.output.resolve():
            parser.error("entrada e saída precisam ser diferentes")
        # Modelo/cache explícitos, fora do OneDrive. Download inicial pelo rembg.
        os.environ["U2NET_HOME"] = str(VENV / "models")
        from rembg import new_session, remove
        result = remove(args.input.read_bytes(), session=new_session(MODEL, providers=["CPUExecutionProvider"]))
        write_output(args.output, result)
        return
    if not supported_platform():
        raise RuntimeError("Setup do rembg só no Neo (Windows x64) ou no 300 (Linux x86_64). " + HELP)
    if sys.version_info[:3] != PYTHON_VERSION:
        raise RuntimeError("Instale CPython 3.11.9 x64 antes do setup. " + HELP)
    if not VENV.exists():
        subprocess.run([sys.executable, "-m", "venv", str(VENV)], check=True)
    subprocess.run([str(PYTHON), "-m", "pip", "install", "pip==25.0.1"], check=True)
    subprocess.run([str(PYTHON), "-m", "pip", "install", "--only-binary=:all:", "--no-deps", "-r", str(LOCK)], check=True)
    subprocess.run([str(PYTHON), "-m", "pip", "check"], check=True)
    subprocess.run([str(PYTHON), str(Path(__file__).resolve()), "--check"], check=True)
    print("rembg pronto: " + str(PYTHON))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"rembg: {error}\n{HELP}", file=sys.stderr)
        sys.exit(1)
