/**
 * test/gtm-drift-check.test.ts (#8585)
 *
 * Cobertura de `scripts/lib/gtm-drift-check.ts` (lógica pura) +
 * `scripts/gtm-drift-check.ts` (fetch injetável, wiring). NUNCA bate rede
 * real — o `gtm.js` é sempre uma fixture local que mimetiza o formato
 * observável do compilador do Tag Manager (arrays `["map","name",...,"value",...]`
 * pro `objectPropertyList` do template oficial do Meta Pixel), com o
 * fetch mockado em todo teste que exercita o script fino.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  evaluateGtmDrift,
  hasGtmDrift,
  unresolvedGtmChecks,
  extractQuotedValueAfterKey,
  extractObjectPropertyListValue,
  computeGtmDriftFingerprint,
  gtmDriftFindingKey,
  buildGtmDriftAlarmEmail,
  type GtmExpectedConfig,
} from "../scripts/lib/gtm-drift-check.ts";
import { fetchGtmJs, GTM_JS_URL, GTM_CONTAINER_ID } from "../scripts/gtm-drift-check.ts";

const EXPECTED: GtmExpectedConfig = {
  pixelId: "1285191740325112",
  eventName: "CompleteRegistration",
  value: "1",
  currency: "BRL",
};

/** Fixture mínima que reproduz o padrão observável de um `gtm.js`
 * compilado com a tag oficial `__cvt_5RM3Q` (Meta Pixel) — NÃO é uma cópia
 * do container real (não temos acesso de rede pra capturá-la), é uma
 * aproximação estrutural o bastante pra exercitar as regexes de extração. */
function buildFixtureGtmJs(opts: {
  pixelId?: string;
  eventName?: string;
  value?: string;
  currency?: string;
  includeEventId?: boolean;
} = {}): string {
  const {
    pixelId = "1285191740325112",
    eventName = "CompleteRegistration",
    value = "1",
    currency = "BRL",
    includeEventId = true,
  } = opts;
  const eventIdField = includeEventId ? `,"vtp_eventId":["macro",7]` : "";
  return (
    `(function(){var data={"function":"__cvt_5RM3Q",` +
    `"vtp_pixelId":"${pixelId}","vtp_standardEventName":"${eventName}",` +
    `"vtp_objectPropertyList":["list",["map","name","value","value","${value}"],["map","name","currency","value","${currency}"]]` +
    `${eventIdField}};})();`
  );
}

describe("#8585 — extractQuotedValueAfterKey", () => {
  it("acha o valor entre aspas logo após a chave", () => {
    assert.equal(extractQuotedValueAfterKey('{"vtp_pixelId":"12345"}', "vtp_pixelId"), "12345");
  });

  it("devolve null quando a chave não existe", () => {
    assert.equal(extractQuotedValueAfterKey('{"outraChave":"x"}', "vtp_pixelId"), null);
  });

  it("nunca lança em texto vazio/malformado", () => {
    assert.equal(extractQuotedValueAfterKey("", "vtp_pixelId"), null);
    assert.equal(extractQuotedValueAfterKey("{{{ não é json", "vtp_pixelId"), null);
  });
});

describe("#8585 — extractObjectPropertyListValue", () => {
  it("acha o valor no formato name-antes-de-value", () => {
    const text = '["map","name","currency","value","BRL"]';
    assert.equal(extractObjectPropertyListValue(text, "currency"), "BRL");
  });

  it("acha o valor no formato value-antes-de-name", () => {
    const text = '["map","value","BRL","name","currency"]';
    assert.equal(extractObjectPropertyListValue(text, "currency"), "BRL");
  });

  it("devolve null quando a propriedade não existe", () => {
    assert.equal(extractObjectPropertyListValue('["map","name","outra","value","x"]', "currency"), null);
  });

  it("tolera aspas simples", () => {
    assert.equal(extractObjectPropertyListValue("['map','name','currency','value','BRL']", "currency"), "BRL");
  });
});

describe("#8585 — evaluateGtmDrift: caso limpo (container bate com o esperado)", () => {
  it("todos os 5 eixos vêm 'match'", () => {
    const results = evaluateGtmDrift(buildFixtureGtmJs(), EXPECTED);
    assert.equal(results.length, 5);
    for (const r of results) {
      assert.equal(r.status, "match", `eixo ${r.check} não bateu: ${r.message}`);
    }
    assert.equal(hasGtmDrift(results), false);
    assert.equal(unresolvedGtmChecks(results).length, 0);
    assert.equal(computeGtmDriftFingerprint(results), null);
  });
});

