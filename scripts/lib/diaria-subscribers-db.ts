/**
 * diaria-subscribers-db.ts — store histórico centrado no assinante, unificando
 * Beehiiv + Brevo + Kit (#6464, fatia 2 — #6585).
 *
 * Fundação das fatias 3-7 do épico #6464: nada nelas anda sem este esquema
 * existir. Copia o PADRÃO já provado por `scripts/lib/clarice-db.ts` (SQLite
 * via `node:sqlite`, builtin no Node ≥22.5, zero dependência nova, roda com
 * 435k linhas hoje) — mas é um DB **separado**, nunca extensão de
 * `clarice-users.db`: base diferente (~600 assinantes da diária vs 435k da
 * Clarice), audiência diferente, semântica diferente. Só o padrão se copia.
 *
 * ## A decisão de modelagem que não pode ser diluída
 *
 * Fato + dimensão, não contador. `clarice_users` guarda agregado
 * (`opens_count`, `clicks_count`, `last_open_at`) e agregado não responde
 * timeline — que é a pergunta que motivou o épico ("alguém que assinou na
 * Beehiiv, clicou, esfriou, entrou na reativação pelo Brevo, clicou lá,
 * voltou, foi migrado pro Kit e clicou de novo" — history atravessando 3
 * silos). Derivadas (score, probabilidade de abertura) são SEMPRE
 * recomputadas em cima de `event`, nunca persistidas — mesma lição já paga
 * pelo `clarice-db`: `score`/`OPEN_PROBABILITY` ficaram fora do store porque
 * atributo estático não prediz abertura (r=0,04); o preditor real é
 * comportamento passado, consultável via `event`.
 *
 * ## Esquema
 *
 *   - `subscriber`       — identidade canônica (1 linha por pessoa resolvida).
 *   - `identity_alias`   — `(platform, external_id, email) → subscriber_id`.
 *     NUNCA PK ingênua por e-mail: `canonicalizeGmail` já mostra que o mesmo
 *     humano usa formas distintas de e-mail, e há identidade que
 *     legitimamente NÃO junta (voto anônimo do É IA?). Reingestão da MESMA
 *     plataforma com a MESMA identidade externa é idempotente (nunca cria
 *     um 2º `subscriber` pro mesmo alias já visto) — ver `ensureSubscriber`.
 *     A resolução determinística CROSS-plataforma (quando dois aliases de
 *     plataformas DIFERENTES são a mesma pessoa, por e-mail canonicalizado)
 *     é a fatia 5 do épico — implementada em
 *     `diaria-subscribers-identity-resolve.ts` (#6589), como um passo
 *     SEPARADO que roda depois da ingestão, não dentro de `ensureSubscriber`.
 *   - `subscription`     — 1 linha por `(subscriber × platform)`: status,
 *     datas de entrada/saída, origem/UTM.
 *   - `event`            — o fato: `{subscriber_id, platform, type, ts, ...}`.
 *     `subscriber_id` **não tem FK rígida bloqueante** contra `subscription`
 *     — as fatias 3 (Kit) e 4 (Brevo) rodam em ordem indeterminada, e um
 *     evento de uma plataforma cuja `subscription` ainda não foi ingerida
 *     precisa caber. `event.subscriber_id` só precisa apontar pra um
 *     `subscriber` já resolvido via `ensureSubscriber` (garantido pelo
 *     próprio chamador, que sempre resolve o subscriber antes de gravar o
 *     evento) — nunca depende de existir uma `subscription` correspondente.
 *
 * ## Idempotência do builder
 *
 * `event` tem chave natural `(platform, type, external_event_id)` — re-rodar
 * a ingestão de uma plataforma nunca duplica o mesmo evento (`INSERT OR
 * IGNORE`, ver `recordEvent`). `subscription` tem chave natural `(subscriber_id,
 * platform)` — upsert (`ON CONFLICT DO UPDATE`), nunca duplica linha por
 * reingestão. `identity_alias` tem chave natural `(platform, external_id,
 * email)` — `ensureSubscriber` faz find-or-create por essa chave.
 *
 * ## Fail-soft com `data/` ausente
 *
 * `data/` é uma junction/symlink pro OneDrive — não existe num clone fresco
 * nem em sessão cloud (mesmo cenário de `clarice-db.ts`/`clarice-envio-enabled.ts`).
 * `openDiariaSubscribersDb` (uso normal, escrita) pode lançar se o diretório
 * não existir — é o comportamento de `new DatabaseSync(path)` do Node, igual
 * a `openClariceDb`. Para qualquer caminho de LEITURA que precise degradar
 * graciosamente (painel do Studio, fatia 6), usar
 * `openDiariaSubscribersDbSafe`, que nunca lança — `data/` ausente, store
 * corrompido ou qualquer erro de abertura viram `null` (mesmo padrão de
 * `buildContactsSummaryLocal` em `scripts/studio-ui/dashboard-clarice.ts`).
 *
 * O arquivo .db vive em `data/diaria-subscribers/diaria-subscribers.db`
 * (OneDrive, gitignored como todo `data/`).
 *
 * @see scripts/diaria-subscribers-build-db.ts — bootstrap/CLI (schema + summary).
 * @see https://github.com/vjpixel/diaria-studio/issues/6585
 * @see https://github.com/vjpixel/diaria-studio/issues/6464 (épico)
 */

