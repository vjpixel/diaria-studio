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
 *   0. `alarm-stamp-unreadable` — um carimbo EXISTE mas não serve: JSON
 *      inválido, sem permissão de leitura, `at` mais de
 *      `STAMP_FUTURE_TOLERANCE_MS` no futuro, ou `last-success.json` com
 *      `exit` != 0 (review da #12357: antes isso contava como ausente, e um
 *      `last-run.json` corrompido virava `not-installed` — silêncio, com as
 *      issues abertas congeladas). Sem carimbo legível não há medida, então
 *      os outros três achados ficam congelados enquanto este estiver aceso.
 *   1. `alarm-bisync-blocked` — a última rodada saiu 75 (trava do script,
 *      sempre do lado LOCAL: HD desmontado, sentinela local ausente, arquivo
 *      de filtros ausente; a sentinela que falta do lado do Drive cai no
 *      `--check-access` do rclone e sai como falha, achado 2) e o
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
 * Sem NENHUM carimbo (`last-run.json` e `last-success.json` ausentes) →
 * `not-installed`: a máquina não roda o bisync (ou ele ainda não foi
 * instalado, a cópia inicial da #12356 roda à mão). Silêncio, nunca alarme:
 * é o caso de toda máquina menos o `300` e do próprio `300` antes da
 * instalação. Só `last-success.json` presente (o `last-run.json` sumiu) NÃO é
 * `not-installed`: o sucesso conta como a última rodada conhecida (exit 0) e
 * a idade dele decide entre `ok` e `alarm-sync-stale`.
 *
 * Duas instâncias de bisync, o mesmo veredito (#12478): o do Drive inteiro
 * (`diaria-gdrive-bisync`, carimbos em `~/.cache/diaria/gdrive-bisync`) e o
 * dedicado de `data/` (`diaria-gdrive-data-bisync`, a cada 1 min, carimbos em
 * `~/.cache/diaria/gdrive-data-bisync`). Muda só o texto (`BisyncTarget`) e a
 * tolerância (`DATA_GDRIVE_SYNC_TOLERANCES`, curta, adequada à cadência).
 */

import {
  DEFAULT_DATA_BISYNC_REMOTE,
  DEFAULT_DATA_BISYNC_MOUNT,
  DEFAULT_DATA_BISYNC_LOCAL_REL,
} from "./gdrive-data-bisync-config.ts";

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
/** Folga de relógio para um carimbo no futuro (o 300 e o NTP): além disto o
 * carimbo é inválido — um `at` no futuro daria idade negativa e seguraria o
 * alarme de stale até o relógio alcançá-lo. */
export const STAMP_FUTURE_TOLERANCE_MS = 5 * 60 * 1000;

export type GdriveSyncVerdict =
  | "ok"
  | "not-installed"
  | "alarm-stamp-unreadable"
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

/** Tolerâncias do bisync dedicado de `data/` (#12478). Ele roda a cada 1 min
 * e existe para o `data/` não ficar mais que minutos atrás entre as máquinas:
 * 30 min sem sucesso já é o problema que ele veio resolver (o bisync do Drive
 * inteiro deixava até ~70 min). Falha persistente alarma antes (15 min, ~15
 * rodadas seguidas); trava (exit 75) e stale em 30 min. */
export const DATA_GDRIVE_SYNC_TOLERANCES: GdriveSyncTolerances = {
  blockedMs: 30 * 60 * 1000,
  failedMs: 15 * 60 * 1000,
  staleMs: 30 * 60 * 1000,
};

/** O que muda no texto do achado entre as duas instâncias de bisync. */
export interface BisyncTarget {
  /** Nome da instância no texto ("do Google Drive", "do `data/` no Google Drive"). */
  subject: string;
  /** Nome-base da unit (sem `.service`/`.timer`). */
  unit: string;
  /** State dir como aparece no texto (com `~`). */
  stateDirHint: string;
  /** Sentinela LOCAL como aparece no texto. */
  localSentinelHint: string;
  /** Comando que recria a sentinela do lado do Drive. */
  remoteSentinelTouch: string;
  /** Comando manual do script (sem argumentos). */
  scriptCmd: string;
}

/** Bisync do Drive inteiro (#12356): o texto de sempre. */
export const FULL_DRIVE_BISYNC_TARGET: BisyncTarget = {
  subject: "do Google Drive",
  unit: "diaria-gdrive-bisync",
  stateDirHint: "~/.cache/diaria/gdrive-bisync/",
  localSentinelHint: "/mnt/hd-sata/GoogleDrive/.diaria-bisync-sentinel",
  remoteSentinelTouch: "rclone touch gdrive:.diaria-bisync-sentinel",
  scriptCmd: "sh scripts/systemd/gdrive-bisync.sh",
};

/** Bisync dedicado de `data/` (#12478), com o remote e a pasta local
 * EFETIVOS (arquivo `~/.config/diaria/gdrive-data-bisync.env` + ambiente +
 * defaults, `resolveDataBisyncConfig`): os comandos do texto saem coláveis. */
export function dataBisyncTarget(cfg: { remote: string; local: string; stateDir?: string }): BisyncTarget {
  const sep = cfg.remote.endsWith(":") || cfg.remote.endsWith("/") ? "" : "/";
  return {
    subject: "do `data/` no Google Drive (bisync dedicado)",
    unit: "diaria-gdrive-data-bisync",
    stateDirHint: cfg.stateDir ? `${cfg.stateDir.replace(/\/+$/, "")}/` : "~/.cache/diaria/gdrive-data-bisync/",
    localSentinelHint:
      `\`${cfg.local}/.diaria-bisync-sentinel\` (pasta local de \`data/\`: \`GDRIVE_DATA_LOCAL\` em ` +
      "`~/.config/diaria/gdrive-data-bisync.env`)",
    remoteSentinelTouch: `rclone touch ${cfg.remote}${sep}.diaria-bisync-sentinel`,
    scriptCmd: "sh scripts/systemd/gdrive-data-bisync.sh",
  };
}

/** Target de `data/` com os defaults do wrapper (sem arquivo de env). */
export const DATA_BISYNC_TARGET: BisyncTarget = dataBisyncTarget({
  remote: DEFAULT_DATA_BISYNC_REMOTE,
  local: `${DEFAULT_DATA_BISYNC_MOUNT}/${DEFAULT_DATA_BISYNC_LOCAL_REL}`,
});

export interface GdriveSyncEvaluation {
  verdict: GdriveSyncVerdict;
  lastRun: BisyncStamp | null;
  lastSuccess: BisyncStamp | null;
  /** Idade do último sucesso em ms; `null` = nunca houve sucesso carimbado. */
  successAgeMs: number | null;
  /** Carimbos que existem mas não servem (motivo legível por arquivo). Vazio
   * no caminho normal; não vazio ⇔ `alarm-stamp-unreadable`. */
  invalidStamps: string[];
}

/**
 * Leitura de um carimbo do disco, já separando os três casos que o alarme
 * trata diferente: `absent` (ENOENT — máquina sem bisync), `unreadable`
 * (existe mas não abre ou não é um carimbo válido — alarma) e `ok`.
 */
export type BisyncStampRead =
  | { kind: "absent" }
  | { kind: "unreadable"; reason: string }
  | { kind: "ok"; stamp: BisyncStamp };

/** Pura — converte o conteúdo cru (já lido) em `BisyncStampRead`. */
export function bisyncStampReadFromText(text: string): BisyncStampRead {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return { kind: "unreadable", reason: `JSON inválido (${(e as Error).message})` };
  }
  const stamp = parseBisyncStamp(raw);
  return stamp ? { kind: "ok", stamp } : { kind: "unreadable", reason: "não é um carimbo {at, exit} válido" };
}

/** Entrada de `evaluateGdriveSync` por carimbo: o carimbo, `null` (ausente)
 * ou a leitura completa (que distingue ausente de ilegível). */
export type BisyncStampInput = BisyncStamp | null | BisyncStampRead;

function normalizeStampInput(input: BisyncStampInput): BisyncStampRead {
  if (input === null) return { kind: "absent" };
  if ("kind" in input) return input;
  return { kind: "ok", stamp: input };
}

/**
 * Pura. Sem sucesso carimbado, a idade conta como infinita: rodada travada
 * ou falhando que nunca teve sucesso alarma na hora (a instalação da #12356
 * faz o 1º `--resync` pelo próprio script, então o carimbo nasce ali).
 *
 * Contratos fixados no review da #12357 (testes em
 * `test/gdrive-sync-alarm-12357.test.ts`):
 *   - carimbo ilegível, `at` além de `STAMP_FUTURE_TOLERANCE_MS` no futuro,
 *     ou `last-success.json` com `exit` != 0 → `alarm-stamp-unreadable`
 *     (precede todo o resto: sem carimbo confiável não há o que medir);
 *   - `at` no futuro DENTRO da folga conta como idade 0 (relógio);
 *   - os limiares são estritos: idade exatamente igual à tolerância não
 *     alarma, 1 ms além alarma;
 *   - só `last-success.json` (sem `last-run.json`) → o sucesso é a última
 *     rodada conhecida; não é `not-installed`;
 *   - `last-run` exit 0 sem nenhum sucesso carimbado → `alarm-sync-stale`
 *     (um exit 0 que não carimbou sucesso é rodada `--dry-run` antiga ou
 *     escrita do carimbo falhando; idade infinita).
 */
export function evaluateGdriveSync(
  lastRunInput: BisyncStampInput,
  lastSuccessInput: BisyncStampInput,
  now: Date,
  tol: GdriveSyncTolerances = DEFAULT_GDRIVE_SYNC_TOLERANCES,
): GdriveSyncEvaluation {
  const invalidStamps: string[] = [];
  const nowMs = now.getTime();
  const accept = (name: string, input: BisyncStampInput, mustBeSuccess: boolean): BisyncStamp | null => {
    const read = normalizeStampInput(input);
    if (read.kind === "absent") return null;
    if (read.kind === "unreadable") {
      invalidStamps.push(`${name}: ${read.reason}`);
      return null;
    }
    const atMs = Date.parse(read.stamp.at);
    if (atMs - nowMs > STAMP_FUTURE_TOLERANCE_MS) {
      invalidStamps.push(`${name}: \`at\` ${read.stamp.at} está no futuro além da folga de relógio`);
      return null;
    }
    if (mustBeSuccess && read.stamp.exit !== 0) {
      invalidStamps.push(`${name}: carimbo de sucesso com exit ${read.stamp.exit}`);
      return null;
    }
    return read.stamp;
  };
  const lastRunRaw = accept("last-run.json", lastRunInput, false);
  const lastSuccess = accept("last-success.json", lastSuccessInput, true);
  const successAgeMs = lastSuccess ? Math.max(0, nowMs - Date.parse(lastSuccess.at)) : null;
  if (invalidStamps.length > 0) {
    return { lastRun: lastRunRaw, lastSuccess, successAgeMs, invalidStamps, verdict: "alarm-stamp-unreadable" };
  }
  const base = { lastRun: lastRunRaw, lastSuccess, successAgeMs, invalidStamps };
  if (!lastRunRaw && !lastSuccess) return { ...base, verdict: "not-installed" };
  // `last-run.json` sumiu mas há sucesso: o sucesso É uma rodada (exit 0).
  const lastRun = lastRunRaw ?? lastSuccess!;
  const olderThan = (ms: number) => successAgeMs === null || successAgeMs > ms;
  if (lastRun.exit === BISYNC_BLOCKED_EXIT && olderThan(tol.blockedMs)) return { ...base, verdict: "alarm-bisync-blocked" };
  if (lastRun.exit !== 0 && lastRun.exit !== BISYNC_BLOCKED_EXIT && olderThan(tol.failedMs)) {
    return { ...base, verdict: "alarm-bisync-failed" };
  }
  if (olderThan(tol.staleMs)) return { ...base, verdict: "alarm-sync-stale" };
  return { ...base, verdict: "ok" };
}

export function isAlarmingGdriveSyncVerdict(v: GdriveSyncVerdict): boolean {
  return (
    v === "alarm-stamp-unreadable" || v === "alarm-bisync-blocked" || v === "alarm-bisync-failed" || v === "alarm-sync-stale"
  );
}

function hours(ms: number | null): string {
  return ms === null ? "nunca" : `${(ms / 3_600_000).toFixed(1)}h`;
}

/** Texto do achado (issue e e-mail): o que aconteceu e o passo que resolve.
 * `target` troca nome, unit, caminhos e comandos entre as duas instâncias
 * (#12478); o default é o texto de sempre do bisync do Drive inteiro. */
export function describeGdriveSyncVerdict(ev: GdriveSyncEvaluation, target: BisyncTarget = FULL_DRIVE_BISYNC_TARGET): string {
  const last = ev.lastRun ? `última rodada ${ev.lastRun.at}, exit ${ev.lastRun.exit}` : "nenhuma rodada carimbada";
  const ctx = `(${last}; último sucesso há ${hours(ev.successAgeMs)})`;
  const t = target;
  const localSentinel = t.localSentinelHint.startsWith("/") ? `\`${t.localSentinelHint}\`` : t.localSentinelHint;
  switch (ev.verdict) {
    case "alarm-stamp-unreadable":
      return (
        `Os carimbos do \`rclone bisync\` ${t.subject} existem mas não servem ${ctx}: ` +
        `${ev.invalidStamps.join("; ")}. Sem carimbo confiável o alarme não mede o sync (os outros achados ficam ` +
        `congelados). Conferir \`ls -l ${t.stateDirHint}\` (permissão, conteúdo, relógio da máquina); ` +
        `apagar o carimbo inválido faz a próxima rodada do \`${t.unit}.timer\` regravá-lo.`
      );
    case "alarm-bisync-blocked":
      return (
        `O \`rclone bisync\` ${t.subject} está TRAVADO pela proteção contra pasta vazia ${ctx}: ` +
        `o HD \`/mnt/hd-sata\` não está montado, a sentinela LOCAL ${localSentinel} ` +
        "sumiu, ou o arquivo de filtros não foi achado (a sentinela do lado do Drive não cai aqui: o " +
        "`--check-access` do rclone a acusa como falha, `alarm-bisync-failed`). Nada sincroniza enquanto isso. " +
        `Conferir \`mountpoint /mnt/hd-sata\` e \`journalctl --user -u ${t.unit} -n 20\`; sentinela local ` +
        `apagada → recriar com \`touch\` (ver \`docs/scheduled-tasks-registry.md\`, \`${t.unit}\`).`
      );
    case "alarm-bisync-failed":
      return (
        `O \`rclone bisync\` ${t.subject} está FALHANDO ${ctx}. Causas comuns: "too many deletes" (a trava do ` +
        `\`--max-delete\`: confirmar que a deleção foi intencional e rodar \`${t.scriptCmd} --force\` ` +
        "uma vez), bisync pedindo `--resync` (filtros mudaram ou estado perdido), lock preso, token do remote " +
        "expirado, sentinela ausente do lado do Drive (o `--check-access` recusa; recriar com " +
        `\`${t.remoteSentinelTouch}\`). Log: \`journalctl --user -u ${t.unit} -n 50\`. ` +
        "Este alarme nunca roda o sync."
      );
    case "alarm-sync-stale":
      return (
        `O ${t.subject.replace(/^do /, "")} não sincroniza com sucesso há mais que a tolerância ${ctx}. Pode ser o timer ` +
        `\`${t.unit}.timer\` desarmado, a unit nem chegando ao script, ou uma rodada pendurada. ` +
        `Conferir \`systemctl --user list-timers ${t.unit}.timer\` e o journal da unit.`
      );
    default:
      return `Estado: verdict=${ev.verdict} ${ctx}.`;
  }
}
