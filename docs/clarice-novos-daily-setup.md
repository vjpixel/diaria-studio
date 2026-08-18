# Task diária: envio automático aos cadastros novos da Clarice

Issue: [#4941](https://github.com/vjpixel/diaria-studio/issues/4941) (automatiza a skill `/diaria-clarice-novos`, entregue no [#4347](https://github.com/vjpixel/diaria-studio/issues/4347)).

## O que a task faz

Task `Diaria-Clarice-Novos` (`scripts/lib/scheduled-tasks.ts`) → `npx tsx scripts/clarice-novos-run.ts`, rodando diariamente às **09:00 BRT** (mudou de 11:00 em 260816, #5447 — sucede o #5140, que tinha mudado de 17:00 em 260812). `clarice-novos-run.ts` é o orquestrador determinístico dos 7 passos que até o #4941 só existiam como prosa executada manualmente por um LLM (`.claude/skills/diaria-clarice-novos/SKILL.md`) — delta Stripe → MV → grupo `novos` → campanha Brevo → disparo imediato, **sem gate humano** (decisão D6 do #4347), com os 9 guards determinísticos documentados na SKILL.md como única trava.

## Kill switch — `data/clarice-novos-enabled.json` (#4941 E3)

**Default `enabled: false`** quando o arquivo não existe — armar esta task NUNCA liga o disparo automático sozinha. O que está do outro lado do toggle é envio de e-mail real e irreversível sem revisão humana; o lado seguro do fail-soft é o oposto do padrão usado no toggle de chat do Studio (`studio-chat-enabled.ts`, #4078), que é `true` por default.

```bash
npx tsx scripts/lib/clarice-novos-enabled.ts --set enabled   # libera o disparo automático diário
npx tsx scripts/lib/clarice-novos-enabled.ts --set disabled  # pausa (kill switch — substitui "não rodar a skill de novo")
npx tsx scripts/lib/clarice-novos-enabled.ts                 # imprime "enabled"/"disabled"
```

**Depois de armar a task, ela roda todo dia às 09:00 mas sai imediatamente com "pausado" até você liberar o toggle explicitamente.** Confira a 1ª rodada pausada (relatório em `/relatorios` do Studio) antes de liberar.

## Guard de pré-condição — `data/clarice-subscribers/clarice-users.db`

Igual ao `Diaria-Brevo-Diaria-Evaluate` (#4552): se o store SQLite da Clarice não existir (sinal de que o junction `data/` do OneDrive ainda não montou nesta máquina), a task aborta ANTES de tocar Stripe/MV/Brevo — nunca roda sobre um `data/` vazio. Este guard é INDEPENDENTE do kill switch acima; os dois convivem (um cobre "`data/` ainda não sincronizou", o outro cobre "o editor pausou de propósito").

## Log

`data/clarice-subscribers/.novos-run.log` (append-only, gerado pelo runner declarativo — `scripts/lib/task-runner.ts`).

## Relatório por rodada

Toda invocação (sucesso, rodada vazia, pausada pelo toggle, ou abortada por qualquer guard) grava um relatório em `data/clarice-subscribers/novos-reports/{id}.md` e registra na superfície `/relatorios` do Studio (`data/reports/index.jsonl`, `kind: "clarice-novos"`, #3714) — com notificação por e-mail já no default (#4475). Uma rodada agendada que aborta em silêncio ficaria indistinguível de uma que não rodou; por isso o registro acontece em TODOS os caminhos, não só no sucesso (diferente do desenho original da skill, que só descrevia o Passo 7 no caminho feliz).

## Setup (ação local one-time do editor)

`local` — precisa do junction `data/` (OneDrive) + `STRIPE_API_KEY` + `BREVO_CLARICE_API_KEY` + `MILLION_VERIFIER_API_KEY`. O antigo `.ps1` do Windows (`scripts\setup-clarice-novos-schedule.ps1`) foi removido no #5115 (cutover final) — via de arme é só systemd.

**Linux (systemd, via o registro declarativo `scripts/lib/scheduled-tasks.ts`, épica #4798):**

```bash
npx tsx scripts/setup-systemd-timers.ts --task Diaria-Clarice-Novos   # gera os units em .systemd-units/
npx tsx scripts/arm-systemd-timers.ts --task Diaria-Clarice-Novos     # arma de verdade (systemctl)
```

## Armar em UMA máquina só (#4941 E4)

`data/` é junction do OneDrive sincronizada entre máquinas. `clarice-novos-resolve-key.ts` sufixa `-2`/`-3`… quando enxerga a key do dia já usada em `group-campaigns.json` — mas isso depende do OneDrive ter sincronizado esse arquivo a tempo. Duas máquinas armadas na mesma janela de latência poderiam resolver a MESMA key e criar 2 campanhas (envio duplicado real, não cosmético como o `history-predator-safeBackup-*.jsonl` do monitor GEO). Sem lock novo pra isso — se for armar numa 2ª máquina, desarme a 1ª antes (`systemctl --user disable --now diaria-clarice-novos.timer`).

**Task NÃO armada nesta unidade quando implementada em worktree isolado** — mesma disciplina do #4320/#4382/#4490/#4534/#4723 (credencial/estado de máquina fica fora do worktree do subagente). Se implementada numa sessão local com acesso real à máquina, o arme + a 1ª rodada (pausada pelo toggle) podem acontecer na mesma sessão — ver o PR/commit pra confirmar se isso ocorreu.

**Armada e confirmada ativa (#4941, 10/ago)** — `systemctl --user is-active diaria-clarice-novos.timer` retorna `active` na máquina `predator`, `Trigger: Tue 2026-08-11 20:00:00 UTC` (= 11/ago 17:00 BRT, o próximo disparo real). Kill switch confirmado no estado default seguro (`npx tsx scripts/lib/clarice-novos-enabled.ts` → `disabled`) — a 1ª rodada de amanhã sai limpo, sem tocar Stripe/MV/Brevo, até o editor liberar explicitamente. Arme feito fora de worktree isolado (sessão local direta no clone principal), então os passos acima já foram executados nesta máquina — não repetir.

> **Re-arme feito em 260812 (#5140).** O parágrafo acima é registro HISTÓRICO: o `Trigger` de 20:00 UTC descrito ali é o das 17:00 BRT antigas. Mudar `hour` no registry **não** mexe no timer já instalado — o unit precisa ser regenerado e recarregado. Estado atual em `predator`: `active`, próximo disparo `14:00 UTC` (11:00 BRT).
>
> ```bash
> npx tsx scripts/setup-systemd-timers.ts --task Diaria-Clarice-Novos
> cp .systemd-units/diaria-clarice-novos.timer ~/.config/systemd/user/   # SÓ o .timer — ver abaixo
> systemctl --user daemon-reload && systemctl --user restart diaria-clarice-novos.timer
> systemctl --user list-timers diaria-clarice-novos.timer
> ```
>
> **Copiar só o `.timer`, nunca o `.service` junto.** O `ExecStart` gerado embute o caminho do Node que rodou o comando; em `predator` o service instalado usa `~/.local/node/bin/node` e uma sessão com `nvm` ativo gera `~/.nvm/versions/node/vX/bin/node`. A mudança de horário vive inteira no `.timer` — trocar o `.service` junto substitui o binário por outro sem necessidade.
>
> **⚠️ `Persistent=true` dispara catch-up no re-arme.** Aconteceu em 260812: o re-arme às 16:00 BRT disparou a rodada `novos-260812` na hora (67 contatos, `sent` confirmado — rodada legítima do dia, só adiantada, sem duplicação).
>
> A regra é sobre o **carimbo**, não sobre o relógio. Existe `~/.local/share/systemd/timers/stamp-diaria-clarice-novos.timer`, cujo mtime é o último disparo real (confirmado: bate com `LastTriggerUSec`). Ao iniciar o timer, o systemd dispara imediatamente se alguma ocorrência do `OnCalendar` cai em `(carimbo, agora]`.
>
> Duas armadilhas que decorrem disso:
>
> - **`stop` não consome o carimbo.** Parar o timer e só dar `start` no dia seguinte **não evita nada** — a ocorrência perdida continua devida e dispara na hora do `start`.
> - **Rearmar "depois do horário novo" é o caso ruim**, não a fuga dele. Foi exatamente a sequência do incidente: horário novo 11:00, re-arme às 16:00.
>
> Saídas que de fato funcionam:
>
> 1. Rearmar **antes** de a próxima ocorrência do horário novo acontecer — a janela entre o último disparo e o horário novo.
> 2. Usar o kill switch desta task: `npx tsx scripts/lib/clarice-novos-enabled.ts --set disabled`, rearmar, deixar o catch-up sair no vazio, religar com `--set enabled`. É a opção mais segura aqui, porque o switch existe justamente para isso.
> 3. `touch` no arquivo de carimbo antes do `start` — declara "já disparou agora", e não sobra ocorrência devida.

## 2ª captura diária — `Diaria-Clarice-Novos-Tarde` (#5185, 260814)

Mesmo script (`clarice-novos-run.ts`), mesmo guard de pré-condição, mesmo kill switch (lido dentro do script — não precisa de um 2º toggle) — só muda o `name`/`schedule`/`logPath` da entrada no registro (`Diaria-Clarice-Novos-Tarde`, diária às **18:00 BRT** — mudou de 15:00 em 260816, #5447 —, log em `data/clarice-subscribers/.novos-tarde-run.log`). Tudo o que este documento descreve acima (kill switch, guard de pré-condição, relatório por rodada, armadilha do `Persistent=true`) se aplica igualmente, trocando `Diaria-Clarice-Novos` por `Diaria-Clarice-Novos-Tarde` nos comandos.

**Por quê:** a issue #5185 avaliou integrar `clarice-envio-run.ts` chamando `runNovos()` internamente (cadastros indo direto pro pool `ramp-warm`) — descartado no briefing ao vivo de 260814. Decisão do editor: manter os fluxos separados e só rodar a captura mais vezes. Detalhes/motivação completa: ver comentário da entrada `Diaria-Clarice-Novos-Tarde` em `scripts/lib/scheduled-tasks.ts` e o parágrafo correspondente no `CLAUDE.md`.

**Idempotência entre as duas rodadas do dia:** verificada, não nova — `clarice-build-segment.ts --group novos` já dedupa via `sent-or-queued.json` (cycle-wide, gravado no MOMENTO da seleção, antes do envio real assentar) e via `guardScope: "committed"` (exclui quem já está em lista Brevo `queued`∪`sent`). A rodada das 18:00 não reseleciona quem a das 09:00 já pegou.

**Risco residual do #5185 — FECHADO pelo #5410 (16/08/2026):** a folga até `Diaria-Clarice-Envio` (19:00) já não depende mais de a campanha do `novos` ter assentado em `sent` — desde o #5410, `isNovos` e `isRampWarm` PARTICIONAM a fila de 1º envio (`segmentRampWarm` corta por `readNovosCutoff()`) em vez de um ser subconjunto do outro. É exatamente esse fechamento estrutural que libera mover a rodada da tarde de 15:00 para 18:00 sem reabrir o risco de duplicata — ver `scripts/lib/scheduled-tasks.ts` para o detalhe técnico completo. O teste `#5140` (`test/scheduled-tasks.test.ts`) mantém o piso de 4h como regressão barata mesmo com o caminho estrutural fechado.

**Task NÃO armada nesta unidade** (worktree isolado do subagente implementador) — mesma disciplina de sempre. **Estado atual: ARMADA na `predator`, confirmado ao vivo em 17/08/2026** (`systemctl --user is-enabled` = `enabled`); a fonte canônica de estado de arme é `docs/scheduled-tasks-registry.md`, não esta seção, que descreve o procedimento. Arme (Linux/systemd, checkout compartilhado, DEPOIS do merge):

```bash
npx tsx scripts/setup-systemd-timers.ts --task Diaria-Clarice-Novos-Tarde
systemctl --user daemon-reload && systemctl --user enable --now diaria-clarice-novos-tarde.timer
```

## Re-arme feito em 260816 (#5447)

**Histórico, aposentado pelo #5660:** o alarm `Diaria-Clarice-Novos-Abort-Alarm` foi removido do registro porque o guard D4 deixou de existir neste caminho. O coordenador top-level roda, no checkout principal DEPOIS do merge, apenas pra `Diaria-Clarice-Novos` (09:00) e `Diaria-Clarice-Novos-Tarde` (18:00):

```bash
npx tsx scripts/setup-systemd-timers.ts --task Diaria-Clarice-Novos
npx tsx scripts/setup-systemd-timers.ts --task Diaria-Clarice-Novos-Tarde
cp .systemd-units/diaria-clarice-novos.timer .systemd-units/diaria-clarice-novos-tarde.timer ~/.config/systemd/user/   # SÓ os .timer
systemctl --user daemon-reload
systemctl --user restart diaria-clarice-novos.timer diaria-clarice-novos-tarde.timer
systemctl --user list-timers diaria-clarice-novos.timer diaria-clarice-novos-tarde.timer
```

**Achado desta unidade, não corrigido aqui (fora do escopo exato da #5447):** `Diaria-Clarice-Novos` (09:00) agora colide, no minuto exato, com `Diaria-Clarice-Opens-Catchup-Alarm` (também 09:00, `#4740`/`#4722` item 4). São dois timers systemd independentes, sem recurso compartilhado óbvio (um lê um relatório de catch-up de opens; o outro toca Stripe/MV/Brevo), então não é um conflito funcional — mas quebra a convenção do resto do registro de manter dailies em minutos distintos, e nenhum teste do arquivo pega colisões globais (só pares específicos comentados task a task). Documentado aqui e no self-review do PR para o coordenador decidir se vale desencostar um dos dois horários numa unidade futura.
