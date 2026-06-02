/**
 * lint-social-numbers.ts (#1711)
 *
 * Guard heurístico anti-alucinação de CIFRAS FINANCEIRAS nos posts de social.
 * O `social-linkedin`/`social-facebook` (LLM) pode inventar um número específico
 * ausente da fonte — caso 260602: post d1 escreveu "US$ 965 bilhões em valuation"
 * (valor implausível, não estava no The Guardian nem no approved.json). Humanizer
 * e Clarice NÃO fazem fact-check; sem catch manual no gate, sai número falso no
 * LinkedIn/Facebook da marca.
 *
 * Estratégia conservadora (baixo ruído): extrai só cifras de DINHEIRO COM
 * MAGNITUDE (US$/R$/$/€ + número + bi/mi/tri/bilhões/...) — o tipo que foi
 * alucinado — e flaga as que NÃO aparecem em lugar nenhum do approved.json
 * (títulos + summaries de TODOS os destaques). NÃO flaga porcentagens nem
 * números pequenos (comuns e legítimos). WARN-only (exit 0) — sinal pro gate,
 * nunca bloqueia. Decisão final é do editor.
 *
 * Uso:
 *   npx tsx scripts/lint-social-numbers.ts \
 *     --social data/editions/260602/03-social.md \
 *     --approved data/editions/260602/_internal/01-approved.json
 *
 * Output (stdout JSON): { ok, unsourced: [{figure, context}], checked }
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// ---------------------------------------------------------------------------
// Pure helpers — exportados pra teste
// ---------------------------------------------------------------------------

/**
 * Normaliza a unidade de magnitude pra um símbolo canônico:
 *   bilhões/billion/bi/bn/B → "B"; milhões/million/mi/M → "M";
 *   trilhões/trillion/tri/T → "T"; mil/thousand/K → "K".
 * Retorna "" pra unidade desconhecida.
 */
export function normalizeMagnitude(unit: string): string {
  // Strip de diacríticos pra "bilhões" → "bilhoes" (senão `\w*` para no "õ").
  const u = unit
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\./g, "");
  if (/^(b|bi|bn|bilh\w*|billion)$/.test(u)) return "B";
  if (/^(m|mi|milh\w*|million)$/.test(u)) return "M";
  if (/^(t|tri|trilh\w*|trillion)$/.test(u)) return "T";
  if (/^(k|mil|thousand)$/.test(u)) return "K";
  return "";
}

/**
 * Normaliza os dígitos de um número PT/EN pra comparação: tira separadores de
 * milhar e unifica decimal. "965", "1.000", "2,5", "1,234.5" → string só com
 * dígitos e um ponto decimal. Heurística: o ÚLTIMO separador vira decimal se
 * seguido de 1-2 dígitos; os demais são milhares e somem.
 */
export function normalizeDigits(raw: string): string {
  const cleaned = raw.replace(/[^\d.,]/g, "");
  if (!cleaned) return "";
  // Acha o último separador
  const lastSep = Math.max(cleaned.lastIndexOf("."), cleaned.lastIndexOf(","));
  if (lastSep < 0) return cleaned;
  const afterSep = cleaned.slice(lastSep + 1);
  const intPart = cleaned.slice(0, lastSep).replace(/[.,]/g, "");
  // Decimal só se 1-2 dígitos após o separador (senão é separador de milhar)
  if (afterSep.length >= 1 && afterSep.length <= 2) {
    const dec = afterSep.replace(/0+$/, ""); // tira zeros à direita
    return dec ? `${intPart}.${dec}` : intPart;
  }
  return intPart + afterSep;
}

export interface MoneyFigure {
  /** Chave normalizada pra comparação: `{digits}{B|M|T|K}` (ex: "965B"). */
  key: string;
  /** Trecho original casado (pra exibir no warn). */
  raw: string;
}

// Cifra de dinheiro com magnitude: símbolo de moeda + número + (opcional)
// magnitude por extenso/abreviada. Cobre "US$ 965 bilhões", "R$2,5 bi", "$10B",
// "€3 milhões". A magnitude pode estar colada ou separada por espaço.
// Magnitude: palavras (bilhões/billion/...) OU abreviação single-letter glued
// ou separada (10B, 2.5 M) — `[BMTK]` exige não-letra à frente pra não casar
// "monthly"/"million-prefix" indevidamente.
const MAGNITUDE = "bilh\\w*|milh\\w*|trilh\\w*|billion|million|trillion|bi|mi|tri|bn|mil|[BMTK](?![a-z])";
const MONEY_RE = new RegExp(
  `(?:US\\$|R\\$|\\$|€|USD|BRL|EUR)\\s?(\\d[\\d.,]*)\\s*(${MAGNITUDE})?`,
  "gi",
);

