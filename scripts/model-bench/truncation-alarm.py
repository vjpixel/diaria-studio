#!/usr/bin/env python3
"""Alarme de truncagem silenciosa do modelo local (#7528).

Truncagem não é erro em nenhuma camada: o Ollama devolve **HTTP 200 sem
sinal**, e o Hermes v0.20.5 não checa `prompt_eval_count` no caminho da
chamada. Um tick que perdeu metade do prompt é indistinguível de um tick
saudável — só se percebe pelo comportamento estranho, semanas depois, como
no #6917.

Este script detecta pelo lado de fora, sem tocar o core do Hermes.

## A assinatura, medida em 06/09/2026

Quando o prompt excede a janela, o Ollama mantém **exatamente METADE** — a
metade final, descartando o começo, que é onde ficam as regras. Confirmado
em dois `num_ctx` independentes:

    num_ctx 65.536  ->  32.770 tokens lidos   (metade + 2)
    num_ctx 98.304  ->  49.154 tokens lidos   (metade + 2)

Isso é assinatura muito mais forte que "caiu abaixo do teto": procura-se um
valor a ±4 de `janela/2`, não uma queda difusa.

## Duas armadilhas de leitura, ambas pagas ao medir

1. **`input_tokens` é CUMULATIVO por sessão, não por chamada.** Dividir por
   `api_call_count`. Sem isso os números parecem absurdos (2,2 milhões numa
   sessão) e a comparação contra a janela não faz sentido.
2. **A tabela não tem `updated_at`.** As colunas de tempo são `first_seen` /
   `last_seen`; um `order by updated_at` falha com `OperationalError`.

Uso:
    python3 truncation-alarm.py --janela 81920
    python3 truncation-alarm.py --janela 81920 --horas 24 --json
"""

from __future__ import annotations

import argparse
import json
import sqlite3
import sys
import time

DB = "/home/vjpixel/.hermes/state.db"

# Ocupação acima da qual o tick está na borda: ainda não truncou, mas é
# véspera. O tick medido roda a ~68.6k contra janela de 79.134 — 87%.
LIMIAR_BORDA = 0.85
# Folga para casar "metade exata": o valor observado é metade+2.
TOLERANCIA_METADE = 4


def analisa(db: str, janela: int, horas: float) -> list[dict]:
    con = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
    corte = time.time() - horas * 3600
    achados = []
    # `last_seen`, não `updated_at` — esta coluna não existe.
    q = ("select session_id, model, input_tokens, api_call_count, last_seen "
         "from session_model_usage where api_call_count > 0")
    for sid, modelo, entrada, chamadas, visto in con.execute(q):
        try:
            t = float(visto)
        except (TypeError, ValueError):
            continue
        if t < corte:
            continue
        # CUMULATIVO por sessão: dividir pelas chamadas.
        por_chamada = (entrada or 0) / max(1, chamadas)
        if por_chamada < 1000:
            continue
        metade = janela // 2
        if abs(por_chamada - metade) <= TOLERANCIA_METADE:
            nivel, motivo = "TRUNCOU", (
                f"{por_chamada:.0f} tok/chamada é exatamente metade de "
                f"{janela:,} — assinatura de colapso, o começo do prompt "
                f"(as regras) foi descartado")
        elif por_chamada >= janela * LIMIAR_BORDA:
            nivel, motivo = "BORDA", (
                f"{por_chamada:.0f} tok/chamada = "
                f"{100 * por_chamada / janela:.0f}% da janela — véspera de "
                f"truncar")
        else:
            continue
        achados.append({
            "nivel": nivel, "sessao": str(sid)[:24], "modelo": modelo,
            "tokens_por_chamada": round(por_chamada),
            "chamadas": chamadas, "motivo": motivo,
        })
    return achados


def main() -> int:
    p = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--janela", type=int, required=True,
                   help="janela ÚTIL MEDIDA (não o num_ctx declarado — use "
                        "`probe.py window`; o declarado mente)")
    p.add_argument("--horas", type=float, default=24)
    p.add_argument("--db", default=DB)
    p.add_argument("--json", action="store_true")
    a = p.parse_args()

    try:
        achados = analisa(a.db, a.janela, a.horas)
    except sqlite3.OperationalError as e:
        print(f"ERRO ao ler {a.db}: {e}", file=sys.stderr)
        return 2

    if a.json:
        print(json.dumps(achados, ensure_ascii=False, indent=2))
    elif not achados:
        print(f"OK — nenhuma sessão truncada ou na borda nas últimas "
              f"{a.horas:g}h (janela {a.janela:,}).")
    else:
        for f in achados:
            print(f"[{f['nivel']}] {f['modelo']} sessão {f['sessao']}")
            print(f"         {f['motivo']}")
    # exit 1 = truncou (acionável); 0 = ok ou só borda.
    return 1 if any(f["nivel"] == "TRUNCOU" for f in achados) else 0


if __name__ == "__main__":
    sys.exit(main())
