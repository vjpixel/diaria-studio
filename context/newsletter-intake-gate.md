### 4b-newsletters. Intake auditável (#12188)

Roda dentro do 4b, ANTES do `check-invariants` (também em resume/`--no-gates`):

```bash
npx tsx scripts/audit-newsletter-intake.ts --edition {AAMMDD} --edition-dir {EDITION_DIR} --require-scores
```

Ler `_internal/newsletter-intake-gate.md` e apresentar a tabela COMPLETA ao editor (ou link local para o arquivo completo, nunca só top-N): score decrescente, título, newsletter, URL e destino. Incluir TODOS os warnings (`falhou`, `parcial`, total no inbox diferente do total registrado, captura ou descoberta indisponível, descoberta no teto, threads da descoberta não lidas, links com falha de fetch registrada) no `{violations_block}`. Não resumir newsletters.

O relatório grava a impressão digital (hash de conteúdo) das entradas. Do `02-reviewed.md` só entram os links AUDITADOS (URLs de newsletter de IA do relatório). O invariante `newsletter-intake` só acusa "Intake desatualizado" quando esse conteúdo muda: salvar o `02-reviewed.md` sem mudar links não conta, e trocar um link do Radar que não veio de newsletter também não; mover, incluir ou remover link de newsletter conta e pede re-rodar a auditoria. O playbook re-roda a auditoria (sem `--require-scores`) imediatamente antes do `pipeline-sentinel.ts write --step 4`, inclusive no fast-path do painel do Studio (#6444), então edição feita no gate não recusa o sentinel por fingerprint velho.

#### Links sem score ou sem título

Se `missing_scores > 0` ou `missing_titles > 0`: `_internal/newsletter-unscored.json` contém TODOS os candidatos IA ainda sem score ou sem título, incluindo os que saíram antes do scoring/corte do pool.

1. Rodar `npx tsx scripts/enrich-inbox-articles.ts --in {EDITION_DIR}/_internal/newsletter-unscored.json > {EDITION_DIR}/_internal/newsletter-unscored.enrich.json` e re-rodar a auditoria (ela reconstrói `categorized` com os metadados enriquecidos e lê do stdout gravado os `outcomes` com `fetch_failed`/`no_metadata_found` como falha de leitura registrada).
2. Despachar `scorer-chunk` com esse arquivo (mesmo rubrico e contexto obrigatório), `out_path={EDITION_DIR}/_internal/newsletter-extra-scores.json`. Para títulos placeholder, ler a URL com ferramenta de leitura oficial disponível antes de pontuar; inacessibilidade (paywall, 403, challenge) é registrada como falha em `{EDITION_DIR}/_internal/newsletter-fetch-failures.json` (`[{"url": "...", "reason": "paywall"}]`, acrescentando às entradas já existentes), nunca inventar título/score.
3. Re-rodar a auditoria até `blocking_missing: 0`.

**O que bloqueia e o que não (#12188).** A auditoria nunca bloqueia a publicação por algo que o pipeline não controla. Só bloqueia (`error` no invariante, exit 1 no `--require-scores`) link de newsletter aprovada sem score/título em que ninguém tentou: está no pool e não tem falha de leitura registrada. Viram `warning`, mostrados ao editor mas sem bloquear (nem em `--no-gates`): link com falha de fetch/enrich registrada (`FALHA FETCH (motivo)` na tabela) e link removido antes do pool por dedup/data (`in_pool: false`). O score deste último é opcional, porque o item está fora da edição por regra e o score seria só auditoria.

"Pool" é o que foi de fato ao scorer, `_internal/tmp-scoring-pool.json` (pós dedup, data e cap; #12593). O bruto `tmp-articles-raw.json` só é usado em edição sem esse arquivo. Fonte fundida num cluster (`cluster_sources`) também conta como fora do pool: quem é pontuado é o item principal. Link pontuado e fora da edição cujo título continua placeholder (`(newsletter:...)`) vira warning: o score já é a avaliação, o título ali é só exibição da tabela. Score fora de 0-100 é score real (bônus e penalidades somados ao `score_base`).

Scores suplementares são só auditoria, não promovem nem reintroduzem itens na edição. Sem pontuação real, mostrar a falha; não fabricar zero para satisfazer o check.

#### Remetentes novos

A descoberta (`_internal/discovered-newsletters.json`, só metadados) acha newsletters de remetentes sem decisão. Ela nunca entra no pool nem na linha de cobertura. Só é oferecido para decisão o remetente cujos cabeçalhos apontam para um serviço de envio em massa conhecido (`newsletter_auto_capture.bulk_service_domains`); o resto aparece no relatório só como contagem, sem endereço (privacidade: lista de discussão ou pessoa física).

Se houver `pending_senders`, perguntar UMA vez em lote ao editor quais aprovar e quais rejeitar, usando endereços exatos. Cada resposta explícita vira entrada em um JSON `{ "{REMETENTE}": { "status": "aprovado" ou "rejeitado", "reason": "decisão do editor no gate da edição AAMMDD", "decided_at": "ISO timestamp" } }`. Persistir com:

```bash
npx tsx scripts/audit-newsletter-intake.ts --decisions {ARQUIVO_DO_LOTE}.json --edition {AAMMDD} --edition-dir {EDITION_DIR}
```

O comando valida o lote inteiro antes de gravar e atualiza atomicamente `seed/newsletter-senders.json`; versionar esse caminho explícito. Rejeição de remetente que não estava em `pending_senders` da edição não é gravada (sai como `skipped_rejections`). Nunca decidir pelo conteúdo nem re-perguntar remetentes já decididos. `--no-gates` não aprova remetentes: mantém `novo-pendente`, mostra a lista e deixa a decisão para sessão com editor.

Após aprovar remetentes, buscar as threads deles (a descoberta não lê corpo), extrair os links e re-auditar. O `--no-sentinel` é obrigatório nesse re-fetch: o sentinel `.capture-newsletter-failed.json` é da captura do Stage 0, e uma busca suplementar não pode apagá-lo (escondendo a falha da linha de cobertura) nem gravá-lo:

```bash
npx tsx scripts/fetch-newsletter-threads.ts --senders {APROVADOS_SEPARADOS_POR_VÍRGULA} --since-hours {since_hours} --out {EDITION_DIR}/_internal/captured-newsletters.json --no-sentinel
npx tsx scripts/capture-newsletter-urls.ts --threads {EDITION_DIR}/_internal/captured-newsletters.json --out {EDITION_DIR}/_internal/captured-newsletter-articles.json --cursor data/newsletter-capture-cursor.json --edition {AAMMDD}
```

Newsletters recém-aprovadas também precisam ser pontuadas neste gate (seção acima). Ao editar a seleção no gate, regenerar a auditoria para atualizar destinos.
