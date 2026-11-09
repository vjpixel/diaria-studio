/**
 * #11961 item 4 — formato v2 do backup off-site cifrado: `{tipo}/{data}` no
 * AAD amarra o blob à chave do objeto (detecta rollback feito por quem tem a
 * credencial R/W do bucket), e os backups v1 já gravados seguem legíveis.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

import {
  BACKUP_FORMAT_VERSION,
  backupBinding,
  backupFormatVersion,
  backupKeyFromBytes,
  decryptBackup,
  encryptBackup,
  encryptBackupV1ForTest,
  type BackupBinding,
} from "../scripts/lib/backup-offsite-crypto.ts";
import { offsiteBinding, offsiteBindingFromName, offsiteObjectKey } from "../scripts/lib/backup-offsite.ts";
import { main as restoreMain, restoreBlob } from "../scripts/restore-backup-offsite.ts";

const KEY = backupKeyFromBytes(Buffer.alloc(32, 7));
const KEY_B64 = Buffer.alloc(32, 7).toString("base64");
const NOV08 = offsiteBinding("beehiiv", "2026-11-08");
const NOV01 = offsiteBinding("beehiiv", "2026-11-01");

/**
 * Bytes produzidos pelo `encryptBackup` de master ANTES desta mudança (formato
 * v1), com chave `Buffer.alloc(32, 7)` e IV `Buffer.alloc(12, 5)`. Vetor fixo:
 * prova que um backup v1 real (não um gerado pelo código novo) ainda decifra.
 */
const GOLDEN_V1_HEX =
  "444941524941424b01dff89ada0ed1e838050505050505050505050505ea78dd091b81921d78de3be21909b0028090e443a4ed5f45d1573a02e41be8d03866696d87bb31a7419fb865cd139be0e1";
const GOLDEN_V1_PLAIN = "backup v1 gravado antes do #11961";

function tmpOut(): string {
  return join(mkdtempSync(join(tmpdir(), "restore-v2-11961-")), "out");
}

describe("#11961 formato v2: vínculo {tipo}/{data} no AAD", () => {
  it("encrypt grava v2 e decifra só com o mesmo vínculo", () => {
    const enc = encryptBackup(Buffer.from("assinantes"), KEY, NOV08);
    assert.equal(BACKUP_FORMAT_VERSION, 2);
    assert.equal(backupFormatVersion(enc), 2);
    assert.equal(decryptBackup(enc, KEY, NOV08).toString(), "assinantes");
  });

  it("rollback: blob de outra data ou de outro tipo não autentica", () => {
    const old = encryptBackup(Buffer.from("snapshot velho"), KEY, NOV01);
    assert.throws(() => decryptBackup(old, KEY, NOV08), (e: Error) => {
      assert.match(e.message, /autenticação/);
      assert.match(e.message, /beehiiv\/2026-11-08/);
      return true;
    });
    assert.throws(() => decryptBackup(old, KEY, offsiteBinding("eia-votes", "2026-11-01")), /autenticação/);
  });

  it("v2 sem vínculo falha antes de decifrar, pedindo o nome original", () => {
    const enc = encryptBackup(Buffer.from("x"), KEY, NOV08);
    assert.throws(() => decryptBackup(enc, KEY, null), /precisa do vínculo/);
  });

  it("restoreBlob: blob de 01/11 copiado sob a chave de 08/11 é recusado e não cria --out", () => {
    const old = encryptBackup(Buffer.from("tar velho"), KEY, NOV01);
    const out = tmpOut();
    assert.throws(() => restoreBlob(old, KEY, "beehiiv", offsiteObjectKey("beehiiv", "2026-11-08"), out), /autenticação/);
    assert.equal(existsSync(out), false);
  });

  it("CLI --file: o vínculo sai do nome; arquivo renomeado para outra data falha com exit 1", async () => {
    const dir = mkdtempSync(join(tmpdir(), "restore-file-v2-11961-"));
    const enc = encryptBackup(gzipSync(Buffer.from('{"key":"vote:1:a","value":"x"}\n')), KEY, offsiteBinding("eia-votes", "2026-11-08"));
    const deps = (logs: string[]) => ({ env: { BACKUP_ENCRYPTION_KEY: KEY_B64 }, skipEnvLoad: true, log: (m: string) => logs.push(m) });

    const good = join(dir, "2026-11-08.jsonl.gz.enc");
    writeFileSync(good, enc);
    const okOut = tmpOut();
    assert.equal(await restoreMain(["--file", good, "--out", okOut], deps([])), 0);
    assert.equal(readFileSync(join(okOut, "eia-votes-2026-11-08.jsonl"), "utf8"), '{"key":"vote:1:a","value":"x"}\n');

    const renamed = join(dir, "2026-11-15.jsonl.gz.enc");
    writeFileSync(renamed, enc);
    const logs: string[] = [];
    const badOut = tmpOut();
    assert.equal(await restoreMain(["--file", renamed, "--out", badOut], deps(logs)), 1);
    assert.ok(logs.some((l) => /autenticação/.test(l) && /eia-votes\/2026-11-15/.test(l)), logs.join("\n"));
    assert.equal(existsSync(badOut), false);
  });
});

