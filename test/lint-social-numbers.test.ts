import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  normalizeMagnitude,
  normalizeDigits,
  extractMoneyFigures,
  sourceFigureKeys,
  findUnsourcedFigures,
  highlightSourceText,
  parseSocialByDestaque,
  lintSocialNumbers,
  computeOutrosCount,
  parseCommentDiariaByDestaque,
  lintCommentDiariaCount,
} from "../scripts/lint-social-numbers.ts";

describe("normalizeMagnitude (#1711)", () => {
  it("bilhões/billion/bi/bn/B → B", () => {
    for (const u of ["bilhões", "billion", "bi", "bn", "B", "Bilhões"]) {
      assert.equal(normalizeMagnitude(u), "B");
    }
  });
  it("milhões/million/mi/M → M", () => {
    for (const u of ["milhões", "million", "mi", "M"]) {
      assert.equal(normalizeMagnitude(u), "M");
    }
  });
  it("desconhecido → ''", () => {
    assert.equal(normalizeMagnitude("xyz"), "");
  });
});

describe("normalizeDigits (#1711)", () => {
  it("separador de milhar some", () => {
    assert.equal(normalizeDigits("1.000"), "1000");
    assert.equal(normalizeDigits("1,234,567"), "1234567");
  });
  it("decimal de 1-2 dígitos preservado", () => {
    assert.equal(normalizeDigits("2,5"), "2.5");
    assert.equal(normalizeDigits("2.50"), "2.5");
  });
  it("número simples inalterado", () => {
    assert.equal(normalizeDigits("965"), "965");
  });
});

describe("extractMoneyFigures (#1711)", () => {
  it("extrai cifra com magnitude por extenso", () => {
    const f = extractMoneyFigures("levantou US$ 965 bilhões em valuation");
    assert.equal(f.length, 1);
    assert.equal(f[0].key, "965B");
  });
  it("extrai cifra com magnitude abreviada colada", () => {
    const f = extractMoneyFigures("avaliada em $10B após a rodada");
    assert.equal(f[0].key, "10B");
  });
  it("R$ com decimal PT", () => {
    const f = extractMoneyFigures("R$ 2,5 bi em receita");
    assert.equal(f[0].key, "2.5B");
  });
  it("NÃO extrai cifra SEM magnitude (específica demais / comum)", () => {
    assert.deepEqual(extractMoneyFigures("custou US$ 50 por mês"), []);
  });
  it("NÃO extrai porcentagem", () => {
    assert.deepEqual(extractMoneyFigures("cresceu 45% no trimestre"), []);
  });

  it("#1722: 'R$ 35 mil' → 35K (não 35M — mil antes de mi)", () => {
    const f = extractMoneyFigures("concorra a R$ 35 mil em prêmios");
    assert.equal(f[0].key, "35K");
  });

  it("#1722: 'US$ 50 milhões' → 50M (milh\\w* vence mil/mi)", () => {
    assert.equal(extractMoneyFigures("US$ 50 milhões em receita")[0].key, "50M");
  });

  it("#1722: 'trimestre' NÃO é magnitude 'tri' (lookahead)", () => {
    // "tri" seguido de letra (m) não casa → sem cifra fabricada.
    assert.deepEqual(extractMoneyFigures("US$ 10 no trimestre passado"), []);
    assert.deepEqual(extractMoneyFigures("US$ 10 trimestrais"), []);
  });

  it("'US$ 1,5 trilhão' → 1.5T", () => {
    assert.equal(extractMoneyFigures("avaliado em US$ 1,5 trilhão")[0].key, "1.5T");
  });
});

describe("sourceFigureKeys (#1711) — com e sem símbolo de moeda", () => {
  it("captura cifra sem símbolo na fonte ('965 bilhões de dólares')", () => {
    const keys = sourceFigureKeys("avaliada em 965 bilhões de dólares");
    assert.ok(keys.has("965B"));
  });
});

