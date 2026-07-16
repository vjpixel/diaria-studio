import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  stripHtmlComments,
  stripLeadingPlatformHeader,
  extractEiaCreditLine,
  buildEiaSocialSection,
  insertEiaSection,
} from "../scripts/merge-social-md.ts";
import {
  lintPlatformHeadersUnique,
  lintInstagramEmailCTA,
  lintFacebookCTAs,
  extractPlatformSection,
} from "../scripts/lib/social-lint-rules.ts";
import { extractSection } from "../scripts/lib/extract-section.ts";
import { makeEditionDir as makeEditionDirWithPrefix } from "./_helpers/make-edition-dir.ts";

function makeEditionDir(): string {
  return makeEditionDirWithPrefix("merge-social-");
}

function runScript(editionDir: string): {
  status: number | null;
  stdout: string;
  stderr: string;
} {
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "scripts/merge-social-md.ts",
      "--edition-dir",
      editionDir,
    ],
    { encoding: "utf8" },
  );
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

describe("stripHtmlComments (#875)", () => {
  it("strip de comentários balanceados retorna conteúdo limpo", () => {
    const input = "antes <!-- comentário --> depois";
    const r = stripHtmlComments(input);
    assert.equal(r.stripped, "antes  depois");
    assert.equal(r.warnings.length, 0);
  });

  it("input sem comentários passa intacto (modulo collapse de newlines)", () => {
    const r = stripHtmlComments("nada aqui");
    assert.equal(r.stripped, "nada aqui");
  });

  it("colapsa ≥3 newlines em 2", () => {
    const r = stripHtmlComments("a\n\n\n\nb");
    assert.equal(r.stripped, "a\n\nb");
  });

  it("comment não-fechado (`<!-- abc` sem `-->`) lança erro", () => {
    assert.throws(
      () => stripHtmlComments("texto <!-- abc sem fim"),
      /mal-formados.*1.*0/,
    );
  });

  it("comment órfão `-->` sem `<!--` lança erro", () => {
    assert.throws(
      () => stripHtmlComments("texto sem inicio --> finale"),
      /mal-formados.*0.*1/,
    );
  });

  it("comment nested (`<!-- a <!-- b --> c -->`) handle gracefully", () => {
    const input = "antes <!-- a <!-- b --> c --> depois";
    const r = stripHtmlComments(input);
    assert.equal(r.stripped, "antes  depois");
    assert.ok(r.warnings.some((w) => w.includes("nested")));
  });

  it("multiple comments balanceados strip todos", () => {
    const input = "<!-- 1 -->A<!-- 2 -->B<!-- 3 -->C";
    const r = stripHtmlComments(input);
    assert.equal(r.stripped, "ABC");
  });

  it("comments multilinhas funcionam", () => {
    const input = "antes\n<!--\n  multi\n  linha\n-->\ndepois";
    const r = stripHtmlComments(input);
    assert.equal(r.stripped, "antes\n\ndepois");
  });
});

describe("stripLeadingPlatformHeader (#3424)", () => {
  it("remove header LinkedIn no início do conteúdo", () => {
    const input = "# LinkedIn\n\n## d1\n\nconteúdo\n";
    assert.equal(stripLeadingPlatformHeader(input, "linkedin"), "## d1\n\nconteúdo\n");
  });

  it("remove header Facebook no início do conteúdo", () => {
    const input = "# Facebook\n\n## d1\n\nconteúdo\n";
    assert.equal(stripLeadingPlatformHeader(input, "facebook"), "## d1\n\nconteúdo\n");
  });

  it("case-insensitive e tolera trailing whitespace no header", () => {
    const input = "# linkedin   \n\nconteúdo\n";
    assert.equal(stripLeadingPlatformHeader(input, "linkedin"), "conteúdo\n");
  });

  it("tolera linhas em branco antes do header", () => {
    const input = "\n\n# LinkedIn\n\nconteúdo\n";
    assert.equal(stripLeadingPlatformHeader(input, "linkedin"), "conteúdo\n");
  });

  it("sem header no início → conteúdo intacto", () => {
    const input = "## d1\n\nconteúdo sem header\n";
    assert.equal(stripLeadingPlatformHeader(input, "linkedin"), input);
  });

  it("header da OUTRA plataforma no início → não remove", () => {
    const input = "# Facebook\n\nconteúdo\n";
    assert.equal(stripLeadingPlatformHeader(input, "linkedin"), input);
  });

  it("header no MEIO do conteúdo (não na 1ª linha não-vazia) → não remove", () => {
    const input = "## d1\n\n# LinkedIn\n\nconteúdo\n";
    assert.equal(stripLeadingPlatformHeader(input, "linkedin"), input);
  });

  it("substring 'LinkedIn' solta em prosa não é removida (regex exige linha inteira)", () => {
    const input = "Siga a Diar.ia no LinkedIn\n\nconteúdo\n";
    assert.equal(stripLeadingPlatformHeader(input, "linkedin"), input);
  });
});

