#!/usr/bin/env python3
"""
hermes-model-cost-report.test.py — regressão pro #6880 (decorre do #6708).

`collect()` fazia `LEFT JOIN sessions s ON s.id = u.session_id` só pra
produzir a coluna `pedido` (`s.model`) e o campo derivado `substituido`
(`pedido != modelo`). `sessions.model` é o modelo CORRENTE da sessão
(mutável) — não o modelo pedido NA CHAMADA que gerou aquela linha
agregada. Uma sessão que trocasse de modelo DEPOIS de fazer chamadas com
um modelo mais antigo fabricava uma "substituição" que nunca aconteceu.
Foi exatamente esse artefato de JOIN que abriu o #6708 como falso P1
(nenhuma cobrança fora da allowlist tinha de fato ocorrido).

Cobre:
  1. `collect()` nunca mais retorna as chaves `pedido`/`substituido`.
  2. `collect()` funciona SEM a tabela `sessions` existir no banco —
     prova que a dependência foi removida de verdade, não só escondida.
  3. `_is_leak`/`vazamento_pago` continuam corretos (dependem só de
     `model`/`provider`, nunca tocaram `pedido`) — não é uma regressão
     por associação com o fix.

#6912 (01/09/2026): também cobre `collect_tick_composition` — o detector de
degradação silenciosa POR TICK do job `continuo` (fallback local invisível
quando agregado por dia+modelo, ver docstring da função):
  4. tick 100% no modelo primário -> degraded=False.
  5. tick com qualquer chamada no fallback local (qwen) -> degraded=True,
     mesmo que a maioria das chamadas tenha sido no primário.
  6. session_id fora do padrão `hermes-cron-{JOB_ID}-*` não entra na
     composição (não é o job continuo).

Uso: python3 hermes/scripts/hermes-model-cost-report.test.py
"""

from __future__ import annotations

import importlib.util
import sqlite3
import sys
import tempfile
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
MODULE_PATH = HERE / "hermes-model-cost-report.py"

FAILED = 0


def _load_module():
    spec = importlib.util.spec_from_file_location("hermes_model_cost_report", MODULE_PATH)
    mod = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(mod)
    return mod


def assert_true(desc: str, cond: bool) -> None:
    global FAILED
    if cond:
        print(f"ok: {desc}")
    else:
        print(f"FAIL: {desc}")
        FAILED += 1


def _seed_usage_only(db_path: Path) -> None:
    """Banco com session_model_usage mas SEM a tabela sessions — prova que
    collect() não depende mais dela."""
    con = sqlite3.connect(db_path)
    con.execute(
        """
        CREATE TABLE session_model_usage (
            session_id TEXT,
            model TEXT,
            billing_provider TEXT,
            api_call_count INTEGER,
            input_tokens INTEGER,
            output_tokens INTEGER,
            actual_cost_usd REAL,
            estimated_cost_usd REAL,
            first_seen REAL
        )
        """
    )
    now = time.time()
    # Cenário do #6708: uma sessão fez chamadas com um modelo :free (nunca
    # cobrou), sem nenhuma linha de vazamento real.
    con.execute(
        "INSERT INTO session_model_usage VALUES (?,?,?,?,?,?,?,?,?)",
        ("s1", "z-ai/glm-5.3-flash:free", "openrouter", 3, 1000, 500, 0.0, 0.0, now),
    )
    # Linha de vazamento real: pago, fora da allowlist.
    con.execute(
        "INSERT INTO session_model_usage VALUES (?,?,?,?,?,?,?,?,?)",
        ("s2", "z-ai/glm-5.2", "openrouter", 17, 100000, 100000, 0.459, 0.459, now),
    )
    con.commit()
    con.close()


