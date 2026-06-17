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
 *     --approved data/editions/260602/_internal/01-approved-capped.json
 *
 * Output (stdout JSON): { ok: boolean, num_findings: DestaqueFinding[], count_findings: CommentCountFinding[] }
 */

import { readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { outrosCount as _outrosCount } from "./lib/outros-count.ts";

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
// Magnitude: palavras por extenso (bilhões/billion/...) PRIMEIRO, depois
// abreviações. Ordem importa (#1722 review):
//  - `milh\w*`/`bilh\w*`/`trilh\w*` antes das abreviações pra "milhões" não casar
//    "mil"/"mi".
//  - `mil` (mil = K) antes de `mi` (mi = M) — senão "35 mil" virava "35 mi"(lhões),
//    erro de 1000×.
//  - todas as abreviações + `[BMTK]` exigem não-letra à frente `(?![a-z])` pra
//    não casar "trimestre" (tri), "monthly" (m), "Bilhões"-prefix, etc.
const MAGNITUDE =
  "bilh\\w*|milh\\w*|trilh\\w*|billion|million|trillion|(?:mil|bn|bi|tri|mi)(?![a-z])|[BMTK](?![a-z])";
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
  lancamento?: unknown[];
  radar?: unknown[];
  use_melhor?: unknown[];
  video?: unknown[];
}

/**
 * Texto-fonte do destaque N (1-based) = title + summary do highlights[N-1].
 * É a fonte que o social-linkedin/facebook recebe pra escrever o post de dN
 * (social-linkedin.md). Comparar o post de dN contra a fonte de dN (não contra
 * o pool inteiro) é o que pega o caso 260602: "965B" estava num item use_melhor,
 * mas NÃO na fonte do destaque d1 (Anthropic IPO) — então o post de d1 que cita
 * "965B" É unsourced relativo ao d1. Vazio quando N fora de range.
 */
export function highlightSourceText(approved: ApprovedShape, destaque: number): string {
  const h = approved.highlights?.[destaque - 1];
  if (!h?.article) return "";
  return `${h.article.title ?? ""}\n${h.article.summary ?? ""}`;
}

/**
 * Separa o 03-social.md por destaque. Os posts (LinkedIn main + comments +
 * Facebook) ficam sob headers `## d1`/`## d2`/`## d3` (dentro de `# LinkedIn`
 * e `# Facebook`). Concatena TODO o texto de cada dN (os dois canais), parando
 * em `## d{outro}` ou `# {canal}`. Exportada pra teste.
 */
