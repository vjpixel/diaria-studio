/**
 * clarice-db.ts — store único de usuários da Clarice (#2647).
 *
 * Um SQLite local (keyed por email) que consolida os 3 papéis das fontes:
 *   - Stripe = quem é / relacionamento comercial (snapshot estático)
 *   - Brevo  = como se comporta com nossos emails (stream dinâmico)
 *   - MV      = entregabilidade (risco de bounce)
 *
 * Achado validado (`data/clarice-subscribers/monday-drive-drafts.md`): atributos
 * estáticos da base NÃO predizem abertura (score r=0,04 · recência r=0,049 ~ zero).
 * O preditor real é histórico de abertura → por isso `score`/`OPEN_PROBABILITY`
 * NÃO entram no store; a priorização de re-envio é por comportamento
 * (`priority_points`, ver `computePriorityPoints`).
 *
 * Eixos de priorização:
 *   - `tier` (T01–T10): decide QUANDO entra no primeiro envio (de status+created).
 *   - `priority_points`: prioriza re-envios por comportamento de abertura passado.
 *   - `send_eligible` + `ineligible_reason`: corte de supressão/entregabilidade.
 *
 * Usa `node:sqlite` (built-in no Node ≥22.5 / 24) — sem dependência nativa nova.
 *
 * O arquivo .db vive em `data/clarice-subscribers/` (OneDrive, gitignored como
 * todo `data/`). Builder: `scripts/clarice-build-db.ts`. Optin manual:
 * `scripts/clarice-optin.ts`.
 */

import { DatabaseSync } from "node:sqlite";
import { resolve } from "node:path";
import type { BrevoColumns } from "./brevo-stats.ts";
import { deriveCohort } from "./clarice-segment.ts";
import { cohortFromSafra, cohortFromTier } from "./cohorts.ts";

// import.meta.dirname pode vir undefined em alguns loaders CJS (tsx eval / import
// deep-relative) — fallback pra cwd evita throw no load do módulo. Scripts do
// projeto rodam a partir da raiz, então ambos resolvem pra raiz do repo.
const ROOT = import.meta.dirname
  ? resolve(import.meta.dirname, "..", "..")
  : process.cwd();
export const DEFAULT_DB_PATH = resolve(
  ROOT,
  "data/clarice-subscribers/clarice-users.db",
);

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

/**
 * `clarice_users`: 1 linha por email (base Stripe completa, left-join Brevo/MV).
 * `priority_optin`: flag manual gerida pela CLI (`clarice-optin.ts`), separada
 *   pra sobreviver a rebuilds do store — o builder a lê via join, nunca a apaga.
 */
export const SCHEMA = `
CREATE TABLE IF NOT EXISTS clarice_users (
  email                TEXT PRIMARY KEY,
  name                 TEXT,
  stripe_ids           TEXT,            -- JSON array

  -- Stripe (5 campos mantidos; plan/total_spend/payment_count/tag/description fora — #2647)
  status               TEXT,
  created              TEXT,            -- ISO date
  delinquent           INTEGER,         -- 0 | 1 | NULL
  dispute_losses       REAL DEFAULT 0,
  refunded_volume      REAL DEFAULT 0,

  tier                 INTEGER,         -- 1..10 (T01-T10). Dupla-escrita (#2857 fase A) — continua
                                         -- AUTORITATIVO pra ordenação de 1o envio (segmentFromStore/
                                         -- tierRank); nenhum consumidor de envio lê a coluna cohort ainda.
  cohort               TEXT,            -- slug de cohort nomeado (#2857 fase A — ver scripts/lib/cohorts.ts):
                                         -- created >= epoch da safra (2026-05) -> 'leads-YYYY-MM'
                                         -- (cohortFromSafra); senão -> derivado do tier (cohortFromTier,
                                         -- ex: 'assinantes-ativos', 'leads-2025h2'); tier NULL + sem safra
                                         -- -> NULL. Antes do #2857 guardava só a safra crua 'YYYY-MM' (#2817).

  -- MillionVerifier (ingestão total per-email)
  mv_result            TEXT,            -- ok | catch_all | invalid | disposable | unknown
  mv_resultcode        INTEGER,
  mv_quality           TEXT,
  mv_subresult         TEXT,
  mv_bucket            TEXT,            -- verified | rejected | unknown (derivado)
  mv_last_verified_at  TEXT,
  mv_cycle             TEXT,            -- ciclo {conteúdo}-{envio}

  -- Brevo (ingestão total per-contato)
  recency_quartil      TEXT,
  brevo_list_ids       TEXT,            -- JSON array
  opens_count          INTEGER DEFAULT 0,
  clicks_count         INTEGER DEFAULT 0,
  sends_count          INTEGER DEFAULT 0,
  soft_bounce_count    INTEGER DEFAULT 0,
  last_open_at         TEXT,
  last_click_at        TEXT,
  last_sent_at         TEXT,
  email_blacklisted    INTEGER DEFAULT 0,
  unsubscribed         INTEGER DEFAULT 0,
  hard_bounced         INTEGER DEFAULT 0,
  complained           INTEGER DEFAULT 0,
  brevo_created_at     TEXT,
  brevo_modified_at    TEXT,

  -- Priorização derivada (recomputada a cada build, ver recomputeDerived)
  priority_optin       INTEGER DEFAULT 0,
  priority_points      INTEGER DEFAULT 0,
  send_eligible        INTEGER DEFAULT 1,
  ineligible_reason    TEXT,

  updated_at           TEXT
);

CREATE TABLE IF NOT EXISTS priority_optin (
  email     TEXT PRIMARY KEY,
  added_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_users_tier        ON clarice_users(tier);
CREATE INDEX IF NOT EXISTS idx_users_eligible    ON clarice_users(send_eligible);
CREATE INDEX IF NOT EXISTS idx_users_points       ON clarice_users(priority_points);
`;

