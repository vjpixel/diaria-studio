#!/usr/bin/env tsx
/**
 * lint-test-email-structure.ts (#1248)
 *
 * Compara contagens estruturais do email vs source MD pra detectar:
 *  - Seção faltando (#section_missing)
 *  - Ordem de destaques diferente (#destaque_order_mismatch)
 *  - É IA? ausente no email mas presente no source (#eia_section_missing)
 *  - Contagem de itens divergente em LANÇAMENTOS/PESQUISAS/OUTRAS NOTÍCIAS
 *
 * Estratégia: extrai estrutura de cada lado por regex/heurística e compara.
 * Não substitui validate-stage-2 — esse roda ANTES do paste; este roda DEPOIS,
 * capturando drift entre source MD e o que o template Beehiiv renderiza.
 *
 * Uso:
 *   npx tsx scripts/lint-test-email-structure.ts \
 *     --email-file /tmp/email-260514.txt \
 *     --source-md data/editions/260514/02-reviewed.md \
 *     --out /tmp/lint-structure.json
 *
 * Exit codes:
 *   0 = estrutura bate
 *   1 = ao menos 1 mismatch
 *   2 = erro de uso
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
// #1836: fonte única do prefixo de emoji de seção (mandatório + opcional).
import { SECTION_EMOJI, SECTION_EMOJI_PREFIX } from "./lib/section-naming.ts";
import { parseArgs, isMainModule } from "./lib/cli-args.ts";

export interface StructureIssue {
  // #1721: `section_item_count_mismatch` removido — era declarado mas NUNCA
  // emitido (compareStructure compara só PRESENÇA de seção, não contagem; o
  // count do email é heurístico → comparar geraria falso-positivo, e o caso
  // email=0/source>0 já é coberto por `section_missing`).
  type:
    | "eia_section_missing"
    | "section_missing"
    | "destaque_count_mismatch"
    | "destaque_order_mismatch";
  section?: string;
  source_count?: number;
  email_count?: number;
  details: string;
}

export interface StructureSnapshot {
  has_eia: boolean;
  destaques: string[]; // títulos extraídos
  sections: { name: string; item_count: number }[];
}

export interface StructureResult {
  source: StructureSnapshot;
  email: StructureSnapshot;
  issues: StructureIssue[];
}

// #1569: RADAR substitui PESQUISAS + OUTRAS NOTÍCIAS em edições novas.
// Legacy aliases mantidos pra re-lint de edições antigas (re-render).
// #1660: USE MELHOR (#1568) e VÍDEOS (#1629) FALTAVAM — sem eles o lint não
// emitia section_missing quando o paste no Beehiiv dropava/truncava essas
// seções, e o slice de RADAR corria até o fim (sem boundary de VÍDEOS),
// super-contando links de RADAR. Cada seção carrega o `name` canônico + um
// `body` regex que tolera acento (í/i) e singular/plural (#1324) — usado tanto
// no path MD (regex) quanto no path email (antes `indexOf` literal, frágil).
interface KnownSection {
  /** Nome canônico exibido no snapshot/diff. */
  name: string;
  /** Corpo do regex do header (sem âncoras), igual ao newsletter-count.ts. */
  body: string;
}
const KNOWN_SECTIONS: KnownSection[] = [
  { name: "LANÇAMENTOS", body: "LAN[ÇC]AMENTOS?" },
  { name: "RADAR", body: "RADAR" },
  { name: "PESQUISAS", body: "PESQUISAS?" },
  { name: "OUTRAS NOTÍCIAS", body: "OUTRAS?\\s+NOT[ÍI]CIAS?" },
  { name: "USE MELHOR", body: "USE\\s+MELHOR" },
  { name: "VÍDEOS", body: "V[ÍI]DEOS?" },
];

// Prefixo emoji de header de seção (📡 RADAR, 🛠️ USE MELHOR, 📺 VÍDEOS, ...).
// OPCIONAL no path MD (que ancora em `**...**`); OBRIGATÓRIO no path email
// (#1660 review): sem `**`, ancorar no emoji impede que um keyword bare ("vídeo",
// "radar", "use melhor") case em prosa/headline/URL e crie seção FANTASMA — o
// que mascarava `section_missing` (presença-por-nome em compareStructure ficava
// satisfeita pelo fantasma). O render sempre prefixa o header com emoji
// (section-naming.ts: 🚀📡🛠️📺, fallback 📰).
// #1836: SECTION_EMOJI (mandatório) + SECTION_EMOJI_PREFIX (opcional) vêm do
// registry section-naming.ts — antes havia cópia local idêntica aqui.
const SECTION_EMOJI_OPT = SECTION_EMOJI_PREFIX;

