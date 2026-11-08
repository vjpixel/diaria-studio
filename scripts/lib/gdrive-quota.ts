/**
 * scripts/lib/gdrive-quota.ts (#12357, épica #12353)
 *
 * Cota do Google Drive, o equivalente do sinal de cota do OneDrive
 * (`onedrive-quota.ts`, #10957) para o backend novo. Fonte: `rclone about
 * gdrive: --json` (só leitura; o remote `gdrive` vive em
 * `~/.config/rclone/rclone.conf` do `300`, #12356).
 *
 * Formato medido no `300` em 08/11/2026 (rclone v1.75.2, conta do editor):
 *
 *   {"total": 429496729600, "used": 174606077777, "trashed": 1667219855,
 *    "other": 173457514248, "free": 81433137575}
 *
 * No backend `drive` do rclone, `used` é o uso do Drive (lixeira inclusa),
 * `other` é o resto da conta Google (Gmail, Fotos), `free` = `total` - uso
 * total. Por isso o consumo que conta pra cota é `total - free`, não `used`:
 * a conta é UMA cota compartilhada, e o Gmail enchendo também para o sync.
 * Medido acima: 81% da cota em uso.
 *
 * Fail-soft (mesma disciplina de `onedrive-quota.ts`): rclone ausente,
 * remote não configurado, rede fora ou JSON ilegível → `unmeasured`, nunca
 * "cota ok". Quem chama congela as issues de cota nesse caso (#10520).
 */
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { formatBytes } from "./onedrive-quota.ts";

/** Aviso a partir de 90% (não 80% como no OneDrive, onde o orçamento de 5 GB
 * era só do `data/`): a conta do editor já estava em 81% na medição de
 * 08/11/2026, e um aviso que nasce aceso não avisa nada. */
export const DEFAULT_GDRIVE_QUOTA_WARN_PCT = 90;

export const DEFAULT_GDRIVE_REMOTE = "gdrive:";

export interface GdriveAbout {
  total: number | null;
  used: number | null;
  trashed: number | null;
  other: number | null;
  free: number | null;
}

function numOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;
}

/** Pura — parse da saída de `rclone about --json`. `null` se não for um
 * objeto JSON com ao menos um campo numérico conhecido. */
export function parseRcloneAboutJson(text: string): GdriveAbout | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const about: GdriveAbout = {
    total: numOrNull(o.total),
    used: numOrNull(o.used),
    trashed: numOrNull(o.trashed),
    other: numOrNull(o.other),
    free: numOrNull(o.free),
  };
  return Object.values(about).some((v) => v !== null) ? about : null;
}

export type GdriveQuotaVerdict = "ok" | "quota-near" | "quota-full" | "unmeasured";

export interface GdriveQuotaEvaluation {
  verdict: GdriveQuotaVerdict;
  totalBytes: number | null;
  consumedBytes: number | null;
  freeBytes: number | null;
  /** % da cota em uso (0-100+), `null` sem total. */
  usedPct: number | null;
  warnPct: number;
  about: GdriveAbout | null;
}

/**
 * Pura. `quota-full`: `free` zerado ou consumo ≥ total. `quota-near`:
 * consumo ≥ `warnPct`% do total. Sem `total` (conta ilimitada, backend que
 * não informa) → `ok` se não houver `free` zerado, porque não há cota a
 * estourar; sem `about` → `unmeasured`.
 */
export function evaluateGdriveQuota(
  about: GdriveAbout | null,
  warnPct: number = DEFAULT_GDRIVE_QUOTA_WARN_PCT,
): GdriveQuotaEvaluation {
  const base = { warnPct, about };
  if (!about) {
    return { ...base, verdict: "unmeasured", totalBytes: null, consumedBytes: null, freeBytes: null, usedPct: null };
  }
  const total = about.total;
  const free = about.free;
  const consumed =
    total !== null && free !== null ? Math.max(0, total - free) : about.used !== null ? about.used + (about.other ?? 0) : null;
  const usedPct = total !== null && total > 0 && consumed !== null ? (consumed / total) * 100 : null;
  let verdict: GdriveQuotaVerdict = "ok";
  if ((free !== null && free <= 0) || (usedPct !== null && usedPct >= 100)) verdict = "quota-full";
  else if (usedPct !== null && usedPct >= warnPct) verdict = "quota-near";
  else if (usedPct === null && free === null) verdict = "unmeasured";
  return { ...base, verdict, totalBytes: total, consumedBytes: consumed, freeBytes: free, usedPct };
}

export function isAlarmingGdriveQuotaVerdict(v: GdriveQuotaVerdict): boolean {
  return v === "quota-full" || v === "quota-near";
}

/** Texto do alarme com a causa (mesmo pedido do editor na #10957: dizer o
 * que está ocupando, não só o percentual). */
export function buildGdriveQuotaCauseText(ev: GdriveQuotaEvaluation): string {
  const out: string[] = [];
  const pct = ev.usedPct === null ? "?" : `${ev.usedPct.toFixed(1)}%`;
  out.push(`Google Drive: cota ${ev.verdict} — ${pct} em uso (aviso a partir de ${ev.warnPct}%).`);
  const a = ev.about;
  if (a) {
    const part = (label: string, v: number | null) => (v === null ? null : `${label} ${formatBytes(v)}`);
    const parts = [
      part("total", a.total),
      part("livre", a.free),
      part("Drive", a.used),
      part("lixeira do Drive", a.trashed),
      part("resto da conta (Gmail, Fotos)", a.other),
    ].filter((p): p is string => p !== null);
    if (parts.length > 0) out.push(parts.join(", ") + ".");
  }
  out.push(
    "A cota é da conta Google inteira: Gmail e Fotos contam junto com o Drive. Com ela cheia o `rclone bisync` " +
      "deixa de subir arquivo, e depois do cutover (#12359) isso para o `data/` entre as máquinas.",
  );
  out.push(
    "O que fazer (manual): esvaziar a lixeira do Drive, apagar o que não precisa (vídeos antigos da pasta YouTube " +
      "costumam ser o grosso) ou ampliar o plano (Google One — gasto, decisão do editor, #12355).",
  );
  return out.join("\n");
}

/** Binário do rclone: `RCLONE_BIN` do ambiente ou `~/.local/bin/rclone` (o
 * mesmo default do `scripts/systemd/gdrive-bisync.sh`). */
export function resolveRcloneBin(env: NodeJS.ProcessEnv = process.env): string {
  return env.RCLONE_BIN && env.RCLONE_BIN.length > 0 ? env.RCLONE_BIN : join(homedir(), ".local", "bin", "rclone");
}

export type ExecFileFn = (cmd: string, args: string[], opts: Record<string, unknown>) => unknown;

/** I/O — `rclone about {remote} --json`, só leitura. `null` em qualquer
 * falha (binário ausente, remote inexistente, rede, timeout, JSON ruim). */
export function readRcloneAbout(
  rcloneBin: string = resolveRcloneBin(),
  remote: string = DEFAULT_GDRIVE_REMOTE,
  execFn: ExecFileFn = execFileSync as unknown as ExecFileFn,
): GdriveAbout | null {
  try {
    const out = execFn(rcloneBin, ["about", remote, "--json"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 120_000,
    });
    return parseRcloneAboutJson(String(out ?? ""));
  } catch {
    return null;
  }
}