/** Abre (ou cria) o DB e garante o schema. */
export function openClariceDb(dbPath: string = DEFAULT_DB_PATH): DatabaseSync {
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec(SCHEMA);
  migrateSchema(db);
  return db;
}

/**
 * Migrações idempotentes pra stores existentes criados ANTES de uma coluna
 * nova entrar no SCHEMA acima — `CREATE TABLE IF NOT EXISTS` não adiciona
 * colunas a uma tabela já existente, e SQLite não tem `ADD COLUMN IF NOT
 * EXISTS`, então guardamos via `PRAGMA table_info`. Roda a cada `openClariceDb`
 * (barato — 1 PRAGMA + no-op se a coluna já existe); seguro rodar 2x.
 *
 * #2817: adiciona `cohort` pra stores criados antes desta migração.
 */
function migrateSchema(db: DatabaseSync): void {
  const cols = (
    db.prepare("PRAGMA table_info(clarice_users)").all() as Array<{ name: string }>
  ).map((c) => c.name);
  if (!cols.includes("cohort")) {
    db.exec("ALTER TABLE clarice_users ADD COLUMN cohort TEXT;");
  }
}

// ---------------------------------------------------------------------------
// priority_points — prioriza re-envios por comportamento de abertura (#2647)
//
//   +40  se priority_optin (pediu pra entrar na lista de prioridade; flag manual)
//   +20  por email aberto
//   -10  por email recebido e NÃO aberto
//   quem não recebeu nenhum email → 0 (ponto de partida)
//
// Aditivo (não corte duro): um optin que ignora 4 emails decai pra 0
// (40 − 10×4) — comportamento confirmado pelo editor.
// ---------------------------------------------------------------------------

export interface PriorityInput {
  priority_optin: boolean;
  opens_count: number;
  sends_count: number;
}

export function computePriorityPoints(i: PriorityInput): number {
  const notOpened = Math.max(0, i.sends_count - i.opens_count);
  return (i.priority_optin ? 40 : 0) + 20 * i.opens_count - 10 * notOpened;
}

// ---------------------------------------------------------------------------
// Emails internos (#2809) — editor + parceiro Clarice. Abrem/testam envios por
// ofício; o engajamento deles não é sinal de audiência. EXCLUÍDOS das
// agregações de priority_points do sumário (exibição/dashboard) — mas seguem
// no store e na fila de envio normalmente (decisão do editor 260702: "é para
// continuar enviando"). Fonte única — não espalhar os literais.
// ---------------------------------------------------------------------------

export const INTERNAL_EMAILS = [
  "vjpixel@gmail.com",
  "pixel@memelab.com.br",
  "felipe@clarice.ai",
] as const;

