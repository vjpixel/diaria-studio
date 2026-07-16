# Regras Editoriais Absolutas — diar.ia.br

A **diar.ia.br** é uma newsletter diária brasileira de IA ("notícias essenciais sobre IA em 5 minutos"), publicada em português, voltada a profissionais de **tecnologia, finanças e consultoria no Brasil**.

Estas regras se aplicam a toda edição. Nunca quebrar, em nenhuma circunstância.

---

## 1. Links

- **Sem paywall.** Nunca incluir link atrás de paywall. Paywalls comuns: Fortune, Bloomberg, Financial Times, Wall Street Journal, NYT, The Information, Business Insider. Se a história só tiver paywall, substituir por fonte gratuita equivalente. Validação: `npx tsx scripts/validate-domains.ts <md>` (exit ≠0 se houver paywall ou agregador).
- **Sem agregadores.** Nunca usar links de agregadores: `crescendo.ai`, `techstartups.com`, `perplexity.ai/search`, `news.google.com`, `flipboard.com`. Sempre usar URLs diretas de artigos originais.
- **Sem repetição.** Antes de incluir qualquer link, verificar `data/past-editions.md` (últimas 5 edições) — se o link ou **tema** já foi coberto, não incluir.
- **URL limpa.** Nas seções LANÇAMENTOS / RADAR, usar apenas a URL — sem título, sem texto adicional antes/depois.
- **Lançamentos só com link oficial (#160).** Cada item da seção LANÇAMENTOS deve linkar para o domínio oficial da empresa que está lançando o produto/atualização (lista em `scripts/categorize.ts > LANCAMENTO_DOMAINS`/`LANCAMENTO_PATTERNS`). Cobertura de imprensa, blogs pessoais, agregadores e análise de terceiros vão para NOTÍCIAS, mesmo quando o tema é o lançamento. Se não houver link oficial disponível na janela de pesquisa, **o item não entra em LANÇAMENTOS** (a seção pode ficar vazia — preferível a fingir que análise de terceiro é lançamento). Validação: `npx tsx scripts/validate-lancamentos.ts <md>` (exit ≠0 se houver URL não-oficial).
- **Dentro da janela de publicação.** Apenas artigos publicados dentro da janela corrida anterior à data da edição: **4 dias para edições de segunda e terça-feira** (segunda: quinta→segunda; terça: sexta→terça — ambas capturam o fim de semana), **3 dias para demais edições** (quarta a sexta).
- **arXiv canônico.** Para papers, usar `arxiv.org/abs/XXXX.XXXXX` (nunca PDF direto).
- **URLs canônicas.** Remover tracking params (`utm_*`, `ref`, etc.) e normalizar trailing slashes.

## 2. Prompt da imagem de capa

- Estilo **Van Gogh impasto**, alto contraste, proporção **2:1**.
- **NUNCA** incluir resolução em pixels (ex: "1600x900px", "1920x1080px"). Proibido.
- **Não** mencionar "Noite Estrelada" ou obras reconhecíveis de Van Gogh. Evitar céu noturno estrelado com pinceladas giratórias — produz clone de Noite Estrelada.
- Descrição em português, concreta, com elementos visuais claros.
- **Composição para crop (#2657).** A imagem D1 é usada em 2:1 (wide, newsletter) e 1:1 (square, redes sociais). O crop quadrado extrai os 800×800 pixels centrais de uma imagem 1600×800 — equivalente à metade central da largura (safe-area de ~25% a ~75% horizontal). **Quando houver múltiplos sujeitos principais, todos devem ser agrupados no terço central da composição**, nunca espalhados pelas bordas laterais. Contra-exemplo do bug 260629: 3 esferas (Sol/Terra/Lua) distribuídas ao longo de toda a largura — o crop central captura só a do meio. Evitar cenas verticais (foguete decolando, prédio alto) que perdem sentido no crop 2:1. Esta instrução também está fixada como guard determinístico no STYLE_SUFFIX em `scripts/image-generate.ts`.
- **Sem texto visível (#373).** Todo prompt deve terminar com: `Sem texto, letras, palavras, letreiros, placas ou legendas visíveis na imagem.` Não descrever elementos que implicitamente contenham texto (cartazes, painéis digitais com conteúdo, telas com texto legível). Alternativas: painel luminoso abstrato, cartazes coloridos sem texto, tela iluminada com cursor piscante.

## 3. Destaques

- Máximo **3 destaques** por edição.
- Título: **máximo 52 caracteres** (incluindo espaços). Validação: `npx tsx scripts/lint-newsletter-md.ts --check title-length --md <md>`.
- Sempre propor **3 opções de título** por destaque (todas ≤52 chars).
- **"Por que isso importa:"** sempre em **linha separada**, nunca continuando o parágrafo.
- O parágrafo de "Por que isso importa" vai **direto ao impacto** — nunca começa com "Para [audiência]," ou endereça o leitor explicitamente. Errado: "Para profissionais de tecnologia, o dado muda...". Certo: "O dado muda...". Validação: `npx tsx scripts/lint-newsletter-md.ts --check why-matters-format --md <md>`.
- Conteúdo: 4 parágrafos + 1 parágrafo de "Por que isso importa".

## 4. Categorias válidas (#1569)

- `noticia` ou `opiniao` → **DESTAQUE** ou **RADAR**
- `ferramenta` → **LANÇAMENTOS**
- `pesquisa` → **DESTAQUE** ou **RADAR** (papers entram em RADAR junto com notícias; seção PESQUISAS removida em #1569)

## 5. Linguagem

- **Evitar "IA" e "inteligência artificial" sempre que possível.** A newsletter é sobre IA — o contexto já está dado. Prefira o sujeito concreto: em vez de "a IA gerou X", escreva "o modelo gerou X"; em vez de "ferramentas de IA", escreva "ferramentas como X"; em vez de "avanços em IA", escreva "o avanço". Reserve "IA" para quando a distinção for necessária (ex: contrastar com outro campo) ou para o título, onde a palavra ancora o assunto para novos leitores.

## 6. Formatação geral

- **Markdown limitado** (#590): permitido em **negrito** (`**...**`) apenas em: nomes de seção (`**LANÇAMENTOS**`, `**RADAR**`, `**DESTAQUE N | EMOJI CATEGORIA**`, `**É IA?**`), títulos de destaques (cada uma das 3 opções), e títulos de itens em LANÇAMENTOS/RADAR. **Proibido em corpo de parágrafo**, em URLs/descrições, e em `_italic_`/`# headers`/`- bullets`. Markdown link `[título](url)` continua permitido (#599) — não conta como formatação.
- Linha em branco entre elementos.
- Em LANÇAMENTOS/RADAR: título na 1ª linha, frase descritiva na 2ª, URL limpa na 3ª, linha em branco, próximo item.

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

- [ ] Prompt de capa: sem resolução em pixels, estilo Van Gogh, 2:1, não menciona Noite Estrelada, múltiplos sujeitos agrupados no terço central (safe-area crop 1:1).
- [ ] Todos os links verificados contra paywall (status `accessible` do verifier).
- [ ] Todos os links ausentes em `data/past-editions.md`.
- [ ] Todos os links dentro da janela de datas da edição.
- [ ] "Por que isso importa:" em linha separada em cada destaque, sem "Para [audiência]," no início.
- [ ] Títulos dos destaques com ≤52 caracteres.
- [ ] 3 opções de título propostas por destaque.
- [ ] URLs de LANÇAMENTOS/PESQUISAS/OUTRAS: apenas URL, sem texto adicional.
- [ ] Texto sem markdown em parágrafos (bold permitido apenas em seções/títulos per #590; sem bullets, sem headers).
- [ ] Máximo 3 destaques, distribuídos pelas categorias válidas.

## 10. Concurso "ache o erro" — regras do erro intencional (#2149)

Cada edição inclui 1 erro intencional para os leitores encontrarem. Duas regras invariáveis:

**Regra 1 — Verificável SEM sair do email.**
O leitor deve poder detectar o erro a partir do próprio email, sem clicar na fonte. Dois tipos aceitos:
- **Inconsistência interna** (✅): o erro contradiz outro trecho do mesmo email. Ex: título diz "US$ 2 bi", corpo diz "US$ 3 bilhões".
- **Conhecimento comum do público** (✅): qualquer leitor de IA sabe que está errado de cabeça. Ex: "Amodei, CEO da DeepMind" (é da Anthropic).

Proibido:
- **Precisa da fonte** (❌): erro só confirmável clicando no link. Ex: trocar data de viralização, mudar número de uma pesquisa.

**Regra 2 — Não gerar desinformação.**
O erro não pode ser fato ou estatística plausível-mas-falso que, se não for pego, o leitor passa a acreditar. Ex: trocar "30%" por "50%" num estudo; trocar dívida de US$ 570 bi por US$ 750 bi. Erros numéricos e de data "vazam" como desinformação real para quem não percebe. Preferir contradições internas autoevidentes ou trocas que o público corrige de cabeça.

Categorias de frontmatter por risco:
- ✅ Seguras por design: `attribution`, `version_inconsistency`, `ortografico`, `factual_synthetic`
- ⚠️ Requerem revisão manual: `numeric`, `factual`, `data` — só válidos se forem inconsistência interna evidente (ex: título × corpo com valor diferente), não erro plausível que planta fato falso

Validator: `checkIntentionalErrorSafety(category)` em `scripts/lib/lint-checks/intentional-error.ts` — chamado por `lint-newsletter-md.ts --check intentional-error-flagged` (Stage 5, antes de criar draft no Beehiiv). Emite `warn` não-bloqueante para categorias ⚠️ com instrução de verificar contra as 2 regras.

---

## Seção "Vídeos" (#359)

Seção opcional após Outras Notícias. Máximo 2 vídeos por edição. Se o bucket estiver vazio, omitir a seção inteira (incluindo o cabeçalho).

**Itens da seção VÍDEO usam link do YouTube. Nunca linkar página que apenas embeda o vídeo (#3202).** Toda URL da seção deve ser `youtube.com/watch?v=...` ou `youtu.be/...` — nunca a página de blog/site oficial que hospeda o player (ex: página de anúncio da própria empresa com o vídeo embedado). Se o editor indicar um vídeo fora do YouTube, o pipeline busca automaticamente o vídeo equivalente no YouTube (Stage 1, `scripts/resolve-video-youtube.ts`, scoped a `site:youtube.com`) e substitui a URL antes do gate. Sem correspondência confiável, o item NUNCA cai de volta pra URL não-YouTube — fica flagado no gate ("vídeo sem URL de YouTube verificável — cole o link") para o editor colar o link manualmente. Validação: `npx tsx scripts/lint-newsletter-md.ts --check video-links-are-youtube --md <md>` (exit ≠0, GATE-BLOCKING, se houver URL não-YouTube na seção). Caso real (260709): "Introducing GPT-Live" só existia acessível na página oficial da OpenAI (bloqueava o bot, 403) — sem resolução automática, a URL oficial acabou reusada, duplicando o link de outro destaque.

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

## Seção "Use melhor" (#1568, renomeada de "Aprenda hoje" #59)

Seção pra conteúdo acionável (tutoriais, cookbooks, dicas práticas, treinamentos). **Mínimo 2 itens por edição** (#1855) — só omitida quando o pool genuinamente não tem 2 tutoriais reais (aí o pipeline warna no gate, nunca completa com não-tutorial). Motivação: CTR de Treinamento é 2.42% (5× a média) — audiência engaja fortemente com conteúdo educacional.

### Critérios de seleção

- **Acionável**: leitor termina o tutorial (leitura + execução) em **≤ 30 min**.
- **Prático**: ensina a fazer algo concreto, não apenas teoria.
- **Tutorial de verdade, não cobertura (#1798).** O item tem que *ensinar um procedimento* (passo a passo, "como usar", cookbook). Newsletter, post de análise, episódio de podcast, release ou notícia sobre uma ferramenta **não são tutoriais**, mesmo que o tema seja prático — esses vão pra RADAR/LANÇAMENTOS, nunca pra USE MELHOR. Sinal de alerta: domínio de agregador/newsletter (ex: `latent.space`, `*.substack.com`) ou slug sem verbo imperativo ("como", "guia", "passo a passo", "how-to", "tutorial").
- **Ferramenta de utilidade ampla (#1798).** Priorizar guia de ferramenta que o público (tech/finanças/consultoria) abre e usa no mesmo dia — planilha (ChatGPT no Excel), pesquisa/estudo (NotebookLM), automação de trabalho. Acima de recurso de nicho.
- **Diversidade de ângulo (#1798).** Com mais de 1 item, variar ferramenta ou formato (ex: NotebookLM texto + NotebookLM vídeo + Excel), nunca 3 guias quase idênticos do mesmo recurso.
- **Atual**: referencia ferramentas/APIs/modelos vigentes (≤ 12 meses de shelf life).
- **Janela de data: 60 dias (#2312).** A janela de recência do `use_melhor` é de **60 dias** (vs. 3-4d dos demais buckets). Cookbooks e how-tos de qualidade são evergreen e não seguem o ciclo de notícias — a janela longa garante que um bom tutorial publicado há 5 semanas ainda é candidato. Implementado em `bucketWindowDays("tutorial")` em `scripts/filter-date-window.ts` (constante `TUTORIAL_WINDOW_DAYS = 60`), **isolado**: LANÇAMENTOS/RADAR/VÍDEOS mantêm suas janelas curtas.
- **Independente de plano pago**: se requer subscription paga, alertar no blurb.
- **Preferir PT-BR** quando disponível; **EN é aceitável e renderiza normalmente** (revert do PT-only #1632 → #1855): título verbatim + `[TRADUZIR]` na descrição EN, igual às demais seções secundárias. A maioria dos cookbooks de qualidade é em inglês; descartá-los esvaziava a seção (#1851). (Não confundir com o relax de mínimo abaixo: o teste de "tutorial de verdade" é inegociável mesmo no relax.)
- **Título no idioma original, nunca traduzir (#1634).** O título/link do item preserva o nome original do recurso (PT ou EN) — `Claude 101`, `The Founders Playbook`, não `Claude 101: curso gratuito da Anthropic`. Não adaptar nem traduzir. A *descrição* abaixo do título pode ser em PT (descritiva). Mesma regra do RADAR.

### Garantia de mínimo no pipeline

Stage 1 deve garantir **mínimo 3 candidatos** no bucket `use_melhor` (#1629, ex-`tutorial`) de `_internal/01-approved.json`. Se o categorizer encontrar < 3, scorer deve relaxar critérios (ampliar janela de data, aceitar EN sem PT-BR equivalente, considerar artigos de fontes Primárias com pattern "how to/cookbook/guide/passo a passo"). **O relax amplia a busca, não rebaixa o tipo:** nunca completar a cota com newsletter/análise/notícia só pra bater 3 (foi o que poluiu o USE MELHOR em 260604 com 2 posts da latent.space). Preferível surfaçar "< 3 tutoriais reais" no gate a embarcar item mal-bucketado. Nunca pular silenciosamente — sem 3 candidatos, alertar no gate.

**Mínimo 2 renderizados, enforçado em Stage 2 (#1855).** `apply-stage2-caps` (`promoteUseMelhorToMinimum`) garante que a seção sai com **≥ 2 itens**: se após a seleção o bucket tiver < 2, promove runners-up **já categorizados como `use_melhor`** (tutoriais de verdade, por score desc — nunca outro bucket). Se nem com runners-up dá 2, emite warn loud (`shortfall > 0`) que o orchestrator surfa no gate. Editor pode reordenar/cortar no gate da Etapa 2.

**Mínimo 2 iniciantes, warn-only (#3213).** Após os caps de Stage 2, `check-invariants.ts --stage 2` avisa (não bloqueia) se a seleção final de USE MELHOR tiver < 2 itens classificados como `casual` ou `dev-iniciante` (`classifyAudienceClass`, #2339 — reusado, não redefinido). Caso real 260710: 2 itens renderizados, ambos `dev-avancado` (comparação de frameworks de orquestração LLM, tuning de harness), nenhum acessível a quem está começando com IA. Editor revisa/completa no gate quando o warn aparecer.

**Destaques NUNCA vêm de USE MELHOR (#3436).** A seção já tem visibilidade garantida própria (mínimo 2 itens acima) — promover um tutorial também a destaque (D1/D2/D3) é redundante e desperdiça um slot editorial nobre (imagem gerada, post social próprio) que deveria ir para uma notícia real de LANÇAMENTOS ou RADAR. `scorer-select` descarta qualquer finalista `bucket: "use_melhor"` da seleção de destaques, sem exceção — mesmo com score competitivo. Backstop determinístico: `check-invariants.ts --stage 1` bloqueia o gate (`no-use-melhor-highlights`, hard error) se algum item de `highlights[]` tiver `bucket`/`article.category` em `{"use_melhor", "tutorial"}`. Caso real 260714: "Como o Copilot acha inconsistências no Excel" (tutorial) foi selecionado como D2 antes desta regra existir.

### Fontes primárias (veja `context/sources.md` → seção "Tutoriais")

- **Cookbooks oficiais**: Anthropic Cookbook, OpenAI Cookbook
- **Tutoriais práticos**: Simon Willison's Weblog, Sebastian Raschka (Ahead of AI), Fast.ai, Hamel Husain, Eugene Yan
- **Plataformas de aprendizado**: HuggingFace Learn, Pinecone Learn, Kaggle Learn, Microsoft Learn AI, Weights & Biases
- **Newsletters técnicas**: Latent Space, Every Inc (Chain of Thought), DeepLearning.ai The Batch
- **Cursos oficiais corporativos**: Google AI for Developers, AWS Machine Learning Blog, LangChain Blog
- **BR**: Asimov Academy

### Formato na newsletter

```
🛠️ USE MELHOR

[Título acionável do item](url)
Frase descritiva curta (1 linha) — ferramenta/técnica, tempo estimado entre parênteses.
```

Exemplo:
```
🛠️ USE MELHOR

[Prompt chaining com Claude para tarefas complexas](https://simonwillison.net/2024/prompt-chaining/)
Técnica de encadear chamadas de LLM com exemplo em Python (15 min).
```

### Posição na newsletter

**Antes de LANÇAMENTOS (#1633).** É a primeira seção secundária após os destaques + É IA?. Nova ordem: (destaques + É IA?) → **USE MELHOR** → LANÇAMENTOS → RADAR → VÍDEOS → SORTEIO → PARA ENCERRAR. Montada automaticamente pelo `stitch-newsletter.ts` a partir do bucket `use_melhor` (#1752); só some quando o pool não tem 2 tutoriais (#1855).

**Links com parênteses (#1634):** se a URL do item contém `(` ou `)` (ex: PDF com `(1)` no nome), o render já tolera parênteses balanceados (`processInlineLinks`). Mesmo assim, prefira URL-encode (`%28`/`%29`) na fonte quando houver parênteses desbalanceados.

### Integração no pipeline

Status (após #1568): implementado.
- `categorize.ts` category `tutorial` → bucket `use_melhor` (#1629; TUTORIAL_DOMAINS + TUTORIAL_PATTERNS + TUTORIAL_KEYWORDS_RE)
- Stage 1 garante mínimo 3 candidatos em `01-approved.json` (scorer guardrail)
- Template `context/templates/newsletter.md` tem bloco opcional
- Writer renderiza quando selecionado, omite seção inteira caso contrário
