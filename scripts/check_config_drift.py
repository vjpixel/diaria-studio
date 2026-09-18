#!/usr/bin/env python3
"""Check mecânico de drift entre snapshot versionado (config/hermes-home/config.yaml)
e config vivo (~/.hermes/config.yaml), ignorando chaves redigidas.
Nunca lê ~/.hermes/auth.json.
Referência: vjpixel/hermes #6"""
import sys, os, yaml

SNAPSHOT = "config/hermes-home/config.yaml"
LIVE = os.path.expanduser("~/.hermes/config.yaml")
REDACED_KEYS = {"password_hash"}  # allowlist explícita; novas chaves sensíveis precisam entrar aqui

def load(path):
    with open(path, "r") as f:
        return yaml.safe_load(f) or {}

def compare(a, b, path=""):
    diffs = {}
    if isinstance(a, dict) and isinstance(b, dict):
        all_keys = set(a) | set(b)
        for k in sorted(all_keys):
            if k in REDACED_KEYS:
                continue
            child_path = f"{path}.{k}" if path else k
            if k not in a:
                diffs[child_path] = ("missing_in_snap", b[k])
            elif k not in b:
                diffs[child_path] = ("missing_in_live", a[k])
            else:
                child = compare(a[k], b[k], child_path)
                diffs.update(child)
    elif type(a) != type(b):
        diffs[path] = ("type_mismatch", str(type(a)), str(type(b)))
    elif a != b:
        diffs[path] = ("value_diff", a, b)
    return diffs

def main():
    if not os.path.isfile(SNAPSHOT):
        print("ERROR: snapshot não encontrado:", SNAPSHOT, file=sys.stderr)
        sys.exit(2)
    if not os.path.isfile(LIVE):
        print("ERROR: config vivo não encontrado:", LIVE, file=sys.stderr)
        sys.exit(2)
    snap = load(SNAPSHOT)
    live = load(LIVE)
    # Explicit: nunca tentar ler auth.json
    auth_path = os.path.expanduser("~/.hermes/auth.json")
    if os.path.isfile(auth_path):
        # Apenas confirmamos existência; não abrimos conteúdo.
        pass
    diffs = compare(snap, live)
    if diffs:
        print("DRIFT DETECTED")
        for k, (reason, *rest) in sorted(diffs.items()):
            if reason == "missing_in_snap":
                print(f"  + {k} = {rest[0]} (só em vivo)")
            elif reason == "missing_in_live":
                print(f"  - {k} = {rest[0]} (só no snapshot)")
            elif reason == "value_diff":
                print(f"  ~ {k} = {rest[0]!r} vs {rest[1]!r}")
            elif reason == "type_mismatch":
                print(f"  ! {k} tipo {rest[0]} vs {rest[1]}")
        sys.exit(1)
    else:
        print("NO DRIFT (chaves redigidas ignoradas)")
        sys.exit(0)

if __name__ == "__main__":
    main()
