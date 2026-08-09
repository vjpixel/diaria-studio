/**
 * test/poll-vote-clarice-cta-4054.test.ts (#4054, atualizado #4418)
 *
 * Gap remanescente da issue #4054: a página de resultado do `/vote` para o
 * brand `clarice` (audiência da Clarice News, não assinante da Diar.ia)
 * precisa de um CTA de cadastro na Diar.ia — com UTM PRÓPRIO pra medir
 * separado do CTA/link do parceiro (`clarice.ai/?via=diaria`, afiliado
 * Rewardful #1910) — sem NUNCA substituir esse link do parceiro (a entrega
 * da parceria, medida pelo #4048).
 *
 * O núcleo desse gap foi entregue pelo #4065 (form standalone
 * `renderInlineSignupFormBlock`/`inlineSignupScript("vote-clarice")`, com UTM
 * próprio via `VOTE_CLARICE_INLINE_UTM`). O #4418 (260801) FUNDIU esse form
 * na caixa de apelido (`.nick-box`) — o CTA de cadastro deixou de ser um
 * bloco separado (`id="jogar-signup-form"`) e virou um checkbox de opt-in
 * (`name="optin"`) dentro da mesma caixa que já oferece o leaderboard. O UTM
 * próprio (`VOTE_CLARICE_INLINE_UTM`) agora é aplicado server-side, no
 * cadastro que `handleSetName` (index.ts) dispara quando `optin=on` chega em
 * `/set-name` — não é mais visível como literal JS na página (o form virou
 * `GET`, não `fetch`).
 *
 * Este arquivo formaliza o invariante das DUAS cautelas da issue na FORMA
 * NOVA: o checkbox de opt-in aparece AO LADO do link do parceiro (nunca no
 * lugar dele), e as duas conversões continuam distinguíveis (checkbox
 * presente = existe oferta de cadastro; o parceiro é medido por
 * clarice.ai/?via=diaria, entrega própria e sempre presente).
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

describe("#4054/#4418: brand clarice — checkbox de opt-in (Caixa A fundida) CONVIVE com o link do parceiro (clarice.ai), nunca o substitui", () => {
  it("brand=clarice: checkbox de opt-in dentro da caixa fundida E o link de saída pro parceiro (clarice.ai/?via=diaria) aparecem NA MESMA resposta", async () => {
    const env = makeEnv();
    const res = await worker.fetch(voteReq("clarice", "leitor@example.com", "A"), env);
    assert.equal(res.status, 200);
    const html = await res.text();

    // #4418: o CTA de cadastro na Diar.ia agora é o checkbox de opt-in
    // dentro da Caixa A (nick-box) — não mais um form/bloco separado.
    assert.match(html, /<div class="nick-box">/, "Caixa A deve estar presente (leitor sem apelido)");
    assert.match(html, /<label class="nick-optin"><input type="checkbox" name="optin" value="on">/, "checkbox de opt-in deve estar presente pra clarice");
    // #4797: "diar.ia.br" nesta frase ganhou o wordmark da marca (negrito + `.`/`.br` teal).
    assert.match(html, /Quero receber a <strong>diar<span[^>]*>\.<\/span>ia<span[^>]*>\.br<\/span><\/strong>/, "copy do checkbox nomeia o produto");

    // O link de saída pro parceiro (clarice.ai/?via=diaria) — a entrega da
    // parceria, medida pelo #4048. NUNCA pode desaparecer quando o CTA entra.
    assert.match(html, /href="https:\/\/clarice\.ai\/\?via=diaria[^"]*"/, "link do parceiro (clarice.ai) deve continuar presente ao lado do CTA");
  });

  it("brand=diaria: NÃO renderiza o checkbox de opt-in (regressão — assinante não precisa reoferecer cadastro)", async () => {
    const env = makeEnv();
    const res = await worker.fetch(voteReq(null, "leitor@example.com", "B"), env);
    const html = await res.text();
    assert.doesNotMatch(html, /name="optin"/);
  });

  it("brand=web: NÃO renderiza o checkbox de opt-in (regressão — já tem o form de identidade equivalente do #3975)", async () => {
    const env = makeEnv();
    const res = await worker.fetch(
      voteReq("web", "3fa85f64-5717-4562-b3fc-2c963f66afa6@web.eia.diaria.local", "A"),
      env,
    );
    const html = await res.text();
    assert.doesNotMatch(html, /name="optin"/);
  });

  it("brand=clarice na tela de 'já votou' (buildAlreadyVotedResponse): checkbox + link do parceiro TAMBÉM convivem (mesma garantia, caminho de revisita)", async () => {
    const env = makeEnv();
    await worker.fetch(voteReq("clarice", "revisita@example.com", "A"), env);
    const res2 = await worker.fetch(voteReq("clarice", "revisita@example.com", "B"), env);
    const html2 = await res2.text();
    assert.match(html2, /já votou/i);
    assert.match(html2, /<label class="nick-optin"><input type="checkbox" name="optin" value="on">/);
    assert.match(html2, /href="https:\/\/clarice\.ai\/\?via=diaria[^"]*"/);
  });
});
