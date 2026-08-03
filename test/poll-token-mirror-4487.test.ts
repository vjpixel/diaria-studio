/**
 * test/poll-token-mirror-4487.test.ts (#4487, regressão #633)
 *
 * `workers/poll/src/poll-token.ts` é CÓPIA de `scripts/lib/shared/poll-token.ts`
 * — o bundle do Worker `poll` não alcança `scripts/**` (mesmo motivo/mecanismo
 * já em produção pra `session-cookie.ts`/`utm-registry.ts`, ver
 * `test/poll-shared-mirror-4054.test.ts`). Trava a divergência comportamental
 * entre o espelho e a fonte — editar um lado sem o outro quebra o CI.
 *
 * Comparação por COMPORTAMENTO (as funções são assíncronas/usam crypto.subtle),
 * não por referência de função.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import * as shared from "../scripts/lib/shared/poll-token.ts";
import * as mirror from "../workers/poll/src/poll-token.ts";

describe("#4487 — espelho de poll-token.ts não pode driftar", () => {
  it("VOTE_TOKEN_DOMAIN idêntico entre shared/ e o espelho", () => {
    assert.equal(mirror.VOTE_TOKEN_DOMAIN, shared.VOTE_TOKEN_DOMAIN);
  });

  it("computePollToken produz o MESMO token pros dois lados (mesmo secret/email)", async () => {
    const sharedToken = await shared.computePollToken("s3cr3t", "leitor@example.com");
    const mirrorToken = await mirror.computePollToken("s3cr3t", "leitor@example.com");
    assert.equal(mirrorToken, sharedToken, "token deve ser byte-idêntico entre shared/ e o espelho");
  });

  it("computePollTokenEmail idêntico pros dois lados", async () => {
    const sharedEmail = await shared.computePollTokenEmail("s3cr3t", "leitor@example.com");
    const mirrorEmail = await mirror.computePollTokenEmail("s3cr3t", "leitor@example.com");
    assert.equal(mirrorEmail, sharedEmail);
  });

  it("pollTokenKvKey / isValidPollTokenFormat / isPollTokenIdentity / extractPollToken — mesma saída pros dois lados", async () => {
    assert.equal(mirror.pollTokenKvKey("abc"), shared.pollTokenKvKey("abc"));
    const token = await shared.computePollToken("s3cr3t", "leitor@example.com");
    assert.equal(mirror.isValidPollTokenFormat(token), shared.isValidPollTokenFormat(token));
    const tokenEmail = `${token}@${shared.VOTE_TOKEN_DOMAIN}`;
    assert.equal(mirror.isPollTokenIdentity(tokenEmail), shared.isPollTokenIdentity(tokenEmail));
    assert.equal(mirror.extractPollToken(tokenEmail), shared.extractPollToken(tokenEmail));
  });

  it("cross-implementação: token gerado pelo shared é reconhecido/extraído pelo espelho e vice-versa", async () => {
    const bySh = await shared.computePollTokenEmail("cross", "a@b.com");
    const byMi = await mirror.computePollTokenEmail("cross", "a@b.com");
    assert.equal(byMi, bySh);
    assert.equal(mirror.extractPollToken(bySh), shared.extractPollToken(byMi));
  });

  it("o espelho não exporta nada que o shared não tenha (cópia só de valores/funções)", () => {
    const extra = Object.keys(mirror).filter((k) => !(k in shared));
    assert.deepEqual(extra, [], `espelho tem export órfão: ${extra.join(", ")}`);
  });
});
