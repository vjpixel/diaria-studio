<!--
nome: Agradecimento apoiadores 28/Jul
categoria: Agradecimento
Caixa de AGRADECIMENTO a quem acabou de apoiar via Apoia.se. Fica na região de
INTRO, imediatamente APÓS a frase-CTA "Se este trabalho faz diferença para você,
[considere apoiar o projeto](…)." e ANTES do `---` que abre o DESTAQUE 1.

Injetado por `scripts/stitch-newsletter.ts` (logo após a coverage line). O
parser já aceita parágrafos extras nessa região desde #3477 — não é preciso
colar antes da frase-CTA.

Formato: parágrafo único, texto plano no nível do bloco , com o NOME de cada apoiador em negrito inline, deve aparecer com caixa no fundo.

Como a caixa é obtida: o bloco inteiro vai embrulhado em `**...**` (bold-wrap).
É esse embrulho que `extractIntroCallout` (scripts/lib/newsletter-parse.ts)
detecta na região de intro pra renderizar com fundo, em vez de parágrafo solto.
O negrito do NOME fica aninhado dentro do embrulho — mesmo padrão da edição
260724. Não remover os `**` das pontas: sem eles o bloco vira texto plano.

Só 1 bloco bold-wrap por edição na região de intro — 2 ou mais disparam o lint
`stacked-intro-callouts` (#2729) e o parser funde os dois num só.

SEM apoiador novo na edição: o bloco é OMITIDO inteiro — não deixar a frase com
placeholder vazio nem um agradecimento genérico sem nome.
-->

**Agradeço ao novo apoiador: **Murilo Sarno**. Seu apoio ajuda a manter essa curadoria diária de pé!**