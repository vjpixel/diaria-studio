/**
 * test/render-newsletter-html-link-layout-4841.test.ts (#4841)
 *
 * Cobertura NO NÍVEL DO CLI (subprocess real via spawnSync, mesmo padrão de
 * test/render-newsletter-html-cli-esp-4266.test.ts /
 * test/render-newsletter-html-no-tty-warn.test.ts) — confirma que
 * `scripts/render-newsletter-html.ts` grava `_internal/link-layout.json` +
 * `_internal/published-links.json` a cada render, independente de
 * --format/--split, e que a origem (scored vs writer_inserted) é resolvida
 * corretamente contra `01-approved.json`.
 *
 * test/link-layout.test.ts cobre as funções puras isoladas; este arquivo
 * cobre só a integração (o CLI de fato chama e persiste).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const PROJECT_ROOT = resolve(import.meta.dirname, "..");
const SCRIPT = join(PROJECT_ROOT, "scripts", "render-newsletter-html.ts");

/**
 * Fixture: 2 destaques (D1 com link inline no corpo, não-scored; D2 url
 * scored) + seção RADAR com 1 item scored — o suficiente pra exercitar
 * bloco/ordinal/origin nos 2 artefatos.
 */
function makeEditionDir(): string {
  const base = mkdtempSync(join(tmpdir(), "diaria-link-layout-cli-"));
  const dir = join(base, "260999");
  mkdirSync(dir, { recursive: true });
  const reviewed = [
    "**DESTAQUE 1 | LANÇAMENTO**",
    "",
    "**[Título um](https://example.com/d1)**",
    "",
    "Corpo com link contextual [inserido pelo writer](https://example.com/d1-writer-link).",
    "",
    "Por que isso importa: razão um.",
    "",
    "---",
    "",
    "**DESTAQUE 2 | RADAR**",
    "",
    "**[Título dois](https://example.com/d2)**",
    "",
    "Corpo dois.",
    "",
    "Por que isso importa: razão dois.",
    "",
    "---",
    "",
    "**📡 RADAR**",
    "",
    "**[Item radar](https://example.com/radar-1)**",
    "Descrição do item.",
    "",
    "---",
    "",
  ].join("\n");
  writeFileSync(join(dir, "02-reviewed.md"), reviewed, "utf8");
  mkdirSync(join(dir, "_internal"), { recursive: true });
  // Pool aprovado (Stage 1): d1 e radar-1 passaram pelo scorer; d2 e o link
  // inserido pelo writer no corpo de D1 não estão aqui.
  writeFileSync(
    join(dir, "_internal", "01-approved.json"),
    JSON.stringify({
      highlights: [{ url: "https://example.com/d1", article: { url: "https://example.com/d1" } }],
      radar: [{ url: "https://example.com/radar-1" }],
    }),
  );
  return dir;
}

function run(dirAndArgs: string[]) {
  return spawnSync(process.execPath, ["--import", "tsx", SCRIPT, ...dirAndArgs], {
    encoding: "utf8",
    cwd: PROJECT_ROOT,
  });
}

