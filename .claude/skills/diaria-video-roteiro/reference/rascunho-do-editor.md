# Rascunho do editor como entrada (#13132)

Referência de `/diaria-video-roteiro`, lida sob demanda (#14040). Gatilho: o editor trouxe um rascunho próprio do roteiro (notícia e comentários, em texto ou imagem). Citado no Passo 1 do SKILL.md.

**Rascunho do editor como entrada (#13132).** O editor pode trazer um rascunho próprio do roteiro (notícia e comentários, em texto ou imagem). Ler cada ponto e separar: **fato** a checar ou **opinião** dele (opinião entra como fala dele, sem checagem). Para cada fato:

1. Está na fonte do D1 (`d1.txt`) ou no fact-check da edição? Usar como está.
2. Não está: buscar na web (WebSearch e WebFetch) e classificar como **confirmado**, **só em fonte terceira** (blog, agregador, site de comparação: entra com a ressalva nas notas), **contraditório** (fontes divergem ou o ponto está errado: propor a versão corrigida, em vez de só excluir; na 261116 o mapa Pro/Flash/Flash-Lite do rascunho estava errado e foi corrigido) ou **sem fonte** (fica fora).
3. A fala que usa um fato de fora do D1 leva `fontes` no `roteiro-falas.json` (Passo 5): a URL e o que ela sustenta. É o que o fact-check da fala gravada (`/diaria-video-montagem`, Passo 3a) recebe além do D1.

Na entrega da primeira versão, listar os fatos checados com a classificação e, à parte, **os pontos do rascunho que ficaram de fora ou entraram só em parte, com o motivo** (na 261116 o editor perguntou por isso). A lista vai também nas notas da página (`notas` no JSON).
