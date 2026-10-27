/**
 * scripts/lib/onedrive-quota.ts (#10957)
 *
 * Lógica PURA do sinal de COTA do alarme do OneDrive
 * (`scripts/onedrive-sync-alarm.ts`). Achado de 23/10/2026: a conta ficou
 * sem espaço, o sync de `data/` parou e o alarme do #5548 (serviço +
 * canário) não dizia por quê — o canário até seguia "fresco" porque ele é
 * escrito localmente. A causa era vídeo: os `.mp4` de `data/editions`
 * somavam a maior parte dos 2,6 GB da pasta (edição com vídeo 0,4 a 0,7 GB,
 * sem vídeo ~0,1 GB).
 *
 * Dois sinais, os dois só de leitura:
 *
 *   1. **Log do daemon** (`journalctl --user -u onedrive`, I/O no caller) —
 *      linhas em que o cliente recusa upload por falta de espaço. É a
 *      evidência direta de "cota cheia". O número da cota não é lido:
 *      `onedrive --display-quota` recusa rodar com o daemon ativo, e usar o
 *      token do cliente pra chamar a Graph por fora arriscaria rotacionar o
 *      refresh token dele.
 *   2. **Uso local de `data/`** — soma dos tamanhos, descontando o que o
 *      `skip_file` efetivo já tira do sync (`lib/onedrive-skip-file.ts`),
 *      contra um orçamento de cota (`--quota-gb`). É o aviso ANTES de
 *      encher, e é dele que sai a causa no texto (maiores diretórios,
 *      maiores arquivos, quanto é `.mp4`).
 *
 * Limitação honesta: o uso local subestima a cota quando arquivos já
 * enviados saem do sync (o `skip_file` não apaga a cópia online, e apagar
 * manda pra lixeira, que conta na cota). Por isso o sinal 1 vence o 2.
 *
 * **Trava persistente (review do PR #11139):** o journal só é lido numa
 * janela curta, e o daemon só registra a recusa quando TENTA subir algo.
 * Janela sem recusa NÃO prova que a cota liberou. Por isso uma recusa vista
 * arma uma trava (`QuotaFullLatch`, persistida pelo caller) que mantém
 * `quota-full` até haver evidência positiva de espaço: na mesma janela, pelo
 * menos um upload concluído e nenhuma recusa. Journal ilegível ou janela sem
 * upload mantêm a trava. Só depois de solta a trava o veredito volta a vir
 * da medida local, que sozinha nunca solta um `quota-full` vindo do log.
 */
import { skipFileResyncStepsInline } from "./onedrive-skip-file.ts";

export const DEFAULT_QUOTA_WARN_PCT = 80;

/**
 * Premissa registrada (não medida): a conta é o plano gratuito de 5 GB.
 * `data/` tinha 4,8 GB quando o sync parou por falta de espaço (#10957),
 * o que só fecha com cota de ~5 GB. Override com `--quota-gb`.
 */
export const DEFAULT_QUOTA_GB = 5;

/** Frases do cliente `abraunegg/onedrive` (e respostas da Graph) que
 * indicam recusa por falta de espaço na conta. Casadas sem diferenciar
 * maiúsculas. */
export const QUOTA_FULL_LOG_PATTERNS: readonly RegExp[] = [
  /exceeds the available free space/i,
  /zero space available/i,
  /insufficient (free )?(space|storage)/i,
  /quota\s*limit\s*reached|quotaLimitReached/i,
  /quota (has been )?exceeded/i,
  /\b507\b.*insufficient storage/i,
];

/** Linha de upload CONCLUÍDO do cliente (`Uploading new file: x ... done.`,
 * `Uploading modified file x ... done`). É a evidência positiva de que a
 * conta aceitou bytes — o que solta a trava de `quota-full`. */
export const UPLOAD_SUCCESS_LOG_PATTERN = /\buploading\b.*\.\.\.\s*done\.?\s*$/i;

export interface QuotaLogScan {
  matched: boolean;
  matchCount: number;
  /** Última linha que casou (a mais recente), pra citar no texto. */
  sample: string | null;
  /** Uploads concluídos na janela (linha que casa a recusa nunca conta). */
  uploadSuccessCount: number;
}

export function scanOnedriveLogForQuotaFull(lines: readonly string[]): QuotaLogScan {
  let matchCount = 0;
  let uploadSuccessCount = 0;
  let sample: string | null = null;
  for (const line of lines) {
    if (QUOTA_FULL_LOG_PATTERNS.some((re) => re.test(line))) {
      matchCount++;
      sample = line.trim();
    } else if (UPLOAD_SUCCESS_LOG_PATTERN.test(line)) {
      uploadSuccessCount++;
    }
  }
  return { matched: matchCount > 0, matchCount, sample, uploadSuccessCount };
}

/** Trava persistida entre execuções (o caller grava em `data/`). `null` =
 * solta. */
export interface QuotaFullLatch {
  /** Quando a trava armou (1ª recusa vista). */
  since: string;
  /** Última vez que uma recusa foi vista no log. */
  lastRefusalAt: string;
  lastRefusalSample: string | null;
}

