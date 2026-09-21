# Bloqueio #8632 — discovery falha consecutiva (continuo/fix-8632-discovery-falha)
Data: 2026-09-21
Branch: continuo/fix-8632-discovery-falha
Status: BLOQUEADO — decisão editorial não documentada

Fonte: "tutorial IA para iniciantes sem precisar" (discovery-searcher, query aberta)
Evidência: 4 falhas consecutivas (27/08×2, 29/08, 31/08; ok 17/08) — coletado via collect-edition-signals.ts (edição 260921)

Investigação real do código:
- Não está em seed/sources.csv (fonte de discovery aberta, não cadastrada)
- Nenhum mecanismo de disable por sluga de discovery em scripts/lib/ (apenas aggregator-blocklist para fontes cadastradas)
- Sugestão da issue (desativar em seed/sources.csv) inviável para esta fonte

Ação: comentário de bloqueio postado na issue (#5754880671). Parado.
Para prosseguir: pedido explícito do editor (ex: desativar query, trocar filtros, ou adicionar ao CSV com low_cadence).
