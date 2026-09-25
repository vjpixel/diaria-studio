/**
 * scripts/lib/tmp-disk-alarm.ts (#8828)
 *
 * Lógica PURA (sem I/O) do alarme de ocupação do `/tmp` — mesmo molde de
 * `scripts/lib/kit-subscriber-limit-alarm.ts` (decisão pura testável +
 * fingerprint/idempotência do alarme, separados do I/O que mora em
 * `scripts/tmp-disk-alarm.ts`).
 *
 * ─── Contexto ────────────────────────────────────────────────────────────
 *
 * Em 25/09/2026 o `/tmp` do servidor `300` (tmpfs de 15 GB) estourou a
 * cota (EDQUOT) sem NENHUM sinal prévio — nada na lista de tasks agendadas
 * cuidava do `/tmp` até esta unidade (#8828). O alarme aqui é a rede de
 * segurança: mesmo com `scripts/cleanup-tmp-300.ts` rodando diariamente
 * (só cobre `/tmp/claude-{uid}`, uma fração pequena do `/tmp` real — ver
 * docstring de `cleanup-tmp-300.ts`), o resto do `/tmp` (cache do
 * `wrangler`/`esbuild`, clones de isolamento de worktree do harness,
 * caches de ferramenta) pode crescer sem que este repo tenha alavanca
 * nenhuma pra limpar — o alarme garante que o editor saiba ANTES do
 * próximo EDQUOT, não depois.
 *
 * `DEFAULT_TMP_DISK_ALARM_THRESHOLD_PCT = 0.80` (80%, valor sugerido pela
 * issue #8828) — limiar PERCENTUAL sobre a capacidade real do filesystem
 * (`statfsSync`), não uma contagem de bytes absoluta, mesmo racional do
 * `kit-subscriber-limit-alarm` (sobrevive a qualquer mudança de tamanho do
 * tmpfs sem precisar recalibrar código).
 */

/** Decisão default sugerida pela issue #8828 — 80% de ocupação do
 *  filesystem de `/tmp`. */
export const DEFAULT_TMP_DISK_ALARM_THRESHOLD_PCT = 0.8;

export interface TmpDiskUsage {
  /** Blocos totais do filesystem (`statfsSync(path).blocks`). */
  totalBlocks: number;
  /** Blocos disponíveis para um processo não-root (`bavail`) — mais
   *  conservador que `bfree` (que inclui blocos reservados ao root). */
  availableBlocks: number;
}

export interface TmpDiskEvaluation {
  totalBlocks: number;
  availableBlocks: number;
  usedBlocks: number;
  /** Fração 0-1. */
  thresholdPct: number;
  /** `usedBlocks / totalBlocks` — 0 quando `totalBlocks <= 0` (leitura
   *  inválida, tratada como sem ocupação em vez de `NaN`). */
  occupancyPct: number;
  /** `true` quando `occupancyPct >= thresholdPct` e `totalBlocks > 0`. */
  triggered: boolean;
}

/**
 * Pura — avalia a ocupação do `/tmp` contra o threshold percentual de
 * alarme. `usage` vem do caller (I/O real: `statfsSync("/tmp")`).
 */
export function evaluateTmpDiskAlarm(
  usage: TmpDiskUsage,
  thresholdPct: number = DEFAULT_TMP_DISK_ALARM_THRESHOLD_PCT,
): TmpDiskEvaluation {
  const { totalBlocks, availableBlocks } = usage;
  const usedBlocks = Math.max(0, totalBlocks - availableBlocks);
  const occupancyPct = totalBlocks > 0 ? usedBlocks / totalBlocks : 0;
  return {
    totalBlocks,
    availableBlocks,
    usedBlocks,
    thresholdPct,
    occupancyPct,
    triggered: totalBlocks > 0 && occupancyPct >= thresholdPct,
  };
}

/** Chave estável de finding pro `alarm-issues.ts` — 1 issue "estado" só
 *  (o achado É a ocupação cruzada, não uma lista de itens individuais). */
export const TMP_DISK_ALARM_FINDING_KEY = "tmp-disk-alarm";

/** Formata bytes aproximados a partir de blocos + tamanho de bloco, só
 *  pra exibição (issue/e-mail) — não participa de nenhuma decisão. */
export function blocksToGiB(blocks: number, blockSizeBytes: number): number {
  return (blocks * blockSizeBytes) / 1024 / 1024 / 1024;
}
