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
    """Banco com 4 ticks do continuo — 1 saudavel (100% primario), 1
    degradado (chamou o fallback local), 1 com o id do modelo prefixado, 1
    no formato historico de hifens — e 1 sessao fora do padrao (nao e do
    job continuo, nao deve entrar na composicao).

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
            "collect_tick_composition() só retorna sessões do job contínuo (4, não 5 — a alheia fica de fora)",
            len(ticks) == 4,
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

    # -----------------------------------------------------------------
    # #6818 item 4 — aumento de preço em modelo PAGO já em uso
    # -----------------------------------------------------------------
    # O buraco que motiva: `_is_leak` só pergunta "está na allowlist?", então
    # um modelo JÁ pago que dobra de preço (o degrau de 09/09 do glm-5.3-flash)
    # não dispara nada. Estes testes travam a detecção do aumento e, tão
    # importante quanto, travam que "não consegui medir" nunca vire "ok".
    BASE = {"z-ai/glm-5.3-flash": {"prompt": 0.000000075, "completion": 0.00000025}}

    def _catalog(*entries: dict) -> dict:
        return {"data": list(entries)}

    # 1. O CENÁRIO DA ISSUE: promoção expira, prompt dobra 0,075 -> 0,15/M.
    dobrou = mod.extract_catalog_pricing(_catalog(
        {"id": "z-ai/glm-5.3-flash",
         "pricing": {"prompt": "0.00000015", "completion": "0.00000025"}},
    ))
    f = mod.detect_price_changes(dobrou, baseline=BASE, not_on_openrouter=set())
    assert_true(
        "#6818: prompt dobrando (promoção expirada) -> 1 aumento detectado, fator 2x",
        len(f["increases"]) == 1
        and f["increases"][0]["campo"] == "prompt"
        and abs(f["increases"][0]["fator"] - 2.0) < 1e-9,
    )
    assert_true(
        "#6818: aumento -> exit code 3 (distinto de indeterminado)",
        mod.price_check_exit_code(f) == 3,
    )

    # 2. Preço inalterado não alarma — senão o alarme vira ruído diário.
    igual = mod.extract_catalog_pricing(_catalog(
        {"id": "z-ai/glm-5.3-flash",
         "pricing": {"prompt": "0.000000075", "completion": "0.00000025"}},
    ))
    f_igual = mod.detect_price_changes(igual, baseline=BASE, not_on_openrouter=set())
    assert_true(
        "#6818: preço igual ao baseline -> nenhum achado, exit 0",
        not any(f_igual.values()) and mod.price_check_exit_code(f_igual) == 0,
    )

    # 3. Queda de preço é reportada mas NUNCA alarma.
    caiu = mod.extract_catalog_pricing(_catalog(
        {"id": "z-ai/glm-5.3-flash",
         "pricing": {"prompt": "0.00000005", "completion": "0.00000025"}},
    ))
    f_caiu = mod.detect_price_changes(caiu, baseline=BASE, not_on_openrouter=set())
    assert_true(
        "#6818: queda de preço -> reportada como 'decrease', exit 0, nunca alarme",
        len(f_caiu["decreases"]) == 1 and not f_caiu["increases"]
        and mod.price_check_exit_code(f_caiu) == 0,
    )

    # 4. FAIL-CLOSED: modelo do baseline sumiu do catálogo -> INDETERMINADO,
    #    nunca silêncio. É o modo de falha que o alarme existe pra impedir.
    f_sumiu = mod.detect_price_changes({}, baseline=BASE, not_on_openrouter=set())
    assert_true(
        "#6818: modelo ausente do catálogo -> unverifiable + exit 1, nunca 'ok'",
        len(f_sumiu["unverifiable"]) == 1 and not f_sumiu["increases"]
        and mod.price_check_exit_code(f_sumiu) == 1,
    )

    # 5. Campo de preço somiu (id existe, `prompt` não) -> também indeterminado.
    f_campo = mod.detect_price_changes(
        mod.extract_catalog_pricing(_catalog(
            {"id": "z-ai/glm-5.3-flash", "pricing": {"completion": "0.00000025"}},
        )),
        baseline=BASE, not_on_openrouter=set(),
    )
    assert_true(
        "#6818: campo de preço ausente -> unverifiable nomeando o campo, exit 1",
        any(u.get("campo") == "prompt" for u in f_campo["unverifiable"])
        and mod.price_check_exit_code(f_campo) == 1,
    )

    # 6. Modelo pago fora da OpenRouter é `out_of_scope`, NÃO `unverifiable`,
    #    e NÃO alarma. Esses ids nunca vão aparecer no catálogo — somá-los ao
    #    indeterminado faria o alarme sair INDETERMINADO todo dia, pra sempre,
    #    e um alarme que sempre grita esconde o aumento real de 09/09.
    f_fora = mod.detect_price_changes(
        igual, baseline=BASE, not_on_openrouter={"openai-codex/gpt-5.6-luna"},
    )
    assert_true(
        "#6818: modelo pago servido por outra rota -> out_of_scope com motivo próprio",
        any(u["modelo"] == "openai-codex/gpt-5.6-luna" and "outra rota" in u["motivo"]
            for u in f_fora["out_of_scope"]),
    )
    assert_true(
        "#6818: out_of_scope sozinho NÃO alarma (exit 0) — fronteira conhecida não é medição falha",
        not f_fora["unverifiable"] and mod.price_check_exit_code(f_fora) == 0,
    )
    # E o caso real: com o PAID_ALLOWLIST/baseline de produção e o catálogo
    # sem alteração, a execução diária tem que sair limpa — senão o watchdog
    # nasce ruidoso e é desligado na primeira semana.
    f_prod = mod.detect_price_changes(igual, baseline=BASE)
    assert_true(
        "#6818: execução diária com preço inalterado sai exit 0, apesar dos modelos fora da OpenRouter",
        mod.price_check_exit_code(f_prod) == 0 and len(f_prod["out_of_scope"]) == 2,
    )

    # 7. Preço não-numérico NUNCA vira 0.0 — 0.0 leria como "de graça" e
    #    mascararia exatamente o que o alarme procura.
    lixo = mod.extract_catalog_pricing(_catalog(
        {"id": "z-ai/glm-5.3-flash", "pricing": {"prompt": None, "completion": "abc"}},
    ))
    assert_true(
        "#6818: preço não-parseável é OMITIDO, nunca coagido a 0.0",
        lixo.get("z-ai/glm-5.3-flash") is None
        or ("prompt" not in lixo["z-ai/glm-5.3-flash"]
            and "completion" not in lixo["z-ai/glm-5.3-flash"]),
    )

    # 8. Tolerância cobre ruído decimal, não variação real de preço.
    ruido = mod.extract_catalog_pricing(_catalog(
        {"id": "z-ai/glm-5.3-flash",
         "pricing": {"prompt": "0.0000000753", "completion": "0.00000025"}},
    ))
    f_ruido = mod.detect_price_changes(ruido, baseline=BASE, not_on_openrouter=set())
    assert_true(
        "#6818: +0,4% (ruído de arredondamento) fica DENTRO da tolerância de 1%",
        not f_ruido["increases"],
    )

    # 9. O baseline versionado tem que casar com a allowlist: um modelo pago
    #    em uso que não esteja nem no baseline nem na lista de fora-da-OpenRouter
    #    seria um ponto cego silencioso — exatamente o bug desta issue.
    coberto = set(mod.PAID_PRICE_BASELINE) | set(mod.PAID_MODELS_NOT_ON_OPENROUTER)
    assert_true(
        "#6818: todo modelo do PAID_ALLOWLIST está coberto pelo baseline ou nomeado fora da OpenRouter",
        set(mod.PAID_ALLOWLIST) <= coberto,
    )

    # --- achados do review do PR #7085 ---

    # 10. (P2) O caminho "catálogo inacessível" agora é função PURA. Antes era
    #     dict literal inline no main() — o único ponto onde o shape de
    #     `findings` era montado à mão, e um typo numa chave quebraria em
    #     silêncio justamente no fail-closed. Trava as 4 chaves e o exit 1.
    indisp = mod.build_catalog_unavailable_findings()
    assert_true(
        "#7085 P2: catálogo inacessível -> shape completo (4 chaves) e exit 1, nunca 0",
        set(indisp) == {"increases", "decreases", "out_of_scope", "unverifiable"}
        and len(indisp["unverifiable"]) == 1
        and mod.price_check_exit_code(indisp) == 1,
    )

    # 11. (P3) Tolerância SIMÉTRICA: -0,4% é ruído decimal, não queda real.
    #     Antes a folga valia só pro aumento e isso imprimia "queda" fantasma.
    ruido_baixo = mod.extract_catalog_pricing(_catalog(
        {"id": "z-ai/glm-5.3-flash",
         "pricing": {"prompt": "0.0000000747", "completion": "0.00000025"}},
    ))
    f_rb = mod.detect_price_changes(ruido_baixo, baseline=BASE, not_on_openrouter=set())
    assert_true(
        "#7085 P3: -0,4% fica dentro da tolerância — não vira 'queda' fantasma",
        not f_rb["decreases"] and not f_rb["increases"],
    )
    # E queda REAL continua sendo reportada (a folga não pode engolir tudo).
    f_qr = mod.detect_price_changes(caiu, baseline=BASE, not_on_openrouter=set())
    assert_true(
        "#7085 P3: queda real (-33%) continua reportada apesar da tolerância",
        len(f_qr["decreases"]) == 1,
    )

    # 12. (robustez) Raiz do JSON como LISTA não pode explodir com
    #     AttributeError — viraria traceback, e o exit 1 resultante seria
    #     fail-closed por acidente, não por desenho.
    assert_true(
        "#7085: catálogo com raiz não-dict -> {} (indeterminado por desenho), nunca exceção",
        mod.extract_catalog_pricing([]) == {} and mod.extract_catalog_pricing(None) == {},
    )

    # 13. `input_cache_read` é 90% do mix do tick (#6712) — é o campo que mais
    #     pesa no custo real, e nenhum teste variava ele especificamente.
    cache_subiu = mod.extract_catalog_pricing(_catalog(
        {"id": "z-ai/glm-5.3-flash", "pricing": {
            "prompt": "0.000000075", "completion": "0.00000025",
            "input_cache_read": "0.0000000255"}},
    ))
    f_cache = mod.detect_price_changes(
        cache_subiu,
        baseline={"z-ai/glm-5.3-flash": dict(BASE["z-ai/glm-5.3-flash"],
                                             input_cache_read=0.000000015)},
        not_on_openrouter=set(),
    )
    assert_true(
        "#7085: aumento SÓ no input_cache_read (campo dominante do custo) é detectado e alarma",
        len(f_cache["increases"]) == 1
        and f_cache["increases"][0]["campo"] == "input_cache_read"
        and mod.price_check_exit_code(f_cache) == 3,
    )

    if FAILED:
        print(f"\n{FAILED} asserção(ões) falharam")
        return 1
    print("\nTODOS OS TESTES PASSARAM")
    return 0


if __name__ == "__main__":
    sys.exit(main())
