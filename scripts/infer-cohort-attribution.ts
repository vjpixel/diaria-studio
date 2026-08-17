/**
 * infer-cohort-attribution.ts (#5514)
 *
 * Atribuição PROBABILÍSTICA por vizinhança temporal para cadastros sem
 * origem (`utm_source` vazio ou `direct`) — paliativo para a lacuna medida
 * na #5514 (45% da coorte de lançamento 21/07–02/08 entrou sem atribuição
 * nenhuma, 3× a taxa do resto da base).
 *
 * ## Disciplina (mesma de `build-origem-map.ts`, #5235 Parte 2)
 *
 * Script de análise OFFLINE, leitura local apenas — NUNCA chama a API
 * Beehiiv, NUNCA escreve `utm_source` de volta em lugar nenhum (nem na
 * Beehiiv, nem em `origem-original.json`, nem em qualquer campo "real"). O
 * output inteiro é rotulado `inferencia: true` em todo registro — é palpite,
 * não fato recuperado. A #5514 já confirmou que o dado original não é
 * recuperável (API não guarda log de eventos por assinante; o caso não é
 * DELETE+CREATE de reativação, então `build-origem-map.ts` não cobre).
 *
 * ## Método
 *
 * Para cada cadastro SEM atribuição (`utm_source` em `""`/`"direct"`),
 * procura o cadastro COM atribuição mais próximo em `created` (distância
 * absoluta em segundos), dentro de uma janela (`--window-minutes`, default
 * 30 — mesmo valor medido na issue: 25 dos 52 casos, 48%, têm vizinho
 * atribuído a menos de 30min). Fora da janela ou sem nenhum vizinho
 * atribuído → sem palpite (`guess: null`), nunca força um resultado.
 *
 * `utm_channel: "website"` (o único valor presente nos 52 casos da issue)
 * não entra no critério de "sem atribuição" — o corte é só `utm_source`,
 * porque é o campo que os outros scripts do projeto (`count-subscriptions-
 * by-utm.ts`, `cohort-retention.ts`) já usam como canônico, e é isso que
 * falta pro palpite completar.
 *
 * ## Uso
 *
 *   npx tsx scripts/infer-cohort-attribution.ts --since 2026-07-21 --until 2026-08-02
 *   npx tsx scripts/infer-cohort-attribution.ts --since ... --until ... --window-minutes 45 --json
 *
 * Flags:
 *   --since AAAA-MM-DD       início INCLUSIVO da coorte (obrigatório)
 *   --until AAAA-MM-DD       fim INCLUSIVO da coorte, dia inteiro (obrigatório)
 *   --window-minutes N       janela de vizinhança, default 30
 *   --snapshot AAAA-MM-DD    snapshot específico (default: mais recente disponível)
 *   --backup-root <path>     default data/beehiiv-backup
 *   --out <path>             default data/aquisicao/cohort-attribution-inference.json
 *   --json                   imprime o relatório em stdout também (além de escrever o arquivo)
 *
 * Exit codes: 0=sucesso, 1=sem snapshot/erro de leitura, 2=args inválidos.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isMainModule, parseArgs } from "./lib/cli-args.ts";
import {
  latestSnapshotDate,
  readSnapshotSubscribers,
  type BeehiivBackupSubscriber,
} from "./lib/beehiiv-backup-snapshots.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const DEFAULT_BACKUP_ROOT = resolve(ROOT, "data/beehiiv-backup");
export const DEFAULT_OUT_PATH = resolve(ROOT, "data/aquisicao/cohort-attribution-inference.json");
export const DEFAULT_WINDOW_MINUTES = 30;

// ---------------------------------------------------------------------------
// Núcleo puro — sem I/O
// ---------------------------------------------------------------------------

/** Forma mínima exigida do subscriber — o campo `email` é a chave de
 *  identidade usada só no relatório (nunca em escrita), `created` epoch
 *  segundos (como a Beehiiv devolve). */
export interface AttributionSubscriber {
  email: string;
  created: number;
  utm_source: string | null | undefined;
  utm_medium?: string | null;
  utm_campaign?: string | null;
  referring_site?: string | null;
}

/** `utm_source` vazio ou `"direct"` (case-insensitive, trimmed) → sem
 *  atribuição. Mesmo critério textual da issue #5514. @pure */
export function isUnattributed(utmSource: string | null | undefined): boolean {
  const s = (utmSource ?? "").trim().toLowerCase();
  return s === "" || s === "direct";
}

