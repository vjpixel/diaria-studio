/**
 * backup-beehiiv.test.ts (#1742)
 *
 * Cobre os helpers puros do backup full do Beehiiv: enumeração de endpoints
 * (garante que o escopo declarado na issue está coberto), sumarização do
 * manifest e helpers de path/data. Sem rede — a parte de IO/fetch é exercida
 * manualmente via `--dry-run` / `--posts-limit`.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  publicationEndpoints,
  summarizeManifest,
  backupDir,
  isoDate,
  MCP_ONLY_GAPS,
  type ManifestEntry,
} from "../scripts/backup-beehiiv.ts";

describe("publicationEndpoints (#1742)", () => {
  const eps = publicationEndpoints("pub_123");

  it("inclui as categorias do escopo da issue", () => {
    const keys = new Set(eps.map((e) => e.key));
    for (const required of ["publication", "custom_fields", "segments", "automations", "tiers", "referral_program"]) {
      assert.ok(keys.has(required), `falta endpoint: ${required}`);
    }
  });

  it("embute o publicationId em todos os paths", () => {
    for (const e of eps) {
      assert.ok(e.path.includes("pub_123"), `${e.key} não tem pubId: ${e.path}`);
    }
  });

  it("custom_fields é paginado e não-opcional (poll_sig é crítico)", () => {
    const cf = eps.find((e) => e.key === "custom_fields")!;
    assert.equal(cf.paginated, true);
    assert.notEqual(cf.optional, true);
  });

  it("endpoints de plano-dependente são opcionais (404 tolerado)", () => {
    for (const key of ["automations", "email_blasts", "tiers", "referral_program"]) {
      const ep = eps.find((e) => e.key === key)!;
      assert.equal(ep.optional, true, `${key} deveria ser optional`);
    }
  });

  it("publication expande stats", () => {
    const pub = eps.find((e) => e.key === "publication")!;
    assert.ok(pub.path.includes("expand[]=stats"));
  });
});

describe("summarizeManifest (#1742)", () => {
  const endpoints: ManifestEntry[] = [
    { key: "publication", file: "publication.json", status: "ok", count: 1 },
    { key: "custom_fields", file: "custom-fields.json", status: "ok", count: 3 },
    { key: "automations", file: "automations.json", status: "skipped" },
    { key: "email_blasts", file: "email-blasts.json", status: "error", error: "boom" },
  ];
  const m = summarizeManifest({
    generatedAt: "2026-06-03T00:00:00.000Z",
    publicationId: "pub_123",
    apiBase: "https://api.beehiiv.com/v2",
    options: { subscribers: true, content: true, posts_limit: null, dry_run: false },
    endpoints,
    posts: { fetched: 10, errors: 1 },
    subscribers: { fetched: 4200 },
  });

  it("conta totals por status", () => {
    assert.deepEqual(m.totals, { ok: 2, skipped: 1, error: 1 });
  });

  it("preserva contagens de posts e subscribers", () => {
    assert.equal(m.posts.fetched, 10);
    assert.equal(m.posts.errors, 1);
    assert.equal(m.subscribers?.fetched, 4200);
  });

  it("sinaliza os gaps MCP-only pra não dar falsa sensação de exaustivo", () => {
    assert.deepEqual(m.mcp_only_gaps, MCP_ONLY_GAPS);
    assert.ok(m.mcp_only_gaps.length >= 2);
  });

  it("carimba api_base e generated_at", () => {
    assert.equal(m.api_base, "https://api.beehiiv.com/v2");
    assert.equal(m.generated_at, "2026-06-03T00:00:00.000Z");
  });
});

describe("path/date helpers (#1742)", () => {
  it("backupDir aninha a data sob o root", () => {
    const d = backupDir("/tmp/bk", "2026-06-03");
    assert.ok(d.replaceAll("\\", "/").endsWith("/tmp/bk/2026-06-03".replace("/tmp", "/tmp")));
    assert.ok(d.includes("2026-06-03"));
  });

  it("isoDate formata YYYY-MM-DD em UTC", () => {
    assert.equal(isoDate(new Date("2026-06-03T14:25:00.000Z")), "2026-06-03");
    assert.equal(isoDate(new Date("2026-12-31T23:59:59.000Z")), "2026-12-31");
  });
});