def _seed_tick_composition(db_path: Path, job_id: str) -> None:
    """Banco com 5 ticks do continuo — 1 saudavel (100% primario), 1
    degradado (chamou o fallback local), 1 com o id do modelo prefixado, 1
    no formato historico de hifens, 1 com chamada paga + :free (#10431) — e
    1 sessao fora do padrao (nao e do job continuo, nao deve entrar na
    composicao).

    #6963: os session_id usam o formato REAL de producao,
    `cron_{job_id}_<data>_<hora>` (UNDERSCORE). A fixture antiga usava
    `hermes-cron-{job_id}-*`, o MESMO padrao errado da implementacao — por
    isso o teste ficava verde enquanto a query casava zero linhas no banco
    de verdade (0 contra 238, medido em producao em 01/09). Um teste que
    seeda a suposicao da implementacao nao testa nada alem dela mesma."""
    con = sqlite3.connect(db_path)
    con.execute(
        """
        CREATE TABLE session_model_usage (
            session_id TEXT,
            model TEXT,
            billing_provider TEXT,
            api_call_count INTEGER,
            input_tokens INTEGER,
            output_tokens INTEGER,
            actual_cost_usd REAL,
            estimated_cost_usd REAL,
            first_seen REAL
        )
        """
    )
    now = time.time()
    rows = [
        # tick saudavel: só primário.
        (f"cron_{job_id}_20260901_010101", "gpt-5.6-luna", "openai-codex", 5, 1000, 500, 0.0, 0.0, now),
        # tick degradado: maioria no primário, mas ALGUMA chamada caiu no
        # fallback local (qwen) — degraded=True mesmo sendo minoria.
        (f"cron_{job_id}_20260901_020202", "gpt-5.6-luna", "openai-codex", 8, 2000, 1000, 0.0, 0.0, now),
        (f"cron_{job_id}_20260901_020202", "qwen3.5:latest", "custom", 2, 200, 100, 0.0, 0.0, now),
        # tick saudável cuja chamada foi gravada com o id PREFIXADO do
        # mesmo modelo primário (PAID_ALLOWLIST já prova que as duas formas
        # aparecem em produção) — precisa contar como primário, não cair em
        # other_calls (finding do review do #6912).
        (f"cron_{job_id}_20260901_030303", "openai-codex/gpt-5.6-luna", "openai-codex", 4, 800, 400, 0.0, 0.0, now),
        # #6963: formato HISTORICO de hifens — segue aceito de proposito,
        # pra um deploy antigo/futuro do Hermes que volte a produzi-lo nao
        # ficar invisivel do mesmo jeito que o real ficou.
        (f"hermes-cron-{job_id}-ddd444", "gpt-5.6-luna", "openai-codex", 3, 300, 150, 0.0, 0.0, now),
        # #10431: tick com uma chamada num id PAGO da OpenRouter (o ex-modelo
        # da lane, glm-5.3-flash; de proposito NAO o slug fixo antigo, deepseek) e outra num :free. A coluna
        # pago=% nao pode depender de um slug fixo: o pago entra em
        # paid_fallback, o :free em other_calls.
        (f"cron_{job_id}_20260901_040404", "gpt-6-luna", "openai-codex", 6, 600, 300, 0.0, 0.0, now),
        (f"cron_{job_id}_20260901_040404", "z-ai/glm-5.3-flash", "openrouter", 2, 200, 100, 0.01, 0.01, now),
        (f"cron_{job_id}_20260901_040404", "poolside/laguna-s-2.1:free", "openrouter", 2, 200, 100, 0.0, 0.0, now),
        # sessão fora do padrão (não é job continuo) — não deve aparecer.
        ("outra-sessao-qualquer", "gpt-5.6-luna", "openai-codex", 9, 900, 900, 0.0, 0.0, now),
    ]
    con.executemany(
        "INSERT INTO session_model_usage VALUES (?,?,?,?,?,?,?,?,?)", rows
    )
    con.commit()
    con.close()


