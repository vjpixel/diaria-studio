# context/snippets/ — biblioteca de blocos reutilizáveis

Índice dos blocos de divulgação/CTA reutilizáveis entre edições. Cada arquivo
tem seu próprio comentário-cabeçalho `<!-- ... -->` (fonte primária —
consulte-o para a convenção completa daquele bloco específico); este README é
o mapa de qual bloco existe, onde ele entra na edição, que formato de render
ele produz, e quando o editor deve escolher cada um.

**Isto é sobre catalogar os modelos de conteúdo — não sobre automatizar a
escolha entre eles.** A decisão de qual box entra em qual slot numa edição
específica ainda é manual (config em `platform.config.json` ou paste direto
no draft pelo editor). Automação/rotação dessa escolha é escopo de #3212,
não deste índice.

## Onde um box pode entrar

`scripts/stitch-newsletter.ts` monta a edição diária com 4 pontos de encaixe
para conteúdo de divulgação/CTA: 3 slots dinâmicos (topo, D1/D2, D2/D3) mais
1 posição fixa (PARA ENCERRAR, sempre a mesma fonte). O parse
(`scripts/lib/newsletter-parse.ts`) e o render
(`scripts/lib/newsletter-render-html.ts`) identificam os 3 slots dinâmicos
por **posição + estrutura**, não pelo emoji que abre o texto (marcador-
agnóstico desde #3204/#3232 — um emoji novo, ou nenhum emoji, ainda funciona;
o emoji é só decorativo/cosmético no título renderizado).

| Slot | Onde fica | Mecanismo | Config |
|---|---|---|---|
| **Topo** (intro callout) | Antes do DESTAQUE 1 | `extractIntroCallout`/`renderIntroCallout` — bloco `**...**` inteiro na região de intro | Auto-gerado (campeões/sorteio) ou colado manualmente pelo editor |
| **Slot 1** (D1/D2) | Lacuna entre DESTAQUE 1 e DESTAQUE 2 | `boxes_divulgacao.slot1` em `platform.config.json` | Auto-injetado por `stitchNewsletter` se o snippet configurado carregar (ver tabela abaixo) |
| **Slot 2** (D2/D3) | Lacuna entre DESTAQUE 2 e DESTAQUE 3 (só existe em edição de 3 destaques) | `boxes_divulgacao.slot2` em `platform.config.json` | Idem slot 1 |
| **PARA ENCERRAR** | Seção final da edição (diário e mensal) | `buildParaEncerrar` (diário) / `writer-monthly` (mensal) — sempre lê `encerramento-social-apoio.md` | Fixo, não configurável por snippet |

