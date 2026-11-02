/**
 * newsletter-backend.ts (#7963, reduzido no #11225) — detecta artefato de
 * newsletter do backend errado numa lista de outputs de sentinel.
 *
 * O envio é só Kit desde o #11225: `publish-newsletter-kit.ts` escreve
 * `newsletter-kit-published.json`, e `05-published.json` é artefato de edição
 * antiga da Beehiiv, que nenhuma edição nova escreve. Achado que motivou o guard
 * (#7963, edição 260911): `_internal/.step-5-done.json` gravado citando
 * `05-published.json` — só o `assert` do Stage 6 percebia, já com publicação
 * real feita.
 */

const LEGACY_BEEHIIV_NEWSLETTER_OUTPUT = "05-published.json";

/**
 * Pure: filtra `outputs` (paths relativos ao editionDir, com ou sem prefixo de
 * diretório) pelos que citam o artefato legado. Compara por nome-base —
 * `"_internal/05-published.json"` e `"05-published.json"` casam igual.
 */
export function findWrongBackendNewsletterOutputs(outputs: string[]): string[] {
  return outputs.filter((o) => o.replace(/\\/g, "/").split("/").pop() === LEGACY_BEEHIIV_NEWSLETTER_OUTPUT);
}