describe("findUnsourcedFigures (#1711) — caso real 260602", () => {
  it("flaga 'US$ 965 bilhões' ausente da fonte (alucinação)", () => {
    const social = "A Anthropic vai abrir capital; a última rodada levantou US$ 965 bilhões em valuation.";
    const source = "Anthropic planeja IPO, diz The Guardian. A empresa busca novos investidores.";
    const unsourced = findUnsourcedFigures(social, source);
    assert.equal(unsourced.length, 1);
    assert.equal(unsourced[0].key, "965B");
  });

  it("NÃO flaga cifra que ESTÁ na fonte (mesmo formato diferente)", () => {
    const social = "A startup foi avaliada em US$ 10B.";
    const source = "A startup atingiu valuation de 10 bilhões de dólares.";
    assert.deepEqual(findUnsourcedFigures(social, source), []);
  });

  it("post sem cifras → nada a flagar", () => {
    assert.deepEqual(findUnsourcedFigures("A OpenAI lançou um novo modelo hoje.", "fonte qualquer"), []);
  });
});

describe("highlightSourceText (#1722) — fonte do destaque N", () => {
  const approved = {
    highlights: [
      { article: { title: "Anthropic planeja IPO", summary: "Sem cifra na fonte." } },
      { article: { title: "Outro destaque", summary: "Cresceu 10 bilhões." } },
    ],
  };
  it("retorna title+summary do highlight N-1", () => {
    assert.match(highlightSourceText(approved, 1), /Anthropic planeja IPO/);
    assert.match(highlightSourceText(approved, 2), /10 bilhões/);
  });
  it("N fora de range → ''", () => {
    assert.equal(highlightSourceText(approved, 9), "");
  });
});

describe("parseSocialByDestaque (#1722)", () => {
  it("separa posts por ## dN (LinkedIn + Facebook concatenados)", () => {
    const md = `# LinkedIn

## d1

Post LinkedIn d1 com US$ 965 bilhões.

### comment_diaria

Comentário d1.

## d2

Post d2.

# Facebook

## d1

Post Facebook d1.

## d2

Post Facebook d2.`;
    const map = parseSocialByDestaque(md);
    assert.match(map.get(1) ?? "", /Post LinkedIn d1/);
    assert.match(map.get(1) ?? "", /Comentário d1/);
    assert.match(map.get(1) ?? "", /Post Facebook d1/); // os dois canais juntos
    assert.doesNotMatch(map.get(1) ?? "", /Post d2/);
  });
});

describe("lintSocialNumbers (#1722) — per-destaque, caso 260602", () => {
  it("flaga '965B' no post d1 mesmo que esteja na fonte de OUTRO destaque", () => {
    // O bug 260602: "965B" aparecia num item use_melhor, mas o post d1 (Anthropic
    // IPO) o citou como valuation — ausente da fonte do d1. Per-destaque pega isso.
    const social = `# LinkedIn

## d1

A Anthropic vai abrir capital; a rodada levantou US$ 965 bilhões em valuation.

## d2

Post d2 sem cifras.`;
    const approved = {
      highlights: [
        { article: { title: "Anthropic planeja IPO", summary: "Empresa busca investidores, diz Guardian." } },
        { article: { title: "Outro", summary: "Item com US$ 965 bilhões em outro contexto." } },
      ],
    };
    const findings = lintSocialNumbers(social, approved);
    const d1 = findings.find((f) => f.destaque === 1);
    assert.ok(d1, "d1 deve ter finding");
    assert.equal(d1!.unsourced[0].key, "965B");
  });

  it("NÃO flaga cifra que ESTÁ na fonte do próprio destaque", () => {
    const social = `# LinkedIn

## d1

A startup foi avaliada em US$ 10B.`;
    const approved = {
      highlights: [{ article: { title: "Startup X", summary: "Atingiu valuation de 10 bilhões de dólares." } }],
    };
    assert.deepEqual(lintSocialNumbers(social, approved), []);
  });
});

// ---------------------------------------------------------------------------
// #2014 — comment_diaria count lint
// ---------------------------------------------------------------------------

