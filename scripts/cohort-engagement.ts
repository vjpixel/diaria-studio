/**
 * cohort-engagement.ts (#4464)
 *
 * Script de análise read-only: mede LEITORES (não só cadastros) por origem de
 * aquisição (`utm_source`, com `referring_site` como fallback), usando a API
 * v2 da Beehiiv com `expand[]=stats`.
 *
 *   GET /publications/{pub}/subscriptions?expand[]=stats&expand[]=utm_params&limit=100&page=N
 *   → data[].stats = { total_sent, total_received, total_unique_opened,
 *                       total_clicked, total_unique_clicked, open_rate, click_rate }
 *
 * `open_rate` vem da Beehiiv em escala 0-100 (percentual), não fração 0-1 —
 * daí o default de `--threshold` ser 40 (= 40%), comparável direto.
 *
 * O plano de aquisição de 29/jul registrou esse recorte como bloqueado (item
 * 12, "criar segmentos por referring_site"). Não está bloqueado: rodou ao
 * vivo em 02/08/2026, ~1 min para drenar 1.413 assinaturas, sem tocar em
 * segmento nenhum. Ver issue #4464 para o achado que motivou (Google Ads e
 * Beehiiv Boosts compraram base, não leitor).
 *
 * ## Uso
 *
 *   npx tsx scripts/cohort-engagement.ts
 *   npx tsx scripts/cohort-engagement.ts --threshold 50
 *   npx tsx scripts/cohort-engagement.ts --min-received 10
 *   npx tsx scripts/cohort-engagement.ts --since 2026-07-31
 *   npx tsx scripts/cohort-engagement.ts --json
 *
 * Flags:
 *   --threshold N     open_rate mínimo (0-100) para contar como "leitor". Default 40.
 *   --min-received N  refaz o corte de leitores/abertura/média só com ativos
 *                      cujo total_received >= N (amostra com histórico suficiente).
 *   --since AAAA-MM-DD Filtra assinantes por `created` (epoch, UTC) >= início do dia
 *                      informado (inclusivo). Ex: verificar a meta da #4295.
 *   --json            Emite o resultado como JSON (stdout) para uso em pipelines.
 *
 * ## Agrupamento
 *
 * Chave de grupo = `utm_source` normalizado; se ausente, cai para
 * `referring_site` normalizado (mesmo tratamento null/vazio → "__none__").
 *
 * ## Saída por grupo
 *
 *   cadastros           total de assinantes no grupo (todos os status, após --since)
 *   ativos / inativos / pending / invalid   contagem por status
 *   leitores            ativos com stats.open_rate >= threshold
 *   abertura_agregada   Σ total_unique_opened ÷ Σ total_received (fração 0-1) dos
 *                       ativos considerados (após --min-received, se houver)
 *   media_recebidas     média de total_received dos ativos considerados
 *   mediana_recebidas   mediana de total_received dos ativos considerados
 *   amostra_instavel    true se mediana_recebidas < 10 (poucas edições recebidas
 *                       → taxa não confiável)
 *
 * Assinante sem `stats` (campo ausente na resposta) nunca conta como leitor e
 * é excluído do denominador de abertura_agregada/media/mediana — mas ainda
 * entra em cadastros/ativos (contagem de status independe de stats).
 *
 * Env:
 *   BEEHIIV_API_KEY           obrigatório
 *   BEEHIIV_PUBLICATION_ID    opcional — fallback p/ platform.config.json
 *   BEEHIIV_API_URL           opcional — override para tests
 *
 * Exit codes: 0=sucesso, 1=erro de API/truncamento, 2=config inválida, 3=args inválidos.
 */

import "dotenv/config";
import { loadBeehiivConfig, beehiivApiBase } from "./lib/beehiiv-config.ts";
import { isMainModule, parseArgs } from "./lib/cli-args.ts";

const BEEHIIV_API = beehiivApiBase();
const PER_PAGE = 100;
const RATE_LIMIT_DELAY_MS = 300;
const MAX_RETRIES = 5;
const DEFAULT_THRESHOLD = 40;

