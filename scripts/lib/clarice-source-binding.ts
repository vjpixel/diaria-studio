/**
 * scripts/lib/clarice-source-binding.ts (#12794)
 *
 * Amarra um `{S}-filtrado.json` do `clarice-filter.ts` ao texto que foi
 * enviado à Clarice. Sem isso, o arquivo de sugestões não diz de que texto
 * veio: um `[]` velho, ou o filtrado de uma versão anterior, passaria como
 * prova de que a Clarice rodou sobre uma versão nova.
 *
 * `clarice-filter.ts --source-text F` grava, ao lado do `--out`, o sidecar
 * `{out}.source.json` com o sha256 do texto de entrada (normalizado: fim de
 * linha e bordas) e o sha256 do conteúdo exato do filtrado gravado. Quem
 * consome o filtrado confere os dois: o texto de entrada tem de ser o mesmo
 * e o filtrado não pode ter sido trocado ou editado depois.
 */
import { createHash } from "node:crypto";

export interface ClariceSourceSidecar {
  /** sha256 do texto enviado à Clarice, normalizado por `normalizeClariceSource`. */
  source_sha256: string;
  /** sha256 do conteúdo exato do `{S}-filtrado.json` gravado. */
  filtered_sha256: string;
  /** Sugestões mantidas pelo filtro. */
  kept: number;
}

/** Caminho do sidecar de um filtrado. @pure */
export function clariceSourceSidecarPath(filteredPath: string): string {
  return `${filteredPath}.source.json`;
}

/** Normaliza fim de linha e bordas: Write/colagem não devem mudar o hash. @pure */
export function normalizeClariceSource(text: string): string {
  return text.replace(/\r\n?/g, "\n").trim();
}

/** sha256 hex do texto normalizado. @pure */
export function clariceSourceHash(text: string): string {
  return createHash("sha256").update(normalizeClariceSource(text), "utf8").digest("hex");
}

/** sha256 hex do conteúdo bruto (sem normalizar). @pure */
export function rawSha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/** Monta o sidecar para o texto de entrada e o filtrado já serializado. @pure */
export function buildClariceSourceSidecar(sourceText: string, filteredContent: string, kept: number): ClariceSourceSidecar {
  return { source_sha256: clariceSourceHash(sourceText), filtered_sha256: rawSha256(filteredContent), kept };
}

export function isClariceSourceSidecar(v: unknown): v is ClariceSourceSidecar {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.source_sha256 === "string" &&
    /^[0-9a-f]{64}$/.test(o.source_sha256) &&
    typeof o.filtered_sha256 === "string" &&
    /^[0-9a-f]{64}$/.test(o.filtered_sha256) &&
    typeof o.kept === "number"
  );
}
