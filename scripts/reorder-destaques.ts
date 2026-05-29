#!/usr/bin/env tsx
/**
 * reorder-destaques.ts (#1585)
 *
 * Reordena destaques mid-Stage atomicamente. Propaga reorder pra:
 *   - `_internal/01-approved.json` (highlights[])
 *   - `_internal/01-approved-capped.json` (highlights[])
 *   - `02-reviewed.md` (blocos DESTAQUE 1/2/3 + frontmatter intentional_error.location)
 *   - `_internal/02-d{N}-prompt.md` (rename files)
 *   - `04-d{N}-*.jpg` (rename files — 2x1 e 1x1)
 *   - `03-social.md` (sections `## d{N}` em cada plataforma)
 *
 * Outputs a JSON com lista de arquivos modificados. NÃO re-uploada imagens
 * pro Drive/Cloudflare (editor roda upload-images-public manualmente após
 * checagem visual).
 *
 * Uso:
 *   # D2 vira D1, D1 vira D2, D3 stay:
 *   npx tsx scripts/reorder-destaques.ts --edition 260529 --new-order 2,1,3
 *
 *   # Dry-run:
 *   npx tsx scripts/reorder-destaques.ts --edition 260529 --new-order 2,1,3 --dry-run
 *
 *   # Custom edition-dir (sobrescreve default data/editions/{AAMMDD}):
 *   npx tsx scripts/reorder-destaques.ts --edition 260529 --new-order 3,1,2 --edition-dir /tmp/test
 *
 * Validação:
 *   - --new-order DEVE ser permutação de [1,2,3]
 *   - Idempotente: reorder 1,2,3 = no-op (saída zero-changes)
 *   - Reorder + inverso = identity (#1606 review fix: 2× só identity em 2-cycles
 *     como [2,1,3]; 3-cycles como [3,1,2] precisam 3 aplicações pra fechar).
 *     Editor que quer desfazer reorder anterior deve usar o inverso explícito.
 */

