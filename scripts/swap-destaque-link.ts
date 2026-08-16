#!/usr/bin/env tsx
/**
 * swap-destaque-link.ts (#5458)
 *
 * Troca só o LINK de um destaque já escrito, mantendo título/corpo/história
 * intactos — ex: trocar cobertura de imprensa pela fonte primária oficial
 * depois que o editor pede isso no gate. Meio-termo entre editar 1 link à
 * mão (frágil, múltiplos arquivos esquecíveis) e `swap-destaque.ts` (#2499,
 * troca de história inteira — overkill pra esse caso).
 *
 * Achado ao vivo (edição 260817, D1): trocar só a URL do destaque, sem
 * ferramenta dedicada, quebrou silenciosamente 2 invariantes do Stage 4
 * (`social-hash-fresh` #1413, `image-content-fresh` #1730) que só apareceram
 * depois de rodar `check-invariants.ts` — e exigiu edição manual em 4
 * arquivos espalhados.
 *
 * Propaga atomicamente para:
 *   - `02-reviewed.md` (só o link do título do destaque, texto preservado)
 *   - `_internal/01-approved.json` + `01-approved-capped.json` (highlights[N].url)
 *   - `_internal/.social-source-hash.json` (recomputado via hashFromApprovedFile)
 *   - `_internal/02-d{N}-prompt.md` (frontmatter `destaque_url:`)
 *   - `_internal/04-d{N}-sd-prompt.json` (campo `positive`, só se a URL antiga
 *     aparecer ali literalmente — o campo é documental/embutido no texto do
 *     prompt, não estruturado; #5458 pede isso como opcional/barato)
 *
 * A NOVA url é verificada via `verify()` (scripts/verify-accessibility.ts)
 * ANTES de qualquer mutação — fail-fast se inacessível, nenhum arquivo é
 * tocado (mesma disciplina de precondição-antes-de-mutar do #2499).
 *
 * Uso:
 *   npx tsx scripts/swap-destaque-link.ts \
 *     --edition 260817 \
 *     --destaque d1 \
 *     --url https://reglab.example.com/anuncio-oficial
 *
 *   # Dry-run (só valida + mostra o plano, não escreve nada):
 *   npx tsx scripts/swap-destaque-link.ts \
 *     --edition 260817 --destaque d1 --url <nova-url> --dry-run
 *
 *   # Custom edition-dir (mesma convenção de swap-destaque.ts):
 *   npx tsx scripts/swap-destaque-link.ts \
 *     --edition 260817 --destaque d1 --url <nova-url> --edition-dir /tmp/test
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { isMainModule } from "./lib/cli-args.ts";
import { resolveEditionDir } from "./lib/find-current-edition.ts"; // #3491: layout flat+nested
import { hashHighlights } from "./lib/social-source-hash.ts";
import { verify as verifyUrl } from "./verify-accessibility.ts";
import type { VerifyOptions } from "./lib/verify-options.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DestaquePosition = "d1" | "d2" | "d3";

export interface SwapLinkArgs {
  edition: string;
  editionDir: string;
  destaque: DestaquePosition;
  url: string;
  dryRun: boolean;
}

export interface SwapLinkResult {
  edition: string;
  destaque: DestaquePosition;
  dry_run: boolean;
  old_url: string;
  new_url: string;
  modified: string[];
  skipped: Array<{ file: string; reason: string }>;
}

/** Same "accessible enough to publish" bar used by verify-accessibility.ts main(). */
const OK_VERDICTS = new Set(["accessible", "video"]);

// ---------------------------------------------------------------------------
// Pure helpers — exportados pra teste (#633)
// ---------------------------------------------------------------------------

/**
 * Localiza o bloco `**DESTAQUE {position} | ...**` em `02-reviewed.md` e
 * substitui SÓ a URL do link do título (`**[Título](URL)**`), preservando
 * título e corpo intactos. Mesma regex de split de blocos de
 * `swap-destaque.ts::removeDestaqueBlockFromMd` — reusa o formato canônico
 * (separador `---` entre blocos, header `**DESTAQUE N | CATEGORIA**`).
 *
 * Retorna `changed: false` (sem lançar) se o bloco não existir ou se
 * nenhuma URL for encontrada dentro dele — caller decide se isso é fatal.
 */