// ---------------------------------------------------------------------------
// send_eligible / ineligible_reason — corte de supressão e entregabilidade
//
// Ordem de prioridade (primeira condição que bate vira a razão). Soft bounce é
// transitório (caixa cheia / indisponibilidade temporária) → só exclui após
// SOFT_BOUNCE_LIMIT repetidos, pra não perder contato bom por hiccup do servidor.
//
// As colunas de supressão do Brevo (unsubscribed/hard_bounced/complained/
// email_blacklisted) são mantidas por `clarice-sync-brevo.ts` (MAX-merge,
// nunca des-suprime). `send_eligible=1` só é autoritativo depois que esse
// sync rodou pelo menos 1x sobre um contato — antes disso, as colunas ficam
// no DEFAULT 0 (parecem "limpas" sem ser).
//
// mv_unknown (#2735): mv_bucket="unknown" (MV inconclusivo — reverify/error)
// vira inelegível, mas é transitório (uma re-verificação pode reabilitar).
//
// mv_unverified (#2656 cutover, REVERTIDO em #2804): entre #2656 e #2804,
// tier != 1 exigia mv_bucket==="verified" — contato nunca submetido ao MV
// (mv_bucket NULL) virava inelegível com razão "mv_unverified". Decisão do
// editor em 260702 (briefing overnight, comentário na issue #2804): "elegível
// pra todos" — contato nunca-verificado (mv_bucket NULL, qualquer tier) volta
// a ser ELEGÍVEL. A verificação MV (#1297) segue recomendada antes de enviar
// pra tiers ≥ T02, mas deixou de ser bloqueante no store. `mv_rejected` e
// `mv_unknown` continuam cortando normalmente (checados acima, tier-
// agnóstico) — só o corte específico de "nunca verificado" foi removido.
// ---------------------------------------------------------------------------

export const SOFT_BOUNCE_LIMIT = 3;

export type IneligibleReason =
  | "unsubscribed"
  | "hard_bounce"
  | "complaint"
  | "mv_rejected"
  | "mv_unknown"
  | "dispute"
  | "soft_bounce";

export interface EligibilityInput {
  email_blacklisted: boolean;
  unsubscribed: boolean;
  hard_bounced: boolean;
  complained: boolean;
  mv_bucket: string | null | undefined;
  dispute_losses: number;
  soft_bounce_count: number;
}

export function classifyEligibility(i: EligibilityInput): {
  send_eligible: boolean;
  ineligible_reason: IneligibleReason | null;
} {
  if (i.unsubscribed || i.email_blacklisted)
    return { send_eligible: false, ineligible_reason: "unsubscribed" };
  if (i.hard_bounced)
    return { send_eligible: false, ineligible_reason: "hard_bounce" };
  if (i.complained)
    return { send_eligible: false, ineligible_reason: "complaint" };
  if (i.mv_bucket === "rejected")
    return { send_eligible: false, ineligible_reason: "mv_rejected" };
  // MV inconclusivo (unknown/reverify/unverified/error, #2735) — mesma lógica
  // defensiva de rejected, mas NÃO é permanente: o registro fica no store (só
  // send_eligible=0), então uma re-verificação futura pode reabilitar. Contatos
  // nunca submetidos ao MV (mv_bucket NULL, ex: T01 ativo) não são afetados —
  // só quem tem uma linha `-unknown.csv` ingerida de fato.
  if (i.mv_bucket === "unknown")
    return { send_eligible: false, ineligible_reason: "mv_unknown" };
  if (i.dispute_losses > 0)
    return { send_eligible: false, ineligible_reason: "dispute" };
  if (i.soft_bounce_count >= SOFT_BOUNCE_LIMIT)
    return { send_eligible: false, ineligible_reason: "soft_bounce" };
  return { send_eligible: true, ineligible_reason: null };
}

/**
 * Recomputa as colunas derivadas (`priority_optin`, `priority_points`,
 * `send_eligible`, `ineligible_reason`, `cohort` — #2817, taxonomia
 * unificada #2857 fase A) pra todas as linhas a partir do estado atual de
 * Brevo/MV/Stripe + tabela `priority_optin`. Idempotente — roda no fim de
 * cada build e sempre que a flag de optin muda.
 *
 * `cohort` (#2857 fase A): `created >= epoch da safra (2026-05)` → cohort da
 * safra mensal (`cohortFromSafra(deriveCohort(created))`, forma
 * 'leads-YYYY-MM'); senão → cohort derivado do `tier` atual
 * (`cohortFromTier`, ex: 'assinantes-ativos', 'leads-2025h2'). `tier` NULL +
 * sem safra → `cohort` NULL. Como a derivação sempre recalcula do zero a
 * partir de `created`/`tier` correntes (nunca lê o `cohort` antigo), rodar
 * sobre um store com valores LEGADOS (safra crua 'YYYY-MM' de antes do
 * #2857, ou o próprio `cohort` ainda NULL) é automaticamente uma migração —
 * idempotente por construção, sem passo de migração separado. `tier`
 * INTEGER não é escrito aqui (fica intacto — dupla-escrita, fase A).
 */
