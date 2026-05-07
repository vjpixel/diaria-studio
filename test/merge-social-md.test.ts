import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripHtmlComments } from "../scripts/merge-social-md.ts";

function makeEditionDir(): string {
  const root = mkdtempSync(join(tmpdir(), "merge-social-"));
  mkdirSync(join(root, "_internal"), { recursive: true });
  return root;
}

function runScript(editionDir: string): {
  status: number | null;
  stdout: string;
  stderr: string;
} {
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "scripts/merge-social-md.ts",
      "--edition-dir",
      editionDir,
    ],
    { encoding: "utf8" },
  );
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

describe("stripHtmlComments (#875)", () => {
  it("strip de comentários balanceados retorna conteúdo limpo", () => {
    const input = "antes <!-- comentário --> depois";
    const r = stripHtmlComments(input);
    assert.equal(r.stripped, "antes  depois");
    assert.equal(r.warnings.length, 0);
  });

  it("input sem comentários passa intacto (modulo collapse de newlines)", () => {
    const r = stripHtmlComments("nada aqui");
    assert.equal(r.stripped, "nada aqui");
  });

  it("colapsa ≥3 newlines em 2", () => {
    const r = stripHtmlComments("a\n\n\n\nb");
    assert.equal(r.stripped, "a\n\nb");
  });

  it("comment não-fechado (`<!-- abc` sem `-->`) lança erro", () => {
    assert.throws(
      () => stripHtmlComments("texto <!-- abc sem fim"),
      /mal-formados.*1.*0/,
    );
  });

  it("comment órfão `-->` sem `<!--` lança erro", () => {
    assert.throws(
      () => stripHtmlComments("texto sem inicio --> finale"),
      /mal-formados.*0.*1/,
    );
  });

  it("comment nested (`<!-- a <!-- b --> c -->`) handle gracefully", () => {
    const input = "antes <!-- a <!-- b --> c --> depois";
    const r = stripHtmlComments(input);
    assert.equal(r.stripped, "antes  depois");
    assert.ok(r.warnings.some((w) => w.includes("nested")));
  });

  it("multiple comments balanceados strip todos", () => {
    const input = "<!-- 1 -->A<!-- 2 -->B<!-- 3 -->C";
    const r = stripHtmlComments(input);
    assert.equal(r.stripped, "ABC");
  });

  it("comments multilinhas funcionam", () => {
    const input = "antes\n<!--\n  multi\n  linha\n-->\ndepois";
    const r = stripHtmlComments(input);
    assert.equal(r.stripped, "antes\n\ndepois");
  });
});

