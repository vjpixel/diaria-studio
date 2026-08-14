---
name: diaria-brevo-diaria
description: Empacota o envio da edição diária pelo canal Brevo próprio do editor (segmento Pending da Beehiiv — reativação, `platform.config.json` → `brevo_diaria`). Skill manual e separada do fluxo 0-5 de `/diaria-edicao` (Beehiiv continua sendo o canal principal automático) — o editor decide quando disparar este canal extra. Uso — `/diaria-brevo-diaria AAMMDD`.
---

# /diaria-brevo-diaria

Empacota `scripts/publish-daily-brevo.ts` (#4266) — hoje só invocável manualmente
via CLI — no mesmo padrão de skill manual já usado por `/diaria-mensal-apoiadores`:
preview obrigatório e gate humano explícito antes de criar o rascunho.
**Agendamento (Passo 8) pode ser feito por esta skill desde 260811 (#4980)** —
decisão do editor que revoga o guard anterior ("nunca agenda/envia sozinho",
#4580); o `scheduledAt` em si continua exigindo confirmação explícita do
editor a cada execução (ver Passo 8), só a proibição categórica saiu.

**Canal Pending, não o canal principal.** O envio-padrão da edição (Beehiiv,
lista completa de assinantes confirmados) continua saindo pelo fluxo normal de
`/diaria-edicao`/`/diaria-5-publicacao`. Este canal é um EXTRA: gente que se
inscreveu na Beehiiv mas nunca confirmou o double opt-in (segmento Pending),
migrada pra uma lista Brevo própria do editor como via alternativa de
reativação (#4266/#4476). Rodar esta skill não substitui nem depende do envio
Beehiiv da mesma edição — são canais paralelos e independentes.

## Argumentos

- `AAMMDD` — **obrigatório, sempre explícito**, nunca inferir a partir de
  `today()` (mesma disciplina do CLAUDE.md — "Data da edição é sempre
  explícita"). Se o usuário não passar a data, perguntar com sugestão de
  amanhã (D+1) como atalho padrão — mesma data que o resto do pipeline usa
  pra "a edição em curso" (CLAUDE.md, "Edição é sempre D+1"; este canal Brevo
  é um envio EXTRA da mesma edição diária, não uma edição própria — #5180) —,
  mas exigir confirmação antes de prosseguir.

## Pré-requisito: localizar o diretório da edição

As pastas de edição são NESTED por mês — `data/editions/{AAMM}/{AAMMDD}`, não
`data/editions/{AAMMDD}` (achado ao vivo registrado no comentário 2026-08-04 da
issue #4580, execução manual da edição 260804). Resolva o path com o helper
canônico em vez de montar a string à mão:

```bash
npx tsx -e "import { editionDir } from './scripts/lib/edition-paths.ts'; console.log(editionDir('AAMMDD'))"
```

(substitua `AAMMDD` pelo argumento recebido). Use o resultado como
`<edition-dir>` nos passos abaixo. Se o diretório não existir, informe o
editor e pare — não há o que publicar.

## Passo 1 — Atualização de contatos (`evaluate-brevo-diaria.ts`, OBRIGATÓRIO — #4637/#4725)

**Não é mais opcional.** Antes de qualquer preview de campanha nova, esta
skill SEMPRE roda esta reavaliação — não é uma sugestão que o editor aceita
ou recusa, é parte fixa do fluxo (decisão do editor, comentário 260806 da
issue #4637, consolidando a #4725). Motivo: a task agendada que faria isso
automaticamente antes do envio canônico das 06:00
(`Diaria-Brevo-Diaria-Evaluate`, 05:30 BRT, #4534) ainda não foi armada em
produção segundo o CLAUDE.md — sem rodar aqui, a campanha nova sai pra gente
que já deveria ter sido promovida/suprimida. Não é cosmético: na execução da
edição 260807 (260806), rodar isto antes resolveu 3 contatos que receberiam
mais um envio Pending indevidamente (1 auto-confirmado + 2 promovidos por
abertura).

Rode o dry-run primeiro:

```bash
npx tsx scripts/evaluate-brevo-diaria.ts
```

Apresente ao editor a tabela de ações do stderr do script — quantos
promovidos / descadastros nativos / suprimidos / mantidos — e o threshold em
uso. **Não assuma o valor de cabeça**, leia direto de
`scripts/lib/shared/brevo-diaria-score.ts`:

- `BREVO_DIARIA_PROMOTE_MIN_OPEN_RATE` — promoção, avaliada contra
  contadores INSTANTÂNEOS (todos os envios). Comparação ESTRITA (`>`, não
  `>=`) desde a decisão do editor (#4637, 260805b): hoje `0.51` — 51% exato
  NÃO promove, 51,1% promove.
- `BREVO_DIARIA_SUPPRESS_MAX_OPEN_RATE` — supressão, avaliada contra
  contadores MADUROS (só envios com ≥48h de idade). Hoje `0.2`.

As duas são constantes **separadas de propósito** (risco assimétrico:
promover errado é barato, suprimir errado é quase irreversível) — nunca leia
o valor de uma como se valesse pra outra, mesmo que um dia voltem a coincidir
por acaso.

**Falha do evaluate é HALT, não warning.** Se o dry-run ou o `--push` abortar
(erro de API, MCP indisponível, timeout, etc.), pare e informe o editor — não
prossiga pro Passo 5 (preview da campanha) com dado de audiência
desatualizado (mesma disciplina do #738 pro resto do pipeline).

A mutação real (`--push`) só roda depois da confirmação combinada do Passo 4
— este passo aqui só produz a tabela de proposta.

## Passo 2 — Refresh do pool Pending (`refresh-pending-pool.ts`, OBRIGATÓRIO — #5183)

**Etapa nova (#5183).** O pool de entrada deste canal é um snapshot MANUAL
congelado de 260802 (`data/pending-reativacao/pending-scored.csv`) — sem este
passo, todo Pending cadastrado na Beehiiv DEPOIS daquele dia é invisível pro
resto do fluxo (paginado pela Beehiiv, mas descartado em silêncio antes de
virar candidato). Roda **sempre**, antes do Passo 3, na mesma disciplina de
obrigatoriedade do Passo 1.

Dry-run primeiro:

```bash
npx tsx scripts/refresh-pending-pool.ts
```

Apresente ao editor, a partir do stderr do script:

- Quantos Pending novos foram encontrados fora do pool (bruto + computado) e
  do store deste canal.
- Quantos foram excluídos por origem **SparkLoop Upscribe** (`RH_SOURCE =
  "sparkloop-upscribe"`) — filtro **obrigatório**, reusa o mesmo fingerprint
  de `sync-sparkloop-exclusion-segment-beehiiv.ts`; contato dessa origem
  NUNCA entra no pool por este canal.
- Quantos serão de fato adicionados nesta rodada, dentro da cota
  (`DEFAULT_REFRESH_LIMIT` = 25/rodada por padrão — conservador, sem número
  explícito do editor; ajustável via `--limit N` se o volume real em produção
  pedir outro valor).

Com a confirmação combinada do Passo 4, aplique:

```bash
npx tsx scripts/refresh-pending-pool.ts --push
npx tsx scripts/score-pending-origin.ts
npx tsx scripts/verify-pending-emails-mv.ts
```

**Ordem FIXA, sempre as três em sequência** — um contato novo só é visível
pra MillionVerifier depois de entrar no pool (`refresh-pending-pool.ts`), e só
depois de reverificado (`verify-pending-emails-mv.ts`) é que
`sync-pending-to-brevo.ts` (Passo 3) o enxerga como candidato. Pular
`score-pending-origin.ts`/`verify-pending-emails-mv.ts` depois do `--push`
deste passo deixa o pool "refrescado mas não recomputado" —
`assertMvGuardAcknowledged` (`sync-pending-to-brevo.ts`) detecta esse estado e
recusa `--push` do Passo 3 até rodar os dois scripts.

Contato Pending novo NUNCA compete por `score` com o pool antigo de 2023 —
entra marcado `lane: "recency"` (decisão do editor, briefing 260814: cadastro
recente/orgânico é mais "quente", mas nunca foi medido pela mesma fórmula
manual) e ganha prioridade de fila própria em `selectContactsForBackfill`
(Passo 3), sem um score inventado.

## Passo 3 — Proposta de aumento de rampa (`sync-pending-to-brevo.ts`, sempre perguntada)

Depois dos Passos 1–2 (as saídas de promoção/supressão liberam slots; o pool
está com os Pending mais recentes), rode o dry-run do backfill:

```bash
npx tsx scripts/sync-pending-to-brevo.ts
```

Apresente ao editor, a partir do stderr do script:

- **Slots livres no cap** (`fila: X/Y ocupados, Z livre(s)`) — já reflete as
  saídas propostas no Passo 1 só depois que o Passo 1 de fato aplicar
  `--push` (rodar o dry-run deste passo ANTES do `--push` do Passo 1 mostra
  o número desatualizado; ao apresentar ao editor, deixe claro se o Passo 1
  já foi aplicado ou ainda está só proposto).
- **Candidatos elegíveis**, ordenados pela fila priorizada — lane de
  recência (Passo 2) primeiro, depois pool antigo por score de origem
  (`scripts/score-pending-origin.ts` via `selectContactsForBackfill`).
- **Cobertura MillionVerifier** (quantos do pool já foram processados —
  ver `assertMvGuardAcknowledged`; sem cobertura completa, `--push` exige
  `--i-know-this-skips-mv` explícito. Desde #5183, isso também bloqueia se o
  pool foi refrescado no Passo 2 mas ainda não recomputado/reverificado).

Pergunte quantos contatos acrescentar — **"nenhum" é resposta válida e é o
default recomendado enquanto a abertura agregada recente do canal estiver
abaixo de 15%** (piso de entregabilidade do ramp Clarice, mesmo piso
documentado no CLAUDE.md — critério de retomada registrado no comentário
260806 da issue #4637: abertura madura ≥~20% no mesmo volume → causa
provável é horário de envio, não composição da fila; ~10% no mesmo volume →
composição da fila é a causa, considerar suprimir os não-abridores antes de
ingerir qualquer contato novo). Cheque o número real com:

```bash
npx tsx scripts/check-brevo-diaria-guardrail.ts --dry-run
```

(`openRatePct` no output — mesma métrica agregada do piso de 15% citado
acima; não julgue "abaixo de 15%" de memória). Só então rode o push,
**limitado ao número escolhido**:

```bash
npx tsx scripts/sync-pending-to-brevo.ts --push --max-add N
```

`--max-add 0` é a forma explícita de "nenhum" — roda o resto do fluxo (MV
guard, circuit breaker de campanha) normalmente, só não ingere ninguém.
Omitir `--max-add` volta ao comportamento antigo (preenche até o cap) — só
use assim se o editor pedir explicitamente "preenche tudo que couber".

**O cap de 300 exclui os 5 `EDITOR_SEED_EMAILS` por design (#4631,
#5182).** `computeCurrentActiveCount` (`sync-pending-to-brevo.ts`) e
`checkDailySendCap` (`publish-daily-brevo.ts`) subtraem os 5 seeds do
numerador antes de comparar contra `brevo_diaria.daily_send_cap` — eles
ficam permanentemente vinculados à lista Brevo fora deste fluxo (sondas de
inbox placement), não fazem parte da fila gerenciada (`in_brevo`) que o cap
rege. Ao preencher até o cap, o total BRUTO esperado na lista Brevo é
`cap + len(EDITOR_SEED_EMAILS)` — hoje `300 + 5 = 305`, não `300`. Não
estranhe se `publish-daily-brevo.ts` reportar "305 contato(s) na lista" com
o cap em 300.

### Origem/tema do backfill (achado do #4632, issue fechada NOT_PLANNED)

A issue #4632 propunha um allowlist/denylist explícito de origem antes do
backfill (achado ao vivo: o backfill cego a tema já puxou leitores de
numerologia/alquimia por score alto de origens off-topic). **#4632 foi
fechada `NOT_PLANNED` em 260805, sem comentário de motivo registrado** — não
foi implementada nem redirecionada por outra issue. A única defesa hoje
contra audiência off-topic no backfill continua sendo a priorização por
SCORE (`selectContactsForBackfill` + `loadOriginScores`) — não existe
allowlist/denylist de origem no código pro pool ANTIGO (o pool NOVO, via
Passo 2, tem o filtro obrigatório de origem SparkLoop, mas não é um
allowlist/denylist geral). Ao apresentar a fila priorizada neste passo,
mencione ao editor se alguma origem de score baixo/duvidoso aparece entre os
N candidatos escolhidos (mesmo escrutínio manual que o #4632 documentou como
necessário enquanto o gate automático não existir).

## Passo 4 — Gate humano: contatos + rampa

Apresente as **três etapas juntas** — ações do Passo 1 (promovidos /
descadastros nativos / suprimidos / mantidos), refresh do pool do Passo 2
(Pending novos encontrados, excluídos por SparkLoop, selecionados dentro da
cota) e proposta de rampa do Passo 3 (slots livres, candidatos, `--max-add`
escolhido) — antes de aplicar QUALQUER mutação real. Só prossiga com
confirmação explícita ("sim", "pode aplicar", equivalente) — mesma
disciplina do #3938 pra gates interativos. Resposta ambígua ou ausência de
resposta → não prossiga, pergunte de novo.

Com a confirmação, rode as mutações reais nesta ordem (Passo 1 primeiro —
libera slots; Passo 2 antes do Passo 3 — o pool precisa estar refrescado
E recomputado/reverificado antes do backfill enxergar os novos):

```bash
npx tsx scripts/evaluate-brevo-diaria.ts --push
npx tsx scripts/refresh-pending-pool.ts --push
npx tsx scripts/score-pending-origin.ts
npx tsx scripts/verify-pending-emails-mv.ts
npx tsx scripts/sync-pending-to-brevo.ts --push --max-add N   # N = escolhido no Passo 3; omita p/ preencher até o cap
```

## Passo 5 — Preview da campanha (`--dry-run`, sempre depois dos Passos 1–4)

```bash
npx tsx scripts/publish-daily-brevo.ts <edition-dir> --dry-run
```

Mostra ao editor, a partir do stderr do script:

- **Assunto** (`Assunto: ...`) e **preview text** (`Preview: ...`).
- **Warnings de imagem não resolvida** (`warn: N placeholder(s) de imagem sem
  URL: ...`) — se aparecer, avise explicitamente antes do gate do Passo 6; o
  editor pode preferir corrigir `06-public-images.json` antes de prosseguir.
- O HTML completo fica escrito em
  `<edition-dir>/_internal/newsletter-final-brevo.html` — mencione o path pro
  editor poder abrir e ler o corpo renderizado, inclusive o bloco de intro
  obrigatório do segmento Pending (`context/snippets/brevo-diaria-pending-intro.md`
  — ver disclaimer no próprio arquivo, ainda rascunho).

Se o script abortar antes disso (assunto vazio, `brevo_diaria` ausente em
`platform.config.json`, etc. — ver exit codes no cabeçalho do script), relate o
erro tal como impresso e pare — não tente contornar.

## Passo 6 — Gate humano: copy da campanha

**Nunca pule este passo, mesmo com `--dry-run` limpo.** Apresente ao editor:

- Assunto e preview text do Passo 5.
- Qualquer warning de imagem.
- Lembrete explícito: `--i-reviewed-the-copy` é a confirmação de que ele
  revisou `context/snippets/brevo-diaria-pending-intro.md` (o bloco de intro
  ainda é rascunho, por decisão registrada no próprio arquivo/#4266) — não é
  só uma flag de "prossiga", é uma checagem de compliance sobre ESTE texto
  específico.

Só prossiga pro Passo 7 com confirmação explícita ("sim", "pode mandar",
equivalente). Resposta ambígua ou ausência de resposta → não prossiga, pergunte
de novo (mesma disciplina do #3938 pra gates interativos).

## Passo 7 — Criar a campanha (rascunho)

Só depois da confirmação explícita do Passo 6:

```bash
npx tsx scripts/publish-daily-brevo.ts <edition-dir> --i-reviewed-the-copy
```

A campanha sai **sempre como rascunho** neste passo — o script em si não
agenda (ainda não existe flag `--schedule-at`/`--send-now` em
`publish-daily-brevo.ts`; ver Passo 8 pro caminho atual). Reporte ao editor:

- **Campaign id** (`campanha criada: id=N ...`, impresso no stderr).
- Se o editor quiser mandar um e-mail de teste antes de agendar
  (`--send-test`, #5086 — espelha `publish-monthly.ts`): rode

  ```bash
  npx tsx scripts/publish-daily-brevo.ts <edition-dir> --i-reviewed-the-copy --send-test
  ```

  Dispara `POST /emailCampaigns/{id}/sendTest` DEPOIS de criar o rascunho, pro
  destinatário default (`brevo_diaria.test_email` em `platform.config.json` —
  hoje `vjpixel@gmail.com`). Pra outro destinatário, acrescente
  `--send-test-to <email>` (sobrepõe o default). Sem nenhum dos dois
  configurados, o script recusa ANTES de qualquer chamada de rede — nunca
  dispara `sendTest` sem destinatário resolvido. O envio de teste fica
  registrado em `<edition-dir>/_internal/brevo-diaria-published.json`
  (`test_email` + `test_sent_at`) — só quando `--send-test` de fato dispara;
  criar o rascunho sem `--send-test` continua sem esse arquivo.

## Passo 8 — Agendar a campanha (#4980, 260811)

**Mudança de política (260811, #4980):** até aqui, agendar/disparar era
proibido categoricamente pra esta skill ("guard de publicação, invariante do
CLAUDE.md"). O editor revogou essa proibição ao vivo na execução da edição
`260811` — a instrução anterior estava, nas palavras dele, "desatualizada".
**O que NÃO mudou:** o `scheduledAt` continua sendo uma decisão do editor, não
um default silencioso — pergunte a data/hora explicitamente a cada execução
(mesma disciplina de "data da edição é sempre explícita" do CLAUDE.md). Uma
campanha agendada na Brevo é **imutável** (`brevo-scheduled-campaigns-immutable`)
e este canal manda pro segmento Pending (não confirmado) — errar aqui não tem
volta, então confirme o horário por escrito antes de agendar, mesmo que o
editor já tenha dito "pode agendar" de forma genérica.

Não existe script dedicado ainda (unidade de trabalho separada, ver "Escopo
possível" na issue #4980 — `--schedule-at` em `publish-daily-brevo.ts`
reusando `brevoSendNow`/`pollTerminalSendStatus` de
`scripts/lib/brevo-client.ts`). Até isso ser implementado, agende via chamada
direta à API Brevo (`PUT /emailCampaigns/{id}` com `{"scheduledAt": "<ISO
8601>"}`, `api-key: $BREVO_DIARIA_API_KEY`), seguido de um GET de verificação
confirmando `status` e `scheduledAt` na resposta — mesmo padrão de
releitura pós-mutação usado em `ingestContactToBrevo`
(`scripts/sync-pending-to-brevo.ts`). Reporte ao editor o `scheduledAt`
confirmado por essa releitura, não o que foi enviado no PUT.

## Fora de escopo desta skill

- Allowlist/denylist automático de origem em `selectContactsForBackfill`
  (`sync-pending-to-brevo.ts`) — issue #4632, fechada `NOT_PLANNED` em
  260805 (sem gate automático implementado; ver "Origem/tema do backfill" no
  Passo 3 pro estado atual e a mitigação manual).
- Adicionar `--schedule-at` a `publish-daily-brevo.ts` — gap conhecido (ver
  Passo 8 e issue #4980), não fechado aqui; o agendamento hoje passa por
  chamada direta à API, não pelo script.
- Task agendada diária automática pro refresh do Passo 2 — a skill continua
  com gate humano em todos os passos (#5183 escopo explícito).
