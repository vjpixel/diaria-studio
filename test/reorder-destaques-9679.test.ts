/**
 * #9679 — reorder-destaques/promote deixavam 3 coisas na numeração antiga
 * (achado na edição 261006, reorder 3,1,2):
 *   1. `04-d{N}-sd-prompt.json` (raiz e `_internal/`) e `_internal/04-d{N}-generator.json`
 *      não eram renomeados junto com a imagem;
 *   2. o texto livre de `_internal/04-crop-review.json` (`sugestao: "Regenerar D3…"`)
 *      continuava citando o número antigo;
 *   3. o selo do humanizador (`.humanizer-social-done.json`) acusava hash_mismatch
 *      mesmo sem nenhum texto alterado — só os headers `## d{N}` mudam.
 * CLI end-to-end porque a regressão possível é de fiação em main().
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { remapDestaqueRefsInText, reorderCropReviewJson } from "../scripts/reorder-destaques.ts";
import { checkSentinel, writeSentinel } from "../scripts/check-humanizer-social.ts";
import { planHumanizerReseal } from "../scripts/lib/humanizer-social-seal.ts";
import { promoteToDestaque } from "../scripts/promote-to-destaque.ts";

const ROOT = join(import.meta.dirname, "..");

function runReorder(dir: string, order: string): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(
    process.execPath,
    ["--import", "tsx", join(ROOT, "scripts", "reorder-destaques.ts"), "--edition", "999999", "--edition-dir", dir, "--new-order", order],
    { cwd: ROOT, encoding: "utf8" },
  );
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

const SOCIAL = `# Social

## d1

Texto do destaque A.

## d2

Texto do destaque B.

## d3

Texto do destaque C.
`;

function makeEdition(): string {
  const dir = mkdtempSync(join(tmpdir(), "reorder-9679-"));
  const internal = join(dir, "_internal");
  mkdirSync(internal, { recursive: true });
  const approved = {
    highlights: ["https://a.com/1", "https://b.com/2", "https://c.com/3"].map((url, i) => ({
      url,
      title_options: [`T${i + 1}`],
    })),
  };
  writeFileSync(join(internal, "01-approved.json"), JSON.stringify(approved, null, 2));
  writeFileSync(join(internal, "01-approved-capped.json"), JSON.stringify(approved, null, 2));
  for (const n of [1, 2, 3]) {
    const url = approved.highlights[n - 1].url;
    writeFileSync(join(dir, `04-d${n}-sd-prompt.json`), JSON.stringify({ positive: `destaque_url: ${url} position_at_write: ${n}` }));
    writeFileSync(join(internal, `04-d${n}-generator.json`), JSON.stringify({ generator: `gen-${n}` }));
  }
  writeFileSync(
    join(internal, "04-crop-review.json"),
    JSON.stringify({
      results: [
        { destaque: "d1", ratio: "1x1", status: "warn", sugestao: "Regenerar D1 com sujeitos centralizados." },
        { destaque: "d2", ratio: "1x1", status: "ok" },
        { destaque: "d3", ratio: "1x1", status: "warn", sugestao: "Regenerar D3, ou usar o 2:1." },
      ],
    }),
  );
  return dir;
}

describe("reorder-destaques #9679: sd-prompt/generator seguem a imagem", () => {
  it("--new-order 3,1,2 renomeia 04-d{N}-sd-prompt.json e _internal/04-d{N}-generator.json", () => {
    const dir = makeEdition();
    try {
      const r = runReorder(dir, "3,1,2");
      assert.equal(r.status, 0, r.stderr);
      // novo d1 = antigo d3
      assert.match(readFileSync(join(dir, "04-d1-sd-prompt.json"), "utf8"), /https:\/\/c\.com\/3/);
      assert.match(readFileSync(join(dir, "04-d2-sd-prompt.json"), "utf8"), /https:\/\/a\.com\/1/);
      assert.equal(JSON.parse(readFileSync(join(dir, "_internal", "04-d1-generator.json"), "utf8")).generator, "gen-3");
      assert.equal(JSON.parse(readFileSync(join(dir, "_internal", "04-d3-generator.json"), "utf8")).generator, "gen-2");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("reorder-destaques #9679: texto do crop-review", () => {
  it("remapDestaqueRefsInText troca D{N} numa passada só (sem oscilar)", () => {
    // [3,1,2]: antigo 3 → 1, antigo 1 → 2, antigo 2 → 3
    assert.equal(remapDestaqueRefsInText("Regenerar D3 ou D1; ver 04-d2-1x1.jpg", [3, 1, 2]), "Regenerar D1 ou D2; ver 04-d3-1x1.jpg");
    assert.equal(remapDestaqueRefsInText("D12 e D9 ficam", [2, 1, 3]), "D12 e D9 ficam");
  });

  it("sugestao acompanha o destaque (caso 261006: 'Regenerar D3' no novo d1 vira 'Regenerar D1')", () => {
    const dir = makeEdition();
    try {
      const r = runReorder(dir, "3,1,2");
      assert.equal(r.status, 0, r.stderr);
      const crop = JSON.parse(readFileSync(join(dir, "_internal", "04-crop-review.json"), "utf8"));
      const d1 = crop.results.find((x: { destaque: string }) => x.destaque === "d1");
      const d2 = crop.results.find((x: { destaque: string }) => x.destaque === "d2");
      assert.equal(d1.sugestao, "Regenerar D1, ou usar o 2:1.");
      assert.equal(d2.sugestao, "Regenerar D2 com sujeitos centralizados.");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("entrada em ponto fixo da permutação também tem o texto remapeado", () => {
    const { changed, data } = reorderCropReviewJson(
      { results: [{ destaque: "d3", ratio: "1x1", sugestao: "Parecido com D1" }] },
      [2, 1, 3],
    );
    assert.equal(changed, true);
    assert.equal((data as { results: Array<{ sugestao: string }> }).results[0].sugestao, "Parecido com D2");
  });
});

describe("reorder-destaques #9679: selo do humanizador", () => {
  it("re-sela quando o selo batia antes (check-humanizer-social --check volta ok sem bypass manual)", () => {
    const dir = makeEdition();
    try {
      writeFileSync(join(dir, "03-social.md"), SOCIAL);
      writeSentinel(dir, "motivo original");
      const r = runReorder(dir, "3,1,2");
      assert.equal(r.status, 0, r.stderr);
      assert.deepEqual(checkSentinel(dir), { ok: true });
      const sentinel = JSON.parse(readFileSync(join(dir, "_internal", ".humanizer-social-done.json"), "utf8"));
      assert.equal(sentinel.bypass_reason, "motivo original", "preserva o bypass_reason anterior");
      assert.match(sentinel.resealed_by, /reorder-destaques --new-order 3,1,2/);
      const report = JSON.parse(r.stdout) as { next_steps: string[] };
      assert.ok(!report.next_steps.some((s) => s.includes("check-humanizer-social")), r.stdout);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("NÃO re-sela social editado depois da humanização — vira next_step", () => {
    const dir = makeEdition();
    try {
      writeFileSync(join(dir, "03-social.md"), SOCIAL);
      writeSentinel(dir);
      writeFileSync(join(dir, "03-social.md"), SOCIAL.replace("Texto do destaque B.", "Texto editado à mão."));
      const r = runReorder(dir, "3,1,2");
      assert.equal(r.status, 0, r.stderr);
      assert.equal(checkSentinel(dir).ok, false, "edição não humanizada não pode ser lavada pelo reorder");
      const report = JSON.parse(r.stdout) as { next_steps: string[] };
      assert.ok(report.next_steps.some((s) => s.includes("check-humanizer-social.ts --write")), r.stdout);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("planHumanizerReseal: sem sentinel → absent", () => {
    const dir = mkdtempSync(join(tmpdir(), "seal-9679-"));
    try {
      assert.deepEqual(planHumanizerReseal(dir, "a", "b", "x"), { status: "absent" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("promote-to-destaque #9679: selo do humanizador e sd-prompt", () => {
  it("re-sela após renumerar headers, então o check pós-splice aponta só a seção nova", () => {
    const dir = mkdtempSync(join(tmpdir(), "promote-9679-"));
    try {
      const internal = join(dir, "_internal");
      mkdirSync(internal, { recursive: true });
      const approved = {
        highlights: [
          { rank: 1, url: "https://a.com/d1", article: { url: "https://a.com/d1" } },
          { rank: 2, url: "https://b.com/d2", article: { url: "https://b.com/d2" } },
        ],
        radar: [{ url: "https://r.com/x", title: "X" }],
      };
      writeFileSync(join(internal, "01-approved.json"), JSON.stringify(approved));
      writeFileSync(join(dir, "03-social.md"), "# Social\n\n## d1\n\nA\n\n## d2\n\nB\n");
      writeFileSync(join(dir, "04-d1-sd-prompt.json"), "{\"positive\":\"d1\"}");
      writeSentinel(dir);

      const res = promoteToDestaque(dir, "https://r.com/x", 1);
      assert.deepEqual(checkSentinel(dir), { ok: true });
      assert.equal(readFileSync(join(dir, "04-d2-sd-prompt.json"), "utf8"), "{\"positive\":\"d1\"}");
      assert.equal(existsSync(join(dir, "04-d1-sd-prompt.json")), false);
      assert.ok(res.next_steps.some((s) => s.includes("check-humanizer-social.ts --write")));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
