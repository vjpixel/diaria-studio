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
ANTES da chamada disparar. A causa raiz da resolucao de modelo fica no
Hermes CORE (overrides de sessao persistidos, provavelmente
`~/.hermes/sessions/sessions.json`, mais a cadeia de smart_model_routing
em `~/.hermes/config.yaml`) — nenhum dos dois vive neste repo, e nao
existem nesta maquina/worktree (checado em 29/08/2026: `~/.hermes/`
inteiro ausente aqui, por design — so existe no `helios`). Investigar/
corrigir a causa raiz exige acesso a essa maquina; nao reproduzido nem
instrumentado a partir daqui. O que ESTE script ja cobre (deteccao
pos-fato via `vazamento_pago`/`_is_leak`, com base no `model`/`provider`
REALMENTE cobrados) e o que `watch-continuo-health.sh` ja consome pra
abrir issue automaticamente segue valido e e a mitigacao disponivel
enquanto a causa raiz no Hermes core nao for corrigida.

#6880 (01/09/2026, decorre do #6708): a coluna `pedido` (e o campo
derivado `substituido`) FORAM REMOVIDOS. `pedido` vinha de `sessions.model`
via `LEFT JOIN sessions s ON s.id = u.session_id` — mas `sessions.model` e
o modelo CORRENTE da sessao (mutavel), nao o modelo pedido NA CHAMADA que
gerou aquela linha agregada de `session_model_usage`. Qualquer sessao que
trocasse de modelo DEPOIS de fazer chamadas com um modelo mais antigo
fabricava uma "substituicao" que nunca aconteceu — foi exatamente esse
artefato de JOIN que abriu o #6708 como falso P1 (nenhuma cobranca fora da
allowlist tinha de fato ocorrido). `vazamento_pago`/`_is_leak` NAO usava
`pedido` pra nada — deriva so de `model`/`provider`, os campos REALMENTE
cobrados — e continua correto sem nenhuma mudanca.