// Mesma razão de `import type` (não `import`) documentada em clarice-db.ts:
// evita ERR_UNKNOWN_BUILTIN_MODULE em runtime pra quem só usa este arquivo
// por tipo. A resolução real é lazy via createRequire dentro de
// openDiariaSubscribersDb, depois de assertSupportedNodeVersion() já ter
// dado a mensagem clara.
import type { DatabaseSync } from "node:sqlite";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { assertSupportedNodeVersion } from "./check-node-version.ts";

const ROOT = import.meta.dirname
  ? resolve(import.meta.dirname, "..", "..")
  : process.cwd();

export const DEFAULT_DB_PATH = resolve(
  ROOT,
  "data/diaria-subscribers/diaria-subscribers.db",
);

// ---------------------------------------------------------------------------
// Tipos
// ---------------------------------------------------------------------------

/**
 * As plataformas cobertas pelo épico #6464. `brevo_diaria`/`brevo_clarice`
 * (#6587, fatia 4) substituem o que teria sido um `"brevo"` genérico — a
 * Brevo tem DUAS contas reais (tenants distintos, quota independente, ver
 * `docs/brevo-rate-limits.md`), e o mesmo e-mail pode legitimamente ter
 * histórico nas duas ao mesmo tempo. Colapsar as duas num só valor
 * `"brevo"` teria feito exatamente a fusão indevida que a fatia 5
 * (reconciliação cross-plataforma, fora de escopo aqui) precisa decidir
 * deliberadamente, não herdar por acidente de modelagem — `subscription`
 * tem UNIQUE(subscriber_id, platform), então duas contas com o mesmo valor
 * de `platform` colidiriam numa linha só em vez de preservar as duas
 * `subscription` que a issue #6587 pede explicitamente ("são duas
 * `subscription`, um `subscriber`").
 */
export const PLATFORMS = [
  "beehiiv",
  "brevo_diaria",
  "brevo_clarice",
  "kit",
] as const;
export type Platform = (typeof PLATFORMS)[number];

export function isPlatform(value: unknown): value is Platform {
  return typeof value === "string" && (PLATFORMS as readonly string[]).includes(value);
}

/**
 * Tipos de evento do épico (corpo da issue #6464). `"delivered"` (#6586,
 * fatia 3) entra como eixo de 1ª classe pro Kit — a diferença `sent −
 * delivered` carrega o sinal que abertura sozinha esconde (achado #6504: o
 * Gmail recusou 72% do 1º envio em massa). Bounce explícito continua
 * existindo (Brevo expõe hard/soft bounce como evento próprio); pro Kit,
 * que não expõe bounce em `/broadcasts/{id}/stats`, o consumidor deriva
 * bounce por `sent − delivered` na LEITURA em vez de gravar um evento
 * `bounce` sintético que a fonte nunca confirmou individualmente.
 */
