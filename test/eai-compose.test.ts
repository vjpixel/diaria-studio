import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  findEligiblePotd,
  chooseSides,
  buildEaiMd,
  isStage4Complete,
  buildPrevResultLine,
  readPrevPollStats,
  extractFirstHref,
  extractFirstWikipediaUrl,
  extractCommonsUserUrl,
  buildCreditLine,
  pickSubjectWikipediaLink,
  tokenizeImageTitle,
} from "../scripts/eai-compose.ts";

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

describe("buildEaiMd (#192)", () => {
  it("escreve frontmatter com mapping A:real, B:ia quando realSide=A", () => {
    const md = buildEaiMd({ realSide: "A", aiSide: "B" }, "Credit line.");
    assert.match(md, /^---\n/, "começa com delimitador de frontmatter");
    assert.match(md, /eai_answer:/);
    assert.match(md, /A: real/);
    assert.match(md, /B: ia/);
    assert.match(md, /---\n\nÉ IA\?\n/, "frontmatter fecha antes do header");
    assert.match(md, /Credit line\./);
  });

  it("escreve frontmatter com mapping A:ia, B:real quando realSide=B", () => {
    const md = buildEaiMd({ realSide: "B", aiSide: "A" }, "Credit line.");
    assert.match(md, /A: ia/);
    assert.match(md, /B: real/);
  });

  it("frontmatter pode ser parseado por regex (compatível com render-newsletter-html)", () => {
    const md = buildEaiMd({ realSide: "A", aiSide: "B" }, "Credit line.");
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
      touch(join(dir, "01-eai.md"));
      touch(join(dir, "_internal/01-eai-meta.json"));
      touch(join(dir, "01-eai-A.jpg"));
      touch(join(dir, "01-eai-B.jpg"));
      assert.equal(isStage4Complete(dir), true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("true para edições legacy com real/ia (backward compat)", () => {
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

  it("false quando md existe mas par de imagens incompleto", () => {
    const dir = makeDir();
    try {
      touch(join(dir, "01-eai.md"));
      touch(join(dir, "_internal/01-eai-meta.json"));
      touch(join(dir, "01-eai-A.jpg")); // só A, falta B
      assert.equal(isStage4Complete(dir), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("false quando imagens existem mas meta JSON falta", () => {
    const dir = makeDir();
    try {
      touch(join(dir, "01-eai.md"));
      touch(join(dir, "01-eai-A.jpg"));
      touch(join(dir, "01-eai-B.jpg"));
      // sem _internal/01-eai-meta.json
      assert.equal(isStage4Complete(dir), false);
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
      writeFileSync(join(dir, "_internal/04-eai-poll-stats.json"), "{ not json");
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
        join(dir, "_internal/04-eai-poll-stats.json"),
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

describe("buildEaiMd com prevResultLine (#107)", () => {
  it("inclui linha de resultado após o crédito quando passada", () => {
    const md = buildEaiMd(
      { realSide: "A", aiSide: "B" },
      "Credit line.",
      "Resultado da última edição: 85% das pessoas acertaram.",
    );
    assert.match(md, /Credit line\.\n\nResultado da última edição: 85%/);
  });

  it("omite linha de resultado quando null (default)", () => {
    const md = buildEaiMd(
      { realSide: "A", aiSide: "B" },
      "Credit line.",
    );
    assert.ok(!md.includes("Resultado da última edição"));
  });

  it("omite linha de resultado quando explicitamente null", () => {
    const md = buildEaiMd(
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

  it("Pilot boat scenario: heurística favorece o link com mais tokens do title (limitação documentada)", () => {
    // Title: "Pilot_boat_at_Landsort_April_2012" → tokens
    // ["pilot", "boat", "landsort", "april", "2012"]
    //
    // - "Pilot boat" link: 2 tokens match (pilot, boat) × 10 + 2 (≤12 chars) = 22
    // - "Landsort"  link: 1 token match × 10 + 2 (≤12 chars)             = 12
    // - "Stockholm Archipelago": 0 + 0 (>12 chars)                        = 0
    //
    // Heurística vence pra Pilot boat (foreground subject literal). O issue #284
    // citava Landsort como "subject editorial" — mas a heurística proposta no body
    // do issue (esta mesma) também não alcança Landsort nesse caso. Trade-off
    // editorialmente subjetivo: foreground concept vs location qualifier.
    //
    // Fica como follow-up se aparecer reclamação real do editor — solução
    // exigiria sinais adicionais (ex: penalizar matches consecutivos de tokens).
    const html =
      '<a href="https://en.wikipedia.org/wiki/Pilot%20boat">Pilot boat</a> outside Öja island ' +
      '(<a href="https://en.wikipedia.org/wiki/Landsort">Landsort</a>), ' +
      '<a href="https://en.wikipedia.org/wiki/Stockholm%20Archipelago">Stockholm Archipelago</a>.';
    const title = "File:Pilot_boat_at_Landsort_April_2012.jpg";
    const result = pickSubjectWikipediaLink(html, title);
    assert.equal(result?.url, "https://en.wikipedia.org/wiki/Pilot%20boat");
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