describe("merge-social-md CLI", () => {
  it("happy path — ambos tmps válidos → merge OK + tmps deletados", () => {
    const dir = makeEditionDir();
    writeFileSync(
      join(dir, "_internal", "03-linkedin.tmp.md"),
      "## d1\n\nLinkedIn d1 content\n\n## d2\n\nLinkedIn d2 content\n",
    );
    writeFileSync(
      join(dir, "_internal", "03-facebook.tmp.md"),
      "## d1\n\nFacebook d1 content\n",
    );

    const r = runScript(dir);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);

    const out = readFileSync(join(dir, "03-social.md"), "utf8");
    assert.ok(out.startsWith("# LinkedIn\n\n"));
    assert.ok(out.includes("LinkedIn d1 content"));
    assert.ok(out.includes("# Facebook\n\n"));
    assert.ok(out.includes("Facebook d1 content"));

    // Tmps deletados após sucesso
    assert.equal(
      existsSync(join(dir, "_internal", "03-linkedin.tmp.md")),
      false,
    );
    assert.equal(
      existsSync(join(dir, "_internal", "03-facebook.tmp.md")),
      false,
    );
  });

  it("LinkedIn tmp ausente → exit 1 com nome do agent", () => {
    const dir = makeEditionDir();
    // Só Facebook tmp
    writeFileSync(
      join(dir, "_internal", "03-facebook.tmp.md"),
      "## d1\n\nFacebook content\n",
    );

    const r = runScript(dir);
    assert.equal(r.status, 1);
    assert.ok(r.stderr.includes("social-linkedin"));
    assert.ok(r.stderr.includes("ausente") || r.stderr.includes("FALHOU"));
    // Output principal não foi gravado
    assert.equal(existsSync(join(dir, "03-social.md")), false);
  });

  it("Facebook tmp ausente → exit 1 com nome do agent", () => {
    const dir = makeEditionDir();
    writeFileSync(
      join(dir, "_internal", "03-linkedin.tmp.md"),
      "## d1\n\nLinkedIn content\n",
    );

    const r = runScript(dir);
    assert.equal(r.status, 1);
    assert.ok(r.stderr.includes("social-facebook"));
  });

  it("tmp vazio (0 bytes) → exit 1", () => {
    const dir = makeEditionDir();
    writeFileSync(join(dir, "_internal", "03-linkedin.tmp.md"), "");
    writeFileSync(
      join(dir, "_internal", "03-facebook.tmp.md"),
      "## d1\n\nFB\n",
    );

    const r = runScript(dir);
    assert.equal(r.status, 1);
    assert.ok(r.stderr.includes("social-linkedin"));
    assert.ok(r.stderr.includes("vazio"));
  });

  it("HTML comments balanceados → strip OK", () => {
    const dir = makeEditionDir();
    writeFileSync(
      join(dir, "_internal", "03-linkedin.tmp.md"),
      "## d1\n\n<!-- debug: source-id 42 -->\nLinkedIn content\n",
    );
    writeFileSync(
      join(dir, "_internal", "03-facebook.tmp.md"),
      "<!-- agent meta -->\n## d1\n\nFacebook content\n",
    );

    const r = runScript(dir);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);

    const out = readFileSync(join(dir, "03-social.md"), "utf8");
    assert.ok(!out.includes("<!--"), "no opening comment marker should remain");
    assert.ok(!out.includes("-->"), "no closing comment marker should remain");
    assert.ok(out.includes("LinkedIn content"));
    assert.ok(out.includes("Facebook content"));
  });

  it("HTML comment não-balanceado em LinkedIn → exit 1", () => {
    const dir = makeEditionDir();
    writeFileSync(
      join(dir, "_internal", "03-linkedin.tmp.md"),
      "## d1\n\n<!-- abc sem fechamento\nLinkedIn content\n",
    );
    writeFileSync(
      join(dir, "_internal", "03-facebook.tmp.md"),
      "## d1\n\nFB content\n",
    );

    const r = runScript(dir);
    assert.equal(r.status, 1);
    assert.ok(r.stderr.includes("mal-formados") || r.stderr.includes("FALHOU"));
    // Output principal não foi gravado (FS state preservado)
    assert.equal(existsSync(join(dir, "03-social.md")), false);
    // Tmps NÃO deletados em caso de erro (rollback-safe)
    assert.equal(
      existsSync(join(dir, "_internal", "03-linkedin.tmp.md")),
      true,
    );
    assert.equal(
      existsSync(join(dir, "_internal", "03-facebook.tmp.md")),
      true,
    );
  });

  it("HTML comment nested → handle gracefully (merge sucede)", () => {
    const dir = makeEditionDir();
    writeFileSync(
      join(dir, "_internal", "03-linkedin.tmp.md"),
      "## d1\n\n<!-- outer <!-- inner --> trailing -->\nVisible LinkedIn\n",
    );
    writeFileSync(
      join(dir, "_internal", "03-facebook.tmp.md"),
      "## d1\n\nVisible Facebook\n",
    );

    const r = runScript(dir);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);

    const out = readFileSync(join(dir, "03-social.md"), "utf8");
    assert.ok(!out.includes("<!--"));
    assert.ok(!out.includes("-->"));
    assert.ok(!out.includes("inner"));
    assert.ok(!out.includes("trailing"));
    assert.ok(out.includes("Visible LinkedIn"));
    assert.ok(out.includes("Visible Facebook"));
  });
});
