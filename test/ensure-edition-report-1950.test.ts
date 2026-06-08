/**
 * test/ensure-edition-report-1950.test.ts (#1950)
 *
 * Garante que o refresh-dedup gera o `edition-report.html` quando uma edição
 * publicada não tem o relatório (caso publish manual / Stage 4 interrompido —
 * caso 260608). Cobre: gera-quando-falta, idempotência, e safety (sem edition
 * dir local → no-op).
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, existsSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureEditionReport } from "../scripts/refresh-dedup.ts";

const roots: string[] = [];
function tmpRoot(): string {
  const r = mkdtempSync(join(tmpdir(), "ensure-report-"));
  roots.push(r);
  return r;
}
after(() => {
  for (const r of roots) {
    try {
      rmSync(r, { recursive: true, force: true });
    } catch {
      /* noop */
    }
  }
});

const post = (pub: string) => ({ id: "p", published_at: pub } as never);

describe("ensureEditionReport (#1950)", () => {
  it("gera edition-report.html quando a edição publicada não tem", () => {
    const root = tmpRoot();
    const dir = join(root, "260608");
    mkdirSync(join(dir, "_internal"), { recursive: true });
    const gen = ensureEditionReport(root, post("2026-06-08T09:00:00Z"));
    assert.equal(gen, true);
    assert.ok(existsSync(join(dir, "_internal", "edition-report.html")));
    // manifest md5 também escrito (#1579)
    assert.ok(existsSync(join(dir, "_internal", ".edition-report-md5.txt")));
  });

  it("é idempotente — não regenera se o relatório já existe", () => {
    const root = tmpRoot();
    const dir = join(root, "260608");
    mkdirSync(join(dir, "_internal"), { recursive: true });
    writeFileSync(join(dir, "_internal", "edition-report.html"), "<html>existente</html>", "utf8");
    const gen = ensureEditionReport(root, post("2026-06-08T09:00:00Z"));
    assert.equal(gen, false);
  });

  it("não cria nada quando a edição não existe local (scheduling futuro)", () => {
    const root = tmpRoot();
    const gen = ensureEditionReport(root, post("2099-01-01T00:00:00Z"));
    assert.equal(gen, false);
    assert.ok(!existsSync(join(root, "990101")));
  });
});
