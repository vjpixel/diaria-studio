#!/usr/bin/env npx tsx
/**
 * scripts/sync-beehiiv-subscribers-kit.ts (#6091 — migração Beehiiv → Kit, #461)
 *
 * Sync recorrente de assinantes ativos da Beehiiv pro Kit — pré-requisito
 * de QUALQUER switchover real (#464/#6048/#466). O #6047 fez uma importação
 * PONTUAL (585 assinantes, 24/08/2026); confirmado ao vivo em 25/08/2026
 * que o Kit continua com exatamente esses 585, todos `created_at:
 * 2026-08-24` — nenhum assinante novo da Beehiiv chegou ao Kit desde então,
 * porque não existia nenhum mecanismo recorrente. Este script é esse
 * mecanismo.
 *
 * ## Design: ADITIVO, nunca remove
 *
 * Só cria/atualiza no Kit quem está `active` na Beehiiv e ainda não está
 * `active` no Kit (ausente, ou presente com outro `state`). NUNCA
 * desativa/remove ninguém do Kit — mesmo que tenha cancelado na Beehiiv.
 * Diferente do `sync-apoio-nivel-beehiiv.ts` (que precisa remover tags de
 * quem perdeu o nível), aqui a lista mais "atrasada em incluir" é
 * inofensiva (só significa que aquele e-mail não recebeu de novo alguém
 * que já estava lá); a lista mais "atrasada em remover" já é aceita como
 * escopo futuro (não perseguido aqui — decisão de manter o escopo mínimo
 * o bastante pra destravar os switchovers reais).
 *
 * ## Guard: lista do Kit suspeita-vazia
 *
 * Se `listAllKitSubscribers` devolver poucos (<50% do que o Kit já tinha
 * na última vez que este script rodou — persistido em
 * `data/kit-subscriber-sync-state.json`) — provável falha de auth/paginação
 * silenciosa, não "todo mundo cancelou". `--push` recusa nesse cenário
 * (mesmo espírito do guard de blast radius do `sync-apoio-nivel-beehiiv.ts`,
 * adaptado pro risco AQUI, que é "recriar tudo por engano" nunca acontece
 * — a operação é idempotente — mas "achar que falta muito mais gente do
 * que falta de verdade" indicaria a MESMA classe de falha silenciosa).
 *
 * Uso:
 *   npx tsx scripts/sync-beehiiv-subscribers-kit.ts               # dry-run (default)
 *   npx tsx scripts/sync-beehiiv-subscribers-kit.ts --push         # aplica de verdade
 *
 * Exit codes: 1 erro fatal (config ausente, API falhou, guard de lista
 * suspeita-vazia sem --force-empty-guard).
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { hasFlag, isMainModule } from "./lib/cli-args.ts";
import { loadBeehiivConfig, beehiivApiBase } from "./lib/beehiiv-config.ts";
import { hasMorePages, resolveTotalPages } from "./backup-beehiiv.ts";
import { listAllKitSubscribers, createOrUpdateSubscriber } from "./lib/kit-subscribers.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const RATE_LIMIT_DELAY_MS = 350; // #6047: rate limit do Kit bate em ~240 chamadas sem espaçamento
const PER_PAGE = 100;
const STATE_PATH = resolve(ROOT, "data", "kit-subscriber-sync-state.json");
/** Guard: se o Kit devolver menos que este % do que tinha na última rodada
 *  registrada, algo está errado (auth/paginação) — não "todo mundo cancelou". */
const EMPTY_GUARD_RATIO = 0.5;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

interface BeehiivSubscriptionRaw {
  email: string;
  status: string;
}

interface BeehiivPage {
  data?: BeehiivSubscriptionRaw[];
  total_pages?: number;
  total_results?: number;
  limit?: number;
  page?: number;
}

/** Pagina `GET /subscriptions?status=active` — mesmo achado/mitigação do
 *  #1897 já aplicado em `backup-beehiiv.ts` (`per_page` é ignorado nesse
 *  endpoint, `total_pages` infla; drena por `total_results` via
 *  `hasMorePages`, reusado daqui). */
async function fetchActiveBeehiivEmails(apiKey: string, publicationId: string): Promise<string[]> {
  const emails: string[] = [];
  let page = 1;
  let more = true;
  let totalResults: number | null = null;
  while (more) {
    await sleep(RATE_LIMIT_DELAY_MS);
    const res = await fetch(
      `${beehiivApiBase()}/publications/${publicationId}/subscriptions?status=active&limit=${PER_PAGE}&page=${page}`,
      { headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" } },
    );
    if (!res.ok) {
      throw new Error(`Beehiiv API ${res.status} em subscriptions (página ${page}): ${await res.text()}`);
    }
    const body = (await res.json()) as BeehiivPage;
    const got = body.data ?? [];
    emails.push(...got.map((s) => s.email));
    if (body.total_results != null) totalResults = body.total_results;
    more = hasMorePages({
      collected: emails.length,
      gotLength: got.length,
      totalResults: body.total_results,
      effectiveLimit: body.limit,
      requestedPerPage: PER_PAGE,
    });
    page++;
  }
  if (totalResults != null && totalResults > 0 && emails.length < totalResults) {
    throw new Error(`subscriptions truncado: ${emails.length}/${totalResults} (loop encerrou antes de drenar total_results)`);
  }
  return emails;
}

export interface SyncState {
  last_run_at: string;
  kit_subscriber_count: number;
}

export function readSyncState(): SyncState | null {
  if (!existsSync(STATE_PATH)) return null;
  return JSON.parse(readFileSync(STATE_PATH, "utf8"));
}

export function writeSyncState(state: SyncState): void {
  mkdirSync(dirname(STATE_PATH), { recursive: true });
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + "\n");
}

