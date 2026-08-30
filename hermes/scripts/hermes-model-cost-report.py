#!/usr/bin/env python3
"""Relatorio de qual MODELO respondeu e QUANTO custou, por dia e por sessao.

Motivacao (27/08/2026): o Hermes degrada silenciosamente pela cadeia de
fallback ate o qwen local de 4B quando o balde free do OpenRouter (1000
req/dia, compartilhado por CONTA entre TODOS os :free) esgota — e o sintoma
que chega ao editor e so "o agente esta burro hoje", sem nada que diga qual
modelo respondeu.

Alem disso, a substituicao de um modelo que falha pode aterrissar num id
PAGO: em 27/08 01:23 uma sessao pediu `thinkingmachines/inkling:free` (que
recusa chamada via API crua) e acabou cobrada em `z-ai/glm-5.2` sem o
sufixo :free — 17 chamadas, 202.692 tokens, USD 0,459. Por isso o relatorio
sinaliza toda linha cobrada num id que NAO termina em ":free" e nao esta na
allowlist de modelos pagos intencionais.

Nao instrumenta nada: le `session_model_usage` do state.db, que o proprio
Hermes ja preenche (model, billing_provider, actual/estimated_cost_usd).
Sobrevive a atualizacao do Hermes porque nao toca no codigo dele.

LIMITACAO CONHECIDA (#6708, 29/08/2026): este script so DETECTA a cobranca
indevida depois do fato (le o billing ja gravado) — nao valida o override
ANTES da chamada disparar. A causa raiz de "pedido X, cobrado Y" fica na
resolucao de modelo do Hermes CORE (overrides de sessao persistidos,
provavelmente `~/.hermes/sessions/sessions.json`, mais a cadeia de
smart_model_routing em `~/.hermes/config.yaml`) — nenhum dos dois vive
neste repo, e nao existem nesta maquina/worktree (checado em 29/08/2026:
`~/.hermes/` inteiro ausente aqui, por design — so existe no `helios`).
Investigar/corrigir a causa raiz exige acesso a essa maquina; nao
reproduzido nem instrumentado a partir daqui. O que ESTE script ja cobre
(deteccao pos-fato via `vazamento_pago`/`_is_leak`) e o que
`watch-continuo-health.sh` ja consome pra abrir issue automaticamente
segue valido e e a mitigacao disponivel enquanto a causa raiz no Hermes
core nao for corrigida.

Uso:
    python3 hermes-model-cost-report.py [--days N] [--sessions] [--json]
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import sqlite3
import sys
from pathlib import Path

STATE_DB = Path.home() / ".hermes" / "state.db"

# Modelos pagos que o config engaja DE PROPOSITO. Qualquer outro id pago que
# apareca no relatorio e vazamento e deve ser investigado, nao normalizado.
PAID_ALLOWLIST = {
    "z-ai/glm-5.3-flash",       # rede de seguranca da cadeia + visao
    "openai-codex/gpt-5.6-luna",
    "gpt-5.6-luna",
}


def _connect() -> sqlite3.Connection:
    if not STATE_DB.exists():
        sys.exit(f"state.db nao encontrado em {STATE_DB}")
    return sqlite3.connect(f"file:{STATE_DB}?mode=ro", uri=True)


# Providers que podem COBRAR. Local (`custom`/ollama) nunca cobra, entao um id
# local sem sufixo :free nao e vazamento — era o falso-positivo da 1a versao.
BILLABLE_PROVIDERS = {"openrouter", "openai-codex", "openai", "anthropic"}

# Providers conhecidos que NUNCA cobram (inferencia local).
FREE_PROVIDERS = {"custom", "ollama"}

# Ids que denunciam modelo local mesmo com billing_provider ausente no row.
LOCAL_MODEL_HINTS = ("qwen-64k", "qwen3.5", "gemma3", ":latest")


def _is_leak(model: str, provider: str) -> bool:
    """True para id pago fora da allowlist (candidato a cobranca indevida).

    FAIL-CLOSED em provider desconhecido (finding P2 do review do PR #6446):
    a versao anterior tratava billing_provider NULL/vazio como "nao cobra" —
    o oposto do proposito do detector. Agora provider ausente so escapa se o
    MODELO em si for comprovadamente gratuito/local; caso contrario, flag.
    """
    if not model:
        return False
    if model.endswith(":free") or model in PAID_ALLOWLIST:
        return False
    # stealth/* rodou gratuito durante a janela de preview (ox-alpha, ate
    # 26/08/2026). Sem sufixo :free, mas nunca cobrou.
    if model.startswith("stealth/"):
        return False
    prov = (provider or "").lower()
    if prov in FREE_PROVIDERS:
        return False
    if prov in BILLABLE_PROVIDERS:
        return True
    # Provider ausente/desconhecido: suspeito por default, a menos que o id
    # do modelo seja claramente local.
    return not any(h in model for h in LOCAL_MODEL_HINTS)


def collect(days: int) -> list[dict]:
    cutoff = (dt.datetime.now() - dt.timedelta(days=days)).timestamp()
    con = _connect()
    rows = con.execute(
        """
        SELECT date(u.first_seen, 'unixepoch', 'localtime') AS dia,
               u.model,
               s.model AS pedido,
               u.billing_provider,
               SUM(u.api_call_count),
               SUM(u.input_tokens),
               SUM(u.output_tokens),
               SUM(COALESCE(u.actual_cost_usd, 0)),
               SUM(COALESCE(u.estimated_cost_usd, 0))
          FROM session_model_usage u
          LEFT JOIN sessions s ON s.id = u.session_id
         WHERE u.first_seen > ?
         GROUP BY dia, u.model, s.model, u.billing_provider
         ORDER BY dia DESC, 9 DESC, 5 DESC
        """,
        (cutoff,),
    ).fetchall()
    con.close()

    out = []
    for dia, model, pedido, prov, calls, tin, tout, actual, est in rows:
        model = model or "?"
        out.append(
            {
                "dia": dia,
                "modelo": model,
                "pedido": pedido or "?",
                "provider": prov or "?",
                "chamadas": calls or 0,
                "tokens_in": tin or 0,
                "tokens_out": tout or 0,
                "custo_real": round(actual or 0, 6),
                "custo_estimado": round(est or 0, 6),
                "substituido": bool(pedido and pedido != model),
                "vazamento_pago": _is_leak(model, prov or ""),
            }
        )
    return out


def render(rows: list[dict], days: int, show_sessions: bool) -> None:
    if not rows:
        print(f"Nenhum uso registrado nos ultimos {days} dias.")
        return

    print(f"=== Uso por modelo — ultimos {days} dias ===\n")
    print(f"{'dia':11} {'modelo':40} {'calls':>6} {'in':>9} {'out':>8} "
          f"{'real':>9} {'est':>9}")
    print("-" * 96)

    dia_atual = None
    for r in rows:
        if dia_atual and r["dia"] != dia_atual:
            print()
        dia_atual = r["dia"]
        flag = ""
        if r["vazamento_pago"]:
            flag = "  <-- PAGO FORA DA ALLOWLIST"
        elif r["substituido"]:
            flag = f"  (pedido: {r['pedido']})"
        print(
            f"{r['dia']:11} {r['modelo'][:40]:40} {r['chamadas']:>6} "
            f"{r['tokens_in']:>9} {r['tokens_out']:>8} "
            f"${r['custo_real']:>8.4f} ${r['custo_estimado']:>8.4f}{flag}"
        )

    real = sum(r["custo_real"] for r in rows)
    est = sum(r["custo_estimado"] for r in rows)
    print("-" * 96)
    print(f"TOTAL  real=${real:.4f}  estimado=${est:.4f}"
          f"  ({real / days:.4f}/dia real)")

    local = sum(r["chamadas"] for r in rows if r["provider"] == "custom"
                or "qwen" in r["modelo"])
    total_calls = sum(r["chamadas"] for r in rows) or 1
    pct = 100 * local / total_calls
    print(f"Chamadas no modelo LOCAL: {local}/{total_calls} ({pct:.1f}%)"
          f"{'   <-- degradacao alta, checar balde free' if pct > 40 else ''}")

    leaks = [r for r in rows if r["vazamento_pago"]]
    if leaks:
        print(f"\n!! {len(leaks)} linha(s) cobradas em id PAGO fora da "
              f"allowlist — total ${sum(x['custo_estimado'] for x in leaks):.4f}")
        for r in leaks:
            print(f"   {r['dia']}  {r['modelo']}  (pedido: {r['pedido']})"
                  f"  ${r['custo_estimado']:.4f}")

    if show_sessions:
        print("\n=== Sessoes com substituicao de modelo ===")
        subs = [r for r in rows if r["substituido"]]
        if not subs:
            print("  (nenhuma)")
        for r in subs:
            print(f"  {r['dia']}  {r['pedido']:34} -> {r['modelo']:34}"
                  f"  ${r['custo_estimado']:.4f}")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--days", type=int, default=7, help="janela em dias (default 7)")
    ap.add_argument("--sessions", action="store_true",
                    help="lista as substituicoes de modelo pedido -> cobrado")
    ap.add_argument("--json", action="store_true", help="saida JSON")
    args = ap.parse_args()

    rows = collect(args.days)
    if args.json:
        print(json.dumps(rows, indent=2, ensure_ascii=False))
    else:
        render(rows, args.days, args.sessions)


if __name__ == "__main__":
    main()
