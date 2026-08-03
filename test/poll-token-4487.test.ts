/**
 * test/poll-token-4487.test.ts (#4487)
 *
 * Unidade pura de `scripts/lib/shared/poll-token.ts` — determinismo,
 * normalização de e-mail, forma do token, e o roundtrip
 * identidade→domínio→extração usado por `handleVote`.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  computePollToken,
  computePollTokenEmail,
  pollTokenKvKey,
  isValidPollTokenFormat,
  isPollTokenIdentity,
  extractPollToken,
  classifyPollTokenEmail,
  VOTE_TOKEN_DOMAIN,
  type PollToken,
} from "../scripts/lib/shared/poll-token.ts";

const SECRET = "s3cr3t";

describe("#4487 — computePollToken", () => {
  it("é determinístico — mesma entrada, mesma saída", async () => {
    const a = await computePollToken(SECRET, "leitor@example.com");
    const b = await computePollToken(SECRET, "leitor@example.com");
    assert.equal(a, b);
  });

  it("normaliza e-mail (lowercase + trim) antes do HMAC", async () => {
    const t1 = await computePollToken(SECRET, "Foo@Bar.com");
    const t2 = await computePollToken(SECRET, "foo@bar.com");
    const t3 = await computePollToken(SECRET, "  foo@bar.com  ");
    assert.equal(t1, t2);
    assert.equal(t2, t3);
  });

  it("secrets diferentes produzem tokens diferentes (não é reversível sem o secret certo)", async () => {
    const a = await computePollToken("secret-a", "leitor@example.com");
    const b = await computePollToken("secret-b", "leitor@example.com");
    assert.notEqual(a, b);
  });

  it("emails diferentes produzem tokens diferentes", async () => {
    const a = await computePollToken(SECRET, "a@example.com");
    const b = await computePollToken(SECRET, "b@example.com");
    assert.notEqual(a, b);
  });

  it("token bate o formato esperado (24 hex chars minúsculos)", async () => {
    const token = await computePollToken(SECRET, "leitor@example.com");
    assert.ok(isValidPollTokenFormat(token), `token "${token}" não bate o formato esperado`);
    assert.match(token, /^[0-9a-f]{24}$/);
  });
});

describe("#4487 — computePollTokenEmail / VOTE_TOKEN_DOMAIN", () => {
  it("monta o pseudo-email completo sob o domínio reservado", async () => {
    const tokenEmail = await computePollTokenEmail(SECRET, "leitor@example.com");
    assert.ok(tokenEmail.endsWith(`@${VOTE_TOKEN_DOMAIN}`));
    const [localPart] = tokenEmail.split("@");
    assert.ok(isValidPollTokenFormat(localPart));
  });

  it("VOTE_TOKEN_DOMAIN é distinto do domínio anônimo do brand web (#3976)", () => {
    assert.notEqual(VOTE_TOKEN_DOMAIN, "web.eia.diaria.local");
  });
});

describe("#4487 — pollTokenKvKey", () => {
  it("prefixa a chave KV de forma estável", () => {
    // #4518: pollTokenKvKey agora exige PollToken (branded), não string cru —
    // "abc123" não é um token de forma válida (24 hex chars), mas o teste é
    // sobre o PREFIXO da chave, não sobre validade de forma; cast explícito
    // é o jeito correto de expressar "finja que isto é um PollToken" num teste.
    assert.equal(pollTokenKvKey("abc123" as PollToken), "polltoken:abc123");
  });
});

describe("#4518 — classifyPollTokenEmail", () => {
  it("'not-token-domain' pra e-mail normal (fora do domínio reservado)", () => {
    assert.deepEqual(classifyPollTokenEmail("leitor@example.com"), { kind: "not-token-domain" });
  });

  it("'malformed' quando está sob o domínio certo mas o local-part não é hex válido", () => {
    assert.deepEqual(classifyPollTokenEmail(`nao-e-hex-valido@${VOTE_TOKEN_DOMAIN}`), { kind: "malformed" });
    assert.deepEqual(classifyPollTokenEmail(`abc@${VOTE_TOKEN_DOMAIN}`), { kind: "malformed" }, "curto demais");
  });

  it("'valid' com o token quando a forma bate", async () => {
    const token = await computePollToken(SECRET, "leitor@example.com");
    const tokenEmail = `${token}@${VOTE_TOKEN_DOMAIN}`;
    assert.deepEqual(classifyPollTokenEmail(tokenEmail), { kind: "valid", token });
  });

  it("consistente com extractPollToken/isPollTokenIdentity (mesmo par colapsado)", async () => {
    const token = await computePollToken(SECRET, "outro@example.com");
    const tokenEmail = `${token}@${VOTE_TOKEN_DOMAIN}`;
    const classification = classifyPollTokenEmail(tokenEmail);
    assert.equal(classification.kind, "valid");
    assert.equal(isPollTokenIdentity(tokenEmail), true);
    assert.equal(extractPollToken(tokenEmail), token);
  });
});

describe("#4487 — isPollTokenIdentity / extractPollToken", () => {
  it("identifica um pseudo-email sob o domínio reservado", async () => {
    const tokenEmail = await computePollTokenEmail(SECRET, "leitor@example.com");
    assert.equal(isPollTokenIdentity(tokenEmail), true);
    assert.equal(isPollTokenIdentity("leitor@example.com"), false);
  });

  it("é case-insensitive no domínio", () => {
    assert.equal(isPollTokenIdentity(`abc123@${VOTE_TOKEN_DOMAIN.toUpperCase()}`), true);
  });

  it("extractPollToken extrai o local-part quando a forma bate", async () => {
    const token = await computePollToken(SECRET, "leitor@example.com");
    const tokenEmail = `${token}@${VOTE_TOKEN_DOMAIN}`;
    assert.equal(extractPollToken(tokenEmail), token);
  });

  it("extractPollToken retorna null pra e-mail normal (fora do domínio reservado)", () => {
    assert.equal(extractPollToken("leitor@example.com"), null);
  });

  it("extractPollToken retorna null quando o local-part não bate a forma (token malformado sob o domínio certo)", () => {
    assert.equal(extractPollToken(`nao-e-hex-valido@${VOTE_TOKEN_DOMAIN}`), null);
    assert.equal(extractPollToken(`abc@${VOTE_TOKEN_DOMAIN}`), null, "curto demais");
  });

  it("extractPollToken retorna null pra string sem @", () => {
    assert.equal(extractPollToken("nao-e-email"), null);
  });
});
