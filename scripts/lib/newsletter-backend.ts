/**
 * newsletter-backend.ts (#7963) — helper compartilhado pra código que precisa
 * saber qual backend de newsletter está ativo (`platform.config.json` →
 * `publishing.newsletter.backend`) e detectar artefato do backend ERRADO
 * grudado numa lista de outputs de sentinel/assert.
 *
 * `loadNewsletterBackend()` já existia duplicado (sem exportar) em
 * `scripts/lib/invariant-checks/stage-5.ts` e `stage-6.ts` (#464) — aqueles
 * dois arquivos mantêm suas cópias locais (com seam `backendOverride` pra
 * teste, já usadas por `test/check-invariants-stage-6.test.ts` e
 * `test/consent-binding-invariant.test.ts`) intocadas por escopo do #7963,
 * pra não arriscar quebrar cobertura existente numa unidade de bugfix. Este
 * módulo é a versão nova, consumida só pelo guard de
 * `scripts/pipeline-sentinel.ts write` (Stage 5/6) — ver `findWrongBackendNewsletterOutputs`.
 *
 * Achado que motivou (#7963, edição 260911): `_internal/.step-5-done.json`
 * foi gravado com `outputs: ["05-published.json", ...]` numa edição com
 * `backend: "kit"` — artefato que esse backend NUNCA escreve (quem escreve é
 * `publish-newsletter-kit.ts` → `newsletter-kit-published.json`). O playbook
 * (`.claude/agents/orchestrator-stage-5.md` §5h) já tinha o branch por
 * backend em prosa desde o #6096/#464, mas nada MECÂNICO impedia uma sessão
 * de copiar o exemplo genérico errado — só o `assert` do Stage 6, já tarde
 * demais (edição inteira travada com publicação real já feita).
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

export type NewsletterBackend = "beehiiv" | "kit";

/**
 * Lê `publishing.newsletter.backend` de `platform.config.json`. Default
 * `"beehiiv"` — config ausente, chave ausente, ou qualquer valor que não
 * seja literalmente `"kit"` (mesmo fallback de `loadNewsletterBackend` em
 * `invariant-checks/stage-5.ts`/`stage-6.ts`).
 *
 * `configPathOverride` existe só pra teste — produção sempre lê o
 * `platform.config.json` real do repo (resolvido por posição do arquivo,
 * não por `cwd`, pra funcionar igual não importa de onde o processo Node
 * foi iniciado).
 */
export function loadNewsletterBackend(configPathOverride?: string): NewsletterBackend {
  const configPath = configPathOverride ?? resolve(ROOT, "platform.config.json");
  if (!existsSync(configPath)) return "beehiiv";
  try {
    const cfg = JSON.parse(readFileSync(configPath, "utf8")) as {
      publishing?: { newsletter?: { backend?: string } };
    };
    return cfg.publishing?.newsletter?.backend === "kit" ? "kit" : "beehiiv";
  } catch {
    return "beehiiv";
  }
}

/**
 * Nome-base do artefato de newsletter que o backend OPOSTO produz — se
 * aparecer na lista de `outputs` gravada pro backend ATUAL, é sinal de lista
 * copiada do exemplo/branch errado (#7963).
 */
const WRONG_BACKEND_NEWSLETTER_OUTPUT: Record<NewsletterBackend, string> = {
  beehiiv: "newsletter-kit-published.json",
  kit: "05-published.json",
};

/**
 * Pure: filtra `outputs` (paths relativos ao editionDir, com ou sem prefixo
 * de diretório) pelos que citam o artefato de newsletter do backend ERRADO
 * pra `backend`. Compara por nome-base (`basename`), não pelo path inteiro —
 * `"_internal/05-published.json"` e `"05-published.json"` casam igual.
 */
export function findWrongBackendNewsletterOutputs(
  outputs: string[],
  backend: NewsletterBackend,
): string[] {
  const wrongBasename = WRONG_BACKEND_NEWSLETTER_OUTPUT[backend];
  return outputs.filter((o) => o.replace(/\\/g, "/").split("/").pop() === wrongBasename);
}
