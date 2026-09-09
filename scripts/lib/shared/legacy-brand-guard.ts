/**
 * scripts/lib/shared/legacy-brand-guard.ts (#7719)
 *
 * Guard de marca legada no CAMINHO DE PUBLICAÇÃO — gêmeo do guard estático de
 * `test/reader-facing-no-legacy-brand-4424.test.ts`, mas para conteúdo que só
 * existe fora do repo (`data/monthly/{ciclo}/draft.md`, `data/anual/**` —
 * gitignored, junction OneDrive). O guard estático varre uma LISTA CURADA DE
 * ARQUIVOS DO REPO e não tem como enxergar esse conteúdo: `git grep` nunca
 * vê o que nunca foi commitado. O sintoma real (#7719): o `<title>` de
 * `retrospectiva.diar.ia.br/2607` saiu "Diar.ia | Julho 2026 — ..." — texto
 * que nasce em `data/monthly/2607-08/draft.md`, propagado sem checagem pelo
 * render (`draftToEmail` → `wrapEmail`) até o KV que o Worker serve cru.
 *
 * Por isso este guard não vive numa varredura de arquivos: vive nos dois
 * publishers que de fato produzem o HTML público a partir de dado externo —
 * `scripts/lib/mensal/build-article-page.ts` (`buildArticleHtml`) e
 * `scripts/lib/anual/build-annual-page.ts` (`buildAnnualHtml`) — aplicado ao
 * HTML final, DEPOIS de todo o render (cobre título E corpo com uma chamada
 * só, já que o `<title>` mensal é `escHtml(subject)` embutido no mesmo HTML).
 *
 * Três estados, nunca dois binário ok/found — a classe de defeito desta
 * rodada overnight (#7776) é o sistema deixar de OLHAR e isso silenciosamente
 * contar como "passou": fonte ausente, vazia ou ilegível é tratada IGUAL a
 * "achou a marca errada", nunca como "ok" por omissão.
 */

export const LEGACY_BRAND_RE = /Diar\.ia/;

export type LegacyBrandCheckResult =
  | { status: "ok" }
  | { status: "legacy-brand-found"; matches: string[] }
  | { status: "cannot-verify"; reason: string };

/**
 * Checa um texto (título, HTML, subject...) contra a grafia legada da marca.
 *
 * `text` nulo/indefinido/vazio nunca vira "ok" — vira "cannot-verify": não dá
 * pra afirmar que um texto que não foi lido está correto.
 */
export function checkLegacyBrand(text: string | null | undefined): LegacyBrandCheckResult {
  if (text === null || text === undefined) {
    return { status: "cannot-verify", reason: "texto ausente (null/undefined)" };
  }
  if (text.trim().length === 0) {
    return { status: "cannot-verify", reason: "texto vazio" };
  }
  const matches = [...new Set(text.match(new RegExp(LEGACY_BRAND_RE, "g")) ?? [])];
  if (matches.length > 0) {
    return { status: "legacy-brand-found", matches };
  }
  return { status: "ok" };
}

/**
 * Lança se o resultado não for "ok". `legacy-brand-found` e `cannot-verify`
 * são tratados IGUAL — os dois recusam a publicação — porque a regra desta
 * rodada é "nunca passar verde sem ter conseguido olhar", não só "nunca
 * passar verde tendo visto a marca errada".
 */
export function assertNoLegacyBrand(result: LegacyBrandCheckResult, context: string): void {
  if (result.status === "ok") return;
  if (result.status === "legacy-brand-found") {
    throw new Error(
      `${context}: marca legada "Diar.ia" encontrada (${result.matches.join(", ")}) — use "diar.ia.br", nunca "Diar.ia".`,
    );
  }
  throw new Error(
    `${context}: guard de marca legada não conseguiu verificar (${result.reason}) — recusando publicar em vez de assumir "ok".`,
  );
}
