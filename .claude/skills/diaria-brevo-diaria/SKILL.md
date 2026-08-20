---
name: diaria-brevo-diaria
description: Empacota o envio da edição diária pelo canal Brevo próprio do editor (segmento Pending da Beehiiv — reativação, `platform.config.json` → `brevo_diaria`). Desde #5772 (20/08/2026) este canal também faz parte do dispatch AUTOMÁTICO da Etapa 5/6 de `/diaria-edicao` (rascunho na 5, agendamento na 6) — esta skill continua existindo pro disparo MANUAL/ad-hoc (retry, execução fora do fluxo normal, `--max-add`/horário customizados). Uso — `/diaria-brevo-diaria AAMMDD`.
---

# /diaria-brevo-diaria

**Desde #5772 (20/08/2026), este canal NÃO é mais exclusivamente manual** — a
Etapa 5 de `/diaria-edicao` (`brevo-diaria-stage5-dispatch.ts`) já cria o
rascunho automaticamente (`--max-add` derivado sem gate) e a Etapa 6
(`schedule-daily-brevo.ts`) já agenda junto com o Schedule Beehiiv, sob o
mesmo gate humano. Esta skill segue existindo pro caminho **manual/ad-hoc**:
retry de um disparo que falhou na Etapa 5/6, execução fora do fluxo normal
da edição diária, ou quando o editor quer `--max-add`/horário diferentes do
default automático.