describe("merge-social-md CLI", () => {
  it("happy path — ambos tmps válidos → merge OK + tmps deletados", () => {
    const dir = makeEditionDir();
    try {
      writeFileSync(
        join(dir, "_internal", "03-linkedin.tmp.md"),
        "## d1\n\nLinkedIn d1 content\n\n## d2\n\nLinkedIn d2 content\n",
      );
      writeFileSync(
        join(dir, "_internal", "03-facebook.tmp.md"),
        "## d1\n\nFacebook d1 content\n",
      );

      const r = runScript(dir);
      assert.equal(r.status, 0, `stderr: ${r.stderr}`);

      const out = readFileSync(join(dir, "03-social.md"), "utf8");
      assert.ok(out.startsWith("# LinkedIn\n\n"));
      assert.ok(out.includes("LinkedIn d1 content"));
      assert.ok(out.includes("# Facebook\n\n"));
      assert.ok(out.includes("Facebook d1 content"));
      // #1075: banner explica postagem manual de comment_pixel
      assert.ok(out.includes("Postagem semi-automática"));
      assert.ok(out.includes("comment_pixel"));

      // Tmps deletados após sucesso
      assert.equal(
        existsSync(join(dir, "_internal", "03-linkedin.tmp.md")),
        false,
      );
      assert.equal(
        existsSync(join(dir, "_internal", "03-facebook.tmp.md")),
        false,
      );
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("LinkedIn tmp ausente → exit 1 com nome do agent", () => {
    const dir = makeEditionDir();
    try {
      // Só Facebook tmp
      writeFileSync(
        join(dir, "_internal", "03-facebook.tmp.md"),
        "## d1\n\nFacebook content\n",
      );

      const r = runScript(dir);
      assert.equal(r.status, 1);
      assert.ok(r.stderr.includes("social-linkedin"));
      assert.ok(r.stderr.includes("ausente") || r.stderr.includes("FALHOU"));
      // Output principal não foi gravado
      assert.equal(existsSync(join(dir, "03-social.md")), false);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("Facebook tmp ausente → exit 1 com nome do agent", () => {
    const dir = makeEditionDir();
    try {
      writeFileSync(
        join(dir, "_internal", "03-linkedin.tmp.md"),
        "## d1\n\nLinkedIn content\n",
      );

      const r = runScript(dir);
      assert.equal(r.status, 1);
      assert.ok(r.stderr.includes("social-facebook"));
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("tmp vazio (0 bytes) → exit 1", () => {
    const dir = makeEditionDir();
    try {
      writeFileSync(join(dir, "_internal", "03-linkedin.tmp.md"), "");
      writeFileSync(
        join(dir, "_internal", "03-facebook.tmp.md"),
        "## d1\n\nFB\n",
      );

      const r = runScript(dir);
      assert.equal(r.status, 1);
      assert.ok(r.stderr.includes("social-linkedin"));
      assert.ok(r.stderr.includes("vazio"));
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("HTML comments balanceados → strip OK", () => {
    const dir = makeEditionDir();
    try {
      writeFileSync(
        join(dir, "_internal", "03-linkedin.tmp.md"),
        "## d1\n\n<!-- debug: source-id 42 -->\nLinkedIn content\n",
      );
      writeFileSync(
        join(dir, "_internal", "03-facebook.tmp.md"),
        "<!-- agent meta -->\n## d1\n\nFacebook content\n",
      );

      const r = runScript(dir);
      assert.equal(r.status, 0, `stderr: ${r.stderr}`);

      const out = readFileSync(join(dir, "03-social.md"), "utf8");
      assert.ok(!out.includes("<!--"), "no opening comment marker should remain");
      assert.ok(!out.includes("-->"), "no closing comment marker should remain");
      assert.ok(out.includes("LinkedIn content"));
      assert.ok(out.includes("Facebook content"));
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("HTML comment não-balanceado em LinkedIn → exit 1", () => {
    const dir = makeEditionDir();
    try {
      writeFileSync(
        join(dir, "_internal", "03-linkedin.tmp.md"),
        "## d1\n\n<!-- abc sem fechamento\nLinkedIn content\n",
      );
      writeFileSync(
        join(dir, "_internal", "03-facebook.tmp.md"),
        "## d1\n\nFB content\n",
      );

      const r = runScript(dir);
      assert.equal(r.status, 1);
      assert.ok(r.stderr.includes("mal-formados") || r.stderr.includes("FALHOU"));
      // Output principal não foi gravado (FS state preservado)
      assert.equal(existsSync(join(dir, "03-social.md")), false);
      // Tmps NÃO deletados em caso de erro (rollback-safe)
      assert.equal(
        existsSync(join(dir, "_internal", "03-linkedin.tmp.md")),
        true,
      );
      assert.equal(
        existsSync(join(dir, "_internal", "03-facebook.tmp.md")),
        true,
      );
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("HTML comment nested → handle gracefully (merge sucede)", () => {
    const dir = makeEditionDir();
    try {
      writeFileSync(
        join(dir, "_internal", "03-linkedin.tmp.md"),
        "## d1\n\n<!-- outer <!-- inner --> trailing -->\nVisible LinkedIn\n",
      );
      writeFileSync(
        join(dir, "_internal", "03-facebook.tmp.md"),
        "## d1\n\nVisible Facebook\n",
      );

      const r = runScript(dir);
      assert.equal(r.status, 0, `stderr: ${r.stderr}`);

      const out = readFileSync(join(dir, "03-social.md"), "utf8");
      assert.ok(!out.includes("<!--"));
      assert.ok(!out.includes("-->"));
      assert.ok(!out.includes("inner"));
      assert.ok(!out.includes("trailing"));
      assert.ok(out.includes("Visible LinkedIn"));
      assert.ok(out.includes("Visible Facebook"));
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("#3424 — tmp de LinkedIn já com header embutido → merge NÃO duplica (root cause do #3388)", () => {
    const dir = makeEditionDir();
    try {
      // Reproduz o caso real da edição 260713: o agent social-linkedin já
      // escreveu "# LinkedIn" no início do próprio tmp file.
      writeFileSync(
        join(dir, "_internal", "03-linkedin.tmp.md"),
        "# LinkedIn\n\n## d1\n\nLinkedIn d1 content\n",
      );
      writeFileSync(
        join(dir, "_internal", "03-facebook.tmp.md"),
        "## d1\n\nFacebook d1 content\n",
      );

      const r = runScript(dir);
      assert.equal(r.status, 0, `stderr: ${r.stderr}`);
      assert.ok(r.stderr.includes("já continha o header"), "deve avisar sobre o strip no stderr");

      const out = readFileSync(join(dir, "03-social.md"), "utf8");
      // Exatamente 1 ocorrência de "# LinkedIn" como linha inteira — não 2.
      const lintResult = lintPlatformHeadersUnique(out);
      assert.equal(lintResult.ok, true, JSON.stringify(lintResult.errors));
      assert.ok(out.includes("LinkedIn d1 content"));
      assert.ok(out.includes("Postagem semi-automática"));
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("#3424 — tmp de Facebook já com header embutido → merge NÃO duplica", () => {
    const dir = makeEditionDir();
    try {
      writeFileSync(
        join(dir, "_internal", "03-linkedin.tmp.md"),
        "## d1\n\nLinkedIn d1 content\n",
      );
      writeFileSync(
        join(dir, "_internal", "03-facebook.tmp.md"),
        "# Facebook\n\n## d1\n\nFacebook d1 content\n",
      );

      const r = runScript(dir);
      assert.equal(r.status, 0, `stderr: ${r.stderr}`);
      assert.ok(r.stderr.includes("já continha o header"), "deve avisar sobre o strip no stderr");

      const out = readFileSync(join(dir, "03-social.md"), "utf8");
      const lintResult = lintPlatformHeadersUnique(out);
      assert.equal(lintResult.ok, true, JSON.stringify(lintResult.errors));
      assert.ok(out.includes("Facebook d1 content"));
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("#3424 — ambos tmps já com header embutido → merge NÃO duplica em nenhuma plataforma", () => {
    const dir = makeEditionDir();
    try {
      writeFileSync(
        join(dir, "_internal", "03-linkedin.tmp.md"),
        "# LinkedIn\n\n## d1\n\nLinkedIn content\n",
      );
      writeFileSync(
        join(dir, "_internal", "03-facebook.tmp.md"),
        "# Facebook\n\n## d1\n\nFacebook content\n",
      );

      const r = runScript(dir);
      assert.equal(r.status, 0, `stderr: ${r.stderr}`);

      const out = readFileSync(join(dir, "03-social.md"), "utf8");
      const lintResult = lintPlatformHeadersUnique(out);
      assert.equal(lintResult.ok, true, JSON.stringify(lintResult.errors));
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  // ── #3486: seção Instagram dedicada (tmp opcional) ────────────────────────
  // Regressão do incidente que motivou #3486: antes deste fix, nenhum
  // agent/template emitia `# Instagram` em 03-social.md, então
  // `lintInstagramEmailCTA` sempre caía no fallback `# Facebook` — que
  // MANTÉM o CTA de e-mail (legítimo lá) — e a lint disparava incorretamente
  // sobre a copy do Instagram (que na real nunca existia). Com
  // `social-instagram` gerando um tmp próprio, o merge deve produzir uma
  // seção `# Instagram` real, sem CTA de e-mail, e a seção `# Facebook`
  // deve continuar intocada (CTA de e-mail preservado, sem violar lint).
  describe("#3486 — merge da seção Instagram (tmp opcional)", () => {
    it("Instagram tmp presente → 03-social.md ganha seção '# Instagram' própria, sem CTA de e-mail; Facebook mantém CTA de e-mail sem violar lint", () => {
      const dir = makeEditionDir();
      try {
        writeFileSync(
          join(dir, "_internal", "03-linkedin.tmp.md"),
          "## d1\n\nLinkedIn d1 content\n",
        );
        writeFileSync(
          join(dir, "_internal", "03-facebook.tmp.md"),
          "## d1\n\nFato concreto sobre IA. Receba notícias de IA todo dia por e-mail, assine grátis em https://diar.ia.br.\n",
        );
        writeFileSync(
          join(dir, "_internal", "03-instagram.tmp.md"),
          "## d1\n\nFato concreto sobre IA. Edição completa no link da bio. Segue @diar.ia pra não perder a próxima.\n",
        );

        const r = runScript(dir);
        assert.equal(r.status, 0, `stderr: ${r.stderr}`);

        const out = readFileSync(join(dir, "03-social.md"), "utf8");

        // Seção Instagram existe e é extraível isoladamente.
        const igSection = extractSection(out, "Instagram");
        assert.ok(igSection !== null, "seção '# Instagram' deve existir no merge");
        assert.ok(igSection!.includes("link da bio"));

        // (a) Seção Instagram passa limpa na lint no-email-cta-instagram —
        // e por ler a seção IG DIRETA (não o fallback FB), o CTA de e-mail do
        // Facebook não vaza pra validação do Instagram.
        const igLint = lintInstagramEmailCTA(out);
        assert.equal(igLint.ok, true, JSON.stringify(igLint.errors));

        // (b) Seção Facebook mantém o CTA de e-mail intacto — não removido
        // pelo merge, e a lint de CTA do Facebook (formato https://.../.) não
        // reclama (regra é sobre formato, não sobre proibir CTA de e-mail).
        const fbSection = extractPlatformSection(out, "facebook");
        assert.ok(fbSection !== null);
        assert.ok(
          fbSection!.includes("Receba notícias de IA todo dia por e-mail"),
          "CTA de e-mail do Facebook deve permanecer intacto (#3486 não altera Facebook)",
        );
        const fbCtaLint = lintFacebookCTAs(fbSection!);
        assert.equal(fbCtaLint.length, 0, JSON.stringify(fbCtaLint));

        // Tmp de Instagram deletado após sucesso, igual LinkedIn/Facebook.
        assert.equal(
          existsSync(join(dir, "_internal", "03-instagram.tmp.md")),
          false,
        );
      } finally {
        rmSync(dir, { recursive: true });
      }
    });

    it("Instagram tmp AUSENTE → merge sucede sem seção '# Instagram' (comportamento legado preservado, fallback FB continua valendo)", () => {
      const dir = makeEditionDir();
      try {
        writeFileSync(
          join(dir, "_internal", "03-linkedin.tmp.md"),
          "## d1\n\nLinkedIn d1 content\n",
        );
        writeFileSync(
          join(dir, "_internal", "03-facebook.tmp.md"),
          "## d1\n\nAssine grátis em diar.ia.br!\n",
        );
        // Nenhum 03-instagram.tmp.md gravado — simula edição/worktree onde
        // social-instagram não rodou (ou ainda não existe).

        const r = runScript(dir);
        assert.equal(r.status, 0, `stderr: ${r.stderr}`);

        const out = readFileSync(join(dir, "03-social.md"), "utf8");
        assert.equal(
          extractSection(out, "Instagram"),
          null,
          "sem tmp de Instagram, '# Instagram' não deve aparecer no merge",
        );

        // Comportamento legado preservado: sem seção IG própria, a lint
        // no-email-cta-instagram cai no fallback '# Facebook' e DETECTA o
        // CTA de e-mail (mesmo comportamento de antes do #3486 existir).
        const igLint = lintInstagramEmailCTA(out);
        assert.equal(igLint.ok, false, "sem seção IG, fallback FB deve disparar a lint (comportamento legado)");
        assert.ok(igLint.errors.length > 0);
      } finally {
        rmSync(dir, { recursive: true });
      }
    });

    it("Instagram tmp vazio (0 bytes) → warn no stderr, merge sucede sem seção Instagram (não é FATAL como LinkedIn/Facebook)", () => {
      const dir = makeEditionDir();
      try {
        writeFileSync(
          join(dir, "_internal", "03-linkedin.tmp.md"),
          "## d1\n\nLinkedIn content\n",
        );
        writeFileSync(
          join(dir, "_internal", "03-facebook.tmp.md"),
          "## d1\n\nFacebook content\n",
        );
        writeFileSync(join(dir, "_internal", "03-instagram.tmp.md"), "");

        const r = runScript(dir);
        assert.equal(r.status, 0, `stderr: ${r.stderr}`);
        assert.ok(r.stderr.includes("social-instagram"));

        const out = readFileSync(join(dir, "03-social.md"), "utf8");
        assert.equal(extractSection(out, "Instagram"), null);
      } finally {
        rmSync(dir, { recursive: true });
      }
    });

    it("Instagram tmp com header '# Instagram' embutido → merge NÃO duplica (mesma proteção #3424 aplicada ao 3º canal)", () => {
      const dir = makeEditionDir();
      try {
        writeFileSync(
          join(dir, "_internal", "03-linkedin.tmp.md"),
          "## d1\n\nLinkedIn content\n",
        );
        writeFileSync(
          join(dir, "_internal", "03-facebook.tmp.md"),
          "## d1\n\nFacebook content\n",
        );
        writeFileSync(
          join(dir, "_internal", "03-instagram.tmp.md"),
          "# Instagram\n\n## d1\n\nInstagram content\n",
        );

        const r = runScript(dir);
        assert.equal(r.status, 0, `stderr: ${r.stderr}`);
        assert.ok(r.stderr.includes("já continha o header"));

        const out = readFileSync(join(dir, "03-social.md"), "utf8");
        // Exatamente 1 ocorrência de "# Instagram" como linha inteira.
        const igHeaderCount = out
          .split("\n")
          .filter((l) => /^# Instagram\s*$/i.test(l)).length;
        assert.equal(igHeaderCount, 1, "header '# Instagram' não deve duplicar");
        assert.ok(out.includes("Instagram content"));
      } finally {
        rmSync(dir, { recursive: true });
      }
    });
  });
});

// ── #3471: seção "## eia" (posto social do "É IA?" pra publicação manual) ──

// Réplica minimal do formato real gerado por `eia-compose.ts` `buildEiaMd`
// (ver scripts/eia-compose.ts) — frontmatter com o GABARITO (eia_answer),
// header em negrito, linha de crédito.
const REAL_EIA_MD = `---
eia_answer:
  A: real
  B: ia
---

**É IA?**

[Landsort](https://pt.wikipedia.org/wiki/Landsort) é um farol na Suécia — [Tisha Mukherjee](https://commons.wikimedia.org/wiki/User:Tisha) / [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0).

Resultado da última edição: 62% das pessoas acertaram.
`;

describe("extractEiaCreditLine (#3471)", () => {
  it("extrai a linha de crédito (1ª linha não-vazia após o header **É IA?**)", () => {
    const line = extractEiaCreditLine(REAL_EIA_MD);
    assert.equal(
      line,
      "[Landsort](https://pt.wikipedia.org/wiki/Landsort) é um farol na Suécia — [Tisha Mukherjee](https://commons.wikimedia.org/wiki/User:Tisha) / [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0).",
    );
  });

  it("NUNCA retorna conteúdo do frontmatter — gabarito (eia_answer/real/ia) não vaza", () => {
    const line = extractEiaCreditLine(REAL_EIA_MD);
    assert.ok(line);
    assert.ok(!line!.includes("eia_answer"));
    assert.ok(!/^\s*A:\s*(real|ia)/i.test(line!));
  });

  it("ignora a linha 'Resultado da última edição' opcional — pega só o crédito", () => {
    const line = extractEiaCreditLine(REAL_EIA_MD);
    assert.ok(!line!.includes("Resultado da última edição"));
  });

  it("sem o header '**É IA?**' → retorna null (formato inesperado)", () => {
    const malformed = "---\neia_answer:\n  A: real\n  B: ia\n---\n\nsem header aqui\n";
    assert.equal(extractEiaCreditLine(malformed), null);
  });

  it("sem frontmatter mas com header → ainda extrai a linha de crédito", () => {
    const noFrontmatter = "**É IA?**\n\nUma foto qualquer — Autor / CC BY-SA 4.0.\n";
    assert.equal(extractEiaCreditLine(noFrontmatter), "Uma foto qualquer — Autor / CC BY-SA 4.0.");
  });

  it("CRLF (arquivo vindo do Drive/Windows) → extrai normalmente", () => {
    const crlf = REAL_EIA_MD.replace(/\n/g, "\r\n");
    const line = extractEiaCreditLine(crlf);
    assert.ok(line?.startsWith("[Landsort]"));
  });

  it("arquivo vazio → retorna null", () => {
    assert.equal(extractEiaCreditLine(""), null);
  });
});

describe("buildEiaSocialSection (#3471)", () => {
  it("gera seção '## eia' copy-paste-ready referenciando as imagens A/B", () => {
    const section = buildEiaSocialSection("Crédito de teste — Autor / CC BY-SA 4.0.");
    assert.ok(section.startsWith("## eia\n\n"));
    assert.ok(section.includes("01-eia-A.jpg"));
    assert.ok(section.includes("01-eia-B.jpg"));
    assert.ok(section.includes("Crédito de teste — Autor / CC BY-SA 4.0."));
  });

  it("NUNCA menciona o gabarito (eia_answer, 'A: real', 'B: ia')", () => {
    const section = buildEiaSocialSection("Crédito de teste — Autor / CC BY-SA 4.0.");
    assert.ok(!section.includes("eia_answer"));
    assert.ok(!/\bA:\s*(real|ia)\b/i.test(section));
    assert.ok(!/\bB:\s*(real|ia)\b/i.test(section));
  });

  it("não termina em pergunta (mesmo padrão editorial dos posts de destaque)", () => {
    const section = buildEiaSocialSection("Crédito.");
    const trimmed = section.trim();
    assert.ok(!trimmed.endsWith("?"), `não deveria terminar com '?': ...${trimmed.slice(-40)}`);
  });

  it("sem referências temporais relativas (#747 — hoje/ontem/agora/esta semana)", () => {
    const section = buildEiaSocialSection("Crédito.");
    assert.ok(!/\b(hoje|ontem|agora|esta semana|recentemente|acabou de)\b/i.test(section));
  });
});

describe("insertEiaSection (#3471)", () => {
  it("com '## post_pixel' presente → insere IMEDIATAMENTE antes dele (ordem pedida pelo editor)", () => {
    const linkedinBody =
      "## d1\n\nMain d1\n\n## d2\n\nMain d2\n\n## d3\n\nMain d3\n\n## post_pixel\n\nPost pessoal do Pixel\n";
    const eiaSection = "## eia\n\nConteúdo do É IA?\n";
    const out = insertEiaSection(linkedinBody, eiaSection);

    const idxD3 = out.indexOf("## d3");
    const idxEia = out.indexOf("## eia");
    const idxPostPixel = out.indexOf("## post_pixel");
    assert.ok(idxD3 < idxEia, "## eia deve vir depois de ## d3");
    assert.ok(idxEia < idxPostPixel, "## eia deve vir antes de ## post_pixel");
    assert.ok(out.includes("Conteúdo do É IA?"));
    assert.ok(out.includes("Post pessoal do Pixel"));
  });

  it("sem '## post_pixel' → acrescenta a seção ao final (nunca descarta o bloco)", () => {
    const linkedinBody = "## d1\n\nMain d1\n\n## d2\n\nMain d2\n";
    const eiaSection = "## eia\n\nConteúdo do É IA?\n";
    const out = insertEiaSection(linkedinBody, eiaSection);
    assert.ok(out.trim().endsWith("Conteúdo do É IA?"));
  });
});

describe("merge-social-md CLI — seção '## eia' (#3471)", () => {
  it("01-eia.md presente na raiz da edição → '## eia' aparece no LinkedIn, entre destaques e post_pixel", () => {
    const dir = makeEditionDir();
    try {
      writeFileSync(
        join(dir, "_internal", "03-linkedin.tmp.md"),
        "## d1\n\nMain d1\n\n## d2\n\nMain d2\n\n## d3\n\nMain d3\n\n## post_pixel\n\n<!-- destaque: d1 -->\n\nPost pessoal do Pixel\n",
      );
      writeFileSync(
        join(dir, "_internal", "03-facebook.tmp.md"),
        "## d1\n\nFacebook d1 content\n",
      );
      writeFileSync(join(dir, "01-eia.md"), REAL_EIA_MD);

      const r = runScript(dir);
      assert.equal(r.status, 0, `stderr: ${r.stderr}`);
      assert.ok(r.stderr.includes("seção '## eia' incluída"));

      const out = readFileSync(join(dir, "03-social.md"), "utf8");
      const liSection = extractPlatformSection(out, "linkedin");
      assert.ok(liSection);

      const idxD3 = liSection!.indexOf("## d3");
      const idxEia = liSection!.indexOf("## eia");
      const idxPostPixel = liSection!.indexOf("## post_pixel");
      assert.ok(idxD3 >= 0 && idxEia > idxD3, "## eia deve vir depois de ## d3");
      assert.ok(idxPostPixel > idxEia, "## eia deve vir antes de ## post_pixel");

      assert.ok(out.includes("01-eia-A.jpg"));
      assert.ok(out.includes("01-eia-B.jpg"));
      assert.ok(out.includes("Landsort"));

      // Gabarito NUNCA vaza pro social.md publicável.
      assert.ok(!out.includes("eia_answer"));
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("01-eia.md AUSENTE → merge sucede sem '## eia' (comportamento pré-#3471 preservado)", () => {
    const dir = makeEditionDir();
    try {
      writeFileSync(
        join(dir, "_internal", "03-linkedin.tmp.md"),
        "## d1\n\nMain d1\n\n## post_pixel\n\nPost pessoal do Pixel\n",
      );
      writeFileSync(
        join(dir, "_internal", "03-facebook.tmp.md"),
        "## d1\n\nFacebook d1 content\n",
      );
      // Nenhum 01-eia.md gravado — simula edição sem É IA? (skip, ou ainda processando).

      const r = runScript(dir);
      assert.equal(r.status, 0, `stderr: ${r.stderr}`);
      assert.ok(r.stderr.includes("01-eia.md ausente"));

      const out = readFileSync(join(dir, "03-social.md"), "utf8");
      assert.ok(!out.includes("## eia"));
      // Resto do merge não regride.
      assert.ok(out.includes("Post pessoal do Pixel"));
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("01-eia.md malformado (sem header '**É IA?**') → warn no stderr, merge sucede sem '## eia' (não é FATAL)", () => {
    const dir = makeEditionDir();
    try {
      writeFileSync(
        join(dir, "_internal", "03-linkedin.tmp.md"),
        "## d1\n\nMain d1\n\n## post_pixel\n\nPost pessoal\n",
      );
      writeFileSync(
        join(dir, "_internal", "03-facebook.tmp.md"),
        "## d1\n\nFacebook d1 content\n",
      );
      writeFileSync(join(dir, "01-eia.md"), "---\neia_answer:\n  A: real\n  B: ia\n---\n\nformato inesperado sem header\n");

      const r = runScript(dir);
      assert.equal(r.status, 0, `stderr: ${r.stderr}`);
      assert.ok(r.stderr.includes("formato inesperado"));

      const out = readFileSync(join(dir, "03-social.md"), "utf8");
      assert.ok(!out.includes("## eia"));
      assert.ok(!out.includes("eia_answer"));
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("01-eia.md presente → lintPlatformHeadersUnique + lintInstagramEmailCTA/Facebook continuam OK (sem regressão nos outros lints)", () => {
    const dir = makeEditionDir();
    try {
      writeFileSync(
        join(dir, "_internal", "03-linkedin.tmp.md"),
        "## d1\n\nMain d1\n\n### comment_diaria\n\nEdição completa com mais {outros_count} destaques em {edition_url}\n\nSiga a diar.ia.br no LinkedIn em linkedin.com/company/diar.ia.br\n\n### comment_pixel\n\nOpinião do Pixel sobre d1.\n\n## post_pixel\n\n{outros_count} novidades em {edition_url}. Post pessoal do Pixel sobre d1.\n\nSiga a diar.ia.br em linkedin.com/company/diar.ia.br\n",
      );
      writeFileSync(
        join(dir, "_internal", "03-facebook.tmp.md"),
        "## d1\n\nAssine grátis em https://diar.ia.br.\n",
      );
      writeFileSync(join(dir, "01-eia.md"), REAL_EIA_MD);

      const r = runScript(dir);
      assert.equal(r.status, 0, `stderr: ${r.stderr}`);

      const out = readFileSync(join(dir, "03-social.md"), "utf8");
      assert.equal(lintPlatformHeadersUnique(out).ok, true);

      const fbSection = extractPlatformSection(out, "facebook");
      assert.equal(lintFacebookCTAs(fbSection!).length, 0);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});
