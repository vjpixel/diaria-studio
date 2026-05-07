/**
 * lint-social-md.ts (#602, #877)
 *
 * Valida regras invariáveis do `03-social.md`. Dois modos:
 *
 * 1. Default (sem `--check`): valida CTAs (#602)
 *    - LinkedIn CTA termina com `diar.ia.br` (sem `https://`, sem `.` final)
 *    - Facebook CTA termina com `https://diar.ia.br.` (com prefixo + ponto)
 *
 *    Regras opostas entre plataformas — agent confunde sem validação
 *    determinística.
 *
 * 2. `--check relative-time` (#877): valida timestamps relativos (defense-in-depth)
 *    - Detecta "hoje", "ontem", "há N dias", "esta semana", etc.
 *    - Posts vão pra fila com D+1+ delay; relativos envelhecem mal.
 *
 * IMPORTANTE: o flag `--check relative-time` é OBRIGATÓRIO pra validação de
 * timestamps. SEM o flag, o lint só checa CTAs e ignora qualquer "hoje" /
 * "ontem" no MD. Se o orchestrator esquecer o flag, posts com timestamps
 * relativos passam pelo gate sem warning.
 *
 * Uso:
 *   # Default — checa CTAs
 *   npx tsx scripts/lint-social-md.ts --md data/editions/260505/03-social.md
 *
 *   # Modo relative-time — checa timestamps narrativos
 *   npx tsx scripts/lint-social-md.ts --check relative-time --md <path>
 *
 * Exit code:
 *   0 = ok
 *   1 = lint errors (bloqueia gate)
 *   2 = uso inválido
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

// ---------------------------------------------------------------------------
// Pure helpers — exportadas pra tests
// ---------------------------------------------------------------------------

export interface LintError {
  platform: "linkedin" | "facebook";
  rule: string;
  detail: string;
  line?: number;
}

/** Extrai a seção de uma plataforma do md (`# LinkedIn` ou `# Facebook`). */
export function extractPlatformSection(md: string, platform: "linkedin" | "facebook"): string | null {
  const normalized = md.replace(/\r\n/g, "\n");
  const platTitle = platform.charAt(0).toUpperCase() + platform.slice(1);
  const re = new RegExp(`(?:^|\\n)# ${platTitle}\\n([\\s\\S]*?)(?=\\n# |$)`, "i");
  const match = normalized.match(re);
  return match ? match[1] : null;
}

/**
 * Valida CTAs do LinkedIn — devem usar `diar.ia.br` puro.
 *
 * Aceitos:
 *   - "...em diar.ia.br" (sem prefixo, sem ponto)
 * Rejeitados:
 *   - "...em https://diar.ia.br" (prefixo)
 *   - "...em [diar.ia.br](https://diar.ia.br)" (markdown link — agent comum confunde)
 *   - "...em diar.ia.br." (ponto final)
 */
export function lintLinkedinCTAs(linkedinSection: string): LintError[] {
  const errors: LintError[] = [];
  const lines = linkedinSection.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!/diar\.ia\.br/i.test(line)) continue;
    if (!/(assine grátis|assine grátis em|assine|grátis em|notícias de IA)/i.test(line)) continue;

    // Aceita: "em diar.ia.br" no fim (com possível trailing whitespace)
    const ok = /\bem\s+diar\.ia\.br\s*$/i.test(line.trim());
    if (ok) continue;

    if (/https:\/\/diar\.ia\.br/.test(line)) {
      errors.push({
        platform: "linkedin",
        rule: "no_https_prefix",
        detail: `Linha ${i + 1} usa "https://diar.ia.br" — LinkedIn CTA deve ser apenas "diar.ia.br"`,
        line: i + 1,
      });
    } else if (/diar\.ia\.br\./.test(line)) {
      errors.push({
        platform: "linkedin",
        rule: "no_trailing_period",
        detail: `Linha ${i + 1} tem ponto final após "diar.ia.br" — LinkedIn CTA não usa ponto`,
        line: i + 1,
      });
    } else if (/\[diar\.ia\.br\]/.test(line)) {
      errors.push({
        platform: "linkedin",
        rule: "no_markdown_link",
        detail: `Linha ${i + 1} usa markdown link — LinkedIn não renderiza markdown, escrever URL crua`,
        line: i + 1,
      });
    }
  }
  return errors;
}

