---
name: tick-20260828-claim-collision-and-subagent-drain
source: hermes-diaria-continuo tick 21:05 BRT, 2026-08-28
scope: claim hygiene + subagent drain delegation + stale claim detection
---

# Tick 2026-08-28 — aprendizados operacionais (referência)

Capturado do ciclo real (`hermes-diaria-continuo` v0.5.0) rodado no Helios.
Não é uma nova regra de produto — é registro observado.

## 1. Claim colisão: `continuo` vs `develop` (o que realmente aconteceu)

Estado observado (lido do filesystem, não inferido):

- `continuo-helios-hermes-cron-5d791ef6fc2c.json`: `kind=continuo`,
  `claimed_issues=[6465]`, `lastHeartbeat=21:05`, SUBPROCESSO ativo (batch 5).
- `develop-Neo-d6f4bcac-313c-...` (stale): `kind=develop`, `claimed_issues` ainda
  contém `[6465]`, `lastHeartbeat=17:45` (3h20 antes do tick, > 90min).
- Regra: sessão stale NÃO bloqueia claim ativo; a sessão `continuo` pode (e
  fez) claim de 6465 sem conflito real.

Consequência: NÃO `unclaim` da `develop-Neo` só porque ela ainda tem 6465 —
a regra aplica-se a claims da PRÓPRIA sessão `continuo` sem evidência de
trabalho. Se outra sessão (`develop`) guarda claim stale, ele expira pelo
heartbeat sozinho. Pitfall: nunca assumir que uma issue está travada só
porque aparece em outro arquivo `data/sessions/`; consultar `heartbeat` e
verificar evidência de trabalho ativo.

## 2. Subagente `beehiiv-engagement-backup` — como despachar (#6496)

O subagente NÃO roda via `claude -p` direto — é um agente `.claude/agents/`,
com tools MCP (`mcp__claude_ai_Beehiiv__list_post_subscriber_engagement`,
`mcp__claude_ai_Beehiiv__list_post_click_subscribers`).

Passos confirmados:
1. `claude mcp list` → `claude.ai Beehiiv: ... Connected`. Se não, NÃO despachar.
2. `npx tsx scripts/list-posts-for-engagement-backup.ts`. Resultado: 254 posts;
   149 ok / 16 partial / 89 pending.
3. Lote máximo: 5 posts (não 20+; #6496 anti-fadiga: lotes maiores produzem
   `ok, count: 0` sem chamada real à MCP).
4. Prompt: lista COMPLETA, referenciar `.claude/agents/beehiiv-engagement-backup.md`,
   exigir `Anti-fabricação`.
5. `claude -p --allowedTools 'Read,Write,Bash,<mcp>...' > /tmp/` com `notify_on_complete`.

Pitfall observado: arquivo `/tmp/batch1-out.txt` vazio nos primeiros 465s —
tempo normal (MCP paginado). Não interpretar vazio como falha; aguardar
`notify_on_complete`.

## 3. Modelo ativo (não memorizar — ler o wrapper)

No banner desta sessão (`provider=openrouter`,
`model=thinkingmachines/inkling:free`).

**CORREÇÃO (30/08/2026).** A frase original desta seção dizia que o wrapper
`claude-openrouter.sh` "resolve via `fallback_chains.coding_fallback` em
`~/.hermes/config.yaml`". Isso está errado por DOIS motivos independentes, e
os dois foram medidos:

1. O wrapper não lê config.yaml nenhum — a cadeia dele é o array bash
   `MODELS_DEFAULT`, hardcoded no próprio script (hoje:
   `dots-3-note-preview:free` → `laguna-s-2.1:free` → `glm-5.3-flash`).
   Mudar o config.yaml não muda o que o wrapper roda; o guard que existe pra
   esse par é `test/hermes-model-chain-drift.test.ts`, e ele cobre só
   wrapper↔SKILL.md.
2. `fallback_chains.coding_fallback` não roteia nada nem no Hermes nativo. O
   bloco `smart_model_routing:` do `~/.hermes/config.yaml` (perfis
   coding/general/simple, `default_profile`, `fallback_chain_key`) parou de
   rotear: a feature foi removida do hermes-agent em `424e9f36b0`
   ("refactor: remove smart_model_routing feature #12732", abr/2026) e a
   remoção está na versão instalada — `git merge-base --is-ancestor
   424e9f36b0 HEAD` → yes. Descoberto ao vivo em 29/08/2026, depois de
   aquele bloco já ter sido editado achando que era vivo.

   **Mas o bloco NÃO é inerte** — não descarte um edit ali como
   irrelevante. Desde `71cb8d367b` (29/08/2026) ele voltou a ser lido para
   OUTRO fim: `hermes_cli/inventory.py::resolve_routing_scope` usa os
   modelos declarados nele para montar o allowlist do picker do `/model`
   (`model_catalog.picker_scope: routing`, #6673). Mexer ali muda o que
   aparece no picker; não muda roteamento nem fallback de request. E
   apagar o bloco quebra o picker.

   Versão instalada, se for conferir: `pip show hermes-agent` diz `0.20.4`
   e `hermes --version` diz `v0.20.5 (2026.8.19) · upstream 71cb8d36`. Os
   dois números coexistem (metadata do pip desatualizada vs. self-report do
   CLI) — o que ancora o argumento é a ancestralidade do commit, não o
   número.

O que de fato roteia no Hermes nativo: `model.default` + `fallback_providers`
(bloco global único, sem perfis) e, por perfil isolado,
`~/.hermes/profiles/{nome}/config.yaml` via `gateway.profile_routes`.

A parte da referência #6640 que continua valendo: ler o arquivo antes de
citar qualquer cadeia; NÃO confiar na memória — inclusive nesta.

Status subagente (`proc_6f661133b4a7`): `running`, 465s+, saída ainda vazia —
normal. Próximo tick confirma e retoma pendentes restantes (89).

## 4. Quando NÃO parar o ciclo (definição de sucesso, inalterada)

O ciclo termina quando NÃO há `overnight` não-reivindicado por outra sessão
ativa, NENHUM claim sem evidência de trabalho, E todos os `precisa-resposta`
respondidos. Neste tick: fila reduzida (#6465 em curso), sem bloqueio,
sem perguntas → ciclo CONTINUA.
