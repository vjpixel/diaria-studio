/**
 * Regressões de #10292 (propose-intentional-error-candidate: o caminho
 * principal `--edition-dir` também lê o histórico em modo ESTRITO) e #10293
 * (record-kit-review: `wrong_value` placeholder vira `no_wrong_value`, mas com
 * aviso — nunca calado).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { main as proposeMain } from "../scripts/propose-intentional-error-candidate.ts";
import { checkEditionEmail } from "../scripts/record-kit-review.ts";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(REPO_ROOT, "scripts", "propose-intentional-error-candidate.ts");
const REVIEWED ="**RADAR**\n[Notícia sobre Claude](https://example.com/x)\nUm comentário sobre Claude, da Anthropic.\n";

function run(argv: string[]): { code: number; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  const ol = console.log;
  const oe = console.error;
  console.log = (m: string) => out.push(m);
  console.error = (m: string) => err.push(m);
  try {
    return { code: proposeMain(argv), out, err };
  } finally {
    console.log = ol;
    console.error = oe;
  }
}

/** `{root}/data/editions/260930/02-reviewed.md` + JSONL irmão de `editions/`. */
function editionTree(jsonl: string | "dir" | null): { editionDir: string; jsonlPath: string } {
  const root = mkdtempSync(join(tmpdir(), "ie-10292-"));
  const editionDir = join(root, "data", "editions", "260930");
  mkdirSync(editionDir, { recursive: true });
  writeFileSync(join(editionDir, "02-reviewed.md"), REVIEWED);
  const jsonlPath = join(root, "data", "intentional-errors.jsonl");
  if (jsonl === "dir") mkdirSync(jsonlPath); // existe, mas readFileSync lança — análogo ao lock do OneDrive
  else if (jsonl !== null) writeFileSync(jsonlPath, jsonl);
  return { editionDir, jsonlPath };
}

describe("#10292 caminho principal --edition-dir com histórico ilegível", () => {
  it("JSONL inteiramente corrompido → exit 1, nunca um candidate não filtrado", () => {
    const { editionDir } = editionTree("{corrompido\nlixo\n");
    const r = run(["--edition-dir", editionDir]);
    assert.equal(r.code, 1);
    assert.equal(r.out.length, 0);
    assert.ok(r.err.some((l) => /nenhuma parseia/.test(l)));
  });

  it("JSONL existente mas ilegível (EISDIR) → exit 1", () => {
    const { editionDir } = editionTree("dir");
    const r = run(["--edition-dir", editionDir]);
    assert.equal(r.code, 1);
    assert.equal(r.out.length, 0);
    assert.ok(r.err.some((l) => /não pôde ser lido/.test(l)));
  });

  it("JSONL legível com a grafia já usada → candidate filtrado (filtro #9101 intacto)", () => {
    const clean = run(["--edition-dir", editionTree(null).editionDir]);
    assert.equal(clean.code, 0);
    const first = JSON.parse(clean.out[0]).candidate;
    assert.ok(first, "sem histórico o fixture precisa propor algo");
    const { editionDir } = editionTree(
      JSON.stringify({
        edition: "260928",
        wrong_value: first.wrong_value,
        correct_value: first.correct_value,
        description: "x",
      }) + "\n{corrompido\n",
    );
    const r = run(["--edition-dir", editionDir]);
    assert.equal(r.code, 0);
    assert.ok(r.err.some((l) => /WARN 1 linha/.test(l)));
    const cand = JSON.parse(r.out[0]).candidate;
    assert.notEqual(cand?.wrong_value, first.wrong_value);
  });

  it("JSONL ausente segue sendo histórico vazio (exit 0, candidate preenchido)", () => {
    const r = run(["--edition-dir", editionTree(null).editionDir]);
    assert.equal(r.code, 0);
    assert.ok(JSON.parse(r.out[0]).candidate);
  });

  it("--edition-dir fora de .../editions/ em --list-recent → histórico vazio, não exit 1", () => {
    const dir = join(mkdtempSync(join(tmpdir(), "ie-10292-fx-")), "260930");
    mkdirSync(dir);
    const r = run(["--edition-dir", dir, "--list-recent"]);
    assert.equal(r.code, 0);
    assert.deepEqual(JSON.parse(r.out[0]).recent, []);
  });

  it("processo real: exit code 1 chega ao shell", () => {
    const { editionDir } = editionTree("{corrompido\n");
    const res = spawnSync(
      process.execPath,
      ["--import", "tsx", SCRIPT, "--edition-dir", editionDir],
      { encoding: "utf8", cwd: REPO_ROOT },
    );
    assert.equal(res.status, 1, res.stderr);
    assert.equal(res.stdout.trim(), "");
  });
});

describe("#10293 record-kit-review: placeholder não passa calado", () => {
  function edition(ie: object): { dir: string; emailFile: string } {
    const dir = mkdtempSync(join(tmpdir(), "kit-10293-"));
    mkdirSync(join(dir, "_internal"));
    writeFileSync(join(dir, "_internal", "intentional-error.json"), JSON.stringify(ie));
    const emailFile = join(dir, "_internal", ".email-body.tmp");
    writeFileSync(emailFile, "<p>O Unibanco abriu</p>");
    return { dir, emailFile };
  }

  it("wrong_value {PREENCHER} → no_wrong_value + aviso de placeholder", () => {
    const { dir, emailFile } = edition({ wrong_value: "{PREENCHER}", correct_value: "Unibanco" });
    const r = checkEditionEmail(dir, emailFile);
    assert.equal(r.check, "no_wrong_value");
    assert.equal(r.warnings.length, 1);
    assert.match(r.warnings[0], /placeholder/);
    assert.match(r.warnings[0], /#10293/);
  });

  it("variante com texto ({PREENCHER: grafia}) e espaço também avisa", () => {
    const { dir, emailFile } = edition({ wrong_value: "  {preencher: grafia errada}" });
    assert.equal(checkEditionEmail(dir, emailFile).warnings.length, 1);
  });

  it("no_error: true com placeholder residual é decisão editorial → sem aviso", () => {
    const { dir, emailFile } = edition({ no_error: true, wrong_value: "{PREENCHER}" });
    assert.deepEqual(checkEditionEmail(dir, emailFile), { check: "no_wrong_value", warnings: [] });
  });

  it("wrong_value real → sem aviso", () => {
    const { dir, emailFile } = edition({ wrong_value: "Unibanco" });
    assert.deepEqual(checkEditionEmail(dir, emailFile), { check: "present", warnings: [] });
  });
});
