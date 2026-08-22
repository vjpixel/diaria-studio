---
name: diaria-instagram-semanal
description: DOIS carrosséis semanais (#4101, restrito ao Instagram + seleção por clique pelo #4483; segundo carrossel "Principais Destaques" pelo #5330; expandido pra Facebook E Threads pelo #5348) — "clicked" (os itens mais clicados da semana, D1/D2/D3 e desde o #4513 também RADAR, card 4:5 sob demanda quando vence) publica domingo; "highlights" (os 5 D1 da semana, sem ranking) publica sábado. Cada um abre com slide de capa e fecha com slide de CTA de assinatura, sem foto. Publica em Instagram, Facebook E Threads automaticamente, mesmo agendamento, sem flag/canal separado (#5348) — ver seção "#5348 — expansão pra Facebook e Threads" abaixo pro detalhe de cada canal (Threads exige polling obrigatório de status, diferente dos outros 2). Nunca vira edição no Beehiiv, nunca dispara e-mail (o recap semanal do LinkedIn é `/diaria-linkedin-semanal`, #4456, produto/cadência diferentes). `--mode both` (#5349) roda os 2 modos numa única invocação — e é o default quando `--mode` é omitido (#5903, uso semanal normal; `clicked` isolado é só back-compat do script chamado direto). Uso — `/diaria-instagram-semanal [AAMMDD-do-sabado] [--mode clicked|highlights|both] [--schedule] [--no-gates]`.
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
| `clicked` | Os 5 itens mais clicados da semana (D1/D2/D3/RADAR) | Ranking por taxa de clique verificado, ver `weekly-instagram-select.ts` | **Domingo** seguinte, 11:00 |

**Sem `--mode` explícito, a skill roda os DOIS (#5903)** — ver "Argumentos"
abaixo. `clicked` isolado só é o default de quem chama
`scripts/publish-weekly-social.ts` direto (back-compat, não é o comportamento
da skill).

Motivo dos dias separados: publicar os dois no mesmo dia competiria pelo
mesmo slot de feed do leitor. `DEFAULT_MODE_DAY_OFFSET` em
`scripts/publish-weekly-social.ts` é o parâmetro (`--day-offset` sobrescreve
por invocação, sem editar código). Cada modo é independente (seleção, cache
de card capa/CTA, persisted store e skip-existing nunca colidem entre os
dois, chave `{saturday}-{mode}`).

**`--mode both` (#5349): roda os 2 modos numa única invocação.** Em vez de
invocar a skill 2x na semana, `--mode both` dispara `highlights` e depois
`clicked` dentro da MESMA chamada — cada um com seu próprio agendamento
(sábado/domingo, `DEFAULT_MODE_DAY_OFFSET`), reportando sucesso/falha
independente: uma falha em `clicked` (ex: dado de clique incompleto) não
impede `highlights` de ser agendado, e vice-versa. O processo só sai com
código de erro se PELO MENOS 1 dos 2 modos falhar — o preview/gate humano
(Passos 2-3 abaixo) roda 2x em sequência (uma vez por modo) antes de
qualquer `--schedule`. `--mode clicked`/`--mode highlights` continuam
disponíveis pra quem preferir rodar um de cada vez (ex: só reagendar um dos
dois depois de corrigir algo). **`--day-offset` não compõe com `--mode
both`** (cada modo precisa do seu offset padrão próprio) — passar os dois
juntos aborta cedo com erro explícito; sobrescrever offset exige rodar os
modos separadamente.

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
mudar o tamanho comum). Item de RADAR (modo `clicked`) também recebe o mesmo
`carouselFontSize` (repassado como `fontSizeOverride` a
`resolveOrGenerateSectionCardUrl` — a padronização visual vale pro
carrossel inteiro) — a diferença é só o MECANISMO de geração/cache: RADAR
usa o caminho sob demanda (#4513, ver abaixo), não o cache
`06-news-cards.json` de `weekly-carousel-news-card.ts` usado por D1/D2/D3.

**Renomeada de `/diaria-semanal` pelo #4483 (260803).** Duas decisões
anteriores da issue #4101 foram SUPERSEDIDAS — releia esta seção antes de
mexer no arquivo, o histórico do #4101 não reflete mais o comportamento
atual:

- **Canal: era só Instagram (#4483), Facebook E Threads voltaram pelo
  #5348 — LinkedIn e X seguem de fora.** Motivo do #4483 pra tirar
  LinkedIn: a newsletter semanal do LinkedIn (`/diaria-linkedin-semanal`,
  #4456) passou a cobrir o recap de segunda — manter o post de sábado no
  LinkedIn duplicaria o recap com 2 dias de distância, e a newsletter
  ganha em alcance (notificação + e-mail, fora do ranqueamento de feed).
  **Essa lógica NÃO se aplica a Facebook/Threads** — não existe recap
  semanal nativo em nenhum dos 2 — nem o editor os resgatou por esse
  motivo: foi uma decisão nova e própria (260815, #5348), "alcance/
  audiência adicional". Facebook saiu completo numa 1ª rodada (PR #5360);
  Threads exigiu uma unidade dedicada pra implementar carrossel de imagem
  com polling obrigatório de status no publisher, que não existia. Ver
  seção "#5348: expansão pra Facebook e Threads" abaixo pro detalhe
  completo (X nunca foi mencionado de novo).
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
- `--mode clicked|highlights|both` — qual dos dois carrosséis rodar (ver
  tabela acima). **Se omitido na invocação da SKILL (#5903, 260821): default
  — `both`, e imprimir banner** `--mode não informado — assumindo both (uso
  semanal normal, os 2 carrosséis). Passe --mode clicked|highlights
  explicitamente para rodar só um dos dois.` — mesmo padrão do
  `AAMMDD-do-sabado` acima, nunca rodar só 1 carrossel em silêncio.
  Achado ao vivo 260821: antes do #5903 esta mesma seção documentava
  "Default `clicked`" pro `--mode` omitido — correto SÓ para quem chama
  `scripts/publish-weekly-social.ts` DIRETO (back-compat de invocações de
  antes do #5330, o script preserva esse default), mas ambíguo pra quem
  invoca a SKILL (`/diaria-instagram-semanal`, sem args — o uso normal
  semanal), que seguia o default do script e publicava só metade do
  trabalho da semana sem nenhum aviso. `both` (#5349) roda os 2 modos numa
  única invocação, cada um reportando sucesso/falha independente; o
  preview/gate humano (Passos 2-3 abaixo) roda 2x em sequência (uma vez por
  modo) antes de qualquer `--schedule`. `--mode clicked`/`--mode
  highlights` explícitos continuam disponíveis pra quem quiser rodar um de
  cada vez (ex: só reagendar um dos dois depois de corrigir algo).
  **`--day-offset` não é compatível com `--mode both`** (ver seção acima).
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
- `--force-urls url1,url2,...` (#5905) — override manual da seleção
  algorítmica: lista de URLs separadas por vírgula, na ordem desejada do
  carrossel, substituindo `selectInstagramWeekly`/`selectInstagramHighlights`
  por uma escolha explícita do editor. Cada URL precisa casar com um
  candidato ELEGÍVEL do pool da semana (não-comercial/afiliado/próprio) —
  URL fora do pool ou bloqueada pela mesma exclusão comercial aborta com erro
  nomeando qual. Não compõe com `--mode both` (highlights e clicked têm pools
  de candidatos diferentes — rode os modos separados pra forçar os 2). No
  modo `clicked`, a intro da caption troca automaticamente pra uma frase
  neutra ("Os destaques da semana"), já que "os mais clicados" deixaria de
  ser verdade. Todo o resto do pipeline (imagem, agendamento, persistência)
  roda igual. Uso típico: o editor revisou o ranking completo (fora desta
  skill, ex: consultando `weekly-instagram-select.ts` diretamente) e discorda
  do desempate por ruído da seleção automática pra esta rodada.

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
- Credenciais Instagram/Threads (mesmas dos publishers diários):
  `DIARIA_LINKEDIN_CRON_URL` + `DIARIA_LINKEDIN_CRON_TOKEN` (Worker queue —
  mesmo endpoint usado pelo Instagram/Threads/LinkedIn diários,
  `channel: "instagram"`/`channel: "threads"`). Credenciais Threads
  propriamente ditas (`THREADS_ACCESS_TOKEN`/`THREADS_USER_ID`) vivem no
  ambiente do Worker (`workers/linkedin-cron`), não neste script — se
  ausentes no Worker, o dispatch do Threads marca `status:"dlq"` (via
  `fireQueueEntry`) sem afetar Instagram/Facebook.
- Credenciais Facebook (#5348, mesmas do publisher diário `publish-facebook.ts`):
  `FACEBOOK_PAGE_ID` + `FACEBOOK_PAGE_ACCESS_TOKEN` (opcional `FACEBOOK_API_VERSION`,
  default `v25.0`). Ausentes → o dispatch do Facebook marca `status:"failed"`
  com `reason:"facebook_not_configured"` e segue em frente — NUNCA impede
  Instagram/Threads de publicar (canais são independentes, ver seção #5348
  abaixo).
- Para cada edição candidata a contribuir um item de DESTAQUE (D1/D2/D3): o
  card do carrossel é RECOMPOSTO com o tamanho de fonte único da rodada
  (#5345, ver seção "Slide de capa e CTA final" acima) — não mais lido pronto
  de `06-public-images.json`. O pré-requisito real é a arte-base do destaque
  já existir no disco na edição de origem (`04-{destaque}-4x5-nativo.jpg`,
  ou fallback `04-{destaque}-master.jpg`/`04-{destaque}-2x1.jpg` — mesma
  ordem de preferência de `gen-social-card-4x5.ts`), produzida pelo Stage 3
  diário. Sem essa arte-base, a recomposição falha e o carrossel inteiro
  falha junto (não publica parcial, ver Passo 3). Item de RADAR NÃO passa
  pelo cache de recomposição (`06-news-cards.json`) — o card 4:5 é gerado SOB
  DEMANDA (#4513, ver `scripts/lib/weekly-instagram-ondemand-card.ts`) só se
  o item vencer o ranking, mas recebe o MESMO `carouselFontSize` da rodada
  (o padrão visual do carrossel vale pra todos os itens, RADAR incluso —
  muda só o mecanismo de geração); a mesma regra de "falha o carrossel
  inteiro em vez de publicar parcial" vale se a geração sob demanda falhar
  (ex: crédito de API esgotado, fonte de marca ausente na máquina).

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
- A caption formatada do Instagram, Facebook E Threads (#5348) — MESMOS
  títulos numerados; Instagram/Facebook incluem 1 linha de contexto (`why`
  do destaque, ou a 1ª frase de `body` pra RADAR), Threads NÃO (orçamento
  de 500 chars do canal não sobra pra isso com 5 itens, ver
  `format-weekly-social.ts`). A CTA final também diverge por canal:
  Instagram "link na bio"; Facebook/Threads link clicável direto no corpo.
  Desde o #5345, a linha de contexto (Instagram/Facebook) sai SEMPRE
  inteira, sem truncar em N chars por item (um cap de 140 chars cortava a
  frase no meio, ilegível) — no Instagram a única rede de segurança é o
  limite de 2200 chars da caption INTEIRA (`truncateAtLimit`,
  `format-weekly-social.ts`), que corta preservando palavras inteiras se o
  total estourar; Facebook não tem esse cap; Threads tem um cap MUITO mais
  apertado (500 chars, imposto pela própria API).
- O horário de agendamento planejado (sábado pra `highlights`, domingo pra
  `clicked`) — MESMO horário pros 3 canais.

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
skip-existing — chave `destaque: "weekly-{mode}"` por `platform` (3 canais
desde o #5348: `instagram`/`facebook`/`threads`), os dois modos nunca
colidem no mesmo arquivo, e os canais nunca colidem entre si):

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
card pré-existente tem o card gerado SOB DEMANDA nesse momento (#4513),
recebendo o MESMO `carouselFontSize` da rodada via `fontSizeOverride` — o
que muda é só o mecanismo de geração/cache, não o tamanho de fonte
aplicado. Capa/CTA (paleta clara, auto-size —
ver seção acima) são gerados/upados sob demanda na 1ª execução e cacheados
depois (`data/weekly/{saturday}-{mode}/_internal/06-flat-cards.json` — ver
`scripts/lib/weekly-flat-card.ts`). Se QUALQUER item de notícia não resolver
imagem (falha de leitura, recomposição OU geração sob demanda), o post
inteiro falha (nunca publica carrossel parcial) — capa/CTA falhando também
aborta o post inteiro pela mesma razão.

**O MESMO `--schedule` acima já dispara Facebook E Threads (#5348) — não é
preciso passo/flag adicional.** Ver seção dedicada logo abaixo.

## #5348: expansão pra Facebook e Threads

Decisão do editor, 260815: publicar o MESMO carrossel (7 slides — capa +
itens + CTA, idênticas às imagens do Instagram) também no Facebook e no
Threads, com o MESMO `scheduledAt` (`computeWeeklyScheduledAt`),
automaticamente junto do Instagram — sem flag/canal separado. Implementado
em 2 rodadas: Facebook saiu completo numa 1ª unidade (PR #5360); Threads
exigiu uma unidade dedicada (mesma issue #5348) porque o publisher de
Threads deste repo era TEXT-only e precisou de carrossel de imagem +
polling de status construídos do zero — ver subseção própria abaixo.
Implementado dentro de `runOneMode` em `scripts/publish-weekly-social.ts`:
os 3 canais compartilham seleção, resolução de imagem (`carouselImageUrls`)
e horário; cada um tem seu próprio dispatch, skip-existing e bookkeeping de
falha — **um canal falhando NUNCA desfaz nem impede os outros**. Diferenças
por canal:

- **Publisher**: Instagram e Threads passam pelo MESMO Worker queue
  (`postToWorkerQueue`, `channel: "instagram"`/`channel: "threads"`, agenda
  via cron do Worker) — a publicação real (e, no caso do Threads, o
  polling de status) acontece no momento do disparo agendado, não no
  enqueue. Facebook chama a Graph API DIRETO — sem Worker/cron —, porque a
  Graph API agenda nativamente (`scheduled_publish_time`), o mesmo padrão
  já usado pelo publisher DIÁRIO (`publish-facebook.ts`). Função
  `publishFacebookCarouselByUrl` (`scripts/publish-facebook.ts`): N
  `POST /{page-id}/photos` (uma por imagem, `url=<CDN>`, `published=false`)
  seguidos de 1 `POST /{page-id}/feed` com `attached_media[i]` indexado +
  `message` + `scheduled_publish_time`. Falha em QUALQUER foto aborta o
  carrossel inteiro (nunca publica parcial — mesma decisão de escopo do
  carrossel do Instagram, #4153).
- **Caption**: `formatFacebookWeekly`/`formatThreadsWeekly`
  (`scripts/lib/format-weekly-social.ts`) — MESMOS títulos/ordem do
  Instagram. Facebook mantém a linha de contexto (`why`/1ª frase de `body`)
  igual ao Instagram, com a CTA final trocada por um link CLICÁVEL direto
  pro arquivo (Facebook permite link no corpo do post; Instagram não, daí
  "link na bio"); sem o cap de 2200 chars do Instagram. Threads OMITE a
  linha de contexto (só título numerado) — a Threads API rejeita texto
  >500 chars (`fireThreads`/`handleEnqueue` no Worker), orçamento que não
  sobra pra 5 linhas de contexto — e também usa link clicável direto,
  como o Facebook.
- **Persisted store**: `06-weekly-published.json` ganha `platform:"facebook"`
  e `platform:"threads"` ao lado de `"instagram"`, mesma chave
  `destaque:"weekly-{mode}"` — skip-existing é POR CANAL (um já publicado
  não impede os outros de tentar numa re-run parcial).
- **Credenciais ausentes**: Facebook (`FACEBOOK_PAGE_ID`/
  `FACEBOOK_PAGE_ACCESS_TOKEN`) — checagem SÍNCRONA, inline, neste script →
  entry `status:"failed"`, `reason:"facebook_not_configured"`, visível
  imediatamente em `06-weekly-published.json`. Threads
  (`THREADS_ACCESS_TOKEN`/`THREADS_USER_ID`, no ambiente do WORKER, não
  deste script) é diferente: este script só checa se o Worker QUEUE está
  configurado (`DIARIA_LINKEDIN_CRON_URL`/`DIARIA_LINKEDIN_CRON_TOKEN`) —
  sem visibilidade sobre as credenciais Threads em si, que só são
  verificadas depois, ASSINCRONAMENTE, quando o cron do Worker de fato
  dispara o post agendado. O enqueue aqui sempre grava `status:"scheduled"`
  se o Worker aceitou a entry — se a credencial Threads faltar no Worker, o
  `dlq` que `fireQueueEntry` retorna acontece SÓ no lado do Worker, na hora
  do disparo, e **não é reconciliado de volta** em
  `06-weekly-published.json` (achado do self-review, #5348 — nenhum
  mecanismo hoje lê o resultado do fire de volta pra esse arquivo). Auditar
  uma falha silenciosa de credencial Threads via logs/KV do Worker
  (`diaria-linkedin-cron`), não via este arquivo. Nenhum dos 2 cenários
  trava Instagram nem os outros canais.

### Threads: carrossel de imagem com polling obrigatório de status

O publisher de Threads deste repo (`fireThreads`,
`workers/linkedin-cron/src/dispatch.ts`) era **TEXT-only** antes desta
unidade — não implementava NENHUM tipo de imagem. A Meta suporta carrossel
na API do Threads (mesmo padrão `media_type: "IMAGE"`/`"CAROUSEL"` do
Instagram), mas com uma diferença estrutural: **a Threads API não garante
`FINISHED` imediato pra containers de imagem** — publicar um
`creation_id` cujo container ainda está `IN_PROGRESS` falha na API.
Diferente do poll BEST-EFFORT que `fireInstagramSingle` já faz pro
Instagram (2 tentativas, ~3s, segue pro publish mesmo sem confirmar), o
Threads precisa de poll **OBRIGATÓRIO e FAIL-CLOSED**:
`pollThreadsContainerStatus` tenta até `THREADS_POLL_MAX_ATTEMPTS` (10,
~2s de intervalo — teto FIXO, nunca poll infinito) e só segue adiante se
o `status` responder `FINISHED`; `ERROR`/`EXPIRED` abortam IMEDIATO sem
esperar esgotar as tentativas; timeout/erro de rede/resposta não-JSON
também abortam (fail-closed). Isso vale pros DOIS caminhos com imagem:

- `fireThreadsSingleImage` (1 imagem — `entry.image_urls.length === 1`):
  container `media_type: "IMAGE"` direto + poll obrigatório + publish.
- `fireThreadsCarousel` (2+ imagens): N containers filhos
  (`media_type: "IMAGE"`, `is_carousel_item: true`) — cada um com poll
  obrigatório ANTES do próximo passo poder referenciá-lo por id — seguidos
  de 1 container pai (`media_type: "CAROUSEL"`, `children=[ids]`, `text`),
  com o MESMO poll obrigatório, e só então `threads_publish`. Falha em
  QUALQUER passo — inclusive o poll de um único container — aborta o post
  inteiro (`status: "dlq"`, nunca "failed"/retriable): mesma decisão de
  escopo do carrossel do Instagram (#4153), publicar um carrossel
  incompleto é pior que não publicar.

O caminho TEXT-only original (`fireThreadsText`, sem imagem — posts fora
deste carrossel semanal) continua sem poll, inalterado desde o #3944 Parte
B. Testes: `workers/linkedin-cron/test/threads-carousel.test.ts` (happy
path com poll, timeout fail-closed com teto finito, `ERROR` abortando
imediato, falha parcial não publica) e
`test/format-weekly-social.test.ts` (`formatThreadsWeekly`, UTM próprio,
limite de 500 chars).

**A skill NÃO foi renomeada** apesar de deixar de ser Instagram-only — o
nome `diaria-instagram-semanal` continua refletindo o produto PRINCIPAL
(seleção/carrossel são todos desenhados em torno do feed do Instagram;
Facebook/Threads são réplicas automáticas do mesmo material). Renomear
tocaria múltiplas referências cruzadas (`diaria-linkedin-semanal/SKILL.md`,
`weekly-social-click-rank.ts`, `format-weekly-social.ts`) sem ganho
funcional — decisão de escopo do #5348, mantida mesmo com os 3 canais
completos.

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
