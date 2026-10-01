/**
 * editor-request-snapshots.ts (#9356)
 *
 * IO e saúde dos snapshots de referência usados por
 * `scripts/derive-editor-requests.ts` (derivação de pedidos do editor) e
 * `scripts/edition-manual-edits.ts` (métrica "edições sem modificação
 * manual", #9357).
 *
 * ## O bug que motivou este módulo (#9356)
 *
 * O baseline `stage2-post-gate` deveria ser a SAÍDA DA PIPELINE no fim do
 * Stage 2, antes de qualquer edição humana do Stage 4. Na prática:
 *
 * 1. a captura dependia de um passo em PROSA no fim do §2d do playbook
 *    (`snapshot-stage2`), que a sessão pulava — em 15 de 21 edições
 *    (260820 → 261001) o diretório do snapshot nasceu SEGUNDOS depois do
 *    `.step-4-done.json`, criado pelo próprio `derive-stage4`;
 * 2. `derive-stage4`, sem snapshot, pulava em silêncio ("primeira vez, não
 *    podemos derivar") e no fim REGRAVAVA `stage2-post-gate` com o estado
 *    final — o snapshot passava a ser byte a byte o `02-reviewed.md` final e
 *    escondia o problema de qualquer auditoria posterior.
 *
 * Correção: a captura passa a ser MECÂNICA (`pipeline-sentinel.ts write
 * --step 2` chama `captureStage2Baseline`), carimbada com `.capture.json`
 * (`captured_at` + `trigger`), e nunca mais é regravada — o checkpoint que o
 * `derive-stage6` precisa vive num label separado (`stage4-post-gate`).
 * `assessStage2Baseline` decide, de forma pura, se o baseline presente é
 * confiável.
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

/** Diretório de snapshots, relativo ao diretório da edição. */
export const SNAPSHOT_DIR = "_internal/editor-request-snapshots";

/** Baseline imutável: saída da pipeline no fim do Stage 2 (#5731, #7964, #9356). */
export const STAGE2_BASELINE_LABEL = "stage2-post-gate";

/**
 * Checkpoint gravado pelo `derive-stage4` DEPOIS de derivar (#9356) — é
 * contra ele que o `derive-stage6` diffa, pra só ver o que mudou após a
 * aprovação do Stage 4. Antes do #9356 esse refresh sobrescrevia o próprio
 * `stage2-post-gate`, destruindo o baseline.
 */
export const STAGE4_POST_GATE_LABEL = "stage4-post-gate";

/**
 * Marcador do `derive-editor-requests.ts backfill-stage4 --write` (#9356):
 * presente = os pedidos do Stage 4 já foram reconstruídos contra o baseline
 * reconstruído. Lido também pelo `jev-ab-report.ts` (#9374).
 */
export const STAGE4_BACKFILL_MARKER = "_internal/.stage4-editor-requests-backfill.json";

/** Arquivos do baseline pós-Stage 2. */
export const STAGE2_SNAPSHOT_FILES = [
  "02-reviewed.md",
  "03-social.md",
  "_internal/01-approved.json",
] as const;

/** Arquivo de carimbo da captura, dentro do diretório do label. */
export const CAPTURE_META_FILE = ".capture.json";

/**
 * Quem gravou o baseline:
 * - `pipeline-sentinel-step-2` — caminho mecânico (#9356), no write do sentinel do Stage 2;
 * - `snapshot-stage2` — chamada explícita (playbook §2d / CLI).
 */
export type CaptureTrigger = "pipeline-sentinel-step-2" | "snapshot-stage2";

export interface CaptureMeta {
  captured_at: string;
  trigger: CaptureTrigger;
}

/**
 * Captura mais de 30 min depois do sentinel do Stage 2 já não é "saída da
 * pipeline": o Stage 3 dura ~10 min e o editor começa a revisar logo depois.
 * Medido em 260923 (captura correta): 28 s entre `.step-2-done.json` e o
 * snapshot. Nas 15 edições do bug, 1h40 a 7h.
 */
export const LATE_CAPTURE_TOLERANCE_MS = 30 * 60 * 1000;

function labelDir(editionDir: string, label: string): string {
  return resolve(editionDir, SNAPSHOT_DIR, label);
}

/**
 * Copia `files` para `{SNAPSHOT_DIR}/{label}/`, preservando a subestrutura
 * de diretórios (`_internal/01-approved.json` →
 * `{label}/_internal/01-approved.json`) — achatar `/` em `_` seria
 * irreversível pra paths que já começam com `_`.
 */
export function createSnapshots(
  editionDir: string,
  files: readonly string[],
  label: string,
  meta?: CaptureMeta,
): void {
  const dir = labelDir(editionDir, label);
  mkdirSync(dir, { recursive: true });
  for (const file of files) {
    const srcPath = resolve(editionDir, file);
    if (existsSync(srcPath)) {
      const destPath = resolve(dir, file);
      mkdirSync(dirname(destPath), { recursive: true });
      copyFileSync(srcPath, destPath);
    }
  }
  if (meta) {
    writeFileSync(resolve(dir, CAPTURE_META_FILE), JSON.stringify(meta, null, 2) + "\n", "utf8");
  }
}

