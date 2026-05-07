# Template — Edição Diar.ia

Formato exato do output da edição. Seguir rigorosamente.

**Importante (#245, #334):** sempre uma linha em branco entre qualquer elemento — header, título, URL, parágrafo. Isso vale tanto nos blocos DESTAQUE quanto nas seções secundárias (LANÇAMENTOS/PESQUISAS/OUTRAS NOTÍCIAS). Sem linhas em branco, viewers markdown (Drive preview, GitHub) colapsam tudo em parágrafo único ilegível.

**Formato URL (#599 — atualizado):** URL fica **embedada no próprio título via markdown link** `[Título](URL)` em vez de linha solo separada. Aplica-se tanto a destaques (cada uma das 3 opções) quanto a seções secundárias (cada item). Vantagem: menos ruído visual, título vira CTA clicável, mobile-friendly. Parsers aceitam ambos os formatos (legacy URL solo + inline) durante a transição.

**Linha de cobertura (#592, #609):** primeira linha do reviewed.md, formato literal copiado de `_internal/01-approved.json` campo `coverage.line`. Padrão esperado:

**Negrito em headers/títulos (#590):** nomes de seção e títulos saem em **negrito** (`**...**`) para hierarquia visual no Drive review (mobile). URLs e parágrafos seguem plain. Markdown link `[Título](URL)` é compatível com bold via `**[Título](URL)**`.

```
Para esta edição, eu (o editor) enviei X submissões e a Diar.ia encontrou outros Y artigos. Selecionamos os Z mais relevantes para as pessoas que assinam a newsletter.

---

**DESTAQUE 1 | [CATEGORIA]**

**[Opção de título 1 — máx. 52 chars](URL)**

**[Opção de título 2 — máx. 52 chars](URL)**

**[Opção de título 3 — máx. 52 chars](URL)**

[Parágrafo 1 — abre a história]

[Parágrafo 2 — desenvolve contexto]

[Parágrafo 3 — dados/atores relevantes]

[Parágrafo 4 — fecha com consequência concreta]

Por que isso importa:

[1 parágrafo — impacto prático para o público Diar.ia]

---

**DESTAQUE 2 | [CATEGORIA]**

[mesmo formato]

---

**DESTAQUE 3 | [CATEGORIA]**

[mesmo formato]

---

**LANÇAMENTOS**

**[Título do item](URL)**

[Frase descritiva em 1 linha]

**[Título do próximo item](URL)**

[Frase descritiva]

---

**PESQUISAS**

[mesmo formato de Lançamentos — linha em branco entre cada elemento]

---

**OUTRAS NOTÍCIAS**

[mesmo formato de Lançamentos — linha em branco entre cada elemento]

---

**VÍDEOS** (opcional — omitir se bucket vazio)

**[Título do Vídeo]** — [Canal](URL)

[Frase descritiva em 1 linha]
```

URL embedada no título (#599): editor poda 2 das 3 opções no gate de Etapa 2, sobrando 1 título-com-URL. Todas as 3 opções pré-gate apontam pra **mesma URL canônica** (são variantes do mesmo título do mesmo artigo).

## Regras de preenchimento

- CATEGORIA dos destaques: label editorial específico ao conteúdo do artigo, em caps, com emoji prefix (#265). Não usar o genérico `NOTÍCIA` — escolher um que descreva o ângulo real da história. Tabela de emojis canônicos:
  | Categoria | Emoji | Categoria | Emoji |
  |---|---|---|---|
  | LANÇAMENTO | 🚀 | PRODUTO | 📦 |
  | FERRAMENTA | 🛠️ | PESQUISA | 🔬 |
  | MERCADO | 💼 | INDÚSTRIA | 🏭 |
  | TENDÊNCIA | 📈 | CONCEITO | 💡 |
  | CULTURA | 🎭 | BRASIL | 🇧🇷 |
  | OPINIÃO | 💬 | DADOS | 📊 |
  | REGULAÇÃO | ⚖️ | PRODUTO | 📦 |
  Exemplo: `DESTAQUE 1 | 🚀 LANÇAMENTO`. Para categorias não listadas, escolher emoji semanticamente próximo.
  Se nenhum se encaixar bem, criar uma nova categoria com emoji adequado.
- Ordenar destaques por relevância editorial (scorer decide).
- LANÇAMENTOS: itens da categoria `ferramenta` que não viraram destaque.
- PESQUISAS: itens da categoria `pesquisa` (papers, estudos).
- OUTRAS NOTÍCIAS: itens `noticia`/`opiniao` que não viraram destaque.
- Se uma seção não tiver itens, omitir a seção inteira (incluindo o cabeçalho).

## Não fazer

- Não usar markdown em parágrafos. **Negrito (`**...**`) só é permitido em** nomes de seção (`**LANÇAMENTOS**`, `**DESTAQUE N**`) e títulos (#590). Outros markups (`#`, `-`, `_`, `>`) sempre proibidos.
- Não incluir texto fora do template.
- Não adicionar emojis no corpo do texto — apenas o emoji de categoria no header `DESTAQUE N | emoji CATEGORIA` é permitido (#265).
- Não mencionar "Diar.ia" dentro do corpo dos destaques (é redundante).
