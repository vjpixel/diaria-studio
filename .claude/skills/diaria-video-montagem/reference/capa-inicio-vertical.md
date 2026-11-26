# Capa no começo dos verticais (#13123, opt-in)

Referência de `/diaria-video-montagem`, lida sob demanda (#14040). Gatilho: o editor liga a capa no começo dos verticais, ou o `blocks.json` tem `"capaInicio"`. Citado no Passo 2 (item 5) do SKILL.md.

## `capaInicio` no `blocks.json`

**Capa no começo dos verticais (#13123, em teste em 2 ou 3 edições, opt-in):** `"capaInicio": true` (300 ms) ou um número de ms (100 a 1000) põe o painel e o gancho da capa do Short nos primeiros quadros de cada vertical, numa faixa de vídeo acima de todas, sobre a fala de abertura e sem mexer no áudio, para TikTok, Facebook, LinkedIn, Threads e X pegarem esse frame como capa; o horizontal nunca leva. Texto: `"capa"` da sequência, depois `"capa"` do arquivo (só a vertical da edição), depois `porVideo.vertical1.capa` (vertical da edição) ou `porVideo.vertical2.capa` (corte `guia`) do `_internal/roteiro-falas.json`; 2 a 7 palavras, como a capa do Short. Sem texto, a vertical sai sem a capa, com `[aviso]`. Ausente = o build de sempre. No teste, conferir depois de publicar qual frame cada rede mostrou, a retenção nos primeiros 3 s e a leitura com o título e a legenda queimada (`docs/youtube-capa-texto.md`).