def main() -> int:
    mod = _load_module()

    with tempfile.TemporaryDirectory() as td:
        db_path = Path(td) / "state.db"
        _seed_usage_only(db_path)
        mod.STATE_DB = db_path

        rows = mod.collect(days=1)

        assert_true("collect() retorna as 2 linhas seedadas", len(rows) == 2)

        for r in rows:
            assert_true(
                f"linha {r['modelo']!r}: NÃO tem a chave 'pedido' (artefato de JOIN removido, #6880)",
                "pedido" not in r,
            )
            assert_true(
                f"linha {r['modelo']!r}: NÃO tem a chave 'substituido' (derivada de 'pedido', removida junto)",
                "substituido" not in r,
            )

        free_row = next(r for r in rows if r["modelo"] == "z-ai/glm-5.3-flash:free")
        assert_true(
            "linha :free (sem sessions.model divergente possível de existir) -> vazamento_pago=False",
            free_row["vazamento_pago"] is False,
        )

        leak_row = next(r for r in rows if r["modelo"] == "z-ai/glm-5.2")
        assert_true(
            "linha paga fora da allowlist (sem :free, sem match na allowlist) -> vazamento_pago=True",
            leak_row["vazamento_pago"] is True,
        )

    with tempfile.TemporaryDirectory() as td:
        db_path = Path(td) / "state.db"
        _seed_tick_composition(db_path, mod.CONTINUO_JOB_ID)
        mod.STATE_DB = db_path

        ticks = mod.collect_tick_composition(days=1)
        session_ids = {t["session_id"] for t in ticks}

        assert_true(
            "collect_tick_composition() só retorna sessões do job contínuo (5, não 6 — a alheia fica de fora)",
            len(ticks) == 5,
        )
        assert_true(
            "sessão fora do padrão (outra-sessao-qualquer) NÃO entra na composição",
            "outra-sessao-qualquer" not in session_ids,
        )

        # #6963 — O TESTE QUE TERIA PEGO O BUG. O formato real de producao e
        # `cron_{id}_...` (underscore); a query usava `hermes-cron-{id}-%`
        # (hifens) e casava ZERO linhas — 0 contra 238 no banco real. Com a
        # fixture antiga (que seedava hifens) tudo passava. Esta assercao
        # falha contra a implementacao anterior.
        assert_true(
            "#6963: session_id no formato REAL de producao (cron_{id}_data_hora) entra na composição",
            any(t["session_id"].startswith(f"cron_{mod.CONTINUO_JOB_ID}_") for t in ticks),
        )
        assert_true(
            "#6963: formato histórico de hifens continua aceito (nenhum dos dois fica invisível)",
            any(t["session_id"].startswith(f"hermes-cron-{mod.CONTINUO_JOB_ID}-") for t in ticks),
        )

        saudavel = next(t for t in ticks if t["session_id"].endswith("010101"))
        assert_true(
            "tick 100% no modelo primário -> degraded=False",
            saudavel["degraded"] is False and saudavel["primary_pct"] == 100.0,
        )

        degradado = next(t for t in ticks if t["session_id"].endswith("020202"))
        assert_true(
            "tick com QUALQUER chamada no fallback local -> degraded=True, mesmo sendo minoria das chamadas",
            degradado["degraded"] is True and degradado["local_fallback_pct"] > 0
            and degradado["primary_pct"] > degradado["local_fallback_pct"],
        )

        # #6912 (review): PAID_ALLOWLIST já prova que o mesmo modelo aparece
        # sob 2 ids ("gpt-5.6-luna" e "openai-codex/gpt-5.6-luna") — a forma
        # prefixada tinha que contar como primário, não cair em other_calls.
        prefixado = next(t for t in ticks if t["session_id"].endswith("030303"))
        assert_true(
            "tick com modelo primário sob o id PREFIXADO (openai-codex/gpt-5.6-luna) -> conta como primário, não other_calls",
            prefixado["degraded"] is False and prefixado["primary_pct"] == 100.0
            and prefixado["other_calls"] == 0,
        )

        # #10431: a coluna pago=% conta QUALQUER id pago (via _is_leak), nao
        # mais o slug fixo CONTINUO_PAID_FALLBACK_MODEL (removido). Contra a
        # implementacao anterior (slug fixo = deepseek), o glm cairia em
        # other_calls e o tick pareceria sem chamada paga.
        pago = next(t for t in ticks if t["session_id"].endswith("040404"))
        assert_true(
            "#10431: chamada num id pago da OpenRouter conta em paid_fallback, :free conta em other_calls",
            pago["paid_fallback_calls"] == 2 and pago["other_calls"] == 2
            and pago["primary_calls"] == 6 and pago["paid_fallback_pct"] == 20.0,
        )
        assert_true(
            "#10431: tick só com primário não tem chamada paga",
            saudavel["paid_fallback_calls"] == 0 and degradado["paid_fallback_calls"] == 0,
        )

    # #10431: o --price-check (#6818 item 4) foi removido — inerte desde que o
    # #10387 esvaziou o baseline e tirou a chamada do watchdog.
    for gone in ("PAID_PRICE_BASELINE", "PAID_MODELS_NOT_ON_OPENROUTER", "PRICE_INCREASE_DECISIONS",
                 "detect_price_changes", "extract_catalog_pricing", "price_check_exit_code",
                 "CONTINUO_PAID_FALLBACK_MODEL"):
        assert_true(f"#10431: {gone} removido do módulo", not hasattr(mod, gone))

    # #10387 (18/10/2026, decisao do editor): nenhum modelo pago do
    # OpenRouter e intencional. PAID_ALLOWLIST vazio; o ex-fallback pago do
    # continuo (deepseek) e o ex-modelo da lane (glm) sao vazamento.
    assert_true(
        "#10387: PAID_ALLOWLIST vazio (nenhum modelo pago do OpenRouter e intencional)",
        len(mod.PAID_ALLOWLIST) == 0,
    )
    assert_true(
        "#10387: qualquer id pago do OpenRouter sem :free e vazamento; o mesmo id com :free nao",
        mod._is_leak("deepseek/deepseek-v4-flash", "openrouter") is True
        and mod._is_leak("z-ai/glm-5.3-flash", "openrouter") is True
        and mod._is_leak("poolside/laguna-s-2.1:free", "openrouter") is False,
    )
    assert_true(
        "primario do continuo esta em SUBSCRIPTION_ROUTE_MODELS (nunca vazamento; mesma classe de erro)",
        set(mod.CONTINUO_PRIMARY_MODEL_IDS) <= set(mod.SUBSCRIPTION_ROUTE_MODELS),
    )

    # #10431 item 1: o luna da rota de assinatura (openai-codex) nao e
    # vazamento; o MESMO luna faturado pela OpenRouter (id `openai/...`) e.
    # Rota real verificada em 18/10/2026: ~/.hermes/config.yaml roda o luna so
    # por provider openai-codex, e o state.db nao tem luna com
    # billing_provider=openrouter. Luna la = config errada, deve acusar.
    assert_true(
        "#10431: luna via openai-codex -> nao e vazamento",
        mod._is_leak("gpt-6-luna", "openai-codex") is False,
    )
    assert_true(
        "#10431: luna faturado pela OpenRouter (openai/gpt-6-luna) -> vazamento",
        mod._is_leak("openai/gpt-6-luna", "openrouter") is True
        and "openai/gpt-6-luna" not in mod.SUBSCRIPTION_ROUTE_MODELS,
    )

    # --- #7649 (08/09/2026): elo de assinatura claude.ai de claude-delegate.sh ---
    assert_true(
        "#7649: elo de assinatura ('sonnet') esta em SUBSCRIPTION_ROUTE_MODELS (nunca sinalizado como vazamento)",
        "sonnet" in mod.SUBSCRIPTION_ROUTE_MODELS,
    )
    assert_true(
        "#7649: _is_leak('sonnet', 'anthropic') -> False (nao e vazamento, mesmo com provider billable)",
        mod._is_leak("sonnet", "anthropic") is False,
    )
    assert_true(
        "#7649: _is_leak('sonnet', '') -> False mesmo com provider AUSENTE (fail-closed do #6446 nao pega um id na allowlist)",
        mod._is_leak("sonnet", "") is False,
    )

    # --- #8738 (23/09/2026): version bump gpt-5.6-luna -> gpt-6-luna ---
    #
    # Mesma classe de drift do #7649/PR #7648: o id do modelo "Luna" do
    # orquestrador mudou de versão (gpt-5.6-luna -> gpt-6-luna) sem a
    # allowlist acompanhar, e as 2 linhas cobradas $0/$0 (nas 2 formas,
    # nua e prefixada com openai-codex/) viraram falso "PAGO FORA DA
    # ALLOWLIST" no relatório. As formas ANTIGAS não foram removidas —
    # continuam cobertas por testes anteriores neste arquivo.
    assert_true(
        "#8738: _is_leak('gpt-6-luna', 'openai-codex') -> False (forma nua, mesmo com provider billable)",
        mod._is_leak("gpt-6-luna", "openai-codex") is False,
    )
    assert_true(
        "#8738: _is_leak('openai-codex/gpt-6-luna', 'openai-codex') -> False (forma prefixada)",
        mod._is_leak("openai-codex/gpt-6-luna", "openai-codex") is False,
    )
    assert_true(
        "#8738: _is_leak('gpt-6-luna', 'main') -> False (billing_provider 'main' observado no state.db real)",
        mod._is_leak("gpt-6-luna", "main") is False,
    )
    assert_true(
        "#8738: gpt-6-luna (as 2 formas) está em CONTINUO_PRIMARY_MODEL_IDS, senão o tick-composition "
        "classifica chamadas do modelo bumpado como 'outros' em vez de primário",
        {"gpt-6-luna", "openai-codex/gpt-6-luna"} <= set(mod.CONTINUO_PRIMARY_MODEL_IDS),
    )
    if FAILED:
        print(f"\n{FAILED} asserção(ões) falharam")
        return 1
    print("\nTODOS OS TESTES PASSARAM")
    return 0


if __name__ == "__main__":
    sys.exit(main())
