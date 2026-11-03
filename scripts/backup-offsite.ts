#!/usr/bin/env node
/**
 * scripts/backup-offsite.ts (#11413)
 *
 * 2º passo da task `Diaria-Beehiiv-Backup` (domingo 03:00 BRT): depois do
 * snapshot local de `backup-beehiiv.ts`, envia uma cópia compactada e
 * criptografada pro bucket R2 PRIVADO `diaria-backup`:
 *
 *   beehiiv/{AAAA-MM-DD}.tar.gz.enc       o diretório do snapshot do dia
 *   eia-votes/{AAAA-MM-DD}.jsonl.gz.enc   dump das chaves vote:/score:/correct: do KV POLL
 *
 * Por que um script separado chamado pela MESMA task, e não um passo dentro
 * de `backup-beehiiv.ts`: o runner da task roda os passos em sequência sempre
 * (um passo que falha não cancela o seguinte), então o snapshot local continua
 * valendo mesmo se o off-site falhar, e o off-site falha com exit próprio (a
 * unit fica `failed`) sem mexer no exit do snapshot. `backup-beehiiv.ts` fica
 * sem dependência de R2/KV, e o off-site pode rodar à mão sobre um snapshot
 * antigo (`--date … --only beehiiv`). Nenhum timer novo.
 *
 * O snapshot só sobe se for "bem-sucedido": diretório do dia existe, tem
 * `manifest.json` e `isSubscribersSnapshotUsable` aprova. Senão o upload da
 * Beehiiv é pulado. Na execução agendada (sem `--date`) o pulo vira achado
 * (`notifyEditor`, fingerprint `backup-offsite-skipped:beehiiv`), mas o exit
 * continua 0: não houve falha do off-site, o snapshot é que não existiu. Não
 * caímos no snapshot mais recente: a task roda às 06:00 UTC e os dois passos
 * usam a mesma data UTC, então não há virada de dia a cobrir, e reenviar o
 * snapshot da semana passada esconderia que o desta semana falhou.
 *
 * Os votos do KV são sempre os de AGORA, então só sobem com a data de hoje:
 * `--date` diferente de hoje exige `--only beehiiv` (senão os votos ao vivo
 * sobrescreveriam o dump daquela data no bucket).
 *
 * Falha de upload/dump/credencial NÃO é silenciosa: vira issue de alarme pelo
 * portão `notifyEditor` (`scripts/lib/editor-notify.ts`, severidade `acao`) e
 * exit 1. Cada upload loga o tamanho (a faixa grátis do R2 é 10 GB por conta,
 * divididos com os verticais e as imagens públicas).
 *
 * Uso:
 *   npx tsx scripts/backup-offsite.ts                       # snapshot de hoje (UTC) + votos
 *   npx tsx scripts/backup-offsite.ts --date 2026-11-08 --only beehiiv
 *   npx tsx scripts/backup-offsite.ts --only eia-votes
 *   npx tsx scripts/backup-offsite.ts --root /outro/beehiiv-backup
 *   npx tsx scripts/backup-offsite.ts --dry-run             # empacota, cifra e mede; NÃO envia nem alarma
 *
 * Env — no Doppler `diaria-studio/dev` E no `.env` do 300 (a task systemd lê
 * o `.env`, não roda sob `doppler run`); nunca no repo:
 *   R2_ACCOUNT_ID, R2_BACKUP_ACCESS_KEY_ID, R2_BACKUP_SECRET_ACCESS_KEY  bucket diaria-backup
 *   BACKUP_ENCRYPTION_KEY                                                32 bytes em base64
 *   CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN                          leitura do KV POLL (REST)
 * Consequência aceita: a chave de cifra fica em texto no `.env` da mesma
 * máquina que guarda os snapshots em claro — ela protege a cópia no bucket,
 * não o 300.
 *
 * Restauração: `scripts/restore-backup-offsite.ts`.
 * Exit: 0 ok (ou nada a fazer), 1 falha (alarme registrado), 2 uso inválido.
 */
import { existsSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { loadProjectEnv } from "./lib/env-loader.ts";
import { getArg, hasFlag, isMainModule } from "./lib/cli-args.ts";
import { runCli } from "./lib/cli-exit.ts";
import { notifyEditor, type NotifyEditorFinding, type NotifyEditorResult } from "./lib/editor-notify.ts";
import { encryptBackup } from "./lib/backup-offsite-crypto.ts";
import { isSubscribersSnapshotUsable, readBackupManifest } from "./lib/beehiiv-backup-snapshots.ts";
import { createKvRestOps } from "./lib/cloudflare-kv-rest.ts";
import {
  describeKvDump,
  dumpKvPrefixes,
  formatBytes,
  gzip,
  isOffsiteKind,
  kvRestDumpSource,
  loadOffsiteConfig,
  offsiteObjectKey,
  putAndVerifyOffsite,
  POLL_KV_NAMESPACE_ID_DEFAULT,
  systemTar,
  tarGzDirectory,
  type KvDumpSource,
  type OffsiteKind,
  type TarRunner,
} from "./lib/backup-offsite.ts";
import type { R2UploadDeps } from "./lib/r2-object-upload.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_BACKUP_ROOT = resolve(ROOT, "data/beehiiv-backup");
const LOG = "[backup-offsite]";

export interface OffsiteStepResult {
  kind: OffsiteKind;
  status: "uploaded" | "dry-run" | "skipped" | "failed";
  key?: string;
  bytes?: number;
  etagVerified?: boolean;
  detail?: string;
}

export interface RunOffsiteOpts {
  date: string;
  only: OffsiteKind | null;
  dryRun: boolean;
  backupRoot: string;
}

export interface RunOffsiteDeps {
  env: Record<string, string | undefined>;
  r2: R2UploadDeps;
  tar?: TarRunner;
  /** Fonte do dump do KV; default REST com CLOUDFLARE_ACCOUNT_ID/CLOUDFLARE_API_TOKEN. */
  kvSource?: (env: Record<string, string | undefined>) => KvDumpSource;
  log?: (m: string) => void;
}

export function defaultKvSource(env: Record<string, string | undefined>): KvDumpSource {
  const accountId = env.CLOUDFLARE_ACCOUNT_ID?.trim();
  const token = env.CLOUDFLARE_API_TOKEN?.trim();
  if (!accountId || !token) throw new Error("CLOUDFLARE_ACCOUNT_ID/CLOUDFLARE_API_TOKEN ausentes (leitura do KV POLL)");
  const cfg = { accountId, token, namespaceId: env.POLL_KV_NAMESPACE_ID?.trim() || POLL_KV_NAMESPACE_ID_DEFAULT };
  return kvRestDumpSource(cfg, createKvRestOps(cfg));
}

/**
 * Motivo pelo qual o snapshot do dia NÃO é "bem-sucedido", ou `null` se for.
 */
export function snapshotNotReadyReason(backupRoot: string, date: string): string | null {
  if (!existsSync(join(backupRoot, date))) return `snapshot ${date} não existe em ${backupRoot}`;
  if (!readBackupManifest(backupRoot, date)) return `snapshot ${date} sem manifest.json (backup não terminou)`;
  const u = isSubscribersSnapshotUsable(backupRoot, date);
  return u.usable ? null : `snapshot ${date} inutilizável: ${u.reason}`;
}

/**
 * Executa os passos (Beehiiv e votos) e devolve o resultado de cada um. Não
 * lança por falha de um passo: falha vira `status: "failed"`. Credencial
 * ausente/inválida falha os dois (nada sobe sem cifra nem sem credencial).
 */
export async function runOffsiteBackup(opts: RunOffsiteOpts, deps: RunOffsiteDeps): Promise<OffsiteStepResult[]> {
  const log = deps.log ?? ((m: string) => console.log(m));
  const kinds: OffsiteKind[] = opts.only ? [opts.only] : ["beehiiv", "eia-votes"];
  const cfg = loadOffsiteConfig(deps.env);
  if (!cfg.ready) {
    const detail = `configuração ausente/inválida: ${cfg.missing.join("; ")}`;
    return kinds.map((kind) => ({ kind, status: "failed", detail }));
  }

  const results: OffsiteStepResult[] = [];
  for (const kind of kinds) {
    const key = offsiteObjectKey(kind, opts.date);
    try {
      let plain: Buffer;
      let what: string;
      if (kind === "beehiiv") {
        const notReady = snapshotNotReadyReason(opts.backupRoot, opts.date);
        if (notReady) {
          log(`${LOG} beehiiv: pulado — ${notReady}`);
          results.push({ kind, status: "skipped", key, detail: notReady });
          continue;
        }
        plain = tarGzDirectory(join(opts.backupRoot, opts.date), deps.tar ?? systemTar);
        what = `tar.gz de ${opts.date}`;
      } else {
        const src = (deps.kvSource ?? defaultKvSource)(deps.env);
        const dump = await dumpKvPrefixes(src);
        plain = gzip(Buffer.from(dump.jsonl, "utf8"));
        what = describeKvDump(dump);
      }
      const enc = encryptBackup(plain, cfg.key);
      if (opts.dryRun) {
        log(`${LOG} ${kind}: --dry-run, ${what}: ${formatBytes(plain.length)} compactado, ${formatBytes(enc.length)} cifrado → ${key} (NÃO enviado)`);
        results.push({ kind, status: "dry-run", key, bytes: enc.length });
        continue;
      }
      const put = await putAndVerifyOffsite(deps.r2, cfg.access, key, enc);
      log(`${LOG} ${kind}: enviado ${key} — ${formatBytes(put.bytes)} (${put.bytes} bytes), ${what}, ETag ${put.etagVerified ? "confere" : "não comparável, tamanho confere"}`);
      results.push({ kind, status: "uploaded", key, bytes: put.bytes, etagVerified: put.etagVerified });
    } catch (e) {
      const detail = (e as Error).message;
      log(`${LOG} ${kind}: FALHOU — ${detail}`);
      results.push({ kind, status: "failed", key, detail });
    }
  }
  return results;
}

/** Fingerprint estável por tipo: a mesma issue de alarme é reaproveitada semana a semana. */
export const offsiteFailureFingerprint = (kind: OffsiteKind) => `backup-offsite-failed:${kind}`;
export const offsiteSkippedFingerprint = (kind: OffsiteKind) => `backup-offsite-skipped:${kind}`;

export function buildOffsiteFailureAlarm(r: OffsiteStepResult, date: string): { subject: string; body: string } {
  const skipped = r.status === "skipped";
  return {
    subject: skipped ? `⚠️ Backup off-site (${r.kind}) pulado em ${date}: snapshot não pronto` : `⚠️ Backup off-site (${r.kind}) falhou em ${date}`,
    body: [
      "Alarme automático do 2º passo da task Diaria-Beehiiv-Backup (#11413).",
      "",
      `Tipo: ${r.kind}`,
      `Objeto: ${r.key ?? "n/d"} (bucket R2 privado diaria-backup)`,
      `${skipped ? "Motivo" : "Erro"}: ${r.detail ?? "n/d"}`,
      "",
      skipped
        ? "O snapshot do dia não existe ou não é utilizável, então nada subiu pro bucket. Rodar o backup local e depois o off-site."
        : "O snapshot local em data/beehiiv-backup/ não depende deste passo e continua valendo; o que falta é a cópia fora do OneDrive.",
      "",
      "Para repetir: doppler run -- npx tsx scripts/backup-offsite.ts" + (r.kind === "eia-votes" ? " --only eia-votes" : ` --date ${date} --only beehiiv`),
      "Detalhes: scripts/backup-offsite.ts, docs/beehiiv-backup-setup.md.",
    ].join("\n"),
  };
}

export interface OffsiteMainDeps {
  env?: Record<string, string | undefined>;
  r2?: R2UploadDeps;
  tar?: TarRunner;
  kvSource?: (env: Record<string, string | undefined>) => KvDumpSource;
  notify?: (finding: NotifyEditorFinding, opts: { cwd: string }) => Promise<NotifyEditorResult>;
  now?: () => Date;
  log?: (m: string) => void;
  /** Não carrega o `.env` (teste). */
  skipEnvLoad?: boolean;
}

export async function main(argv: string[] = process.argv.slice(2), deps: OffsiteMainDeps = {}): Promise<number> {
  if (!deps.skipEnvLoad) loadProjectEnv();
  const log = deps.log ?? ((m: string) => console.log(m));
  const err = deps.log ?? ((m: string) => console.error(m));
  const today = (deps.now ?? (() => new Date()))().toISOString().slice(0, 10);
  const dateArg = getArg(argv, "date");
  const date = dateArg || today;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    err(`${LOG} --date inválido: "${date}"`);
    return 2;
  }
  const onlyRaw = getArg(argv, "only");
  if (onlyRaw && !isOffsiteKind(onlyRaw)) {
    err(`${LOG} --only inválido: "${onlyRaw}" (beehiiv | eia-votes)`);
    return 2;
  }
  const only = (onlyRaw || null) as OffsiteKind | null;
  if (date !== today && only !== "beehiiv") {
    err(`${LOG} --date ${date} não é hoje (${today}): os votos do KV são os de agora e sobrescreveriam o dump daquela data. Use --only beehiiv.`);
    return 2;
  }
  const opts: RunOffsiteOpts = { date, only, dryRun: hasFlag(argv, "dry-run"), backupRoot: getArg(argv, "root") || DEFAULT_BACKUP_ROOT };
  const results = await runOffsiteBackup(opts, {
    env: deps.env ?? process.env,
    r2: deps.r2 ?? { fetch: (u, i) => fetch(u, i), now: () => new Date() },
    tar: deps.tar,
    kvSource: deps.kvSource,
    log,
  });
  const failed = results.filter((r) => r.status === "failed");
  if (opts.dryRun) {
    for (const r of failed) err(`${LOG} --dry-run: falharia (${r.kind}): ${r.detail} — sem alarme no dry-run`);
    return failed.length ? 1 : 0;
  }
  // Pulo do Beehiiv na execução agendada (sem --date) também é achado; com
  // --date explícito, quem rodou à mão já vê o log.
  const alarms = [...failed, ...(dateArg ? [] : results.filter((r) => r.status === "skipped"))];
  const notifyFn = deps.notify ?? ((f, o) => notifyEditor(f, o));
  for (const r of alarms) {
    const { subject, body } = buildOffsiteFailureAlarm(r, date);
    const fingerprint = r.status === "skipped" ? offsiteSkippedFingerprint(r.kind) : offsiteFailureFingerprint(r.kind);
    // #11413 review: um alarme que falha não impede o do outro tipo.
    try {
      const res = await notifyFn({ check: "backup-offsite", fingerprint, severity: "acao", subject, body }, { cwd: ROOT });
      if (res.issue?.action === "failed") err(`${LOG} ensureAlarmIssue falhou (${r.kind}): ${res.issue.error}`);
      else err(`${LOG} alarme registrado (${r.kind}, ${fingerprint}, issue #${res.issue?.issueNumber ?? "?"})`);
    } catch (e) {
      err(`${LOG} notifyEditor lançou (${r.kind}): ${(e as Error).message}`);
    }
  }
  return failed.length ? 1 : 0;
}

if (isMainModule(import.meta.url)) {
  runCli(() => main(), { onError: (e) => console.error(`${LOG} erro:`, e instanceof Error ? e.message : String(e)) });
}