// ---------------------------------------------------------------------------
// Tipos
// ---------------------------------------------------------------------------

/** Subconjunto de `stats` que nos interessa (expand[]=stats). */
export interface SubscriberStats {
  total_sent?: number | null;
  total_received?: number | null;
  total_unique_opened?: number | null;
  total_clicked?: number | null;
  total_unique_clicked?: number | null;
  open_rate?: number | null;
  click_rate?: number | null;
}

/** Subscription com os campos que este script consome. */
export interface EngagementSubscriber {
  id?: string;
  status?: string | null;
  /** Epoch em segundos (UTC) — igual ao usado pela API Beehiiv. */
  created?: number | null;
  utm_source?: string | null;
  referring_site?: string | null;
  stats?: SubscriberStats | null;
}

export interface GroupEngagement {
  cadastros: number;
  ativos: number;
  inativos: number;
  pending: number;
  invalid: number;
  /** Outros status (ex: validating, paused, needs_attention) — não descartados silenciosamente. */
  outros_status: number;
  leitores: number;
  /** Fração 0-1, ou null se não há denominador (nenhum ativo considerado recebeu email). */
  abertura_agregada: number | null;
  media_recebidas: number | null;
  mediana_recebidas: number | null;
  amostra_instavel: boolean;
  /** Quantos ativos entraram no denominador de leitores/abertura/média (após --min-received). */
  amostra_considerada: number;
}

export interface EngagementOptions {
  /** open_rate mínimo (escala 0-100) para contar como leitor. */
  threshold: number;
  /** Se definido, restringe leitores/abertura/média a ativos com total_received >= minReceived. */
  minReceived?: number;
}

export interface EngagementResult {
  groups: Record<string, GroupEngagement>;
  total_cadastros: number;
  threshold: number;
  min_received: number | null;
  since: string | null;
  fetched_at: string;
}

// ---------------------------------------------------------------------------
// Helpers puros — normalização, agrupamento, estatística
// ---------------------------------------------------------------------------

/**
 * Normaliza um valor de atribuição (utm_source ou referring_site):
 * null/undefined/"" → "__none__"; qualquer outro valor → lowercase trimmed.
 *
 * @pure
 */
export function normalizeKey(raw: unknown): string {
  if (raw == null) return "__none__";
  const s = String(raw).trim().toLowerCase();
  return s === "" ? "__none__" : s;
}

/**
 * Resolve a chave de grupo de um assinante: `utm_source` normalizado; se
 * ausente (__none__), cai para `referring_site` normalizado.
 *
 * @pure
 */
export function resolveGroupKey(sub: Pick<EngagementSubscriber, "utm_source" | "referring_site">): string {
  const utm = normalizeKey(sub.utm_source);
  if (utm !== "__none__") return utm;
  return normalizeKey(sub.referring_site);
}

/**
 * Converte "AAAA-MM-DD" no epoch (segundos, UTC) do INÍCIO daquele dia.
 * Lança se o formato for inválido — CLI guard trata a mensagem.
 *
 * @pure
 */
export function parseSinceToEpochSeconds(since: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(since.trim());
  if (!m) {
    throw new Error(`--since inválido: "${since}" (esperado AAAA-MM-DD)`);
  }
  const [, y, mo, d] = m;
  const ms = Date.UTC(Number(y), Number(mo) - 1, Number(d), 0, 0, 0, 0);
  if (Number.isNaN(ms)) {
    throw new Error(`--since inválido: "${since}" (data não existe)`);
  }
  return Math.floor(ms / 1000);
}

/**
 * Filtra assinantes com `created` >= sinceEpochSeconds (inclusivo na borda).
 * Assinante sem `created` é excluído quando `sinceEpochSeconds` é informado —
 * não há como verificar a condição, e assumir presente enviesaria a métrica.
 *
 * @pure
 */
