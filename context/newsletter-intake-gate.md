### 4b-newsletters. Intake auditável (#12188)

Roda dentro do 4b, ANTES do `check-invariants` (também em resume/`--no-gates`):

```bash
npx tsx scripts/audit-newsletter-intake.ts --edition {AAMMDD} --edition-dir {EDITION_DIR} --require-scores
```

Ler `_internal/newsletter-intake-gate.md` e apresentar a tabela COMPLETA ao editor (ou link local para o arquivo completo, nunca só top-N): score decrescente, título, newsletter, URL e destino. Incluir TODOS os warnings (`falhou`, `parcial`, total no inbox diferente do total registrado, captura ou descoberta indisponível) no `{violations_block}`. Não resumir newsletters.

O relatório grava a impressão digital (hash de conteúdo) das entradas. O invariante `newsletter-intake` só acusa "Intake desatualizado" quando o conteúdo muda: salvar o `02-reviewed.md` sem mudar links não conta; mover, trocar ou incluir link conta e pede re-rodar a auditoria.

#### Links sem score ou sem título

Se `missing_scores > 0` ou `missing_titles > 0`: `_internal/newsletter-unscored.json` contém TODOS os candidatos IA ainda sem score ou sem título, incluindo os que saíram antes do scoring/corte do pool.

1. Rodar `npx tsx scripts/enrich-inbox-articles.ts --in {EDITION_DIR}/_internal/newsletter-unscored.json` e re-rodar a auditoria (ela reconstrói `categorized` com os metadados enriquecidos).
2. Despachar `scorer-chunk` com esse arquivo (mesmo rubrico e contexto obrigatório), `out_path={EDITION_DIR}/_internal/newsletter-extra-scores.json`. Para títulos placeholder, ler a URL com ferramenta de leitura oficial disponível antes de pontuar; inacessibilidade deve ser reportada como falha, nunca inventar título/score.
3. Re-rodar a auditoria até `missing_scores: 0` e `missing_titles: 0`.

Scores suplementares são só auditoria, não promovem nem reintroduzem itens na edição. Sem pontuação real, mostrar falha e pausar; não fabricar zero para satisfazer o check.

#### Remetentes novos

A descoberta (`_internal/discovered-newsletters.json`, só metadados) acha newsletters de remetentes sem decisão. Ela nunca entra no pool nem na linha de cobertura. Só é oferecido para decisão o remetente cujos cabeçalhos apontam para um serviço de envio em massa conhecido (`newsletter_auto_capture.bulk_service_domains`); o resto aparece no relatório só como contagem, sem endereço (privacidade: lista de discussão ou pessoa física).

Se houver `pending_senders`, perguntar UMA vez em lote ao editor quais aprovar e quais rejeitar, usando endereços exatos. Cada resposta explícita vira entrada em um JSON `{ "{REMETENTE}": { "status": "aprovado" ou "rejeitado", "reason": "decisão do editor no gate da edição AAMMDD", "decided_at": "ISO timestamp" } }`. Persistir com:

```bash
npx tsx scripts/audit-newsletter-intake.ts --decisions {ARQUIVO_DO_LOTE}.json --edition {AAMMDD} --edition-dir {EDITION_DIR}
```

O comando valida o lote inteiro antes de gravar e atualiza atomicamente `seed/newsletter-senders.json`; versionar esse caminho explícito. Rejeição de remetente que não estava em `pending_senders` da edição não é gravada (sai como `skipped_rejections`). Nunca decidir pelo conteúdo nem re-perguntar remetentes já decididos. `--no-gates` não aprova remetentes: mantém `novo-pendente`, mostra a lista e deixa a decisão para sessão com editor.

Após aprovar remetentes, buscar as threads deles (a descoberta não lê corpo), extrair os links e re-auditar:

```bash
npx tsx scripts/fetch-newsletter-threads.ts --senders {APROVADOS_SEPARADOS_POR_VÍRGULA} --since-hours {since_hours} --out {EDITION_DIR}/_internal/captured-newsletters.json
npx tsx scripts/capture-newsletter-urls.ts --threads {EDITION_DIR}/_internal/captured-newsletters.json --out {EDITION_DIR}/_internal/captured-newsletter-articles.json --cursor data/newsletter-capture-cursor.json --edition {AAMMDD}
```

Newsletters recém-aprovadas também precisam ser pontuadas neste gate (seção acima). Ao editar a seleção no gate, regenerar a auditoria para atualizar destinos.
