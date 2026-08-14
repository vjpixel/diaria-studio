# context/snippets/ — biblioteca de blocos reutilizáveis

Índice dos blocos de divulgação/CTA reutilizáveis entre edições. Cada arquivo
tem seu próprio comentário-cabeçalho `<!-- ... -->` (fonte primária —
consulte-o para a convenção completa daquele bloco específico); este README é
o mapa de qual bloco existe, onde ele entra na edição, que formato de render
ele produz, e quando o editor deve escolher cada um.

**Isto é sobre catalogar os modelos de conteúdo — a escolha de qual box
entra em qual slot 1/2/3 numa edição específica.** Até o #4626 essa escolha
era 100% manual (config em `platform.config.json` ou paste direto no draft
pelo editor); desde o #4626, os slots 1/2/3 são preenchidos por padrão por
`scripts/select-boxes-by-clicks.ts` — seleção automática por cliques +
tendência de queda + anti-repetição vs. a edição anterior, controlada por
`platform.config.json` → `boxes_divulgacao_auto` (`enabled`, e
`pinned_slots` pra fixar manualmente 1 ou mais slots, que aí voltam a ler
`boxes_divulgacao.slotN` como sempre). Slot 0 (topo) fica de fora dessa
automação — continua manual/opt-in raro, decisão do #4274. Ver a docstring
de `select-boxes-by-clicks.ts` pra precedência completa.

## Onde um box pode entrar

`scripts/stitch-newsletter.ts` monta a edição diária com 5 pontos de encaixe
para conteúdo de divulgação/CTA: 4 slots dinâmicos (topo, D1/D2, D2/D3,
pós-último-destaque) mais 1 posição fixa (PARA ENCERRAR, sempre a mesma
fonte). O parse (`scripts/lib/newsletter-parse.ts`) e o render
(`scripts/lib/newsletter-render-html.ts`) identificam os 4 slots dinâmicos
por **posição + estrutura**, não pelo emoji que abre o texto (marcador-
agnóstico desde #3204/#3232, estendido pro slot 3 em #3476 — um emoji novo,
ou nenhum emoji, ainda funciona; o emoji é só decorativo/cosmético no título
renderizado).

| Slot | Onde fica | Mecanismo | Config |
|---|---|---|---|
| **Topo** (intro callout) | Antes do DESTAQUE 1 | `extractIntroCallout`/`renderIntroCallout` — bloco `**...**` inteiro na região de intro | Auto-gerado (campeões/sorteio) ou colado manualmente pelo editor |
| **Slot 1** (D1/D2) | Lacuna entre DESTAQUE 1 e DESTAQUE 2 | `boxes_divulgacao.slot1` em `platform.config.json` | Auto-injetado por `stitchNewsletter` se o snippet configurado carregar (ver tabela abaixo) |
| **Slot 2** (D2/D3) | Lacuna entre DESTAQUE 2 e DESTAQUE 3 (só existe em edição de 3 destaques) | `boxes_divulgacao.slot2` em `platform.config.json` | Idem slot 1 |
| **Slot 3** (pós-último-destaque, #3476) | Região entre o ÚLTIMO destaque (D3 em edições de 3, D2 em edições de 2) e USE MELHOR — existe em QUALQUER contagem de destaques, diferente do slot 2 | `boxes_divulgacao.slot3` em `platform.config.json` — `extractBoxDivulgacao3`/`locateBoxAfterLastDestaque` | Idem slot 1 |
| **PARA ENCERRAR** | Seção final da edição (diário e mensal) | `buildParaEncerrar` (diário) / `writer-monthly` (mensal) — sempre lê `encerramento-social-apoio.md` | Fixo, não configurável por snippet |

Default atual de `platform.config.json` → `boxes_divulgacao` (#3212/#3476 —
os 3 boxes são permanentes, toda edição traz os 3): `slot1:
"recomendacao-leitura.md"` (recomendação de leitura específica), `slot2:
"livros-divulgacao.md"` (curadoria geral de livros), `slot3:
"apoio-divulgacao.md"` (programa de apoio, apoia.se/diaria — trocado de
`indicacao-ferramenta.md` em #3824, 260722, decisão permanente do editor;
`indicacao-ferramenta.md` segue disponível pra reuso pontual, mesmo padrão
de `clarice-divulgacao.md`).
Se a chave `boxes_divulgacao` estiver ausente do config inteiro,
`stitchNewsletter` cai no default legado pré-#2978 (livros no slot 1, nada
nos slots 2/3 — back-compat).

