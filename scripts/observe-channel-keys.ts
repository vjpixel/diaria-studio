/**
 * observe-channel-keys.ts (#5493)
 *
 * Instrumento de OBSERVAÇÃO — nunca adivinhação — das chaves de grupo
 * (`utm_source`/`referring_site` normalizados, mesma resolução de
 * `scripts/cohort-engagement.ts` → `resolveGroupKey`) usadas por assinantes
 * cadastrados numa janela de datas. Existe pra transformar "chute de chave
 * de canal" em "medição": rodar depois de ≥1 dia de campanha real
 * (Meta/Microsoft Advertising) e colar a saída LITERAL no PR que adicionar a
 * spec correspondente a `CHANNEL_KEY_SPECS` (`scripts/lib/cac.ts`) — o
 * passo 4 da issue #5493, explicitamente bloqueado até existir essa
 * evidência ("não deve ser antecipado").
 *
 * Só leitura LOCAL (snapshot Beehiiv já baixado por `Diaria-Beehiiv-Backup`)
 * — nunca toca a API Beehiiv/Meta/Microsoft ao vivo (guard de publicação do
 * overnight/develop).
 *
 * ## Uso
 *
 *   npx tsx scripts/observe-channel-keys.ts --since 2026-08-17
 *   npx tsx scripts/observe-channel-keys.ts --since 2026-08-17 --until 2026-08-20
 *   npx tsx scripts/observe-channel-keys.ts --since 2026-08-17 --filter facebook
 *   npx tsx scripts/observe-channel-keys.ts --since 2026-08-17 --json
 *
 * Flags:
 *   --since AAAA-MM-DD  Obrigatória — borda inferior INCLUSIVA de `created`.
 *   --until AAAA-MM-DD  Opcional — borda superior INCLUSIVA (default: sem borda,
 *                       "até agora").
 *   --filter REGEX      Opcional — só chaves que casam a regex (case-insensitive).
 *                       Útil pra isolar candidatos de um canal específico
 *                       (ex: `--filter "facebook|instagram|fb|ig"` pra Meta).
 *   --snapshot AAAA-MM-DD  Snapshot específico (default: mais recente).
 *   --root PATH         Override de `data/beehiiv-backup` (default, testes).
 *   --json              Emite o resultado como JSON.
 *
 * Contas internas/teste (`INTERNAL_EMAILS`/`isTestAccount`, mesmo filtro de
 * `cac-report.ts`) são excluídas antes de contar — o editor/QA clicando no
 * próprio anúncio não deveria aparecer como "chave observada" de um canal.
 *
 * Exit codes: 0 = sucesso; 1 = insumo obrigatório ausente/ilegível
 * (`--since` ausente, snapshot ausente) ou `--since`/`--until` inválido.
 */

import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { isMainModule, hasFlag, getStringArg } from "./lib/cli-args.ts";
import { latestSnapshotDate, readSnapshotSubscribers, type BeehiivBackupSubscriber } from "./lib/beehiiv-backup-snapshots.ts";
import {
  resolveGroupKey,
  filterWindow,
  countMissingCreated,
  parseSinceToEpochSeconds,
  parseUntilToEpochSecondsExclusive,
  resolveWindowGuardError,
  type CohortWindow,
  type EngagementSubscriber,
} from "./cohort-engagement.ts";
import { filterInternalAndTestSubscribers, toEngagementSubscriber } from "./lib/cac.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const DEFAULT_BACKUP_ROOT = resolve(ROOT, "data", "beehiiv-backup");

export interface KeyObservation {
  key: string;
  count: number;
}

export interface ObserveChannelKeysResult {
  totalConsidered: number;
  excludedMissingCreated: number;
  observations: KeyObservation[];
}

/**
 * Núcleo puro: agrupa `subs` por `resolveGroupKey` dentro de `window`,
 * ordenado por volume descendente (empate: ordem alfabética da chave).
 * Reusa `filterWindow`/`countMissingCreated` de `cohort-engagement.ts` —
 * nunca reimplementa a comparação de datas (mesma disciplina de
 * `scripts/lib/cac.ts`).
 * @pure
 */