/**
 * Extrai snapshot estrutural de MD (source).
 *
 * Destaques: linhas tipo `**DESTAQUE N | CATEGORIA**` seguidas por
 * `**[Título](URL)**` — capturamos o título da primeira opção.
 */
export function extractMdStructure(md: string): StructureSnapshot {
  const has_eia = /É\s+IA\?/i.test(md);
  const destaques: string[] = [];

  // Match `**DESTAQUE N | ...**` blocks; capture next title line
  const destaqueRe = /\*\*DESTAQUE\s+(\d+)[^*]*\*\*\s*\n\s*\n\s*\*\*\[([^\]]+)\]/g;
  let m: RegExpExecArray | null;
  while ((m = destaqueRe.exec(md)) !== null) {
    destaques.push(m[2]);
  }

  // Sections: count items em `**SECTION**` block até próximo `---` ou outra section.
  // Review #1612: aceitar emoji prefix opcional (📡 RADAR, 🚀 LANÇAMENTOS,
  // 📰 OUTRAS NOTÍCIAS). Sem isso, regex `\*\*RADAR\*\*` não matchava
  // `**📡 RADAR**` real-world. (#1660: emoji prefix movido pra const de módulo.)
  const sections: { name: string; item_count: number }[] = [];
  for (const sec of KNOWN_SECTIONS) {
    const secRe = new RegExp(`\\*\\*${SECTION_EMOJI_OPT}${sec.body}\\*\\*([\\s\\S]*?)(?=\\n---|\\n\\*\\*[A-ZÇÃÕÉ\\s🎁🙋📡]|$)`, "iu");
    const match = md.match(secRe);
    if (!match) continue;
    const body = match[1];
    // Conta linhas de item: `**[Title](URL)**` na seção
    const items = body.match(/\*\*\[[^\]]+\]\([^)]+\)\*\*/g) ?? [];
    sections.push({ name: sec.name, item_count: items.length });
  }

  return { has_eia, destaques, sections };
}

/**
 * Extrai snapshot estrutural do email renderizado (HTML ou plain).
 *
 * Estratégia:
 * - Plain text: usa heurística por linha (uppercase section headers).
 * - HTML: extrai texto e roda mesma heurística + complementa com tags.
 *
 * Capta o suficiente pra contagem; não precisa parse HTML perfeito.
 */
