/**
 * test/select-linkedin-weekly-integration.test.ts (#4489)
 *
 * Teste de integração real do boundary CLI `select-linkedin-weekly.ts` →
 * `ln-selection.json` → `render-linkedin-weekly.ts` → `ln-{cycle}.html`
 * (achado #4489 finding 4, pr-test-analyzer + 2 revisores independentes):
 * nenhum dos 81 testes unitários pré-existentes tocava esse boundary — uma
 * mudança futura de campo (rename) em `SelectionJson` (interface duplicada
 * à mão em `render-linkedin-weekly.ts`, sem validação de runtime) quebraria
 * em runtime sem nenhum teste pegando. Roda os CLIs de verdade (`main()`
 * exportado, root injetado via `mkdtempSync` — mesmo padrão de
 * `publish-monthly-integration.test.ts`) sobre fixtures em disco, sem tocar
 * `data/` real.
 *
 * Cobre também o teste de regressão pedido pelo finding 1 (CRÍTICO): edição
 * com `02-reviewed.md` presente mas AUSENTE do cache Beehiiv (gap de sync)
 * perde a disputa de manchete de forma AUDITÁVEL (warning específico), não
 * silenciosamente — e a wiring dos findings 5/6/7 (heurística de linguagem
 * comercial, falha total de parse, guard de segunda-feira).
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main as selectMain } from "../scripts/select-linkedin-weekly.ts";
import { main as renderMain } from "../scripts/render-linkedin-weekly.ts";
import { deriveEditionUrl } from "../scripts/lib/edition-url.ts";

const originalArgv = process.argv;
const originalExit = process.exit;
let exitCode: number | null = null;

function mockProcessExit(): void {
  exitCode = null;
  // @ts-expect-error mocking
  process.exit = (code?: number) => {
    exitCode = code ?? 0;
    throw new Error("__mocked_exit__");
  };
}

function restoreProcessExit(): void {
  process.exit = originalExit;
}

function epochFor(aammdd: string): number {
  const yy = Number(aammdd.slice(0, 2));
  const mm = Number(aammdd.slice(2, 4));
  const dd = Number(aammdd.slice(4, 6));
  return Math.floor(new Date(2000 + yy, mm - 1, dd, 8, 0, 0).getTime() / 1000);
}

function writeEdition(root: string, date: string, md: string): void {
  const dir = join(root, "data/editions", date);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "02-reviewed.md"), md, "utf8");
}

function writeCachePost(root: string, id: string, post: unknown): void {
  const dir = join(root, "data/beehiiv-cache/posts");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}.json`), JSON.stringify(post), "utf8");
}

function mkTmpRoot(): string {
  return mkdtempSync(join(tmpdir(), "select-linkedin-weekly-test-"));
}

after(() => {
  process.argv = originalArgv;
});

describe("select→render end-to-end (#4489 finding 4) + gap de cache de clique (#4489 finding 1, CRÍTICO)", () => {
  let root: string;
  let selectionJson: any;

  before(() => {
    root = mkTmpRoot();

    // Edição 260727: post presente e enriquecido no cache Beehiiv — 3
    // candidatos com clique real (destaque, radar, use melhor).
    writeEdition(
      root,
      "260727",
      [
        "**DESTAQUE 1 | 💼 MERCADO**",
        "",
        "**[Matéria A: empregos e automação](https://exemplo.com/materia-a)**",
        "",
        "Corpo da matéria A, primeiro parágrafo.",
        "",
        "Por que isso importa:",
        "",
        "Explicação de impacto no mercado brasileiro.",
        "",
        "---",
        "",
        "**📡 RADAR**",
        "",
        "**[Matéria A Radar: cobertura complementar](https://exemplo.com/materia-a-radar)**",
        "Notícia complementar sobre o mesmo tema.",
        "",
        "---",
        "",
        "**🛠️ USE MELHOR**",
        "",
        "**[Tutorial X: como usar melhor o Claude Code](https://exemplo.com/tutorial-x)**",
        "Tutorial de 5 minutos.",
        "",
      ].join("\n"),
    );

    // Edição 260728: 02-reviewed.md EXISTE (found=true) mas o post NUNCA
    // entrou no cache Beehiiv (sem arquivo correspondente) — o gap real do
    // finding 1, distinto de "post presente sem stats.clicks".
    writeEdition(
      root,
      "260728",
      [
        "**DESTAQUE 1 | 🚀 LANÇAMENTO**",
        "",
        "**[Matéria B: lançamento de modelo novo](https://exemplo.com/materia-b)**",
        "",
        "Corpo da matéria B.",
        "",
        "Por que isso importa:",
        "",
        "Explicação da matéria B.",
        "",
      ].join("\n"),
    );

    // 260729-260731: sem 02-reviewed.md — editionsMissing.

    writeCachePost(root, "post_727", {
      id: "post_727",
      title: "Edição 260727",
      status: "confirmed",
      publish_date: epochFor("260727"),
      stats: {
        email: { clicks: 17, unique_opens: 200 },
        clicks: [
          { url: "https://exemplo.com/materia-a", base_url: "https://exemplo.com/materia-a", email: { unique_verified_clicks: 10 }, web: { total_unique_clicked: 0 } },
          { url: "https://exemplo.com/materia-a-radar", base_url: "https://exemplo.com/materia-a-radar", email: { unique_verified_clicks: 4 } },
          { url: "https://exemplo.com/tutorial-x", base_url: "https://exemplo.com/tutorial-x", email: { unique_verified_clicks: 3 } },
        ],
      },
    });

    process.argv = ["node", "select-linkedin-weekly.ts", "--publish-monday", "260803"];
    selectMain(root);

    const selectionPath = join(root, "data/weekly/26w31/_internal/ln-selection.json");
    assert.ok(existsSync(selectionPath), "ln-selection.json deveria ter sido escrito");
    selectionJson = JSON.parse(readFileSync(selectionPath, "utf8"));
  });

  after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("editionsFound/editionsMissing refletem o disco (2 encontradas, 3 sem 02-reviewed.md)", () => {
    assert.deepEqual(selectionJson.editionsFound, ["260727", "260728"]);
    assert.deepEqual(selectionJson.editionsMissing, ["260729", "260730", "260731"]);
  });

  it("finding 1 item 1: warning específico aponta a edição 260728 como ausente do cache Beehiiv", () => {
    const w = selectionJson.warnings as string[];
    assert.ok(
      w.some((x) => /Sem dados de clique.*260728.*cache Beehiiv/.test(x)),
      `warnings: ${JSON.stringify(w)}`,
    );
  });

  it("finding 1: candidatos da edição 260728 (gap) NÃO vencem a manchete por default ratePct=0 — perdem de forma auditável, não silenciosamente", () => {
    const headlineDates = (selectionJson.headlines as Array<{ editionDate: string }>).map((h) => h.editionDate);
    assert.ok(!headlineDates.includes("260728"), `manchetes não deveriam incluir a edição gap: ${JSON.stringify(headlineDates)}`);
    assert.deepEqual(
      (selectionJson.headlines as Array<{ title: string }>).map((h) => h.title),
      ["Matéria A: empregos e automação", "Matéria A Radar: cobertura complementar"],
    );
  });

  it("'Edições da semana' lista TODAS as edições da janela (inclusive as que já viraram manchete acima), com link + destaques (#4456, decisão 260803)", () => {
    assert.deepEqual(selectionJson.weeklyEditions, [
      {
        editionDate: "260727",
        url: deriveEditionUrl("Matéria A: empregos e automação"),
        destaques: ["Matéria A: empregos e automação"],
      },
      {
        editionDate: "260728",
        url: deriveEditionUrl("Matéria B: lançamento de modelo novo"),
        destaques: ["Matéria B: lançamento de modelo novo"],
      },
    ]);
  });

  it("Use Melhor escolhe o único candidato use_melhor (não competiu pela manchete, taxa 1.5%)", () => {
    assert.equal(selectionJson.useMelhor?.title, "Tutorial X: como usar melhor o Claude Code");
  });

  it("finding 2 (finding 1 item 2): editionsMissing (3 edições) entra em warnings — antes computado mas nunca empurrado", () => {
    const w = selectionJson.warnings as string[];
    assert.ok(
      w.some((x) => /3 edição\(ões\) da janela sem 02-reviewed\.md/.test(x) && x.includes("260729") && x.includes("260730") && x.includes("260731")),
      `warnings: ${JSON.stringify(w)}`,
    );
  });

  it("render: JSON boundary sobrevive ao roundtrip real (finding 4) — HTML final contém as 2 manchetes numeradas, Use Melhor e a lista de Edições da semana", () => {
    process.argv = [
      "node",
      "render-linkedin-weekly.ts",
      "--cycle",
      "26w31",
      "--opening",
      "Essa semana teve empregos, automação e um tutorial novo.",
      "--closing",
      "É isso que a diar.ia.br cobre todo dia, sem enrolação.",
      "--use-melhor-comment",
      "Testei essa semana e cortou tempo de setup.",
    ];
    renderMain(root);

    const htmlPath = join(root, "data/weekly/26w31/ln-26w31.html");
    assert.ok(existsSync(htmlPath));
    const html = readFileSync(htmlPath, "utf8");

    assert.match(html, /<h2>1\. Matéria A: empregos e automação<\/h2>/);
    assert.match(html, /<h2>2\. Matéria A Radar: cobertura complementar<\/h2>/);
    assert.match(html, /Use melhor/);
    assert.match(html, /Tutorial X: como usar melhor o Claude Code/);
    assert.match(html, /Testei essa semana e cortou tempo de setup\./);
    assert.match(html, /Matéria B: lançamento de modelo novo/);
    assert.match(html, /Edições da semana/);
    assert.match(html, /Essa semana teve empregos, automação e um tutorial novo\./);
    assert.match(html, /É isso que a diar\.ia\.br cobre todo dia, sem enrolação\./);

    const jsonPath = join(root, "data/weekly/26w31/ln-26w31.json");
    const renderMeta = JSON.parse(readFileSync(jsonPath, "utf8"));
    assert.equal(renderMeta.useMelhorRendered, true);
    // opening/closing foram passados — nenhum warning de ausência (finding 3).
    assert.ok(!(renderMeta.warnings as string[]).some((w: string) => /ausente\/vazi[ao]/i.test(w)));
  });
});

describe("#4492: candidato USE MELHOR com maior clique da semana não vira manchete (fim-a-fim)", () => {
  let root: string;
  let selectionJson: any;

  before(() => {
    root = mkTmpRoot();
    writeEdition(
      root,
      "260810",
      [
        "**DESTAQUE 1 | 💼 MERCADO**",
        "",
        "**[Matéria A](https://exemplo.com/materia-a)**",
        "",
        "Corpo da matéria A.",
        "",
        "Por que isso importa:",
        "",
        "Explicação.",
        "",
        "---",
        "",
        "**🛠️ USE MELHOR**",
        "",
        "**[Tutorial imbatível de clique](https://exemplo.com/tutorial-imbativel)**",
        "Tutorial de 5 minutos que bombou de clique essa semana.",
        "",
      ].join("\n"),
    );
    writeCachePost(root, "post_810", {
      id: "post_810",
      status: "confirmed",
      publish_date: epochFor("260810"),
      stats: {
        email: { clicks: 60, unique_opens: 200 },
        clicks: [
          // Destaque: 1/200 = 0.5%. Use Melhor: 50/200 = 25% — de longe o
          // maior clique da semana, mas NÃO pode virar manchete (#4492).
          { url: "https://exemplo.com/materia-a", base_url: "https://exemplo.com/materia-a", email: { unique_verified_clicks: 1 } },
          { url: "https://exemplo.com/tutorial-imbativel", base_url: "https://exemplo.com/tutorial-imbativel", email: { unique_verified_clicks: 50 } },
        ],
      },
    });

    process.argv = ["node", "select-linkedin-weekly.ts", "--publish-monday", "260817"];
    selectMain(root);
    const selectionPath = join(root, "data/weekly/26w33/_internal/ln-selection.json");
    selectionJson = JSON.parse(readFileSync(selectionPath, "utf8"));
  });

  after(() => rmSync(root, { recursive: true, force: true }));

  it("manchete é o destaque de mercado (única elegível), não o tutorial de 25% de taxa", () => {
    assert.deepEqual(
      (selectionJson.headlines as Array<{ title: string }>).map((h) => h.title),
      ["Matéria A"],
    );
  });

  it("o candidato use_melhor de maior taxa vai pro bloco Use Melhor dedicado, não pra manchete", () => {
    assert.equal(selectionJson.useMelhor?.title, "Tutorial imbatível de clique");
  });
});

describe("finding 7: guard de segunda-feira no CLI", () => {
  before(mockProcessExit);
  after(restoreProcessExit);

  it("--publish-monday numa terça-feira aborta com erro claro, sem escrever nada", () => {
    const root = mkTmpRoot();
    try {
      process.argv = ["node", "select-linkedin-weekly.ts", "--publish-monday", "260804"]; // terça
      assert.throws(() => selectMain(root), /__mocked_exit__/);
      assert.equal(exitCode, 2);
      assert.ok(!existsSync(join(root, "data/weekly")), "não deveria ter escrito nenhum output");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("finding 5: heurística de linguagem comercial sinaliza sem bloquear", () => {
  let root: string;
  let selectionJson: any;

  before(() => {
    root = mkTmpRoot();
    writeEdition(
      root,
      "260803",
      [
        "**DESTAQUE 1 | 🚀 LANÇAMENTO**",
        "",
        "**[Cupom especial em parceria com fornecedor de IA](https://exemplo.com/cupom-parceria)**",
        "",
        "Ganhe desconto usando o cupom da parceria desta semana.",
        "",
        "Por que isso importa:",
        "",
        "Explicação qualquer.",
        "",
      ].join("\n"),
    );
    writeCachePost(root, "post_803", {
      id: "post_803",
      status: "confirmed",
      publish_date: epochFor("260803"),
      stats: {
        email: { clicks: 10, unique_opens: 100 },
        clicks: [{ url: "https://exemplo.com/cupom-parceria", base_url: "https://exemplo.com/cupom-parceria", email: { unique_verified_clicks: 10 } }],
      },
    });

    process.argv = ["node", "select-linkedin-weekly.ts", "--publish-monday", "260810"];
    selectMain(root);
    const selectionPath = join(root, "data/weekly/26w32/_internal/ln-selection.json");
    selectionJson = JSON.parse(readFileSync(selectionPath, "utf8"));
  });

  after(() => rmSync(root, { recursive: true, force: true }));

  it("candidato com vocabulário comercial (domínio NÃO listado na blocklist) ainda é selecionado — não bloqueia automaticamente", () => {
    assert.equal(selectionJson.headlines.length, 1);
    assert.equal(selectionJson.headlines[0].title, "Cupom especial em parceria com fornecedor de IA");
  });

  it("mas gera warning de baixa confiança pro gate humano", () => {
    const w = selectionJson.warnings as string[];
    assert.ok(
      w.some((x) => /linguagem comercial/i.test(x) && x.includes("Cupom especial em parceria")),
      `warnings: ${JSON.stringify(w)}`,
    );
  });
});

describe("#4491: falha PARCIAL de parse — header reconhecido, zero candidatos SÓ daquela seção", () => {
  let root: string;
  let selectionJson: any;

  before(() => {
    root = mkTmpRoot();
    // RADAR tem header reconhecido mas o item não tem URL nenhuma (formato
    // mudou) — parseSections ainda inclui a seção (item title-only não é
    // "vazio" pra ela), mas extractWeeklyCandidates descarta o item por
    // falta de URL: zero candidatos de RADAR nessa edição. USE MELHOR, na
    // mesma edição, parseia normalmente — candidates.length total > 0, então
    // o warning de falha TOTAL (emptyParseEditions) não dispara aqui.
    writeEdition(
      root,
      "260810",
      [
        "**DESTAQUE 1 | 💼 MERCADO**",
        "",
        "**[Matéria A](https://exemplo.com/materia-a)**",
        "",
        "Corpo da matéria A.",
        "",
        "Por que isso importa:",
        "",
        "Explicação.",
        "",
        "---",
        "",
        "**📡 RADAR**",
        "",
        "Notícia sem link nenhum — formato mudou e o parser não reconhece mais",
        "",
        "---",
        "",
        "**🛠️ USE MELHOR**",
        "",
        "**[Tutorial Y: como usar melhor](https://exemplo.com/tutorial-y)**",
        "Tutorial de 5 minutos.",
        "",
      ].join("\n"),
    );
    writeCachePost(root, "post_810", {
      id: "post_810",
      status: "confirmed",
      publish_date: epochFor("260810"),
      stats: {
        email: { clicks: 5, unique_opens: 100 },
        clicks: [
          { url: "https://exemplo.com/materia-a", base_url: "https://exemplo.com/materia-a", email: { unique_verified_clicks: 3 } },
          { url: "https://exemplo.com/tutorial-y", base_url: "https://exemplo.com/tutorial-y", email: { unique_verified_clicks: 2 } },
        ],
      },
    });

    process.argv = ["node", "select-linkedin-weekly.ts", "--publish-monday", "260817"];
    selectMain(root);
    const selectionPath = join(root, "data/weekly/26w33/_internal/ln-selection.json");
    selectionJson = JSON.parse(readFileSync(selectionPath, "utf8"));
  });

  after(() => rmSync(root, { recursive: true, force: true }));

  it("warning específico de seção morta aponta RADAR e a edição 260810 — distinto do warning de falha total", () => {
    const w = selectionJson.warnings as string[];
    assert.ok(
      w.some((x) => /RADAR/.test(x) && x.includes("260810") && /ZERO candidatos extraídos/.test(x) && /header reconhecido/.test(x)),
      `warnings: ${JSON.stringify(w)}`,
    );
    assert.ok(
      !w.some((x) => /ZERO candidatos extraídos \(seção vazia ou formato não reconhecido pelo parser\) — não competiram por seleção/.test(x)),
      `warning de falha TOTAL não deveria disparar — candidates.length > 0 (destaque + use melhor): ${JSON.stringify(w)}`,
    );
  });

  it("candidatos de USE MELHOR (seção não-quebrada da mesma edição) seguem extraídos normalmente", () => {
    assert.equal(selectionJson.useMelhor?.title, "Tutorial Y: como usar melhor");
  });
});

describe("finding 6: falha total de parse (d1Title existe, zero candidatos) gera warning distinto de missingD1", () => {
  let root: string;
  let selectionJson: any;

  before(() => {
    root = mkTmpRoot();
    // DESTAQUE 1 com título mas SEM nenhuma URL no bloco — d1Title fica
    // setado (parseDestaques encontra o header+título), mas
    // extractWeeklyCandidates descarta o destaque (sem URL) e não há
    // nenhuma seção reconhecível → candidates.length === 0.
    writeEdition(
      root,
      "260810",
      ["**DESTAQUE 1 | 💼 MERCADO**", "", "Só um título sem link nenhum", "", "Corpo do destaque sem url.", "", "Por que isso importa:", "", "Explicação qualquer.", ""].join("\n"),
    );

    process.argv = ["node", "select-linkedin-weekly.ts", "--publish-monday", "260817"];
    selectMain(root);
    const selectionPath = join(root, "data/weekly/26w33/_internal/ln-selection.json");
    selectionJson = JSON.parse(readFileSync(selectionPath, "utf8"));
  });

  after(() => rmSync(root, { recursive: true, force: true }));

  it("warning de falha total de parse aparece, citando a edição", () => {
    const w = selectionJson.warnings as string[];
    assert.ok(
      w.some((x) => /ZERO candidatos extraídos/.test(x) && x.includes("260810")),
      `warnings: ${JSON.stringify(w)}`,
    );
  });

  it("NÃO é confundido com missingD1 — d1Title existe, então o warning de DESTAQUE 1 não-parseável não deve aparecer", () => {
    const w = selectionJson.warnings as string[];
    assert.ok(!w.some((x) => /sem DESTAQUE 1 parseável/.test(x)), `warnings: ${JSON.stringify(w)}`);
  });
});
