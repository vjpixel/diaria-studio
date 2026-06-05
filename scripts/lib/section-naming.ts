/**
 * section-naming.ts (#1324, #1328, #1569) — helpers compartilhados pra nomes
 * canônicos das seções da newsletter (LANÇAMENTOS, RADAR) usados tanto no MD
 * do gate (`02-reviewed.md`) quanto no HTML renderizado
 * (`render-newsletter-html.ts`).
 *
 * Antes vivia inline em `render-newsletter-html.ts` (singularizeSectionName,
 * SECTION_EMOJI), agora extraído pra evitar drift entre MD e HTML.
 *
 * Convenção (#1328 + #1569): cada seção secundária tem emoji prefix
 * consistente — 🚀 LANÇAMENTOS, 📡 RADAR. PESQUISAS removida em #1569
 * (papers mergeam em RADAR via stitch). OUTRAS NOTÍCIAS renomeada pra RADAR.
 * Aliases legacy mantidos no map pra rendering de edições antigas.
 */

/** Mapa emoji → nome canônico (singular + plural compartilham o emoji). */
const SECTION_EMOJI_MAP: Record<string, string> = {
  "LANÇAMENTO": "🚀",
  "LANÇAMENTOS": "🚀",
  "RADAR": "📡",
  "USE MELHOR": "🛠️",
  // #1674: seção VÍDEOS (bucket `video`). Sem isso parseSections dropa a seção
  // inteira do HTML (mesma classe da falha silenciosa 260519).
  "VÍDEO": "📺",
  "VÍDEOS": "📺",
  // #1569: legacy aliases — render-newsletter-html ainda precisa reconhecer
  // headers de edições antigas pra re-rendering. Não emitir esses nomes em
  // edições novas.
  "PESQUISA": "🔬",
  "PESQUISAS": "🔬",
  "OUTRA NOTÍCIA": "📰",
  "OUTRAS NOTÍCIAS": "📰",
};

/**
 * Pure (#1070, #1569): retorna o nome da seção no singular quando N=1.
 * Plurais permanecem inalterados quando N≠1.
 *
 * Mapping pt-BR:
 *   - LANÇAMENTOS → LANÇAMENTO
 *   - RADAR → RADAR (invariante — singular e plural são iguais)
 *   - Legacy: PESQUISAS → PESQUISA, OUTRAS NOTÍCIAS → OUTRA NOTÍCIA
 *     (mantidos pra rendering de edições antigas)
 *
 * Aceita nome com ou sem emoji prefix — strip emoji antes de mapear, depois
 * cliente pode re-anexar via `sectionEmojiPrefix`. Isso evita
 * `🚀 LANÇAMENTOS` ficar inalterado por não bater no exato match.
 */
export function singularizeSectionName(name: string, count: number): string {
  if (count !== 1) return name;
  const bare = stripEmojiPrefix(name);
  if (bare === "LANÇAMENTOS") return "LANÇAMENTO";
  if (bare === "VÍDEOS") return "VÍDEO";
  if (bare === "PESQUISAS") return "PESQUISA";
  if (bare === "OUTRAS NOTÍCIAS") return "OUTRA NOTÍCIA";
  // #1569: RADAR não singulariza (radar é radar, mesmo com 1 item)
  return name;
}

/**
 * Retorna o prefix de emoji (incluindo trailing space) pra uma seção
 * conhecida, ou string vazia se a seção não tem emoji canônico.
 *
 * Aceita nome com ou sem emoji prefix existente (strip antes de buscar
 * no map).
 */
export function sectionEmojiPrefix(name: string): string {
  const bare = stripEmojiPrefix(name);
  const emoji = SECTION_EMOJI_MAP[bare];
  return emoji ? `${emoji} ` : "";
}

