# Token Reduction Analysis — Pipeline de Edição (#2452)

> Status: análise + 1 corte implementado (0b-bis Gmail). Medição antes/depois
> deferida para a próxima edição de controle (ver Seção 6).

---

## 1. Contexto

O pipeline consome tokens de forma difusa em 6 stages. Cada token desperdiçado
em I/O (MCP responses, re-leituras de arquivo, re-renderizações) é subtraído
do orçamento disponível para raciocínio editorial. As 6 hipóteses do corpo da
issue foram avaliadas abaixo em ordem de impacto estimado.

Instrumentação existente: `scripts/log-stage-1-payload-sizes.ts` (#891) reporta
tamanho dos JSONs intermediários em `_internal/` após o Stage 1 (threshold warn
1MB, error 2.5MB). Não cobre tokens de MCP responses nem contexto do orchestrator.

---

## 2. Inventário dos Ofensores

### #1 — Gmail `get_thread FULL_CONTENT` no 0b-bis ⭐ MAIOR IMPACTO

**Onde:** `orchestrator-stage-0-preflight.md` § 0b-bis, passos 3–4.

**O problema:** O orchestrator chamava `mcp__claude_ai_Gmail__get_thread` com
`messageFormat: "FULL_CONTENT"` para cada uma das 6 newsletters (Cyberman, TLDR,
7min.ai, Superhuman, Lenny, Marktechpost), janela de 48h, até 20 threads.
Cada email de newsletter em HTML chega com 80–112k chars (HTML + inline CSS
+ tracking pixels + footers). Com 6–12 threads em contexto, isso soma
**480k–1.3M chars** (~120k–325k tokens) entrando no contexto do parent em uma
única rodada, antes de qualquer raciocínio editorial.

**O que o orchestrator precisa:** apenas `thread_id`, `sender`, `subject`,
`date`, e `body` (text/plain para extração de URL). O HTML nunca é usado para
nada além de fallback de extração de URL.

**Corte implementado:** `scripts/fetch-newsletter-threads.ts` (#2452)
- Usa Gmail REST API diretamente (OAuth via `data/.credentials.json`, mesmo
  mecanismo do `inbox-drain.ts`)
- Extrai somente `text/plain` (fallback: HTML stripped + truncado a 8000 chars)
- Escreve `CapturedThread[]` JSON compacto via Bash call
- Orquestrador recebe apenas o JSON summary do stdout (`{ threads_found,
  threads_written, skipped_no_body }`)
- **Redução esperada: 480k–1.3M chars → <96k chars** (6 threads × 8k limit)
  = **85–93% de redução** para esta etapa

**Nota sobre review-test-email:** o agente `review-test-email.md` também usa
`get_thread FULL_CONTENT`, mas ali o HTML completo é necessário (verificar
seções renderizadas no email de teste). Esse uso é legítimo e foi mantido.

---

### #2 — Re-render + re-humanização completa no Stage 4 ⭐⭐ ALTO IMPACTO — ✅ Implementado (#3446)

**Onde:** `orchestrator-stage-4.md` — loop de gate humano (§4d.1 passo 6, §4c.2b).

**O problema:** Quando o editor faz ajustes pós-gate (ex: muda D1, aprova D2
e D3 sem alteração), o Stage 4 re-renderiza o HTML completo (`render-newsletter-html.ts`
— newsletter-final.html ~34KB) e disparava humanizador completo de novo, mesmo
que apenas 1 dos 3 destaques tivesse mudado. O humanizador carrega ~600 linhas
de prompt (skill `humanizador`) a cada invocação.

**Impacto estimado:** 2–4 re-renders por edição em gates com ajuste = ~600k
tokens adicionais por edição (prompt do humanizador × invocação completa × re-cargas).

**Corte implementado (#3446):**
- `check-humanizer-social.ts` grava hash sha256 **por seção** (`main_dN`,
  `comment_pixel_dN`, `post_pixel`) no sentinel, além do hash whole-file
  (`computeSectionHashes`, `scripts/lib/social-lint-rules.ts`).
- `computeChangedSections()` compara os hashes por-seção armazenados contra o
  `03-social.md` atual e retorna EXATAMENTE quais blocos mudaram desde a
  última humanização — o Stage 4 usa isso pra pedir à skill humanizador que
  reescreva só esses blocos, não o arquivo inteiro.
- `scripts/verify-scoped-humanization.ts` verifica deterministicamente que a
  re-humanização scoped tocou exatamente o pedido (nem menos — bloco ignorado,
  nem mais — colateral fora do escopo) antes de gravar o sentinel.
- Sentinels gravados antes do #3446 (sem `section_hashes`) caem no fallback
  full-file antigo automaticamente (`legacy: true`) — sem regressão em
  edições em voo.
- O render de newsletter/social HTML continua completo (script determinístico,
  custo de token desprezível) — só a chamada LLM do humanizador foi escopada.

---

### #3 — Humanizador recarrega prompt inteiro a cada invocação ⭐ MÉDIO IMPACTO

**Onde:** Skill `humanizador` (`.claude/skills/humanizador/SKILL.md`), invocada
2× no Stage 2 (newsletter + social) e potencialmente N× no Stage 4 via loop.

**O problema:** Cada invocação carrega ~600 linhas de prompt de regras de
humanização. Com 2 invocações em Stage 2 + 2 em Stage 4 = 4 cargas = ~2400
linhas × 4. Se o prompt cache funcionar, o overhead é minimal (cache hit). Mas
em sessões onde o cache invalida (mudança de context/ files), o custo é real.

**Mitigação disponível:** o CLAUDE.md já menciona que `context/` é cacheado.
Garantir que `humanizador/SKILL.md` não seja modificado desnecessariamente entre
stages mantém o cache quente. Não requer código novo — é disciplina operacional.

**Corte recomendado (baixo risco, oportunidade futura):**
- Extrair os 9 passos do humanizador para um script TS parametrizado que opere
  sobre sections específicas do markdown (não o arquivo inteiro)
- Permite chamar apenas 1 vez por edição com batch das sections modificadas

---

### #4 — Round-trip Google Docs mangla frontmatter → reescrita de arquivo inteiro

**Onde:** `scripts/drive-sync.ts` (pull antes de Stage 2, 3, 4, 5).

**O problema:** Pull do Google Doc pode trazer markdown com diferenças de
encoding ou formatação que forçam o orchestrator a re-ler e re-escrever o arquivo
inteiro (ex: 02-reviewed.md com ~4KB) em vez de edição cirúrgica.

**Impacto real:** Moderado. O CLAUDE.md já tem a regra de "edições cirúrgicas"
(#495) e "pull antes de editar" (#494). O custo de token aqui é a leitura
repetida do arquivo (Read × N estages) mais eventual re-análise de conteúdo.

**Corte recomendado:** Nenhum adicional além das regras #494/#495 já vigentes.
O verdadeiro gargalo é o tamanho do arquivo lido, não o round-trip em si. Se
02-reviewed.md cresce para >20KB, vale investigar compressão de seções não
editáveis via marcadores de frontmatter.

---

### #5 — Leitura de arquivos grandes repetida (02-reviewed.md relido N×)

**Onde:** Stages 2, 4, 5 — todos leem `02-reviewed.md` múltiplas vezes.

**O problema:** `02-reviewed.md` (~4–8KB tipicamente) é relido pelo orchestrator
em cada sub-etapa. Com 3–5 releituras por edição, isso é ~20–40KB de conteúdo
de arquivo adicional no contexto.

**Impacto:** Baixo. ~40KB ≈ ~10k tokens — ruído comparado ao offender #1.

**Mitigação:** Sem código novo necessário — já está dentro dos limites normais
de operação. Monitorar se o arquivo crescer >30KB.

---

### #6 — MCP outputs grandes (Beehiiv/Gmail) entrando no contexto do parent

**Onde:** Stage 5 (`publish-newsletter`, `review-test-email`), Stage 6
(verificação de post agendado via Beehiiv MCP).

**O problema:** Calls a `mcp__claude_ai_Beehiiv__get_post` retornam o post
completo (incluindo body HTML) quando o orchestrator precisa apenas de campos
de status (`status`, `publish_date`, `scheduled_at`).

**Impacto estimado:** 1–3 calls × ~20KB por response = ~40–60KB por edição.
Moderado, mas estruturalmente corrigível.

**Corte recomendado (baixo risco, futura oportunidade):**
- Usar `get_post_stats` em vez de `get_post` quando apenas status/métricas
  são necessários
- Para verificação de estado (`resolveBeehiivState` em `scripts/lib/publish-state.ts`),
  fazer chamada via script TS que extrai só os campos relevantes — já existe o
  padrão em `publish-state.ts` (#573)
- Beehiiv MCP não suporta field projection — a única alternativa é encapsular
  a chamada num script TS que descarta o body antes de retornar ao parent

---

## 3. Priorização

| # | Ofensor | Impacto estimado | Risco do corte | Status |
|---|---------|-----------------|----------------|--------|
| 1 | Gmail `get_thread FULL_CONTENT` (0b-bis) | **480k–1.3M chars por edição** | Baixo | ✅ Implementado (#2452) |
| 2 | Re-render + re-humanização no Stage 4 | ~600k tokens/loop de ajuste | Médio | ✅ Implementado (#3446) |
| 3 | Humanizador recarrega prompt | ~2.4k linhas × 4 invocações | Baixo | Oportunidade futura |
| 4 | Round-trip Google Docs | Moderado (já mitigado #494/#495) | — | N/A |
| 5 | Re-leitura de arquivos grandes | ~10k tokens | Baixo | Monitorar |
| 6 | MCP outputs grandes Beehiiv | ~40–60KB/edição | Baixo | Oportunidade futura |

**Top 2–3 de maior impacto para atacar:**

1. **#1 — Gmail 0b-bis** (já resolvido): maior ofensor absoluto, baixo risco,
   corte contido em 1 script + mudança de prompt.
2. **#2 — Re-humanização parcial no Stage 4** (já resolvido, #3446): segundo
   maior impacto para edições com múltiplos loops de ajuste pós-gate. Hashing
   por-seção + verificação de escopo determinística.
3. **#6 — MCP outputs Beehiiv**: baixo risco de implementar (encapsular em TS)
   e elimina 40–60KB de JSON de post body do contexto do orchestrator no Stage 5–6.

---

## 4. Corte Implementado — `fetch-newsletter-threads.ts`

**Arquivo:** `scripts/fetch-newsletter-threads.ts`  
**Testes:** `test/fetch-newsletter-threads.test.ts` (18 cases)  
**Prompt alterado:** `.claude/agents/orchestrator-stage-0-preflight.md` § 0b-bis

### O que mudou

Antes (0b-bis passos 3–4):
```
3. Buscar via Gmail MCP: search_threads
4. Para cada thread: get_thread (FULL_CONTENT) → extrai body manualmente
   → N× 80–112k chars HTML no contexto do orchestrator
```

Depois (passo 3 novo):
```
3. Bash: npx tsx scripts/fetch-newsletter-threads.ts \
     --senders "email1,...,email6" \
     --since-hours 48 \
     --out _internal/captured-newsletters.json
   → orchestrator recebe apenas { threads_found, threads_written, skipped_no_body }
```

### Invariantes preservadas

- `CapturedThread[]` output shape é idêntico ao esperado por `capture-newsletter-urls.ts`
- `text/plain` preferido; HTML stripped + truncado como fallback (não remove URLs)
- `DEFAULT_BODY_LIMIT = 8000` chars preserva URLs suficientes para extração
  (teste "40 URLs within limit" verifica que 40 URLs × ~50 chars cada = ~2k chars
  ficam bem dentro do limite)
- Sem impacto no Stage 1 (consume `captured-newsletters.json` inalterado)
- Guard #1756 adaptado: usa `threads_found` do summary JSON em vez de contagem
  de threads do MCP

### O que NÃO foi alterado

- `review-test-email.md`: continua usando `get_thread FULL_CONTENT` pois precisa
  do HTML renderizado para checar estrutura do email de teste. Uso legítimo.
- `orchestrator-stage-0-preflight.md` § 0n (respostas pessoais via Gmail MCP):
  também usa `get_thread FULL_CONTENT`, mas com ≤5 threads e body usado para
  draft de resposta — fora do escopo desta issue.

---

## 5. Instruções de Uso

```bash
# Testar localmente (requer data/.credentials.json configurado):
npx tsx scripts/fetch-newsletter-threads.ts \
  --senders "cyberman@mail.beehiiv.com,dan@tldrnewsletter.com" \
  --since-hours 48 \
  --out /tmp/captured-newsletters-test.json

# Dry-run (não escreve arquivo):
npx tsx scripts/fetch-newsletter-threads.ts \
  --senders "cyberman@mail.beehiiv.com" \
  --since-hours 24 \
  --out /tmp/ignored.json \
  --dry-run
```

---

## 6. Medição Antes/Depois — Deferida

A medição "antes/depois numa edição de controle" foi **explicitamente deferida**
por design da issue: requer rodar uma edição real com instrumentação de token
counting antes e depois do corte.

**Próximos passos para medir:**
1. Adicionar logging de token count no orchestrator quando o Stage 0 completar
   (ler `usage` da response se disponível via SDK, ou estimar por output size)
2. Rodar 1 edição com o script novo; comparar `_internal/01-payload-sizes.json`
   antes/depois (o 0b-bis não produz JSONs intermediários diretamente, então o
   impacto estará no contexto do orchestrator — não capturado por payload-sizes)
3. Alternativa pragmática: comparar `_internal/stage-status.json` entre edições
   com e sem o corte, via `scripts/aggregate-costs.ts` (#3439 — `tokens_in`/
   `tokens_out` por stage agora são capturados automaticamente do transcript
   local pelo `scripts/capture-stage-usage.ts`, #3441, sem passo manual)

**Proxy imediato disponível:** tamanho de `captured-newsletters.json` por edição.
Com o script novo, cada thread contribui ≤8000 chars em vez de 80–112k chars.
Para 10 threads: `captured-newsletters.json` antes ~900KB → depois ~80KB.
