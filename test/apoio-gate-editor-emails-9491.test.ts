/**
 * test/apoio-gate-editor-emails-9491.test.ts (#9491)
 *
 * O editor (que não é apoiador) recebia "não é apoiador" na Retrospectiva e no
 * Artigo Especial ao conferir o que o apoiador vê: as duas allowlists derivam
 * só do CRM de Apoios. A correção acrescenta os e-mails de
 * `platform.config.json` → `apoio_gate_editor_emails.emails` nas DUAS
 * gravações de KV, sem tocar no fail-closed dos Workers.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  parseApoioGateEditorEmails,
  readApoioGateEditorEmails,
  mergeEditorEmails,
} from "../scripts/lib/apoio-gate-editor-emails.ts";
import { decideAllowlistPush, evaluateAllowlistBlastRadius } from "../scripts/build-apoiador-allowlist.ts";
import { buildKvBulkEntries, withEditorRows, EDITOR_APOIO_NIVEL } from "../scripts/sync-artigos-apoio-kv.ts";
import { apoioLevelKvKey, meetsApoioThreshold } from "../scripts/lib/shared/apoio-level-verify.ts";
import { ARTIGOS_ESPECIAIS_APOIO_THRESHOLD } from "../workers/artigos/src/apoio-gate-config.ts";
import { decideApoioGate, parseAllowlist } from "../workers/retrospectiva/src/gate-apoio.ts";

const REPO_ROOT = resolve(import.meta.dirname, "..");

describe("#9491 — parseApoioGateEditorEmails: config → lista de editores", () => {
  it("config ausente / sem a chave / formato errado → sem extras", () => {
    for (const cfg of [null, undefined, {}, { apoio_gate_editor_emails: null }, { apoio_gate_editor_emails: "x@y.com" }, { apoio_gate_editor_emails: { emails: "x@y.com" } }]) {
      assert.deepEqual(parseApoioGateEditorEmails(cfg), [], JSON.stringify(cfg));
    }
  });

  it("normaliza (trim + minúsculas), deduplica, descarta não-e-mail", () => {
    const cfg = { apoio_gate_editor_emails: { emails: ["  Editor@X.com ", "editor@x.com", "", 7, "sem-arroba", "qa@x.com"] } };
    assert.deepEqual(parseApoioGateEditorEmails(cfg), ["editor@x.com", "qa@x.com"]);
  });

  it("arquivo ausente → []; JSON quebrado LANÇA (não confunde com 'sem editores')", () => {
    const dir = mkdtempSync(join(tmpdir(), "editor-emails-"));
    try {
      assert.deepEqual(readApoioGateEditorEmails(dir), []);
      writeFileSync(join(dir, "platform.config.json"), "{ quebrado", "utf8");
      assert.throws(() => readApoioGateEditorEmails(dir), /não pôde ser parseado/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a config real do repo tem o e-mail do editor", () => {
    assert.ok(readApoioGateEditorEmails(REPO_ROOT).includes("vjpixel@gmail.com"));
  });
});

describe("#9491 — mergeEditorEmails: une sem duplicar", () => {
  it("editor que já é apoiador não duplica nem aparece como editor", () => {
    const r = mergeEditorEmails(["a@x.com", "Ed@x.com"], ["ed@x.com", "qa@x.com"]);
    assert.deepEqual(r.merged, ["a@x.com", "ed@x.com", "qa@x.com"]);
    assert.deepEqual(r.editorsOnly, ["qa@x.com"]);
  });

  it("sem editores → a lista dos apoiadores, intacta", () => {
    assert.deepEqual(mergeEditorEmails(["b@x.com", "a@x.com"], []).merged, ["a@x.com", "b@x.com"]);
  });
});

describe("#9491 — Retrospectiva: push inclui o editor e o gate o deixa entrar", () => {
  it("regressão: o JSON gravado no KV contém o editor, e o gate (fail-closed) libera", () => {
    const { merged } = mergeEditorEmails(["apoiador@x.com"], ["vjpixel@gmail.com"]);
    const allowlist = parseAllowlist(JSON.stringify(merged));
    assert.deepEqual(decideApoioGate("VJPixel@gmail.com", allowlist), { state: "allowed" });
    // fail-closed intacto: allowlist indisponível segue recusando até o editor.
    assert.deepEqual(decideApoioGate("vjpixel@gmail.com", parseAllowlist(null)), { state: "not_backer" });
  });

  it("diff marca o editor à parte e o tira do blast radius", () => {
    const r = evaluateAllowlistBlastRadius(
      ["a@x.com", "ed@x.com"],
      ["a@x.com", "b@x.com"],
      false,
      ["ed@x.com"],
    );
    assert.deepEqual(r.entram, []);
    assert.deepEqual(r.saem, ["b@x.com"]);
    assert.deepEqual(r.editores, { entram: ["ed@x.com"], inalterados: [] });
    assert.equal(r.currentCount, 2);
  });

  it("editor já presente não dilui a razão de remoção dos apoiadores", () => {
    // 10 apoiadores + editor no KV: o denominador é 10, não 11 — o editor não
    // conta como apoiador nem pra diluir a razão de remoção.
    const apoiadores = Array.from({ length: 10 }, (_, i) => `a${i}@x.com`);
    const current = [...apoiadores, "ed@x.com"];
    const next = [...apoiadores.slice(4), "ed@x.com"];
    const r = evaluateAllowlistBlastRadius(next, current, false, ["ed@x.com"]);
    assert.equal(r.currentCount, 10);
    assert.equal(r.saem.length, 4);
    assert.equal(r.blocked, true);
    assert.deepEqual(r.editores.inalterados, ["ed@x.com"]);
  });

  it("decideAllowlistPush segue recusando leitura corrompida mesmo com editor", async () => {
    const d = await decideAllowlistPush({
      next: ["ed@x.com"],
      force: false,
      editors: ["ed@x.com"],
      readCurrent: async () => "{{{",
    });
    assert.equal(d.action, "refuse");
  });
});

describe("#9491 — Artigo Especial: editor entra no KV com nível que passa no limiar", () => {
  it("regressão: chave do editor gravada com patrono, acima do limiar do gate", async () => {
    const entries = await buildKvBulkEntries(withEditorRows([{ email: "a@x.com", nivel: "apoiador" }], ["vjpixel@gmail.com"]));
    const key = await apoioLevelKvKey("VJPixel@gmail.com ");
    assert.deepEqual(entries.find((e) => e.key === key), { key, value: EDITOR_APOIO_NIVEL });
    assert.ok(meetsApoioThreshold(EDITOR_APOIO_NIVEL, ARTIGOS_ESPECIAIS_APOIO_THRESHOLD));
    assert.equal(entries.length, 2);
  });

  it("editor que já é apoiador fica com o MAIOR nível, uma chave só", async () => {
    const entries = await buildKvBulkEntries(withEditorRows([{ email: "ed@x.com", nivel: "amigo" }], ["ed@x.com"]));
    assert.deepEqual(entries, [{ key: await apoioLevelKvKey("ed@x.com"), value: "patrono" }]);
  });

  it("sem editores → linhas inalteradas", () => {
    const rows = [{ email: "a@x.com", nivel: "apoiador" as const }];
    assert.deepEqual(withEditorRows(rows, []), rows);
  });
});