Default atual de `platform.config.json` → `boxes_divulgacao`: `slot1:
"livros-divulgacao.md"`, `slot2: null` (nenhum box no slot 2). Se a chave
`boxes_divulgacao` estiver ausente do config inteiro, `stitchNewsletter` cai
nesse mesmo default (back-compat, #2978).

**Idempotência:** se a lacuna do slot já tiver um box colado manualmente pelo
editor (`boxAlreadyPresentInGap`), `stitchNewsletter` pula a auto-injeção
nesse slot — não duplica. `--no-sponsor` (`sponsor: false`) suprime os 2
slots de uma vez (kill-switch pontual).

## Formato: famílias de render

O formato de render de um box de slot 1/2 é decidido pela **estrutura do
próprio conteúdo** (`shouldForceCtaPill` em `newsletter-render-html.ts`), não
pelo slot nem pelo emoji:

- **bold-line / mid-callout** (`renderMidCallout`) — bloco `**emoji Título …
  [link](url)**` compacto, título + corpo + 1 link, tudo dentro do mesmo
  `**...**`. Formato de `clarice-divulgacao.md` e `livros-divulgacao.md`.
- **carrinho / CTA pill** (`renderIntroCallout` com `forceCtaPill=true`) —
  multi-parágrafo SEM bold-wrap, acionado quando (a) o texto começa com 🛒,
  (b) tem 2+ links no total, ou (c) algum parágrafo é SÓ um link (`[label](url)`
  ou `→ [label](url)`) — o último link vira botão pill centralizado no HTML.
  Formato de `alexa-plus-divulgacao.md`.
- **multi-parágrafo com lista** — mesma família estrutural do carrinho (texto
  plano, sem bold-wrap), mas com um bloco de lista `- item` no meio que vira
  `<ul><li>` real no HTML. Formato de `apoio-divulgacao.md`.
- **disclosure "● DIVULGAÇÃO"** — não é um formato de LAYOUT, é um kicker
  acima do box. Comportamento **diferente por slot** (atenção, não confundir):
  - **Slot 1 e Slot 2**: o kicker é emitido **sempre**, incondicionalmente,
    para QUALQUER box nesses slots — decisão editorial 260611, independe de
    o conteúdo ter link de afiliado ou não (`renderDivulgacaoSeparator` é
    chamado incondicionalmente em `content.boxDivulgacao1`/`boxDivulgacao2`).
    Todo box de slot 1/2 (livros, clarice, alexa-plus, apoio, recomendação de
    leitura) sai com "Divulgação" acima, mesmo os não-patrocinados.
  - **Topo (intro callout)**: aí sim é condicional — só ganha o kicker
    quando o texto contém link de afiliado (`?via=` ou `tag=` na URL —
    `isSponsoredCallout`). `intro-campeoes-sorteio.md`, por exemplo, NÃO
    tem link de afiliado → sobe sem "Divulgação".
  `clarice-divulgacao.md` é o único com link de afiliado de fato (`?via=diaria`)
  — nos outros slots isso não muda nada (kicker já sairia de qualquer forma),
  mas importa se um dia esse conteúdo for usado no topo.

## Os 7 arquivos

| Arquivo | Slot(s) | Formato | Auto-injetável via `boxes_divulgacao`? | Quando usar |
|---|---|---|---|---|
| `livros-divulgacao.md` | Slot 1 (default) ou Slot 2 | bold-line/mid-callout | **Sim** — é o default de `slot1` | Default automático — não precisa fazer nada. Curadoria própria (`livros.diaria.workers.dev`), roda sem intervenção na maioria das edições (#2527). |
| `clarice-divulgacao.md` | Slot 1 ou Slot 2 | bold-line/mid-callout, link de afiliado (`?via=diaria`) | **Sim** | Trocar o config quando quiser rodar a campanha Clarice no lugar de livros (era o default pré-#2527). Também reusado no mensal como seção própria. |
| `alexa-plus-divulgacao.md` | Slot 1 ou Slot 2 | carrinho/CTA pill, com disclosure de comissão no próprio corpo | **Sim** (começa com 🛒) | Trocar o config quando quiser divulgar a campanha de afiliado Alexa+. |
| `apoio-divulgacao.md` | Slot 1 ou Slot 2 | multi-parágrafo com lista + CTA pill | **Não** — `loadDivulgacaoSnippet` só reconhece bold-line (`**📚\|📣\|🎉…**`) ou carrinho (prefixo `🛒`); este arquivo é texto plano sem nenhum dos dois, então via `boxes_divulgacao` carregaria `null`. Colar manualmente no draft (`02-d1-draft.md`/`02-d2-draft.md`) funciona normalmente — o parse do lado do render é marcador-agnóstico e não depende de `loadDivulgacaoSnippet`. | Editor cola manualmente na lacuna desejada quando quiser rodar a campanha do programa de apoio (apoia.se/diaria). |
| `recomendacao-leitura.md` | Slot 1 ou Slot 2 | bold-line/mid-callout (só 1 link no bloco, nenhum parágrafo CTA-only → não vira carrinho) | **Não** — mesmo motivo de `apoio-divulgacao.md` (texto plano, sem bold-wrap nem prefixo 🛒). Colar manualmente no draft. | Editor cola manualmente quando quiser recomendar uma leitura pessoal (livro/artigo) numa edição específica. Título+autor em negrito-com-link, 1 comentário pessoal em 1ª pessoa, sem CTA pill. |
| `intro-campeoes-sorteio.md` | **Topo** (intro callout, não slot 1/2) | bold-line com sub-cabeçalho (`titleStyle="body"`) | Não é usado via `boxes_divulgacao` na prática (o slot dele é o topo, não a lacuna D1/D2 ou D2/D3) | **Não editar/colar manualmente** — é template de REFERÊNCIA para o gerador `scripts/lib/build-champions-callout.ts` + `scripts/inject-champions-callout.ts` (Stage 3), que preenche os placeholders (`{mes}`, `{1o}`/`{2o}`/`{3o}`, `{data}`, `{hora_inicio}`/`{hora_fim}`, `{meet_url}`) e injeta automaticamente na 1ª edição de cada mês. Consultar este arquivo só para revisar o texto/formato esperado. |
| `encerramento-social-apoio.md` | **PARA ENCERRAR** (seção final, não slot 1/2) | multi-parágrafo, sem CTA pill | Não passa por `boxes_divulgacao` — é lido direto por `buildParaEncerrar` (diário) e `writer-monthly` (mensal) via `scripts/lib/shared/encerramento-snippet.ts` | Fonte única do encerramento — convite social (LinkedIn/Facebook) + parágrafo de apoio (Apoia.se). Editar aqui propaga pro diário E pro mensal (mesmo texto, placeholder `{{OPENING}}` diferencia a abertura). |

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
- **Marcador emoji é cosmético, não estrutural.** O parse/render decide
  formato e posição por estrutura (posição no texto, presença de `---`,
  contagem de links, parágrafo CTA-only), não por qual emoji abre o bloco
  (#3204/#3232). Um emoji novo nunca-visto-antes funciona sem mudança de
  código — só fica visível no título (não é removido por `stripCalloutMarker`,
  que só reconhece `📣`/`📚`/`📖`/`🎉` para fins cosméticos).
- **Nem todo arquivo é "vivo" em runtime.** `intro-campeoes-sorteio.md` é
  puramente um template de referência (o gerador é a fonte de verdade
  executável); os demais 6 são lidos de fato — seja via `boxes_divulgacao`
  (livros/clarice/alexa-plus), via leitura fixa fora do slot config
  (encerramento-social-apoio), ou via cópia manual pelo editor pro draft
  (apoio/recomendação de leitura).

## Relação com #3212

Este índice cataloga **o que existe**. A pergunta "qual box entra em qual
slot nesta edição específica" ainda é decidida manualmente hoje — trocando
`boxes_divulgacao` em `platform.config.json` (para os 3 formatos
auto-injetáveis) ou colando o conteúdo direto no draft (para os demais).
#3212 é sobre automatizar/rotacionar essa escolha; nenhuma lógica de rotação
foi implementada aqui — é fora de escopo deste índice.
