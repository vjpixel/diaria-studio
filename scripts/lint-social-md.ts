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
import { tokenizeForJaccard, jaccardSimilarity } from "./dedup.ts"; // #1861

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
// #595: schema validation pra LinkedIn 3-textos-por-destaque
// ---------------------------------------------------------------------------

export interface LinkedinSchemaError {
  destaque: string;
  rule: string;
  detail: string;
}

export interface LinkedinSchemaResult {
  ok: boolean;
  errors: LinkedinSchemaError[];
  destaques: Array<{
    destaque: string;
    has_main: boolean;
    has_comment_diaria: boolean;
    has_comment_pixel: boolean;
    main_chars: number;
    comment_diaria_chars: number;
    comment_pixel_chars: number;
  }>;
}

/**
 * #595: Valida que cada `## d{N}` na seção LinkedIn do `03-social.md` tem
 * subseções `### comment_diaria` e `### comment_pixel`. Sem isso, Stage 4
 * (futuro publish-linkedin com 9 items) não tem como compor payload pros 3
 * scenarios Make.
 *
 * Char count limits:
 *   main: 1200-1500 (sweet spot LinkedIn)
 *   comment_diaria: 200-400 (CTA + URL)
 *   comment_pixel: 300-600 (opinião editorial)
 */
export function lintLinkedinSchema(md: string): LinkedinSchemaResult {
  const linkedinSection = extractPlatformSection(md, "linkedin");
  const errors: LinkedinSchemaError[] = [];
  const destaques: LinkedinSchemaResult["destaques"] = [];
  if (!linkedinSection) {
    return { ok: true, errors, destaques }; // sem seção LinkedIn = no-op
  }

  // Splitar por `## d{N}`. Cada chunk começa após o header.
  const chunks = linkedinSection.split(/\n## (d\d+)\n/);
  // chunks[0] = preâmbulo (vazio ou irrelevante); chunks[1] = "d1", chunks[2] = body d1, chunks[3] = "d2", etc
  for (let i = 1; i < chunks.length; i += 2) {
    const destaque = chunks[i];
    const body = chunks[i + 1] ?? "";

    // Splitar por `### comment_diaria` e `### comment_pixel`.
    const mainEnd = body.search(/\n### comment_diaria\b/);
    const commentDiariaStart = body.search(/\n### comment_diaria\b/);
    const commentPixelStart = body.search(/\n### comment_pixel\b/);

    let mainText = "";
    let commentDiariaText = "";
    let commentPixelText = "";

    if (mainEnd === -1) {
      mainText = body;
    } else {
      mainText = body.slice(0, mainEnd);
    }
    if (commentDiariaStart !== -1) {
      const start = body.indexOf("\n", commentDiariaStart + 1) + 1;
      const end = commentPixelStart !== -1 ? commentPixelStart : body.length;
      commentDiariaText = body.slice(start, end);
    }
    if (commentPixelStart !== -1) {
      const start = body.indexOf("\n", commentPixelStart + 1) + 1;
      // #1690: terminar no próximo sibling `## ` (ex: post_pixel) — senão o
      // último bloco (d3) absorve a seção post_pixel e infla comment_pixel_chars.
      const nextSibling = body.indexOf("\n## ", start);
      commentPixelText = nextSibling !== -1 ? body.slice(start, nextSibling) : body.slice(start);
    }

    // Strip char_count comments + leading whitespace
    const stripCommentMarkers = (s: string) =>
      s.replace(/<!--[\s\S]*?-->/g, "").trim();
    mainText = stripCommentMarkers(mainText);
    commentDiariaText = stripCommentMarkers(commentDiariaText);
    commentPixelText = stripCommentMarkers(commentPixelText);

    const has_main = mainText.length > 0;
    const has_comment_diaria = commentDiariaText.length > 0;
    const has_comment_pixel = commentPixelText.length > 0;

    destaques.push({
      destaque,
      has_main,
      has_comment_diaria,
      has_comment_pixel,
      main_chars: mainText.length,
      comment_diaria_chars: commentDiariaText.length,
      comment_pixel_chars: commentPixelText.length,
    });

    if (!has_main) {
      errors.push({
        destaque,
        rule: "missing_main",
        detail: `${destaque}: post principal ausente em ## ${destaque}`,
      });
    }
    if (!has_comment_diaria) {
      errors.push({
        destaque,
        rule: "missing_comment_diaria",
        detail: `${destaque}: subseção ### comment_diaria ausente — necessária pra CTA + URL (#595)`,
      });
    }
    if (!has_comment_pixel) {
      errors.push({
        destaque,
        rule: "missing_comment_pixel",
        detail: `${destaque}: subseção ### comment_pixel ausente — necessária pra amplificação 2ª conta (#595)`,
      });
    }
    // Char count ranges (warning only — não bloqueia gate; lints estritos
    // apenas missing-section)
    if (has_main && (mainText.length < 800 || mainText.length > 1800)) {
      errors.push({
        destaque,
        rule: "main_chars_out_of_range",
        detail: `${destaque}: main post ${mainText.length} chars (esperado 1200-1500, tolerância 800-1800)`,
      });
    }

    // #595 (decisão editorial 2026-05-08): main post NÃO pode mencionar
    // Diar.ia ou diar.ia.br. Branding/CTA vão exclusivamente no comment_diaria
    // (T+3min). Main post fica 100% editorial.
    if (has_main) {
      if (/\bDiar\.ia\b/i.test(mainText)) {
        errors.push({
          destaque,
          rule: "main_post_mentions_diaria",
          detail:
            `${destaque}: main post menciona "Diar.ia" — ` +
            `branding vai exclusivamente no comment_diaria (T+3min), main post fica 100% editorial.`,
        });
      }
      if (/\bdiar\.ia\.br\b/i.test(mainText)) {
        errors.push({
          destaque,
          rule: "main_post_mentions_diaria_url",
          detail:
            `${destaque}: main post contém "diar.ia.br" — ` +
            `URL/CTA pra newsletter vai exclusivamente no comment_diaria.`,
        });
      }
    }

    // #595: comment_diaria deve conter `{edition_url}` (placeholder) em Stage 2.
    // Stage 4 substitui pelo URL Beehiiv real. Lint OK se contém placeholder OU
    // já contém URL diar.ia.br/p/<slug> (substituição pós-Stage 4).
    if (has_comment_diaria) {
      const hasPlaceholder = /\{edition_url\}/.test(commentDiariaText);
      const hasResolved = /https?:\/\/diar\.ia\.br\/p\//.test(commentDiariaText);
      if (!hasPlaceholder && !hasResolved) {
        errors.push({
          destaque,
          rule: "comment_diaria_missing_edition_url",
          detail:
            `${destaque}: comment_diaria não contém ` +
            `'{edition_url}' (placeholder Stage 2) nem 'diar.ia.br/p/<slug>' (resolvido pós-Stage 4). ` +
            `Editor deve apontar pra edição completa, não pro artigo source.`,
        });
      }
    }
    if (has_comment_diaria && (commentDiariaText.length < 100 || commentDiariaText.length > 600)) {
      errors.push({
        destaque,
        rule: "comment_diaria_chars_out_of_range",
        detail: `${destaque}: comment_diaria ${commentDiariaText.length} chars (esperado 200-400, tolerância 100-600)`,
      });
    }
    if (has_comment_pixel && (commentPixelText.length < 150 || commentPixelText.length > 800)) {
      errors.push({
        destaque,
        rule: "comment_pixel_chars_out_of_range",
        detail: `${destaque}: comment_pixel ${commentPixelText.length} chars (esperado 300-600, tolerância 150-800)`,
      });
    }
  }

  return { ok: errors.length === 0, errors, destaques };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

// ── #1762: posts social NÃO devem encerrar com pergunta (CTA-pergunta) ──────

export interface TrailingQuestionMatch {
  platform: "linkedin" | "facebook";
  destaque: string;
  sentence: string;
}
export interface TrailingQuestionResult {
  ok: boolean;
  matches: TrailingQuestionMatch[];
}

/**
 * #1762: a ÚLTIMA frase do post principal (corpo de `## d{N}`, antes dos comments
 * do LinkedIn) não pode terminar em "?". Alvo: CTA-pergunta de encerramento
 * ("Comente abaixo: ...? Como você faz X?"). Perguntas retóricas NO MEIO do corpo
 * e perguntas entre aspas (`vale a pena?"`) são aceitáveis — só a de encerramento
 * é flagada.
 *
 * Estratégia: pega a última linha de texto significativa (ignorando linhas só de
 * hashtags / só de URL), remove hashtags inline no fim, e checa se termina em "?"
 * literal (um "?" seguido de aspas de fechamento = pergunta citada → OK).
 */
// Linha que é só hashtags (tags podem ter hífen, ex: #multi-agent).
const HASHTAG_ONLY_LINE_RE = /^(#[\p{L}\w-]+(\s+#[\p{L}\w-]+)*)$/u;
// CTA fixo de assinatura (Facebook fecha com isto após o corpo) — não é o
// "fim editorial" que o #1762 mira; pulamos pra checar a última frase do corpo.
const SUBSCRIBE_CTA_LINE_RE = /diar\.ia\.br|assine\s+gr[áa]tis|receba\s+not[íi]cias/i;

/**
 * #1861: o `## post_pixel` (post pessoal standalone do Pixel) é por convenção
 * sobre o **D1** (#1690). Quando os destaques são reordenados DEPOIS de gerar o
 * social (reorder no gate / edição manual), os `## d{N}` são remapeados mas o
 * post_pixel atrelado ao D1 antigo fica stale — e nenhum lint pegava (caso
 * 260605: D1 virou MIT empregos, post_pixel ficou sobre ChatGPT, o D1 antigo).
 *
 * Heurística de ALTA precisão (evita FP num post reescrito): compara a
 * sobreposição de tokens (Jaccard, reusa o de dedup.ts) do post_pixel com o
 * main de cada destaque. O sinal real é RELATIVO — só falha quando o post_pixel
 * é claramente MAIS parecido com OUTRO destaque que com o d1, por uma margem:
 *   `bestOther ≥ simD1 + MARGIN` E `bestOther ≥ FLOOR`.
 *
 * Por que margem RELATIVA, não threshold absoluto (review #1877): o post_pixel
 * é voz PESSOAL reescrita, então o overlap literal com o main EDITORIAL do
 * destaque é naturalmente baixo (na 260605 real, o post_pixel correto batia o
 * d1 em ~0.14, os outros em ~0.05). Um floor absoluto de 0.15 deixaria passar o
 * caso stale (post sobre d2 com Jaccard ~0.12-0.14). O que discrimina é
 * bestOther superar simD1 com folga; o FLOOR baixo só evita disparar em ruído
 * (1-2 tokens coincidentes quando o post quase não casa com nada).
 *
 * Hashtags são stripadas dos DOIS lados (simetria) — senão as tags do main
 * inflam o union e derrubam todas as sims.
 */
export interface PostPixelMatchResult {
  ok: boolean;
  /** false = no-op (sem seção LinkedIn / sem post_pixel / sem d1 / post vazio). */
  checked: boolean;
  best_match?: string;
  sims?: Record<string, number>;
  detail?: string;
  /**
   * Valor do label `<!-- destaque: d{N} -->` emitido pelo social-linkedin no bloco
   * `## post_pixel`. Quando presente, indica a qual destaque o bloco declarou
   * pertencer. O lint usa isso como cross-check: se `declared_destaque` difere de
   * `best_match` Jaccard, a inconsistência é mais forte (label desatualizado é
   * evidência adicional de stale). Undefined = label ausente no bloco.
   */
  declared_destaque?: string;
}

const POST_PIXEL_MARGIN = 0.05; // bestOther tem que bater simD1 por ≥ 5 pontos
const POST_PIXEL_FLOOR = 0.08; // e ser um match topical real, não 1-2 tokens de ruído

/**
 * Tokeniza prosa social: strip comments + hashtags (em ambos os lados da
 * comparação, de forma simétrica), depois tokenizeForJaccard.
 *
 * Stripping simétrico evita falso-positivo quando entidades aparecem como
 * hashtag apenas no post_pixel (ex: #Anthropic) — sem symmetry, o tag inflaria
 * o union do post_pixel sem contrapartida no main do destaque, derrubando
 * artificialmente as sims (#2145 finding 6).
 */
function socialProseTokens(s: string): Set<string> {
  // Strip HTML comments primeiro, depois hashtags (ex: #InteligenciaArtificial).
  // A ordem importa: um hashtag dentro de um comment seria removido pelo
  // comment-strip; remover hashtags depois garante que sobraram só no texto.
  const clean = s
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/#[\p{L}\w-]+/gu, " ");
  return tokenizeForJaccard(clean);
}

export function lintPostPixelMatchesD1(md: string): PostPixelMatchResult {
  const section = extractPlatformSection(md, "linkedin");
  if (!section) return { ok: true, checked: false };

  // Mapa de blocos `## <name>` → conteúdo até o próximo `## <name>` (mesmo nível).
  const text = "\n" + section.replace(/\r\n/g, "\n");
  const blocks: Record<string, string> = {};
  const re = /\n## ([a-z0-9_]+)\s*\n([\s\S]*?)(?=\n## [a-z0-9_]+\s*\n|$)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    blocks[m[1].toLowerCase()] = m[2];
  }

  const postPixelRaw = blocks["post_pixel"];
  if (!postPixelRaw || postPixelRaw.trim().length === 0) {
    return { ok: true, checked: false };
  }

  // Extrair label `<!-- destaque: d{N} -->` emitido pelo social-linkedin.
  // Usado como cross-check: se o label diz "d1" mas Jaccard aponta outro destaque,
  // reforça a evidência de stale. Se ausente → undefined (não bloqueia).
  const labelMatch = postPixelRaw.match(/<!--\s*destaque:\s*(d\d+)\s*-->/i);
  const declaredDestaque = labelMatch ? labelMatch[1].toLowerCase() : undefined;

  // Main text de um destaque = conteúdo antes do 1º `### ` (subseções comment).
  const destaqueMain = (name: string): string | null => {
    const raw = blocks[name];
    if (raw === undefined) return null;
    const idx = raw.search(/\n### /);
    return idx === -1 ? raw : raw.slice(0, idx);
  };

  const d1 = destaqueMain("d1");
  if (d1 === null) return { ok: true, checked: false }; // sem d1 não há baseline

  const ppTokens = socialProseTokens(postPixelRaw);
  // post_pixel só com hashtags/comment (sem prosa real) → não dá pra comparar.
  if (ppTokens.size === 0) return { ok: true, checked: false };

  const sims: Record<string, number> = {};
  for (const name of ["d1", "d2", "d3"]) {
    const main = destaqueMain(name);
    if (main === null) continue;
    sims[name] = jaccardSimilarity(ppTokens, socialProseTokens(main));
  }

  const simD1 = sims["d1"] ?? 0;
  let bestOther = -1;
  let bestOtherName = "";
  for (const [name, s] of Object.entries(sims)) {
    if (name === "d1") continue;
    if (s > bestOther) {
      bestOther = s;
      bestOtherName = name;
    }
  }

  if (bestOther >= simD1 + POST_PIXEL_MARGIN && bestOther >= POST_PIXEL_FLOOR) {
    const labelHint = declaredDestaque && declaredDestaque !== "d1"
      ? ` Label '<!-- destaque: ${declaredDestaque} -->' confirma dessincronização.`
      : "";
    return {
      ok: false,
      checked: true,
      best_match: bestOtherName,
      sims,
      declared_destaque: declaredDestaque,
      detail:
        `post_pixel parece sobre ${bestOtherName} (Jaccard ${bestOther.toFixed(2)}), não d1 ` +
        `(Jaccard ${simD1.toFixed(2)}). Reordenou destaques após gerar o social? Re-sincronize ` +
        `o post_pixel pro D1 atual (#1861).${labelHint}`,
    };
  }
  return { ok: true, checked: true, best_match: simD1 > 0 ? "d1" : undefined, sims, declared_destaque: declaredDestaque };
}

export function lastMeaningfulSentence(body: string): string {
  const cleaned = body.replace(/<!--[\s\S]*?-->/g, ""); // strip char_count comments
  const lines = cleaned.split("\n").map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i];
    if (HASHTAG_ONLY_LINE_RE.test(l)) continue; // linha só de hashtags
    if (/^https?:\/\/\S+$/.test(l)) continue; // linha só de URL
    if (SUBSCRIBE_CTA_LINE_RE.test(l)) continue; // #1762: CTA de assinatura (Facebook)
    return l;
  }
  return "";
}

export function endsWithTrailingQuestion(sentence: string): boolean {
  // Remove decorações de encerramento (hashtags coladas/espaçadas + emoji +
  // espaço) iterativamente, em qualquer ordem ("...faz? 🚀 #IA" → "...faz?").
  let stripped = sentence.trimEnd();
  let prev = "";
  while (stripped !== prev) {
    prev = stripped;
    stripped = stripped.replace(/\s*#[\p{L}\w-]+\s*$/u, "").trimEnd(); // hashtag final
    stripped = stripped.replace(/[\p{Extended_Pictographic}️‍]\s*$/u, "").trimEnd(); // emoji final
  }
  // "?" literal no fim → pergunta de encerramento. "?\"" / "?'" / "?)" → citada/aparte → OK.
  return /\?$/.test(stripped);
}

export function lintTrailingQuestion(md: string): TrailingQuestionResult {
  const matches: TrailingQuestionMatch[] = [];
  for (const platform of ["linkedin", "facebook"] as const) {
    const section = extractPlatformSection(md, platform);
    if (!section) continue;
    // Prefixa "\n" pra garantir captura do 1º `## d1` mesmo sem linha em branco
    // antes (o split exige `\n## d{N}\n`). Sem isso, d1 era pulado (review #1776).
    const chunks = ("\n" + section).split(/\n## (d\d+)\n/);
    for (let i = 1; i < chunks.length; i += 2) {
      const destaque = chunks[i];
      let body = chunks[i + 1] ?? "";
      // Só o post PRINCIPAL — corta os comments do LinkedIn (### comment_*).
      const commentIdx = body.search(/\n### comment_/);
      if (commentIdx !== -1) body = body.slice(0, commentIdx);
      const last = lastMeaningfulSentence(body);
      if (last && endsWithTrailingQuestion(last)) {
        matches.push({ platform, destaque, sentence: last.slice(-100) });
      }
    }
  }
  return { ok: matches.length === 0, matches };
}

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
        "  ou: lint-social-md.ts --check relative-time --md <path>\n" +
        "  ou: lint-social-md.ts --check linkedin-schema --md <path>\n" +
        "  ou: lint-social-md.ts --check post_pixel-matches-d1 --md <path>",
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

  // Modo --check no-trailing-question (#1762) — posts não encerram com pergunta
  if (args.check === "no-trailing-question") {
    const result = lintTrailingQuestion(md);
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) {
      console.error(
        `\n❌ ${result.matches.length} post(s) social encerrando com pergunta (#1762 — fechar com afirmação, não CTA-pergunta):`,
      );
      for (const m of result.matches) {
        console.error(`  [${m.platform} ${m.destaque}] termina em pergunta: "...${m.sentence}"`);
      }
      process.exit(1);
    }
    return;
  }

  // Modo --check linkedin-schema (#595) — valida 3 textos por destaque
  if (args.check === "linkedin-schema") {
    const result = lintLinkedinSchema(md);
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) {
      console.error(
        `\n❌ ${result.errors.length} erro(s) no schema LinkedIn (#595 — main + comment_diaria + comment_pixel por destaque):`,
      );
      for (const e of result.errors) console.error(`  [${e.destaque}] ${e.rule}: ${e.detail}`);
      process.exit(1);
    }
    return;
  }

  // Modo --check post_pixel-matches-d1 (#1861) — post pessoal do Pixel deve ser
  // sobre o D1 atual (não ficar stale após reorder dos destaques).
  if (args.check === "post_pixel-matches-d1") {
    const result = lintPostPixelMatchesD1(md);
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) {
      console.error(`\n❌ post_pixel desalinhado com D1 (#1861):\n  ${result.detail}`);
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