Empacota `scripts/publish-daily-brevo.ts` (#4266) — hoje só invocável manualmente
via CLI — no mesmo padrão de skill manual já usado por `/diaria-mensal-apoiadores`:
preview obrigatório e gate humano explícito antes de criar o rascunho.
**Agendamento (Passo 8) pode ser feito por esta skill desde 260811 (#4980)** —
decisão do editor que revoga o guard anterior ("nunca agenda/envia sozinho",
#4580); o `scheduledAt` em si continua exigindo confirmação explícita do
editor a cada execução (ver Passo 8), só a proibição categórica saiu.

**Os Passos 1-4 (contatos + rampa) são um orquestrador determinístico desde
#5192** — `scripts/brevo-diaria-run.ts` (padrão de `scripts/clarice-novos-run.ts`,
#4941), não mais 5 invocações de script encadeadas em prosa. O LLM/editor
segue decidindo `--max-add N` no gate humano (Passo 4) e confirmando o
disparo — só a SEQUÊNCIA fixa entre sub-scripts (ordem, args, quando cada um
roda) virou código. Os Passos 5-8 (campanha) continuam em prosa — cada um já
é uma única invocação de `publish-daily-brevo.ts` cercada por um gate humano,
sem encadeamento de múltiplos scripts pra determinizar (ver scoping na
issue #5192).

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

## Passos 1-3 — Preflight (contatos + pool + rampa, dry-run)

Roda o preflight determinístico — os 3 dry-runs (evaluate-brevo-diaria,
refresh-pending-pool, sync-pending-to-brevo) em sequência fixa, SEM mutar
nada:

```bash
npx tsx scripts/brevo-diaria-run.ts --preflight
```

Se qualquer um dos 3 passos falhar (erro de API, MCP indisponível, timeout,
config ausente), o script PARA no primeiro que falhar e não roda os
seguintes — reporte o erro tal como impresso (stderr) e pare, não tente
contornar (mesma disciplina do #738 pro resto do pipeline; **falha do
Passo 1 é HALT, não warning** — não prossiga pro Passo 5 com dado de
audiência desatualizado).

Com o stderr combinado dos 3 passos, apresente ao editor:

**Passo 1 (`evaluate-brevo-diaria`)** — quantos promovidos / descadastros
nativos / suprimidos / mantidos, e o threshold em uso. **Não assuma o valor
de cabeça**, leia direto de `scripts/lib/shared/brevo-diaria-score.ts`:

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

**Passo 2 (`refresh-pending-pool`)** — quantos Pending novos foram
encontrados fora do pool (bruto + computado) e do store deste canal; quantos
foram excluídos por origem **SparkLoop Upscribe** (`RH_SOURCE =
"sparkloop-upscribe"`, filtro obrigatório — reusa o mesmo fingerprint de
`sync-sparkloop-exclusion-segment-beehiiv.ts`, contato dessa origem NUNCA
entra no pool por este canal); quantos serão de fato adicionados nesta
rodada, dentro da cota (`DEFAULT_REFRESH_LIMIT` = 25/rodada por padrão —
conservador, sem número explícito do editor; ajustável via
`npx tsx scripts/refresh-pending-pool.ts --limit N` fora do orquestrador se o
volume real em produção pedir outro valor — o orquestrador não expõe
`--limit` de propósito, é uma decisão rara o bastante pra ficar fora do
caminho automatizado). Contato Pending novo NUNCA compete por `score` com o
pool antigo de 2023 — entra marcado `lane: "recency"` (decisão do editor,
briefing 260814: cadastro recente/orgânico é mais "quente", mas nunca foi
medido pela mesma fórmula manual) e ganha prioridade de fila própria em
`selectContactsForBackfill` (Passo 3), sem um score inventado.

**Passo 3 (`sync-pending-to-brevo`)** — **slots livres no cap** (`fila: X/Y
ocupados, Z livre(s)`) — reflete o estado ATUAL da lista Brevo, ainda sem as
saídas do Passo 1 aplicadas (o preflight roda tudo em dry-run; o número real
pós-aplicação só existe depois do Passo 4 rodar `--apply`, deixe isso claro
ao editor); **candidatos elegíveis**, ordenados pela fila priorizada — lane
de recência (Passo 2) primeiro, depois pool antigo por score de origem
(`scripts/score-pending-origin.ts` via `selectContactsForBackfill`);
**cobertura MillionVerifier** (quantos do pool já foram processados — ver
`assertMvGuardAcknowledged`).

Pergunte quantos contatos acrescentar — **"nenhum" continua sendo resposta
válida**, mas deixou de ser o default sugerido só porque a abertura agregada
recente do canal está abaixo de 15% (revisado #5246: abertura baixa é
**informativa, nunca pausa o rollout sozinha** — mesma decisão já
implementada no circuit breaker automático,
`scripts/lib/brevo-diaria-guardrail.ts` §"Abertura é INFORMATIVA, não pausa":
furar o piso no primeiro lote é resultado esperado de uma cohort fria de 7+
meses, não fracasso; só bounce/spam/unsub pausam o rollout). Reporte a
abertura agregada ao editor como dado de contexto no gate — útil pra decidir
volume e composição da fila (comentário 260806 da issue #4637: abertura
madura ≥~20% no mesmo volume → causa provável é horário de envio, não
composição da fila; ~10% no mesmo volume → composição da fila é a causa,
considerar suprimir os não-abridores via Passo 1 antes de ingerir contato
novo) — sem travar "nenhum" como resposta padrão. Cheque o número real com:

```bash
npx tsx scripts/check-brevo-diaria-guardrail.ts --dry-run
```

(`openRatePct` no output — mesma métrica agregada do piso de 15% citado
acima; não julgue "abaixo de 15%" de memória).

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

Apresente as **três etapas juntas** (Passos 1-3 do preflight acima) — ações
de promoção/supressão, refresh do pool, e proposta de rampa — antes de
aplicar QUALQUER mutação real. Só prossiga com confirmação explícita ("sim",
"pode aplicar", equivalente) — mesma disciplina do #3938 pra gates
interativos. Resposta ambígua ou ausência de resposta → não prossiga,
pergunte de novo.

Com a confirmação (N = número de contatos a acrescentar, escolhido no
Passo 3 — `0` é a forma explícita de "nenhum"), rode a mutação real:

```bash
npx tsx scripts/brevo-diaria-run.ts --apply --max-add N
```

Isso roda, na ordem FIXA (Passo 1 primeiro — libera slots; Passo 2 antes do
Passo 3 — o pool precisa estar refrescado E recomputado/reverificado antes
do backfill enxergar os novos):

1. `evaluate-brevo-diaria.ts --push`
2. `refresh-pending-pool.ts --push`
3. `score-pending-origin.ts`
4. `verify-pending-emails-mv.ts`
5. `sync-pending-to-brevo.ts --push --max-add N`

O script PARA no primeiro passo que falhar — nunca continua a sequência com
uma mutação parcial. Se o passo 4 (`verify-pending-emails-mv`) falhar por
`MV_COST_GUARD_THRESHOLD` (500 e-mails, ~US$1.14 acima do teto — critério 3
de "Perguntar é exceção" no CLAUDE.md, gasto real acima do trivial), o erro
aparece no stderr com a estimativa de custo: confirme com o editor e
re-rode com `--confirm-mv`:

```bash
npx tsx scripts/brevo-diaria-run.ts --apply --max-add N --confirm-mv
```

(idempotente o suficiente pra reexecutar — os passos já aplicados
`--push`/`score-pending-origin` não têm efeito colateral destrutivo em
re-rodar; `verify-pending-emails-mv` usa checkpoint próprio, `refresh-pending-pool`
não reingere quem já entrou no pool).

Se em vez disso for o passo 5 (`sync-pending-to-brevo`) que falhar por
cobertura MillionVerifier incompleta no pool ANTIGO
(`assertMvGuardAcknowledged` — guard DISTINTO do `MV_COST_GUARD_THRESHOLD`
acima), confirme com o editor que ingerir sem cobertura completa é aceitável
nesta rodada e re-rode com `--i-know-this-skips-mv`:

```bash
npx tsx scripts/brevo-diaria-run.ts --apply --max-add N --i-know-this-skips-mv
```

## Passo 5 — Preview da campanha (`--dry-run`, sempre depois do Passo 4)

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
  obrigatório do segmento Pending (`data/snippets/brevo-diaria-pending-intro.md`
  — ver disclaimer no próprio arquivo, ainda rascunho).

Se o script abortar antes disso (assunto vazio, `brevo_diaria` ausente em
`platform.config.json`, etc. — ver exit codes no cabeçalho do script), relate o
erro tal como impresso e pare — não tente contornar.

## Passo 6 — Gate humano: copy da campanha

**Nunca pule este passo, mesmo com `--dry-run` limpo.** Apresente ao editor:

- Assunto e preview text do Passo 5.
- Qualquer warning de imagem.
- Lembrete explícito: `--i-reviewed-the-copy` é a confirmação de que ele
  revisou `data/snippets/brevo-diaria-pending-intro.md` (o bloco de intro
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
- `--limit N` do `refresh-pending-pool.ts` — o orquestrador `brevo-diaria-run.ts`
  não expõe essa flag (decisão de escopo do #5192); ajustar a cota de
  25/rodada requer rodar `refresh-pending-pool.ts --push --limit N` fora do
  orquestrador.
- Envolver os Passos 5-8 (criação/agendamento de campanha) no orquestrador —
  cada um já é uma única invocação de script cercada de gate humano, sem
  encadeamento de JSON entre múltiplos sub-scripts pra determinizar (scoping
  explícito do #5192, ver comentário no PR desta unidade).