#6912 (01/09/2026): `--tick-composition` reporta a composicao de modelo POR
TICK do job `continuo` (ver `collect_tick_composition`) — detecta degradacao
silenciosa pra fallback local (qwen) que `collect()` esconde ao agregar por
dia+modelo. So DETECTA/reporta por enquanto (consumido por
`watch-continuo-health.sh`); o limiar de alarme fica pra depois que houver
linha de base medida (issue #6912 pede baseline antes de calibrar).

Uso:
    python3 hermes-model-cost-report.py [--days N] [--json] [--tick-composition]
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

# #6912 (01/09/2026): cadeia de modelo do job `continuo` — MANTIDA A MAO
# neste arquivo, igual ao PAID_ALLOWLIST acima. `~/.hermes/cron/jobs.json` e
# `~/.hermes/config.yaml` (onde a cadeia REAL de smart_model_routing vive)
# sao fora de escopo deste repo (mesma fronteira do #6708 no topo do
# docstring) — nunca ler de la a partir daqui. Se a cadeia mudar no Hermes
# core, estas constantes ficam defasadas ate alguem atualizar a mao; e o
# mesmo trade-off ja aceito pro PAID_ALLOWLIST.
CONTINUO_JOB_ID = "5d791ef6fc2c"
# #6912 (review): o PAID_ALLOWLIST acima ja prova que o MESMO modelo aparece
# gravado sob 2 ids diferentes ("gpt-5.6-luna" e "openai-codex/gpt-5.6-luna",
# dependendo do provider/rota) — casar so a forma nua deixava a forma
# prefixada cair silenciosamente em other_calls, sem aparecer em nenhum
# percentual, corrompendo justo a linha de base que esta issue quer coletar.
CONTINUO_PRIMARY_MODEL_IDS = {"gpt-5.6-luna", "openai-codex/gpt-5.6-luna"}
CONTINUO_LOCAL_FALLBACK_HINT = "qwen"
CONTINUO_PAID_FALLBACK_MODEL = "z-ai/glm-5.3-flash"


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
               u.billing_provider,
               SUM(u.api_call_count),
               SUM(u.input_tokens),
               SUM(u.output_tokens),
               SUM(COALESCE(u.actual_cost_usd, 0)),
               SUM(COALESCE(u.estimated_cost_usd, 0))
          FROM session_model_usage u
         WHERE u.first_seen > ?
         GROUP BY dia, u.model, u.billing_provider
         ORDER BY dia DESC, 8 DESC, 4 DESC
        """,
        (cutoff,),
    ).fetchall()
    con.close()

    out = []
    for dia, model, prov, calls, tin, tout, actual, est in rows:
        model = model or "?"
        out.append(
            {
                "dia": dia,
                "modelo": model,
                "provider": prov or "?",
                "chamadas": calls or 0,
                "tokens_in": tin or 0,
                "tokens_out": tout or 0,
                "custo_real": round(actual or 0, 6),
                "custo_estimado": round(est or 0, 6),
                "vazamento_pago": _is_leak(model, prov or ""),
            }
        )
    return out


def collect_tick_composition(days: int) -> list[dict]:
    """Composicao de modelo POR TICK do job `continuo` (#6912).

    Motivacao: `collect()` agrupa por `(dia, model, provider)` — isso ESCONDE
    qual tick/sessao especifico rodou em qual modelo. Uma sessao inteira que
    degradou pro fallback local (qwen) some dentro da media do dia junto com
    dezenas de outras sessoes/jobs que rodaram normal no primario — o sintoma
    "silencioso" que o #6708 documentou no topo do arquivo, so que na camada
    de TICK em vez de cobranca.

    `session_id` do continuo e prefixado com o proprio job id do cron do
    Hermes — agrupa por essa coluna diretamente, sem JOIN com `sessions`
    (mesma licao do #6880: nao reintroduzir uma dependencia que ja se
    provou artefato).

    #6963: o formato REAL gravado em `session_model_usage` e
    `cron_{JOB_ID}_<data>_<hora>` (UNDERSCORE, sem prefixo `hermes-`) —
    ex. `cron_5d791ef6fc2c_20260901_170808`. O padrao anterior usado aqui,
    `hermes-cron-{JOB_ID}-%`, casava **ZERO** linhas: medido no banco de
    producao em 01/09, 0 linhas contra 238 do formato real. Ou seja, esta
    funcao SEMPRE devolveu `[]` e o detector de degradacao silenciosa do
    #6912 nunca teve como disparar. O teste nao pegou porque seedava a
    fixture com o mesmo padrao errado da implementacao — codificou a
    suposicao em vez da realidade do banco.

    Os DOIS padroes sao aceitos de proposito: o real (`cron_..._%`) e o
    historico de hifens, caso algum deploy antigo/futuro do Hermes volte a
    produzi-lo. Aceitar a mais nao tem custo (nenhuma sessao que nao seja
    deste job casa qualquer um dos dois); aceitar a menos foi exatamente o
    bug.

    Os `_` do padrao real sao ESCAPADOS: em `LIKE` do SQL, `_` e curinga de
    UM caractere, entao `cron_{id}_%` sem escape tambem casaria
    `cronX{id}Y...`. Aqui isso seria overmatch inofensivo (nenhuma outra
    sessao tem essa forma), mas deixar o curinga implicito num padrao que
    parece literal e a semente da proxima leitura errada — e foi
    exatamente uma leitura errada de formato que originou este bug.
    """
    cutoff = (dt.datetime.now() - dt.timedelta(days=days)).timestamp()
    con = _connect()
    like_underscore = f"cron\\_{CONTINUO_JOB_ID}\\_%"
    like_hyphen = f"hermes-cron-{CONTINUO_JOB_ID}-%"
    rows = con.execute(
        """
        SELECT u.session_id,
               MIN(date(u.first_seen, 'unixepoch', 'localtime')) AS dia,
               u.model,
               SUM(u.api_call_count)
          FROM session_model_usage u
         WHERE u.first_seen > ?
           AND (u.session_id LIKE ? ESCAPE '\\' OR u.session_id LIKE ?)
         GROUP BY u.session_id, u.model
         ORDER BY dia ASC, u.session_id ASC
        """,
        (cutoff, like_underscore, like_hyphen),
    ).fetchall()
    con.close()

    ticks: dict[str, dict] = {}
    for session_id, dia, model, calls in rows:
        model = model or "?"
        calls = calls or 0
        t = ticks.setdefault(
            session_id,
            {"session_id": session_id, "dia": dia, "primary_calls": 0,
             "local_fallback_calls": 0, "paid_fallback_calls": 0,
             "other_calls": 0, "total_calls": 0},
        )
        t["total_calls"] += calls
        if model in CONTINUO_PRIMARY_MODEL_IDS:
            t["primary_calls"] += calls
        elif CONTINUO_LOCAL_FALLBACK_HINT in model:
            t["local_fallback_calls"] += calls
        elif model == CONTINUO_PAID_FALLBACK_MODEL:
            t["paid_fallback_calls"] += calls
        else:
            t["other_calls"] += calls

    out = []
    for t in ticks.values():
        total = t["total_calls"] or 1
        out.append(
            {
                **t,
                "primary_pct": round(100 * t["primary_calls"] / total, 1),
                "local_fallback_pct": round(100 * t["local_fallback_calls"] / total, 1),
                "paid_fallback_pct": round(100 * t["paid_fallback_calls"] / total, 1),
                # degraded = QUALQUER chamada no fallback local — sem limiar,
                # a mera presenca ja prova que o primario falhou naquele
                # tick (o limiar de alarme fica pra depois, quando houver
                # linha de base medida — ver #6912).
                "degraded": t["local_fallback_calls"] > 0,
            }
        )
    out.sort(key=lambda r: (r["dia"], r["session_id"]))
    return out


def render(rows: list[dict], days: int) -> None:
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
        flag = "  <-- PAGO FORA DA ALLOWLIST" if r["vazamento_pago"] else ""
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
            print(f"   {r['dia']}  {r['modelo']}  ${r['custo_estimado']:.4f}")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--days", type=int, default=7, help="janela em dias (default 7)")
    ap.add_argument("--json", action="store_true", help="saida JSON")
    ap.add_argument("--tick-composition", action="store_true",
                     help="composicao de modelo por TICK do job continuo (#6912), em vez do relatorio por dia/modelo")
    args = ap.parse_args()

    if args.tick_composition:
        rows = collect_tick_composition(args.days)
        if args.json:
            print(json.dumps(rows, indent=2, ensure_ascii=False))
        else:
            if not rows:
                print(f"Nenhum tick do continuo registrado nos ultimos {args.days} dias.")
            for r in rows:
                flag = "  <-- DEGRADADO (usou fallback local)" if r["degraded"] else ""
                print(f"{r['dia']:11} {r['session_id']:40} "
                      f"primario={r['primary_pct']:5.1f}%  local={r['local_fallback_pct']:5.1f}%  "
                      f"pago={r['paid_fallback_pct']:5.1f}%{flag}")
        return

    rows = collect(args.days)
    if args.json:
        print(json.dumps(rows, indent=2, ensure_ascii=False))
    else:
        render(rows, args.days)


if __name__ == "__main__":
    main()
