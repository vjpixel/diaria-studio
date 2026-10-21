#!/usr/bin/env npx tsx
/**
 * sweep-continuo-orphan-sessions.ts (#10002)
 *
 * Encerra registros `data/sessions/continuo-{tag}-hermes-cron-{job}-*.json`
 * deixados por ticks do contínuo que falharam cedo e nunca chamaram `end`.
 * Achado ao vivo em 10/10/2026: 35 arquivos acumulados numa madrugada em que
 * todo tick morria no 1º passo (cota do provider esgotada, #10001) — o
 * wrapper `register-continuo-tick.sh` registra a sessão ANTES de invocar o
 * modelo (#8740), e quem encerra é o próprio tick, no fim. Tick que morre
 * não encerra.
 *
 * Quem chama: `hermes/scripts/register-continuo-tick.sh`, no início de cada
 * tick, antes de registrar a sessão nova — o tick seguinte limpa o anterior.
 *
 * Critério (todos obrigatórios — na dúvida, mantém):
 *   1. `kind === "continuo"` e `machineTag` da máquina local (nunca encerra
 *      registro de outra máquina);
 *   2. `sessionId` do MESMO job do cron (`hermes-cron-{job}-…`) e diferente
 *      da sessão atual (`--exclude`);
 *   3. `claimed_issues` E `claimed_foreign_issues` (#10618) vazios —
 *      encerrar nunca libera uma claim. Vale a
 *      UNIÃO do arquivo real com as cópias `-safeBackup-` do grupo (#10015,
 *      mesma semântica do registry, #6623): claim só no backup também mantém;
 *   4. heartbeat mais recente (`lastHeartbeat ?? startedAt`, também da união) mais velho que
 *      `ORPHAN_SWEEP_MIN_AGE_MS` (6h) — DE PROPÓSITO bem acima do
 *      `SOFT_STALE_MS` (90min) do registry (#10017). Um tick vivo só renova o
 *      heartbeat ao registrar e no renovador da delegação (~45min); review,
 *      CI e merge depois disso não renovam, e fora do Claude Code não há
 *      beacon — então "stale" (90min) NÃO é "morto" (#7227). Com o corte de
 *      90min, um tick novo do mesmo job podia varrer o anterior ainda vivo
 *      (num instante sem claims, ex. entre unclaim e merge) e o `heartbeat`/
 *      `end` dele viravam no-op silencioso. 6h = 3× a cadência de 120min do
 *      cron e 4× o `SOFT_STALE_MS`: o tick morto de verdade ainda é varrido,
 *      só alguns ticks depois — o custo de esperar é ruído, o de errar é
 *      matar um tick vivo. Timestamp ilegível ou no futuro → mantém.
 *      **Exceção (#10064):** com `--cron-output-dir`, a sessão de um run do
 *      cron que já terminou com `## Error` (tick morreu no provider antes do
 *      relatório) é encerrada sem esperar as 6h — ver `readDeadTickSessionIds`.
 *      Os critérios 1–3 continuam valendo.
 * Cópias de conflito (`-safeBackup-`) não são candidatas por si (o GC,
 * `session-registry.ts gc`, cuida delas) — só entram na decisão do arquivo
 * real a que pertencem; o encerramento usa `endSession`, que carimba
 * `endedAt` nelas.
 *
 * O encerramento registra `"swept-without-end"` (não `"ended"`) no log de
 * ciclo de vida (#10020): o tick nunca chamou `end`, e registrar como fim
 * limpo apagava do `session-lifecycle-report.ts` exatamente a falha que o
 * #6624 foi criado pra medir.
 *
 * Exit code 0 sempre que conseguiu rodar (fail-soft: o chamador é o wrapper
 * do cron, que não pode travar o tick por causa de limpeza de ruído).
 *
 * Uso:
 *   npx tsx scripts/sweep-continuo-orphan-sessions.ts --job 5d791ef6fc2c --exclude <session-id> [--dry-run]
 *
 * @see test/sweep-continuo-orphan-sessions.test.ts
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { isMainModule } from "./lib/cli-args.ts";
import {
  endSession,
  machineTag,
  readEffectiveSessionRecord,
  sessionsDir,
  type SessionRecord,
} from "./lib/session-registry.ts";

/** Idade mínima do heartbeat (união real+backups) para um tick ser varrido
 *  (#10017). Ver critério 4 no docblock do módulo — maior que `SOFT_STALE_MS`
 *  de propósito, nunca igual. */
export const ORPHAN_SWEEP_MIN_AGE_MS = 6 * 60 * 60 * 1000;

export interface SweepCandidate {
  sessionId: string;
  action: "end" | "keep";
  reason: string;
}

