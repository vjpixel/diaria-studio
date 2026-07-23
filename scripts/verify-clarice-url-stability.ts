/**
 * verify-clarice-url-stability.ts (#873)
 *
 * Compara as URLs em duas versões de um MD da newsletter (pré-Clarice
 * vs pós-Clarice/pós-humanize) e verifica que nenhuma URL na seção
 * LANÇAMENTOS foi alterada por Clarice. URL "limpa" pelo Clarice (ex:
 * remoção de query params, normalização de path, trailing slash) é
 * detectada como mudança e reportada.
 *
 * Para LANÇAMENTOS, qualquer alteração é tratada como erro fatal — a
 * regra "LANÇAMENTOS só com link oficial" (#160) depende de match
 * exato com whitelist; uma URL "normalizada" pode passar a não bater
 * mais e quebrar a validação.
 *
 * Para outras seções (PESQUISAS, NOTÍCIAS), URLs adicionadas/removidas
 * geram apenas warning (informativo, exit 0).
 *
 * Uso:
 *   npx tsx scripts/verify-clarice-url-stability.ts \
 *     --pre <pre-clarice.md> --post <reviewed.md>
 *
 * Exit codes:
 *   0  Todas URLs em LANÇAMENTOS estáveis (warnings em outras seções
 *      são informativos)
 *   1  URL em LANÇAMENTOS mudou — diff impresso em stderr
 *   2  Erro de leitura/argumento
 *
 * Output JSON em stdout:
 *   {
 *     status: "ok" | "error",
 *     lancamento_changes: [{ before, after }],
 *     other_changes: [{ section, kind: "added"|"removed", url }]
 *   }
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgsSimple, isMainModule } from "./lib/cli-args.ts";
import { SECTION_EMOJI_PREFIX } from "./lib/section-naming.ts"; // #3955 fonte única do prefixo de emoji

export type Section = "LANCAMENTOS" | "PESQUISAS" | "NOTICIAS" | "OUTRAS";

const URL_RE = /https?:\/\/\S+/g;

// List item line. Aceita 2 formatos:
//   - bullet marker legacy (`-`, `*`, `+`) ou numerado (`1.`, `2.`).
//   - #3955: `**[Título](URL)**` SEM bullet — o formato REAL de
//     `02-pre-clarice.md`/`02-reviewed.md` (confirmado em
//     `context/templates/newsletter.md` + `singularize-md-sections.ts`
//     `countItemsAfter`, que já usa `/^\*\*\[/` pra contar items). O regex
//     antigo (só bullet) nunca casava esse formato — todo item real ficava
//     invisível à extração, mesmo quando o header da seção era reconhecido.
// URLs só contam quando aparecem numa linha de item; URLs em parágrafos
// narrativos são intencionalmente ignoradas pra evitar falsos-positivos
// quando o humanizer reordena prosa ao redor de URLs.
const LIST_ITEM_RE = /^\s*(?:(?:[-*+]|\d+\.)\s+|\*\*\[)/;

// Headers — accept "## Header" (Stage 1), plain caps (Stage 2 legado) ou
// bold+emoji (Stage 2 REAL, #3955).
//
// #3955: antes deste fix, `SECTION_PATTERNS` só casava o header cru
// ("LANÇAMENTOS", sem `**` nem emoji) — mas o header real emitido por
// `singularize-md-sections.ts` (que roda logo após o normalize, ANTES do
// humanizer/Clarice — ou seja, ANTES deste script comparar pré/pós) é
// `**🚀 LANÇAMENTOS**` (bold + emoji + singular/plural via `S?`). A regex
// nunca casava esse formato, então `detectSection` nunca reconhecia o
// header real — TODAS as URLs de uma edição real caíam no bucket OUTRAS, e
// o guard ficava estruturalmente incapaz de detectar mudança de URL em
// LANÇAMENTOS (sempre `status: "ok"` incondicional). Reusa
// `SECTION_EMOJI_PREFIX` de `section-naming.ts` (mesma fonte única já usada
// por `validate-section-structure.ts` e `render-erro-intencional.ts`) em vez
// de reinventar o range Unicode do emoji localmente.
const MD_HEADER_PREFIX = String.raw`(?:##\s+)?`;
const BOLD_OPT = String.raw`(?:\*\*)?`;

function sectionHeaderRe(namePattern: string): RegExp {
  return new RegExp(
    String.raw`^${MD_HEADER_PREFIX}${BOLD_OPT}${SECTION_EMOJI_PREFIX}(?:${namePattern})${BOLD_OPT}\s*$`,
    "iu",
  );
}

// PESQUISAS/NOTÍCIAS não recebem o mesmo grau de confirmação real que
// LANÇAMENTOS aqui: são buckets informativos (nunca fatais — só LANÇAMENTOS
// é fatal), e PESQUISAS é seção legacy (removida em #1569, papers mergeiam em
// RADAR via stitch). Os patterns ainda ganham bold+emoji opcional pra
// consistência e pra não regredir se alguma edição antiga precisar re-passar
// por este script.
const SECTION_PATTERNS: Array<{ section: Section; re: RegExp }> = [
  { section: "LANCAMENTOS", re: sectionHeaderRe(String.raw`LAN[ÇC]AMENTOS?`) },
  { section: "PESQUISAS", re: sectionHeaderRe(String.raw`PESQUISAS?`) },
  { section: "NOTICIAS", re: sectionHeaderRe(String.raw`(?:OUTRAS?\s+)?NOT[ÍI]CIAS?`) },
];

const SECTION_BREAK_RE = /^---\s*$/;

// #3955: boundary genérico pra headers top-level do formato Stage 2 real que
// NÃO são um dos `SECTION_PATTERNS` acima (RADAR, USE MELHOR, VÍDEOS, É IA?,
// SORTEIO, PARA ENCERRAR, ERRO INTENCIONAL) — mesma lista de sentinelas usada
// em `render-erro-intencional.ts`. Sem isso, se um desses headers aparecer
// sem um `---` explícito antes (o template sempre tem um, mas é defesa em
// profundidade — reordenação/corrupção estrutural é justamente o cenário que
// #1205/#3950 documentam), o `current` bucket anterior (ex: LANCAMENTOS)
// vazaria pros itens da seção seguinte.
const DESTAQUE_HEADER_RE = /^\*{0,2}DESTAQUE\s+\d+\s*\|/i;
const OTHER_TOPLEVEL_HEADER_RE = new RegExp(
  String.raw`^\*{0,2}${SECTION_EMOJI_PREFIX}(?:É\s+IA\?|USE\s+MELHOR|V[ÍI]DEOS?|RADAR|SORTEIO|PARA\s+ENCERRAR|ERRO\s+INTENCIONAL)\*{0,2}\s*$`,
  "iu",
);

function trimUrl(url: string): string {
  // #3955: `*` incluído no char class — items sem bullet vêm como
  // `**[Título](URL)**`, e `\S+` do URL_RE captura os `)**` de fechamento
  // junto com a URL (ex: "https://x.com/y)**"). Sem o `*` aqui, o trim
  // deixava o `**` de bold grudado na URL extraída.
  return url.replace(/[).,;*]+$/, "");
}

function detectSection(line: string): Section | null {
  const trimmed = line.trim();
  for (const { section, re } of SECTION_PATTERNS) {
    if (re.test(trimmed)) return section;
  }
  return null;
}

function isSectionBoundary(line: string): boolean {
  const trimmed = line.trim();
  if (SECTION_BREAK_RE.test(trimmed)) return true;
  // Plain-caps header (>5 chars, e.g. "DESTAQUE 1") signals section change too.
  const isPlainCaps = /^[A-ZÇÃÕÁÉÍÓÚÊÔ ]+$/.test(trimmed) && trimmed.length > 5;
  const isMdHeader = /^##\s+\S/.test(trimmed);
  // #3955: outros headers top-level do formato bold real (DESTAQUE N, É IA?,
  // USE MELHOR, VÍDEOS, RADAR, SORTEIO, PARA ENCERRAR, ERRO INTENCIONAL)
  // também fecham a seção atual — sem isso, `current` vazaria pro conteúdo
  // dessas seções quando não há `---` explícito antes delas.
  const isOtherKnownHeader =
    DESTAQUE_HEADER_RE.test(trimmed) || OTHER_TOPLEVEL_HEADER_RE.test(trimmed);
  return isPlainCaps || isMdHeader || isOtherKnownHeader;
}

/**
 * Extrai URLs de cada seção do MD, dedupadas por URL string.
 * Retorna mapa section -> URLs[] na ordem em que aparecem.
 */
