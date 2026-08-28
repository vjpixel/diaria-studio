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

## 3. Modelo ativo (não memorizar — ler `config.yaml`)

No banner desta sessão (`provider=openrouter`, `model=thinkingmachines/inkling:free`):
o wrapper `claude-openrouter.sh` resolve via `fallback_chains.coding_fallback`
em `~/.hermes/config.yaml`. Referência #6640 já atualizada: ler `config.yaml`
antes de citar a chain; NÃO confiar na memória.

Status subagente (`proc_6f661133b4a7`): `running`, 465s+, saída ainda vazia —
normal. Próximo tick confirma e retoma pendentes restantes (89).

## 4. Quando NÃO parar o ciclo (definição de sucesso, inalterada)

O ciclo termina quando NÃO há `overnight` não-reivindicado por outra sessão
ativa, NENHUM claim sem evidência de trabalho, E todos os `precisa-resposta`
respondidos. Neste tick: fila reduzida (#6465 em curso), sem bloqueio,
sem perguntas → ciclo CONTINUA.
