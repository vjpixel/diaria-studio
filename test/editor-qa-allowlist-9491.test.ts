/**
 * #9491 — e-mails editor/QA entram nas allowlists de apoio (Retrospectiva + Artigo Especial),
 * vindos do env (nunca do código público).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseEditorQaEmails, readEditorQaEmails } from "../scripts/lib/shared/editor-qa-emails.ts";
import { withEditorQaEmails } from "../scripts/build-apoiador-allowlist.ts";
import { apoioLevelKvKey } from "../scripts/lib/shared/apoio-level-verify.ts";
import { withEditorQaRows, buildKvBulkEntries } from "../scripts/sync-artigos-apoio-kv.ts";

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
  it("Artigo Especial: QA vira patrono, inclusive se já for apoiador amigo; nunca rebaixa", async () => {
    const rows = withEditorQaRows([{ email: "qa@x.com", nivel: "amigo" }, { email: "a@x.com", nivel: "amigo" }], ["qa@x.com", "new@x.com"]);
    const entries = await buildKvBulkEntries(rows);
    const lvl = async (e: string) => entries.find((x) => x.key === k[e])?.value;
    const k: Record<string, string> = {};
    for (const e of ["qa@x.com", "a@x.com", "new@x.com"]) k[e] = await apoioLevelKvKey(e);
    assert.equal(await lvl("qa@x.com"), "patrono");
    assert.equal(await lvl("new@x.com"), "patrono");
    assert.equal(await lvl("a@x.com"), "amigo");
  });
  it("nenhum e-mail pessoal do editor hardcoded nos Workers", () => {
    for (const f of ["workers/retrospectiva/src/gate-apoio.ts", "workers/artigos/src/apoio-gate.ts"]) {
      assert.ok(!/[\w.+-]+@[\w-]+\.[\w.]+/.test(readFileSync(new URL(`../${f}`, import.meta.url), "utf8")), f);
    }
  });
});
