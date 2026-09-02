/**
 * leitor-store.ts (#6464 fatia 7 — #6591)
 *
 * `leitor-v1` CROSS-PLATAFORMA, calculado sobre o store unificado
 * (`diaria-subscribers-db.ts`) em vez de um snapshot de 1 plataforma só.
 * Módulo IRMÃO de `leitor.ts` (ver "Regra de versionamento" em
 * `docs/definicao-leitor.md`) — MESMA definição v1 (`LEITOR_V1_THRESHOLDS`,
 * `isLeitorV1`, `computeCtrPct`), fonte de dado NOVA. `leitor.ts` continua
 * intocado: este módulo só adiciona um caminho de extração de `LeitorInput`
 * a partir do store, coexistindo com `leitorInputFromBeehiivSubscriber`/
 * `leitorInputFromKitSubscriber`.
 *
 * **Decisão adiada de propósito (#6591): substituir ou coexistir com a
 * definição atual.** "Trade-off real (muda como o projeto se mede) —
 * decidir com o número na mão, não agora" (corpo da issue). Este módulo só
 * entrega o número; a decisão de substituição fica pra quando a base real
 * estiver ingerida (`data/diaria-subscribers/` ainda não existe nesta
 * sessão — nenhuma ingestão real rodou até aqui, só os fixtures de teste).
 *
 * ## Por que `brevo_clarice` fica de fora
 *
 * `PLATFORMS` (diaria-subscribers-db.ts) inclui `brevo_clarice` — a base de
 * reativação da Clarice News (~435k contatos, `scripts/lib/clarice-db.ts`),
 * ingerida no MESMO store só pelo valor de resolução de identidade
 * cross-produto (#6587). `leitor-v1` é a unidade de qualidade da DIÁRIA
 * (CLAUDE.md, "a unidade é LEITOR" — contexto de CAC/ads da diária, não da
 * Clarice). Somar recebidas/cliques da Clarice ao leitor-v1 da diária
 * inflaria as duas pontas da fração com engajamento de um produto/audiência
 * DIFERENTE — alguém pode ler a Clarice todo santo dia e nunca ter recebido
 * uma edição da diária. `LEITOR_DIARIA_PLATFORMS` exclui `brevo_clarice` de
 * propósito; a métrica equivalente pro lado Clarice (se um dia fizer
 * sentido) usa `clarice-db.ts`/`clarice_users` diretamente — fora de escopo
 * aqui.
 *
 * ## Recebidas: `delivered` explícito, ou `sent − bounce` quando a
 * plataforma não expõe `delivered`
 *
 * Mesma disciplina já documentada em `diaria-subscribers-db.ts`
 * (`EVENT_TYPES`): o Kit ingere `delivered` como eixo de 1ª classe (#6586)
 * — usamos direto quando presente. A API da Brevo NUNCA expõe `delivered`
 * por contato (só `messagesSent`, mapeado pra `"sent"` em
 * `brevo-subscribers-ingest.ts`), mas expõe bounce explícito — então, por
 * simetria com a leitura de bounce do Kit (lá o consumidor deriva
 * `sent − delivered`; aqui derivamos `delivered = sent − bounce`),
 * calculamos "recebidas" da Brevo como `sent − bounce` (nunca negativo).
 * Qual caminho usar é detectado a partir do DADO real — alguma plataforma
 * já gravou pelo menos 1 evento `delivered`? — nunca hardcoded por nome de
 * plataforma (`detectPlatformCapabilities` abaixo): se uma ingestão futura
 * (Beehiiv, fatia 1 do épico) também passar a gravar `delivered`, o
 * caminho certo é escolhido automaticamente, sem editar este módulo.
 *
 * ## "Únicas clicadas": por EDIÇÃO, não por evento de clique
 *
 * `total_unique_clicked` (Beehiiv/Kit) conta EDIÇÕES em que o assinante
 * clicou ao menos 1 link, nunca o total de eventos de clique. O Kit grava
 * exatamente 1 evento `click` por (assinante × broadcast) — contar linhas
 * já é a contagem certa. A Brevo grava 1 evento POR LINK clicado
 * (`brevo-stats.ts`, `extractContactEvents` expande `links[]`) — sem
 * deduplicar por edição, clicar em 2 links da MESMA campanha contaria como
 * 2 "cliques únicos", inflando o CTR real (o mesmo viés que `leitor-v1`
 * inteiro existe pra evitar — ver docstring de `leitor.ts`). Por isso
 * `kit-subscribers-ingest.ts`/`brevo-subscribers-ingest.ts` passaram a
 * gravar `event.edicao` (broadcastId/campaignId — coluna já existia no
 * schema, só não estava populada) e `countDistinctEditions` abaixo conta
 * `COUNT(DISTINCT COALESCE(edicao, external_event_id))` — o fallback pra
 * `external_event_id` é só defensivo (dado legado sem `edicao`, que não
 * existe hoje: `data/diaria-subscribers/` ainda não tem nenhuma ingestão
 * real rodada).
 *
 * ## PISO, nunca exato
 *
 * Herdado de `diaria-subscribers-identity-resolve.ts` (#6589): identidade
 * não-casada aparece como um `subscriber` separado por plataforma —
 * `summarizeStoreLeitores` sempre devolve `note` com
 * `CROSS_PLATFORM_FLOOR_NOTE` ao lado do número, nunca sozinho.
 *
 * ## CLI
 *
 *   npx tsx scripts/lib/leitor-store.ts [--db <path>] [--ctr-min 2] [--received-min 20]
 *
 * Só leitura local (mesma disciplina de `leitor.ts`) — nunca chama API
 * nenhuma ao vivo. Sem `data/diaria-subscribers/diaria-subscribers.db`
 * (clone fresco, sessão cloud, ou nenhuma ingestão rodada ainda), sai com
 * erro explícito em vez de degradar silenciosamente pra zero.
 */

