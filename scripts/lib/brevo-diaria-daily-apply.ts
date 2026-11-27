/**
 * brevo-diaria-daily-apply.ts (#13981)
 *
 * Marcador "o `brevo-diaria-run.ts --apply` já rodou hoje (dia civil BRT)".
 * Duas origens rodam o `--apply`:
 *
 *  - a task `Diaria-Brevo-Diaria-Evaluate` (05:30 BRT, todo dia), pelo
 *    `scripts/brevo-diaria-daily-apply.ts`;
 *  - o dispatch da Etapa 5 (`scripts/brevo-diaria-stage5-dispatch.ts`), só
 *    quando a edição tem campanha Brevo (segunda no regime semanal #11226;
 *    todo dia no regime diário ou de transição #10533).
 *
 * Critério para não rodar duas vezes no mesmo dia: no máximo 1 `--apply` por
 * dia BRT, quem chegar primeiro roda e grava o marcador; o outro lê o
 * marcador do dia e pula. Só `--apply` com exit 0 grava (falha não marca, e o
 * próximo caller do dia tenta de novo).
 *
 * Fail-soft de propósito: marcador ausente, ilegível ou de outro dia ⇒ roda.
 * O pior caso de um marcador perdido (gravação falhou, sync do `data/` entre
 * máquinas atrasado) é um `--apply` a mais no dia, que é idempotente; nunca
 * um dia sem `--apply`.
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileAtomic } from "./atomic-write.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** Mesmo diretório do store (`data/brevo-diaria/contacts.json`). */
export const DAILY_APPLY_MARKER_PATH = resolve(ROOT, "data/brevo-diaria/.daily-apply.json");

export type DailyApplySource = "task-05:30" | "stage5-dispatch";

export interface DailyApplyMarker {
  /** Dia civil BRT (`YYYY-MM-DD`, `brtDayKey`) do `--apply` bem-sucedido. */
  day: string;
  /** Instante ISO do fim do `--apply`. */
  at: string;
  by: DailyApplySource;
}

/** Pura: o `--apply` já rodou neste dia BRT? */
export function applyAlreadyRanToday(marker: DailyApplyMarker | null, todayBrt: string): boolean {
  return marker !== null && marker.day === todayBrt;
}

/** Lê o marcador; ausente ou inválido ⇒ `null` (fail-soft: o caller roda o `--apply`). */
export function readDailyApplyMarker(path: string = DAILY_APPLY_MARKER_PATH): DailyApplyMarker | null {
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<DailyApplyMarker>;
    if (typeof raw.day !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(raw.day)) return null;
    if (typeof raw.at !== "string" || (raw.by !== "task-05:30" && raw.by !== "stage5-dispatch")) return null;
    return { day: raw.day, at: raw.at, by: raw.by };
  } catch {
    return null;
  }
}

export function writeDailyApplyMarker(marker: DailyApplyMarker, path: string = DAILY_APPLY_MARKER_PATH): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileAtomic(path, JSON.stringify(marker, null, 2) + "\n");
}
