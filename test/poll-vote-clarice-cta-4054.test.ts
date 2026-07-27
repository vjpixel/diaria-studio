/**
 * test/poll-vote-clarice-cta-4054.test.ts (#4054)
 *
 * Gap remanescente da issue #4054: a página de resultado do `/vote` para o
 * brand `clarice` (audiência da Clarice News, não assinante da Diar.ia)
 * precisa de um CTA de cadastro na Diar.ia — com UTM PRÓPRIO pra medir
 * separado do CTA/link do parceiro (`clarice.ai/?via=diaria`, afiliado
 * Rewardful #1910) — sem NUNCA substituir esse link do parceiro (a entrega
 * da parceria, medida pelo #4048).
 *
 * O núcleo desse gap já tinha sido entregue pelo #4065 (cadastro inline
 * `renderInlineSignupFormBlock`/`inlineSignupScript("vote-clarice")`, com UTM
 * próprio via `VOTE_CLARICE_INLINE_UTM`, ver utm-registry.ts e subscribe.ts) —
 * este arquivo formaliza o invariante das DUAS cautelas da issue: o CTA
 * aparece AO LADO do link do parceiro (nunca no lugar dele), e os dois são
 * medíveis separadamente (UTMs distintos).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import worker, { type Env } from "../workers/poll/src/index.ts";

function makeMapKV(initial: Record<string, string> = {}) {
  const m = new Map<string, string>(Object.entries(initial));
  return {
    async get(key: string) {
      const v = m.get(key);
      return v === undefined ? null : v;
    },
    async getWithMetadata(key: string) {
      const v = m.get(key);
      return { value: v ?? null, metadata: null };
    },
    async put(key: string, value: string) {
      m.set(key, value);
    },
    async delete(key: string) {
      m.delete(key);
    },
    async list({ prefix = "" }: { prefix?: string; cursor?: string } = {}) {
      const keys = [...m.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name }));
      return { keys, list_complete: true, cursor: undefined };
    },
  };
}

const makeEnv = (overrides: Partial<Env> = {}): Env => ({
  POLL: makeMapKV() as unknown as KVNamespace,
  POLL_SECRET: "poll-secret",
  ADMIN_SECRET: "admin-secret",
  ALLOWED_ORIGINS: "*",
  ...overrides,
});

function voteReq(brand: string | null, email: string, choice: string, edition = "260724") {
  const b = brand ? `&brand=${brand}` : "";
  return new Request(`https://poll.test/vote?email=${encodeURIComponent(email)}&edition=${edition}&choice=${choice}${b}`);
}

describe("#4054: brand clarice — CTA de cadastro na Diar.ia CONVIVE com o link do parceiro (clarice.ai), nunca o substitui", () => {
  it("brand=clarice: CTA de cadastro (source=vote-clarice, UTM próprio) E o link de saída pro parceiro (clarice.ai/?via=diaria) aparecem NA MESMA resposta", async () => {
    const env = makeEnv();
    const res = await worker.fetch(voteReq("clarice", "leitor@example.com", "A"), env);
    assert.equal(res.status, 200);
    const html = await res.text();

    // O CTA de cadastro na Diar.ia (#4065/#4054) — UTM próprio (source distinto
    // do funil "eia-standalone" do jogo público, ver subscribe.ts).
    assert.match(html, /id="jogar-signup-form"/, "CTA de cadastro deve estar presente");
    assert.match(html, /source: "vote-clarice"/, "CTA deve carregar o UTM próprio vote-clarice");

    // O link de saída pro parceiro (clarice.ai/?via=diaria) — a entrega da
    // parceria, medida pelo #4048. NUNCA pode desaparecer quando o CTA entra.
    assert.match(html, /href="https:\/\/clarice\.ai\/\?via=diaria[^"]*"/, "link do parceiro (clarice.ai) deve continuar presente ao lado do CTA");
  });

  it("brand=diaria: NÃO renderiza o CTA vote-clarice (regressão — assinante não precisa reoferecer cadastro)", async () => {
    const env = makeEnv();
    const res = await worker.fetch(voteReq(null, "leitor@example.com", "B"), env);
    const html = await res.text();
    assert.doesNotMatch(html, /source: "vote-clarice"/);
  });

  it("brand=web: NÃO renderiza o CTA vote-clarice (regressão — já tem o form de identidade equivalente do #3975)", async () => {
    const env = makeEnv();
    const res = await worker.fetch(
      voteReq("web", "3fa85f64-5717-4562-b3fc-2c963f66afa6@web.eia.diaria.local", "A"),
      env,
    );
    const html = await res.text();
    assert.doesNotMatch(html, /source: "vote-clarice"/);
  });

  it("brand=clarice na tela de 'já votou' (buildAlreadyVotedResponse): CTA + link do parceiro TAMBÉM convivem (mesma garantia, caminho de revisita)", async () => {
    const env = makeEnv();
    await worker.fetch(voteReq("clarice", "revisita@example.com", "A"), env);
    const res2 = await worker.fetch(voteReq("clarice", "revisita@example.com", "B"), env);
    const html2 = await res2.text();
    assert.match(html2, /já votou/i);
    assert.match(html2, /source: "vote-clarice"/);
    assert.match(html2, /href="https:\/\/clarice\.ai\/\?via=diaria[^"]*"/);
  });
});
