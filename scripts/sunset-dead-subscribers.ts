#!/usr/bin/env node
/**
 * sunset-dead-subscribers.ts (#5807)
 *
 * Identifica assinantes ATIVOS maduros que nunca se engajam de verdade — abrem
 * ≤10% E nunca clicaram em nada — e os move do envio diário Beehiiv pro funil
 * de reativação Brevo (`brevo_diaria`), mesma trilha já usada pelo segmento
 * Pending (`sync-pending-to-brevo.ts`).
 *
 * ## O guard que a issue exige (#5807, análise 260820, snapshot 2026-08-16)
 *
 * Critério NUNCA pode ser só abertura baixa: dos ativos maduros com abertura
 * ≤10%, uma fração real (101 na medição de origem) TEM cliques — leitores
 * genuínos com pixel de abertura bloqueado (Apple MPP e afins). Só quem tem
 * abertura ≤10% **E** zero cliques na vida inteira é sunset. Mesma filosofia
 * de `scripts/lib/leitor.ts` (nunca decidir por abertura sozinha, CTR/clique
 * real é o sinal que não mente) — aqui invertida: em vez de "quem lê", a
 * pergunta é "quem provadamente NUNCA leu".
 *
 * `receivedMin` desta issue é 20 (mais conservador que os 10 usados na
 * análise original que motivou a issue — decisão explícita da spec, não um
 * relaxamento acidental do piso de `leitor-v1`, que também usa 20).
 *
 * ## Dry-run por padrão, `--push` real NUNCA rodado por sessão autônoma
 *
 * Mesmo guard de publicação do overnight/develop (`context/overnight-dispatch-rules.md`
 * item 1) — `--push` existe no código (a issue pede) mas nenhuma sessão
 * autônoma o invoca contra a Beehiiv/Brevo real; só testado com fetch mockado.
 *
 * ## Push: unsubscribe Beehiiv + funil de reativação Brevo
 *
 * `--push` faz, por selecionado: (a) `PUT .../subscriptions/by_email/{email}`
 * com `{unsubscribe:true}` na Beehiiv — único campo documentado como
 * gravável nesse endpoint (mesma disciplina de `cleanup-preflight-subscribers.ts`/
 * `evaluate-brevo-diaria.ts`: nunca DELETE, preserva histórico); (b) upsert no
 * store `data/brevo-diaria/contacts.json` via `upsertIngested` — MESMO store
 * e ciclo de vida que `sync-pending-to-brevo.ts` já usa (`in_brevo` →
 * avaliação periódica por `evaluate-brevo-diaria.ts`, cap de fila
 * `brevo_diaria.daily_send_cap` respeitado por essa maquinaria existente, não
 * reimplementado aqui). Cada sunset é registrado em
 * `data/brevo-diaria/sunset-log.jsonl` (append-only, auditoria/reversão
 * manual) — `origem: "sunset"` no registro distingue do fluxo normal Pending.
 *
 * ## Guard de blast radius (mesmo padrão de #4436 — sync-apoio-nivel-beehiiv.ts)
 *
 * Recusa `--push` inteiro se a seleção passar de `BLAST_RADIUS_THRESHOLD`
 * (20%, decisão desta issue — spec pede "~20% dos ativos") dos assinantes
 * ativos maduros (`receivedMin` atingido) do snapshot. `--force-blast-radius`
 * é o escape hatch explícito, mesma convenção.
 *
 * ## MillionVerifier — fora de escopo aqui
 *
 * Diferente de `sync-pending-to-brevo.ts` (que ingere e-mails NUNCA
 * confirmados na Beehiiv, risco de bounce real), os selecionados por este
 * script já são assinantes `status=active` confirmados há muito tempo
 * (`receivedMin >= 20` edições recebidas) — não há necessidade de
 * verificação MV antes de reingerir no canal Brevo.
 *
 * ## Uso
 *
 *   npx tsx scripts/sunset-dead-subscribers.ts                          # dry-run (default)
 *   npx tsx scripts/sunset-dead-subscribers.ts --snapshot 2026-08-16    # snapshot específico
 *   npx tsx scripts/sunset-dead-subscribers.ts --push                   # aplica (unsubscribe Beehiiv + funil Brevo)
 *   npx tsx scripts/sunset-dead-subscribers.ts --push --force-blast-radius
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getStringArg, hasFlag, isMainModule } from "./lib/cli-args.ts";
import { loadBeehiivConfig, beehiivApiBase } from "./lib/beehiiv-config.ts";
import {
  isSubscribersSnapshotUsable,
  latestSnapshotDate,
  readSnapshotSubscribers,
  type BeehiivBackupSubscriber,
} from "./lib/beehiiv-backup-snapshots.ts";
import { DEFAULT_BACKUP_ROOT } from "./lib/leitor.ts";
import {
  readStore,
  writeStore,
  upsertIngested,
  normalizeEmail,
  DEFAULT_STORE_PATH,
  type BrevoDiariaStore,
} from "./lib/brevo-diaria-store.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const DEFAULT_SUNSET_LOG_PATH = resolve(ROOT, "data/brevo-diaria/sunset-log.jsonl");

// ---------------------------------------------------------------------------
// Limiares (spec #5807)
// ---------------------------------------------------------------------------

export interface SunsetThresholds {
  /** Mínimo de edições recebidas pra elegibilidade — 20, mais conservador
   *  que os 10 usados na análise original (#5807). */
  receivedMin: number;
  /** Abertura pessoal (open rate) máxima em fração 0-1 (0.10 = 10%). */
  openRateMaxPct: number;
}

