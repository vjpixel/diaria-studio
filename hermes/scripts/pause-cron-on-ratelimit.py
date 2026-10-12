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

Pausa por `403 Key limit exceeded` (#10064, 12/10/2026): a parada de 08–10/10
acumulou `failure_streak=45` no job porque a key OpenRouter do fallback bateu
o limite DIÁRIO configurado na key (`RuntimeError: HTTP 403: Key limit
exceeded (daily limit)`) — erro que não passa pelo pool de `auth.json` (as
credenciais seguiam "ok"), então o ramo acima nunca disparava. Agora o
watchdog também lê `last_error`/`failure_streak` do próprio job:
  - `failure_streak >= KEY_LIMIT_MIN_STREAK` e `last_error` com 403 + "key
    limit exceeded" → pausa, independente do provider configurado (o erro é
    evidência direta de que todo tick falha), e grava o marcador em JSON com
    `resume_after` = próxima 00:00 UTC (+5min) — é quando o limite diário de
    key da OpenRouter renova.
  - Retomada: `now >= resume_after`. Ao retomar, guarda o `last_run_at` do job
    em `KEY_LIMIT_STATE_PATH`: o `last_error` só muda no PRÓXIMO run, e sem
    isso o watchdog re-pausaria na hora o job que acabou de retomar, lendo o
    erro velho. Se o próximo run falhar de novo, `last_run_at` muda e a pausa
    volta (correto: a cota ainda não voltou).
