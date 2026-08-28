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

/** #6185: escreve um broadcast Kit em `data/kit-cache/broadcasts/{id}.json`
 *  — mesmo shape que `normalizeKitBroadcast` (`edition-cache-reader.ts`)
 *  espera (`RawKitBroadcastFile` = `KitBroadcastSummary` + `clicks`
 *  opcional). Usado pra provar que a seleção por clique lê edições de
 *  origem Kit, não só Beehiiv (o manifest de enriquecimento via MCP
 *  continua Beehiiv-only, de propósito — não testado aqui). */
function writeKitCachePost(root: string, id: string | number, broadcast: unknown): void {
  const dir = join(root, "data/kit-cache/broadcasts");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}.json`), JSON.stringify(broadcast), "utf8");
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
    // candidatos com clique real (destaque, radar, use melhor). Tem os 3
    // destaques (D1-D3) pra exercitar o caminho real de extração
    // multi-destaque de `readEdition` (achado do pr-test-analyzer na
    // revisão do #4501 — antes só era exercitado por fixture hand-built em
    // weekly-linkedin-render.test.ts, nunca pelo parser de verdade).
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
        "**DESTAQUE 2 | ⚖️ REGULAÇÃO**",
        "",
        "**[Matéria A2: regulação de IA](https://exemplo.com/materia-a2)**",
        "",
        "Corpo da matéria A2.",
        "",
        "Por que isso importa:",
        "",
        "Explicação da matéria A2.",
        "",
        "---",
        "",
        "**DESTAQUE 3 | 🚀 LANÇAMENTO**",
        "",
        "**[Matéria A3: lançamento de feature](https://exemplo.com/materia-a3)**",
        "",
        "Corpo da matéria A3.",
        "",
        "Por que isso importa:",
        "",
        "Explicação da matéria A3.",
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

  it("'Edições da semana' lista TODAS as edições da janela (inclusive as que já viraram manchete acima), com link + destaques (#4456, decisão 260802)", () => {
    assert.deepEqual(selectionJson.weeklyEditions, [
      {
        editionDate: "260727",
        url: deriveEditionUrl("Matéria A: empregos e automação"),
        destaques: ["Matéria A: empregos e automação", "Matéria A2: regulação de IA", "Matéria A3: lançamento de feature"],
      },
      {
        editionDate: "260728",
        url: deriveEditionUrl("Matéria B: lançamento de modelo novo"),
        destaques: ["Matéria B: lançamento de modelo novo"],
      },
    ]);
  });

  it("extração real de D1-D3 via readEdition/parseDestaques preserva a ordem (D1, D2, D3) — não só a fixture hand-built de weekly-linkedin-render.test.ts (achado do pr-test-analyzer, revisão #4501)", () => {
    const edicao727 = (selectionJson.weeklyEditions as Array<{ editionDate: string; destaques: string[] }>).find(
      (e) => e.editionDate === "260727",
    );
    assert.equal(edicao727?.destaques.length, 3);
    assert.deepEqual(edicao727?.destaques, ["Matéria A: empregos e automação", "Matéria A2: regulação de IA", "Matéria A3: lançamento de feature"]);
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
    // #5109: linha de proveniência "da edição de DD/MM" sobrevive ao
    // roundtrip real select→render (editionDate vem de ln-selection.json).
    assert.match(html, /<em>da edição de 27\/07<\/em>/);
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

describe("#5109: --picks resolve o pendingGroup fim-a-fim", () => {
  let root: string;

  function writeFixture(r: string): void {
    // 1 única edição na janela → headlineCap = 1 (computeHeadlineCap(1)).
    // Destaque e item de RADAR com taxa IDÊNTICA (2,5%) — empate dentro do
    // ruído disputando a única vaga: banda de 2 > 1 vaga restante → pendingGroup.
    writeEdition(
      r,
      "260901",
      [
        "**DESTAQUE 1 | 💼 MERCADO**",
        "",
        "**[Matéria de mercado](https://exemplo.com/materia-mercado)**",
        "",
        "Corpo da matéria de mercado.",
        "",
        "Por que isso importa:",
        "",
        "Explicação.",
        "",
        "---",
        "",
        "**📡 RADAR**",
        "",
        "**[Matéria do radar](https://exemplo.com/materia-radar)**",
        "Notícia complementar.",
        "",
      ].join("\n"),
    );
    writeCachePost(r, "post_901", {
      id: "post_901",
      status: "confirmed",
      publish_date: epochFor("260901"),
      stats: {
        email: { clicks: 10, unique_opens: 200 },
        clicks: [
          { url: "https://exemplo.com/materia-mercado", base_url: "https://exemplo.com/materia-mercado", email: { unique_verified_clicks: 5 } },
          { url: "https://exemplo.com/materia-radar", base_url: "https://exemplo.com/materia-radar", email: { unique_verified_clicks: 5 } },
        ],
      },
    });
  }

  after(() => rmSync(root, { recursive: true, force: true }));

  it("sem --picks: headlines fica vazio, pendingGroup traz os 2 candidatos empatados, pendingSlots=1", () => {
    root = mkTmpRoot();
    writeFixture(root);
    process.argv = ["node", "select-linkedin-weekly.ts", "--publish-monday", "260907"];
    selectMain(root);
    const selectionPath = join(root, "data/weekly/26w36/_internal/ln-selection.json");
    const selectionJson = JSON.parse(readFileSync(selectionPath, "utf8"));
    assert.equal(selectionJson.headlines.length, 0);
    assert.equal(selectionJson.pendingGroup?.length, 2);
    assert.equal(selectionJson.pendingSlots, 1);
    // dica de desempate editorial calculada pro caller exibir — nunca decide.
    assert.ok(
      (selectionJson.pendingGroup as Array<{ editorialTiebreakHint: number }>).every(
        (c) => typeof c.editorialTiebreakHint === "number",
      ),
    );
  });

  it("com --picks apontando pra 1 dos 2 candidatos: headlines finaliza com 1, pendingGroup limpo", () => {
    process.argv = [
      "node",
      "select-linkedin-weekly.ts",
      "--publish-monday",
      "260907",
      "--picks",
      "https://exemplo.com/materia-radar",
    ];
    selectMain(root);
    const selectionPath = join(root, "data/weekly/26w36/_internal/ln-selection.json");
    const selectionJson = JSON.parse(readFileSync(selectionPath, "utf8"));
    assert.equal(selectionJson.headlines.length, 1);
    assert.equal(selectionJson.headlines[0].title, "Matéria do radar");
    assert.equal(selectionJson.pendingGroup, null);
    assert.equal(selectionJson.pendingSlots, 0);
  });

  it("--picks com contagem errada aborta com exit 2 ANTES de escrever — output em disco fica intacto (a resolução anterior de 1 headline)", () => {
    const selectionPath = join(root, "data/weekly/26w36/_internal/ln-selection.json");
    const before = readFileSync(selectionPath, "utf8");
    mockProcessExit();
    try {
      process.argv = [
        "node",
        "select-linkedin-weekly.ts",
        "--publish-monday",
        "260907",
        "--picks",
        "https://exemplo.com/materia-radar,https://exemplo.com/materia-mercado",
      ];
      assert.throws(() => selectMain(root), /__mocked_exit__/);
      assert.equal(exitCode, 2);
    } finally {
      restoreProcessExit();
    }
    assert.equal(readFileSync(selectionPath, "utf8"), before, "arquivo não deveria ter sido reescrito quando --picks é inválido");
  });

  it("--picks sem nenhum pendingGroup pendente aborta com exit 2 (janela sem empate — CTOR já decidiu sozinho)", () => {
    const cleanRoot = mkTmpRoot();
    try {
      // Só 1 candidato elegível na janela — sem banda de empate, CTOR decide
      // sozinho e `pendingGroup` sai `null` já na 1ª passada.
      writeEdition(
        cleanRoot,
        "260901",
        [
          "**DESTAQUE 1 | 💼 MERCADO**",
          "",
          "**[Matéria única](https://exemplo.com/materia-unica)**",
          "",
          "Corpo.",
          "",
          "Por que isso importa:",
          "",
          "Explicação.",
          "",
        ].join("\n"),
      );
      writeCachePost(cleanRoot, "post_901b", {
        id: "post_901b",
        status: "confirmed",
        publish_date: epochFor("260901"),
        stats: {
          email: { clicks: 5, unique_opens: 100 },
          clicks: [{ url: "https://exemplo.com/materia-unica", base_url: "https://exemplo.com/materia-unica", email: { unique_verified_clicks: 5 } }],
        },
      });

      mockProcessExit();
      process.argv = [
        "node",
        "select-linkedin-weekly.ts",
        "--publish-monday",
        "260907",
        "--picks",
        "https://exemplo.com/materia-unica",
      ];
      assert.throws(() => selectMain(cleanRoot), /__mocked_exit__/);
      assert.equal(exitCode, 2);
    } finally {
      restoreProcessExit();
      rmSync(cleanRoot, { recursive: true, force: true });
    }
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

describe("achado do silent-failure-hunter (revisão #4501): 2 D1 que produzem a MESMA URL derivada geram warning explícito", () => {
  let root: string;
  let selectionJson: any;

  before(() => {
    root = mkTmpRoot();
    // Mesmo D1 (título idêntico) em 2 edições da semana — seoSlug produz a
    // MESMA URL derivada pras 2. Sem o guard, uma delas linkaria pro post
    // ERRADO em "Edições da semana" sem nenhum sinal (o rótulo do link,
    // "Edição de DD/MM", segue diferente e correto — só o href fica errado).
    writeEdition(
      root,
      "260817",
      ["**DESTAQUE 1 | 💼 MERCADO**", "", "**[Duas edições, mesmo título](https://exemplo.com/materia-x)**", "", "Corpo X.", ""].join("\n"),
    );
    writeEdition(
      root,
      "260818",
      ["**DESTAQUE 1 | 🚀 LANÇAMENTO**", "", "**[Duas edições, mesmo título](https://exemplo.com/materia-y)**", "", "Corpo Y.", ""].join("\n"),
    );

    process.argv = ["node", "select-linkedin-weekly.ts", "--publish-monday", "260824"];
    selectMain(root);
    const selectionPath = join(root, "data/weekly/26w34/_internal/ln-selection.json");
    selectionJson = JSON.parse(readFileSync(selectionPath, "utf8"));
  });

  after(() => rmSync(root, { recursive: true, force: true }));

  it("as 2 edições recebem a MESMA URL derivada em weeklyEditions (reprodução do bug)", () => {
    const urls = (selectionJson.weeklyEditions as Array<{ url: string }>).map((e) => e.url);
    assert.equal(urls[0], urls[1], `URLs deveriam colidir: ${JSON.stringify(urls)}`);
  });

  it("gera warning explícito citando as 2 datas e o slug colidido", () => {
    const w = selectionJson.warnings as string[];
    assert.ok(
      w.some((x) => /URL derivada colide entre 260817 e 260818/.test(x) && /post ERRADO/.test(x)),
      `warnings: ${JSON.stringify(w)}`,
    );
  });
});

/**
 * #6185: seleção por clique lê Beehiiv E Kit, conforme a origem da edição —
 * mesma partição por origem que o #6048 aplicou à verificação de assinante.
 * Regressão pro `windowPostsUnified` de `select-linkedin-weekly.ts` (o
 * `matchPostsToWindow` genérico de `weekly-linkedin-clicks.ts`) — sem isso,
 * uma edição de origem Kit nunca competiria por clique real (ratePct=0
 * sempre), mesmo com o broadcast presente e enriquecido no cache Kit.
 */
describe("#6185: seleção por clique lê edição de origem Kit (broadcast completed em data/kit-cache/broadcasts/)", () => {
  let root: string;
  let selectionJson: any;

  before(() => {
    root = mkTmpRoot();

    // 260901: edição de origem BEEHIIV, sem clique nenhum casando com sua
    // URL (candidato perde a disputa de manchete).
    writeEdition(
      root,
      "260901",
      ["**DESTAQUE 1 | 💼 MERCADO**", "", "**[Matéria Beehiiv sem clique](https://exemplo.com/materia-beehiiv)**", "", "Corpo.", ""].join("\n"),
    );
    writeCachePost(root, "post_beehiiv_901", {
      id: "post_beehiiv_901",
      status: "confirmed",
      publish_date: epochFor("260901"),
      stats: { email: { clicks: 0, unique_opens: 50 }, clicks: [] },
    });

    // 260902: edição de origem KIT (published_at ISO, SEM contraparte no
    // cache Beehiiv) — com clique real registrado no broadcast Kit.
    writeEdition(
      root,
      "260902",
      ["**DESTAQUE 1 | 🚀 LANÇAMENTO**", "", "**[Matéria Kit com clique](https://exemplo.com/materia-kit)**", "", "Corpo.", ""].join("\n"),
    );
    const publishedAtLocalNoon = new Date(2026, 8, 2, 12, 0, 0).toISOString();
    writeKitCachePost(root, 900902, {
      id: 900902,
      subject: "Assunto Kit 260902",
      send_at: null,
      status: "completed",
      public: true,
      published_at: publishedAtLocalNoon,
      created_at: publishedAtLocalNoon,
      description: null,
      thumbnail_url: null,
      publication_id: 1,
      clicks: [{ url: "https://exemplo.com/materia-kit", unique_clicks: 12, click_to_delivery_rate: 0.2, click_to_open_rate: 0.24 }],
      stats: { recipients: 500, emails_opened: 50, unsubscribes: 0, total_clicks: 12, show_total_clicks: true, status: "completed" },
    });

    process.argv = ["node", "select-linkedin-weekly.ts", "--publish-monday", "260907"];
    selectMain(root);
    const selectionPath = join(root, "data/weekly/26w36/_internal/ln-selection.json");
    selectionJson = JSON.parse(readFileSync(selectionPath, "utf8"));
  });

  after(() => rmSync(root, { recursive: true, force: true }));

  it("NÃO gera warning de 'sem dados de clique' pra 260902 — o broadcast Kit foi encontrado", () => {
    const w = selectionJson.warnings as string[];
    assert.ok(
      !w.some((x) => x.includes("260902")),
      `260902 não deveria aparecer em nenhum warning de dado ausente: ${JSON.stringify(w)}`,
    );
  });

  it("o candidato Kit (24% de taxa: 12 cliques / 50 aberturas) vence a ordem sobre o Beehiiv (0%) — prova que o broadcast Kit entrou no ranking real, não ratePct=0 por omissão", () => {
    const headlines = selectionJson.headlines as Array<{ editionDate: string; title: string; ratePct: number }>;
    assert.equal(headlines[0].editionDate, "260902", `1º lugar deveria ser a edição Kit: ${JSON.stringify(headlines)}`);
    assert.equal(headlines[0].ratePct, 24);
    assert.equal(headlines[1].editionDate, "260901");
    assert.equal(headlines[1].ratePct, 0);
  });
});