export interface SweepOptions {
  jobId: string;
  localTag: string;
  now: number;
  /** Sessão do tick corrente — nunca encerrada. */
  excludeSessionId?: string;
  /** #10064: sessões cujo run do cron JÁ TERMINOU com erro do provider
   *  (`## Error` no output do Hermes, ver `readDeadTickSessionIds`). Prova
   *  determinística de que o tick morreu — dispensa o corte de 6h do
   *  critério 4. Os critérios 1–3 (kind/máquina/job, exclude, sem claims)
   *  continuam valendo. */
  deadTickSessionIds?: ReadonlySet<string>;
}

/** Decisão PURA (sem I/O) sobre registros já lidos. Só olha registros do
 *  kind `continuo` do job pedido; o resto nem aparece no resultado. */
export function planContinuoOrphanSweep(
  records: readonly SessionRecord[],
  opts: SweepOptions,
): SweepCandidate[] {
  const prefix = `hermes-cron-${opts.jobId}-`;
  const out: SweepCandidate[] = [];
  for (const r of records) {
    if (r.kind !== "continuo" || typeof r.sessionId !== "string" || !r.sessionId.startsWith(prefix)) continue;
    const keep = (reason: string) => out.push({ sessionId: r.sessionId, action: "keep", reason });
    if (r.sessionId === opts.excludeSessionId) {
      keep("sessão do tick corrente");
      continue;
    }
    if (r.machineTag !== opts.localTag) {
      keep(`registro de outra máquina (${r.machineTag})`);
      continue;
    }
    // #10618: claim de OUTRO repo (`claimed_foreign_issues`, `owner/repo#N`)
    // é claim — encerrar a sessão a liberaria igual.
    const claims = [
      ...(Array.isArray(r.claimed_issues) ? r.claimed_issues.map((n) => `#${n}`) : []),
      ...(Array.isArray(r.claimed_foreign_issues) ? r.claimed_foreign_issues : []),
    ];
    if (claims.length > 0) {
      keep(`tem claimed_issues (${claims.join(", ")}) — encerrar liberaria claim`);
      continue;
    }
    if (opts.deadTickSessionIds?.has(r.sessionId)) {
      out.push({
        sessionId: r.sessionId,
        action: "end",
        reason: "run do cron terminou com erro do provider (## Error) antes do relatório, sem claimed_issues",
      });
      continue;
    }
    const hb = Date.parse(r.lastHeartbeat ?? r.startedAt ?? "");
    if (!Number.isFinite(hb)) {
      keep("timestamp ilegível");
      continue;
    }
    const ageMs = opts.now - hb;
    if (ageMs < 0) {
      keep("heartbeat no futuro (clock skew)");
      continue;
    }
    if (ageMs <= ORPHAN_SWEEP_MIN_AGE_MS) {
      keep(`heartbeat recente (${Math.round(ageMs / 60_000)}min ≤ ${ORPHAN_SWEEP_MIN_AGE_MS / 60_000}min)`);
      continue;
    }
    out.push({
      sessionId: r.sessionId,
      action: "end",
      reason: `tick sem end: heartbeat há ${Math.round(ageMs / 60_000)}min, sem claimed_issues`,
    });
  }
  return out;
}

/** Lê os registros do kind `continuo`, um por arquivo REAL (sem
 *  `-safeBackup-`), já unidos às cópias de conflito do grupo (#10015):
 *  `claimed_issues` e heartbeat vêm da união real+backups
 *  (`readEffectiveSessionRecord`, semântica #6623) — uma claim que só
 *  sobreviveu num backup ainda impede o encerramento, porque `endSession`
 *  carimba `endedAt` nos backups e a soltaria. A identidade
 *  (`kind`/`machineTag`/`sessionId`) é sempre a do arquivo real, que é o que
 *  `endSession` vai encerrar. Arquivo real ilegível é pulado — nunca
 *  encerrado sem ser entendido. */
export function readContinuoRecords(repoRoot: string): SessionRecord[] {
  const dir = sessionsDir(repoRoot);
  if (!existsSync(dir)) return [];
  const records: SessionRecord[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.startsWith("continuo-") || !name.endsWith(".json") || name.includes("-safeBackup-")) continue;
    const path = join(dir, name);
    let real: SessionRecord;
    try {
      real = JSON.parse(readFileSync(path, "utf8")) as SessionRecord;
    } catch {
      continue; // ilegível: fica com o GC, que também nunca remove o que não entende
    }
    if (!real || typeof real !== "object" || typeof real.sessionId !== "string") continue;
    const merged = readEffectiveSessionRecord(repoRoot, path) ?? real;
    records.push({ ...merged, kind: real.kind, machineTag: real.machineTag, sessionId: real.sessionId });
  }
  return records;
}

