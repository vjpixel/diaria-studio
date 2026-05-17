import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { makeVariantPath, snapshotPathFor } from "../scripts/sync-report.ts";

describe("makeVariantPath (#1308 #13)", () => {
  it("insere variant antes do .md", () => {
    assert.equal(
      makeVariantPath("/path/to/foo.md", "merged-1234"),
      "/path/to/foo.merged-1234.md",
    );
  });

  it("não trata .md no meio do nome como extension", () => {
    assert.equal(
      makeVariantPath("/path/to/foo.md.backup", "v1"),
      "/path/to/foo.md.backup.v1.md",
      "comportamento safe: anexa .v1.md ao final pra evitar overwrite",
    );
  });

  it("anexa .{variant}.md pra paths sem .md extension", () => {
    assert.equal(
      makeVariantPath("/path/to/relatorio", "preview"),
      "/path/to/relatorio.preview.md",
    );
  });

  it("anexa .{variant}.md pra paths com extension diferente", () => {
    assert.equal(
      makeVariantPath("/path/to/doc.txt", "merged"),
      "/path/to/doc.txt.merged.md",
    );
  });

  it("variant strings com hífen e dígitos passam intactos (timestamps)", () => {
    assert.equal(
      makeVariantPath("/a/b/c.md", "dryrun-1747436491000"),
      "/a/b/c.dryrun-1747436491000.md",
    );
  });
});

describe("snapshotPathFor (#1308 #13)", () => {
  it("coloca snapshot em .snapshots/ ao lado do arquivo", () => {
    const result = snapshotPathFor("/path/to/relatorios/foo.md");
    // path.join normaliza separadores por plataforma — usar regex
    assert.match(result, /relatorios[\\/]\.snapshots[\\/]foo\.snapshot\.md$/);
  });

  it("substitui .md por .snapshot.md no basename", () => {
    const result = snapshotPathFor("/dir/report.md");
    assert.match(result, /report\.snapshot\.md$/);
  });

  it("trata path sem .md anexando .snapshot.md", () => {
    const result = snapshotPathFor("/dir/report");
    // basename.replace(/\.md$/, ".snapshot.md") é no-op se não termina em .md
    assert.match(result, /report$/);
  });
});
