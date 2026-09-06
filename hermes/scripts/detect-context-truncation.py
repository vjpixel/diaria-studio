#!/usr/bin/env python3
"""Detecção EXTERNA de truncagem silenciosa do modelo local (qwen, llama e outros
via Ollama) via `session_model_usage` no state.db do Hermes.

Motivacao (issue #7528): o Ollama trunca o input silenciosamente — HTTP 200
sem sinal nenhum — quando o prompt excede a janela real do modelo. O Hermes
v0.20.5 nao checa `prompt_eval_count` na chamada, entao um tick que perdeu
metade do prompt e indistinguivel de um tick saudavel (so visivel semanas
depois, como no #6917).

O sinal ja existe e e gratuito: o valor truncado fica registrado em
`session_model_usage.input_tokens` (~/.hermes/state.db). Mas
`input_tokens` e cumulativo por sessao, nao por chamada — divide por
`api_call_count` para obter a media por chamada.

Duas armadilhas de leitura, ambas pagas ao medir:

- **`input_tokens` e cumulativo por sessao, nao por chamada.** Dividir por
  `api_call_count`. Sem isso os numeros parecem absurdos (2,2 milhões numa
  sessao) e a comparacao contra a janela nao faz sentido.
- **A tabela nao tem `updated_at`.** As colunas de tempo sao `first_seen` /
  `last_seen`. Um `select ... order by updated_at` falha com OperationalError.

Le a janela do modelo de ~/.hermes/config.yaml (`model.context_length`),
nunca hardcode (#7528: "leia da config, nao hardcode").

Dois patamares, porque significam coisas diferentes:

- **TRUNCANDO** — media por chamada colapsou pra bem abaixo do teto, ou bate
  repetidamente num mesmo valor suspeito (tipo 32770). Alarme (P1).
- **NA BORDA** — ocupacao acima de EDGE_RATIO (~85%) da janela sem truncar
  ainda. Aviso (log apenas, nunca alarme).

Nao mexer no core do Hermes (`run_agent.py`) para checar
`prompt_eval_count` na chamada. Seria o conserto de raiz, mas o Hermes e um
fork externo (`vjpixel/hermes`) e PR la fica aguardando review humano
indefinidamente (#6817 item 6). Deteccao externa entrega o valor sem essa
dependencia.

Uso:
    python3 detect-context-truncation.py [--days N] [--json]
        [--config <path>] [--state-db <path>] [--ollama-url <url>]
        [--ollama-model <name>] [--no-ollama]
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import sqlite3
import sys
import urllib.request
from pathlib import Path

STATE_DB = Path.home() / ".hermes" / "state.db"
CONFIG_YAML = Path.home() / ".hermes" / "config.yaml"
OLLAMA_SHOW_URL = "http://127.0.0.1:11434/api/show"

# Valor de truncagem suspeito (issue #7528): ~32770, que e 32768 (2^15) arredondado
# pra cima pelo overhead do Ollama. Quando a media por chamada bate
# repetidamente NESSE valor (ou valores proximos), e truncagem silenciosa.
TRUNCATION_VALUE = 32770
# Tolerancia em torno do valor de truncagem (6% — cobre variacao de rounding
# e overhead entre chamadas).
TRUNCATION_TOLERANCE_FRAC = 0.06
# Sessoes produtivas: precisam de pelo menos este numero de chamadas pra o
# "colapso" ser significativo. Evita flaggear sessoes de 1 chamada com input
# casualmente pequeno como truncagem.
MIN_CALLS_PRODUCTIVE = 3
# Colapso: media por chamada ABAIXO de COLLAPSE_RATIO * ceiling e considerada
# truncagem quando tambem esta acima de COLLAPSE_FLOOR (para filtrar o padrao
# de 2050 tokens/calls = sessoes de verdade pequenas, nao truncagem).
COLLAPSE_RATIO = 0.50
COLLAPSE_FLOOR = 10000
# Na borda: ocupacao acima de EDGE_RATIO da janela sem truncar.
EDGE_RATIO = 0.85
# Quantas sessoes na faixa de truncagem disparam o alarme (repeticao).
TRUNCATION_MIN_COUNT = 2


def _load_yaml_config(config_path: Path) -> dict:
    """Carrega o config.yaml do Hermes. Fail-open: retorna {} se nao conseguir."""
    try:
        import yaml
    except ImportError:
        return {}
    try:
        with open(config_path, "r") as f:
            return yaml.safe_load(f) or {}
    except (FileNotFoundError, OSError, yaml.YAMLError):
        return {}


def _read_context_length_from_config(config: dict) -> int | None:
    """Extrai `model.context_length` do config parsed."""
    model = config.get("model")
    if isinstance(model, dict):
        cl = model.get("context_length")
        if cl is not None:
            try:
                return int(cl)
            except (TypeError, ValueError):
                pass
    return None


def _read_num_ctx_from_ollama(ollama_url: str, model_name: str, timeout: int = 5) -> int | None:
    """Query o endpoint /api/show do Ollama pra extrair `num_ctx` do Modelfile.

    Fallback quando config.yaml nao expor context_length. Fail-soft: retorna
    None se a API nao estiver disponivel (Ollama parado, container caido).
    """
    try:
        req = urllib.request.Request(
            ollama_url,
            data=json.dumps({"name": model_name}).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        params = data.get("parameters", "")
        if params and isinstance(params, str):
            for line in params.splitlines():
                line = line.strip()
                if line.startswith("num_ctx"):
                    parts = line.split()
                    if len(parts) >= 2:
                        try:
                            return int(parts[1])
                        except ValueError:
                            pass
    except Exception:
        pass
    return None


def _resolve_ceiling(config_path: Path, ollama_url: str, model_name: str) -> int | None:
    """Resolve a janela de contexto (ceiling) do modelo local.

    Ordem: config.yaml `model.context_length` (medido por sondagem, autoritativo)
    -> Ollama /api/show `num_ctx` (fallback quando config nao expor).
    Retorna None (INDETERMINADO) se nenhuma fonte responder.
    """
    config = _load_yaml_config(config_path)
    cl = _read_context_length_from_config(config)
    if cl is not None:
        return cl
    # Fallback: num_ctx do Modelfile via Ollama API.
    return _read_num_ctx_from_ollama(ollama_url, model_name)


def _connect_ro(db_path: Path) -> sqlite3.Connection:
    """Abre state.db READ-ONLY (nunca escreve — e um arquivo grande, centenas
    de MB hoje; abrir read-only evita corrupcao). Fail-fast se inexistente."""
    if not db_path.exists():
        sys.exit(f"[truncation] state.db nao encontrado em {db_path}")
    return sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)


def collect_local_sessions(days: int, db_path: Path) -> list[dict]:
    """Le session_model_usage de TODAS as provider, filtrado por janela
    temporal via `first_seen` (a tabela NAO tem updated_at — ver docstring).

    NAO filtra por modelo local — isso e feito em detect_truncation() via
    _is_local_model(). Le todas as rows para que o caller possa aplicar o
    filtro local (qwen/llama via Ollama) e outros filtros de negocio.

    Para cada row, calcula `avg_per_call = input_tokens / api_call_count`
    (input_tokens e cumulativo, divide pra obter a media real por chamada).
    """
    cutoff = (dt.datetime.now() - dt.timedelta(days=days)).timestamp()
    con = _connect_ro(db_path)
    # #7528 armadilha 2: usa first_seen, NUNCA updated_at (nao existe na tabela).
    rows = con.execute(
        """
        SELECT session_id,
               model,
               billing_provider,
               api_call_count,
               input_tokens,
               first_seen,
               last_seen
          FROM session_model_usage
         WHERE first_seen > ?
         ORDER BY first_seen DESC
        """,
        (cutoff,),
    ).fetchall()
    con.close()

    out = []
    for sid, model, provider, calls, tin, first, last in rows:
        calls = calls or 0
        tin = tin or 0
        avg = tin / calls if calls > 0 else 0
        out.append({
            "session_id": sid,
            "model": model or "?",
            "billing_provider": provider or "?",
            "api_call_count": calls,
            "input_tokens": tin,
            "avg_per_call": round(avg),
            "first_seen": first,
            "last_seen": last,
        })
    return out


def _is_local_model(row: dict) -> bool:
    """Filtra chamadas do modelo LOCAL (qwen/llama via Ollama) — truncagem so
    acontece la. Pagos (openrouter/openai-codex) nao truncam no mesmo ponto."""
    prov = (row.get("billing_provider") or "").lower()
    model = (row.get("model") or "").lower()
    if prov in ("custom", "ollama"):
        return True
    return any(h in model for h in ("qwen", "hermes"))


def _in_truncation_band(avg: float, truncation_value: int, tolerance_frac: float) -> bool:
    """True se `avg` esta dentro da faixa de truncagem suspeita."""
    lo = truncation_value * (1 - tolerance_frac)
    hi = truncation_value * (1 + tolerance_frac)
    return lo <= avg <= hi


def detect_truncation(
    sessions: list[dict],
    ceiling: int,
    truncation_value: int = TRUNCATION_VALUE,
    truncation_tolerance_frac: float = TRUNCATION_TOLERANCE_FRAC,
    collapse_ratio: float = COLLAPSE_RATIO,
    collapse_floor: float = COLLAPSE_FLOOR,
    min_calls_productive: int = MIN_CALLS_PRODUCTIVE,
    edge_ratio: float = EDGE_RATIO,
    truncation_min_count: int = TRUNCATION_MIN_COUNT,
) -> dict:
    """Classifica o estado de truncagem dado o conjunto de sessoes.

    Dois patamares (issue #7528):
    - **TRUNCANDO** (alarme): media por chamada colapsou pra bem abaixo do teto
      (sinal A, sozinho basta em sessao produtiva), OU bate repetidamente num
      valor suspeito como 32770 (sinal B, exige 2+ repeticoes).
    - **NA BORDA** (aviso): ocupacao >85% da janela sem truncar.

    Devolve:
    {
      "status": "truncating" | "edge" | "ok",
      "ceiling": int,
      "truncation_value": int,
      "edge_threshold": int,
      "truncating_sessions": [...],
      "edge_sessions": [...],
      "details": "...",
    }
    """
    local = [s for s in sessions if _is_local_model(s)]
    edge_threshold = round(ceiling * edge_ratio)
    collapse_limit = ceiling * collapse_ratio

    if not local:
        return {
            "status": "ok",
            "ceiling": ceiling,
            "truncation_value": truncation_value,
            "edge_threshold": edge_threshold,
            "truncating_sessions": [],
            "edge_sessions": [],
            "details": "Nenhuma sessao local na janela analisada.",
        }

    suspicious_value_hits: list[dict] = []
    collapse_hits: list[dict] = []

    for s in local:
        avg = s["avg_per_call"]
        calls = s["api_call_count"]

        # Sinal 1: bate no valor suspeito (32770 +- tolerancia).
        if _in_truncation_band(avg, truncation_value, truncation_tolerance_frac):
            suspicious_value_hits.append(s)

        # Sinal 2: colapso pra bem abaixo do teto (somente em sessoes produtivas
        # — calls >= min_calls_productive — para nao flaggear sessoes de 1
        # chamada com input casualmente pequeno como truncagem; o andar de cima
        # do piso COLLAPSE_FLOOR filtra o padrao de 2050 tokens/call = sessoes
        # de verdade pequenas, nao truncagem).
        if (calls >= min_calls_productive
                and avg < collapse_limit
                and avg > collapse_floor):
            collapse_hits.append(s)

    # "Repetidamente" (sinal B) exige 2+ acertos no valor suspeito; o colapso
    # (sinal A) e sozinho suficiente em uma sessao produtiva.
    is_truncating = len(suspicious_value_hits) >= truncation_min_count or len(collapse_hits) >= 1

    truncating: list[dict] = []
    edge: list[dict] = []
    seen_ids: set[str] = set()

    if is_truncating:
        for s in suspicious_value_hits:
            pct = round(s["avg_per_call"] / ceiling * 100, 1) if ceiling else 0
            truncating.append({**s, "pct_of_ceiling": pct, "signal": "suspicious_value"})
            seen_ids.add(s["session_id"])
        for s in collapse_hits:
            if s["session_id"] in seen_ids:
                continue
            pct = round(s["avg_per_call"] / ceiling * 100, 1) if ceiling else 0
            truncating.append({**s, "pct_of_ceiling": pct, "signal": "collapse"})
            seen_ids.add(s["session_id"])

        sig_counts: dict[str, int] = {}
        for t in truncating:
            sig_counts[t["signal"]] = sig_counts.get(t["signal"], 0) + 1
        parts = [f"{k}: {v}" for k, v in sig_counts.items()]
        details = (
            f"TRUNCAGEM detectada: {len(truncating)} sessao(es) | "
            f"valores suspeitos (~{truncation_value}): {len(suspicious_value_hits)} | "
            f"colapsos (avg < {int(collapse_limit)}): {len(collapse_hits)} | "
            f"ceil={ceiling} | " + " | ".join(parts)
        )
    else:
        # Sessoes na borda (ocupacao > 85% sem truncar).
        for s in local:
            avg = s["avg_per_call"]
            pct = round(avg / ceiling * 100, 1) if ceiling else 0
            if avg > edge_threshold:
                edge.append({**s, "pct_of_ceiling": pct, "signal": "edge"})

        if edge:
            details = (
                f"NA BORDA: {len(edge)} sessao(es) com avg_per_call > {edge_threshold} "
                f"(85% de {ceiling})"
            )
        else:
            max_avg = max(s["avg_per_call"] for s in local) if local else 0
            max_pct = round(max_avg / ceiling * 100, 1) if ceiling else 0
            details = (
                f"OK: {len(local)} sessao(es) locais, max avg_per_call={max_avg} "
                f"({max_pct}% de {ceiling}), sem truncagem nem proximidade do teto."
            )

    status = "truncating" if is_truncating else ("edge" if edge else "ok")

    return {
        "status": status,
        "ceiling": ceiling,
        "truncation_value": truncation_value,
        "edge_threshold": edge_threshold,
        "truncating_sessions": truncating,
        "edge_sessions": edge,
        "details": details,
    }


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--days", type=int, default=1,
                    help="janela temporal em dias (default 1)")
    ap.add_argument("--json", action="store_true",
                    help="saida JSON (para consumo do watch-continuo-health.sh)")
    ap.add_argument("--config", type=str, default=str(CONFIG_YAML),
                    help=f"path do config.yaml (default: {CONFIG_YAML})")
    ap.add_argument("--state-db", type=str, default=str(STATE_DB),
                    help=f"path do state.db (default: {STATE_DB})")
    ap.add_argument("--ollama-url", type=str, default=OLLAMA_SHOW_URL,
                    help=f"URL do endpoint /api/show do Ollama (fallback num_ctx)")
    ap.add_argument("--ollama-model", type=str, default="qwen-64k:latest",
                    help="nome do modelo Ollama pra query do num_ctx")
    ap.add_argument("--no-ollama", action="store_true",
                    help="desativa o fallback de query ao Ollama API")
    args = ap.parse_args()

    # #7528: le a janela da config, NUNCA hardcode.
    ollama_url = "disabled" if args.no_ollama else args.ollama_url
    ceiling = _resolve_ceiling(Path(args.config), ollama_url, args.ollama_model)
    if ceiling is None:
        out = {
            "status": "indeterminado",
            "details": (
                f"Nao foi possivel resolver context_length do config.yaml "
                f"({args.config}) nem via Ollama API ({ollama_url})."
            ),
        }
        if args.json:
            print(json.dumps(out, indent=2, ensure_ascii=False))
        else:
            print(f"[truncation] INDETERMINADO: {out['details']}")
        return 3  # 3 = indeterminado, fail-closed (nunca silencio)

    sessions = collect_local_sessions(args.days, Path(args.state_db))
    result = detect_truncation(sessions, ceiling)

    if args.json:
        print(json.dumps(result, indent=2, ensure_ascii=False))
    else:
        if result["status"] == "truncating":
            print(f"[truncation] TRUNCANDO — {result['details']}")
            for t in result["truncating_sessions"]:
                print(f"  sessao={t['session_id'][:35]} "
                      f"avg={t['avg_per_call']} calls={t['api_call_count']} "
                      f"({t['pct_of_ceiling']}% de {result['ceiling']}) "
                      f"signal={t['signal']}")
        elif result["status"] == "edge":
            print(f"[truncation] NA BORDA — {result['details']}")
            for e in result["edge_sessions"]:
                print(f"  sessao={e['session_id'][:35]} "
                      f"avg={e['avg_per_call']} calls={e['api_call_count']} "
                      f"({e['pct_of_ceiling']}% de {result['ceiling']})")
        else:
            print(f"[truncation] {result['details']}")

    # Exit codes: 0=ok, 1=edge(aviso), 2=truncating(alarme), 3=indeterminado
    return {"ok": 0, "edge": 1, "truncating": 2, "indeterminado": 3}[result["status"]]


if __name__ == "__main__":
    sys.exit(main())
