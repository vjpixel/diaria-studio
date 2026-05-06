/**
 * match-prompts-to-destaques.ts (#606)
 *
 * Detecta reorder de destaques entre Stage 2 (writer) e Stage 3 (imagens) e
 * realinha os arquivos `_internal/02-d{N}-prompt.md` à ordem atual do
 * `02-reviewed.md`. Sem isso, editor que reordena destaques no gate da
 * Etapa 2 acaba com imagens erradas (capa do D1 com cena do destaque que
 * antes era D3).
 *
 * Estratégia:
 *
 * 1. Cada prompt `_internal/02-d{N}-prompt.md` tem (ou ganha agora)
 *    frontmatter com `destaque_url: https://...` identificando qual artigo
 *    a cena descreve.
 * 2. Lê `02-reviewed.md` e extrai URLs em ordem (D1, D2, D3 atuais).
 * 3. Compara com URLs dos prompts. Se matching atual (d1↔d1) → no-op.
 *    Se reordenado → renomeia prompts pra alinhar.
 *
 * Uso:
 *   npx tsx scripts/match-prompts-to-destaques.ts \
 *     --edition-dir data/editions/260505/
 *     [--dry-run]
 *
 * Output JSON: { ok, swaps: [{from, to}], reason }
 */

import { readFileSync, existsSync, renameSync } from "node:fs";
import { resolve } from "node:path";

// ---------------------------------------------------------------------------
// Pure helpers — exportados pra tests
// ---------------------------------------------------------------------------

/**
 * Extrai a URL principal de cada DESTAQUE em ordem do `02-reviewed.md`.
 * URL principal = primeira `https://...` que aparece após o header
 * `DESTAQUE N | CATEGORIA`, antes do próximo header.
 */
export function extractDestaqueUrls(reviewedMd: string): string[] {
  const normalized = reviewedMd.replace(/\r\n/g, "\n");
  const blocks = normalized.split(/\n(?=DESTAQUE \d+\s*\|)/);
  const urls: string[] = [];

  for (const block of blocks) {
    const headerMatch = block.match(/^DESTAQUE (\d+)\s*\|/);
    if (!headerMatch) continue;
    // Primeira URL do block (após header, antes de próximo block ou ---)
    const urlMatch = block.match(/https?:\/\/[^\s)\]]+/);
    if (urlMatch) {
      urls.push(urlMatch[0].replace(/[).,;]+$/, ""));
    }
  }

  return urls;
}

/**
 * Lê frontmatter `destaque_url:` de um prompt MD. Retorna URL ou null.
 */
export function extractPromptUrl(promptMd: string): string | null {
  const fmMatch = promptMd.match(/^---\s*\n([\s\S]*?)\n---/);
  if (fmMatch) {
    const urlInFm = fmMatch[1].match(/^destaque_url:\s*(\S+)$/m);
    if (urlInFm) return urlInFm[1];
  }
  // Fallback: procurar URL solta no body (raro — alguns prompts antigos
  // mencionam URL no comentário inicial)
  const bodyUrl = promptMd.match(/destaque_url:\s*(\S+)/);
  return bodyUrl ? bodyUrl[1] : null;
}

export type SwapsResult =
  | { ok: true; swaps: Array<{ from: string; to: string }>; reason: string }
  | { ok: false; reason: string };

/**
 * Calcula swaps necessários pra alinhar prompts à ordem dos destaques.
 *
 * Ex: prompts d1=A, d2=B, d3=C; reviewed atual D1=C, D2=B, D3=A → swap d1↔d3.
 *
 * Retorna lista de renomeações (paths originais → paths finais), garantida
 * de ser executável sequencialmente sem conflitos (usa intermediário .tmp
 * quando ciclo).
 *
 * Fail-closed quando informação insuficiente (#691):
 *
 * - Se prompt sem `destaque_url:` no frontmatter (`promptUrls.dN === null`),
 *   retorna `ok: false` — Stage 3 deve bloquear em vez de gerar imagens
 *   no destaque errado silenciosamente.
 * - Se URL do prompt não existe no reviewed.md, mesmo comportamento.
 *
 * Antes desse fix, ambos os casos retornavam `[]` (no-op) e Stage 3
 * passava como se "prompts já alinhados", quando na verdade não dá pra
 * verificar.
 */
