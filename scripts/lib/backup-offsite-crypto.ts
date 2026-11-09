/**
 * backup-offsite-crypto.ts (#11413)
 *
 * Criptografia autenticada (AES-256-GCM, `node:crypto`) da cópia off-site dos
 * backups — snapshot semanal da Beehiiv (PII de assinantes) e dump dos votos
 * do É IA?. O arquivo cifrado vai pro bucket R2 privado `diaria-backup`; a
 * chave fica só no Doppler (`BACKUP_ENCRYPTION_KEY`, 32 bytes em base64) e
 * numa 2ª cópia com o editor (Bitwarden), nunca no bucket.
 *
 * Formato, tudo big-endian (mesmo layout nas versões 1 e 2):
 *
 *   offset  bytes  campo
 *   0       8      magic  "DIARIABK"
 *   8       1      versão (2; a 1 ainda é lida)
 *   9       8      keyId  — 8 primeiros bytes de sha256("diaria-backup-keyid:" + chave)
 *   17      12     IV     — aleatório por arquivo
 *   29      16     tag GCM
 *   45      ...    ciphertext
 *
 * Os 29 bytes antes da tag (magic + versão + keyId + IV) entram como AAD:
 * trocar qualquer byte do cabeçalho também falha a autenticação. Sem salt:
 * a chave já é 256 bits aleatórios, não uma senha, então não há derivação.
 *
 * Versão 2 (#11961 item 4): o AAD ganha, depois dos 29 bytes, o vínculo
 * `{tipo}/{AAAA-MM-DD}` (`BackupBinding`) derivado da chave do objeto no
 * bucket. O vínculo NÃO é gravado no arquivo: a restauração o recalcula a
 * partir da chave do objeto (ou do nome do arquivo, no `--file`). Quem tem a
 * credencial R/W do bucket e copia o blob de uma data antiga por cima da
 * chave de uma data nova (rollback) produz um arquivo que não autentica.
 * Efeito colateral aceito pelo editor (08/11/2026): um arquivo v2 renomeado
 * pra outra data ou tipo não decifra; o nome precisa ser o da chave original.
 *
 * Versão 1 (gravada até esta mudança): AAD só com os 29 bytes, sem vínculo.
 * Continua legível (backups dentro da janela de 56 dias do lifecycle), sem a
 * proteção contra rollback. Depois que o último v1 expirar do bucket, a
 * leitura v1 pode sair; até lá, `backupFormatVersion` deixa a restauração
 * avisar.
 *
 * `keyId` existe pra rotação: se a chave for trocada, a antiga precisa ficar
 * guardada (nos dois cofres) enquanto houver backup cifrado com ela dentro da
 * janela de 56 dias do lifecycle; o `keyId` deixa a restauração dizer "este
 * arquivo é de outra chave" em vez de um "falha de autenticação" genérico. Não
 * revela nada útil da chave (hash truncado de 256 bits aleatórios).
 *
 * Nenhuma mensagem de erro inclui a chave nem pedaço dela.
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

export const BACKUP_MAGIC = Buffer.from("DIARIABK", "ascii");
/** Versão gravada por `encryptBackup`. */
export const BACKUP_FORMAT_VERSION = 2;
/** Versões que `decryptBackup` lê (a 1 sem vínculo no AAD). */
export const BACKUP_READABLE_VERSIONS: readonly number[] = [1, 2];
const KEY_ID_LEN = 8;
const IV_LEN = 12;
const TAG_LEN = 16;
/** magic + versão + keyId + IV: o trecho autenticado como AAD. */
export const BACKUP_AAD_LEN = BACKUP_MAGIC.length + 1 + KEY_ID_LEN + IV_LEN;
export const BACKUP_HEADER_LEN = BACKUP_AAD_LEN + TAG_LEN;

export const BACKUP_KEY_ENV = "BACKUP_ENCRYPTION_KEY";

const KEY_LEN = 32;

