#!/usr/bin/env node
/**
 * scripts/restore-backup-offsite.ts (#11413)
 *
 * Restaura uma cópia off-site do bucket R2 privado `diaria-backup`
 * (`scripts/backup-offsite.ts`): baixa pela API S3 assinada, autentica e
 * decifra (AES-256-GCM, `BACKUP_ENCRYPTION_KEY`) e extrai numa pasta.
 *
 *   beehiiv/{data}.tar.gz.enc     → o diretório do snapshot, extraído em --out
 *   eia-votes/{data}.jsonl.gz.enc → --out/eia-votes-{data}.jsonl
 *
 * Uso:
 *   doppler run -- npx tsx scripts/restore-backup-offsite.ts --list
 *   doppler run -- npx tsx scripts/restore-backup-offsite.ts --latest beehiiv --out /tmp/restore-bh
 *   doppler run -- npx tsx scripts/restore-backup-offsite.ts --key beehiiv/2026-11-08.tar.gz.enc --out /tmp/restore-bh
 *   doppler run -- npx tsx scripts/restore-backup-offsite.ts --file ./2026-11-08.tar.gz.enc --out /tmp/r   # arquivo já baixado, nome original
 *   ... --key-env BACKUP_ENCRYPTION_KEY_OLD   # chave antiga, depois de uma rotação
 *
 * `--latest` escolhe pela data da chave (não pelo `LastModified`, que só
 * desempata): reenviar uma data antiga não a torna "a mais recente".
 *
 * `--out` precisa estar vazia ou não existir (nunca sobrescreve um snapshot
 * em `data/beehiiv-backup/` por engano). A extração vai pra uma pasta
 * temporária ao lado e só é renomeada pra `--out` se der certo: falha de
 * decifra ou do `tar` não deixa nada pela metade. Restaurar em `data/` é passo
 * manual depois de conferir o conteúdo.
 *
 * Formato v2 (#11961): o blob é autenticado junto com `{tipo}/{data}` tirado
 * da chave do objeto. No `--file`, o tipo e a data saem do NOME do arquivo:
 * um arquivo renomeado pra outra data/tipo não decifra (é a proteção contra
 * rollback no bucket). Mantenha o nome original (`2026-11-08.tar.gz.enc`).
 * Backups v1 (gravados antes da mudança) seguem restaurando, com aviso.
 *
 * Exit: 0 ok, 1 falha (download, chave, autenticação, extração), 2 uso inválido.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { resolve, join } from "node:path";

import { loadProjectEnv } from "./lib/env-loader.ts";
import { getArg, hasFlag, isMainModule } from "./lib/cli-args.ts";
import { runCli } from "./lib/cli-exit.ts";
import { BACKUP_KEY_ENV, backupFormatVersion, decryptBackup, parseBackupKey, type BackupKey } from "./lib/backup-offsite-crypto.ts";
import {
  dateFromOffsiteKey,
  extractTarGz,
  formatBytes,
  getOffsiteObject,
  gunzip,
  isOffsiteKind,
  kindFromKey,
  latestOffsiteObject,
  listOffsiteObjects,
  loadOffsiteAccess,
  OFFSITE_KINDS,
  offsiteBindingFromName,
  offsitePrefix,
  systemTar,
  type OffsiteKind,
  type TarRunner,
} from "./lib/backup-offsite.ts";
import type { R2UploadDeps } from "./lib/r2-object-upload.ts";

export { kindFromKey };

const LOG = "[restore-backup-offsite]";

/**
 * Decifra e grava em `outDir`. Devolve o que foi escrito (pra log/teste).
 * Lança em qualquer falha sem deixar `outDir` criada pela metade; `outDir`
 * não vazia é recusada. `name` (chave do objeto ou nome do arquivo) dá o
 * vínculo `{tipo}/{data}` que o formato v2 autentica (#11961).
 */
export function restoreBlob(blob: Buffer, key: BackupKey, kind: OffsiteKind, name: string, outDir: string, tar: TarRunner = systemTar): string {
  const existed = existsSync(outDir);
  if (existed && readdirSync(outDir).length > 0) throw new Error(`--out ${outDir} não está vazia — escolha uma pasta nova`);
  const plain = decryptBackup(blob, key, offsiteBindingFromName(name));
  if (kind === "eia-votes") {
    const jsonl = gunzip(plain);
    mkdirSync(outDir, { recursive: true });
    const target = join(outDir, `eia-votes-${dateFromOffsiteKey(name) ?? "sem-data"}.jsonl`);
    writeFileSync(target, jsonl);
    return target;
  }
  const tmp = `${outDir}.restore-tmp-${randomBytes(4).toString("hex")}`;
  mkdirSync(tmp, { recursive: true });
  try {
    extractTarGz(plain, tmp, tar);
  } catch (e) {
    rmSync(tmp, { recursive: true, force: true });
    throw e;
  }
  if (existed) rmdirSync(outDir);
  renameSync(tmp, outDir);
  return outDir;
}

