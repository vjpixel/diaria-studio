# Análise: Migração de Agentes LLM → Scripts TypeScript

## Resumo executivo

O pipeline Diar.ia roda 20+ agentes LLM distribuídos em 4 etapas. Vários desses agentes executam tarefas cujo núcleo é determinístico (classificação por regra, sync de arquivo, verificação de link) mas foram implementados como LLM por conveniência histórica. Migrar esses agentes para scripts TypeScript reduz custo por edição, elimina variância de output e acelera o pipeline. Os agentes que requerem linguagem natural, julgamento editorial ou navegação de UI devem permanecer como LLM — a diferenciação central é: "pode ser expresso como função pura ou sequência de chamadas de API determinísticas?"

## Candidatos à migração

| Agente | Tarefa | Determinístico? | Esforço | Risco | Recomendação |
|--------|--------|-----------------|---------|-------|--------------|
| `categorizer` | Classifica artigos em Lançamento/Pesquisa/Notícia por regras editoriais | Parcial — usa heurísticas de palavras-chave + contexto, mas o conjunto de regras é finito | Médio | Baixo | **Migrar** — a maioria dos casos é decidida por padrões de título/URL; LLM é overkill para regras documentadas em `editorial-rules.md`. Fallback LLM para casos ambíguos (ex: tool launch vs. news). |
| `link-verifier` | Verifica acessibilidade e paywall de URLs | Sim — fetch HTTP + regex de detecção de paywall | Baixo | Baixo | **Já migrado** — o agente invoca `scripts/verify-accessibility.ts`. O frontmatter do agente ainda existe como wrapper; o script é a implementação real. Remover o agente é cleanup. |
| `inbox-drainer` | Drena Gmail MCP, extrai URLs, atualiza `data/inbox.md` | Sim — parsing de email + regex de URL | Médio | Médio | **Migrar** — `scripts/inbox-drain.ts` já existe e cobre o fluxo. O agente LLM adiciona overhead de ~$0.01/drain sem ganho de qualidade. Autenticar via Gmail API direta ou manter MCP mas chamar do script. |
| `drive-syncer` | Sincroniza arquivos com Google Drive (push/pull) | Sim — diff de hashes + chamadas à API Drive | Médio | Baixo | **Já migrado** — `scripts/drive-sync.ts` é a implementação; o agente é wrapper. Remover agente é cleanup análogo ao `link-verifier`. |
| `research-reviewer` (Filtro 1: datas) | Invoca `verify-dates.ts` e `filter-date-window.ts`, aplica resultado mecanicamente | Sim — o próprio agente delega para scripts e aplica regras | Baixo | Baixo | **Migrar Filtro 1** — toda a lógica de datas já é implementada em scripts TS; o agente só orquestra chamadas e copia campos. Um script `review-dates.ts` faz o mesmo sem tokens LLM. |
| `research-reviewer` (Filtro 2: temas recentes) | Compara semanticamente artigos com `past-editions.md` para detectar repetição | Não — requer compreensão semântica do "tema central" de um artigo | — | — | **Manter como LLM** — ver seção abaixo. |
| `collect-monthly-runner` | Roda `scripts/collect-monthly.ts` e retorna resultado | Sim — puramente invoca script | Trivial | Nenhum | **Remover agente** — o orchestrator pode chamar `collect-monthly.ts` via `Bash` diretamente. |
| `auto-reporter` | Dedup de sinais + gate humano + criar/comentar issues GitHub | Parcial — dedup já migrado para `scripts/consolidate-signals.ts`; gate humano é inevitável | — | — | **Manter como LLM** — interação conversacional com editor + chamadas MCP GitHub são naturais para LLM. |
| `refresh-dedup-runner` | Wrapper sobre `scripts/refresh-past-editions.ts` | Sim | Trivial | Nenhum | **Remover agente** — orchestrator chama script direto via `Bash`. |

## Agentes que devem continuar como LLM

