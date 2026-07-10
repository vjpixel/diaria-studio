/**
 * lint-checks/callout-placement.ts (#1972 — Opção B, defesa; marcador-
 * agnóstico desde #3204)
 *
 * Detecta um callout (bold-line `**...**` OU parágrafo emoji-led) colado
 * DENTRO de uma seção de DESTAQUE, em vez de isolado entre dois `---`.
 *
 * Por que importa: `parseDestaques` fatia o reviewed.md em `^---$`. Um callout
 * colado antes do `---` de fechamento do D1 cai na seção do D1 e é absorvido
 * pelo corpo/why do destaque (render quebrado + duplicado — visto na 260609).
 * Marcador-agnóstico desde #3204: `newsletter-parse.ts`'s `locateBoxInGap`
 * extrai o box por POSIÇÃO (bloco `---`-isolado), não por marcador — mas essa
 * extração só funciona quando o box É seu próprio bloco. Um box "colado" (sem
 * `---` isolando) não tem sinal estrutural de posição pro parser pegar; este
 * lint é o backstop que ainda reconhece a FORMA do bloco (bold-line inteiro
 * OU emoji-led) pra flagrar antes que ele seja silenciosamente absorvido.
 *
 * O render já é robusto a isso quando o box ESTÁ isolado (de-dup determinístico
 * em `stripBoxDivulgacao1`/`stripBoxDivulgacao2`, Opção A), mas este lint
 * sinaliza a fonte do problema pro editor reposicionar o bloco — o callout deve
 * ser sua PRÓPRIA seção, isolada entre o `---` que fecha o D1 e o `---` que
 * abre o D2:
 *
 *   ...corpo do D1...
 *
 *   ---
 *
 *   **Callout...**
 *
 *   ---
 *
 *   **DESTAQUE 2 | ...**
 *
 * O introCallout (🎉/📣 ANTES do 1º DESTAQUE, na região de intro) é legítimo e
 * NÃO é sinalizado — só callouts dentro de uma seção que já contém um header
 * `DESTAQUE N | ...`. O TÍTULO do destaque (1ª linha de conteúdo após o
 * header — tipicamente `**[Título](url)**`, também bold-wrapped) também NÃO é
 * sinalizado — é reconhecido por POSIÇÃO (1º parágrafo da seção), não por forma.
 */

export interface CalloutPlacementMatch {
  line: number;
  context: string;
}

export interface CalloutPlacementResult {
  ok: boolean;
  matches: CalloutPlacementMatch[];
}

// Separador casado na linha BRUTA (sem trim), espelhando `parseDestaques`
// (`raw.split(/^---$/m)`) e `parseSections` no render. Estrito de propósito: um
// `--- ` (espaço final) ou ` ---` (indentado) NÃO splita pra aqueles parsers, então
// o callout seguinte É absorvido no D1 — o lint precisa ser tão estrito quanto o
// splitter que protege, senão vira falso-negativo (passa, mas o render quebra).
const SEPARATOR_RE = /^---$/;
const DESTAQUE_HEADER_RE = /^(?:\*\*)?DESTAQUE\s+[123]\s*\|/;
// #3204: marcador-agnóstico — QUALQUER parágrafo INTEIRAMENTE embrulhado em
// `**...**` (mesma forma que `formatBoxInner` em newsletter-parse.ts detecta
// como box bold-line) OU iniciado por um emoji + espaço (range Unicode
// genérico — não um allowlist de 3 emojis) é candidato a box colado.
const FULL_BOLD_LINE_RE = /^\*\*[\s\S]+\*\*$/;
const EMOJI_LEAD_RE =
  /^[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}][\u{FE0F}\u{200D}\u{1F3FB}-\u{1F3FF}\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]*\s+/u;