export interface AttributionGuess {
  source: string;
  medium: string | null;
  campaign: string | null;
  referring_site: string | null;
  /** Distância absoluta, em segundos, até o vizinho atribuído usado. */
  distance_seconds: number;
  neighbor_email: string;
  /** Sempre `true` — marca explícita de que é palpite, não fato. Nunca
   *  omitido, nunca `false` (o invariante que a issue pede: não pode
   *  circular como se fosse dado recuperado). */
  inferencia: true;
}

export interface AttributionInferenceRecord {
  email: string;
  created: number;
  /** `null` quando não há vizinho atribuído dentro da janela. */
  guess: AttributionGuess | null;
}

export interface AttributionInferenceResult {
  window_minutes: number;
  unattributed_total: number;
  attributed_total: number;
  guessed_count: number;
  guessed_pct: number;
  records: AttributionInferenceRecord[];
}

function isAttributed(sub: AttributionSubscriber): boolean {
  return !isUnattributed(sub.utm_source);
}

/**
 * Monta o mapa de palpites por vizinhança temporal. `subscribers` não
 * precisa vir ordenado. @pure
 */
export function inferCohortAttribution(
  subscribers: AttributionSubscriber[],
  opts: { windowMinutes?: number } = {},
): AttributionInferenceResult {
  const windowMinutes = opts.windowMinutes ?? DEFAULT_WINDOW_MINUTES;
  const windowSeconds = windowMinutes * 60;

  const unattributed = subscribers.filter((s) => isUnattributed(s.utm_source));
  const attributed = subscribers.filter(isAttributed).sort((a, b) => a.created - b.created);

  const records: AttributionInferenceRecord[] = unattributed
    .slice()
    .sort((a, b) => a.created - b.created)
    .map((sub) => {
      let nearest: AttributionSubscriber | null = null;
      let nearestDistance = Infinity;
      for (const candidate of attributed) {
        const distance = Math.abs(candidate.created - sub.created);
        if (distance < nearestDistance) {
          nearestDistance = distance;
          nearest = candidate;
        }
      }
      const guess: AttributionGuess | null =
        nearest && nearestDistance <= windowSeconds
          ? {
              source: nearest.utm_source ?? "",
              medium: nearest.utm_medium ?? null,
              campaign: nearest.utm_campaign ?? null,
              referring_site: nearest.referring_site ?? null,
              distance_seconds: nearestDistance,
              neighbor_email: nearest.email,
              inferencia: true,
            }
          : null;
      return { email: sub.email, created: sub.created, guess };
    });

  const guessedCount = records.filter((r) => r.guess !== null).length;

  return {
    window_minutes: windowMinutes,
    unattributed_total: unattributed.length,
    attributed_total: attributed.length,
    guessed_count: guessedCount,
    guessed_pct: unattributed.length === 0 ? 0 : Math.round((guessedCount / unattributed.length) * 1000) / 10,
    records,
  };
}

/** Recorta subscribers por janela de `created` (epoch segundos),
 *  `sinceEpoch`/`untilEpoch` ambos INCLUSIVOS. @pure */
export function filterByCreatedWindow<T extends { created: number }>(
  subscribers: T[],
  sinceEpoch: number,
  untilEpoch: number,
): T[] {
  return subscribers.filter((s) => s.created >= sinceEpoch && s.created <= untilEpoch);
}

function toAttributionSubscriber(rec: BeehiivBackupSubscriber): AttributionSubscriber {
  return {
    email: rec.email,
    created: rec.created,
    utm_source: rec.utm_source,
    utm_medium: rec.utm_medium,
    utm_campaign: rec.utm_campaign,
    referring_site: rec.referring_site,
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export interface InferCohortAttributionCliArgs {
  since: string;
  until: string;
  windowMinutes: number;
  snapshot: string | null;
  backupRoot: string;
  out: string;
  json: boolean;
}

/** Parseia `AAAA-MM-DD` como epoch segundos UTC. `endOfDay` inclui o dia
 *  inteiro (23:59:59 UTC). Lança em formato inválido. @pure */
export function dateToEpoch(dateStr: string, endOfDay = false): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    throw new Error(`data inválida (esperado AAAA-MM-DD): ${dateStr}`);
  }
  const suffix = endOfDay ? "T23:59:59Z" : "T00:00:00Z";
  const ms = Date.parse(`${dateStr}${suffix}`);
  if (Number.isNaN(ms)) throw new Error(`data inválida: ${dateStr}`);
  return Math.floor(ms / 1000);
}

