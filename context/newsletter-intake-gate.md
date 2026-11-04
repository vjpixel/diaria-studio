### 4a-newsletters. Intake auditável (#12188)

Antes do gate, SEMPRE rodar (também em resume/`--no-gates`):

```bash
npx tsx scripts/audit-newsletter-intake.ts --edition {AAMMDD} --edition-dir {EDITION_DIR} --require-scores
```

Ler `_internal/newsletter-intake-gate.md` e apresentar a tabela COMPLETA ao editor (ou link local para o arquivo completo, nunca só top-N): score decrescente, título, newsletter, URL e destino. Incluir TODOS os warnings (`falhou`, total no inbox diferente do total registrado, captura indisponível) no `{violations_block}`. Não resumir newsletters.

Se `missing_scores > 0` ou `missing_titles > 0`: `_internal/newsletter-unscored.json` contém TODOS os candidatos IA ainda sem score, incluindo os que saíram antes do scoring/corte do pool. Primeiro rodar `npx tsx scripts/enrich-inbox-articles.ts --in {EDITION_DIR}/_internal/newsletter-unscored.json` e re-rodar a auditoria (ela reconstrói `categorized` com os metadados enriquecidos). Despachar `scorer-chunk` com esse arquivo (mesmo rubrico e contexto obrigatório), `out_path={EDITION_DIR}/_internal/newsletter-extra-scores.json`. Para títulos placeholder, ler a URL com ferramenta de leitura oficial disponível antes de pontuar; inacessibilidade deve ser reportada como falha, nunca inventar título/score. Re-rodar a auditoria até `missing_scores: 0` e `missing_titles: 0`. Scores suplementares são só auditoria, não promovem nem reintroduzem itens na edição. Sem pontuação real, mostrar falha e pausar; não fabricar zero para satisfazer o check.

Se houver `pending_senders`, perguntar UMA vez em lote ao editor quais aprovar e quais rejeitar, usando endereços exatos. Cada resposta explícita vira entrada em um JSON `{ "email@example.com": { "status": "aprovado" ou "rejeitado", "reason": "decisão do editor no gate da edição AAMMDD", "decided_at": "ISO timestamp" } }`. Persistir com:

```bash
npx tsx scripts/audit-newsletter-intake.ts --decisions {ARQUIVO_DO_LOTE}.json
```

O comando valida o lote inteiro e atualiza atomicamente `seed/newsletter-senders.json`; versionar esse caminho explícito. Nunca decidir pelo conteúdo nem re-perguntar remetentes já decididos. `--no-gates` não aprova remetentes: mantém `novo-pendente`, mostra a lista e deixa a decisão para sessão com editor. Após decisões, re-rodar `capture-newsletter-urls.ts` (com os caminhos/cursor do Stage 0) e a auditoria; newsletters recém-aprovadas também precisam ser pontuadas neste gate. Ao editar a seleção no gate, regenerar a auditoria para atualizar destinos.

