/**
 * studio-subscribers.ts (#6464 fatia 6 — #6590)
 *
 * Camada de leitura pra `GET /api/subscribers/search` e
 * `GET /api/subscribers/cohort`: busca por e-mail → timeline unificada, e
 * visão de coorte por migração — sobre o store unificado
 * (`scripts/lib/diaria-subscribers-db.ts`, fatias 2-5 do épico #6464:
 * #6585/#6586/#6587/#6589). Mesmo padrão de `studio-ads.ts`/`studio-tasks.ts`
 * — `server.ts` só roteia, este arquivo monta o snapshot.
 *
 * ## Read-only por construção (decisão do editor, corpo da issue #6590)
 *
 * "Sem fusão manual de identidade, sem edição de assinante, sem nada que
 * mude estado" — este arquivo não exporta NENHUMA função de escrita. O
 * store em si é read-only por design (a resolução de identidade e a
 * ingestão são scripts CLI separados, fora do Studio) — "não é uma quarta
 * plataforma de envio". Isto não é economia de esforço, é a linha que
 * mantém a épica inteira honesta (ver corpo da issue).
 *
 * ## Toda métrica cross-plataforma é PISO, nunca exata
 *
 * Herdado de `diaria-subscribers-identity-resolve.ts` (#6589): identidade
 * não-casada aparece como churn + cadastro novo, não continuidade. TODA
 * resposta desta camada carrega `note` = `CROSS_PLATFORM_FLOOR_NOTE` — a
 * UI exibe a margem ao lado do número, nunca o número sozinho (critério de
 * pronto explícito da #6590: "a margem tem que aparecer NA TELA").
 *
 * ## Fail-soft: `data/` ausente ou store sem ingestão ainda
 *
 * Mesmo padrão de `buildContactsSummaryLocal` (`dashboard-clarice.ts`):
 * sessão cloud sem o junction OneDrive, ou store existente mas ainda sem
 * nenhuma ingestão rodada (`openDiariaSubscribersDbSafe` retorna `null`
 * nos dois casos) degradam pra `db.available: false` — a UI mostra "sem
 * dados", nunca quebra.
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
  openDiariaSubscribersDbSafe,
  DEFAULT_DB_PATH,
  PLATFORMS,
  findSubscriberIdsByEmail,
  getSubscriberTimeline,
  getAliasesForSubscriber,
  getSubscriptionsForSubscriber,
  getAllSubscriberPlatforms,
  type Platform,
  type TimelineEvent,
  type SubscriberAlias,
  type SubscriptionRecord,
} from "../lib/diaria-subscribers-db.ts";
import {
  detectPlatformCapabilities,
  computeStoreLeitorResult,
  type StoreLeitorResult,
} from "../lib/leitor-store.ts";
import {
  buildUnmatchedReport,
  CROSS_PLATFORM_FLOOR_NOTE,
  type UnmatchedReport,
} from "../lib/diaria-subscribers-identity-resolve.ts";

// ---------------------------------------------------------------------------
// Camada de DB compartilhada pelas 2 rotas
// ---------------------------------------------------------------------------

export interface SubscribersDbLayer {
  dbPath: string;
  /** `false` só quando `rootDir/data` inteiro está ausente (sessão cloud
   *  sem junction) — mesmo sinal de topo que `studio-ads.ts` usa. */
  hasDataDir: boolean;
  /** `false` quando o DB não abre — `data/diaria-subscribers/` ausente
   *  (nenhuma ingestão rodou ainda) OU store corrompido. */
  available: boolean;
  error: string | null;
}

export interface BuildSubscribersOptions {
  /** Override do path do DB — usado por teste (fixture isolado). Produção
   *  sempre resolve a partir de `rootDir`. */
  dbPath?: string;
}

function resolveDbPath(rootDir: string, opts: BuildSubscribersOptions): string {
  return opts.dbPath ?? resolve(rootDir, "data", "diaria-subscribers", "diaria-subscribers.db");
}

