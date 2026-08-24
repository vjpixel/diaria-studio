/**
 * test/reorder-destaques.test.ts (#1585)
 *
 * Cobre helpers puros + integração filesystem do reorder-destaques.ts.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  readFileSync,
  writeFileSync,
  existsSync,
  readdirSync,
  renameSync as renameFsSync,
  copyFileSync as copyFileFsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import {
  reorderHighlightsInJson,
  reorderDestaquesInMd,
  detectTrailingNonDestaqueContent,
  updateIntentionalErrorLocationJson,
  reorderSocialMd,
  renameDestaqueImages,
  renameDestaquePrompts,
  renameSyncVerified,
  deriveTituloSubtitulo,
  parseArgs,
  refreshSocialSourceHash,
  reindexCarouselSourceHashes,
  type RenameFileDeps,
} from "../scripts/reorder-destaques.ts";
import { hashFromApprovedFile } from "../scripts/lib/social-source-hash.ts";
import { checkIntentionalError } from "../scripts/lib/lint-checks/intentional-error.ts";
import type { IntentionalErrorJson } from "../scripts/lib/intentional-errors.ts";

describe("reorderHighlightsInJson (#1585)", () => {
  it("swap 1↔2: highlights[0]=original[1], highlights[1]=original[0]", () => {
    const data = {
      highlights: [
        { id: "A", title: "Opus" },
        { id: "B", title: "Mercer" },
        { id: "C", title: "C6" },
      ],
    };
    assert.equal(reorderHighlightsInJson(data, [2, 1, 3]), true);
    assert.equal((data.highlights[0] as { id: string }).id, "B");
    assert.equal((data.highlights[1] as { id: string }).id, "A");
    assert.equal((data.highlights[2] as { id: string }).id, "C");
  });

  it("rotate 1→3,2→1,3→2 ([3,1,2])", () => {
    const data = {
      highlights: [{ id: "A" }, { id: "B" }, { id: "C" }],
    };
    reorderHighlightsInJson(data, [3, 1, 2]);
    assert.equal((data.highlights[0] as { id: string }).id, "C");
    assert.equal((data.highlights[1] as { id: string }).id, "A");
    assert.equal((data.highlights[2] as { id: string }).id, "B");
  });

  it("preserva slots 3+ (runners-up no top-level)", () => {
    const data = {
      highlights: [
        { id: "A" },
        { id: "B" },
        { id: "C" },
        { id: "X" },
        { id: "Y" },
      ],
    };
    reorderHighlightsInJson(data, [2, 1, 3]);
    assert.equal((data.highlights[3] as { id: string }).id, "X");
    assert.equal((data.highlights[4] as { id: string }).id, "Y");
  });

  it("retorna false se highlights ausente", () => {
    const data = {};
    assert.equal(reorderHighlightsInJson(data, [2, 1, 3]), false);
  });

  it("reorder × 2 = identity (idempotência)", () => {
    const data = {
      highlights: [{ id: "A" }, { id: "B" }, { id: "C" }],
    };
    reorderHighlightsInJson(data, [2, 1, 3]);
    reorderHighlightsInJson(data, [2, 1, 3]);
    assert.equal((data.highlights[0] as { id: string }).id, "A");
    assert.equal((data.highlights[1] as { id: string }).id, "B");
  });
});

describe("reorderDestaquesInMd (#1585)", () => {
  it("swap D1↔D2 reorders blocks AND renumbers headers", () => {
    const md = `Intro...

---

**DESTAQUE 1 | 🚀 LANÇAMENTO**

**[Opus](https://x.com)**

Texto Opus.

---

**DESTAQUE 2 | 💼 MERCADO**

**[Mercer](https://y.com)**

Texto Mercer.

---

**DESTAQUE 3 | 🇧🇷 BRASIL**

**[C6](https://z.com)**

Texto C6.

---

**📰 OUTRAS NOTÍCIAS**

[N1](https://n.com)
`;
    const result = reorderDestaquesInMd(md, [2, 1, 3]);
    // Esperado: bloco do Mercer (era D2) agora vem como DESTAQUE 1
    const d1Idx = result.indexOf("**DESTAQUE 1");
    const mercerIdx = result.indexOf("Mercer");
    const opusIdx = result.indexOf("Opus");
    assert.ok(d1Idx >= 0);
    assert.ok(mercerIdx < opusIdx, "Mercer (era D2) agora antes do Opus (era D1)");
    // E o block do Opus deve ter sido renumerado pra DESTAQUE 2
    const d2Idx = result.indexOf("**DESTAQUE 2");
    assert.ok(d2Idx > 0 && d2Idx > d1Idx);
  });

  it("MD sem 3 blocos DESTAQUE → no-op", () => {
    const md = "**DESTAQUE 1 | A**\n\n**[T](https://x.com)**";
    assert.equal(reorderDestaquesInMd(md, [2, 1, 3]), md);
  });

  it("Review #1606+#1608: RADAR (📡) é terminator do D3 — não engole bloco RADAR", () => {
    // Pré-fix: blockRe não incluía 📡 → D3 estendia até ERRO INTENCIONAL
    // engolindo RADAR. Reorder corrompia o RADAR.
    const md = `Intro...

---

**DESTAQUE 1 | 🚀 LANÇAMENTO**

**[Opus](https://anthropic.com)**

Texto Opus.

---

**DESTAQUE 2 | 💼 MERCADO**

**[Mercer](https://exame.com)**

Texto Mercer.

---

**DESTAQUE 3 | 🇧🇷 BRASIL**

**[C6](https://c6.com)**

Texto C6.

---

**📡 RADAR**

**[Item radar](https://r.com)**

Desc radar.

---

**ERRO INTENCIONAL**

placeholder
`;
    const result = reorderDestaquesInMd(md, [2, 1, 3]);
    // RADAR section deve estar intacta pós-reorder, NÃO consumida pelo D3.
    assert.ok(
      result.indexOf("**📡 RADAR**") > 0,
      "RADAR section deve estar presente pós-reorder",
    );
    assert.ok(
      result.indexOf("Item radar") > 0,
      "conteúdo do RADAR preservado",
    );
    // Mercer (era D2) agora vem como DESTAQUE 1, antes do bloco RADAR
    const mercerIdx = result.indexOf("Mercer");
    const radarIdx = result.indexOf("RADAR");
    assert.ok(mercerIdx > 0 && mercerIdx < radarIdx);
  });
});

describe("detectTrailingNonDestaqueContent (#5585)", () => {
  it("bloco canônico (título → parágrafos → Por que importa → Aprofunde + bullets) → false", () => {
    const block = `**DESTAQUE 1 | 🚀 LANÇAMENTO**

**[Opus](https://x.com)**

Texto Opus.

Por que isso importa:

Impacto prático.

Aprofunde:

* [Fonte 1](https://a.com) - Site A
* [Fonte 2](https://b.com) - Site B
`;
    assert.equal(detectTrailingNonDestaqueContent(block), false);
  });

  it("box de divulgação colado após Aprofunde (dentro do mesmo chunk) → true", () => {
    // Reproduz o caso real (#5585): um box (ex: livros-divulgacao.md,
    // formato bold-line) capturado no mesmo chunk do destaque anterior por
    // não ter header próprio reconhecido por blockRe.
    const block = `**DESTAQUE 1 | 🚀 LANÇAMENTO**

**[Opus](https://x.com)**

Texto Opus.

Por que isso importa:

Impacto prático.

Aprofunde:

* [Fonte 1](https://a.com) - Site A

**Confira nossa curadoria de livros sobre IA [aqui](https://livros.diar.ia.br)**
`;
    assert.equal(detectTrailingNonDestaqueContent(block), true);
  });

  it("sem seção 'Aprofunde:' (formato legado) → false (conservador, não arrisca falso positivo)", () => {
    const block = `**DESTAQUE 1 | 🚀 LANÇAMENTO**

**[Opus](https://x.com)**

Texto Opus sem seção Aprofunde.
`;
    assert.equal(detectTrailingNonDestaqueContent(block), false);
  });

  it("'Aprofunde:' seguido só de bullets (sem trailing blank) → false", () => {
    const block = `**DESTAQUE 1 | 🚀 LANÇAMENTO**

Texto.

Aprofunde:

* [Fonte 1](https://a.com) - Site A
* [Fonte 2](https://b.com) - Site B`;
    assert.equal(detectTrailingNonDestaqueContent(block), false);
  });

  it("#4907: 'Saiba mais:' + link do hub após Aprofunde → false (conteúdo mecânico do próprio destaque, não box)", () => {
    // Review PR #5588: sem esta exceção explícita, TODA edição com hub
    // temático casado (anthropic-claude/openai-chatgpt/etc, injetado por
    // stitch-newsletter.ts) dispararia falso positivo aqui.
    const block = `**DESTAQUE 1 | 🚀 LANÇAMENTO**

**[Opus](https://x.com)**

Texto Opus.

Por que isso importa:

Impacto prático.

Aprofunde:

* [Fonte 1](https://a.com) - Site A

Saiba mais:

[Tudo sobre Claude/Anthropic](https://arquivo.diar.ia.br/temas/anthropic-claude?utm_source=newsletter)
`;
    assert.equal(detectTrailingNonDestaqueContent(block), false);
  });

  it("#4907: box de divulgação DEPOIS do 'Saiba mais:' ainda é detectado → true", () => {
    // A exceção do hub só cobre o próprio bloco "Saiba mais:" + link — não
    // vira um passe livre pra qualquer coisa que venha depois dele.
    const block = `**DESTAQUE 1 | 🚀 LANÇAMENTO**

Texto.

Aprofunde:

* [Fonte 1](https://a.com) - Site A

Saiba mais:

[Tudo sobre Claude/Anthropic](https://arquivo.diar.ia.br/temas/anthropic-claude)

**Box de divulgação colado aqui [link](https://x.com)**
`;
    assert.equal(detectTrailingNonDestaqueContent(block), true);
  });

  it("reorderDestaquesInMd NÃO avisa sobre bloco cuja posição não muda (ex: D3 parado num swap D1<->D2)", () => {
    // Review PR #5588: newOrder=[2,1,3] move D1 e D2, mas D3 permanece na
    // posição 3 — mesmo que D3 carregue um box na lacuna seguinte (antes de
    // OUTRAS NOTÍCIAS), nada relacionado a ele "viaja" neste reorder, então
    // não há aviso útil a dar.
    const md = `Intro...

---

**DESTAQUE 1 | 🚀 LANÇAMENTO**

**[Opus](https://x.com)**

Texto Opus.

Aprofunde:

* [Fonte 1](https://a.com) - Site A

---

**DESTAQUE 2 | 💼 MERCADO**

**[Mercer](https://y.com)**

Texto Mercer.

Aprofunde:

* [Fonte 2](https://b.com) - Site B

---

**DESTAQUE 3 | 🇧🇷 BRASIL**

**[C6](https://z.com)**

Texto C6.

Aprofunde:

* [Fonte 3](https://c.com) - Site C

**Box parado junto do D3 [link](https://x.com)**

---

**📰 OUTRAS NOTÍCIAS**

[N1](https://n.com)
`;
    const originalWarn = console.warn;
    const warnings: string[] = [];
    console.warn = (msg: string) => {
      warnings.push(msg);
    };
    try {
      reorderDestaquesInMd(md, [2, 1, 3]);
    } finally {
      console.warn = originalWarn;
    }
    assert.equal(
      warnings.length,
      0,
      `não esperava nenhum warning (D3 não muda de posição). Warnings capturados: ${JSON.stringify(warnings)}`,
    );
  });

  it("reorderDestaquesInMd emite console.warn quando detecta conteúdo sobrando", () => {
    const md = `Intro...

---

**DESTAQUE 1 | 🚀 LANÇAMENTO**

**[Opus](https://x.com)**

Texto Opus.

Por que isso importa:

Impacto.

Aprofunde:

* [Fonte 1](https://a.com) - Site A

**Box de divulgação colado aqui [link](https://x.com)**

---

**DESTAQUE 2 | 💼 MERCADO**

**[Mercer](https://y.com)**

Texto Mercer.

Por que isso importa:

Impacto.

Aprofunde:

* [Fonte 2](https://b.com) - Site B

---

**DESTAQUE 3 | 🇧🇷 BRASIL**

**[C6](https://z.com)**

Texto C6.

Por que isso importa:

Impacto.

Aprofunde:

* [Fonte 3](https://c.com) - Site C

---

**📰 OUTRAS NOTÍCIAS**

[N1](https://n.com)
`;
    const originalWarn = console.warn;
    const warnings: string[] = [];
    console.warn = (msg: string) => {
      warnings.push(msg);
    };
    try {
      reorderDestaquesInMd(md, [2, 1, 3]);
    } finally {
      console.warn = originalWarn;
    }
    assert.ok(
      warnings.some((w) => /DESTAQUE 1/.test(w) && /divulgação/.test(w)),
      `esperava warning mencionando DESTAQUE 1 e "divulgação". Warnings capturados: ${JSON.stringify(warnings)}`,
    );
    // DESTAQUE 2 e 3 são canônicos (sem conteúdo extra) — não devem gerar warning.
    assert.ok(
      !warnings.some((w) => /DESTAQUE 2/.test(w) || /DESTAQUE 3/.test(w)),
      `não esperava warning para DESTAQUE 2/3. Warnings capturados: ${JSON.stringify(warnings)}`,
    );
  });
});

describe("updateIntentionalErrorLocationJson (#1585, migrado pra JSON #3222)", () => {
  it("DESTAQUE 2 + swap 2↔1 → DESTAQUE 1", () => {
    const record: IntentionalErrorJson = {
      location: "DESTAQUE 2, parágrafo 2, primeira frase",
      category: "factual",
    };
    const { record: result, changed } = updateIntentionalErrorLocationJson(record, [2, 1, 3]);
    assert.equal(changed, true);
    assert.equal(result.location, "DESTAQUE 1, parágrafo 2, primeira frase");
  });

  it("DESTAQUE 3 + rotation 3→1,1→2,2→3 → DESTAQUE 1", () => {
    const record: IntentionalErrorJson = { location: "DESTAQUE 3" };
    // newOrder=[3,1,2] significa: posição 1 fica com original 3, posição 2 com original 1, posição 3 com original 2
    // Então o que era DESTAQUE 3 agora é DESTAQUE 1
    const { record: result, changed } = updateIntentionalErrorLocationJson(record, [3, 1, 2]);
    assert.equal(changed, true);
    assert.equal(result.location, "DESTAQUE 1");
  });

  it("location sem DESTAQUE N (ex: OUTRAS NOTÍCIAS) → no-op", () => {
    const record: IntentionalErrorJson = { location: "OUTRAS NOTÍCIAS, item 3" };
    const { record: result, changed } = updateIntentionalErrorLocationJson(record, [2, 1, 3]);
    assert.equal(changed, false);
    assert.equal(result.location, "OUTRAS NOTÍCIAS, item 3");
  });

  it("#2366: location 'DESTAQUE 3' + newOrder=[2,1] (3→2 rebase) → marca REVISAR (não fica stale)", () => {
    // Caso de reorder numa edição rebaixada de 3 para 2 destaques:
    // o record ainda guarda location='DESTAQUE 3', mas DESTAQUE 3
    // não existe mais em newOrder=[2,1]. Antes do fix #2366, retornava
    // o record intacto (location stale silenciosa). Após o fix, marca um sentinel REVISAR.
    const record: IntentionalErrorJson = {
      location: "DESTAQUE 3, parágrafo 1",
      category: "factual",
    };
    const { record: result, changed } = updateIntentionalErrorLocationJson(record, [2, 1]);
    assert.equal(changed, true);
    // Stale 'DESTAQUE 3' removido + sentinel REVISAR escrito
    assert.ok(
      !result.location!.includes("DESTAQUE 3"),
      `location 'DESTAQUE 3' stale deveria ter sido removida. Resultado: ${result.location}`,
    );
    assert.match(
      result.location ?? "",
      /^\[REVISAR/,
      `location deveria ter sido marcada com sentinel REVISAR. Resultado: ${result.location}`,
    );
  });

  it("#2366: location REVISAR NÃO é vazia — passa o lint intentional-error (não bloqueia Stage 5)", () => {
    // Guard de regressão crítico (code-review #2395): se o fix limpasse a
    // location pra string vazia, checkIntentionalError reportaria
    // "intentional_error_incomplete: campos faltando — location" → ok:false
    // → BLOQUEIA publicação no Stage 5. O sentinel não-vazio passa o lint.
    const record: IntentionalErrorJson = {
      description: "Erro de data",
      location: "DESTAQUE 3, parágrafo 1",
      category: "factual_synthetic",
      correct_value: "2026",
      reveal: "Na última edição, escrevi X onde o correto é 2026.",
    };
    const { record: result } = updateIntentionalErrorLocationJson(record, [2, 1]);
    const dir = mkdtempSync(join(tmpdir(), "reorder-lint-"));
    try {
      const mdPath = join(dir, "02-reviewed.md");
      const internalDir = join(dir, "_internal");
      mkdirSync(internalDir, { recursive: true });
      writeFileSync(mdPath, "Body...");
      writeFileSync(join(internalDir, "intentional-error.json"), JSON.stringify(result, null, 2));
      const lint = checkIntentionalError(mdPath);
      assert.equal(
        lint.ok,
        true,
        `lint deveria passar com sentinel não-vazio. Label: ${lint.label ?? "(none)"}`,
      );
      assert.ok(
        !/campos faltando/.test(lint.label ?? ""),
        `location não deveria ser reportada como faltando. Label: ${lint.label}`,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("#2366: location 'DESTAQUE 2' + newOrder=[1] (reduz a 1 destaque hipotético) → marca REVISAR", () => {
    // Mesmo padrão: destaque referenciado não existe em newOrder
    const record: IntentionalErrorJson = { location: "DESTAQUE 2" };
    const { record: result, changed } = updateIntentionalErrorLocationJson(record, [1]);
    assert.equal(changed, true);
    assert.ok(
      !result.location!.includes("DESTAQUE 2"),
      `location 'DESTAQUE 2' stale deveria ter sido removida. Resultado: ${result.location}`,
    );
    assert.match(
      result.location ?? "",
      /\[REVISAR/,
      `location deveria ter sido marcada com sentinel REVISAR. Resultado: ${result.location}`,
    );
  });
});

describe("reorderSocialMd (#1585)", () => {
  it("swap D1↔D2 em ambas plataformas LinkedIn + Facebook", () => {
    const md = `# LinkedIn

## d1

Post LinkedIn D1...

## d2

Post LinkedIn D2...

## d3

Post LinkedIn D3...

# Facebook

## d1

Post FB D1...

## d2

Post FB D2...

## d3

Post FB D3...
`;
    const result = reorderSocialMd(md, [2, 1, 3]);
    // Cada `## d1` original deve ter virado `## d2` e vice-versa
    const d1Matches = (result.match(/^## d1\b/gm) ?? []).length;
    const d2Matches = (result.match(/^## d2\b/gm) ?? []).length;
    const d3Matches = (result.match(/^## d3\b/gm) ?? []).length;
    assert.equal(d1Matches, 2);
    assert.equal(d2Matches, 2);
    assert.equal(d3Matches, 2);
    // Verificar conteúdo: ## d1 deve agora ter "Post LinkedIn D2" (era D2)
    const firstD1Section = result.match(/## d1[\s\S]*?(?=## d|$)/)?.[0] ?? "";
    assert.match(firstD1Section, /Post LinkedIn D2/);
  });

  it("3,1,2 rotation", () => {
    const md = `## d1

A1

## d2

A2

## d3

A3
`;
    const result = reorderSocialMd(md, [3, 1, 2]);
    const d1Section = result.match(/## d1[\s\S]*?(?=## d|$)/)?.[0] ?? "";
    assert.match(d1Section, /A3/); // original d3 agora é d1
  });
});

describe("renameDestaqueImages (#1585)", () => {
  it("swap d1↔d2 renames 04-d1-*.jpg → 04-d2-*.jpg e vice-versa", () => {
    const dir = mkdtempSync(join(tmpdir(), "reorder-img-"));
    try {
      writeFileSync(join(dir, "04-d1-2x1.jpg"), "data1-2x1");
      writeFileSync(join(dir, "04-d1-1x1.jpg"), "data1-1x1");
      writeFileSync(join(dir, "04-d2-1x1.jpg"), "data2-1x1");
      writeFileSync(join(dir, "04-d3-1x1.jpg"), "data3-1x1");

      renameDestaqueImages(dir, [2, 1, 3], false);

      assert.ok(existsSync(join(dir, "04-d1-1x1.jpg")));
      assert.ok(existsSync(join(dir, "04-d2-2x1.jpg")));
      assert.ok(existsSync(join(dir, "04-d2-1x1.jpg")));
      assert.equal(
        readFileSync(join(dir, "04-d1-1x1.jpg"), "utf8"),
        "data2-1x1",
        "novo d1 deve ter os bytes do antigo d2",
      );
      assert.equal(
        readFileSync(join(dir, "04-d2-1x1.jpg"), "utf8"),
        "data1-1x1",
      );
      assert.equal(
        readFileSync(join(dir, "04-d2-2x1.jpg"), "utf8"),
        "data1-2x1",
        "2x1 também segue (era do D1)",
      );
      assert.ok(existsSync(join(dir, "04-d3-1x1.jpg"))); // intacto
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("dry-run não modifica filesystem", () => {
    const dir = mkdtempSync(join(tmpdir(), "reorder-img-dry-"));
    try {
      writeFileSync(join(dir, "04-d1-2x1.jpg"), "a");
      writeFileSync(join(dir, "04-d2-1x1.jpg"), "b");

      renameDestaqueImages(dir, [2, 1, 3], true);

      // Files in original positions
      assert.ok(existsSync(join(dir, "04-d1-2x1.jpg")));
      assert.ok(existsSync(join(dir, "04-d2-1x1.jpg")));
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});

describe("renameDestaquePrompts (#1585)", () => {
  it("rename 02-d{N}-prompt.md, sd-prompt.json, draft.md", () => {
    const dir = mkdtempSync(join(tmpdir(), "reorder-prompts-"));
    try {
      writeFileSync(join(dir, "02-d1-prompt.md"), "p1");
      writeFileSync(join(dir, "02-d2-prompt.md"), "p2");
      writeFileSync(join(dir, "02-d1-sd-prompt.json"), "sd1");
      writeFileSync(join(dir, "02-d2-sd-prompt.json"), "sd2");

      renameDestaquePrompts(dir, [2, 1, 3], false);

      assert.equal(readFileSync(join(dir, "02-d1-prompt.md"), "utf8"), "p2");
      assert.equal(readFileSync(join(dir, "02-d2-prompt.md"), "utf8"), "p1");
      assert.equal(readFileSync(join(dir, "02-d1-sd-prompt.json"), "utf8"), "sd2");
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});

describe("renameSyncVerified (#5085 — guard pós-rename)", () => {
  it("rename normal (destino existe depois) não lança", () => {
    const dir = mkdtempSync(join(tmpdir(), "reorder-verify-ok-"));
    try {
      writeFileSync(join(dir, "a.jpg"), "bytes");
      assert.doesNotThrow(() => renameSyncVerified(join(dir, "a.jpg"), join(dir, "b.jpg")));
      assert.ok(existsSync(join(dir, "b.jpg")));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("#5085: destino sumiu logo após renameSync (simula conflito OneDrive) → lança erro claro", () => {
    // Simula o cenário real reportado na issue: renameSync retorna sem erro,
    // mas o arquivo de destino não existe mais quando checado logo em seguida
    // (resolução de conflito de sync descartando a versão "perdedora").
    const calls: Array<{ from: string; to: string }> = [];
    const fakeDeps: RenameFileDeps = {
      renameSync: (from, to) => {
        calls.push({ from: String(from), to: String(to) });
        // Não cria o destino de verdade — simula o rename "sumir" depois.
      },
      existsSync: () => false,
      copyFileSync: copyFileFsSync,
      readFileSync,
    };
    assert.throws(
      () => renameSyncVerified("/fake/from.jpg", "/fake/to.jpg", fakeDeps),
      /rename .* retornou sem erro mas o arquivo de destino não existe/,
    );
    assert.equal(calls.length, 1, "renameSync deveria ter sido chamado exatamente 1×");
  });
});

describe("renameDestaqueImages (#5564 — guard pós-escrita + 4x5-nativo)", () => {
  it("destino da escrita final sumiu → aborta a sequência inteira (não segue silenciosamente)", () => {
    const dir = mkdtempSync(join(tmpdir(), "reorder-img-vanish-"));
    try {
      writeFileSync(join(dir, "04-d1-1x1.jpg"), "data1");
      writeFileSync(join(dir, "04-d2-1x1.jpg"), "data2");
      writeFileSync(join(dir, "04-d3-1x1.jpg"), "data3");

      // deps reais, exceto existsSync: qualquer arquivo DENTRO de `dir`
      // (o diretório "sincronizado") reporta ausência — simula o OneDrive
      // descartando a escrita final entre o `copyFileSync` e a checagem
      // seguinte (o staging, fora de `dir`, continua reportando a verdade).
      const fakeDeps: RenameFileDeps = {
        renameSync: renameFsSync,
        copyFileSync: copyFileFsSync,
        readFileSync,
        existsSync: (p) => {
          const s = String(p);
          if (s === dir) return true;
          if (s.startsWith(dir + sep)) return false;
          return existsSync(s);
        },
      };

      assert.throws(
        () => renameDestaqueImages(dir, [2, 1, 3], false, fakeDeps),
        /reorder-destaques: escrita de .* retornou sem erro mas o arquivo não existe/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("cobre 04-d{N}-4x5-nativo.jpg no rename set (regex antiga excluía por causa do hífen)", () => {
    const dir = mkdtempSync(join(tmpdir(), "reorder-img-nativo-"));
    try {
      writeFileSync(join(dir, "04-d1-4x5-nativo.jpg"), "nativo1");
      writeFileSync(join(dir, "04-d2-4x5-nativo.jpg"), "nativo2");

      const renames = renameDestaqueImages(dir, [2, 1, 3], false);

      assert.ok(
        renames.some((r) => r.from === "04-d1-4x5-nativo.jpg"),
        `esperava rename de 04-d1-4x5-nativo.jpg — renames: ${JSON.stringify(renames)}`,
      );
      assert.equal(
        readFileSync(join(dir, "04-d1-4x5-nativo.jpg"), "utf8"),
        "nativo2",
        "novo d1-4x5-nativo deve ter os bytes do antigo d2-4x5-nativo",
      );
      assert.equal(
        readFileSync(join(dir, "04-d2-4x5-nativo.jpg"), "utf8"),
        "nativo1",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("renameDestaqueImages / renameDestaquePrompts (#5564 — rollback via staging restaura conteúdo original)", () => {
  // #5564 substituiu a dança de rename-em-2-passos (original→TMP→final,
  // toda ela dentro do diretório sincronizado) por staging local +
  // escrita direta no destino (ver docstring de `stageAndWriteVerified`
  // em scripts/reorder-destaques.ts). O rollback não depende mais de uma
  // pilha cronológica de renames — cada arquivo afetado tem seu conteúdo
  // ORIGINAL capturado no staging ANTES de qualquer escrita, então o
  // rollback simplesmente regrava esse conteúdo de volta no path
  // original, pra CADA arquivo afetado, independente de quais escritas
  // chegaram a rodar.
  it("renameDestaqueImages: swap D1↔D2, escrita final do 2º arquivo falha → D1 e D2 restaurados intactos (nenhum perdido, nenhum sobrescrito)", () => {
    const dir = mkdtempSync(join(tmpdir(), "reorder-img-cyclic-rollback-"));
    try {
      writeFileSync(join(dir, "04-d1-1x1.jpg"), "CONTENT_D1");
      writeFileSync(join(dir, "04-d2-1x1.jpg"), "CONTENT_D2");
      writeFileSync(join(dir, "04-d3-1x1.jpg"), "CONTENT_D3");

      // pending (ordem de readdirSync): d1→(final)d2, d2→(final)d1. A
      // 1ª escrita final (dest=04-d2-1x1.jpg) sucede; a 2ª (dest=04-d1-1x1.jpg)
      // falha — simula um erro tipo EPERM/ENOSPC do próprio copyFileSync,
      // não um conflito pós-escrita do OneDrive (já coberto no describe
      // "#5564 — guard pós-escrita" acima). A flag garante que só a 1ª
      // chamada casando o path falha — o rollback (que também escreve
      // nesse mesmo path) deve suceder normalmente.
      let failureInjected = false;
      const finalD1Path = join(dir, "04-d1-1x1.jpg");
      const fakeDeps: RenameFileDeps = {
        renameSync: renameFsSync,
        existsSync,
        readFileSync,
        copyFileSync: ((from: unknown, to: unknown, ...rest: unknown[]) => {
          if (!failureInjected && String(to) === finalD1Path) {
            failureInjected = true;
            throw new Error("simulated failure writing final 04-d1-1x1.jpg");
          }
          (copyFileFsSync as any)(from, to, ...rest);
        }) as typeof copyFileFsSync,
      };

      assert.throws(
        () => renameDestaqueImages(dir, [2, 1, 3], false, fakeDeps),
        /simulated failure writing final 04-d1-1x1\.jpg/,
      );

      // Nenhum arquivo extra (staging/TMP) vaza pro diretório sincronizado.
      assert.deepEqual(
        readdirSync(dir).sort(),
        ["04-d1-1x1.jpg", "04-d2-1x1.jpg", "04-d3-1x1.jpg"],
      );

      assert.equal(
        readFileSync(join(dir, "04-d1-1x1.jpg"), "utf8"),
        "CONTENT_D1",
        "04-d1-1x1.jpg deveria ter o conteúdo ORIGINAL restaurado pelo rollback",
      );
      assert.equal(
        readFileSync(join(dir, "04-d2-1x1.jpg"), "utf8"),
        "CONTENT_D2",
        "04-d2-1x1.jpg deveria ter o conteúdo ORIGINAL restaurado (não o de D1 sobrescrito na 1ª escrita)",
      );
      assert.equal(readFileSync(join(dir, "04-d3-1x1.jpg"), "utf8"), "CONTENT_D3");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Mesma classe, ciclo de 3 (rotação, não swap) — exercita o caso em que
  // DUAS escritas finais têm sucesso antes de uma terceira falhar.
  it("renameDestaqueImages: rotação de 3 (newOrder=[3,1,2]), 2 escritas finais OK e a 3ª falha → D1/D2/D3 todos restaurados intactos", () => {
    const dir = mkdtempSync(join(tmpdir(), "reorder-img-3cycle-rollback-"));
    try {
      writeFileSync(join(dir, "04-d1-1x1.jpg"), "CONTENT_D1");
      writeFileSync(join(dir, "04-d2-1x1.jpg"), "CONTENT_D2");
      writeFileSync(join(dir, "04-d3-1x1.jpg"), "CONTENT_D3");

      // newOrder=[3,1,2]: oldToNew = {3→1, 1→2, 2→3}. Escritas finais em
      // ordem: dest=04-d2 (era D1, OK), dest=04-d3 (era D2, OK), dest=04-d1
      // (era D3, falha).
      let failureInjected = false;
      const finalD1Path = join(dir, "04-d1-1x1.jpg");
      const fakeDeps: RenameFileDeps = {
        renameSync: renameFsSync,
        existsSync,
        readFileSync,
        copyFileSync: ((from: unknown, to: unknown, ...rest: unknown[]) => {
          if (!failureInjected && String(to) === finalD1Path) {
            failureInjected = true;
            throw new Error("simulated failure writing final 04-d1-1x1.jpg");
          }
          (copyFileFsSync as any)(from, to, ...rest);
        }) as typeof copyFileFsSync,
      };

      assert.throws(
        () => renameDestaqueImages(dir, [3, 1, 2], false, fakeDeps),
        /simulated failure writing final 04-d1-1x1\.jpg/,
      );

      assert.deepEqual(
        readdirSync(dir).sort(),
        ["04-d1-1x1.jpg", "04-d2-1x1.jpg", "04-d3-1x1.jpg"],
      );
      assert.equal(readFileSync(join(dir, "04-d1-1x1.jpg"), "utf8"), "CONTENT_D1");
      assert.equal(readFileSync(join(dir, "04-d2-1x1.jpg"), "utf8"), "CONTENT_D2");
      assert.equal(readFileSync(join(dir, "04-d3-1x1.jpg"), "utf8"), "CONTENT_D3");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Mesmo cenário, no OUTRO call site que compartilha `stageAndWriteVerified`.
  it("renameDestaquePrompts: swap D1↔D2, escrita final do 2º arquivo falha → D1 e D2 restaurados intactos", () => {
    const dir = mkdtempSync(join(tmpdir(), "reorder-prompts-cyclic-rollback-"));
    try {
      writeFileSync(join(dir, "02-d1-prompt.md"), "CONTENT_D1");
      writeFileSync(join(dir, "02-d2-prompt.md"), "CONTENT_D2");

      let failureInjected = false;
      const finalD1Path = join(dir, "02-d1-prompt.md");
      const fakeDeps: RenameFileDeps = {
        renameSync: renameFsSync,
        existsSync,
        readFileSync,
        copyFileSync: ((from: unknown, to: unknown, ...rest: unknown[]) => {
          if (!failureInjected && String(to) === finalD1Path) {
            failureInjected = true;
            throw new Error("simulated failure writing final 02-d1-prompt.md");
          }
          (copyFileFsSync as any)(from, to, ...rest);
        }) as typeof copyFileFsSync,
      };

      assert.throws(
        () => renameDestaquePrompts(dir, [2, 1, 3], false, fakeDeps),
        /simulated failure writing final 02-d1-prompt\.md/,
      );

      assert.deepEqual(readdirSync(dir).sort(), ["02-d1-prompt.md", "02-d2-prompt.md"]);
      assert.equal(readFileSync(join(dir, "02-d1-prompt.md"), "utf8"), "CONTENT_D1");
      assert.equal(readFileSync(join(dir, "02-d2-prompt.md"), "utf8"), "CONTENT_D2");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("renameDestaqueImages (#5581 — conjunto de imagens assimétrico entre destaques não deixa órfão)", () => {
  // Reprodução exata do corpo da issue: D1 tem 4x5-nativo (imagem gerada
  // nativamente), D2 e D3 não. Antes do fix, `stageAndWriteVerified` usava
  // `copyFileSync` (copy, nunca remove o original) sem nenhum passo de
  // deleção — `04-d1-4x5-nativo.jpg` sobrevivia intocado com o conteúdo do
  // D1 PRÉ-reorder, ao lado do novo `04-d2-4x5-nativo.jpg` correto.
  it("swap D1<->D2 com 4x5-nativo só em D1: órfão 04-d1-4x5-nativo.jpg é removido, sem perda de conteúdo válido", () => {
    const dir = mkdtempSync(join(tmpdir(), "reorder-img-assimetrico-"));
    try {
      writeFileSync(join(dir, "04-d1-1x1.jpg"), "D1_1x1");
      writeFileSync(join(dir, "04-d1-4x5-nativo.jpg"), "D1_4x5_NATIVO");
      writeFileSync(join(dir, "04-d2-1x1.jpg"), "D2_1x1");
      writeFileSync(join(dir, "04-d3-1x1.jpg"), "D3_1x1");

      renameDestaqueImages(dir, [2, 1, 3], false);

      // O órfão não pode sobreviver: 04-d1-4x5-nativo.jpg (nome antigo do
      // D1) só deve existir se ainda for o finalName de alguma entrada do
      // lote — não é o caso aqui (D2 não tinha 4x5-nativo, então nada
      // reescreve esse path de volta).
      assert.deepEqual(
        readdirSync(dir).sort(),
        ["04-d1-1x1.jpg", "04-d2-1x1.jpg", "04-d2-4x5-nativo.jpg", "04-d3-1x1.jpg"],
        "04-d1-4x5-nativo.jpg (órfão) não deveria sobreviver ao reorder",
      );

      // Conteúdo correto: D1 (slot novo) tem os bytes do antigo D2; o novo
      // 04-d2-4x5-nativo.jpg tem os bytes do 4x5-nativo original do D1
      // (migrou pro slot D2 junto com o resto do destaque).
      assert.equal(readFileSync(join(dir, "04-d1-1x1.jpg"), "utf8"), "D2_1x1");
      assert.equal(readFileSync(join(dir, "04-d2-1x1.jpg"), "utf8"), "D1_1x1");
      assert.equal(
        readFileSync(join(dir, "04-d2-4x5-nativo.jpg"), "utf8"),
        "D1_4x5_NATIVO",
      );
      assert.equal(readFileSync(join(dir, "04-d3-1x1.jpg"), "utf8"), "D3_1x1");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rotação de 3 com 4x5-nativo só em D1: nenhum arquivo órfão sobrevive, ciclo fechado preserva todo conteúdo", () => {
    const dir = mkdtempSync(join(tmpdir(), "reorder-img-assimetrico-3cycle-"));
    try {
      writeFileSync(join(dir, "04-d1-1x1.jpg"), "D1_1x1");
      writeFileSync(join(dir, "04-d1-4x5-nativo.jpg"), "D1_4x5_NATIVO");
      writeFileSync(join(dir, "04-d2-1x1.jpg"), "D2_1x1");
      writeFileSync(join(dir, "04-d3-1x1.jpg"), "D3_1x1");

      // newOrder=[3,1,2]: oldToNew = {3→1, 1→2, 2→3}. D1 (com nativo) vira
      // D2; D2 vira D3; D3 vira D1. Nenhum destino recebe 4x5-nativo além
      // do novo D2 — o antigo 04-d1-4x5-nativo.jpg vira 04-d2-4x5-nativo.jpg
      // e não deve sobrar cópia órfã sob o nome antigo.
      renameDestaqueImages(dir, [3, 1, 2], false);

      assert.deepEqual(
        readdirSync(dir).sort(),
        ["04-d1-1x1.jpg", "04-d2-1x1.jpg", "04-d2-4x5-nativo.jpg", "04-d3-1x1.jpg"],
        "04-d1-4x5-nativo.jpg (órfão) não deveria sobreviver à rotação",
      );
      assert.equal(readFileSync(join(dir, "04-d1-1x1.jpg"), "utf8"), "D3_1x1");
      assert.equal(readFileSync(join(dir, "04-d2-1x1.jpg"), "utf8"), "D1_1x1");
      assert.equal(
        readFileSync(join(dir, "04-d2-4x5-nativo.jpg"), "utf8"),
        "D1_4x5_NATIVO",
      );
      assert.equal(readFileSync(join(dir, "04-d3-1x1.jpg"), "utf8"), "D2_1x1");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("renameDestaqueImages (#5564 — regressão central: 'reversão pós-hoc' detectada mesmo com escrita individual OK)", () => {
  // Reproduz a causa raiz reportada na issue: `renameSyncVerified` (#5085)
  // já checava `existsSync` logo após CADA rename — mas isso não pegava o
  // caso real: o provedor de sync (OneDrive) reportava a escrita como
  // bem-sucedida (existsSync passa), e só DEPOIS — enquanto os OUTROS
  // arquivos da sequência ainda estavam sendo escritos — revertia o
  // arquivo de volta pro conteúdo de ANTES do reorder. Um mock de
  // filesystem não consegue reproduzir a corrida real do OneDrive, mas
  // reproduz a CLASSE do bug: um `readFileSync` que reporta o conteúdo
  // ORIGINAL (não o recém-escrito) quando consultado DEPOIS que todas as
  // escritas finais já terminaram — exatamente o padrão "confirmei o
  // conteúdo correto momentos antes, e ele reverteu depois" da issue.
  it("verificação final (passo 3 de stageAndWriteVerified) detecta o arquivo revertido e aborta em vez de reportar sucesso", () => {
    const dir = mkdtempSync(join(tmpdir(), "reorder-img-posthoc-"));
    try {
      writeFileSync(join(dir, "04-d1-1x1.jpg"), "CONTENT_D1");
      writeFileSync(join(dir, "04-d2-1x1.jpg"), "CONTENT_D2");
      writeFileSync(join(dir, "04-d3-1x1.jpg"), "CONTENT_D3");

      // Conteúdo ORIGINAL de cada path afetado pelo swap — é pra isso que
      // o provedor de sync "reverte" quando descarta a versão perdedora.
      const originalAtPath = new Map<string, Buffer>([
        [join(dir, "04-d1-1x1.jpg"), Buffer.from("CONTENT_D1")],
        [join(dir, "04-d2-1x1.jpg"), Buffer.from("CONTENT_D2")],
      ]);

      let writesToSyncedDir = 0;
      const TOTAL_FINAL_WRITES = 2; // swap D1<->D2 => 2 arquivos mudam de nome

      const fakeDeps: RenameFileDeps = {
        renameSync: renameFsSync,
        existsSync,
        copyFileSync: ((from: unknown, to: unknown, ...rest: unknown[]) => {
          (copyFileFsSync as any)(from, to, ...rest);
          if (String(to).startsWith(dir + sep)) writesToSyncedDir++;
        }) as typeof copyFileFsSync,
        readFileSync: ((p: unknown, ...rest: unknown[]) => {
          const s = String(p);
          // Só "revela" a reversão DEPOIS que TODAS as escritas finais já
          // terminaram — reproduz "revertido um instante depois", não
          // "nunca escreveu" (esse segundo caso já é coberto pelo guard
          // do passo 2 no describe "guard pós-escrita" acima).
          if (
            s.startsWith(dir + sep) &&
            writesToSyncedDir >= TOTAL_FINAL_WRITES &&
            originalAtPath.has(s)
          ) {
            return originalAtPath.get(s)!;
          }
          return (readFileSync as any)(p, ...rest);
        }) as typeof readFileSync,
      };

      assert.throws(
        () => renameDestaqueImages(dir, [2, 1, 3], false, fakeDeps),
        /reversão pós-hoc/,
        "deveria abortar com erro claro citando a reversão pós-hoc (#5564), não reportar sucesso silenciosamente",
      );

      // Rollback (que usa copyFileSync real, não interceptado por
      // originalAtPath) ainda restaura o conteúdo original de fato no
      // disco — confirmado via readFileSync REAL (fora do fakeDeps).
      assert.equal(readFileSync(join(dir, "04-d1-1x1.jpg"), "utf8"), "CONTENT_D1");
      assert.equal(readFileSync(join(dir, "04-d2-1x1.jpg"), "utf8"), "CONTENT_D2");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("parseArgs — default editionDir via #3491 (mesma classe de #3483/#3484)", () => {
  // Antes do #3491, sem --edition-dir (comando editor-invocado diretamente,
  // sem caller fixo que sempre passe a flag), o default construía
  // `data/editions/{AAMMDD}` à mão (layout FLAT). Numa edição já migrada pro
  // layout nested (`{AAMM}/{AAMMDD}`, #2463/#3024), isso apontava pra um dir
  // que não existe.
  it("resolve edição no layout NESTED via --editions-dir", () => {
    const dir = mkdtempSync(join(tmpdir(), "reorder-dest-nested-"));
    try {
      const nestedEditionDir = join(dir, "2605", "260517");
      mkdirSync(nestedEditionDir, { recursive: true });
      const args = parseArgs([
        "--edition", "260517",
        "--new-order", "2,1,3",
        "--editions-dir", dir,
      ]);
      assert.equal(args.editionDir, nestedEditionDir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("resolve edição no layout FLAT legado via --editions-dir (compat)", () => {
    const dir = mkdtempSync(join(tmpdir(), "reorder-dest-flat-"));
    try {
      const flatEditionDir = join(dir, "260421");
      mkdirSync(flatEditionDir, { recursive: true });
      const args = parseArgs([
        "--edition", "260421",
        "--new-order", "2,1,3",
        "--editions-dir", dir,
      ]);
      assert.equal(args.editionDir, flatEditionDir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("--edition-dir explícito continua tendo precedência sobre --editions-dir", () => {
    const dir = mkdtempSync(join(tmpdir(), "reorder-dest-precedence-"));
    try {
      const nestedEditionDir = join(dir, "2605", "260517");
      mkdirSync(nestedEditionDir, { recursive: true });
      const args = parseArgs([
        "--edition", "260517",
        "--new-order", "2,1,3",
        "--editions-dir", dir,
        "--edition-dir", "/custom/override",
      ]);
      assert.equal(args.editionDir, "/custom/override");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("deriveTituloSubtitulo (#3980 — helper puro)", () => {
  it("deriva TÍTULO/SUBTÍTULO a partir dos D1/D2/D3 já reordenados no md", () => {
    const md = `**DESTAQUE 1 | 🚀 LANÇAMENTO**

**[Título Novo D1](https://x.com)**

Corpo D1.

---

**DESTAQUE 2 | 💼 MERCADO**

**[Título Novo D2](https://y.com)**

Corpo D2.

---

**DESTAQUE 3 | 🇧🇷 BRASIL**

**[Título Novo D3](https://z.com)**

Corpo D3.
`;
    const result = deriveTituloSubtitulo(md);
    assert.ok(result, "deveria derivar com sucesso (DESTAQUE 1 reconhecível)");
    assert.equal(result!.action, "inserted");
    assert.match(result!.md, /^TÍTULO\n\nTítulo Novo D1\n\nSUBTÍTULO\n\nTítulo Novo D2 \| Título Novo D3/);
  });

  it("retorna null quando não há DESTAQUE 1 reconhecível", () => {
    const md = "Corpo qualquer sem blocos DESTAQUE.";
    assert.equal(deriveTituloSubtitulo(md), null);
  });
});

// ─── Testes de integração via CLI (subprocess) — #3980 e #3982 ───────────
//
// Rodam o script de ponta a ponta (mesmo padrão de test/sync-intro-count.test.ts)
// porque o bug original em ambas as issues era de FIAÇÃO em main() (a função
// pura existia/foi criada, mas main() não a chamava) — um teste só das funções
// puras não pegaria uma regressão onde alguém remove a chamada em main().

function runReorderCli(args: string[]): {
  status: number | null;
  stdout: string;
  stderr: string;
} {
  const projectRoot = join(import.meta.dirname, "..");
  const scriptPath = join(projectRoot, "scripts", "reorder-destaques.ts");
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", scriptPath, ...args],
    { cwd: projectRoot, encoding: "utf8" },
  );
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function makeEditionDirFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "reorder-cli-"));
  const internalDir = join(dir, "_internal");
  mkdirSync(internalDir, { recursive: true });
  // readDestaqueCount lê isso pra validar --new-order de 3 posições.
  writeFileSync(
    join(internalDir, "01-approved-capped.json"),
    JSON.stringify({ highlights: [{}, {}, {}] }, null, 2),
    "utf8",
  );
  return dir;
}

function buildReviewedMdFixture(opts: {
  d1Title: string;
  d1Body: string;
  d2Title: string;
  d2Body: string;
  d3Title: string;
  d3Body: string;
}): string {
  return `Intro qualquer da edição...

---

**DESTAQUE 1 | 🚀 LANÇAMENTO**

**[${opts.d1Title}](https://x.com)**

${opts.d1Body}

---

**DESTAQUE 2 | 💼 MERCADO**

**[${opts.d2Title}](https://y.com)**

${opts.d2Body}

---

**DESTAQUE 3 | 🇧🇷 BRASIL**

**[${opts.d3Title}](https://z.com)**

${opts.d3Body}

---

**📰 OUTRAS NOTÍCIAS**

[N1](https://n.com)
`;
}

describe("reorder-destaques CLI (#3980): TÍTULO/SUBTÍTULO pós-reorder", () => {
  it("swap D1<->D2 atualiza TÍTULO/SUBTÍTULO pros títulos NOVOS (não deixa stale)", () => {
    const dir = makeEditionDirFixture();
    try {
      const md = buildReviewedMdFixture({
        d1Title: "Título Original Um",
        d1Body: "A".repeat(300),
        d2Title: "Título Original Dois",
        d2Body: "A".repeat(300),
        d3Title: "Título Original Três",
        d3Body: "A".repeat(300),
      });
      writeFileSync(join(dir, "02-reviewed.md"), md, "utf8");

      const result = runReorderCli([
        "--edition", "999999",
        "--edition-dir", dir,
        "--new-order", "2,1,3",
      ]);
      assert.equal(result.status, 0, `CLI deveria sair 0. stderr: ${result.stderr}`);

      const updated = readFileSync(join(dir, "02-reviewed.md"), "utf8");
      assert.match(updated, /^TÍTULO/);

      const tituloIdx = updated.indexOf("TÍTULO");
      const subtituloIdx = updated.indexOf("SUBTÍTULO");
      assert.ok(tituloIdx >= 0 && subtituloIdx > tituloIdx);

      const tituloBlock = updated.slice(tituloIdx, subtituloIdx);
      assert.match(
        tituloBlock,
        /Título Original Dois/,
        "TÍTULO deveria conter o título do NOVO D1 (era D2 antes do reorder)",
      );
      assert.ok(
        !tituloBlock.includes("Título Original Um"),
        "TÍTULO NÃO deveria conter o título ANTIGO do D1 pós-reorder (bug #3980)",
      );

      const subtituloBlock = updated.slice(subtituloIdx);
      assert.match(subtituloBlock, /Título Original Um/);
      assert.match(subtituloBlock, /Título Original Três/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reorder idempotente: rodar 2× em sequência não duplica o bloco TÍTULO/SUBTÍTULO", () => {
    const dir = makeEditionDirFixture();
    try {
      const md = buildReviewedMdFixture({
        d1Title: "Título A",
        d1Body: "A".repeat(300),
        d2Title: "Título B",
        d2Body: "A".repeat(300),
        d3Title: "Título C",
        d3Body: "A".repeat(300),
      });
      writeFileSync(join(dir, "02-reviewed.md"), md, "utf8");

      runReorderCli(["--edition", "999999", "--edition-dir", dir, "--new-order", "2,1,3"]);
      const afterFirst = readFileSync(join(dir, "02-reviewed.md"), "utf8");

      // Reorder de volta (inverso do swap 2,1,3 é o próprio 2,1,3 — 2-cycle).
      runReorderCli(["--edition", "999999", "--edition-dir", dir, "--new-order", "2,1,3"]);
      const afterSecond = readFileSync(join(dir, "02-reviewed.md"), "utf8");

      // Header standalone (linha exata "TÍTULO") — não confundir com a
      // substring "TÍTULO" dentro de "SUBTÍTULO" logo abaixo no mesmo bloco.
      const countHeaderLines = (haystack: string) =>
        (haystack.match(/^TÍTULO$/gm) ?? []).length;
      assert.equal(countHeaderLines(afterFirst), 1);
      assert.equal(countHeaderLines(afterSecond), 1);
      // Volta ao estado original (D1=A, D2=B) pois 2,1,3 é involução.
      assert.match(afterSecond, /^TÍTULO\n\nTítulo A/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("reorder-destaques CLI (#3982): validação destaque-max-chars pós-reorder", () => {
  it("move D1 (limite 1200) pra D2 (limite 1000) com corpo excedente → WARN, sem hard-fail", () => {
    const dir = makeEditionDirFixture();
    try {
      const md = buildReviewedMdFixture({
        d1Title: "D1 grande",
        d1Body: "A".repeat(1100), // cabia em D1 (≤1200) mas excede o novo teto de D2 (1000)
        d2Title: "D2 pequeno",
        d2Body: "A".repeat(600),
        d3Title: "D3 pequeno",
        d3Body: "A".repeat(600),
      });
      writeFileSync(join(dir, "02-reviewed.md"), md, "utf8");

      const result = runReorderCli([
        "--edition", "999999",
        "--edition-dir", dir,
        "--new-order", "2,1,3",
      ]);
      // WARN, nunca hard-fail — exit code continua 0.
      assert.equal(result.status, 0, `CLI não deveria falhar por max-chars. stderr: ${result.stderr}`);
      assert.match(result.stderr, /destaque-max-chars pós-reorder/);
      assert.match(result.stderr, /D2/);

      const parsed = JSON.parse(result.stdout);
      assert.equal(parsed.max_chars_warnings.length, 1);
      assert.match(parsed.max_chars_warnings[0], /D2/);
      assert.match(parsed.max_chars_warnings[0], /1100 chars/);
      assert.match(parsed.max_chars_warnings[0], /máximo de 1000/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("move D1 pra D2 dentro do limite novo → SEM warning", () => {
    const dir = makeEditionDirFixture();
    try {
      const md = buildReviewedMdFixture({
        d1Title: "D1 ok",
        d1Body: "A".repeat(900), // dentro do teto de D2 (1000) após mover
        d2Title: "D2 pequeno",
        d2Body: "A".repeat(600),
        d3Title: "D3 pequeno",
        d3Body: "A".repeat(600),
      });
      writeFileSync(join(dir, "02-reviewed.md"), md, "utf8");

      const result = runReorderCli([
        "--edition", "999999",
        "--edition-dir", dir,
        "--new-order", "2,1,3",
      ]);
      assert.equal(result.status, 0);
      assert.doesNotMatch(result.stderr, /destaque-max-chars/);

      const parsed = JSON.parse(result.stdout);
      assert.equal(parsed.max_chars_warnings.length, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("reorder-destaques CLI (#5087): imagens renomeadas ANTES do texto — abort de imagem não deixa texto mutado", () => {
  it("falha no rename de imagem (EISDIR real) aborta ANTES de escrever 02-reviewed.md/03-social.md/JSONs", () => {
    const dir = makeEditionDirFixture();
    const internalDir = join(dir, "_internal");
    try {
      const originalMd = buildReviewedMdFixture({
        d1Title: "Título Original D1",
        d1Body: "corpo d1",
        d2Title: "Título Original D2",
        d2Body: "corpo d2",
        d3Title: "Título Original D3",
        d3Body: "corpo d3",
      });
      writeFileSync(join(dir, "02-reviewed.md"), originalMd, "utf8");

      const originalSocial = "## d1\npost d1\n\n## d2\npost d2\n\n## d3\npost d3\n";
      writeFileSync(join(dir, "03-social.md"), originalSocial, "utf8");

      const originalApprovedCapped = readFileSync(
        join(internalDir, "01-approved-capped.json"),
        "utf8",
      );

      // Imagens reais no edition dir. #5564: a nova implementação copia o
      // conteúdo ORIGINAL de cada arquivo afetado pro staging ANTES de
      // qualquer escrita — 04-d2-1x1.jpg (fonte da entrada D2→D1) é um
      // DIRETÓRIO de propósito, então essa cópia falha com um EISDIR REAL
      // de filesystem, sem precisar de dependency injection (a CLI usa os
      // deps reais de produção). O abort acontece antes de QUALQUER
      // escrita — nem staging completo, nem texto.
      writeFileSync(join(dir, "04-d1-1x1.jpg"), "img1");
      mkdirSync(join(dir, "04-d2-1x1.jpg"));
      writeFileSync(join(dir, "04-d3-1x1.jpg"), "img3");

      const result = runReorderCli([
        "--edition", "999999",
        "--edition-dir", dir,
        "--new-order", "2,1,3",
      ]);

      assert.notEqual(result.status, 0, "CLI deveria sair com erro (EISDIR propagado)");
      assert.match(result.stderr, /EISDIR|illegal operation on a directory/);

      // #5087: o abort de imagem aconteceu ANTES de qualquer escrita de
      // texto — 02-reviewed.md, 03-social.md e os JSONs canônicos devem
      // continuar exatamente como estavam (nunca reordenados), evitando o
      // estado misto "texto já reordenado, imagem só parcialmente".
      assert.equal(
        readFileSync(join(dir, "02-reviewed.md"), "utf8"),
        originalMd,
        "02-reviewed.md não deveria ter sido tocado — imagem falhou primeiro",
      );
      assert.equal(
        readFileSync(join(dir, "03-social.md"), "utf8"),
        originalSocial,
        "03-social.md não deveria ter sido tocado — imagem falhou primeiro",
      );
      assert.equal(
        readFileSync(join(internalDir, "01-approved-capped.json"), "utf8"),
        originalApprovedCapped,
        "01-approved-capped.json não deveria ter sido tocado — imagem falhou primeiro",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ─── #6062: .social-source-hash.json pós-reorder ─────────────────────────
//
// Bug original: o reorder propagava a nova ordem pro 03-social.md mas deixava
// o carimbo de `_internal/.social-source-hash.json` (#1413) apontando pros
// highlights ANTIGOS — `check-invariants.ts --stage 4` acusava
// `social-hash-fresh` como ERROR com o social JÁ correto (edição 260825).
// Testes via CLI porque a regressão possível é de FIAÇÃO em main(): a função
// pura pode existir e ninguém chamá-la.

function writeApprovedFixture(dir: string, urls: string[]): string {
  const approvedPath = join(dir, "_internal", "01-approved.json");
  writeFileSync(
    approvedPath,
    JSON.stringify(
      {
        highlights: urls.map((url, i) => ({
          url,
          title_options: [`Título ${i + 1}`, "Alt", "Alt2"],
        })),
      },
      null,
      2,
    ),
    "utf8",
  );
  return approvedPath;
}

const SOCIAL_MD_FIXTURE = `# Social

## d1

Post D1...

## d2

Post D2...

## d3

Post D3...
`;

describe("reorder-destaques CLI (#6062): .social-source-hash.json", () => {
  it("recarimba o hash com os highlights JÁ reordenados (era ERROR falso em social-hash-fresh)", () => {
    const dir = makeEditionDirFixture();
    try {
      const approvedPath = writeApprovedFixture(dir, [
        "https://a.com/1",
        "https://b.com/2",
        "https://c.com/3",
      ]);
      const hashPath = join(dir, "_internal", ".social-source-hash.json");
      const staleHash = hashFromApprovedFile(approvedPath);
      writeFileSync(
        hashPath,
        JSON.stringify({ hash: staleHash, generated_at: "2026-08-25T00:00:00.000Z" }, null, 2),
        "utf8",
      );
      writeFileSync(join(dir, "03-social.md"), SOCIAL_MD_FIXTURE, "utf8");

      const result = runReorderCli([
        "--edition", "999999",
        "--edition-dir", dir,
        "--new-order", "3,2,1",
      ]);
      assert.equal(result.status, 0, `CLI deveria sair 0. stderr: ${result.stderr}`);

      // O hash gravado tem que bater com o que o invariante de Stage 4
      // recomputa do approved JÁ reordenado — senão o gate acusa stale.
      const esperado = hashFromApprovedFile(approvedPath);
      const gravado = JSON.parse(readFileSync(hashPath, "utf8")) as { hash: string };
      assert.equal(gravado.hash, esperado);
      assert.notEqual(
        gravado.hash,
        staleHash,
        "o hash pré-reorder não pode sobreviver — era exatamente o falso positivo do #6062",
      );

      // E o arquivo precisa aparecer no relatório de modificados.
      const report = JSON.parse(result.stdout) as { modified: { rewritten: string[] } };
      assert.ok(
        report.modified.rewritten.some((f) => f.endsWith(".social-source-hash.json")),
        `hash deveria constar em modified.rewritten: ${result.stdout}`,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("NÃO recarimba quando não há 03-social.md — não inventa frescor pra social inexistente", () => {
    const dir = makeEditionDirFixture();
    try {
      writeApprovedFixture(dir, ["https://a.com/1", "https://b.com/2", "https://c.com/3"]);
      const hashPath = join(dir, "_internal", ".social-source-hash.json");

      const result = runReorderCli([
        "--edition", "999999",
        "--edition-dir", dir,
        "--new-order", "3,2,1",
      ]);
      assert.equal(result.status, 0, `CLI deveria sair 0. stderr: ${result.stderr}`);
      assert.equal(
        existsSync(hashPath),
        false,
        "sem 03-social.md não existe social pra declarar fresco",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("--dry-run não escreve o hash", () => {
    const dir = makeEditionDirFixture();
    try {
      writeApprovedFixture(dir, ["https://a.com/1", "https://b.com/2", "https://c.com/3"]);
      writeFileSync(join(dir, "03-social.md"), SOCIAL_MD_FIXTURE, "utf8");
      const hashPath = join(dir, "_internal", ".social-source-hash.json");

      const result = runReorderCli([
        "--edition", "999999",
        "--edition-dir", dir,
        "--new-order", "3,2,1",
        "--dry-run",
      ]);
      assert.equal(result.status, 0, `CLI deveria sair 0. stderr: ${result.stderr}`);
      assert.equal(existsSync(hashPath), false, "--dry-run não pode tocar o disco");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("refreshSocialSourceHash (#6062, unidade)", () => {
  it("approved ausente → null, sem lançar (best-effort, não derruba o reorder)", () => {
    const dir = mkdtempSync(join(tmpdir(), "reorder-hash-"));
    try {
      mkdirSync(join(dir, "_internal"), { recursive: true });
      assert.equal(refreshSocialSourceHash(dir, false), null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("approved ilegível → warning + null, nunca exceção", () => {
    const dir = mkdtempSync(join(tmpdir(), "reorder-hash-bad-"));
    try {
      mkdirSync(join(dir, "_internal"), { recursive: true });
      writeFileSync(join(dir, "_internal", "01-approved.json"), "{ nao json", "utf8");
      assert.equal(refreshSocialSourceHash(dir, false), null);
      assert.equal(existsSync(join(dir, "_internal", ".social-source-hash.json")), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ─── #6068: carimbo do carrossel acompanha o reorder ─────────────────────
//
// `renameDestaqueImages` já renomeia `04-d{N}-carousel-{slot}-4x5.jpg` (o
// regex de sufixo com hífen do #5085 pega esses nomes sem código dedicado),
// mas o carimbo `_internal/.carousel-source-hash.json` indexa por destaque —
// sem reindexar, um swap deixa a entrada `d1` com o hash do texto do ex-D1
// enquanto o arquivo `d1` já é a arte do ex-D2, e `carousel-cards-stale`
// acusa ERROR falso nos dois destaques trocados.

function writeCarouselStamp(dir: string, hashes: Record<string, string>): string {
  const path = join(dir, "_internal", ".carousel-source-hash.json");
  writeFileSync(path, JSON.stringify({ hashes, generated_at: "2026-08-24T00:00:00.000Z" }, null, 2), "utf8");
  return path;
}

function readCarouselStamp(dir: string): Record<string, string> {
  const raw = readFileSync(join(dir, "_internal", ".carousel-source-hash.json"), "utf8");
  return (JSON.parse(raw) as { hashes: Record<string, string> }).hashes;
}

describe("reorder-destaques CLI (#6068): .carousel-source-hash.json", () => {
  it("swap D1↔D2 reindexa as entradas do carimbo junto com o rename dos slides", () => {
    const dir = makeEditionDirFixture();
    try {
      writeCarouselStamp(dir, { d1: "hashD1", d2: "hashD2", d3: "hashD3" });

      const result = runReorderCli([
        "--edition", "999999",
        "--edition-dir", dir,
        "--new-order", "2,1,3",
      ]);
      assert.equal(result.status, 0, `CLI deveria sair 0. stderr: ${result.stderr}`);

      const hashes = readCarouselStamp(dir);
      assert.equal(hashes.d1, "hashD2", "a posição 1 agora tem a arte/texto do ex-D2");
      assert.equal(hashes.d2, "hashD1");
      assert.equal(hashes.d3, "hashD3", "d3 não se moveu");

      const report = JSON.parse(result.stdout) as { modified: { rewritten: string[] } };
      assert.ok(
        report.modified.rewritten.some((f) => f.endsWith(".carousel-source-hash.json")),
        `carimbo deveria constar em modified.rewritten: ${result.stdout}`,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("--dry-run não reescreve o carimbo", () => {
    const dir = makeEditionDirFixture();
    try {
      writeCarouselStamp(dir, { d1: "hashD1", d2: "hashD2", d3: "hashD3" });
      const result = runReorderCli([
        "--edition", "999999",
        "--edition-dir", dir,
        "--new-order", "2,1,3",
        "--dry-run",
      ]);
      assert.equal(result.status, 0, `stderr: ${result.stderr}`);
      assert.deepEqual(readCarouselStamp(dir), { d1: "hashD1", d2: "hashD2", d3: "hashD3" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("edição sem carrossel (carimbo ausente) é no-op — não cria o arquivo", () => {
    const dir = makeEditionDirFixture();
    try {
      const result = runReorderCli([
        "--edition", "999999",
        "--edition-dir", dir,
        "--new-order", "2,1,3",
      ]);
      assert.equal(result.status, 0, `stderr: ${result.stderr}`);
      assert.equal(existsSync(join(dir, "_internal", ".carousel-source-hash.json")), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("reindexCarouselSourceHashes (#6068, unidade)", () => {
  it("carimbo ausente → null (nada a reindexar)", () => {
    const dir = mkdtempSync(join(tmpdir(), "reorder-carousel-"));
    try {
      mkdirSync(join(dir, "_internal"), { recursive: true });
      assert.equal(reindexCarouselSourceHashes(dir, [2, 1, 3], false), null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("entrada faltando na posição de origem não deixa hash velho na posição nova", () => {
    const dir = mkdtempSync(join(tmpdir(), "reorder-carousel-parcial-"));
    try {
      mkdirSync(join(dir, "_internal"), { recursive: true });
      writeCarouselStamp(dir, { d1: "hashD1", d3: "hashD3" }); // d2 nunca carimbado
      const out = reindexCarouselSourceHashes(dir, [2, 1, 3], false);
      assert.ok(out);
      assert.equal(out!.hashes.d1, undefined, "origem (d2) não tinha hash — d1 não pode herdar o antigo");
      assert.equal(out!.hashes.d2, "hashD1");
      assert.equal(out!.hashes.d3, "hashD3");

      // O que importa é o DISCO: a escrita mesclava com o arquivo antigo e
      // ressuscitava a entrada recém-deletada (#6068).
      const emDisco = readCarouselStamp(dir);
      assert.equal(emDisco.d1, undefined, "o delete precisa chegar ao arquivo, não só ao objeto em memória");
      assert.equal(emDisco.d2, "hashD1");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("refreshSocialSourceHash — gate do 03-social.md (#6062/#6068)", () => {
  it("social SEM seções `## d{N}` não recarimba: o arquivo continua na ordem velha", () => {
    const dir = makeEditionDirFixture();
    try {
      writeFileSync(
        join(dir, "_internal", "01-approved.json"),
        JSON.stringify({ highlights: [{ url: "https://a" }, { url: "https://b" }, { url: "https://c" }] }),
        "utf8",
      );
      const hashPath = join(dir, "_internal", ".social-source-hash.json");
      writeFileSync(hashPath, JSON.stringify({ hash: "carimboVelho", generated_at: "2026-08-24T00:00:00.000Z" }), "utf8");
      // existe, mas sem nenhum `## d{N}` — reorderSocialMd devolve igual
      writeFileSync(join(dir, "03-social.md"), "# Social\n\ntexto sem secoes de destaque\n", "utf8");

      const result = runReorderCli([
        "--edition", "999999",
        "--edition-dir", dir,
        "--new-order", "3,2,1",
      ]);
      assert.equal(result.status, 0, `stderr: ${result.stderr}`);

      const gravado = JSON.parse(readFileSync(hashPath, "utf8")) as { hash: string };
      assert.equal(
        gravado.hash,
        "carimboVelho",
        "recarimbar aqui diria 'fresco' pra um social que continua na ordem antiga — o falso NEGATIVO que o gate evita",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("reindexCarouselSourceHashes — entradas órfãs (#6068)", () => {
  it("edição de 2 destaques purga o d3 sobrevivente de uma demoção 3→2", () => {
    const dir = mkdtempSync(join(tmpdir(), "reorder-carousel-orfa-"));
    try {
      mkdirSync(join(dir, "_internal"), { recursive: true });
      writeCarouselStamp(dir, { d1: "hashD1", d2: "hashD2", d3: "hashD3-orfao" });

      const out = reindexCarouselSourceHashes(dir, [2, 1], false);
      assert.ok(out);
      assert.equal(out!.hashes.d3, undefined, "d3 não existe mais nesta edição");

      const emDisco = readCarouselStamp(dir);
      assert.equal(emDisco.d3, undefined, "a purga precisa chegar ao arquivo");
      assert.equal(emDisco.d1, "hashD2");
      assert.equal(emDisco.d2, "hashD1");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
