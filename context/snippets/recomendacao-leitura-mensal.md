<!--
Variante MENSAL (base da Clarice) do box "Recomendação de leitura". Difere do
snippet do diário (context/snippets/recomendacao-leitura.md) em duas coisas:
3ª pessoa (tom IMPESSOAL) + mini-bio do autor, e ESTRUTURA (ver abaixo).
Decisão do editor 260716.

Por que separado do snippet do diário: no DIÁRIO o box é a recomendação
pessoal do editor, em 1ª pessoa por design (auto-injetado via stitch-newsletter
como slot1, platform.config.json). A mensal fala pra base da Clarice com voz
mais institucional, então precisa da versão impessoal — sem acoplar as duas.

Estrutura na MENSAL (renderiza via label LIVRO DO MÊS em
scripts/lib/mensal/monthly-render.ts → renderClariceBox com noSubtitle):
  (1) o LABEL de seção `**LIVRO DO MÊS**` — vira o kicker do box "Livro do mês"
      (não há título/h3 interno; o kicker já nomeia a seção). O "do mês" segue a
      família de rubricas da mensal; #3581 propõe removê-lo de todas;
  (2) 1 parágrafo com o título do livro em negrito-com-link + autor(es) —
      `[**Título**](url), de Autor.` (o `**` dentro do link é renderizado como
      <strong>, ver escHtmlWithEmphasis);
  (3) parágrafo IMPESSOAL sobre o AUTOR (mini-bio);
  (4) parágrafo IMPESSOAL sobre o LIVRO (o que o torna interessante).
Sem CTA pill — só 1 link no bloco (o título do livro).

O conteúdo abaixo (2041, de Kai-Fu Lee) é a instância de referência — o editor
substitui título/autor/link/comentário a cada reuso, preservando estrutura +
tom impessoal. Sem a linha de desconto/estoque (sensível ao tempo — o editor
repõe por edição se quiser).

Uso na mensal: o editor cola este bloco (COM o label) numa lacuna entre
destaques, isolado por `---`. Não é auto-inserido pelo pipeline.
-->

**LIVRO DO MÊS**

[**2041: Como a Inteligência Artificial Vai Mudar Sua Vida nas Próximas Décadas**](https://link.amazon/B05FlAaJ7), de Kai-Fu Lee e Chen Qiufan.

Kai-Fu Lee foi presidente do Google na China, passou pela Apple e pela Microsoft e hoje é um dos investidores e pensadores de IA mais influentes da Ásia.

Ao lado do escritor de ficção científica Chen Qiufan, ele adota uma estrutura pouco comum: cada capítulo abre com um conto e depois desconstrói as tecnologias que aparecem nele. É uma forma diferente de imaginar para onde a IA pode ir nas próximas décadas.