export function parseInferCohortAttributionArgs(argv: string[]): InferCohortAttributionCliArgs {
  const { flags, values } = parseArgs(argv);
  const since = values["since"];
  const until = values["until"];
  if (!since || !until) {
    throw new Error("--since e --until são obrigatórios (AAAA-MM-DD)");
  }
  return {
    since,
    until,
    windowMinutes: values["window-minutes"] ? Number(values["window-minutes"]) : DEFAULT_WINDOW_MINUTES,
    snapshot: values["snapshot"] ?? null,
    backupRoot: values["backup-root"] ?? DEFAULT_BACKUP_ROOT,
    out: values["out"] ?? DEFAULT_OUT_PATH,
    json: flags.has("json"),
  };
}

export function main(argv: string[] = process.argv.slice(2)): void {
  let args: InferCohortAttributionCliArgs;
  try {
    args = parseInferCohortAttributionArgs(argv);
  } catch (err) {
    console.error(`[infer-cohort-attribution] ${(err as Error).message}`);
    process.exitCode = 2;
    return;
  }

  const date = args.snapshot ?? latestSnapshotDate(args.backupRoot);
  if (!date) {
    console.error(
      `[infer-cohort-attribution] nenhum snapshot em ${args.backupRoot} — rodar ` +
        `\`npx tsx scripts/backup-beehiiv.ts\` primeiro`,
    );
    process.exitCode = 1;
    return;
  }
  const raw = readSnapshotSubscribers(args.backupRoot, date);
  if (raw.length === 0) {
    console.error(`[infer-cohort-attribution] snapshot ${date} não tem subscribers.jsonl legível`);
    process.exitCode = 1;
    return;
  }

  const sinceEpoch = dateToEpoch(args.since, false);
  const untilEpoch = dateToEpoch(args.until, true);

  // O universo de "atribuídos" pra achar vizinho vem da BASE INTEIRA do
  // snapshot (não só da janela da coorte) — um cadastro sem atribuição no
  // fim da janela pode ter o vizinho mais próximo logo depois dela.
  const all = raw.map(toAttributionSubscriber);
  const cohort = filterByCreatedWindow(all, sinceEpoch, untilEpoch);
  const cohortUnattributedEmails = new Set(
    cohort.filter((s) => isUnattributed(s.utm_source)).map((s) => s.email),
  );

  // Roda a inferência sobre a BASE INTEIRA (vizinhos podem estar fora da
  // janela), depois filtra o relatório só pros sem-atribuição DA COORTE.
  const full = inferCohortAttribution(all, { windowMinutes: args.windowMinutes });
  const cohortRecords = full.records.filter((r) => cohortUnattributedEmails.has(r.email));
  const guessedCount = cohortRecords.filter((r) => r.guess !== null).length;

  const result: AttributionInferenceResult = {
    window_minutes: full.window_minutes,
    unattributed_total: cohortRecords.length,
    attributed_total: full.attributed_total,
    guessed_count: guessedCount,
    guessed_pct:
      cohortRecords.length === 0 ? 0 : Math.round((guessedCount / cohortRecords.length) * 1000) / 10,
    records: cohortRecords,
  };

  const output = {
    generated_at: new Date().toISOString(),
    snapshot_date: date,
    since: args.since,
    until: args.until,
    disclaimer:
      "INFERÊNCIA, NÃO FATO. Palpite de atribuição por vizinhança temporal " +
      "(#5514) — nunca gravar em utm_source real, Beehiiv, ou origem-original.json. " +
      "Todo registro com guess != null carrega inferencia:true; guess:null significa " +
      "'sem vizinho atribuído dentro da janela', não 'atribuição desconhecida = X'.",
    ...result,
  };

  const outDir = dirname(args.out);
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  writeFileSync(args.out, JSON.stringify(output, null, 2));

  console.error(
    `[infer-cohort-attribution] snapshot=${date} janela=${args.since}..${args.until} ` +
      `sem_atribuicao=${result.unattributed_total} palpites=${result.guessed_count} ` +
      `(${result.guessed_pct}%) window=${args.windowMinutes}min → ${args.out}`,
  );
  if (args.json) {
    console.log(JSON.stringify(output, null, 2));
  }
}

if (isMainModule(import.meta.url)) {
  main();
}