export function extractUrlsBySection(text: string): Record<Section, string[]> {
  const lines = text.split("\n");
  const out: Record<Section, string[]> = {
    LANCAMENTOS: [],
    PESQUISAS: [],
    NOTICIAS: [],
    OUTRAS: [],
  };
  const seen: Record<Section, Set<string>> = {
    LANCAMENTOS: new Set(),
    PESQUISAS: new Set(),
    NOTICIAS: new Set(),
    OUTRAS: new Set(),
  };
  let current: Section = "OUTRAS";

  for (const line of lines) {
    const detected = detectSection(line);
    if (detected) {
      current = detected;
      continue;
    }
    // A header for one of the known sections always sets `current`. Any
    // other section boundary (---, plain caps that's not a known section,
    // or a markdown ## header that's not a known section) resets to OUTRAS.
    if (isSectionBoundary(line)) {
      current = "OUTRAS";
      continue;
    }
    // Only extract URLs from list-item lines. URLs embedded in narrative
    // paragraphs are ignored — Clarice/humanizer reorder prose freely
    // and that motion would otherwise produce false-positive add/remove
    // diffs across sections (#889 review P2).
    if (!LIST_ITEM_RE.test(line)) continue;
    const matches = line.matchAll(URL_RE);
    for (const m of matches) {
      const url = trimUrl(m[0]);
      if (!seen[current].has(url)) {
        seen[current].add(url);
        out[current].push(url);
      }
    }
  }

  return out;
}

