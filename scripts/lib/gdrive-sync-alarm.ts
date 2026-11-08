/**
 * scripts/lib/gdrive-sync-alarm.ts (#12357, épica #12353)
 *
 * Lógica PURA do alarme de sync do Google Drive parado — o equivalente, pro
 * `rclone bisync` do `300` (#12356), do `onedrive-sync-alarm.ts` (#5548).
 * Os dois alarmes convivem na transição (cutover de `data/` na #12359): o
 * do OneDrive segue intocado vigiando o `onedrive.service`; este vigia a
 * cópia do Drive inteiro em `/mnt/hd-sata/GoogleDrive`.
 *
 * Diferença de desenho em relação ao OneDrive: lá o cliente é um daemon
 * (`--monitor`) e o alarme pergunta ao systemd se ele está vivo, mais um
 * canário que ele mesmo escreve. Aqui o sync é um oneshot a cada 2 min, e o
 * próprio `scripts/systemd/gdrive-bisync.sh` carimba cada rodada
 * (`last-run.json`, com o exit code) e cada sucesso (`last-success.json`) no
 * state dir (`~/.cache/diaria/gdrive-bisync`). O canário de frescor é o
 * carimbo de sucesso: ele só anda quando o rclone de fato terminou um bisync
 * contra a nuvem, o que prova mais que "o timer rodou".
 *
 * Três achados, por ordem de especificidade:
 *
 *   1. `alarm-bisync-blocked` — a última rodada saiu 75 (trava do script:
 *      HD desmontado, sentinela ausente, arquivo de filtros ausente) e o
 *      último sucesso é mais velho que `blockedToleranceMs`. A trava é a
 *      proteção contra a pasta vazia apagar a nuvem; ela disparar uma vez é
 *      normal (boot antes do mount), persistir é o HD fora.
 *   2. `alarm-bisync-failed` — a última rodada saiu com outro código != 0
 *      (erro do rclone: "too many deletes" do `--max-delete`, lock, pedido
 *      de `--resync`, rede) e o último sucesso é mais velho que
 *      `failedToleranceMs`. Um erro isolado de rede se resolve na rodada
 *      seguinte; o que persiste quase sempre pede ação (`--force`,
 *      `--resync`).
 *   3. `alarm-sync-stale` — o último sucesso é mais velho que
 *      `staleToleranceMs`, seja qual for o último exit. Pega o que os dois
 *      acima não veem: timer desarmado, unit que nem chega a rodar o script,
 *      rodada pendurada horas a fio.
 *
 * Sem `last-run.json` → `not-installed`: a máquina não roda o bisync (ou ele
 * ainda não foi instalado, a cópia inicial da #12356 roda à mão). Silêncio,
 * nunca alarme: é o caso de toda máquina menos o `300` e do próprio `300`
 * antes da instalação.
 */

export interface BisyncStamp {
  /** ISO 8601 (UTC) da rodada. */
  at: string;
  /** Exit code do script naquela rodada. */
  exit: number;
}

/** Pura — valida o JSON de um carimbo. `null` = ausente/ilegível. */
export function parseBisyncStamp(raw: unknown): BisyncStamp | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.at !== "string" || Number.isNaN(Date.parse(o.at))) return null;
  if (typeof o.exit !== "number" || !Number.isInteger(o.exit)) return null;
  return { at: o.at, exit: o.exit };
}

/** Exit code da trava do `gdrive-bisync.sh` (EX_TEMPFAIL). */
export const BISYNC_BLOCKED_EXIT = 75;

export const DEFAULT_BLOCKED_TOLERANCE_MS = 60 * 60 * 1000;
export const DEFAULT_FAILED_TOLERANCE_MS = 30 * 60 * 1000;
export const DEFAULT_STALE_TOLERANCE_MS = 6 * 60 * 60 * 1000;

export type GdriveSyncVerdict =
  | "ok"
  | "not-installed"
  | "alarm-bisync-blocked"
  | "alarm-bisync-failed"
  | "alarm-sync-stale";

export interface GdriveSyncTolerances {
  blockedMs: number;
  failedMs: number;
  staleMs: number;
}

export const DEFAULT_GDRIVE_SYNC_TOLERANCES: GdriveSyncTolerances = {
  blockedMs: DEFAULT_BLOCKED_TOLERANCE_MS,
  failedMs: DEFAULT_FAILED_TOLERANCE_MS,
  staleMs: DEFAULT_STALE_TOLERANCE_MS,
};

