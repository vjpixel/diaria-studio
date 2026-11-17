/**
 * splice-social-sections.ts (#13431)
 *
 * Integra em `03-social.md` as seções de UM ou mais destaques reescritos no
 * Stage 4 (troca/promoção de destaque, §4d.1b; cascata `social`, §4d.1a passo
 * e), sem tocar o resto do arquivo. Substitui o splice manual que o
 * orchestrator fazia colando o retorno do `social-writer`/`social-curto` em
 * escopo reduzido.
 *
 * Por que script e não splice à mão: o caminho do Stage 2 (`merge-social-md.ts`)
 * remove os comentários HTML que os agents deixam no tmp (`<!-- char_count:
 * ... -->`, #875) antes de gravar; o splice à mão do Stage 4 não passava por
 * esse strip, e os comentários ficavam no artefato (`03-social.md`). O preview
 * e os publishers já os removem desde o #13430, mas o arquivo divergia entre
 * os dois caminhos. Aqui o strip é o MESMO (`stripHtmlComments`, depth-aware,
 * aborta em comentário mal-formado).
 *
 * Entrada (os tmps que o prompt de re-disparo manda gravar):
 *   - `_internal/03-social.tmp.md` (social-writer): `## d{N}` e, desde o
 *     #12094, `## d{N}-cards`. Seções de outros destaques no tmp são ignoradas.
 *   - `_internal/03-curto.tmp.md` (social-curto): `## d{N}`. Opcional.
 *   Pelo menos um dos dois precisa existir.
 *
 * Saída: `03-social.md` com os blocos `## d{N}`/`## d{N}-cards` de `# Social`
 * e `## d{N}` de `# Curto` trocados pelo texto novo. Os tmps lidos são
 * apagados depois da gravação (como no merge), salvo `--keep-tmp`.
 *
 * NÃO recarimba `_internal/.social-source-hash.json`: o recarimbo segue como
 * passo separado (`refresh-social-hash.ts`), depois deste, como o `next_steps`
 * do swap já pede (#9169).
 *
 * Uso:
 *   npx tsx scripts/splice-social-sections.ts --edition-dir data/editions/AAMMDD \
 *     --destaque d2[,d3] [--social-tmp P] [--curto-tmp P] [--keep-tmp]
 *
 * Exit codes:
 *   0 — splice feito (JSON em stdout)
 *   1 — argumento inválido, tmp ausente, seção ausente no tmp ou no
 *       `03-social.md`, comentário HTML mal-formado, tool-call cru, falha de FS
 */

import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { isMainModule } from "./lib/cli-args.ts";
import { carouselCardsSectionId, extractDestaqueBlock } from "./lib/extract-section.ts";
import { detectToolCallArtifactsAnywhere } from "./lib/lint-checks/no-xml-artifacts.ts";
import { stripHtmlComments } from "./merge-social-md.ts";

const DESTAQUE_RE = /^d[1-3]$/;

export interface SectionSpan {
  /** Índice do primeiro caractere depois da linha `## id`. */
  bodyStart: number;
  /** Índice exclusivo: começo do `\n` que antecede o próximo heading, ou fim da seção. */
  bodyEnd: number;
}