describe("render-newsletter-html CLI — link-layout.json + published-links.json (#4841)", () => {
  it("grava os 2 artefatos com bloco/ordinal/origin corretos", () => {
    const dir = makeEditionDir();
    try {
      const r = run([dir, "--out", join(dir, "_internal", "newsletter-draft.html")]);
      assert.equal(r.status, 0, `stderr: ${r.stderr}`);

      const layoutPath = join(dir, "_internal", "link-layout.json");
      const publishedPath = join(dir, "_internal", "published-links.json");
      assert.ok(existsSync(layoutPath), "link-layout.json deveria existir");
      assert.ok(existsSync(publishedPath), "published-links.json deveria existir");

      const layout = JSON.parse(readFileSync(layoutPath, "utf8"));
      assert.deepEqual(
        layout.map((e: { url: string; bloco: string }) => [e.url, e.bloco]),
        [
          ["https://example.com/d1", "destaque"],
          ["https://example.com/d1-writer-link", "destaque"],
          ["https://example.com/d2", "destaque"],
          ["https://example.com/radar-1", "radar"],
        ],
      );
      // ordinal_global sequencial 1..4; ordinal_no_bloco reinicia por bloco.
      assert.deepEqual(
        layout.map((e: { ordinal_global: number }) => e.ordinal_global),
        [1, 2, 3, 4],
      );
      assert.deepEqual(
        layout.map((e: { ordinal_no_bloco: number }) => e.ordinal_no_bloco),
        [1, 2, 3, 1],
      );

      const published = JSON.parse(readFileSync(publishedPath, "utf8"));
      const byUrl = Object.fromEntries(
        published.map((p: { url: string; origin: string }) => [p.url, p.origin]),
      );
      assert.equal(byUrl["https://example.com/d1"], "scored");
      assert.equal(byUrl["https://example.com/d1-writer-link"], "writer_inserted");
      assert.equal(byUrl["https://example.com/d2"], "writer_inserted"); // não está em 01-approved.json
      assert.equal(byUrl["https://example.com/radar-1"], "scored");
      assert.equal(published.length, 4); // 4 urls distintas, sem duplicata
    } finally {
      rmSync(resolve(dir, ".."), { recursive: true, force: true });
    }
  });

  it("re-render sobrescreve (nunca acumula entries STALE de uma rodada anterior)", () => {
    const dir = makeEditionDir();
    try {
      const outPath = join(dir, "_internal", "newsletter-draft.html");
      assert.equal(run([dir, "--out", outPath]).status, 0);
      const firstLayout = JSON.parse(
        readFileSync(join(dir, "_internal", "link-layout.json"), "utf8"),
      );
      assert.equal(firstLayout.length, 4);

      // Troca a seção RADAR por LANÇAMENTOS (nome diferente) e re-roda — o
      // layout deve refletir só o estado atual, não acumular entries antigas.
      const reviewed = [
        "**DESTAQUE 1 | LANÇAMENTO**",
        "",
        "**[Título um](https://example.com/d1)**",
        "",
        "Corpo um.",
        "",
        "Por que isso importa: razão um.",
        "",
        "---",
        "",
        "**DESTAQUE 2 | RADAR**",
        "",
        "**[Título dois](https://example.com/d2)**",
        "",
        "Corpo dois.",
        "",
        "Por que isso importa: razão dois.",
        "",
      ].join("\n");
      writeFileSync(join(dir, "02-reviewed.md"), reviewed, "utf8");
      assert.equal(run([dir, "--out", outPath]).status, 0);
      const secondLayout = JSON.parse(
        readFileSync(join(dir, "_internal", "link-layout.json"), "utf8"),
      );
      assert.deepEqual(
        secondLayout.map((e: { url: string }) => e.url),
        ["https://example.com/d1", "https://example.com/d2"],
      );
    } finally {
      rmSync(resolve(dir, ".."), { recursive: true, force: true });
    }
  });

  it("--format json também grava os 2 artefatos (independe do formato de saída)", () => {
    const dir = makeEditionDir();
    try {
      const r = run([dir, "--format", "json"]);
      assert.equal(r.status, 0, `stderr: ${r.stderr}`);
      assert.ok(existsSync(join(dir, "_internal", "link-layout.json")));
      assert.ok(existsSync(join(dir, "_internal", "published-links.json")));
    } finally {
      rmSync(resolve(dir, ".."), { recursive: true, force: true });
    }
  });

  it("--split também grava os 2 artefatos", () => {
    const dir = makeEditionDir();
    try {
      const r = run([dir, "--split"]);
      assert.equal(r.status, 0, `stderr: ${r.stderr}`);
      assert.ok(existsSync(join(dir, "_internal", "link-layout.json")));
      assert.ok(existsSync(join(dir, "_internal", "published-links.json")));
    } finally {
      rmSync(resolve(dir, ".."), { recursive: true, force: true });
    }
  });

  it("sem 01-approved.json (fail-soft): tudo published como writer_inserted, nunca quebra o render", () => {
    const base = mkdtempSync(join(tmpdir(), "diaria-link-layout-cli-noapproved-"));
    const dir = join(base, "260999");
    mkdirSync(dir, { recursive: true });
    const reviewed = [
      "**DESTAQUE 1 | LANÇAMENTO**",
      "",
      "**[Título um](https://example.com/d1)**",
      "",
      "Corpo um.",
      "",
      "Por que isso importa: razão um.",
      "",
      "---",
      "",
      "**DESTAQUE 2 | RADAR**",
      "",
      "**[Título dois](https://example.com/d2)**",
      "",
      "Corpo dois.",
      "",
      "Por que isso importa: razão dois.",
      "",
    ].join("\n");
    writeFileSync(join(dir, "02-reviewed.md"), reviewed, "utf8");
    mkdirSync(join(dir, "_internal"), { recursive: true });
    try {
      const r = run([dir, "--out", join(dir, "_internal", "newsletter-draft.html")]);
      assert.equal(r.status, 0, `stderr: ${r.stderr}`);
      const published = JSON.parse(
        readFileSync(join(dir, "_internal", "published-links.json"), "utf8"),
      );
      assert.deepEqual(published, [
        { url: "https://example.com/d1", bloco: "destaque", origin: "writer_inserted" },
        { url: "https://example.com/d2", bloco: "destaque", origin: "writer_inserted" },
      ]);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
