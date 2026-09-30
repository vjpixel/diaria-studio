/**
 * #9133 — regressão: `data/intentional-errors.jsonl` ganhou a entry de
 * 260830 como cópia literal da de 260831 (mesmo detail/correct_value/reveal).
 * O sync agora recusa (exit 1, sem escrever) quando (a) `--md` vem do
 * diretório de outra edição ou (b) o record é idêntico ao de outra edição.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { intentionalErrorJsonPath } from "../scripts/lib/intentional-errors.ts";
import { editionFromMdPath, findDuplicateFromOtherEdition } from "../scripts/sync-intentional-error.ts";

const RECORD = {
  description: "DESTAQUE 1 cita 6.241 domínios. O número correto é 6.214.",
  location: "DESTAQUE 1, parágrafo 1",
  category: "numeric",
  correct_value: "6.214",
  reveal: "Na última edição, escrevi 6.241 domínios — o correto é 6.214.",
};

function setupEdition(root: string, edition: string, record: Record<string, unknown>): string {
  const dir = join(root, edition.slice(0, 4), edition);
  mkdirSync(dir, { recursive: true });
  const md = join(dir, "02-reviewed.md");
  writeFileSync(md, "# edição\n\nTexto.\n", "utf8");
  mkdirSync(join(dir, "_internal"), { recursive: true });
  writeFileSync(intentionalErrorJsonPath(dir), JSON.stringify(record), "utf8");
  return md;
}

function runSync(md: string, edition: string, jsonl: string) {
  const script = join(import.meta.dirname, "..", "scripts", "sync-intentional-error.ts");
  return spawnSync(process.execPath, ["--import", "tsx", script, "--md", md, "--edition", edition, "--jsonl", jsonl], {
    encoding: "utf8",
  });
}

describe("sync-intentional-error cross-edition (#9133)", () => {
  it("editionFromMdPath extrai o AAMMDD do diretório", () => {
    assert.equal(editionFromMdPath("/x/data/editions/2608/260831/02-reviewed.md"), "260831");
    assert.equal(editionFromMdPath("/tmp/abc/02-reviewed.md"), null);
  });

  it("findDuplicateFromOtherEdition ignora a própria edição e no_error", () => {
    const e = { edition: "260831", error_type: "numeric", is_feature: true, detail: "x", correct_value: "1" } as const;
    assert.equal(findDuplicateFromOtherEdition({ ...e }, [{ ...e }]), null);
    assert.equal(findDuplicateFromOtherEdition({ ...e }, [{ ...e, edition: "260830" }])?.edition, "260830");
    assert.equal(findDuplicateFromOtherEdition({ ...e, no_error: true }, [{ ...e, edition: "260830" }]), null);
  });

  it("recusa --md de outra edição sem escrever", () => {
    const root = mkdtempSync(join(tmpdir(), "sie-9133-"));
    const md31 = setupEdition(root, "260831", RECORD);
    const jsonl = join(root, "errors.jsonl");
    const r = runSync(md31, "260830", jsonl);
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /#9133/);
    assert.equal(existsSync(jsonl), false);
  });

  it("recusa record idêntico ao de outra edição (cenário 260830/260831)", () => {
    const root = mkdtempSync(join(tmpdir(), "sie-9133-"));
    const md30 = setupEdition(root, "260830", RECORD);
    const md31 = setupEdition(root, "260831", RECORD);
    const jsonl = join(root, "errors.jsonl");
    assert.equal(runSync(md30, "260830", jsonl).status, 0);
    const r = runSync(md31, "260831", jsonl);
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /idêntico à entry de 260830/);
    const lines = readFileSync(jsonl, "utf8").trim().split("\n");
    assert.equal(lines.length, 1);
    assert.equal(JSON.parse(lines[0]).edition, "260830");
  });

  it("record distinto em outra edição continua sincronizando", () => {
    const root = mkdtempSync(join(tmpdir(), "sie-9133-"));
    const md30 = setupEdition(root, "260830", RECORD);
    const md31 = setupEdition(root, "260831", {
      ...RECORD,
      description: "DESTAQUE 2 grafa Anthropik.",
      correct_value: "Anthropic",
      reveal: "Na última edição, escrevi Anthropik — o correto é Anthropic.",
    });
    const jsonl = join(root, "errors.jsonl");
    assert.equal(runSync(md30, "260830", jsonl).status, 0);
    assert.equal(runSync(md31, "260831", jsonl).status, 0);
    assert.equal(readFileSync(jsonl, "utf8").trim().split("\n").length, 2);
  });
});