export function filterSince(
  subs: EngagementSubscriber[],
  sinceEpochSeconds: number | null,
): EngagementSubscriber[] {
  if (sinceEpochSeconds == null) return subs;
  return subs.filter((s) => typeof s.created === "number" && s.created >= sinceEpochSeconds);
}

/** Mediana de uma lista de números. Retorna null para lista vazia. @pure */
export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1] + sorted[mid]) / 2;
  }
  return sorted[mid];
}

/** Média de uma lista de números. Retorna null para lista vazia. @pure */
export function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/**
 * Calcula as métricas de engajamento de UM grupo (assinantes já filtrados
 * pra essa origem). Contagens de status usam TODO o grupo; leitores/
 * abertura_agregada/media/mediana usam só os ATIVOS com `stats` presente
 * (e, se `minReceived` for informado, só os que atingem esse piso).
 *
 * @pure
 */
export function computeGroupEngagement(
  subsInGroup: EngagementSubscriber[],
  opts: EngagementOptions,
): GroupEngagement {
  let ativos = 0;
  let inativos = 0;
  let pending = 0;
  let invalid = 0;
  let outros_status = 0;

  const ativosComStats: Array<{ received: number; opened: number; open_rate: number | null }> = [];

  for (const sub of subsInGroup) {
    switch (sub.status) {
      case "active":
        ativos++;
        break;
      case "inactive":
        inativos++;
        break;
      case "pending":
        pending++;
        break;
      case "invalid":
        invalid++;
        break;
      default:
        outros_status++;
        break;
    }

    if (sub.status !== "active") continue;
    const stats = sub.stats;
    if (!stats) continue; // sem stats: conta em ativos acima, mas fora do denominador de engajamento

    const received = typeof stats.total_received === "number" ? stats.total_received : 0;
    const opened = typeof stats.total_unique_opened === "number" ? stats.total_unique_opened : 0;
    const openRate = typeof stats.open_rate === "number" ? stats.open_rate : null;
    ativosComStats.push({ received, opened, open_rate: openRate });
  }

  const considerados =
    opts.minReceived != null
      ? ativosComStats.filter((a) => a.received >= opts.minReceived!)
      : ativosComStats;

  const leitores = considerados.filter(
    (a) => a.open_rate != null && a.open_rate >= opts.threshold,
  ).length;

  const totalReceived = considerados.reduce((sum, a) => sum + a.received, 0);
  const totalOpened = considerados.reduce((sum, a) => sum + a.opened, 0);
  const abertura_agregada = totalReceived > 0 ? totalOpened / totalReceived : null;

  const receivedValues = considerados.map((a) => a.received);
  const media_recebidas = mean(receivedValues);
  const mediana_recebidas = median(receivedValues);
  const amostra_instavel = mediana_recebidas != null && mediana_recebidas < 10;

  return {
    cadastros: subsInGroup.length,
    ativos,
    inativos,
    pending,
    invalid,
    outros_status,
    leitores,
    abertura_agregada,
    media_recebidas,
    mediana_recebidas,
    amostra_instavel,
    amostra_considerada: considerados.length,
  };
}

/**
 * Agrupa por `resolveGroupKey` e calcula `computeGroupEngagement` por grupo.
 *
 * @pure
 */
export function aggregateEngagement(
  subs: EngagementSubscriber[],
  opts: EngagementOptions,
): Record<string, GroupEngagement> {
  const byGroup = new Map<string, EngagementSubscriber[]>();
  for (const sub of subs) {
    const key = resolveGroupKey(sub);
    const arr = byGroup.get(key);
    if (arr) arr.push(sub);
    else byGroup.set(key, [sub]);
  }

  const out: Record<string, GroupEngagement> = {};
  for (const [key, group] of byGroup) {
    out[key] = computeGroupEngagement(group, opts);
  }
  return out;
}

/**
 * Formata o resultado agregado como tabela legível (stdout), ordenada por
 * `cadastros` decrescente — mesma convenção do script irmão.
 *
 * @pure
 */
