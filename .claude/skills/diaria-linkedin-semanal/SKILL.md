---
name: diaria-linkedin-semanal
description: Newsletter semanal do LinkedIn (perfil pessoal, #4456) — 3 matérias da semana selecionadas por clique verificado + bloco Use Melhor (comentário do editor opcional, #5970) + "Edições da semana" (link + destaques das 5 edições). Produzida domingo, publicada segunda ~09:30 BRT (artigo colado à mão — LinkedIn não tem API de publicação de newsletter). Uso — `/diaria-linkedin-semanal --publish-monday AAMMDD`.
disable-model-invocation: true
---

# /diaria-linkedin-semanal

Monta o artefato colável da newsletter semanal do LinkedIn (issue #4456):
3 matérias da semana que acabou (segunda a sexta), selecionadas por **taxa
de clique verificado** — não pela posição na edição de origem — mais o
bloco **Use Melhor** (comentário do editor opcional, #5970) e a seção
**Edições da semana** — as 5 edições, cada uma com link + seus até-3
destaques.

**A spec desta skill mudou várias vezes ao longo do dia 260802 — os
comentários da issue #4456 têm precedência sobre o corpo original.** Se
você (ou um agente futuro) for alterar este arquivo, releia a issue
inteira antes — não só o body.

## Decisões do editor já tomadas (não são desta skill pra revisitar)

- **Canal: newsletter nativa do LinkedIn** (perfil pessoal do editor, não a
  Page) — diferente de `/diaria-instagram-semanal` (post de feed, só
  Instagram desde #4483, sábado, com ranking por clique restrito a
  D1/D2/D3). As duas skills seguem **separadas** (ver "Sobreposição"
  abaixo) — não fundir, não renomear esta.
- **Seleção: por clique verificado, não por manchete.** A regra antiga
  "só DESTAQUE 1" foi substituída em 260802 — matéria secundária, item de
  Radar ou entrada de Use Melhor são candidatos legítimos quando o clique
  justificar. Ver `scripts/lib/weekly-linkedin-select.ts`.
- **Seleção: CTOR puro decide fora do ruído; dentro do ruído, o editor
  decide no gate (#5109, decisão do editor).** Até 260812, um empate dentro
  do ruído de 1 clique (`withinClickNoise`) era resolvido automaticamente
  por `editorialTiebreakScore` (ângulo Brasil > implicação profissional >
  diversidade de categoria) — achado ao vivo do ciclo `26w32`: a banda
  engoliu 6 candidatos e produziu 3× RADAR seguidos, com um candidato de
  🔒 SEGURANÇA (CTOR de topo) perdendo nas 3 rodadas pra candidatos de CTOR
  MENOR. A partir de agora `editorialTiebreakScore` só é DICA exibida no
  gate, nunca decisor — ver Passo 3.
- **Sem link por destaque.** O texto de manchete já É o conteúdo completo —
  um link de volta pra edição de origem prometeria mais do que existe. A
  seção "ATERRISSAGEM" que existiu numa versão intermediária da spec foi
  **removida**. **Exceção textual, não-linkada (#5109):** cada manchete leva
  uma linha "da edição de DD/MM" logo abaixo do título — sinaliza de qual
  das 5 edições da semana ela veio (sem isso o leitor precisava abrir
  "Edições da semana" e cruzar os 5 links pra achar), mas é TEXTO puro, não
  `<a href>` — a decisão de não-linkar continua de pé.
- **Título literal + numeração.** Nunca reescrever o título do bloco de
  origem — só prefixar "1.", "2.", "3.". Vale mesmo depois do #5108 abaixo:
  só o CORPO da manchete virou resumo autoral, o título continua sempre
  literal.
- **Corpo da manchete: resumo próprio a partir da fonte primária, não mais
  "levantar literal" (#5108, decisão do editor 260812 — reverte a decisão
  original registrada no #4456, comentário registrando a reversão lá).**
  Motivado por um achado concreto do ciclo `26w32`: a seleção por clique
  escolheu 3 itens de Radar, cujos corpos levantados somavam 461 caracteres
  nos três blocos, contra ~700-800 caracteres de um único destaque — pouco
  substância pra uma peça inteira. Consequência direta: a isenção de
  humanizador/Clarice/fact-check que o `#4456` original dava ao bloco de
  manchete (por ser texto já revisado na edição diária de origem) só se
  aplica a manchetes que PERMANECEM literais (fonte ficou inacessível desde
  a edição de origem, ver Passo 4) — a regra agora é **"texto levantado
  nunca passa por humanizador/Clarice/fact-check, texto autoral sempre
  passa"** (Passos 4-6).
- **Use Melhor é obrigatório sempre que há candidato elegível — comentário
  do editor é OPCIONAL (#5970, reverte a regra anterior "sem comentário,
  o bloco inteiro sai da edição").** A skill **nunca inventa** esse
  comentário — é voz pessoal do editor, critério 2 do rubrico "Perguntar é
  exceção" (`CLAUDE.md`) — mas também não trava mais o ciclo esperando por
  ele. Sem comentário, o bloco renderiza igual (título + link + descrição +
  CTA, curadoria normal), só sem o parágrafo de comentário — mecânico em
  `renderLinkedinWeeklyHtml` (`scripts/lib/weekly-linkedin-render.ts`), que
  grava um warning explícito (banner de default aplicado, regra do #5321)
  sempre que isso acontece. `--use-melhor-comment` continua existindo pra
  quem quiser passar um comentário (Passo 7).
- **Imagem de capa é obrigatória (#5536).** `render-linkedin-weekly.ts`
  (Passo 7) copia mecanicamente `04-d1-2x1.jpg` da edição de origem da
  manchete #1 pra `data/weekly/{cycle}/`, fail-soft se a imagem não
  existir mais (edição arquivada). Sem esse passo, 2 ciclos seguidos
  (`26w32`, `26w33`) saíram sem capa até o editor perguntar "onde está a
  imagem?" — ver Passo 7 e `context/publishers/linkedin.md` §3.
- **Edição #1 não é mais exceção** (260802, último comentário) — cobre a
  janela normal como qualquer outra. Não tratar a primeira invocação
  desta skill como recorte mensal/moldura de estreia.
- **Seção final chama "Edições da semana", não "Resto da semana"** (260802,
  decisão do editor) — e não é mais só as edições que perderam a manchete:
  lista as edições da semana com D1 parseável (até 5 — pode ser menos em
  semana curta/feriado), cada uma com link (`deriveEditionUrl` a partir do
  D1) + os até-3 destaques daquele dia, independente de um deles já ter
  virado manchete acima. Implementado em `scripts/select-linkedin-weekly.ts`
  (campo `weeklyEditions` no `ln-selection.json`, populado em
  `readEdition`/`destaqueTitles`, com guard de colisão de URL derivada — 2
  D1 que produzem o mesmo slug geram warning explícito) e
  `scripts/lib/weekly-linkedin-render.ts` (`editionLabel` gera o rótulo
  "Edição de DD/MM" do link; cada destaque some como sub-item de lista).
  Resolve o achado #4489 finding 8b (se o item devia ter mais que o
  título).

## Argumentos

- `--publish-monday AAMMDD` — é o AAMMDD da SEGUNDA em que o artigo será
  publicado — a janela de conteúdo (segunda a sexta) é resolvida
  automaticamente como a semana ANTERIOR a essa data
  (`resolveWeeklyLinkedinCycle` em `scripts/lib/weekly-linkedin-cycle.ts`).
  **Se omitido (#5321, "Perguntar é exceção"): default — a próxima
  segunda-feira** (`nextMondayAAMMDD()`, mesmo módulo — se hoje já for
  segunda, resolve pra hoje) — e imprimir banner: `--publish-monday não
  informado — assumindo {AAMMDD} (próxima segunda). Passe explicitamente
  para outra data.` Nunca inferir silenciosamente sem o banner.

O **ciclo** (`{YY}w{WW}`, ex: `26w31`) é derivado da semana de CONTEÚDO
(não da segunda de publicação) e usado como namespace de diretório
(`data/weekly/{cycle}/`) e como `utm_campaign` (`ln-{cycle}`).

## Pré-requisitos

- As edições da semana (segunda a sexta) precisam ter
  `data/editions/{AAMMDD}/02-reviewed.md` no disco — mesmo risco de
  retenção documentado em `/diaria-instagram-semanal` (se
  `data/editions/{AAMMDD}/` for arquivado antes de rodar esta skill, essa
  edição não pode ser recuperada pro cálculo).
- `data/beehiiv-cache/posts/*.json` — populado por `scripts/beehiiv-sync.ts`
  (roda automaticamente no Stage 0 de cada edição diária). Não precisa
  rodar manualmente, mas o Passo 1 abaixo checa se falta enriquecimento de
  clicks pros posts da janela.

## Passo 1 — Checar se falta enriquecimento de clicks

```bash
npx tsx scripts/select-linkedin-weekly.ts --publish-monday {AAMMDD} --manifest-only
```

Imprime `{cycle, contentWindow, editionsFound, posts_needing_clicks}`.
**Por que este passo existe:** o gate de estabilização de CTR do pipeline
diário (`MIN_AGE_DAYS_FOR_CLICKS = 7`, `scripts/lib/shared/ctr-config.ts`)
NUNCA enriquece posts com menos de 7 dias — e os posts desta janela têm
entre 2 e 6 dias no momento em que esta skill roda (domingo, semana que
acabou de terminar). Sem este passo explícito, a seleção rodaria com
clicks zerados pra toda a semana.

Se `posts_needing_clicks` for não-vazio:

```
Agent(subagent_type="beehiiv-clicks-enricher", prompt=<manifest items uma por linha>)
```

Mesmo agent reusado do Stage 0 diário (0h.2) — cada item do prompt no
formato `post_id=<id> title=<title>`, um por linha. **Não reinventar** um
enricher próprio — MCP `list_post_clicks` só roda de subagent/top-level
com a tool declarada, nunca de script TS standalone (ver docstring de
`scripts/lib/weekly-linkedin-clicks.ts`).

Se `posts_needing_clicks` já vier vazio (todos os posts da semana já
enriquecidos — ex: alguém já rodou o Stage 0 de uma edição posterior que
puxou esses posts pro gate normal), pule direto pro Passo 2.

## Passo 2 — Rodar a seleção de verdade

```bash
npx tsx scripts/select-linkedin-weekly.ts --publish-monday {AAMMDD}
```

Escreve `data/weekly/{cycle}/_internal/ln-selection.json` com: manchetes
selecionadas (rank + auditoria completa dos candidatos, inclusive
excluídos por serem comercial/próprio), candidato de Use Melhor, Edições
da semana (`weeklyEditions` — as 5 edições, link + destaques de cada
uma), e warnings (empates dentro do ruído de 1 clique, edições
faltando, etc — ver `scripts/lib/weekly-linkedin-select.ts`).

**Empate dentro do ruído de 1 clique maior que as vagas restantes (#5109):**
`headlines` pode sair mais curto que o cap (2 ou 3), e o JSON traz
`pendingGroup` (não-nulo) com os candidatos disputando — CTOR não decide
sozinho aqui, a escolha vai pro editor no Passo 3. Se `pendingGroup` vier
`null`, a seleção já está completa e o Passo 3 não precisa da etapa de
escolha manual.

**Semana curta (feriado):** se `editionsFound < 5`, o script já reduz o
número de manchetes automaticamente (`computeHeadlineCap`) — nunca puxa
conteúdo da semana anterior pra completar 3. Se `editionsFound === 0`, o
script aborta (exit 1) — reporte ao editor em vez de prosseguir.

## Passo 3 — Gate humano: resolver empate pendente + apresentar seleção + pedir texto novo

### 3a. Se `pendingGroup` não for `null`: escolha manual do empate (#5109)

Mostrar ao editor o grupo inteiro empatado, com as colunas que a decisão
precisa (não só a taxa — cliques/opens absolutos e tipo, #5109 item 4):

```
⚖️  Empate dentro do ruído de 1 clique — {N} candidatos disputam {pendingSlots} vaga(s):

  [{taxa}% · {cliques}cl/{opens}op · {tipo}] {título} ({edição de origem}, {seção})
  ...

Dica de desempate editorial (ângulo Brasil > implicação profissional >
diversidade de categoria) — NÃO decide, só informa: {título} tem o maior score ({N})

Escolha {pendingSlots} candidato(s) (ordem = ordem de exibição das manchetes):
```

`tipo` é `destaque` (`kind === "destaque"`) ou `section` (`kind ===
"section"`) — sinaliza quanto corpo levantado já existe pra base do resumo
autoral do Passo 4 (destaque tem corpo completo; item de seção só tem 1
linha). Depois da resposta do editor, re-rodar:

```bash
npx tsx scripts/select-linkedin-weekly.ts --publish-monday {AAMMDD} \
  --picks {url-1},{url-2}
```

na ORDEM escolhida pelo editor. Erro explícito (exit 2) se a contagem não
bater com `pendingSlots` ou alguma URL não pertencer ao `pendingGroup` —
apresente o erro ao editor e peça de novo, nunca adivinhe/complete
sozinho. `pendingGroup` sai `null` no JSON re-escrito quando resolvido.

### 3b. Apresentar a seleção final (sempre, com ou sem 3a)

```
📰 LinkedIn semanal — ciclo {cycle} (segunda {AAMMDD})

Manchetes selecionadas (por taxa de clique verificado):
  1. [{taxa}% · {cliques}cl/{opens}op · {tipo}] {título} ({edição de origem}, {seção})
  2. ...
  3. ...

Use Melhor: {título ou "nenhum candidato elegível"}

Edições da semana: {N} edições (link + destaques cada)

{warnings, se houver}

Aprovar seleção? sim / trocar {N} por outro candidato / abortar
```

Se aprovado, pedir ao editor (nunca gerar sozinho) os 2 textos que seguem
obrigatórios:
1. **Abertura** (1 parágrafo curto identidade+promessa+cadência).
2. **Fecho** (1 parágrafo curto antes do CTA final).

**Comentário do Use Melhor deixou de ser pergunta bloqueante (#5970).** A
skill nunca inventa esse texto (é voz pessoal do editor), mas também não
espera por ele: se o editor oferecer um comentário espontaneamente nesta
conversa, use-o no Passo 7 (`--use-melhor-comment`); do contrário siga sem
perguntar — o bloco Use Melhor sai com curadoria normal (link + descrição),
sem o parágrafo de comentário, e `renderLinkedinWeeklyHtml` grava um
warning sinalizando o default aplicado (avise o editor disso no resumo do
Passo 8 — ele pode sempre colar um comentário depois, direto no artigo).

## Passo 4 — Checar acessibilidade da fonte + escrever resumo próprio de cada manchete (#5108, troca automática #5538)

```bash
npx tsx scripts/verify-linkedin-weekly-sources.ts --cycle {cycle}
```

Verifica CADA `headlines[].url` da seleção FINAL (já com o Passo 3a
resolvido, se havia) via o mesmo verificador do Stage 1 diário
(`scripts/verify-accessibility.ts`) e grava `sourceAccessibility` de volta
em cada headline de `ln-selection.json`. Um link acessível na edição de
origem (dias atrás) pode ter virado paywall/indisponível desde então —
resumir um stub é pior que não resumir.

**#5538 — manchete `kind === "section"` com fonte inacessível troca
automaticamente de candidato, nunca publica o stub de 1 linha.** O corpo
levantado de um item de seção (RADAR/LANÇAMENTOS/VÍDEOS que virou manchete
por clique) é só 1 linha — publicável como stub quando a fonte segue
acessível (não é o caso ideal, mas é aceitável), fraco demais quando a
fonte caiu e não dá pra escrever resumo próprio. Quando isso acontece, o
script troca sozinho pelo PRÓXIMO candidato elegível do ranking
(`headlineCandidatesRanked`, já exclui comercial/própria/use_melhor/já-
selecionados), verificando a acessibilidade de cada candidato até achar um
usável — `kind === "destaque"` é aceito incondicionalmente no papel de
reposição (corpo já completo). Se o pool inteiro se esgotar sem achar
reposição, mantém o stub original como antes (fallback, não trava a
skill). A troca é **automática, sem reabrir o gate do Passo 3** — decisão
do editor registrada no #5538: o Passo 3 já decidiu QUAIS matérias
competem; uma fonte que morreu depois disso é o mesmo tipo de evento que
"esse candidato não tinha clique suficiente", não um novo trade-off
editorial. `ln-selection.json` grava a troca em `warnings` (mensagem
"trocada por... (#5538)") e o script imprime no console — sempre relate
ao editor no resumo do gate/entrega quais manchetes trocaram e por quê.
**`kind === "destaque"` inacessível NUNCA troca** (comportamento
inalterado — o corpo levantado já é substancial, publicável como stub).

Para cada manchete (já com eventuais trocas do #5538 aplicadas):

- **`sourceAccessibility.accessible === true`:** `WebFetch` a URL e
  **escreva um resumo próprio** (2-4 parágrafos curtos, tamanho comparável
  ao de um destaque da diária — não copie frases da fonte) + 1 frase de
  "por que isso importa" quando fizer sentido, preservando os fatos sem
  fabricar nada além do que a fonte sustenta. Atualize
  `data/weekly/{cycle}/_internal/ln-selection.json` — edição cirúrgica
  (`Edit`, só os campos desta manchete): `headlines[i].body`,
  `headlines[i].why` (se aplicável) e `headlines[i].textOrigin = "autoral"`.
  **Título permanece literal, intocado.**
- **`sourceAccessibility.accessible === false`:** mantenha o corpo
  LEVANTADO que já veio da seleção (Passo 2, ou do candidato de reposição
  se houve troca #5538 e mesmo assim ele saiu inacessível — só acontece pra
  `kind === "destaque"`, que nunca troca) — não escreva resumo. Marque
  `headlines[i].textOrigin = "literal"` e avise o editor no resumo do gate
  que essa fonte específica ficou inacessível desde a edição de origem.

O campo `textOrigin` (literal|autoral) é o que os Passos 5-6 usam pra
decidir tratamento — nunca pule esta escrita, mesmo pra manchetes que
ficaram literais (a ausência do campo é tratada como "não decidido ainda",
não como "literal por default").

## Passo 5 — Humanizador + Clarice (texto NOVO — inclusive manchetes autorais, #5108)

**Regra atualizada (#5108, reverte parte do #4456 original): "texto
levantado nunca passa por humanizador/Clarice, texto autoral sempre
passa."** Não é mais "manchete nunca passa" — é por `textOrigin`
individual de cada manchete (ver Passo 4).

Para os 3 textos sempre-novos (abertura, fecho, comentário Use Melhor) **e**
para cada manchete com `textOrigin === "autoral"` (`body`/`why`):

```
Skill("humanizador", "Humanize este texto em português, mantendo o
sentido: <texto>")
```

Depois:

```
mcp__clarice__correct_text(<texto humanizado>)
```

Aplique **todas** as sugestões da Clarice, incondicionalmente (texto curto
— não precisa de `clarice-apply.ts`) — nunca apresente as sugestões como
menu de escolha ao editor, relate o que mudou depois de aplicar, não
negocie antes (#4514). **Única exceção:** sugestão que corrompa
identificador técnico ou nome de marca (ex: `diar.ia` → `diária` quebraria
a marca) — nesse caso aplique todo o resto e sinalize só essa ao editor.
Manchetes com `textOrigin === "literal"` continuam ISENTAS (mesma lógica
original do #4456: já revisadas na edição diária de origem, reprocessar
reintroduziria risco factual e deriva de voz sem ganho). Para as manchetes
autorais processadas aqui, atualize `ln-selection.json` (`body`/`why`) com
o texto final humanizado/corrigido — o Passo 7 (render) lê direto de lá.
Guarde também o resultado final dos 3 textos sempre-novos pro Passo 7.

## Passo 6 — Fact-check do texto autoral (#5108)

Se NENHUMA manchete tiver `textOrigin === "autoral"` (todas as fontes
ficaram inacessíveis no Passo 4, ou a semana reduzida só tinha manchetes
literais) — **pule este passo**, não há claim novo pra verificar.

Caso contrário:

```
Agent(subagent_type="fact-checker", prompt=<selection_path=data/weekly/{cycle}/_internal/ln-selection.json, mode="weekly-linkedin", out_path=data/weekly/{cycle}/_internal/ln-fact-check.json>)
```

Reusa o agente existente (`.claude/agents/fact-checker.md` §"Modo LinkedIn
semanal") — verifica só as manchetes `textOrigin === "autoral"` (as
literais já passaram por fact-check na edição diária de origem, mesma
isenção do Passo 5). Sem auto-bloqueio (mesma política de `daily`/
`monthly`): apresente `summary.attention_items` (claims DIVERGENT/
NOT_FOUND_IN_SOURCE/superlativo-sem-suporte) ao editor junto do gate do
Passo 3b (se ainda não passou) ou como aviso separado — o editor decide se
ajusta o resumo antes de renderizar. `DIVERGENT` com `suggested_fix`
populado: aplique a correção diretamente no `body`/`why` da manchete
(edição cirúrgica em `ln-selection.json`) e informe o editor do que mudou.

## Passo 7 — Renderizar o artefato final

```bash
npx tsx scripts/render-linkedin-weekly.ts --cycle {cycle} \
  --opening "{abertura humanizada}" \
  --closing "{fecho humanizado}" \
  --use-melhor-comment "{comentário humanizado, ou omitir a flag inteira se o editor não deu comentário}"
```

(`--opening-file`/`--closing-file`/`--use-melhor-comment-file` aceitam
texto longo via arquivo, mesmo padrão de outros scripts do repo.)

Escreve `data/weekly/{cycle}/ln-{cycle}.html` (fragmento HTML colável —
sem `<html>`/`<body>`, é o payload que vai no `text/html` do
`ClipboardEvent`, ver `context/publishers/linkedin.md` §Newsletter
LinkedIn) e `data/weekly/{cycle}/ln-{cycle}.json` (metadados + warnings).

Se `--use-melhor-comment` foi omitido (ou vazio), o bloco Use Melhor
renderiza normalmente — só o parágrafo de comentário some (#5970, mecânico
em `renderLinkedinWeeklyHtml`); nunca pergunte pelo comentário aqui, isso
não é mais perguntado em lugar nenhum do fluxo (Passo 3 acima).

**Imagem de capa (#5536).** O mesmo comando copia
`data/weekly/{cycle}/04-d1-2x1.jpg` — a imagem 2:1 gerada no Stage 3 da
edição de origem da manchete #1 (`headlines[0]`, não necessariamente o
DESTAQUE 1 literal daquela edição, mas é a única imagem 2:1 disponível
nela). **Obrigatória por decisão registrada (não perguntada — os ciclos
`26w32`/`26w33` já tinham estabelecido esse padrão manualmente antes de
virar mecânico):** roda sempre, sem flag. Fail-soft — se a edição de
origem foi arquivada ou nunca gerou a imagem, a cópia é pulada com warning
em `ln-{cycle}.json`, sem travar o resto do render. `coverImagePath` no
JSON é `null` quando isso acontece; confira antes do Passo 8 se veio
populado.

## Passo 8 — Entregar o artefato ao editor

Publique `ln-{cycle}.html` como Artifact (padrão do repo: entregas vão
como artefato aberto no browser, não `.md`/arquivo solto) pro editor
revisar e copiar. Se `coverImagePath` (Passo 7) veio populado, inclua a
imagem de capa junto (ex: anexada na mensagem/artifact) pro editor subir
no campo de cover image do editor de artigo — se veio `null`, avise que a
edição saiu sem capa e por quê (warning do Passo 7). **Relate também
qualquer warning de "USE MELHOR: comentário do editor ausente" (#5970) —
o default aplicado precisa aparecer visível no resumo da entrega, regra do
#5321, mesmo tratamento dos outros warnings deste passo.** Inclua no
artifact (ou na mensagem) as instruções de publicação de
`context/publishers/linkedin.md` §Newsletter LinkedIn — resumo:

1. Ir em `linkedin.com/newsletters/{urn}/` (a página DA newsletter, não
   o feed pessoal) → clicar **Write article** DALI. Caminho preferido por
   ser o que não depende do default do seletor de destino — mas
   `/article/new/` **não** desvincula o artigo, ao contrário do que esta
   linha afirmava até 260803 (ver `context/publishers/linkedin.md` §1, que
   é a fonte única sobre isso).
2. Confirmar que o cabeçalho do editor mostra o nome da newsletter, não
   "Individual article". **Esta é a verificação que importa**, e vale
   reler antes de publicar, não só ao abrir: em 260803 uma aba que
   recarregou sozinha voltou como "Individual article".
3. Fazer upload de `04-d1-2x1.jpg` (Passo 7) no campo de cover image do
   editor, se `coverImagePath` veio populado.
4. Colar o conteúdo de `ln-{cycle}.html`.
5. Revisar visualmente (numeração, sem link nos blocos de manchete, Use
   Melhor com comentário se presente, CTAs no fim, capa presente se
   aplicável).
6. Publicar.

**SEMPRE agendar, nunca publicar na hora** (corrigido em 260803, ver
"Reuso do agendamento" abaixo). No diálogo que abre no **Next**, usar o
ícone de relógio ao lado do botão Publish. A data certa não basta: a HORA
importa mais que ela, porque o post de feed que acompanha o artigo nasce
com o alcance definido pelo engajamento da primeira hora. Publicar de
madrugada queima o alcance daquele post de forma permanente. Horário
comercial da manhã, na mesma lógica do envio canônico das 06:00 BRT da
diária.

Depois de agendar, o artigo **sai da lista de rascunhos** e
`/article/edit/{id}/` passa a redirecionar pra `/article/new/` — isso é
esperado, não é perda. Conferir em `linkedin.com/article/manage/scheduled/`.

## Reuso do agendamento — decisão: NÃO reusar `/diaria-6-agendamento`

`/diaria-6-agendamento` (`.claude/skills/diaria-6-agendamento/SKILL.md`)
existe pra agendar o ENVIO da newsletter diária no **Beehiiv** — chama a
API/UI do Beehiiv via Claude in Chrome (`context/publishers/beehiiv-playbook.md`
§9-10) e verifica o estado agendado via `scripts/verify-scheduled-post.ts`.

Isso não se aplica aqui, mas **não pelo motivo que esta seção dava antes**.
A versão anterior afirmava que "o LinkedIn não tem agendamento de
newsletter" e concluía daí que não havia o que agendar. A premissa sobre a
**API** continua verdadeira; a conclusão operacional estava errada e foi
corrigida em 260803, ao publicar a edição #1: **a UI agenda** (ícone de
relógio no diálogo do Next, lista em `/article/manage/scheduled/`).

O que de fato não se reusa é o **código**: o Schedule do Beehiiv é
click-e-verifica via `scripts/verify-scheduled-post.ts`, contra a API/UI do
Beehiiv, e não existe equivalente programático aqui — o agendamento do
LinkedIn é ação humana no editor, sem endpoint oficial que dê pra verificar
depois. Do Stage 6 esta skill reusa só o padrão conceitual (gate humano
antes de considerar a unidade "pronta").

## Sobreposição com `/diaria-instagram-semanal` — mantenha separadas

| | `/diaria-instagram-semanal` | `/diaria-linkedin-semanal` |
|---|---|---|
| Seleção | itens mais clicados (D1/D2/D3; RADAR/USE MELHOR ainda não competem — limitação técnica de asset, não decisão de escopo, ver #4513) | 3 matérias por taxa de clique (D1/D2/D3/RADAR/USE MELHOR) |
| Cadência | produz sexta, publica sábado | produz domingo, publica segunda |
| Canal | post social (só Instagram, desde #4483) | newsletter nativa do LinkedIn (perfil pessoal) |
| Formato | 5 itens curtos, carrossel de imagens | 3 blocos longos + Use Melhor + lista |
| Entrega | feed, ranqueado pelo algoritmo | notificação + e-mail, fora do feed |

Decisão do editor (comentário 260802 do #4456): **produtos diferentes,
seguem separados.** `/diaria-semanal` foi renomeada pra
`/diaria-instagram-semanal` e restrita a Instagram pelo #4483 (260803) —
`.claude/skills/diaria-instagram-semanal/` é a skill atual, não mexer nela
daqui.

## Casos de borda

- **0 edições na janela:** `select-linkedin-weekly.ts` aborta (exit 1) —
  reporte ao editor, não prossiga pra render.
- **Menos de 3 edições (feriado):** reduz o nº de manchetes
  automaticamente — nunca puxa da semana anterior.
- **Nenhum candidato Use Melhor elegível na semana:** `useMelhor` sai
  `null` no JSON — sem candidato, não há bloco pra renderizar (diferente do
  caso "há candidato, mas sem comentário", que renderiza normalmente desde
  o #5970 — ver acima). O Passo 3 nunca pergunta pelo comentário em nenhum
  dos dois casos.
- **Empate dentro do ruído de 1 clique maior que as vagas restantes
  (#5109):** `pendingGroup` sai não-nulo — o editor escolhe manualmente no
  Passo 3a (`editorialTiebreakScore` é só dica exibida, não decide mais
  sozinho). Um empate que CABE inteiro nas vagas restantes (ex: 2
  candidatos empatados, 2 vagas) é incluído automaticamente, sem
  ambiguidade real — não gera `pendingGroup`.
- **Fonte da manchete ficou inacessível desde a edição de origem (#5108,
  troca #5538):** `sourceAccessibility.accessible === false` no Passo 4 —
  `kind === "destaque"` fica com o corpo LEVANTADO original (nunca resume
  um stub/paywall), `textOrigin: "literal"`, isenta de humanizador/Clarice/
  fact-check (Passos 5-6). `kind === "section"` troca automaticamente pelo
  próximo candidato elegível do ranking (ver Passo 4) — só cai no mesmo
  tratamento do destaque (stub literal) se o pool de reposição se esgotar
  inteiro sem achar um candidato usável.
- **Nenhuma manchete elegível pra resumo autoral (todas as fontes
  ficaram inacessíveis, ou semana reduzida):** Passo 6 (fact-check) é
  pulado inteiro — sem claim novo pra verificar.
- **Edição de origem da manchete #1 arquivada ou sem `04-d1-2x1.jpg`
  (#5536):** Passo 7 pula a cópia da imagem de capa com warning explícito
  em `ln-{cycle}.json` (`coverImagePath: null`) — o artefato HTML sai
  normalmente, só a capa fica ausente. Avise o editor no Passo 8.

## Outputs

```
data/weekly/{cycle}/
  _internal/ln-selection.json   seleção completa + auditoria (Passo 2) — pendingGroup (Passo 3a), sourceAccessibility + trocas de candidato #5538 + textOrigin/body/why atualizados (Passo 4), texto autoral humanizado (Passo 5)
  _internal/ln-fact-check.json  claims verificados do texto autoral (Passo 6, se houver manchete autoral)
  ln-{cycle}.html                artefato colável (Passo 7)
  ln-{cycle}.json                 metadados do render (Passo 7)
  04-d1-2x1.jpg                   imagem de capa (Passo 7, #5536) — ausente se a edição de origem da manchete #1 não tinha o arquivo (fail-soft, ver coverImagePath em ln-{cycle}.json)
```