/** Lê os snapshots de `label` para a lista de arquivos esperados. */
export function readSnapshots(editionDir: string, label: string, files: readonly string[]): Map<string, string> {
  const dir = labelDir(editionDir, label);
  const result = new Map<string, string>();
  if (!existsSync(dir)) return result;
  for (const file of files) {
    const snapPath = resolve(dir, file);
    if (existsSync(snapPath)) result.set(file, readFileSync(snapPath, "utf8"));
  }
  return result;
}

/**
 * Um snapshot conta como "já capturado" (#7964) se ao menos um dos arquivos
 * esperados foi copiado — `createSnapshots` cria o diretório mesmo quando
 * nenhum arquivo-fonte existia ainda.
 */
export function hasSnapshot(editionDir: string, label: string, files: readonly string[]): boolean {
  const dir = labelDir(editionDir, label);
  if (!existsSync(dir)) return false;
  return files.some((file) => existsSync(resolve(dir, file)));
}

/** Carimbo da captura, ou `null` (ausente/malformado — snapshot legado, pré-#9356). */
export function readCaptureMeta(editionDir: string, label: string): CaptureMeta | null {
  const p = resolve(labelDir(editionDir, label), CAPTURE_META_FILE);
  if (!existsSync(p)) return null;
  try {
    const parsed = JSON.parse(readFileSync(p, "utf8")) as Partial<CaptureMeta>;
    if (typeof parsed.captured_at !== "string" || typeof parsed.trigger !== "string") return null;
    return { captured_at: parsed.captured_at, trigger: parsed.trigger as CaptureTrigger };
  } catch {
    return null;
  }
}

export type CaptureOutcome = "created" | "exists" | "no-sources";

/**
 * Grava o baseline `stage2-post-gate` UMA vez por edição (imutável, #7964).
 * `no-sources`: nenhum dos arquivos existe ainda (não trava o baseline vazio
 * — a próxima chamada real grava).
 */
export function captureStage2Baseline(
  editionDir: string,
  trigger: CaptureTrigger,
  now: Date = new Date(),
): CaptureOutcome {
  if (hasSnapshot(editionDir, STAGE2_BASELINE_LABEL, STAGE2_SNAPSHOT_FILES)) return "exists";
  if (!STAGE2_SNAPSHOT_FILES.some((f) => existsSync(resolve(editionDir, f)))) return "no-sources";
  createSnapshots(editionDir, STAGE2_SNAPSHOT_FILES, STAGE2_BASELINE_LABEL, {
    captured_at: now.toISOString(),
    trigger,
  });
  return "created";
}

export type BaselineHealth =
  /** Carimbo presente e a captura aconteceu junto do fim do Stage 2. */
  | { status: "ok" }
  /** Nenhum baseline — nada a diffar (o bug do #9356 em execução). */
  | { status: "missing" }
  /** Carimbo presente, mas a captura aconteceu longe do fim do Stage 2. */
  | { status: "late"; reason: string }
  /**
   * Snapshot sem carimbo (gravado antes do #9356). O `derive-stage4` antigo
   * REGRAVAVA esse diretório com o estado final, então ele não serve de
   * baseline pra auditoria retroativa — só pro diff em tempo real de uma
   * edição em curso no momento do deploy.
   */
  | { status: "legacy" };

/**
 * Decide se o baseline `stage2-post-gate` é confiável. Pura.
 *
 * `step2CompletedAt` = `completed_at` de `_internal/.step-2-done.json`
 * (`null` se o sentinel não existe/não parseia — aí o carimbo sozinho decide).
 */
export function assessStage2Baseline(input: {
  snapshotExists: boolean;
  meta: CaptureMeta | null;
  step2CompletedAt: string | null;
}): BaselineHealth {
  if (!input.snapshotExists) return { status: "missing" };
  if (!input.meta) return { status: "legacy" };
  const capturedMs = Date.parse(input.meta.captured_at);
  if (Number.isNaN(capturedMs)) return { status: "late", reason: `captured_at inválido: ${input.meta.captured_at}` };
  if (input.step2CompletedAt) {
    const step2Ms = Date.parse(input.step2CompletedAt);
    if (!Number.isNaN(step2Ms) && capturedMs - step2Ms > LATE_CAPTURE_TOLERANCE_MS) {
      const minutes = Math.round((capturedMs - step2Ms) / 60000);
      return {
        status: "late",
        reason: `baseline capturado ${minutes} min depois do sentinel do Stage 2 (tolerância ${LATE_CAPTURE_TOLERANCE_MS / 60000} min) — já pode conter edições do editor`,
      };
    }
  }
  return { status: "ok" };
}

/** Lê `completed_at` do sentinel do Stage 2, ou `null`. */
export function readStep2CompletedAt(editionDir: string): string | null {
  const p = resolve(editionDir, "_internal", ".step-2-done.json");
  if (!existsSync(p)) return null;
  try {
    const parsed = JSON.parse(readFileSync(p, "utf8")) as { completed_at?: unknown };
    return typeof parsed.completed_at === "string" ? parsed.completed_at : null;
  } catch {
    return null;
  }
}

/** `assessStage2Baseline` lendo o estado real da edição. */
export function assessStage2BaselineOnDisk(editionDir: string): BaselineHealth {
  return assessStage2Baseline({
    snapshotExists: hasSnapshot(editionDir, STAGE2_BASELINE_LABEL, STAGE2_SNAPSHOT_FILES),
    meta: readCaptureMeta(editionDir, STAGE2_BASELINE_LABEL),
    step2CompletedAt: readStep2CompletedAt(editionDir),
  });
}