function openLayer(rootDir: string, opts: BuildSubscribersOptions): { db: DatabaseSync | null; layer: SubscribersDbLayer } {
  const dbPath = resolveDbPath(rootDir, opts);
  const hasDataDir = existsSync(resolve(rootDir, "data"));
  const db = openDiariaSubscribersDbSafe(dbPath);
  return {
    db,
    layer: {
      dbPath,
      hasDataDir,
      available: db != null,
      error:
        db == null
          ? "store não encontrado/ilegível — sem data/diaria-subscribers/ (nenhuma ingestão rodou ainda?)"
          : null,
    },
  };
}

// ---------------------------------------------------------------------------
// Busca por e-mail → timeline unificada
// ---------------------------------------------------------------------------

export interface SubscriberRecord {
  subscriberId: number;
  aliases: SubscriberAlias[];
  subscriptions: SubscriptionRecord[];
  /** Todos os eventos, já ordenados por `ts` (`getSubscriberTimeline`) —
   *  a timeline unificada das 3 plataformas numa linha só (caso de uso
   *  motivador do épico, corpo da issue #6590/#6464). */
  timeline: TimelineEvent[];
  leitor: StoreLeitorResult;
}

export interface SubscribersSearchResult {
  query: string;
  db: SubscribersDbLayer;
  /** Normalmente 0 ou 1 — mais de 1 só acontece TRANSITORIAMENTE, entre uma
   *  ingestão nova e a próxima rodada de `resolveIdentitiesByEmail`
   *  (#6589). Nunca fundido aqui — a UI mostra cada `subscriber` separado,
   *  igual o store realmente está. */
  subscribers: SubscriberRecord[];
  note: string;
}

/** `email` vazio/whitespace nunca bate — `findSubscriberIdsByEmail` já
 *  normaliza (trim+lowercase), mas uma busca vazia devolveria `[]` mesmo
 *  assim; o caller (rota HTTP) trata string vazia como "sem busca" antes
 *  de chegar aqui, então esta função nunca precisa se preocupar com isso
 *  de propósito. */