export function computeSwaps(
  promptUrls: { d1: string | null; d2: string | null; d3: string | null },
  reviewedUrls: string[],
): SwapsResult {
  // Frontmatter ausente em algum prompt → fail-closed: não dá pra detectar reorder
  for (const cur of ["d1", "d2", "d3"] as const) {
    if (promptUrls[cur] === null) {
      return {
        ok: false,
        reason:
          `frontmatter destaque_url ausente em 02-${cur}-prompt.md — não dá pra ` +
          `detectar reorder de destaques. Editar o prompt e adicionar ` +
          `'destaque_url: <url-do-destaque>' no frontmatter, ou regenerar Stage 2. ` +
          `Stage 3 vai falhar com exit 1 até esse fix ser aplicado.`,
      };
    }
  }

  // Mapping: posição atual no prompt (1/2/3) → posição desejada no reviewed
  const desiredFor = new Map<string, number>(); // url → position (1-indexed)
  reviewedUrls.forEach((url, idx) => desiredFor.set(url, idx + 1));

  const currentByPrompt: Record<string, number | null> = {
    d1: desiredFor.get(promptUrls.d1!) ?? null,
    d2: desiredFor.get(promptUrls.d2!) ?? null,
    d3: desiredFor.get(promptUrls.d3!) ?? null,
  };

  // URL do prompt ausente do reviewed → fail-closed também
  for (const cur of ["d1", "d2", "d3"] as const) {
    if (currentByPrompt[cur] === null) {
      return {
        ok: false,
        reason:
          `URL de 02-${cur}-prompt.md (${promptUrls[cur]}) não está em ` +
          `02-reviewed.md — destaque foi removido no gate? Regenerar Stage 2 ou ` +
          `corrigir o prompt manualmente. ` +
          `Stage 3 vai falhar com exit 1 até esse fix ser aplicado.`,
      };
    }
  }

  // Já alinhado?
  if (currentByPrompt.d1 === 1 && currentByPrompt.d2 === 2 && currentByPrompt.d3 === 3) {
    return { ok: true, swaps: [], reason: "prompts já alinhados" };
  }

  // Renomeio via temp pra evitar colisão (caso mais comum: d1↔d3 ou rotação 3-cycle)
  const swaps: Array<{ from: string; to: string }> = [];
  const tmpSuffix = ".swap-tmp";

  // Step 1: rename atuais pra .swap-tmp
  for (const cur of ["d1", "d2", "d3"] as const) {
    swaps.push({
      from: `02-${cur}-prompt.md`,
      to: `02-${cur}-prompt${tmpSuffix}.md`,
    });
  }
  // Step 2: rename .swap-tmp → posição final desejada
  for (const cur of ["d1", "d2", "d3"] as const) {
    const desired = currentByPrompt[cur]!;
    swaps.push({
      from: `02-${cur}-prompt${tmpSuffix}.md`,
      to: `02-d${desired}-prompt.md`,
    });
  }

  return { ok: true, swaps, reason: "renomeados pra alinhar com reviewed" };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const args: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const cur = argv[i];
    if (cur === "--dry-run") {
      args["dry-run"] = true;
    } else if (cur.startsWith("--") && i + 1 < argv.length && !argv[i + 1].startsWith("--")) {
      args[cur.slice(2)] = argv[i + 1];
      i++;
    }
  }
  return args;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const editionDir = args["edition-dir"] as string;
  const dryRun = !!args["dry-run"];

  if (!editionDir) {
    console.error("Uso: match-prompts-to-destaques.ts --edition-dir <path> [--dry-run]");
    process.exit(2);
  }

  const ROOT = process.cwd();
  const reviewedPath = resolve(ROOT, editionDir, "02-reviewed.md");
  const internalDir = resolve(ROOT, editionDir, "_internal");

  if (!existsSync(reviewedPath)) {
    console.error(`02-reviewed.md não encontrado: ${reviewedPath}`);
    process.exit(2);
  }

  const reviewedMd = readFileSync(reviewedPath, "utf8");
  const reviewedUrls = extractDestaqueUrls(reviewedMd);
  if (reviewedUrls.length !== 3) {
    console.log(JSON.stringify({
      ok: false,
      reason: `Esperado 3 destaques em 02-reviewed.md, encontrado ${reviewedUrls.length}`,
    }));
    process.exit(1);
  }

  const promptUrls: Record<"d1" | "d2" | "d3", string | null> = { d1: null, d2: null, d3: null };
  for (const d of ["d1", "d2", "d3"] as const) {
    const path = resolve(internalDir, `02-${d}-prompt.md`);
    if (existsSync(path)) {
      promptUrls[d] = extractPromptUrl(readFileSync(path, "utf8"));
    }
  }

  const result = computeSwaps(promptUrls, reviewedUrls);

  if (!result.ok) {
    // Fail-closed: Stage 3 deve bloquear quando match-prompts não tem informação
    // suficiente pra detectar reorder (frontmatter ausente, URL não bate).
    console.log(JSON.stringify({ ok: false, reason: result.reason }));
    process.exit(1);
  }

  if (result.swaps.length === 0) {
    console.log(JSON.stringify({ ok: true, swaps: [], reason: result.reason }));
    return;
  }

  if (dryRun) {
    console.log(JSON.stringify({ ok: true, swaps: result.swaps, reason: "dry-run — sem renomear" }, null, 2));
    return;
  }

  // Executar swaps em ordem (todos pra .swap-tmp primeiro, depois pra desejados)
  for (const s of result.swaps) {
    const fromPath = resolve(internalDir, s.from);
    const toPath = resolve(internalDir, s.to);
    if (existsSync(fromPath)) {
      renameSync(fromPath, toPath);
    }
  }

  console.log(JSON.stringify({ ok: true, swaps: result.swaps, reason: result.reason }, null, 2));
}

const _argv1 = process.argv[1]?.replaceAll("\\", "/") ?? "";
if (
  import.meta.url === `file://${_argv1}` ||
  import.meta.url === `file:///${_argv1.replace(/^\//, "")}`
) {
  main();
}
