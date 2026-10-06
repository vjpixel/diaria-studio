/**
 * #9718 — `classifySocialDiff` compara cada seção com a sua própria seção
 * (bloco + nome: `# Curto ## d1` não sobrescreve mais `# Social ## d1`),
 * casa destaque por URL (o `01-approved.json` de cada lado) e normaliza CRLF.
 *
 * Fixtures REAIS em `test/fixtures/derive-editor-requests-9718/{261005,261006}/`:
 * os `03-social.md` dos snapshots `stage2-post-gate` (baseline) e
 * `stage4-post-gate` (aprovado) e as URLs dos destaques de cada
 * `01-approved.json` (reduzido a `highlights[].url`). Em 261005 a correção
 * factual do d2 no texto longo ("A empresa que mais fala em segurança" →
 * "A OpenAI") não entrava na contagem porque o Curto do d2 não mudou.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { classifySocialDiff } from "../scripts/derive-editor-requests.ts";
import { destaqueUrlMapFromApproved } from "../scripts/lib/social-rewrite-diff.ts";

const PROJECT_ROOT = join(import.meta.dirname, "..");
const FIX = join(PROJECT_ROOT, "test", "fixtures", "derive-editor-requests-9718");
const read = (...p: string[]) => readFileSync(join(FIX, ...p), "utf8");

function fixture(edition: string) {
  return {
    oldMd: read(edition, "stage2-post-gate", "03-social.md"),
    newMd: read(edition, "stage4-post-gate", "03-social.md"),
    oldApproved: read(edition, "stage2-post-gate", "01-approved.json"),
    newApproved: read(edition, "stage4-post-gate", "01-approved.json"),
  };
}

function classifyFixture(edition: string) {
  const f = fixture(edition);
  return classifySocialDiff(f.oldMd, f.newMd, destaqueUrlMapFromApproved(f.newApproved), destaqueUrlMapFromApproved(f.oldApproved));
}

const key = (r: { context?: Record<string, unknown> }) => {
  const c = r.context as Record<string, unknown>;
  return `${c.block}/${c.baseline_section ? `${c.baseline_section}→` : ""}${c.section}`;
};

describe("classifySocialDiff — bloco + seção, URL, CRLF (#9718)", () => {
  it("261005: a correção factual do d2 no texto LONGO entra; troca de destaque/item e Curto idêntico não", () => {
    const out = classifyFixture("261005");
    assert.ok(out.every((r) => r.request_type === "social-rewrite"));
    assert.deepEqual(out.map(key).sort(), ["curto/d3→d1", "social/d2", "social/d3→d1"]);

    const d2 = out.find((r) => key(r) === "social/d2")!;
    assert.equal(d2.target, "d2");
    assert.equal(
      (d2.context as Record<string, unknown>).url,
      "https://www.theguardian.com/technology/2026/oct/03/openai-safety-leader-quits-warning-ai-companys-culture-is-broken",
    );
    // O texto comparado é o LONGO (~550 chars), não o Curto (~190).
    assert.ok(((d2.context as Record<string, unknown>).old_length as number) > 400);

    // context.url é da MESMA história comparada (Clef, que foi de d3 pra d1).
    const d1 = out.find((r) => key(r) === "social/d3→d1")!;
    assert.equal((d1.context as Record<string, unknown>).url, "https://blog.cloudflare.com/clef-decision-models");
    assert.equal((d1.context as Record<string, unknown>).matched_by, "url");
  });

  it("261006: reordenar sem editar (Gartner d1→d2, Curto inteiro) não gera nada; só as 2 seções editadas", () => {
    const out = classifyFixture("261006");
    assert.deepEqual(out.map(key).sort(), ["social/d2→d3", "social/d3→d1"]);
    const gpts = out.find((r) => key(r) === "social/d3→d1")!;
    assert.equal((gpts.context as Record<string, unknown>).source_changed, true);
    assert.equal(
      (gpts.context as Record<string, unknown>).url,
      "https://help.openai.com/en/articles/20001519-custom-gpt-retirement-and-migration-faq",
    );
  });

  it("Curto não sobrescreve Social: edição só no texto longo do d1 vira 1 entrada do bloco social", () => {
    const build = (longo: string) =>
      ["# Social", "", "## d1", longo, "", "# Curto", "", "## d1", "Texto curto estável sobre o mesmo assunto.", ""].join("\n");
    const urls = new Map([["d1", "https://example.com/a"]]);
    const out = classifySocialDiff(
      build("Texto longo original sobre agentes autônomos dentro das empresas."),
      build("Texto longo corrigido sobre agentes autônomos dentro das empresas grandes."),
      urls,
      urls,
    );
    assert.deepEqual(out.map(key), ["social/d1"]);
  });

  it("CRLF no snapshot e LF no arquivo final (260928) não conta como mudança", () => {
    const lf = ["# Social", "", "## d1", "Mesmo texto.", "", "## post_pixel", "Outro texto.", ""].join("\n");
    const urls = new Map([["d1", "https://example.com/a"]]);
    assert.deepEqual(classifySocialDiff(lf.replace(/\n/g, "\r\n"), lf, urls, urls), []);
  });

  it("destaque trocado (URL nova sem par) não vira social-rewrite — a troca já é destaque-swap", () => {
    const build = (t: string) => ["# Social", "", "## d1", t, ""].join("\n");
    const out = classifySocialDiff(
      build("História sobre chips de memória e fábricas na Ásia."),
      build("História completamente diferente sobre regulação europeia de modelos."),
      new Map([["d1", "https://example.com/nova"]]),
      new Map([["d1", "https://example.com/antiga"]]),
    );
    assert.deepEqual(out, []);
  });
});

describe("derive-stage4 usa o 01-approved.json do snapshot como URL do lado antigo (#9718)", () => {
  it("fixture 261005 de ponta a ponta: 3 social-rewrite, incluindo o d2 longo", () => {
    const dir = mkdtempSync(join(tmpdir(), "derive-9718-"));
    try {
      const f = fixture("261005");
      const editionDir = join(dir, "261005");
      mkdirSync(join(editionDir, "_internal"), { recursive: true });
      writeFileSync(join(editionDir, "03-social.md"), f.oldMd, "utf8");
      writeFileSync(join(editionDir, "_internal", "01-approved.json"), f.oldApproved, "utf8");
      const run = (args: string[]) =>
        spawnSync(process.execPath, ["--import", "tsx", join(PROJECT_ROOT, "scripts", "derive-editor-requests.ts"), ...args], {
          cwd: PROJECT_ROOT,
          encoding: "utf8",
          timeout: 15000,
        });
      assert.equal(run(["snapshot-stage2", "--edition", "261005", "--editions-dir", dir]).status, 0);
      writeFileSync(join(editionDir, "03-social.md"), f.newMd, "utf8");
      writeFileSync(join(editionDir, "_internal", "01-approved.json"), f.newApproved, "utf8");
      const r = run(["derive-stage4", "--edition", "261005", "--editions-dir", dir]);
      assert.equal(r.status, 0, r.stderr);

      const outPath = join(editionDir, "_internal", "editor-requests.jsonl");
      assert.ok(existsSync(outPath));
      const rewrites = readFileSync(outPath, "utf8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l))
        .filter((e) => e.request_type === "social-rewrite");
      assert.deepEqual(rewrites.map(key).sort(), ["curto/d3→d1", "social/d2", "social/d3→d1"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