const SOCIAL_WITH_COMMENTS = `# LinkedIn

## d1

Post principal d1.

### comment_diaria

Edição completa com mais 9 destaques de IA do dia em {edition_url}

Receba a Diar.ia todo dia por e-mail, assine grátis em diar.ia.br

### comment_pixel

Opinião do Pixel sobre d1.

## d2

Post principal d2.

### comment_diaria

Edição completa com mais 9 destaques de IA do dia em {edition_url}

Receba a Diar.ia todo dia por e-mail, assine grátis em diar.ia.br

### comment_pixel

Opinião do Pixel sobre d2.

## d3

Post principal d3.

### comment_diaria

Edição completa com mais 9 destaques de IA do dia em {edition_url}

Receba a Diar.ia todo dia por e-mail, assine grátis em diar.ia.br

### comment_pixel

Opinião do Pixel sobre d3.

# Facebook

## d1

Post Facebook d1.

## d2

Post Facebook d2.

## d3

Post Facebook d3.
`;

const APPROVED_13_ITEMS = {
  highlights: [
    { article: { title: "D1", summary: "s1" } },
    { article: { title: "D2", summary: "s2" } },
    { article: { title: "D3", summary: "s3" } },
  ],
  lancamento: [{ title: "L1" }, { title: "L2" }],
  radar: [{ title: "R1" }, { title: "R2" }, { title: "R3" }, { title: "R4" }, { title: "R5" }, { title: "R6" }, { title: "R7" }, { title: "R8" }],
  use_melhor: [],
  video: [],
};
// highlights=3, lancamento=2, radar=8 → total=13, outros=10

describe("computeOutrosCount (#2014)", () => {
  it("calcula lancamento + radar + use_melhor + video", () => {
    assert.equal(computeOutrosCount(APPROVED_13_ITEMS), 10);
  });

  it("approved sem buckets secundários → 0", () => {
    assert.equal(computeOutrosCount({ highlights: [] }), 0);
  });

  it("use_melhor e video contribuem", () => {
    assert.equal(
      computeOutrosCount({ lancamento: [{}], radar: [{}], use_melhor: [{}], video: [{}] }),
      4,
    );
  });
});

describe("parseCommentDiariaByDestaque (#2014)", () => {
  it("extrai textos comment_diaria de d1, d2, d3", () => {
    const map = parseCommentDiariaByDestaque(SOCIAL_WITH_COMMENTS);
    assert.ok(map.has(1), "deve ter d1");
    assert.ok(map.has(2), "deve ter d2");
    assert.ok(map.has(3), "deve ter d3");
    assert.match(map.get(1) ?? "", /mais 9 destaques/);
  });

  it("NÃO inclui conteúdo do # Facebook", () => {
    const map = parseCommentDiariaByDestaque(SOCIAL_WITH_COMMENTS);
    // d1 do Facebook não tem comment_diaria — o parseador não deve confundir
    for (const [, text] of map) {
      assert.doesNotMatch(text, /Post Facebook/);
    }
  });
});