/** Seções `## X` do output do cron do Hermes (`~/.hermes/cron/output/{job}/*.md`). */
function hasCronSection(text: string, heading: string): boolean {
  return new RegExp(`^## ${heading}[ \\t]*$`, "m").test(text);
}

/** #10064: ids de sessão de ticks cujo run do cron morreu no provider.
 *
 *  O pre-run (`register-continuo-tick.sh`) imprime o SESSION_ID em stdout, e
 *  o Hermes grava esse stdout na seção `## Script Output` do output do run;
 *  quando o run morre no provider (cota, credencial), o mesmo arquivo ganha
 *  uma seção `## Error` no lugar de `## Response`. As duas juntas provam que
 *  aquela sessão é de um tick que já terminou sem chegar ao relatório nem ao
 *  `end` — o caso que o corte de 6h do critério 4 só pegava horas depois.
 *
 *  Hermes cron não tem hook pós-run (o job só tem `script`, que é pre-run):
 *  quem chama isto é o pre-run do tick SEGUINTE. Diretório ausente ou
 *  arquivo ilegível → conjunto vazio (fail-soft, nada é encerrado). */
export function readDeadTickSessionIds(cronOutputDir: string, jobId: string): Set<string> {
  const ids = new Set<string>();
  if (!existsSync(cronOutputDir)) return ids;
  const idRe = new RegExp(`hermes-cron-${jobId}-\\d{8}T\\d{6}Z`, "g");
  let names: string[];
  try {
    names = readdirSync(cronOutputDir);
  } catch {
    return ids;
  }
  for (const name of names) {
    if (!name.endsWith(".md")) continue;
    let text: string;
    try {
      text = readFileSync(join(cronOutputDir, name), "utf8");
    } catch {
      continue;
    }
    // Só o que vem DEPOIS de `## Script Output` — antes dele está o prompt
    // (a skill inteira), cujo texto não pode decidir nada aqui.
    const tail = text.split(/^## Script Output[ \t]*$/m)[1];
    if (tail === undefined) continue;
    if (!hasCronSection(tail, "Error") || hasCronSection(tail, "Response")) continue;
    const scriptOut = tail.split(/^## /m)[0] ?? "";
    for (const id of scriptOut.match(idRe) ?? []) ids.add(id);
  }
  return ids;
}

export function sweepContinuoOrphanSessions(
  repoRoot: string,
  opts: Omit<SweepOptions, "localTag" | "now"> & { localTag?: string; now?: number; dryRun?: boolean },
): { ended: string[]; plan: SweepCandidate[]; errors: string[] } {
  const localTag = opts.localTag ?? machineTag();
  const plan = planContinuoOrphanSweep(readContinuoRecords(repoRoot), {
    jobId: opts.jobId,
    excludeSessionId: opts.excludeSessionId,
    deadTickSessionIds: opts.deadTickSessionIds,
    localTag,
    now: opts.now ?? Date.now(),
  });
  const ended: string[] = [];
  const errors: string[] = [];
  if (opts.dryRun) return { ended, plan, errors };
  for (const c of plan) {
    if (c.action !== "end") continue;
    try {
      if (endSession(repoRoot, "continuo", c.sessionId, localTag, undefined, { lifecycleEvent: "swept-without-end" })) {
        ended.push(c.sessionId);
      }
    } catch (e) {
      errors.push(`${c.sessionId}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { ended, plan, errors };
}

if (isMainModule(import.meta.url)) {
  const argv = process.argv.slice(2);
  const arg = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const jobId = arg("--job");
  if (!jobId) {
    console.error("sweep-continuo-orphan-sessions: --job é obrigatório");
    process.exitCode = 1;
  } else {
    const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    const cronOutputDir = arg("--cron-output-dir");
    const r = sweepContinuoOrphanSessions(repoRoot, {
      jobId,
      excludeSessionId: arg("--exclude"),
      deadTickSessionIds: cronOutputDir ? readDeadTickSessionIds(cronOutputDir, jobId) : undefined,
      dryRun: argv.includes("--dry-run"),
    });
    const toEnd = r.plan.filter((c) => c.action === "end").length;
    console.log(
      `sweep-continuo-orphan-sessions: ${r.ended.length} encerrada(s) de ${toEnd} candidata(s)` +
        (argv.includes("--dry-run") ? " (dry-run)" : "") +
        (r.errors.length ? `; ${r.errors.length} erro(s): ${r.errors.join("; ")}` : ""),
    );
  }
}