/**
 * Valida CTAs do Facebook — devem usar `https://diar.ia.br.` (com prefixo + ponto).
 * Regra oposta do LinkedIn (#602).
 */
export function lintFacebookCTAs(facebookSection: string): LintError[] {
  const errors: LintError[] = [];
  const lines = facebookSection.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!/diar\.ia\.br/i.test(line)) continue;
    if (!/(assine grátis|assine|grátis em|notícias de IA)/i.test(line)) continue;

    // Aceita Facebook: "https://diar.ia.br." OU [https://diar.ia.br](https://diar.ia.br).
    // (Drive markdown link conversion adiciona o wrapper às vezes — ainda renderiza ok)
    const okPlain = /\bhttps:\/\/diar\.ia\.br\.\s*$/i.test(line.trim());
    const okMd = /\[https:\/\/diar\.ia\.br\]\(https:\/\/diar\.ia\.br\)\.\s*$/i.test(line.trim());
    if (okPlain || okMd) continue;

    // Falta https://
    if (!/https:\/\/diar\.ia\.br/.test(line)) {
      errors.push({
        platform: "facebook",
        rule: "missing_https_prefix",
        detail: `Linha ${i + 1} usa "diar.ia.br" sem prefixo — Facebook CTA exige "https://diar.ia.br."`,
        line: i + 1,
      });
    }
  }
  return errors;
}

export interface LintResult {
  ok: boolean;
  errors: LintError[];
}

