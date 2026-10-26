"""Ambiente de recorte do Neo (Windows x64), #11071. Nunca usa Python global para recortar."""
import argparse
import importlib.metadata
import os
from pathlib import Path
import platform
import subprocess
import sys

ROOT = Path(__file__).resolve().parent.parent
VENV = ROOT / ".venv-rembg"
PYTHON = VENV / "Scripts" / "python.exe"
LOCK = ROOT / "scripts" / "rembg-requirements.txt"
PYTHON_VERSION = (3, 11, 9)
MODEL = "birefnet-portrait"
HELP = "No Neo (Windows x64), execute: py -3.11 scripts/setup-rembg.py. Veja docs/setup.md (rembg)."


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
        args.output.write_bytes(result)
        return
    if sys.platform != "win32" or platform.machine().lower() not in ("amd64", "x86_64"):
        raise RuntimeError("Setup do rembg é exclusivo do Neo (Windows x64). " + HELP)
    if sys.version_info[:3] != PYTHON_VERSION:
        raise RuntimeError("Instale CPython 3.11.9 x64 antes do setup. " + HELP)
    if not VENV.exists():
        subprocess.run([sys.executable, "-m", "venv", str(VENV)], check=True)
    subprocess.run([str(PYTHON), "-m", "pip", "install", "pip==25.0.1"], check=True)
    subprocess.run([str(PYTHON), "-m", "pip", "install", "--only-binary=:all:", "--no-deps", "-r", str(LOCK)], check=True)
    subprocess.run([str(PYTHON), "-m", "pip", "check"], check=True)
    subprocess.run([str(PYTHON), str(Path(__file__).resolve()), "--check"], check=True)
    print("rembg pronto no Neo: " + str(PYTHON))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"rembg: {error}\n{HELP}", file=sys.stderr)
        sys.exit(1)
