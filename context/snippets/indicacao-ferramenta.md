<!--
Bloco de DIVULGAÇÃO de indicação de ferramenta pessoal do editor (🔧). Mesma
categoria de recomendacao-leitura.md — 3º slot fixo (slot 3, #3476),
posicionado SEMPRE após o ÚLTIMO destaque (D3 em edições de 3 destaques, D2
em edições de 2), antes de USE MELHOR/É IA?. Diferente do slot 1/2, não é uma
lacuna ENTRE destaques — é a região pós-destaques (ver
`locateBoxAfterLastDestaque` em scripts/lib/newsletter-parse.ts).

Formato: (1) linha de título da seção, sem negrito nem link ("🔧 Indicação de
ferramenta"); (2) 1 parágrafo com nome da ferramenta em negrito-com-link —
`[**Nome da Ferramenta**](url)`; (3) 1 parágrafo de comentário pessoal em 1ª
pessoa sobre por que o editor usa/recomenda; (4) 1 parágrafo em itálico com o
disclaimer de que não há comissão envolvida — decisão explícita do editor
(#3476): diferente de recomendacao-leitura.md (Amazon, link afiliado), esta
indicação é pessoal e NÃO patrocinada. Sem CTA pill — só 1 link no bloco
inteiro e nenhum parágrafo é CTA-only, cai no bold-line/mid-callout padrão
(`renderMidCallout`), igual aos demais boxes de slot 1/2/3.

Marcador-agnóstico no render (#3204/#3232/#3476) — o 🔧 é decorativo; o parse
identifica o box pela POSIÇÃO (região pós-último-destaque, isolada por `---`)
e ESTRUTURA, não pelo emoji. O kicker "● DIVULGAÇÃO" acima do box é emitido
incondicionalmente por estar no slot 3 (mesma decisão editorial 260611 já
aplicada aos slots 1/2) — independe de o conteúdo ter link de afiliado ou
não.

O conteúdo abaixo é um exemplo de referência — o editor substitui
nome/link/comentário a cada reuso, preservando a estrutura acima (incluindo
o disclaimer em itálico).
-->

🔧 Indicação de ferramenta

[**Raycast**](https://www.raycast.com)

Uso todo dia pra trocar de app, rodar snippets e automatizar buscas sem tirar a mão do teclado — virou parte do meu fluxo de trabalho.

_Não recebi comissão por essa indicação — é só uma ferramenta que uso e gosto._