Marcador legado (texto `JOB_ID`, do ramo do pool) segue com a regra antiga.
"""

import datetime
import json
import os
import re
import subprocess

HERMES_HOME = os.path.expanduser("~/.hermes")
AUTH_PATH = os.path.join(HERMES_HOME, "auth.json")
JOBS_PATH = os.path.join(HERMES_HOME, "cron", "jobs.json")
MARKER_PATH = os.path.join(HERMES_HOME, "cron", ".paused-by-watchdog")
JOB_ID = "5d791ef6fc2c"
KEY_LIMIT_STATE_PATH = os.path.join(HERMES_HOME, "cron", ".key-limit-resumed-run")

# #10064: mesmo limiar de `AUTH_STALL_STREAK_THRESHOLD`
# (`scripts/check-continuo-auth-stall.ts`) — 1 falha isolada não é parada.
KEY_LIMIT_MIN_STREAK = 2
# Mesma assinatura de `QUOTA_STALL_PATTERNS` (#10001) no detector TS: código
# E frase juntos — um 403 genérico não casa.
KEY_LIMIT_RE = re.compile(r"\b403\b[\s\S]*key limit exceeded", re.IGNORECASE)
# Folga depois da virada UTC — o reset da OpenRouter não é instantâneo.
KEY_LIMIT_RESUME_MARGIN_S = 5 * 60


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


def _run_hermes_cmd(args):
    """subprocess.run com guard (#6697 finding 4) — sem isto, `hermes` fora do
    PATH (FileNotFoundError) ou uma chamada travada (TimeoutExpired) produzia
    traceback cru a cada tick em vez de uma mensagem de watchdog. Retorna
    `None` na falha (chamador trata como "não consegui rodar o comando",
    distinto de rc!=0, que é "rodei e o hermes recusou")."""
    try:
        return subprocess.run(args, capture_output=True, text=True, timeout=90)
    except (FileNotFoundError, subprocess.TimeoutExpired) as e:
        print(f"⚠️ Watchdog não conseguiu rodar `{' '.join(args)}`: {e}")
        return None


def _job_uses_free_openrouter_pool(job):
    """True só se o job está configurado pra rodar num modelo `:free` do
    OpenRouter (#6594) — a exaustão do pool free só é relevante nesse caso.
    Um override manual pra modelo pago (provider != "openrouter", ou model
    sem sufixo ":free") não depende do pool: não deve ser pausado por ela
    nem ficar preso esperando o reset dela pra retomar."""
    provider = (job.get("provider") or "").strip().lower()
    model = (job.get("model") or "").strip().lower()
    return provider == "openrouter" and model.endswith(":free")


def is_key_limit_error(last_error):
    """True se `last_error` do job é o 403 de limite diário da key (#10064)."""
    return isinstance(last_error, str) and bool(KEY_LIMIT_RE.search(last_error))


def next_key_limit_reset(now_ts):
    """Próxima 00:00 UTC estritamente depois de `now_ts`, + margem. O limite
    diário de key da OpenRouter renova na virada do dia UTC."""
    now = datetime.datetime.fromtimestamp(now_ts, tz=datetime.timezone.utc)
    midnight = (now + datetime.timedelta(days=1)).replace(
        hour=0, minute=0, second=0, microsecond=0
    )
    return midnight.timestamp() + KEY_LIMIT_RESUME_MARGIN_S


def _read_marker():
    """Conteúdo do marcador: dict (marcador JSON do #10064) ou None (legado
    em texto, ou ilegível — trata como o marcador antigo do pool)."""
    try:
        with open(MARKER_PATH) as f:
            raw = f.read()
    except OSError:
        return None
    try:
        data = json.loads(raw)
    except ValueError:
        return None
    return data if isinstance(data, dict) else None


def _read_resumed_run():
    try:
        with open(KEY_LIMIT_STATE_PATH) as f:
            return f.read().strip() or None
    except OSError:
        return None


def _handle_key_limit(job, enabled, paused_by_us, now_ts):
    """Ramo do #10064. Devolve True quando tratou o tick (o chamador não segue
    pro ramo do pool), False quando não é com ele."""
    marker = _read_marker() if paused_by_us else None
    if marker is not None and marker.get("reason") == "key_limit":
        if enabled:
            # editor (ou outra rotina) já retomou; só limpa o marcador
            os.remove(MARKER_PATH)
            return True
        resume_after = marker.get("resume_after") or 0
        if now_ts < resume_after:
            return True  # ainda antes do reset — silêncio
        r = _run_hermes_cmd(["hermes", "cron", "resume", JOB_ID])
        if r is None:
            return True
        if r.returncode == 0:
            os.remove(MARKER_PATH)
            try:
                with open(KEY_LIMIT_STATE_PATH, "w") as f:
                    f.write(str(job.get("last_run_at") or ""))
            except OSError as e:
                print(
                    f"⚠️ Watchdog retomou {JOB_ID} mas não gravou {KEY_LIMIT_STATE_PATH} "
                    f"({e}) — pode re-pausar no próximo tick lendo o 403 antigo."
                )
            print(
                "▶️ **Diária Contínuo retomado** pelo watchdog: passou a virada UTC "
                "do limite diário da key OpenRouter (403 Key limit exceeded). Se o "
                "próximo tick falhar de novo com o mesmo erro, o watchdog pausa outra vez."
            )
        else:
            print(
                f"⚠️ Watchdog tentou retomar {JOB_ID} (key limit) e falhou: "
                f"{(r.stderr or r.stdout).strip()[:200]}"
            )
        return True
    if paused_by_us:
        return False  # marcador do ramo do pool — regra antiga

    streak = job.get("failure_streak")
    if not (enabled and isinstance(streak, int) and streak >= KEY_LIMIT_MIN_STREAK):
        return False
    if not is_key_limit_error(job.get("last_error")):
        return False
    last_run = str(job.get("last_run_at") or "")
    if last_run and last_run == _read_resumed_run():
        # erro velho, de antes da nossa retomada — o job ainda não rodou de novo
        return True
    r = _run_hermes_cmd(["hermes", "cron", "pause", JOB_ID])
    if r is None:
        return True
    if r.returncode != 0:
        print(
            f"⚠️ Watchdog detectou 403 Key limit exceeded (failure_streak={streak}) "
            f"mas não conseguiu pausar {JOB_ID}: {(r.stderr or r.stdout).strip()[:200]}"
        )
        return True
    resume_after = next_key_limit_reset(now_ts)
    dt = datetime.datetime.fromtimestamp(resume_after, tz=datetime.timezone.utc)
    try:
        with open(MARKER_PATH, "w") as f:
            json.dump(
                {"job": JOB_ID, "reason": "key_limit", "resume_after": resume_after,
                 "paused_last_run_at": last_run},
                f,
            )
    except OSError as e:
        print(
            f"🚨 Watchdog PAUSOU {JOB_ID} (403 Key limit exceeded) mas FALHOU AO GRAVAR "
            f"o marcador ({e}) — o job vai ficar pausado INDEFINIDAMENTE sem retomada "
            f"automática. Ação manual: 'hermes cron resume {JOB_ID}' após "
            f"{dt:%d/%m %H:%M} UTC, ou investigar {MARKER_PATH}."
        )
        return True
    print(
        f"⏸️ **Diária Contínuo pausado** pelo watchdog: a key OpenRouter bateu o "
        f"limite diário (`403 Key limit exceeded`, failure_streak={streak}). "
        f"Retomada automática após {dt:%d/%m %H:%M} UTC (virada do limite diário); "
        f"pausar evita acumular falha a cada tick (#10064)."
    )
    return True


def main():
    now_ts = datetime.datetime.now().timestamp()
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

    # #10064: 403 de key limit vem do PRÓPRIO job, não do pool de auth.json —
    # roda antes (e independe) da leitura do pool.
    if _handle_key_limit(job, enabled, paused_by_us, now_ts):
        return

    try:
        auth = _load(AUTH_PATH)
        entries = auth.get("credential_pool", {}).get("openrouter", [])
    except Exception:
        return  # auth.json ilegível — não é hora de alarme
    if not entries:
        return  # sem pool openrouter — fora do escopo

    blocked = _pool_state(entries, now_ts)

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
            r = _run_hermes_cmd(["hermes", "cron", "resume", JOB_ID])
            if r is None:
                return
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
        r = _run_hermes_cmd(["hermes", "cron", "pause", JOB_ID])
        if r is None:
            return
        if r.returncode == 0:
            next_reset = max(
                (e.get("last_error_reset_at") or 0) for e in entries
            )
            dt = datetime.datetime.fromtimestamp(next_reset)
            # #6697 finding 4: o `hermes cron pause` JÁ efetivou quando este
            # `open()` roda. Qualquer exceção aqui (permissão, disco cheio)
            # deixava o job desabilitado SEM o marcador que autoriza a
            # retomada — o watchdog nunca mais o retomaria, em silêncio
            # (mesma classe do #6643: job pausado ~7h sem sinal). Gritar alto
            # em vez de deixar a exceção subir crua é o mínimo: o pause já
            # aconteceu, então a alternativa "falhar e não pausar" não existe
            # mais neste ponto.
            try:
                with open(MARKER_PATH, "w") as f:
                    f.write(JOB_ID)
            except OSError as e:
                print(
                    f"🚨 Watchdog PAUSOU {JOB_ID} mas FALHOU AO GRAVAR o marcador "
                    f"({e}) — o job vai ficar pausado INDEFINIDAMENTE sem retomada "
                    f"automática (o watchdog só retoma quando o marcador existe). "
                    f"Ação manual necessária: 'hermes cron resume {JOB_ID}' após o "
                    f"reset ({dt:%d/%m %H:%M}), ou investigar {MARKER_PATH}."
                )
                return
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
