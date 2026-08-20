# Benchmarks de Instagram — padrões extraídos (#5815)

Análise de 2 posts indicados pelo editor como referência de formato/estilo pra
publicações no Instagram do diar.ia.br. Ambos da conta `reboloinstituto`
(carrosséis biográficos/narrativos sobre o pintor Francisco Rebolo).

- https://www.instagram.com/p/DZFqmk2luNo/ — "A trajetória única de Francisco
  Rebolo" (biografia). 5.7K likes, 145 comentários, 224 compartilhamentos.
- https://www.instagram.com/p/DY2BAKaFmMr/ — "A história por trás da obra
  'Futebol' de Francisco Rebolo (1936)" (deep dive de 1 obra). 809 likes, 38
  comentários, 49 compartilhamentos.

## Padrões replicáveis

1. **Carrossel narrativo, 1 "batida" de história por slide.** Não é um resumo
   estático — cada slide avança a narrativa um passo (infância → dificuldade →
   virada → consequência), como um roteiro de vídeo curto transposto pra
   imagem estática. O 1º post é biografia inteira em ~8 slides; o 2º é o
   "making of"/contexto de UMA obra específica.

2. **Slide 1 = gancho dramático + contraste**, nunca resumo neutro. Texto
   grande, caixa alta, fonte sans-serif bold, quebrado em várias linhas
   curtas — funciona como "trailer" que cria uma pergunta ("como um menino
   pintor de paredes virou um dos grandes nomes do modernismo?") em vez de
   entregar a resposta de cara. O 2º post usa a variante "por trás de uma obra
   específica" — mesmo gancho, escopo mais estreito.

3. **2 sub-formatos de texto sobre imagem, intercambiáveis dentro do mesmo
   carrossel:**
   - Texto ocupando o slide inteiro (fundo sólido ou foto de baixo contraste)
     — usado nos slides mais narrativos/emocionais.
   - Imagem/obra em destaque + faixa de texto (topo OU base do slide) — usado
     quando o conteúdo em si (a pintura, a foto de arquivo) é o protagonista
     visual e o texto só ancora o contexto.

4. **Legenda (caption) curta, gancho emocional + call-to-action explícito.**
   Nenhuma legenda tenta reexplicar o carrossel — ela reforça o tom (ex: "A
   vida de Rebolo é um exemplo de superação, de amor ao trabalho...") e no 2º
   post adiciona CTA explícito de engajamento: "Conta nos comentários o que
   achou", "Curta esta postagem e compartilhe com quem vai gostar de saber
   essa história" — pedido direto de comentário + compartilhamento, não só
   like.

5. **Hashtags: 4-5, específicas do tema/artista**, nunca genéricas de nicho
   amplo (`#franciscorebolo #grupsantahelena #artistasdobrasil
   #pintoresdobrasil #inspiracao`) — funcionam como categorização temática,
   não como tentativa de alcance via hashtag popular.

6. **Diferença de engajamento entre os 2 formatos** (biografia completa vs.
   deep-dive de uma obra): o carrossel biográfico completo teve ~7× mais
   likes e ~4,5× mais compartilhamentos que o de uma obra só — sugere que
   arco narrativo pessoal (superação, trajetória) engaja mais que análise
   de uma peça isolada, pelo menos nesta conta de referência.

## Onde aplicar

- **`social-writer`** (texto do post — é quem serve Instagram/LinkedIn/Facebook,
  #3991; `social-curto` é Twitter/X e Threads, não tem relação com Instagram)
  — adotar a estrutura de gancho dramático + CTA explícito de comentário/
  compartilhamento na legenda, em vez de resumo do destaque.
- **Stage 3 (imagens, pipeline diário)** — hoje só gera 1 imagem por destaque
  (2x1/1x1/4x5); se vier a ganhar formato de carrossel próprio, o padrão de
  "1 slide = 1 batida narrativa" com texto grande sobre a imagem é o modelo a
  seguir, não um resumo estático do artigo. **Carrossel no Instagram já existe
  fora do pipeline diário**, na skill `/diaria-instagram-semanal`
  (`scripts/lib/weekly-carousel-news-card.ts`) — vale conferir esse código
  antes de reimplementar do zero, ele já se aproxima do padrão "1 slide = 1
  batida".

**Fora de escopo desta análise**: implementação em si (mudar
`social-writer`/pipeline de imagens) — a issue #5815 pede só a extração e
documentação dos padrões; ajuste de prompts/templates fica pra unidade
separada, à critério do editor sobre o que priorizar.