export type EmptyGuardResult = { ok: true } | { ok: false; reason: string };

/** Pura — recusa a rodada se a lista do Kit encolheu demais desde a última
 *  vez (ver docstring do módulo). Sem histórico prévio (1ª rodada), sempre
 *  passa — não há baseline pra comparar. */
export function evaluateEmptyGuard(currentCount: number, previousState: SyncState | null): EmptyGuardResult {
  if (!previousState || previousState.kit_subscriber_count === 0) return { ok: true };
  const ratio = currentCount / previousState.kit_subscriber_count;
  if (ratio < EMPTY_GUARD_RATIO) {
    return {
      ok: false,
      reason: `Kit devolveu ${currentCount} assinantes, só ${(ratio * 100).toFixed(0)}% dos ${previousState.kit_subscriber_count} da última rodada (${previousState.last_run_at}) — provável falha de auth/paginação, não "todo mundo cancelou". Recusando --push.`,
    };
  }
  return { ok: true };
}

/** Pura — diff por e-mail (lowercase, trim): quem está ativo na Beehiiv e
 *  ainda não está `active` no Kit. */
export function computeMissingEmails(beehiivActiveEmails: string[], kitEmailsByState: Map<string, string>): string[] {
  const missing: string[] = [];
  for (const raw of beehiivActiveEmails) {
    const email = raw.trim().toLowerCase();
    const kitState = kitEmailsByState.get(email);
    if (kitState !== "active") missing.push(raw);
  }
  return missing;
}

export async function main(rootDirOverride?: string): Promise<void> {
  const rootDir = rootDirOverride ?? ROOT;
  loadProjectEnv(rootDir);
  const argv = process.argv.slice(2);
  const push = hasFlag(argv, "push");
  const forceEmptyGuard = hasFlag(argv, "force-empty-guard");
  const log = (msg: string) => process.stderr.write(`[sync-beehiiv-subscribers-kit] ${msg}\n`);

  const beehiivCfg = loadBeehiivConfig("[sync-beehiiv-subscribers-kit]");
  const kitApiKey = process.env.KIT_API_KEY;
  if (!kitApiKey) {
    log("ERRO: KIT_API_KEY ausente (.env).");
    process.exitCode = 1;
    return;
  }
  const kitConfig = { apiKey: kitApiKey };

  log("buscando assinantes ativos da Beehiiv...");
  const beehiivActiveEmails = await fetchActiveBeehiivEmails(beehiivCfg.apiKey, beehiivCfg.publicationId);
  log(`${beehiivActiveEmails.length} assinante(s) ativo(s) na Beehiiv.`);

  log("buscando assinantes do Kit...");
  const kitSubscribers = await listAllKitSubscribers(kitConfig);
  log(`${kitSubscribers.length} assinante(s) no Kit.`);

  const previousState = readSyncState();
  const guard = evaluateEmptyGuard(kitSubscribers.length, previousState);
  if (!guard.ok && !forceEmptyGuard) {
    log(`ERRO: ${guard.reason}`);
    process.exitCode = 1;
    return;
  }
  if (!guard.ok && forceEmptyGuard) {
    log(`AVISO (--force-empty-guard): ${guard.reason} — prosseguindo mesmo assim.`);
  }

  const kitEmailsByState = new Map(kitSubscribers.map((s) => [s.email_address.trim().toLowerCase(), s.state]));
  const missing = computeMissingEmails(beehiivActiveEmails, kitEmailsByState);
  log(`${missing.length} assinante(s) da Beehiiv ausente(s)/não-ativo(s) no Kit.`);

  if (!push) {
    log(`[dry-run] nenhuma escrita feita. Amostra (até 10): ${missing.slice(0, 10).join(", ")}`);
    return;
  }

  let created = 0;
  let failed = 0;
  for (const email of missing) {
    try {
      await createOrUpdateSubscriber({ email_address: email, state: "active" }, kitConfig);
      created++;
    } catch (e) {
      failed++;
      log(`falha ao sincronizar ${email}: ${e instanceof Error ? e.message : String(e)}`);
    }
    await sleep(RATE_LIMIT_DELAY_MS);
  }
  log(`sync concluído: ${created} sincronizado(s), ${failed} falha(s).`);

  writeSyncState({ last_run_at: new Date().toISOString(), kit_subscriber_count: kitSubscribers.length + created });

  if (failed > 0) process.exitCode = 1;
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    process.stderr.write(`[sync-beehiiv-subscribers-kit] erro fatal: ${e instanceof Error ? e.stack ?? e.message : String(e)}\n`);
    process.exitCode = 1;
  });
}