declare const backupKeyBrand: unique symbol;
/**
 * Chave AES-256 já validada (32 bytes). Só sai de `parseBackupKey` ou
 * `backupKeyFromBytes`, e é o que `encryptBackup`/`decryptBackup` exigem
 * (#11961): antes só o `encryptBackup` conferia o tamanho, e o decrypt
 * dependia de quem chamava ter passado pelo parse.
 */
export type BackupKey = Buffer & { readonly [backupKeyBrand]: true };

/** Valida o tamanho e marca o Buffer como `BackupKey`. Mensagem nunca ecoa o valor. */
export function backupKeyFromBytes(bytes: Buffer, what: string = "chave AES-256"): BackupKey {
  if (bytes.length !== KEY_LEN) throw new Error(`${what} precisa ter ${KEY_LEN} bytes (tem ${bytes.length})`);
  return bytes as BackupKey;
}

/**
 * Decodifica a chave (base64, 32 bytes). Lança com mensagem que nunca ecoa o
 * valor. `envName` só entra na mensagem.
 */
export function parseBackupKey(raw: string | undefined, envName: string = BACKUP_KEY_ENV): BackupKey {
  const v = raw?.trim();
  if (!v) throw new Error(`${envName} ausente`);
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(v)) throw new Error(`${envName} não é base64 válido`);
  const key = Buffer.from(v.replace(/-/g, "+").replace(/_/g, "/"), "base64");
  return backupKeyFromBytes(key, `${envName} depois do base64`);
}

/**
 * Identificador público da chave: Buffer de 8 bytes (16 caracteres em hex nas
 * mensagens). Exige `BackupKey` (#11961): o id de um Buffer não validado
 * casaria com nada que `encryptBackup` produz.
 */
export function backupKeyId(key: BackupKey): Buffer {
  return createHash("sha256").update("diaria-backup-keyid:").update(key).digest().subarray(0, KEY_ID_LEN);
}

declare const backupBindingBrand: unique symbol;
/**
 * Vínculo `{tipo}/{AAAA-MM-DD}` que a versão 2 autentica no AAD (#11961 item
 * 4). Só sai de `backupBinding`, que valida o formato: um vínculo montado à
 * mão com outro separador ou data fora do padrão autenticaria um blob que a
 * restauração nunca conseguiria reproduzir.
 */
export type BackupBinding = string & { readonly [backupBindingBrand]: true };

const BINDING_KIND_RE = /^[a-z][a-z0-9-]*$/;
const BINDING_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Monta e valida o vínculo. Lança com tipo ou data fora do formato. */
export function backupBinding(kind: string, date: string): BackupBinding {
  if (!BINDING_KIND_RE.test(kind)) throw new Error(`tipo inválido para o vínculo do backup: "${kind}"`);
  if (!BINDING_DATE_RE.test(date)) throw new Error(`data inválida para o vínculo do backup: "${date}" (esperado AAAA-MM-DD)`);
  return `${kind}/${date}` as BackupBinding;
}

/** Versão do formato no cabeçalho, ou `null` se não for um backup cifrado deste formato. */
export function backupFormatVersion(blob: Buffer): number | null {
  if (blob.length <= BACKUP_MAGIC.length || !blob.subarray(0, BACKUP_MAGIC.length).equals(BACKUP_MAGIC)) return null;
  return blob[BACKUP_MAGIC.length];
}

/** AAD de cada versão: v1 só o cabeçalho; v2 cabeçalho + vínculo (obrigatório). */
function aadFor(header: Buffer, version: number, binding: BackupBinding | null): Buffer {
  if (version === 1) return header;
  if (!binding) {
    throw new Error(
      "backup no formato v2 precisa do vínculo {tipo}/{AAAA-MM-DD}, tirado da chave do objeto ou do nome do arquivo (ex.: beehiiv/2026-11-08.tar.gz.enc) — use o nome original do objeto",
    );
  }
  return Buffer.concat([header, Buffer.from(binding, "utf8")]);
}

