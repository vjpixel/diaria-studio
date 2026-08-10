---
name: diaria-clarice-envio
description: Planeja e agenda a próxima onda de envio da edição mensal pra base Clarice News. Levanta o estado dos últimos envios, avalia o teste A/B/C de assunto, puxa os cadastros novos, propõe volume por dia e só agenda depois de confirmação explícita de TODOS os valores. Uso — `/diaria-clarice-envio --cycle YYMM-MM --dates YYYY-MM-DD[,...]`.
---

# /diaria-clarice-envio

Decide **pra quem** a edição mensal já pronta vai, e agenda. Complementa
`/diaria-mensal` (que produz a edição e para no rascunho da campanha) —
esta skill distribui a mesma edição em ondas sucessivas pela base.

**Blast radius alto.** Uma invocação errada manda dezenas de milhares de
e-mails e queima a reputação do domínio `clarice.ai`, que é do PARCEIRO. Por
isso: nada é escrito na Brevo antes do gate de confirmação. **Correção
(#4935, 260810): campanha agendada na Brevo NÃO é imutável** — dá pra
cancelar via API (`PUT /emailCampaigns/{id}/status`, `status: cancel` ou
`suspended`) ou pelo painel, e recriar com as características corretas. O
que passar pelo gate ainda tem custo real de reverter (janela até o disparo,
possível reputação de duplicar envio) — a confirmação continua obrigatória —
mas não é mais um estado terminal sem saída (incidente 260703).

## Argumentos

- `--cycle {conteúdo}-{envio}` — **obrigatório**. Ex: `--cycle 2607-08`
  (conteúdo de julho, enviado em agosto).
- `--dates YYYY-MM-DD[,...]` — **obrigatório**. Datas explícitas, uma por dia
  de envio. O número de datas define o horizonte da onda.

  **Nunca inferir** a partir de `today()`, de dia-da-semana, ou da última
  onda — "data é sempre explícita" é princípio invariável do CLAUDE.md.
  Se o editor não passar, perguntar (Passo 3 abaixo), sugerindo os próximos
  dias como atalho mas exigindo confirmação.
- `--locked-subject "…"` — opcional. Assunto único já travado num ciclo
  anterior; força a recomendação A/B/C pra "travar" sem recalcular.

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
- `state.scheduledCount` — campanhas ainda agendadas. Imutáveis; seus
  destinatários já estão congelados.
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
