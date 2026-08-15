---
name: diaria-instagram-semanal
description: DOIS carrosséis semanais do Instagram (#4101, restrito ao Instagram + seleção por clique pelo #4483; segundo carrossel "Principais Destaques" pelo #5330) — "clicked" (os itens mais clicados da semana, D1/D2/D3 e desde o #4513 também RADAR, card 4:5 sob demanda quando vence) publica domingo; "highlights" (os 5 D1 da semana, sem ranking) publica sábado. Cada um abre com slide de capa e fecha com slide de CTA de assinatura, sem foto. Só Instagram — nunca vira edição no Beehiiv, nunca dispara e-mail, e não publica em LinkedIn/Facebook/Threads/X (o recap semanal do LinkedIn é `/diaria-linkedin-semanal`, #4456). Uso — `/diaria-instagram-semanal [AAMMDD-do-sabado] [--mode clicked|highlights] [--schedule] [--no-gates]`.
disable-model-invocation: true
---

# /diaria-instagram-semanal

Monta e agenda DOIS carrosséis semanais de recapitulação do Instagram — issue
#4101, redesenhado pelo #4483, e desdobrado em dois carrosséis distintos pelo
#5330 (260815, briefing do editor). Skill própria (recomendação da issue
#4101, mesma lógica de `/diaria-mensal` ser separada do diário) — invocada
uma vez por semana, logo depois que a edição de sexta é escrita (Stage 2),
não como etapa do pipeline diário.

**Dois carrosséis, dois dias, mesma skill (`--mode`, #5330):**

| Modo | Conteúdo | Seleção | Publica |
|---|---|---|---|
| `highlights` | Os 5 D1 da semana | Ordem cronológica, SEM ranking por clique — não depende de dado de clique nenhum | **Sábado** (o próprio `AAMMDD-do-sabado`), 11:00 |
| `clicked` (default) | Os 5 itens mais clicados da semana (D1/D2/D3/RADAR) | Ranking por taxa de clique verificado, ver `weekly-instagram-select.ts` | **Domingo** seguinte, 11:00 |

Motivo dos dias separados: publicar os dois no mesmo dia competiria pelo
mesmo slot de feed do leitor. `DEFAULT_MODE_DAY_OFFSET` em
`scripts/publish-weekly-social.ts` é o parâmetro (`--day-offset` sobrescreve
por invocação, sem editar código). Rode a skill 2x por semana — uma vez por
modo — cada invocação é independente (seleção, cache de card capa/CTA,
persisted store e skip-existing nunca colidem entre os dois, chave
`{saturday}-{mode}`).

**Slide de capa e CTA final (#5330, paleta ajustada na 2ª rodada de review —
#5345):** os dois carrosséis agora têm 7 slides, não 5 — abrem com um card de
apresentação e fecham com um card de CTA convidando a assinar, os dois sem
foto. Paleta CLARA canônica da marca (`COLORS.paper` fundo, `COLORS.ink`
texto, `COLORS.brand` teal de acento — mesma do site/newsletter), não mais um
fundo escuro imitando o overlay dos cards de notícia. Título em auto-size que
cresce até preencher o card inteiro (`fillingFontSize`, 46-148px, testa do
maior tamanho pro menor até caber) — "preenche o card todo, assim não sente
falta de não ter imagem". Ver `scripts/lib/weekly-flat-card.ts`.

**Os 5 slides do meio são RECOMPOSTOS, não reusados como estão (#5345).**
Antes do #5345, cada card de notícia usava o clamp dinâmico de
`buildOverlaySvg` (44-88px, escalado pelo comprimento do próprio título) —
títulos de comprimento bem diferente publicados em dias diferentes da semana
saíam em tamanhos bem diferentes lado a lado no mesmo carrossel (50-88px numa
semana real, achado ao vivo do editor). `computeCarouselTitleFontSize`
(`scripts/lib/weekly-carousel-font-size.ts`) acha o MENOR tamanho que caiba
todos os títulos do carrossel, e `weekly-carousel-news-card.ts` gera um card
4:5 NOVO pra cada D1/D2/D3 selecionado, nesse tamanho único — a partir da
MESMA arte-base do card diário, mas **o `04-{destaque}-4x5.jpg` já publicado
no feed diário nunca é sobrescrito** (arquivo/upload novo, cacheado por
`{edição}-{destaque}-{fontSize}` em
`data/weekly/{carouselKey}/_internal/06-news-cards.json` — `fontSize` faz
parte da chave de propósito, um re-run com seleção diferente pode legitimamente
mudar o tamanho comum). Item de RADAR (modo `clicked`) segue o próprio
caminho de card sob demanda (#4513, ver abaixo) — a recomposição de fonte
única só se aplica a D1/D2/D3, que já têm card pré-gerado no Stage 3 diário.

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
  (D1, D2, D3 ou RADAR)** — era "os 5 D1, sem ranking por clique, sem
  re-scoring". Dados reais de julho/2026 mostraram o D1 perdendo pra outro
  destaque da própria edição com frequência (ver #4483 pra números). **RADAR
  compete desde o #4513** (briefing do editor 260803) — até então ficava de
  fora por uma limitação técnica real: o carrossel do Instagram precisa de um
  card 4:5 com o TÍTULO já embutido na imagem (`gen-social-card-4x5.ts`), e
  só D1/D2/D3 tinham esse card PRÉ-gerado no Stage 3 diário. A solução não
  foi gerar o card preventivamente pra todo item de toda edição (mais caro, a
  maioria nunca seria usada) — é gerar SOB DEMANDA, só quando um item de
  RADAR de fato vence o ranking semanal, dentro do próprio
  `publish-weekly-social.ts` (ver
  `scripts/lib/weekly-instagram-ondemand-card.ts`). Stage 3 da diária
  (`image-generate.ts`) permanece intocado. Ver
  `scripts/lib/weekly-instagram-select.ts` pro detalhe completo (inclusive
  por que o núcleo de ranking É compartilhado com `weekly-linkedin-select.ts`
  desde o #4511). **USE MELHOR também competiu aqui, entre o #4513 (260803) e
  o #5319 (260814) — excluído por decisão do editor: o post semanal é sobre a
  notícia mais clicada da semana, não sobre tutorial/ferramenta. Regra
  permanente — não reabrir sem nova decisão explícita do editor.**
- **Produção sexta/sábado, publicação sábado** — inalterado.
- **Quantidade: continua 5** (comentário 260802 do #4483) — muda a
  DEFINIÇÃO ("os 5 mais clicados", não "1 por edição"), não o número.
  `WEEKLY_EXPECTED_ITEMS` em `scripts/publish-weekly-social.ts` é o
  parâmetro fácil de ajustar se isso mudar depois — não é uma constante
  investigada a fundo, é um default seguro.

## Argumentos

- `AAMMDD-do-sabado` — data do sábado ÂNCORA da semana (segunda a sexta
  anterior). **Se omitido (#5321, "Perguntar é exceção"): default — o
  próximo sábado** (`nextSaturdayAAMMDD()` em `scripts/lib/select-weekly-d1.ts`
  — se hoje já for sábado, resolve pra hoje) — e imprimir banner:
  `AAMMDD-do-sabado não informado — assumindo {AAMMDD} (próximo sábado).
  Passe explicitamente para outra data.` Nunca inferir silenciosamente sem o
  banner. Vale pros dois modos — só a data de AGENDAMENTO muda
  (`highlights` = o próprio sábado, `clicked` = domingo seguinte), a janela
  de conteúdo é a mesma.
- `--mode clicked|highlights` — qual dos dois carrosséis rodar (ver tabela
  acima). Default `clicked` (back-compat com invocações antigas, de antes do
  #5330). Rode a skill 2x na semana, uma vez por modo.
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
- Para cada edição candidata a contribuir um item de DESTAQUE (D1/D2/D3): o
  card do carrossel é RECOMPOSTO com o tamanho de fonte único da rodada
  (#5345, ver seção "Slide de capa e CTA final" acima) — não mais lido pronto
  de `06-public-images.json`. O pré-requisito real é a arte-base do destaque
  já existir no disco na edição de origem (`04-{destaque}-4x5-nativo.jpg`,
  ou fallback `04-{destaque}-master.jpg`/`04-{destaque}-2x1.jpg` — mesma
  ordem de preferência de `gen-social-card-4x5.ts`), produzida pelo Stage 3
  diário. Sem essa arte-base, a recomposição falha e o carrossel inteiro
  falha junto (não publica parcial, ver Passo 3). Item de RADAR NÃO passa
  por esse caminho — o card 4:5 é gerado SOB DEMANDA (#4513, ver
  `scripts/lib/weekly-instagram-ondemand-card.ts`) só se o item vencer o
  ranking; a mesma regra de "falha o carrossel inteiro em vez de publicar
  parcial" vale se a geração sob demanda falhar (ex: crédito de API
  esgotado, fonte de marca ausente na máquina).

## Passo 1 — Checar se falta enriquecimento de clicks

**Só se aplica ao modo `clicked`** — `highlights` não ranqueia por clique,
então `--manifest-only` sempre retorna `posts_needing_clicks: []` nesse modo
(pule direto pro Passo 2).

```bash
npx tsx scripts/publish-weekly-social.ts --saturday {AAMMDD-do-sabado} --mode clicked --manifest-only
```

Imprime `{saturday, mode, contentWindow, editionsFound, posts_needing_clicks}`.
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
npx tsx scripts/publish-weekly-social.ts --saturday {AAMMDD-do-sabado} --mode {clicked|highlights}
```

Sem `--schedule`, o script nunca faz chamada de rede — só imprime:
- Quais edições da semana têm `02-reviewed.md` no disco.
- Os itens selecionados (modo `clicked`: taxa + título + edição de origem;
  modo `highlights`: os 5 D1 em ordem cronológica, sem taxa).
- Warnings (empates dentro do ruído de 1 clique — só `clicked`, edições sem
  dado de clique — só `clicked`, linguagem comercial suspeita em item
  selecionado — os dois modos, etc).
- A caption formatada do Instagram (intro varia por modo) — cada item leva
  título numerado + 1 linha de contexto (`why` do destaque, ou a 1ª frase de
  `body` pra RADAR). Desde o #5345, essa linha de contexto sai SEMPRE
  inteira, sem truncar em N chars por item (um cap de 140 chars cortava a
  frase no meio, ilegível) — a única rede de segurança é o limite de 2200
  chars da caption INTEIRA (`truncateAtLimit`, `format-weekly-social.ts`),
  que corta preservando palavras inteiras se o total estourar.
- O horário de agendamento planejado (sábado pra `highlights`, domingo pra
  `clicked`).

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
skip-existing — chave `destaque: "weekly-{mode}"`, os dois modos nunca
colidem no mesmo arquivo):

```bash
npx tsx scripts/publish-weekly-social.ts --saturday {AAMMDD-do-sabado} --mode {clicked|highlights} --schedule
```

Carrossel: 7 slides — capa (sem foto) + 1 card 4:5 por item selecionado
(resolvido pelo destaque/edição de origem PRÓPRIOS de cada item — 2 itens
podem vir da mesma edição, e uma edição pode não contribuir nenhum) + CTA
final (sem foto). O tamanho de fonte comum do carrossel
(`computeCarouselTitleFontSize`) é calculado 1x, a partir do SET inteiro de
itens selecionados nessa rodada; cada item D1/D2/D3 é então RECOMPOSTO nesse
tamanho (`resolveOrGenerateNewsCardUrl`, #5345 — ver seção acima), nunca
reusado no tamanho publicado originalmente no feed diário. Item de RADAR sem
card pré-existente tem o card gerado SOB DEMANDA nesse momento (#4513), fora
desse mecanismo de recomposição de fonte. Capa/CTA (paleta clara, auto-size —
ver seção acima) são gerados/upados sob demanda na 1ª execução e cacheados
depois (`data/weekly/{saturday}-{mode}/_internal/06-flat-cards.json` — ver
`scripts/lib/weekly-flat-card.ts`). Se QUALQUER item de notícia não resolver
imagem (falha de leitura, recomposição OU geração sob demanda), o post
inteiro falha (nunca publica carrossel parcial) — capa/CTA falhando também
aborta o post inteiro pela mesma razão.

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
  nomeando qual edição/destaque faltou — nunca publica parcial. Pra item de
  DESTAQUE (D1/D2/D3), a causa é arte-base ausente na edição de origem
  (`04-{destaque}-4x5-nativo.jpg`/`master.jpg`/`2x1.jpg`) — rode o Stage 3
  (`/diaria-3-imagens`) pra edição faltante e re-rode esta skill. Pra item de
  RADAR, a causa é falha da geração sob demanda (#4513) — o erro reportado
  (`onDemandError`) já indica o motivo.
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
