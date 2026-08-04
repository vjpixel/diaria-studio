/**
 * test/vote-token-e2e-4512.test.ts (#4512, fix pré-merge do #4487/#4486;
 * repontado pro canal BREVO em #4581)
 *
 * Achado CRÍTICO do fleet review (comment-analyzer) que originou este arquivo:
 * o script de injeção gravava o PSEUDO-EMAIL COMPLETO
 * (`{token}@vote.eia.diaria.local`) no atributo/custom field do contato, mas
 * `newsletter-render-html.ts` já concatena o domínio DEPOIS do merge tag — o
 * resultado final da URL de voto tinha 2 arrobas
 * (`...@vote.eia.diaria.local@vote.eia.diaria.local`), o que falha
 * `isValidVoteEmailFormat` (workers/poll/src/lib.ts) ANTES mesmo de chegar na
 * resolução do token em `handleVote`. Quebraria 100% dos votos no primeiro dia
 * de envio.
 *
 * **Por que este arquivo agora testa o BREVO (#4581).** O bug só aparece
 * quando as duas metades — o valor GRAVADO e o template que CONCATENA o
 * domínio — são combinadas; cada metade isolada "parece certa". Até o #4581 o
 * par vivo era Beehiiv (`inject-poll-token.ts` + `renderEIA(eia, "beehiiv")`).
 * O #4581 reverteu o ramo Beehiiv pro `{{email}}` cru (o É IA? não distribui
 * prêmio — ver `newsletter-render-html.ts::buildVoteUrl`), então esse par
 * deixou de existir em produção: `inject-poll-token.ts` ficou órfão e o
 * template Beehiiv não concatena mais domínio nenhum.
 *
 * O par que CONTINUA vivo é o Brevo, enviando desde 260803:
 * `scripts/inject-poll-token-brevo.ts` (chamado INLINE por
 * `publish-daily-brevo.ts` antes de cada campanha) + `renderEIA(eia, "brevo")`.
 * É esse que este arquivo exercita agora — usando as funções REAIS de produção
 * dos dois lados, não uma reimplementação inline:
 *
 * 1. `run()` de `scripts/inject-poll-token-brevo.ts` (mockando a API da Brevo)
 *    — captura o BODY real do PUT enviado, ou seja, o valor que fica
 *    armazenado no atributo de contato `POLL_TOKEN`.
 * 2. `renderEIA(eia, "brevo")` — o HTML real que vai pro e-mail, com o merge
 *    tag `{{ contact.POLL_TOKEN }}` ainda não substituído.
 * 3. Simula a substituição de merge tag que a Brevo faz no envio.
 * 4. Confirma que a URL final resultante passa em `isValidVoteEmailFormat` — o
 *    MESMO guard que `handleVote` aplica antes de qualquer resolução.
 * 5. Fecha o loop: `extractPollToken` (workers/poll/src/poll-token.ts, o
 *    espelho usado em produção pelo Worker) extrai de volta o MESMO token que
 *    foi gravado no KV — prova que o par escrita↔leitura é consistente
 *    ponta-a-ponta.
 *
 * Complementa `test/inject-poll-token-brevo-4517.test.ts`, que cobre o
 * injetor Brevo ISOLADO (sem o template), e reusa o padrão de mock dele
 * (`fetch` global, não `undici.MockAgent` — os helpers `brevoGet`/`brevoPut`
 * usam `fetch` global sem hook de baseUrl).
 *
 * O 3º teste cobre o outro lado da mesma moeda: o ramo Beehiiv NÃO pode voltar
 * a concatenar domínio. Com `{{email}}` cru, a plataforma já substitui por um
 * e-mail completo — colar o sufixo de volta reintroduz o bug do #4512 pelo
 * lado do TEMPLATE (antes ele vinha pelo lado do valor gravado).
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { run } from "../scripts/inject-poll-token-brevo.ts";
import { renderEIA, type EIA } from "../scripts/lib/newsletter-render-html.ts";
import { isValidVoteEmailFormat } from "../workers/poll/src/lib.ts";
import { extractPollToken } from "../workers/poll/src/poll-token.ts";
import { pollTokenKvKey } from "../scripts/lib/shared/poll-token.ts";
import type { CloudflareKVConfig } from "../scripts/lib/cloudflare-kv-upload.ts";

const API_KEY = "fake_brevo_key";
const SECRET = "test_secret";
const LIST_ID = 7;
const KV_CFG: CloudflareKVConfig = { accountId: "acct", token: "kvtoken", kvNamespaceId: "ns_test" };

const EIA_FIXTURE: EIA = {
  credit: "Foto: Author / CC BY-SA 4.0.",
  imageA: "01-eia-A.jpg",
  imageB: "01-eia-B.jpg",
  edition: "260999",
};

function jsonRes(status: number, body: unknown): Response {
  const text = JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => (name.toLowerCase() === "content-type" ? "application/json" : null) },
    text: async () => text,
    json: async () => body,
    body: { cancel: async () => {} },
  } as unknown as Response;
}

function noContentRes(status = 204): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    text: async () => "",
    body: { cancel: async () => {} },
  } as unknown as Response;
}

let originalFetch: typeof fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

/**
 * Router mínimo da API Brevo — mesmo padrão de
 * test/inject-poll-token-brevo-4517.test.ts. Devolve os `attributes` capturados
 * do PUT, que são literalmente o valor que a Brevo substitui no merge tag.
 */