export function replaceDestaqueLinkInMd(
  md: string,
  position: 1 | 2 | 3,
  newUrl: string,
): { updated: string; changed: boolean; reason?: string } {
  const blockRe =
    /(\*\*DESTAQUE\s+\d+\s*\|[^\n]*\*\*[\s\S]*?)(?=\n+---\n+\*\*(?:DESTAQUE\s+\d|🚀|🔬|📰|📡|🛠️|VÍDEOS?|🎁|🙋|ERRO\s+INTENCIONAL|ASSINE)|$(?![\s\S]))/g;

  const blocks: string[] = [];
  const positions: Array<{ start: number; end: number }> = [];
  let m: RegExpExecArray | null;
  while ((m = blockRe.exec(md)) !== null) {
    blocks.push(m[1]);
    positions.push({ start: m.index, end: m.index + m[1].length });
  }

  if (blocks.length === 0) {
    return { updated: md, changed: false, reason: "nenhum bloco DESTAQUE encontrado em 02-reviewed.md" };
  }
  if (blocks.length < position) {
    return {
      updated: md,
      changed: false,
      reason: `só ${blocks.length} bloco(s) DESTAQUE encontrado(s), mas a posição pedida é ${position}`,
    };
  }

  const idx = position - 1;
  const block = blocks[idx];

  // Título do destaque: `**[Título](URL)**` — primeira URL do bloco, igual
  // à heurística de match-prompts-to-destaques.ts::extractDestaqueUrls.
  const linkMatch = block.match(/\[[^\]]*\]\((https?:\/\/[^\s)]+)\)/);
  if (!linkMatch) {
    return { updated: md, changed: false, reason: `nenhum link markdown [Título](URL) encontrado no bloco DESTAQUE ${position}` };
  }

  const oldUrlInBlock = linkMatch[1];
  const newBlock = block.replace(
    `](${oldUrlInBlock})`,
    `](${newUrl})`,
  );

  const updated = md.slice(0, positions[idx].start) + newBlock + md.slice(positions[idx].end);
  return { updated, changed: true };
}

/**
 * Extrai a URL atual do highlight na posição `idx` (0-based) de
 * `01-approved.json`. Mesma tolerância flat/nested de swap-destaque.ts —
 * `.url` direto ou `.article.url` aninhado.
 */
export function extractHighlightUrl(highlight: Record<string, unknown>): string {
  if (typeof highlight.url === "string" && highlight.url.length > 0) return highlight.url;
  const article = highlight.article as Record<string, unknown> | undefined;
  if (article && typeof article.url === "string" && article.url.length > 0) return article.url;
  return "";
}

/**
 * Atualiza `highlights[idx].url` (e `highlights[idx].article.url`, se
 * presente e nested) IN PLACE. Retorna a URL antiga pra uso downstream
 * (recompute de hash, substituição no md).
 */
export function updateHighlightUrl(
  data: Record<string, unknown>,
  idx: number,
  newUrl: string,
): { ok: true; oldUrl: string } | { ok: false; reason: string } {
  const highlights = data.highlights as Record<string, unknown>[] | undefined;
  if (!Array.isArray(highlights)) {
    return { ok: false, reason: "highlights[] ausente ou inválido" };
  }
  if (idx < 0 || idx >= highlights.length) {
    return { ok: false, reason: `posição ${idx} fora de range (highlights tem ${highlights.length} itens)` };
  }
  const highlight = highlights[idx];
  const oldUrl = extractHighlightUrl(highlight);
  if (typeof highlight.url === "string") {
    highlight.url = newUrl;
  }
  const article = highlight.article as Record<string, unknown> | undefined;
  if (article && typeof article.url === "string") {
    article.url = newUrl;
  }
  return { ok: true, oldUrl };
}

/**
 * Substitui `destaque_url: <url>` no frontmatter YAML de um
 * `02-d{N}-prompt.md`. Mirror de `extractPromptUrl` (match-prompts-to-destaques.ts)
 * — mesma âncora `^---\n...\n---` pro frontmatter.
 */