export const SUNSET_THRESHOLDS: SunsetThresholds = {
  receivedMin: 20,
  openRateMaxPct: 10,
};

/** Limiar do guard de blast radius (20% — spec da issue #5807, "~20% dos
 *  ativos"). Mesmo mecanismo de `sync-apoio-nivel-beehiiv.ts` (#4436, lá 30%). */
export const BLAST_RADIUS_THRESHOLD = 0.2;

// ---------------------------------------------------------------------------
// Predicado puro de seleção
// ---------------------------------------------------------------------------

export interface SunsetInput {
  email: string;
  status: string;
  totalReceived: number;
  totalUniqueOpened: number;
  totalUniqueClicked: number;
}

/** Open rate real (aberturas únicas ÷ recebidas), em pontos percentuais
 *  (0-100). Mesma disciplina de `computeCtrPct` (`leitor.ts`): denominador
 *  ≤0 ou entradas inválidas retornam 0, nunca NaN/Infinity. */
export function computeOpenRatePct(totalUniqueOpened: number, totalReceived: number): number {
  if (!Number.isFinite(totalReceived) || totalReceived <= 0) return 0;
  if (!Number.isFinite(totalUniqueOpened) || totalUniqueOpened < 0) return 0;
  return (totalUniqueOpened / totalReceived) * 100;
}

/**
 * Predicado puro: `status=active` AND `totalReceived >= receivedMin` AND
 * `openRatePct <= openRateMaxPct` AND `totalUniqueClicked === 0`.
 *
 * O guard crítico da issue vive na ÚLTIMA condição: `totalUniqueClicked ===
 * 0`, não `<= algum limiar` — QUALQUER clique na vida inteira, mesmo um só,
 * exclui o assinante do sunset (é o mesmo assinante que os "101 com pixel
 * bloqueado" da análise original representam — abertura baixa sozinha nunca
 * decide, exatamente como `isLeitorV1` nunca decide só por CTR sem o piso de
 * recebidas, e o inverso do motivo de `leitor-v1` nunca usar `click_rate`:
 * aqui é abertura que pode mentir por MPP, clique nunca mente).
 */
export function isDeadSubscriber(
  input: SunsetInput,
  thresholds: SunsetThresholds = SUNSET_THRESHOLDS,
): boolean {
  if (input.status !== "active") return false;
  if (input.totalReceived < thresholds.receivedMin) return false;
  if (input.totalUniqueClicked !== 0) return false;
  return computeOpenRatePct(input.totalUniqueOpened, input.totalReceived) <= thresholds.openRateMaxPct;
}

