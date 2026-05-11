# Triagem: agentes LLM → scripts TS determinísticos (#1094)

Decisão por agente atual em `.claude/agents/`, com follow-ups concretos. Substitui (consolida) as análises prévias em [`llm-ts-migration-analysis.md`](./llm-ts-migration-analysis.md) e [`script-migration-plan.md`](./script-migration-plan.md) — a partir de 2026-05-11, este doc é o source-of-truth da triagem.

---

## Decisão por agente

Score: **migrar** = lógica é determinística e migração reduz custo/tempo/bugs sem perder qualidade; **manter** = LLM agrega valor irredutível (criatividade, julgamento editorial, navegação de UI); **remover** = agente é wrapper de script já migrado, basta apagar o `.md` e fazer o orchestrator chamar o script via `Bash`.

### Pipeline diário (Stage 1-4)

| Agente | Modelo | Frequência | Decisão | Justificativa |
|---|---|---|---|---|
| `source-researcher` | haiku | ~47×/edição | **Manter** | WebSearch + WebFetch + julgamento "isso é artigo válido?" sobre HTML imprevisível. Heurísticas determinísticas (`is-aggregator`, `verify-accessibility`) já cobrem boa parte mas o **extract-from-HTML** é fundamentalmente LLM-friendly. Migração parcial possível: cada fonte com RSS conhecido já roda via `scripts/fetch-rss.ts`; o agente só ataca o resto. |
| `discovery-searcher` | haiku | ~10×/edição | **Manter** | Query temática aberta — sem `site:`. O julgamento de "esse veículo é confiável?" sobre resultados de busca livre não é parametrizável com regex. |
| `eia-composer` | haiku | 1×/edição | **Migrar (parcial)** | POTD fetch + crop + Gemini API call + sorteio A/B são puramente determinísticos. Só a **redação do crédito + tradução PT** se beneficia de LLM. Proposta: `scripts/eia-compose.ts` (já existe parcialmente, ver `image-generate.ts` + `eia-answer.ts`) com 1 chamada LLM inline pra crédito. |
| `research-reviewer` (Filtro 1: datas) | haiku pinned | 1×/edição | **Migrar** | Já delega tudo pra `scripts/verify-dates.ts` + `filter-date-window.ts`. Wrapper LLM só copia campos. Risk: zero (regras já testadas). |
| `research-reviewer` (Filtro 2: temas recentes) | haiku pinned | 1×/edição | **Manter** | Detecção semântica de "esse tema já saiu" — Jaccard de tokens já provou insuficiente (#344). Embeddings é uma alternativa (ver follow-up). |
| `scorer` | opus 4.6 | 1×/edição | **Manter** | Score 0-100 com raciocínio editorial sobre relevância pra audiência + diversidade entre destaques. Não é função pura — depende de `audience-profile.md` + contexto da edição. Heurísticas (-X paywall, +Y Brasil) já existem em `scripts/lib/` como helpers, mas a decisão final é editorial. |
| `writer` | sonnet 4.6 | 1×/edição | **Manter** | Geração de newsletter editorial. Irredutivelmente criativo. |
| `social-linkedin` | sonnet 4.6 | 1×/edição | **Manter** | Tom-aware editorial copy + 6 textos auxiliares (comments) por edição. |
| `social-facebook` | sonnet 4.6 | 1×/edição | **Manter** | Ídem `social-linkedin`. |
| `title-picker` | opus 4.7 | fallback 1×/edição | **Manter** | Escolha 1-de-3 títulos com raciocínio sobre concretude + CTR. Opus deliberado por alto impacto editorial (#159). |
| `publish-newsletter` | sonnet 4.6 | 1×/edição (playbook) | **Manter** | Chrome paste via TipTap + merge tag preservation. UI navigation. Hoje já é "playbook lido pelo top-level" e não subagent Agent-dispatched, mas a marcação como agent persiste. Cleanup possível: mover pra `context/publishers/` como roteiro puro. |
| `social-instagram` | haiku | n/a (não usado) | **Remover** | Não invocado pela pipeline atual (`/diaria-edicao` só dispatcha LinkedIn + Facebook). Confirmar com Pixel antes de apagar. |
| `social-twitter` | haiku | n/a (não usado) | **Remover** | Idem `social-instagram`. |

### Suporte

| Agente | Modelo | Decisão | Justificativa |
|---|---|---|---|
| `auto-reporter` | haiku | **Manter** | Dedup contra GitHub issues abertas + síntese narrativa de sinais + gate humano. `scripts/auto-reporter-dedup.ts` já existe pro dedup; o agent ainda agrega valor na escolha de severidade/título + interação. |
| `review-test-email` | haiku | **Manter** | Verifica email contra checklist subjetiva ("layout quebrado", "imagens carregam"). Gmail MCP + Chrome fallback — inspeção visual/semântica precisa LLM. |
| `inbox-drainer` | haiku | **Remover** | Migrado para `scripts/inbox-drain.ts` (já está no `script-migration-plan.md` como ✅). Skill `/diaria-inbox` ainda dispatcha via `Agent` — atualizar pra chamar script direto via Bash. |
| `drive-syncer` | haiku | **Remover** | Migrado para `scripts/drive-sync.ts` (✅). Orchestrator já chama via Bash em vários stages; o agent `.md` é redundante. |
| `collect-monthly-runner` | haiku | **Remover** | Migrado para `scripts/collect-monthly.ts`. Skill `/diaria-mensal` pode invocar direto via Bash. |

### Pipeline mensal

| Agente | Modelo | Decisão | Justificativa |
|---|---|---|---|
| `analyst-monthly` | opus 4.7 | **Manter** | Agrupar ~90 destaques por tema requer compreensão de coerência narrativa ao longo do mês. Heurística por keyword não cobre. |
| `scorer-monthly` | opus 4.6 | **Manter** | Idem `scorer` diário. |
| `writer-monthly` | sonnet 4.6 | **Manter** | Criativo. |

---

## Resumo numérico

- **Total de `.md` em `.claude/agents/`:** 26 (inclui 6 docs de orchestrator-stage-* que são playbooks, não agents dispatchables, mais o `orchestrator.md` raiz)
- **Agents dispatchables hoje:** 20
- **Manter:** 13 (writer, writer-monthly, social-linkedin, social-facebook, scorer, scorer-monthly, source-researcher, discovery-searcher, research-reviewer F2, auto-reporter, review-test-email, title-picker, publish-newsletter, analyst-monthly)
- **Migrar (parcial):** 2 (eia-composer, research-reviewer F1)
- **Remover (wrapper redundante):** 5 (inbox-drainer, drive-syncer, collect-monthly-runner, social-instagram, social-twitter)

---

## Follow-ups concretos

Issues sugeridas pra abrir:

1. **P3 — Cleanup: remover agent wrappers redundantes**
   - Apagar `.claude/agents/{inbox-drainer,drive-syncer,collect-monthly-runner,social-instagram,social-twitter}.md`
   - Atualizar `/diaria-inbox` skill pra chamar `scripts/inbox-drain.ts` via Bash direto
   - Confirmar com Pixel se `social-instagram` e `social-twitter` realmente não rodam (provavelmente sim, mas não vi referência no orchestrator-stage-2.md)
   - Risk: baixo. Ganho: -5 arquivos de agent + 1 menos camada de indireção.

2. **P3 — Migrar `research-reviewer` Filtro 1 (datas) pra script**
   - Criar `scripts/research-review-dates.ts` que invoca `verify-dates.ts` + `filter-date-window.ts` e aplica o resultado
   - Manter `research-reviewer` agent só pro Filtro 2 (temas)
   - Risk: baixo. Ganho: -1 Haiku call por edição, ~3-5s mais rápido.

3. **P2 — Migrar `eia-composer` pra script híbrido**
   - `scripts/eia-compose.ts` faz: POTD fetch + crop + Gemini API + sorteio A/B
   - 1 chamada LLM inline (via `scripts/lib/claude-api.ts` se existir, ou Bash → `claude -p`) só pra crédito traduzido
   - Risk: médio (precisa testar tradução vs. agent atual). Ganho: -1 Haiku call + tempo determinístico.

4. **P3 — Investigar embeddings pra Filtro 2 de `research-reviewer`**
   - Hoje LLM Haiku decide "tema já saiu nas últimas 7 edições". Custo + variância alto.
   - Alternativa: embeddings (OpenAI/Cohere/local) + cosine similarity contra `past-editions.md` cacheado.
   - Risk: médio. Ganho: maior consistência, custo similar mas mais estável.

5. **P3 — Mover `publish-newsletter` pra `context/publishers/`**
   - Hoje é "playbook lido pelo top-level" mas vive em `.claude/agents/` o que confunde.
   - Mover pra `context/publishers/beehiiv-playbook.md` deixa explícito que não é subagent dispatchable.
   - Risk: zero. Ganho: clareza de modelo conceitual.

---

## Princípios de decisão usados

1. **Migrar quando:** lógica reduz a fluxo de regras + chamadas de API estruturadas; output é JSON ou strings determinísticas; histórico de bugs ≥2 envolvendo skip silencioso/variância.
2. **Manter quando:** envolve julgamento editorial sobre input livre-forma; navegação de UI; gate humano conversacional; geração criativa.
3. **Remover quando:** o `.md` do agent só existe como wrapper de um script que orchestrator/skill poderia chamar direto via Bash.

Os "Migrar parcial" reconhecem que o mesmo agent pode ter sub-tarefas determinísticas e criativas — migrar só o determinístico e deixar 1 chamada LLM inline pra parte criativa.
