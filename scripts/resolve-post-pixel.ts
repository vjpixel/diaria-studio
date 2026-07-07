/**
 * resolve-post-pixel.ts (#3052)
 *
 * Resolve `{outros_count}` + `{edition_url}` no texto do `## post_pixel` de
 * `03-social.md`, para exibição no gate do Stage 6 (#2153 lembrete) e cópia
 * manual no Claude in Chrome (#1690).
 *
 * `post_pixel` NUNCA passa por `publish-linkedin.ts` — é publicado 100%
 * manualmente (Make.com não tem endpoint pra post pessoal, ver §3d de
 * social-linkedin.md e context/publishers/linkedin.md). Por isso os
 * placeholders não são resolvidos no dispatch de Stage 5 como em
 * `### comment_diaria` — este script é o ponto de resolução equivalente
 * pro fluxo manual, chamado no pré-gate do Stage 6 (depois que o draft
 * Beehiiv e o approved JSON final já existem).
 *
 * Uso:
 *   npx tsx scripts/resolve-post-pixel.ts --edition-dir data/editions/260707
 *   npx tsx scripts/resolve-post-pixel.ts --edition-dir data/editions/260707 --edition-url https://diar.ia.br/p/slug
 *
 * Saída: texto resolvido do post_pixel em stdout (best-effort — mesmo em
 * falha parcial, imprime o que conseguiu resolver).
 *
 * Exit codes:
 *   0 — resolvido com sucesso (ambos placeholders substituídos, ou já
 *       ausentes no texto original — backward-compat com schema pré-#3052)
 *   1 — erro de uso/estrutura: --edition-dir ausente, 03-social.md ausente,
 *       seção LinkedIn ausente, ou seção `## post_pixel` ausente
 *   2 — outros_count não pôde ser resolvido (nenhum approved JSON legível).
 *       `{outros_count}` permanece literal no stdout — NÃO bloqueia o Stage 6
 *       (post_pixel é lembrete não-bloqueante, #2153), mas o caller deve
 *       avisar o editor visivelmente.
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { extractPlatformSection, extractPostPixelBlock } from "./lib/social-lint-rules.ts";
import { resolveOutrosCountFromEditionDir } from "./lib/outros-count.ts";
import { BEEHIIV_BASE_URL } from "./lib/edition-url.ts";
import { parseArgs } from "./lib/cli-args.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Substitui `{edition_url}` e `{outros_count}` literais pelo valor resolvido.
 * `null` para qualquer um dos dois deixa o placeholder correspondente intacto
 * (backward-compat + fail-soft — nunca lança).
 * Exportada pra testes unitários.
 */
export function substitutePostPixelPlaceholders(
  text: string,
  editionUrl: string | null,
  outrosCount: number | null,
): string {
  let out = text;
  if (editionUrl !== null) out = out.replaceAll("{edition_url}", editionUrl);
  if (outrosCount !== null) out = out.replaceAll("{outros_count}", String(outrosCount));
  return out;
}

/**
 * Extrai o texto bruto (não resolvido) do `## post_pixel` de um `03-social.md`
 * completo. Retorna `null` se a seção LinkedIn ou o bloco post_pixel não
 * existirem (schema pré-#1690 ou edição sem D1... não deveria acontecer, mas
 * fail-soft de qualquer forma). Exportada pra testes unitários.
 */
export function extractPostPixelText(socialMd: string): string | null {
  const linkedinSection = extractPlatformSection(socialMd, "linkedin");
  if (!linkedinSection) return null;
  const block = extractPostPixelBlock(linkedinSection);
  if (!block) return null;
  return block.text.replace(/<!--[\s\S]*?-->/g, "").trim();
}

function main(): void {
  const { values } = parseArgs(process.argv.slice(2));
  const editionDirRaw = values["edition-dir"];
  if (!editionDirRaw) {
    console.error(
      "Erro: --edition-dir obrigatório.\n" +
        "Uso: npx tsx scripts/resolve-post-pixel.ts --edition-dir data/editions/260707 [--edition-url <url>]",
    );
    process.exit(1);
  }
  const editionDir = resolve(ROOT, editionDirRaw);

  const socialMdPath = resolve(editionDir, "03-social.md");
  if (!existsSync(socialMdPath)) {
    console.error(`Erro: 03-social.md não encontrado em ${editionDir}. Rode a Etapa 2 primeiro.`);
    process.exit(1);
  }
  const socialMd = readFileSync(socialMdPath, "utf8");

  const rawText = extractPostPixelText(socialMd);
  if (rawText === null) {
    console.error(
      `Erro: seção '## post_pixel' não encontrada em 03-social.md (${socialMdPath}). ` +
        "Schema pré-#1690 ou seção LinkedIn ausente.",
    );
    process.exit(1);
  }

  // edition_url: --edition-url flag > _internal/05-edition-url.txt > fallback
  // raiz (com warn) — mesma precedência de publish-linkedin.ts (#595).
  const editionUrlFlag = values["edition-url"] || undefined;
  let editionUrl: string;
  if (editionUrlFlag) {
    editionUrl = editionUrlFlag;
    console.error(`#3052: edition_url via flag → ${editionUrl}`);
  } else {
    const editionUrlFile = resolve(editionDir, "_internal", "05-edition-url.txt");
    if (existsSync(editionUrlFile)) {
      editionUrl = readFileSync(editionUrlFile, "utf8").trim();
      console.error(`#3052: edition_url via 05-edition-url.txt → ${editionUrl}`);
    } else {
      editionUrl = BEEHIIV_BASE_URL;
      console.warn(
        `#3052: edition_url não encontrado (sem --edition-url nem 05-edition-url.txt) — fallback ${editionUrl}. ` +
          "post_pixel vai apontar pra raiz da newsletter em vez do post específico.",
      );
    }
  }

  const outrosCountValue = resolveOutrosCountFromEditionDir(editionDir);
  let exitCode = 0;
  if (outrosCountValue === null) {
    console.error(
      "#3052: AVISO — outros_count não pôde ser resolvido (nenhum approved JSON legível em " +
        resolve(editionDir, "_internal") +
        "). '{outros_count}' permanece literal no texto abaixo — editor deve preencher " +
        "manualmente antes de postar (não bloqueia o gate, #2153).",
    );
    exitCode = 2;
  }

  const resolved = substitutePostPixelPlaceholders(rawText, editionUrl, outrosCountValue);
  console.log(resolved);

  process.exit(exitCode);
}

const _argv1 = process.argv[1]?.replaceAll("\\", "/") ?? "";
if (
  import.meta.url === `file://${_argv1}` ||
  import.meta.url === `file:///${_argv1.replace(/^\//, "")}`
) {
  main();
}
