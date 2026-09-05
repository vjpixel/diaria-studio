---
name: diaria-clarice-envio
description: Caminho MANUAL/ad-hoc do envio Clarice News — desde #5026 os scripts existem pra rodar automaticamente todo dia às 19:00 BRT via a task `Diaria-Clarice-Envio` (arme da task, #5027 — até lá, este é o único caminho); esta skill invoca o MESMO orquestrador (`scripts/clarice-envio-run.ts`), nunca reimplementa. Uso — `/diaria-clarice-envio` (sem args — ciclo e data são resolvidos deterministicamente, nunca digitados). Desde #5985, o caminho manual roda `--plan-only` primeiro e apresenta a proposta de volume ao editor antes de escrever.
---

# /diaria-clarice-envio

Decide **pra quem** a edição mensal já pronta vai, e agenda. Complementa
`/diaria-mensal` (que produz a edição e para no rascunho da campanha) —
esta skill distribui a mesma edição em ondas sucessivas pela base.

**Desde #5026 o orquestrador existe pra rodar todo dia às 19:00 BRT** via a
task `Diaria-Clarice-Envio` (planeja + agenda a onda do dia seguinte,
06:00 BRT) com o par `Diaria-Clarice-Envio-Guard` (05:00 BRT, reavalia o
freio na véspera imediata do disparo) — **o ARME dessas duas tasks é o
#5027, que pode não ter mergeado ainda** (checar `scripts/lib/scheduled-tasks.ts`
por uma entrada `Diaria-Clarice-Envio` antes de assumir que a automação já
está em produção). Até lá, `npx tsx scripts/clarice-envio-run.ts` (abaixo) é
o único caminho — o mesmo comando que a task vai rodar quando armada. **Esta
skill é o caminho manual/ad-hoc**: rodar fora do horário, investigar um
abort, ou destravar um cenário que a automação recusa por decisão de design
(ver tabela abaixo).

