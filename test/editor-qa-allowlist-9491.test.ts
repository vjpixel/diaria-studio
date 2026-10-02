/**
 * #9491 — e-mails editor/QA entram nas allowlists de apoio (Retrospectiva + Artigo Especial),
 * vindos do env (nunca do código público).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseEditorQaEmails, readEditorQaEmails } from "../scripts/lib/shared/editor-qa-emails.ts";
import { withEditorQaEmails } from "../scripts/build-apoiador-allowlist.ts";
import { withEditorQaRows } from "../scripts/sync-artigos-apoio-kv.ts";

describe("editor QA emails (#9491)", () => {
  it("parseia CSV, normaliza, deduplica e descarta lixo", () => {
    assert.deepEqual(parseEditorQaEmails(" B@x.com, a@x.com;A@X.com\nnaoemail "), ["a@x.com", "b@x.com"]);
  });
  it("env ausente/vazio = lista vazia (comportamento anterior)", () => {
    assert.deepEqual(readEditorQaEmails({}), []);
    assert.deepEqual(readEditorQaEmails({ EDITOR_QA_EMAILS: "" }), []);
  });
  it("Retrospectiva: QA entra na allowlist, sem duplicar apoiador", () => {
    assert.deepEqual(withEditorQaEmails(["ap@x.com", "qa@x.com"], ["qa@x.com", "z@x.com"]), ["ap@x.com", "qa@x.com", "z@x.com"]);
    assert.deepEqual(withEditorQaEmails(["ap@x.com"], []), ["ap@x.com"]);
  });
  it("Artigo Especial: QA entra como patrono e não rebaixa apoiador existente", () => {
    const rows = withEditorQaRows([{ email: "qa@x.com", nivel: "mantenedor" }, { email: "a@x.com", nivel: "amigo" }], ["qa@x.com", "new@x.com"]);
    assert.deepEqual(rows.find((r) => r.email === "qa@x.com")?.nivel, "mantenedor");
    assert.deepEqual(rows.find((r) => r.email === "new@x.com")?.nivel, "patrono");
    assert.equal(rows.length, 3);
  });
  it("nenhum e-mail pessoal do editor hardcoded nos Workers", () => {
    for (const f of ["workers/retrospectiva/src/gate-apoio.ts", "workers/artigos/src/apoio-gate.ts"]) {
      assert.ok(!/vjpixel@gmail\.com/i.test(readFileSync(new URL(`../${f}`, import.meta.url), "utf8")), f);
    }
  });
});
