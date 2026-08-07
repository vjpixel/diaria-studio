import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  findEligiblePotd,
  chooseSides,
  buildEiaMd,
  isStage4Complete,
  isStage4Partial,
  buildPrevResultLine,
  readPrevPollStats,
  firstSentence,
  extractFirstHref,
  extractFirstWikipediaUrl,
  extractCommonsUserUrl,
  buildCreditLine,
  pickSubjectWikipediaLink,
  tokenizeImageTitle,
  readUsedTitles,
  isOwnWorkOnlyCredit,
  isPtDescription,
  translateToPtBR,
  resolveTranslatedSentence,
  resolveSubjectWikipediaUrl,
  buildSdPrompt,
  resolveSdPromptDescription,
  resolveImageScriptName,
} from "../scripts/eia-compose.ts";
import { withFetchSpy } from "./_helpers/with-fetch-spy.ts";

interface MockImage {
  title?: string;
  image?: { width?: number; height?: number; source?: string };
  thumbnail?: { width?: number; height?: number };
}

function makeImage(width: number, height: number, title = "File:Test.jpg"): MockImage {
  return {
    title,
    image: { width, height, source: "https://example/x.jpg" },
  };
}

describe("findEligiblePotd", () => {
  it("retorna primeira imagem elegível (horizontal + não usada)", async () => {
    const fetcher = async (_iso: string) =>
      makeImage(1600, 900, "File:Mountain.jpg") as never;
    const used = new Set<string>();
    const r = await findEligiblePotd("2026-04-26", used, 7, fetcher);
    assert.equal(r.image.title, "File:Mountain.jpg");
    assert.equal(r.imageDate, "2026-04-26");
    assert.equal(r.rejections.length, 0);
  });

  it("rejeita imagem vertical, tenta dia anterior", async () => {
    const responses: Record<string, MockImage> = {
      "2026-04-26": makeImage(800, 1200, "File:Tall.jpg"),
      "2026-04-25": makeImage(1600, 900, "File:Wide.jpg"),
    };
    const fetcher = async (iso: string) => (responses[iso] ?? null) as never;
    const used = new Set<string>();
    const r = await findEligiblePotd("2026-04-26", used, 7, fetcher);
    assert.equal(r.image.title, "File:Wide.jpg");
    assert.equal(r.imageDate, "2026-04-25");
    assert.equal(r.rejections.length, 1);
    assert.equal(r.rejections[0].reason, "vertical");
    assert.equal(r.rejections[0].height, 1200);
  });

  it("rejeita imagem já usada (case-insensitive)", async () => {
    const responses: Record<string, MockImage> = {
      "2026-04-26": makeImage(1600, 900, "File:Used.jpg"),
      "2026-04-25": makeImage(1600, 900, "File:Fresh.jpg"),
    };
    const fetcher = async (iso: string) => (responses[iso] ?? null) as never;
    const used = new Set(["file:used.jpg"]);
    const r = await findEligiblePotd("2026-04-26", used, 7, fetcher);
    assert.equal(r.image.title, "File:Fresh.jpg");
    assert.equal(r.rejections[0].reason, "already_used");
  });

  it("rejeita resposta nula da API, tenta dia anterior", async () => {
    const responses: Record<string, MockImage> = {
      "2026-04-25": makeImage(1600, 900, "File:Found.jpg"),
    };
    const fetcher = async (iso: string) => (responses[iso] ?? null) as never;
    const used = new Set<string>();
    const r = await findEligiblePotd("2026-04-26", used, 7, fetcher);
    assert.equal(r.image.title, "File:Found.jpg");
    assert.equal(r.rejections[0].reason, "api_no_image");
  });

  it("dispara erro após max attempts sem encontrar elegível", async () => {
    const fetcher = async (_iso: string) =>
      makeImage(800, 1200, "File:Vertical.jpg") as never;
    const used = new Set<string>();
    await assert.rejects(
      () => findEligiblePotd("2026-04-26", used, 3, fetcher),
      /no_eligible_potd/,
    );
  });

  it("imagem quadrada (w=h) é aceita", async () => {
    const fetcher = async (_iso: string) =>
      makeImage(1000, 1000, "File:Square.jpg") as never;
    const used = new Set<string>();
    const r = await findEligiblePotd("2026-04-26", used, 7, fetcher);
    assert.equal(r.image.title, "File:Square.jpg");
  });

  // #1259: cap default subido de 7 para 14. Cenário do incidente 260516:
  // dias 1-5 rejeitados por already_used, 6-7 verticais — 7 tentativas
  // se exauriam. Com cap 14, dias 8+ entram no pool e desbloqueiam.
  it("encontra imagem elegível além de 7 dias quando window curto exaure (#1259)", async () => {
    // 7 dias rejeitados (5 used + 2 vertical), 8º elegível
    const responses: Record<string, MockImage> = {
      "2026-05-16": makeImage(1600, 900, "File:UsedA.jpg"),
      "2026-05-15": makeImage(800, 1200, "File:VerticalA.jpg"),
      "2026-05-14": makeImage(900, 1400, "File:VerticalB.jpg"),
      "2026-05-13": makeImage(1600, 900, "File:UsedB.jpg"),
      "2026-05-12": makeImage(1600, 900, "File:UsedC.jpg"),
      "2026-05-11": makeImage(1600, 900, "File:UsedD.jpg"),
      "2026-05-10": makeImage(1600, 900, "File:UsedE.jpg"),
      "2026-05-09": makeImage(1600, 900, "File:Fresh.jpg"), // dia 8 — elegível
    };
    const fetcher = async (iso: string) => (responses[iso] ?? null) as never;
    const used = new Set([
      "file:useda.jpg",
      "file:usedb.jpg",
      "file:usedc.jpg",
      "file:usedd.jpg",
      "file:usede.jpg",
    ]);
    // Cap=7 falharia; cap=14 (default novo) acha no dia 8.
    const r = await findEligiblePotd("2026-05-16", used, 14, fetcher);
    assert.equal(r.image.title, "File:Fresh.jpg");
    assert.equal(r.imageDate, "2026-05-09");
    assert.equal(r.rejections.length, 7);
  });
});

describe("chooseSides (#192)", () => {
  it("rand < 0.5 → real=A, ai=B", () => {
    assert.deepEqual(chooseSides(0), { realSide: "A", aiSide: "B" });
    assert.deepEqual(chooseSides(0.4), { realSide: "A", aiSide: "B" });
    assert.deepEqual(chooseSides(0.4999), { realSide: "A", aiSide: "B" });
  });

  it("rand >= 0.5 → real=B, ai=A", () => {
    assert.deepEqual(chooseSides(0.5), { realSide: "B", aiSide: "A" });
    assert.deepEqual(chooseSides(0.7), { realSide: "B", aiSide: "A" });
    assert.deepEqual(chooseSides(0.9999), { realSide: "B", aiSide: "A" });
  });

  it("realSide e aiSide são sempre opostos", () => {
    for (const r of [0, 0.1, 0.3, 0.5, 0.7, 0.9, 1]) {
      const s = chooseSides(r);
      assert.notEqual(s.realSide, s.aiSide);
    }
  });
});

describe("buildEiaMd (#192)", () => {
  it("escreve frontmatter com mapping A:real, B:ia quando realSide=A", () => {
    const md = buildEiaMd({ realSide: "A", aiSide: "B" }, "Credit line.");
    assert.match(md, /^---\n/, "começa com delimitador de frontmatter");
    assert.match(md, /eia_answer:/);
    assert.match(md, /A: real/);
    assert.match(md, /B: ia/);
    // #1100: header em negrito (consistente com LANÇAMENTOS, PESQUISAS, etc.)
    assert.match(md, /---\n\n\*\*É IA\?\*\*\n/, "frontmatter fecha antes do header em negrito");
    assert.match(md, /Credit line\./);
  });

  it("escreve frontmatter com mapping A:ia, B:real quando realSide=B", () => {
    const md = buildEiaMd({ realSide: "B", aiSide: "A" }, "Credit line.");
    assert.match(md, /A: ia/);
    assert.match(md, /B: real/);
  });

  it("frontmatter pode ser parseado por regex (compatível com render-newsletter-html)", () => {
    const md = buildEiaMd({ realSide: "A", aiSide: "B" }, "Credit line.");
    const fmMatch = md.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
    assert.ok(fmMatch, "frontmatter encontrado");
    assert.match(fmMatch![1], /A: real/);
    assert.match(fmMatch![2], /Credit line\./);
  });
});

