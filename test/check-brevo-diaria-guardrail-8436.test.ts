/**
 * test/check-brevo-diaria-guardrail-8436.test.ts (#8436)
 *
 * Medido ao vivo (19/09/2026): `brevo_diaria.test_email` (vjpixel@gmail.com)
 * ficou `emailBlacklisted: true` na conta Brevo da diária — `sendTest`
 * passou a falhar 400 ("Test emails cannot be sent to non-existent/
 * blacklisted/without-contact-list users") e a sonda de inbox placement do
 * Gmail pessoal (`EDITOR_SEED_EMAILS`) parou de receber a campanha, sem
 * nenhum sinal no código.
 *
 * Cobre a parte MECÂNICA do guard sugerido pela issue (`checkSeedEmailsBlacklisted`/
 * `describeSeedBlacklistFailures` em `scripts/lib/brevo-diaria-guardrail.ts`):
 * um seed com `emailBlacklisted: true` (ou 404, contato ausente) precisa
 * falhar ALTO e nomear qual email — nunca um warning silencioso.
 *
 * A decisão de fundo (trocar o seed vs remover o blacklist na Brevo) é
 * editorial e fica fora do escopo deste teste/PR (ver #8436).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifySeedContactStatus,
  checkSeedEmailsBlacklisted,
  describeSeedBlacklistFailures,
  type SeedBlacklistCheckResult,
} from "../scripts/lib/brevo-diaria-guardrail.ts";

test("classifySeedContactStatus — emailBlacklisted:true classifica como 'blacklisted'", () => {
  assert.equal(classifySeedContactStatus(200, { emailBlacklisted: true }), "blacklisted");
});

test("classifySeedContactStatus — emailBlacklisted:false/ausente classifica como 'ok'", () => {
  assert.equal(classifySeedContactStatus(200, { emailBlacklisted: false }), "ok");
  assert.equal(classifySeedContactStatus(200, {}), "ok");
});

test("classifySeedContactStatus — 404 classifica como 'not_found' (contato ausente da conta)", () => {
  assert.equal(classifySeedContactStatus(404, {}), "not_found");
});

test("checkSeedEmailsBlacklisted — reproduz o achado ao vivo da #8436: test_email blacklisted, seed workspace ok", async () => {
  const calls: string[] = [];
  const fetchContact = async (email: string) => {
    calls.push(email);
    if (email === "vjpixel@gmail.com") {
      return { status: 200, body: { listIds: [2, 7, 4], emailBlacklisted: true } };
    }
    return { status: 200, body: { listIds: [2], emailBlacklisted: false } };
  };

  const results = await checkSeedEmailsBlacklisted(
    ["vjpixel@gmail.com", "pixel@memelab.com.br"],
    fetchContact,
  );

  assert.deepEqual(calls, ["vjpixel@gmail.com", "pixel@memelab.com.br"]);
  assert.deepEqual(results, [
    { email: "vjpixel@gmail.com", status: "blacklisted" },
    { email: "pixel@memelab.com.br", status: "ok" },
  ]);
});

test("describeSeedBlacklistFailures — mensagem nomeia o email blacklisted, some quando tudo ok", () => {
  const mixed: SeedBlacklistCheckResult[] = [
    { email: "vjpixel@gmail.com", status: "blacklisted" },
    { email: "pixel@memelab.com.br", status: "ok" },
  ];
  const failures = describeSeedBlacklistFailures(mixed);
  assert.equal(failures.length, 1);
  assert.match(failures[0], /vjpixel@gmail\.com/);
  assert.match(failures[0], /emailBlacklisted/);

  const allOk: SeedBlacklistCheckResult[] = [{ email: "pixel@memelab.com.br", status: "ok" }];
  assert.deepEqual(describeSeedBlacklistFailures(allOk), []);
});

test("describeSeedBlacklistFailures — seed ausente da conta (404) também é falha nomeada", () => {
  const notFound: SeedBlacklistCheckResult[] = [{ email: "sumiu@example.com", status: "not_found" }];
  const failures = describeSeedBlacklistFailures(notFound);
  assert.equal(failures.length, 1);
  assert.match(failures[0], /sumiu@example\.com/);
  assert.match(failures[0], /não existe como contato/);
});
