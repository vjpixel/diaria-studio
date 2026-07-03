# Store único de usuários da Clarice (#2647)

Um SQLite local (`data/clarice-subscribers/clarice-users.db`, keyed por email)
que consolida o que antes vivia fragmentado e lossy em CSVs de tier, arquivos MV
por ciclo, Brevo e o `excluded.csv`. Vive no OneDrive como todo `data/`
(gitignored).

## Por que existe

A priorização de envio era re-derivada manualmente a cada ciclo. Pior: o
`merge-clarice-subscribers.ts` calcula muito sinal do Stripe mas os CSVs de tier
só guardam `email,NOME,OPEN_PROBABILITY` — o resto é descartado. O store para de
perder esse sinal e torna "priorizar envio" uma query, não um merge ad-hoc.

## As 3 fontes (papéis distintos)

| Fonte | Papel | Como entra |
|---|---|---|
| **Stripe** | quem é / relacionamento comercial (estático) | `buildUniverse()` do merge → 5 campos + cohort |
| **Brevo** | comportamento com nossos emails (dinâmico) | engajamento/supressão via `clarice-sync-brevo.ts` |
| **MV** | entregabilidade (risco de bounce) | `mv-export-*` de cada ciclo `{conteúdo}-{envio}/` |

> **Achado validado** (`monday-drive-drafts.md`): atributos estáticos da base não
> predizem abertura (`score` r=0,04 · recência r=0,049 ~ zero). Por isso `score` e
> `OPEN_PROBABILITY` **não** entram no store. O preditor real é histórico de
> abertura → ver `priority_points`.

## Stripe: 5 campos mantidos (#2647)

`status`, `created`, `delinquent`, `dispute_losses`, `refunded_volume`.
**Fora:** `plan`, `total_spend`, `payment_count`, `tag`, `description` (este só no
audit `excluded.csv`).

Disputados (chargeback) **entram** no store marcados como inelegíveis
(`ineligible_reason='dispute'`, `cohort=null` na escrita direta do ingest —
`recomputeDerived` ainda faz backfill informativo via `created`, se presente).
São clientes reais, não somem.
Emails inválidos/disposable/test/role ficam só no audit CSV.

## Dois eixos de priorização

