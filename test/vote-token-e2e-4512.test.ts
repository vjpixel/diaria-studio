/**
 * test/vote-token-e2e-4512.test.ts (#4512, fix pré-merge do #4487/#4486)
 *
 * Achado CRÍTICO do fleet review (comment-analyzer): `inject-poll-token.ts`
 * gravava o PSEUDO-EMAIL COMPLETO (`{token}@vote.eia.diaria.local`) no
 * custom field `poll_token` da Beehiiv, mas `newsletter-render-html.ts`
 * já concatena o domínio DEPOIS do merge tag
 * (`{{poll_token}}@vote.eia.diaria.local`) — o resultado final da URL de
 * voto tinha 2 arrobas (`...@vote.eia.diaria.local@vote.eia.diaria.local`),
 * o que falha `isValidVoteEmailFormat` (workers/poll/src/lib.ts) ANTES
 * mesmo de chegar na resolução do token opaco em `handleVote` — quebraria
 * 100% dos votos no primeiro dia em que `inject-poll-token.ts` rodasse ao
 * vivo.
 *
 * `test/inject-poll-token.test.ts` e `test/newsletter-render-html-esp-4266.test.ts`
 * testam cada METADE isoladamente (o valor gravado vs. o template) — nenhum
 * dos dois pega esse bug, porque o pareamento errado só aparece quando as
 * duas metades são combinadas. Este teste faz exatamente essa combinação,
 * usando as funções REAIS de produção dos dois lados (não uma
 * reimplementação inline):
 *
 * 1. `run()` de `scripts/inject-poll-token.ts` (mockando a API da Beehiiv)
 *    — captura o BODY real do PATCH enviado, ou seja, o valor que fica
 *    armazenado no custom field `poll_token`.
 * 2. `renderEIA()` de `scripts/lib/newsletter-render-html.ts` — o HTML real
 *    que vai pro e-mail, com o merge tag `{{poll_token}}` ainda não
 *    substituído.
 * 3. Simula a substituição de merge tag que a Beehiiv faz no envio
 *    (`{{poll_token}}` → valor do custom field).
 * 4. Confirma que a URL final resultante passa em `isValidVoteEmailFormat`
 *    (workers/poll/src/lib.ts) — o MESMO guard que `handleVote` aplica antes
 *    de qualquer lógica de resolução de token.
 * 5. Fecha o loop: `extractPollToken` (workers/poll/src/poll-token.ts, o
 *    espelho usado em produção pelo Worker) extrai de volta o MESMO token
 *    que foi gravado — prova que o par escrita↔leitura é consistente
 *    ponta-a-ponta, não só que cada metade isolada "parece certa".
 */

import { describe, it, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  MockAgent,
  setGlobalDispatcher,
  getGlobalDispatcher,
  type Dispatcher,
} from "undici";
import { run } from "../scripts/inject-poll-token.ts";
import { renderEIA, type EIA } from "../scripts/lib/newsletter-render-html.ts";
import { isValidVoteEmailFormat } from "../workers/poll/src/lib.ts";
import { extractPollToken } from "../workers/poll/src/poll-token.ts";
import type { CloudflareKVConfig } from "../scripts/lib/cloudflare-kv-upload.ts";

const PUB_ID = "pub_test";
const API_KEY = "fake_key";
const SECRET = "test_secret";
const BASE = "https://api.beehiiv.com";
const KV_CFG: CloudflareKVConfig = { accountId: "acct", token: "kvtoken", kvNamespaceId: "ns_test" };

let mockAgent: MockAgent;
let originalDispatcher: Dispatcher;

before(() => {
  originalDispatcher = getGlobalDispatcher();
  mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  setGlobalDispatcher(mockAgent);
});

after(async () => {
  await mockAgent.close();
  setGlobalDispatcher(originalDispatcher);
});

afterEach(() => {
  mockAgent.assertNoPendingInterceptors();
});

/** Extrai o valor de `?email=` do href de voto A dentro do HTML do painel É
 * IA?. Não usa URL() pra parse — o merge tag `{{poll_token}}` ainda não foi
 * substituído neste ponto, então a string não é uma URL válida ainda. */
function extractVoteEmailParam(html: string, choice: "A" | "B"): string {
  const re = new RegExp(`href="[^"]*[?&]email=([^&"]+)&edition=[^&"]+&choice=${choice}`);
  const m = html.match(re);
  assert.ok(m, `href de voto (choice=${choice}) não encontrado no HTML renderizado`);
  return decodeURIComponent(m![1]);
}