export function extractEmailStructure(content: string): StructureSnapshot {
  // Strip HTML tags grosseiramente
  const text = content
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");

  const has_eia = /É\s*IA\?/i.test(text);

  // Destaques: heurística por categoria label (uppercase) + título imediato.
  // Categorias conhecidas observadas em emails: MERCADO, LANÇAMENTO, REGULAÇÃO,
  // PESQUISA, EMPRESAS, EDUCAÇÃO, etc.
  const destaques: string[] = [];
  // Match: CATEGORY (uppercase) + opcional emoji + ate o proximo CATEGORY
  // Pra simplificar, vamos extrair o que aparece após DESTAQUE [N] em label.
  // Plain text do email geralmente NÃO tem "DESTAQUE N" porque o template
  // do Beehiiv usa só o emoji+CATEGORIA. Heurística mais pragmática:
  // procurar trechos curtos (5-90 chars) em uppercase próximo a links.
  // Trade-off: pode pegar falso-positivo. Aceitável pra esse lint informativo.
  const sections: { name: string; item_count: number }[] = [];
  // #1660: PRESENÇA detectada no texto STRIPADO com âncora de emoji. Após strip
  // de tags + colapso de whitespace, `📺 VÍDEOS` fica contíguo (independente de
  // como o template separa emoji e nome em tags), e a âncora de emoji impede
  // fantasma de keyword bare em prosa. Tolera acento (í/i) e singular (#1324).
  // #1936: o novo design (DS) troca o emoji do kicker pelo ponto ● (entidade
  // `&#9679;`, que sobrevive ao strip de tags). Aceitar AMBOS: o emoji (emails
  // legados) OU o bullet `&#9679;`. Mantém a âncora (não casa keyword solta em
  // prosa), só amplia o prefixo permitido.
  // #10181: o e-mail que o Gmail devolve do Kit traz o ponto já DECODIFICADO
  // (`●` literal, U+25CF, fora do range de SECTION_EMOJI) em vez da entidade —
  // e todas as seções caíam em `section_missing` (falso positivo, 261014). A
  // âncora aceita as três grafias do mesmo ponto: `&#9679;`, `&#x25CF;` e `●`.
  const SECTION_ANCHOR = String.raw`(?:${SECTION_EMOJI}|(?:&#9679;|&#x25cf;|\u{25CF})\s*)`;
  const headerInText = (body: string): boolean =>
    new RegExp(`${SECTION_ANCHOR}${body}`, "iu").test(text);
  // #11403: no HTML do Kit o ponto fica dentro de um `<span>` colorido
  // (`<span style="color:#00A0A0;">●</span> RADAR`), então no RAW há tags entre
  // a âncora e o nome — a busca crua falhava e todo `item_count` saía 0. O
  // separador cru aceita tags e espaço entre a âncora e o nome.
  const RAW_GAP = String.raw`(?:\s|&nbsp;|&#160;|<[^>]*>)*`;
  // Posições de TODOS os headers de uma seção no RAW content.
  const rawAll = (body: string): { idx: number; len: number }[] => {
    const re = new RegExp(`${SECTION_ANCHOR}${RAW_GAP}${body}`, "giu");
    const out: { idx: number; len: number }[] = [];
    let m: RegExpExecArray | null;
    while ((m = re.exec(content)) !== null) out.push({ idx: m.index, len: m[0].length });
    return out;
  };
  // #11403: o kicker de categoria do destaque usa a MESMA marcação do header de
  // seção (`● LANÇAMENTO`), e `LAN[ÇC]AMENTOS?` casava com ele — seção
  // LANÇAMENTOS fantasma em toda edição com destaque de lançamento (mascarava
  // `section_missing`). Um kicker é aquele cujo PRÓXIMO link é o título do
  // destaque (`<a class="headline">`); num header de seção o próximo link é o
  // 1º item. Só vale no render atual (que tem `class="headline"`): em HTML
  // sem essa marcação (local mínimo, legado, Beehiiv) nenhum header é
  // descartado — o comportamento anterior fica intacto.
  const hasHeadlineMarkup = /<a\b[^>]*class=["'][^"']*\bheadline\b/i.test(content);
  const isDestaqueKicker = (end: number): boolean => {
    if (!hasHeadlineMarkup) return false;
    const nextA = content.slice(end).match(/<a\b[^>]*>/i);
    return !!nextA && /class=["'][^"']*\bheadline\b/i.test(nextA[0]);
  };
  const headers = new Map<string, { idx: number; len: number }>();
  // Seções cujas ocorrências no RAW eram TODAS kickers de destaque (fantasma).
  const onlyKickers = new Set<string>();
  const allHeaderStarts: number[] = [];
  for (const sec of KNOWN_SECTIONS) {
    const all = rawAll(sec.body);
    const hits = all.filter((h) => !isDestaqueKicker(h.idx + h.len));
    for (const h of hits) allHeaderStarts.push(h.idx);
    if (hits.length > 0) headers.set(sec.name, hits[0]);
    else if (all.length > 0) onlyKickers.add(sec.name);
  }
  for (const sec of KNOWN_SECTIONS) {
    const hit = headers.get(sec.name);
    // Presença: header real no RAW; senão, o texto stripado (texto puro,
    // markup que o RAW não alcança) — exceto quando o RAW mostrou que o único
    // casamento é o kicker de um destaque.
    const present = hit !== undefined || (!onlyKickers.has(sec.name) && headerInText(sec.body));
    if (!present) continue;
    let slice = "";
    if (hit) {
      const sliceStart = hit.idx + hit.len;
      // Termina no próximo header de seção OU no próximo bloco de destaque/
      // kicker — o que vier antes.
      let sliceEnd = content.length;
      for (const s of allHeaderStarts) if (s > sliceStart && s < sliceEnd) sliceEnd = s;
      const nextKicker = content.slice(sliceStart).search(new RegExp(SECTION_ANCHOR, "iu"));
      if (nextKicker >= 0 && sliceStart + nextKicker < sliceEnd) sliceEnd = sliceStart + nextKicker;
      slice = content.slice(sliceStart, sliceEnd);
    }
    // Item de seção no render atual = título em `<h3>` (1 por item); sem `<h3>`
    // (e-mail legado/texto), cai na contagem de links como aproximação.
    const h3Count = (slice.match(/<h3\b/gi) ?? []).length;
    const linkCount = (slice.match(/<a\s+[^>]*href/gi) ?? []).length;
    sections.push({ name: sec.name, item_count: h3Count > 0 ? h3Count : linkCount });
  }

  // #11403: destaques no HTML do render atual (Kit e local) — o título é o
  // `<h2>` dentro de `<a class="headline">`. Antes nada era extraído e
  // `destaques` saía sempre vazio no e-mail (o `destaque_count_mismatch`
  // nunca podia disparar).
  const headlineRe = /<a\b[^>]*class=["'][^"']*\bheadline\b[^"']*["'][^>]*>\s*<h2\b[^>]*>([\s\S]*?)<\/h2>/gi;
  let hm: RegExpExecArray | null;
  while ((hm = headlineRe.exec(content)) !== null) {
    const title = decodeBasicEntities(hm[1].replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();
    if (title) destaques.push(title);
  }

  return { has_eia, destaques, sections };
}

function decodeBasicEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, "&");
}

export function compareStructure(
  source: StructureSnapshot,
  email: StructureSnapshot,
): StructureIssue[] {
  const issues: StructureIssue[] = [];

  // É IA?
  if (source.has_eia && !email.has_eia) {
    issues.push({
      type: "eia_section_missing",
      details: "Source MD tem 'É IA?' mas email não — template provavelmente errado ou bloco não foi colado.",
    });
  }

  // Sections presence
  for (const srcSec of source.sections) {
    const emailSec = email.sections.find((s) => s.name === srcSec.name);
    if (!emailSec) {
      issues.push({
        type: "section_missing",
        section: srcSec.name,
        source_count: srcSec.item_count,
        email_count: 0,
        details: `Seção '${srcSec.name}' presente no source com ${srcSec.item_count} itens mas ausente no email.`,
      });
    }
  }

  // Destaque count
  // Email não tem como capturar destaques limpo (heurística falha) — só
  // comparamos count quando o source tem dado claro.
  if (source.destaques.length > 0 && email.destaques.length > 0) {
    if (source.destaques.length !== email.destaques.length) {
      issues.push({
        type: "destaque_count_mismatch",
        source_count: source.destaques.length,
        email_count: email.destaques.length,
        details: `Source tem ${source.destaques.length} destaques, email aparenta ter ${email.destaques.length}.`,
      });
    }
  }

  return issues;
}

async function mainCli(): Promise<number> {
  const { flags, values } = parseArgs(process.argv.slice(2));
  if (flags.has("help") || !values["email-file"] || !values["source-md"]) {
    console.error("Uso: lint-test-email-structure.ts --email-file <file> --source-md <file> [--out <json>]");
    return 2;
  }
  const emailFile = values["email-file"];
  const sourceMd = values["source-md"];
  if (!existsSync(emailFile) || !existsSync(sourceMd)) {
    console.error(`Arquivo(s) faltando.`);
    return 2;
  }
  const emailContent = readFileSync(emailFile, "utf8");
  const sourceContent = readFileSync(sourceMd, "utf8");
  const source = extractMdStructure(sourceContent);
  const email = extractEmailStructure(emailContent);
  const issues = compareStructure(source, email);
  const result: StructureResult = { source, email, issues };
  if (values.out) writeFileSync(values.out, JSON.stringify(result, null, 2), "utf8");
  console.log(JSON.stringify(result, null, 2));
  if (issues.length > 0) {
    console.error(`[lint-test-email-structure] ${issues.length} issue(s):`);
    for (const i of issues) console.error(`  - [${i.type}] ${i.details}`);
    return 1;
  }
  return 0;
}

if (isMainModule(import.meta.url)) {
  mainCli().then((code) => process.exit(code));
}
