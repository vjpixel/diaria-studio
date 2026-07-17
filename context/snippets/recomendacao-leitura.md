<!--
Bloco de DIVULGAÇÃO de recomendação de leitura pessoal do editor. Mesma
categoria de apoio-divulgacao.md/alexa-plus-divulgacao.md (slot 1 D1/D2 ou
slot 2 D2/D3, #2978) — NÃO auto-injetado por padrão (diferente de livros,
#2527): o editor cola este bloco na lacuna desejada quando quiser divulgar
uma leitura específica.

Formato: (1) linha de título da seção, em negrito e sem link
("**Recomendação de leitura**", 260717); (2) 1 parágrafo com título do livro em negrito-com-link +
autor(es) — `[**Título**](url), de Autor.`; (3) 1 parágrafo de comentário
pessoal em 1ª pessoa sobre a leitura. Sem CTA pill — só 1 link no bloco
inteiro e nenhum parágrafo é CTA-only, então `shouldForceCtaPill`
(newsletter-render-html.ts) não força o formato carrinho; cai no bold-line/
mid-callout padrão (`renderMidCallout`), igual ao box Clarice.

Marcador-agnóstico no render (#3204/#3232) — o parse identifica o box pela
POSIÇÃO (lacuna isolada por `---`) e ESTRUTURA, não por emoji. O kicker
"● DIVULGAÇÃO" acima do box é emitido incondicionalmente por estar no slot
1/2 (decisão 260611) — independe de o link ter ou não `?via=`/`tag=`
(isSponsoredCallout só é condicional pro callout do TOPO, não pros slots
D1/D2 e D2/D3).

#3475: sem marcador emoji de abertura (📖) — o sistema de marcadores foi
removido. Efeito colateral aceito (documentado no PR #3475): este é o único
box dos 4 (recomendação de leitura, livros, Clarice, Alexa+) cuja distinção
"título vs. corpo comum" dependia do marcador emoji, não de sinal
estrutural (sponsored/CTA-only não se aplicam aqui). Sem o marcador, o box
passa a renderizar os 3 parágrafos uniformemente (sem título serif 26px
destacado) — ainda funcional, só sem o realce visual de título.

260717 (decisão do editor): a linha de título volta a sair em negrito
(`**Recomendação de leitura**`) pra funcionar como categoria/kicker
visualmente distinta do corpo — bold-wrap simples que reverte o efeito
colateral do #3475 sem reintroduzir detecção por emoji nem mexer em
newsletter-render-html.ts.

O conteúdo abaixo é a instância real usada na edição 2041 (Kai-Fu Lee),
mantida como exemplo de referência — o editor substitui título/autor/link/
comentário a cada reuso, preservando a estrutura acima.

Variante IMPESSOAL para a MENSAL (base da Clarice): ver
context/snippets/recomendacao-leitura-mensal.md — mesma estrutura, 3ª pessoa
+ mini-bio do autor (decisão do editor 260716, desacoplada deste box do
diário que fica em 1ª pessoa por design).
-->

**Recomendação de leitura**

[**2041: Como a inteligência artificial vai mudar sua vida nas próximas décadas**](https://link.amazon/B05FlAaJ7), de Kai-Fu Lee e Chen Qiufan.

Estou terminando agora e, como fã de ficção científica e curioso, gosto da estrutura: cada capítulo abre com um conto e depois desconstrói as tecnologias que aparecem nele. Está com 45% de desconto até terminar o estoque (o livro físico está mais barato que o digital).