export function recomputeDerived(db: DatabaseSync): number {
  const optin = new Set<string>(
    (db.prepare("SELECT email FROM priority_optin").all() as Array<{
      email: string;
    }>).map((r) => r.email),
  );

  const rows = db
    .prepare(
      `SELECT email, opens_count, sends_count, soft_bounce_count, dispute_losses,
              mv_bucket, email_blacklisted, unsubscribed, hard_bounced, complained, created, tier
       FROM clarice_users`,
    )
    .all() as Array<{
    email: string;
    opens_count: number;
    sends_count: number;
    soft_bounce_count: number;
    dispute_losses: number;
    mv_bucket: string | null;
    email_blacklisted: number;
    unsubscribed: number;
    hard_bounced: number;
    complained: number;
    created: string | null;
    tier: number | null;
  }>;

  const update = db.prepare(
    `UPDATE clarice_users
        SET priority_optin = ?, priority_points = ?, send_eligible = ?, ineligible_reason = ?, cohort = ?
      WHERE email = ?`,
  );

  // Transação única: a recomputação é all-or-nothing. Sem o wrap, um Ctrl+C no
  // meio (ex: durante `clarice-optin add` numa base grande) deixaria parte das
  // linhas com derivados novos e parte stale, sem detecção (#2649 review).
  let n = 0;
  db.exec("BEGIN");
  try {
    for (const r of rows) {
      const isOptin = optin.has(r.email);
      const points = computePriorityPoints({
        priority_optin: isOptin,
        opens_count: r.opens_count ?? 0,
        sends_count: r.sends_count ?? 0,
      });
      const elig = classifyEligibility({
        email_blacklisted: !!r.email_blacklisted,
        unsubscribed: !!r.unsubscribed,
        hard_bounced: !!r.hard_bounced,
        complained: !!r.complained,
        mv_bucket: r.mv_bucket,
        dispute_losses: r.dispute_losses ?? 0,
        soft_bounce_count: r.soft_bounce_count ?? 0,
      });
      // #2857 fase A: safra mensal (created >= epoch) tem precedência sobre
      // tier — um contato pode ter tier residual de um merge antigo mas
      // created recente (raro, mas a safra é o sinal mais fresco/específico).
      const safra = deriveCohort(r.created);
      const cohort = safra ? cohortFromSafra(safra) : cohortFromTier(r.tier);
      update.run(
        isOptin ? 1 : 0,
        points,
        elig.send_eligible ? 1 : 0,
        elig.ineligible_reason,
        cohort,
        r.email,
      );
      n++;
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  return n;
}

// ---------------------------------------------------------------------------
// Brevo → upsert das colunas de engajamento/supressão (#2647 follow-up)
//
// INSERT OR IGNORE garante a linha (contato Brevo pode não ter vindo do Stripe),
// depois UPDATE só nas colunas Brevo — não toca Stripe/MV/optin/derivados. Os
// derivados (send_eligible/priority_points) são recomputados depois via
// recomputeDerived, num passo separado, sobre a base inteira.
// ---------------------------------------------------------------------------

export function makeBrevoUpsert(db: DatabaseSync): (cols: BrevoColumns) => void {
  const ensure = db.prepare(
    "INSERT OR IGNORE INTO clarice_users (email) VALUES (?)",
  );
  // MAX-merge das flags de supressão e dos counts (colunas NOT-NULL DEFAULT 0):
  // dois registros Brevo do MESMO email (re-add após unsub) ou um re-run não podem
  // DES-suprimir — se qualquer registro é blacklisted/unsub/bounce, vale o
  // conservador (mesma garantia do OR-merge em fetchBrevoEngagement). Counts da
  // Brevo são cumulativos → MAX nunca regride. last_*/identity = overwrite com o
  // valor fresco. updated_at sempre = agora (marca quando o Brevo foi sincronizado).
  const update = db.prepare(
    `UPDATE clarice_users SET
       email_blacklisted = MAX(email_blacklisted, ?),
       unsubscribed      = MAX(unsubscribed, ?),
       hard_bounced      = MAX(hard_bounced, ?),
       complained        = MAX(complained, ?),
       opens_count       = MAX(opens_count, ?),
       clicks_count      = MAX(clicks_count, ?),
       sends_count       = MAX(sends_count, ?),
       soft_bounce_count = MAX(soft_bounce_count, ?),
       last_open_at = ?, last_click_at = ?, last_sent_at = ?,
       recency_quartil = ?, brevo_list_ids = ?,
       brevo_created_at = ?, brevo_modified_at = ?,
       updated_at = ?
     WHERE email = ?`,
  );
  return (c: BrevoColumns) => {
    if (!c.email) return; // sem email → ignora (evita colisão na key "")
    ensure.run(c.email);
    update.run(
      c.email_blacklisted,
      c.unsubscribed,
      c.hard_bounced,
      c.complained,
      c.opens_count,
      c.clicks_count,
      c.sends_count,
      c.soft_bounce_count,
      c.last_open_at,
      c.last_click_at,
      c.last_sent_at,
      c.recency_quartil,
      c.brevo_list_ids,
      c.brevo_created_at,
      c.brevo_modified_at,
      new Date().toISOString(),
      c.email,
    );
  };
}