function installRouter(email: string): { putBodies: Array<Record<string, string>> } {
  const putBodies: Array<Record<string, string>> = [];
  globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(init.body as string) : undefined;

    if (method === "GET" && url.pathname === "/v3/contacts/attributes") {
      return jsonRes(200, { attributes: [{ name: "POLL_TOKEN", category: "normal", type: "text" }] });
    }
    if (method === "GET" && url.pathname === `/v3/contacts/lists/${LIST_ID}/contacts`) {
      const offset = Number(url.searchParams.get("offset") ?? "0");
      return jsonRes(200, { contacts: offset === 0 ? [{ email, attributes: {} }] : [], count: 1 });
    }
    if (method === "PUT" && url.pathname.startsWith("/v3/contacts/")) {
      putBodies.push((body as { attributes: Record<string, string> }).attributes);
      return noContentRes(204);
    }
    throw new Error(`unexpected fetch: ${method} ${url.pathname}${url.search}`);
  }) as typeof fetch;
  return { putBodies };
}

/** Extrai o valor de `?email=` do href de voto dentro do HTML do painel É IA?.
 * Não usa URL() pra parse — o merge tag ainda não foi substituído neste ponto,
 * então a string não é uma URL válida ainda. O ramo Brevo escapa o separador
 * como `&amp;`; o Beehiiv usa `&` cru. */
function extractVoteEmailParam(html: string, choice: "A" | "B"): string {
  const sep = "(?:&amp;|&)";
  const re = new RegExp(`href="[^"]*[?&]email=([^&"]+)${sep}edition=[^&"]+${sep}choice=${choice}`);
  const m = html.match(re);
  assert.ok(m, `href de voto (choice=${choice}) não encontrado no HTML renderizado`);
  return decodeURIComponent(m![1]);
}

describe("#4512 — combinação real inject-poll-token-brevo.ts + newsletter-render-html.ts (canal Brevo, #4581)", () => {
  it("valor gravado no atributo + template do e-mail juntos produzem uma URL de voto que PASSA em isValidVoteEmailFormat", async () => {
    const email = "leitor@example.com";
    const { putBodies } = installRouter(email);

    const written = new Map<string, string>();
    await run({
      dryRun: false,
      force: false,
      apiOpts: { apiKey: API_KEY, listId: LIST_ID },
      secret: SECRET,
      kvConfig: KV_CFG,
      putKv: async (key, value) => {
        written.set(key, value);
      },
    });

    assert.equal(putBodies.length, 1, "PUT deveria ter sido enviado com o atributo POLL_TOKEN");
    const storedValue = putBodies[0].POLL_TOKEN;
    assert.ok(storedValue, "atributo POLL_TOKEN ausente no body do PUT");

    // O bug do #4512 em uma linha: se o valor gravado já trouxesse o domínio,
    // a concatenação do template duplicaria. Guard direto sobre o valor.
    assert.ok(
      !storedValue.includes("@"),
      `valor gravado deve ser o token CRU, sem domínio — achou "${storedValue}" (bug #4512)`,
    );

    // Segunda metade: o template REAL do e-mail (não uma reimplementação).
    const html = renderEIA(EIA_FIXTURE, "brevo");
    const mergeTagUrlEmailParam = extractVoteEmailParam(html, "A");
    assert.equal(
      mergeTagUrlEmailParam,
      "{{ contact.POLL_TOKEN }}@vote.eia.diaria.local",
      "sanity check: o template ainda carrega o merge tag não-substituído",
    );

    // Simula a substituição de merge tag que a Brevo faz no envio.
    const finalEmailParam = mergeTagUrlEmailParam.replace("{{ contact.POLL_TOKEN }}", storedValue);

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
    assert.equal(kvKey, pollTokenKvKey(resolvedToken!), "o token extraído da URL final é a mesma chave gravada no KV");
    assert.equal(written.get(kvKey), email, "a entrada reversa do KV aponta pro e-mail real do assinante");
  });

  it("regressão documentada: se o atributo guardasse o pseudo-email completo (bug pré-#4512), a URL final teria 2 arrobas e FALHARIA isValidVoteEmailFormat", () => {
    // Não reexercita o script — só documenta, com as funções reais de
    // validação/template, por que o valor antigo era inválido. Serve de
    // contraste direto com o teste acima.
    const html = renderEIA(EIA_FIXTURE, "brevo");
    const mergeTagUrlEmailParam = extractVoteEmailParam(html, "B");

    const buggyFieldValue = "abc123def456abc123def456@vote.eia.diaria.local"; // valor que o código com bug gravava
    const finalEmailParamBuggy = mergeTagUrlEmailParam.replace("{{ contact.POLL_TOKEN }}", buggyFieldValue);

    assert.equal((finalEmailParamBuggy.match(/@/g) ?? []).length, 2, "reproduz o bug: 2 arrobas");
    assert.equal(
      isValidVoteEmailFormat(finalEmailParamBuggy),
      false,
      "confirma que o valor pré-fix falharia isValidVoteEmailFormat — exatamente o bug que #4512 corrige",
    );
  });

  it("#4581: o ramo BEEHIIV não concatena domínio nenhum — o mesmo bug pelo lado do template", () => {
    // Guard da reversão: com `{{email}}` cru, a plataforma já substitui por um
    // e-mail COMPLETO. Se alguém recolar `@vote.eia.diaria.local` neste ramo,
    // toda URL de voto do diário passa a ter 2 arrobas — o bug do #4512 de
    // volta, agora pelo lado do template em vez do lado do valor gravado.
    const html = renderEIA(EIA_FIXTURE, "beehiiv");
    const param = extractVoteEmailParam(html, "A");
    assert.equal(param, "{{email}}", "ramo Beehiiv deve emitir a merge tag crua, sem sufixo de domínio");

    const substituido = param.replace("{{email}}", "leitor@example.com");
    assert.equal((substituido.match(/@/g) ?? []).length, 1, "após substituição real, exatamente 1 arroba");
    assert.ok(isValidVoteEmailFormat(substituido), "e-mail cru substituído passa no mesmo guard do handleVote");
  });
});
