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
| **Stripe** | quem é / relacionamento comercial (estático) | `buildUniverse()` do merge → 5 campos + tier |
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
(`ineligible_reason='dispute'`, `tier=null`) — são clientes reais, não somem.
Emails inválidos/disposable/test/role ficam só no audit CSV.

## Dois eixos de priorização

- **`tier` (T01–T10)** — decide *quando* entra no **primeiro** envio (de
  `status` + `created`).
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
`mv_rejected` → `dispute` → `soft_bounce` (só após **3** soft bounces; transitório).

> ⚠️ **`send_eligible` só é autoritativo após `clarice-sync-brevo.ts` rodar.**
> Num store recém-buildado (Stripe+MV só), as colunas de supressão do Brevo ficam
> no default → `send_eligible` reflete só MV + dispute, **não** captura
> descadastro/bounce. O builder emite warning e reporta `brevo_synced: false`
> nesse caso. Rode o sync do Brevo pra completar; até lá, o `clarice-build-waves.ts`
> continua excluindo `emailBlacklisted` do Brevo de forma independente.
>
> Queries de wave devem exigir `tier IS NOT NULL` além de `send_eligible = 1` —
> linhas só-de-MV/Brevo (email ausente do Stripe) entram com `tier = NULL` e sem
> proveniência comercial.

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

### Sync do Brevo — operação

⚠️ **Pesado + rate-limited.** A base toda são dezenas de milhares de contatos =
1 GET por contato; a Brevo tem limite **horário** (memória `brevo-hourly-ratelimit`).
O run é checkpoint-resumável: o progresso é durável no DB (upsert em batches
transacionais) + `data/clarice-subscribers/.brevo-sync-checkpoint.json` de ids
feitos. Se esgotar a cota / cair (exit 2), **re-rodar continua de onde parou**.
Reusa o `brevoGet` de `clarice-build-waves.ts` (respeita `Retry-After`). Requer
`BREVO_CLARICE_API_KEY`. Use `--limit N` pra um sync parcial / teste.

## Follow-up (ainda não feito)

- `clarice-build-waves.ts` ler a priorização do store (tier p/ 1º envio,
  `priority_points` p/ re-envio, `send_eligible` p/ corte) em vez de CSVs soltos.
- **Reconciliação de clientes que saíram da base:** o build é upsert-only — um
  cliente removido do export Stripe não é apagado do store (linger). Hoje é
  inofensivo (os exports são dumps completos: cancelados permanecem com
  `status='canceled'`, não somem). Se um dia o export virar incremental, adicionar
  tombstone/DELETE dos emails ausentes.
- Migrar `main()` do `merge-clarice-subscribers.ts` pra chamar `buildUniverse`
  (hoje há uma cópia inline da lógica, mantida intacta pra não tocar o caminho de
  geração de CSV validado em produção).
