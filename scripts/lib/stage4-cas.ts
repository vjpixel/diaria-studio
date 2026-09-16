/**
 * stage4-cas.ts (#8123 Fatia 3)
 *
 * Primitiva de compare-and-swap (CAS) por hash — usada por qualquer checagem
 * do Stage 4 que ESCREVE de volta no arquivo da edição (autofix do
 * fact-check, re-humanização, correção da Clarice) rodando em BACKGROUND
 * enquanto o editor pode estar editando o mesmo arquivo ao vivo (loop
 * `ajustar` de §4d.1, ou o painel /revisao do Studio).
 *
 * Contrato (#7401 — nunca reverter uma edição do editor por cima):
 *   1. Antes de disparar um autofix, tirar um snapshot do arquivo
 *      (`snapshotFile`) — guarda o hash do conteúdo NO MOMENTO em que a
 *      checagem decidiu o que escrever.
 *   2. Quando o autofix termina de calcular o novo conteúdo (pode levar
 *      segundos a minutos — é um agente ou um script pesado), aplicar via
 *      `applyIfUnchanged` passando o hash do snapshot original.
 *   3. Se o arquivo NÃO mudou desde o snapshot (hash bate) → grava
 *      normalmente (`applied: true`).
 *   4. Se o arquivo MUDOU (`applied: false, reason: "changed"`) → o editor
 *      editou o arquivo enquanto o autofix rodava. **Nunca escrever por
 *      cima** — o caller descarta o resultado calculado e, se a correção
 *      ainda for necessária, re-roda o autofix sobre o conteúdo NOVO
 *      (`current_content`/`current_hash` já vêm no resultado, sem precisar
 *      reler o arquivo).
 *
 * Não é específico do Stage 4 — a primitiva é genérica (hash de conteúdo,
 * sem dependência de path de edição) — mas nasce aqui porque o Stage 4 é o
 * 1º consumidor real (#8123).
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";

/** Mesma normalização de `check-humanizer-social.ts:computeSocialHash` — CRLF→LF antes do hash, senão um checkout Windows produz hash diferente do mesmo conteúdo lógico. */
export function hashContent(content: string): string {
  return createHash("sha256").update(content.replace(/\r\n/g, "\n")).digest("hex");
}

export interface CasSnapshot {
  path: string;
  content: string;
  hash: string;
}

/** `null` quando o arquivo não existe — caller decide se isso é um erro. */
export function snapshotFile(path: string): CasSnapshot | null {
  if (!existsSync(path)) return null;
  const content = readFileSync(path, "utf8");
  return { path, content, hash: hashContent(content) };
}

export type CasWriteResult =
  | { applied: true; new_hash: string }
  | { applied: false; reason: "changed"; current_hash: string; current_content: string }
  | { applied: false; reason: "missing" };

/**
 * Escreve `newContent` em `path` SE E SOMENTE SE o conteúdo atual do arquivo
 * ainda tiver o hash `expectedHash` (tirado de um `snapshotFile` anterior).
 * Escrita atômica (write em arquivo temporário + rename) — nunca deixa o
 * arquivo num estado parcialmente escrito se o processo morrer no meio.
 *
 * `reason: "changed"` já devolve `current_content`/`current_hash` — o
 * caller que precisar re-aplicar a correção sobre o estado novo não precisa
 * de uma leitura extra.
 */
export function applyIfUnchanged(
  path: string,
  expectedHash: string,
  newContent: string,
): CasWriteResult {
  if (!existsSync(path)) return { applied: false, reason: "missing" };
  const current = readFileSync(path, "utf8");
  const currentHash = hashContent(current);
  if (currentHash !== expectedHash) {
    return { applied: false, reason: "changed", current_hash: currentHash, current_content: current };
  }
  const tmpPath = `${path}.stage4-cas-tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmpPath, newContent, "utf8");
  renameSync(tmpPath, path);
  return { applied: true, new_hash: hashContent(newContent) };
}