**Os dois caminhos rodam o MESMO código — `scripts/clarice-envio-run.ts`.**
Antes do #5026, os 8 passos abaixo eram prosa que o LLM executava manualmente
(extrair valor do JSON de um passo, decidir ramo condicional, injetar no
próximo comando) — incompatível com uma task agendada sem editor presente
(regra #573). `clarice-envio-run.ts` é esse *glue* em código, testado
(`test/clarice-envio-run.test.ts`). **Esta skill nunca reimplementa o
fluxo — apenas invoca**, mas o caminho MANUAL invoca em **duas etapas**
(#5985) em vez de uma — a task agendada continua rodando SEM nenhuma flag,
sem essa parada:

```bash
# 1. Proposta — para ANTES do MV sob demanda (crédito real), nunca escreve nada.
npx tsx scripts/clarice-envio-run.ts --plan-only
```

Isso imprime um JSON (`volume`, `baseVolume`, `step`, `note`, `brake`,
`overrideApplied`, `queueAvailable`, `brevoCredits`, `mvOnDemand`, `cycle`,
`sendDate`, `abcAction`, `subjects`) — a proposta de volume da política, ANTES
de qualquer chamada que gaste crédito. **Apresentar isso ao editor via
`AskUserQuestion`**: confirmar o número proposto (`volume`), informar outro
número, ou abortar. Falha do `AskUserQuestion` cai na regra do #3938 (halt
banner, nunca prosseguir sem resposta).

```bash
# 2a. Editor confirmou o número proposto, OU não respondeu (skill roda sem editor
#     nesta invocação isolada) — segue com o mesmo volume que a política propôs:
npx tsx scripts/clarice-envio-run.ts --volume {plan.volume}

# 2b. Editor pediu outro número — segue com N, sem afrouxar nenhum guard:
npx tsx scripts/clarice-envio-run.ts --volume {N}
```

`--volume N` roda o MESMO fluxo completo de sempre (MV sob demanda incluso,
se a fila não cobrir), só substituindo o volume que a política escolheria
sozinha por `N`. Os guards de fila/crédito/freio continuam valendo: se `N`
pedir mais do que algum teto permite, a rodada **aborta** (exit 1) explicando
qual teto foi violado — nunca corta em silêncio pra caber num número que o
editor não confirmou. `N` abaixo do proposto segue normal. O relatório grava
a origem da decisão (`default_policy` sem `--volume`, `editor_confirmed`
quando `N` bate com o que a política propôs, `editor_override` quando
diverge) junto do volume que a política teria escolhido sozinha.

**O gate é da SKILL, não do script.** `clarice-envio-run.ts` nunca chama
`AskUserQuestion` — ele só para (`--plan-only`) ou aceita um número já
decidido (`--volume N`). Quem decide ligar as duas etapas com uma pergunta ao
editor no meio é esta skill; a task agendada nunca vê essas flags e continua
rodando de ponta a ponta sem parar, exatamente como antes do #5985.

**Blast radius alto.** Uma invocação errada manda dezenas de milhares de
e-mails e queima a reputação do domínio `clarice.ai`, que é do PARCEIRO. Por
isso a automação é toda guiada por guards DETERMINÍSTICOS (tabela abaixo),
não por um gate de confirmação humana — a decisão do editor (260811) foi
substituir "nada escreve sem o editor aprovar" por "nada escreve se algum
guard não passar", com reversibilidade real como rede de segurança: campanha
agendada na Brevo NÃO é imutável (#4935, 260810) — dá pra cancelar via API
(`PUT /emailCampaigns/{id}/status`, `status: "suspended"`) até o disparo, e
é exatamente isso que `Diaria-Clarice-Envio-Guard` faz quando o risco piora
entre 19:00 e 06:00.

## O que mudou em relação ao fluxo descrito no resto deste documento

O restante deste arquivo (Passos 0-8) documenta o fluxo ORIGINAL, manual,
`--cycle`/`--dates` explícitos — continua válido como REFERÊNCIA de
mecanismo (o que cada sub-script faz, os formatos de arquivo, as armadilhas
já batidas), mas **não é mais o que se digita**. `clarice-envio-run.ts`
resolve tudo isso sozinho:

| Antes (prosa/manual) | Agora (`clarice-envio-run.ts`) |
|---|---|
| `--cycle` digitado | `computeExpectedEnvioCycle(hoje)` (calendário) comparado contra `resolveLatestMonthlyCycleFromDisk()` (conteúdo pronto) — só prossegue se baterem; senão PARA (nunca cai pro ciclo antigo em silêncio, decisão do editor 260811). |
| `--dates` digitado, horizonte de N dias | Sempre **1 data** = hoje+1 BRT — uma rodada planeja um dia, com dado fresco a cada execução. |
| Volume: semáforo do dashboard (inclui abertura) | Motor novo (#5025, `scripts/lib/clarice-envio-policy.ts`) — abertura NUNCA freia. **#6793 "Faixa B" item 2 (01/09/2026, decisão do editor): o freio automático de risco de ISP (`decideBrake`) foi REMOVIDO** — `level` é sempre `"ok"`, `stop`/`hold` nunca mais são produzidos sozinhos; `reasons`/`maxUtil` continuam calculados e reportados (observabilidade preservada). `adaptiveStep` (escalada adaptativa pela folga) é função SEPARADA, intocada — seu próprio guard contra escalar sobre dado ausente/risco alto continua ativo. |
| Teste A/B/C: skill propõe, editor confirma (#4657) | Decide sozinha pra `continuar`/`travar` (cálculo já determinístico); `iniciar` (exige 3 assuntos novos) PARA e pede o editor — não foi revogado, só automatizado onde já era mecânico. |
| `--subject`/assunto digitado | Herdado da onda anterior do mesmo ciclo (`resolveInheritedSubjects`) — nunca digitado. |
| `--send-test` + agente `review-test-email` | Removido do caminho (decisão do editor 260811) — o HTML é o mesmo da edição inteira do ciclo, já revisado na Etapa 4 do `/diaria-mensal`; era o último LLM no caminho de um envio irreversível. |
| `close-poll.ts` rodado aqui | Fora do caminho — o guard `checkEiaGuard` (dentro de `clarice-schedule-group.ts --schedule`) só CONFERE que o marker existe; populá-lo é responsabilidade do `/diaria-mensal`, 1× por ciclo. |
| Passo 7 — gate humano `sim/ajustar/abortar` | Substituído pelos guards determinísticos abaixo — nenhum é aviso, todos abortam (exit ≠ 0) fora dos caminhos de parada limpa (exit 0). **#5985 reintroduz um gate, mas só de VOLUME e só no caminho MANUAL** — `--plan-only` + `AskUserQuestion` + `--volume N`, ver "Uso" acima; a task agendada nunca vê essas flags. |
| Sem trava de concorrência | `scripts/lib/clarice-envio-lock.ts` — task e skill manual não podem montar a mesma onda ao mesmo tempo. |
| Nenhum guard pra "onda esperada não disparou" | `detectMissedWaveToday` (#4975) — se a onda de hoje deveria ter saído e não saiu, a rodada reporta e não escala volume até resolver. |

**Guards determinísticos e seus exit codes — nunca "sim/ajustar/abortar", sempre uma
decisão automática (a maioria PARA limpo com `exit 0`; só uma minoria é erro duro `exit 1`):**

| Guard | Condição | Exit |
|---|---|---|
| Kill switch | `data/clarice-envio-enabled.json` = `{enabled:false}` → pausa intencional. | `0` |
| exec-mode | `!= "local"` → precisa do junction `data/`. | `1` |
| `BREVO_CLARICE_API_KEY` | ausente. | `1` |
| Ciclo | calendário ≠ conteúdo pronto mais recente → "sem-ciclo-elegivel". | `0` |
| `.step-4-done.json` | ausente pro ciclo resolvido. | `1` |
| Lock | rodada concorrente em curso (`LockHeldError`). | `1` |
| `committedLookupFailed` | consulta de campanhas comprometidas na Brevo falhou. | `1` |
| `novosFreshness` | `never-run`/`blocker` (>48h) aborta; `warning` (12-48h) segue, registrado. | `1`/— |
| `brevoCredits === null` | crédito não consultado. | `1` |
| `abc.action === "iniciar"` | exige 3 assuntos do editor. | `0` |
| Assunto não herdável | `travar` sem onda-base NEM onda da célula vencedora (`abc.winner`); `continuar` faltando o precedente de alguma célula. | `1` |
| Fila insuficiente pós-MV | mesmo após MV sob demanda, fila não cobre o volume desejado — nunca troca de público, nunca envia menos sem avisar antes. | `0` |
| Agendamento incerto | POST aceito, GET-verify não confirma em ≥1 célula. | `2` |
| Onda parcialmente montada | falha no meio do loop de células (`continuar`) — as já confirmadas SÃO campanhas reais e disparam; relatório torna isso explícito. | `1` |
| Agendamento incerto | POST aceito, GET-verify não confirma → `exit 2` (não é erro nem sucesso; reconciliável na próxima rodada). |

**Zero volume final** (base ≤ 0, ou freio `stop` — **#6793 item 2, 01/09/2026:
`decideBrake` nunca mais produz `stop` sozinho**, então este caso hoje só
acontece via `handlePrereqFailure`/item 3 da mesma issue, INTOCADO, ou base
≤ 0) → sai limpo, grava relatório, **exit 0** (não é erro).

**Override persistente do freio (#5515) — dormente desde #6793 item 2.**
Existia pra quando o editor confirmava que um `stop` calculado era
falso-positivo (ex: pico de campanha antiga sem decaimento, #5487) e a
correção precisava sobreviver a mais de um ciclo. Como `decideBrake` nunca
mais produz `stop` automaticamente, não há mais o que rebaixar nesse
caminho — a ferramenta continua existindo (não removida, é do editor) mas
fica sem efeito prático até/se o freio voltar. Uso histórico, gravar um
override em `data/clarice-envio-override.json` via:

```bash
npx tsx scripts/lib/clarice-envio-override.ts --set \
  --until 2026-08-18T09:00:00.000Z \
  --reason "pico de campanha de 27/06 (#5487) confirmado falso-positivo" \
  --issue 5487
```

`--until` é obrigatório e deve ser um teto CURTO (sugestão ~48h — não é
travado em código, o operador escolhe). O override só REBAIXA `stop`→`hold`
— nunca destrava `ok` (blast radius limitado por desenho, ver docstring do
módulo). Enquanto ativo, `clarice-envio-risk.ts`/`clarice-envio-guard.ts`
(as DUAS metades do par) mostram no relatório "OVERRIDE do editor: freio
calculado seria STOP, rebaixado para HOLD..." — nunca some silenciosamente
sobre o STOP real. Expirado (`--until` no passado) é ignorado sem alarme —
o freio volta a decidir sozinho. Revogar antes do prazo:

```bash
npx tsx scripts/lib/clarice-envio-override.ts --clear
```

Ver status atual (sem `--set`/`--clear`): `npx tsx scripts/lib/clarice-envio-override.ts`.

---

## Passo 0 — Preflight

```bash
npx tsx scripts/lib/exec-mode.ts   # precisa imprimir "local"
```

Esta skill é `local`: depende do junction `data/` (store SQLite no OneDrive)
e de `BREVO_CLARICE_API_KEY`. Em `cloud`, abortar com a explicação — não há
store pra segmentar.

Confirmar também que a edição do ciclo existe e passou pela revisão:

```bash
test -f "data/monthly/$CYCLE/_internal/.step-4-done.json" || echo "⚠️ Etapa 4 (revisão) do /diaria-mensal não concluída"
```

Sem a Etapa 4, o conteúdo não passou pelo gate humano de revisão — **não
distribuir**. Parar e avisar o editor.

---

## Passo 1 — Levantar o estado dos últimos envios

Rodar o planejador em modo leitura. Ele faz TODO o levantamento determinístico
(dashboard ao vivo + store local) e não escreve nada:

```bash
npx tsx scripts/clarice-plan-wave.ts --cycle $CYCLE --dates $DATES --json
```

Saída (`WaveProposal`) traz, entre outras coisas:
- `state.waves[]` — cada onda já disparada/agendada do ciclo, com lista,
  volume, status e data.
- `state.volumeComplete` — `false` significa que o total já enviado é um
  **piso**, não um número exato. Nunca apresentar como exato nesse caso.
- `state.scheduledCount` — campanhas ainda agendadas. Editáveis via API
  (`PUT /emailCampaigns/{id}`, inclusive `scheduledAt`) ou canceláveis
  (`PUT .../status` com `cancel`/`suspended`) — não são estado terminal,
  ver #4935 — mas seus destinatários já estão congelados no agendamento.
- `staleNote` — preenchido quando o dashboard serviu **cache**. A idade real
  vem junto (`~3.2h stale`). Reportar sempre ao editor — nunca decidir volume
  sobre cache sem dizer que é cache.

**Rate limit.** `GET /api/campaigns` bate o limite da Brevo com facilidade
(observado `retryAfterSecs: 1916` — ~32min — em 05/08). Se o script abortar
com 429, **não** contornar com dado local: esperar e repetir. Planejar a onda
sobre estado desatualizado é como se manda duas vezes pra mesma pessoa.

---

## Passo 2 — Avaliar o teste A/B/C de assunto

Já vem calculado em `abc` na saída do Passo 1. A skill **propõe, o editor
confirma** (decisão do editor, #4657) — nunca decidir sozinha.

| `abc.action` | significa |
|---|---|
| `iniciar` | Não há teste em curso. Onda sai com 3 células. |
| `continuar` | Teste em curso sem conclusão confiável. Mantém 3 células. |
| `travar` | Vencedor claro e sem ressalva. Ondas seguintes com assunto único. |

**Antes de tudo isso, checar o estado durável (#5055):** se
`data/clarice-abc-state.json` disser `encerrado`, não há teste pra avaliar —
`abc.action` já vem `travar`, o assunto travado vem do arquivo, e o Passo 2
vira só um relato ("teste encerrado em {data} pelo editor: {assunto}").
**Recálculo nunca reabre um teste encerrado**; só
`clarice-abc-state.ts --reopen --confirm`, ato explícito do editor. Se o
editor pedir pra reabrir no gate, é esse comando — não basta responder
`ajustar`.

**Sempre declarar a métrica** (`abc.metric`) ao apresentar. O clique é a
métrica que decide o teste por design (#2976), mas é também a contaminada
pela #4559 — o editor precisa saber qual sustentou a recomendação.

**Significativo recomenda `travar`; a ressalva vira aviso** (decisão do
editor, 05/08) — a skill dá a leitura, o editor pesa a ressalva no gate.
Rebaixar pra `continuar` sempre que houvesse ressalva fazia o teste nunca
terminar. As ressalvas que aparecem nos avisos:

- `attributionUnknown` — clique parcialmente não-verificado (#4567).
- `minDetectableLiftRelative` acima de 30% — poder baixo, risco de winner's
  curse (#4559).
- `suspectedDriftDays` — dia excluído por drift de naming (#4449).

Se `abc.metric` for clique e a líder por **abertura** for outra célula, o
`rationale` diz isso. As duas métricas já discordaram (memória
`teste-abc-subject-2606-07`) — apresentar, não esconder.

**Antes de recomendar `continuar`, checar se a conclusão é alcançável.**
Aprendizado do 2607-08 (05/08): o teste estava em p=0,34 por clique, e
concluir exigiria ~217.000 envios adicionais contra uma fila de ~26.000 —
8× toda a base disponível. Continuar teria gastado 2/3 da fila remanescente
perseguindo o inalcançável.

O diagnóstico veio de olhar a métrica certa: **abertura** estava em
23,73%/23,98%/24,04% com ~9,4k por célula — espalhamento de 0,32pp (p≈0,61)
com poder pra detectar 7,3% de lift relativo. Isso não é "ainda não sei", é
"os assuntos são equivalentes", com amostra pra afirmar. Assunto move
abertura; clique é dirigido pelo conteúdo, idêntico nas 3 células — a
diferença de 10 cliques media a coisa errada.

Regra prática: se a abertura está empatada COM poder suficiente, o teste
respondeu. Encerrar não é desistir.

---

## Passo 3 — Confirmar o horizonte do agendamento

Se `--dates` não veio, perguntar **antes** de qualquer outra coisa:

```
Pra quantos dias é o agendamento, e em que datas?
(sugestão: {próximos N dias úteis} — mas confirme, a data nunca é inferida)
```

Cada data vira `06:00 BRT` (09:00 UTC — o Brasil não tem horário de verão
desde 2019). Datas precisam ser crescentes e sem repetição; o script rejeita
o contrário, e rejeita também data inexistente no calendário (`2026-02-31`
viraria 03/03 em silêncio no `Date` do JS).

---

## Passo 4 — Puxar os cadastros novos

**Antes** de fechar a proposta, rodar a skill de novos (decisão do editor,
#4657 — invoca como passo do plano, não absorve).

**Desde #4664, isto não é só prosa** — a saída do Passo 1 (`clarice-plan-wave.ts`)
traz `novosFreshness`, medindo há quanto tempo `/diaria-clarice-novos` rodou de
fato (`lastRunAt` do `novos-state.json`): acima de 12h vira **aviso**, acima de
48h vira **bloqueio** (o gate não pode oferecer "sim" com ele de pé), e "nunca
rodou" também bloqueia. O guard só DETECTA e REPORTA — nunca invoca a skill
sozinho (`clarice-plan-wave.ts` é read-only por construção). Caso real que
motivou isto: onda `d6-qui06` (05/08) saiu 99,3% leads frios de 2024 porque
este passo foi pulado.

```
/diaria-clarice-novos
```

Ela faz cadastro Stripe novo → MillionVerifier → campanha própria. Rodá-la
aqui garante que quem acabou de assinar já esteja verificado e visível no
store quando os volumes forem calculados — senão entra só na onda seguinte.

⚠️ **Reingerir o store depois** (causa raiz do #4362): sem isso os
recém-verificados ficam invisíveis na mesma rodada. A skill de novos já faz
isso internamente desde o #4362; confirmar na saída dela antes de seguir.

Depois de rodar, **repetir o Passo 1** — a fila mudou.

---

## Passo 5 — Verificação MV sob demanda (#4659)

Só relevante quando o Passo 1 revelar um **déficit** de fila de 1º envio
(o mesmo bloqueio "Fila de 1º envio... é menor que o volume proposto"). Nesse
caso a saída de `clarice-plan-wave.ts` já traz `mvOnDemandPlan` calculado:
quantos contatos verificar, de quais cohorts — na MESMA ordem de prioridade
da fila de envio (`cohortSendRank`, morno→frio — #4542 já corrigiu uma
inversão dessa ordem, não reintroduzir) — e o custo estimado.
`renderWaveProposal` imprime isso numa seção própria ("Verificação MV sob
demanda"), já dentro do texto do Passo 1.

Substitui a abordagem em lote da #4427 (fechada como "aberta cedo demais",
propunha varrer os ~253k contatos `mv_unverified` de uma vez, ~US$482
pré-comprados). Aqui o gasto é proporcional ao déficit REAL desta onda —
decisão do editor (05-06/08/2026, #4659).

Se `mvOnDemandPlan.byCohort` vier **vazio**, não há nada a fazer aqui — ou
não há déficit, ou o backlog disponível não cobre (a proposta já diz qual
dos dois). Pule pro Passo 6.

Se `mvOnDemandPlan.byCohort` tiver entradas, rode os 3 comandos NESTA ordem:

```bash
# 1. Verifica só o recorte que a proposta revelou — GASTA crédito
#    MillionVerifier de verdade (ao contrário de clarice-plan-wave.ts, que é
#    read-only por construção).
npx tsx scripts/clarice-mv-ondemand.ts --cycle $CYCLE --dates $DATES

# 2. Reingere o store (#4362) — sem isso os recém-verificados ficam
#    invisíveis na mesma rodada (mesmo passo que a #4362 já exige depois do
#    MV do Passo 4/novos).
npx tsx scripts/clarice-build-db.ts

# 3. Recompõe a proposta — availableFirstSend deve subir (ou o déficit
#    encolher, se o backlog disponível não cobriu tudo).
npx tsx scripts/clarice-plan-wave.ts --cycle $CYCLE --dates $DATES --json
```

**Sem gate de confirmação de gasto separado aqui** (decisão do editor,
05-06/08/2026, #4659) — o volume desta verificação já é limitado pelo
déficit da onda ATUAL (ordem de grandeza ~1k contatos/dia ≈ US$2/dia), nunca
um lote arbitrário sobre o backlog inteiro. O gate de confirmação da onda
continua sendo o Passo 7 — o custo desta verificação aparece ali dentro do
resumo (quantos foram verificados, quanto custou, taxa de aprovação obtida),
não como uma pergunta separada.

Guards preservados (nunca pulados por este passo):
- **"Skip forever"** (#2886) — um contato já verificado em QUALQUER ciclo
  anterior nunca é re-verificado.
- **`assinantes-ativos` NUNCA entra no recorte** — MV-isento (#3826/#1297);
  `planMvOnDemand` filtra por construção, e `verify-emails-mv.ts` também
  abortaria se recebesse esse cohort (defesa em profundidade dupla).
- **Falha transitória vai pro `-error.csv`**, nunca no checkpoint (#4353) —
  retentada automaticamente na próxima invocação.

Se depois do passo 3 acima a fila continuar menor que o volume proposto
(`mvOnDemandPlan.backlogInsufficient` — o backlog disponível não cobriu o
alvo mesmo verificando tudo), volte ao Passo 6 com o déficit remanescente e
decida com o editor: reduzir o volume da onda, ou aceitar a fila do jeito que
está. Este passo NUNCA reduz o volume proposto sozinho.

⚠️ **Não exercitado ao vivo nesta unidade** (#4659, worktree isolado sem
`MILLION_VERIFIER_API_KEY`/`data/` reais — mesma disciplina do #4320/#4382/
#4490/#4534/#4572) — testado com mocks; a 1ª execução numa onda real com
déficit de verdade fica pra sessão supervisionada, com o editor presente.

---

## Passo 6 — Proposta de volume

Também já vem calculada (`volumes`) no Passo 1. O volume **não** é decidido
por esta skill: vem de `computeWeekPlan`, a mesma máquina que alimenta a aba
"Rampa" do dashboard. Herda de graça o gate de spam do Postmaster (breaker
0,30%) — 🟢 escalona +10% ao dia, 🟡 mantém, 🔴 poda 30% e sinaliza.

Horizonte maior que 3 dias repete o 3º volume em vez de continuar escalando:
os dias 4+ não maturaram quando a proposta é montada, e escalar sem métrica
nova é inventar confiança que o dado não sustenta.

### O que olhar com atenção

**Fila de 1º envio secando.** No ciclo 2607-08 as ondas caíram de ~3.300/dia
(d3) pra ~350/dia (d5) em dois dias. Quando `availableFirstSend` fica perto
do volume proposto, a proposta emite o aviso apontando o **backlog do
MillionVerifier** como alavanca — não "troque pra reenvio". Trocar o público
é mudar a natureza da onda (aquisição → retenção) disfarçado de continuidade,
e é decisão do editor, não default da skill.

**Não-abridores acumulados.** `nonOpeners` conta quem já recebeu 2+ envios
sem nunca abrir e **continua elegível** — o sunset da #4430 nunca foi
implementado (`computeEligibility` em `clarice-db.ts` não tem esse corte).
Esse estoque alimenta a reclamação de spam, que depois faz o semáforo frear
o volume. O laço se fecha contra o próprio alcance; a skill torna isso
visível sem poder cortá-lo.

---

## Passo 7 — Gate de confirmação

Apresentar a saída de `renderWaveProposal` (o script sem `--json` já imprime).
Ela mostra **todo** valor que vira escrita na Brevo — datas, volume por dia,
nome de cada lista a criar, crédito consumido. Um valor que não aparece ali é
um valor que o editor não confirmou.

**Bloqueio ≠ aviso.** Com qualquer `blockers` de pé (exit code 2), **não
oferecer "sim"**. Os bloqueios são:

- Semáforo vermelho (circuit breaker estourado).
- Crédito Brevo não cobre a onda.
- Crédito Brevo **não consultado** — nunca agendar sem validar antes.
- Fila de 1º envio menor que o volume proposto — se o Passo 5
  (`mvOnDemandPlan`) revelou um recorte cobrível, rode-o e volte aqui antes
  de tentar de novo; se revelou vazio ou `backlogInsufficient`, a alavanca de
  fila não está disponível e o editor decide (reduzir volume ou aceitar).
- `/diaria-clarice-novos` do ciclo nunca rodou, ou rodou há mais de 48h
  (#4664) — sem isso, cadastro novo (`cohortSendRank: 0`) perde prioridade
  em silêncio pra leads frios.

Avisos (fila apertando, não-abridores, dado stale, campanha agendada,
ressalvas do A/B/C, `/diaria-clarice-novos` rodou entre 12h e 48h atrás)
o editor **pesa**, não impedem.

```
Confirmar e agendar? sim / ajustar / abortar
```

- `ajustar` → editor muda datas/volume/decisão A/B/C; voltar ao Passo 1.
- `abortar` → encerrar sem escrever nada.

Se o `AskUserQuestion` falhar sem exibir a pergunta, tratar como #3938:
halt banner com motivo e ação, aguardar resposta explícita. **Nunca**
prosseguir sem confirmação — este é o gate que separa uma proposta de
dezenas de milhares de e-mails.

---

## Passo 8 — Executar

Só depois do `sim`. Nada aqui é novo: são os scripts já existentes, agora com
os parâmetros que o editor confirmou. **Passo corrigido em 05/08/2026 (#4663)
por execução ao vivo** — a versão anterior tinha 2 comandos que não rodavam
(`--key` sozinho onde `--group` é obrigatório; `--schedule-at` só-data). O
fluxo abaixo é o que de fato funcionou (onda `d6-qui06`, ciclo 2607-08).

**Atenção ao `--group`:** ele nomeia o MANIFEST a ler
(`{grupo}-manifest.json`), não uma lista individual. Numa onda com teste
A/B/C o `--group` é a chave do **dia** (`d6-qui06`), e o manifest dela
contém as 3 entradas de célula (`d6-qui06-A/B/C`) — `--key {dia}-A` desambigua
QUAL das 3. **`--key` sozinho não seleciona nada** — `clarice-schedule-group.ts`
exige `--group NOME` (ou `--list-id N`) sempre; `--key` é só o desambiguador
quando `--group` resolve mais de uma lista.

**Atenção ao `--schedule-at`:** exige HORA explícita (#4662 — `YYYY-MM-DD`
sozinho é RECUSADO com erro claro desde 05/08/2026, nunca mais silenciosamente
vira meia-noite UTC = 21:00 BRT do dia anterior, o incidente da campanha #119).
Use sempre `{YYYY-MM-DD}T09:00:00Z` (09:00 UTC = 06:00 BRT, o horário
canônico) a menos que o horário pretendido seja outro de propósito.

**Antes de escolher entre os dois fluxos abaixo, checar o teste de HORÁRIO
(#5140) — é independente do teste de assunto e pode estar rodando mesmo
quando o A/B/C já está `travado`:**

```bash
npx tsx scripts/lib/clarice-hour-test.ts   # imprime "ativo"/"inativo"/"encerrado"
```

Achado ao vivo 260820: segui direto pro fluxo "sem teste A/B/C" (assunto
travado) sem checar isto, e a onda saiu inteira numa campanha única às 06:00
— zerando a amostra do dia pro braço das 10:00 de um teste que estava `ativo`
desde 16/08. Quando o teste de horário está `ativo` **e** o A/B/C está
`travar`, `clarice-envio-run.ts` (o caminho automático) já resolve isso
sozinho (`--hour-cells` em `clarice-split-group-cells.ts`, mesma lista/
assunto, metade agendada em cada hora) — mas o fluxo MANUAL abaixo não
verifica isso por conta própria. Se o teste de horário estiver `ativo`, usar
`--hour-cells {h1},{h2}` no passo 2 de `clarice-split-group-cells.ts` no
lugar de `--no-cells`, mesmo com o A/B/C de assunto travado. Ver #5824.

Com teste A/B/C (recomendação `iniciar`/`continuar` do Passo 2), para cada
onda `d{N}` da proposta:

```bash
# 1. Segmentar (dry-run primeiro, sempre)
npx tsx scripts/clarice-build-segment.ts --group ramp-warm --cycle $CYCLE --budget {volume}

# 2. Dividir em células A/B/C e gerar o manifest do dia.
#    Escreve {dia}-A/B/C.csv + {dia}-manifest.json com as chaves GERADAS.
npx tsx scripts/clarice-split-group-cells.ts --cycle $CYCLE --wave {N} --date {YYYY-MM-DD} \
  --from segments/ramp-warm.csv

# 3. Importar — --group é a chave do DIA. `--execute` AGUARDA o processo
#    assíncrono e RECONCILIA a contagem (#4577/#4602: a Brevo dropa linha em
#    silêncio; um contato foi perdido assim em 04/08). Processo failed/timeout
#    ou contagem menor abortam a invocação inteira. A contagem importada pode
#    sair MAIOR que a segmentada (ver nota EDITOR_SEED_EMAILS abaixo).
npx tsx scripts/clarice-import-waves.ts --cycle $CYCLE --group {dia} --label "{label}" --execute

# 4. Criar a campanha como RASCUNHO — uma por célula (--group + --key, hora EXPLÍCITA)
npx tsx scripts/clarice-schedule-group.ts --cycle $CYCLE --group {dia} --key {dia}-A \
  --subject "{assunto A}" --schedule-at {YYYY-MM-DD}T09:00:00Z --create

# 5. E-mail de teste + verificação
npx tsx scripts/clarice-schedule-group.ts --cycle $CYCLE --group {dia} --key {dia}-A --send-test
# (dispatchar o agente review-test-email, platform: brevo)

# 6. Gabarito É IA? — OBRIGATÓRIO antes de agendar. Confira
#    _internal/.close-poll-clarice.json do ciclo ANTES de chegar aqui — o
#    guard só roda neste passo 6 (--schedule), não no --create acima.
npx tsx scripts/close-poll.ts --brand clarice --cycle $CYCLE --edition {AAMMDD}

# 7. Agendar (--group + --key, SEM --schedule-at — a data já foi fixada no --create)
npx tsx scripts/clarice-schedule-group.ts --cycle $CYCLE --group {dia} --key {dia}-A --schedule
```

Repita os passos 4-7 pra cada célula (`--key {dia}-A`, `-B`, `-C`).

Sem teste A/B/C (recomendação `travar` do Passo 2) — 1 lista só, assunto
único, validado ao vivo em 05/08/2026:

```bash
# 1. Segmentar
npx tsx scripts/clarice-build-segment.ts --group ramp-warm --cycle $CYCLE --budget {volume}

# 2. Gerar a chave do dia SEM célula (1 lista, assunto travado)
npx tsx scripts/clarice-split-group-cells.ts --cycle $CYCLE --wave {N} --date {YYYY-MM-DD} \
  --from segments/ramp-warm.csv --no-cells

# 3. Importar — --group é a chave do DIA (1 lista só, --key não é necessário)
npx tsx scripts/clarice-import-waves.ts --cycle $CYCLE --group {dia} --label "{label}" --execute

# 4. Criar rascunho — --group basta (1 lista só), hora EXPLÍCITA
npx tsx scripts/clarice-schedule-group.ts --cycle $CYCLE --group {dia} \
  --subject "{assunto travado}" --schedule-at {YYYY-MM-DD}T09:00:00Z --create

# 5. E-mail de teste + verificação
npx tsx scripts/clarice-schedule-group.ts --cycle $CYCLE --group {dia} --send-test

# 6. Gabarito É IA?
npx tsx scripts/close-poll.ts --brand clarice --cycle $CYCLE --edition {AAMMDD}

# 7. Agendar
npx tsx scripts/clarice-schedule-group.ts --cycle $CYCLE --group {dia} --schedule
```

**O nome da lista nunca é digitado — nem a chave.** A chave sai de
`waveKey()` (passo 2) e o nome da lista de `groupCellListNameFor()`, que
`clarice-import-waves.ts` aplica quando a chave termina em `-A`/`-B`/`-C`.
Antes do passo 2 existir, esse manifest de 3 entradas era escrito à mão — era
esse o "digitado à mão" da #4449, e ele sobreviveu ao #4471 (que ligou o
gerador de NOME) porque quem se digitava era a CHAVE. Teste de paridade
gerador↔parser em `test/clarice-wave-plan.test.ts`.

**A contagem importada pode ser maior que a segmentada.** No ciclo 2607-08:
737 selecionados no Passo 1 → 742 na lista Brevo após o Passo 3. A diferença
são os `EDITOR_SEED_EMAILS` (`scripts/lib/editor-copy.ts`) — endereços do
editor sempre adicionados pelo import, pra o editor também receber a
campanha. Não é bug; não investigar como se fosse.

**Reagendar uma campanha JÁ `scheduled`/`sent`? `--schedule` PULA
silenciosamente** (idempotência: `↷ {key} já scheduled — pulando`) —
mudar o horário exige `--reschedule` (#4668), nunca PUT manual na API (o PUT
manual não grava `group-campaigns.json`, deixando o `scheduledAt` local
mentiroso — aconteceu 2× em 05/08/2026, ver #4668):

```bash
npx tsx scripts/clarice-schedule-group.ts --cycle $CYCLE --group {dia} --key {dia}-A \
  --schedule-at {YYYY-MM-DD}T{NOVA-HORA}Z --reschedule
```

`--reschedule` recusa campanha nunca agendada (`draft` — use `--schedule`) ou
já disparada (`sent`, ou `in_review`/terminal AO VIVO na Brevo mesmo que o
registro local ainda diga `scheduled`), exige o mesmo gabarito É IA? do
`--schedule`, e só grava o novo `scheduledAt` local DEPOIS de um GET-verify
que confere o horário por INSTANTE (`Date.parse`) — a Brevo devolve
`scheduledAt` com OFFSET (ex: `...-03:00`), não com `Z`, e comparação por
string dá falso negativo num reagendamento que na verdade funcionou.
⚠️ **Não confirmado ao vivo:** se a Brevo RE-CONGELA o snapshot de
destinatários no reagendamento (a memória `brevo-recipients-snapshot` só
cobre o AGENDAMENTO inicial) — documentar quando alguém rodar `--reschedule`
de verdade pela 1ª vez.

### Guards que não se pulam

- **Gabarito É IA?** antes de qualquer `--schedule`/`--reschedule`.
  `--skip-eia-guard` existe mas não é pra uso normal.
- **Exclusão de comprometidos** (`queued`/`sent`) por fetch ao vivo — imune
  ao lag do store (#3682, que reenviou 100% pra quem já tinha recebido).
- **GET-verify pós-schedule/reschedule** — confirma que a Brevo aceitou o
  agendamento/reagendamento (por INSTANTE, nunca por igualdade de string).
- **Nunca dois agendamentos em paralelo** pro mesmo ciclo.

---

## Grupo `engajados` — fila única por score, sem orquestrador separado (#7406)

Esta seção documentava um orquestrador **separado** pro grupo `engajados`
(`scripts/clarice-envio-engajados-run.ts`, task agendada `Diaria-Clarice-Envio-Engajados`
às 20:15 BRT, #6945/#7235) — **aposentado por completo em #7406 (05/09/2026)**.
Decisão do editor: "não faz mais sentido ter grupos diferentes ramp-warm e
engajados, porque a gente pode trabalhar tudo só a partir do score" — a
criação da 2ª task em si (#6945) foi um engano (#7406), não uma decisão a
reavaliar; não sobrevive como caminho manual.

`Diaria-Clarice-Envio` (19:10, documentado acima) já cobre score>0
("engajados") e score=0 ("ramp-warm") **na mesma fila única**, via
`clarice-build-segment.ts --daily` (`buildDailySendQueue`,
`scripts/lib/clarice-segment.ts` — `priority_points DESC`, engajados
esgotam antes de ramp-warm começar, guard de duplicidade por CONTATO em vez
de por grupo escolhido, #7408/#7413). Não há mais `--group`/audiência a
escolher no caminho de produção — quem quiser reproduzir uma composição
manual da fila usa `clarice-build-segment.ts --daily --cycle {ciclo} --budget N --send-date {AAAA-MM-DD} --dry-run`.

---

## Verificação final

```bash
npx tsx scripts/clarice-plan-wave.ts --cycle $CYCLE --dates $DATES --json
```

As ondas recém-agendadas devem aparecer em `state.waves` com
`status: "queued"` e o `scheduledAt` correto. Se não aparecerem, **não
re-executar o Passo 8** — investigar primeiro (pode ter agendado e falhado o
registro, e re-executar duplicaria o envio).

## Não faz

- Não produz a edição — isso é `/diaria-mensal`.
- Não substitui `/diaria-clarice-novos` — invoca.
- Não decide sozinha nada que mude quem recebe e-mail.
