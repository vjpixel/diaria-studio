/**
 * linkedin-api-version-12171.test.ts (#12171)
 *
 * O Worker pinava `LinkedIn-Version: 202401` (default de
 * `resolveLinkedInCreds` e `[vars]` do `wrangler.toml`). A LinkedIn mantém
 * cada versão ~1 ano, então o pin expira em silêncio e o primeiro carrossel
 * com o token da página (#8816) falharia como erro da API. Regressão:
 *   - sem LINKEDIN_API_VERSION, o default acompanha a data (2 meses atrás);
 *   - LINKEDIN_API_VERSION presente continua sobrescrevendo;
 *   - o `wrangler.toml` não volta a pinar a versão em `[vars]`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { resolveLinkedInCreds } from "../src/dispatch.ts";
import { defaultLinkedInApiVersion } from "../src/linkedin-api-version.ts";
import type { Env } from "../src/index.ts";

const HERE = dirname(fileURLToPath(import.meta.url));

function env(extra: Partial<Env>): Env {
  return { LINKEDIN_ACCESS_TOKEN: "tok", LINKEDIN_AUTHOR_URN: "urn:li:organization:1", ...extra } as unknown as Env;
}

describe("defaultLinkedInApiVersion (#12171)", () => {
  it("devolve o mês de 2 meses atrás, em YYYYMM", () => {
    assert.equal(defaultLinkedInApiVersion(new Date("2026-11-04T12:00:00Z")), "202609");
    assert.equal(defaultLinkedInApiVersion(new Date("2026-10-07T12:00:00Z")), "202608");
  });

  it("vira o ano em janeiro e fevereiro", () => {
    assert.equal(defaultLinkedInApiVersion(new Date("2027-01-15T12:00:00Z")), "202611");
    assert.equal(defaultLinkedInApiVersion(new Date("2027-02-28T23:59:59Z")), "202612");
  });

  it("usa UTC: 1º do mês às 00:30 UTC continua no mês UTC", () => {
    assert.equal(defaultLinkedInApiVersion(new Date("2027-03-01T00:30:00Z")), "202701");
  });
});

describe("resolveLinkedInCreds — apiVersion (#12171)", () => {
  const now = new Date("2026-11-04T12:00:00Z");

  it("sem LINKEDIN_API_VERSION usa o default dinâmico, nunca 202401", () => {
    const creds = resolveLinkedInCreds(env({}), now);
    assert.equal(creds?.apiVersion, "202609");
    assert.notEqual(creds?.apiVersion, "202401");
  });

  it("LINKEDIN_API_VERSION vazio ou só espaços cai no default dinâmico", () => {
    assert.equal(resolveLinkedInCreds(env({ LINKEDIN_API_VERSION: "" }), now)?.apiVersion, "202609");
    assert.equal(resolveLinkedInCreds(env({ LINKEDIN_API_VERSION: "   " }), now)?.apiVersion, "202609");
  });

  it("LINKEDIN_API_VERSION presente sobrescreve o default", () => {
    assert.equal(resolveLinkedInCreds(env({ LINKEDIN_API_VERSION: " 202605 " }), now)?.apiVersion, "202605");
  });

  it("sem token ou URN continua devolvendo undefined", () => {
    assert.equal(resolveLinkedInCreds({ LINKEDIN_AUTHOR_URN: "urn:li:organization:1" } as unknown as Env, now), undefined);
    assert.equal(resolveLinkedInCreds({ LINKEDIN_ACCESS_TOKEN: "tok" } as unknown as Env, now), undefined);
  });

  it("sem `now` explícito usa a data corrente (formato YYYYMM)", () => {
    assert.match(resolveLinkedInCreds(env({}))?.apiVersion ?? "", /^\d{6}$/);
  });
});

describe("wrangler.toml (#12171)", () => {
  it("não pina LINKEDIN_API_VERSION em [vars]", () => {
    const toml = readFileSync(resolve(HERE, "..", "wrangler.toml"), "utf8");
    const pinned = toml.split(/\r?\n/).filter((l) => /^\s*LINKEDIN_API_VERSION\s*=/.test(l));
    assert.deepEqual(pinned, [], `wrangler.toml voltou a pinar a versão: ${pinned.join(" | ")}`);
  });
});
