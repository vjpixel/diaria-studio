#!/usr/bin/env python3
"""
pause-cron-on-ratelimit.py — watchdog silencioso do job Diária Contínuo (5d791ef6fc2c).

Causa raiz tratada (#5948-adjacente, diagnóstico 23/08): quando TODAS as credenciais
do pool OpenRouter estão `exhausted` por rate-limit diário com reset FUTURO, cada
wake do cron falha com o erro enganoso "No LLM provider configured" até o reset.

Comportamento (padrão watchdog — silêncio quando nada a fazer):
  - Se o pool inteiro está exausto com reset futuro e o job está ATIVO:
      pausa o job (`hermes cron pause`) e imprime UMA mensagem (entregue ao chat).
      Grava marcador .paused-by-watchdog pra saber que FOI este watchdog.
  - Se o marcador existe e nenhuma exaustão-com-reset-futuro resta (reset natural
      aconteceu): retoma o job (`hermes cron resume`) e imprime UMA mensagem.
  - Se o marcador existe mas o job já voltou por outro caminho: só limpa o marcador.
  - Qualquer outro estado: sai sem imprimir nada (tick sem custo).

Limitação conhecida: se o editor pausar o job MANUALMENTE enquanto o marcador
existir, o watchdog ainda vai retomá-lo no reset (intenção manual é indistinguível
da intenção dele). Aceito — o marcador só vive entre pausa e reset, janela curta.

Guard de override manual (#6594, 28/08/2026): a pausa preventiva só se aplica
quando o job está de fato configurado pra rodar num modelo `:free` do
OpenRouter. Um override manual pra modelo pago (ex: `z-ai/glm-5.3-flash`) ou
outro provider não depende do pool free — exaustão dele é irrelevante nesse
caso, e pausar desfaria silenciosamente a decisão operacional do editor.
"""

import datetime
import json
import os
import subprocess

HERMES_HOME = os.path.expanduser("~/.hermes")
AUTH_PATH = os.path.join(HERMES_HOME, "auth.json")
JOBS_PATH = os.path.join(HERMES_HOME, "cron", "jobs.json")
MARKER_PATH = os.path.join(HERMES_HOME, "cron", ".paused-by-watchdog")
JOB_ID = "5d791ef6fc2c"


def _load(path):
    with open(path) as f:
        return json.load(f)


def _pool_state(entries, now_ts):
    """Retorna True se algum crendencial está exausta com reset futuro."""
    return any(
        e.get("last_status") == "exhausted"
        and (e.get("last_error_reset_at") or 0) > now_ts
        for e in entries
    )


def _job_uses_free_openrouter_pool(job):
    """True só se o job está configurado pra rodar num modelo `:free` do
    OpenRouter (#6594) — a exaustão do pool free só é relevante nesse caso.
    Um override manual pra modelo pago (provider != "openrouter", ou model
    sem sufixo ":free") não depende do pool: não deve ser pausado por ela
    nem ficar preso esperando o reset dela pra retomar."""
    provider = (job.get("provider") or "").strip().lower()
    model = (job.get("model") or "").strip().lower()
    return provider == "openrouter" and model.endswith(":free")


def main():
    try:
        auth = _load(AUTH_PATH)
        entries = auth.get("credential_pool", {}).get("openrouter", [])
    except Exception:
        return  # auth.json ilegível — não é hora de alarme
    if not entries:
        return  # sem pool openrouter — fora do escopo

    now_ts = datetime.datetime.now().timestamp()
    blocked = _pool_state(entries, now_ts)

    try:
        jobs_raw = _load(JOBS_PATH)
        items = jobs_raw if isinstance(jobs_raw, list) else jobs_raw.get("jobs", [])
        job = next((j for j in items if j.get("id") == JOB_ID), None)
    except Exception:
        return
    if job is None:
        return
    enabled = bool(job.get("enabled", True))
    paused_by_us = os.path.exists(MARKER_PATH)

    # --- retomada pós-reset ---
    if paused_by_us:
        if enabled:
            # alguém (editor ou reset manual) já reativou; só limpa o marcador
            os.remove(MARKER_PATH)
            return
        # #6594: se o editor reconfigurou o job pra modelo pago ENQUANTO
        # pausado, ele não depende mais do pool free — não faz sentido
        # esperar o reset dele pra retomar.
        if not blocked or not _job_uses_free_openrouter_pool(job):
            r = subprocess.run(
                ["hermes", "cron", "resume", JOB_ID],
                capture_output=True, text=True, timeout=90,
            )
            if r.returncode == 0:
                os.remove(MARKER_PATH)
                reason = (
                    "modelo do job não depende mais do pool free"
                    if blocked
                    else "a cota do OpenRouter renovou (reset natural)"
                )
                print(
                    f"▶️ **Diária Contínuo retomado** pelo watchdog: {reason}. "
                    f"Próximo wake volta ao normal."
                )
            else:
                print(
                    f"⚠️ Watchdog tentou retomar {JOB_ID} e falhou: "
                    f"{(r.stderr or r.stdout).strip()[:200]}"
                )
        return

    # --- pausa preventiva durante exaustão ---
    all_exhausted = all(e.get("last_status") == "exhausted" for e in entries)
    if all_exhausted and blocked and enabled and _job_uses_free_openrouter_pool(job):
        r = subprocess.run(
            ["hermes", "cron", "pause", JOB_ID],
            capture_output=True, text=True, timeout=90,
        )
        if r.returncode == 0:
            next_reset = max(
                (e.get("last_error_reset_at") or 0) for e in entries
            )
            dt = datetime.datetime.fromtimestamp(next_reset)
            with open(MARKER_PATH, "w") as f:
                f.write(JOB_ID)
            print(
                f"⏸️ **Diária Contínuo pausado** pelo watchdog: toda a credencial "
                f"OpenRouter está exaurida (rate limit diário — causa dos erros "
                f"`No LLM provider configured`). O job volta SOZINHO após o reset "
                f"natural ({dt:%d/%m %H:%M}); nenhuma ação necessária."
            )
        else:
            print(
                f"⚠️ Watchdog detectou exaustão total do pool mas não conseguiu "
                f"pausar {JOB_ID}: {(r.stderr or r.stdout).strip()[:200]}"
            )


if __name__ == "__main__":
    main()