describe("#11961 compatibilidade: backups v1 já gravados seguem legíveis", () => {
  it("vetor fixo gerado pelo código antigo decifra, com ou sem vínculo", () => {
    const blob = Buffer.from(GOLDEN_V1_HEX, "hex");
    assert.equal(backupFormatVersion(blob), 1);
    assert.equal(decryptBackup(blob, KEY, null).toString("utf8"), GOLDEN_V1_PLAIN);
    // O vínculo é ignorado na v1: a restauração por chave (que sempre tem vínculo) continua funcionando.
    assert.equal(decryptBackup(blob, KEY, NOV08).toString("utf8"), GOLDEN_V1_PLAIN);
  });

  it("v1 adulterado continua falhando a autenticação", () => {
    const blob = Buffer.from(GOLDEN_V1_HEX, "hex");
    blob[blob.length - 1] ^= 0x01;
    assert.throws(() => decryptBackup(blob, KEY, NOV08), /autenticação/);
  });

  it("encryptBackupV1ForTest reproduz o vetor fixo byte a byte", () => {
    const enc = encryptBackupV1ForTest(Buffer.from(GOLDEN_V1_PLAIN, "utf8"), KEY, Buffer.alloc(12, 5));
    assert.equal(enc.toString("hex"), GOLDEN_V1_HEX);
  });

  it("CLI restaura um v1 por --file e avisa que não há proteção contra rollback", async () => {
    const dir = mkdtempSync(join(tmpdir(), "restore-v1-11961-"));
    const f = join(dir, "2026-11-01.jsonl.gz.enc");
    writeFileSync(f, encryptBackupV1ForTest(gzipSync(Buffer.from("linha\n")), KEY));
    const logs: string[] = [];
    const out = tmpOut();
    assert.equal(await restoreMain(["--file", f, "--out", out], { env: { BACKUP_ENCRYPTION_KEY: KEY_B64 }, skipEnvLoad: true, log: (m) => logs.push(m) }), 0);
    assert.ok(logs.some((l) => /formato v1/.test(l)), logs.join("\n"));
    assert.equal(readFileSync(join(out, "eia-votes-2026-11-01.jsonl"), "utf8"), "linha\n");
  });
});

describe("#11961 BackupBinding: só sai validado", () => {
  it("backupBinding recusa tipo e data fora do formato", () => {
    assert.equal(backupBinding("eia-votes", "2026-11-08"), "eia-votes/2026-11-08");
    assert.throws(() => backupBinding("Beehiiv", "2026-11-08"), /tipo inválido/);
    assert.throws(() => backupBinding("beehiiv/x", "2026-11-08"), /tipo inválido/);
    assert.throws(() => backupBinding("beehiiv", "08/11/2026"), /data inválida/);
  });

  it("offsiteBindingFromName tira tipo do sufixo e data do nome; null se faltar um dos dois", () => {
    assert.equal(offsiteBindingFromName("beehiiv/2026-11-08.tar.gz.enc"), "beehiiv/2026-11-08");
    assert.equal(offsiteBindingFromName("C:\\tmp\\2026-11-08.jsonl.gz.enc"), "eia-votes/2026-11-08");
    assert.equal(offsiteBindingFromName("x.tar.gz.enc"), null);
    assert.equal(offsiteBindingFromName("beehiiv/2026-11-08.zip"), null);
  });

  it("o upload e a restauração calculam o mesmo vínculo para a mesma chave", () => {
    for (const kind of ["beehiiv", "eia-votes"] as const) {
      assert.equal(offsiteBindingFromName(offsiteObjectKey(kind, "2026-11-08")), offsiteBinding(kind, "2026-11-08"));
    }
  });

  it("tipos: string crua não é BackupBinding e encrypt exige o vínculo", () => {
    const raw = "beehiiv/2026-11-08";
    // @ts-expect-error string sem passar por backupBinding não é BackupBinding
    const b: BackupBinding = raw;
    assert.equal(b, raw);
    // @ts-expect-error encryptBackup sem vínculo não compila (v2 sempre amarra o blob)
    assert.throws(() => decryptBackup(encryptBackup(Buffer.from("x"), KEY), KEY, NOV08));
  });
});
