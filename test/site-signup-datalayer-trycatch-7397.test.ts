/**
 * test/site-signup-datalayer-trycatch-7397.test.ts (#7397)
 *
 * O commit `cbb71c69` (fix #7358/#7361) adicionou
 * `dataLayer.push({event: 'signedUp', ...})` no sucesso de cadastro em várias
 * páginas, deliberadamente envolvido em `try { … } catch (e) {}`
 * (`pushSignupConversionEventJs()` em `scripts/lib/shared/seo-meta.ts`) —
 * sem o try/catch, uma falha de tracking (dataLayer congelado por extensão
 * de privacidade, script de terceiro hostil) pode lançar dentro do
 * `.then()` de sucesso, ser capturada pelo `.catch()` genérico do form
 * (escrito só pra erro de rede), e mostrar "Erro de conexão" ao usuário
 * mesmo com o cadastro tendo funcionado no servidor.
 *
 * `workers/site/public/index.html` e `workers/site/public/assinar/index.html`
 * já são gerados a partir de `buildIndexHtml()`/`buildAssinarHtml()`, que já
 * chamam `pushSignupConversionEventJs("email")` (com try/catch) — mas os 2
 * arquivos COMMITTED estavam desatualizados (gerados ANTES do #7358/#7361
 * adicionar o try/catch ao helper, e nunca re-regenerados), então carregavam
 * a versão antiga do snippet sem o try/catch. Fix: rerodar
 * `gen-home-page.ts`/`gen-assinar-page.ts`. Mesma classe de regressão que
 * `test/site-home-gtm-6977.test.ts` já cobre pra outro snippet (GTM) nos
 * mesmos 2 arquivos — este teste generaliza a checagem "committed reflete o
 * gerador" pro dataLayer.push de conversão.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { buildIndexHtml } from "../scripts/lib/site-home-page.ts";
import { buildAssinarHtml } from "../scripts/lib/site-assinar-page.ts";
import { pushSignupConversionEventJs } from "../scripts/lib/shared/seo-meta.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const EXPECTED_SNIPPET = pushSignupConversionEventJs("email");

/** `dataLayer.push` de `signedUp` fora de um `try { … }` — o bug do #7397. */
const BARE_PUSH_PATTERN =
  /(?<!try\s*\{\s*)window\.dataLayer\s*=\s*window\.dataLayer\s*\|\|\s*\[\];\s*window\.dataLayer\.push\(\s*\{\s*event:\s*"signedUp"/;

describe("pushSignupConversionEventJs() — try/catch (#7397)", () => {
  it("o snippet SEMPRE envolve o dataLayer.push em try/catch", () => {
    assert.match(EXPECTED_SNIPPET, /^try\s*\{.*\}\s*catch\s*\(e\)\s*\{\}$/);
    assert.match(EXPECTED_SNIPPET, /window\.dataLayer\.push\(\s*\{\s*event:\s*"signedUp"/);
  });
});

describe("buildIndexHtml()/buildAssinarHtml() — usam o helper com try/catch (#7397)", () => {
  it("home: emite o mesmo snippet byte-a-byte que pushSignupConversionEventJs('email') produz", () => {
    const html = buildIndexHtml({ feature: null, archive: [] });
    assert.ok(html.includes(EXPECTED_SNIPPET));
    assert.doesNotMatch(html, BARE_PUSH_PATTERN);
  });

  it("/assinar: emite o mesmo snippet byte-a-byte que pushSignupConversionEventJs('email') produz", () => {
    const html = buildAssinarHtml();
    assert.ok(html.includes(EXPECTED_SNIPPET));
    assert.doesNotMatch(html, BARE_PUSH_PATTERN);
  });
});

describe("workers/site/public/index.html e assinar/index.html — committed (#7397)", () => {
  const indexPath = resolve(ROOT, "workers", "site", "public", "index.html");
  const assinarPath = resolve(ROOT, "workers", "site", "public", "assinar", "index.html");

  it("os 2 arquivos existem", () => {
    assert.ok(existsSync(indexPath));
    assert.ok(existsSync(assinarPath));
  });

  it("index.html committed contém o dataLayer.push de signedUp DENTRO de try/catch (regressão: gerado antes do helper ganhar try/catch, nunca re-regenerado)", () => {
    const html = readFileSync(indexPath, "utf8");
    assert.ok(
      html.includes(EXPECTED_SNIPPET),
      "esperava o snippet exato de pushSignupConversionEventJs('email') — rerodar `npx tsx scripts/gen-home-page.ts` se isto falhar",
    );
    assert.doesNotMatch(html, BARE_PUSH_PATTERN);
  });

  it("assinar/index.html committed contém o dataLayer.push de signedUp DENTRO de try/catch (mesma regressão)", () => {
    const html = readFileSync(assinarPath, "utf8");
    assert.ok(
      html.includes(EXPECTED_SNIPPET),
      "esperava o snippet exato de pushSignupConversionEventJs('email') — rerodar `npx tsx scripts/gen-assinar-page.ts` se isto falhar",
    );
    assert.doesNotMatch(html, BARE_PUSH_PATTERN);
  });
});