/** Narrow do subscriber bruto do snapshot pra `SunsetInput` — mesmo padrão
 *  de `leitorInputFromBeehiivSubscriber`. */
export function sunsetInputFromBeehiivSubscriber(sub: BeehiivBackupSubscriber): SunsetInput {
  return {
    email: sub.email,
    status: sub.status,
    totalReceived: sub.stats?.total_received ?? 0,
    totalUniqueOpened: sub.stats?.total_unique_opened ?? 0,
    totalUniqueClicked: sub.stats?.total_unique_clicked ?? 0,
  };
}

// ---------------------------------------------------------------------------
// Seleção sobre a lista completa + open rate projetado
// ---------------------------------------------------------------------------

export interface SunsetSelectionResult {
  snapshot_date: string;
  thresholds: SunsetThresholds;
  total_subscribers: number;
  /** Ativos maduros (`status=active` AND `totalReceived >= receivedMin`) —
   *  denominador do guard de blast radius. */
  mature_active_count: number;
  selected: SunsetInput[];
  /** Open rate médio ATUAL entre ativos maduros (fração 0-1). */
  open_rate_before: number;
  /** Open rate médio PROJETADO removendo os selecionados do denominador
   *  (fração 0-1) — soma das aberturas dos que ficam ÷ soma das recebidas
   *  dos que ficam. */
  open_rate_projected: number;
}

/** Pura — seleciona os candidatos a sunset e projeta o open rate resultante.
 *  Testável sem tocar disco (recebe a lista já carregada). */
export function selectDeadSubscribers(
  subscribers: readonly BeehiivBackupSubscriber[],
  thresholds: SunsetThresholds,
  snapshotDate: string,
): SunsetSelectionResult {
  const mature = subscribers
    .map(sunsetInputFromBeehiivSubscriber)
    .filter((s) => s.status === "active" && s.totalReceived >= thresholds.receivedMin);

  const selected = mature.filter((s) => isDeadSubscriber(s, thresholds));
  const selectedEmails = new Set(selected.map((s) => s.email));
  const remaining = mature.filter((s) => !selectedEmails.has(s.email));

  const sumOpened = (list: SunsetInput[]) => list.reduce((acc, s) => acc + s.totalUniqueOpened, 0);
  const sumReceived = (list: SunsetInput[]) => list.reduce((acc, s) => acc + s.totalReceived, 0);

  const receivedBefore = sumReceived(mature);
  const openRateBefore = receivedBefore > 0 ? sumOpened(mature) / receivedBefore : 0;

  const receivedAfter = sumReceived(remaining);
  const openRateProjected = receivedAfter > 0 ? sumOpened(remaining) / receivedAfter : openRateBefore;

  return {
    snapshot_date: snapshotDate,
    thresholds,
    total_subscribers: subscribers.length,
    mature_active_count: mature.length,
    selected,
    open_rate_before: openRateBefore,
    open_rate_projected: openRateProjected,
  };
}

// ---------------------------------------------------------------------------
// Guard de blast radius (#5807, mesmo mecanismo de #4436)
// ---------------------------------------------------------------------------

export interface BlastRadiusGuardResult {
  blocked: boolean;
  selectedCount: number;
  matureActiveCount: number;
  ratio: number;
}

/** Pura — recusa o `--push` inteiro quando a seleção excede
 *  `BLAST_RADIUS_THRESHOLD` dos ativos maduros. "Passar de" é estrito —
 *  exatamente no limiar não bloqueia. `force` é o escape hatch explícito. */
export function evaluateBlastRadiusGuard(
  selectedCount: number,
  matureActiveCount: number,
  force: boolean,
  threshold: number = BLAST_RADIUS_THRESHOLD,
): BlastRadiusGuardResult {
  const ratio = matureActiveCount > 0 ? selectedCount / matureActiveCount : 0;
  const blocked = !force && ratio > threshold;
  return { blocked, selectedCount, matureActiveCount, ratio };
}

