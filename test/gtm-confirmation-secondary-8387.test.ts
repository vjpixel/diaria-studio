/**
 * #8387 Etapa 1 — regressão da proposta de import da 2a ação de conversão
 * (pageview de /confirmada). Audita o ARQUIVO versionado, nunca o container ao vivo (#8578).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PAGE_URL } from "../scripts/lib/shared/confirmado-page.ts";

type Param = { key: string; value: string };
type Tag = { name: string; firingTriggerId: string[]; parameter: Param[] };
const c = JSON.parse(
  readFileSync(new URL("../docs/gtm-confirmation-secondary-import-proposal.json", import.meta.url), "utf8"),
).containerVersion as {
  tag: Tag[];
  trigger: { triggerId: string; type: string; filter: { parameter: Param[] }[] }[];
};
const html = (t: Tag) => t.parameter.find((p) => p.key === "html")?.value ?? "";

describe("#8387 proposta GTM — confirmação secundária", () => {
  it("trigger é pageview por PATH (ignora ?via=brevo) e casa o PAGE_URL real", () => {
    assert.equal(c.trigger.length, 1);
    const trig = c.trigger[0];
    assert.equal(trig.type, "pageview");
    const re = new RegExp(trig.filter[0].parameter.find((p) => p.key === "arg1")!.value);
    const path = new URL(PAGE_URL).pathname;
    assert.ok(re.test(path), `regex não casa ${path}`);
    assert.ok(re.test(path + "/"));
    assert.ok(!re.test("/confirmado"), "o path antigo é 301, não deve contar em dobro");
    assert.ok(!re.test("/"));
    assert.equal(trig.filter[0].parameter.find((p) => p.key === "arg0")!.value, "{{Page Path}}");
  });

  it("todas as tags disparam só nesse trigger", () => {
    for (const t of c.tag) assert.deepEqual(t.firingTriggerId, [c.trigger[0].triggerId], t.name);
  });

  it("Meta usa evento CUSTOM, nunca CompleteRegistration (#8551)", () => {
    const meta = c.tag.find((t) => t.name.startsWith("Meta"))!;
    assert.match(html(meta), /fbq\('trackCustom',\s*'SubscriptionConfirmed'/);
    assert.ok(!html(meta).includes("CompleteRegistration"));
  });

  it("Google Ads não reusa o rótulo da ação de cadastro primária (#7523)", () => {
    const g = c.tag.find((t) => t.name.startsWith("Google Ads"))!;
    const label = g.parameter.find((p) => p.key === "conversionLabel")!.value;
    assert.notEqual(label, "dxY1CIb1v9EbEKmt_aJC");
    assert.match(label, /^REPLACE_/);
  });

  it("tags HTML têm guard de sessão contra dupla contagem por recarga", () => {
    const htmlTags = c.tag.filter((t) => html(t) !== "");
    assert.equal(htmlTags.length, 3);
    for (const t of htmlTags) assert.match(html(t), /sessionStorage/, t.name);
  });

  it("LinkedIn mantém placeholder que impede publicar sem o id real", () => {
    const li = c.tag.find((t) => t.name.startsWith("LinkedIn"))!;
    assert.match(html(li), /REPLACE_LINKEDIN_CONVERSION_ID_CONFIRMACAO/);
  });
});
