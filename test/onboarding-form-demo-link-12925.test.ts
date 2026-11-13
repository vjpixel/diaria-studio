/**
 * test/onboarding-form-demo-link-12925.test.ts (#12925)
 *
 * Link de demonstração do formulário (formulario.diar.ia.br): o link impresso
 * por `scripts/onboarding-form-demo-link.ts` tem que passar na MESMA
 * verificação que o Worker faz (`prefillEmailFromQuery` + `checkFormEmailSig`),
 * inclusive com o `+` do endereço de demonstração; e o que a pessoa de fora
 * digitar com esse endereço não entra no perfil de audiência.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildDemoFormLink, demoFormEmail } from "../scripts/onboarding-form-demo-link.ts";
import { checkFormEmailSig } from "../scripts/lib/onboarding-form-link-sig.ts";
import { prefillEmailFromQuery, type FormDraft, type FormResponse } from "../scripts/lib/onboarding-form-contract.ts";
import { isFormTestEmail } from "../scripts/lib/onboarding-form-partial-results.ts";
import { loadOnboardingFormSurveyResponses } from "../scripts/audience-run.ts";

const SECRET = "s".repeat(40);
const DEMO_FORM_EMAIL = demoFormEmail(new Date("2026-11-13T22:05:09Z"));
const FORM_URL = "https://formulario.diar.ia.br/";

/** Reproduz o GET do Worker (`workers/onboarding-form/src/index.ts`). */
async function workerAccepts(url: string): Promise<boolean> {
  const u = new URL(url);
  const email = prefillEmailFromQuery(u.searchParams.get("email"));
  return (await checkFormEmailSig(email, u.searchParams.get("sig") ?? "", SECRET)).ok;
}

describe("onboarding-form-demo-link (#12925)", () => {
  it("o endereço padrão é de teste do editor (fica fora dos resultados) e muda a cada execução", () => {
    assert.ok(DEMO_FORM_EMAIL.includes("+formulario-demo-20261113220509@"));
    assert.ok(isFormTestEmail(DEMO_FORM_EMAIL));
    // Sufixo fixo faria a 2ª pessoa ver o rascunho da 1ª (o Worker retoma o rascunho, #12504).
    assert.notEqual(demoFormEmail(new Date("2026-11-13T22:05:10Z")), DEMO_FORM_EMAIL);
  });

  it("o link padrão passa na verificação do Worker, com o + preservado", async () => {
    const r = await buildDemoFormLink(FORM_URL, SECRET);
    assert.ok(r.ok);
    assert.ok(isFormTestEmail(r.email));
    assert.match(r.email, /\+formulario-demo-\d{14}@/);
    assert.ok(r.url.startsWith(`${FORM_URL}?email=`));
    assert.ok(r.url.includes("%2B"), "o + vai codificado, não vira espaço");
    assert.ok(await workerAccepts(r.url));
    assert.equal(r.avisos.length, 1, "só o aviso de que o link grava rascunho/envio");
  });

  it("e-mail cru com + também passa (o Worker troca espaço por +)", async () => {
    const r = await buildDemoFormLink(FORM_URL, SECRET, DEMO_FORM_EMAIL);
    assert.ok(r.ok);
    assert.equal(r.email, DEMO_FORM_EMAIL);
    const raw = r.url.replace("%2B", "+");
    assert.ok(await workerAccepts(raw));
  });

  it("segredo diferente do Worker não passa", async () => {
    const r = await buildDemoFormLink(FORM_URL, "t".repeat(40));
    assert.ok(r.ok);
    assert.equal(await workerAccepts(r.url), false);
  });

  it("form_url com query usa &", async () => {
    const r = await buildDemoFormLink("https://formulario.diar.ia.br/?x=1", SECRET);
    assert.ok(r.ok);
    assert.match(r.url, /\?x=1&email=/);
  });

  it("segredo ausente/curto e form_url ausente falham sem link", async () => {
    for (const [url, secret] of [
      [FORM_URL, undefined],
      [FORM_URL, "curto"],
      [null, SECRET],
    ] as const) {
      const r = await buildDemoFormLink(url, secret);
      assert.equal(r.ok, false);
    }
  });

  it("e-mail inválido falha; e-mail que não é de teste gera aviso", async () => {
    assert.equal((await buildDemoFormLink(FORM_URL, SECRET, "sem-arroba")).ok, false);
    const r = await buildDemoFormLink(FORM_URL, SECRET, "Alguem@Exemplo.com");
    assert.ok(r.ok);
    assert.equal(r.email, "alguem@exemplo.com");
    assert.equal(r.avisos.length, 2);
    assert.ok(await workerAccepts(r.url));
  });

  it("resposta e rascunho do endereço de demonstração ficam fora do perfil de audiência", async () => {
    const real: FormResponse = { email: "leitor@x.com", submitted_at: "2026-11-08T12:00:00Z", answers: { area: "Engenharia" } };
    const demo: FormResponse = { email: DEMO_FORM_EMAIL, submitted_at: "2026-11-08T12:00:00Z", answers: { area: "Vendas ou atendimento" } };
    const demoDraft: FormDraft = {
      email: DEMO_FORM_EMAIL.toUpperCase(),
      answers: { area: "RH ou gestão de pessoas" },
      updated_at: "2026-11-08T12:00:00Z",
      last_question: "area",
      form_version: 3,
    };
    const out = await loadOnboardingFormSurveyResponses({}, async () => [real, demo], async () => [demoDraft]);
    assert.equal(out.length, 1);
    assert.ok(!JSON.stringify(out).includes("Vendas"));
    assert.ok(!JSON.stringify(out).includes("RH ou"));
  });
});