describe("isStage4Complete (#192 resume-aware)", () => {
  function makeDir(): string {
    const root = mkdtempSync(join(tmpdir(), "diaria-eai-stage4-"));
    mkdirSync(join(root, "_internal"), { recursive: true });
    return root;
  }

  function touch(path: string): void {
    writeFileSync(path, "x");
  }

  it("false quando nada existe", () => {
    const dir = makeDir();
    try {
      assert.equal(isStage4Complete(dir), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("true quando todos os 4 outputs (md + meta + A/B) existem", () => {
    const dir = makeDir();
    try {
      touch(join(dir, "01-eia.md"));
      touch(join(dir, "_internal/01-eia-meta.json"));
      touch(join(dir, "01-eia-A.jpg"));
      touch(join(dir, "01-eia-B.jpg"));
      assert.equal(isStage4Complete(dir), true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("true para edições legacy com real/ia (backward compat)", () => {
    const dir = makeDir();
    try {
      touch(join(dir, "01-eia.md"));
      touch(join(dir, "_internal/01-eia-meta.json"));
      touch(join(dir, "01-eia-real.jpg"));
      touch(join(dir, "01-eia-ia.jpg"));
      assert.equal(isStage4Complete(dir), true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("false quando md existe mas par de imagens incompleto", () => {
    const dir = makeDir();
    try {
      touch(join(dir, "01-eia.md"));
      touch(join(dir, "_internal/01-eia-meta.json"));
      touch(join(dir, "01-eia-A.jpg")); // só A, falta B
      assert.equal(isStage4Complete(dir), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("false quando imagens existem mas meta JSON falta", () => {
    const dir = makeDir();
    try {
      touch(join(dir, "01-eia.md"));
      touch(join(dir, "01-eia-A.jpg"));
      touch(join(dir, "01-eia-B.jpg"));
      // sem _internal/01-eia-meta.json
      assert.equal(isStage4Complete(dir), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("isStage4Partial (#1325)", () => {
  function makeDir(): string {
    const d = mkdtempSync(join(tmpdir(), "eia-partial-"));
    mkdirSync(join(d, "_internal"), { recursive: true });
    return d;
  }
  function touch(p: string): void {
    writeFileSync(p, "");
  }

  it("false quando nada existe", () => {
    const dir = makeDir();
    try {
      assert.equal(isStage4Partial(dir), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("false quando tudo existe (não partial — completo)", () => {
    const dir = makeDir();
    try {
      touch(join(dir, "01-eia.md"));
      touch(join(dir, "_internal/01-eia-meta.json"));
      touch(join(dir, "01-eia-A.jpg"));
      touch(join(dir, "01-eia-B.jpg"));
      assert.equal(isStage4Partial(dir), false);
      assert.equal(isStage4Complete(dir), true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("true quando só A existe (B falhou — caso 260518)", () => {
    const dir = makeDir();
    try {
      touch(join(dir, "01-eia.md"));
      touch(join(dir, "01-eia-A.jpg"));
      // B faltando
      assert.equal(isStage4Partial(dir), true);
      assert.equal(isStage4Complete(dir), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("true quando só MD existe", () => {
    const dir = makeDir();
    try {
      touch(join(dir, "01-eia.md"));
      assert.equal(isStage4Partial(dir), true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("true quando meta + imgs existem mas MD falta", () => {
    const dir = makeDir();
    try {
      touch(join(dir, "_internal/01-eia-meta.json"));
      touch(join(dir, "01-eia-A.jpg"));
      touch(join(dir, "01-eia-B.jpg"));
      assert.equal(isStage4Partial(dir), true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("buildPrevResultLine (#107)", () => {
  it("retorna linha formatada com pct válido", () => {
    const line = buildPrevResultLine({
      total_responses: 30,
      pct_correct: 85,
      below_threshold: false,
    });
    assert.equal(line, "Resultado da última edição: 85% das pessoas acertaram.");
  });

  it("retorna null quando stats é null (sem arquivo)", () => {
    assert.equal(buildPrevResultLine(null), null);
  });

  it("retorna null quando skipped (ai_side ausente, no previous edition, etc)", () => {
    assert.equal(
      buildPrevResultLine({ skipped: "no_previous_edition" }),
      null,
    );
    assert.equal(buildPrevResultLine({ skipped: "ai_side_null" }), null);
  });

  it("retorna null quando 0 respostas", () => {
    assert.equal(
      buildPrevResultLine({ total_responses: 0, pct_correct: null }),
      null,
    );
  });

  it("retorna null quando below_threshold (poucos votos)", () => {
    assert.equal(
      buildPrevResultLine({
        total_responses: 3,
        pct_correct: null,
        below_threshold: true,
      }),
      null,
    );
  });

  it("retorna null quando pct_correct é null mesmo com respostas", () => {
    // Cenário: ai_side não foi setado então não dá pra calcular correctChoice
    assert.equal(
      buildPrevResultLine({
        total_responses: 10,
        pct_correct: null,
        below_threshold: false,
      }),
      null,
    );
  });

  it("aceita 0% (todos erraram) como resultado válido", () => {
    const line = buildPrevResultLine({
      total_responses: 30,
      pct_correct: 0,
      below_threshold: false,
    });
    assert.equal(line, "Resultado da última edição: 0% das pessoas acertaram.");
  });

  it("aceita 100% (todos acertaram) como resultado válido", () => {
    const line = buildPrevResultLine({
      total_responses: 30,
      pct_correct: 100,
      below_threshold: false,
    });
    assert.equal(
      line,
      "Resultado da última edição: 100% das pessoas acertaram.",
    );
  });
});

describe("readPrevPollStats (#107)", () => {
  function makeDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "diaria-prev-stats-"));
    mkdirSync(join(dir, "_internal"), { recursive: true });
    return dir;
  }

  it("retorna null quando o arquivo não existe", () => {
    const dir = makeDir();
    try {
      assert.equal(readPrevPollStats(dir), null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("retorna null quando JSON inválido", () => {
    const dir = makeDir();
    try {
      writeFileSync(join(dir, "_internal/04-eia-poll-stats.json"), "{ not json");
      assert.equal(readPrevPollStats(dir), null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("parseia stats válidos", () => {
    const dir = makeDir();
    try {
      const stats = {
        total_responses: 42,
        pct_correct: 76,
        below_threshold: false,
      };
      writeFileSync(
        join(dir, "_internal/04-eia-poll-stats.json"),
        JSON.stringify(stats),
      );
      const parsed = readPrevPollStats(dir);
      assert.equal(parsed?.total_responses, 42);
      assert.equal(parsed?.pct_correct, 76);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("buildEiaMd com prevResultLine (#107)", () => {
  it("inclui linha de resultado após o crédito quando passada", () => {
    const md = buildEiaMd(
      { realSide: "A", aiSide: "B" },
      "Credit line.",
      "Resultado da última edição: 85% das pessoas acertaram.",
    );
    assert.match(md, /Credit line\.\n\nResultado da última edição: 85%/);
  });

  it("omite linha de resultado quando null (default)", () => {
    const md = buildEiaMd(
      { realSide: "A", aiSide: "B" },
      "Credit line.",
    );
    assert.ok(!md.includes("Resultado da última edição"));
  });

  it("omite linha de resultado quando explicitamente null", () => {
    const md = buildEiaMd(
      { realSide: "A", aiSide: "B" },
      "Credit line.",
      null,
    );
    assert.ok(!md.includes("Resultado"));
  });
});

describe("extractFirstHref (#256)", () => {
  it("extrai href absoluta", () => {
    const html = '<a href="https://example.com/foo">link</a>';
    assert.equal(extractFirstHref(html), "https://example.com/foo");
  });

  it("normaliza protocol-relative `//commons.wikimedia.org/...` para https", () => {
    const html = '<a href="//commons.wikimedia.org/wiki/User:ArildV">name</a>';
    assert.equal(extractFirstHref(html), "https://commons.wikimedia.org/wiki/User:ArildV");
  });

  it("expande `/wiki/...` para en.wikipedia.org", () => {
    const html = '<a href="/wiki/Foo">Foo</a>';
    assert.equal(extractFirstHref(html), "https://en.wikipedia.org/wiki/Foo");
  });

  it("retorna null para html undefined", () => {
    assert.equal(extractFirstHref(undefined), null);
  });

  it("retorna null para html sem `<a>` tag", () => {
    assert.equal(extractFirstHref("Plain text without links"), null);
  });
});

describe("extractFirstWikipediaUrl (#256)", () => {
  it("extrai a primeira href para en.wikipedia.org/wiki/", () => {
    const html =
      '<a rel="mw:WikiLink/Interwiki" href="https://en.wikipedia.org/wiki/Pilot%20boat">Pilot boat</a>';
    assert.equal(
      extractFirstWikipediaUrl(html),
      "https://en.wikipedia.org/wiki/Pilot%20boat",
    );
  });

  it("ignora URLs não-Wikipedia", () => {
    const html =
      '<a href="https://commons.wikimedia.org/wiki/Foo">commons</a> <a href="https://en.wikipedia.org/wiki/Real">subject</a>';
    assert.equal(
      extractFirstWikipediaUrl(html),
      "https://en.wikipedia.org/wiki/Real",
    );
  });

  it("pega o primeiro link wikipedia mesmo com múltiplos", () => {
    const html =
      '<a href="https://en.wikipedia.org/wiki/A">A</a> e <a href="https://en.wikipedia.org/wiki/B">B</a>';
    assert.equal(extractFirstWikipediaUrl(html), "https://en.wikipedia.org/wiki/A");
  });

  it("retorna null quando nada bate", () => {
    assert.equal(extractFirstWikipediaUrl("plain text"), null);
    assert.equal(extractFirstWikipediaUrl(undefined), null);
  });
});

describe("extractCommonsUserUrl (#256, expansão)", () => {
  it("extrai href protocol-relative do html field (formato real da API)", () => {
    const html = '<a href="//commons.wikimedia.org/wiki/User:ArildV" title="User:ArildV">Arild Vågen</a>';
    assert.equal(
      extractCommonsUserUrl(html),
      "https://commons.wikimedia.org/wiki/User:ArildV",
    );
  });

  it("extrai href absoluta do html field", () => {
    const html = '<a href="https://commons.wikimedia.org/wiki/User:Foo">Foo</a>';
    assert.equal(
      extractCommonsUserUrl(html),
      "https://commons.wikimedia.org/wiki/User:Foo",
    );
  });

  it("fallback: URL bare em texto plain (compat antiga)", () => {
    const text = "Photo by https://commons.wikimedia.org/wiki/User:LegacyUser";
    assert.equal(
      extractCommonsUserUrl(text),
      "https://commons.wikimedia.org/wiki/User:LegacyUser",
    );
  });

  it("retorna null para input vazio ou sem padrão", () => {
    assert.equal(extractCommonsUserUrl(undefined), null);
    assert.equal(extractCommonsUserUrl("Just a name without URL"), null);
  });
});

describe("buildCreditLine (#256 markdown links inline)", () => {
  it("renderiza credit com links markdown quando html fields presentes", () => {
    const image = {
      title: "File:Pilot.jpg",
      description: {
        text: "Pilot boat outside Öja island.",
        html: '<a rel="mw:WikiLink/Interwiki" href="https://en.wikipedia.org/wiki/Pilot%20boat">Pilot boat</a> outside Öja island.',
      },
      artist: {
        text: "Arild Vågen",
        html: '<a href="//commons.wikimedia.org/wiki/User:ArildV">Arild Vågen</a>',
      },
      license: {
        type: "CC BY-SA 3.0",
        url: "https://creativecommons.org/licenses/by-sa/3.0",
      },
    };
    const credit = buildCreditLine(image);
    // Subject link no início
    assert.match(credit, /\[Pilot boat\]\(https:\/\/en\.wikipedia\.org\/wiki\/Pilot%20boat\)/);
    // Artist link
    assert.match(credit, /\[Arild Vågen\]\(https:\/\/commons\.wikimedia\.org\/wiki\/User:ArildV\)/);
    // License link
    assert.match(credit, /\[CC BY-SA 3\.0\]\(https:\/\/creativecommons\.org\/licenses\/by-sa\/3\.0\)/);
  });

  it("graceful degrade: html ausente vira plain text legado", () => {
    const image = {
      description: { text: "Algum sujeito qualquer." },
      artist: { text: "Photographer Name" },
      license: { type: "CC BY-SA 4.0" },
    };
    const credit = buildCreditLine(image);
    assert.match(credit, /Photographer Name/);
    assert.match(credit, /CC BY-SA 4\.0/);
    // Sem brackets — plain text
    assert.ok(!credit.includes("]("));
  });

  it("usa license default quando ausente", () => {
    const credit = buildCreditLine({ description: { text: "Foo." }, artist: { text: "Bar" } });
    assert.match(credit, /CC BY-SA 4\.0/);
  });

  it("artist sem URL: nome plain, license ainda link se url presente", () => {
    const image = {
      description: { text: "Foo bar." },
      artist: { text: "Anonymous" },
      license: { type: "CC0", url: "https://creativecommons.org/publicdomain/zero/1.0" },
    };
    const credit = buildCreditLine(image);
    assert.match(credit, /Anonymous/);
    assert.ok(!credit.includes("[Anonymous]"));
    assert.match(credit, /\[CC0\]\(https:\/\/creativecommons\.org\/publicdomain\/zero\/1\.0\)/);
  });

  it("#706: artist.text='Unknown' vira 'autor desconhecido', não 'Unknown'", () => {
    // Wikimedia frequentemente retorna "Unknown" para domínio público antigo.
    // Newsletter não deve publicar "Unknown" como nome de autor.
    const image = { description: { text: "Historic photograph." }, artist: { text: "Unknown" } };
    const credit = buildCreditLine(image);
    assert.ok(!credit.includes("Unknown"), `credit não deve conter 'Unknown': ${credit}`);
    assert.match(credit, /autor desconhecido/);
  });

  it("#706: artist.text='Unknown author' também vira 'autor desconhecido'", () => {
    const image = { description: { text: "Historic photograph." }, artist: { text: "Unknown author" } };
    const credit = buildCreditLine(image);
    assert.ok(!credit.includes("Unknown"), `credit não deve conter 'Unknown': ${credit}`);
    assert.match(credit, /autor desconhecido/);
  });

  it("#706: artist ausente → 'Wikimedia Commons' (creditar instituição)", () => {
    // Campo ausente é semanticamente diferente de "Unknown" explícito —
    // creditar a instituição Wikimedia Commons, não "autor desconhecido".
    const image = { description: { text: "Imagem sem autor." } };
    const credit = buildCreditLine(image);
    assert.match(credit, /Wikimedia Commons/);
  });

  it("#4258 item 2: artist ausente + credit.text='Own work' → 'Wikimedia Commons', não 'Own work'", () => {
    // Caso real reportado pelo editor: Wikimedia grava 'Own work' quando quem
    // enviou a imagem é o próprio fotógrafo, sem propagar nome de verdade —
    // 'Own work' publicado como se fosse o NOME do artista é ruído/confuso.
    const image = { description: { text: "Ave em voo." }, credit: { text: "Own work" } };
    const credit = buildCreditLine(image);
    assert.ok(!credit.includes("Own work"), `credit não deve conter 'Own work': ${credit}`);
    assert.match(credit, /Wikimedia Commons/);
  });

  it("#4258 item 2: artist.text='Own work' DIRETO (não via fallback de credit) também vira 'Wikimedia Commons'", () => {
    // Achado do review consolidado (pr-test-analyzer): o teste acima só
    // exercita o caminho de FALLBACK (artist ausente, credit.text='Own
    // work'). Wikimedia mais comumente grava 'Own work' no PRÓPRIO campo
    // artist — testar esse caminho direto, não só via `??`.
    const image = { description: { text: "Ave em voo." }, artist: { text: "Own work" } };
    const credit = buildCreditLine(image);
    assert.ok(!credit.includes("Own work"), `credit não deve conter 'Own work': ${credit}`);
    assert.match(credit, /Wikimedia Commons/);
  });

  it("#4258 item 2: artist.text='Own work' + artist.html com link real do uploader → nome vira 'Wikimedia Commons' mas o link é preservado", () => {
    // Achado do review consolidado (pr-test-analyzer): quando o Commons
    // hyperlinka o 'Own work' pro user page de quem enviou (comum na
    // prática), o resultado atribui a INSTITUIÇÃO mas linka pro INDIVÍDUO —
    // combinação um pouco estranha, mas pré-existente (o link já vinha do
    // mesmo html ANTES deste fix; só o nome mudou de 'Own work' pra
    // 'Wikimedia Commons') — documentando o comportamento, não uma regressão
    // nova introduzida aqui.
    const image = {
      description: { text: "Ave em voo." },
      artist: {
        text: "Own work",
        html: '<a href="//commons.wikimedia.org/wiki/User:SomeUploader">Own work</a>',
      },
    };
    const credit = buildCreditLine(image);
    assert.ok(!credit.includes("Own work"), `credit não deve conter 'Own work': ${credit}`);
    assert.match(credit, /\[Wikimedia Commons\]\(.*User:SomeUploader\)/);
  });
});

describe("isOwnWorkOnlyCredit (#4258 item 2, pure)", () => {
  it("'Own work' (e variações de case/espaço) → true", () => {
    assert.equal(isOwnWorkOnlyCredit("Own work"), true);
    assert.equal(isOwnWorkOnlyCredit("own work"), true);
    assert.equal(isOwnWorkOnlyCredit("OWN WORK"), true);
    assert.equal(isOwnWorkOnlyCredit("  Own work  "), true);
  });

  it("variantes localizadas → true", () => {
    assert.equal(isOwnWorkOnlyCredit("Trabalho próprio"), true);
    assert.equal(isOwnWorkOnlyCredit("Self-photographed"), true);
  });

  it("crédito com nome de verdade → false (nunca suprimir crédito real)", () => {
    assert.equal(isOwnWorkOnlyCredit("Tisha Mukherjee"), false);
  });

  it("'Own work' como SUBSTRING de um texto maior → false (só suprime quando é o campo INTEIRO)", () => {
    assert.equal(isOwnWorkOnlyCredit("Own work by Jane Doe"), false);
  });

  it("string vazia → false", () => {
    assert.equal(isOwnWorkOnlyCredit(""), false);
  });
});

describe("buildCreditLine — trunca nota de uso verbosa em artist.text (#3367)", () => {
  it("caso real 260713: 'This Photo was taken by Timothy A. Gonsalves. Feel free...' vira só o nome", () => {
    const verboseArtist =
      "This Photo was taken by Timothy A. Gonsalves. Feel free to use my photos, " +
      "but please mention me as the author. I would much appreciate if you send me " +
      "an email tagooty@yahoo.com or write on my talk page, for my information. " +
      "Please contact me before commercial use. Please do not upload an edited image " +
      "here without consulting me. I would like to make corrections only at my own " +
      "source to ensure that the changes improve the image and are preserved." +
      "Otherwise you may upload an edited image with a new name. Please use one of " +
      "the templates derivative or extract.";
    const image = {
      description: { text: "A photograph of a landscape." },
      artist: { text: verboseArtist },
    };
    const credit = buildCreditLine(image);
    assert.match(credit, /Timothy A\. Gonsalves/);
    assert.ok(
      !credit.includes("Feel free to use my photos"),
      `credit não deve conter a nota de uso completa: ${credit}`,
    );
    assert.ok(
      !credit.includes("tagooty@yahoo.com"),
      `credit não deve vazar o email do fotógrafo: ${credit}`,
    );
    assert.ok(
      !credit.includes("templates derivative"),
      `credit não deve conter o texto de instruções final: ${credit}`,
    );
  });

  it("caso saudável 260710: 'Tisha Mukherjee' (nome curto) permanece inalterado — sem falso-corte", () => {
    const image = {
      description: { text: "A photograph of a person." },
      artist: { text: "Tisha Mukherjee" },
    };
    const credit = buildCreditLine(image);
    assert.match(credit, /Tisha Mukherjee/);
  });

  it("iniciais do meio isoladas: 'John F. Kennedy' não é cortado em 'F' (regex de sentence-boundary)", () => {
    const image = {
      description: { text: "A historical photograph." },
      artist: {
        text:
          "Photo by John F. Kennedy. All rights reserved, please credit accordingly " +
          "when reusing this image for any commercial or editorial purpose whatsoever.",
      },
    };
    const credit = buildCreditLine(image);
    assert.match(credit, /John F\. Kennedy/);
    assert.ok(
      !credit.includes("All rights reserved"),
      `credit não deve conter a nota de direitos: ${credit}`,
    );
  });

  it("nome sem lead-in 'by' à frente da nota de uso: corta na primeira frase segura mesmo assim", () => {
    const image = {
      description: { text: "A photograph of a building." },
      artist: {
        text:
          "Timothy A. Gonsalves. Feel free to reuse this image for any purpose, " +
          "commercial or otherwise, as long as proper attribution is given in the caption.",
      },
    };
    const credit = buildCreditLine(image);
    assert.match(credit, /Timothy A\. Gonsalves/);
    assert.ok(
      !credit.includes("Feel free to reuse"),
      `credit não deve conter a nota de uso: ${credit}`,
    );
  });

  it("#706 preservado após fix de truncamento: 'Unknown' continua virando 'autor desconhecido'", () => {
    const image = { description: { text: "Historic photograph." }, artist: { text: "Unknown" } };
    const credit = buildCreditLine(image);
    assert.ok(!credit.includes("Unknown"), `credit não deve conter 'Unknown': ${credit}`);
    assert.match(credit, /autor desconhecido/);
  });

  it("#706 preservado após fix de truncamento: artist ausente continua 'Wikimedia Commons'", () => {
    const image = { description: { text: "Imagem sem autor." } };
    const credit = buildCreditLine(image);
    assert.match(credit, /Wikimedia Commons/);
  });

  it("self-review: texto malformado começando com '.' não produz nome vazio (fallback pras 6 primeiras palavras)", () => {
    const image = {
      description: { text: "A photograph." },
      artist: {
        text:
          ". Some malformed text without a leading name, just a long run-on " +
          "sentence with no safe cut point anywhere near the start of the string.",
      },
    };
    const credit = buildCreditLine(image);
    // Não deve produzir " — / CC BY-SA 4.0." (nome vazio antes do traço).
    assert.ok(
      !/— \//.test(credit),
      `credit não deve ter nome de artista vazio: ${credit}`,
    );
  });

  it("#3390: texto começando com '.' sem outro ponto de corte seguro não deixa pontuação solta isolada no crédito", () => {
    const image = {
      description: { text: "A photograph." },
      artist: {
        text:
          ". Some malformed text without a leading name, just a long run-on " +
          "sentence with no safe cut point anywhere near the start of the string.",
      },
    };
    const credit = buildCreditLine(image);
    // O "." solto do início do texto malformado não deve sobreviver como
    // token isolado no crédito publicado (ex: "— . Some malformed...").
    assert.ok(
      !credit.includes("— ."),
      `credit não deve ter "." solto logo após o traço: ${credit}`,
    );
    // O nome de artista publicado deve começar direto pela primeira palavra
    // real (sem "." isolado antes), confirmando que o token sobrevivente do
    // fallback de 6 palavras é "Some", não ".".
    assert.match(credit, /— Some malformed text without a/);
  });
});

describe("tokenizeImageTitle (#284)", () => {
  it("strip File: prefix + extensão", () => {
    assert.deepEqual(
      tokenizeImageTitle("File:Pilot_boat_at_Landsort_April_2012.jpg"),
      ["pilot", "boat", "landsort", "april", "2012"],
    );
  });

  it("filtra tokens curtos (≤3 chars)", () => {
    // "of" e "at" são curtos demais; "the" é exatamente 3 (também filtra)
    assert.deepEqual(
      tokenizeImageTitle("File:View_of_the_Park.png"),
      ["view", "park"],
    );
  });

  it("normaliza separadores múltiplos (hífen, slash, underscore → espaço)", () => {
    assert.deepEqual(
      tokenizeImageTitle("File:Stockholm-Archipelago/Sweden_Coastal.jpg"),
      ["stockholm", "archipelago", "sweden", "coastal"],
    );
  });

  it("title undefined: array vazio", () => {
    assert.deepEqual(tokenizeImageTitle(undefined), []);
  });

  it("title sem File: prefix funciona", () => {
    assert.deepEqual(
      tokenizeImageTitle("Pilot_Boat_Landsort.jpg"),
      ["pilot", "boat", "landsort"],
    );
  });

  it("case-insensitive (output sempre lowercase)", () => {
    assert.deepEqual(
      tokenizeImageTitle("FILE:PILOT_BOAT.JPG"),
      ["pilot", "boat"],
    );
  });
});

describe("pickSubjectWikipediaLink (#284)", () => {
  it("0 links: null", () => {
    assert.equal(pickSubjectWikipediaLink("plain text without links"), null);
    assert.equal(pickSubjectWikipediaLink(undefined), null);
  });

  it("1 link: retorna esse mesmo (sem ranking)", () => {
    const html =
      '<a href="https://en.wikipedia.org/wiki/Foo">Foo</a> bla bla.';
    assert.deepEqual(pickSubjectWikipediaLink(html), {
      url: "https://en.wikipedia.org/wiki/Foo",
      text: "Foo",
    });
  });

  it("título com tokens distintivos boost o link mais específico (Euganean Hills caso real)", () => {
    // Caso real produzido por edição teste 260428: title "Parco_Regionale_dei_Colli_Euganei_2"
    // gera tokens ["parco", "regionale", "colli", "euganei"]. Description.html teve só
    // 1 link Wikipedia → trivialmente vence.
    const html = '<a href="https://en.wikipedia.org/wiki/Euganean%20Hills">Euganean Hills</a> are a group of hills.';
    const title = "File:Parco_Regionale_dei_Colli_Euganei_2.jpg";
    const result = pickSubjectWikipediaLink(html, title);
    assert.equal(result?.url, "https://en.wikipedia.org/wiki/Euganean%20Hills");
  });

  it("Pilot boat scenario: stop words (#301) penalizam 'pilot'+'boat' → Landsort vence", () => {
    // Title: "Pilot_boat_at_Landsort_April_2012" → tokens
    // ["pilot", "boat", "landsort", "april", "2012"]
    //
    // Com stop words (#301):
    // - "Pilot boat": 2 tokens match × 10 = 20, + 2 (≤12), - 10 (pilot -5, boat -5),
    //   + 0 (proper noun bloqueado: first word "pilot" é stop word) = 12
    // - "Landsort":   1 token match × 10 = 10, + 2 (≤12), - 0 (sem stop words),
    //   + 3 (proper noun: "landsort" não é stop word) = 15 → Landsort vence
    // - "Stockholm Archipelago": 0 + 0 (>12) - 0 + 3 (proper noun) = 3
    //
    // Stop words resolvem o problema editorial: "Pilot boat" era genérico;
    // Landsort (o local específico) é o subject editorial correto.
    const html =
      '<a href="https://en.wikipedia.org/wiki/Pilot%20boat">Pilot boat</a> outside Öja island ' +
      '(<a href="https://en.wikipedia.org/wiki/Landsort">Landsort</a>), ' +
      '<a href="https://en.wikipedia.org/wiki/Stockholm%20Archipelago">Stockholm Archipelago</a>.';
    const title = "File:Pilot_boat_at_Landsort_April_2012.jpg";
    const result = pickSubjectWikipediaLink(html, title);
    assert.equal(result?.url, "https://en.wikipedia.org/wiki/Landsort");
  });

  it("sem title: cai pra primeiro link (tie-break por posição) + bonus texto curto", () => {
    const html =
      '<a href="https://en.wikipedia.org/wiki/A">First</a> e ' +
      '<a href="https://en.wikipedia.org/wiki/B">Second</a>.';
    const result = pickSubjectWikipediaLink(html);
    // Ambos com 0 score (sem title); ambos qualificam pra short-text bonus.
    // Position vence empate → primeiro.
    assert.equal(result?.url, "https://en.wikipedia.org/wiki/A");
  });

  it("texto curto (≤12 chars) ganha bonus quando títulos não dão match", () => {
    const html =
      '<a href="https://en.wikipedia.org/wiki/Long%20concept%20name">Long concept name</a> e ' +
      '<a href="https://en.wikipedia.org/wiki/Short">Short</a>.';
    const result = pickSubjectWikipediaLink(html, "File:Unrelated_title.jpg");
    // "Long concept name" tem 17 chars (sem bonus), "Short" tem 5 chars (+2).
    assert.equal(result?.url, "https://en.wikipedia.org/wiki/Short");
  });

  it("title match (×10) supera bonus de texto curto (+2)", () => {
    const html =
      '<a href="https://en.wikipedia.org/wiki/Long%20Town%20Name">Long Town Name</a> e ' +
      '<a href="https://en.wikipedia.org/wiki/AB">AB</a>.';
    const result = pickSubjectWikipediaLink(html, "File:Visit_to_Long_Town.jpg");
    // "Long Town Name" → tokens "long" e "town" no title → +20.
    // "AB" → curto +2 mas zero token match.
    assert.equal(result?.url, "https://en.wikipedia.org/wiki/Long%20Town%20Name");
  });

  it("regex robusto a atributos extras no <a>", () => {
    const html =
      '<a rel="mw:WikiLink/Interwiki" class="extiw" href="https://en.wikipedia.org/wiki/Foo" title="Foo">Foo Bar</a>';
    const result = pickSubjectWikipediaLink(html);
    assert.equal(result?.text, "Foo Bar");
  });
});

describe("pickSubjectWikipediaLink — stop words + proper noun bias (#301)", () => {
  it("stop words penalizam link genérico em favor do link específico", () => {
    // "Bridge" tem stop word "bridge" → -5; "Rialto Bridge" tem "bridge" → -5.
    // "Venice" não tem stop word → +0; "Venice" começa com maiúscula → +3.
    // Com 0 title match: Bridge = -5 + 2 (short) + 3 (proper) = 0
    //                    Venice = +2 (short) + 3 (proper) = 5 → Venice wins
    const html =
      '<a href="https://en.wikipedia.org/wiki/Bridge">Bridge</a> in ' +
      '<a href="https://en.wikipedia.org/wiki/Venice">Venice</a>.';
    const result = pickSubjectWikipediaLink(html);
    assert.equal(result?.url, "https://en.wikipedia.org/wiki/Venice");
  });

  it("stop word 'park' penaliza link genérico; proper noun sem stop word vence", () => {
    const html =
      '<a href="https://en.wikipedia.org/wiki/Park">Park</a> near ' +
      '<a href="https://en.wikipedia.org/wiki/Yosemite">Yosemite</a>.';
    const result = pickSubjectWikipediaLink(html);
    assert.equal(result?.url, "https://en.wikipedia.org/wiki/Yosemite");
  });

  it("proper noun bias (+3) favorece link capitalized sem stop word", () => {
    // Sem title match, sem stop words em nenhum.
    // "tokyo" começa com minúscula → sem proper noun bonus.
    // "Tokyo" começa com maiúscula → +3.
    const html =
      '<a href="https://en.wikipedia.org/wiki/lowercase">lowercase city</a> vs ' +
      '<a href="https://en.wikipedia.org/wiki/Tokyo">Tokyo</a>.';
    const result = pickSubjectWikipediaLink(html);
    assert.equal(result?.url, "https://en.wikipedia.org/wiki/Tokyo");
  });

  it("múltiplas stop words penalizam cada uma separadamente (-5 each)", () => {
    // "Mountain river landscape" tem 3 stop words → -15
    // "Danube" tem 0 stop words → 0; começa com maiúscula → +3; ≤12 → +2 = 5
    const html =
      '<a href="https://en.wikipedia.org/wiki/Mountain%20river%20landscape">Mountain river landscape</a> near ' +
      '<a href="https://en.wikipedia.org/wiki/Danube">Danube</a>.';
    const result = pickSubjectWikipediaLink(html);
    assert.equal(result?.url, "https://en.wikipedia.org/wiki/Danube");
  });

  it("1 link único: retorna sem aplicar heurística (fast path)", () => {
    const html = '<a href="https://en.wikipedia.org/wiki/Bridge">Bridge</a>.';
    // 1 link → retorna imediatamente sem penalidade
    const result = pickSubjectWikipediaLink(html);
    assert.equal(result?.url, "https://en.wikipedia.org/wiki/Bridge");
  });

  it("stop word case-insensitive: 'PILOT' também penaliza", () => {
    // "PILOT BOAT" em caixa alta: tokens "pilot" e "boat" são stop words
    const html =
      '<a href="https://en.wikipedia.org/wiki/Pilot%20Boat">PILOT BOAT</a> near ' +
      '<a href="https://en.wikipedia.org/wiki/Helsinki">Helsinki</a>.';
    const result = pickSubjectWikipediaLink(html);
    // PILOT BOAT: -10 (2 stop words) + 2 (≤12) + 3 (começa P maiúsculo) = -5
    // Helsinki: 0 + 2 (≤12) + 3 (proper) = 5 → Helsinki wins
    assert.equal(result?.url, "https://en.wikipedia.org/wiki/Helsinki");
  });
});

describe("pickSubjectWikipediaLink — extended stop words (#434)", () => {
  it("stop word 'flower' penaliza link genérico; specific subject wins", () => {
    // "Flower" tem stop word "flower" → -5 + 2 (short) + 3 (proper) = 0
    // "Kyoto" não tem stop word → 0 + 2 (short) + 3 (proper) = 5 → Kyoto vence
    const html =
      '<a href="https://en.wikipedia.org/wiki/Flower">Flower</a> in ' +
      '<a href="https://en.wikipedia.org/wiki/Kyoto">Kyoto</a>.';
    const result = pickSubjectWikipediaLink(html);
    assert.equal(result?.url, "https://en.wikipedia.org/wiki/Kyoto");
  });

  it("stop word 'tree' penaliza link genérico; specific subject wins", () => {
    // "Tree" → stop word "tree" → -5 + 2 (short) + 3 (proper) = 0
    // "Amazon" → 0 + 2 (short) + 3 (proper) = 5 → Amazon vence
    const html =
      '<a href="https://en.wikipedia.org/wiki/Tree">Tree</a> in the ' +
      '<a href="https://en.wikipedia.org/wiki/Amazon">Amazon</a>.';
    const result = pickSubjectWikipediaLink(html);
    assert.equal(result?.url, "https://en.wikipedia.org/wiki/Amazon");
  });

  it("stop word 'bird' penaliza link genérico", () => {
    const html =
      '<a href="https://en.wikipedia.org/wiki/Bird">Bird</a> near ' +
      '<a href="https://en.wikipedia.org/wiki/Galapagos">Galapagos</a>.';
    const result = pickSubjectWikipediaLink(html);
    assert.equal(result?.url, "https://en.wikipedia.org/wiki/Galapagos");
  });

  it("stop word 'statue' penaliza link genérico", () => {
    const html =
      '<a href="https://en.wikipedia.org/wiki/Statue">Statue</a> at ' +
      '<a href="https://en.wikipedia.org/wiki/Rhodes">Rhodes</a>.';
    const result = pickSubjectWikipediaLink(html);
    assert.equal(result?.url, "https://en.wikipedia.org/wiki/Rhodes");
  });

  it("stop word 'night' penaliza link genérico", () => {
    // "Night" → stop word → -5 + 2 (short) + 3 (proper) = 0
    // "Vienna" → 0 + 2 (short) + 3 (proper) = 5 → Vienna vence
    const html =
      '<a href="https://en.wikipedia.org/wiki/Night">Night</a> scene in ' +
      '<a href="https://en.wikipedia.org/wiki/Vienna">Vienna</a>.';
    const result = pickSubjectWikipediaLink(html);
    assert.equal(result?.url, "https://en.wikipedia.org/wiki/Vienna");
  });

  it("stop word 'frog' penaliza link genérico; specific species wins", () => {
    const html =
      '<a href="https://en.wikipedia.org/wiki/Frog">Frog</a> species ' +
      '<a href="https://en.wikipedia.org/wiki/Glyphoglossus_molossus">Glyphoglossus molossus</a>.';
    const result = pickSubjectWikipediaLink(html);
    assert.equal(result?.url, "https://en.wikipedia.org/wiki/Glyphoglossus_molossus");
  });
});

describe("isStage4Complete — legacy eai.* paths (#436)", () => {
  function makeDir(): string {
    const root = mkdtempSync(join(tmpdir(), "diaria-eai-legacy-"));
    mkdirSync(join(root, "_internal"), { recursive: true });
    return root;
  }

  function touch(path: string): void {
    writeFileSync(path, "x");
  }

  it("true com arquivos 01-eai.* (legacy pré-PR#428, md+meta+real+ia)", () => {
    const dir = makeDir();
    try {
      touch(join(dir, "01-eai.md"));
      touch(join(dir, "_internal/01-eai-meta.json"));
      touch(join(dir, "01-eai-real.jpg"));
      touch(join(dir, "01-eai-ia.jpg"));
      assert.equal(isStage4Complete(dir), true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("true com arquivos 01-eia.* novo padrão (regressão)", () => {
    const dir = makeDir();
    try {
      touch(join(dir, "01-eia.md"));
      touch(join(dir, "_internal/01-eia-meta.json"));
      touch(join(dir, "01-eia-A.jpg"));
      touch(join(dir, "01-eia-B.jpg"));
      assert.equal(isStage4Complete(dir), true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("false quando só tem 01-eai.md mas sem imagens", () => {
    const dir = makeDir();
    try {
      touch(join(dir, "01-eai.md"));
      touch(join(dir, "_internal/01-eai-meta.json"));
      // sem imagens
      assert.equal(isStage4Complete(dir), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("false quando nenhum dos dois padrões existe", () => {
    const dir = makeDir();
    try {
      assert.equal(isStage4Complete(dir), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("false quando 01-eai.md existe mas meta legacy falta", () => {
    const dir = makeDir();
    try {
      touch(join(dir, "01-eai.md"));
      touch(join(dir, "01-eai-real.jpg"));
      touch(join(dir, "01-eai-ia.jpg"));
      // sem _internal/01-eai-meta.json
      assert.equal(isStage4Complete(dir), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("buildCreditLine — wrap exato com link da description (#285)", () => {
  it("subject não é primeira palavra: wrap só no texto exato do <a>", () => {
    const image = {
      title: "File:Landsort_island.jpg",
      description: {
        text: "The remote island of Landsort sits south of Stockholm.",
        html:
          'The remote island of <a href="https://en.wikipedia.org/wiki/Landsort">Landsort</a> ' +
          'sits south of Stockholm.',
      },
      license: { type: "CC BY-SA 4.0", url: "https://example/cc" },
    };
    const credit = buildCreditLine(image);
    // Wrap em "Landsort" exato, NÃO em "The remote"
    assert.match(credit, /\[Landsort\]\(https:\/\/en\.wikipedia\.org\/wiki\/Landsort\)/);
    assert.ok(!credit.includes("[The remote]"));
    assert.ok(!credit.includes("[The remote island]"));
  });

  it("subject com pontuação interna ('U.S. Capitol'): wrap completo, sem truncar no ponto", () => {
    const image = {
      title: "File:US_Capitol_dome.jpg",
      description: {
        text: "U.S. Capitol is the meeting place of Congress.",
        html:
          '<a href="https://en.wikipedia.org/wiki/United%20States%20Capitol">U.S. Capitol</a> ' +
          'is the meeting place of Congress.',
      },
      license: { type: "CC BY-SA 4.0" },
    };
    const credit = buildCreditLine(image);
    // Wrap em "U.S. Capitol" inteiro, não em "U" só
    assert.match(credit, /\[U\.S\. Capitol\]\(https:\/\/en\.wikipedia\.org\/wiki\/United%20States%20Capitol\)/);
    assert.ok(!credit.match(/\[U\]\(/));
  });

  it("subject 3+ palavras: wrap completo (não trunca nas primeiras 1-2)", () => {
    const image = {
      title: "File:Stockholm_Archipelago.jpg",
      description: {
        text: "The Stockholm Archipelago is a large group of islands.",
        html:
          'The <a href="https://en.wikipedia.org/wiki/Stockholm%20Archipelago">Stockholm Archipelago</a> ' +
          'is a large group of islands.',
      },
      license: { type: "CC BY-SA 4.0" },
    };
    const credit = buildCreditLine(image);
    assert.match(credit, /\[Stockholm Archipelago\]\(https:\/\/en\.wikipedia\.org\/wiki\/Stockholm%20Archipelago\)/);
    // Não deve haver wrap em "The Stockholm" ou outras primeiras palavras
    assert.ok(!credit.match(/\[The /));
  });

  it("texto do link não aparece literal na sentence: sem wrap (graceful)", () => {
    // Cenário onde stripHtml mudaria o text (ex: HTML entities) e
    // sentence.includes(text) falha → não wrap, sentence original.
    const image = {
      title: "File:Foo.jpg",
      description: {
        text: "AT&T is a company.",
        // html tem &amp; mas stripHtml converteu pra & no text
        html: '<a href="https://en.wikipedia.org/wiki/AT%26T">AT&amp;T</a> is a company.',
      },
      license: { type: "CC BY-SA 4.0" },
    };
    const credit = buildCreditLine(image);
    // text do <a> = "AT&amp;T", sentence = "AT&T..." → não bate. Sem wrap.
    assert.ok(!credit.match(/\[AT/));
    assert.match(credit, /AT&T is a company\./);
  });
});

describe("firstSentence (#299)", () => {
  it("preserva U.S. e segue até primeiro fim de sentença real", () => {
    assert.equal(
      firstSentence("U.S. Capitol is the meeting place. Built 1800."),
      "U.S. Capitol is the meeting place.",
    );
  });

  it("preserva Dr. em sentenças subsequentes", () => {
    assert.equal(
      firstSentence("Dr. Smith arrived. He spoke."),
      "Dr. Smith arrived.",
    );
  });

  it("Mt. Everest preservado", () => {
    assert.equal(
      firstSentence("Mt. Everest is the tallest peak."),
      "Mt. Everest is the tallest peak.",
    );
  });

  it("comportamento legado: sem regressão em sentença simples", () => {
    assert.equal(firstSentence("Foo bar. Baz qux."), "Foo bar.");
  });

  it("single sentence sem continuação", () => {
    assert.equal(firstSentence("Foo."), "Foo.");
  });

  it("texto sem terminador retorna texto inteiro trim", () => {
    assert.equal(firstSentence("  Hello world  "), "Hello world");
  });

  it("string vazia retorna vazia", () => {
    assert.equal(firstSentence(""), "");
  });

  it("ponto seguido de minúscula NÃO é fim de sentença (heurística)", () => {
    // "v2.5 today" — ponto entre dígitos, regex pula porque não tem espaço+Maiúscula
    assert.equal(
      firstSentence("Released v2.5 today. Big update."),
      "Released v2.5 today.",
    );
  });

  it("aceita ! e ? como terminadores", () => {
    assert.equal(firstSentence("Wow! Really?"), "Wow!");
    assert.equal(firstSentence("Sure? Yes."), "Sure?");
  });
});

describe("readUsedTitles excludeEdition (#1417)", () => {
  function makeFixture(entries: unknown): { path: string; cleanup: () => void } {
    const dir = mkdtempSync(join(tmpdir(), "diaria-eia-used-"));
    const path = join(dir, "eia-used.json");
    writeFileSync(path, JSON.stringify(entries), "utf8");
    return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
  }

  it("retorna titles de todas as edições quando excludeEdition é undefined", () => {
    const { path, cleanup } = makeFixture([
      { edition_date: "260518", title: "File:A.jpg", image_date: "2026-05-17", url: "u" },
      { edition_date: "260519", title: "File:B.jpg", image_date: "2026-05-18", url: "u" },
    ]);
    const titles = readUsedTitles(undefined, [path]);
    assert.equal(titles.size, 2);
    assert.ok(titles.has("file:a.jpg"));
    assert.ok(titles.has("file:b.jpg"));
    cleanup();
  });

  it("#1417: filtra entries da própria edição em re-runs (caso 260520)", () => {
    const { path, cleanup } = makeFixture([
      { edition_date: "260518", title: "File:Other.jpg", image_date: "2026-05-17", url: "u" },
      { edition_date: "260520", title: "File:Rapanui.jpg", image_date: "2026-04-24", url: "u" },
      { edition_date: "260520", title: "File:Pigs.jpg", image_date: "2026-04-25", url: "u" },
      { edition_date: "260520", title: "File:Colli.jpg", image_date: "2026-04-26", url: "u" },
      { edition_date: "260520", title: "File:Tiger.jpg", image_date: "2026-05-20", url: "u" },
    ]);
    const titles = readUsedTitles("260520", [path]);
    // Só File:Other.jpg deve estar — os 4 entries de 260520 são filtrados.
    assert.equal(titles.size, 1);
    assert.ok(titles.has("file:other.jpg"));
    assert.ok(!titles.has("file:rapanui.jpg"));
    assert.ok(!titles.has("file:tiger.jpg"));
    cleanup();
  });

  it("retorna Set vazio quando nenhum candidate path existe", () => {
    const titles = readUsedTitles("260520", ["/nonexistent/path.json"]);
    assert.equal(titles.size, 0);
  });

  it("normaliza titles pra lowercase (case-insensitive dedup)", () => {
    const { path, cleanup } = makeFixture([
      { edition_date: "260518", title: "File:CamelCase.JPG", image_date: "2026-05-17", url: "u" },
    ]);
    const titles = readUsedTitles(undefined, [path]);
    assert.ok(titles.has("file:camelcase.jpg"));
    assert.ok(!titles.has("File:CamelCase.JPG"));
    cleanup();
  });

  it("graceful skip quando JSON é inválido (cai no próximo candidate)", () => {
    const dir = mkdtempSync(join(tmpdir(), "diaria-eia-corrupt-"));
    const corruptPath = join(dir, "corrupt.json");
    writeFileSync(corruptPath, "not-json", "utf8");
    const validPath = join(dir, "valid.json");
    writeFileSync(
      validPath,
      JSON.stringify([{ edition_date: "260518", title: "File:Valid.jpg", image_date: "x", url: "u" }]),
      "utf8",
    );
    const titles = readUsedTitles(undefined, [corruptPath, validPath]);
    assert.ok(titles.has("file:valid.jpg"));
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("pickSubjectWikipediaLink — aceita pt.wikipedia.org (#4618)", () => {
  it("extrai link pt.wikipedia.org quando description.html já vem nativa em pt", () => {
    // #4618: desde que fetchPotd passou a pedir a feed em locale `pt`, a
    // Wikimedia devolve description.html com links pra pt.wikipedia.org
    // (antes só en.wikipedia.org era reconhecido pelo regex).
    const html =
      '<a href="https://pt.wikipedia.org/wiki/Foo">Foo</a> bla bla.';
    assert.deepEqual(pickSubjectWikipediaLink(html), {
      url: "https://pt.wikipedia.org/wiki/Foo",
      text: "Foo",
    });
  });

  it("continua aceitando en.wikipedia.org (fallback path quando description.lang !== pt)", () => {
    const html = '<a href="https://en.wikipedia.org/wiki/Foo">Foo</a> bla bla.';
    assert.deepEqual(pickSubjectWikipediaLink(html), {
      url: "https://en.wikipedia.org/wiki/Foo",
      text: "Foo",
    });
  });

  it("ranking por title match funciona igual com links pt.wikipedia.org", () => {
    // Confirma que a heurística de scoring (title match, #284) não dependia
    // implicitamente do domínio en.wikipedia.org — só o SUBJECT_STOP_WORDS
    // (#301) é inerentemente inglês (não penaliza termos em pt), então este
    // teste usa title-match puro em vez de reusar o cenário "Pilot boat".
    const html =
      '<a href="https://pt.wikipedia.org/wiki/Barco">Barco</a> perto de ' +
      '<a href="https://pt.wikipedia.org/wiki/Landsort">Landsort</a>.';
    const title = "File:Landsort_April_2012.jpg";
    const result = pickSubjectWikipediaLink(html, title);
    assert.equal(result?.url, "https://pt.wikipedia.org/wiki/Landsort");
  });
});

describe("buildCreditLine — #4618: topônimos não vazam em EN quando a Wikimedia serve description nativa em pt", () => {
  it("caso real (edição 260804, issue #4618): Rome/Tiber/Vatican City saem como Roma/rio Tibre/Cidade do Vaticano, sem tradução nenhuma", () => {
    // Fixture = resposta REAL da Wikimedia feed API pra
    // https://api.wikimedia.org/feed/v1/wikipedia/pt/featured/2026/08/04 —
    // mesma POTD do bug relatado na issue (File:Rom (IT), Brücke „Ponte
    // Vittorio Emanuele II“ ...), capturada ao vivo durante a investigação
    // desta correção. Antes (#4618), eia-compose.ts pedia a description em
    // EN e tentava traduzir via Gemini com um prompt que instruía "manter
    // nomes próprios em inglês" — Rome/Tiber/Vatican City (topônimos, mas
    // também "nomes próprios" no sentido amplo) vazavam intactos. Buscar a
    // description já em pt elimina a tradução inteira nesse caso comum.
    const image = {
      title: 'File:Rom (IT), Brücke „Ponte Vittorio Emanuele II“ -- 2024 -- 0732.jpg',
      description: {
        html:
          '<a rel="mw:WikiLink/Interwiki" href="https://pt.wikipedia.org/wiki/Ponte%20Vittorio%20Emanuele%20II" title="pt:Ponte Vittorio Emanuele II" class="extiw">Ponte Vittorio Emanuele II</a>, com 108 metros de extensão, conecta o centro histórico de Roma — a leste do <a rel="mw:WikiLink/Interwiki" href="https://pt.wikipedia.org/wiki/rio%20Tibre" title="pt:rio Tibre" class="extiw">rio Tibre</a> — à <a rel="mw:WikiLink/Interwiki" href="https://pt.wikipedia.org/wiki/Vaticano" title="pt:Vaticano" class="extiw">Cidade do Vaticano</a>.',
        text:
          "Ponte Vittorio Emanuele II, com 108 metros de extensão, conecta o centro histórico de Roma — a leste do rio Tibre — à Cidade do Vaticano.",
        lang: "pt",
      },
      artist: {
        html:
          '<bdi><a href="//commons.wikimedia.org/wiki/User:A._%C3%96ztas" title="User:A. Öztas">Anil Öztas</a></bdi>',
        text: "Anil Öztas",
      },
      license: { type: "CC BY 4.0", url: "https://creativecommons.org/licenses/by/4.0" },
    };
    // Sem passar opts (ptLabel/ptWikipediaUrl/translatedSentence) — exatamente
    // como main() chama quando `sourceIsPt` é true (#4618): buildCreditLine
    // cai no fallback interno (`subj` recomputado de description.html), que
    // já é suficiente porque a description em si já está em pt.
    const credit = buildCreditLine(image as never);
    assert.match(credit, /Roma/, `credit deve conter "Roma": ${credit}`);
    assert.match(credit, /rio Tibre/, `credit deve conter "rio Tibre": ${credit}`);
    assert.match(credit, /Cidade do Vaticano/, `credit deve conter "Cidade do Vaticano": ${credit}`);
    assert.ok(!credit.includes("Rome"), `credit não deve conter "Rome" (vazamento EN): ${credit}`);
    assert.ok(!credit.includes("Tiber"), `credit não deve conter "Tiber" (vazamento EN): ${credit}`);
    assert.ok(!credit.includes("Vatican City"), `credit não deve conter "Vatican City" (vazamento EN): ${credit}`);
    // Subject principal linkado direto pra pt.wikipedia.org, sem precisar de
    // ptLabel/ptWikipediaUrl explícitos (mecanismo do #337/#480 fica ocioso).
    assert.match(
      credit,
      /\[Ponte Vittorio Emanuele II\]\(https:\/\/pt\.wikipedia\.org\/wiki\/Ponte%20Vittorio%20Emanuele%20II\)/,
    );
  });
});

describe("eia-compose.ts (source guard) — #4618: fix de raiz não regride silenciosamente", () => {
  it("fetchPotd pede a feed no locale pt por padrão (não mais en)", () => {
    // Guard de configuração: a troca de locale é o fix primário (a Wikimedia
    // passa a servir a description já traduzida nativamente). Sem este
    // guard, um revert acidental de volta pro DEFAULT `en` reintroduziria o
    // vazamento de topônimos em EN sem nenhum teste falhar (buildCreditLine
    // sozinho não pega isso — ele só reage ao que recebe).
    //
    // #4620: `fetchPotd` ganhou um 3º parâmetro `locale` (usado por
    // `resolveSdPromptDescription` pra buscar a versão EN sob demanda) — a
    // URL virou interpolação de template, então o guard passou a checar o
    // DEFAULT do parâmetro em vez do literal da URL antiga.
    const src = readFileSync(resolve(import.meta.dirname, "../scripts/eia-compose.ts"), "utf8");
    assert.match(src, /wikipedia\/\$\{locale\}\/featured/, "URL de fetchPotd deve ser parametrizada por locale");
    assert.match(
      src,
      /locale: "pt" \| "en" = "pt"/,
      "default do parâmetro locale deve continuar 'pt' — revert acidental pra 'en' quebraria este guard",
    );
  });

  it("prompt de tradução (fallback) não instrui mais 'manter nomes próprios em inglês' de forma ampla", () => {
    // #4618 causa raiz: a instrução antiga ("mantendo nomes próprios,
    // científicos e siglas em inglês") fazia o Gemini preservar topônimos —
    // tecnicamente nomes próprios — intactos em inglês. Esse prompt só roda
    // no fallback raro agora (description.lang !== "pt"), mas continua
    // sendo corrigido pra não repetir o mesmo bug nesse caminho.
    const src = readFileSync(resolve(import.meta.dirname, "../scripts/eia-compose.ts"), "utf8");
    assert.ok(
      !src.includes("mantendo nomes próprios, nomes científicos e siglas em inglês"),
      "prompt de tradução não deve mais instruir manter TODOS os nomes próprios (incl. topônimos) em inglês",
    );
    assert.match(
      src,
      /Traduza topônimos e nomes de lugares/,
      "prompt de tradução deve instruir explicitamente a tradução de topônimos",
    );
  });
});

describe("isPtDescription (#4618)", () => {
  it("lang='pt' → true", () => {
    assert.equal(isPtDescription({ description: { lang: "pt" } }), true);
  });

  it("lang='en' → false (fallback esperado, sem warn)", () => {
    assert.equal(isPtDescription({ description: { lang: "en" } }), false);
  });

  it("lang ausente (campo description ausente ou sem lang) → false", () => {
    assert.equal(isPtDescription({}), false);
    assert.equal(isPtDescription({ description: {} }), false);
  });

  it("lang inesperado (ex: 'pt-BR', formato que a Wikimedia poderia adotar) → false + warn em stderr", () => {
    // Achado do review consolidado (type-design-analyzer): `lang` é lido via
    // comparação frágil contra a literal "pt" — este teste trava que um
    // valor fora do conjunto esperado {"pt","en",ausente} pelo menos EMITE
    // um sinal observável em vez de degradar silenciosamente.
    const originalWrite = process.stderr.write;
    let captured = "";
    process.stderr.write = ((chunk: string) => {
      captured += chunk;
      return true;
    }) as typeof process.stderr.write;
    try {
      const result = isPtDescription({ description: { lang: "pt-BR" } });
      assert.equal(result, false);
    } finally {
      process.stderr.write = originalWrite;
    }
    assert.match(captured, /lang="pt-BR"/);
  });

  it("lang ausente MAS description.html contém link pt.wikipedia.org → false + warn de shape drift (#4619 item 1)", () => {
    // Achado do review consolidado sobre a PR #4619 (silent-failure-hunter):
    // `lang` ausente hoje é tratado igual a "sem versão pt" (fallback
    // silencioso, esperado). Mas se a Wikimedia mantivesse a resposta em pt
    // e só renomeasse/removesse o campo `lang`, description.html continuaria
    // apontando pra pt.wikipedia.org — esse teste confirma que esse
    // cenário específico pelo menos emite um warning observável, mesmo sem
    // mudar o retorno (false, main() ainda cai no fallback).
    const originalWrite = process.stderr.write;
    let captured = "";
    process.stderr.write = ((chunk: string) => {
      captured += chunk;
      return true;
    }) as typeof process.stderr.write;
    try {
      const result = isPtDescription({
        description: { html: '<a href="https://pt.wikipedia.org/wiki/Landsort">Landsort</a>' },
      });
      assert.equal(result, false);
    } finally {
      process.stderr.write = originalWrite;
    }
    assert.match(captured, /shape drift/);
    assert.match(captured, /pt\.wikipedia\.org/);
  });

  it("lang ausente e description.html sem link pt.wikipedia.org → false, sem warn de shape drift", () => {
    // Contraprova do teste acima: html ausente, vazio, ou só com link
    // en.wikipedia.org não deve disparar o warning de shape drift — é
    // exatamente o caminho "sem versão pt" normal, já coberto sem warn
    // pelo teste "lang ausente ... → false" logo acima.
    const originalWrite = process.stderr.write;
    let captured = "";
    process.stderr.write = ((chunk: string) => {
      captured += chunk;
      return true;
    }) as typeof process.stderr.write;
    try {
      assert.equal(isPtDescription({}), false);
      assert.equal(
        isPtDescription({
          description: { html: '<a href="https://en.wikipedia.org/wiki/Landsort">Landsort</a>' },
        }),
        false,
      );
    } finally {
      process.stderr.write = originalWrite;
    }
    assert.doesNotMatch(captured, /shape drift/);
  });
});

describe("resolveTranslatedSentence — gate central do #4618 não gasta Gemini quando já é pt (#4619 item 2)", () => {
  it("sourceIsPt=true → nunca chama translateToPtBR (zero fetch)", async () => {
    await withFetchSpy(async (calls) => {
      const result = await resolveTranslatedSentence(true, "Rome is on the Tiber.");
      assert.equal(result, null);
      assert.deepEqual(calls, [], "sourceIsPt=true não deve fazer nenhuma chamada externa");
    });
  });

  it("sourceIsPt=false → chama translateToPtBR (fetch acontece)", async () => {
    // withFetchSpy sempre lança na chamada interceptada — a asserção
    // relevante é que a chamada FOI feita (calls.length===1), não o
    // resultado (que fica null pelo fallback silencioso de translateToPtBR,
    // já coberto por outro teste). Mesmo padrão usado pro guard de
    // fetchPotd acima.
    const originalKey = process.env.GEMINI_API_KEY;
    process.env.GEMINI_API_KEY = "test-key-synthetic";
    try {
      await withFetchSpy(async (calls) => {
        const result = await resolveTranslatedSentence(false, "Rome is on the Tiber.");
        assert.equal(result, null, "fetch mockado lança, então cai no fallback silencioso EN");
        assert.equal(calls.length, 1, "sourceIsPt=false deve chamar translateToPtBR exatamente 1 vez");
      });
    } finally {
      if (originalKey === undefined) delete process.env.GEMINI_API_KEY;
      else process.env.GEMINI_API_KEY = originalKey;
    }
  });
});

describe("resolveSubjectWikipediaUrl (#4619 item 3)", () => {
  it("pt nativo (sourceIsPt): ptWikipediaUrl e subjectEnUrl null → usa subjUrl direto", () => {
    const result = resolveSubjectWikipediaUrl(null, null, "https://pt.wikipedia.org/wiki/Landsort");
    assert.equal(result, "https://pt.wikipedia.org/wiki/Landsort");
  });

  it("fallback com tradução pt bem-sucedida: ptWikipediaUrl tem prioridade sobre subjectEnUrl/subjUrl", () => {
    const result = resolveSubjectWikipediaUrl(
      "https://pt.wikipedia.org/wiki/Sapo-escavador",
      "https://en.wikipedia.org/wiki/Burrowing_frog",
      "https://en.wikipedia.org/wiki/Burrowing_frog",
    );
    assert.equal(result, "https://pt.wikipedia.org/wiki/Sapo-escavador");
  });

  it("fallback sem tradução (langlink pt não encontrado): cai pro subjectEnUrl", () => {
    const result = resolveSubjectWikipediaUrl(
      null,
      "https://en.wikipedia.org/wiki/Burrowing_frog",
      "https://en.wikipedia.org/wiki/Burrowing_frog",
    );
    assert.equal(result, "https://en.wikipedia.org/wiki/Burrowing_frog");
  });

  it("nenhum candidato disponível → null", () => {
    assert.equal(resolveSubjectWikipediaUrl(null, null, undefined), null);
    assert.equal(resolveSubjectWikipediaUrl(null, null, null), null);
  });
});

describe("pickSubjectWikipediaLink — stop words em pt (#4618)", () => {
  it("stop word pt 'ponte' penaliza link genérico; subject específico em pt vence", () => {
    // Espelha o teste EN existente ("Bridge" vs "Venice") — confirma que a
    // lista pt adicionada em #4618 realmente participa do scoring, não só
    // existe no Set sem efeito (SUBJECT_STOP_WORDS era 100% inglês antes;
    // agora que pt é o locale PRIMÁRIO de description.html, essa cobertura
    // deixou de ser cosmética).
    const html =
      '<a href="https://pt.wikipedia.org/wiki/Ponte">Ponte</a> em ' +
      '<a href="https://pt.wikipedia.org/wiki/Veneza">Veneza</a>.';
    const result = pickSubjectWikipediaLink(html);
    assert.equal(result?.url, "https://pt.wikipedia.org/wiki/Veneza");
  });

  it("stop word pt 'árvore' penaliza link genérico; subject específico vence", () => {
    const html =
      '<a href="https://pt.wikipedia.org/wiki/%C3%81rvore">Árvore</a> na ' +
      '<a href="https://pt.wikipedia.org/wiki/Amaz%C3%B4nia">Amazônia</a>.';
    const result = pickSubjectWikipediaLink(html);
    assert.equal(result?.url, "https://pt.wikipedia.org/wiki/Amaz%C3%B4nia");
  });
});

describe("pickSubjectWikipediaLink — domínios mistos en+pt na mesma description (#4618)", () => {
  it("html com links en.wikipedia.org E pt.wikipedia.org: title-match decide, sem preferência de domínio (comportamento documentado)", () => {
    // Achado do review consolidado (pr-test-analyzer): pickSubjectWikipediaLink
    // é uma função PURA sobre html/title — não sabe se o caller espera pt ou
    // en (isso é decidido por `sourceIsPt` em main(), fora desta função).
    // Quando a description mistura domínios (cenário hipotético: fallback
    // raro onde parte dos links residuais ainda aponta pra en.wikipedia.org),
    // o scoring decide só por title-match/stop-words/proper-noun, IGUAL
    // trataria dois links do mesmo domínio — não há bônus/penalidade por
    // domínio. Este teste documenta esse comportamento atual (intencional,
    // não um bug) em vez de deixá-lo implícito/não-testado.
    const html =
      '<a href="https://en.wikipedia.org/wiki/Generic">Generic</a> perto de ' +
      '<a href="https://pt.wikipedia.org/wiki/Landsort">Landsort</a>.';
    const title = "File:Landsort_April_2012.jpg";
    const result = pickSubjectWikipediaLink(html, title);
    assert.equal(result?.url, "https://pt.wikipedia.org/wiki/Landsort");
  });
});

describe("fetchPotd (via findEligiblePotd com fetcher default) — #4618: URL real pede locale pt", () => {
  it("a chamada fetch real (não mockada por injeção) pede /wikipedia/pt/featured/, nunca /en/", async () => {
    // Complementa o guard de source-text (grep no arquivo) com um teste
    // COMPORTAMENTAL de verdade: intercepta o `globalThis.fetch` real e
    // confirma a URL que o código efetivamente monta e chama — não seria
    // enganado por um refactor que movesse a URL pra uma constante, por
    // exemplo (achado do review consolidado, pr-test-analyzer).
    //
    // `withFetchSpy` sempre lança na chamada interceptada (não devolve uma
    // resposta mockada) — fetchPotd/findEligiblePotd não têm try/catch
    // próprio ao redor do fetch, então o erro propaga como rejection; a
    // asserção relevante é sobre a URL CAPTURADA antes do throw, não sobre
    // o resultado da promise.
    await withFetchSpy(async (calls) => {
      await assert.rejects(() => findEligiblePotd("2026-08-04", new Set(), 1));
      assert.equal(calls.length, 1, "exatamente 1 chamada fetch (sem fetcher injetado)");
      assert.match(calls[0], /\/wikipedia\/pt\/featured\/2026\/08\/04/);
      assert.ok(
        !calls[0].includes("/wikipedia/en/featured/"),
        `URL não deve mais pedir o locale en: ${calls[0]}`,
      );
    });
  });
});

describe("fetchPotd — retry recursivo em 429 propaga o locale corretamente (#4625 item 2)", () => {
  // #4625: `fetchPotd` (privada, não exportada) recomputa a URL com o MESMO
  // `locale` recebido a cada retry recursivo (`return fetchPotd(iso,
  // retryOnRateLimit - 1, locale)`) — confirmado por LEITURA na issue, mas
  // nenhum teste existente exercitava o branch de retry (nem pt nem en) com
  // um fetch em FILA (429 seguido de 200). `test/_helpers/with-fetch-spy.ts`
  // sempre lança na chamada interceptada — não serve pra simular "1ª chamada
  // falha, 2ª sucede". Mock direto de `globalThis.fetch`, mesmo padrão de
  // `test/brevo-get-retry.test.ts` (fila de respostas por índice de chamada).
  // `Retry-After: 0` mantém o teste rápido (fetchPotd não tem `_sleep`
  // injetável como brevoGet — só delay real via setTimeout).

  function wikimediaJsonResponse(title: string): Response {
    return new Response(
      JSON.stringify({
        image: {
          title,
          description: { text: "desc", lang: "en" },
          image: { source: "https://example.org/x.jpg", width: 1600, height: 800 },
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }

  it("locale pt (via findEligiblePotd, fetcher default): 429 → retry → 200, mesma URL /wikipedia/pt/", async () => {
    const originalFetch = globalThis.fetch;
    const calls: string[] = [];
    globalThis.fetch = (async (input: unknown) => {
      calls.push(String(input));
      if (calls.length === 1) {
        return new Response("rate limited", { status: 429, headers: { "retry-after": "0" } });
      }
      return wikimediaJsonResponse("Ponte de teste pt");
    }) as unknown as typeof globalThis.fetch;

    try {
      const result = await findEligiblePotd("2026-08-04", new Set(), 1);
      assert.equal(result.image.title, "Ponte de teste pt");
      assert.equal(calls.length, 2, "1ª chamada (429) + 2ª chamada (200, mesmo retryOnRateLimit-1)");
      for (const url of calls) {
        assert.match(url, /\/wikipedia\/pt\/featured\/2026\/08\/04/, `locale pt preservado no retry: ${url}`);
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("locale en (via resolveSdPromptDescription, fetchEn default): 429 → retry → 200, mesma URL /wikipedia/en/", async () => {
    const originalFetch = globalThis.fetch;
    const calls: string[] = [];
    globalThis.fetch = (async (input: unknown) => {
      calls.push(String(input));
      if (calls.length === 1) {
        return new Response("rate limited", { status: 429, headers: { "retry-after": "0" } });
      }
      return wikimediaJsonResponse("Bridge test en");
    }) as unknown as typeof globalThis.fetch;

    try {
      // imageGenerator != gemini + description pt (isPtDescription=true) →
      // dispara o fetchEn default = fetchPotd(iso, 3, "en").
      const ptImage = { description: { text: "Roma fica no rio Tibre.", lang: "pt" } };
      const result = await resolveSdPromptDescription("comfyui", ptImage, "2026-08-04", "260804");
      assert.equal(result.locale, "en", "fetch EN sucedeu após o retry — não deveria degradar pra pt_fallback");
      assert.equal(result.text, "desc");
      assert.equal(calls.length, 2, "1ª chamada (429) + 2ª chamada (200, mesmo retryOnRateLimit-1)");
      for (const url of calls) {
        assert.match(url, /\/wikipedia\/en\/featured\/2026\/08\/04/, `locale en preservado no retry: ${url}`);
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("translateToPtBR — prompt real enviado ao Gemini (#4618)", () => {
  it("corpo da requisição instrui traduzir topônimos e contém o texto de entrada; resposta mockada é retornada", async () => {
    // Comportamental (não source-grep): mocka `globalThis.fetch` capturando
    // URL + body, devolve uma resposta Gemini sintética, e confirma tanto o
    // PROMPT ENVIADO quanto o parsing do retorno — cobre exatamente o texto
    // que chega no modelo, não só uma string solta em algum lugar do arquivo.
    const originalFetch = globalThis.fetch;
    const originalKey = process.env.GEMINI_API_KEY;
    process.env.GEMINI_API_KEY = "test-key-synthetic";
    let capturedUrl: string | null = null;
    let capturedBody: string | null = null;
    globalThis.fetch = (async (input: unknown, init?: unknown) => {
      capturedUrl = String(input);
      capturedBody = (init as { body?: string } | undefined)?.body ?? null;
      return new Response(
        JSON.stringify({
          candidates: [{ content: { parts: [{ text: "Roma fica no Tibre." }] } }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;
    try {
      const result = await translateToPtBR("Rome is on the Tiber.");
      assert.equal(result, "Roma fica no Tibre.");
      assert.ok(capturedUrl?.includes("generativelanguage.googleapis.com"), `URL inesperada: ${capturedUrl}`);
      assert.ok(capturedBody, "corpo da requisição deveria ter sido capturado");
      assert.match(capturedBody!, /Traduza topônimos e nomes de lugares/);
      assert.match(capturedBody!, /Rome is on the Tiber\./);
      assert.ok(
        !capturedBody!.includes("mantendo nomes próprios, nomes científicos e siglas em inglês"),
        "prompt enviado não deve conter a instrução antiga (root cause do #4618)",
      );
    } finally {
      globalThis.fetch = originalFetch;
      if (originalKey === undefined) delete process.env.GEMINI_API_KEY;
      else process.env.GEMINI_API_KEY = originalKey;
    }
  });

  it("sem GEMINI_API_KEY → null, sem chamada externa (fallback pra EN preservado)", async () => {
    await withFetchSpy(async (calls) => {
      const originalKey = process.env.GEMINI_API_KEY;
      delete process.env.GEMINI_API_KEY;
      try {
        const result = await translateToPtBR("Rome is on the Tiber.");
        assert.equal(result, null);
      } finally {
        if (originalKey !== undefined) process.env.GEMINI_API_KEY = originalKey;
      }
      assert.deepEqual(calls, [], "sem API key, translateToPtBR nunca deve chamar fetch");
    });
  });
});

describe("buildSdPrompt (#4620 — antes recebia WikimediaImage inteiro, agora recebe o texto já resolvido)", () => {
  it("texto curto: aparece no positive + sufixo de estilo; negative/dimensões fixas", () => {
    const result = buildSdPrompt("A quiet harbor at dawn.");
    assert.match(result.positive, /^A quiet harbor at dawn\./);
    assert.match(result.positive, /documentary photograph, natural light, candid composition, photorealistic$/);
    assert.ok(result.negative.length > 0);
    assert.equal(result.final_width, 800);
    assert.equal(result.final_height, 450);
  });

  it("texto >500 chars é truncado ANTES do sufixo de estilo", () => {
    const longText = "x".repeat(600);
    const result = buildSdPrompt(longText);
    const suffix = ", documentary photograph, natural light, candid composition, photorealistic";
    assert.equal(result.positive, "x".repeat(500) + suffix);
  });

  it("remove HTML do texto de entrada", () => {
    const result = buildSdPrompt("<p>Roma <b>antiga</b>.</p>");
    assert.ok(!result.positive.includes("<"), "não deve sobrar tag HTML no prompt");
    assert.match(result.positive, /^Roma antiga/);
  });

  it("texto vazio: só o sufixo de estilo sobra, não lança", () => {
    const result = buildSdPrompt("");
    assert.match(result.positive, /^, documentary photograph/);
  });
});

describe("resolveSdPromptDescription (#4620 — só busca EN quando genuinamente precisa)", () => {
  const ptImage = { description: { text: "Roma fica no rio Tibre.", lang: "pt" } };
  const enNativeImage = { description: { text: "Rome is on the Tiber.", lang: "en" } };
  const EDITION = "260804";

  // #4620 (achado do review consolidado, silent-failure-hunter): todo caminho
  // que chega no fail-soft chama logEvent(), que por padrão escreve em
  // data/run-log.jsonl relativo ao cwd real — sem injetar rootDir, estes
  // testes poluiriam o run-log de verdade do repo (mesmo padrão de isolamento
  // já usado em test/run-log.test.ts). tmpdir novo por teste que precisa dele.
  function makeTmpRoot(): string {
    return mkdtempSync(join(tmpdir(), "eia-sd-prompt-logevent-"));
  }
  function readRunLog(rootDir: string): unknown[] {
    const p = join(rootDir, "data", "run-log.jsonl");
    return readFileSync(p, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  }

  it("image_generator=gemini + description pt → retorna o texto pt, locale=pt, ZERO fetch (custo do caminho ativo hoje)", async () => {
    const fetchEn = async () => {
      throw new Error("não deveria ser chamado");
    };
    const result = await resolveSdPromptDescription("gemini", ptImage, "2026-08-04", EDITION, fetchEn);
    assert.equal(result.text, "Roma fica no rio Tibre.");
    assert.equal(result.locale, "pt", "#4625: gemini é multilíngue, pt é aceitável — não é degradação");
  });

  it("image_generator=comfyui + description já nativa em EN (isPtDescription=false) → retorna o texto EN, locale=en, ZERO fetch", async () => {
    const fetchEn = async () => {
      throw new Error("não deveria ser chamado");
    };
    const result = await resolveSdPromptDescription("comfyui", enNativeImage, "2026-08-04", EDITION, fetchEn);
    assert.equal(result.text, "Rome is on the Tiber.");
    assert.equal(result.locale, "en");
  });

  it("image_generator=comfyui + description pt → busca EN da MESMA data e usa o texto EN retornado, locale=en", async () => {
    let calledWithIso: string | null = null;
    const fetchEn = async (iso: string) => {
      calledWithIso = iso;
      return { description: { text: "Rome is on the Tiber.", lang: "en" } };
    };
    const result = await resolveSdPromptDescription("comfyui", ptImage, "2026-08-04", EDITION, fetchEn);
    assert.equal(result.text, "Rome is on the Tiber.");
    assert.equal(result.locale, "en", "#4625: fetch EN bem-sucedido — caminho saudável, sem degradação");
    assert.equal(calledWithIso, "2026-08-04");
  });

  it("image_generator=cloudflare + description pt + fetch EN falha (exceção) → fail-soft, cai pro texto pt, locale=pt_fallback, warn em stderr E run-log com a mensagem de erro real", async () => {
    const tmpRoot = makeTmpRoot();
    const fetchEn = async () => {
      throw new Error("Wikimedia indisponível");
    };
    const originalWrite = process.stderr.write;
    let captured = "";
    process.stderr.write = ((chunk: string) => {
      captured += chunk;
      return true;
    }) as typeof process.stderr.write;
    let result: { text: string; locale: "pt" | "en" | "pt_fallback" };
    try {
      result = await resolveSdPromptDescription("cloudflare", ptImage, "2026-08-04", EDITION, fetchEn, tmpRoot);
    } finally {
      process.stderr.write = originalWrite;
    }
    assert.equal(result.text, "Roma fica no rio Tibre.");
    assert.equal(result.locale, "pt_fallback", "#4625: EN falhou e o backend não é gemini — degradação real, precisa ser visível pro editor");
    assert.match(captured, /FALHOU \(Wikimedia indisponível\)/, "stderr deve conter a mensagem de erro REAL, não genérica (achado silent-failure-hunter)");
    const entries = readRunLog(tmpRoot) as Array<{
      edition: string; stage: number; agent: string; level: string; message: string;
      details: { imageDate: string; imageGenerator: string; fetchError: string | null };
    }>;
    assert.equal(entries.length, 1, "logEvent deve gravar exatamente 1 entrada no run-log (#612, achado silent-failure-hunter: warning precisa ser durável, não só stderr)");
    assert.equal(entries[0].edition, EDITION);
    assert.equal(entries[0].stage, 3);
    assert.equal(entries[0].agent, "eia-compose");
    assert.equal(entries[0].level, "warn");
    assert.match(entries[0].message, /FALHOU \(Wikimedia indisponível\)/);
    assert.deepEqual(entries[0].details, { imageDate: "2026-08-04", imageGenerator: "cloudflare", fetchError: "Wikimedia indisponível" });
  });

  it("image_generator=comfyui + description pt + fetch EN retorna sem description.text (sem erro) → fail-soft, cai pro texto pt, locale=pt_fallback, mensagem distingue de falha real", async () => {
    const tmpRoot = makeTmpRoot();
    const fetchEn = async () => ({ description: { lang: "en" } });
    const result = await resolveSdPromptDescription("comfyui", ptImage, "2026-08-04", EDITION, fetchEn, tmpRoot);
    assert.equal(result.text, "Roma fica no rio Tibre.");
    assert.equal(result.locale, "pt_fallback");
    const entries = readRunLog(tmpRoot) as Array<{ message: string; details: { fetchError: string | null } }>;
    assert.equal(entries.length, 1);
    assert.equal(entries[0].details.fetchError, null, "sem exceção — não deve inventar uma mensagem de erro");
    assert.match(entries[0].message, /SEM description\.text \(sem erro/);
  });

  it("image_generator=comfyui + description pt + fetch EN retorna null → fail-soft, cai pro texto pt, locale=pt_fallback", async () => {
    const tmpRoot = makeTmpRoot();
    const fetchEn = async () => null;
    const result = await resolveSdPromptDescription("comfyui", ptImage, "2026-08-04", EDITION, fetchEn, tmpRoot);
    assert.equal(result.text, "Roma fica no rio Tibre.");
    assert.equal(result.locale, "pt_fallback");
  });

  it("default fetchEn (sem injeção): pede a feed real no locale en pra mesma data (#4620)", async () => {
    const tmpRoot = makeTmpRoot();
    await withFetchSpy(async (calls) => {
      // withFetchSpy sempre lança na chamada interceptada — cai no fail-soft,
      // a asserção relevante é a URL efetivamente pedida (mesmo padrão do
      // guard de fetchPotd/locale pt já usado pro #4618 mais acima).
      const result = await resolveSdPromptDescription("comfyui", ptImage, "2026-08-04", EDITION, undefined, tmpRoot);
      assert.equal(result.text, "Roma fica no rio Tibre.", "fail-soft cai pro texto pt quando o fetch real falha no teste");
      assert.equal(result.locale, "pt_fallback");
      assert.equal(calls.length, 1);
      assert.match(calls[0], /\/wikipedia\/en\/featured\/2026\/08\/04/);
    });
  });
});

describe("resolveImageScriptName (#4625 item 3 — helper único compartilhado)", () => {
  it("comfyui → scripts/comfyui-run.js", () => {
    assert.equal(resolveImageScriptName("comfyui"), "scripts/comfyui-run.js");
  });

  it("cloudflare → scripts/cloudflare-image.js", () => {
    assert.equal(resolveImageScriptName("cloudflare"), "scripts/cloudflare-image.js");
  });

  it("gemini → scripts/gemini-image.js", () => {
    assert.equal(resolveImageScriptName("gemini"), "scripts/gemini-image.js");
  });

  it("valor desconhecido (typo/futuro, ex: openai) cai no mesmo fallback gemini que o dispatch real usaria", () => {
    // #4625: garante que o gate de resolveSdPromptDescription e o dispatch de
    // main() NUNCA divergem — os dois chamam este mesmo helper.
    assert.equal(
      resolveImageScriptName("openai" as unknown as Parameters<typeof resolveImageScriptName>[0]),
      "scripts/gemini-image.js",
    );
  });
});