export function replaceDestaqueUrlInPromptFrontmatter(
  promptMd: string,
  newUrl: string,
): { updated: string; changed: boolean } {
  const fmMatch = promptMd.match(/^(---\s*\n)([\s\S]*?)(\n---)/);
  if (!fmMatch) return { updated: promptMd, changed: false };
  const [full, open, body, close] = fmMatch;
  if (!/^destaque_url:\s*\S+$/m.test(body)) return { updated: promptMd, changed: false };
  const newBody = body.replace(/^destaque_url:\s*\S+$/m, `destaque_url: ${newUrl}`);
  const newFm = open + newBody + close;
  return { updated: promptMd.replace(full, newFm), changed: true };
}

/**
 * Substitui a URL antiga (se aparecer literalmente) dentro do campo
 * `positive` de um `04-d{N}-sd-prompt.json`. O campo é texto livre (prompt
 * de geração de imagem) — a URL só aparece ali porque `image-generate.ts`
 * (`buildPositivePrompt`) não faz strip de frontmatter YAML do
 * `02-d{N}-prompt.md`, então `destaque_url: <url>` sobra no texto (#5458).
 * Puramente documental/best-effort: `changed: false` se a URL antiga não
 * aparecer no campo (nada a fazer, não é erro).
 */
export function replaceUrlInSdPromptPositive(
  sdPrompt: Record<string, unknown>,
  oldUrl: string,
  newUrl: string,
): { updated: Record<string, unknown>; changed: boolean } {
  if (typeof sdPrompt.positive !== "string" || !oldUrl || !sdPrompt.positive.includes(oldUrl)) {
    return { updated: sdPrompt, changed: false };
  }
  return {
    updated: { ...sdPrompt, positive: (sdPrompt.positive as string).split(oldUrl).join(newUrl) },
    changed: true,
  };
}

// ---------------------------------------------------------------------------
// CLI arg parsing
// ---------------------------------------------------------------------------

export function parseSwapLinkArgs(argv: string[]): SwapLinkArgs {
  const args: Record<string, string> = {};
  let dryRun = false;

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (argv[i].startsWith("--") && i + 1 < argv.length) {
      args[argv[i].slice(2)] = argv[i + 1];
      i++;
    }
  }

  if (!args.edition) {
    console.error("Erro: --edition AAMMDD é obrigatório");
    console.error(
      "Uso: swap-destaque-link.ts --edition AAMMDD --destaque d{1|2|3} --url <nova-url> [--dry-run] [--edition-dir <path>]",
    );
    process.exit(2);
  }
  if (!args.destaque || !["d1", "d2", "d3"].includes(args.destaque)) {
    console.error('Erro: --destaque deve ser "d1", "d2" ou "d3"');
    process.exit(2);
  }
  if (!args.url) {
    console.error("Erro: --url <nova-url> é obrigatório");
    process.exit(2);
  }
  if (!/^https?:\/\//.test(args.url)) {
    console.error(`Erro: --url deve ser uma URL http(s) absoluta, recebido "${args.url}"`);
    process.exit(2);
  }

  const editionsRootDir = args["editions-dir"]
    ? resolve(args["editions-dir"])
    : resolve(ROOT, "data", "editions");
  const editionDir = args["edition-dir"] ?? resolveEditionDir(editionsRootDir, args.edition);

  return {
    edition: args.edition,
    editionDir,
    destaque: args.destaque as DestaquePosition,
    url: args.url,
    dryRun,
  };
}

// ---------------------------------------------------------------------------
// Core orchestration — exportado pra teste com verifyFn injetável (evita
// bater na rede real em teste; guard do repo proíbe verify-accessibility.ts
// contra edição real, ver overnight-dispatch-rules.md).
// ---------------------------------------------------------------------------

export type VerifyFn = (url: string, opts?: VerifyOptions) => ReturnType<typeof verifyUrl>;

