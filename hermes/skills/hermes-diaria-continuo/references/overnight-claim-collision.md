---
name: overnight-claim-collision-pattern
reference_for: hermes-diaria-continuo
description: Padrão de colisão entre sessões coordenadoras (continuo × overnight/develop/interactive) via session-registry. Corrigido em 26/08: exclusão por claim específico, não por categoria.
source: ciclo 26/08/2026 (skill v0.4.2, PR #6396, session-registry.ts)
---

# Padrão: Colisão Overnight × Contínuo

## O que era errado (v0.4.0)

Regra: `overnight ativo = não reivindica nenhuma issue nova`. Isso era **exclusão por categoria** — bloqueava toda a fila apenas porque uma sessão `overnight` existia, mesmo que ela só reivindicasse 1 issue específica.

Consequência: o contínuo ficava ocioso enquanto o overnight implementava uma única issue (#6336) e 15+ outras `overnight` elegíveis permaneciam sem dono.

## A correção (v0.4.2)

**Exclusão por claim específico**, não por categoria:

1. `active-of-kind --kind overnight` → sessões ativas (não só overnight)
2. Coletar `claimed_issues` de cada uma
3. Pular apenas as reivindicadas (`is-claimed --issue N` falha = pular)
4. Stale (`stale:true`, >90min) NÃO bloqueia — já tratado pelo check
5. `uncertain:true` = "não posso afirmar que está livre" → pular só as explícitas

Exemplo real (26/08): overnight `ca0e0596` (stale, heartbeat 18:45, claims: 5653, 5942, 6035, 6181, 6186, 6202, 6217, 6254, 6259, 6265, 6269, 6275, 6307, 6308, 6309, 6311). O contínuo não pula todas — só as 16 listadas.

Verificação: `npx tsx scripts/lib/session-registry.ts active-of-kind --kind overnight`
Referência código: `session-registry.ts` (`COORDINATOR_SESSION_KINDS`, `SOFT_STALE_MS`, `is-claimed`, check-and-set #6236). Skill: `hermes-diaria-continuo` §2 (v0.4.2).
