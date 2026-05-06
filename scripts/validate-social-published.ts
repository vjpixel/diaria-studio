/**
 * validate-social-published.ts (#266)
 *
 * Valida `06-social-published.json` produzido pelo agent `publish-social`.
 * Detecta data loss silencioso onde 3 posts LinkedIn foram salvos como
 * drafts mas sobrescreveram um ao outro — agent reporta `summary.draft: 3`
 * mas só 1 draft único existe na conta.
 *
 * Caso real (#266): edição 260428 reportou 3 drafts LinkedIn mas o editor
 * viu visualmente apenas 1 rascunho — 2 perdidos.
 *
 * Uso:
 *   npx tsx scripts/validate-social-published.ts <edition_dir>
 *   npx tsx scripts/validate-social-published.ts data/editions/260428/
 *
 * Output (stdout, JSON):
 *   { "ok": true, "linkedin_count": 3, "linkedin_unique_urls": 3 }
 *   { "ok": false, "reason": "...", "duplicates": [...] }
 *
 * Exit codes:
 *   0 = OK (todas as URLs únicas, sem failed)
 *   1 = duplicates detectados (data loss silencioso)
 *   2 = erro de input (arquivo missing, JSON inválido)
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

interface Post {
  platform: string;
  destaque?: string;
  url: string | null;
  status: "draft" | "scheduled" | "failed";
  scheduled_at?: string | null;
  reason?: string;
  [key: string]: unknown;
}

interface PublishedJson {
  posts: Post[];
}

export interface ValidationResult {
  ok: boolean;
  linkedin_count: number;
  linkedin_unique_urls: number;
  duplicates: Array<{ url: string; destaques: string[] }>;
  reason?: string;
}

/**
 * Valida que cada post LinkedIn com `status` ∈ {"draft", "scheduled"} tem
 * URL única. URLs duplicadas indicam que o save sobrescreveu draft anterior
 * em vez de criar um novo (#266).
 */
export function validateLinkedinUniqueness(data: PublishedJson): ValidationResult {
  const linkedinPosts = (data.posts ?? []).filter(
    (p) => p.platform === "linkedin",
  );
  const successfulPosts = linkedinPosts.filter(
    (p) => p.status !== "failed" && p.url,
  );

  const urlGroups = new Map<string, string[]>();
  for (const p of successfulPosts) {
    const url = p.url as string;
    const list = urlGroups.get(url) ?? [];
    list.push(p.destaque ?? "?");
    urlGroups.set(url, list);
  }

  const duplicates = [...urlGroups.entries()]
    .filter(([, destaques]) => destaques.length > 1)
    .map(([url, destaques]) => ({ url, destaques }));

  const ok = duplicates.length === 0;
  return {
    ok,
    linkedin_count: successfulPosts.length,
    linkedin_unique_urls: urlGroups.size,
    duplicates,
    reason: ok
      ? undefined
      : `${duplicates.length} URL(s) duplicada(s) detectada(s) — drafts sobrescreveram um ao outro (#266 data loss). Recriar manualmente no LinkedIn.`,
  };
}

function main(): void {
  const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const arg = process.argv[2];
  if (!arg) {
    console.error("Uso: validate-social-published.ts <edition_dir>");
    process.exit(2);
  }

  const editionDir = resolve(ROOT, arg);
  // #725: publishers gravam em _internal/ para edições novas (#158); raiz
  // mantida apenas para backward compat com edições antigas.
  const internalPath = resolve(editionDir, "_internal", "06-social-published.json");
  const rootPath = resolve(editionDir, "06-social-published.json");
  const jsonPath = existsSync(internalPath) ? internalPath
                 : existsSync(rootPath) ? rootPath
                 : null;
  if (!jsonPath) {
    console.error(`Arquivo não existe em:\n  ${internalPath}\n  ${rootPath}`);
    process.exit(2);
  }

  let data: PublishedJson;
  try {
    data = JSON.parse(readFileSync(jsonPath, "utf8"));
  } catch (e) {
    console.error(`JSON inválido em ${jsonPath}: ${(e as Error).message}`);
    process.exit(2);
    return;
  }

  const result = validateLinkedinUniqueness(data);
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  if (!result.ok) {
    console.error(`\n❌ ${result.reason}`);
    for (const dup of result.duplicates) {
      console.error(
        `  ${dup.url} — destaques: ${dup.destaques.join(", ")}`,
      );
    }
  }
  process.exit(result.ok ? 0 : 1);
}

const _argv1 = process.argv[1]?.replaceAll("\\", "/") ?? "";
if (
  import.meta.url === `file://${_argv1}` ||
  import.meta.url === `file:///${_argv1.replace(/^\//, "")}`
) {
  main();
}
