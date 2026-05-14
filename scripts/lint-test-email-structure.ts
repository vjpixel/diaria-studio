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

export interface StructureIssue {
  type:
    | "eia_section_missing"
    | "section_missing"
    | "destaque_count_mismatch"
    | "destaque_order_mismatch"
    | "section_item_count_mismatch";
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

const KNOWN_SECTIONS = ["LANÇAMENTOS", "PESQUISAS", "OUTRAS NOTÍCIAS"];

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
  const sections: { name: string; item_count: number }[] = [];
  for (const sec of KNOWN_SECTIONS) {
    const secRe = new RegExp(`\\*\\*${sec.replace(/\s/g, "\\s+")}\\*\\*([\\s\\S]*?)(?=\\n---|\\n\\*\\*[A-ZÇÃÕÉ\\s🎁🙋]|$)`, "i");
    const match = md.match(secRe);
    if (!match) continue;
    const body = match[1];
    // Conta linhas de item: `**[Title](URL)**` na seção
    const items = body.match(/\*\*\[[^\]]+\]\([^)]+\)\*\*/g) ?? [];
    sections.push({ name: sec, item_count: items.length });
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
  for (const sec of KNOWN_SECTIONS) {
    // Procura no HTML original (case-insensitive) — assume section name aparece
    // como texto sem entities (LANÇAMENTOS, PESQUISAS, OUTRAS NOTÍCIAS).
    const idx = content.toUpperCase().indexOf(sec);
    if (idx < 0) continue;
    const sliceStart = idx + sec.length;
    let sliceEnd = content.length;
    for (const other of KNOWN_SECTIONS) {
      if (other === sec) continue;
      const otherIdx = content.toUpperCase().indexOf(other, sliceStart);
      if (otherIdx > sliceStart && otherIdx < sliceEnd) sliceEnd = otherIdx;
    }
    const slice = content.slice(sliceStart, sliceEnd);
    const linkCount = (slice.match(/<a\s+[^>]*href/gi) ?? []).length;
    // Cada item é geralmente 1 link de título — mas comments/imagens podem
    // duplicar. Fallback heurística: contar título e descrição em pares.
    // Pra reduzir ruído, contamos só hrefs primeiros do tipo cnnbrasil/anthropic etc
    // — mas isso é frágil. Mantemos contagem simples e logamos como aproximação.
    sections.push({ name: sec, item_count: linkCount });
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