export const EVENT_TYPES = [
  "sent",
  "delivered",
  "open",
  "click",
  "subscribe",
  "unsub",
  "bounce",
  "complaint",
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export function isEventType(value: unknown): value is EventType {
  return typeof value === "string" && (EVENT_TYPES as readonly string[]).includes(value);
}

export interface SubscriptionFields {
  status: string | null;
  enteredAt: string | null;
  exitedAt: string | null;
  source: string | null;
}

export interface SubscriberEvent {
  subscriberId: number;
  platform: Platform;
  type: EventType;
  /** Chave natural do evento NESSA plataforma — junto com (platform, type)
   * garante idempotência de `recordEvent`. Para plataformas sem id de evento
   * nativo (ex: Kit "abriu o broadcast X"), o chamador constrói uma string
   * determinística (ex: `${external_id}:${broadcast_id}`). */
  externalEventId: string;
  /** Edição/broadcast associado ao evento, quando aplicável. */
  edicao?: string | null;
  url?: string | null;
  /** ISO 8601. */
  ts: string;
}

export interface TimelineEvent {
  id: number;
  subscriber_id: number | null;
  platform: Platform;
  type: EventType;
  external_event_id: string;
  edicao: string | null;
  url: string | null;
  ts: string;
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS subscriber (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

-- (platform, external_id, email) -> subscriber_id. Chave natural composta
-- (não PK ingênua por e-mail, ver docstring do módulo). external_id e email
-- podem ser NULL individualmente (uma plataforma pode só ter um dos dois),
-- mas a combinação dos 3 campos identifica 1 alias único.
CREATE TABLE IF NOT EXISTS identity_alias (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  subscriber_id  INTEGER NOT NULL,
  platform       TEXT NOT NULL,
  external_id    TEXT,
  email          TEXT,
  created_at     TEXT NOT NULL,
  UNIQUE(platform, external_id, email)
);
CREATE INDEX IF NOT EXISTS idx_identity_alias_subscriber ON identity_alias(subscriber_id);
CREATE INDEX IF NOT EXISTS idx_identity_alias_email       ON identity_alias(email);
CREATE INDEX IF NOT EXISTS idx_identity_alias_platform     ON identity_alias(platform, external_id);

-- 1 linha por (subscriber x platform).
CREATE TABLE IF NOT EXISTS subscription (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  subscriber_id  INTEGER NOT NULL,
  platform       TEXT NOT NULL,
  status         TEXT,
  entered_at     TEXT,
  exited_at      TEXT,
  source         TEXT,
  updated_at     TEXT NOT NULL,
  UNIQUE(subscriber_id, platform)
);
CREATE INDEX IF NOT EXISTS idx_subscription_platform ON subscription(platform);

-- O fato. subscriber_id SEM FK rígida bloqueante contra subscription (ver
-- docstring do módulo) -- só precisa apontar pra um subscriber já resolvido
-- via ensureSubscriber. Chave natural (platform, type, external_event_id)
-- garante idempotência do builder.
CREATE TABLE IF NOT EXISTS event (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  subscriber_id       INTEGER,
  platform            TEXT NOT NULL,
  type                TEXT NOT NULL,
  external_event_id   TEXT NOT NULL,
  edicao              TEXT,
  url                 TEXT,
  ts                  TEXT NOT NULL,
  UNIQUE(platform, type, external_event_id)
);
-- Consulta 1: timeline de 1 assinante (busca por email -> subscriber_id ->
-- todos os eventos ordenados por ts).
CREATE INDEX IF NOT EXISTS idx_event_subscriber_ts ON event(subscriber_id, ts);
-- Consulta 2: coorte por plataforma/período (quantos abriram/clicaram numa
-- plataforma entre duas datas).
CREATE INDEX IF NOT EXISTS idx_event_platform_ts ON event(platform, ts);
CREATE INDEX IF NOT EXISTS idx_event_type ON event(type);
`;

// ---------------------------------------------------------------------------
// Abertura do DB
// ---------------------------------------------------------------------------

/**
 * Abre (ou cria) o DB e garante o schema. Mesmo padrão de
 * `openClariceDb` — lança se `data/diaria-subscribers/` não existir (ex:
 * `data/` ausente, clone fresco) porque `new DatabaseSync(path)` não cria
 * diretórios pai. Chamadores de escrita (builder) devem checar/criar o
 * diretório antes; chamadores de LEITURA que precisam degradar graciosamente
 * devem usar `openDiariaSubscribersDbSafe` abaixo.
 */
export function openDiariaSubscribersDb(
  dbPath: string = DEFAULT_DB_PATH,
): DatabaseSync {
  assertSupportedNodeVersion();
  const { DatabaseSync: DatabaseSyncCtor } = createRequire(import.meta.url)(
    "node:sqlite",
  ) as { DatabaseSync: typeof DatabaseSync };
  const db = new DatabaseSyncCtor(dbPath);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA busy_timeout = 5000;");
  db.exec(SCHEMA);
  return db;
}

/**
 * Variante fail-soft de `openDiariaSubscribersDb` — nunca lança. `data/`
 * ausente (sessão cloud, clone fresco), diretório sem permissão, ou store
 * corrompido: retorna `null`. Uso pretendido: qualquer superfície de LEITURA
 * (painel do Studio, fatia 6) que deve degradar para "sem dados" em vez de
 * quebrar — mesmo padrão de `buildContactsSummaryLocal` em
 * `scripts/studio-ui/dashboard-clarice.ts`.
 */
export function openDiariaSubscribersDbSafe(
  dbPath: string = DEFAULT_DB_PATH,
): DatabaseSync | null {
  try {
    return openDiariaSubscribersDb(dbPath);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Escrita — primitivas idempotentes usadas pelos builders por plataforma
// (fatias 3/4, ainda não implementadas neste módulo).
// ---------------------------------------------------------------------------

/**
 * Find-or-create do subscriber pra uma identidade `(platform, external_id,
 * email)`. Idempotente: reingestão da MESMA identidade (mesmos 3 campos)
 * sempre retorna o MESMO `subscriber_id` — nunca cria um 2º subscriber pro
 * alias já visto.
 *
 * Não faz merge cross-plataforma — dois aliases de PLATAFORMAS DIFERENTES
 * pra mesma pessoa real criam, nesta chamada, dois `subscriber` distintos.
 * Isso é esperado e transitório: `resolveIdentitiesByEmail`
 * (`diaria-subscribers-identity-resolve.ts`, fatia 5, #6589) roda DEPOIS da
 * ingestão e funde por e-mail canonicalizado (`UPDATE identity_alias SET
 * subscriber_id = ?`) — este helper nunca precisa saber disso.
 *
 * `externalId`/`email` podem ser `null` individualmente, mas ao menos um dos
 * dois precisa estar presente (senão não há como reidentificar o alias numa
 * reingestão futura).
 */
export function ensureSubscriber(
  db: DatabaseSync,
  platform: Platform,
  externalId: string | null,
  email: string | null,
  now: string = new Date().toISOString(),
): number {
  if (!externalId && !email) {
    throw new Error(
      "ensureSubscriber: externalId e email não podem ser ambos null/vazio",
    );
  }
  const normalizedEmail = email ? email.trim().toLowerCase() : null;

  const existing = db
    .prepare(
      "SELECT subscriber_id FROM identity_alias WHERE platform = ? AND external_id IS ? AND email IS ?",
    )
    .get(platform, externalId, normalizedEmail) as
    | { subscriber_id: number }
    | undefined;
  if (existing) return existing.subscriber_id;

  db.exec("BEGIN");
  try {
    db.prepare(
      "INSERT INTO subscriber (created_at, updated_at) VALUES (?, ?)",
    ).run(now, now);
    const row = db.prepare("SELECT last_insert_rowid() AS id").get() as {
      id: number;
    };
    const subscriberId = row.id;
    db.prepare(
      `INSERT INTO identity_alias (subscriber_id, platform, external_id, email, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(subscriberId, platform, externalId, normalizedEmail, now);
    db.exec("COMMIT");
    return subscriberId;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

/**
 * Upsert de `subscription` — 1 linha por `(subscriber_id, platform)`.
 * Idempotente via `ON CONFLICT DO UPDATE`: reingestão nunca duplica linha.
 */
export function upsertSubscription(
  db: DatabaseSync,
  subscriberId: number,
  platform: Platform,
  fields: SubscriptionFields,
  now: string = new Date().toISOString(),
): void {
  db.prepare(
    `INSERT INTO subscription (subscriber_id, platform, status, entered_at, exited_at, source, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(subscriber_id, platform) DO UPDATE SET
       status     = excluded.status,
       entered_at = excluded.entered_at,
       exited_at  = excluded.exited_at,
       source     = excluded.source,
       updated_at = excluded.updated_at`,
  ).run(
    subscriberId,
    platform,
    fields.status,
    fields.enteredAt,
    fields.exitedAt,
    fields.source,
    now,
  );
}

/**
 * Grava 1 evento. Idempotente via `INSERT OR IGNORE` sobre a chave natural
 * `(platform, type, external_event_id)` — re-rodar a ingestão de uma
 * plataforma nunca duplica o mesmo evento. Retorna `inserted: false` quando
 * o evento já existia (útil pro builder reportar quantos eventos eram
 * novos vs. já conhecidos).
 */
export function recordEvent(
  db: DatabaseSync,
  event: SubscriberEvent,
): { inserted: boolean } {
  const result = db
    .prepare(
      `INSERT OR IGNORE INTO event
         (subscriber_id, platform, type, external_event_id, edicao, url, ts)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      event.subscriberId,
      event.platform,
      event.type,
      event.externalEventId,
      event.edicao ?? null,
      event.url ?? null,
      event.ts,
    );
  return { inserted: result.changes > 0 };
}

// ---------------------------------------------------------------------------
// Leitura — as duas consultas que importam (critério de pronto da #6585)
// ---------------------------------------------------------------------------

/** Timeline de 1 assinante — todos os eventos, ordenados por ts. */
export function getSubscriberTimeline(
  db: DatabaseSync,
  subscriberId: number,
): TimelineEvent[] {
  return db
    .prepare(
      `SELECT id, subscriber_id, platform, type, external_event_id, edicao, url, ts
       FROM event WHERE subscriber_id = ? ORDER BY ts ASC`,
    )
    .all(subscriberId) as unknown as TimelineEvent[];
}

/** Resolve o subscriber_id de um alias já conhecido — usado pra ir de
 * "e-mail buscado pelo editor" até a timeline (`getSubscriberTimeline`). */
export function findSubscriberIdByAlias(
  db: DatabaseSync,
  platform: Platform,
  externalId: string | null,
  email: string | null,
): number | null {
  const normalizedEmail = email ? email.trim().toLowerCase() : null;
  const row = db
    .prepare(
      "SELECT subscriber_id FROM identity_alias WHERE platform = ? AND external_id IS ? AND email IS ?",
    )
    .get(platform, externalId, normalizedEmail) as
    | { subscriber_id: number }
    | undefined;
  return row ? row.subscriber_id : null;
}

/** Todos os subscriber_id associados a um e-mail, em qualquer plataforma —
 * ponto de entrada mais comum pra busca no painel (editor digita um e-mail,
 * não sabe de antemão em qual plataforma). Depois de
 * `resolveIdentitiesByEmail` (fatia 5, #6589) rodar, retorna no máximo 1 id
 * pra este e-mail exato — mais de 1 só aparece transitoriamente, ANTES da
 * resolução rodar (ex: entre duas ingestões e o próximo `npx tsx
 * scripts/diaria-subscribers-resolve-identity.ts`). */
export function findSubscriberIdsByEmail(
  db: DatabaseSync,
  email: string,
): number[] {
  const normalizedEmail = email.trim().toLowerCase();
  const rows = db
    .prepare(
      "SELECT DISTINCT subscriber_id FROM identity_alias WHERE email = ?",
    )
    .all(normalizedEmail) as unknown as Array<{ subscriber_id: number }>;
  return rows.map((r) => r.subscriber_id);
}

/** Coorte por plataforma/período — contagem de eventos por tipo, entre
 * `fromTs`/`toTs` (ISO 8601, inclusive), opcionalmente restrita a um `type`. */
export function getCohortEventCounts(
  db: DatabaseSync,
  platform: Platform,
  fromTs: string,
  toTs: string,
  type?: EventType,
): Array<{ type: EventType; count: number }> {
  const rows = type
    ? (db
        .prepare(
          `SELECT type, COUNT(*) AS count FROM event
           WHERE platform = ? AND type = ? AND ts >= ? AND ts <= ?
           GROUP BY type`,
        )
        .all(platform, type, fromTs, toTs) as unknown as Array<{
        type: EventType;
        count: number;
      }>)
    : (db
        .prepare(
          `SELECT type, COUNT(*) AS count FROM event
           WHERE platform = ? AND ts >= ? AND ts <= ?
           GROUP BY type`,
        )
        .all(platform, fromTs, toTs) as unknown as Array<{
        type: EventType;
        count: number;
      }>);
  return rows;
}

/** Contagem simples de linhas por tabela — usado pelo builder/CLI pra
 * imprimir um summary sem precisar reimplementar SELECT COUNT(*) 4x. */
export function getStoreCounts(db: DatabaseSync): {
  subscribers: number;
  identity_aliases: number;
  subscriptions: number;
  events: number;
} {
  const count = (table: string): number =>
    (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number })
      .n;
  return {
    subscribers: count("subscriber"),
    identity_aliases: count("identity_alias"),
    subscriptions: count("subscription"),
    events: count("event"),
  };
}

// ---------------------------------------------------------------------------
// Leitura — helpers pra fatias 6 (painel Studio, #6590) e 7 (leitor-v1
// cross-plataforma, #6591). Vivem aqui (não em cada consumidor) pela mesma
// razão de `getSubscriberTimeline`/`findSubscriberIdsByEmail` acima: SQL
// centralizado no módulo dono do esquema, reusável por qualquer caller.
// ---------------------------------------------------------------------------

export interface SubscriberAlias {
  platform: Platform;
  external_id: string | null;
  email: string | null;
}

/** Todos os `identity_alias` de 1 subscriber — pra montar a ficha de
 *  identidade na busca por e-mail do painel (#6590) e pra derivar o
 *  conjunto de plataformas em que o subscriber existe (leitor-v1
 *  cross-plataforma, #6591). */
export function getAliasesForSubscriber(
  db: DatabaseSync,
  subscriberId: number,
): SubscriberAlias[] {
  return db
    .prepare(
      "SELECT platform, external_id, email FROM identity_alias WHERE subscriber_id = ?",
    )
    .all(subscriberId) as unknown as SubscriberAlias[];
}

export interface SubscriptionRecord {
  platform: Platform;
  status: string | null;
  entered_at: string | null;
  exited_at: string | null;
  source: string | null;
  updated_at: string;
}

/** Todas as `subscription` de 1 subscriber (1 por plataforma, no máximo
 *  `PLATFORMS.length` linhas) — status/datas/origem por plataforma, pra
 *  ficha de identidade do painel e pro status "ativo em qualquer
 *  plataforma coberta" do leitor-v1 cross-plataforma. */
export function getSubscriptionsForSubscriber(
  db: DatabaseSync,
  subscriberId: number,
): SubscriptionRecord[] {
  return db
    .prepare(
      "SELECT platform, status, entered_at, exited_at, source, updated_at FROM subscription WHERE subscriber_id = ?",
    )
    .all(subscriberId) as unknown as SubscriptionRecord[];
}

/** Mapa `subscriber_id -> conjunto de plataformas em que tem alias` pro
 *  store INTEIRO — 1 scan de `identity_alias`, reusado tanto pela visão de
 *  coorte/migração do painel (#6590) quanto pelo summary batch de
 *  leitor-v1 cross-plataforma (#6591), que senão repetiriam a mesma
 *  agregação (já feita, de forma privada, dentro de `buildUnmatchedReport`
 *  em `diaria-subscribers-identity-resolve.ts`). */
export function getAllSubscriberPlatforms(
  db: DatabaseSync,
): Map<number, Set<Platform>> {
  const rows = db
    .prepare("SELECT DISTINCT subscriber_id, platform FROM identity_alias")
    .all() as unknown as Array<{ subscriber_id: number; platform: Platform }>;
  const map = new Map<number, Set<Platform>>();
  for (const r of rows) {
    let set = map.get(r.subscriber_id);
    if (!set) {
      set = new Set();
      map.set(r.subscriber_id, set);
    }
    set.add(r.platform);
  }
  return map;
}