describe("#4512 — combinação real inject-poll-token.ts + newsletter-render-html.ts", () => {
  it("valor gravado no custom field + template do e-mail juntos produzem uma URL de voto que PASSA em isValidVoteEmailFormat", async () => {
    const pool = mockAgent.get(BASE);
    pool
      .intercept({ path: `/v2/publications/${PUB_ID}/custom_fields?limit=100`, method: "GET" })
      .reply(200, { data: [{ id: "1", kind: "string", display: "poll_token" }] }, { headers: { "content-type": "application/json" } });

    const email = "leitor@example.com";
    pool
      .intercept({ path: new RegExp(`/v2/publications/${PUB_ID}/subscriptions`), method: "GET" })
      .reply(
        200,
        { data: [{ id: "s_1", email, status: "active", created: 1000000000, custom_fields: [] }], has_more: false },
        { headers: { "content-type": "application/json" } },
      );

    // Captura o BODY real do PATCH — é literalmente o valor que a Beehiiv
    // vai armazenar e substituir no merge tag `{{poll_token}}` no envio.
    let patchedFieldValue: string | undefined;
    pool
      .intercept({ path: `/v2/publications/${PUB_ID}/subscriptions/s_1`, method: "PATCH" })
      .reply((opts) => {
        const body = JSON.parse(opts.body as string) as { custom_fields: Array<{ name: string; value: string }> };
        patchedFieldValue = body.custom_fields.find((f) => f.name === "poll_token")?.value;
        return { statusCode: 200, data: JSON.stringify({ ok: true }), headers: { "content-type": "application/json" } };
      });

    const written = new Map<string, string>();
    await run({
      dryRun: false,
      force: false,
      apiOpts: { publicationId: PUB_ID, apiKey: API_KEY, baseUrl: `${BASE}/v2` },
      secret: SECRET,
      kvConfig: KV_CFG,
      putKv: async (key, value) => {
        written.set(key, value);
      },
    });

    assert.ok(patchedFieldValue, "PATCH deveria ter sido enviado com o custom field poll_token");

    // Segunda metade: o template REAL do e-mail (não uma reimplementação).
    const eia: EIA = {
      credit: "Foto: Author / CC BY-SA 4.0.",
      imageA: "01-eia-A.jpg",
      imageB: "01-eia-B.jpg",
      edition: "260999",
    };
    const html = renderEIA(eia, "beehiiv");
    const mergeTagUrlEmailParam = extractVoteEmailParam(html, "A");
    assert.equal(
      mergeTagUrlEmailParam,
      "{{poll_token}}@vote.eia.diaria.local",
      "sanity check: o template ainda carrega o merge tag não-substituído",
    );

    // Simula a substituição de merge tag que a Beehiiv faz no envio.
    const finalEmailParam = mergeTagUrlEmailParam.replace("{{poll_token}}", patchedFieldValue!);

    assert.equal(
      (finalEmailParam.match(/@/g) ?? []).length,
      1,
      `URL final deve ter exatamente 1 arroba — achou "${finalEmailParam}" (bug #4512 duplicava o domínio)`,
    );
    assert.ok(
      isValidVoteEmailFormat(finalEmailParam),
      `URL final "${finalEmailParam}" deveria passar isValidVoteEmailFormat (o mesmo guard que handleVote aplica antes de resolver o token)`,
    );

    // Fecha o loop ponta-a-ponta: o token embutido na URL final resolve de
    // volta pro MESMO token que foi gravado no KV pela injeção.
    const resolvedToken = extractPollToken(finalEmailParam);
    assert.ok(resolvedToken, "extractPollToken deveria reconhecer o token válido na URL final");
    const [kvKey] = [...written.keys()];
    assert.equal(kvKey, `polltoken:${resolvedToken}`, "o token extraído da URL final é a mesma chave gravada no KV");
  });

  it("regressão documentada: se o custom field guardasse o pseudo-email completo (bug pré-#4512), a URL final teria 2 arrobas e FALHARIA isValidVoteEmailFormat", () => {
    // Não reexercita o script — só documenta, com as funções reais de
    // validação/template, por que o valor antigo era inválido. Serve de
    // contraste direto com o teste acima (mesmo par email/edição/choice).
    const eia: EIA = {
      credit: "Foto: Author / CC BY-SA 4.0.",
      imageA: "01-eia-A.jpg",
      imageB: "01-eia-B.jpg",
      edition: "260999",
    };
    const html = renderEIA(eia, "beehiiv");
    const mergeTagUrlEmailParam = extractVoteEmailParam(html, "B");

    const buggyFieldValue = "abc123def456abc123def456@vote.eia.diaria.local"; // valor que o código com bug gravava
    const finalEmailParamBuggy = mergeTagUrlEmailParam.replace("{{poll_token}}", buggyFieldValue);

    assert.equal((finalEmailParamBuggy.match(/@/g) ?? []).length, 2, "reproduz o bug: 2 arrobas");
    assert.equal(
      isValidVoteEmailFormat(finalEmailParamBuggy),
      false,
      "confirma que o valor pré-fix falharia isValidVoteEmailFormat — exatamente o bug que #4512 corrige",
    );
  });
});
