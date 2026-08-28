#!/usr/bin/env python3
"""
monitor-cron-model-rotation.py — monitor do job Diária Contínuo (5d791ef6fc2c).

Padrão watchdog: stdout ESTÁVEL quando tudo bem (silêncio = nada a fazer);
stdout MUDANDO quando há falha nova a tratar. Anexado como monitor_script
de um cron de 15min, dispara o agente só quando o estado de falha muda.

Lógica:
  - Conta falhas consecutivas do job (failure_streak em jobs.json) E,
    independentemente, falhas de DELEGAÇÃO detectadas no output dos ticks
    mais recentes (#6616 — failure_streak/last_status do Hermes nunca
    refletem falha de trabalho interno: um tick que roda até o fim e
    imprime relatório é "ok" pro Hermes mesmo quando os 3 modelos do
    wrapper retornaram rc=1 e nada foi delegado de verdade).
  - Estado = f"{streak}:{last_status}:{model_atual}".
  - streak < 2 E nenhuma falha de delegação nos últimos ticks → "OK" estável.
  - streak >= 2 OU 2+ falhas de delegação consecutivas → alerta com o
                        PRÓXIMO modelo da chain coding_fallback
                        (preferência de codificação do editor no config.yaml),
                        pulando o atual e os que já falharam nesta sequência.
  - job rodando agora → "RUNNING" estável.
"""
import json
import os
import sys

import yaml

JOBS_JSON = os.path.expanduser("~/.hermes/cron/jobs.json")
CONFIG_YAML = os.path.expanduser("~/.hermes/config.yaml")
CRON_OUTPUT_DIR = os.path.expanduser("~/.hermes/cron/output/{}")
JOB_ID = "5d791ef6fc2c"

# Marcadores de falha de delegação no output em prosa do tick (#6616) — os
# mesmos citados na issue como evidência de que o wrapper não conseguiu
# rodar em NENHUM modelo, apesar do tick ter terminado com "sucesso" do
# ponto de vista do Hermes.
DELEGATION_FAILURE_MARKERS = ("rc=1", "wrapper degradado", "falhou model=")


def consecutive_delegation_failures(max_check: int = 5) -> int:
    """Conta quantos dos ticks mais recentes (mais novo primeiro) trazem
    marcador de falha de delegação, parando no primeiro tick sem marcador.
    Fonte independente de jobs.json — cobre o caso em que o Hermes nunca vê
    a falha porque o tick em si roda até o fim com exit 0."""
    out_dir = CRON_OUTPUT_DIR.format(JOB_ID)
    try:
        names = [f for f in os.listdir(out_dir) if f.endswith(".md")]
        # Ordena por mtime, não pelo nome — o nome do arquivo é convenção do
        # Hermes, não garantia; mtime é o sinal de "mais recente" real.
        files = sorted(names, key=lambda f: os.path.getmtime(os.path.join(out_dir, f)))
    except Exception:
        return 0
    count = 0
    for fname in reversed(files[-max_check:]):
        try:
            with open(
                os.path.join(out_dir, fname), encoding="utf-8", errors="replace"
            ) as f:
                content = f.read()
        except Exception:
            # Arquivo ilegível não conta como falha nem interrompe a
            # contagem — pula pro próximo tick mais antigo em vez de
            # subestimar o streak por um problema de leitura pontual.
            continue
        if any(marker in content for marker in DELEGATION_FAILURE_MARKERS):
            count += 1
        else:
            break
    return count


def load_chain():
    """Chain de fallback de codificação do config.yaml (preferência do editor)."""
    with open(CONFIG_YAML) as f:
        cfg = yaml.safe_load(f)
    chain = (
        cfg.get("smart_model_routing", {})
        .get("fallback_chains", {})
        .get("coding_fallback", [])
    )
    # normaliza para (model, provider)
    return [(e.get("model"), e.get("provider")) for e in chain if e.get("model")]


def main() -> None:
    try:
        with open(JOBS_JSON) as f:
            jobs = json.load(f)
        items = jobs if isinstance(jobs, list) else jobs.get("jobs", [])
        job = next(j for j in items if j.get("id") == JOB_ID)
    except Exception as e:
        print(f"ERRO lendo {JOBS_JSON}: {e}")
        return

    streak = int(job.get("failure_streak") or 0)
    status = job.get("last_status") or "unknown"
    model = job.get("model") or "?"
    state = job.get("state") or "?"
    provider = job.get("provider") or "?"

    if state == "running":
        print(f"RUNNING — ciclo em execução (modelo {model}); nada a fazer.")
        return

    delegation_streak = consecutive_delegation_failures()

    if streak < 2 and status == "ok" and delegation_streak < 2:
        print("OK")
        return

    # Falha(s): próximo da chain coding_fallback após o atual.
    try:
        chain = load_chain()
        idx = next((i for i, (m, _) in enumerate(chain) if m == model), None)
        if idx is None:
            nxt = chain[0] if chain else ("gpt-5.6-luna", "openai-codex")
        else:
            nxt = chain[(idx + 1) % len(chain)]
        nxt_txt = f"{nxt[0]} ({nxt[1]})"
    except Exception as e:
        nxt_txt = f"gpt-5.6-luna (openai-codex) — falha ao ler chain: {e}"

    print(
        f"ALERTA falhas_cron={streak} falhas_delegacao_detectadas={delegation_streak} "
        f"last_status={status} modelo_atual={model} ({provider}). "
        f"Se failure_streak >= 2 OU falhas de delegação consecutivas >= 2: trocar o "
        f"modelo do job para o PRÓXIMO da chain coding_fallback: {nxt_txt} via "
        f"'hermes cron edit {JOB_ID} --model <modelo> --provider <provider>' "
        f"ANTES do próximo disparo, diagnosticar a causa e registrar na issue/relatório. "
        f"Critério do editor: 2 falhas consecutivas = rotação obrigatória seguindo "
        f"a prioridade de codificação dele no config.yaml."
    )


if __name__ == "__main__":
    sys.exit(main())
