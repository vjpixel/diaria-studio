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
isso: nada é escrito na Brevo antes do gate de confirmação, e **campanha
agendada na Brevo é IMUTÁVEL** (incidente 260703) — o que passar pelo gate
não volta atrás por API.

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

**A regra é conservadora de propósito:** resultado significativo **com**
qualquer ressalva vira `continuar`, não `travar`. Travar é irreversível na
prática (todas as ondas seguintes herdam o assunto), e no ciclo 2607-08 o A
"venceu" por clique com p=0,0049 enquanto 81% dos cliques daquela célula não
eram atribuíveis a nenhum contato da lista. As ressalvas que rebaixam:

- `attributionUnknown` — clique parcialmente não-verificado (#4567).
- `minDetectableLiftRelative` acima de 30% — poder baixo, risco de winner's
  curse (#4559).
- `suspectedDriftDays` — dia excluído por drift de naming (#4449).

Se `abc.metric` for clique e a líder por **abertura** for outra célula, o
`rationale` diz isso. As duas métricas já discordaram (memória
`teste-abc-subject-2606-07`) — apresentar, não esconder.

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
#4657 — invoca como passo do plano, não absorve):

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

## Passo 5 — Proposta de volume

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

## Passo 6 — Gate de confirmação

Apresentar a saída de `renderWaveProposal` (o script sem `--json` já imprime).
Ela mostra **todo** valor que vira escrita na Brevo — datas, volume por dia,
nome de cada lista a criar, crédito consumido. Um valor que não aparece ali é
um valor que o editor não confirmou.

**Bloqueio ≠ aviso.** Com qualquer `blockers` de pé (exit code 2), **não
oferecer "sim"**. Os bloqueios são:

- Semáforo vermelho (circuit breaker estourado).
- Crédito Brevo não cobre a onda.
- Crédito Brevo **não consultado** — nunca agendar sem validar antes.
- Fila de 1º envio menor que o volume proposto.

Avisos (fila apertando, não-abridores, dado stale, campanha agendada,
ressalvas do A/B/C) o editor **pesa**, não impedem.

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

## Passo 7 — Executar

Só depois do `sim`. Nada aqui é novo: são os scripts já existentes, agora com
os parâmetros que o editor confirmou.

Para cada onda `d{N}` da proposta, e para cada chave de lista:

```bash
# 1. Segmentar (dry-run primeiro, sempre)
npx tsx scripts/clarice-build-segment.ts --group ramp-warm --cycle $CYCLE --budget {volume}

# 2. Importar as listas — --execute AGUARDA o processo assíncrono e RECONCILIA
#    a contagem (#4577/#4602: a Brevo dropa linha em silêncio; um contato foi
#    perdido assim em 04/08). Processo failed/timeout ou contagem menor abortam.
npx tsx scripts/clarice-import-waves.ts --cycle $CYCLE --group {key} --label "{label}" --execute

# 3. Criar a campanha como RASCUNHO
npx tsx scripts/clarice-schedule-group.ts --cycle $CYCLE --key {key} --subject "{assunto}" --create

# 4. Gabarito É IA? — OBRIGATÓRIO antes de agendar
npx tsx scripts/close-poll.ts --brand clarice --cycle $CYCLE --edition {AAMMDD}

# 5. Agendar
npx tsx scripts/clarice-schedule-group.ts --cycle $CYCLE --key {key} --schedule-at {YYYY-MM-DD}
```

**O nome da lista nunca é digitado.** `clarice-import-waves.ts` deriva de
`groupCellListNameFor` quando a chave termina em `-A`/`-B`/`-C` — e as chaves
vêm de `waveKey()`, geradas. Digitar o nome à mão é o que quebrou o painel 3×
(#3081 → #3128 → #4447); há teste de paridade gerador↔parser em
`test/clarice-wave-plan.test.ts`.

### Guards que não se pulam

- **Gabarito É IA?** antes de qualquer `--schedule`. `--skip-eia-guard`
  existe mas não é pra uso normal.
- **Exclusão de comprometidos** (`queued`/`sent`) por fetch ao vivo — imune
  ao lag do store (#3682, que reenviou 100% pra quem já tinha recebido).
- **GET-verify pós-schedule** — confirma que a Brevo aceitou o agendamento.
- **Nunca dois agendamentos em paralelo** pro mesmo ciclo.

---

## Verificação final

```bash
npx tsx scripts/clarice-plan-wave.ts --cycle $CYCLE --dates $DATES --json
```

As ondas recém-agendadas devem aparecer em `state.waves` com
`status: "queued"` e o `scheduledAt` correto. Se não aparecerem, **não
re-executar o Passo 7** — investigar primeiro (pode ter agendado e falhado o
registro, e re-executar duplicaria o envio).

## Não faz

- Não produz a edição — isso é `/diaria-mensal`.
- Não substitui `/diaria-clarice-novos` — invoca.
- Não decide sozinha nada que mude quem recebe e-mail.