/** Faixa `[start, end)` do corpo da seção `# {title}` (sem a linha do heading). */
function findTopSection(md: string, title: string): { start: number; end: number } | null {
  const re = new RegExp(`(^|\\n)# ${title}[ \\t]*\\n`, "i");
  const m = re.exec(md);
  if (!m) return null;
  const start = m.index + m[0].length;
  const next = md.slice(start).search(/\n# /);
  return { start, end: next === -1 ? md.length : start + next };
}

/**
 * Localiza o corpo do bloco `## {id}` dentro de `md[from, to)`. Termina no
 * próximo `## `/`# ` (mesmo terminador de `extractDestaqueBlock`, #4309), então
 * `## d1` nunca casa `## d1-cards`.
 */
export function findBlockSpan(md: string, id: string, from: number, to: number): SectionSpan | null {
  const region = md.slice(from, to);
  const re = new RegExp(`(^|\\n)## ${id}[ \\t]*\\n`, "i");
  const m = re.exec(region);
  if (!m) return null;
  const bodyStart = from + m.index + m[0].length;
  const rest = md.slice(bodyStart, to);
  const next = rest.search(/\n## |\n# /);
  return { bodyStart, bodyEnd: next === -1 ? to : bodyStart + next };
}

export interface SpliceBlocks {
  /** Corpo novo do `## d{N}` de `# Social`. */
  social?: string;
  /** Corpo novo do `## d{N}-cards` de `# Social`. */
  cards?: string;
  /** Corpo novo do `## d{N}` de `# Curto`. */
  curto?: string;
}

function formatBody(body: string): string {
  return `\n${body.trim()}\n`;
}

/**
 * Troca, num `03-social.md` já com LF, os blocos de `destaque` pelos corpos
 * de `blocks`. Lança quando o bloco a trocar não existe no arquivo — com uma
 * exceção: `## d{N}-cards` ausente (edição anterior ao #12094) é inserido logo
 * depois do `## d{N}`.
 */
export function spliceSocialMd(md: string, destaque: string, blocks: SpliceBlocks): {
  md: string;
  spliced: string[];
} {
  let out = md;
  const spliced: string[] = [];

  const replace = (sectionTitle: string, id: string, body: string): boolean => {
    const sec = findTopSection(out, sectionTitle);
    if (!sec) throw new Error(`seção "# ${sectionTitle}" ausente em 03-social.md`);
    const span = findBlockSpan(out, id, sec.start, sec.end);
    if (!span) return false;
    out = out.slice(0, span.bodyStart) + formatBody(body) + out.slice(span.bodyEnd);
    spliced.push(`${sectionTitle.toLowerCase()}:${id}`);
    return true;
  };

  if (blocks.social !== undefined) {
    if (!replace("Social", destaque, blocks.social)) {
      throw new Error(`bloco "## ${destaque}" ausente em "# Social" do 03-social.md`);
    }
  }
  if (blocks.cards !== undefined) {
    const cardsId = carouselCardsSectionId(destaque);
    if (!replace("Social", cardsId, blocks.cards)) {
      // Edição anterior ao #12094: inserir o bloco logo depois do `## d{N}`.
      const sec = findTopSection(out, "Social");
      const span = sec ? findBlockSpan(out, destaque, sec.start, sec.end) : null;
      if (!span) {
        throw new Error(`não dá pra inserir "## ${cardsId}": "## ${destaque}" ausente em "# Social"`);
      }
      const insert = `\n\n## ${cardsId}\n\n${blocks.cards.trim()}\n`;
      // span.bodyEnd aponta pro `\n` antes do próximo heading (ou fim): o corpo
      // do `## d{N}` termina em `\n`; tirar o `\n` final evita linha em branco dupla.
      const head = out.slice(0, span.bodyEnd).replace(/\n+$/, "");
      out = head + insert + out.slice(span.bodyEnd);
      spliced.push(`social:${cardsId}`);
    }
  }
  if (blocks.curto !== undefined) {
    if (!replace("Curto", destaque, blocks.curto)) {
      throw new Error(`bloco "## ${destaque}" ausente em "# Curto" do 03-social.md`);
    }
  }
  return { md: out, spliced };
}

/**
 * Extrai os corpos de `destaque` de um tmp já lido: strip de comentários HTML
 * (o mesmo do merge do Stage 2) e conferência de tool-call cru.
 */
export function readTmpBlocks(
  raw: string,
  ids: string[],
  label: string,
): { blocks: Record<string, string | null>; warnings: string[] } {
  const { stripped, warnings } = stripHtmlComments(raw.replace(/\r\n/g, "\n"));
  const artifacts = detectToolCallArtifactsAnywhere(stripped);
  if (artifacts.length > 0) {
    throw new Error(
      `${label}: sintaxe de tool-call crua no tmp (#4987): ` +
        artifacts.map((a) => `linha ${a.line}: ${a.text}`).join("; "),
    );
  }
  const blocks: Record<string, string | null> = {};
  for (const id of ids) {
    const body = extractDestaqueBlock(stripped, id);
    blocks[id] = body !== null && body.trim() ? body.trim() : null;
  }
  return { blocks, warnings };
}

export interface SpliceOptions {
  editionDir: string;
  destaques: string[];
  socialTmp?: string;
  curtoTmp?: string;
  keepTmp?: boolean;
}

export interface SpliceResult {
  ok: true;
  out: string;
  spliced: string[];
  removed_tmps: string[];
  warnings: string[];
  next_steps: string[];
}

export function runSplice(opts: SpliceOptions): SpliceResult {
  for (const d of opts.destaques) {
    if (!DESTAQUE_RE.test(d)) throw new Error(`--destaque inválido: "${d}" (esperado d1, d2 ou d3)`);
  }
  const editionDir = resolve(opts.editionDir);
  const outPath = resolve(editionDir, "03-social.md");
  if (!existsSync(outPath)) throw new Error(`03-social.md ausente: ${outPath}`);
  const socialTmp = resolve(opts.socialTmp ?? resolve(editionDir, "_internal/03-social.tmp.md"));
  const curtoTmp = resolve(opts.curtoTmp ?? resolve(editionDir, "_internal/03-curto.tmp.md"));
  const hasSocial = existsSync(socialTmp);
  const hasCurto = existsSync(curtoTmp);
  if (!hasSocial && !hasCurto) {
    throw new Error(`nenhum tmp encontrado: ${socialTmp} / ${curtoTmp}`);
  }

  const original = readFileSync(outPath, "utf8");
  const crlf = original.includes("\r\n");
  let md = original.replace(/\r\n/g, "\n");
  const warnings: string[] = [];
  const spliced: string[] = [];

  const socialIds = opts.destaques.flatMap((d) => [d, carouselCardsSectionId(d)]);
  const social = hasSocial
    ? readTmpBlocks(readFileSync(socialTmp, "utf8"), socialIds, "social-writer")
    : null;
  const curto = hasCurto ? readTmpBlocks(readFileSync(curtoTmp, "utf8"), opts.destaques, "social-curto") : null;
  if (social) warnings.push(...social.warnings);
  if (curto) warnings.push(...curto.warnings);

  for (const d of opts.destaques) {
    const blocks: SpliceBlocks = {};
    if (social) {
      const caption = social.blocks[d];
      if (caption === null) throw new Error(`"## ${d}" ausente ou vazio em ${socialTmp}`);
      blocks.social = caption;
      const cardsId = carouselCardsSectionId(d);
      const cards = social.blocks[cardsId];
      if (cards !== null) {
        blocks.cards = cards;
      } else {
        const sec = findTopSection(md, "Social");
        if (sec && findBlockSpan(md, cardsId, sec.start, sec.end)) {
          // Integrar só a legenda deixaria a arte do carrossel com o ângulo velho (#12094).
          throw new Error(
            `"## ${cardsId}" ausente em ${socialTmp}, mas existe em 03-social.md: ` +
              `re-despachar o social-writer pedindo também o ## ${cardsId}`,
          );
        }
      }
    }
    if (curto) {
      const body = curto.blocks[d];
      if (body === null) {
        warnings.push(`"## ${d}" ausente em ${curtoTmp}: # Curto de ${d} não foi trocado`);
      } else {
        blocks.curto = body;
      }
    }
    const r = spliceSocialMd(md, d, blocks);
    md = r.md;
    spliced.push(...r.spliced);
  }

  writeFileSync(outPath, crlf ? md.replace(/\n/g, "\r\n") : md, "utf8");

  const removed: string[] = [];
  if (!opts.keepTmp) {
    for (const [present, p] of [[hasSocial, socialTmp], [hasCurto, curtoTmp]] as const) {
      if (!present) continue;
      try {
        unlinkSync(p);
        removed.push(p);
      } catch (err) {
        warnings.push(`falha apagando ${p}: ${(err as Error).message}`);
      }
    }
  }

  return {
    ok: true,
    out: outPath,
    spliced,
    removed_tmps: removed,
    warnings,
    next_steps: [
      `npx tsx scripts/refresh-social-hash.ts --edition-dir ${opts.editionDir.replace(/\/+$/, "")} (#9169)`,
      `Re-humanizar SCOPED as seções trocadas (${spliced.join(", ")}) e re-renderizar o social preview`,
    ],
  };
}

function parseArgs(argv: string[]): SpliceOptions | string {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 && i + 1 < argv.length && !argv[i + 1].startsWith("--") ? argv[i + 1] : undefined;
  };
  const editionDir = get("--edition-dir");
  const destaque = get("--destaque");
  if (!editionDir || !destaque) {
    return "uso: splice-social-sections.ts --edition-dir <dir> --destaque d{N}[,d{M}] [--social-tmp P] [--curto-tmp P] [--keep-tmp]";
  }
  return {
    editionDir,
    destaques: destaque.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean),
    socialTmp: get("--social-tmp"),
    curtoTmp: get("--curto-tmp"),
    keepTmp: argv.includes("--keep-tmp"),
  };
}

if (isMainModule(import.meta.url)) {
  const parsed = parseArgs(process.argv.slice(2));
  if (typeof parsed === "string") {
    console.error(parsed);
    process.exit(1);
  }
  try {
    const r = runSplice(parsed);
    for (const w of r.warnings) console.error(`splice-social-sections: warn — ${w}`);
    console.log(JSON.stringify(r, null, 2));
  } catch (err) {
    console.error(`splice-social-sections: FALHOU — ${(err as Error).message}`);
    process.exit(1);
  }
}
