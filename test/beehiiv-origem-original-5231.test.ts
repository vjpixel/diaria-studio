/**
 * test/beehiiv-origem-original-5231.test.ts (#5231)
 *
 * Testes puros de `scripts/lib/shared/beehiiv-origem-original.ts` — extração
 * best-effort da origem de aquisição a partir do corpo do
 * `GET .../subscriptions/by_email/{email}`, e montagem do `custom_fields`
 * pra preservá-la no CREATE (`promoteBeehiivSubscription`/
 * `activateSubscription`). Cobertura fail-soft: nenhum destes cenários
 * deve lançar.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  ORIGEM_ORIGINAL_FIELD_NAME,
  extractSubscriptionOrigin,
  formatOrigemOriginalValue,
  buildOrigemOriginalCustomFields,
  extractOrigemOriginalFromCustomFields,
} from "../scripts/lib/shared/beehiiv-origem-original.ts";

describe("extractSubscriptionOrigin", () => {
  it("extrai os 5 campos quando todos presentes com o tipo esperado", () => {
    const body = {
      data: {
        utm_source: "google",
        utm_medium: "cpc",
        utm_campaign: "brand",
        referring_site: "https://google.com",
        created: 1700000000,
      },
    };
    assert.deepEqual(extractSubscriptionOrigin(body), {
      utm_source: "google",
      utm_medium: "cpc",
      utm_campaign: "brand",
      referring_site: "https://google.com",
      created: 1700000000,
    });
  });

  it("extração parcial: campos ausentes são omitidos, não zerados/lançados", () => {
    const body = { data: { utm_source: "newsletter", created: 1700000000 } };
    assert.deepEqual(extractSubscriptionOrigin(body), {
      utm_source: "newsletter",
      created: 1700000000,
    });
  });

  it("body sem `data` → null (nunca lança)", () => {
    assert.equal(extractSubscriptionOrigin({}), null);
    assert.equal(extractSubscriptionOrigin(null), null);
    assert.equal(extractSubscriptionOrigin(undefined), null);
  });

  it("`data` presente mas SEM nenhum dos 5 campos → null", () => {
    assert.equal(extractSubscriptionOrigin({ data: { id: "sub_1", status: "active" } }), null);
  });

  it("campos com tipo errado (não string/number) são ignorados, não lançam", () => {
    const body = {
      data: {
        utm_source: 123, // não é string — ignorado
        utm_medium: null,
        created: "não é number", // ignorado
        referring_site: "https://x.com",
      },
    };
    assert.deepEqual(extractSubscriptionOrigin(body), { referring_site: "https://x.com" });
  });

  it("string vazia é tratada como ausente (não grava origem vazia)", () => {
    const body = { data: { utm_source: "", referring_site: "https://x.com" } };
    assert.deepEqual(extractSubscriptionOrigin(body), { referring_site: "https://x.com" });
  });
});

describe("formatOrigemOriginalValue", () => {
  it("serializa em JSON com chaves em ordem estável", () => {
    const value = formatOrigemOriginalValue({
      referring_site: "https://x.com",
      utm_source: "google",
      created: 1700000000,
    });
    assert.equal(value, JSON.stringify({ utm_source: "google", referring_site: "https://x.com", created: 1700000000 }));
  });

  it("null/vazio → null (nunca lança, nunca serializa objeto vazio)", () => {
    assert.equal(formatOrigemOriginalValue(null), null);
    assert.equal(formatOrigemOriginalValue({}), null);
  });
});

describe("buildOrigemOriginalCustomFields — fail-soft (#5231 item 4)", () => {
  it("origem presente + fieldName informado → 1 custom field com esse nome + valor JSON", () => {
    const body = { data: { utm_source: "google", utm_medium: "cpc" } };
    const fields = buildOrigemOriginalCustomFields(body, ORIGEM_ORIGINAL_FIELD_NAME);
    assert.deepEqual(fields, [
      { name: ORIGEM_ORIGINAL_FIELD_NAME, value: JSON.stringify({ utm_source: "google", utm_medium: "cpc" }) },
    ]);
  });

  it("GET sem `data` (corpo malformado) → undefined, nunca lança (fail-soft)", () => {
    assert.equal(buildOrigemOriginalCustomFields({}, ORIGEM_ORIGINAL_FIELD_NAME), undefined);
    assert.equal(buildOrigemOriginalCustomFields(null, ORIGEM_ORIGINAL_FIELD_NAME), undefined);
    assert.equal(buildOrigemOriginalCustomFields(undefined, ORIGEM_ORIGINAL_FIELD_NAME), undefined);
  });

  it("GET com `data` mas sem nenhum campo de origem → undefined, nunca lança", () => {
    assert.equal(buildOrigemOriginalCustomFields({ data: { id: "sub_1", status: "pending" } }, ORIGEM_ORIGINAL_FIELD_NAME), undefined);
  });

  it("undefined (não array vazio) permite ao caller usar `...(fields ? {custom_fields: fields} : {})` sem incluir a chave", () => {
    const fields = buildOrigemOriginalCustomFields({}, ORIGEM_ORIGINAL_FIELD_NAME);
    const body: Record<string, unknown> = { email: "a@b.com", ...(fields ? { custom_fields: fields } : {}) };
    assert.deepEqual(body, { email: "a@b.com" });
    assert.ok(!("custom_fields" in body));
  });
});

describe("buildOrigemOriginalCustomFields — gate (#5231 fixer, achado do review dedicado)", () => {
  it("fieldName ausente (undefined) → sempre undefined, MESMO com origem presente no GET (gate OFF)", () => {
    const body = {
      data: {
        utm_source: "google",
        utm_medium: "cpc",
        utm_campaign: "brand",
        referring_site: "https://google.com",
        created: 1700000000,
      },
    };
    assert.equal(buildOrigemOriginalCustomFields(body, undefined), undefined);
  });

  it("fieldName vazio (\"\") → tratado como ausente, gate OFF", () => {
    const body = { data: { utm_source: "google" } };
    assert.equal(buildOrigemOriginalCustomFields(body, ""), undefined);
  });

  it("fieldName presente (gate ON) → custom field usa o NOME PASSADO, não necessariamente a constante", () => {
    const body = { data: { utm_source: "google" } };
    const fields = buildOrigemOriginalCustomFields(body, "campo_customizado");
    assert.deepEqual(fields, [{ name: "campo_customizado", value: JSON.stringify({ utm_source: "google" }) }]);
  });
});

describe("extractOrigemOriginalFromCustomFields (#7207) — companheiro de extractSubscriptionOrigin, mas lendo um array custom_fields já expandido (roster/snapshot)", () => {
  it("extrai os 5 campos quando o custom field está presente e bem formado", () => {
    const customFields = [
      {
        name: ORIGEM_ORIGINAL_FIELD_NAME,
        value: JSON.stringify({
          utm_source: "instagram",
          utm_medium: "bio-link",
          utm_campaign: "lancamento",
          referring_site: "www.instagram.com",
          created: 1700000000,
        }),
      },
    ];
    assert.deepEqual(extractOrigemOriginalFromCustomFields(customFields), {
      utm_source: "instagram",
      utm_medium: "bio-link",
      utm_campaign: "lancamento",
      referring_site: "www.instagram.com",
      created: 1700000000,
    });
  });

  it("extração parcial — só utm_source presente, resto omitido do resultado", () => {
    const customFields = [{ name: ORIGEM_ORIGINAL_FIELD_NAME, value: JSON.stringify({ utm_source: "google" }) }];
    assert.deepEqual(extractOrigemOriginalFromCustomFields(customFields), { utm_source: "google" });
  });

  it("customFields ausente/undefined → null", () => {
    assert.equal(extractOrigemOriginalFromCustomFields(undefined), null);
  });

  it("customFields sem o campo origem_original → null", () => {
    assert.equal(
      extractOrigemOriginalFromCustomFields([{ name: "outro_campo", value: "x" }]),
      null,
    );
  });

  it("value não é string → null", () => {
    assert.equal(
      extractOrigemOriginalFromCustomFields([{ name: ORIGEM_ORIGINAL_FIELD_NAME, value: 123 }]),
      null,
    );
  });

  it("value é JSON malformado → null, nunca lança", () => {
    assert.doesNotThrow(() => {
      const result = extractOrigemOriginalFromCustomFields([
        { name: ORIGEM_ORIGINAL_FIELD_NAME, value: "{not valid json" },
      ]);
      assert.equal(result, null);
    });
  });

  it("value decodificado sem utm_source → null (mínimo de utilidade exigido)", () => {
    assert.equal(
      extractOrigemOriginalFromCustomFields([
        { name: ORIGEM_ORIGINAL_FIELD_NAME, value: JSON.stringify({ utm_medium: "cpc" }) },
      ]),
      null,
    );
  });

  it("customFields não é array → null", () => {
    assert.equal(extractOrigemOriginalFromCustomFields("not-an-array" as unknown as undefined), null);
  });
});
