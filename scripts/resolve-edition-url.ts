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
 *   {edition_url} estiver presente após a resolução.
 *   {outros_count} é DEFERRED (resolvido por publish-linkedin.ts no dispatch)
 *   e NÃO é rejeitado por este guard.
 *
 * Uso:
 *   npx tsx scripts/resolve-edition-url.ts \
 *     --edition-dir data/editions/260623/ \
 *     --title "Título D1 da edição"
 *     [--validate-social]   # falhar se {edition_url} sobreviver no 03-social.md
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
 *   3 — {edition_url} não-resolvido detectado em 03-social.md (--validate-social)
 */

import { existsSync, readFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { deriveEditionUrl, findUnresolvedPlaceholders, BEEHIIV_BASE_URL } from "./lib/edition-url.ts";
import { seoSlug } from "./lib/slug.ts";
import { writeFileAtomic } from "./lib/atomic-write.ts";
import { parseArgs as parseArgsLib } from "./lib/cli-args.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// ── CLI parser ────────────────────────────────────────────────────────────────
// #finding3: corrige crash quando --title (ou --slug / --edition-url) é seguido
// de outra flag em vez de um valor. A lógica anterior tratava a próxima flag como
// o valor da opção anterior (ex: --title --validate-social definia title="--validate-social").
// Agora: flags booleanas conhecidas são tratadas separadamente; qualquer argumento
// que começa com "--" não é consumido como valor de outra flag.

// #2834: --validate-social é flag booleana incondicional (sempre true quando
// presente, independente do que vem depois) — argv.includes preserva isso
// mesmo se o token seguinte pareceria um valor consumível. As demais flags
// (--title/--slug/--edition-url/--edition-dir) usam consumo condicional
// (só consome o próximo token se não começar com "--"), que é exatamente o
// comportamento canônico de parseArgs.
function parseArgs(argv: string[]): Record<string, string | boolean> {
  const { values } = parseArgsLib(argv);
  const args: Record<string, string | boolean> = { ...values };
  if (argv.includes("--validate-social")) args["validate-social"] = true;
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
  if (!editionDirRaw || typeof editionDirRaw !== "string") {
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

  const titleArg = typeof args["title"] === "string" ? args["title"] : undefined;
  const slugArg = typeof args["slug"] === "string" ? args["slug"] : undefined;
  const editionUrlArg = typeof args["edition-url"] === "string" ? args["edition-url"] : undefined;

  let editionUrl: string;

  if (titleArg) {
    editionUrl = deriveEditionUrl(titleArg);
    console.log(`#2454: edition_url derivada do título → ${editionUrl}`);
    console.log(`       (slug: "${seoSlug(titleArg)}")`);
  } else if (slugArg) {
    editionUrl = `${BEEHIIV_BASE_URL}/p/${slugArg}`;
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

  // ── Gravar 05-edition-url.txt (write atômico) ─────────────────────────────
  // #finding2: write atômico (tmp + rename) — garante que o arquivo é ou a versão
  // anterior completa ou a nova, nunca parcial (kill mid-write, crash, OOM).

  const outPath = resolve(internalDir, "05-edition-url.txt");
  writeFileAtomic(outPath, editionUrl, { encoding: "utf8" });
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
        `{edition_url} DEVE ser substituído antes do dispatch do social.\n` +
        `  → resolvido via --title/--slug/--edition-url neste script (já gravado: ${editionUrl})\n` +
        `  → confirmar que publish-linkedin.ts foi invocado DEPOIS que 05-edition-url.txt foi gravado.\n` +
        `\n` +
        `Nota: {outros_count} é resolvido por publish-linkedin.ts no dispatch (deferred) —\n` +
        `  não é detectado por este guard.`,
      );
      process.exit(3);
    }
    console.log(`#2454: guard anti-placeholder OK — {edition_url} não presente em 03-social.md.`);
  }

  // Sucesso
  console.log(`OK: edition_url="${editionUrl}" gravada em ${outPath}`);
}