import type { DatabaseSync } from "node:sqlite";
import { isMainModule, getStringArg } from "./cli-args.ts";
import {
  DEFAULT_DB_PATH,
  openDiariaSubscribersDbSafe,
  PLATFORMS,
  getAliasesForSubscriber,
  getSubscriptionsForSubscriber,
  getAllSubscriberPlatforms,
  type Platform,
} from "./diaria-subscribers-db.ts";
import { isLeitorV1, LEITOR_V1_THRESHOLDS, type LeitorInput, type LeitorThresholds } from "./leitor.ts";
import { CROSS_PLATFORM_FLOOR_NOTE } from "./diaria-subscribers-identity-resolve.ts";

/** As plataformas da DIÁRIA — todas as `PLATFORMS` do store MENOS
 *  `brevo_clarice` (ver docstring do módulo, "Por que brevo_clarice fica de
 *  fora"). */
export const LEITOR_DIARIA_PLATFORMS: readonly Platform[] = PLATFORMS.filter(
  (p): p is Exclude<Platform, "brevo_clarice"> => p !== "brevo_clarice",
);

// ---------------------------------------------------------------------------
// Capacidade por plataforma — detectada do dado, nunca hardcoded
// ---------------------------------------------------------------------------

export interface PlatformCapabilities {
  /** Plataformas com ao menos 1 evento `delivered` gravado no store — usamos
   *  `delivered` explícito pra essas; as demais caem no fallback
   *  `sent − bounce` (ver docstring do módulo). */
  platformsWithDelivered: Set<Platform>;
}

function hasAnyEvent(db: DatabaseSync, platform: Platform, type: string): boolean {
  const row = db
    .prepare("SELECT 1 AS one FROM event WHERE platform = ? AND type = ? LIMIT 1")
    .get(platform, type);
  return row != null;
}

/** Roda 1x por chamada de `summarizeStoreLeitores` (não por subscriber) —
 *  scan pequeno e independente do tamanho da base. */
export function detectPlatformCapabilities(
  db: DatabaseSync,
  platforms: readonly Platform[] = LEITOR_DIARIA_PLATFORMS,
): PlatformCapabilities {
  const platformsWithDelivered = new Set<Platform>();
  for (const platform of platforms) {
    if (hasAnyEvent(db, platform, "delivered")) platformsWithDelivered.add(platform);
  }
  return { platformsWithDelivered };
}

// ---------------------------------------------------------------------------
// Contagem por (subscriber, platform) — a unidade real é a EDIÇÃO
// ---------------------------------------------------------------------------

/** `COUNT(DISTINCT edicao)` pro tipo de evento pedido — `edicao` é a chave
 *  de deduplicação real (1 edição = 1 broadcast/campanha, ver docstring do
 *  módulo); `COALESCE(edicao, external_event_id)` é só o fallback
 *  defensivo pra evento legado sem `edicao` gravado. */