export interface UrlStabilityResult {
  status: "ok" | "error";
  lancamento_changes: Array<{ before: string; after: string }>;
  other_changes: Array<{
    section: Exclude<Section, "LANCAMENTOS">;
    kind: "added" | "removed";
    url: string;
  }>;
}

/**
 * Compara URLs pre/post na seção LANÇAMENTOS por posição (i-ésima URL
 * pre vs i-ésima URL post). Se diferente, é uma "alteração in-place"
 * (ex: trailing slash, remoção de query) — fatal.
 *
 * URLs adicionadas/removidas em LANÇAMENTOS também são fatais (Clarice
 * não deveria mexer em URLs).
 *
 * URLs em outras seções: changes geram warnings (não fatais).
 */
export function compareUrls(
  pre: Record<Section, string[]>,
  post: Record<Section, string[]>,
): UrlStabilityResult {
  const lancamento_changes: UrlStabilityResult["lancamento_changes"] = [];
  const other_changes: UrlStabilityResult["other_changes"] = [];

  // LANÇAMENTOS: bucket-a-bucket comparison. Treat reorder as fine
  // (compare set membership). Anything different is fatal.
  const preLanc = pre.LANCAMENTOS;
  const postLanc = post.LANCAMENTOS;
  const preLancSet = new Set(preLanc);
  const postLancSet = new Set(postLanc);

  // Find URLs that disappeared and matching ones that appeared.
  const removedFromLanc = preLanc.filter((u) => !postLancSet.has(u));
  const addedToLanc = postLanc.filter((u) => !preLancSet.has(u));

  // Pair removed/added by position to produce explicit before/after diffs
  // (typical Clarice corruption: same slot, different normalized URL).
  const pairCount = Math.min(removedFromLanc.length, addedToLanc.length);
  for (let i = 0; i < pairCount; i++) {
    lancamento_changes.push({ before: removedFromLanc[i], after: addedToLanc[i] });
  }
  // Any leftover removed-only or added-only entries also count as fatal.
  for (let i = pairCount; i < removedFromLanc.length; i++) {
    lancamento_changes.push({ before: removedFromLanc[i], after: "" });
  }
  for (let i = pairCount; i < addedToLanc.length; i++) {
    lancamento_changes.push({ before: "", after: addedToLanc[i] });
  }

  // Outras seções: só warnings.
  for (const section of ["PESQUISAS", "NOTICIAS", "OUTRAS"] as const) {
    const preSet = new Set(pre[section]);
    const postSet = new Set(post[section]);
    for (const url of pre[section]) {
      if (!postSet.has(url)) {
        other_changes.push({ section, kind: "removed", url });
      }
    }
    for (const url of post[section]) {
      if (!preSet.has(url)) {
        other_changes.push({ section, kind: "added", url });
      }
    }
  }

  return {
    status: lancamento_changes.length === 0 ? "ok" : "error",
    lancamento_changes,
    other_changes,
  };
}

export function verifyStability(preText: string, postText: string): UrlStabilityResult {
  return compareUrls(extractUrlsBySection(preText), extractUrlsBySection(postText));
}

function main(): void {
  const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const argv = parseArgsSimple(process.argv.slice(2));
  const pre = argv.pre;
  const post = argv.post;
  if (!pre || !post) {
    console.error(
      "Uso: verify-clarice-url-stability.ts --pre <pre-clarice.md> --post <reviewed.md>",
    );
    process.exit(2);
  }
  const prePath = resolve(ROOT, pre);
  const postPath = resolve(ROOT, post);
  if (!existsSync(prePath)) {
    console.error(`Arquivo pré-Clarice não existe: ${prePath}`);
    process.exit(2);
  }
  if (!existsSync(postPath)) {
    console.error(`Arquivo pós-Clarice não existe: ${postPath}`);
    process.exit(2);
  }

  const preText = readFileSync(prePath, "utf8");
  const postText = readFileSync(postPath, "utf8");
  const result = verifyStability(preText, postText);

  console.log(JSON.stringify(result, null, 2));

  if (result.other_changes.length > 0) {
    console.error(
      `\n⚠ ${result.other_changes.length} URL(s) mudou em outras seções (informativo):`,
    );
    for (const c of result.other_changes) {
      console.error(`  ${c.section} [${c.kind}]: ${c.url}`);
    }
  }

  if (result.status === "error") {
    console.error(
      `\n❌ Clarice alterou ${result.lancamento_changes.length} URL(s) em LANÇAMENTOS — risco de quebrar #160 (link oficial).`,
    );
    for (const c of result.lancamento_changes) {
      if (c.before && c.after) {
        console.error(`  antes:  ${c.before}`);
        console.error(`  depois: ${c.after}`);
        console.error("");
      } else if (c.before) {
        console.error(`  removida: ${c.before}`);
      } else {
        console.error(`  adicionada: ${c.after}`);
      }
    }
    console.error(
      "Restaure as URLs originais em `02-reviewed.md` antes de prosseguir, ou aceite explicitamente como caso de borda.",
    );
    process.exit(1);
  }
}

if (isMainModule(import.meta.url)) {
  main();
}
