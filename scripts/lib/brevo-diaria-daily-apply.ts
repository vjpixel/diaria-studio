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
 * Critério: a task roda o `--apply` no máximo 1 vez por dia BRT, e pula se
 * o marcador já é do dia. Só `--apply` com exit 0 grava (falha não marca, e
 * o próximo caller do dia tenta de novo).
 *
 * Quem pula: só a TASK. O dispatch da Etapa 5, nas edições com campanha,
 * roda SEMPRE o `--apply` antes de criar a campanha (lista atualizada logo
 * antes do agendamento, que congela os destinatários na Brevo), ignorando o
 * marcador, e grava o marcador do dia. Custo aceito: no dia em que a edição
 * de segunda é despachada (em geral domingo), o `--apply` roda 2 vezes
 * (05:30 pela task, e no dispatch). A task pula quando o dispatch já rodou
 * naquele dia (dispatch de madrugada, antes das 05:30).
 *
 * Fail-soft de propósito: marcador ausente, ilegível ou de outro dia ⇒ roda.
 * O pior caso de um marcador perdido (gravação falhou, sync do `data/` entre
 * máquinas atrasado) é um `--apply` a mais no dia, que é idempotente; nunca
 * um dia sem `--apply`.
 *
 * Lock: ler marcador → `--apply` → gravar marcador corre dentro de
 * `withFileLock` (`.daily-apply.json.lock`), nos dois caminhos, para task e
 * dispatch na MESMA máquina não rodarem o `--apply` em paralelo. Entre
 * máquinas o lock NÃO protege: o arquivo de lock em `data/` chega pela sync
 * do Drive com atraso, então duas máquinas podem adquiri-lo ao mesmo tempo.
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileAtomic } from "./atomic-write.ts";
import { withFileLock } from "./file-lock.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** Mesmo diretório do store (`data/brevo-diaria/contacts.json`). */
export const DAILY_APPLY_MARKER_PATH = resolve(ROOT, "data/brevo-diaria/.daily-apply.json");

/** O `--apply` leva >5 min; quem espera o lock espera uma rodada inteira antes de desistir. */
export const DAILY_APPLY_LOCK_TIMEOUT_MS = 30 * 60_000;

export type DailyApplySource = "task-05:30" | "stage5-dispatch";

export interface DailyApplyMarker {
  /** Dia civil BRT (`YYYY-MM-DD`, `brtDayKey`) do `--apply` bem-sucedido. */
  day: string;
  /** Instante ISO do fim do `--apply`. */
  at: string;
  by: DailyApplySource;
  /**
   * Avisos fail-soft do `--apply` (`extractRunWarnings`: exit 3 do evaluate,
   * pool Kit, `sync-kit-frio`...). Lidos pelo skip rápido da Etapa 5 para o
   * aviso da task do dia aparecer também no resultado da Etapa 5.
   */
  warnings: string[];
}

/** Lock do marcador, na mesma máquina (ver docstring do módulo). */
export function withDailyApplyLock<T>(fn: () => T, path: string = DAILY_APPLY_MARKER_PATH): T {
  mkdirSync(dirname(path), { recursive: true });
  return withFileLock(path + ".lock", fn, DAILY_APPLY_LOCK_TIMEOUT_MS);
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
    const warnings = Array.isArray(raw.warnings) ? raw.warnings.filter((w): w is string => typeof w === "string") : [];
    return { day: raw.day, at: raw.at, by: raw.by, warnings };
  } catch {
    return null;
  }
}

export function writeDailyApplyMarker(marker: DailyApplyMarker, path: string = DAILY_APPLY_MARKER_PATH): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileAtomic(path, JSON.stringify(marker, null, 2) + "\n");
}
