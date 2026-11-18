/**
 * #13546: `dedup.ts` rodado sem `--current-edition` (e com paths fora de
 * `editions/{AAMMDD}/`, de onde ele derivaria a edição) usava como referência
 * "seção mais recente de past-editions.md + 1 dia". Quando a edição em curso
 * já estava publicada, a própria edição entrava no histórico e TODO item do
 * pool saía como repetido. Agora o CLI recusa (exit 1) sem edição corrente;
 * com a flag, ou com o path dentro de `editions/{AAMMDD}/`, a própria edição
 * fica fora do histórico.
 */
import { it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const OWN_URL = "https://a.example/propria-edicao";

// past-editions.md cuja seção mais recente é a PRÓPRIA edição 261118, já
// publicada, com o item do pool que está sendo deduplicado.
function fixture(): { root: string; past: string; articles: string } {
  const root = mkdtempSync(join(tmpdir(), "dedup-13546-"));
  const past = join(root, "past.md");
  writeFileSync(
    past,
    [
      "# Past editions",
      "",
      "## 2026-11-17 — Edição anterior",
      "",
      "- https://a.example/outra-coisa",
      "",
      "## 2026-11-18 — Edição em curso",
      "",
      `- ${OWN_URL}`,
      "",
    ].join("\n"),
  );
  const articles = join(root, "articles.json");
  writeFileSync(articles, JSON.stringify([{ url: OWN_URL, title: "Item da própria edição 261118" }]));
  return { root, past, articles };
}

function runDedup(root: string, args: string[]) {
  return spawnSync(
    process.execPath,
    ["--import", "tsx", resolve("scripts/dedup.ts"), "--editions-dir", join(root, "missing"), "--log-root-dir", root, ...args],
    { encoding: "utf8" },
  );
}

it("#13546: sem --current-edition e sem path derivável, recusa em vez de marcar tudo como repetido", () => {
  const { root, past, articles } = fixture();
  try {
    const out = join(root, "out.json");
    const r = runDedup(root, ["--articles", articles, "--past-editions", past, "--out", out]);
    assert.equal(r.status, 1, `deveria recusar; stderr: ${r.stderr}`);
    assert.match(r.stderr, /edição corrente desconhecida \(#13546\)/);
    assert.match(r.stderr, /--current-edition AAMMDD/);
    assert.equal(existsSync(out), false, "não grava saída com falso positivo");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it("#13546: com --current-edition a própria edição sai do histórico e o item fica no pool", () => {
  const { root, past, articles } = fixture();
  try {
    const out = join(root, "out.json");
    const r = runDedup(root, ["--articles", articles, "--past-editions", past, "--current-edition", "261118", "--out", out]);
    assert.equal(r.status, 0, r.stderr);
    const result = JSON.parse(readFileSync(out, "utf8"));
    assert.deepEqual(result.kept.map((a: { url: string }) => a.url), [OWN_URL]);
    assert.equal(result.removed.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it("#13546: edição derivada do --out em data/editions/{AAMM}/{AAMMDD}/ continua aceita sem a flag", () => {
  const { root, past, articles } = fixture();
  try {
    const internal = join(root, "data/editions/2611/261118/_internal");
    mkdirSync(internal, { recursive: true });
    const out = join(internal, "tmp-dedup-output.json");
    const r = runDedup(root, ["--articles", articles, "--past-editions", past, "--out", out]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /edição corrente derivada do path: 261118/);
    const result = JSON.parse(readFileSync(out, "utf8"));
    assert.deepEqual(result.kept.map((a: { url: string }) => a.url), [OWN_URL]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