describe("lintCommentDiariaCount (#2014)", () => {
  it("contagem certa (9 == 9) → zero findings", () => {
    const approvedWith9 = {
      ...APPROVED_13_ITEMS,
      lancamento: [{}],
      radar: [{}, {}, {}, {}, {}, {}, {}, {}],
    };
    // outros = 1+8 = 9 → bate com "mais 9 destaques"
    const { findings } = lintCommentDiariaCount(SOCIAL_WITH_COMMENTS, approvedWith9);
    assert.equal(findings.length, 0, "não deve ter findings quando contagem está certa");
  });

  it("contagem errada (9 encontrado, 10 esperado) → findings em d1/d2/d3", () => {
    const { findings } = lintCommentDiariaCount(SOCIAL_WITH_COMMENTS, APPROVED_13_ITEMS);
    assert.equal(findings.length, 3, "deve ter 1 finding por destaque (d1, d2, d3)");
    assert.equal(findings[0].found, 9);
    assert.equal(findings[0].expected, 10);
  });

  it("modo fix: corrige o número no texto retornado", () => {
    const { findings, fixed } = lintCommentDiariaCount(SOCIAL_WITH_COMMENTS, APPROVED_13_ITEMS, { fix: true });
    assert.equal(findings.length, 3);
    assert.doesNotMatch(fixed, /mais 9 destaques/, "número errado não deve estar no texto fixado");
    assert.match(fixed, /mais 10 destaques/, "número correto deve estar no texto fixado");
  });

  it("modo fix preserva o resto do texto intacto", () => {
    const { fixed } = lintCommentDiariaCount(SOCIAL_WITH_COMMENTS, APPROVED_13_ITEMS, { fix: true });
    assert.match(fixed, /Post principal d1/);
    assert.match(fixed, /Opinião do Pixel/);
    assert.match(fixed, /Post Facebook d1/);
    assert.match(fixed, /{edition_url}/);
  });

  it("modo fix (#2033): NÃO altera 'mais N destaques' em ## post_pixel ou main post", () => {
    // post_pixel pode conter frases como "confira os mais 9 destaques curados" — o fix
    // só deve corrigir a frase canônica do CTA ("mais N destaques de IA do dia").
    // Construímos um fixture que contém ## post_pixel explicitamente, pois
    // SOCIAL_WITH_COMMENTS não tem essa seção.
    const socialWithPixelSection = `# LinkedIn

## d1

Post principal d1. Confira os mais 9 destaques curados nesta edição.

### comment_diaria

Edição completa com mais 9 destaques de IA do dia em {edition_url}

Receba a Diar.ia todo dia por e-mail, assine grátis em diar.ia.br

### comment_pixel

Opinião do Pixel sobre d1.

## post_pixel

Confira os mais 9 destaques curados desta edição — seleção cuidadosa de IA.

# Facebook

## d1

Post Facebook d1.
`;
    const { fixed } = lintCommentDiariaCount(socialWithPixelSection, APPROVED_13_ITEMS, { fix: true });
    // O número 9 na frase sem "de IA do dia" (post_pixel e main post) deve permanecer
    assert.match(fixed, /mais 9 destaques curados/, "post_pixel não deve ser alterado pelo --fix");
    assert.match(fixed, /Post principal d1. Confira os mais 9 destaques curados/, "main post não deve ser alterado pelo --fix");
    // O número 9 no comment_diaria deve ser corrigido para 10
    assert.doesNotMatch(fixed, /mais 9 destaques de IA do dia/, "comment_diaria deve ser corrigido");
    assert.match(fixed, /mais 10 destaques de IA do dia/, "comment_diaria deve ter o número correto");
  });

  it("placeholder {outros_count} literal → finding com unresolved_placeholder=true (#2033)", () => {
    // Se o LLM escreve o placeholder literal em vez do número resolvido,
    // o texto "mais {outros_count} destaques de IA do dia" publica broken.
    const socialWithPlaceholder = SOCIAL_WITH_COMMENTS.replace(
      /mais 9 destaques de IA do dia/g,
      "mais {outros_count} destaques de IA do dia",
    );
    const { findings } = lintCommentDiariaCount(socialWithPlaceholder, APPROVED_13_ITEMS);
    assert.equal(findings.length, 3, "deve ter finding pra cada destaque com placeholder literal");
    assert.ok(findings[0].unresolved_placeholder, "finding deve indicar unresolved_placeholder");
    assert.ok(isNaN(findings[0].found), "found deve ser NaN para placeholder não-resolvido");
  });

  it("approved sem 01-approved.json (buckets ausentes) → comportamento gracioso", () => {
    // Se approved.json não tem campos de bucket, computeOutrosCount retorna 0
    const approvedMinimal = { highlights: [{ article: { title: "D1", summary: "s" } }] };
    const { findings } = lintCommentDiariaCount(SOCIAL_WITH_COMMENTS, approvedMinimal);
    // "mais 9 destaques" encontrado mas esperado 0 → finding
    assert.equal(findings.length, 3);
    assert.equal(findings[0].expected, 0);
  });
});

// ---------------------------------------------------------------------------
// #2044 — lint deve usar 01-approved-capped.json (não uncapped)
// ---------------------------------------------------------------------------