// ---------------------------------------------------------------------------
// Aplicação (I/O) — unsubscribe Beehiiv + funil de reativação Brevo
// ---------------------------------------------------------------------------

/** `PUT .../subscriptions/by_email/{email}` com `{unsubscribe:true}` — mesmo
 *  endpoint/disciplina de `cleanup-preflight-subscribers.ts::unsubscribe`
 *  (nunca DELETE, preserva histórico do registro). Reimplementado aqui (não
 *  importado) pelo mesmo motivo documentado lá: este script é
 *  Beehiiv+Brevo, não deveria puxar um módulo pensado só pra limpeza de
 *  teste de preflight. */
export async function unsubscribeFromBeehiiv(
  publicationId: string,
  apiKey: string,
  email: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const res = await fetchImpl(
    `${beehiivApiBase()}/publications/${publicationId}/subscriptions/by_email/${encodeURIComponent(email)}`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ unsubscribe: true }),
    },
  );
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `Beehiiv API PUT subscriptions/by_email/${email} (unsubscribe:true) falhou (HTTP ${res.status}): ${text}`,
    );
  }
}

export interface SunsetLogEntry {
  email: string;
  sunset_at: string;
  snapshot_date: string;
  total_received: number;
  total_unique_opened: number;
  total_unique_clicked: number;
  open_rate_pct: number;
  origem: "sunset";
}

/** I/O — grava 1 linha jsonl append-only em `path` (cria o diretório pai se
 *  necessário) — auditoria/reversão manual (#5807 item 6 da spec). */
export function appendSunsetLog(entry: SunsetLogEntry, path: string = DEFAULT_SUNSET_LOG_PATH): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, JSON.stringify(entry) + "\n", "utf8");
}

export interface PushOneResult {
  email: string;
  ok: boolean;
  error?: string;
}

/**
 * I/O — aplica sunset a 1 candidato: unsubscribe na Beehiiv, upsert no store
 * Brevo (`in_brevo`, mesmo ciclo de vida de `sync-pending-to-brevo.ts` —
 * `evaluate-brevo-diaria.ts` cuida da avaliação/promoção/supressão
 * subsequente, não reimplementado aqui), e log de auditoria. `beehiiv_subscription_id`
 * do registro do store fica `"sunset:{email}"` — este fluxo não tem (nem
 * precisa) o id de subscription Beehiiv que `sync-pending-to-brevo.ts` carrega
 * da paginação Pending; o campo é só chave de correlação, nunca usado como
 * subscription id real em nenhum caminho de código existente.
 */
export async function applySunsetOne(
  input: SunsetInput,
  snapshotDate: string,
  publicationId: string,
  beehiivApiKey: string,
  store: BrevoDiariaStore,
  fetchImpl: typeof fetch,
  logPath: string,
  now: string = new Date().toISOString(),
): Promise<{ result: PushOneResult; nextStore: BrevoDiariaStore }> {
  try {
    await unsubscribeFromBeehiiv(publicationId, beehiivApiKey, input.email, fetchImpl);
    const nextStore = upsertIngested(
      store,
      { email: input.email, beehiiv_subscription_id: `sunset:${normalizeEmail(input.email)}` },
      now,
    );
    appendSunsetLog(
      {
        email: normalizeEmail(input.email),
        sunset_at: now,
        snapshot_date: snapshotDate,
        total_received: input.totalReceived,
        total_unique_opened: input.totalUniqueOpened,
        total_unique_clicked: input.totalUniqueClicked,
        open_rate_pct: computeOpenRatePct(input.totalUniqueOpened, input.totalReceived),
        origem: "sunset",
      },
      logPath,
    );
    return { result: { email: input.email, ok: true }, nextStore };
  } catch (e) {
    return { result: { email: input.email, ok: false, error: (e as Error).message }, nextStore: store };
  }
}

// ---------------------------------------------------------------------------
// Formatação (dry-run)
// ---------------------------------------------------------------------------