export function lintCalloutPlacement(md: string): CalloutPlacementResult {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const matches: CalloutPlacementMatch[] = [];
  let inDestaqueSection = false;
  let sawTitle = false; // já vimos o 1º parágrafo de conteúdo (= título) desta seção?
  let blankRun = 0;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    // Separador: linha bruta (sem trim) pra bater com /^---$/m do parseDestaques.
    if (SEPARATOR_RE.test(raw)) {
      inDestaqueSection = false;
      sawTitle = false;
      blankRun = 0;
      continue;
    }
    const t = raw.trim();
    if (t === "") {
      blankRun++;
      continue;
    }
    if (DESTAQUE_HEADER_RE.test(t)) {
      inDestaqueSection = true;
      sawTitle = false;
      blankRun = 0;
      continue;
    }
    const isParaStart = blankRun > 0 || i === 0;
    blankRun = 0;
    if (!inDestaqueSection) continue;
    if (!sawTitle) {
      // 1ª linha de conteúdo não-vazia da seção = título do destaque — nunca
      // sinalizada, mesmo bold-wrapped (`**[Título](url)**` também bate em
      // FULL_BOLD_LINE_RE). Reconhecida por POSIÇÃO, não por forma.
      sawTitle = true;
      continue;
    }
    if (!isParaStart) continue; // só avalia INÍCIO de parágrafo
    if (FULL_BOLD_LINE_RE.test(t) || EMOJI_LEAD_RE.test(t)) {
      matches.push({ line: i + 1, context: t.slice(0, 80) });
    }
  }
  return { ok: matches.length === 0, matches };
}

// ---------------------------------------------------------------------------
// #2729 — ≥2 blocos de callout-marker (🎉/📣) empilhados na região de intro
// ---------------------------------------------------------------------------

/**
 * #2729: `extractIntroCallout` (`scripts/lib/newsletter-parse.ts`, tornado
 * greedy pelo #2727 pra permitir sub-linhas `**bold**` dentro do box de
 * início de mês) assume que a região de intro (tudo antes do 1º
 * `**DESTAQUE`) contém NO MÁXIMO 1 bloco `**(🎉|📣) …**` — o regex greedy
 * casa do PRIMEIRO abertura até o ÚLTIMO `**` de fim de linha na região.
 *
 * Se o editor colar 2 blocos empilhados (ex: um 📣 patrocinado acima do 🎉 de
 * campeões/sorteio — `inject-champions-callout.ts` já tem lógica de
 * precedência que PULA a auto-injeção quando já existe um callout, mas isso
 * não impede colagem manual de 2 blocos pelo editor no Drive), o greedy funde
 * os dois num só bloco: os `**` internos (fechamento do 1º bloco + abertura
 * do 2º) vazam como texto literal no meio do parágrafo renderizado, e o
 * separador "Divulgação" do bloco 📣 patrocinado se perde.
 *
 * Este check erra (`ok: false`) quando encontra ≥2 linhas
 * `^\*\*\s*(🎉|📣)` na região de intro (antes do 1º `**DESTAQUE`) —
 * independente dos boxes de divulgação (📚/📣/🎉/🛒 entre destaques, cobertos por
 * `lintCalloutPlacement`/`locateBoxInGap`, semântica diferente).
 */
export interface StackedIntroCalloutResult {
  ok: boolean;
  count: number;
  lines: number[];
}

const INTRO_CALLOUT_OPEN_RE = /^\*\*\s*(?:🎉|📣)/u;
const DESTAQUE_MARKER_RE = /^\*\*DESTAQUE/;

export function lintStackedIntroCallouts(md: string): StackedIntroCalloutResult {
  const normalized = md.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  const matchLines: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    // Região de intro = tudo ANTES da 1ª linha `**DESTAQUE` — para assim que
    // encontrar o 1º destaque, espelhando `extractIntroCallout`
    // (`text.split(/^\*\*DESTAQUE/m)[0]`).
    if (DESTAQUE_MARKER_RE.test(lines[i])) break;
    if (INTRO_CALLOUT_OPEN_RE.test(lines[i].trim())) {
      matchLines.push(i + 1);
    }
  }
  return { ok: matchLines.length < 2, count: matchLines.length, lines: matchLines };
}
