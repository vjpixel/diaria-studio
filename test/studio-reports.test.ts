/**
 * test/studio-reports.test.ts (#3714)
 *
 * Cobertura de `scripts/studio-ui/studio-reports.ts` — a lógica pura +
 * I/O de arquivo por trás da superfície de Relatórios do Studio:
 * `registerReport` (append-only, file-based, fail-soft), `listReports`
 * (dedup por id + ordenação por createdAt desc), `getReportById` e
 * `resolveReportHtml` (guard de path traversal + wrap de markdown).
 * Fixtures em tmpdir, mesmo padrão de `test/studio-round.test.ts`.
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  registerReport,
  listReports,
  getReportById,
  resolveReportHtml,
  renderMarkdownToHtml,
  reportId,
  isReportKind,
  type ReportEntry,
} from "../scripts/studio-ui/studio-reports.ts";

let root: string | null = null;

afterEach(() => {
  if (root) {
    rmSync(root, { recursive: true, force: true });
    root = null;
  }
});

function makeRoot(): string {
  root = mkdtempSync(join(tmpdir(), "studio-reports-"));
  return root;
}

describe("isReportKind / reportId (#3714)", () => {
  it("aceita só os 4 kinds válidos", () => {
    assert.equal(isReportKind("edicao"), true);
    assert.equal(isReportKind("overnight"), true);
    assert.equal(isReportKind("develop"), true);
    assert.equal(isReportKind("mensal"), true);
    assert.equal(isReportKind("qualquer-outra-coisa"), false);
  });

  it("id é `{kind}-{sessionId}` — estável entre chamadas", () => {
    assert.equal(reportId("overnight", "260720"), "overnight-260720");
    assert.equal(reportId("edicao", "260720"), "edicao-260720");
  });
});

describe("registerReport / listReports (#3714)", () => {
  it("registry ausente -> listReports retorna []", () => {
    const r = makeRoot();
    assert.deepEqual(listReports(r), []);
  });

  it("registra 1 relatório -> listReports retorna 1 entry com o shape esperado", () => {
    const r = makeRoot();
    const result = registerReport(r, {
      kind: "edicao",
      sessionId: "260720",
      title: "Diar.ia — relatório de edição 260720",
      htmlPath: "data/editions/260720/_internal/edition-report.html",
    });
    assert.equal(result.ok, true);
    assert.equal(result.entry?.id, "edicao-260720");
    assert.equal(result.entry?.url, "/relatorios/edicao-260720");

    const reports = listReports(r);
    assert.equal(reports.length, 1);
    assert.equal(reports[0].id, "edicao-260720");
    assert.equal(reports[0].kind, "edicao");
    assert.equal(reports[0].sessionId, "260720");
    assert.equal(reports[0].htmlPath, "data/editions/260720/_internal/edition-report.html");
    assert.match(reports[0].createdAt, /^\d{4}-\d{2}-\d{2}T/); // ISO
  });

  it("N relatórios de kinds/sessões diferentes -> listReports retorna todos, mais recente primeiro", () => {
    const r = makeRoot();
    registerReport(r, {
      kind: "edicao",
      sessionId: "260718",
      title: "Edição 260718",
      htmlPath: "a.html",
      createdAt: "2026-07-18T10:00:00.000Z",
    });
    registerReport(r, {
      kind: "overnight",
      sessionId: "260719",
      title: "Overnight 260719",
      htmlPath: "b.md",
      createdAt: "2026-07-19T23:00:00.000Z",
    });
    registerReport(r, {
      kind: "develop",
      sessionId: "260720",
      title: "Develop 260720",
      htmlPath: "c.md",
      createdAt: "2026-07-20T09:00:00.000Z",
    });

    const reports = listReports(r);
    assert.equal(reports.length, 3);
    assert.deepEqual(
      reports.map((x) => x.id),
      ["develop-260720", "overnight-260719", "edicao-260718"], // mais recente no topo
    );
  });

  it("registrar de novo o MESMO (kind, sessionId) -> última entry vence na leitura, arquivo físico só cresce (append-only)", () => {
    const r = makeRoot();
    registerReport(r, {
      kind: "overnight",
      sessionId: "260720",
      title: "Diar.ia overnight 260720 — 2 resolvidas",
      htmlPath: "data/overnight/260720/report.md",
      createdAt: "2026-07-20T20:00:00.000Z",
    });
    registerReport(r, {
      kind: "overnight",
      sessionId: "260720",
      title: "Diar.ia overnight 260720 — 5 resolvidas", // regenerado no fim da rodada
      htmlPath: "data/overnight/260720/report.md",
      createdAt: "2026-07-20T23:30:00.000Z",
    });

    const reports = listReports(r);
    assert.equal(reports.length, 1); // dedupado por id
    assert.equal(reports[0].title, "Diar.ia overnight 260720 — 5 resolvidas");

    // append-only: o arquivo físico tem as 2 linhas, nunca foi truncado.
    const raw = readFileSync(join(r, "data", "reports", "index.jsonl"), "utf8");
    const lines = raw.split("\n").filter((l) => l.trim());
    assert.equal(lines.length, 2);
  });

  it("linha corrompida no registry é ignorada, não derruba a listagem", () => {
    const r = makeRoot();
    registerReport(r, {
      kind: "edicao",
      sessionId: "260720",
      title: "Edição 260720",
      htmlPath: "a.html",
    });
    // Injeta uma linha corrompida entre as válidas.
    const path = join(r, "data", "reports", "index.jsonl");
    writeFileSync(path, readFileSync(path, "utf8") + "{ not json\n");
    registerReport(r, {
      kind: "overnight",
      sessionId: "260720",
      title: "Overnight 260720",
      htmlPath: "b.md",
    });

    const reports = listReports(r);
    assert.equal(reports.length, 2);
  });

  it("getReportById encontra por id; retorna null se nunca registrado", () => {
    const r = makeRoot();
    registerReport(r, { kind: "mensal", sessionId: "2605-06", title: "Digest 2605-06", htmlPath: "x.html" });

    const found = getReportById(r, "mensal-2605-06");
    assert.ok(found);
    assert.equal(found?.title, "Digest 2605-06");

    assert.equal(getReportById(r, "mensal-9999-99"), null);
  });

  it("fail-soft: rootDir onde mkdir falha (arquivo no lugar do diretório) -> ok:false, error preenchido, nunca lança", () => {
    const r = makeRoot();
    // Cria um ARQUIVO chamado "data" pra forçar mkdirSync(..., {recursive:true})
    // a falhar (ENOTDIR) — simula disco/permissão hostil sem precisar de root.
    writeFileSync(join(r, "data"), "não é um diretório");

    let result: ReturnType<typeof registerReport> | undefined;
    assert.doesNotThrow(() => {
      result = registerReport(r, { kind: "edicao", sessionId: "260720", title: "x", htmlPath: "x.html" });
    });
    assert.equal(result?.ok, false);
    assert.ok(result?.error);
  });
});

describe("renderMarkdownToHtml (#3784 — renderer mínimo zero-dep)", () => {
  it("headings h1/h2/h3", () => {
    const html = renderMarkdownToHtml("# Título\n## Sub\n### Sub-sub");
    assert.match(html, /<h1>Título<\/h1>/);
    assert.match(html, /<h2>Sub<\/h2>/);
    assert.match(html, /<h3>Sub-sub<\/h3>/);
  });

  it("bold **texto** -> <strong>", () => {
    const html = renderMarkdownToHtml("Isto é **importante** aqui.");
    assert.match(html, /<strong>importante<\/strong>/);
    assert.ok(!html.includes("**"));
  });

  it("--- vira <hr>, não heading nem texto cru", () => {
    const html = renderMarkdownToHtml("Antes\n\n---\n\nDepois");
    assert.match(html, /<hr>/);
    assert.ok(!html.includes("---"));
  });

  it("lista `- item` vira <ul><li>", () => {
    const html = renderMarkdownToHtml("- primeiro\n- segundo\n- terceiro");
    assert.match(html, /<ul>/);
    assert.match(html, /<li>primeiro<\/li>/);
    assert.match(html, /<li>segundo<\/li>/);
    assert.match(html, /<\/ul>/);
  });

  it("parágrafos simples viram <p>", () => {
    const html = renderMarkdownToHtml("Primeira linha.\n\nSegunda linha.");
    assert.match(html, /<p>Primeira linha\.<\/p>/);
    assert.match(html, /<p>Segunda linha\.<\/p>/);
  });

  it("tabela markdown (header + separador + rows) vira <table>", () => {
    const html = renderMarkdownToHtml(
      "| Issue | PR |\n|---|---|\n| #3784 | [#3800](https://github.com/x/y/pull/3800) |",
    );
    assert.match(html, /<table>/);
    assert.match(html, /<th>Issue<\/th>/);
    assert.match(html, /<th>PR<\/th>/);
    assert.match(html, /<td>#3784<\/td>/);
    assert.ok(!html.includes("|---|")); // linha separadora não vira row de dados
  });

  it("link [texto](url) http(s) vira <a>; esquema não-seguro (javascript:) não linkifica", () => {
    const htmlOk = renderMarkdownToHtml("[PR #3800](https://github.com/x/y/pull/3800)");
    assert.match(htmlOk, /<a href="https:\/\/github\.com\/x\/y\/pull\/3800"[^>]*>PR #3800<\/a>/);

    const htmlUnsafe = renderMarkdownToHtml("[clique](javascript:alert(1))");
    assert.ok(!htmlUnsafe.includes("<a "));
    assert.ok(!htmlUnsafe.includes("javascript:"));
  });

  it("HTML embutido no markdown cru nunca vira tag real (XSS)", () => {
    const html = renderMarkdownToHtml("Texto com <img src=x onerror=alert(1)> no meio");
    assert.ok(!html.includes("<img"));
    assert.match(html, /&lt;img/);
  });
});

describe("resolveReportHtml (#3714)", () => {
  it("serve .html cru, content-type text/html", () => {
    const r = makeRoot();
    mkdirSync(join(r, "data", "editions", "260720", "_internal"), { recursive: true });
    const htmlPath = "data/editions/260720/_internal/edition-report.html";
    writeFileSync(resolve(r, htmlPath), "<h1>Relatório</h1>");

    const entry: ReportEntry = {
      id: "edicao-260720",
      kind: "edicao",
      sessionId: "260720",
      title: "Edição 260720",
      htmlPath,
      createdAt: new Date().toISOString(),
      url: "/relatorios/edicao-260720",
    };
    const rendered = resolveReportHtml(r, entry);
    assert.equal(rendered.ok, true);
    assert.equal(rendered.html, "<h1>Relatório</h1>");
  });

  it(".md vira markdown renderizado de verdade (headings/hr/bold), HTML embutido continua escapado (#3784)", () => {
    const r = makeRoot();
    mkdirSync(join(r, "data", "overnight", "260720"), { recursive: true });
    writeFileSync(
      resolve(r, "data/overnight/260720/report.md"),
      "# Overnight\n\n**Modo:** bugs\n\n---\n\n<script>alert(1)</script> & coisas",
    );

    const entry: ReportEntry = {
      id: "overnight-260720",
      kind: "overnight",
      sessionId: "260720",
      title: "Overnight 260720",
      htmlPath: "data/overnight/260720/report.md",
      createdAt: new Date().toISOString(),
      url: "/relatorios/overnight-260720",
    };
    const rendered = resolveReportHtml(r, entry);
    assert.equal(rendered.ok, true);
    // markdown vira HTML de verdade, não texto literal dentro de <pre>.
    assert.match(rendered.html, /<h1>Overnight<\/h1>/);
    assert.match(rendered.html, /<strong>Modo:<\/strong>/);
    assert.match(rendered.html, /<hr>/);
    assert.ok(!rendered.html.includes("# Overnight")); // não sobrou marcador cru
    assert.ok(!rendered.html.includes("**Modo:**"));
    // conteúdo do markdown é escapado, nunca interpretado como HTML/JS.
    assert.ok(!rendered.html.includes("<script>alert(1)</script>"));
    assert.match(rendered.html, /&lt;script&gt;/);
  });

  it("arquivo referenciado não existe -> ok:false, 'não encontrado' no corpo", () => {
    const r = makeRoot();
    const entry: ReportEntry = {
      id: "edicao-999999",
      kind: "edicao",
      sessionId: "999999",
      title: "Sumiu",
      htmlPath: "data/editions/999999/_internal/edition-report.html",
      createdAt: new Date().toISOString(),
      url: "/relatorios/edicao-999999",
    };
    const rendered = resolveReportHtml(r, entry);
    assert.equal(rendered.ok, false);
    assert.match(rendered.html, /não encontrado/);
  });

  it("path traversal (htmlPath absoluto escapando rootDir) -> ok:false, nunca lê fora de rootDir", () => {
    const r = makeRoot();
    // Arquivo real fora do rootDir — prova que o guard bloqueia mesmo quando
    // o arquivo existe de verdade no filesystem (path.resolve ignora rootDir
    // quando o 2º argumento já é absoluto — exatamente o caso que o guard
    // precisa cobrir).
    const outsideDir = mkdtempSync(join(tmpdir(), "studio-reports-outside-"));
    const secretPath = join(outsideDir, "secret.html");
    writeFileSync(secretPath, "<p>segredo fora do repo</p>");

    const entry: ReportEntry = {
      id: "edicao-260720",
      kind: "edicao",
      sessionId: "260720",
      title: "Traversal",
      htmlPath: secretPath, // absoluto, fora de `r`
      createdAt: new Date().toISOString(),
      url: "/relatorios/edicao-260720",
    };
    const rendered = resolveReportHtml(r, entry);
    assert.equal(rendered.ok, false);
    assert.ok(!rendered.html.includes("segredo fora do repo"));

    rmSync(outsideDir, { recursive: true, force: true });
  });
});