export function parseSocialByDestaque(socialMd: string): Map<number, string> {
  const map = new Map<number, string>();
  let current: number | null = null;
  for (const line of socialMd.split("\n")) {
    const dHeader = line.match(/^##\s+d(\d)\b/i);
    if (dHeader) {
      current = parseInt(dHeader[1], 10);
      continue;
    }
    if (/^#\s+/.test(line)) {
      current = null; // # LinkedIn / # Facebook — fora de qualquer destaque
      continue;
    }
    if (current !== null) {
      map.set(current, (map.get(current) ?? "") + line + "\n");
    }
  }
  return map;
}

export interface DestaqueFinding {
  destaque: number;
  unsourced: MoneyFigure[];
}

/**
 * Roda o lint per-destaque: pra cada dN no social, flaga cifras de dinheiro
 * ausentes da fonte do destaque N. Pure — exportada pra teste.
 */
export function lintSocialNumbers(socialMd: string, approved: ApprovedShape): DestaqueFinding[] {
  const byDestaque = parseSocialByDestaque(socialMd);
  const findings: DestaqueFinding[] = [];
  for (const [n, postText] of [...byDestaque.entries()].sort((a, b) => a[0] - b[0])) {
    const source = highlightSourceText(approved, n);
    const unsourced = findUnsourcedFigures(postText, source);
    if (unsourced.length > 0) findings.push({ destaque: n, unsourced });
  }
  return findings;
}

// ---------------------------------------------------------------------------
// comment_diaria count lint (#2014)
// ---------------------------------------------------------------------------

/**
 * Calcula o total de itens não-destaque da edição:
 *   lancamento + radar + use_melhor + video
 * Esse é o número correto pra "mais N destaques" no comment_diaria.
 * NUNCA deve ser estimado pelo LLM — derivado deterministicamente do approved.json.
 *
 * #2331/F4: Delegado a scripts/lib/outros-count.ts (shared com publish-linkedin.ts).
 * Formula permanece aqui apenas como re-export com assinatura original.
 */
export function computeOutrosCount(approved: ApprovedShape): number {
  return _outrosCount(approved);
}

/** Regex que casa "mais N destaques" no comment_diaria (N = inteiro >= 0). */
const COMMENT_COUNT_RE = /mais\s+(\d+)\s+destaques/gi;

export interface CommentCountFinding {
  /** Destaque (1, 2, 3) onde o count_diaria foi encontrado e está errado. */
  destaque: number;
  /** Número encontrado no texto do comment_diaria (NaN quando placeholder não-resolvido). */
  found: number;
  /** Número esperado (calculado de approved.json). */
  expected: number;
  /** true quando o placeholder literal `{outros_count}` não foi resolvido pelo LLM. */
  unresolved_placeholder?: true;
}

/**
 * Extrai os textos de `### comment_diaria` de cada destaque no 03-social.md
 * (LinkedIn only — Facebook não tem comment_diaria). Exportada pra teste.
 */
export function parseCommentDiariaByDestaque(socialMd: string): Map<number, string> {
  const map = new Map<number, string>();
  // Trabalha apenas na seção # LinkedIn (antes de # Facebook)
  const linkedinSection = socialMd.split(/^#\s+Facebook\b/im)[0] ?? socialMd;

  let currentDestaque: number | null = null;
  let inCommentDiaria = false;
  let buffer = "";

  for (const line of linkedinSection.split("\n")) {
    const dHeader = line.match(/^##\s+d(\d)\b/i);
    if (dHeader) {
      // Flush anterior
      if (inCommentDiaria && currentDestaque !== null) {
        map.set(currentDestaque, buffer);
      }
      currentDestaque = parseInt(dHeader[1], 10);
      inCommentDiaria = false;
      buffer = "";
      continue;
    }
    // Detectar início da subseção ### comment_diaria
    if (/^###\s+comment_diaria\b/i.test(line)) {
      if (inCommentDiaria && currentDestaque !== null) {
        map.set(currentDestaque, buffer);
      }
      inCommentDiaria = true;
      buffer = "";
      continue;
    }
    // Qualquer outro ### ou ## encerra o comment_diaria atual
    if (/^#{2,3}\s/.test(line) && inCommentDiaria) {
      if (currentDestaque !== null) {
        map.set(currentDestaque, buffer);
      }
      inCommentDiaria = false;
      buffer = "";
      // Não continuar — processar o header na próxima iteração implicitamente
      continue;
    }
    if (inCommentDiaria) {
      buffer += line + "\n";
    }
  }
  // Flush final
  if (inCommentDiaria && currentDestaque !== null) {
    map.set(currentDestaque, buffer);
  }
  return map;
}

/**
 * Valida a contagem "mais N destaques" nos `### comment_diaria` do social.
 * Retorna findings pra cada destaque onde a contagem diverge do approved.json,
 * incluindo o caso de placeholder não-resolvido `{outros_count}` literal.
 *
 * Se `fix = true`, retorna também o `socialMd` corrigido (substituição inline).
 * A correção é ancorada à frase canônica do CTA ("mais N destaques de IA do dia")
 * para não afetar seções como `## post_pixel` que podem conter frases semelhantes.
 */
export function lintCommentDiariaCount(
  socialMd: string,
  approved: ApprovedShape,
  opts: { fix?: boolean } = {},
): { findings: CommentCountFinding[]; fixed: string } {
  const expected = computeOutrosCount(approved);
  const commentsByDestaque = parseCommentDiariaByDestaque(socialMd);
  const findings: CommentCountFinding[] = [];

  for (const [destaque, text] of [...commentsByDestaque.entries()].sort((a, b) => a[0] - b[0])) {
    // #2319: {outros_count} é agora placeholder intencional deferido para Stage 5
    // (igual a {edition_url} #595). Não é mais um erro no Stage 2.
    // Pular o check de contagem para este destaque (não tem número no texto ainda).
    if (/\{outros_count\}/.test(text)) {
      continue;
    }
    const matches = [...text.matchAll(COMMENT_COUNT_RE)];
    for (const m of matches) {
      const found = parseInt(m[1], 10);
      if (found !== expected) {
        findings.push({ destaque, found, expected });
        break; // um finding por destaque basta
      }
    }
  }

  let fixed = socialMd;
  if (opts.fix && findings.length > 0) {
    // Substituição ancorada à frase canônica do CTA ("mais N destaques de IA do dia")
    // para não afetar seções como `## post_pixel` que podem conter texto semelhante.
    // Usamos um Set de valores 'found' (excluindo NaN = placeholder) pra não
    // substituir o mesmo número duas vezes (caso raro de dois destaques com o mesmo
    // número errado).
    const toReplace = new Set(findings.map((f) => f.found).filter((n) => !isNaN(n)));
    for (const wrongN of toReplace) {
      fixed = fixed.replace(
        new RegExp(`(mais\\s+)${wrongN}(\\s+destaques\\s+de\\s+IA\\s+do\\s+dia)`, "gi"),
        `$1${expected}$2`,
      );
    }
  }

  return { findings, fixed };
}

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) {
      const key = argv[i].slice(2);
      // Suporta flags boolean (--fix) e flags com valor (--social path)
      if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) {
        out[key] = argv[i + 1];
        i++;
      } else {
        out[key] = "true";
      }
    }
  }
  return out;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  if (!args.social || !args.approved) {
    console.error(
      "Uso: lint-social-numbers.ts --social <03-social.md> --approved <01-approved-capped.json> [--fix]",
    );
    process.exit(1);
  }
  const doFix = args.fix === "true";
  const socialPath = resolve(process.cwd(), args.social);
  let socialMd = readFileSync(socialPath, "utf8");
  // #2061: fallback pra 01-approved.json quando 01-approved-capped.json ausente
  // (edição pré-#2053 não tem o arquivo capped — ENOENT sem fallback dá mensagem
  // inútil ao editor que roda o lint retroativamente).
  let approvedPath = resolve(process.cwd(), args.approved);
  if (!existsSync(approvedPath)) {
    const uncappedPath = approvedPath.replace("01-approved-capped.json", "01-approved.json");
    if (existsSync(uncappedPath)) {
      console.error(
        `⚠️  lint-social-numbers: ${args.approved} ausente — edição pré-#2053, usando 01-approved.json como fallback.`,
      );
      approvedPath = uncappedPath;
    }
    // Se nem o uncapped existe, deixar o readFileSync lançar ENOENT com path original.
  }
  const approved = JSON.parse(readFileSync(approvedPath, "utf8")) as ApprovedShape;

  // --- lint 1: cifras financeiras alucinadas (#1711) ---
  const numFindings = lintSocialNumbers(socialMd, approved);
  const totalNums = numFindings.reduce((acc, f) => acc + f.unsourced.length, 0);

  if (totalNums > 0) {
    console.error(
      `\n⚠️  lint-social-numbers: ${totalNums} cifra(s) financeira(s) no social NÃO encontrada(s) na fonte do destaque correspondente — possível alucinação, confira no gate:`,
    );
    for (const f of numFindings) {
      for (const fig of f.unsourced) {
        console.error(`  - d${f.destaque}: "${fig.raw}" (normalizado: ${fig.key})`);
      }
    }
  }

  // --- lint 2: contagem comment_diaria (#2014) ---
  const { findings: countFindings, fixed } = lintCommentDiariaCount(socialMd, approved, { fix: doFix });

  // #2331/F6 — Contrato do lint no modelo de resolução tardia (#2319):
  //
  //  Stage 2 (padrão, sem --post-stage5):
  //    - {outros_count} literal no comment_diaria é PERMITIDO (placeholder intencional,
  //      resolvido pelo publish-linkedin no Stage 5 — igual a {edition_url}).
  //    - lintCommentDiariaCount já pula entradas com {outros_count} (não gera findings).
  //    - Contagem numérica errada (ex: "mais 9 destaques" quando esperado 10) → WARN (exit 0).
  //
  //  Pós-Stage 5 (com --post-stage5):
  //    - {outros_count} literal que sobreviveu ao Stage 5 é BLOCKER (exit 1).
  //    - Indica que publish-linkedin.ts falhou em resolver o placeholder antes de despachar.
  //    - Deve ser passado ao auditar 03-social.md pós-publicação ou em CI pós-stage5.
  //
  // #2331/F5 — Removida a variável `unresolvedFindings` que era always [] e tinha
  //   um bloco process.exit(1) referenciando ela (dead code). A semântica de bloqueio
  //   agora é controlada pelo flag --post-stage5 documentado acima.

  if (countFindings.length > 0) {
    const didFix = doFix && fixed !== socialMd;
    const action = didFix
      ? "→ corrigido automaticamente"
      : doFix
        ? "→ não foi possível corrigir automaticamente, confira no gate"
        : "→ confira no gate ou rode com --fix";
    console.error(
      `\n⚠️  lint-social-numbers: contagem "mais N destaques" errada no comment_diaria ${action}:`,
    );
    for (const f of countFindings) {
      console.error(`  - d${f.destaque}: encontrou ${f.found}, esperado ${f.expected}`);
    }
    if (didFix) {
      const tmpPath = socialPath + ".tmp";
      writeFileSync(tmpPath, fixed, "utf8");
      renameSync(tmpPath, socialPath);
      console.error(`  [fix] ${socialPath} atualizado.`);
      socialMd = fixed;
    }
  }

  // Verificar placeholder não-resolvido somente em --post-stage5 mode.
  // Em Stage 2 (sem o flag), {outros_count} literal é esperado e não é erro.
  const postStage5 = args["post-stage5"] === "true";
  let hasUnresolvedPostStage5 = false;
  if (postStage5) {
    // Checar se algum comment_diaria ainda tem o placeholder literal
    const commentsByDestaque = parseCommentDiariaByDestaque(socialMd);
    for (const [destaque, text] of commentsByDestaque) {
      if (/\{outros_count\}/.test(text)) {
        if (!hasUnresolvedPostStage5) {
          console.error(
            `\n🚨  lint-social-numbers (--post-stage5): placeholder literal {outros_count} não-resolvido — Stage 5 deveria ter substituído antes de despachar:`,
          );
        }
        hasUnresolvedPostStage5 = true;
        console.error(`  - d${destaque}: "{outros_count}" literal sobreviveu ao Stage 5 (bug em publish-linkedin.ts?)`);
      }
    }
  }

  // Saída final:
  //   - Cifras financeiras: WARN-only (exit 0)
  //   - Contagem errada Stage 2: WARN-only (exit 0)
  //   - Placeholder {outros_count} pós-Stage5 (--post-stage5): blocker (exit 1)
  // ok must be false whenever hasUnresolvedPostStage5 — same condition that drives
  // exit 1 — so callers that parse `| jq -e '.ok'` instead of the exit code also
  // detect the failure (#2338 fix 1).
  console.log(
    JSON.stringify({
      ok: totalNums === 0 && countFindings.length === 0 && !hasUnresolvedPostStage5,
      num_findings: numFindings,
      count_findings: countFindings,
    }, null, 2),
  );
  if (hasUnresolvedPostStage5) {
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