export interface GdriveSyncEvaluation {
  verdict: GdriveSyncVerdict;
  lastRun: BisyncStamp | null;
  lastSuccess: BisyncStamp | null;
  /** Idade do último sucesso em ms; `null` = nunca houve sucesso carimbado. */
  successAgeMs: number | null;
}

/**
 * Pura. Sem sucesso carimbado, a idade conta como infinita: rodada travada
 * ou falhando que nunca teve sucesso alarma na hora (a instalação da #12356
 * faz o 1º `--resync` pelo próprio script, então o carimbo nasce ali).
 */
export function evaluateGdriveSync(
  lastRun: BisyncStamp | null,
  lastSuccess: BisyncStamp | null,
  now: Date,
  tol: GdriveSyncTolerances = DEFAULT_GDRIVE_SYNC_TOLERANCES,
): GdriveSyncEvaluation {
  const successAgeMs = lastSuccess ? now.getTime() - Date.parse(lastSuccess.at) : null;
  const base = { lastRun, lastSuccess, successAgeMs };
  if (!lastRun) return { ...base, verdict: "not-installed" };
  const olderThan = (ms: number) => successAgeMs === null || successAgeMs > ms;
  if (lastRun.exit === BISYNC_BLOCKED_EXIT && olderThan(tol.blockedMs)) return { ...base, verdict: "alarm-bisync-blocked" };
  if (lastRun.exit !== 0 && lastRun.exit !== BISYNC_BLOCKED_EXIT && olderThan(tol.failedMs)) {
    return { ...base, verdict: "alarm-bisync-failed" };
  }
  if (olderThan(tol.staleMs)) return { ...base, verdict: "alarm-sync-stale" };
  return { ...base, verdict: "ok" };
}

export function isAlarmingGdriveSyncVerdict(v: GdriveSyncVerdict): boolean {
  return v === "alarm-bisync-blocked" || v === "alarm-bisync-failed" || v === "alarm-sync-stale";
}

function hours(ms: number | null): string {
  return ms === null ? "nunca" : `${(ms / 3_600_000).toFixed(1)}h`;
}

/** Texto do achado (issue e e-mail): o que aconteceu e o passo que resolve. */
export function describeGdriveSyncVerdict(ev: GdriveSyncEvaluation): string {
  const last = ev.lastRun ? `última rodada ${ev.lastRun.at}, exit ${ev.lastRun.exit}` : "nenhuma rodada carimbada";
  const ctx = `(${last}; último sucesso há ${hours(ev.successAgeMs)})`;
  switch (ev.verdict) {
    case "alarm-bisync-blocked":
      return (
        `O \`rclone bisync\` do Google Drive está TRAVADO pela proteção contra pasta vazia ${ctx}: ` +
        "o HD `/mnt/hd-sata` não está montado, a sentinela `.diaria-bisync-sentinel` sumiu de um dos lados, " +
        "ou o arquivo de filtros não foi achado. Nada sincroniza enquanto isso. Conferir `mountpoint /mnt/hd-sata` " +
        "e `journalctl --user -u diaria-gdrive-bisync -n 20`; sentinela apagada → recriar com `touch` / " +
        "`rclone touch gdrive:.diaria-bisync-sentinel` (ver `docs/scheduled-tasks-registry.md`, `diaria-gdrive-bisync`)."
      );
    case "alarm-bisync-failed":
      return (
        `O \`rclone bisync\` do Google Drive está FALHANDO ${ctx}. Causas comuns: "too many deletes" (a trava do ` +
        "`--max-delete`: confirmar que a deleção foi intencional e rodar `sh scripts/systemd/gdrive-bisync.sh --force` " +
        "uma vez), bisync pedindo `--resync` (filtros mudaram ou estado perdido), lock preso, token do remote " +
        "expirado. Log: `journalctl --user -u diaria-gdrive-bisync -n 50`. Este alarme nunca roda o sync."
      );
    case "alarm-sync-stale":
      return (
        `O Google Drive não sincroniza com sucesso há mais que a tolerância ${ctx}. Pode ser o timer ` +
        "`diaria-gdrive-bisync.timer` desarmado, a unit nem chegando ao script, ou uma rodada pendurada. " +
        "Conferir `systemctl --user list-timers diaria-gdrive-bisync.timer` e o journal da unit."
      );
    default:
      return `Estado: verdict=${ev.verdict} ${ctx}.`;
  }
}
