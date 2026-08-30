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
# from __future__ import annotations (#6697 self-review): as novas type hints
# `str | None`/`list[str]`/`set[str]` introduzidas nesta revisão usam sintaxe
# de anotação do Python 3.10+; sem este import, DEFINIR as funções (não só
# chamá-las) já lança TypeError num interpretador mais antigo — e não há
# garantia versionada aqui de qual Python roda no `helios`. O future import
# torna toda anotação uma string avaliada preguiçosamente, seguro desde 3.7+.
from __future__ import annotations

import json
import os
import re
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
#
# #6697 finding 1: "falhou model=X" FOI removido daqui. `claude-openrouter.sh`
# imprime essa linha para CADA modelo que falha antes de um seguinte dar
# certo — o fallback em cadeia é o comportamento de PROJETO, não uma falha
# (o caso comum é o :free #1 estourar cota e o #2 responder normalmente). O
# marcador precisa ser a linha TERMINAL, que só aparece quando a cadeia
# INTEIRA falhou (todos os modelos, sem nenhum sucesso) — ver o `exit 1`/
# `exit 4` no fim do loop do wrapper.
#
# #6795: "rc=1" foi removido pelo MESMO motivo que já valeu para
# "falhou model=" — `claude-openrouter.sh:282,288,300,304` imprime
# "falhou model=$MODEL rc=$RC: ..." em stderr para CADA modelo que falha
# antes de um seguinte dar certo, e um `:free` estourar cota (rc=1) seguido
# de sucesso no próximo elo é o tick normal e bem-sucedido, não uma falha de
# delegação. O filtro por substring casava essa linha e contava como falha
# um tick que terminou com exit 0. A linha TERMINAL correta já está na
# tupla ("ERRO: todos os modelos da cadeia falharam") — "rc=1" é redundante
# no caso real (cadeia inteira falhou) e nocivo no caso comum (fallback
# bem-sucedido).
DELEGATION_FAILURE_MARKERS = (
    "wrapper degradado",
    "ERRO: todos os modelos da cadeia falharam",
)

# #6697 finding 1: regex pra extrair, de um tick que falhou de fato, QUAIS
# modelos ele tentou nesta sequência — usado pela rotação (finding 2) pra
# não recomendar de volta um modelo que já falhou no mesmo tick.
#
# Achado no self-review desta mesma PR: um corte em `[^\s:]+` (parar no
# primeiro ':') TRUNCA slugs `:free` — a maioria dos modelos da chain
# (ex: "poolside/laguna-s-2.1:free") tem um ':' DENTRO do próprio nome, não
# só como delimitador do log. `claude-openrouter.sh` imprime "falhou
# model=$MODEL" seguido ora por espaço ("model=$MODEL rc=$RC: ..."), ora por
# ':' direto ("model=$MODEL: TIMEOUT ...") — captura por \S+ (não-espaço) e
# só depois remove um ':' remanescente no fim (`.rstrip(":")`), que nunca
# aparece DENTRO de um slug real (sempre termina em letra, ex: "...free").
FAILED_MODEL_RE = re.compile(r"falhou model=(\S+)")


def _latest_tick_files(max_check: int = 5) -> list[str]:
    """Caminhos completos dos `max_check` ticks mais recentes (mais novo
    por último), ordenados por mtime — não pelo nome do arquivo, que é
    convenção do Hermes, não garantia."""
    out_dir = CRON_OUTPUT_DIR.format(JOB_ID)
    try:
        names = [f for f in os.listdir(out_dir) if f.endswith(".md")]
        files = sorted(names, key=lambda f: os.path.getmtime(os.path.join(out_dir, f)))
    except Exception:
        return []
    return [os.path.join(out_dir, f) for f in files[-max_check:]]


def _read_tick(path: str) -> str | None:
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            return f.read()
    except Exception:
        # Arquivo ilegível — sinalizado ao chamador via None; cada chamador
        # decide se isso conta como "falha" ou "pula" (não subestimar nem
        # superestimar o streak por um problema de leitura pontual).
        return None


def consecutive_delegation_failures(max_check: int = 5) -> int:
    """Conta quantos dos ticks mais recentes (mais novo primeiro) trazem
    marcador de falha de delegação TERMINAL, parando no primeiro tick sem
    marcador. Fonte independente de jobs.json — cobre o caso em que o Hermes
    nunca vê a falha porque o tick em si roda até o fim com exit 0."""
    count = 0
    for path in reversed(_latest_tick_files(max_check)):
        content = _read_tick(path)
        if content is None:
            continue
        if any(marker in content for marker in DELEGATION_FAILURE_MARKERS):
            count += 1
        else:
            break
    return count


def failed_models_in_latest_tick() -> set[str]:
    """Modelos que apareceram em uma linha `falhou model=X` no tick mais
    recente — usado só pra evitar recomendar de volta, na rotação (#6697
    finding 2), um modelo que JÁ falhou nesta mesma sequência."""
    files = _latest_tick_files(max_check=1)
    if not files:
        return set()
    content = _read_tick(files[-1])
    if content is None:
        return set()
    return {m.rstrip(":") for m in FAILED_MODEL_RE.findall(content)}


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

    # #6697 finding 3: NÃO exigir status == "ok" — um job novo (`last_status`
    # ainda "unknown") ou o estado logo após a pausa do watchdog irmão
    # (pause-cron-on-ratelimit.py) caem fora de "ok" sem serem falha real, e
    # isso fazia a saída MUDAR a cada tick com streak=0 (o próprio gatilho de
    # despacho do padrão monitor). streak e delegation_streak já são os
    # sinais determinísticos de falha real; last_status só entra na MENSAGEM
    # de alerta abaixo, nunca na decisão OK/ALERTA.
    if streak < 2 and delegation_streak < 2:
        print("OK")
        return

    # Falha(s): próximo da chain coding_fallback após o atual, pulando
    # modelos que JÁ falharam nesta sequência (#6697 finding 2 — a versão
    # anterior só avançava 1 posição com wrap-around, então com 2 modelos na
    # chain e ambos falhando o alerta alternava indefinidamente entre os
    # dois quebrados).
    try:
        chain = load_chain()
        if not chain:
            raise ValueError("coding_fallback vazio em config.yaml")
        failed = failed_models_in_latest_tick()
        idx = next((i for i, (m, _) in enumerate(chain) if m == model), None)
        start = (idx + 1) % len(chain) if idx is not None else 0
        candidates = [chain[(start + i) % len(chain)] for i in range(len(chain))]
        nxt = next((c for c in candidates if c[0] not in failed), candidates[0])
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