describe("computeOutrosCount (#2044) — capped vs uncapped divergência", () => {
  it("capped (após applyStage2Caps cortar lançamentos) retorna count menor que uncapped", () => {
    // Simula o caso onde applyStage2Caps cortou 7 → 5 lançamentos.
    // uncapped: lancamento=7 + radar=5 = 12
    // capped:   lancamento=5 + radar=5 = 10
    const uncapped = {
      highlights: [
        { article: { title: "D1", summary: "s1" } },
        { article: { title: "D2", summary: "s2" } },
        { article: { title: "D3", summary: "s3" } },
      ],
      lancamento: [{ title: "L1" }, { title: "L2" }, { title: "L3" }, { title: "L4" }, { title: "L5" }, { title: "L6" }, { title: "L7" }],
      radar: [{ title: "R1" }, { title: "R2" }, { title: "R3" }, { title: "R4" }, { title: "R5" }],
      use_melhor: [],
      video: [],
    };
    const capped = {
      ...uncapped,
      lancamento: uncapped.lancamento.slice(0, 5), // cap de 5 lançamentos
    };

    const uncappedCount = computeOutrosCount(uncapped);
    const cappedCount = computeOutrosCount(capped);

    assert.equal(uncappedCount, 12, "uncapped deve contar os 7 lançamentos originais");
    assert.equal(cappedCount, 10, "capped deve contar apenas os 5 lançamentos após cap");
    assert.ok(cappedCount < uncappedCount, "capped < uncapped quando caps cortam");
  });

  it("lintCommentDiariaCount com capped: número certo no social, sem findings", () => {
    // O social foi escrito com outros_count=10 (do capped). O lint também usa capped.
    // → zero findings (correto).
    const capped = {
      highlights: [
        { article: { title: "D1", summary: "s1" } },
        { article: { title: "D2", summary: "s2" } },
        { article: { title: "D3", summary: "s3" } },
      ],
      lancamento: [{ title: "L1" }, { title: "L2" }, { title: "L3" }, { title: "L4" }, { title: "L5" }],
      radar: [{ title: "R1" }, { title: "R2" }, { title: "R3" }, { title: "R4" }, { title: "R5" }],
      use_melhor: [],
      video: [],
    };
    // Social usa "mais 10 destaques" (capped conta 5+5=10)
    const socialWith10 = SOCIAL_WITH_COMMENTS.replace(/mais 9 destaques/g, "mais 10 destaques");
    const { findings } = lintCommentDiariaCount(socialWith10, capped);
    assert.equal(findings.length, 0, "sem findings quando social usa o número do capped");
  });

  it("lintCommentDiariaCount com uncapped: flagaria o número errado (#2044 root cause)", () => {
    // Se o lint usasse uncapped (bug original), o social com "mais 10 destaques"
    // (número correto do capped) seria flagado como errado — e o --fix substituiria
    // pelo número errado (12 do uncapped).
    const uncapped = {
      highlights: [
        { article: { title: "D1", summary: "s1" } },
        { article: { title: "D2", summary: "s2" } },
        { article: { title: "D3", summary: "s3" } },
      ],
      lancamento: [{ title: "L1" }, { title: "L2" }, { title: "L3" }, { title: "L4" }, { title: "L5" }, { title: "L6" }, { title: "L7" }],
      radar: [{ title: "R1" }, { title: "R2" }, { title: "R3" }, { title: "R4" }, { title: "R5" }],
      use_melhor: [],
      video: [],
    };
    // Social correto usa "mais 10 destaques" (do capped)
    const socialWithCorrectCappedNumber = SOCIAL_WITH_COMMENTS.replace(/mais 9 destaques/g, "mais 10 destaques");
    // Lint contra uncapped: esperaria 12, encontrou 10 → falso finding
    const { findings } = lintCommentDiariaCount(socialWithCorrectCappedNumber, uncapped);
    assert.equal(findings.length, 3, "uncapped lint flaga o número correto como errado (bug #2044)");
    assert.equal(findings[0].found, 10, "encontrou o número certo do capped (10)");
    assert.equal(findings[0].expected, 12, "mas esperava o número errado do uncapped (12)");
  });
});

