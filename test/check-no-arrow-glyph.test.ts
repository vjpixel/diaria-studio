/**
 * test/check-no-arrow-glyph.test.ts (#9721): a seta `→` não volta ao que
 * chega ao leitor.
 *
 * Cobre as duas metades da issue: a remoção mecânica (`stripCtaArrows`,
 * usada em runtime pelo carregador de caixas e pelo `renderHTML` da
 * newsletter) e o check de CI (`scripts/check-no-arrow-glyph.ts`). O teste
 * de regressão principal é "o repo real está limpo" + "reintroduzir a seta
 * num arquivo publicado/gerador/caixa faz o check falhar".
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { ARROW_GLYPH, findArrowGlyphs, stripCtaArrows } from "../scripts/lib/shared/arrow-glyph.ts";
import {
  ALLOWLIST,
  resolveGeneratorFiles,
  scanGeneratorSource,
  scanPublishedText,
  scanRepo,
  scanSnippet,
  staleAllowlistEntries,
} from "../scripts/lib/no-arrow-glyph-scan.ts";
import { formatReport } from "../scripts/check-no-arrow-glyph.ts";
import { readSnippetFile } from "../scripts/lib/shared/snippet-loader.ts";
import {
  renderJogarArchiveLinkRow,
  renderLeaderboardLinkRow,
} from "../scripts/lib/newsletter-render-html.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "no-arrow-9721-"));
}

function put(root: string, rel: string, content: string): void {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

describe("stripCtaArrows (#9721)", () => {
  it("tira a seta do fim do rótulo de link/botão (HTML e markdown)", () => {
    assert.equal(stripCtaArrows('<a href="/archive">Ver todas as edições →</a>'), '<a href="/archive">Ver todas as edições</a>');
    assert.equal(stripCtaArrows('<button class="x">Próxima rodada →</button>'), '<button class="x">Próxima rodada</button>');
    assert.equal(stripCtaArrows("[Ver os livros →](https://livros.diar.ia.br)"), "[Ver os livros](https://livros.diar.ia.br)");
  });

  it("tira o span decorativo aria-hidden do botão", () => {
    assert.equal(
      stripCtaArrows('<a class="button">Garanta seu ingresso <span aria-hidden="true">→</span></a>'),
      '<a class="button">Garanta seu ingresso</a>',
    );
  });

  it("tira o prefixo de CTA (sintaxe legada `→ [label](url)` e `<p>→ <a>`)", () => {
    assert.equal(stripCtaArrows("Texto.\n\n→ [Saiba mais](https://x.y)"), "Texto.\n\n[Saiba mais](https://x.y)");
    assert.equal(stripCtaArrows('<p style="a">→ <a href="https://clarice.ai">Clarice</a></p>'), '<p style="a"><a href="https://clarice.ai">Clarice</a></p>');
  });

  it("troca o lead-in `texto → <a>` por dois-pontos", () => {
    assert.equal(
      stripCtaArrows('Veja o ranking de quem mais acerta → <a href="u">ranking</a>'),
      'Veja o ranking de quem mais acerta: <a href="u">ranking</a>',
    );
    assert.equal(stripCtaArrows("apoiar → [apoia.se](https://apoia.se/diaria)"), "apoiar: [apoia.se](https://apoia.se/diaria)");
  });

  it("não mexe em seta editorial fora de posição de CTA, e é idempotente", () => {
    const editorial = "OpenAI: 87% do tráfego global → <b>68%</b> em um ano";
    assert.equal(stripCtaArrows(editorial), editorial);
    const once = stripCtaArrows('Ver →</a> e → [x](y)');
    assert.equal(stripCtaArrows(once), once);
  });
});

describe("findArrowGlyphs / allowlist por trecho exato (#9721)", () => {
  it("trecho liberado é mascarado, mas uma seta NOVA no mesmo arquivo continua pega", () => {
    const frag = "87% → 68%";
    assert.equal(findArrowGlyphs(`x ${frag} y`, [frag]).length, 0);
    const hits = findArrowGlyphs(`x ${frag} y\n<a>Ver →</a>`, [frag]);
    assert.equal(hits.length, 1);
    assert.equal(hits[0].line, 2);
  });

  it("cada entrada da ALLOWLIST tem motivo e contém a seta", () => {
    assert.ok(ALLOWLIST.length > 0);
    for (const a of ALLOWLIST) {
      assert.ok(a.fragment.includes(ARROW_GLYPH), a.path);
      assert.ok(a.reason.length > 10, a.path);
    }
  });

  it("entrada da allowlist cujo trecho sumiu é reportada como obsoleta", () => {
    const stale = staleAllowlistEntries(() => "conteúdo sem o trecho", [
      { path: "p/x.html", fragment: "a → b", reason: "teste de obsolescência" },
    ]);
    assert.equal(stale.length, 1);
    assert.equal(stale[0].kind, "stale-allowlist");
  });

  it("scanPublishedText pega seta até em comentário (o arquivo inteiro vai pro ar)", () => {
    assert.equal(scanPublishedText("workers/site/public/_redirects", "# a → b\n/x /y 301\n", []).length, 1);
  });
});

describe("scanGeneratorSource: só literais de string/template (#9721)", () => {
  it("pega seta em string, template e template com substituição", () => {
    const src = [
      'const a = "Assine →";',
      "const b = `<a>Ver →</a>`;",
      "const c = `<a href=\"${u}\">${t} →</a>`;",
    ].join("\n");
    assert.equal(scanGeneratorSource("g.ts", src).length, 3);
  });

  it("ignora comentário e regex (sintaxe legada aceita na ENTRADA)", () => {
    const src = [
      "// D1 → D2 → D3 (doc interna)",
      "/** slug → label */",
      "const re = /^(?:→\\s*|Acesse\\s+)/u;",
      'const ok = "sem seta";',
    ].join("\n");
    assert.deepEqual(scanGeneratorSource("g.ts", src), []);
  });
});

