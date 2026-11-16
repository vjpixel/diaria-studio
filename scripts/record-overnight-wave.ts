#!/usr/bin/env npx tsx
/**
 * record-overnight-wave.ts (#8486)
 *
 * Grava a onda recém-composta do `/diaria-overnight` em `plan.waves[]` —
 * ver `scripts/lib/overnight-waves.ts`. Chamado no passo 2 da Fase 1, no
 * mesmo ponto do `heartbeat --active-worktrees`.
 *
 * `--units "8290,8291;8300"` — unidades despachadas (`;` separa unidades,
 * `,` separa issues do lote). `--deferred N` — unidades prontas seguradas
 * pelo teto (default 0; valor não-numérico ou flag sem valor = exit 2, nunca
 * `cap_hit` falso-negativo silencioso). `--open-pr-slots N` — vagas do teto
 * global de PRs abertos (`scripts/check-open-pr-cap.ts`, #12765): onda com
 * mais unidades que N é recusada (exit 1), já que cada unidade vira uma PR.
 * Desde o #12873 o script mede o teto sozinho (`readOpenPrCap`, a mesma
 * função do `check-open-pr-cap.ts`) quando `--open-pr-slots` vem: medição
 * verificada prevalece sobre o informado (divergência = aviso em stderr);
 * `gh` indisponível = vale o informado, com aviso. Sem a flag, nada é medido.
 *
 * Exit: 0 = gravado (ou onda duplicada detectada — no-op idempotente, #8496
 * item 3: mesmo conjunto de issues já registrado em `plan.waves` dentro de
 * `OVERNIGHT_WAVE_DEDUP_WINDOW_MS` — ver `scripts/lib/overnight-waves.ts`);
 * 1 = onda inválida (acima do teto, issue repetida, unidade malformada);
 * 2 = uso inválido / plan.json ausente ou ilegível.
 * Escrita atômica (`writeFileAtomic`) — `plan.json` é a única fonte confiável
 * do briefing após compaction, nunca pode ficar truncado.
 */
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { parseArgs, isMainModule } from "./lib/cli-args.ts";
import { logEvent } from "./lib/run-log.ts";
import { currentSessionId } from "./lib/session-transcript.ts";
import { COORDINATOR_ESTIMATE_MESSAGE, estimateCoordinatorUsage, estimateToDetails } from "./coordinator-usage-estimate.ts";
import { writeFileAtomic } from "./lib/atomic-write.ts";
import { recoverPlanFromSafeBackupWithWarning } from "./lib/plan-safe-backup.ts";
import {
  appendWave,
  buildWaveRecord,
  checkOvernightWaves,
  findDuplicateWave,
  type WaveIssueId,
} from "./lib/overnight-waves.ts";
import { formatIssueRef, legacyIssueNumber, parseIssueRef } from "./lib/issue-repos.ts";
import { recordUnitTimeline } from "./lib/overnight-unit-timeline.ts";
import { resolveWaveOpenPrSlots, waveOpenPrCapError } from "./lib/open-pr-cap.ts";
import { readOpenPrCap } from "./check-open-pr-cap.ts";

const INT = /^\d+$/;

/**
 * Pure: `"8290,8291;8300"` → `[[8290,8291],[8300]]`. Desde a fatia 4 da
 * #10618 aceita também `owner/repo#N` (issue de outro repo, gravada como a
 * string canônica); `vjpixel/diaria-studio#N` vira o número de sempre. Lança
 * em token que não é inteiro decimal nem `owner/repo#N`.
 */
export function parseUnits(raw: string): WaveIssueId[][] {
  return raw.split(";").map((unit) =>
    unit.split(",").map((tok) => {
      const t = tok.trim();
      if (INT.test(t)) return Number(t);
      const ref = t.includes("/") ? parseIssueRef(t) : null;
      if (!ref) throw new Error(`--units: token inválido "${t}" (esperado inteiro decimal ou owner/repo#N)`);
      return legacyIssueNumber(ref) ?? formatIssueRef(ref);
    }),
  );
}

/** Onde gravar o checkpoint de token da onda (#13260), ou por que não gravar. */
export type WaveCheckpointTarget =
  | { ok: true; rootDir: string; edition: string; phase: string; sessionId: string | null }
  | { ok: false; reason: string };

