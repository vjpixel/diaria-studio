---
name: diaria-clarice-novos
description: Fecha o laço cadastro novo no Stripe → verificação MillionVerifier → campanha disparada na hora com a edição mensal mais recente da Clarice. Task diária automática, 2x/dia (09:00 + 18:00 BRT, #5447 — antes 11:00+15:00, #5140/#5185 — antes 17:00, #4941) via `Diaria-Clarice-Novos`/`Diaria-Clarice-Novos-Tarde`; esta skill é o caminho MANUAL/ad-hoc — os dois delegam pro mesmo orquestrador determinístico, SEM gate humano (os guards determinísticos são a única trava — issue #4347).
---

# /diaria-clarice-novos [--since YYYY-MM-DD] [--dry-run] [--force] [--subject "…"] [--confirm]

Fecha o laço operacional que a issue #4347 identificou: cadastro novo no Stripe não virava envio sozinho. Desde o #4941, o fluxo (delta Stripe → MV → grupo `novos` → campanha → disparo imediato) roda **automaticamente 2x por dia, às 09:00 e 18:00 BRT** (#5447) via as tasks agendadas `Diaria-Clarice-Novos`/`Diaria-Clarice-Novos-Tarde` — esta skill é o caminho **manual/ad-hoc** (rodar fora do horário, com `--dry-run` numa máquina nova, ou com `--force`/`--confirm`/`--subject` depois de um abort que precisa de decisão explícita do editor).

**Os dois caminhos rodam o MESMO código — `scripts/clarice-novos-run.ts`.** Até o #4941, os 7 passos abaixo eram prosa que o LLM executava manualmente (extraindo valor do JSON de um passo e injetando no próximo). Isso não dava pra automatizar numa task sem editor presente — julgamento não-determinístico no caminho de um envio de e-mail real e irreversível contraria a regra do #573. `clarice-novos-run.ts` é esse *glue* em código: os 9 guards abaixo, a resolução de `{CICLO_ENVIO}`/`{KEY}`/`{CICLO_MENSAL}`, e a decisão sucesso/vazio/incerto/abort são TODOS determinísticos e testados (`test/clarice-novos-run.test.ts`). Esta skill nunca reimplementa o fluxo — apenas invoca:

```bash
npx tsx scripts/clarice-novos-run.ts [--since YYYY-MM-DD] [--dry-run] [--force] [--subject "…"] [--confirm]
```

**Regime de execução — sem gate humano (D6).** Decisão travada do editor (#4347): os 8 guards determinísticos abaixo são a **ÚNICA trava.** Cada um deles **ABORTA**, nunca só avisa, fora de `--dry-run`. O guard D4 de semáforo foi removido explicitamente do caminho `clarice-novos` no #5660; a decisão consciente é deixar este fluxo enviar mesmo quando o dashboard de entregabilidade estiver vermelho. `--dry-run` roda os Passos 0-3 (delta Stripe em preview, MV pulado — custo real nunca gasto sem intenção — e o grupo `novos` construído com `--dry-run`) e para, sem criar lista/campanha nem enviar nada. É o modo recomendado pra 1ª invocação numa máquina nova.

| Guard | Onde | Condição de abort |
|---|---|---|
| Teto de tamanho (D13) | `clarice-build-segment.ts --group novos` | grupo selecionado > 500 contatos → aborta. `--force` (repassado por `clarice-novos-run.ts`) destrava. |

| Queued/sent | `clarice-build-segment.ts` (todos os grupos) | falha ao consultar campanhas comprometidas na Brevo → aborta fora de `--dry-run`. |
| HTML | `clarice-novos-resolve-cycle.ts` | nenhum ciclo com preview pronto → aborta. |
| É IA? | `clarice-novos-resolve-cycle.ts` / `checkEiaGuard` no `--send-now` | gabarito não gravado pro ciclo resolvido → aborta. |
| Atividade divergente (#4621) | `clarice-novos-resolve-cycle.ts` | fallback (D3) diverge por MAIS de 1 ciclo mensal do ciclo mais recente com atividade real em `data/clarice-subscribers/` → aborta. `--subject "Assunto explícito"` destrava conscientemente. |
| Crédito Brevo | `clarice-import-waves.ts --execute` | import incompleto/reconciliação falha → aborta antes do `--create` (já embutido no próprio `--execute`, #4577). |
| Custo MV (D8) | `verify-emails-mv.ts --since` | recorte > 500 e-mails a verificar sem `--confirm` (repassado por `clarice-novos-run.ts`) → aborta sem gastar crédito. |
| `--hold juridico` ausente no resumo (#4542) | `clarice-novos-run.ts` (sanity check próprio) | bug de código do orquestrador (a flag não chegou ao sub-script) → aborta por segurança, nunca arrisca vazar o cohort jurídico reservado. |

Falha de MCP/ferramenta em qualquer passo → o sub-script falha com exit ≠ 0, `clarice-novos-run.ts` aborta e grava o motivo no relatório (nunca stall silencioso, regra global do projeto #738).

**Status pós-envio conhecidos (`--send-now`) — não são guards de abort, são exit codes do GET-verify (#4364, exit code do orquestrador revisado no #5743).** Além dos guards acima (que sempre abortam), o disparo em si tem 3 desfechos possíveis, propagados por `clarice-novos-run.ts` como o próprio exit code do orquestrador: `0` = confirmado (`sent`), `--finalize` gravado; `1` = erro duro (POST `sendNow` recusado, sub-script falhou); `3` = incerto (`isTerminalSendStatus` não bateu — inclui o `in_review` da Brevo, revisão automática de compliance/anti-abuso da plataforma, ou GET-verify sem confirmar status terminal dentro da janela de retry). No `3`, `--finalize` NUNCA é chamado (não declara como enviado algo não confirmado) — a rodada de amanhã reconcilia sozinha (idempotente por key/campanha, `--send-now` de novo é seguro). **#5743:** o exit code do orquestrador pra este caso é `3`, não `2` — o sub-script (`clarice-schedule-group.ts --send-now`) internamente ainda usa exit 2 pra sinalizar "incerto" (contrato inalterado), mas `clarice-novos-run.ts` remapeia sua PRÓPRIA saída pra `3` porque as tasks systemd (`Diaria-Clarice-Novos`/`-Tarde`) declaram `SuccessExitStatus=3` — sem isso, um disparo bem-sucedido com GET-verify apenas lento marcava a unit como `failed` e disparava alarme automático sobre um não-evento.

**Semáforo D4 e o alarme #5405 foram aposentados no caminho `novos` (#5660).** `clarice-novos-run.ts` não chama mais `clarice-check-semaphore.ts`, não produz `exit 3` e as units systemd não declaram mais `SuccessExitStatus=3`. O mecanismo de semáforo continua vivo para os demais fluxos (rampa/dashboard). O alarme dedicado `Diaria-Clarice-Novos-Abort-Alarm` foi removido do registro e seu script permanece como no-op explicitamente dormente, para não interpretar um `semaphore-red` histórico como uma nova ocorrência.

**Zero elegíveis** em qualquer ponto (delta vazio, grupo `novos` vazio) → sai limpo, grava relatório "0 contatos", **exit 0** (não é erro).

---

## Kill switch — `data/clarice-novos-enabled.json` (#4941 E3)

A task diária `Diaria-Clarice-Novos` checa este toggle ANTES de qualquer chamada Stripe/MV/Brevo — **default `enabled: false`** quando o arquivo não existe (lado seguro: o que está do outro lado é envio de e-mail real e irreversível sem gate humano). Armar a task **nunca** liga a automação sozinha.

```bash
npx tsx scripts/lib/clarice-novos-enabled.ts                # imprime "enabled" ou "disabled"
npx tsx scripts/lib/clarice-novos-enabled.ts --set enabled   # libera o disparo automático diário
npx tsx scripts/lib/clarice-novos-enabled.ts --set disabled  # pausa (substitui "não rodar a skill de novo")
```

**Isto substitui, pra a rotina automática, o kill switch antigo que dependia de invocação manual** — pausar continua sendo trivial (uma linha de comando, sem terminal na máquina exigido — futuramente um botão no Studio), mas agora precisa ser explícito, porque a task roda sozinha 2x por dia (09:00 e 18:00, #5447). Se `Diaria-Clarice-Guardrail-Alarm` disparar depois de uma rodada `novos`, a remediação é `--set disabled` até investigar.

---

## Passos (o que `clarice-novos-run.ts` faz — referência, não script pra copiar à mão)

Passo 0 — Preflight: exec-mode local, 3 env vars (`STRIPE_API_KEY`/`BREVO_CLARICE_API_KEY`/`MILLION_VERIFIER_API_KEY`), reingestão se `isDerivedStale()`.

Passo 1 — `clarice-stripe-delta.ts --execute [--since]` → `since` efetivo lido do resumo JSON → `clarice-build-db.ts`.

Resolução de `{CICLO_ENVIO}`: `mostRecentActiveClariceCycle` (mesmo sinal do guard #4621) — ciclo mais recente com atividade real em `data/clarice-subscribers/`. Determinístico; se nenhum ciclo tiver atividade (base sem histórico), aborta em vez de chutar.

Passo 2 — `verify-emails-mv.ts --since {SINCE} --cycle {CICLO_ENVIO} [--confirm]` → `clarice-build-db.ts` de novo (reingestão, #4362). Pulado inteiro em `--dry-run` (custo real).

Passo 3 — `clarice-build-segment.ts --group novos --since {SINCE} --cycle {CICLO_ENVIO} --hold juridico [--dry-run] [--force]`. `--hold juridico` é sempre passado — `clarice-novos-run.ts` confere que o resumo confirma `hold: "juridico"` antes de prosseguir (#4542). O antigo guard D4 não participa mais deste caminho (#5660).

Passo 4 — `clarice-novos-resolve-key.ts --cycle {CICLO_ENVIO} --date {AAMMDD}` → `{KEY}` → `clarice-resolve-folder.ts --name "Clarice novos"` → `clarice-import-waves.ts --cycle {CICLO_ENVIO} --group novos --key {KEY} --label "Novos {DD/MM}" --folder-id {N} --execute` (a espera do processo assíncrono + reconciliação de contagem já é interna ao `--execute`, #4577 — o orquestrador não faz polling extra).

Passo 5 — `clarice-novos-resolve-cycle.ts [--subject]` → `{CICLO_MENSAL}`/`{ASSUNTO}` → `clarice-schedule-group.ts --cycle {CICLO_ENVIO} [--content-cycle {CICLO_MENSAL}] --group novos --key {KEY} --subject "{ASSUNTO}" --create`. `--content-cycle` só quando os dois ciclos divergem.

Passo 6 — `clarice-novos-html-state.ts --cycle {CICLO_MENSAL}` (nunca `--content-cycle` aqui, #4365) → `--send-test` condicional (D12) → `--send-now` → checa exit code (0/1/3, ver acima) → `--finalize --list-id --campaign-id --sent-count` (os IDs vêm do resumo JSON do próprio `--send-now`).

Passo 7 — Relatório sempre gravado (`data/clarice-subscribers/novos-reports/{id}.md`) e registrado via `registerReport({kind: "clarice-novos", ...})` (superfície `/relatorios` do Studio, #3714 — notificação por e-mail já é o default) — **inclusive nos caminhos de abort/pausado/vazio**, não só no sucesso. Uma rodada agendada que aborta em silêncio seria indistinguível de uma que não rodou.

---

## Notas operacionais

- **Cadência**: automática, 2x/dia, 09:00 + 18:00 BRT (`Diaria-Clarice-Novos`/`Diaria-Clarice-Novos-Tarde`, #5447 — antes 11:00+15:00 do #5140/#5185, antes 17:00 do #4941) — supera a antiga "~4×/semana manual" do #4347. Invocação manual continua disponível pra qualquer horário fora do padrão.
- **1 máquina só armada** (decisão do editor, #4941 E4) — `data/` é junction do OneDrive; duas máquinas armadas na mesma janela de sync poderiam resolver a mesma `--key` e criar 2 campanhas. Sem lock novo pra isso — se for armar numa 2ª máquina, desarmar a 1ª antes.
- **Idempotência de campanha**: `--key novos-{AAMMDD}` com sufixo `-2`/`-3`… se a rotina rodar mais de uma vez no mesmo dia (`clarice-novos-resolve-key.ts`). `--create` é idempotente por key (pula se já criada).
- **Sync do Brevo é 1×/dia (08:30)** — quem fecha o furo de `sends_count` defasado é o guard queued/sent (`fetchSentCampaignListIds`), não a cadência. Nunca pular esse guard mesmo que pareça redundante numa rodada específica.
