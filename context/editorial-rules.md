# Regras Editoriais Absolutas — Diar.ia

A **Diar.ia** é uma newsletter diária brasileira de IA ("notícias essenciais sobre IA em 5 minutos"), publicada em português, voltada a profissionais de **tecnologia, finanças e consultoria no Brasil**.

Estas regras se aplicam a toda edição. Nunca quebrar, em nenhuma circunstância.

---

## 1. Links

- **Sem paywall.** Nunca incluir link atrás de paywall. Paywalls comuns: Fortune, Bloomberg, Financial Times, Wall Street Journal, NYT, The Information, Business Insider. Se a história só tiver paywall, substituir por fonte gratuita equivalente.
- **Sem agregadores.** Nunca usar links de agregadores: `crescendo.ai`, `techstartups.com`, `perplexity.ai/search`, `news.google.com`, `flipboard.com`. Sempre usar URLs diretas de artigos originais.
- **Sem repetição.** Antes de incluir qualquer link, verificar `context/past-editions.md` (últimas 5 edições) — se o link ou **tema** já foi coberto, não incluir.
- **URL limpa.** Nas seções LANÇAMENTOS / PESQUISAS / OUTRAS NOTÍCIAS, usar apenas a URL — sem título, sem texto adicional antes/depois.
- **Dentro da janela de publicação.** Apenas artigos publicados nos **2 dias úteis anteriores** à data da edição (fins de semana contam como 0 dias úteis — um artigo de sexta entra na edição de segunda).
- **arXiv canônico.** Para papers, usar `arxiv.org/abs/XXXX.XXXXX` (nunca PDF direto).
- **URLs canônicas.** Remover tracking params (`utm_*`, `ref`, etc.) e normalizar trailing slashes.

## 2. Prompt da imagem de capa

- Estilo **Van Gogh impasto**, alto contraste, proporção **2:1**.
- **NUNCA** incluir resolução em pixels (ex: "1600x900px", "1920x1080px"). Proibido.
- **Não** mencionar "Noite Estrelada" ou obras reconhecíveis de Van Gogh.
- Descrição em português, concreta, com elementos visuais claros.

## 3. Destaques

- Máximo **3 destaques** por edição.
- Título: **máximo 52 caracteres** (incluindo espaços).
- Sempre propor **3 opções de título** por destaque (todas ≤52 chars).
- **"Por que isso importa:"** sempre em **linha separada**, nunca continuando o parágrafo.
- O parágrafo de "Por que isso importa" vai **direto ao impacto** — nunca começa com "Para [audiência]," ou endereça o leitor explicitamente. Errado: "Para profissionais de tecnologia, o dado muda...". Certo: "O dado muda...".
- Conteúdo: 4 parágrafos + 1 parágrafo de "Por que isso importa".

## 4. Categorias válidas

- `noticia` ou `opiniao` → **DESTAQUE** ou **OUTRAS NOTÍCIAS**
- `ferramenta` → **LANÇAMENTOS**
- `pesquisa` → **PESQUISAS**

## 5. Linguagem

- **Evitar "IA" e "inteligência artificial" sempre que possível.** A newsletter é sobre IA — o contexto já está dado. Prefira o sujeito concreto: em vez de "a IA gerou X", escreva "o modelo gerou X"; em vez de "ferramentas de IA", escreva "ferramentas como X"; em vez de "avanços em IA", escreva "o avanço". Reserve "IA" para quando a distinção for necessária (ex: contrastar com outro campo) ou para o título, onde a palavra ancora o assunto para novos leitores.

## 6. Formatação geral

- **Sem markdown** no output final. Nada de `**bold**`, `# headers`, `- bullets`, `_italic_`.
- Linha em branco entre elementos.
- Em LANÇAMENTOS/PESQUISAS/OUTRAS: título na 1ª linha, frase descritiva na 2ª, URL limpa na 3ª, linha em branco, próximo item.

---

## 7. Público-alvo e critérios de tração

Profissionais brasileiros de tecnologia, finanças e consultoria. Priorizar:

- **Alta tração** (dados históricos das últimas edições):
  - IA + impacto econômico direto e concreto
  - IA + geopolítica ou conflito
  - Grandes movimentos de mercado com consequências claras
  - Novos modelos e benchmarks
  - Regulação e governo

- **Evitar**:
  - Demissões genéricas (virou commodity)
  - Filosofia pura sem ancoragem concreta
  - Conteúdo técnico sem gancho prático

Audiência detalhada: ver `context/audience-profile.md` (gerado do Beehiiv MCP).

---

## 8. Métricas de referência

- ~300 assinantes base engajada: open rate médio ~20%.
- ~490 assinantes base completa: open rate médio ~13%.

---

## 9. Checklist pré-publicação

Antes de aprovar o texto final da edição, validar:

- [ ] Prompt de capa: sem resolução em pixels, estilo Van Gogh, 2:1, não menciona Noite Estrelada.
- [ ] Todos os links verificados contra paywall (status `accessible` do verifier).
- [ ] Todos os links ausentes em `context/past-editions.md`.
- [ ] Todos os links dentro da janela de datas da edição.
- [ ] "Por que isso importa:" em linha separada em cada destaque, sem "Para [audiência]," no início.
- [ ] Títulos dos destaques com ≤52 caracteres.
- [ ] 3 opções de título propostas por destaque.
- [ ] URLs de LANÇAMENTOS/PESQUISAS/OUTRAS: apenas URL, sem texto adicional.
- [ ] Texto sem markdown (sem bold, bullets, headers).
- [ ] Máximo 3 destaques, distribuídos pelas categorias válidas.