describe("scanSnippet (data/snippets) (#9721)", () => {
  it("ignora o header <!-- --> (não chega ao leitor) e pega o corpo", () => {
    const md = "<!-- slot1 → D1/D2 -->\n**📚 Livros**\n\n→ [Ver](https://livros.diar.ia.br)\n";
    const hits = scanSnippet("data/snippets/x.md", md);
    assert.equal(hits.length, 1);
    assert.equal(hits[0].line, 4);
  });
});

describe("resolveGeneratorFiles (#9721)", () => {
  it("spec que não resolve nada vai em `missing` (gerador renomeado não some em silêncio)", () => {
    const root = tempRoot();
    try {
      put(root, "scripts/lib/site-home-page.ts", "export const x = 1;");
      const r = resolveGeneratorFiles(root, ["scripts/lib/site-*.ts", "scripts/lib/nao-existe.ts", "workers/x/*.generated.ts"]);
      assert.deepEqual(r.files, ["scripts/lib/site-home-page.ts"]);
      assert.deepEqual(r.missing, ["scripts/lib/nao-existe.ts", "workers/x/*.generated.ts"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("check-no-arrow-glyph: repo real e reintrodução (#9721, regressão #633)", () => {
  // Hermético (#9739): só o conteúdo VERSIONADO (workers/*/public, geradores,
  // templates) — nunca o `data/snippets/` do disco da máquina, que é conteúdo
  // do editor e não é o que este teste está afirmando. Cobre `→` e `←` (#9723).
  it("o repo real versionado está limpo de → e ← (só as exceções editoriais documentadas)", () => {
    const result = scanRepo(ROOT, { includeSnippets: false });
    const { ok, text } = formatReport(result);
    assert.ok(ok, text);
    assert.equal(result.snippetsPresent, false, "data/snippets/ do disco não pode entrar neste teste");
    assert.equal(result.scannedSnippets, 0);
    assert.ok(result.scannedPublished > 100, "varredura de workers/site/public não rodou");
    assert.ok(result.scannedGenerators >= 20, "lista de geradores encolheu");
  });

  it("includeSnippets:false ignora data/snippets/ mas segue reprovando → e ← em arquivo versionado (#9739)", () => {
    const root = tempRoot();
    try {
      put(root, "data/snippets/caixa.md", "**Caixa**\n\n→ [Ver](https://x.y)\n");
      put(root, "workers/site/public/index.html", "<a>Ver todas as edições</a>");
      const clean = scanRepo(root, { includeSnippets: false });
      assert.equal(clean.snippetsPresent, false);
      assert.deepEqual(clean.findings.filter((f) => f.kind === "snippet" || f.kind === "published"), []);
      // o default (CLI) continua varrendo as caixas quando existem
      assert.equal(scanRepo(root).findings.filter((f) => f.kind === "snippet").length, 1);

      put(root, "workers/site/public/index.html", '<a href="/">← Voltar</a> <a>Ver →</a>');
      const dirty = scanRepo(root, { includeSnippets: false });
      assert.equal(dirty.findings.filter((f) => f.kind === "published").length, 2, JSON.stringify(dirty.findings));
      assert.equal(formatReport(dirty).ok, false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reintroduzir a seta num botão publicado, num gerador ou numa caixa faz o check falhar", () => {
    const root = tempRoot();
    try {
      put(root, "workers/site/public/evento/x/index.html", '<a class="button">Garanta seu ingresso <span aria-hidden="true">→</span></a>');
      put(root, "scripts/lib/site-home-page.ts", "export const cta = `<a href=\"/archive\">Ver todas as edições →</a>`;");
      put(root, "data/snippets/livros-divulgacao.md", "<!-- header → ok -->\n**📚 Livros**\n\n→ [Ver os livros](https://livros.diar.ia.br)\n");
      put(root, "data/snippets/_arquivo/velha.md", "→ [arquivada](https://x.y)\n");
      const result = scanRepo(root);
      const kinds = result.findings.map((f) => f.kind);
      assert.ok(kinds.includes("published"), JSON.stringify(result.findings));
      assert.ok(kinds.includes("generator"), JSON.stringify(result.findings));
      assert.equal(result.findings.filter((f) => f.kind === "snippet").length, 1, "_arquivo/ e o header não contam");
      assert.ok(result.snippetsPresent);
      assert.equal(formatReport(result).ok, false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("data/snippets/ ausente (CI) é fail-soft: avisa e não conta como falha", () => {
    const root = tempRoot();
    try {
      put(root, "workers/site/public/index.html", "<a>Ver todas as edições</a>");
      const result = scanRepo(root);
      assert.equal(result.snippetsPresent, false);
      const published = result.findings.filter((f) => f.kind !== "missing-generator" && f.kind !== "stale-allowlist");
      assert.deepEqual(published, []);
      assert.match(formatReport({ ...result, findings: [] }).text, /data\/snippets\/ ausente/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("o check está wired no job 'Static invariants check' de pr-checks.yml (roda em todo PR)", () => {
    const yml = readFileSync(join(ROOT, ".github", "workflows", "pr-checks.yml"), "utf8");
    const job = yml.slice(yml.indexOf("  invariants-static:"), yml.indexOf("  regression-test-gate:"));
    assert.match(job, /npx tsx scripts\/check-no-arrow-glyph\.ts/);
  });
});

describe("runtime: a seta não passa pelo carregador de caixas nem pelo render (#9721)", () => {
  it("readSnippetFile remove a seta de CTA de data/snippets (sem reescrever o arquivo)", () => {
    const root = tempRoot();
    try {
      const raw = "**📚 Livros**\n\n→ [Ver os livros →](https://livros.diar.ia.br)\n";
      put(root, "data/snippets/livros.md", raw);
      const out = readSnippetFile("livros.md", root);
      assert.equal(out, "**📚 Livros**\n\n[Ver os livros](https://livros.diar.ia.br)");
      assert.equal(readFileSync(join(root, "data/snippets/livros.md"), "utf8"), raw, "conteúdo do editor fica intacto em disco");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("linhas fixas do É IA? na newsletter saem sem a seta", () => {
    assert.ok(!renderLeaderboardLinkRow("").includes(ARROW_GLYPH));
    assert.ok(!renderJogarArchiveLinkRow("").includes(ARROW_GLYPH));
  });
});
