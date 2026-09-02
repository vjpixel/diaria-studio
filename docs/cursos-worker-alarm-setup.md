# Worker `cursos`: sync do KV de assinantes

Issue: [#4320](https://github.com/vjpixel/diaria-studio/issues/4320) (extraída da [#4305](https://github.com/vjpixel/diaria-studio/issues/4305), PR [#4306](https://github.com/vjpixel/diaria-studio/pull/4306)).

O worker `cursos` (hosting da página "Cursos sobre IA", `cursos.diar.ia.br`) loga todo caminho de degradação e tem `[observability] enabled = true` no `wrangler.toml` — o Cloudflare coleta os logs, mas **coletar não é avisar**. Este documento cobria originalmente duas peças: um alarme de erro e o sync do KV de assinantes. **O alarme de erro foi cortado (#6798, 01/09/2026, ver seção "Alarme de erro — removido" abaixo)** — só o sync do KV segue ativo.

---

## Alarme de erro — REMOVIDO (#6798, 01/09/2026)

Existiu como `scripts/cursos-error-alarm.ts` (task systemd `Diaria-Cursos-Error-Alarm`, a cada 2h) — lia 4 contadores cumulativos do KV `CURSOS_SUBSCRIBERS` (via `scripts/lib/shared/cursos-alarm-counters.ts`, que **permanece** — é instrumentação do worker, não do alarme, ver nota abaixo) e alarmava por erro fatal (`"COOKIE_HMAC_SECRET ausente"`/`"cadastro na Beehiiv falhou"`) ou taxa alta de `?email=` não confirmado.

**Removido por decisão do editor na auditoria de alarmes do #6798**: medição de 279 execuções, 0 disparos, 24 dias de vida — maior volume de execução do projeto com o menor sinal produzido; nenhum achado chegou a virar issue. Arquivos removidos: `scripts/cursos-error-alarm.ts`, `scripts/lib/cursos-error-alarm.ts`, `test/cursos-error-alarm.test.ts`, `test/cursos-error-alarm-script.test.ts`, e a entrada `Diaria-Cursos-Error-Alarm` em `scripts/lib/scheduled-tasks.ts`.

**O que NÃO foi removido, de propósito:** `scripts/lib/shared/cursos-alarm-counters.ts` (as 4 chaves + `incrementKvCounter`) e os pontos de incremento em `workers/cursos/src/index.ts`/`subscribe.ts` — são instrumentação do WORKER (grava contadores no KV nos mesmos pontos onde já loga), não do alarme que os lia. Removê-los exigiria deploy do worker sem ganho claro (os contadores não têm custo de manutenção — só ficam sem leitor); se algum dia surgir um leitor melhor (ex: dashboard, ou um novo alarme com critério diferente), os dados já estarão lá.

**Ação manual pendente do editor:** desarmar a task no `helios` —
```bash
systemctl --user disable --now diaria-cursos-error-alarm.timer
```
(remover `.service`/`.timer` de `~/.config/systemd/user/` é opcional — `disable --now` já basta pra parar de disparar.)

---

## Sync do KV de assinantes

`scripts/sync-cursos-subscribers-kv.ts` (#4052) pagina `GET /subscriptions?status=active` na Beehiiv e escreve `subscriber:{sha256(email)}` → `"1"` no KV `CURSOS_SUBSCRIBERS` — fonte **primária** de verificação do gate `?email=`. Rodou manualmente 1× (PR #4052) e nunca foi agendado; o `by_email` da Beehiiv funciona como fallback ao vivo (confirmado na #4305), então isto não é urgente, mas o caminho primário ficava permanentemente desatualizado sem o agendamento.

### Setup (ação local one-time do editor — NÃO feito nesta sessão)

Requer `BEEHIIV_API_KEY` (+ opcional `BEEHIIV_PUBLICATION_ID`, fallback `platform.config.json`) + `CLOUDFLARE_ACCOUNT_ID` + `CURSOS_KV_NAMESPACE_ID` (id do namespace `CURSOS_SUBSCRIBERS`, do `wrangler.toml`) no `.env` local + o junction `data/`. O antigo `.ps1` do Windows foi removido no #5115 (cutover final).

```bash
npx tsx scripts/setup-systemd-timers.ts --task Diaria-Cursos-Kv-Sync
systemctl --user daemon-reload
systemctl --user enable --now diaria-cursos-kv-sync.timer
```

Isso registra a task `Diaria-Cursos-Kv-Sync` (diária, 09:15 — 45min depois da `Diaria-Clarice-Sync`, pra não concorrer no mesmo horário). Idempotente — re-executar regenera os units. Remover: `systemctl --user disable --now diaria-cursos-kv-sync.timer`.

### Verificar que a 1ª execução deixou a contagem coerente

```bash
npx tsx scripts/sync-cursos-subscribers-kv.ts --dry-run
```

Imprime `{ subscribers: N, kv_entries: M, dry_run: true }` — `N` deve bater (ordem de grandeza) com a contagem de assinantes ativos no dashboard Beehiiv, bem acima dos 535 que motivaram a issue original. Rodar sem `--dry-run` pra escrever de fato no KV.

### Log

`data/cursos-subscribers/.kv-sync.log` (append-only, uma seção por execução).