| Agente | Justificativa |
|--------|---------------|
| `orchestrator` | Coordena pipeline completa, toma decisões de branching baseadas em estado, interpreta respostas do editor em linguagem natural. É o "cérebro" — complexidade e variabilidade justificam Opus. |
| `source-researcher` | Busca web + extração de conteúdo + julgamento editorial sobre relevância/data/agregador. Combina tool use (WebSearch, WebFetch) com raciocínio — resistente a script por natureza do input imprevisível. |
| `discovery-searcher` | Idem `source-researcher` mas em modo aberto. O julgamento "esse veículo é agregador?" não é parametrizável com confiança como regex. |
| `scorer` / `scorer-monthly` | Atribuição de score 0–100 com raciocínio editorial sobre relevância para audiência, impacto prático e diversidade. Requer acesso a `audience-profile.md` e julgamento contextual — não é função determinística. |
| `research-reviewer` (Filtro 2) | Detecção de repetição temática ("essa é a mesma notícia?") é fundamentalmente semântica — Jaccard de tokens já provou ser insuficiente (issue #344 originou investigação de embeddings). Requer LLM ou embeddings. |
| `writer` / `writer-monthly` | Geração de newsletter. Irredutivelmente criativo. |
| `social-linkedin` / `social-facebook` | Geração de posts sociais. Criativo + tom-aware. |
| `analyst-monthly` | Agrupamento temático de ~90 destaques por narrativa. Requer compreensão de coerência temática ao longo do mês. |
| `publish-newsletter` / `publish-social` | Navegação de UI via Chrome. O Claude in Chrome é dependência fundamental — não há API oficial equivalente. |
| `review-test-email` | Inspeção visual/semântica do email renderizado para detectar problemas de layout. |
| `title-picker` | Decisão editorial de alto impacto em CTR com raciocínio sobre concretude e tom. Opus por design. |
| `inbox-drainer` (gate conversacional) | A extração de URLs é migrável, mas a interpretação de mensagens em formato livre (editor manda links sem contexto estruturado) beneficia de LLM. Migração parcial recomendada (parsing para script, julgamento para LLM como fallback). |
| `auto-reporter` | Gate humano + síntese narrativa de sinais de múltiplas edições requer LLM. |
| `eai-composer` | Já migrado para `scripts/eai-compose.ts`; agente é referência histórica. |

## Agentes já migrados (cleanup pendente)

Os agentes abaixo têm frontmatter em `.claude/agents/` mas sua lógica real vive em scripts TypeScript. O agente LLM só adiciona overhead de boot sem valor:

- `eai-composer` — `scripts/eai-compose.ts`
- `link-verifier` — `scripts/verify-accessibility.ts`
- `drive-syncer` — `scripts/drive-sync.ts`
- `collect-monthly-runner` — `scripts/collect-monthly.ts`
- `refresh-dedup-runner` — `scripts/refresh-past-editions.ts`

## Próximos passos

Issues sugeridas a abrir (com prioridade):

1. **P3 — Remover agentes wrapper já migrados** (`eai-composer` doc, `drive-syncer`, `link-verifier`, `collect-monthly-runner`, `refresh-dedup-runner`): cleanup de arquivos em `.claude/agents/` + validar que orchestrator não chama mais via `Agent()` mas sim via `Bash`. Risco baixo, ganho de manutenibilidade.

2. **P2 — Migrar `categorizer` para script TypeScript com regras explícitas**: implementar `scripts/categorize-rules.ts` com árvore de decisão baseada em palavras-chave de título + domínio + `type_hint` do researcher. Comparar acurácia contra amostra de 100 artigos categorizados pelo agente atual. LLM como fallback opcional para casos `confidence < 0.7`.

3. **P3 — Migrar Filtro 1 do `research-reviewer` para script**: o Filtro 1 (datas) já delega para `verify-dates.ts` e `filter-date-window.ts`; o agente só executa `Bash` e copia campos. Um script `scripts/research-review-dates.ts` elimina o boot do modelo Haiku pinado. Filtro 2 permanece como LLM.

4. **P2 — Avaliar embeddings para Filtro 2 do `research-reviewer`**: a migração de Jaccard→embeddings em `topic-cluster.ts` (#250) valida a infraestrutura. O Filtro 2 ("é o mesmo tema?") pode se beneficiar de cosine similarity de embeddings contra `past-editions.md` em vez de LLM puro — reduzindo custo do modelo pinado (`claude-haiku-4-5-20251001`) e aumentando consistência.