/**
 * Remove emoji prefix de um nome de seção, retornando só o nome base.
 * Idempotente — se não tem emoji, retorna o input.
 *
 * Regex cobre todos os emojis canônicos das seções (🚀 📡 🛠️ 📺 🔬 📰) via
 * range Unicode high — defensivo, casa qualquer emoji novo sem precisar atualizar
 * esta regex.
 *
 * #1836: mesma forma do SECTION_EMOJI_PREFIX (1º char emoji + 0+ modificadores
 * FE0F/ZWJ/skin-tone/range). Mantém consistência: o que o header regex casa como
 * prefixo, este strip remove — antes o strip era tight (só 1 FE0F) e um header
 * com emoji composto (👨‍💻) casava no header mas não singularizava.
 */
export function stripEmojiPrefix(name: string): string {
  return name.replace(
    /^[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}][\u{FE0F}\u{200D}\u{1F3FB}-\u{1F3FF}\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]*\s+/u,
    "",
  );
}

/**
 * Helper one-shot: retorna o nome completo da seção pra display (MD ou
 * HTML), com emoji prefix + número correto (singular se N=1).
 *
 * Exemplo:
 *   displaySectionName("LANÇAMENTOS", 1) → "🚀 LANÇAMENTO"
 *   displaySectionName("LANÇAMENTOS", 3) → "🚀 LANÇAMENTOS"
 *   displaySectionName("🚀 LANÇAMENTOS", 1) → "🚀 LANÇAMENTO" (idempotente)
 */
export function displaySectionName(name: string, count: number): string {
  // Strip emoji prefix antes de singularizar — depois re-anexa via prefix.
  // Sem o strip, "🔬 PESQUISAS" com N=2 fica inalterado, e prefix duplicaria
  // pra "🔬 🔬 PESQUISAS".
  const bare = stripEmojiPrefix(name);
  const adjusted = singularizeSectionName(bare, count);
  return sectionEmojiPrefix(adjusted) + adjusted;
}

// ---------------------------------------------------------------------------
// Fonte de verdade única das seções secundárias (#1737)
// ---------------------------------------------------------------------------
//
// Antes a lista nome → bucket → label e o regex de header estavam DUPLICADOS em
// 3 arquivos (lint-newsletter-md `SECTIONS` + `SECTION_ITEM_HEADER_RE`,
// singularize-md-sections `SECTION_HEADER_REGEX`, render-newsletter-html
// `SECTION_HEADER_RE`), com drift real entre eles:
//   - prefixo de emoji: lint/singularize usavam o range Unicode tight; render
//     usava o loose `[^\sA-Za-zÁ-ú]+` (casava dígitos/pontuação).
//   - `USE\s+MELHOR` (lint) vs `USE MELHOR` literal (singularize/render).
//   - `LAN[ÇC]AMENTOS?` (lint/render) vs `LANÇAMENTOS?` literal-Ç (singularize).
//   - item-header só plural vs section-header com `S?` opcional.
//
// Agora os 3 consumers importam daqui. Os patterns usam as formas mais
// LENIENTES (superset) — `[ÇC]`, `\s+`, `[ÍI]`, `S?` — pra casar tudo que
// qualquer consumer casava antes, nunca menos.

/** Bucket canônico de cada seção secundária (espelha o `Bucket` do lint). */
export type SectionBucket = "lancamento" | "radar" | "use_melhor" | "video";

export interface SectionDef {
  /**
   * Fragmento de regex (NÃO escapado de propósito — usa classes como `[ÇC]`)
   * que casa o nome da seção. Singular e plural via `S?`.
   */
  pattern: string;
  bucket: SectionBucket;
  /** Label canônico emitido em edições novas. */
  label: string;
  /**
   * true = alias legacy (PESQUISAS/OUTRAS NOTÍCIAS, substituídos por RADAR no
   * #1569) — mantido só pra re-lint / re-render de edições antigas.
   */
  legacy?: boolean;
}

export const SECTIONS: SectionDef[] = [
  { pattern: String.raw`LAN[ÇC]AMENTOS?`, bucket: "lancamento", label: "LANÇAMENTOS" },
  { pattern: String.raw`RADAR`, bucket: "radar", label: "RADAR" },
  { pattern: String.raw`USE\s+MELHOR`, bucket: "use_melhor", label: "USE MELHOR" },
  { pattern: String.raw`V[ÍI]DEOS?`, bucket: "video", label: "VÍDEOS" },
  { pattern: String.raw`PESQUISAS?`, bucket: "radar", label: "PESQUISAS", legacy: true },
  { pattern: String.raw`OUTRAS?\s+NOT[ÍI]CIAS?`, bucket: "radar", label: "OUTRAS NOTÍCIAS", legacy: true },
];