export function formatDryRunReport(selection: SunsetSelectionResult): string {
  const lines: string[] = [];
  lines.push(
    `[sunset-dead-subscribers] snapshot ${selection.snapshot_date} — ${selection.total_subscribers} assinante(s) no backup, ` +
      `${selection.mature_active_count} ativo(s) maduro(s) (>= ${selection.thresholds.receivedMin} recebidas).`,
  );
  lines.push(
    `[sunset-dead-subscribers] ${selection.selected.length} candidato(s) a sunset ` +
      `(abertura <= ${selection.thresholds.openRateMaxPct}% E zero cliques na vida inteira).`,
  );
  lines.push(
    `[sunset-dead-subscribers] open rate: ${(selection.open_rate_before * 100).toFixed(1)}% (atual) → ` +
      `${(selection.open_rate_projected * 100).toFixed(1)}% (projetado sem os candidatos).`,
  );
  for (const s of selection.selected) {
    lines.push(
      `  - ${s.email} (recebidas=${s.totalReceived}, abertura=${computeOpenRatePct(s.totalUniqueOpened, s.totalReceived).toFixed(1)}%, cliques=${s.totalUniqueClicked})`,
    );
  }
  lines.push("");
  lines.push("(dry-run — nenhuma escrita feita; rode com --push pra executar)");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const log = (msg: string) => process.stderr.write(`[sunset-dead-subscribers] ${msg}\n`);
  const push = hasFlag(argv, "push");
  const force = hasFlag(argv, "force-blast-radius");
  const backupRoot = getStringArg(argv, "root") ?? DEFAULT_BACKUP_ROOT;
  const snapshotArg = getStringArg(argv, "snapshot");

  const date = snapshotArg ?? latestSnapshotDate(backupRoot);
  if (!date) {
    log(`nenhum snapshot encontrado em ${backupRoot}`);
    process.exitCode = 1;
    return;
  }

  const usability = isSubscribersSnapshotUsable(backupRoot, date);
  if (!usability.usable) {
    log(`snapshot ${date} inutilizável: ${usability.reason}`);
    process.exitCode = 1;
    return;
  }

  const subscribers = readSnapshotSubscribers(backupRoot, date);
  const selection = selectDeadSubscribers(subscribers, SUNSET_THRESHOLDS, date);

  process.stdout.write(formatDryRunReport(selection) + "\n");

  if (!push) return;

  const guard = evaluateBlastRadiusGuard(selection.selected.length, selection.mature_active_count, force);
  if (guard.blocked) {
    log(
      `RECUSANDO o --push inteiro (guard de blast radius): ${guard.selectedCount} sunset(s) de ` +
        `${guard.matureActiveCount} ativo(s) maduro(s) (${(guard.ratio * 100).toFixed(1)}%, limiar ` +
        `${(BLAST_RADIUS_THRESHOLD * 100).toFixed(0)}%) — nenhuma mutação foi aplicada. Investigue antes de usar ` +
        "--force-blast-radius (decisão consciente do editor, sempre logada).",
    );
    process.exitCode = 2;
    return;
  }

  const { apiKey: beehiivApiKey, publicationId } = loadBeehiivConfig("[sunset-dead-subscribers]");

  let store = readStore(DEFAULT_STORE_PATH);
  let applied = 0;
  let failed = 0;
  for (const s of selection.selected) {
    const { result, nextStore } = await applySunsetOne(
      s,
      date,
      publicationId,
      beehiivApiKey,
      store,
      fetch,
      DEFAULT_SUNSET_LOG_PATH,
    );
    store = nextStore;
    if (result.ok) {
      applied++;
      log(`  ${result.email} — unsubscribed na Beehiiv + ingerido no funil Brevo.`);
    } else {
      failed++;
      log(`  FALHA em ${result.email}: ${result.error}`);
    }
  }
  writeStore(store, DEFAULT_STORE_PATH);
  log(`push concluído: ${applied} sunset(s) aplicado(s), ${failed} falha(s).`);
  if (failed > 0) process.exitCode = 1;
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    process.stderr.write(`[sunset-dead-subscribers] erro fatal: ${(e as Error).message}\n`);
    process.exitCode = 1;
  });
}
