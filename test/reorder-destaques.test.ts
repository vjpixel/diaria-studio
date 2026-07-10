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
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  reorderHighlightsInJson,
  reorderDestaquesInMd,
  updateIntentionalErrorLocationJson,
  reorderSocialMd,
  renameDestaqueImages,
  renameDestaquePrompts,
} from "../scripts/reorder-destaques.ts";
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
