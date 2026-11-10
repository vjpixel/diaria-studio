/**
 * #12188 item 7: impressão digital das ENTRADAS da auditoria de intake
 * (`scripts/audit-newsletter-intake.ts`), gravada no relatório e recomputada
 * pelo invariante `newsletter-intake` do Stage 4.
 *
 * Compara CONTEÚDO, nunca mtime (mesmo princípio do
 * `newsletter-html-not-behind-reviewed`, #10245): salvar o `02-reviewed.md`
 * no Studio, `refresh-use-melhor-tempo` ou o `sync-code` tocam arquivos sem
 * mudar o que a auditoria lê. Do `02-reviewed.md` entra só a lista
 * (URL, destino) dos links AUDITADOS (`auditedKeys`, as URLs de newsletter
 * de IA do relatório, #12188 item 3) — editar texto ou trocar um link do
 * Radar que não veio de newsletter não deixa o intake desatualizado;
 * mover/incluir/remover link auditado deixa.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseDestaques } from "../extract-destaques.ts";
import { parseSections } from "./newsletter-parse.ts";
import { canonicalize } from "./url-utils.ts";

/** Arquivos de `_internal/` lidos pela auditoria (a ordem entra no hash). */
export const INTAKE_INPUT_FILES = [
  "captured-newsletters.json",
  "captured-newsletters.json.fetch.jsonl",
  "discovered-newsletters.json",
  "discovered-newsletters.json.fetch.jsonl",
  ".capture-newsletter-failed.json",
  "tmp-allscored.json",
  "tmp-scored.json",
  "newsletter-extra-scores.json",
  "01-approved.json",
  "tmp-articles-raw.json",
  "tmp-scoring-pool.json", // #12593: é o "pool" da auditoria
  "tmp-dates-reviewed.json",
  "captured-newsletter-articles.json",
  "newsletter-unscored.enrich.json",
  "newsletter-fetch-failures.json",
] as const;

export interface ReviewedEntry { url: string; title: string; destination: string }

/**
 * Links do `02-reviewed.md` com o destino. Destaques vêm primeiro e o
 * destino "destaque" tem prioridade sobre qualquer seção (#12188 item 8).
 */
export function reviewedEntries(md: string): ReviewedEntry[] {
  return [
    ...parseDestaques(md).map((d) => ({ url: d.url, title: d.title, destination: "destaque" })),
    ...parseSections(md).flatMap((s) => s.items.map((i) => ({ url: i.url, title: i.title, destination: s.name }))),
  ].filter((e) => typeof e.url === "string" && e.url.length > 0);
}

function sha(text: string | Buffer): string {
  return createHash("sha256").update(text).digest("hex");
}

/**
 * Pura sobre o filesystem: mesma entrada → mesmo hash. `auditedKeys` são
 * URLs já canonicalizadas (`canonicalize(url).toLowerCase()`).
 */
export function computeIntakeFingerprint(editionDir: string, registryPath: string, auditedKeys: Iterable<string>): string {
  const audited = new Set(auditedKeys);
  const internal = resolve(editionDir, "_internal");
  const parts: string[] = [];
  for (const f of INTAKE_INPUT_FILES) {
    const p = resolve(internal, f);
    parts.push(`${f}:${existsSync(p) ? sha(readFileSync(p)) : "-"}`);
  }
  parts.push(`registry:${existsSync(registryPath) ? sha(readFileSync(registryPath)) : "-"}`);
  const reviewedPath = resolve(editionDir, "02-reviewed.md");
  if (existsSync(reviewedPath)) {
    const entries = reviewedEntries(readFileSync(reviewedPath, "utf8"))
      .map((e) => ({ key: canonicalize(e.url).toLowerCase(), destination: e.destination }))
      .filter((e) => audited.has(e.key))
      .map((e) => `${e.key}\t${e.destination}`)
      .sort();
    parts.push(`reviewed:${sha(entries.join("\n"))}`);
  } else {
    parts.push("reviewed:-");
  }
  return sha(parts.join("\n"));
}