function countDistinctEditions(
  db: DatabaseSync,
  subscriberId: number,
  platform: Platform,
  type: string,
): number {
  const row = db
    .prepare(
      `SELECT COUNT(DISTINCT COALESCE(edicao, external_event_id)) AS n
       FROM event WHERE subscriber_id = ? AND platform = ? AND type = ?`,
    )
    .get(subscriberId, platform, type) as { n: number };
  return row.n;
}

/** Recebidas de 1 (subscriber × platform): `delivered` explícito quando a
 *  plataforma o expõe; senão `max(0, sent − bounce)` (nunca negativo — ver
 *  docstring do módulo). */
export function computeReceivedForPlatform(
  db: DatabaseSync,
  subscriberId: number,
  platform: Platform,
  caps: PlatformCapabilities,
): number {
  if (caps.platformsWithDelivered.has(platform)) {
    return countDistinctEditions(db, subscriberId, platform, "delivered");
  }
  const sent = countDistinctEditions(db, subscriberId, platform, "sent");
  const bounce = countDistinctEditions(db, subscriberId, platform, "bounce");
  return Math.max(0, sent - bounce);
}

/** Edições distintas em que o subscriber clicou ao menos 1 link, nesta
 *  plataforma — nunca o total de eventos de clique (ver docstring do
 *  módulo, "Únicas clicadas"). */
export function computeUniqueClickedForPlatform(
  db: DatabaseSync,
  subscriberId: number,
  platform: Platform,
): number {
  return countDistinctEditions(db, subscriberId, platform, "click");
}

/** Status cross-plataforma: "active" se QUALQUER `subscription` coberta
 *  (dentre `platforms`) estiver ativa hoje — alguém migrado (ex:
 *  `unsubscribed` na Beehiiv, `active` no Kit) continua sendo assinante
 *  corrente; "inactive" só quando NENHUMA plataforma coberta reporta
 *  `status === "active"`. */
function resolveCrossPlatformStatus(
  db: DatabaseSync,
  subscriberId: number,
  platforms: readonly Platform[],
): string {
  const subs = getSubscriptionsForSubscriber(db, subscriberId);
  const anyActive = subs.some(
    (s) => platforms.includes(s.platform) && s.status === "active",
  );
  return anyActive ? "active" : "inactive";
}

// ---------------------------------------------------------------------------
// LeitorInput cross-plataforma — 1 subscriber
// ---------------------------------------------------------------------------

/** Monta o `LeitorInput` (mesmo shape que `leitorInputFromBeehiivSubscriber`/
 *  `leitorInputFromKitSubscriber` de `leitor.ts`) somando recebidas/cliques
 *  ao longo de TODAS as `platforms` cobertas em que este subscriber tem
 *  alias — pronto pra passar direto pra `isLeitorV1` de `leitor.ts` (a
 *  definição não muda, só a fonte do dado). Subscriber sem alias em
 *  nenhuma plataforma coberta (ex: só existe em `brevo_clarice`) devolve
 *  `{status: "inactive", totalReceived: 0, totalUniqueClicked: 0}` — nunca
 *  passa em `isLeitorV1` de qualquer forma (piso `receivedMin` reprova). */
export function computeStoreLeitorInput(
  db: DatabaseSync,
  subscriberId: number,
  caps: PlatformCapabilities,
  platforms: readonly Platform[] = LEITOR_DIARIA_PLATFORMS,
): LeitorInput {
  const present = new Set(getAliasesForSubscriber(db, subscriberId).map((a) => a.platform));
  let totalReceived = 0;
  let totalUniqueClicked = 0;
  for (const platform of platforms) {
    if (!present.has(platform)) continue;
    totalReceived += computeReceivedForPlatform(db, subscriberId, platform, caps);
    totalUniqueClicked += computeUniqueClickedForPlatform(db, subscriberId, platform);
  }
  const status = present.size > 0 ? resolveCrossPlatformStatus(db, subscriberId, platforms) : "inactive";
  return { status, totalReceived, totalUniqueClicked };
}

export interface StoreLeitorResult {
  subscriberId: number;
  input: LeitorInput;
  isLeitor: boolean;
}

/** Conveniência: `computeStoreLeitorInput` + `isLeitorV1` num só resultado
 *  — usado pela ficha de busca por e-mail do painel (#6590), que quer
 *  mostrar "é leitor-v1?" ao lado da timeline sem o caller ter que
 *  encadear as duas chamadas. */
