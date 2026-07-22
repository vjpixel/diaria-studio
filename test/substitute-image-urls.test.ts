import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, utimesSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  buildFilenameMap,
  substituteImagePlaceholders,
  checkInputHtmlFreshness,
  htmlFinalBaselinePath,
} from "../scripts/substitute-image-urls.ts";
import { readReviewFile, saveReviewFile, computeReviewDiff } from "../scripts/studio-ui/studio-review.ts";

describe("buildFilenameMap", () => {
  it("constrói map de filename → URL a partir de images dict", () => {
    const map = buildFilenameMap({
      cover: { file_id: "1", url: "https://drive.google.com/uc?id=1&export=view", filename: "04-d1-2x1.jpg" },
      d2: { file_id: "2", url: "https://drive.google.com/uc?id=2&export=view", filename: "04-d2-1x1.jpg" },
    });
    assert.equal(map.size, 2);
    assert.equal(map.get("04-d1-2x1.jpg"), "https://drive.google.com/uc?id=1&export=view");
    assert.equal(map.get("04-d2-1x1.jpg"), "https://drive.google.com/uc?id=2&export=view");
  });

  it("pula entries sem filename ou url", () => {
    const map = buildFilenameMap({
      good: { file_id: "1", url: "https://a.com", filename: "04-d1.jpg" },
      no_url: { file_id: "2", url: "", filename: "04-d2-1x1.jpg" },
      no_filename: { file_id: "3", url: "https://a.com", filename: "" },
    });
    assert.equal(map.size, 1);
    assert.ok(map.has("04-d1.jpg"));
  });

  it("mapa vazio pra images vazio", () => {
    assert.equal(buildFilenameMap({}).size, 0);
  });
});

describe("substituteImagePlaceholders", () => {
  it("substitui placeholder único", () => {
    const html = `<img src="{{IMG:04-d1-2x1.jpg}}" alt="cover"/>`;
    const map = new Map([["04-d1-2x1.jpg", "https://drive.google.com/uc?id=abc"]]);
    const result = substituteImagePlaceholders(html, map);
    assert.equal(result.html, `<img src="https://drive.google.com/uc?id=abc" alt="cover"/>`);
    assert.equal(result.substitutions, 1);
    assert.deepEqual(result.unresolved, []);
  });

  it("substitui múltiplas placeholders", () => {
    const html = `<img src="{{IMG:04-d1-2x1.jpg}}"/><img src="{{IMG:04-d2-1x1.jpg}}"/><img src="{{IMG:04-d3-1x1.jpg}}"/>`;
    const map = new Map([
      ["04-d1-2x1.jpg", "https://a.com/1"],
      ["04-d2-1x1.jpg", "https://a.com/2"],
      ["04-d3-1x1.jpg", "https://a.com/3"],
    ]);
    const result = substituteImagePlaceholders(html, map);
    assert.equal(result.substitutions, 3);
    assert.ok(result.html.includes("https://a.com/1"));
    assert.ok(result.html.includes("https://a.com/2"));
    assert.ok(result.html.includes("https://a.com/3"));
    assert.equal(result.unresolved.length, 0);
  });

  it("placeholder sem match fica como está + unresolved tem o nome", () => {
    const html = `<img src="{{IMG:missing.jpg}}"/>`;
    const map = new Map<string, string>();
    const result = substituteImagePlaceholders(html, map);
    assert.equal(result.substitutions, 0);
    assert.equal(result.html, `<img src="{{IMG:missing.jpg}}"/>`);
    assert.deepEqual(result.unresolved, ["missing.jpg"]);
  });

  it("mix de resolvido + não resolvido", () => {
    const html = `<img src="{{IMG:04-d1.jpg}}"/><img src="{{IMG:ghost.jpg}}"/>`;
    const map = new Map([["04-d1.jpg", "https://a.com/d1"]]);
    const result = substituteImagePlaceholders(html, map);
    assert.equal(result.substitutions, 1);
    assert.deepEqual(result.unresolved, ["ghost.jpg"]);
    assert.ok(result.html.includes("https://a.com/d1"));
    assert.ok(result.html.includes("{{IMG:ghost.jpg}}"));
  });

  it("unresolved dedupe (mesmo placeholder 2x vira 1 entry)", () => {
    const html = `{{IMG:missing.jpg}} e {{IMG:missing.jpg}}`;
    const result = substituteImagePlaceholders(html, new Map());
    assert.deepEqual(result.unresolved, ["missing.jpg"]);
  });

  it("HTML sem placeholders retorna unchanged", () => {
    const html = `<p>Conteúdo sem imagens</p>`;
    const result = substituteImagePlaceholders(html, new Map());
    assert.equal(result.html, html);
    assert.equal(result.substitutions, 0);
    assert.equal(result.unresolved.length, 0);
  });

  it("trim de espaços no nome do placeholder", () => {
    const html = `<img src="{{IMG: 04-d1.jpg }}"/>`;
    const map = new Map([["04-d1.jpg", "https://a.com/d1"]]);
    const result = substituteImagePlaceholders(html, map);
    assert.equal(result.substitutions, 1);
  });
});

