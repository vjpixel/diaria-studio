# Par de tasks diárias: envio automático da rampa Clarice

Issue: [#5027](https://github.com/vjpixel/diaria-studio/issues/5027) (arme das tasks agendadas — depende de [#5026](https://github.com/vjpixel/diaria-studio/issues/5026), orquestrador, e [#5025](https://github.com/vjpixel/diaria-studio/issues/5025), motor de decisão).

## O que o par faz

Um script de setup, **DUAS tasks indivisíveis** (decisão do editor 260811 — armar uma sem a outra é uma configuração que ninguém quer):

- **`Diaria-Clarice-Envio`** — diária **19:00 BRT**. Unit `diaria-clarice-envio` (systemd) → `npx tsx scripts/clarice-envio-run.ts`. Levanta o risco de ISP fresco (freio = últimos 3 dias de envio; acelerador = 30 dias corridos — nunca abertura, ver #5025), planeja o volume da onda de amanhã e AGENDA a campanha pras 06:00 BRT (09:00 UTC) do dia seguinte.
- **`Diaria-Clarice-Envio-Guard`** — diária **05:00 BRT**. Unit `diaria-clarice-envio-guard` (systemd) → `npx tsx scripts/clarice-envio-guard.ts`. Relê o risco com ~11h de dado fresco (bounce/unsub/spam da onda que saiu ontem de manhã) e **cancela** (`status: suspended`) a onda pendente de hoje se o freio virou STOP entre 19:00 e 05:00. Escopo desta 1ª versão: cancela, não recria uma onda menor — ver docstring de `clarice-envio-guard.ts`. **#5220:** os pré-requisitos (`clarice-plan-wave`/`clarice-envio-risk`) retentam falha TRANSITÓRIA (503/rate-limit, orçamento menor que o par das 19:00 — pior caso ~20min) antes de cair num FALLBACK que lê o ÚLTIMO freio conhecido (gravado por `clarice-envio-run.ts`) em vez de simplesmente abortar sem reavaliar nada — ver "Retry e fallback do guard" abaixo.
- **`Diaria-Clarice-Envio-Guard-Alarm`** — diária **06:15 BRT** (#5220). Unit `diaria-clarice-envio-guard-alarm` → `npx tsx scripts/clarice-envio-guard-alarm.ts`. Alarme PRÓPRIO do guard — lê só a família `envio-{aammdd}-guard-*` (nunca compete com o relatório do run das 19:00 por "mais recente"), e alarma sempre que o guard não conseguiu reavaliar o freio com dado fresco (retry esgotado + fallback, cancelamento incompleto, erro duro) ou nem rodou. Detalhes: `docs/clarice-envio-guard-alarm-setup.md`.

`clarice-envio-run.ts`/`clarice-envio-guard.ts` são o *glue* determinístico que substitui os 8 passos em prosa de `.claude/skills/diaria-clarice-envio/SKILL.md` (mesmo padrão do #4941/`clarice-novos-run.ts`) — a skill manual passa a só invocar o mesmo orquestrador, nunca reimplementar.

## Kill switch — `data/clarice-envio-enabled.json` (compartilhado pelas DUAS tasks)

**Default `enabled: true`** quando o arquivo não existe — **INVERSO** do `clarice-novos-enabled.ts`. Decisão explícita do editor ("ligada desde o início"): a rampa Clarice já roda hoje manualmente todo dia; a automação substitui um trabalho que já acontece, não estreia um canal novo. Arquivo **corrompido/ilegível** é tratado como `disabled` (é sinal de problema, não de intenção — ver docstring de `clarice-envio-enabled.ts` pro racional completo e o risco aceito desse default invertido).

```bash
npx tsx scripts/lib/clarice-envio-enabled.ts --set disabled  # pausa o par inteiro
npx tsx scripts/lib/clarice-envio-enabled.ts --set enabled   # religa
npx tsx scripts/lib/clarice-envio-enabled.ts                 # imprime "enabled"/"disabled"
```

## Estado do teste A/B/C de assunto — `data/clarice-abc-state.json` (#5055)

**Default `aberto`** quando o arquivo não existe: a recomendação A/B/C é recalculada a cada rodada a partir dos cliques do ciclo (`recommendAbcAction`), como sempre foi. Encerrar o teste **grava a decisão**, e a partir daí nenhum recálculo a desfaz.

```bash
npx tsx scripts/lib/clarice-abc-state.ts                                    # imprime o estado atual
npx tsx scripts/lib/clarice-abc-state.ts --close --subject "Assunto vencedor" \
  [--winner A|B|C] [--rationale "por que"]                                  # encerra e trava o assunto
npx tsx scripts/lib/clarice-abc-state.ts --reopen --confirm                 # reabre (exige as DUAS flags)
```

Por que existe: antes do #5055 não havia onde registrar "o teste acabou". O único gancho era o flag `--locked-subject` de `clarice-plan-wave.ts`, que vale por invocação e que o orquestrador da task **não repassava** — então a task de 19:00 recalculava tudo todo dia e, se o p-valor voltasse a passar de 0,05, **reabria o teste sozinha**. Foi o que aconteceu com a onda de 12/08/2026, planejada com 3 assuntos depois de o editor já ter encerrado o teste.

Dois efeitos ao encerrar, não um:

1. a onda sai como **célula única** (`--no-cells`), com o assunto travado;
2. o **passo adaptativo de volume volta a valer**. Com o teste aberto, a ressalva de poder baixo (#4559) entra em `caveats` e `clarice-envio-run.ts` zera o passo — um laço que se auto-alimenta (base pequena → poder baixo → passo zerado → base nunca cresce). Teste encerrado não tem poder pra ser baixo, então não há ressalva e nada zera o passo.

Leituras possíveis do arquivo:

| estado do arquivo | resultado | avisa |
|---|---|---|
| ausente | `aberto` (recalcula) | não |
| válido | o valor gravado | não |
| ilegível / `encerrado` sem `subject` | `aberto` (recalcula) | **sim** |

O fail-soft aponta pra `aberto` — o inverso do kill switch acima, e de propósito: aqui o lado seguro é voltar a recalcular (chato, mas conhecido), nunca confiar num assunto corrompido e mandá-lo pra milhares de pessoas. Por isso um `encerrado` sem `subject` não-vazio é rejeitado.

**Guard de divergência, nos dois sentidos.** Há duas leituras do arquivo por rodada — o planejador lê cedo e assa a decisão no JSON; o orquestrador lê de novo segundos depois. Se elas discordarem, a rodada **aborta** em vez de agendar:

- estado diz `encerrado` mas o planejador **não** aplicou a trava (devolveu `continuar` **ou** `iniciar`) → abortar, senão sairiam 3 assuntos depois de o teste ter sido encerrado. O caso `iniciar` importa mais do que parece: é o que o cálculo devolve quando o ciclo ainda não tem 2 células amostradas, ou seja, o estado normal no começo de todo ciclo — sem o guard nessa ordem, a divergência sairia como a pausa rotineira "precisa do editor", indistinguível de operação normal;
- o planejador travou o assunto mas o estado agora diz `aberto` (um `--reopen` concorrente caiu no meio da rodada) → abortar, senão o assunto recém-destravado seria reusado por inferência.

Divergência é bug (arquivo mudou no meio da rodada, ilegível de um lado só, script defasado), não estado normal — por isso é erro duro e não pausa limpa.

## Estado do teste de HORÁRIO — `data/clarice-hour-test.json` (#5140)

Dimensão **separada** do A/B/C de assunto acima. Testa a hora de disparo da onda: hoje 06:00 BRT, herdado e nunca testado. A análise da #5140 indica que esse horário é ruim para os dois objetivos de conversão do e-mail, porque a decisão não acontece na leitura (mediana do clique 7,6h, p75 37,9h) e, quando acontece, cai em horário comercial — 06:00 põe a janela de ação imediata em 06h–10h, o trecho mais morto da curva de compra.

**Default `inativo`** quando o arquivo não existe: a onda sai como sempre, num horário só. Fail-soft de estado corrompido também aponta para `inativo` — o custo de não testar hoje é um dia a menos de amostra; o de dividir errado é uma onda real mal formada.

```bash
npx tsx scripts/lib/clarice-hour-test.ts                          # imprime o estado
npx tsx scripts/lib/clarice-hour-test.ts --start --hours 6,10     # inicia (2 braços)
npx tsx scripts/lib/clarice-hour-test.ts --close --winner 10 \
  --rationale "clique +2pp, p<0,05"                               # encerra com veredito
npx tsx scripts/lib/clarice-hour-test.ts --close --winner none \
  --rationale "sem significância em 7 dias"                       # encerra sem veredito
```

**Pré-condição: o A/B/C de assunto tem que estar travado.** As duas dimensões dividem a MESMA onda. Com o teste de assunto aberto, `clarice-envio-run.ts` **pula** o de horário e avisa no relatório, em vez de produzir 3×N células pequenas demais com os dois efeitos confundidos.

**Por que sufixo próprio (`H06`/`H10`) e não `A`/`B`:**

1. `parseAbcAudienceCampaign` (dashboard) casa `([ABC])\b`. Reusar `A`/`B` faria o painel exibir o teste de horário rotulado como teste de **assunto** — passaria a afirmar algo falso sobre o que está sendo medido.
2. `clarice-abc-state.json` precisa continuar `encerrado`. Reabri-lo devolve a ressalva de poder baixo do #4559, que **zera o passo adaptativo de volume** — o laço "base pequena → poder baixo → passo zerado → base nunca cresce" descrito acima. Um teste de horário que congela o volume da rampa como efeito colateral mediria a coisa errada com a base errada.

**Faixa suportada: 00:00–20:00 BRT.** A partir de 21:00 BRT o horário cai no dia seguinte em UTC, e `brtHourToUtcHourSameDay` **lança** em vez de montar o ISO no dia errado — o modo de falha seria uma campanha agendada 24h antes do pretendido, visível só depois do disparo. A janela útil do teste é diurna de qualquer forma.

**Leitura do resultado:** cada braço é uma campanha Brevo distinta (`Clarice {ciclo} d{N}-{dia}-H06 — hora 06:00 BRT`), então as métricas saem por campanha na lista do painel. Uma seção dedicada de comparação no dashboard **ainda não existe** — é o passo seguinte da #5140.

## Retry e fallback do guard (#5220)

Antes do #5220, `clarice-envio-guard.ts` chamava `clarice-plan-wave` e `clarice-envio-risk` como pré-requisitos e QUALQUER falha (inclusive um 503/rate-limit transitório do dashboard, na janela 05:00–06:00) abortava a rodada ANTES de reavaliar o freio — a onda já agendada disparava às 06:00 sem checagem nenhuma, e o guard existia mas não fazia nada. Dois mecanismos fecham esse buraco:

1. **Retry com backoff**, mesmo padrão do `clarice-envio-run.ts` (#5058), com um orçamento MENOR — o guard roda dentro da janela 05:00→06:00 do MESMO dia, não tem as ~11h de folga do par das 19:00. `GUARD_TRANSIENT_RETRY_BUDGET` em `clarice-envio-guard.ts`: 3 tentativas, fallback de 30s (quando o `retryAfterSecs` não veio), teto de 10min por espera — pior caso ~20min de espera total, com folga franca na janela de 1h. `clarice-envio-risk.ts` ganhou o mesmo sinal tipado de falha transitória (`TransientDashboardError`, exit code 3 + JSON no stdout) que `clarice-plan-wave.ts` já tinha desde o #5058 — os dois batem no mesmo dashboard e podem sofrer o mesmo rate limit; a classe compartilhada mora em `scripts/lib/transient-dashboard-error.ts`.
2. **Fallback fail-closed com exceção** (decisão do editor, 13/08/2026), se o retry esgotar (ou a falha for estrutural): lê o ÚLTIMO freio conhecido, gravado por `clarice-envio-run.ts` (19:00 de ontem) num sidecar JSON — `data/clarice-subscribers/envio-reports/envio-{aammdd}-brake.json` (`scripts/lib/clarice-envio-last-brake.ts`) — NUNCA reconsultando a Brevo, que é justamente a fonte que já falhou.
   - freio da noite era `"ok"` → deixa a onda seguir pro disparo das 06:00 SEM alteração, mas **alarma** (`Diaria-Clarice-Envio-Guard-Alarm`, abaixo) — "deixar passar" é uma aposta, não uma confirmação com dado fresco.
   - freio da noite era `"hold"`, `"stop"`, ausente, ou ilegível → suspende a(s) onda(s) pendente(s) por precaução (mesmo mecanismo de cancelamento do caminho normal, `cancelPendingWaves`), derivando a lista de ondas pendentes DIRETO do registro local (`group-campaigns.json`, não de `proposal.state.waves` — que pode ser justamente o dado que faltou se foi `clarice-plan-wave.ts` que falhou).

`reportId` ganha sufixos próprios pra este caminho — `-guard-prereq-fallback-deixou-passar`, `-guard-prereq-fallback-cancelou`, `-guard-prereq-fallback-cancelamento-incompleto`, `-guard-prereq-falhou-sem-pendencia` — nenhum deles é tratado como "ok" por `Diaria-Clarice-Envio-Guard-Alarm`, mesmo quando o fallback "funcionou" (deixou passar OU suspendeu com sucesso): o guard não conseguiu fazer o trabalho FRESCO que existe pra fazer, e isso é sempre digno de atenção do editor.

## Guards de pré-condição (não são o kill switch — os dois convivem)

- `clarice-users.db` ausente (junction `data/` ainda não montou) → task `Diaria-Clarice-Envio` aborta ANTES de tocar Brevo.
- `Diaria-Clarice-Envio-Guard` **não** tem esse guard de propósito — se ele precisar do store, o próprio script decide como tratar a ausência (é a rede de segurança do par; um guard de pré-condição que aborta a rodada suprimiria justamente a checagem que pode segurar um disparo ruim).
- Ciclo divergente do calendário, `.step-4-done.json` ausente, lock detido, blockers estruturais (crédito não consultado, `/diaria-clarice-novos` nunca rodou, etc.) — todos guards INTERNOS de `clarice-envio-run.ts`, documentados na tabela do cabeçalho de `.claude/skills/diaria-clarice-envio/SKILL.md`.

## Trava de concorrência

`scripts/lib/clarice-envio-lock.ts` — lock por CICLO em `data/clarice-subscribers/{cycle}/.envio-run.lock`, compartilhado pelas duas tasks E pela invocação manual da skill (que delega pro mesmo script). Detecção de abandono: lock mais velho que 30min é tratado como órfão e substituído.

## Log

`data/clarice-subscribers/.envio-run.log` (task das 19:00) e `.envio-guard.log` (task das 05:00) — append-only, gerados pelo runner declarativo (`scripts/lib/task-runner.ts`).

## Relatório por rodada

Toda invocação (sucesso, pausada, ciclo não pronto, fila insuficiente, sem volume, abortada por qualquer guard) grava relatório em `data/clarice-subscribers/envio-reports/{id}.md` e registra na superfície `/relatorios` do Studio (`data/reports/index.jsonl`, `kind: "clarice-envio"`) — com notificação por e-mail completa já no default (`registerReport`, decisão do editor #4708). Uma rodada agendada que aborta em silêncio ficaria indistinguível de uma que não rodou; por isso o registro acontece em TODOS os caminhos, não só no sucesso.

## Setup (ação local one-time do editor)

`local` — precisa do junction `data/` (OneDrive) + `BREVO_CLARICE_API_KEY`. O antigo par de `.ps1` do Windows (`scripts\setup-clarice-envio-schedule.ps1`) foi removido no #5115 (cutover final) — via de arme é só systemd.

**Linux (systemd, via o registro declarativo `scripts/lib/scheduled-tasks.ts`, épica #4798) — gera e arma cada task do par:**

```bash
npx tsx scripts/setup-systemd-timers.ts --task Diaria-Clarice-Envio
npx tsx scripts/setup-systemd-timers.ts --task Diaria-Clarice-Envio-Guard
npx tsx scripts/setup-systemd-timers.ts --task Diaria-Clarice-Envio-Guard-Alarm
npx tsx scripts/arm-systemd-timers.ts --task Diaria-Clarice-Envio
npx tsx scripts/arm-systemd-timers.ts --task Diaria-Clarice-Envio-Guard
npx tsx scripts/arm-systemd-timers.ts --task Diaria-Clarice-Envio-Guard-Alarm
```

Confirmar: `systemctl --user list-timers | grep clarice-envio` deve listar as três, com o próximo disparo em `America/Sao_Paulo` (19:00, 05:00 e 06:15 BRT respectivamente — `setup-systemd-timers.ts` já embute o fuso no `OnCalendar`, confirmado ao vivo na geração desta issue). `Diaria-Clarice-Envio-Guard-Alarm` é INDEPENDENTE do par (não é indivisível com as outras duas, decisão do #5220) — pode ser armada/desarmada sozinha sem afetar o kill switch nem o funcionamento do par; ver `docs/clarice-envio-guard-alarm-setup.md` pro detalhe do próprio alarme.

## Armar em UMA máquina só

`data/` é junction do OneDrive sincronizada entre máquinas. Duas máquinas armadas resolvem o mesmo dia na mesma janela de latência de sync e podem agendar a MESMA onda duas vezes — envio duplicado real, num domínio que é do **parceiro** (`clarice.ai`). Sem lock cross-máquina pra isso (o lock de `clarice-envio-lock.ts` é por processo/arquivo local, não distribuído) — se for armar numa 2ª máquina, desarme a 1ª antes.

**Máquina escolhida pelo editor (260811): `predator`** — mesma máquina do sync das 08:30 (`Diaria-Clarice-Sync`) e do `Diaria-Clarice-Novos` das 09:00 (#5447, antes 11:00 do #5140, antes 17:00), o que elimina o atraso do OneDrive na leitura do store pra este par e mantém as três tasks Clarice na mesma máquina.

**Ordem relativa a `Diaria-Clarice-Novos` (09:00 + 18:00 desde o #5447, antes 11:00+15:00 do #5140/#5185):** de propósito, a 19:00 roda DEPOIS das DUAS rodadas do dia — os cadastros novos já entraram no store antes do planejamento da onda. Desde o #5410 (16/08/2026), `isNovos` e `isRampWarm` PARTICIONAM a fila de 1º envio (`segmentRampWarm` corta por `readNovosCutoff()`) em vez de um ser subconjunto do outro — a exclusão não depende mais da campanha do `novos` ter assentado em `sent` na Brevo antes das 19:00. `novosFreshness` (guard interno de `clarice-envio-run.ts`) confirma isso a cada rodada.
