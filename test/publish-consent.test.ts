import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  autoApproveConsent,
  defaultAutoConsent,
  defaultManualConsent,
  parseEditorResponse,
  parseSkipFlag,
  hasAnyAutoChannel,
  allChannelsSkipped,
} from "../scripts/lib/publish-consent.ts";

describe("autoApproveConsent (#1238)", () => {
  it("retorna tudo auto com source 'auto_approve_default'", () => {
    const c = autoApproveConsent();
    assert.equal(c.newsletter, "auto");
    assert.equal(c.linkedin, "auto");
    assert.equal(c.facebook, "auto");
    assert.equal(c.instagram, "auto"); // #49
    assert.equal(c.threads, "auto"); // #2479
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

describe("defaultAutoConsent (#1326)", () => {
  it("retorna tudo auto com source 'default_auto'", () => {
    const c = defaultAutoConsent();
    assert.equal(c.newsletter, "auto");
    assert.equal(c.linkedin, "auto");
    assert.equal(c.facebook, "auto");
    assert.equal(c.source, "default_auto");
  });
});

describe("parseSkipFlag (#1326)", () => {
  it("input vazio → tudo auto", () => {
    const c = parseSkipFlag("");
    assert.ok(c);
    assert.equal(c.newsletter, "auto");
    assert.equal(c.linkedin, "auto");
    assert.equal(c.facebook, "auto");
    assert.equal(c.source, "skip_flag_empty");
  });

  it("'newsletter' → só newsletter manual", () => {
    const c = parseSkipFlag("newsletter");
    assert.ok(c);
    assert.equal(c.newsletter, "manual");
    assert.equal(c.linkedin, "auto");
    assert.equal(c.facebook, "auto");
    assert.ok(c.source.includes("newsletter"));
  });

  it("'linkedin,facebook' → linkedin + facebook manual", () => {
    const c = parseSkipFlag("linkedin,facebook");
    assert.ok(c);
    assert.equal(c.newsletter, "auto");
    assert.equal(c.linkedin, "manual");
    assert.equal(c.facebook, "manual");
  });

  it("'newsletter,linkedin,facebook' → tudo manual", () => {
    const c = parseSkipFlag("newsletter,linkedin,facebook");
    assert.ok(c);
    assert.equal(c.newsletter, "manual");
    assert.equal(c.linkedin, "manual");
    assert.equal(c.facebook, "manual");
  });

  it("case-insensitive", () => {
    const c = parseSkipFlag("NEWSLETTER,LinkedIn");
    assert.ok(c);
    assert.equal(c.newsletter, "manual");
    assert.equal(c.linkedin, "manual");
    assert.equal(c.facebook, "auto");
  });

  it("token inválido → null", () => {
    assert.equal(parseSkipFlag("invalid"), null);
    assert.equal(parseSkipFlag("newsletter,invalid"), null);
    assert.equal(parseSkipFlag("123"), null);
  });

  it("'instagram' → só instagram manual (#49)", () => {
    const c = parseSkipFlag("instagram");
    assert.ok(c, "instagram deve ser um canal válido em --skip");
    assert.equal(c.instagram, "manual");
    assert.equal(c.newsletter, "auto");
    assert.equal(c.linkedin, "auto");
    assert.equal(c.facebook, "auto");
    assert.equal(c.threads, "auto");
  });

  it("'threads' → só threads manual (#2479)", () => {
    const c = parseSkipFlag("threads");
    assert.ok(c, "threads deve ser um canal válido em --skip");
    assert.equal(c.threads, "manual");
    assert.equal(c.newsletter, "auto");
    assert.equal(c.linkedin, "auto");
    assert.equal(c.facebook, "auto");
    assert.equal(c.instagram, "auto");
  });

  it("aceita whitespace separators", () => {
    const c = parseSkipFlag("newsletter linkedin");
    assert.ok(c);
    assert.equal(c.newsletter, "manual");
    assert.equal(c.linkedin, "manual");
  });

  it("source ordena canais alfabeticamente pra hash estável", () => {
    const a = parseSkipFlag("facebook,linkedin");
    const b = parseSkipFlag("linkedin,facebook");
    assert.equal(a?.source, b?.source);
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

  it("número fora do range 1-10 → null (#2479: range estendido pra Threads)", () => {
    assert.equal(parseEditorResponse("11"), null);
    assert.equal(parseEditorResponse("0,1"), null);
  });

  it("'7' → Instagram auto (canais não mencionados ficam manual) (#49)", () => {
    const c = parseEditorResponse("7");
    assert.ok(c);
    assert.equal(c.instagram, "auto");
    assert.equal(c.newsletter, "manual");
    assert.equal(c.linkedin, "manual");
    assert.equal(c.facebook, "manual");
  });

  it("'8' → Instagram manual (#49)", () => {
    const c = parseEditorResponse("8");
    assert.ok(c);
    assert.equal(c.instagram, "manual");
  });

  it("'1,3,5,7' → tudo auto incluindo Instagram (#49)", () => {
    const c = parseEditorResponse("1,3,5,7");
    assert.ok(c);
    assert.equal(c.newsletter, "auto");
    assert.equal(c.linkedin, "auto");
    assert.equal(c.facebook, "auto");
    assert.equal(c.instagram, "auto");
  });

  it("'9' → Threads auto (canais não mencionados ficam manual) (#2479)", () => {
    const c = parseEditorResponse("9");
    assert.ok(c);
    assert.equal(c.threads, "auto");
    assert.equal(c.newsletter, "manual");
    assert.equal(c.linkedin, "manual");
    assert.equal(c.facebook, "manual");
    assert.equal(c.instagram, "manual");
  });

  it("'10' → Threads manual (#2479)", () => {
    const c = parseEditorResponse("10");
    assert.ok(c);
    assert.equal(c.threads, "manual");
  });

  it("'1,3,5,7,9' → tudo auto incluindo Instagram + Threads (#2479)", () => {
    const c = parseEditorResponse("1,3,5,7,9");
    assert.ok(c);
    assert.equal(c.newsletter, "auto");
    assert.equal(c.linkedin, "auto");
    assert.equal(c.facebook, "auto");
    assert.equal(c.instagram, "auto");
    assert.equal(c.threads, "auto");
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
      hasAnyAutoChannel({ newsletter: "manual", linkedin: "auto", facebook: "manual", instagram: "manual", threads: "manual", source: "x" }),
      true,
    );
  });
  it("true quando só threads é auto (#2479)", () => {
    assert.equal(
      hasAnyAutoChannel({ newsletter: "manual", linkedin: "manual", facebook: "manual", instagram: "manual", threads: "auto", source: "x" }),
      true,
    );
  });
  it("false quando tudo manual ou skipped", () => {
    assert.equal(hasAnyAutoChannel(defaultManualConsent()), false);
    assert.equal(
      hasAnyAutoChannel({ newsletter: "skipped", linkedin: "skipped", facebook: "manual", instagram: "manual", threads: "manual", source: "x" }),
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
      allChannelsSkipped({ newsletter: "skipped", linkedin: "skipped", facebook: "auto", instagram: "skipped", threads: "skipped", source: "x" }),
      false,
    );
  });
  it("false quando threads não-skipped mas resto skipped (#2479)", () => {
    assert.equal(
      allChannelsSkipped({ newsletter: "skipped", linkedin: "skipped", facebook: "skipped", instagram: "skipped", threads: "manual", source: "x" }),
      false,
    );
  });
});