export function observeChannelKeys(
  subs: EngagementSubscriber[],
  window: CohortWindow,
  filterRegex?: RegExp,
): ObserveChannelKeysResult {
  const excludedMissingCreated = countMissingCreated(subs, window);
  const filtered = filterWindow(subs, window);

  const counts = new Map<string, number>();
  for (const s of filtered) {
    const key = resolveGroupKey(s);
    if (filterRegex && !filterRegex.test(key)) continue;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  const observations = [...counts.entries()]
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));

  return { totalConsidered: filtered.length, excludedMissingCreated, observations };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export interface ObserveChannelKeysCliArgs {
  backupRoot: string;
  snapshotDate: string | null;
  since: string | null;
  until: string | null;
  filter: string | null;
  json: boolean;
}

export function parseObserveChannelKeysArgs(argv: string[]): ObserveChannelKeysCliArgs {
  return {
    backupRoot: getStringArg(argv, "root") ?? DEFAULT_BACKUP_ROOT,
    snapshotDate: getStringArg(argv, "snapshot") ?? null,
    since: getStringArg(argv, "since") ?? null,
    until: getStringArg(argv, "until") ?? null,
    filter: getStringArg(argv, "filter") ?? null,
    json: hasFlag(argv, "json"),
  };
}

function formatTable(result: ObserveChannelKeysResult): string {
  const lines: string[] = [];
  lines.push(`n considerado (após janela): ${result.totalConsidered}`);
  if (result.excludedMissingCreated > 0) {
    lines.push(`⚠ ${result.excludedMissingCreated} assinante(s) descartado(s) por falta de "created".`);
  }
  lines.push("");
  lines.push("| Chave | Cadastros |");
  lines.push("|---|---|");
  for (const obs of result.observations) {
    lines.push(`| ${obs.key} | ${obs.count} |`);
  }
  return lines.join("\n");
}

export function main(argv: string[] = process.argv.slice(2), rootDir: string = ROOT): void {
  const args = parseObserveChannelKeysArgs(argv);

  if (!args.since) {
    console.error(`[observe-channel-keys] --since AAAA-MM-DD é obrigatório (borda inferior da janela de observação).`);
    process.exitCode = 1;
    return;
  }

  let window: CohortWindow;
  try {
    const since = parseSinceToEpochSeconds(args.since);
    const untilExclusive = args.until ? parseUntilToEpochSecondsExclusive(args.until) : null;
    const guardError = resolveWindowGuardError({ since, untilExclusive }, { since: args.since, until: args.until });
    if (guardError) throw new Error(guardError);
    window = { since, untilExclusive };
  } catch (e) {
    console.error(`[observe-channel-keys] ${(e as Error).message}`);
    process.exitCode = 1;
    return;
  }

  const snapshotDate = args.snapshotDate ?? latestSnapshotDate(args.backupRoot);
  if (!snapshotDate) {
    console.error(`[observe-channel-keys] nenhum snapshot encontrado em ${args.backupRoot}.`);
    process.exitCode = 1;
    return;
  }

  let raw: BeehiivBackupSubscriber[];
  try {
    raw = readSnapshotSubscribers(args.backupRoot, snapshotDate);
  } catch (e) {
    console.error(`[observe-channel-keys] falha ao ler snapshot ${snapshotDate}: ${(e as Error).message}`);
    process.exitCode = 1;
    return;
  }

  const { kept } = filterInternalAndTestSubscribers(raw);
  const engagementSubs = kept.map(toEngagementSubscriber);
  const filterRegex = args.filter ? new RegExp(args.filter, "i") : undefined;
  const result = observeChannelKeys(engagementSubs, window, filterRegex);

  if (args.json) {
    console.log(JSON.stringify({ snapshotDate, since: args.since, until: args.until, ...result }, null, 2));
  } else {
    console.log(`# Chaves observadas — snapshot ${snapshotDate}, janela ${args.since} a ${args.until ?? "(sem borda superior)"}\n`);
    console.log(formatTable(result));
  }
}

if (isMainModule(import.meta.url)) {
  main();
}