// ── #2316: fail-loud stale guard ─────────────────────────────────────────────

describe("#2316: checkInputHtmlFreshness — rejeita HTML mais antigo que 02-reviewed.md", () => {
  it("retorna null quando HTML é mais novo que reviewed.md (pipeline ok)", () => {
    const dir = mkdtempSync(join(tmpdir(), "diaria-subst-fresh-"));
    try {
      const mdPath = join(dir, "02-reviewed.md");
      const htmlPath = join(dir, "newsletter-draft.html");
      // MD criado primeiro (timestamp mais antigo)
      writeFileSync(mdPath, "# md", "utf8");
      // Força mtime do MD para 1s no passado
      const pastMs = Date.now() - 2000;
      utimesSync(mdPath, new Date(pastMs), new Date(pastMs));
      // HTML criado depois (timestamp mais recente)
      writeFileSync(htmlPath, "<html/>", "utf8");
      assert.strictEqual(checkInputHtmlFreshness(htmlPath, mdPath), null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("retorna mensagem de erro quando HTML é mais antigo que reviewed.md (render falhou)", () => {
    const dir = mkdtempSync(join(tmpdir(), "diaria-subst-stale-"));
    try {
      const htmlPath = join(dir, "newsletter-draft.html");
      const mdPath = join(dir, "02-reviewed.md");
      // HTML criado primeiro (timestamp mais antigo)
      writeFileSync(htmlPath, "<html/>", "utf8");
      // Força mtime do HTML para 2s no passado
      const pastMs = Date.now() - 2000;
      utimesSync(htmlPath, new Date(pastMs), new Date(pastMs));
      // MD criado depois (timestamp mais recente = render não rodou desde o MD)
      writeFileSync(mdPath, "# md", "utf8");

      const result = checkInputHtmlFreshness(htmlPath, mdPath);
      assert.ok(result !== null, "deve retornar mensagem de erro quando HTML está stale");
      assert.match(result, /desatualizado/);
      assert.match(result, /render-newsletter-html\.ts/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("retorna null quando reviewed.md não existe (fail-open)", () => {
    const dir = mkdtempSync(join(tmpdir(), "diaria-subst-nomd-"));
    try {
      const htmlPath = join(dir, "newsletter-draft.html");
      writeFileSync(htmlPath, "<html/>", "utf8");
      // reviewed.md não existe — sem guard (compatibilidade)
      assert.strictEqual(
        checkInputHtmlFreshness(htmlPath, join(dir, "02-reviewed.md")),
        null,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // #2316 fail-loud: HTML ausente deve retornar mensagem acionável (não deixar
  // readFileSync jogar ENOENT opaco mais tarde).
  it("#2316: retorna mensagem de erro quando HTML de input não existe (fail-loud)", () => {
    const dir = mkdtempSync(join(tmpdir(), "diaria-subst-nohtml-"));
    try {
      const htmlPath = join(dir, "newsletter-draft.html");
      const mdPath = join(dir, "02-reviewed.md");
      // reviewed.md existe, HTML não
      writeFileSync(mdPath, "# md", "utf8");

      const result = checkInputHtmlFreshness(htmlPath, mdPath);
      assert.ok(result !== null, "deve retornar mensagem de erro quando HTML não existe");
      assert.match(result, /não encontrado/);
      assert.match(result, /render-newsletter-html\.ts/);
      // Deve mencionar o path do HTML ausente
      assert.ok(result.includes("newsletter-draft.html"), `mensagem: ${result}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── #3829: refresh do baseline "html-final" no re-render da pipeline ───────

describe("htmlFinalBaselinePath (#3829)", () => {
  it("reconhece o newsletter-final.html canônico (dentro de _internal/)", () => {
    const outPath = join("data", "editions", "260716", "_internal", "newsletter-final.html");
    const baseline = htmlFinalBaselinePath(outPath);
    assert.ok(baseline);
    assert.match(baseline!, /_internal[\\/]studio-review-baseline[\\/]newsletter-final\.html\.md$/);
  });

  it("retorna null pra outros nomes de output (ex: newsletter-draft.html, --split)", () => {
    assert.equal(htmlFinalBaselinePath(join("data", "editions", "260716", "_internal", "newsletter-draft.html")), null);
    assert.equal(htmlFinalBaselinePath(join("data", "editions", "260716", "_internal", "newsletter-body.html")), null);
  });

  it("retorna null quando newsletter-final.html não está sob uma pasta _internal/ (--out de debug)", () => {
    assert.equal(htmlFinalBaselinePath(join("data", "editions", "260716", "newsletter-final.html")), null);
    assert.equal(htmlFinalBaselinePath(join(tmpdir(), "newsletter-final.html")), null);
  });
});

describe("#3829: baseline html-final refresca no re-render da pipeline (regressão)", () => {
  let root: string;
  let editionDir: string;
  let internalDir: string;
  let htmlOutPath: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "diaria-html-final-baseline-"));
    editionDir = resolve(root, "data", "editions", "260716");
    internalDir = resolve(editionDir, "_internal");
    mkdirSync(internalDir, { recursive: true });
    htmlOutPath = resolve(internalDir, "newsletter-final.html");
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  /** Simula o que `main()` de substitute-image-urls.ts faz ao escrever
   * `--out .../newsletter-final.html`: grava o arquivo e, se aplicável,
   * refresca o baseline — sem invocar o CLI/subprocess (as funções puras já
   * são as testadas; isto evita duplicar a lógica de main() aqui). */
  function simulatePipelineRender(html: string): void {
    writeFileSync(htmlOutPath, html, "utf8");
    const baselinePath = htmlFinalBaselinePath(htmlOutPath);
    assert.ok(baselinePath, "newsletter-final.html deveria mapear pra um baseline path");
    mkdirSync(resolve(baselinePath!, ".."), { recursive: true });
    writeFileSync(baselinePath!, html, "utf8");
  }

  it("re-render sem edição manual pendente: diff do painel volta a isEmpty:true (banner apaga)", () => {
    // 1) Etapa 4 gera v1. Editor abre o painel — baseline capturado = v1.
    simulatePipelineRender("<html>v1</html>");
    readReviewFile(root, "260716", "html-final"); // captura baseline preguiçoso, se ainda não existir
    assert.equal(computeReviewDiff(root, "260716", "html-final").isEmpty, true);

    // 2) Editor edita manualmente no Studio → v2. Banner acende (correto).
    saveReviewFile(root, "260716", "html-final", "<html>v2 editado à mão</html>");
    assert.equal(computeReviewDiff(root, "260716", "html-final").isEmpty, false);

    // 3) Editor re-roda a Etapa 4 → pipeline re-renderiza fresh do Markdown,
    // descartando a edição manual (o evento que o banner avisava já
    // aconteceu). ANTES do fix (#3829): o baseline continuava em v1 e o
    // banner ficava aceso pra sempre comparando v3 contra v1. DEPOIS do
    // fix: o re-render refresca o baseline pro novo conteúdo.
    simulatePipelineRender("<html>v3 gerado pela pipeline</html>");
    const diffAfterRerender = computeReviewDiff(root, "260716", "html-final");
    assert.equal(diffAfterRerender.isEmpty, true, "banner deveria apagar após o re-render da pipeline");
  });

  it("save do editor via Studio NÃO refresca o baseline (edição de última milha continua sinalizada)", () => {
    simulatePipelineRender("<html>v1</html>");
    readReviewFile(root, "260716", "html-final");
    assert.equal(computeReviewDiff(root, "260716", "html-final").isEmpty, true);

    saveReviewFile(root, "260716", "html-final", "<html>v1 + correção manual</html>");
    const diff = computeReviewDiff(root, "260716", "html-final");
    assert.equal(diff.isEmpty, false, "save do editor deve continuar disparando o aviso de divergência");
    assert.ok(diff.lines.some((l) => l.type === "add" && l.text.includes("correção manual")));

    // Confirma que o conteúdo do baseline em disco não mudou por causa do save
    // (só `saveReviewFile` do arquivo principal — nunca o baseline).
    const baselinePath = htmlFinalBaselinePath(htmlOutPath)!;
    assert.equal(readFileSync(baselinePath, "utf8"), "<html>v1</html>");
  });
});