// ---------------------------------------------------------------------------
// #2044 — regressão: --fix com unresolved_placeholder NÃO imprime "corrigido"
//          e sai com exit não-zero
// ---------------------------------------------------------------------------

describe("lint-social-numbers CLI (#2044) — unresolved_placeholder com --fix", () => {
  function runLintCli(socialPath: string, approvedPath: string, extraArgs: string[] = []) {
    const projectRoot = join(import.meta.dirname, "..");
    const scriptPath = join(projectRoot, "scripts", "lint-social-numbers.ts");
    return spawnSync(
      process.execPath,
      ["--import", "tsx", scriptPath, "--social", socialPath, "--approved", approvedPath, ...extraArgs],
      { cwd: projectRoot, encoding: "utf8" },
    );
  }

  it("--fix com unresolved_placeholder: NÃO imprime 'corrigido automaticamente', sai exit 1 (#2044)", () => {
    const tmp = mkdtempSync(join(tmpdir(), "lint-social-2044-"));
    try {
      // Social com placeholder literal não-resolvido
      const socialContent = SOCIAL_WITH_COMMENTS.replace(
        /mais 9 destaques de IA do dia/g,
        "mais {outros_count} destaques de IA do dia",
      );
      const socialPath = join(tmp, "03-social.md");
      const approvedPath = join(tmp, "01-approved-capped.json");
      writeFileSync(socialPath, socialContent, "utf8");
      writeFileSync(approvedPath, JSON.stringify(APPROVED_13_ITEMS), "utf8");

      const result = runLintCli(socialPath, approvedPath, ["--fix"]);

      // Deve sair com exit 1 (blocker — placeholder literal)
      assert.equal(result.status, 1, `expected exit 1, got ${result.status}\nstderr: ${result.stderr}`);

      // NÃO deve imprimir "corrigido automaticamente"
      assert.doesNotMatch(
        result.stderr,
        /corrigido automaticamente/i,
        "não deve imprimir 'corrigido automaticamente' para placeholder não-resolvível",
      );

      // Deve imprimir mensagem clara de blocker
      assert.match(
        result.stderr,
        /\{outros_count\}/,
        "deve mencionar o placeholder literal no stderr",
      );

      // O arquivo NÃO deve ter sido modificado (placeholder ainda lá)
      const contentAfter = readFileSync(socialPath, "utf8");
      assert.match(contentAfter, /\{outros_count\}/, "arquivo não deve ter sido modificado");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("--fix com número errado (não placeholder): imprime 'corrigido automaticamente' e sai exit 0 (#2044)", () => {
    const tmp = mkdtempSync(join(tmpdir(), "lint-social-2044b-"));
    try {
      const socialPath = join(tmp, "03-social.md");
      const approvedPath = join(tmp, "01-approved-capped.json");
      // Social com número errado (9, esperado 10 pelo APPROVED_13_ITEMS)
      writeFileSync(socialPath, SOCIAL_WITH_COMMENTS, "utf8");
      writeFileSync(approvedPath, JSON.stringify(APPROVED_13_ITEMS), "utf8");

      const result = runLintCli(socialPath, approvedPath, ["--fix"]);

      // Deve sair exit 0 (número errado é corrigível, não é blocker)
      assert.equal(result.status, 0, `expected exit 0, got ${result.status}\nstderr: ${result.stderr}`);

      // Deve imprimir "corrigido automaticamente"
      assert.match(
        result.stderr,
        /corrigido automaticamente/i,
        "deve imprimir 'corrigido automaticamente' quando a correção é aplicável",
      );

      // NÃO deve mencionar "IMPOSSÍVEL" (que é mensagem do placeholder)
      assert.doesNotMatch(result.stderr, /IMPOSSÍVEL/i);

      // Verificar que o arquivo foi de fato atualizado com o número correto
      const contentAfter = readFileSync(socialPath, "utf8");
      assert.match(contentAfter, /mais 10 destaques de IA do dia/, "arquivo deve conter o número correto após --fix");
      assert.doesNotMatch(contentAfter, /mais 9 destaques de IA do dia/, "número errado não deve mais constar após --fix");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