/**
 * Fragmento canônico do prefixo de emoji opcional. Primeiro char é um emoji do
 * range Unicode high (rejeita dígito/pontuação tipo "123 RADAR"), seguido de 0+
 * modificadores: variation selector U+FE0F (🛠️), ZWJ U+200D + skin-tone
 * U+1F3FB-1F3FF + mais emojis do range (sequências tipo 👨‍💻 / 🙋🏼‍♀️). Cobre os
 * emojis de seção (🚀 📡 🛠️ 📺 🔬 📰).
 *
 * #1836: enriquecido pro SUPERSET que newsletter-count / validate-section-structure
 * / render-erro-intencional já usavam — antes a versão da registry era tight
 * (só 1 FE0F), e os validadores aceitavam ZWJ/skin-tone, criando divergência
 * validador↔renderer. Agora todos importam daqui. Superset = byte-idêntico em
 * dado real (edições usam emoji single-codepoint, que casa ambos).
 *
 * Requer flag `u` no RegExp final (code points `\u{...}`).
 */
/**
 * #1836: emoji de seção OBRIGATÓRIO (sem o `(?:...)?` externo) — um codepoint
 * de emoji + zero-ou-mais modificadores + whitespace. Usado quando o header
 * SEMPRE tem emoji (ex: lint-test-email-structure no body do HTML renderizado,
 * onde o render sempre prefixa). `SECTION_EMOJI_PREFIX` é a versão opcional.
 */
export const SECTION_EMOJI = String.raw`[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}][\u{FE0F}\u{200D}\u{1F3FB}-\u{1F3FF}\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]*\s+`;
export const SECTION_EMOJI_PREFIX = `(?:${SECTION_EMOJI})?`;

/** Alternação de TODOS os patterns (incl. legacy) — pra item-header / boundary. */
export const ALL_SECTION_NAMES_PATTERN = SECTIONS.map((s) => s.pattern).join("|");

export interface SectionHeaderRegexOpts {
  /**
   * `**` ao redor do header: "optional" (`(?:\*\*)?` — lint/render aceitam
   * plain legacy + bold) | "required" (`\*\*` — singularize só mexe em bold).
   * Default "optional".
   */
  bold?: "optional" | "required";
  /**
   * Grupo de captura 1:
   *   "none"       → sem captura (lint URL×bucket só faz `.test()`).
   *   "name"       → grupo 1 = nome SEM emoji (render parseSections, item-header).
   *   "with-emoji" → grupo 1 = emoji prefix + nome (singularize → displaySectionName).
   * Default "none".
   */
  capture?: "none" | "name" | "with-emoji";
  /** Flags. Default "mu" (m: ^/$ multiline; u: obrigatório pros `\u{...}`). */
  flags?: string;
}

/**
 * Builder canônico do regex de header de seção (#1737): junta um pattern de
 * nome (um `SectionDef.pattern` ou `ALL_SECTION_NAMES_PATTERN`) com o
 * `SECTION_EMOJI_PREFIX`, com bold/captura/flags configuráveis pra cada
 * consumer manter sua semântica exata.
 *
 * Forma: `^{bold}{emoji+nome}{bold}\s*$`.
 */
export function sectionHeaderRegex(
  namePattern: string,
  opts: SectionHeaderRegexOpts = {},
): RegExp {
  const bold = opts.bold === "required" ? String.raw`\*\*` : String.raw`(?:\*\*)?`;
  const name = `(?:${namePattern})`;
  const inner =
    opts.capture === "with-emoji"
      ? `(${SECTION_EMOJI_PREFIX}${name})`
      : opts.capture === "name"
        ? `${SECTION_EMOJI_PREFIX}(${name})`
        : `${SECTION_EMOJI_PREFIX}${name}`;
  return new RegExp(String.raw`^${bold}${inner}${bold}\s*$`, opts.flags ?? "mu");
}