export async function runSwapLink(
  args: SwapLinkArgs,
  verifyFn: VerifyFn = verifyUrl,
): Promise<SwapLinkResult> {
  const { edition, editionDir, destaque, url: newUrl, dryRun } = args;
  const position = Number(destaque.slice(1)) as 1 | 2 | 3;

  if (!existsSync(editionDir)) {
    throw new Error(`Edition dir não encontrado: ${editionDir}`);
  }
  const internalDir = resolve(editionDir, "_internal");
  const approvedPath = resolve(internalDir, "01-approved.json");
  const cappedPath = resolve(internalDir, "01-approved-capped.json");
  const mdPath = resolve(editionDir, "02-reviewed.md");
  const hashPath = resolve(internalDir, ".social-source-hash.json");
  const promptPath = resolve(internalDir, `02-${destaque}-prompt.md`);
  const sdPromptPath = resolve(internalDir, `04-${destaque}-sd-prompt.json`);

  if (!existsSync(approvedPath)) {
    throw new Error(`${approvedPath} não encontrado`);
  }

  // -------------------------------------------------------------------
  // (a) Fail-fast: verificar acessibilidade da NOVA url ANTES de tocar
  // qualquer arquivo (#5458, mesma disciplina de swap-destaque.ts).
  // -------------------------------------------------------------------
  const verdict = await verifyFn(newUrl);
  if (!OK_VERDICTS.has(verdict.verdict)) {
    throw new Error(
      `URL inacessível (verdict: ${verdict.verdict}${verdict.note ? `, ${verdict.note}` : ""}) — ` +
        `nenhum arquivo foi modificado. Nova URL: ${newUrl}`,
    );
  }

  const approvedData = JSON.parse(readFileSync(approvedPath, "utf8")) as Record<string, unknown>;
  const highlights = approvedData.highlights as Record<string, unknown>[] | undefined;
  if (!Array.isArray(highlights) || position - 1 >= highlights.length) {
    throw new Error(
      `--destaque ${destaque} (posição ${position}) fora de range — 01-approved.json tem ${
        Array.isArray(highlights) ? highlights.length : 0
      } destaque(s)`,
    );
  }
  const oldUrl = extractHighlightUrl(highlights[position - 1]);
  if (!oldUrl) {
    throw new Error(`highlights[${position - 1}] não tem URL — estado inesperado de 01-approved.json`);
  }
  if (oldUrl === newUrl) {
    throw new Error(`Nova URL é idêntica à atual (${oldUrl}) — nada a trocar`);
  }

  const result: SwapLinkResult = {
    edition,
    destaque,
    dry_run: dryRun,
    old_url: oldUrl,
    new_url: newUrl,
    modified: [],
    skipped: [],
  };

  if (dryRun) {
    result.modified = [mdPath, approvedPath, cappedPath, hashPath, promptPath, sdPromptPath].filter((p) =>
      existsSync(p),
    );
    return result;
  }

  // -------------------------------------------------------------------
  // (b) 02-reviewed.md — só o link do título, texto preservado
  // -------------------------------------------------------------------
  if (existsSync(mdPath)) {
    const md = readFileSync(mdPath, "utf8");
    const mdResult = replaceDestaqueLinkInMd(md, position, newUrl);
    if (mdResult.changed) {
      writeFileSync(mdPath, mdResult.updated, "utf8");
      result.modified.push(mdPath);
    } else {
      result.skipped.push({ file: mdPath, reason: mdResult.reason ?? "sem mudança" });
    }
  } else {
    result.skipped.push({ file: mdPath, reason: "arquivo não encontrado" });
  }

  // -------------------------------------------------------------------
  // (c) 01-approved.json + 01-approved-capped.json
  // -------------------------------------------------------------------
  const approvedUpdate = updateHighlightUrl(approvedData, position - 1, newUrl);
  if (!approvedUpdate.ok) {
    throw new Error(`Erro ao atualizar 01-approved.json: ${approvedUpdate.reason}`);
  }
  writeFileSync(approvedPath, JSON.stringify(approvedData, null, 2) + "\n", "utf8");
  result.modified.push(approvedPath);

  if (existsSync(cappedPath)) {
    const cappedData = JSON.parse(readFileSync(cappedPath, "utf8")) as Record<string, unknown>;
    const cappedUpdate = updateHighlightUrl(cappedData, position - 1, newUrl);
    if (cappedUpdate.ok) {
      writeFileSync(cappedPath, JSON.stringify(cappedData, null, 2) + "\n", "utf8");
      result.modified.push(cappedPath);
    } else {
      result.skipped.push({ file: cappedPath, reason: cappedUpdate.reason });
    }
  } else {
    result.skipped.push({ file: cappedPath, reason: "arquivo não encontrado" });
  }

  // -------------------------------------------------------------------
  // (d) .social-source-hash.json — recomputado (reuso de hashHighlights,
  // mesma função usada por merge-social-md.ts via hashFromApprovedFile)
  // -------------------------------------------------------------------
  const newHighlights = approvedData.highlights as Record<string, unknown>[];
  const hashInput = newHighlights.slice(0, Math.min(newHighlights.length, 3)).map((h) => ({
    url: extractHighlightUrl(h),
    title_options: h.title_options as string[] | undefined,
  }));
  const newHash = hashHighlights(hashInput);
  writeFileSync(
    hashPath,
    JSON.stringify({ hash: newHash, generated_at: new Date().toISOString() }, null, 2) + "\n",
    "utf8",
  );
  result.modified.push(hashPath);

  // -------------------------------------------------------------------
  // (e) 02-d{N}-prompt.md frontmatter + 04-d{N}-sd-prompt.json (opcional,
  // best-effort — imagem continua válida pro mesmo tema, só a referência
  // documental da URL precisa acompanhar)
  // -------------------------------------------------------------------
  if (existsSync(promptPath)) {
    const promptMd = readFileSync(promptPath, "utf8");
    const promptResult = replaceDestaqueUrlInPromptFrontmatter(promptMd, newUrl);
    if (promptResult.changed) {
      writeFileSync(promptPath, promptResult.updated, "utf8");
      result.modified.push(promptPath);
    } else {
      result.skipped.push({ file: promptPath, reason: "frontmatter sem destaque_url — nada a trocar" });
    }
  } else {
    result.skipped.push({ file: promptPath, reason: "arquivo não encontrado (Stage 3 ainda não rodou)" });
  }

  if (existsSync(sdPromptPath)) {
    const sdPrompt = JSON.parse(readFileSync(sdPromptPath, "utf8")) as Record<string, unknown>;
    const sdResult = replaceUrlInSdPromptPositive(sdPrompt, oldUrl, newUrl);
    if (sdResult.changed) {
      writeFileSync(sdPromptPath, JSON.stringify(sdResult.updated, null, 2), "utf8");
      result.modified.push(sdPromptPath);
    } else {
      result.skipped.push({ file: sdPromptPath, reason: "URL antiga não aparece em `positive` — nada a trocar" });
    }
  } else {
    result.skipped.push({ file: sdPromptPath, reason: "arquivo não encontrado (Stage 3 ainda não rodou)" });
  }

  return result;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseSwapLinkArgs(process.argv.slice(2));
  try {
    const result = await runSwapLink(args);
    console.log(JSON.stringify(result, null, 2));
    console.error(
      [
        "",
        `${result.dry_run ? "[dry-run] " : ""}✓ swap-destaque-link concluído (edição ${result.edition}, ${result.destaque})`,
        `  URL antiga: ${result.old_url}`,
        `  URL nova:   ${result.new_url}`,
        "",
        result.dry_run ? "  Arquivos que SERIAM modificados:" : "  Arquivos modificados:",
        ...result.modified.map((f) => `    • ${f}`),
        ...(result.skipped.length > 0
          ? ["", "  Arquivos pulados:", ...result.skipped.map((s) => `    • ${s.file} — ${s.reason}`)]
          : []),
      ].join("\n"),
    );
  } catch (e) {
    console.error(`Erro: ${(e as Error).message}`);
    process.exit(1);
  }
}

// CLI guard — required per repo invariant: scripts that export helpers AND
// call main() need this guard so tests that import helpers don't trigger main()
if (isMainModule(import.meta.url)) {
  main();
}