export function lintSocialMd(md: string): LintResult {
  const errors: LintError[] = [];
  const linkedin = extractPlatformSection(md, "linkedin");
  if (linkedin !== null) {
    errors.push(...lintLinkedinCTAs(linkedin));
  }
  const facebook = extractPlatformSection(md, "facebook");
  if (facebook !== null) {
    errors.push(...lintFacebookCTAs(facebook));
  }
  return { ok: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
// Temporal reference check (#747, #877) — social-specific
// ---------------------------------------------------------------------------

/**
 * Detecta referências temporais relativas banidas no MD de social
 * (#747, #877). Edições publicam D+1+ — palavras como "hoje", "ontem",
 * "esta semana" envelhecem mal entre escrever e publicar.
 *
 * #877 — quote-skip: matches dentro de aspas (`"..."`, `'...'`, `«...»`,
 * `“...”`) são ignorados (citação direta de fonte é OK ter relativo).
 */
export interface RelativeTimeMatch {
  word: string;
  context: string;
  line: number;
}

export interface RelativeTimeResult {
  ok: boolean;
  matches: RelativeTimeMatch[];
}

// Nota: \b não funciona com caracteres Unicode (ã, ê, etc.) — usamos
// lookahead/lookbehind em vez de \b para cobrir amanhã, mês, etc.
//
// Patterns cobertos (#877):
//   - hoje, ontem, amanhã (palavra solo; "ontem-feira" / "anteontem" não
//     casam graças aos lookahead/lookbehind contra \w e ao requirement de
//     start-of-word — `(?<![\w-])`)
//   - esta semana, próxima semana, na próxima semana, na semana passada
//   - este mês, mês passado
//   - recentemente, agora mesmo, há pouco, acabou de
//   - há N dia(s) / semana(s) / mês(es)
//   - nesta {weekday}
const RELATIVE_TIME_RE =
  /(?<![\w-])(hoje|ontem|amanhã|agora mesmo|esta semana|próxima semana|na semana passada|na próxima semana|este mês|mês passado|recentemente|há pouco|acabou de|há \d+ (?:dias?|semanas?|m[eê]s(?:es)?)|nesta (?:segunda|terça|quarta|quinta|sexta|sábado|domingo))(?![\w-])/gi;

/**
 * Identifica os ranges (start, end) de pares de aspas em uma linha.
 * Cobre `"..."`, `'...'`, `«...»`, `“...”`. Usado para skip de matches
 * dentro de citações.
 */
function quotedRanges(line: string): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  // Pares simétricos
  const pairs: Array<[string, string]> = [
    ['"', '"'],
    ["'", "'"],
    ["«", "»"],
    ["“", "”"],
  ];
  for (const [open, close] of pairs) {
    let idx = 0;
    while (idx < line.length) {
      const start = line.indexOf(open, idx);
      if (start === -1) break;
      const closeIdx = line.indexOf(close, start + 1);
      if (closeIdx === -1) break;
      // Apóstrofo (`'`): só conta como aspas se houver pelo menos um espaço
      // ou início-de-string antes do par — evita falso quote em "d'água" /
      // "L'Oréal".
      if (open === "'" && start > 0 && /\w/.test(line[start - 1])) {
        idx = start + 1;
        continue;
      }
      ranges.push({ start, end: closeIdx });
      idx = closeIdx + 1;
    }
  }
  return ranges;
}

function isInQuotedRange(
  index: number,
  ranges: Array<{ start: number; end: number }>,
): boolean {
  return ranges.some((r) => index >= r.start && index <= r.end);
}

export function lintRelativeTime(md: string): RelativeTimeResult {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const matches: RelativeTimeMatch[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const ranges = quotedRanges(line);
    RELATIVE_TIME_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = RELATIVE_TIME_RE.exec(line)) !== null) {
      // #877 — pular matches dentro de aspas (citação direta)
      if (isInQuotedRange(m.index, ranges)) continue;
      matches.push({
        word: m[1],
        context: line
          .slice(Math.max(0, m.index - 20), m.index + m[1].length + 20)
          .trim(),
        line: i + 1,
      });
    }
  }

  return { ok: matches.length === 0, matches };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): Record<string, string> {
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--") && i + 1 < argv.length && !argv[i + 1].startsWith("--")) {
      args[argv[i].slice(2)] = argv[i + 1];
      i++;
    }
  }
  return args;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  if (!args.md) {
    console.error(
      "Uso: lint-social-md.ts --md <path>\n" +
        "  ou: lint-social-md.ts --check relative-time --md <path>",
    );
    process.exit(2);
  }
  const ROOT = process.cwd();
  const mdPath = resolve(ROOT, args.md);
  if (!existsSync(mdPath)) {
    console.error(`Arquivo não existe: ${mdPath}`);
    process.exit(2);
  }
  const md = readFileSync(mdPath, "utf8");

  // Modo --check relative-time (#877) — detecta timestamps relativos em posts social
  if (args.check === "relative-time") {
    const result = lintRelativeTime(md);
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) {
      console.error(
        `\n❌ ${result.matches.length} referência(s) temporal(is) relativa(s) detectada(s) em posts social:`,
      );
      for (const m of result.matches) {
        console.error(
          `  linha ${m.line}: relative_time: '${m.word}' encontrado — posts publicam D+1+, use data absoluta\n    contexto: "...${m.context}..."`,
        );
      }
      process.exit(1);
    }
    return;
  }

  // Modo default: validação de CTAs (#602)
  const result = lintSocialMd(md);
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) {
    console.error(`\n❌ ${result.errors.length} erro(s) em CTAs social:`);
    for (const e of result.errors) console.error(`  [${e.platform}] ${e.rule}: ${e.detail}`);
    process.exit(1);
  }
}

const _argv1 = process.argv[1]?.replaceAll("\\", "/") ?? "";
if (
  import.meta.url === `file://${_argv1}` ||
  import.meta.url === `file:///${_argv1.replace(/^\//, "")}`
) {
  main();
}
