/**
 * sync-code-marker.ts (#8690)
 *
 * O Passo -3 de `/diaria-5-publicacao` (sync-code.ts, #8684) era só prosa:
 * nada em código confirmava que ele rodou. `sync-code.ts --edition-dir <dir>`
 * grava este marker e o invariant `sync-code-ran` (stage 5) acusa a ausência
 * — mesmo padrão de `.close-poll-done.json` (#1367).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { InvariantViolation } from "./invariant-checks/types.ts";

export const SYNC_CODE_MARKER_FILENAME = "05-sync-code.json";

export interface SyncCodeMarker {
  ran_at: string;
  outcome: string;
  commits_behind: number;
  up_to_date: boolean;
}

export function syncCodeMarkerPath(editionDir: string): string {
  return resolve(editionDir, "_internal", SYNC_CODE_MARKER_FILENAME);
}

export function writeSyncCodeMarker(editionDir: string, marker: SyncCodeMarker): void {
  mkdirSync(resolve(editionDir, "_internal"), { recursive: true });
  writeFileSync(syncCodeMarkerPath(editionDir), JSON.stringify(marker, null, 2) + "\n", "utf8");
}

/**
 * Warning (não error): o sync é fail-soft por desenho (#2686) — o que este
 * check garante é que pular o passo deixe rastro, não bloquear a publicação.
 */
export function checkSyncCodeMarker(editionDir: string): InvariantViolation[] {
  const path = syncCodeMarkerPath(editionDir);
  if (!existsSync(path)) {
    return [
      {
        rule: "sync-code-ran",
        message:
          `_internal/${SYNC_CODE_MARKER_FILENAME} ausente — o Passo -3 de /diaria-5-publicacao ` +
          `(\`npx tsx scripts/sync-code.ts --edition-dir {EDITION_DIR}\`) não rodou nesta sessão. ` +
          `Scripts da Etapa 5/6 podem estar rodando com código defasado (#8684).`,
        source_issue: "#8690",
        severity: "warning",
        file: path,
      },
    ];
  }
  let marker: Partial<SyncCodeMarker>;
  try {
    marker = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    return [
      {
        rule: "sync-code-ran",
        message: `_internal/${SYNC_CODE_MARKER_FILENAME} ilegível: ${(e as Error).message}`,
        source_issue: "#8690",
        severity: "warning",
        file: path,
      },
    ];
  }
  if (marker.commits_behind === -1) {
    return [
      {
        rule: "sync-code-ran",
        message:
          `sync-code.ts rodou mas não conseguiu medir a defasagem contra origin/master ` +
          `(outcome '${marker.outcome}') — não há confirmação de código atualizado.`,
        source_issue: "#8690",
        severity: "warning",
        file: path,
      },
    ];
  }
  if (typeof marker.commits_behind === "number" && marker.commits_behind > 0) {
    return [
      {
        rule: "sync-code-ran",
        message:
          `sync-code.ts rodou mas o checkout ficou ${marker.commits_behind} commit(s) atrás de ` +
          `origin/master (outcome '${marker.outcome}') — Etapa 5/6 rodou com código defasado.`,
        source_issue: "#8690",
        severity: "warning",
        file: path,
      },
    ];
  }
  return [];
}
