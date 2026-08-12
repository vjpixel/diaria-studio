# Par de tasks diárias: envio automático da rampa Clarice

Issue: [#5027](https://github.com/vjpixel/diaria-studio/issues/5027) (arme das tasks agendadas — depende de [#5026](https://github.com/vjpixel/diaria-studio/issues/5026), orquestrador, e [#5025](https://github.com/vjpixel/diaria-studio/issues/5025), motor de decisão).

## O que o par faz

Um script de setup, **DUAS tasks indivisíveis** (decisão do editor 260811 — armar uma sem a outra é uma configuração que ninguém quer):

- **`Diaria-Clarice-Envio`** — diária **19:00 BRT**. `scripts/run-clarice-envio.ps1` (Windows) / unit `diaria-clarice-envio` (Linux) → `npx tsx scripts/clarice-envio-run.ts`. Levanta o risco de ISP fresco (freio = últimos 3 dias de envio; acelerador = 30 dias corridos — nunca abertura, ver #5025), planeja o volume da onda de amanhã e AGENDA a campanha pras 06:00 BRT (09:00 UTC) do dia seguinte.
- **`Diaria-Clarice-Envio-Guard`** — diária **05:00 BRT**. `scripts/run-clarice-envio-guard.ps1` (Windows) / unit `diaria-clarice-envio-guard` (Linux) → `npx tsx scripts/clarice-envio-guard.ts`. Relê o risco com ~11h de dado fresco (bounce/unsub/spam da onda que saiu ontem de manhã) e **cancela** (`status: suspended`) a onda pendente de hoje se o freio virou STOP entre 19:00 e 05:00. Escopo desta 1ª versão: cancela, não recria uma onda menor — ver docstring de `clarice-envio-guard.ts`.

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

`local` — precisa do junction `data/` (OneDrive) + `BREVO_CLARICE_API_KEY`.

**Windows (Task Scheduler) — registra o PAR:**

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\setup-clarice-envio-schedule.ps1
```

Idempotente — re-executar atualiza as duas tasks. Remover as duas: mesmo comando com `-Unregister`.

**Linux (systemd, via o registro declarativo `scripts/lib/scheduled-tasks.ts`, épica #4798) — gera e arma cada task do par:**

```bash
npx tsx scripts/setup-systemd-timers.ts --task Diaria-Clarice-Envio
npx tsx scripts/setup-systemd-timers.ts --task Diaria-Clarice-Envio-Guard
npx tsx scripts/arm-systemd-timers.ts --task Diaria-Clarice-Envio
npx tsx scripts/arm-systemd-timers.ts --task Diaria-Clarice-Envio-Guard
```

Confirmar: `systemctl --user list-timers | grep clarice-envio` deve listar as duas, com o próximo disparo em `America/Sao_Paulo` (19:00 e 05:00 BRT respectivamente — `setup-systemd-timers.ts` já embute o fuso no `OnCalendar`, confirmado ao vivo na geração desta issue).

## Armar em UMA máquina só

`data/` é junction do OneDrive sincronizada entre máquinas. Duas máquinas armadas resolvem o mesmo dia na mesma janela de latência de sync e podem agendar a MESMA onda duas vezes — envio duplicado real, num domínio que é do **parceiro** (`clarice.ai`). Sem lock cross-máquina pra isso (o lock de `clarice-envio-lock.ts` é por processo/arquivo local, não distribuído) — se for armar numa 2ª máquina, desarme a 1ª antes.

**Máquina escolhida pelo editor (260811): `predator`** — mesma máquina do sync das 08:30 (`Diaria-Clarice-Sync`) e do `Diaria-Clarice-Novos` das 11:00 (#5140, antes 17:00), o que elimina o atraso do OneDrive na leitura do store pra este par e mantém as três tasks Clarice na mesma máquina.

**Ordem relativa a `Diaria-Clarice-Novos` (11:00 desde o #5140, antes 17:00):** de propósito, a 19:00 roda DEPOIS — os cadastros novos do dia já entraram no store antes do planejamento da onda, e a campanha do `novos` já teve tempo de assentar em `sent` pro guard `queued ∪ sent` excluí-los desta onda (`isNovos` é subconjunto estrito de `isRampWarm`, então o mesmo contato está nos dois universos; o guard não cobre `in_process`, daí a folga importar). `novosFreshness` (guard interno de `clarice-envio-run.ts`) confirma isso a cada rodada.