**#3476: É IA? muda de posição** — passa a renderizar DEPOIS da seção USE
MELHOR (antes ficava fixo logo após o último destaque, #2546). Se a edição
não tiver USE MELHOR, É IA? cai logo após o slot 3 (nunca desaparece,
#1085) — ver `renderHTML` em `scripts/lib/newsletter-render-html.ts`.

**Idempotência:** se a lacuna/região do slot já tiver um box colado
manualmente pelo editor (`boxAlreadyPresentInGap`/
`boxAlreadyPresentAfterLastDestaque`), `stitchNewsletter` pula a
auto-injeção nesse slot — não duplica. `--no-sponsor` (`sponsor: false`)
suprime os 3 slots de uma vez (kill-switch pontual).

## Formato: famílias de render

O formato de render de um box de slot 1/2/3 é decidido pela **estrutura do
próprio conteúdo** (`shouldForceCtaPill` em `newsletter-render-html.ts`), não
pelo slot nem pelo emoji:

- **bold-line / mid-callout** (`renderMidCallout`) — bloco `**Título …
  [link](url)**` compacto, título + corpo + 1 link, tudo dentro do mesmo
  `**...**`. Formato de `clarice-divulgacao.md` e `livros-divulgacao.md`.
- **carrinho / CTA pill** (`renderIntroCallout` com `forceCtaPill=true`) —
  multi-parágrafo SEM bold-wrap, acionado quando (a) tem 2+ links no total,
  ou (b) algum parágrafo é SÓ um link (`[label](url)` ou `→ [label](url)`) —
  o último link vira botão pill centralizado no HTML (legado #3204: um
  marcador `🛒` de abertura também acionava este formato; removido em #3475
  por ser redundante com o sinal (b) em todo conteúdo real observado).
  Formato de `_arquivo/alexa-plus-divulgacao.md`.
- **multi-parágrafo com lista** — mesma família estrutural do carrinho (texto
  plano, sem bold-wrap), mas com um bloco de lista `- item` no meio que vira
  `<ul><li>` real no HTML. Formato de `apoio-divulgacao.md`.
- **disclosure "● DIVULGAÇÃO"** — não é um formato de LAYOUT, é um kicker
  acima do box. Comportamento **diferente por slot** (atenção, não confundir):
  - **Slot 1, Slot 2 e Slot 3**: o kicker é emitido **sempre**,
    incondicionalmente, para QUALQUER box nesses slots — decisão editorial
    260611 (estendida ao slot 3 em #3476), independe de o conteúdo ter link
    de afiliado ou não (`renderDivulgacaoSeparator` é chamado
    incondicionalmente em
    `content.boxDivulgacao1`/`boxDivulgacao2`/`boxDivulgacao3`). Todo box de
    slot 1/2/3 (livros, clarice, alexa-plus, apoio, recomendação de leitura,
    indicação de ferramenta) sai com "Divulgação" acima, mesmo os
    não-patrocinados.
  - **Topo (intro callout)**: aí sim é condicional — só ganha o kicker
    quando o texto contém link de afiliado (`?via=` ou `tag=` na URL —
    `isSponsoredCallout`). `intro-campeoes-sorteio.md`, por exemplo, NÃO
    tem link de afiliado → sobe sem "Divulgação".
  `clarice-divulgacao.md` é o único com link de afiliado de fato (`?via=diaria`)
  — nos outros slots isso não muda nada (kicker já sairia de qualquer forma),
  mas importa se um dia esse conteúdo for usado no topo.

## Os 10 arquivos

| Arquivo | Slot(s) | Formato | Auto-injetável via `boxes_divulgacao`? | Quando usar |
|---|---|---|---|---|
| `livros-divulgacao.md` | Slot 1, 2 (default) ou 3 | bold-line/mid-callout | **Sim** — é o default de `slot2` (#3212) | Curadoria própria (`livros.diar.ia.br`), roda sem intervenção na maioria das edições (#2527). |
| `clarice-divulgacao.md` | Slot 1, 2 ou 3 | bold-line/mid-callout, link de afiliado (`?via=diaria`) | **Sim** | Trocar o config quando quiser rodar a campanha Clarice no lugar de livros (era o default pré-#2527). Também reusado no mensal como seção própria. |
| `_arquivo/alexa-plus-divulgacao.md` | Slot 1, 2 ou 3 (quando ativo) | carrinho/CTA pill, com disclosure de comissão no próprio corpo | Arquivado (260726) — movido pra `_arquivo/`, fora de `boxes_divulgacao` | Campanha de afiliado Alexa+ encerrada/pausada. Mantido só como referência de formato; mover de volta pra `context/snippets/` e reconfigurar `boxes_divulgacao` se a campanha reativar. |
| `recomendacao-leitura.md` | Slot 1 (default) ou qualquer outro | bold-line/mid-callout genérico (só 1 link no bloco, nenhum parágrafo CTA-only → não vira carrinho) | **Sim** (#3306) — `loadDivulgacaoSnippet` tem um 3º fallback genérico: quando o conteúdo não bate bold-line nem carrinho, devolve o texto cru em vez de `null`. É o default de `slot1` desde #3212. | Default automático — não precisa fazer nada. Recomendação de leitura pessoal (livro/artigo) com link afiliado; título+autor em negrito-com-link, 1 comentário pessoal em 1ª pessoa, sem CTA pill. Editor substitui o conteúdo a cada reuso (troca manual do arquivo/edição pontual). |
| `indicacao-ferramenta.md` | Slot 1, 2 ou 3 | bold-line/mid-callout genérico (mesmo fallback do #3306) | **Sim** — era o default de `slot3` (#3476), substituído por `apoio-divulgacao.md` em #3824 (260722). Segue disponível pra reuso pontual — trocar o config quando quiser rodar essa campanha em vez da de apoio. | Indicação pessoal de ferramenta que o editor usa/recomenda, SEM comissão — disclaimer em itálico no próprio corpo. Editor substitui nome/link/comentário a cada reuso. |
| `apoio-divulgacao.md` | Slot 3 (default, #3824) — também colável em slot 1/2 | multi-parágrafo com lista + CTA pill | **Sim** — é o default de `slot3` desde #3824 (260722, decisão permanente do editor, substitui `indicacao-ferramenta.md`). Colar manualmente no draft (`02-d1-draft.md`/`02-d2-draft.md`/`02-d3-draft.md`) também funciona pra rodar num slot diferente pontualmente — o parse do lado do render é marcador-agnóstico e não depende de `loadDivulgacaoSnippet`. | Default automático. Programa de apoio (apoia.se/diaria) com lista de recompensas em bullets. |
| `artigo-especial-apoiadores.md` | Slot 1, 2 ou 3 | multi-parágrafo, sem CTA pill (mesmo fallback do #3306) | Não é um dos defaults de `boxes_divulgacao` — colar manualmente no draft (mesmo mecanismo marcador-agnóstico de `apoio-divulgacao.md`) quando o editor quer promover o Artigo Especial do mês em vez do CTA genérico de apoio. | Reuso pontual. Título do artigo em negrito inline (corrigido no gate 260724 — não usar "Mandei... há pouco", fixar "O Artigo Especial desse mês é: **título**"). Editor substitui `{título do artigo}`/`{mês}`/gancho a cada reuso. |
| `intro-campeoes-sorteio.md` | **Topo** (intro callout, não slot 1/2/3) | bold-line com sub-cabeçalho (`titleStyle="body"`) | Não é usado via `boxes_divulgacao` na prática (o slot dele é o topo, não uma das 3 lacunas/região) | **Não editar/colar manualmente** — é template de REFERÊNCIA para o gerador `scripts/lib/build-champions-callout.ts` + `scripts/inject-champions-callout.ts` (Stage 3), que preenche os placeholders (`{mes}`, `{1o}`/`{2o}`/`{3o}`, `{data}`, `{hora_inicio}`/`{hora_fim}`, `{meet_url}`) e injeta automaticamente na 1ª edição de cada mês. Consultar este arquivo só para revisar o texto/formato esperado. |
| `encerramento-social-apoio.md` | **PARA ENCERRAR** (seção final, não slot 1/2/3) | multi-parágrafo, sem CTA pill | Não passa por `boxes_divulgacao` — é lido direto por `buildParaEncerrar` (diário) e `writer-monthly` (mensal) via `scripts/lib/shared/encerramento-snippet.ts` | Fonte única do encerramento — convite social (LinkedIn/Facebook) + parágrafo de apoio (Apoia.se). Editar aqui propaga pro diário E pro mensal (mesmo texto, placeholder `{{OPENING}}` diferencia a abertura). |
| `hub-divulgacao-rotativo.md` | Slot 1, 2 ou 3 (quando ligado — ver coluna seguinte) | bold-line/mid-callout | **AINDA NÃO** (#5263) — conteúdo é GERADO (`scripts/build-hub-divulgacao-box.ts --edition AAMMDD`, nunca editado à mão), com 1 hub em rotação determinística entre os 6 de `HUB_META`; falta só apontar um slot pra ele em `boxes_divulgacao` e decidir em que ponto do pipeline a regeneração roda. | "A cobertura completa de {tema} desde {mês/ano}: {N} edições, cronologia e fontes → arquivo.diar.ia.br/temas/{slug}" — números derivados de `HubContent.sourceEditions`, nunca digitados. Ver docstring de `scripts/lib/shared/hub-divulgacao-box.ts` pro racional completo (inclusive por que a rotação usa dias corridos, não dia-da-semana). |

Coluna "Formato" cobre só o LAYOUT (bold-line vs carrinho vs lista) — o
disclosure "Divulgação" é tratado à parte na seção anterior (regra diferente
por slot).

## Convenções comuns a todos os arquivos

- **Comentário-cabeçalho `<!-- ... -->`** no topo de cada arquivo explica a
  convenção específica daquele bloco (formato exato, slot, decisões
  editoriais, issues relacionadas). `readSnippetFile`
  (`scripts/lib/shared/snippet-loader.ts`) remove esse comentário
  automaticamente antes do conteúdo entrar no render — o comentário é só
  documentação, nunca vaza pro e-mail final.
- **Campos de header dedicados: `nome:`, `categoria:`, `alt:`, `runtime:`.**
  Além do texto livre de notas, o header aceita linhas `{key}: {valor}`
  reconhecidas por `parseBoxHeaderField` (`scripts/lib/shared/snippet-header.ts`),
  mesmo padrão editável no Studio (`scripts/studio-ui/studio-boxes.ts`):
  - `nome:` (#3933) — nome interno do box, exibido no Studio (nunca vaza
    pro e-mail).
  - `categoria:` (#3981) — rótulo do kicker acima do box na newsletter
    (ex: "Recomendação de Livro"), substitui o default "Divulgação"/
    "Agradecimento" (ver `readBoxDivulgacaoCategoriaForSlot`).
  - `alt:` (#4086) — texto alternativo da imagem do box, quando o slot tem
    imagem (`box_slot{N}_image` explícito, ou `livros_promo` no box de
    livros). Lido por `readBoxDivulgacaoAltForSlot` e passado como
    `altOverride` pra `renderMidCallout`/`renderBoxDivulgacao`, vencendo o
    default (anchor text do 1º link do box). **Regra editorial: descreva o
    CONTEÚDO da imagem, nunca o rótulo do botão/CTA** — ex:
    `alt: Capa do livro "Título", de Autor`, não `alt: Quero apoiar` (o
    rótulo do botão já é redundante com o link, e não descreve nada pra
    quem não vê a imagem — leitor de tela, ou cliente de e-mail com
    imagens bloqueadas por padrão, como Outlook desktop). Ausente → o
    render cai no anchor text do 1º link (comportamento legado,
    retrocompatível) — `check-invariants.ts --stage 4` sinaliza (warning,
    não bloqueia) quando um slot tem imagem sem `alt:` declarado (#4086).
  - `runtime: false` (#4500) — sinaliza que o arquivo é documentação/
    referência, não uma caixa de verdade (ex: `intro-campeoes-sorteio.md`,
    ver "Nem todo arquivo é 'vivo' em runtime" abaixo). `listBoxes`
    (`scripts/studio-ui/studio-boxes.ts`) filtra qualquer `.md` com esse
    campo — o painel Caixas nunca oferece esses arquivos como opção pros
    slots 0-3. Ausente ou qualquer valor diferente de `false` (case-
    insensitive) → arquivo continua listado normalmente.
  Todos os 4 campos são opcionais e independentes — declarar um não exige
  os outros.
- **Sem marcador emoji (#3475).** O parse/render decide formato e posição
  100% por estrutura (posição no texto, presença de `---`, contagem de
  links, parágrafo CTA-only) e por sinal de conteúdo (link de afiliado pra
  `isSponsoredCallout`, link `livros.diar.ia.br` pra
  `isBoxDivulgacaoLivros`) — nunca por qual emoji abre o bloco (#3204/#3232).
  O sistema antigo de marcadores (`stripCalloutMarker`, que reconhecia
  `📣`/`📚`/`📖`/`🎉` só pra fins cosméticos) foi removido — os 4 arquivos
  que usavam marcador (`recomendacao-leitura.md`, `livros-divulgacao.md`,
  `clarice-divulgacao.md`, `alexa-plus-divulgacao.md`) não abrem mais com
  emoji. Efeito colateral aceito em `recomendacao-leitura.md`: era o único
  box cuja distinção "título vs. corpo comum" dependia do marcador (não de
  sponsored/CTA-only) — sem ele, os parágrafos renderizam uniformemente,
  sem o título serif 26px destacado (ver comentário do próprio arquivo).
- **Nem todo arquivo é "vivo" em runtime.** `intro-campeoes-sorteio.md` é
  puramente um template de referência (o gerador é a fonte de verdade
  executável) — declara `runtime: false` no header (#4500) pra sumir do
  painel Caixas do Studio, já que atribuí-lo a um slot não teria efeito
  nenhum no render real (o box de campeões é hardcoded pra intro por
  `inject-champions-callout.ts`, nunca lê `boxes_divulgacao`). Os demais 7
  são lidos de fato — seja via `boxes_divulgacao`
  (livros/clarice/alexa-plus/apoio/recomendação de leitura/indicação de
  ferramenta), ou via leitura fixa fora do slot config
  (encerramento-social-apoio).

## Relação com #3212/#3476

`#3212` resolveu o gap original: os 2 primeiros boxes (recomendação de
leitura no slot 1, curadoria de livros no slot 2) são permanentes, sempre
presentes em toda edição — `boxes_divulgacao` default aponta pros 2. `#3476`
estendeu pra 3 boxes permanentes (slot 3 = indicação de ferramenta, entre o
último destaque e USE MELHOR) e reposicionou É IA? pra depois de USE MELHOR.

Este índice cataloga **o que existe**. A pergunta "qual CONTEÚDO específico
entra em cada slot nesta edição" é resolvida de duas formas, dependendo do
slot: slot 0 (topo) e qualquer slot 1/2/3 listado em
`boxes_divulgacao_auto.pinned_slots` continuam manuais — o editor substitui
o conteúdo do snippet a cada reuso, ou troca `boxes_divulgacao` em
`platform.config.json` (ou cola direto no draft, pros que não são
auto-injetáveis); slots 1/2/3 não-pinados são resolvidos automaticamente por
`scripts/select-boxes-by-clicks.ts` (**#4626**, rotação por cliques +
tendência + anti-repetição — ver seção acima).
