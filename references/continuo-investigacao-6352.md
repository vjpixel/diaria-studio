# Investigação 6352 — Flaky: clarice-sync-opens-catchup-slicing-5946

**Classificação:** overnight (P2, bug, session-finding)
**Reivindicado por ciclo contínuo (hermes-cron-5d791ef6fc2c) em:** 2026-08-26
**Status do claim automático:** registro manual (session-registry sem sessão contínua ativa; claim no-op por sessão inexistente — registrado manualmente para evitar duplicação).

## Contexto do achado (leitura fresca do corpo + comentários)

A issue descreve uma falha determinística no CI (`AssertionError [ERR_ASSERTION]: run 3: a campanha 2 ...`) que se repete em dois PRs completamente não-relacionados (#6349 e #6350). Não é ruído aleatório — é uma condição determinística que só se manifesta sob carga do runner do GitHub Actions, não localmente.

Comentário do editor (26/08 18:43): "Avaliada na rodada /diaria-overnight 260826 e não trabalhada nela — sem bloqueio: elegível, direção clara. O motivo é capacidade — a fila não convergida." Confirma que a issue permanece `overnight` e não está reivindicada por outra sessão.

## Ação do ciclo

Como o claim automático falhou (sem sessão `continuo` registrada no `session-registry`), a reivindicação é registrada manualmente neste arquivo. Nenhum arquivo do repo será alterado além deste registro e do commit associado.

## Próximos passos (não executados neste ciclo)

- Rodar `test/clarice-sync-opens-catchup-slicing-5946.test.ts` isoladamente repetidas vezes localmente.
- Inspecionar se há `Date.now()` ou estado global não resetado entre os "runs" simulados.
- Se o fix exigir mudança em código executável, a próxima mudança passará pelo pipeline de `requesting-code-review` (regra dura da skill 0.4.0).
