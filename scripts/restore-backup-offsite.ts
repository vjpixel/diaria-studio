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
 *   doppler run -- npx tsx scripts/restore-backup-offsite.ts --file ./x.tar.gz.enc --out /tmp/r   # arquivo já baixado
 *   ... --key-env BACKUP_ENCRYPTION_KEY_OLD   # chave antiga, depois de uma rotação
 *
 * `--out` precisa estar vazia ou não existir (nunca sobrescreve um snapshot
 * em `data/beehiiv-backup/` por engano). Restaurar em `data/` é passo manual
 * depois de conferir o conteúdo.
 *
 * Exit: 0 ok, 1 falha (download, chave, autenticação, extração), 2 uso inválido.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";

import { loadProjectEnv } from "./lib/env-loader.ts";
import { getArg, hasFlag, isMainModule } from "./lib/cli-args.ts";
import { runCli } from "./lib/cli-exit.ts";
import { decryptBackup, parseBackupKey } from "./lib/backup-offsite-crypto.ts";
import {
  dateFromOffsiteKey,
  extractTarGz,
  formatBytes,
  getOffsiteObject,
  gunzip,
  listOffsiteObjects,
  loadOffsiteAccess,
  OFFSITE_KINDS,
  offsitePrefix,
  systemTar,
  type OffsiteKind,
  type TarRunner,
} from "./lib/backup-offsite.ts";
import type { R2UploadDeps } from "./lib/r2-object-upload.ts";

const LOG = "[restore-backup-offsite]";

/** Tipo pelo sufixo (vale pra chave do bucket e pra arquivo local já baixado). */
export function kindFromKey(key: string): OffsiteKind | null {
  if (key.endsWith(".tar.gz.enc")) return "beehiiv";
  if (key.endsWith(".jsonl.gz.enc")) return "eia-votes";
  return null;
}

/**
 * Decifra e grava em `outDir`. Devolve o que foi escrito (pra log/teste).
 * Lança em qualquer falha; `outDir` não vazio é recusado.
 */
export function restoreBlob(blob: Buffer, key: Buffer, kind: OffsiteKind, name: string, outDir: string, tar: TarRunner = systemTar): string {
  if (existsSync(outDir) && readdirSync(outDir).length > 0) throw new Error(`--out ${outDir} não está vazia — escolha uma pasta nova`);
  const plain = decryptBackup(blob, key);
  mkdirSync(outDir, { recursive: true });
  if (kind === "beehiiv") {
    extractTarGz(plain, outDir, tar);
    return outDir;
  }
  const date = dateFromOffsiteKey(name) ?? "sem-data";
  const target = join(outDir, `eia-votes-${date}.jsonl`);
  writeFileSync(target, gunzip(plain));
  return target;
}

export async function main(argv: string[] = process.argv.slice(2), r2: R2UploadDeps = { fetch: (u, i) => fetch(u, i), now: () => new Date() }): Promise<number> {
  loadProjectEnv();
  const env = process.env;
  const file = getArg(argv, "file");
  const latest = getArg(argv, "latest");
  let objKey = getArg(argv, "key");
  const outArg = getArg(argv, "out");
  const keyEnv = getArg(argv, "key-env") || "BACKUP_ENCRYPTION_KEY";

  if (hasFlag(argv, "list")) {
    const acc = loadOffsiteAccess(env);
    if (!acc.ready) {
      console.error(`${LOG} credencial ausente: ${acc.missing.join(", ")}`);
      return 1;
    }
    for (const kind of OFFSITE_KINDS) {
      const objs = await listOffsiteObjects(r2, acc.access, offsitePrefix(kind));
      objs.sort((a, b) => a.key.localeCompare(b.key));
      console.log(`${kind}: ${objs.length} objeto(s)`);
      for (const o of objs) console.log(`  ${o.key}  ${o.lastModified.toISOString()}`);
    }
    return 0;
  }

  if ([file, latest, objKey].filter(Boolean).length !== 1 || !outArg) {
    console.error(`${LOG} uso: (--key K | --latest beehiiv|eia-votes | --file F) --out DIR [--key-env NOME] | --list`);
    return 2;
  }
  let encKey: Buffer;
  try {
    encKey = parseBackupKey(env[keyEnv], keyEnv);
  } catch (e) {
    console.error(`${LOG} ${(e as Error).message}`);
    return 1;
  }
  const outDir = resolve(outArg);

  let blob: Buffer;
  let name: string;
  if (file) {
    blob = readFileSync(resolve(file));
    name = file;
  } else {
    const acc = loadOffsiteAccess(env);
    if (!acc.ready) {
      console.error(`${LOG} credencial ausente: ${acc.missing.join(", ")}`);
      return 1;
    }
    if (latest) {
      if (latest !== "beehiiv" && latest !== "eia-votes") {
        console.error(`${LOG} --latest inválido: "${latest}"`);
        return 2;
      }
      const objs = await listOffsiteObjects(r2, acc.access, offsitePrefix(latest));
      if (objs.length === 0) {
        console.error(`${LOG} nenhum objeto em ${offsitePrefix(latest)}`);
        return 1;
      }
      objKey = objs.reduce((a, b) => (b.lastModified > a.lastModified ? b : a)).key;
    }
    blob = await getOffsiteObject(r2, acc.access, objKey);
    name = objKey;
    console.log(`${LOG} baixado ${objKey}: ${formatBytes(blob.length)}`);
  }
  const kind = kindFromKey(name);
  if (!kind) {
    console.error(`${LOG} não sei o tipo de "${name}" (esperado beehiiv/….tar.gz.enc ou eia-votes/….jsonl.gz.enc)`);
    return 2;
  }
  const written = restoreBlob(blob, encKey, kind, name, outDir);
  console.log(`${LOG} restaurado (${kind}) em ${written}`);
  return 0;
}

if (isMainModule(import.meta.url)) {
  runCli(() => main(), { onError: (e) => console.error(`${LOG} erro:`, e instanceof Error ? e.message : String(e)) });
}
