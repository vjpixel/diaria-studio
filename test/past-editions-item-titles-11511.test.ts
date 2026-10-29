import { it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { renderMarkdown } from "../scripts/refresh-past-editions.ts";
import { extractPastItemTitles, extractPastUrls } from "../scripts/lib/past-editions-extract.ts";

it("#11511: regen guarda títulos publicados e CLI dedup funciona sem diretórios de edições", () => {
  const root = mkdtempSync(join(tmpdir(), "past-titles-"));
  try {
    const dir = join(root, "data/editions/2610/261028");
    mkdirSync(join(dir, "_internal"), { recursive: true });
    writeFileSync(join(dir, "_internal/01-approved.json"), JSON.stringify({
      highlights: [{ article: { url: "https://a.example/ios", title: "Apple apresenta iOS 27.2" } }],
      radar: [{ url: "https://a.example/genie", title: "Genie 4 disponível" },
        { url: "https://a.example/cut", title: "Gemma 4 fora da edição" }],
    }));
    writeFileSync(join(dir, "02-reviewed.md"), "**[Siri em português no iOS 27.2](https://a.example/ios)**\n**[Conheça Genie 4](https://a.example/genie)**");
    const md = renderMarkdown([{
      id: "test", title: "Manchete sem produto", published_at: "2026-10-28",
      links: ["https://a.example/ios", "https://a.example/genie", "https://a.example/legacy"],
    }], root);
    assert.match(md, /- https:\/\/a.example\/ios — Siri em português no iOS 27.2/);
    assert.match(md, /- https:\/\/a.example\/genie — Conheça Genie 4/);
    assert.doesNotMatch(md, /Gemma 4/);
    assert.equal(extractPastUrls(md, 3).size, 3);
    assert.deepEqual(extractPastItemTitles(md, 3, "261029"), ["Siri em português no iOS 27.2", "Conheça Genie 4"]);
    assert.deepEqual(extractPastItemTitles(md, 3, "261028"), []);
    const past = join(root, "past.md");
    writeFileSync(past, md);
    const articles = join(root, "articles.json");
    writeFileSync(articles, JSON.stringify([
      // #11576: tópico em comum ("português") além do produto+versão → remove.
      { url: "https://b.example/1", title: "Siri fala português no iOS 27.2" },
      // #11576: só o produto+versão em comum, sem segundo sinal → fica marcado.
      { url: "https://b.example/2", title: "Experimente o Genie 4 hoje" },
      { url: "https://b.example/3", title: "iOS 27.3 chega" },
      { url: "https://b.example/4", title: "Gemma 4 disponível" },
      { url: "https://b.example/5", title: "Mais novidades do Genie 4", flag: "editor_submitted" },
    ]));
    const out = join(root, "out.json");
    execFileSync(process.execPath, ["--import", "tsx", resolve("scripts/dedup.ts"),
      "--articles", articles, "--past-editions", past, "--editions-dir", join(root, "missing"),
      "--current-edition", "261029", "--log-root-dir", root, "--out", out], { stdio: "pipe" });
    const result = JSON.parse(readFileSync(out, "utf8"));
    assert.equal(result.removed.length, 1);
    assert.equal(result.removed[0].url, "https://b.example/1");
    assert.match(result.removed[0].dedup_note, /same-product-version \(#11511, tópico: portugues\)/);
    assert.equal(result.kept.length, 4);
    assert.match(result.kept.find((a: { url: string }) => a.url === "https://b.example/2").event_dedup_flagged, /sem segundo sinal \(#11576/);
    assert.match(result.kept.find((a: { flag?: string }) => a.flag === "editor_submitted").event_dedup_flagged, /same-product-version/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it("#11511: títulos de HTML/markdown remoto, legado e janela curta", () => {
  const root = mkdtempSync(join(tmpdir(), "remote-titles-"));
  try {
    const md = renderMarkdown([{ id: "remote", title: "Remota", published_at: "2026-10-28",
      html: '<a href="https://a.example/x"><strong>Genie 4 &amp; novidades</strong></a>',
      markdown: '**[Siri no iOS 27.2](https://a.example/y)**',
    }], root);
    assert.deepEqual(extractPastItemTitles(md, 3), ["Genie 4 & novidades", "Siri no iOS 27.2"]);
    const older = '\n## 2026-10-27 — "Antiga"\nLinks usados:\n- https://old.example — Gemma 4\n';
    assert.equal(extractPastItemTitles(md + older, 1).length, 2);
    assert.deepEqual(extractPastItemTitles('## 2026-10-28 — "Legada"\n- https://a.example/x', 3), []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
