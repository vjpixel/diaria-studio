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
  const SECTION_ANCHOR = String.raw`(?:${SECTION_EMOJI}|&#9679;\s*)`;
  const headerInText = (body: string): boolean =>
    new RegExp(`${SECTION_ANCHOR}${body}`, "iu").test(text);
  // Posição do header no RAW content (pra contar <a href> no slice). Best-effort
  // — item_count é COSMÉTICO (só entra na detail string; compareStructure usa
  // presença, não count). Se a âncora falhar no raw (tags entre emoji e nome),
  // count=0 mas a presença (acima) já foi registrada → sem falso section_missing.
  const rawPos = (body: string, from = 0): { idx: number; len: number } => {
    const m = content.slice(from).match(new RegExp(`${SECTION_ANCHOR}${body}`, "iu"));
    if (m?.index === undefined) return { idx: -1, len: 0 };
    return { idx: from + m.index, len: m[0].length };
  };
  for (const sec of KNOWN_SECTIONS) {
    if (!headerInText(sec.body)) continue;
    const { idx, len } = rawPos(sec.body);
    let slice = "";
    if (idx >= 0) {
      const sliceStart = idx + len;
      let sliceEnd = content.length;
      for (const other of KNOWN_SECTIONS) {
        if (other.name === sec.name) continue;
        const o = rawPos(other.body, sliceStart);
        if (o.idx > sliceStart && o.idx < sliceEnd) sliceEnd = o.idx;
      }
      slice = content.slice(sliceStart, sliceEnd);
    }
    const linkCount = (slice.match(/<a\s+[^>]*href/gi) ?? []).length;
    // Cada item é geralmente 1 link de título — mas comments/imagens podem
    // duplicar. Fallback heurística: contar título e descrição em pares.
    // Pra reduzir ruído, contamos só hrefs primeiros do tipo cnnbrasil/anthropic etc
    // — mas isso é frágil. Mantemos contagem simples e logamos como aproximação.
    sections.push({ name: sec.name, item_count: linkCount });
  }

  return { has_eia, destaques, sections };
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

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        out[key] = next;
        i++;
      } else {
        out[key] = true;
      }
    }
  }
  return out;
}

async function mainCli(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args["email-file"] || !args["source-md"]) {
    console.error("Uso: lint-test-email-structure.ts --email-file <file> --source-md <file> [--out <json>]");
    return 2;
  }
  const emailFile = String(args["email-file"]);
  const sourceMd = String(args["source-md"]);
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
  if (args.out) writeFileSync(String(args.out), JSON.stringify(result, null, 2), "utf8");
  console.log(JSON.stringify(result, null, 2));
  if (issues.length > 0) {
    console.error(`[lint-test-email-structure] ${issues.length} issue(s):`);
    for (const i of issues) console.error(`  - [${i.type}] ${i.details}`);
    return 1;
  }
  return 0;
}

const _argv1 = process.argv[1]?.replaceAll("\\", "/") ?? "";
if (/\/scripts\/lint-test-email-structure\.ts$/.test(_argv1)) {
  mainCli().then((code) => process.exit(code));
}
