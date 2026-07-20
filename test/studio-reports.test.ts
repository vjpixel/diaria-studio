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

  it("#3788 Bug 1: href com aspas duplas/simples nunca quebra pra um 2º atributo HTML (XSS via onmouseover)", () => {
    // PoC exato da issue #3788.
    const html = renderMarkdownToHtml(`[click me](https://x.example"onmouseover="document.title='pwned')`);
    // Nunca uma quebra de atributo real — nada de `" onmouseover="` com aspas literais.
    assert.ok(!html.includes('" onmouseover="'));
    assert.ok(!html.includes("'pwned'"));
    assert.ok(!html.includes('onmouseover="document'));
    // A URL inteira (aspas/apóstrofos virados entidade) fica dentro do valor do atributo href.
    assert.match(
      html,
      /<a href="https:\/\/x\.example&quot;onmouseover=&quot;document\.title=&#39;pwned&#39;" target="_blank" rel="noopener noreferrer">click me<\/a>/,
    );
  });

  it("#3788 Bug 2: URL protocol-relative (//host) não passa no allowlist — nunca vira link clicável", () => {
    // PoC exato da issue #3788.
    const html = renderMarkdownToHtml("[go](//evil.example/phish)");
    assert.ok(!html.includes("<a "));
    assert.ok(!html.includes("href="));
    assert.ok(!html.includes("//evil.example"));
    assert.match(html, /go/); // label continua visível como texto puro
  });

  it("#3788 Bug 2 (controle): path relativo interno de barra única continua linkificável", () => {
    const html = renderMarkdownToHtml("[outro relatório](/relatorios/overnight-260719)");
    assert.match(html, /<a href="\/relatorios\/overnight-260719"/);
  });

  it("#3788 Bug 2 (variante achada no self-review): /\\evil.com (contrabarra) — browsers normalizam \\ pra / na posição de authority delimiter, mesmo bypass do protocol-relative com outro caractere", () => {
    const html = renderMarkdownToHtml("[go](/\\evil.example/phish)");
    assert.ok(!html.includes("<a "));
    assert.ok(!html.includes("href="));
  });

  it("#3788 Bug 3: URL com ** não corrompe o href (renderInline não re-escaneia o <a> já montado)", () => {
    // PoC exato da issue #3788 (adaptado pra `**` em vez de crase).
    const html = renderMarkdownToHtml("[texto](https://evil.com/**pwn**)");
    assert.ok(!html.includes("<strong>pwn</strong>"));
    assert.ok(!html.includes('href="https://evil.com/<strong>'));
    assert.match(html, /<a href="https:\/\/evil\.com\/\*\*pwn\*\*" target="_blank" rel="noopener noreferrer">texto<\/a>/);
  });

  it("#3788 Bug 3: URL com crase não corrompe o href", () => {
    const html = renderMarkdownToHtml("[texto](https://evil.com/`pwn`)");
    assert.ok(!html.includes("<code>pwn</code>"));
    assert.ok(!html.includes('href="https://evil.com/<code>'));
    assert.match(html, /<a href="https:\/\/evil\.com\/`pwn`" target="_blank" rel="noopener noreferrer">texto<\/a>/);
  });

  it("bold/código legítimos no LABEL do link continuam funcionando (não regressão do fix do Bug 3)", () => {
    const html = renderMarkdownToHtml("[**PR #3800**](https://github.com/x/y/pull/3800)");
    assert.match(html, /<a href="https:\/\/github\.com\/x\/y\/pull\/3800"[^>]*><strong>PR #3800<\/strong><\/a>/);
  });

  describe("#3789: separador de tabela é decidido por posição, não por truthiness", () => {
    it("PoC exato da issue: linha dash-like no MEIO do corpo é dado real, não descartada", () => {
      const html = renderMarkdownToHtml("| A | B |\n|---|---|\n| x | y |\n| -- | -- |\n| z | w |");
      // única tabela, com a linha `-- | --` preservada como row de dados.
      assert.match(html, /<td>x<\/td><td>y<\/td>/);
      assert.match(html, /<td>--<\/td><td>--<\/td>/);
      assert.match(html, /<td>z<\/td><td>w<\/td>/);
      // 3 rows de dados no tbody (nenhuma foi descartada).
      const tbodyMatch = html.match(/<tbody>(.*)<\/tbody>/);
      assert.ok(tbodyMatch);
      assert.equal((tbodyMatch![1].match(/<tr>/g) ?? []).length, 3);
    });

    it("controle: separador real logo após o header continua funcionando (não regressão)", () => {
      const html = renderMarkdownToHtml("| Issue | PR |\n|---|---|\n| #3789 | #3800 |\n| #3790 | #3801 |");
      assert.match(html, /<th>Issue<\/th><th>PR<\/th>/);
      assert.ok(!html.includes("<td>---</td>")); // separador não vira row
      const tbodyMatch = html.match(/<tbody>(.*)<\/tbody>/);
      assert.ok(tbodyMatch);
      assert.equal((tbodyMatch![1].match(/<tr>/g) ?? []).length, 2);
    });

    it("duas tabelas consecutivas sem linha em branco: o separador da 2ª tabela não desaparece mais (fica visível como dado, ainda que fundida na mesma <table>)", () => {
      const html = renderMarkdownToHtml(
        "| A | B |\n|---|---|\n| x | y |\n| C | D |\n|---|---|\n| p | q |",
      );
      // nenhum conteúdo textual desaparece silenciosamente — inclusive o
      // separador da 2ª tabela, que antes do fix era engolido sem deixar rastro.
      assert.match(html, /<td>C<\/td><td>D<\/td>/);
      assert.match(html, /<td>---<\/td><td>---<\/td>/);
      assert.match(html, /<td>p<\/td><td>q<\/td>/);
    });
  });

  describe("#3790: itálico", () => {
    it("PoC exato da issue: _(nenhuma unidade registrada)_ (já em uso em scripts/render-overnight-timeline.ts) vira <em>", () => {
      const html = renderMarkdownToHtml("_(nenhuma unidade registrada)_");
      assert.match(html, /<em>\(nenhuma unidade registrada\)<\/em>/);
      assert.ok(!html.includes("_("));
    });

    it("*itálico* com asterisco simples também vira <em>", () => {
      const html = renderMarkdownToHtml("Isto é *importante* aqui.");
      assert.match(html, /<em>importante<\/em>/);
    });

    it("controle: **bold** continua funcionando depois de adicionar itálico (não vira <em> por engano)", () => {
      const html = renderMarkdownToHtml("Isto é **muito importante** aqui.");
      assert.match(html, /<strong>muito importante<\/strong>/);
      assert.ok(!html.includes("<em>"));
    });

    it("controle: identificador snake_case no meio de uma frase não vira itálico por engano", () => {
      const html = renderMarkdownToHtml("Rodar `verify_stage_2` ou o arquivo config_file_name.ts.");
      assert.ok(!html.includes("<em>"));
    });

    it("controle: marcador de lista `- item`/`* item` não é confundido com itálico", () => {
      const html = renderMarkdownToHtml("- primeiro\n- segundo");
      assert.match(html, /<li>primeiro<\/li>/);
      assert.ok(!html.includes("<em>"));
    });

    it("itálico dentro de um item de lista continua funcionando", () => {
      const html = renderMarkdownToHtml("- item com *ênfase* no meio");
      assert.match(html, /<li>item com <em>ênfase<\/em> no meio<\/li>/);
    });

    it("placeholder de link (__mdlink_N__) não é afetado pelo itálico de underscore", () => {
      const html = renderMarkdownToHtml("[PR #3800](https://github.com/x/y/pull/3800) e mais texto.");
      assert.match(html, /<a href="https:\/\/github\.com\/x\/y\/pull\/3800"[^>]*>PR #3800<\/a>/);
      assert.ok(!html.includes("<em>"));
      assert.ok(!html.includes("mdlink"));
    });
  });

  describe("#3790: code fence", () => {
    it("PoC exato da issue: bloco de 3 linhas vira <pre><code> com quebras de linha intactas", () => {
      const html = renderMarkdownToHtml("```ts\nfunction foo() {\n  return 1;\n}\n```");
      assert.match(html, /<pre><code>function foo\(\) \{\n {2}return 1;\n\}<\/code><\/pre>/);
      assert.ok(!html.includes("```"));
      assert.ok(!html.includes("<p>")); // não colapsou num parágrafo
    });

    it("conteúdo do code fence não é reprocessado como markdown (** e _ ficam literais)", () => {
      const html = renderMarkdownToHtml("```\n**not bold** and _not italic_\n```");
      assert.ok(!html.includes("<strong>"));
      assert.ok(!html.includes("<em>"));
      assert.match(html, /\*\*not bold\*\* and _not italic_/);
    });

    it("fence sem linguagem funciona igual", () => {
      const html = renderMarkdownToHtml("```\nplain code\n```");
      assert.match(html, /<pre><code>plain code<\/code><\/pre>/);
    });

    it("HTML embutido dentro de um code fence continua escapado (XSS)", () => {
      const html = renderMarkdownToHtml("```\n<script>alert(1)</script>\n```");
      assert.ok(!html.includes("<script>alert"));
      assert.match(html, /&lt;script&gt;/);
    });

    it("fence não fechado até o fim do texto ainda assim preserva o conteúdo coletado (markdown malformado, fail-soft)", () => {
      const html = renderMarkdownToHtml("```\nlinha 1\nlinha 2");
      assert.match(html, /<pre><code>linha 1\nlinha 2<\/code><\/pre>/);
    });

    it("linhas em branco / --- dentro do fence não são tratadas como separador de bloco ou <hr>", () => {
      const html = renderMarkdownToHtml("```\nlinha 1\n\n---\nlinha 2\n```");
      assert.match(html, /<pre><code>linha 1\n\n---\nlinha 2<\/code><\/pre>/);
      assert.ok(!html.includes("<hr>"));
    });
  });

  describe("#3790: lista numerada", () => {
    it("PoC exato da issue: 1. primeiro / 2. segundo vira <ol><li>, preserva enumeração estrutural", () => {
      const html = renderMarkdownToHtml("1. primeiro\n2. segundo");
      assert.match(html, /<ol>/);
      assert.match(html, /<li>primeiro<\/li>/);
      assert.match(html, /<li>segundo<\/li>/);
      assert.match(html, /<\/ol>/);
      assert.ok(!html.includes("<p>")); // não colapsou num parágrafo
    });

    it("trocar de <ul> pra <ol> no meio do documento fecha a lista anterior corretamente", () => {
      const html = renderMarkdownToHtml("- bullet um\n1. numerado um\n2. numerado dois");
      assert.match(html, /<ul>\n<li>bullet um<\/li>\n<\/ul>/);
      assert.match(html, /<ol>\n<li>numerado um<\/li>\n<li>numerado dois<\/li>\n<\/ol>/);
    });
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