describe("#8585 — evaluateGtmDrift: divergências reais (mismatch)", () => {
  it("currency divergente vira mismatch, resto continua match", () => {
    const results = evaluateGtmDrift(buildFixtureGtmJs({ currency: "USD" }), EXPECTED);
    const currency = results.find((r) => r.check === "currency");
    assert.equal(currency?.status, "mismatch");
    assert.match(currency!.message, /USD.*BRL|BRL.*USD/);
    assert.equal(hasGtmDrift(results), true);
    // os demais eixos não são afetados pela divergência de um único campo
    assert.equal(results.find((r) => r.check === "pixel-id")?.status, "match");
    assert.equal(results.find((r) => r.check === "value")?.status, "match");
  });

  it("value divergente vira mismatch", () => {
    const results = evaluateGtmDrift(buildFixtureGtmJs({ value: "5" }), EXPECTED);
    const value = results.find((r) => r.check === "value");
    assert.equal(value?.status, "mismatch");
  });

  it("pixel ID genuinamente trocado vira mismatch (não not-found) — regressão do achado de review #8613: extrai e compara o valor real de vtp_pixelId em vez de só checar presença", () => {
    const results = evaluateGtmDrift(buildFixtureGtmJs({ pixelId: "9999999999999" }), EXPECTED);
    const pixelId = results.find((r) => r.check === "pixel-id");
    assert.equal(pixelId?.status, "mismatch");
    assert.match(pixelId!.message, /9999999999999/);
    assert.equal(hasGtmDrift([pixelId!]), true);
  });

  it("evento genuinamente trocado vira mismatch (não not-found)", () => {
    const results = evaluateGtmDrift(buildFixtureGtmJs({ eventName: "Lead" }), EXPECTED);
    const eventName = results.find((r) => r.check === "event-name");
    assert.equal(eventName?.status, "mismatch");
  });

  it("vtp_pixelId ausente do gtm.js (não trocado, AUSENTE) vira not-found", () => {
    const noPixelKey = buildFixtureGtmJs().replace(/"vtp_pixelId":"[^"]*",/, "");
    const results = evaluateGtmDrift(noPixelKey, EXPECTED);
    assert.equal(results.find((r) => r.check === "pixel-id")?.status, "not-found");
  });

  it("vtp_eventId ausente vira not-found — nunca mismatch (é presença/ausência, não valor)", () => {
    const results = evaluateGtmDrift(buildFixtureGtmJs({ includeEventId: false }), EXPECTED);
    const eventId = results.find((r) => r.check === "event-id-field");
    assert.equal(eventId?.status, "not-found");
    // not-found não é drift acionável sozinho
    assert.equal(hasGtmDrift([eventId!]), false);
  });
});

describe("#8585 — not-found nunca vira mismatch silenciosamente (formato do gtm.js pode mudar sem que o CONTEÚDO tenha mudado)", () => {
  it("texto completamente diferente do formato esperado só produz not-found, nunca mismatch/exceção", () => {
    const results = evaluateGtmDrift("totalmente outro formato, sem nenhum marcador reconhecido", EXPECTED);
    for (const r of results) {
      assert.equal(r.status, "not-found", `eixo ${r.check} deveria ser not-found, veio ${r.status}`);
    }
    assert.equal(hasGtmDrift(results), false);
    assert.equal(unresolvedGtmChecks(results).length, 5);
  });

  it("string vazia não lança", () => {
    assert.doesNotThrow(() => evaluateGtmDrift("", EXPECTED));
  });
});

describe("#8585 — computeGtmDriftFingerprint", () => {
  it("determinístico independente da ordem de entrada dos achados", () => {
    const a = evaluateGtmDrift(buildFixtureGtmJs({ currency: "USD", value: "5" }), EXPECTED);
    const b = [...a].reverse();
    assert.equal(computeGtmDriftFingerprint(a), computeGtmDriftFingerprint(b));
  });

  it("null quando não há mismatch (mesmo com not-found presente)", () => {
    const results = evaluateGtmDrift(buildFixtureGtmJs({ includeEventId: false }), EXPECTED);
    assert.equal(computeGtmDriftFingerprint(results), null);
  });
});

describe("#8585 — buildGtmDriftAlarmEmail", () => {
  it("lista as divergências e cita a issue quando disponível", () => {
    const results = evaluateGtmDrift(buildFixtureGtmJs({ currency: "USD" }), EXPECTED);
    const currencyFinding = results.find((r) => r.check === "currency")!;
    const issueRefs = new Map([[gtmDriftFindingKey(currencyFinding), { issueNumber: 123, url: "https://github.com/x/y/issues/123" }]]);
    const { subject, body } = buildGtmDriftAlarmEmail(results, GTM_JS_URL, issueRefs);
    assert.match(subject, /currency/);
    assert.match(body, /#123/);
    assert.match(body, new RegExp(GTM_CONTAINER_ID));
  });

  it("achados not-found aparecem só na seção informativa, não na de divergências", () => {
    const results = evaluateGtmDrift(buildFixtureGtmJs({ pixelId: "outro", includeEventId: false }), EXPECTED);
    const { body } = buildGtmDriftAlarmEmail(results, GTM_JS_URL);
    assert.match(body, /não confirmados/);
  });
});

describe("#8585 — fetchGtmJs: fetch mockado, sem rede real", () => {
  it("resolve pra { text, fetchError: null } em resposta 200", async () => {
    const mockFetch = (async () => new Response("gtm content", { status: 200 })) as typeof fetch;
    const { text, fetchError } = await fetchGtmJs("https://example.test/gtm.js", mockFetch);
    assert.equal(text, "gtm content");
    assert.equal(fetchError, null);
  });

  it("HTTP não-2xx vira fetchError, texto null — NUNCA lança", async () => {
    const mockFetch = (async () => new Response("erro", { status: 503 })) as typeof fetch;
    const { text, fetchError } = await fetchGtmJs("https://example.test/gtm.js", mockFetch);
    assert.equal(text, null);
    assert.match(fetchError!, /503/);
  });

  it("exceção de rede (timeout, DNS) vira fetchError — NUNCA lança", async () => {
    const mockFetch = (async () => {
      throw new Error("network down");
    }) as typeof fetch;
    const { text, fetchError } = await fetchGtmJs("https://example.test/gtm.js", mockFetch);
    assert.equal(text, null);
    assert.equal(fetchError, "network down");
  });

  it("manda User-Agent de navegador (defesa contra challenge sem UA)", async () => {
    let capturedHeaders: HeadersInit | undefined;
    const mockFetch = (async (_url: string | URL, init?: RequestInit) => {
      capturedHeaders = init?.headers;
      return new Response("ok", { status: 200 });
    }) as typeof fetch;
    await fetchGtmJs("https://example.test/gtm.js", mockFetch);
    const headers = new Headers(capturedHeaders);
    assert.ok(headers.get("User-Agent"), "User-Agent ausente na chamada");
  });
});
