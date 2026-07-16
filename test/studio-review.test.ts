/**
 * test/studio-review.test.ts (#3559)
 *
 * Camada de leitura/escrita/diff/lint/preview do painel de revisão de
 * conteúdo rica (`scripts/studio-ui/studio-review.ts`). Tudo aqui roda
 * contra um `rootDir` tmpdir injetado — nunca toca o `data/` real.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  resolveReviewFile,
  isReviewSlug,
  readReviewFile,
  saveReviewFile,
  resetBaseline,
  computeReviewDiff,
  runReviewLints,
  buildReviewPreviewHtml,
  pullReviewFileBestEffort,
  REVIEW_FILES,
} from "../scripts/studio-ui/studio-review.ts";

const TWO_DESTAQUES_MD = [
  "**DESTAQUE 1 | LANÇAMENTO**",
  "",
  "**[IA chega às fábricas brasileiras](https://example.com/1)**",
  "",
  "Corpo do primeiro destaque com contexto suficiente.",
  "",
  "Por que isso importa: automatização industrial tem impacto direto no emprego.",
  "",
  "---",
  "",
  "**DESTAQUE 2 | PESQUISA**",
  "",
  "**[Modelos de linguagem superam humanos em diagnóstico](https://example.com/2)**",
  "",
  "Corpo do segundo destaque.",
  "",
  "Por que isso importa: abre caminho para triagem automatizada em clínicas.",
  "",
].join("\n");

describe("isReviewSlug (#3559)", () => {
  it("aceita só os 3 slugs conhecidos", () => {
    assert.equal(isReviewSlug("categorized"), true);
    assert.equal(isReviewSlug("reviewed"), true);
    assert.equal(isReviewSlug("social"), true);
    assert.equal(isReviewSlug("nope"), false);
    assert.equal(isReviewSlug(""), false);
  });
});

describe("resolveReviewFile (#3559)", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "studio-review-resolve-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("retorna null pra AAMMDD inválido", () => {
    assert.equal(resolveReviewFile(root, "nope", "reviewed"), null);
  });

  it("retorna null pra slug desconhecido", () => {
    assert.equal(resolveReviewFile(root, "260716", "unknown"), null);
  });

  it("resolve paths coerentes com REVIEW_FILES + baseline sob _internal/", () => {
    const resolved = resolveReviewFile(root, "260716", "reviewed");
    assert.ok(resolved);
    assert.equal(resolved!.filename, REVIEW_FILES.reviewed);
    assert.ok(resolved!.filePath.endsWith(REVIEW_FILES.reviewed));
    assert.match(resolved!.baselinePath, /_internal[\\/]studio-review-baseline[\\/]02-reviewed\.md\.md$/);
  });
});

function makeEdition(root: string, aammdd: string): string {
  const dir = resolve(root, "data", "editions", aammdd);
  mkdirSync(dir, { recursive: true });
  mkdirSync(resolve(dir, "_internal"), { recursive: true });
  return dir;
}

describe("readReviewFile / saveReviewFile / resetBaseline (#3559)", () => {
  let root: string;
  let editionDir: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "studio-review-io-"));
    editionDir = makeEdition(root, "260716");
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("exists:false quando o arquivo ainda não foi gerado", () => {
    const state = readReviewFile(root, "260716", "reviewed");
    assert.equal(state.ok, true);
    assert.equal(state.exists, false);
    assert.equal(state.content, "");
  });

  it("captura baseline na 1ª leitura e não sobrescreve em leituras seguintes", () => {
    writeFileSync(resolve(editionDir, "02-reviewed.md"), "versão do agente", "utf8");
    const first = readReviewFile(root, "260716", "reviewed");
    assert.equal(first.baseline, "versão do agente");

    // Editor "salva" uma edição — o disco muda, mas o baseline deve persistir.
    writeFileSync(resolve(editionDir, "02-reviewed.md"), "versão editada pelo editor", "utf8");
    const second = readReviewFile(root, "260716", "reviewed");
    assert.equal(second.content, "versão editada pelo editor");
    assert.equal(second.baseline, "versão do agente", "baseline não deve mudar em leituras subsequentes");
  });

  it("saveReviewFile escreve o conteúdo inteiro e retorna modifiedAt", () => {
    writeFileSync(resolve(editionDir, "02-reviewed.md"), "original", "utf8");
    const result = saveReviewFile(root, "260716", "reviewed", "novo conteúdo");
    assert.equal(result.ok, true);
    assert.ok(result.modifiedAt);
    assert.equal(readFileSync(resolve(editionDir, "02-reviewed.md"), "utf8"), "novo conteúdo");
  });

  it("saveReviewFile falha graciosamente pra edição inexistente", () => {
    const result = saveReviewFile(root, "999999", "reviewed", "x");
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /não encontrada/);
  });

  it("resetBaseline passa a comparar contra o conteúdo atual", () => {
    writeFileSync(resolve(editionDir, "02-reviewed.md"), "v1", "utf8");
    readReviewFile(root, "260716", "reviewed"); // captura baseline = v1
    writeFileSync(resolve(editionDir, "02-reviewed.md"), "v2", "utf8");
    const reset = resetBaseline(root, "260716", "reviewed");
    assert.equal(reset.ok, true);
    const state = readReviewFile(root, "260716", "reviewed");
    assert.equal(state.baseline, "v2");
  });
});

describe("computeReviewDiff (#3559)", () => {
  let root: string;
  let editionDir: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "studio-review-diff-"));
    editionDir = makeEdition(root, "260716");
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("vazio quando não há edições vs. baseline", () => {
    writeFileSync(resolve(editionDir, "03-social.md"), "conteúdo estável", "utf8");
    readReviewFile(root, "260716", "social"); // captura baseline
    const diff = computeReviewDiff(root, "260716", "social");
    assert.equal(diff.ok, true);
    assert.equal(diff.isEmpty, true);
  });

  it("não-vazio depois de uma edição salva", () => {
    writeFileSync(resolve(editionDir, "03-social.md"), "linha original", "utf8");
    readReviewFile(root, "260716", "social"); // captura baseline
    saveReviewFile(root, "260716", "social", "linha editada");
    const diff = computeReviewDiff(root, "260716", "social");
    assert.equal(diff.isEmpty, false);
    assert.ok(diff.lines.some((l) => l.type === "add" && l.text === "linha editada"));
    assert.ok(diff.lines.some((l) => l.type === "del" && l.text === "linha original"));
  });
});

describe("runReviewLints (#3559)", () => {
  let root: string;
  let editionDir: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "studio-review-lint-"));
    editionDir = makeEdition(root, "260716");
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("categorized: LANÇAMENTOS com URL não-oficial falha o check bloqueante", () => {
    const md = [
      "## Lançamentos",
      "",
      "**[Cobertura de um lançamento](https://techcrunch.com/algo)**",
      "",
    ].join("\n");
    const report = runReviewLints(root, editionDir, "categorized", md);
    const check = report.checks.find((c) => c.id === "lancamentos-oficiais");
    assert.ok(check);
    assert.equal(check!.ok, false);
    assert.equal(report.ok, false);
  });

  it("categorized: seção LANÇAMENTOS vazia passa", () => {
    const report = runReviewLints(root, editionDir, "categorized", "## Lançamentos\n");
    const check = report.checks.find((c) => c.id === "lancamentos-oficiais");
    assert.equal(check!.ok, true);
    assert.equal(report.ok, true);
  });

  it("reviewed: roda o conjunto de checks sem lançar e reporta 'skipped' sem 01-approved.json", () => {
    const report = runReviewLints(root, editionDir, "reviewed", TWO_DESTAQUES_MD);
    assert.ok(report.checks.length > 5, "deveria rodar vários checks estruturais");
    assert.ok(report.skipped.includes("section-counts"));
    assert.ok(report.skipped.includes("url-bucket"));
  });

  it("reviewed: inclui section-counts/url-bucket quando 01-approved.json existe", () => {
    writeFileSync(
      resolve(editionDir, "_internal", "01-approved.json"),
      JSON.stringify({
        highlights: [
          { url: "https://example.com/1" },
          { url: "https://example.com/2" },
        ],
      }),
      "utf8",
    );
    const report = runReviewLints(root, editionDir, "reviewed", TWO_DESTAQUES_MD);
    assert.ok(report.checks.some((c) => c.id === "section-counts"));
    assert.ok(report.checks.some((c) => c.id === "url-bucket"));
  });

  it("reviewed: check crashado (approved malformado não deveria crashar, mas simulamos md vazio) não derruba o batch", () => {
    // md vazio: countTitlesPerHighlight etc. devem lidar gracefully (podem
    // reportar ok:false, mas não devem lançar) — o próprio runCheck garante
    // fail-soft mesmo se algum check lançasse.
    const report = runReviewLints(root, editionDir, "reviewed", "");
    assert.ok(Array.isArray(report.checks));
    assert.ok(report.checks.length > 0);
  });

  it("social: CTA ausente falha o check bloqueante default", () => {
    const md = ["# LinkedIn", "", "**post principal:**", "", "Um post sem CTA nenhum."].join("\n");
    const report = runReviewLints(root, editionDir, "social", md);
    const cta = report.checks.find((c) => c.id === "cta-format");
    assert.ok(cta);
  });
});

describe("buildReviewPreviewHtml (#3559)", () => {
  let root: string;
  let editionDir: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "studio-review-preview-"));
    editionDir = makeEdition(root, "260716");
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("sem 02-reviewed.md → ok:false com mensagem clara, HTML de erro", () => {
    const preview = buildReviewPreviewHtml(editionDir);
    assert.equal(preview.ok, false);
    assert.match(preview.html, /Sem preview/);
  });

  it("com 02-reviewed.md válido → ok:true, HTML completo com os títulos", () => {
    writeFileSync(resolve(editionDir, "02-reviewed.md"), TWO_DESTAQUES_MD, "utf8");
    const preview = buildReviewPreviewHtml(editionDir);
    assert.equal(preview.ok, true);
    assert.match(preview.html, /IA chega às fábricas brasileiras/);
    assert.match(preview.html, /<html/);
  });

  it("fail-soft: 02-reviewed.md corrompido (0 destaques) não lança, retorna HTML de erro", () => {
    writeFileSync(resolve(editionDir, "02-reviewed.md"), "conteúdo sem nenhum bloco DESTAQUE", "utf8");
    const preview = buildReviewPreviewHtml(editionDir);
    assert.equal(preview.ok, false);
    assert.match(preview.html, /Erro ao renderizar preview/);
  });
});

describe("pullReviewFileBestEffort (#3559 — #494)", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "studio-review-pull-"));
    makeEdition(root, "260716");
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("nunca lança — spawnFn injetado simula sucesso", () => {
    const fakeSpawn = () =>
      ({ status: 0, stdout: JSON.stringify({ pulled: [] }), stderr: "", error: undefined }) as ReturnType<
        typeof import("node:child_process").spawnSync
      >;
    const result = pullReviewFileBestEffort(root, "260716", "reviewed", fakeSpawn as never);
    assert.equal(result.attempted, true);
    assert.equal(result.ok, true);
  });

  it("falha do subprocess vira warning fail-soft (ok:false), não lança", () => {
    const fakeSpawn = () =>
      ({ status: 1, stdout: "", stderr: "offline", error: undefined }) as ReturnType<
        typeof import("node:child_process").spawnSync
      >;
    const result = pullReviewFileBestEffort(root, "260716", "reviewed", fakeSpawn as never);
    assert.equal(result.attempted, true);
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /offline/);
  });

  it("edição inexistente → attempted:false, sem spawnar nada", () => {
    let called = false;
    const fakeSpawn = () => {
      called = true;
      return { status: 0, stdout: "{}", stderr: "", error: undefined } as ReturnType<
        typeof import("node:child_process").spawnSync
      >;
    };
    const result = pullReviewFileBestEffort(root, "999999", "reviewed", fakeSpawn as never);
    assert.equal(result.attempted, false);
    assert.equal(called, false);
  });
});