/**
 * Extrai cifras de dinheiro com magnitude de um texto, normalizadas.
 * Só retorna cifras COM magnitude (bi/mi/tri/mil/...) — uma cifra sem magnitude
 * ("US$ 50") é específica demais pra alucinar e comum demais pra flagar.
 */
export function extractMoneyFigures(text: string): MoneyFigure[] {
  const out: MoneyFigure[] = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(MONEY_RE)) {
    const digits = normalizeDigits(m[1]);
    const mag = m[2] ? normalizeMagnitude(m[2]) : "";
    if (!digits || !mag) continue; // exige magnitude
    const key = `${digits}${mag}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ key, raw: m[0].trim() });
  }
  return out;
}

/**
 * Conjunto de chaves normalizadas de cifras presentes num texto-fonte. Inclui
 * cifras COM e SEM símbolo de moeda (a fonte pode dizer "965 bilhões" sem o $).
 */
export function sourceFigureKeys(text: string): Set<string> {
  const keys = new Set<string>();
  // Com símbolo de moeda (reusa MONEY_RE).
  for (const f of extractMoneyFigures(text)) keys.add(f.key);
  // Número + magnitude SEM símbolo de moeda (ex: "965 bilhões de dólares").
  // Reusa MAGNITUDE; greedy no source é OK (só relaxa o lint, nunca falso-positiva).
  const bareRe = new RegExp(`(\\d[\\d.,]*)\\s*(${MAGNITUDE})`, "gi");
  for (const m of text.matchAll(bareRe)) {
    const digits = normalizeDigits(m[1]);
    const mag = normalizeMagnitude(m[2]);
    if (digits && mag) keys.add(`${digits}${mag}`);
  }
  return keys;
}

/**
 * Cifras de dinheiro presentes no post de social mas AUSENTES da fonte.
 * `sourceText` = concatenação de títulos + summaries de todos os destaques do
 * approved.json (+ qualquer contexto disponível).
 */
export function findUnsourcedFigures(
  socialText: string,
  sourceText: string,
): MoneyFigure[] {
  const sourceKeys = sourceFigureKeys(sourceText);
  return extractMoneyFigures(socialText).filter((f) => !sourceKeys.has(f.key));
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

interface ApprovedShape {
  highlights?: Array<{ article?: { title?: string; summary?: string } }>;
  lancamento?: Array<{ title?: string; summary?: string }>;
  radar?: Array<{ title?: string; summary?: string }>;
  use_melhor?: Array<{ title?: string; summary?: string }>;
  video?: Array<{ title?: string; summary?: string }>;
}

/** Concatena todo o texto-fonte (títulos + summaries) do approved.json. */
export function approvedSourceText(approved: ApprovedShape): string {
  const parts: string[] = [];
  for (const h of approved.highlights ?? []) {
    if (h.article?.title) parts.push(h.article.title);
    if (h.article?.summary) parts.push(h.article.summary);
  }
  for (const bucket of [approved.lancamento, approved.radar, approved.use_melhor, approved.video]) {
    for (const a of bucket ?? []) {
      if (a.title) parts.push(a.title);
      if (a.summary) parts.push(a.summary);
    }
  }
  return parts.join("\n");
}

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--") && i + 1 < argv.length) {
      out[argv[i].slice(2)] = argv[i + 1];
      i++;
    }
  }
  return out;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  if (!args.social || !args.approved) {
    console.error(
      "Uso: lint-social-numbers.ts --social <03-social.md> --approved <01-approved.json>",
    );
    process.exit(1);
  }
  const socialText = readFileSync(resolve(process.cwd(), args.social), "utf8");
  const approved = JSON.parse(readFileSync(resolve(process.cwd(), args.approved), "utf8")) as ApprovedShape;
  const sourceText = approvedSourceText(approved);

  const unsourced = findUnsourcedFigures(socialText, sourceText);

  if (unsourced.length > 0) {
    console.error(
      `\n⚠️  lint-social-numbers: ${unsourced.length} cifra(s) financeira(s) no social NÃO encontrada(s) na fonte (approved.json) — possível alucinação, confira no gate:`,
    );
    for (const f of unsourced) {
      console.error(`  - "${f.raw}" (normalizado: ${f.key})`);
    }
  }

  // WARN-only: nunca bloqueia (exit 0). O editor decide no gate.
  console.log(
    JSON.stringify(
      { ok: unsourced.length === 0, unsourced, checked: extractMoneyFigures(socialText).length },
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
  main();
}
