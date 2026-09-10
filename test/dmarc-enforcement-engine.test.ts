import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readCurrentDmarcPolicy } from "../scripts/dmarc-enforcement-engine.ts";

/** Fabrica um erro estilo `NodeJS.ErrnoException` com o `.code` dado — mesma
 *  forma que `dns.resolveTxt` lança de verdade (ver `node:dns` docs). */
function dnsError(code: string): NodeJS.ErrnoException {
  const e = new Error(`dns error: ${code}`) as NodeJS.ErrnoException;
  e.code = code;
  return e;
}

describe("readCurrentDmarcPolicy — distingue 'sem registro' de 'falha de leitura' (#7933, achado 2)", () => {
  it("ENODATA => policy null, raw null (legítimo: registro genuinamente ausente)", async () => {
    const result = await readCurrentDmarcPolicy("news.diar.ia.br", async () => {
      throw dnsError("ENODATA");
    });
    assert.deepEqual(result, { policy: null, raw: null });
  });

  it("ENOTFOUND => policy null, raw null (legítimo: registro genuinamente ausente)", async () => {
    const result = await readCurrentDmarcPolicy("news.diar.ia.br", async () => {
      throw dnsError("ENOTFOUND");
    });
    assert.deepEqual(result, { policy: null, raw: null });
  });

  it("ETIMEOUT => propaga (lança), nunca vira 'sem registro' silencioso", async () => {
    await assert.rejects(
      () =>
        readCurrentDmarcPolicy("news.diar.ia.br", async () => {
          throw dnsError("ETIMEOUT");
        }),
      /ETIMEOUT/,
    );
  });

  it("ECONNREFUSED (resolver fora do ar) => propaga (lança)", async () => {
    await assert.rejects(
      () =>
        readCurrentDmarcPolicy("news.diar.ia.br", async () => {
          throw dnsError("ECONNREFUSED");
        }),
      /ECONNREFUSED/,
    );
  });

  it("erro sem .code nenhum => propaga (lança), nunca trata como 'sem registro'", async () => {
    await assert.rejects(
      () =>
        readCurrentDmarcPolicy("news.diar.ia.br", async () => {
          throw new Error("algo genérico quebrou");
        }),
      /algo genérico quebrou/,
    );
  });

  it("resolução bem-sucedida com v=DMARC1;p=reject;... => parseia p= corretamente", async () => {
    const result = await readCurrentDmarcPolicy("news.diar.ia.br", async () => [
      ["v=DMARC1; p=reject; rua=mailto:x@y.com"],
    ]);
    assert.equal(result.policy, "reject");
  });
});
