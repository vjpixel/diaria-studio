/**
 * test/site-worker-html-handling-467.test.ts (#467, regressão #633)
 *
 * Cobre `workers/site/wrangler.toml` — config de deploy do Worker
 * `diaria-site` — em vez de `scripts/lib/site-archive-pages.ts` (lógica
 * pura de gerador, escopo de `test/gen-archive-pages.test.ts`). Arquivo
 * dedicado porque este teste abre disco fora de `scripts/`, mesma convenção
 * do repo pra guard de config de Worker (ver `test/worker-drift-check.test.ts`,
 * `test/artigos-robots-txt-4777.test.ts`, `test/cursos-worker-first.test.ts`).
 *
 * Achado ao vivo 26/08/2026: sem `html_handling` explícito, o default do
 * Cloudflare Workers Assets ("auto-trailing-slash") canonicaliza
 * `public/p/{slug}/index.html` pra forma COM barra — `/p/{slug}` responde
 * 307 -> `/p/{slug}/`. Isso contradiz o `<link rel="canonical">` sem barra
 * que `archiveUrlForSlug`/`buildArchivePageHtml`
 * (`scripts/lib/site-archive-pages.ts`) já gravam em cada página, as 258
 * URLs já indexadas pelo Google, e as ~1.950 referências sem barra no repo.
 *
 * Achado do fleet review (#467, mesmo dia): a 1ª versão deste teste usava
 * `toml.indexOf("html_handling")` solto no arquivo INTEIRO pra checar que a
 * diretiva vinha "depois de `[assets]`" — isso casa a PRIMEIRA ocorrência
 * da substring, inclusive dentro do comentário explicativo que também
 * contém a palavra "html_handling" ANTES da atribuição real. Demonstrado
 * empiricamente que esse teste passava verde mesmo com a atribuição movida
 * pra uma seção `[build]` posterior — regressão real (a diretiva passa a
 * pertencer a outra seção, o Cloudflare volta ao default
 * `auto-trailing-slash`, o 307 reaparece) que o teste não pegava. Corrigido
 * dividindo o arquivo em blocos de seção de verdade (mesmo idioma de
 * `parseWranglerTomlCustomDomainHosts` em `scripts/lib/worker-public-hosts.ts`:
 * `tomlContent.split(/(?=^\s*\[)/m)`) e checando a ATRIBUIÇÃO ancorada
 * (`^\s*html_handling\s*=`, não a substring) só dentro do bloco `[assets]`.
 * Não importamos a função de lá porque ela é específica de
 * `[[routes]] custom_domain = true` — o bloco procurado aqui é `[assets]`
 * (seção simples, não array-of-tables) e a checagem é de uma chave
 * `html_handling`, não de `pattern`; copiamos só o idioma do split.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WRANGLER_PATH = resolve(ROOT, "workers", "site", "wrangler.toml");

/**
 * Mesmo idioma de `parseWranglerTomlCustomDomainHosts`
 * (`scripts/lib/worker-public-hosts.ts`): corta o TOML em blocos reais de
 * seção no próximo header `[` (de qualquer tipo — `[assets]`, `[vars]`,
 * `[[migrations]]`, ...), não só no header que se está procurando. Isso é
 * o que faz o teste abaixo detectar corretamente quando `html_handling`
 * migra pra fora do bloco `[assets]`.
 */
function findSectionBlock(tomlContent: string, headerRe: RegExp): string | undefined {
  return tomlContent.split(/(?=^\s*\[)/m).find((block) => headerRe.test(block));
}

describe("workers/site/wrangler.toml — html_handling coerente com a canonical sem barra (#467)", () => {
  it("declara html_handling = drop-trailing-slash dentro do bloco [assets]", () => {
    const toml = readFileSync(WRANGLER_PATH, "utf8");
    const assetsBlock = findSectionBlock(toml, /^\s*\[assets\]/);
    assert.ok(assetsBlock, "[assets] ausente em workers/site/wrangler.toml");
    // "drop-trailing-slash" é o único valor (dos 4 documentados pela
    // Cloudflare: auto-trailing-slash/force-trailing-slash/
    // drop-trailing-slash/none — https://developers.cloudflare.com/workers/static-assets/routing/static-site-generation/)
    // que serve `/p/{slug}` sem barra 200 direto e redireciona `/p/{slug}/`
    // de volta pra forma sem barra — coerente com a canonical sem barra.
    // Âncora `^\s*` (não `indexOf` solto) garante que é a ATRIBUIÇÃO real,
    // não a palavra aparecendo dentro do comentário explicativo acima dela.
    assert.match(
      assetsBlock!,
      /^\s*html_handling\s*=\s*"drop-trailing-slash"/m,
      "html_handling ausente, comentado, ou com valor diferente de drop-trailing-slash dentro de [assets]",
    );
  });

  it("a mesma checagem REJEITA a diretiva se ela estiver fora do bloco [assets] (prova de que o teste acima pega a regressão real)", () => {
    // Simula o cenário do fleet review sem escrever em disco: injeta uma
    // seção [build] fictícia ENTRE [assets] e a diretiva, empurrando
    // html_handling pra fora do bloco [assets] — o mesmo formato que
    // passava verde na versão anterior deste teste (indexOf solto).
    const toml = readFileSync(WRANGLER_PATH, "utf8");
    const original = findSectionBlock(toml, /^\s*\[assets\]/);
    assert.ok(original, "[assets] ausente em workers/site/wrangler.toml");
    const migrated = original!.replace(
      /(\[assets\]\s*\n(?:.*\n)*?directory\s*=\s*"[^"]*"\s*\n)([\s\S]*)/,
      "$1[build]\n$2",
    );
    assert.notEqual(migrated, original, "fixture não moveu html_handling pra fora de [assets] — regex de setup desatualizada");
    const migratedAssetsOnly = migrated.split(/(?=^\s*\[)/m)[0];
    assert.doesNotMatch(
      migratedAssetsOnly,
      /^\s*html_handling\s*=\s*"drop-trailing-slash"/m,
      "a fixture deveria ter movido html_handling pra fora do bloco [assets]",
    );
  });
});
