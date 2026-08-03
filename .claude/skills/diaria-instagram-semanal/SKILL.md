---
name: diaria-instagram-semanal
description: Post semanal do Instagram (#4101, restrito ao Instagram + seleção por clique pelo #4483) — os itens mais clicados da semana (D1/D2/D3 e, desde o #4513, também RADAR/USE MELHOR — card 4:5 gerado sob demanda quando vencem — de qualquer edição de segunda a sexta), produzido no sábado e agendado. Só Instagram — nunca vira edição no Beehiiv, nunca dispara e-mail, e não publica em LinkedIn/Facebook/Threads/X (o recap semanal do LinkedIn é `/diaria-linkedin-semanal`, #4456). Uso — `/diaria-instagram-semanal [AAMMDD-do-sabado] [--schedule] [--no-gates]`.
disable-model-invocation: true
---

# /diaria-instagram-semanal

Monta e agenda o post semanal de recapitulação do Instagram (issue #4101,
redesenhado pelo #4483): os itens mais clicados da semana (segunda a sexta),
publicados no sábado. Skill própria (recomendação da issue #4101, mesma
lógica de `/diaria-mensal` ser separada do diário) — invocada uma vez por
semana, logo depois que a edição de sexta é escrita (Stage 2), não como
etapa do pipeline diário.

**Renomeada de `/diaria-semanal` pelo #4483 (260803).** Duas decisões
anteriores da issue #4101 foram SUPERSEDIDAS — releia esta seção antes de
mexer no arquivo, o histórico do #4101 não reflete mais o comportamento
atual:

- **Canal: só Instagram** (era LinkedIn + Facebook + Instagram + Threads,
  com X à parte). Motivo (#4483): a newsletter semanal do LinkedIn
  (`/diaria-linkedin-semanal`, #4456) passou a cobrir o recap de segunda —
  manter o post de sábado no LinkedIn duplicaria o recap com 2 dias de
  distância, e a newsletter ganha em alcance (notificação + e-mail, fora do
  ranqueamento de feed). Facebook/Threads/X saíram junto — nenhuma decisão
  do editor os resgatou.
- **Seleção: por taxa de clique verificado, de qualquer posição elegível
  (D1, D2, D3, RADAR ou USE MELHOR)** — era "os 5 D1, sem ranking por
  clique, sem re-scoring". Dados reais de julho/2026 mostraram o D1
  perdendo pra outro destaque da própria edição com frequência (ver #4483
  pra números). **RADAR e USE MELHOR competem desde o #4513** (briefing do
  editor 260803) — até então ficavam de fora por uma limitação técnica real:
  o carrossel do Instagram precisa de um card 4:5 com o TÍTULO já embutido
  na imagem (`gen-social-card-4x5.ts`), e só D1/D2/D3 tinham esse card
  PRÉ-gerado no Stage 3 diário. A solução não foi gerar o card
  preventivamente pra todo item de toda edição (mais caro, a maioria nunca
  seria usada) — é gerar SOB DEMANDA, só quando um item de RADAR/USE MELHOR
  de fato vence o ranking semanal, dentro do próprio `publish-weekly-social.ts`
  (ver `scripts/lib/weekly-instagram-ondemand-card.ts`). Stage 3 da diária
  (`image-generate.ts`) permanece intocado. Ver
  `scripts/lib/weekly-instagram-select.ts` pro detalhe completo (inclusive
  por que o núcleo de ranking É compartilhado com `weekly-linkedin-select.ts`
  desde o #4511).
- **Produção sexta/sábado, publicação sábado** — inalterado.
- **Quantidade: continua 5** (comentário 260802 do #4483) — muda a
  DEFINIÇÃO ("os 5 mais clicados", não "1 por edição"), não o número.
  `WEEKLY_EXPECTED_ITEMS` em `scripts/publish-weekly-social.ts` é o
  parâmetro fácil de ajustar se isso mudar depois — não é uma constante
  investigada a fundo, é um default seguro.

## Argumentos

- `AAMMDD-do-sabado` — data do sábado de publicação. **Obrigatório e
  explícito** (mesmo invariante de `CLAUDE.md`: nunca inferir de `today()`).
  Se omitido, pergunte ao editor com o próximo sábado como sugestão — nunca
  assuma silenciosamente.
- `--schedule` — sem esta flag, a skill só mostra o PREVIEW (seleção +
  caption + horário planejado) e não agenda nada. Com a flag, agenda de
  verdade pelo Worker queue (`scheduled_at` explícito — nunca envio
  imediato).
- `--no-gates` — pula a confirmação interativa do Passo 3 e já roda com
  `--schedule` (auto-aprova, mesmo padrão de `/diaria-edicao --no-gates`).
- `--force-incomplete-week` — necessário quando a seleção preencheu menos de
  4 dos 5 itens esperados (pool insuficiente de candidatos elegíveis — poucas
  edições na semana e/ou muita exclusão comercial/própria). Sem a flag, o
  script imprime um aviso e ABORTA — não publica um post materialmente
  incompleto em silêncio. Passe a flag só depois de confirmar com o editor
  que a semana curta é legítima (feriado etc.).

## Pré-requisitos

- As 5 (ou menos) edições da semana precisam ter `data/editions/{AAMMDD}/02-reviewed.md`
  no disco. A issue #4101 aponta o risco de retenção: se `data/editions/{AAMMDD}/`
  for limpo/arquivado antes do sábado, os destaques daquele dia não podem mais
  ser recuperados (o disco é a ÚNICA fonte pra edição de sexta, que ainda não
  foi publicada no Beehiiv no momento da produção).
- `data/beehiiv-cache/posts/*.json` — populado por `scripts/beehiiv-sync.ts`
  (roda automaticamente no Stage 0 de cada edição diária). O Passo 1 abaixo
  checa se falta enriquecimento de clicks pros posts da janela antes de
  confiar na seleção.
- Credenciais (mesmas dos publishers diários): `DIARIA_LINKEDIN_CRON_URL` +
  `DIARIA_LINKEDIN_CRON_TOKEN` (Worker queue — mesmo endpoint usado pelo
  Instagram diário e pelo LinkedIn/Threads, `channel: "instagram"`).
- Para cada edição candidata a contribuir um item de DESTAQUE (D1/D2/D3):
  precisa ter rodado `scripts/upload-images-public.ts` (gera
  `06-public-images.json` com `d{1,2,3}_4x5`/`d{1,2,3}`) — sem a imagem do
  destaque específico selecionado, o carrossel inteiro falha (não publica
  parcial, ver Passo 3). Item de RADAR/USE MELHOR NÃO precisa desse
  pré-requisito — o card 4:5 é gerado SOB DEMANDA (#4513, ver
  `scripts/lib/weekly-instagram-ondemand-card.ts`) só se o item vencer o
  ranking; a mesma regra de "falha o carrossel inteiro em vez de publicar
  parcial" vale se a geração sob demanda falhar (ex: crédito de API
  esgotado, fonte de marca ausente na máquina).

## Passo 1 — Checar se falta enriquecimento de clicks

```bash
npx tsx scripts/publish-weekly-social.ts --saturday {AAMMDD-do-sabado} --manifest-only
```

Imprime `{saturday, contentWindow, editionsFound, posts_needing_clicks}`.
**Por que este passo existe:** o gate de estabilização de CTR do pipeline
diário (`MIN_AGE_DAYS_FOR_CLICKS = 7`, `scripts/lib/shared/ctr-config.ts`)
nunca enriquece posts com menos de 7 dias — e os posts desta janela têm
entre 2 e 6 dias no momento em que esta skill roda (sábado, semana que
acabou de terminar). Sem este passo explícito, a seleção rodaria com clicks
zerados pra semana inteira.

Se `posts_needing_clicks` for não-vazio:

```
Agent(subagent_type="beehiiv-clicks-enricher", prompt=<manifest items uma por linha>)
```

Mesmo agent reusado pelo Stage 0 diário e por `/diaria-linkedin-semanal`
(#4456) — cada item do prompt no formato `post_id=<id> title=<title>`, um
por linha. **Não reinventar** um enricher próprio — MCP `list_post_clicks`
só roda de subagent/top-level com a tool declarada, nunca de script TS
standalone (ver docstring de `scripts/lib/weekly-instagram-select.ts`).

Se `posts_needing_clicks` já vier vazio, pule direto pro Passo 2.

## Passo 2 — Preview (sempre, sem `--schedule`)

```bash
npx tsx scripts/publish-weekly-social.ts --saturday {AAMMDD-do-sabado}
```

Sem `--schedule`, o script nunca faz chamada de rede — só imprime:
- Quais edições da semana têm `02-reviewed.md` no disco.
- Os itens selecionados por clique (taxa + título + edição de origem).
- Warnings (empates dentro do ruído de 1 clique, edições sem dado de clique,
  linguagem comercial suspeita em item selecionado, etc).
- A caption formatada do Instagram.
- O horário de agendamento planejado.

Se **nenhum candidato** (nenhum DESTAQUE 1/2/3 com URL em nenhuma edição da
semana) foi encontrado, o script já encerra aqui — nenhum publisher é
chamado, nada é agendado, e a skill deve reportar isso ao editor sem tentar
prosseguir.

## Passo 3 — Gate humano (pulado com `--no-gates`)

Mostre o preview completo (itens selecionados + taxa de clique + warnings +
caption + horário) e peça confirmação explícita antes de agendar de
verdade. Se o editor não responder ou pedir ajuste, não prossiga
silenciosamente.

## Passo 4 — Agendamento real

Script cuida de tudo, inclusive persistência de estado
(`data/weekly/{AAMMDD}/06-weekly-published.json`, idempotente via
skip-existing):

```bash
npx tsx scripts/publish-weekly-social.ts --saturday {AAMMDD-do-sabado} --schedule
```

Carrossel: 1 card 4:5 por item selecionado, resolvido pelo destaque/edição
de origem PRÓPRIOS de cada item (não mais "1 card por dia da semana" — 2
itens podem vir da mesma edição, e uma edição pode não contribuir nenhum).
Item de RADAR/USE MELHOR sem card pré-existente tem o card gerado SOB
DEMANDA nesse momento (#4513). Se QUALQUER item não resolver imagem (falha
de leitura OU de geração sob demanda), o post inteiro falha (nunca publica
carrossel parcial).

## Casos de borda

- **Seleção completa (4-5 itens)**: o post sai com o que a taxa de clique
  escolher — nunca completa artificialmente com D2/D3 "de reserva" além do
  que o ranking já escolheu.
- **Seleção materialmente incompleta (< 4 de 5 itens)**: o script aborta com
  um aviso alto a menos que `--force-incomplete-week` seja passado
  explicitamente. Confirme com o editor que é uma semana curta legítima
  (feriado etc.) antes de re-rodar com a flag — nunca passe a flag sem essa
  confirmação. Diferente do #4101 original, isso pode acontecer mesmo com
  todas as 5 edições presentes (ex: exclusão comercial cortou candidatos
  demais) — o banner de erro já lista o motivo mais provável.
- **Nenhum candidato na semana**: nenhum publisher é chamado; reporte isso
  ao editor em vez de publicar um post vazio.
- **Dado de clique incompleto (#4511)**: se alguma edição da janela estiver
  ausente do cache local OU algum post ainda não tiver sido enriquecido por
  link (sintoma exato do Passo 1 — por isso ele existe), o script aborta com
  um aviso alto a menos que `--force-incomplete-click-data` seja passado
  explicitamente. Isso é diferente de "seleção materialmente incompleta"
  acima: aqui o PROBLEMA é confiabilidade do dado (post não-enriquecido
  entra no ranking com `ratePct: 0`, indistinguível de zero cliques de
  verdade), não a QUANTIDADE de itens selecionados. Resolva rodando o Passo
  1 de novo antes de recorrer à flag.
- **Empate dentro do ruído de 1 clique**: o script já resolve via critério
  editorial (ângulo Brasil > implicação profissional > diversidade de
  categoria) e registra em warnings — mostre esse warning ao editor no gate
  do Passo 3, é informação relevante mesmo já resolvida mecanicamente.
- **Item selecionado sem imagem gerada**: falha o carrossel inteiro
  nomeando qual edição/destaque faltou — nunca publica parcial. Rode
  `scripts/upload-images-public.ts` pra edição faltante e re-rode.
- **Virada de mês/ano**: `computeWeekdayEditionDates` (em
  `scripts/lib/select-weekly-d1.ts`) usa aritmética de `Date` do JS — cruza
  mês/ano corretamente sem lógica de calendário manual (coberto por teste).

## Sobreposição com `/diaria-linkedin-semanal` — mantenha separadas

Ver a tabela comparativa em
`.claude/skills/diaria-linkedin-semanal/SKILL.md` §"Sobreposição". Resumo:
produtos diferentes (post de feed ranqueado vs. newsletter nativa fora do
feed), cadências diferentes (sábado vs. segunda), metodologias de clique
paralelas mas independentes (cada skill mantém sua própria implementação —
ver nota de decoupling em `scripts/lib/weekly-instagram-select.ts`).
