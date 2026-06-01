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
 * esta regex. Aceita variation selector U+FE0F opcional após o emoji.
 */
export function stripEmojiPrefix(name: string): string {
  return name.replace(/^[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]️?\s+/u, "");
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