/** A janela tem a evidência positiva que solta a trava: upload concluído e
 * nenhuma recusa. Journal ilegível (`null`) nunca solta. */
export function logShowsSpaceFreed(log: QuotaLogScan | null): boolean {
  return log !== null && !log.matched && log.uploadSuccessCount > 0;
}

/** Pura. Recusa no log arma/renova; evidência de espaço solta; qualquer
 * outra coisa (janela muda, journal ilegível) mantém o que estava. */
export function nextQuotaFullLatch(
  prev: QuotaFullLatch | null,
  log: QuotaLogScan | null,
  now: Date,
): QuotaFullLatch | null {
  if (log?.matched) {
    return {
      since: prev?.since ?? now.toISOString(),
      lastRefusalAt: now.toISOString(),
      lastRefusalSample: log.sample,
    };
  }
  if (prev && logShowsSpaceFreed(log)) return null;
  return prev;
}

/** Lê o JSON da trava; qualquer forma inválida vira `null` + `invalid: true`
 * (o caller loga — trava corrompida não deve sumir em silêncio). */
export function parseQuotaFullLatch(raw: unknown): { latch: QuotaFullLatch | null; invalid: boolean } {
  if (raw === null) return { latch: null, invalid: false };
  const r = raw as Partial<QuotaFullLatch> | undefined;
  if (r && typeof r === "object" && typeof r.since === "string" && typeof r.lastRefusalAt === "string") {
    return {
      latch: {
        since: r.since,
        lastRefusalAt: r.lastRefusalAt,
        lastRefusalSample: typeof r.lastRefusalSample === "string" ? r.lastRefusalSample : null,
      },
      invalid: false,
    };
  }
  return { latch: null, invalid: true };
}

export interface DataUsageFile {
  /** Relativo a `data/`, com `/`. */
  relPath: string;
  sizeBytes: number;
}

export interface SizedEntry {
  path: string;
  bytes: number;
}

export interface DataUsageSummary {
  totalBytes: number;
  /** O que o cliente sobe (total menos o que o `skip_file` exclui). */
  syncedBytes: number;
  skippedBytes: number;
  mp4Bytes: number;
  /** `.mp4` que AINDA sincronizam (0 quando `*.mp4` está no skip_file). */
  mp4SyncedBytes: number;
  /** Diretórios que mais pesam no que sincroniza — 1º nível de `data/`,
   * e `editions/{AAMM}` separado (é onde o vídeo mora). */
  topDirs: SizedEntry[];
  topFiles: SizedEntry[];
}

function bucketOf(relPath: string): string {
  const parts = relPath.split("/");
  if (parts.length === 1) return "(raiz de data/)";
  if (parts[0] === "editions" && parts.length > 2) return `editions/${parts[1]}`;
  return parts[0];
}

export function summarizeDataUsage(
  files: readonly DataUsageFile[],
  isSkipped: (fileName: string) => boolean,
  topN = 5,
): DataUsageSummary {
  let totalBytes = 0;
  let syncedBytes = 0;
  let mp4Bytes = 0;
  let mp4SyncedBytes = 0;
  const dirs = new Map<string, number>();
  const synced: SizedEntry[] = [];
  for (const f of files) {
    totalBytes += f.sizeBytes;
    const name = f.relPath.split("/").pop() ?? f.relPath;
    const isMp4 = /\.mp4$/i.test(name);
    if (isMp4) mp4Bytes += f.sizeBytes;
    if (isSkipped(name)) continue;
    syncedBytes += f.sizeBytes;
    if (isMp4) mp4SyncedBytes += f.sizeBytes;
    const b = bucketOf(f.relPath);
    dirs.set(b, (dirs.get(b) ?? 0) + f.sizeBytes);
    synced.push({ path: f.relPath, bytes: f.sizeBytes });
  }
  const byBytes = (a: SizedEntry, b: SizedEntry) => b.bytes - a.bytes || a.path.localeCompare(b.path);
  return {
    totalBytes,
    syncedBytes,
    skippedBytes: totalBytes - syncedBytes,
    mp4Bytes,
    mp4SyncedBytes,
    topDirs: [...dirs].map(([path, bytes]) => ({ path, bytes })).sort(byBytes).slice(0, topN),
    topFiles: synced.sort(byBytes).slice(0, topN),
  };
}

export type OnedriveQuotaVerdict = "ok" | "quota-near" | "quota-full" | "unmeasured";

export interface OnedriveQuotaEvaluation {
  verdict: OnedriveQuotaVerdict;
  quotaBytes: number;
  warnPct: number;
  usage: DataUsageSummary | null;
  log: QuotaLogScan | null;
  /** `*.mp4` está no skip_file efetivo? `null` = config não lida. */
  mp4Excluded: boolean | null;
  /** Trava de `quota-full` depois desta execução (`null` = solta). */
  latch: QuotaFullLatch | null;
}

