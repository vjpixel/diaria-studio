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
| **Brevo** | comportamento com nossos emails (dinâmico) | engajamento/supressão — *sync ao vivo é follow-up* |
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

## Scripts

| Comando | O quê |
|---|---|
| `npx tsx scripts/clarice-build-db.ts [--db <p>] [--data-dir <p>]` | (re)constrói o store: Stripe + MV → recomputa derivados. Idempotente; preserva `priority_optin` e Brevo já sincronizado. |
| `npx tsx scripts/clarice-optin.ts add <email…>` | marca optin manual (+40), com `added_at`. |
| `npx tsx scripts/clarice-optin.ts remove <email…>` | remove optin. |
| `npx tsx scripts/clarice-optin.ts list` | lista optins. |

A lógica de priorização (pontos + elegibilidade) vive em `scripts/lib/clarice-db.ts`
(`computePriorityPoints`, `classifyEligibility`, `recomputeDerived`), testada em
`test/clarice-db.test.ts`.

## Follow-up (ainda não feito)

- Sync ao vivo do Brevo (atributos + `statistics` + `emailBlacklisted`) pra dentro
  do store — rate-limited, MCP top-level (ver memória `brevo-hourly-ratelimit`).
- `clarice-build-waves.ts` ler a priorização do store (tier p/ 1º envio,
  `priority_points` p/ re-envio, `send_eligible` p/ corte) em vez de CSVs soltos.