export function formatEngagementTable(result: EngagementResult): string {
  const rows = Object.entries(result.groups).sort((a, b) => b[1].cadastros - a[1].cadastros);
  if (rows.length === 0) return "(nenhum assinante encontrado)";

  const maxKeyLen = Math.max(...rows.map(([k]) => k.length), "origem".length);
  const header =
    `${"origem".padEnd(maxKeyLen)}  cadastros  ativos  inativos  pending  invalid  ` +
    `leitores  abertura%  media_recebidas`;
  const sep = "-".repeat(header.length);
  const lines = [header, sep];

  for (const [key, g] of rows) {
    const abertura = g.abertura_agregada != null ? `${(g.abertura_agregada * 100).toFixed(1)}%` : "n/a";
    const media = g.media_recebidas != null ? g.media_recebidas.toFixed(1) : "n/a";
    const instavelFlag = g.amostra_instavel ? " ⚠instável" : "";
    lines.push(
      `${key.padEnd(maxKeyLen)}  ${String(g.cadastros).padStart(9)}  ${String(g.ativos).padStart(6)}  ` +
        `${String(g.inativos).padStart(8)}  ${String(g.pending).padStart(7)}  ${String(g.invalid).padStart(7)}  ` +
        `${String(g.leitores).padStart(8)}  ${abertura.padStart(9)}  ${media.padStart(15)}${instavelFlag}`,
    );
  }
  lines.push(sep);
  lines.push(`TOTAL cadastros: ${result.total_cadastros}`);
  lines.push(`threshold (open_rate >=): ${result.threshold}`);
  if (result.min_received != null) lines.push(`min-received: ${result.min_received}`);
  if (result.since != null) lines.push(`since: ${result.since}`);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// HTTP helpers (mesmo padrão do count-subscriptions-by-utm.ts / backup-beehiiv.ts)
// ---------------------------------------------------------------------------

interface FetchResult<T> {
  ok: boolean;
  status: number;
  body: T | null;
}

interface Page<T> {
  data?: T[];
  total_results?: number;
  limit?: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function apiFetch<T>(path: string, apiKey: string, retries = 0): Promise<FetchResult<T>> {
  await sleep(RATE_LIMIT_DELAY_MS);
  const res = await fetch(`${BEEHIIV_API}${path}`, {
    headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
  });

  if (res.status === 429 && retries < MAX_RETRIES) {
    const retryAfter = parseInt(res.headers.get("Retry-After") ?? "60", 10);
    const wait = Math.max(retryAfter * 1000, 30_000);
    process.stderr.write(
      `[cohort-engagement] rate-limited — esperando ${Math.round(wait / 1000)}s (tentativa ${retries + 1}/${MAX_RETRIES})\n`,
    );
    await sleep(wait);
    return apiFetch<T>(path, apiKey, retries + 1);
  }

  if (!res.ok) return { ok: false, status: res.status, body: null };
  return { ok: true, status: res.status, body: (await res.json()) as T };
}

/**
 * Drena TODAS as páginas de `/subscriptions?expand[]=stats&expand[]=utm_params`.
 * Mesmo guard anti-truncamento do `count-subscriptions-by-utm.ts` (#2457):
 * respeita `total_results` quando presente; se a API não o reportar, usa o
 * `limit` REPORTADO na página (não `PER_PAGE`) pra decidir se há mais.
 * Aborta com erro (nunca retorna contagem parcial) se a drenagem terminar
 * truncada.
 */
export async function fetchAllSubscribers(
  publicationId: string,
  apiKey: string,
): Promise<EngagementSubscriber[]> {
  const all: EngagementSubscriber[] = [];
  let page = 1;
  let more = true;
  let totalResults: number | null = null;

  while (more) {
    const path =
      `/publications/${publicationId}/subscriptions` +
      `?expand[]=stats&expand[]=utm_params&limit=${PER_PAGE}&page=${page}`;
    const res = await apiFetch<Page<EngagementSubscriber>>(path, apiKey);

    if (!res.ok) {
      throw new Error(`[cohort-engagement] Beehiiv API ${res.status} em subscriptions página ${page}`);
    }

    const body = res.body!;
    const chunk = body.data ?? [];
    all.push(...chunk);
    if (body.total_results != null) totalResults = body.total_results;

    if (chunk.length === 0) {
      more = false;
    } else if (totalResults != null) {
      more = all.length < totalResults;
    } else {
      const apiLimit = typeof body.limit === "number" && body.limit > 0 ? body.limit : PER_PAGE;
      more = chunk.length >= apiLimit;
    }

    process.stderr.write(
      `[cohort-engagement] página ${page}: ${chunk.length} subscriptions (${all.length}${totalResults != null ? `/${totalResults}` : ""} total)\n`,
    );
    page++;
  }

  // Guard anti-truncamento pós-loop: total_results reportado mas não drenado
  // por completo (página vazia mid-drain, hiccup) → truncamento silencioso →
  // falhar em vez de retornar contagem parcial autoritativa.
  if (totalResults != null && all.length < totalResults) {
    throw new Error(
      `[cohort-engagement] truncado: ${all.length}/${totalResults} subscriptions drenadas — contagem incompleta, abortando.`,
    );
  }

  return all;
}

/** Orquestra fetch + filtro `--since` + agregação. Não é `@pure` (I/O). */
export async function runCohortEngagement(
  publicationId: string,
  apiKey: string,
  opts: EngagementOptions & { sinceEpochSeconds?: number | null; sinceLabel?: string | null },
): Promise<EngagementResult> {
  const all = await fetchAllSubscribers(publicationId, apiKey);
  const filtered = filterSince(all, opts.sinceEpochSeconds ?? null);
  const groups = aggregateEngagement(filtered, opts);

  return {
    groups,
    total_cadastros: filtered.length,
    threshold: opts.threshold,
    min_received: opts.minReceived ?? null,
    since: opts.sinceLabel ?? null,
    fetched_at: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// CLI guard
// ---------------------------------------------------------------------------

if (isMainModule(import.meta.url)) {
  const argv = process.argv.slice(2);
  const { flags, values } = parseArgs(argv);
  const jsonMode = flags.has("json");

  const thresholdRaw = values["threshold"];
  const threshold = thresholdRaw != null ? Number(thresholdRaw) : DEFAULT_THRESHOLD;
  if (Number.isNaN(threshold)) {
    process.stderr.write(`[cohort-engagement] --threshold inválido: "${thresholdRaw}"\n`);
    process.exit(3);
  }

  const minReceivedRaw = values["min-received"];
  let minReceived: number | undefined;
  if (minReceivedRaw != null) {
    minReceived = Number(minReceivedRaw);
    if (Number.isNaN(minReceived)) {
      process.stderr.write(`[cohort-engagement] --min-received inválido: "${minReceivedRaw}"\n`);
      process.exit(3);
    }
  }

  const sinceRaw = values["since"];
  let sinceEpochSeconds: number | null = null;
  if (sinceRaw != null) {
    try {
      sinceEpochSeconds = parseSinceToEpochSeconds(sinceRaw);
    } catch (e) {
      process.stderr.write(`[cohort-engagement] ${(e as Error).message}\n`);
      process.exit(3);
    }
  }

  const cfg = loadBeehiivConfig("[cohort-engagement]");

  runCohortEngagement(cfg.publicationId, cfg.apiKey, {
    threshold,
    minReceived,
    sinceEpochSeconds,
    sinceLabel: sinceRaw ?? null,
  })
    .then((result) => {
      if (jsonMode) {
        process.stdout.write(JSON.stringify(result, null, 2) + "\n");
        return;
      }
      process.stderr.write(`\n[cohort-engagement] Resultado (fetched_at=${result.fetched_at})\n\n`);
      process.stdout.write(formatEngagementTable(result) + "\n");
    })
    .catch((err) => {
      process.stderr.write(`[cohort-engagement] ERRO: ${String(err)}\n`);
      process.exit(1);
    });
}