import {
  existsSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  renameSync,
} from "node:fs";
import { resolve, dirname, basename, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

interface CliArgs {
  edition: string;
  newOrder: number[];
  editionDir: string;
  dryRun: boolean;
}

function parseArgs(argv: string[]): CliArgs {
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
  if (!args.edition || !args["new-order"]) {
    console.error(
      "Uso: reorder-destaques.ts --edition AAMMDD --new-order 2,1,3 [--edition-dir <path>] [--dry-run]",
    );
    process.exit(2);
  }
  const newOrder = args["new-order"].split(",").map((s) => parseInt(s.trim(), 10));
  if (
    newOrder.length !== 3 ||
    newOrder.some((n) => ![1, 2, 3].includes(n)) ||
    new Set(newOrder).size !== 3
  ) {
    console.error(
      `--new-order inválido: "${args["new-order"]}". Deve ser permutação de 1,2,3 (ex: 2,1,3 ou 3,1,2).`,
    );
    process.exit(2);
  }
  const editionDir =
    args["edition-dir"] ?? resolve(ROOT, "data", "editions", args.edition);
  return { edition: args.edition, newOrder, editionDir, dryRun };
}

interface FilesModified {
  rewritten: string[];
  renamed: Array<{ from: string; to: string }>;
}

/**
 * Reordena highlights[] em JSON file (01-approved.json ou 01-approved-capped.json).
 * newOrder[i] é o número canônico (1-based) do destaque que vai pra posição i.
 *
 * Ex: newOrder=[2,1,3] → highlights[0] = original highlights[1] (D2),
 *                       highlights[1] = original highlights[0] (D1),
 *                       highlights[2] = original highlights[2] (D3).
 */
export function reorderHighlightsInJson(
  json: { highlights?: unknown[] },
  newOrder: number[],
): boolean {
  const h = json.highlights;
  if (!Array.isArray(h) || h.length < 3) return false;
  const reordered = newOrder.map((n) => h[n - 1]);
  // Preserva slots 3+ (raro mas possível)
  const tail = h.slice(3);
  json.highlights = [...reordered, ...tail];
  return true;
}

/**
 * Reordena blocos DESTAQUE N em 02-reviewed.md. Renumera headers no
 * resultado (`DESTAQUE 1 | …` no top, `DESTAQUE 2 | …`, etc).
 *
 * Estratégia:
 *   1. Split MD em pre-destaques + N blocos DESTAQUE + post-destaques
 *   2. Reordenar blocos conforme newOrder
 *   3. Renumerar `DESTAQUE N | …` → posição final
 *   4. Re-join
 *
 * Não toca o frontmatter (caller cuida de intentional_error.location).
 */
export function reorderDestaquesInMd(md: string, newOrder: number[]): string {
  // Match cada bloco: header + content until next `---\n\n**DESTAQUE` OR
  // next non-destaque section (LANÇAMENTOS, RADAR/PESQUISAS/OUTRAS legacy, etc).
  // #1569: 📡 RADAR adicionado como terminator (caso 260529+ teve D3 engolindo
  // RADAR inteiro porque emoji ausente da lista).
  // Review #1606: `\Z` é literal Z em JS — usar `$(?![\s\S])` pra true EOF.
  const blockRe =
    /(\*\*DESTAQUE\s+\d+\s*\|[^\n]*\*\*[\s\S]*?)(?=\n+---\n+\*\*(?:DESTAQUE\s+\d|🚀|🔬|📰|📡|🛠️|VÍDEOS?|🎁|🙋|ERRO\s+INTENCIONAL|ASSINE)|$(?![\s\S]))/g;
  const blocks: string[] = [];
  const positions: Array<{ start: number; end: number }> = [];
  let m: RegExpExecArray | null;
  while ((m = blockRe.exec(md)) !== null) {
    blocks.push(m[1]);
    positions.push({ start: m.index, end: m.index + m[1].length });
  }
  if (blocks.length < 3) return md;

  // Reorder + renumerar
  const reorderedBlocks = newOrder.map((n, i) => {
    const block = blocks[n - 1];
    // Substitui "DESTAQUE N |" pra "DESTAQUE i+1 |" no header
    return block.replace(
      /^\*\*DESTAQUE\s+\d+(\s*\|)/m,
      `**DESTAQUE ${i + 1}$1`,
    );
  });
  const tail = blocks.slice(3);

  // Construir resultado: prefixo (antes do 1º block) + blocos reordenados +
  // sufixo (após o último block original).
  const firstStart = positions[0].start;
  const lastEnd = positions[positions.length - 1].end;
  const prefix = md.slice(0, firstStart);
  const suffix = md.slice(lastEnd);
  // Separator entre blocos: usar `\n\n---\n\n` (canônico do template)
  const blocksSerialized = [...reorderedBlocks, ...tail].join("\n\n---\n\n");
  return prefix + blocksSerialized + suffix;
}

/**
 * Atualiza frontmatter intentional_error.location quando refere a DESTAQUE N.
 * "DESTAQUE 2, paragrafo 2" + newOrder=[2,1,3] → "DESTAQUE 1, paragrafo 2"
 * (porque o que era D2 agora é D1).
 *
 * Review #1606: scope LIMITADO ao frontmatter (entre primeiros pares `---`)
 * pra evitar reescrever menção de DESTAQUE N em body text. Pré-fix, regex
 * com `location:` opcional matcheava body lines também.
 */
export function updateIntentionalErrorLocation(
  md: string,
  newOrder: number[],
): string {
  // Extrair frontmatter — só atua se o MD começa com YAML block.
  const fmMatch = md.match(/^(---\s*\n)([\s\S]*?)(\n---\s*\n)/);
  if (!fmMatch) return md;
  const [, openFence, fmBody, closeFence] = fmMatch;
  // Substituir DESTAQUE N dentro do frontmatter — exige prefixo `location:`
  // pra ser conservativo (evitar tocar outros campos).
  const newFmBody = fmBody.replace(
    /^(\s+location:\s+["'])DESTAQUE\s+(\d)(\s*,[^"'\n]*)?(["']?\s*)$/m,
    (full, pre, oldN, rest, post) => {
      const oldNum = parseInt(oldN, 10);
      if (![1, 2, 3].includes(oldNum)) return full;
      const newIdx = newOrder.indexOf(oldNum);
      if (newIdx < 0) return full;
      const newN = newIdx + 1;
      return `${pre}DESTAQUE ${newN}${rest ?? ""}${post ?? ""}`;
    },
  );
  if (newFmBody === fmBody) return md;
  return openFence + newFmBody + closeFence + md.slice(fmMatch[0].length);
}

/**
 * Reordena sections `## d{N}` em 03-social.md. Sintaxe é repetida por
 * plataforma (LinkedIn, Facebook), então re-aplicar pra cada bloco.
 *
 * Header pattern: `^## d(\d)\b` (case-insensitive). Renumerar igual ao MD.
 */
export function reorderSocialMd(md: string, newOrder: number[]): string {
  // Review #1612: dead-code loop de sectionRe removido. O reorder real é
  // o token-replace abaixo (## d{N} → ## TEMP_D{N} → ## d{newN}).
  if (!/^##\s+d\d/im.test(md)) return md;

  // Grupos por d-number. Pode haver múltiplas plataformas com d1/d2/d3.
  // Estratégia: pra cada plataforma block (sequência de d1/d2/d3 consecutiva),
  // reordenar. Por simplicidade, reorder GLOBAL — se há 2 plataformas, cada
  // d1 original vira d{newOrder.indexOf(1)+1}.
  let result = md;
  // Build mapping old N → new N
  const oldToNew = new Map<number, number>();
  for (let i = 0; i < newOrder.length; i++) {
    oldToNew.set(newOrder[i], i + 1);
  }
  // Replace each `## d{N}` header — usar token temporário pra evitar conflito
  // entre passes (## d1 → ## d2 → ## d1 oscilação).
  let temp = result;
  temp = temp.replace(/^##\s+d(\d)\s*$/gim, (full, oldNStr) => {
    const oldN = parseInt(oldNStr, 10);
    const newN = oldToNew.get(oldN);
    return newN ? `## TEMP_D${newN}` : full;
  });
  result = temp.replace(/^##\s+TEMP_D(\d)\s*$/gim, "## d$1");
  return result;
}

/**
 * Renomeia arquivos de imagem 04-d{N}-*.jpg conforme newOrder.
 * Estratégia: usar nomes temporários pra evitar colisão (renomeia
 * 04-d1-* → 04-tmp-d1-*, depois 04-tmp-d1-* → 04-d{newPos}-*).
 *
 * Retorna lista de renames aplicados.
 */
export function renameDestaqueImages(
  editionDir: string,
  newOrder: number[],
  dryRun: boolean,
): Array<{ from: string; to: string }> {
  const renames: Array<{ from: string; to: string }> = [];
  if (!existsSync(editionDir)) return renames;
  const files = readdirSync(editionDir).filter((f) =>
    /^04-d[123]-[a-z0-9]+\.(?:jpg|png|jpeg)$/i.test(f),
  );
  // Build oldN → newN map
  const oldToNew = new Map<number, number>();
  for (let i = 0; i < newOrder.length; i++) {
    oldToNew.set(newOrder[i], i + 1);
  }
  // 2-step rename pra evitar colisão
  for (const f of files) {
    const m = f.match(/^04-d([123])-(.+)$/);
    if (!m) continue;
    const oldN = parseInt(m[1], 10);
    const newN = oldToNew.get(oldN);
    if (!newN || newN === oldN) continue;
    const tmpName = f.replace(`04-d${oldN}-`, `04-TMP${oldN}-`);
    if (!dryRun) {
      renameSync(join(editionDir, f), join(editionDir, tmpName));
    }
    renames.push({ from: f, to: tmpName });
  }
  // Step 2: tmp → final
  if (!dryRun) {
    const tmpFiles = readdirSync(editionDir).filter((f) =>
      /^04-TMP[123]-[a-z0-9]+\.(?:jpg|png|jpeg)$/i.test(f),
    );
    for (const f of tmpFiles) {
      const m = f.match(/^04-TMP([123])-(.+)$/);
      if (!m) continue;
      const oldN = parseInt(m[1], 10);
      const newN = oldToNew.get(oldN)!;
      const finalName = `04-d${newN}-${m[2]}`;
      renameSync(join(editionDir, f), join(editionDir, finalName));
      renames.push({ from: f, to: finalName });
    }
  }
  return renames;
}

/**
 * Renomeia arquivos `_internal/02-d{N}-prompt.md` e `_internal/02-d{N}-sd-prompt.json`.
 */
export function renameDestaquePrompts(
  internalDir: string,
  newOrder: number[],
  dryRun: boolean,
): Array<{ from: string; to: string }> {
  const renames: Array<{ from: string; to: string }> = [];
  if (!existsSync(internalDir)) return renames;
  const files = readdirSync(internalDir).filter((f) =>
    /^02-d[123]-(?:prompt\.md|sd-prompt\.json|draft\.md)$/.test(f),
  );
  const oldToNew = new Map<number, number>();
  for (let i = 0; i < newOrder.length; i++) {
    oldToNew.set(newOrder[i], i + 1);
  }
  // 2-step rename
  for (const f of files) {
    const m = f.match(/^02-d([123])-(.+)$/);
    if (!m) continue;
    const oldN = parseInt(m[1], 10);
    const newN = oldToNew.get(oldN);
    if (!newN || newN === oldN) continue;
    const tmpName = f.replace(`02-d${oldN}-`, `02-TMP${oldN}-`);
    if (!dryRun) {
      renameSync(join(internalDir, f), join(internalDir, tmpName));
    }
    renames.push({ from: f, to: tmpName });
  }
  if (!dryRun) {
    const tmpFiles = readdirSync(internalDir).filter((f) =>
      /^02-TMP[123]-/.test(f),
    );
    for (const f of tmpFiles) {
      const m = f.match(/^02-TMP([123])-(.+)$/);
      if (!m) continue;
      const oldN = parseInt(m[1], 10);
      const newN = oldToNew.get(oldN)!;
      const finalName = `02-d${newN}-${m[2]}`;
      renameSync(join(internalDir, f), join(internalDir, finalName));
      renames.push({ from: f, to: finalName });
    }
  }
  return renames;
}

function processJsonFile(
  path: string,
  newOrder: number[],
  dryRun: boolean,
): boolean {
  if (!existsSync(path)) return false;
  const data = JSON.parse(readFileSync(path, "utf8"));
  const changed = reorderHighlightsInJson(data, newOrder);
  if (changed && !dryRun) {
    writeFileSync(path, JSON.stringify(data, null, 2) + "\n", "utf8");
  }
  return changed;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const editionDir = args.editionDir;
  if (!existsSync(editionDir)) {
    console.error(`Edition dir não encontrado: ${editionDir}`);
    process.exit(1);
  }
  const internalDir = resolve(editionDir, "_internal");

  // No-op se ordem é canônica
  if (args.newOrder.join(",") === "1,2,3") {
    console.log(JSON.stringify({ edition: args.edition, no_op: true }, null, 2));
    return;
  }

  const modified: FilesModified = { rewritten: [], renamed: [] };

  // 1. JSONs canônicos
  for (const f of ["01-approved.json", "01-approved-capped.json"]) {
    const path = resolve(internalDir, f);
    if (processJsonFile(path, args.newOrder, args.dryRun)) {
      modified.rewritten.push(path);
    }
  }

  // 2. 02-reviewed.md (incluindo frontmatter intentional_error)
  const mdPath = resolve(editionDir, "02-reviewed.md");
  if (existsSync(mdPath)) {
    let md = readFileSync(mdPath, "utf8");
    const before = md;
    md = updateIntentionalErrorLocation(md, args.newOrder);
    md = reorderDestaquesInMd(md, args.newOrder);
    if (md !== before) {
      if (!args.dryRun) writeFileSync(mdPath, md, "utf8");
      modified.rewritten.push(mdPath);
    }
  }

  // 3. 03-social.md
  const socialPath = resolve(editionDir, "03-social.md");
  if (existsSync(socialPath)) {
    const md = readFileSync(socialPath, "utf8");
    const reordered = reorderSocialMd(md, args.newOrder);
    if (reordered !== md) {
      if (!args.dryRun) writeFileSync(socialPath, reordered, "utf8");
      modified.rewritten.push(socialPath);
    }
  }

  // 4. Image files
  modified.renamed.push(
    ...renameDestaqueImages(editionDir, args.newOrder, args.dryRun),
  );

  // 5. Prompts
  modified.renamed.push(
    ...renameDestaquePrompts(internalDir, args.newOrder, args.dryRun),
  );

  console.log(
    JSON.stringify(
      {
        edition: args.edition,
        new_order: args.newOrder,
        dry_run: args.dryRun,
        modified,
      },
      null,
      2,
    ),
  );
}

const _argv1 = process.argv[1]?.replaceAll("\\", "/") ?? "";
if (
  import.meta.url === `file://${_argv1}` ||
  import.meta.url === `file:///${_argv1.replace(/^\//, "")}`
) {
  try {
    main();
  } catch (e) {
    console.error("Fatal:", e);
    process.exit(2);
  }
}
