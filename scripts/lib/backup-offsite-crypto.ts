/**
 * backup-offsite-crypto.ts (#11413)
 *
 * Criptografia autenticada (AES-256-GCM, `node:crypto`) da cópia off-site dos
 * backups — snapshot semanal da Beehiiv (PII de assinantes) e dump dos votos
 * do É IA?. O arquivo cifrado vai pro bucket R2 privado `diaria-backup`; a
 * chave fica só no Doppler (`BACKUP_ENCRYPTION_KEY`, 32 bytes em base64) e
 * numa 2ª cópia com o editor (Bitwarden), nunca no bucket.
 *
 * Formato (versão 1), tudo big-endian:
 *
 *   offset  bytes  campo
 *   0       8      magic  "DIARIABK"
 *   8       1      versão (1)
 *   9       8      keyId  — 8 primeiros bytes de sha256("diaria-backup-keyid:" + chave)
 *   17      12     IV     — aleatório por arquivo
 *   29      16     tag GCM
 *   45      ...    ciphertext
 *
 * Os 29 bytes antes da tag (magic + versão + keyId + IV) entram como AAD:
 * trocar qualquer byte do cabeçalho também falha a autenticação. Sem salt:
 * a chave já é 256 bits aleatórios, não uma senha, então não há derivação.
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
export const BACKUP_FORMAT_VERSION = 1;
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

/** Identificador público da chave: Buffer de 8 bytes (16 caracteres em hex nas mensagens). */
export function backupKeyId(key: Buffer): Buffer {
  return createHash("sha256").update("diaria-backup-keyid:").update(key).digest().subarray(0, KEY_ID_LEN);
}

/** Cifra `plain`. `iv` só é injetável pra teste; em produção é aleatório. */
export function encryptBackup(plain: Buffer, key: BackupKey, iv: Buffer = randomBytes(IV_LEN)): Buffer {
  if (iv.length !== IV_LEN) throw new Error(`IV precisa ter ${IV_LEN} bytes`);
  const aad = Buffer.concat([BACKUP_MAGIC, Buffer.from([BACKUP_FORMAT_VERSION]), backupKeyId(key), iv]);
  const cipher = createCipheriv("aes-256-gcm", key, iv, { authTagLength: TAG_LEN });
  cipher.setAAD(aad);
  const ct = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([aad, cipher.getAuthTag(), ct]);
}

/**
 * Decifra e autentica. Lança se: o arquivo não é deste formato, a versão é
 * desconhecida, a chave é outra (keyId diferente) ou qualquer byte foi
 * alterado (tag GCM não confere).
 */
export function decryptBackup(blob: Buffer, key: BackupKey): Buffer {
  if (blob.length < BACKUP_HEADER_LEN) throw new Error(`arquivo cifrado curto demais (${blob.length} bytes)`);
  if (!blob.subarray(0, BACKUP_MAGIC.length).equals(BACKUP_MAGIC)) throw new Error("não é um backup cifrado diar.ia.br (magic não confere)");
  const version = blob[BACKUP_MAGIC.length];
  if (version !== BACKUP_FORMAT_VERSION) throw new Error(`versão de formato desconhecida: ${version}`);
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
  decipher.setAAD(blob.subarray(0, BACKUP_AAD_LEN));
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(blob.subarray(BACKUP_HEADER_LEN)), decipher.final()]);
  } catch {
    throw new Error("falha de autenticação: o arquivo foi alterado ou corrompido (tag GCM não confere)");
  }
}
