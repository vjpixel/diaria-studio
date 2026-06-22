/**
 * resolve-edition-url.ts (#2454)
 *
 * Resolve a URL pública da edição a partir do slug do draft Beehiiv e grava
 * em `_internal/05-edition-url.txt` para consumo pelo publish-linkedin.ts e
 * publish-facebook.ts.
 *
 * Deve ser rodado APÓS o draft Beehiiv ser criado (beehiiv-playbook.md passo 8)
 * e ANTES do dispatch do social (publish-linkedin + publish-facebook).
 *
 * Fontes (ordem de precedência):
 *   1. --title        → deriveEditionUrl(title) via seoSlug (mesmo algoritmo de §4a-bis)
 *   2. --slug         → URL direta (quando o slug já foi derivado / corrigido)
 *   3. --edition-url  → URL literal (override manual, qualquer valor)
 *
 * Guard anti-placeholder:
 *   Com --validate-social, lê 03-social.md e aborta com exit 3 se
 *   {edition_url} ou {outros_count} estiverem presentes após a resolução.
 *   Isso garante que placeholders nunca chegam à fila de publicação.
 *
 * Uso:
 *   npx tsx scripts/resolve-edition-url.ts \
 *     --edition-dir data/editions/260623/ \
 *     --title "Título D1 da edição"
 *     [--validate-social]   # falhar se placeholder sobreviver no 03-social.md
 *
 *   npx tsx scripts/resolve-edition-url.ts \
 *     --edition-dir data/editions/260623/ \
 *     --slug "titulo-d1-da-edicao"
 *     [--validate-social]
 *
 *   npx tsx scripts/resolve-edition-url.ts \
 *     --edition-dir data/editions/260623/ \
 *     --edition-url "https://diar.ia.br/p/titulo-d1-da-edicao"
 *     [--validate-social]
 *
 * Exit codes:
 *   0 — URL gravada com sucesso (+ validação passed se --validate-social)
 *   1 — Erro de input / arquivo ausente
 *   3 — Placeholder não-resolvido detectado em 03-social.md (--validate-social)
 */

import { writeFileSync, existsSync, readFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { deriveEditionUrl, findUnresolvedPlaceholders } from "./lib/edition-url.ts";
import { seoSlug } from "./lib/slug.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// ── CLI parser ────────────────────────────────────────────────────────────────

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const args: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--validate-social") {
      args["validate-social"] = true;
    } else if (argv[i].startsWith("--") && i + 1 < argv.length && !argv[i + 1].startsWith("--")) {
      args[argv[i].slice(2)] = argv[i + 1];
      i++;
    } else if (argv[i].startsWith("--")) {
      args[argv[i].slice(2)] = true;
    }
  }
  return args;
}

// ── CLI guard ─────────────────────────────────────────────────────────────────
// Prevent accidental execution when imported from tests
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2));
}

function main(argv: string[]): void {
  const args = parseArgs(argv);

  const editionDirRaw = args["edition-dir"] as string | undefined;
  if (!editionDirRaw) {
    console.error("Erro: --edition-dir é obrigatório.");
    process.exit(1);
  }
  const editionDir = resolve(ROOT, editionDirRaw);
  const internalDir = resolve(editionDir, "_internal");

  if (!existsSync(editionDir)) {
    console.error(`Erro: edition-dir não existe: ${editionDir}`);
    process.exit(1);
  }

  mkdirSync(internalDir, { recursive: true });

  // ── Resolver a URL ────────────────────────────────────────────────────────

  const titleArg = args["title"] as string | undefined;
  const slugArg = args["slug"] as string | undefined;
  const editionUrlArg = args["edition-url"] as string | undefined;

  let editionUrl: string;

  if (titleArg) {
    editionUrl = deriveEditionUrl(titleArg);
    console.log(`#2454: edition_url derivada do título → ${editionUrl}`);
    console.log(`       (slug: "${seoSlug(titleArg)}")`);
  } else if (slugArg) {
    editionUrl = `https://diar.ia.br/p/${slugArg}`;
    console.log(`#2454: edition_url via slug → ${editionUrl}`);
  } else if (editionUrlArg) {
    editionUrl = editionUrlArg;
    console.log(`#2454: edition_url via override literal → ${editionUrl}`);
  } else {
    console.error(
      "Erro: uma das flags é obrigatória: --title <título> | --slug <slug> | --edition-url <url>\n" +
      "  --title é preferível (mesmo algoritmo seoSlug do playbook §4a-bis).",
    );
    process.exit(1);
  }

  // Validação mínima de formato
  if (!editionUrl.startsWith("https://")) {
    console.error(`Erro: URL derivada deve ser HTTPS: ${editionUrl}`);
    process.exit(1);
  }

  // ── Gravar 05-edition-url.txt ─────────────────────────────────────────────

  const outPath = resolve(internalDir, "05-edition-url.txt");
  writeFileSync(outPath, editionUrl, "utf8");
  console.log(`#2454: gravado → ${outPath}`);

  // ── Guard anti-placeholder (--validate-social) ────────────────────────────

  if (args["validate-social"]) {
    const socialMdPath = resolve(editionDir, "03-social.md");
    if (!existsSync(socialMdPath)) {
      console.error(
        `Erro (--validate-social): 03-social.md não encontrado em ${editionDir}. ` +
        `Rode a Etapa 2 primeiro.`,
      );
      process.exit(1);
    }
    const socialMd = readFileSync(socialMdPath, "utf8");
    const unresolved = findUnresolvedPlaceholders(socialMd);
    if (unresolved.length > 0) {
      console.error(
        `ERRO (#2454 guard anti-placeholder): 03-social.md contém placeholders não-resolvidos:\n` +
        `  ${unresolved.join(", ")}\n` +
        `\n` +
        `Estes placeholders DEVEM ser substituídos antes do dispatch do social.\n` +
        `  {edition_url}  → resolvido via --title/--slug/--edition-url neste script (já gravado: ${editionUrl})\n` +
        `  {outros_count} → resolvido por publish-linkedin.ts (#2319) lendo 01-approved-capped.json\n` +
        `\n` +
        `Se {edition_url} está presente: confirmar que publish-linkedin.ts foi invocado\n` +
        `  DEPOIS que 05-edition-url.txt foi gravado (este script).\n` +
        `Se {outros_count} está presente: verificar 01-approved-capped.json / 01-approved.json.`,
      );
      process.exit(3);
    }
    console.log(`#2454: guard anti-placeholder OK — nenhum placeholder em 03-social.md.`);
  }

  // Sucesso
  console.log(`OK: edition_url="${editionUrl}" gravada em ${outPath}`);
}
