# Regras Editoriais Absolutas — Diar.ia

A **Diar.ia** é uma newsletter diária brasileira de IA ("notícias essenciais sobre IA em 5 minutos"), publicada em português, voltada a profissionais de **tecnologia, finanças e consultoria no Brasil**.

Estas regras se aplicam a toda edição. Nunca quebrar, em nenhuma circunstância.

---

## 1. Links

- **Sem paywall.** Nunca incluir link atrás de paywall. Paywalls comuns: Fortune, Bloomberg, Financial Times, Wall Street Journal, NYT, The Information, Business Insider. Se a história só tiver paywall, substituir por fonte gratuita equivalente. Validação: `npx tsx scripts/validate-domains.ts <md>` (exit ≠0 se houver paywall ou agregador).
- **Sem agregadores.** Nunca usar links de agregadores: `crescendo.ai`, `techstartups.com`, `perplexity.ai/search`, `news.google.com`, `flipboard.com`. Sempre usar URLs diretas de artigos originais.
- **Sem repetição.** Antes de incluir qualquer link, verificar `context/past-editions.md` (últimas 5 edições) — se o link ou **tema** já foi coberto, não incluir.
- **URL limpa.** Nas seções LANÇAMENTOS / PESQUISAS / OUTRAS NOTÍCIAS, usar apenas a URL — sem título, sem texto adicional antes/depois.
- **Lançamentos só com link oficial (#160).** Cada item da seção LANÇAMENTOS deve linkar para o domínio oficial da empresa que está lançando o produto/atualização (lista em `scripts/categorize.ts > LANCAMENTO_DOMAINS`/`LANCAMENTO_PATTERNS`). Cobertura de imprensa, blogs pessoais, agregadores e análise de terceiros vão para NOTÍCIAS, mesmo quando o tema é o lançamento. Se não houver link oficial disponível na janela de pesquisa, **o item não entra em LANÇAMENTOS** (a seção pode ficar vazia — preferível a fingir que análise de terceiro é lançamento). Validação: `npx tsx scripts/validate-lancamentos.ts <md>` (exit ≠0 se houver URL não-oficial).
- **Dentro da janela de publicação.** Apenas artigos publicados dentro da janela corrida anterior à data da edição: **4 dias para edições de segunda e terça-feira** (segunda: quinta→segunda; terça: sexta→terça — ambas capturam o fim de semana), **3 dias para demais edições** (quarta a sexta).
- **arXiv canônico.** Para papers, usar `arxiv.org/abs/XXXX.XXXXX` (nunca PDF direto).
- **URLs canônicas.** Remover tracking params (`utm_*`, `ref`, etc.) e normalizar trailing slashes.

## 2. Prompt da imagem de capa

- Estilo **Van Gogh impasto**, alto contraste, proporção **2:1**.
- **NUNCA** incluir resolução em pixels (ex: "1600x900px", "1920x1080px"). Proibido.
- **Não** mencionar "Noite Estrelada" ou obras reconhecíveis de Van Gogh. Evitar céu noturno estrelado com pinceladas giratórias — produz clone de Noite Estrelada.
- Descrição em português, concreta, com elementos visuais claros.
- **Composição para crop.** A imagem D1 é usada em 2:1 (wide, newsletter) e 1:1 (square, redes sociais). O prompt deve garantir que os elementos principais fiquem **centrados e distribuídos horizontalmente**, sem depender de bordas verticais. Evitar cenas verticais (foguete decolando, prédio alto) que perdem sentido no crop 2:1. Preferir composições panorâmicas onde o crop preserva a narrativa visual.
- **Sem texto visível (#373).** Todo prompt deve terminar com: `Sem texto, letras, palavras, letreiros, placas ou legendas visíveis na imagem.` Não descrever elementos que implicitamente contenham texto (cartazes, painéis digitais com conteúdo, telas com texto legível). Alternativas: painel luminoso abstrato, cartazes coloridos sem texto, tela iluminada com cursor piscante.

## 3. Destaques

- Máximo **3 destaques** por edição.
- Título: **máximo 52 caracteres** (incluindo espaços). Validação: `npx tsx scripts/lint-newsletter-md.ts --check title-length --md <md>`.
- Sempre propor **3 opções de título** por destaque (todas ≤52 chars).
- **"Por que isso importa:"** sempre em **linha separada**, nunca continuando o parágrafo.
- O parágrafo de "Por que isso importa" vai **direto ao impacto** — nunca começa com "Para [audiência]," ou endereça o leitor explicitamente. Errado: "Para profissionais de tecnologia, o dado muda...". Certo: "O dado muda...". Validação: `npx tsx scripts/lint-newsletter-md.ts --check why-matters-format --md <md>`.
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

## Seção "Vídeos" (#359)

Seção opcional após Outras Notícias. Máximo 2 vídeos por edição. Se o bucket estiver vazio, omitir a seção inteira (incluindo o cabeçalho).

### Fontes elegíveis

- **Canais oficiais de labs** (OpenAI, Anthropic, Google DeepMind, Meta AI, NVIDIA, Mistral): incluir se o conteúdo for relevante para a edição.
- **Criadores técnicos reconhecidos** (ex: Andrej Karpathy, Yannic Kilcher, Lex Fridman em entrevistas técnicas): incluir com julgamento editorial — preferir conteúdo com substância técnica.
- **Conferências e palestras** (NeurIPS, ICML, ACL, etc.): incluir sessões plenárias ou palestras keynote.

### Critérios de qualidade

- **Duração máxima sugerida: 30 minutos.** Vídeos mais longos só se o conteúdo for excepcional.
- **Sem tutoriais básicos sem substância técnica.** Cookbooks e walkthroughs práticos vão para "Aprenda hoje", não "Vídeos".
- **Conteúdo recente**: dentro da janela de publicação padrão (3-4 dias).

### Formato na newsletter

```
VÍDEOS

[Título do Vídeo] — [Canal]

[URL]

[Frase descritiva em 1 linha]
```

---

## Seção "Aprenda hoje" (#59 — em scoping)

Seção editorial opcional pra conteúdo acionável (tutoriais, walkthroughs, cookbooks). Toda edição pode (mas não precisa) incluir 1 tutorial curado.

### Critérios de seleção

- **Acionável**: leitor termina o tutorial (leitura + execução) em **≤ 30 min**.
- **Prático**: ensina a fazer algo concreto, não apenas teoria.
- **Atual**: referencia ferramentas/APIs/modelos vigentes (≤ 12 meses de shelf life).
- **Independente de plano pago**: se requer subscription paga, alertar no blurb.
- **Preferir PT-BR** quando disponível; EN aceitável se conteúdo for superior.

### Fontes primárias

Veja `context/sources.md` → seção "Tutoriais":

- Simon Willison's Weblog — tutoriais LLM na prática
- Anthropic Cookbook — exemplos oficiais Claude
- HuggingFace Learn — cursos + cookbook
- DeepLearning.ai The Batch — resumos + tutoriais
- Latent Space — tutorial episodes + blog
- Every Inc (Chain of Thought) — análise prática de AI tools
- Google AI for Developers — guides oficiais
- AWS Machine Learning Blog — guides com código

### Formato

Link + blurb curto (3-5 linhas) + tempo estimado:

```
🧰 APRENDA HOJE · Prompt chaining com Claude (Simon Willison, 15 min)
Técnica de encadear chamadas de LLM pra tarefas complexas, com exemplo
em Python. Útil pra quem está começando a construir agents.
https://simonwillison.net/2024/prompt-chaining/
```

### Integração no pipeline

Status: **em scoping** (#59). Pipeline atual (categorize → scorer → writer) ainda não bucketiza tutoriais separadamente — artigos de fontes "Tutoriais" caem em `lancamento`/`pesquisa`/`noticias` via rules atuais. Implementação completa é follow-up (novo bucket `tutorial` em `Category`, render dedicado, scorer rules, template).