export interface RestoreMainDeps {
  env?: Record<string, string | undefined>;
  r2?: R2UploadDeps;
  tar?: TarRunner;
  log?: (m: string) => void;
  skipEnvLoad?: boolean;
}

export async function main(argv: string[] = process.argv.slice(2), deps: RestoreMainDeps = {}): Promise<number> {
  if (!deps.skipEnvLoad) loadProjectEnv();
  const env = deps.env ?? process.env;
  const r2 = deps.r2 ?? { fetch: (u, i) => fetch(u, i), now: () => new Date() };
  const log = deps.log ?? ((m: string) => console.log(m));
  const err = deps.log ?? ((m: string) => console.error(m));
  const file = getArg(argv, "file");
  const latest = getArg(argv, "latest");
  let objKey = getArg(argv, "key");
  const outArg = getArg(argv, "out");
  const keyEnv = getArg(argv, "key-env") || BACKUP_KEY_ENV;

  if (hasFlag(argv, "list")) {
    const acc = loadOffsiteAccess(env);
    if (!acc.ready) {
      err(`${LOG} credencial ausente: ${acc.missing.join(", ")}`);
      return 1;
    }
    for (const kind of OFFSITE_KINDS) {
      const objs = await listOffsiteObjects(r2, acc.access, offsitePrefix(kind));
      objs.sort((a, b) => a.key.localeCompare(b.key));
      log(`${kind}: ${objs.length} objeto(s)`);
      for (const o of objs) log(`  ${o.key}  ${o.lastModified.toISOString()}`);
    }
    return 0;
  }

  if ([file, latest, objKey].filter(Boolean).length !== 1 || !outArg) {
    err(`${LOG} uso: (--key K | --latest beehiiv|eia-votes | --file F) --out DIR [--key-env NOME] | --list`);
    return 2;
  }
  if (latest && !isOffsiteKind(latest)) {
    err(`${LOG} --latest inválido: "${latest}"`);
    return 2;
  }
  const name0 = file || objKey || offsitePrefix(latest as OffsiteKind);
  if (!latest && !kindFromKey(name0)) {
    err(`${LOG} não sei o tipo de "${name0}" (esperado beehiiv/….tar.gz.enc ou eia-votes/….jsonl.gz.enc)`);
    return 2;
  }
  let encKey: BackupKey;
  try {
    encKey = parseBackupKey(env[keyEnv], keyEnv);
  } catch (e) {
    err(`${LOG} ${(e as Error).message}`);
    return 1;
  }
  const outDir = resolve(outArg);

  try {
    let blob: Buffer;
    let name: string;
    if (file) {
      blob = readFileSync(resolve(file));
      name = file;
    } else {
      const acc = loadOffsiteAccess(env);
      if (!acc.ready) {
        err(`${LOG} credencial ausente: ${acc.missing.join(", ")}`);
        return 1;
      }
      if (latest) {
        const newest = latestOffsiteObject(await listOffsiteObjects(r2, acc.access, offsitePrefix(latest as OffsiteKind)));
        if (!newest) {
          err(`${LOG} nenhum objeto em ${offsitePrefix(latest as OffsiteKind)}`);
          return 1;
        }
        objKey = newest.key;
      }
      blob = await getOffsiteObject(r2, acc.access, objKey);
      name = objKey;
      log(`${LOG} baixado ${objKey}: ${formatBytes(blob.length)}`);
    }
    const kind = kindFromKey(name)!;
    if (backupFormatVersion(blob) === 1) log(`${LOG} aviso: backup no formato v1 (sem vínculo à chave do objeto, #11961): autentica o conteúdo, mas não detecta rollback`);
    const written = restoreBlob(blob, encKey, kind, name, outDir, deps.tar ?? systemTar);
    log(`${LOG} restaurado (${kind}) em ${written}`);
    return 0;
  } catch (e) {
    err(`${LOG} falhou: ${(e as Error).message}`);
    return 1;
  }
}

if (isMainModule(import.meta.url)) {
  runCli(() => main(), { onError: (e) => console.error(`${LOG} erro:`, e instanceof Error ? e.message : String(e)) });
}
