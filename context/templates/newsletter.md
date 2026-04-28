# Template — Edição Diar.ia

Formato exato do output da edição. Seguir rigorosamente.

**Importante (#245):** dentro de cada bloco DESTAQUE, sempre uma linha em branco entre header, cada opção de título, URL e cada parágrafo. Sem isso, viewers markdown (Drive preview, GitHub) colapsam tudo em parágrafo único. Nas seções secundárias (LANÇAMENTOS/PESQUISAS/OUTRAS NOTÍCIAS), os 3 elementos do item (título / URL / descrição) ficam em linhas consecutivas — items separados entre si por linha em branco.

```
DESTAQUE 1 | [CATEGORIA]

[Opção de título 1 — máx. 52 chars]

[Opção de título 2 — máx. 52 chars]

[Opção de título 3 — máx. 52 chars]

[URL — sem paywall, dentro da janela, não usado nas últimas 3 edições]

[Parágrafo 1 — abre a história]

[Parágrafo 2 — desenvolve contexto]

[Parágrafo 3 — dados/atores relevantes]

[Parágrafo 4 — fecha com consequência concreta]

Por que isso importa:

[1 parágrafo — impacto prático para o público Diar.ia]

---

DESTAQUE 2 | [CATEGORIA]

[mesmo formato]

---

DESTAQUE 3 | [CATEGORIA]

[mesmo formato]

---

LANÇAMENTOS

[Título do item]
[URL limpa]
[Frase descritiva em 1 linha]

[Título do próximo item]
[URL limpa]
[Frase descritiva]

---

PESQUISAS

[mesmo formato de Lançamentos]

---

OUTRAS NOTÍCIAS

[mesmo formato de Lançamentos]
```

A URL fica imediatamente abaixo do bloco de título(s) — facilita o gate humano (copiar/abrir/reordenar mais rápido). A ordem visual no email final (Beehiiv) é independente: o renderer rearranja como título → descrição → CTA.

## Regras de preenchimento

- CATEGORIA dos destaques: label editorial específico ao conteúdo do artigo, em caps. Não usar o genérico `NOTÍCIA` — escolher um que descreva o ângulo real da história. Exemplos: `PESQUISA`, `LANÇAMENTO`, `MERCADO`, `CONCEITO`, `FERRAMENTA`, `PRODUTO`, `TENDÊNCIA`, `INDÚSTRIA`, `CULTURA`, `BRASIL`, `OPINIÃO`, `DADOS`, `REGULAÇÃO`. Se nenhum se encaixar bem, criar um novo que faça sentido editorial.
- Ordenar destaques por relevância editorial (scorer decide).
- LANÇAMENTOS: itens da categoria `ferramenta` que não viraram destaque.
- PESQUISAS: itens da categoria `pesquisa` (papers, estudos).
- OUTRAS NOTÍCIAS: itens `noticia`/`opiniao` que não viraram destaque.
- Se uma seção não tiver itens, omitir a seção inteira (incluindo o cabeçalho).

## Não fazer

- Não usar markdown (`**`, `#`, `-`, `_`, `>` etc.).
- Não incluir texto fora do template.
- Não adicionar emojis.
- Não mencionar "Diar.ia" dentro do corpo dos destaques (é redundante).