/**
 * Pure (#13260): destino do checkpoint de token que a gravação da onda emite
 * como efeito colateral. Só vale para o plano da rodada real,
 * `{raiz}/data/overnight/{rodada}/plan.json`: a edição é o nome da pasta da
 * rodada (mesma convenção do `--run-dir` de
 * `check-overnight-token-instrumentation.ts`) e o run-log é o da raiz. Plano
 * fora desse caminho (teste, cópia em /tmp) não grava nada: um evento falso
 * no run-log de produção corromperia a base do delta seguinte. Sessão: a do
 * ambiente (a que roda o comando, dona do transcript), senão a do `plan.json`.
 */
export function waveCheckpointTarget(
  planPath: string,
  plan: Record<string, unknown>,
  waveNumber: number,
  env: NodeJS.ProcessEnv = process.env,
): WaveCheckpointTarget {
  const runDir = dirname(resolve(planPath));
  const overnightDir = dirname(runDir);
  const dataDir = dirname(overnightDir);
  if (basename(planPath) !== "plan.json" || basename(overnightDir) !== "overnight" || basename(dataDir) !== "data") {
    return { ok: false, reason: `plano fora de data/overnight/{rodada}/plan.json (${planPath})` };
  }
  const planSession = typeof plan.session_id === "string" && plan.session_id.trim() ? plan.session_id.trim() : null;
  return {
    ok: true,
    rootDir: dirname(dataDir),
    edition: basename(runDir),
    phase: `onda w${waveNumber}`,
    sessionId: currentSessionId(env) ?? planSession,
  };
}

/**
 * I/O (#13260): grava o `coordinator_tokens_estimate` da onda pelo mesmo
 * cálculo do `coordinator-usage-estimate.ts` (delta desde o último
 * checkpoint, `tokens: null` com `reason` sem fonte). Os checkpoints manuais
 * eram esquecidos (rodada 261115f, mesma classe de #5009/#6634); a onda é
 * gravada sempre, então o checkpoint sai junto. Nunca lança nem muda o exit.
 */
function emitWaveTokenCheckpoint(target: WaveCheckpointTarget): void {
  if (!target.ok) {
    console.error(`[record-overnight-wave] checkpoint de token não gravado: ${target.reason}`);
    return;
  }
  try {
    const result = estimateCoordinatorUsage({
      edition: target.edition,
      agent: "overnight",
      sessionId: target.sessionId,
      rootDir: target.rootDir,
      cwd: process.cwd(),
    });
    const details = estimateToDetails(result, target.phase, target.sessionId);
    logEvent({ edition: target.edition, stage: null, agent: "overnight", level: "info", message: COORDINATOR_ESTIMATE_MESSAGE, details }, target.rootDir);
    console.log(
      `[record-overnight-wave] ${COORDINATOR_ESTIMATE_MESSAGE} gravado: phase="${target.phase}" tokens=${details.tokens ?? `null (${details.reason})`}`,
    );
  } catch (e) {
    console.error(`[record-overnight-wave] checkpoint de token não gravado: ${(e as Error).message}`);
  }
}

