/**
 * enrichment-state.ts (#4836 item 3)
 *
 * Campo derivado explícito pra distinguir os 3 estados que hoje colapsam em
 * `stats.clicks = []` no cache local de per-link clicks
 * (`data/beehiiv-cache/posts/{id}.json`):
 *
 *   - `never_enriched` — nenhuma tentativa de buscar per-link clicks via MCP
 *     ainda rodou pra este post (bootstrap novo, ou post velho de antes do
 *     enricher existir).
 *   - `enriched_zero`   — a tentativa RODOU (via `apply-mcp-clicks.ts`) e o
 *     resultado real é zero linhas per-link — dado confiável, é um zero
 *     genuíno, não ausência de dado.
 *   - `enriched_n`      — a tentativa rodou e trouxe N>0 linhas.
 *
 * Por que isso importa (motivação original da issue): sem este campo, os 3
 * casos são indistinguíveis olhando só `stats.clicks.length === 0` — e código
 * de agregação (ex: `build-link-ctr.ts`) que soma/tira média de cliques trata
 * `never_enriched` como "zero cliques medidos", quando na verdade é "não
 * sabemos". Isso inflava incompletude de enrichment como sinal de baixo CTR
 * genuíno em `context/audience-profile.md`/dashboards.
 *
 * Onde é populado:
 *   - `scripts/beehiiv-sync.ts` — todo write do cache carrega o campo
 *     adiante (preservando o estado anterior, como já fazia com
 *     `stats.clicks`) via `resolveEnrichmentState`. Post novo (sem cache
 *     anterior) nasce `never_enriched`.
 *   - `scripts/apply-mcp-clicks.ts` — toda invocação representa uma
 *     tentativa REAL de enrichment via MCP; o campo é sempre recalculado a
 *     partir do array final (`enriched_n` se não-vazio, `enriched_zero` se
 *     vazio).
 *
 * Onde é consumido: `scripts/build-link-ctr.ts` — links de posts
 * `never_enriched` não entram no resumo de CTR médio por categoria (dado
 * ausente, não zero) e `ctr_pct` fica em branco pro mesmo motivo que já vale
 * pra `unique_opens === 0` (denominador/numerador ausente ≠ taxa 0% medida).
 */

/** Os 3 estados possíveis — ver docstring do arquivo. */
export type EnrichmentState = "never_enriched" | "enriched_zero" | "enriched_n";

const VALID_STATES: readonly EnrichmentState[] = ["never_enriched", "enriched_zero", "enriched_n"];

/**
 * Pure: resolve o `EnrichmentState` efetivo de um post a partir do campo
 * persistido (`stored`, pode ser `undefined`/inválido — cache legado sem o
 * campo) e do tamanho ATUAL de `stats.clicks` (`clicksLength`).
 *
 * Regra: um valor persistido válido é confiável, EXCETO quando contradiz
 * diretamente o array real — nesse caso o array (fonte primária) vence sobre
 * o rótulo (que pode ter sido escrito por código antigo, ou ficado stale se
 * algo tocou `stats.clicks` sem atualizar o campo em paralelo):
 *   - `enriched_n` rotulado mas `clicksLength === 0` → não pode ter N>0
 *     clicado com array vazio; cai pra `never_enriched` (conservador — não
 *     inventa um "enriched_zero" que ninguém confirmou).
 *   - `never_enriched`/`enriched_zero` rotulado mas `clicksLength > 0` →
 *     tem dado real presente; sobe pra `enriched_n`, o array não mente.
 *
 * Sem campo persistido (cache legado, a maioria dos posts reais hoje): não
 * dá pra distinguir "nunca tentado" de "tentado e confirmado zero" só pelo
 * array vazio — assume-se `never_enriched` (conservador: subestimar
 * confiança é mais seguro que inflar zeros genuínos que nunca foram
 * verificados, que é exatamente o bug que este campo existe pra evitar).
 */
export function resolveEnrichmentState(stored: unknown, clicksLength: number): EnrichmentState {
  if (typeof stored === "string" && (VALID_STATES as readonly string[]).includes(stored)) {
    const state = stored as EnrichmentState;
    if (state === "enriched_n" && clicksLength === 0) return "never_enriched";
    if (state !== "enriched_n" && clicksLength > 0) return "enriched_n";
    return state;
  }
  return clicksLength > 0 ? "enriched_n" : "never_enriched";
}