- **`cohort`** (slug nomeado — `assinantes-ativos`, `ex-assinantes`,
  `leads-{período}`, `leads-caudao`; #2857 cutover fase C) — decide *quando*
  entra no **primeiro** envio. `assinantes-ativos`/`ex-assinantes` são fixos
  (de `status`/histórico de pagamento); leads derivam do período REAL de
  `created` (mensal `leads-YYYY-MM` desde a safra #2817, senão semestre real
  `leads-YYYYhN`). Ordem total via `cohortSendRank` (`scripts/lib/cohorts.ts`).
  `tier` (T01–T10, INTEGER) é **coluna legado read-only** desde o cutover —
  ingest novo não escreve mais nela; só serve de fallback pra linhas antigas
  sem `cohort`/`created` (ver `computeCohort`, `scripts/lib/clarice-db.ts`).
- **`priority_points`** — prioriza **re-envios** por comportamento:

  ```
  priority_points =
      (priority_optin ? +40 : 0)        // pediu pra entrar na lista (flag manual)
    + 20 * opens_count                  // +20 por email aberto
    - 10 * (sends_count - opens_count)  // -10 por recebido e NÃO aberto
  quem não recebeu nenhum email → 0
  ```

  Aditivo, não corte duro: um optin que ignora 4 emails decai pra 0 (40 − 10×4).

## Elegibilidade

`send_eligible` é `false` se qualquer condição bater; `ineligible_reason` guarda a
primeira pela ordem:

`unsubscribed` (ou `emailBlacklisted`) → `hard_bounce` → `complaint` →
`mv_rejected` → `mv_unknown` → `dispute` → `soft_bounce` (só após **3** soft
bounces; transitório) → `mv_unverified` (por último — "ainda não processado",
mais fraco que dispute/soft_bounce).

> **Override de engajamento (#2876, editor 260702).** `priority_points > 0`
> (opt-in explícito OU abertura real) **sobrepõe** os vereditos do MV
> (`mv_rejected`/`mv_unknown`/`mv_unverified`) — a abertura é prova empírica de
> entregabilidade, mais forte que a heurística estática do MV (falso-positivo
> em catch-all/greylist). Vale **só** pros vereditos do MV: consentimento e
> entrega real (`unsubscribed`/blacklist/`hard_bounce`/`complaint`/`dispute`/
> `soft_bounce`, checados **antes**) cortam sempre, engajamento não anula.
> Opt-in num e-mail inválido é auto-corretivo: o 1º envio quica e o
> `hard_bounce` corta depois.

> ⚠️ **`mv_unverified` (#2656 → REVERTIDO em #2804 → RE-INTRODUZIDO em #2888,
> mesmo dia).** Entre #2656 e #2804, `mv_bucket` NULL (nunca submetido ao MV)
> virava inelegível com razão `mv_unverified`; tier 1 era isento. #2804 removeu
> esse corte ("elegível pra todos"). **#2888 reverte #2804** — o editor decidiu
> que enviar sem verificação prévia é risco de bounce demais — com 2 exceções:
> (1) cohort `assinantes-ativos` (pagante Stripe, validado implicitamente pelo
> pagamento — mesma isenção do #2656, expressa via `cohort` em vez de
> `tier === 1` desde que #2857 fase C tornou cohort o modelo); (2)
> `priority_points > 0` (mesmo override de engajamento do #2876 acima —
> `mv_unverified` é a irmã ausente do `mv_rejected`/`mv_unknown`). `mv_rejected`
> e `mv_unknown` continuam cortando normalmente (checados acima).

> ⚠️ **`send_eligible` só é autoritativo após `clarice-sync-brevo.ts` rodar.**
> Num store recém-buildado (Stripe+MV só), as colunas de supressão do Brevo ficam
> no default → `send_eligible` reflete só MV + dispute, **não** captura
> descadastro/bounce. O builder emite warning e reporta `brevo_synced: false`
> nesse caso. Rode o sync do Brevo pra completar antes de gerar waves —
> `clarice-build-waves-store.ts` **não** tem fallback independente de exclusão de
> blacklist (o antigo `clarice-build-waves.ts`, removido em #2844/260702, fazia
> um fetch próprio de `emailBlacklisted`; hoje `send_eligible` é a única fonte).
>
> Queries de wave devem exigir `cohort IS NOT NULL` além de `send_eligible = 1` —
> linhas só-de-MV/Brevo (email ausente do Stripe) entram com `cohort = NULL` e
> sem proveniência comercial.

## Scripts

| Comando | O quê |
|---|---|
| `npx tsx scripts/clarice-build-db.ts [--db <p>] [--data-dir <p>]` | (re)constrói o store: Stripe + MV → recomputa derivados. Idempotente; preserva `priority_optin` e Brevo já sincronizado. |
| `npx tsx scripts/clarice-optin.ts add <email…>` | marca optin manual (+40), com `added_at`. |
| `npx tsx scripts/clarice-optin.ts remove <email…>` | remove optin. |
| `npx tsx scripts/clarice-optin.ts list` | lista optins. |
| `npx tsx scripts/clarice-sync-brevo.ts [--db <p>] [--concurrency N] [--limit N]` | sincroniza engajamento/supressão do Brevo (opens/clicks/sends/bounces/unsub/last_*) → recomputa derivados. **Checkpoint-resumável** + rate-limit-aware. |

A lógica de priorização (pontos + elegibilidade) vive em `scripts/lib/clarice-db.ts`
(`computePriorityPoints`, `classifyEligibility`, `recomputeDerived`), testada em
`test/clarice-db.test.ts`. O parsing de contato Brevo vive em
`scripts/lib/brevo-stats.ts` (`parseBrevoContact`), testado em `test/brevo-stats.test.ts`.

### Lookup por email — norma de processo (#2863)

`findContactByEmail(db, email)` (`scripts/lib/clarice-db.ts`) é o helper CANÔNICO
pra procurar um contato: tenta match exato (lowercase/trim) e, se não achar,
tenta normalização Gmail (`canonicalizeGmail`, #1969 — local-part sem pontos,
ignora `+sufixo`, só pra domínios `gmail.com`/`googlemail.com`; fora do Gmail
pontos são significativos e não normaliza). **Ausência no store só é afirmável
depois de (a) este lookup normalizado E (b) grep dos CSVs crus em
`data/clarice-subscribers/`** — o segundo passo é barato e foi o que resolveu o
incidente de 260702 (4 contatos etiquetados errado como "não é cliente Stripe"
porque o lookup usou só match exato). Extensão do princípio #573 (validar
antes de relayar) pra negative claims. `scripts/clarice-optin.ts add` já usa
este helper pra resolver a variante recebida pro canônico do store (#2861).

### Sync do Brevo — operação

⚠️ **Pesado + rate-limited.** A base toda são dezenas de milhares de contatos =
1 GET por contato; a Brevo tem limite **horário** (memória `brevo-hourly-ratelimit`).
O run é checkpoint-resumável: o progresso é durável no DB (upsert em batches
transacionais) + `data/clarice-subscribers/.brevo-sync-checkpoint.json` de ids
feitos. Se esgotar a cota / cair (exit 2), **re-rodar continua de onde parou**.
Reusa o `brevoGet` de `scripts/lib/brevo-client.ts` (respeita `Retry-After`). Requer
`BREVO_CLARICE_API_KEY`. Use `--limit N` pra um sync parcial / teste.

## Cutover store-driven de waves (#2656) — FEITO

`scripts/clarice-build-waves-store.ts` monta as waves a partir do store (base
inteira) e é o único builder de waves em produção (legado — `clarice-build-waves.ts`,
o cohort T1/T2 + fetch ao vivo — removido em #2844/260702): corte por
`send_eligible`, re-envio por `priority_points`, 1º envio por `cohort` (#2857
fase C — sucessor de `tier`, que virou coluna legado read-only).
Fila (`priorityQueue`): engajado → 1º envio → re-envio decaído. Pega o topo até
`--budget` (lever de expansão de alcance) e fatia em `--wave-size`. Escreve
`wN-store.csv` + `waves-manifest.json`; o `clarice-import-waves.ts` lê o manifest
(sem fallback — manifest ausente é erro claro desde #2844). Só escreve CSV — envio
segue gated (import dry-run + schedule manual). Validado pelo dry-run comparativo
(`clarice-waves-dryrun.ts`, #2662): na supressão é no-op vs o pipeline pré-cutover;
o que muda é a segmentação.

Uso: `npx tsx scripts/clarice-build-waves-store.ts --cycle 2606-07 [--budget 8000] [--wave-size 2000] [--dry-run]`.

## Follow-up (ainda não feito)

- **Reconciliação de clientes que saíram da base:** o build é upsert-only — um
  cliente removido do export Stripe não é apagado do store (linger). Hoje é
  inofensivo (os exports são dumps completos: cancelados permanecem com
  `status='canceled'`, não somem). Se um dia o export virar incremental, adicionar
  tombstone/DELETE dos emails ausentes.
- Migrar `main()` do `merge-clarice-subscribers.ts` pra chamar `buildUniverse`
  (hoje há uma cópia inline da lógica, mantida intacta pra não tocar o caminho de
  geração de CSV validado em produção).