if (isMainModule(import.meta.url)) {
  const { values } = parseArgs(process.argv.slice(2));
  const usage = '[record-overnight-wave] uso: --plan {path} --units "8290,8291;8300" [--deferred N] [--open-pr-slots N]';
  if (!values.plan || !values.units) {
    console.error(usage);
    process.exit(2);
  }
  // #10579: plano trocado por cópia de conflito do OneDrive → restaura antes de ler.
  recoverPlanFromSafeBackupWithWarning(values.plan);
  if (!existsSync(values.plan)) {
    console.error(`[record-overnight-wave] plan.json não encontrado: ${values.plan}`);
    process.exit(2);
  }
  // parseArgs descarta a flag sem valor em silêncio — checar o argv cru.
  if (process.argv.includes("--deferred") && !(typeof values.deferred === "string" && INT.test(values.deferred))) {
    console.error(`[record-overnight-wave] --deferred exige inteiro não-negativo (recebido: ${JSON.stringify(values.deferred)})`);
    process.exit(2);
  }
  // Pega `--open-pr-slots N`, `--open-pr-slots=N` e a flag sem valor.
  const slotsGiven = process.argv.some((a) => a === "--open-pr-slots" || a.startsWith("--open-pr-slots="));
  if (slotsGiven && !(typeof values["open-pr-slots"] === "string" && INT.test(values["open-pr-slots"]))) {
    console.error(`[record-overnight-wave] --open-pr-slots exige inteiro não-negativo (recebido: ${JSON.stringify(values["open-pr-slots"])})`);
    process.exit(2);
  }

  let plan: Record<string, unknown>;
  try {
    const parsed = JSON.parse(readFileSync(values.plan, "utf8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("raiz não é um objeto");
    }
    plan = parsed as Record<string, unknown>;
  } catch (e) {
    console.error(`[record-overnight-wave] plan.json ilegível: ${(e as Error).message}`);
    process.exit(2);
  }

  let record;
  try {
    const units = parseUnits(values.units);
    const all = units.flat();
    if (new Set(all).size !== all.length) throw new Error("issue repetida entre/dentro das unidades da onda");
    record = buildWaveRecord({ units, deferred: values.deferred ? Number(values.deferred) : 0 });
  } catch (e) {
    console.error(`[record-overnight-wave] ${(e as Error).message}`);
    process.exit(1);
  }

  // #8496 item 3: dedup — re-executar o script pra a MESMA onda (compaction de
  // contexto faz o coordenador esquecer que já registrou) não pode inflar a
  // contagem que a leitura agregada (`report-overnight-waves.ts`) usa.
  const existingWaves = Array.isArray(plan.waves) ? (plan.waves as import("./lib/overnight-waves.ts").OvernightWaveRecord[]) : [];
  const dup = findDuplicateWave(existingWaves, record);
  if (dup) {
    // Also repair waves recorded before automatic timeline persistence (#12011).
    const next = recordUnitTimeline(plan, dup.units.flatMap((u) => u.issues), "dispatch", dup.composed_at);
    const repaired = JSON.stringify(next) !== JSON.stringify(plan);
    if (repaired) writeFileAtomic(values.plan, JSON.stringify(next, null, 2) + "\n");
    // Contrato da mensagem preservado: nenhuma 2ª onda é gravada, então segue
    // sendo "no-op idempotente"; o reparo de timeline é sinalizado à parte.
    console.log(
      `[record-overnight-wave] onda idêntica já registrada em ${dup.composed_at} (dentro da janela de dedup) — nenhuma onda nova gravada, no-op idempotente${repaired ? "; timeline reparada" : ""}`,
    );
    process.exit(0);
  }

  // Teto de PRs abertos (#12765) DEPOIS do dedup: re-registrar a mesma onda
  // (compaction) já com as PRs dela abertas segue sendo no-op exit 0 (#8496).
  // #12873: o valor informado não é confiável sozinho (261111b passou 5 com 1
  // vaga medida). O script mede o teto pela mesma função do
  // `check-open-pr-cap.ts`; com medição, o medido só aperta (min); sem, o informado.
  if (slotsGiven) {
    const { slots, warning } = resolveWaveOpenPrSlots(Number(values["open-pr-slots"]), readOpenPrCap());
    if (warning) console.error(`[record-overnight-wave] AVISO: ${warning}`);
    const capErr = waveOpenPrCapError(record.unit_count, slots);
    if (capErr) {
      console.error(`[record-overnight-wave] ${capErr}`);
      process.exit(1);
    }
  }

  const next = appendWave(recordUnitTimeline(plan, record.units.flatMap((u) => u.issues), "dispatch", record.composed_at), record);
  const check = checkOvernightWaves(next);
  if (check.status === "invalid") {
    console.error(`[record-overnight-wave] plan.waves existente inválido, nada gravado: ${check.problems.join("; ")}`);
    process.exit(1);
  }
  writeFileAtomic(values.plan, JSON.stringify(next, null, 2) + "\n");
  console.log(
    `[record-overnight-wave] onda registrada: ${record.unit_count} unidade(s), cap_hit=${record.cap_hit}`,
  );
  // #13260: checkpoint de token da onda, sem depender de o coordenador lembrar.
  const waveNumber = Array.isArray(next.waves) ? next.waves.length : existingWaves.length + 1;
  emitWaveTokenCheckpoint(waveCheckpointTarget(values.plan, next, waveNumber));
}