export function searchSubscribersByEmail(
  rootDir: string,
  email: string,
  opts: BuildSubscribersOptions = {},
): SubscribersSearchResult {
  const { db, layer } = openLayer(rootDir, opts);
  if (!db) {
    return { query: email, db: layer, subscribers: [], note: CROSS_PLATFORM_FLOOR_NOTE };
  }
  try {
    const ids = findSubscriberIdsByEmail(db, email);
    const caps = detectPlatformCapabilities(db);
    const subscribers: SubscriberRecord[] = ids.map((subscriberId) => ({
      subscriberId,
      aliases: getAliasesForSubscriber(db, subscriberId),
      subscriptions: getSubscriptionsForSubscriber(db, subscriberId),
      timeline: getSubscriberTimeline(db, subscriberId),
      leitor: computeStoreLeitorResult(db, subscriberId, caps),
    }));
    return { query: email, db: layer, subscribers, note: CROSS_PLATFORM_FLOOR_NOTE };
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// Coorte por migração
// ---------------------------------------------------------------------------

export interface PlatformSubscriberCount {
  platform: Platform;
  /** Subscribers com ao menos 1 alias nesta plataforma (não distingue
   *  status — "já passou por aqui em algum momento"). */
  total: number;
}

export interface MigrationPairCount {
  /** Par não-ordenado de plataformas — "atravessou" as duas, em qualquer
   *  direção/ordem temporal (o store não garante ordem cronológica só
   *  pelas plataformas presentes; a timeline de cada subscriber tem a
   *  ordem real). */
  a: Platform;
  b: Platform;
  count: number;
}

export interface ReactivationStat {
  /** Subscribers com `subscription.status === "active"` em `brevo_diaria`
   *  (o canal de reativação, segmento Pending — ver CLAUDE.md) E alias em
   *  ao menos 1 OUTRA plataforma — reativaram pela Brevo e permanecem
   *  assinantes hoje. Aproximação, não medição direta de "reativou": o
   *  store não grava um evento `reactivated` explícito, isto é o proxy
   *  mais direto disponível a partir do schema atual (subscription ativa
   *  + histórico prévio alhures). */
  count: number;
  note: string;
}

export interface SubscribersCohortData {
  generatedAt: string;
  db: SubscribersDbLayer;
  totalSubscribers: number;
  byPlatform: PlatformSubscriberCount[];
  /** Só pares com count > 0, ordenado do maior pro menor. */
  migrations: MigrationPairCount[];
  reactivation: ReactivationStat;
  /** `null` quando o DB não abriu (mesmo caso de `db.available === false`). */
  unmatched: UnmatchedReport | null;
  note: string;
}

const REACTIVATION_NOTE =
  "Aproximação: subscription ativa em brevo_diaria (canal de reativação) + alias em outra plataforma. " +
  "O store não grava um evento \"reativou\" explícito — não é medição direta.";

export function buildSubscribersCohortData(
  rootDir: string,
  opts: BuildSubscribersOptions = {},
): SubscribersCohortData {
  const generatedAt = new Date().toISOString();
  const { db, layer } = openLayer(rootDir, opts);

  if (!db) {
    return {
      generatedAt,
      db: layer,
      totalSubscribers: 0,
      byPlatform: PLATFORMS.map((platform) => ({ platform, total: 0 })),
      migrations: [],
      reactivation: { count: 0, note: REACTIVATION_NOTE },
      unmatched: null,
      note: CROSS_PLATFORM_FLOOR_NOTE,
    };
  }

  try {
    const allPlatforms = getAllSubscriberPlatforms(db);
    const byPlatformCount = new Map<Platform, number>();
    const pairCounts = new Map<string, MigrationPairCount>();
    let reactivatedAndStayed = 0;

    for (const [subscriberId, platformSet] of allPlatforms) {
      for (const p of platformSet) {
        byPlatformCount.set(p, (byPlatformCount.get(p) ?? 0) + 1);
      }

      const sorted = [...platformSet].sort();
      for (let i = 0; i < sorted.length; i++) {
        for (let j = i + 1; j < sorted.length; j++) {
          const key = `${sorted[i]}|${sorted[j]}`;
          const existing = pairCounts.get(key);
          if (existing) existing.count++;
          else pairCounts.set(key, { a: sorted[i], b: sorted[j], count: 1 });
        }
      }

      // Self-review: "reativou" precisa de histórico numa OUTRA PLATAFORMA
      // DA DIÁRIA (beehiiv/kit) especificamente — `platformSet.size > 1`
      // sozinho contava errado quem tem só brevo_diaria + brevo_clarice
      // (é assinante de outro produto, não "reativado" na diária).
      const hasOtherDiariaPlatform = platformSet.has("beehiiv") || platformSet.has("kit");
      if (platformSet.has("brevo_diaria") && hasOtherDiariaPlatform) {
        const subs = getSubscriptionsForSubscriber(db, subscriberId);
        const brevoSub = subs.find((s) => s.platform === "brevo_diaria");
        if (brevoSub?.status === "active") reactivatedAndStayed++;
      }
    }

    const byPlatform: PlatformSubscriberCount[] = PLATFORMS.map((platform) => ({
      platform,
      total: byPlatformCount.get(platform) ?? 0,
    }));

    const migrations = [...pairCounts.values()].sort((x, y) => y.count - x.count);

    return {
      generatedAt,
      db: layer,
      totalSubscribers: allPlatforms.size,
      byPlatform,
      migrations,
      reactivation: { count: reactivatedAndStayed, note: REACTIVATION_NOTE },
      unmatched: buildUnmatchedReport(db, generatedAt),
      note: CROSS_PLATFORM_FLOOR_NOTE,
    };
  } finally {
    db.close();
  }
}

// Reexport pra conveniência do caller (server.ts) — evita 2 imports do
// mesmo módulo de schema só pra pegar o default path num log/debug.
export { DEFAULT_DB_PATH };
