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
 * o marcador já é do dia E não traz aviso (marcador com aviso ⇒ a task roda
 * de novo, para tentar o passo que falhou). Só `--apply` com exit 0 grava
 * (falha não marca, e o próximo caller do dia tenta de novo).
 *
 * Quem pula: só a TASK. O dispatch da Etapa 5, nas edições com campanha,
 * roda SEMPRE o `--apply` antes de criar a campanha (lista atualizada logo
 * antes do agendamento, que congela os destinatários na Brevo), ignorando o
 * marcador, e grava o marcador do dia. Custo aceito: em dia com campanha o
 * `--apply` roda 2 vezes (05:30 pela task, e no dispatch) — no regime
 * semanal só no dia em que a edição de segunda é despachada (em geral
 * domingo); no regime diário ou de transição, todo dia. A task pula quando
 * o dispatch já rodou naquele dia (dispatch de madrugada, antes das 05:30).
 *
 * Fail-soft de propósito: marcador ausente, ilegível ou de outro dia ⇒ roda.
 * O pior caso de um marcador perdido (gravação falhou, sync do `data/` entre
 * máquinas atrasado) é um `--apply` a mais no dia, que é idempotente; nunca
 * um dia sem `--apply`.
 *
 * Lock: ler marcador → `--apply` → gravar marcador corre dentro de
 * `withFileLock`, nos dois caminhos, para task e dispatch na MESMA máquina
 * não rodarem o `--apply` em paralelo. O arquivo de lock fica num diretório
 * LOCAL da máquina (`os.tmpdir()`), nunca em `data/`: `data/` sincroniza
 * pelo Google Drive e o `file-lock.ts` nunca rouba lock de outro host, então
 * um dispatch morto numa máquina travaria a task do `300` por dias. Entre
 * máquinas o lock não protege nada (o marcador continua em `data/`).
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileAtomic } from "./atomic-write.ts";
import { withFileLock } from "./file-lock.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** Mesmo diretório do store (`data/brevo-diaria/contacts.json`). */
export const DAILY_APPLY_MARKER_PATH = resolve(ROOT, "data/brevo-diaria/.daily-apply.json");

/** Lock LOCAL da máquina (ver docstring): fora de `data/`, que sincroniza. */
export const DAILY_APPLY_LOCK_PATH = join(tmpdir(), "diaria-brevo-daily-apply.lock");

/** A task espera uma rodada inteira do `--apply` (>5 min) antes de desistir. */
export const DAILY_APPLY_TASK_LOCK_TIMEOUT_MS = 30 * 60_000;
/** O dispatch espera menos que o teto de 30 min do join em background (§5g-ter). */
export const DAILY_APPLY_DISPATCH_LOCK_TIMEOUT_MS = 8 * 60_000;

export const DAILY_APPLY_SOURCES = ["task-05:30", "stage5-dispatch"] as const;
export type DailyApplySource = (typeof DAILY_APPLY_SOURCES)[number];

export interface DailyApplyMarker {
  /** Dia civil BRT (`YYYY-MM-DD`, `brtDayKey`) do `--apply` bem-sucedido. */
  day: string;
  /** Instante ISO do fim do `--apply`. */
  at: string;
  by: DailyApplySource;
  /**
   * Avisos fail-soft do `--apply` (`extractRunWarnings`: exit 3 do evaluate,
   * pool Kit, `sync-kit-frio`...). Lidos pelo skip rápido da Etapa 5, e
   * fazem a task do mesmo dia rodar de novo.
   */
  warnings: string[];
}

/** Pura: o `--apply` já rodou neste dia BRT? Type guard do marcador. */
export function applyAlreadyRanToday(marker: DailyApplyMarker | null, todayBrt: string): marker is DailyApplyMarker {
  return marker !== null && marker.day === todayBrt;
}

/** Lock do `--apply` diário, na mesma máquina (ver docstring do módulo). */
export function withDailyApplyLock<T>(fn: () => T, timeoutMs: number, lockPath: string = DAILY_APPLY_LOCK_PATH): T {
  return withFileLock(lockPath, fn, timeoutMs);
}

function isDailyApplySource(v: unknown): v is DailyApplySource {
  return (DAILY_APPLY_SOURCES as readonly unknown[]).includes(v);
}

/** Lê o marcador; ausente ou inválido ⇒ `null` (fail-soft: o caller roda o `--apply`). */
export function readDailyApplyMarker(path: string = DAILY_APPLY_MARKER_PATH): DailyApplyMarker | null {
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<Record<keyof DailyApplyMarker, unknown>>;
    if (typeof raw.day !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(raw.day)) return null;
    if (typeof raw.at !== "string" || Number.isNaN(Date.parse(raw.at))) return null;
    if (!isDailyApplySource(raw.by)) return null;
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
