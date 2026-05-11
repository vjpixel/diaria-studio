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

---

**ERRO INTENCIONAL**

Na última edição, {prev_narrative}.

Nessa edição, {curr_narrative}.

---

**🎁 SORTEIO**

Você presta atenção ao conteúdo gerado por IA que consome? Para ajudar nesse exercício, há pelo menos um pequeno erro em cada edição.

**Responda indicando qual é o erro, ou se não há nenhum, e receba um número para concorrer a [um livro sobre IA entre os que recomendamos](https://diaria.beehiiv.com/livros-sobre-ia), a ser sorteado mês que vem.** Sua resposta deve chegar até mim antes do envio da edição seguinte.

---

**🙋🏼‍♀️ PARA ENCERRAR**

Nessa edição da **Diar.ia**, usei Claude Code para automatizar parte da pesquisa e criar resumos, Gemini para criar imagens e Wispr Flow para ganhar velocidade com comandos de voz ([ganhe um mês do plano Pro](https://wisprflow.ai/r?ANGELO492=)). A revisão foi feita pelo MCP da Clarice ([ganhe 25% de desconto com o cupom DIARIA](https://clarice.ai/?via=diaria)), dei o toque final e enviei via Beehiiv ([ganhe um mês grátis e 20% de desconto por 3 meses](https://www.beehiiv.com?via=Diaria)).

**Acesse:**

- [Melhores cursos grátis de IA](https://diaria.beehiiv.com/cursos-gratuitos-de-ia)
- [Curadoria de livros sobre IA](https://diaria.beehiiv.com/livros-sobre-ia)

Agora que chegou ao final da edição, que tal interagir em uma publicação no [LinkedIn](https://www.linkedin.com/company/diaria/) ou no [Facebook](https://www.facebook.com/diar.ia.br)? Seguir, comentar e compartilhar nossas publicações por lá ajuda bastante!
```

**Seções 🎁 SORTEIO + 🙋🏼‍♀️ PARA ENCERRAR (#1076):** copiadas literalmente do template Beehiiv original. Texto + links de afiliados (Wispr/Clarice/Beehiiv) mudam raramente — editor pode editar no Drive entre Stage 2 gate e publish quando precisar. Render parseia ambos como blocos editoriais (kicker + parágrafos + lista "Acesse:"), sem boxes. Pixel pediu "no reviewed" (#1076) pra ter visibilidade + edição fácil em vez de hardcoded no script. `render-newsletter-html.ts` graceful — se algum bloco ausente, omite na renderização (não falha).

**Seção ERRO INTENCIONAL (#911 / #1079):** cada edição contém 1 erro proposital. Esta seção fecha o loop entre edições com duas frases narrativas curtas — sem convite ao concurso, sem "Responda este e-mail...". É confissão direta:

- `Na última edição, {prev_narrative}.` — revela o erro da edição anterior em forma narrativa ("coloquei X onde deveria ser Y", "escrevi X mas o correto era Y", etc).
- `Nessa edição, {curr_narrative}.` — declara o erro desta edição em forma narrativa ("eu disse X, mas Y é o correto", "afirmei X quando deveria ser Y", etc).

**Regra HTML/Beehiiv (#1079):** **o erro da edição corrente NUNCA aparece no HTML enviado aos leitores.** O HTML só mostra `Na última edição, …` (reveal anterior) dentro do bloco 🎁 SORTEIO. A linha `Nessa edição, …` vive APENAS no `02-reviewed.md` — funciona como diário interno + source-of-truth pra próxima edição extrair. Razão: o erro precisa ser descoberto pelo leitor; revelá-lo na própria edição mata o jogo.

O autor escreve `{curr_narrative}` manualmente no `02-reviewed.md` da edição corrente. O script `scripts/render-erro-intencional.ts` lê o `02-reviewed.md` da edição anterior, extrai a linha `Nessa edição, …` e renderiza como `Na última edição, …` na edição corrente. Fallback: `data/intentional-errors.jsonl` quando o MD anterior não tem a linha. Tom é de auto-zoeira editorial, não de competição — sorteio do mês ainda acontece via o bloco SORTEIO no template Beehiiv, separado dessa seção.

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
