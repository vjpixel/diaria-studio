#!/usr/bin/env npx tsx
/**
 * validate-stage-4-completeness.ts (#1132 P1.2)
 *
 * Validador anti-skip: garante que outputs do Stage 4 (Publicação) existem
 * antes de fechar a edição/sessão. Detecta falhas silenciosas em
 * publish-newsletter, publish-facebook, publish-linkedin.
 *
 * Cobre:
 *   1. `_internal/05-published.json` existe e tem `draft_url` (newsletter)
 *   2. `_internal/06-social-published.json` existe e tem entries (social)
 *   3. (Opcional, via --strict) `05-published.json.test_email_sent_at` populado
 *      — indica que o test email loop completou
 *
 * Análogo a `validate-stage-1-completeness.ts` + `validate-stage-3-completeness.ts`.
 *
 * Uso:
 *   npx tsx scripts/validate-stage-4-completeness.ts --edition-dir data/editions/260512
 *   npx tsx scripts/validate-stage-4-completeness.ts --edition-dir data/editions/260512 --strict
 *
 * Exit codes:
 *   0 = todos os outputs presentes
 *   1 = algum output ausente (FATAL); stderr lista quais
 *   2 = erro de leitura
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

interface Missing {
  file: string;
  category: "newsletter" | "social" | "test-email";
  reason: string;
}

/**
 * Pure: retorna lista de outputs ausentes/inválidos do Stage 4.
 * `strict=true` também exige `test_email_sent_at` populado.
 */
export function findMissingStage4Outputs(
  editionDir: string,
  strict = false,
): Missing[] {
  const missing: Missing[] = [];

  // 1. Newsletter published.json
  const publishedPath = resolve(editionDir, "_internal/05-published.json");
  if (!existsSync(publishedPath)) {
    missing.push({
      file: "_internal/05-published.json",
      category: "newsletter",
      reason: "publish-newsletter não completou (arquivo ausente)",
    });
  } else {
    try {
      const raw = readFileSync(publishedPath, "utf8");
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object") {
        missing.push({
          file: "_internal/05-published.json",
          category: "newsletter",
          reason: "JSON inválido (não é object)",
        });
      } else {
        const obj = parsed as Record<string, unknown>;
        if (!obj.draft_url || typeof obj.draft_url !== "string") {
          missing.push({
            file: "_internal/05-published.json",
            category: "newsletter",
            reason: "campo `draft_url` ausente ou vazio",
          });
        }
        if (strict) {
          if (!obj.test_email_sent_at || typeof obj.test_email_sent_at !== "string") {
            missing.push({
              file: "_internal/05-published.json",
              category: "test-email",
              reason: "campo `test_email_sent_at` ausente (test email não enviado)",
            });
          }
        }
      }
    } catch (e) {
      missing.push({
        file: "_internal/05-published.json",
        category: "newsletter",
        reason: `falha ao parsear JSON: ${(e as Error).message}`,
      });
    }
  }

  // 2. Social published.json
  const socialPath = resolve(editionDir, "_internal/06-social-published.json");
  if (!existsSync(socialPath)) {
    missing.push({
      file: "_internal/06-social-published.json",
      category: "social",
      reason: "publish-facebook/linkedin não completaram (arquivo ausente)",
    });
  } else {
    try {
      const raw = readFileSync(socialPath, "utf8");
      const parsed: unknown = JSON.parse(raw);
      if (
        !parsed
        || typeof parsed !== "object"
        || !Array.isArray((parsed as { posts?: unknown }).posts)
      ) {
        missing.push({
          file: "_internal/06-social-published.json",
          category: "social",
          reason: "JSON inválido (esperado { posts: [...] })",
        });
      } else {
        const posts = (parsed as { posts: unknown[] }).posts;
        if (posts.length === 0) {
          missing.push({
            file: "_internal/06-social-published.json",
            category: "social",
            reason: "array `posts` vazio (esperado ao menos 1 entry de FB/LinkedIn)",
          });
        }
      }
    } catch (e) {
      missing.push({
        file: "_internal/06-social-published.json",
        category: "social",
        reason: `falha ao parsear JSON: ${(e as Error).message}`,
      });
    }
  }

  return missing;
}

function parseArgs(argv: string[]): { editionDir: string; strict: boolean } {
  let editionDir = "";
  let strict = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--edition-dir" && i + 1 < argv.length) {
      editionDir = argv[i + 1];
      i++;
    } else if (argv[i] === "--strict") {
      strict = true;
    }
  }
  if (!editionDir) {
    process.stderr.write("Usage: validate-stage-4-completeness.ts --edition-dir <path> [--strict]\n");
    process.exit(2);
  }
  return { editionDir, strict };
}

function main(): void {
  const { editionDir, strict } = parseArgs(process.argv.slice(2));
  const absDir = resolve(editionDir);
  if (!existsSync(absDir)) {
    process.stderr.write(`[validate-stage-4] edition dir ausente: ${absDir}\n`);
    process.exit(2);
  }

  const missing = findMissingStage4Outputs(absDir, strict);
  if (missing.length === 0) {
    process.stdout.write(
      JSON.stringify({ ok: true, edition_dir: editionDir, strict }, null, 2) + "\n",
    );
    process.exit(0);
  }

  process.stderr.write("[validate-stage-4] Outputs ausentes:\n");
  for (const m of missing) {
    process.stderr.write(`  - ${m.file} (${m.category}): ${m.reason}\n`);
  }
  process.stdout.write(
    JSON.stringify({ ok: false, edition_dir: editionDir, strict, missing }, null, 2) + "\n",
  );
  process.exit(1);
}

const isMain = process.argv[1]?.replace(/\\/g, "/").endsWith("validate-stage-4-completeness.ts");
if (isMain) {
  main();
}