function encryptWithVersion(plain: Buffer, key: BackupKey, version: number, binding: BackupBinding | null, iv: Buffer): Buffer {
  if (iv.length !== IV_LEN) throw new Error(`IV precisa ter ${IV_LEN} bytes`);
  const header = Buffer.concat([BACKUP_MAGIC, Buffer.from([version]), backupKeyId(key), iv]);
  const cipher = createCipheriv("aes-256-gcm", key, iv, { authTagLength: TAG_LEN });
  cipher.setAAD(aadFor(header, version, binding));
  const ct = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([header, cipher.getAuthTag(), ct]);
}

/**
 * Cifra `plain` no formato v2, amarrado a `binding` (tipo e data da chave do
 * objeto). `iv` só é injetável pra teste; em produção é aleatório.
 */
export function encryptBackup(plain: Buffer, key: BackupKey, binding: BackupBinding, iv: Buffer = randomBytes(IV_LEN)): Buffer {
  return encryptWithVersion(plain, key, BACKUP_FORMAT_VERSION, binding, iv);
}

/**
 * Cifra no formato v1 (sem vínculo). Só pra teste da leitura dos backups
 * antigos: produção grava sempre v2 por `encryptBackup`.
 */
export function encryptBackupV1ForTest(plain: Buffer, key: BackupKey, iv: Buffer = randomBytes(IV_LEN)): Buffer {
  return encryptWithVersion(plain, key, 1, null, iv);
}

/**
 * Decifra e autentica. Lança se: o arquivo não é deste formato, a versão é
 * desconhecida, a chave é outra (keyId diferente), qualquer byte foi alterado
 * (tag GCM não confere) ou, na v2, o arquivo não pertence a `binding` (outra
 * data/tipo: rollback no bucket ou arquivo renomeado). `binding` é ignorado na
 * v1 e obrigatório na v2 (`null` numa v2 lança antes de decifrar).
 */
export function decryptBackup(blob: Buffer, key: BackupKey, binding: BackupBinding | null): Buffer {
  if (blob.length < BACKUP_HEADER_LEN) throw new Error(`arquivo cifrado curto demais (${blob.length} bytes)`);
  if (!blob.subarray(0, BACKUP_MAGIC.length).equals(BACKUP_MAGIC)) throw new Error("não é um backup cifrado diar.ia.br (magic não confere)");
  const version = blob[BACKUP_MAGIC.length];
  if (!BACKUP_READABLE_VERSIONS.includes(version)) throw new Error(`versão de formato desconhecida: ${version}`);
  const kidStart = BACKUP_MAGIC.length + 1;
  const fileKeyId = blob.subarray(kidStart, kidStart + KEY_ID_LEN);
  const myKeyId = backupKeyId(key);
  if (!fileKeyId.equals(myKeyId)) {
    throw new Error(
      `o arquivo foi cifrado com outra chave (keyId ${fileKeyId.toString("hex")}, a chave fornecida é ${myKeyId.toString("hex")}) — use a chave antiga (--key-env)`,
    );
  }
  const iv = blob.subarray(kidStart + KEY_ID_LEN, BACKUP_AAD_LEN);
  const tag = blob.subarray(BACKUP_AAD_LEN, BACKUP_HEADER_LEN);
  const decipher = createDecipheriv("aes-256-gcm", key, iv, { authTagLength: TAG_LEN });
  decipher.setAAD(aadFor(blob.subarray(0, BACKUP_AAD_LEN), version, binding));
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(blob.subarray(BACKUP_HEADER_LEN)), decipher.final()]);
  } catch {
    if (version === 1) throw new Error("falha de autenticação: o arquivo foi alterado ou corrompido (tag GCM não confere)");
    throw new Error(
      `falha de autenticação: o arquivo foi alterado, corrompido ou não é o backup de ${binding} (tag GCM não confere) — um blob de outra data/tipo copiado por cima desta chave, ou um arquivo renomeado, cai aqui`,
    );
  }
}
