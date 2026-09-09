/**
 * scripts/lib/hub-editorial-gate.ts (#7101, #7103)
 *
 * Classifica o motivo pelo qual `renderHubPage`/`validateHubContent`
 * (`scripts/lib/shared/hub-page.ts`) recusa um `HubContent`, distinguindo
 * duas causas de natureza MUITO diferente que hoje chegam como o mesmo
 * `Error` genérico (uma lista de strings concatenada):
 *
 * 1. **Gate editorial esperado (#4911/#5124)** — `updatedDate` do hub está
 *    atrás da edição mais recente citada em `sourceEditions`. Isso NÃO é um
 *    bug: é o guard fazendo exatamente o que a issue #5124 pediu — forçar
 *    uma passada editorial (ler a(s) edição(ões) nova(s), decidir se abre
 *    seção/arco, bumpar `UPDATED_DATE` com uma nota) antes de qualquer
 *    regen de dataset virar página publicável. Precedente: PR #7258 fez
 *    exatamente essa passada pros 3 hubs. `generate-hub-sources.ts` sozinho
 *    SEMPRE dispara este estado — é o comportamento documentado no
 *    docstring de `UPDATED_DATE` em cada `scripts/lib/hubs/{slug}.ts`, não
 *    uma falha a corrigir no gerador.
 * 2. **Qualquer outra violação de `validateHubContent`** (FAQ fora de
 *    6-10, tabela com aridade errada, `sourceEditions` fora de ordem,
 *    prosa batendo `HUB_PROSE_RULES`, etc.) — isto SIM é um defeito real de
 *    conteúdo/código, não algo que uma passada editorial de "li a edição
 *    nova, decidi a seção, bumpei a data" resolve sozinha.
 *
 * A distinção interessa porque as DUAS coisas hoje produzem o mesmo
 * `throw` sem cor — um subagente/overnight vendo um stack trace genérico
 * não tem como saber, sem ler a issue #4911 inteira, se está diante do
 * gate esperado (ação: fazer a passada editorial, como #7258) ou de um bug
 * de verdade (ação: investigar/corrigir código). Achado ao vivo: o 1º
 * comentário de #7101 (03/09/2026) tratou o gate esperado como se fosse um
 * motivo pra reverter tudo — leitura defensável dado o stack trace cru,
 * mas que custou um ciclo inteiro.
 *
 * `classifyHubGateVerdict` é PURA (sem I/O) — não depende de
 * `data/beehiiv-cache` nem de nenhum junction OneDrive, então roda em
 * QUALQUER checkout (worktree isolado, sessão cloud, CI) só com o
 * conteúdo já commitado em `scripts/lib/hubs/*.ts`. Complementa (não
 * substitui) `scripts/hub-staleness-check.ts`, que SIM depende de
 * `data/beehiiv-cache/posts` pra saber se o DATASET está atrasado em
 * relação às edições publicadas — essa pergunta ("o dataset tem todas as
 * edições que deveria citar?") continua fora do alcance deste módulo, de
 * propósito: sem o cache Beehiiv não dá pra responder, e fingir que dá
 * seria precisamente o erro que a regra "nunca reportar saudável por não
 * ter conseguido verificar" proíbe.
 */
import { validateHubContent, type HubContent } from "./shared/hub-page.ts";

/**
 * Três estados possíveis pra um hub, além de `cannot-verify` (reservado pro
 * chamador quando nem `loadHubContent`/`validateHubContent` puderam rodar —
 * ex: exceção ao importar o módulo do hub, JSON do dataset corrompido).
 *
 * - `ok`: `validateHubContent` não encontrou nenhuma violação.
 * - `needs-editorial-review`: TODAS as violações encontradas são o guard
 *   de `updatedDate` atrás de `sourceEditions[0].date` (#4911/#5124) — ação
 *   esperada é uma passada editorial manual/agêntica (não um bug).
 * - `invalid`: existe ≥1 violação que NÃO é esse guard — defeito de
 *   conteúdo/código, não resolvido só por bumpar `UPDATED_DATE`.
 * - `cannot-verify`: reservado pro chamador (não produzido por
 *   `classifyHubGateVerdict` em si, que sempre recebe violações já
 *   calculadas) — ver docstring do módulo.
 */
