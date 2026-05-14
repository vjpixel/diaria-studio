/**
 * validate-test-with-publish.test.ts (#1267)
 *
 * Tests do validator que verifica que /diaria-test --with-publish não
 * skippou Beehiiv com motivo ilegítimo (rationalização tipo "complexity").
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { validate } from "../scripts/validate-test-with-publish.ts";

describe("validate-test-with-publish (#1267)", () => {
  describe("quando with_publish=false", () => {
    it("retorna ok mesmo sem 05-published.json", () => {
      const r = validate(false, null);
      assert.equal(r.ok, true);
      assert.match(r.reason || "", /with_publish=false/);
    });

    it("retorna ok com qualquer status", () => {
      const r = validate(false, { status: "skipped" });
      assert.equal(r.ok, true);
    });
  });

  describe("quando with_publish=true", () => {
    it("FALHA se 05-published.json ausente", () => {
      const r = validate(true, null);
      assert.equal(r.ok, false);
      assert.match(r.reason || "", /05-published\.json ausente/);
    });

    it("ok quando status=draft com draft_url populado (caminho feliz)", () => {
      const r = validate(true, {
        status: "draft",
        draft_url: "https://app.beehiiv.com/posts/abc123/edit",
      });
      assert.equal(r.ok, true);
      assert.equal(r.details?.draft_url, "https://app.beehiiv.com/posts/abc123/edit");
    });

    it("FALHA quando status=draft mas draft_url ausente (regressão silenciosa)", () => {
      const r = validate(true, { status: "draft" });
      assert.equal(r.ok, false);
      assert.match(r.reason || "", /draft_url ausente/);
    });

    it("ok quando status=skipped com motivo legítimo (upstream_eia_missing)", () => {
      const r = validate(true, {
        status: "skipped",
        skip_reason: "upstream_eia_missing",
      });
      assert.equal(r.ok, true);
      assert.match(r.reason || "", /[Ss]kip leg.timo/);
    });

    it("ok quando status=skipped com chrome_mcp_unavailable", () => {
      const r = validate(true, {
        status: "skipped",
        skip_reason: "chrome_mcp_unavailable",
      });
      assert.equal(r.ok, true);
    });

    // O caso central do #1267: motivo "complexity" é INVÁLIDO
    it("FALHA quando status=skipped com motivo 'test_mode_beehiiv_playbook_complexity' (caso #1267)", () => {
      const r = validate(true, {
        status: "skipped",
        skip_reason: "test_mode_beehiiv_playbook_complexity",
      });
      assert.equal(r.ok, false);
      assert.match(r.reason || "", /motivo INV.LIDO/);
      assert.match(r.reason || "", /complexity/);
    });

    it("FALHA quando status=skipped sem skip_reason", () => {
      const r = validate(true, { status: "skipped" });
      assert.equal(r.ok, false);
      assert.match(r.reason || "", /motivo INV.LIDO/);
    });

    it("ok quando status=published (real publication)", () => {
      const r = validate(true, { status: "published" });
      assert.equal(r.ok, true);
    });

    it("ok-soft quando status=pending_manual (estado em curso)", () => {
      const r = validate(true, { status: "pending_manual" });
      assert.equal(r.ok, true);
      assert.match(r.reason || "", /soft accept/);
    });
  });
});