export function computeStoreLeitorResult(
  db: DatabaseSync,
  subscriberId: number,
  caps: PlatformCapabilities,
  thresholds: LeitorThresholds = LEITOR_V1_THRESHOLDS,
  platforms: readonly Platform[] = LEITOR_DIARIA_PLATFORMS,
): StoreLeitorResult {
  const input = computeStoreLeitorInput(db, subscriberId, caps, platforms);
  return { subscriberId, input, isLeitor: isLeitorV1(input, thresholds) };
}

// ---------------------------------------------------------------------------
// Summary batch — store inteiro
// ---------------------------------------------------------------------------

export interface StoreLeitorSummary {
  generated_at: string;
  thresholds: LeitorThresholds;
  /** Plataformas cobertas por este cálculo — sempre `LEITOR_DIARIA_PLATFORMS`
   *  a menos que o caller restrinja explicitamente. */
  platforms_counted: Platform[];
  /** Subscribers com alias em ao menos 1 plataforma coberta (exclui quem só
   *  existe em `brevo_clarice`, se essa for a única plataforma fora do
   *  conjunto coberto). */
  total_subscribers: number;
  total_active: number;
  leitores_v1: number;
  /** Sempre `CROSS_PLATFORM_FLOOR_NOTE` — este número é PISO, nunca exato
   *  (ver docstring do módulo). */
  note: string;
}

/** Varre o store inteiro (via `getAllSubscriberPlatforms`, 1 scan de
 *  `identity_alias`) e calcula `leitor-v1` cross-plataforma pra cada
 *  subscriber com alias em ao menos 1 plataforma coberta. Puro sobre um
 *  `DatabaseSync` já aberto — não abre/fecha o DB (isso é responsabilidade
 *  do caller, mesmo padrão de `getStoreCounts`/`buildUnmatchedReport`). */
export function summarizeStoreLeitores(
  db: DatabaseSync,
  thresholds: LeitorThresholds = LEITOR_V1_THRESHOLDS,
  platforms: readonly Platform[] = LEITOR_DIARIA_PLATFORMS,
): StoreLeitorSummary {
  const caps = detectPlatformCapabilities(db, platforms);
  const allPlatforms = getAllSubscriberPlatforms(db);

  let totalSubscribers = 0;
  let totalActive = 0;
  let leitores = 0;

  for (const [subscriberId, platformSet] of allPlatforms) {
    const coversAny = platforms.some((p) => platformSet.has(p));
    if (!coversAny) continue; // ex: subscriber só existe em brevo_clarice
    totalSubscribers++;
    const input = computeStoreLeitorInput(db, subscriberId, caps, platforms);
    if (input.status === "active") totalActive++;
    if (isLeitorV1(input, thresholds)) leitores++;
  }

  return {
    generated_at: new Date().toISOString(),
    thresholds,
    platforms_counted: [...platforms],
    total_subscribers: totalSubscribers,
    total_active: totalActive,
    leitores_v1: leitores,
    note: CROSS_PLATFORM_FLOOR_NOTE,
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parsePositiveNumber(raw: string | undefined, fallback: number, flag: string): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`--${flag} deve ser um número ≥ 0, recebido "${raw}".`);
  }
  return n;
}

export function main(argv: string[] = process.argv.slice(2)): void {
  const dbPath = getStringArg(argv, "db") ?? DEFAULT_DB_PATH;
  const thresholds: LeitorThresholds = {
    ctrMinPct: parsePositiveNumber(getStringArg(argv, "ctr-min"), LEITOR_V1_THRESHOLDS.ctrMinPct, "ctr-min"),
    receivedMin: parsePositiveNumber(
      getStringArg(argv, "received-min"),
      LEITOR_V1_THRESHOLDS.receivedMin,
      "received-min",
    ),
  };

  const db = openDiariaSubscribersDbSafe(dbPath);
  if (!db) {
    console.error(
      `[leitor-store] store não encontrado/ilegível em ${dbPath} — rode as ingestões (#6586/#6587) antes, ` +
        `ou passe --db explícito. "data/" mora no OneDrive (ver CLAUDE.md setup, passo 2b).`,
    );
    process.exitCode = 1;
    return;
  }
  try {
    const summary = summarizeStoreLeitores(db, thresholds);
    console.log(JSON.stringify(summary, null, 2));
  } finally {
    db.close();
  }
}

if (isMainModule(import.meta.url)) {
  main();
}