export type HubEditorialGateVerdict = "ok" | "needs-editorial-review" | "invalid" | "cannot-verify";

export interface HubEditorialGateResult {
  slug: string;
  verdict: HubEditorialGateVerdict;
  violations: string[];
  /** Só presente quando `verdict === "cannot-verify"` — motivo da falha ao
   * tentar carregar/validar o hub (nunca confundido com uma violação real
   * de `validateHubContent`). */
  cannotVerifyReason?: string;
}

/**
 * Duas mensagens EXATAS, de DOIS validadores diferentes, que juntas formam
 * o mesmo gate editorial #4911/#5124 — duplicadas aqui de propósito (não
 * importadas) pra este módulo não travar o texto exato de `hub-page.ts`/
 * `hub-fact-gate.ts` como dependência silenciosa: se a mensagem mudar lá
 * sem atualizar aqui, `classifyHubGateVerdict` passa a tratar o guard como
 * `invalid` (fail-direction mais conservadora — nunca o contrário) até
 * alguém sincronizar os dois, e o teste de regressão
 * (`test/hub-editorial-gate.test.ts`) pega esse drift.
 *
 * 1. `validateHubContent` (`hub-page.ts`) — `updatedDate` atrás da edição
 *    mais recente em `sourceEditions[0]`.
 * 2. `checkNoFutureDates` (`hub-fact-gate.ts`, chamado DE DENTRO de
 *    `validateHubContent` via `checkHubFacts`) — qualquer data ABSOLUTA
 *    citada na prosa (intro/seções) que seja posterior a `updatedDate`.
 *    Achado ao vivo: é literalmente a 2ª linha do erro colado no 1º
 *    comentário de #7101 (`faq[0].answer: data posterior a updatedDate`) —
 *    MESMA causa raiz do guard 1 (dataset ganhou edição nova, `UPDATED_DATE`
 *    não avançou ainda), consequência mecânica dele: toda data nova citada
 *    na prosa devido à edição nova passa a ficar "no futuro" em relação ao
 *    `updatedDate` desatualizado. Tratar só o guard 1 e ignorar este deixaria
 *    o classificador cair em `invalid` (falso: pareceria bug de verdade)
 *    toda vez que a edição nova citada tivesse sua data também mencionada em
 *    prosa — exatamente o caso real de #7101.
 */
const EDITORIAL_REVIEW_GATE_PATTERNS: readonly RegExp[] = [
  /updatedDate ".*" é anterior à edição mais recente citada em sourceEditions/,
  /: data ".*" \(.*\) é posterior a updatedDate \(.*\)$/,
];

/** `true` se a violação é o guard #4911/#5124 (gate editorial esperado),
 * `false` para qualquer outra violação de `validateHubContent`. @pure */
export function isEditorialReviewGateViolation(violation: string): boolean {
  return EDITORIAL_REVIEW_GATE_PATTERNS.some((re) => re.test(violation));
}

/**
 * Classifica uma lista de violações já calculada por `validateHubContent`.
 * PURA — não chama `validateHubContent` sozinha (ver `checkHubEditorialGate`
 * abaixo pra isso), então é testável com qualquer lista de strings, sem
 * precisar de um `HubContent` real. @pure
 */
export function classifyHubGateVerdict(violations: readonly string[]): "ok" | "needs-editorial-review" | "invalid" {
  if (violations.length === 0) return "ok";
  return violations.every(isEditorialReviewGateViolation) ? "needs-editorial-review" : "invalid";
}

/**
 * Roda `validateHubContent` sobre `hub` e devolve o resultado classificado.
 * Não lança — mesmo se `hub` for malformado ao ponto de `validateHubContent`
 * lançar (não deveria, é `Pick`-safe sobre o tipo, mas nunca é demais
 * blindar um diagnóstico), devolve `cannot-verify` em vez de propagar.
 */
export function checkHubEditorialGate(slug: string, hub: HubContent): HubEditorialGateResult {
  let violations: string[];
  try {
    violations = validateHubContent(hub);
  } catch (e) {
    return {
      slug,
      verdict: "cannot-verify",
      violations: [],
      cannotVerifyReason: e instanceof Error ? e.message : String(e),
    };
  }
  return { slug, verdict: classifyHubGateVerdict(violations), violations };
}