/**
 * Pura. Ordem: recusa por espaço no log → `quota-full` (mesmo sem medir
 * `data/`); trava armada sem evidência de espaço liberado → `quota-full`;
 * sem uso medido → `unmeasured`; uso sincronizado ≥ cota → `quota-full`;
 * ≥ `warnPct`% → `quota-near`; senão `ok`.
 *
 * `latch` é a trava da execução ANTERIOR; a da próxima sai em
 * `result.latch` e o caller persiste. Sem `latch`/`now` (testes antigos),
 * vale `null`/agora.
 */
export function evaluateOnedriveQuota(input: {
  log: QuotaLogScan | null;
  usage: DataUsageSummary | null;
  quotaBytes: number;
  warnPct?: number;
  mp4Excluded: boolean | null;
  latch?: QuotaFullLatch | null;
  now?: Date;
}): OnedriveQuotaEvaluation {
  const warnPct = input.warnPct ?? DEFAULT_QUOTA_WARN_PCT;
  const latch = nextQuotaFullLatch(input.latch ?? null, input.log, input.now ?? new Date());
  const base = { quotaBytes: input.quotaBytes, warnPct, usage: input.usage, log: input.log, mp4Excluded: input.mp4Excluded, latch };
  if (input.log?.matched) return { verdict: "quota-full", ...base };
  if (latch) return { verdict: "quota-full", ...base };
  if (!input.usage) return { verdict: "unmeasured", ...base };
  if (input.usage.syncedBytes >= input.quotaBytes) return { verdict: "quota-full", ...base };
  if (input.usage.syncedBytes >= (input.quotaBytes * warnPct) / 100) return { verdict: "quota-near", ...base };
  return { verdict: "ok", ...base };
}

export function isAlarmingQuotaVerdict(v: OnedriveQuotaVerdict): boolean {
  return v === "quota-full" || v === "quota-near";
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(0)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${bytes} B`;
}

/**
 * Texto do alarme com a CAUSA (pedido do editor na #10957): o que está
 * ocupando, quanto disso é vídeo, e o passo que resolve.
 */
export function buildQuotaCauseText(ev: OnedriveQuotaEvaluation): string {
  const out: string[] = [];
  if (ev.verdict === "quota-full") {
    out.push(
      ev.log?.matched
        ? `O cliente do OneDrive está recusando upload por falta de espaço na conta (${ev.log.matchCount} linha(s) no log; última: "${ev.log.sample}"). O sync de data/ parou de propagar.`
        : ev.latch
          ? `O cliente do OneDrive recusou upload por falta de espaço (última recusa vista em ${ev.latch.lastRefusalAt}: "${ev.latch.lastRefusalSample ?? "?"}") e desde então o log não mostrou nenhum upload concluído. Sem essa evidência a cota segue tratada como cheia — janela sem recusa não prova que liberou.`
          : `data/ sincroniza ${formatBytes(ev.usage?.syncedBytes ?? 0)}, acima do orçamento de cota de ${formatBytes(ev.quotaBytes)}. O sync vai parar (ou já parou).`,
    );
  } else if (ev.verdict === "quota-near") {
    out.push(
      `data/ sincroniza ${formatBytes(ev.usage!.syncedBytes)}, ${Math.round((ev.usage!.syncedBytes / ev.quotaBytes) * 100)}% do orçamento de cota de ${formatBytes(ev.quotaBytes)} (aviso a partir de ${ev.warnPct}%).`,
    );
  } else {
    out.push(`Cota: verdict=${ev.verdict}.`);
  }

  const u = ev.usage;
  if (u) {
    out.push("");
    out.push(
      `Causa provável — total em disco ${formatBytes(u.totalBytes)}, sincronizando ${formatBytes(u.syncedBytes)} (${formatBytes(u.skippedBytes)} fora do sync pelo skip_file).`,
    );
    out.push(
      `Vídeo (.mp4): ${formatBytes(u.mp4Bytes)} em disco, ${formatBytes(u.mp4SyncedBytes)} ainda sincronizando.`,
    );
    if (u.topDirs.length > 0) {
      out.push(`Maiores diretórios no sync: ${u.topDirs.map((d) => `${d.path} ${formatBytes(d.bytes)}`).join("; ")}.`);
    }
    if (u.topFiles.length > 0) {
      out.push(`Maiores arquivos no sync: ${u.topFiles.map((f) => `${f.path} ${formatBytes(f.bytes)}`).join("; ")}.`);
    }
  }

  out.push("");
  out.push("O que fazer (passos manuais, docs/onedrive-sync-setup.md item 6):");
  if (ev.mp4Excluded !== true) {
    out.push(
      `- \`*.mp4\` ainda não está no skip_file: \`npx tsx scripts/onedrive-skip-file-config.ts --apply\` e depois (mudar skip_file exige --resync, #11256) ${skipFileResyncStepsInline()}.`,
    );
  }
  out.push(
    "- Vídeos velhos: `npx tsx scripts/prune-edition-videos.ts` lista o que a retenção por data apagaria; `--apply` apaga.",
  );
  out.push(
    "- O que já subiu continua ocupando cota online, e o que é apagado vai pra lixeira (que também conta): apagar os .mp4 no OneDrive web e esvaziar a lixeira.",
  );
  return out.join("\n");
}
