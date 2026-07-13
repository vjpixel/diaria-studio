<!--
Bloco de DIVULGAÇÃO de recomendação de leitura pessoal do editor (📖). Mesma
categoria de apoio-divulgacao.md/alexa-plus-divulgacao.md (slot 1 D1/D2 ou
slot 2 D2/D3, #2978) — NÃO auto-injetado por padrão (diferente do 📚 livros,
#2527): o editor cola este bloco na lacuna desejada quando quiser divulgar
uma leitura específica.

Formato: (1) linha de título da seção, sem negrito nem link ("📖 Recomendação
de leitura"); (2) 1 parágrafo com título do livro em negrito-com-link +
autor(es) — `[**Título**](url), de Autor.`; (3) 1 parágrafo de comentário
pessoal em 1ª pessoa sobre a leitura. Sem CTA pill — só 1 link no bloco
inteiro e nenhum parágrafo é CTA-only, então `shouldForceCtaPill`
(newsletter-render-html.ts) não força o formato carrinho; cai no bold-line/
mid-callout padrão (`renderMidCallout`), igual ao box 📣 Clarice.

Marcador-agnóstico no render (#3204/#3232) — o 📖 é decorativo; o parse
identifica o box pela POSIÇÃO (lacuna isolada por `---`) e ESTRUTURA, não
pelo emoji. O kicker "● DIVULGAÇÃO" acima do box é emitido incondicionalmente
por estar no slot 1/2 (decisão 260611) — independe de o link ter ou não
`?via=`/`tag=` (isSponsoredCallout só é condicional pro callout do TOPO, não
pros slots D1/D2 e D2/D3).

O conteúdo abaixo é a instância real usada na edição 2041 (Kai-Fu Lee),
mantida como exemplo de referência — o editor substitui título/autor/link/
comentário a cada reuso, preservando a estrutura acima.
-->

📖 Recomendação de leitura

[**2041: Como a Inteligência Artificial Vai Mudar Sua Vida nas Próximas Décadas**](https://link.amazon/B05FlAaJ7), de Kai-Fu Lee e Chen Qiufan.

Estou terminando agora e, como fã de ficção científica e curioso, gosto da estrutura: cada capítulo abre com um conto e depois desconstrói as tecnologias que aparecem nele. Está com 45% de desconto até terminar o estoque (o livro físico está mais barato que o digital).
