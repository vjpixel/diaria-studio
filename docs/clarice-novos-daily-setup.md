# Task diária: envio automático aos cadastros novos da Clarice

Issue: [#4941](https://github.com/vjpixel/diaria-studio/issues/4941) (automatiza a skill `/diaria-clarice-novos`, entregue no [#4347](https://github.com/vjpixel/diaria-studio/issues/4347)).

## O que a task faz

`scripts/run-clarice-novos.ps1` → `npx tsx scripts/clarice-novos-run.ts`, rodando diariamente às **17:00 BRT**. `clarice-novos-run.ts` é o orquestrador determinístico dos 7 passos que até o #4941 só existiam como prosa executada manualmente por um LLM (`.claude/skills/diaria-clarice-novos/SKILL.md`) — delta Stripe → MV → grupo `novos` → campanha Brevo → disparo imediato, **sem gate humano** (decisão D6 do #4347), com os 9 guards determinísticos documentados na SKILL.md como única trava.

## Kill switch — `data/clarice-novos-enabled.json` (#4941 E3)

**Default `enabled: false`** quando o arquivo não existe — armar esta task NUNCA liga o disparo automático sozinha. O que está do outro lado do toggle é envio de e-mail real e irreversível sem revisão humana; o lado seguro do fail-soft é o oposto do padrão usado no toggle de chat do Studio (`studio-chat-enabled.ts`, #4078), que é `true` por default.

```bash
npx tsx scripts/lib/clarice-novos-enabled.ts --set enabled   # libera o disparo automático diário
npx tsx scripts/lib/clarice-novos-enabled.ts --set disabled  # pausa (kill switch — substitui "não rodar a skill de novo")
npx tsx scripts/lib/clarice-novos-enabled.ts                 # imprime "enabled"/"disabled"
```

**Depois de armar a task, ela roda todo dia às 17:00 mas sai imediatamente com "pausado" até você liberar o toggle explicitamente.** Confira a 1ª rodada pausada (relatório em `/relatorios` do Studio) antes de liberar.

## Guard de pré-condição — `data/clarice-subscribers/clarice-users.db`

Igual ao `Diaria-Brevo-Diaria-Evaluate` (#4552): se o store SQLite da Clarice não existir (sinal de que o junction `data/` do OneDrive ainda não montou nesta máquina), a task aborta ANTES de tocar Stripe/MV/Brevo — nunca roda sobre um `data/` vazio. Este guard é INDEPENDENTE do kill switch acima; os dois convivem (um cobre "`data/` ainda não sincronizou", o outro cobre "o editor pausou de propósito").

## Log

`data/clarice-subscribers/.novos-run.log` (append-only, gerado pelo runner declarativo — `scripts/lib/task-runner.ts`).

## Relatório por rodada

Toda invocação (sucesso, rodada vazia, pausada pelo toggle, ou abortada por qualquer guard) grava um relatório em `data/clarice-subscribers/novos-reports/{id}.md` e registra na superfície `/relatorios` do Studio (`data/reports/index.jsonl`, `kind: "clarice-novos"`, #3714) — com notificação por e-mail já no default (#4475). Uma rodada agendada que aborta em silêncio ficaria indistinguível de uma que não rodou; por isso o registro acontece em TODOS os caminhos, não só no sucesso (diferente do desenho original da skill, que só descrevia o Passo 7 no caminho feliz).

## Setup (ação local one-time do editor)

`local` — precisa do junction `data/` (OneDrive) + `STRIPE_API_KEY` + `BREVO_CLARICE_API_KEY` + `MILLION_VERIFIER_API_KEY`.

**Windows (Task Scheduler):**

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\setup-clarice-novos-schedule.ps1
```

Isso registra a task `Diaria-Clarice-Novos` (diária, 17:00). Idempotente — re-executar atualiza a task. Remover: mesmo comando com `-Unregister`.

**Linux (systemd, via o registro declarativo `scripts/lib/scheduled-tasks.ts`, épica #4798):**

```bash
npx tsx scripts/setup-systemd-timers.ts --task Diaria-Clarice-Novos   # gera os units em .systemd-units/
npx tsx scripts/arm-systemd-timers.ts --task Diaria-Clarice-Novos     # arma de verdade (systemctl)
```

## Armar em UMA máquina só (#4941 E4)

`data/` é junction do OneDrive sincronizada entre máquinas. `clarice-novos-resolve-key.ts` sufixa `-2`/`-3`… quando enxerga a key do dia já usada em `group-campaigns.json` — mas isso depende do OneDrive ter sincronizado esse arquivo a tempo. Duas máquinas armadas na mesma janela de latência poderiam resolver a MESMA key e criar 2 campanhas (envio duplicado real, não cosmético como o `history-predator-safeBackup-*.jsonl` do monitor GEO). Sem lock novo pra isso — se for armar numa 2ª máquina, desarme a 1ª antes (`-Unregister` / `systemctl --user disable --now diaria-clarice-novos.timer`).

**Task NÃO armada nesta unidade quando implementada em worktree isolado** — mesma disciplina do #4320/#4382/#4490/#4534/#4723 (credencial/estado de máquina fica fora do worktree do subagente). Se implementada numa sessão local com acesso real à máquina, o arme + a 1ª rodada (pausada pelo toggle) podem acontecer na mesma sessão — ver o PR/commit pra confirmar se isso ocorreu.

**Armada e confirmada ativa (#4941, 10/ago)** — `systemctl --user is-active diaria-clarice-novos.timer` retorna `active` na máquina `predator`, `Trigger: Tue 2026-08-11 20:00:00 UTC` (= 11/ago 17:00 BRT, o próximo disparo real). Kill switch confirmado no estado default seguro (`npx tsx scripts/lib/clarice-novos-enabled.ts` → `disabled`) — a 1ª rodada de amanhã sai limpo, sem tocar Stripe/MV/Brevo, até o editor liberar explicitamente. Arme feito fora de worktree isolado (sessão local direta no clone principal), então os passos acima já foram executados nesta máquina — não repetir.
