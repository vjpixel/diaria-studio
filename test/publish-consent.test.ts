import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  autoApproveConsent,
  defaultManualConsent,
  parseEditorResponse,
  hasAnyAutoChannel,
  allChannelsSkipped,
} from "../scripts/lib/publish-consent.ts";

describe("autoApproveConsent (#1238)", () => {
  it("retorna tudo auto com source 'auto_approve_default'", () => {
    const c = autoApproveConsent();
    assert.equal(c.newsletter, "auto");
    assert.equal(c.linkedin, "auto");
    assert.equal(c.facebook, "auto");
    assert.equal(c.source, "auto_approve_default");
  });
});

describe("defaultManualConsent", () => {
  it("retorna tudo manual com source 'default_manual'", () => {
    const c = defaultManualConsent();
    assert.equal(c.newsletter, "manual");
    assert.equal(c.linkedin, "manual");
    assert.equal(c.facebook, "manual");
    assert.equal(c.source, "default_manual");
  });
});

describe("parseEditorResponse (#1238)", () => {
  it("'all' → tudo auto", () => {
    const c = parseEditorResponse("all");
    assert.ok(c);
    assert.equal(c.newsletter, "auto");
    assert.equal(c.linkedin, "auto");
    assert.equal(c.facebook, "auto");
    assert.equal(c.source, "editor_response_all");
  });

  it("'ALL' case-insensitive", () => {
    const c = parseEditorResponse("ALL");
    assert.ok(c);
    assert.equal(c.newsletter, "auto");
  });

  it("'none' → tudo skipped", () => {
    const c = parseEditorResponse("none");
    assert.ok(c);
    assert.equal(c.newsletter, "skipped");
    assert.equal(c.linkedin, "skipped");
    assert.equal(c.facebook, "skipped");
  });

  it("'1,3,5' → tudo auto (canais 1=Beehiiv, 3=LinkedIn, 5=Facebook)", () => {
    const c = parseEditorResponse("1,3,5");
    assert.ok(c);
    assert.equal(c.newsletter, "auto");
    assert.equal(c.linkedin, "auto");
    assert.equal(c.facebook, "auto");
  });

  it("'2,4,6' → tudo manual (canais pares)", () => {
    const c = parseEditorResponse("2,4,6");
    assert.ok(c);
    assert.equal(c.newsletter, "manual");
    assert.equal(c.linkedin, "manual");
    assert.equal(c.facebook, "manual");
  });

  it("'1,4,5' → Beehiiv auto, LinkedIn manual, Facebook auto (mix)", () => {
    const c = parseEditorResponse("1,4,5");
    assert.ok(c);
    assert.equal(c.newsletter, "auto");
    assert.equal(c.linkedin, "manual");
    assert.equal(c.facebook, "auto");
  });

  it("canais não mencionados ficam manual (conservador)", () => {
    const c = parseEditorResponse("3");
    assert.ok(c);
    assert.equal(c.newsletter, "manual");
    assert.equal(c.linkedin, "auto");
    assert.equal(c.facebook, "manual");
  });

  it("aceita whitespace como separador", () => {
    const c = parseEditorResponse("1 3 5");
    assert.ok(c);
    assert.equal(c.newsletter, "auto");
    assert.equal(c.linkedin, "auto");
    assert.equal(c.facebook, "auto");
  });

  it("input vazio → null", () => {
    assert.equal(parseEditorResponse(""), null);
    assert.equal(parseEditorResponse("   "), null);
  });

  it("número fora do range 1-6 → null", () => {
    assert.equal(parseEditorResponse("7"), null);
    assert.equal(parseEditorResponse("0,1"), null);
  });

  it("texto não-numérico → null", () => {
    assert.equal(parseEditorResponse("abc"), null);
    assert.equal(parseEditorResponse("1,abc,3"), null);
  });

  it("source contém os números aplicados pra rastreabilidade", () => {
    const c = parseEditorResponse("1,3,5");
    assert.ok(c);
    assert.match(c.source, /editor_response/);
  });

  it("último valor vence quando conflito (1 e 2 ambos pra newsletter)", () => {
    const c = parseEditorResponse("1,2");
    assert.ok(c);
    assert.equal(c.newsletter, "manual", "2 (manual) sobrescreve 1 (auto) na ordem");
  });
});

describe("hasAnyAutoChannel (#1238)", () => {
  it("true quando algum canal é auto", () => {
    assert.equal(hasAnyAutoChannel(autoApproveConsent()), true);
    assert.equal(
      hasAnyAutoChannel({ newsletter: "manual", linkedin: "auto", facebook: "manual", source: "x" }),
      true,
    );
  });
  it("false quando tudo manual ou skipped", () => {
    assert.equal(hasAnyAutoChannel(defaultManualConsent()), false);
    assert.equal(
      hasAnyAutoChannel({ newsletter: "skipped", linkedin: "skipped", facebook: "manual", source: "x" }),
      false,
    );
  });
});

describe("allChannelsSkipped (#1238)", () => {
  it("true quando todos skipped", () => {
    const c = parseEditorResponse("none")!;
    assert.equal(allChannelsSkipped(c), true);
  });
  it("false quando algum não-skipped", () => {
    assert.equal(allChannelsSkipped(defaultManualConsent()), false);
    assert.equal(allChannelsSkipped(autoApproveConsent()), false);
    assert.equal(
      allChannelsSkipped({ newsletter: "skipped", linkedin: "skipped", facebook: "auto", source: "x" }),
      false,
    );
  });
});
