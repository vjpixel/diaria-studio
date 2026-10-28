/**
 * test/newsletter-html-freshness-10268.test.ts (#10268)
 *
 * Dois defeitos de `newsletter-html-not-behind-reviewed` (#10258):
 *
 * 1. O carimbo relia o `02-reviewed.md` DEPOIS de gravar a saída. Um save do
 *    editor entre a leitura (`extractContent`) e o carimbo fazia o carimbo
 *    registrar o sha novo enquanto o HTML refletia o texto antigo. Teste e2e:
 *    o CLI real roda com um preload que regrava o reviewed no instante em que
 *    a saída é escrita — o carimbo tem de registrar o sha do que foi LIDO.
 * 2. `mtime-fresh` respondia antes do carimbo: HTML mais novo que o reviewed
 *    passava mesmo com o sha carimbado divergente do atual.
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import {
  evaluateNewsletterHtmlFreshness,
  evaluateNewsletterHtmlFreshnessOnDisk,
  writeRenderSourceStamp,
  RENDER_SOURCE_STAMP,
  NEWSLETTER_FINAL_HTML,
} from "../scripts/lib/newsletter-html-freshness.ts";
import { checkNewsletterHtmlNotBehindReviewed } from "../scripts/lib/invariant-checks/stage-4.ts";

const PROJECT_ROOT = resolve(import.meta.dirname, "..");
const SCRIPT = join(PROJECT_ROOT, "scripts", "render-newsletter-html.ts");
const T0 = 1_700_000_000; // segundos

const dirs: string[] = [];
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

function put(dir: string, rel: string, content: string, mtimeSec: number): void {
  writeFileSync(join(dir, rel), content);
  utimesSync(join(dir, rel), mtimeSec, mtimeSec);
}

function reviewedText(marker: string): string {
  return [1, 2, 3]
    .map((n) =>
      [
        `**DESTAQUE ${n} | RADAR**`,
        "",
        `**[Título ${n} ${marker}](https://example.com/${n})**`,
        "",
        `Corpo ${n} ${marker} com contexto suficiente pra render.`,
        "",
        `Por que isso importa: razão ${n}.`,
        "",
        "---",
        "",
      ].join("\n"),
    )
    .join("\n");
}

describe("#10268 defeito 2 — carimbo decide mesmo com HTML mais novo (pura)", () => {
  it("HTML mais novo que o reviewed, mas sha carimbado ≠ atual → defasado (stamp-mismatch)", () => {
    const r = evaluateNewsletterHtmlFreshness({
      htmlMtimeMs: 3e6, reviewedMtimeMs: 2e6, reviewedSha256: "novo", stamp: { reviewed_sha256: "velho", mtimeMs: 1e6 },
    });
    assert.deepEqual([r.stale, r.reason], [true, "stamp-mismatch"]);
    assert.equal(r.stale && r.lagMinutes, 0, "lag não pode sair negativo quando o HTML é o mais novo");
  });
  it("HTML mais novo e sha carimbado = atual → fresco (fluxo normal)", () => {
    const r = evaluateNewsletterHtmlFreshness({
      htmlMtimeMs: 3e6, reviewedMtimeMs: 2e6, reviewedSha256: "x", stamp: { reviewed_sha256: "x", mtimeMs: 3e6 },
    });
    assert.deepEqual([r.stale, r.reason], [false, "mtime-fresh"]);
  });
  it("sem carimbo, HTML mais novo → mtime segue como fallback (fresco)", () => {
    const r = evaluateNewsletterHtmlFreshness({ htmlMtimeMs: 3e6, reviewedMtimeMs: 2e6, reviewedSha256: "x", stamp: null });
    assert.deepEqual([r.stale, r.reason], [false, "mtime-fresh"]);
  });
  it("carimbo presente mas reviewed ilegível (sha null) → fallback por mtime", () => {
    const r = evaluateNewsletterHtmlFreshness({
      htmlMtimeMs: 3e6, reviewedMtimeMs: 2e6, reviewedSha256: null, stamp: { reviewed_sha256: "x", mtimeMs: 1e6 },
    });
    assert.deepEqual([r.stale, r.reason], [false, "mtime-fresh"]);
  });
});

describe("#10268 defeito 2 — disco: newsletter-final.html regravado sem re-render", () => {
  it("reviewed mudou, depois o HTML foi reescrito (Studio/OneDrive) sem re-render → invariante acusa", () => {
    const d = tmp("html-fresh-10268-");
    mkdirSync(join(d, "_internal"), { recursive: true });
    put(d, "02-reviewed.md", "texto velho", T0);
    writeRenderSourceStamp(d);
    utimesSync(join(d, RENDER_SOURCE_STAMP), T0, T0);
    put(d, NEWSLETTER_FINAL_HTML, "<p>texto velho</p>", T0);
    put(d, "02-reviewed.md", "texto novo", T0 + 600);
    // HTML regravado com mtime novo, conteúdo ainda velho.
    put(d, NEWSLETTER_FINAL_HTML, "<p>texto velho</p>", T0 + 900);

    const r = evaluateNewsletterHtmlFreshnessOnDisk(d);
    assert.deepEqual([r.stale, r.reason], [true, "stamp-mismatch"]);
    const v = checkNewsletterHtmlNotBehindReviewed(d);
    assert.equal(v.length, 1);
    assert.equal(v[0].severity, "error");
    assert.match(v[0].message, /não reflete 02-reviewed\.md/);
    assert.match(v[0].message, /conteúdo de 02-reviewed\.md mudou/);
  });
});

describe("#10268 defeito 1 — carimbo é o sha do que o render LEU (CLI real)", () => {
  it("save do editor entre a leitura e o carimbo → carimbo fica com o sha antigo e o invariante acusa", () => {
    const base = tmp("html-fresh-10268-cli-");
    const d = join(base, "260999");
    mkdirSync(join(d, "_internal"), { recursive: true });
    const before = reviewedText("ANTES");
    const during = reviewedText("DURANTE");
    writeFileSync(join(d, "02-reviewed.md"), before, "utf8");
    writeFileSync(join(d, "01-eia.md"), "Foto: Author / CC BY-SA 4.0.", "utf8");

    // Preload: quando o render grava a saída (--out), o "editor" salva o
    // reviewed com outro texto — exatamente a janela entre extractContent e o
    // carimbo. syncBuiltinESMExports propaga o patch pros imports nomeados.
    const outPath = join(d, "_internal", "newsletter-draft.html");
    const preload = join(base, "editor-save-mid-render.mjs");
    writeFileSync(
      preload,
      [
        'import fs from "node:fs";',
        'import { syncBuiltinESMExports } from "node:module";',
        "const orig = fs.writeFileSync;",
        `const OUT = ${JSON.stringify(outPath)};`,
        `const REVIEWED = ${JSON.stringify(join(d, "02-reviewed.md"))};`,
        `const DURING = ${JSON.stringify(during)};`,
        "let done = false;",
        "fs.writeFileSync = function (p, ...rest) {",
        "  if (!done && String(p) === OUT) { done = true; orig.call(fs, REVIEWED, DURING); }",
        "  return orig.call(fs, p, ...rest);",
        "};",
        "syncBuiltinESMExports();",
      ].join("\n"),
    );

    const r = spawnSync(
      process.execPath,
      // `--import` quer URL: caminho absoluto do Windows (`C:\...`) vira scheme `c:` (#11243).
      ["--import", "tsx", "--import", pathToFileURL(preload).href, SCRIPT, d, "--out", outPath],
      { encoding: "utf8", cwd: PROJECT_ROOT },
    );
    assert.equal(r.status, 0, `render falhou: ${r.stderr}`);
    assert.equal(readFileSync(join(d, "02-reviewed.md"), "utf8"), during, "o preload deveria ter regravado o reviewed");
    const html = readFileSync(outPath, "utf8");
    assert.match(html, /ANTES/, "o HTML reflete o texto lido antes do save");
    assert.doesNotMatch(html, /DURANTE/);

    const stamp = JSON.parse(readFileSync(join(d, RENDER_SOURCE_STAMP), "utf8"));
    assert.equal(stamp.reviewed_sha256, sha(before), "carimbo tem de ser o sha do texto renderizado, não da releitura");
    assert.notEqual(stamp.reviewed_sha256, sha(during));

    // Cadeia completa: final = draft (substitute), mais novo que tudo. Com o
    // carimbo certo, o sha divergente acusa mesmo com mtime fresco.
    writeFileSync(join(d, NEWSLETTER_FINAL_HTML), html);
    const fresh = evaluateNewsletterHtmlFreshnessOnDisk(d);
    assert.deepEqual([fresh.stale, fresh.reason], [true, "stamp-mismatch"]);
  });
});
