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
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import {
  reorderHighlightsInJson,
  reorderDestaquesInMd,
  updateIntentionalErrorLocationJson,
  reorderSocialMd,
  renameDestaqueImages,
  renameDestaquePrompts,
  renameSyncVerified,
  deriveTituloSubtitulo,
  parseArgs,
  type RenameFileDeps,
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
    };
    assert.throws(
      () => renameSyncVerified("/fake/from.jpg", "/fake/to.jpg", fakeDeps),
      /rename .* retornou sem erro mas o arquivo de destino não existe/,
    );
    assert.equal(calls.length, 1, "renameSync deveria ter sido chamado exatamente 1×");
  });
});

describe("renameDestaqueImages (#5085 — guard pós-rename + 4x5-nativo)", () => {
  it("destino de um rename intermediário sumiu → aborta a sequência inteira (não segue silenciosamente)", () => {
    const dir = mkdtempSync(join(tmpdir(), "reorder-img-vanish-"));
    try {
      writeFileSync(join(dir, "04-d1-1x1.jpg"), "data1");
      writeFileSync(join(dir, "04-d2-1x1.jpg"), "data2");
      writeFileSync(join(dir, "04-d3-1x1.jpg"), "data3");

      // deps reais, exceto existsSync: sempre reporta ausência do arquivo
      // TMP recém-renomeado — simula o OneDrive descartando a versão
      // "perdedora" entre o renameSync e a checagem seguinte.
      const fakeDeps: RenameFileDeps = {
        renameSync: (from, to) => {
          // Executa o rename de verdade (pra poder inspecionar o filesystem
          // no catch abaixo), mas a verificação subsequente vai reportar
          // "sumiu" mesmo assim.
          renameFsSync(from, to);
        },
        existsSync: (p) => !String(p).includes("TMP"),
      };

      assert.throws(
        () => renameDestaqueImages(dir, [2, 1, 3], false, fakeDeps),
        /reorder-destaques: rename .* retornou sem erro mas o arquivo de destino não existe/,
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

describe("renameDestaqueImages / renameDestaquePrompts (#5087 — rollback best-effort de órfãos TMP)", () => {
  it("renameDestaqueImages: abort no meio da sequência reverte o rename já aplicado (sem 04-TMP1-* órfão)", () => {
    const dir = mkdtempSync(join(tmpdir(), "reorder-img-rollback-"));
    try {
      writeFileSync(join(dir, "04-d1-1x1.jpg"), "data1");
      writeFileSync(join(dir, "04-d2-1x1.jpg"), "data2");
      writeFileSync(join(dir, "04-d3-1x1.jpg"), "data3");

      // newOrder [2,1,3]: d1→TMP1 (deve suceder e depois ser revertido),
      // d2→TMP2 (falha aqui, ANTES de tocar o filesystem — simula um erro
      // tipo EPERM/ENOENT do próprio renameSync, não um conflito pós-rename
      // do OneDrive já coberto pelo teste de "guard pós-rename" acima).
      const fakeDeps: RenameFileDeps = {
        renameSync: (from, to) => {
          if (String(to).includes("TMP2")) {
            throw new Error("simulated EPERM on rename to TMP2");
          }
          renameFsSync(from, to);
        },
        existsSync,
      };

      assert.throws(
        () => renameDestaqueImages(dir, [2, 1, 3], false, fakeDeps),
        /simulated EPERM on rename to TMP2/,
      );

      // Rollback: 04-TMP1-* não deve sobrar órfão — deve ter voltado a
      // 04-d1-1x1.jpg com os bytes originais.
      assert.ok(
        !existsSync(join(dir, "04-TMP1-1x1.jpg")),
        "04-TMP1-1x1.jpg não deveria sobrar órfão no disco após o abort",
      );
      assert.ok(
        existsSync(join(dir, "04-d1-1x1.jpg")),
        "04-d1-1x1.jpg deveria ter sido restaurado pelo rollback",
      );
      assert.equal(
        readFileSync(join(dir, "04-d1-1x1.jpg"), "utf8"),
        "data1",
        "bytes originais preservados pelo rollback",
      );
      // d2 nunca chegou a ser tocado pelo fs (a exceção foi lançada antes do
      // renameSync real) — permanece intacto.
      assert.ok(existsSync(join(dir, "04-d2-1x1.jpg")));
      assert.equal(readFileSync(join(dir, "04-d2-1x1.jpg"), "utf8"), "data2");
      assert.ok(existsSync(join(dir, "04-d3-1x1.jpg")));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("renameDestaquePrompts: abort no meio da sequência reverte o rename já aplicado (sem 02-TMP1-* órfão)", () => {
    const dir = mkdtempSync(join(tmpdir(), "reorder-prompts-rollback-"));
    try {
      writeFileSync(join(dir, "02-d1-prompt.md"), "p1");
      writeFileSync(join(dir, "02-d2-prompt.md"), "p2");

      const fakeDeps: RenameFileDeps = {
        renameSync: (from, to) => {
          if (String(to).includes("TMP2")) {
            throw new Error("simulated EPERM on rename to TMP2");
          }
          renameFsSync(from, to);
        },
        existsSync,
      };

      assert.throws(
        () => renameDestaquePrompts(dir, [2, 1, 3], false, fakeDeps),
        /simulated EPERM on rename to TMP2/,
      );

      assert.ok(!existsSync(join(dir, "02-TMP1-prompt.md")));
      assert.ok(existsSync(join(dir, "02-d1-prompt.md")));
      assert.equal(readFileSync(join(dir, "02-d1-prompt.md"), "utf8"), "p1");
      assert.ok(existsSync(join(dir, "02-d2-prompt.md")));
      assert.equal(readFileSync(join(dir, "02-d2-prompt.md"), "utf8"), "p2");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("renameDestaqueImages / renameDestaquePrompts (HOTFIX — rollback não pode sobrescrever uma promoção anterior já bem-sucedida)", () => {
  // Reproduz EXATAMENTE o cenário do achado do review consolidado: swap
  // D1↔D2 ([2,1,3]). TMP1 (era D1) PROMOVE com sucesso pro passo 2 (vira
  // D2). TMP2 (era D2) FALHA ao promover pro passo 2 (deveria virar D1).
  //
  // Antes do fix: `rollbackTmpRenames` só recebia os pares "original→TMP"
  // AINDA pendentes — TMP1 já tinha sido removido da lista de rollback
  // porque "teve sucesso" ao promover. O rollback então renomeava só TMP2
  // de volta pro seu `originalName` = "04-d2-*" — que JÁ ESTAVA OCUPADO
  // pelo conteúdo recém-promovido de D1. `renameSync` sobrescrevia em
  // silêncio: D1 sumia sem chance de recuperação (nem TMP1 nem d1-*
  // sobravam no disco com o conteúdo de D1) e D2 voltava a ter o conteúdo
  // ANTIGO — pior que nunca ter rodado, e sem nenhum sinal de erro extra
  // além da falha original de promoção.
  //
  // Depois do fix: o rollback desfaz TODOS os renames aplicados (passo 1 E
  // passo 2) em ordem reversa, cada um voltando ao nome que tinha
  // IMEDIATAMENTE ANTES daquele rename específico — nunca ao "originalName"
  // genérico do grupo. D1 e D2 devem terminar exatamente como começaram.
  it("renameDestaqueImages: swap D1↔D2, TMP1 promove OK e TMP2 falha ao promover → D1 e D2 restaurados intactos (nenhum perdido, nenhum sobrescrito)", () => {
    const dir = mkdtempSync(join(tmpdir(), "reorder-img-cyclic-rollback-"));
    try {
      writeFileSync(join(dir, "04-d1-1x1.jpg"), "CONTENT_D1");
      writeFileSync(join(dir, "04-d2-1x1.jpg"), "CONTENT_D2");
      writeFileSync(join(dir, "04-d3-1x1.jpg"), "CONTENT_D3");

      // Falha só na 1ª chamada que casar o padrão "promoção de TMP2 → final"
      // (flag `tmp2FailureInjected`) — a promoção original (dentro do try
      // principal) é a única que deve lançar. Sem a flag, o MESMO padrão
      // ("from" contém "TMP2", "to" não contém "TMP") também casaria a
      // chamada de ROLLBACK que tenta mover TMP2 de volta pro seu nome
      // anterior, fazendo o próprio rollback falhar e mascarar o que
      // estamos testando.
      let tmp2FailureInjected = false;
      const fakeDeps: RenameFileDeps = {
        renameSync: (from, to) => {
          const fromStr = String(from);
          const toStr = String(to);
          // Só a promoção de TMP2 → final (passo 2) falha. Passo 1
          // (original→TMP) e a promoção de TMP1 → final seguem normais —
          // é essa ordem (TMP1 promove ANTES de TMP2 falhar) que exercita
          // o caminho quebrado: o rollback precisa lidar com uma promoção
          // JÁ bem-sucedida no meio da pilha de renames aplicados.
          if (!tmp2FailureInjected && fromStr.includes("TMP2") && !toStr.includes("TMP")) {
            tmp2FailureInjected = true;
            throw new Error("simulated failure promoting TMP2 -> final");
          }
          renameFsSync(from, to);
        },
        existsSync,
      };

      assert.throws(
        () => renameDestaqueImages(dir, [2, 1, 3], false, fakeDeps),
        /simulated failure promoting TMP2 -> final/,
      );

      // Nenhum TMP{N} órfão sobra no disco.
      assert.ok(
        !existsSync(join(dir, "04-TMP1-1x1.jpg")),
        "04-TMP1-1x1.jpg não deveria sobrar órfão",
      );
      assert.ok(
        !existsSync(join(dir, "04-TMP2-1x1.jpg")),
        "04-TMP2-1x1.jpg não deveria sobrar órfão",
      );

      // D1 restaurado com o conteúdo ORIGINAL — o bug fazia D1 desaparecer
      // completamente (irrecuperável a partir do output da função).
      assert.ok(
        existsSync(join(dir, "04-d1-1x1.jpg")),
        "04-d1-1x1.jpg (D1) deveria existir pós-rollback — antes do fix, sumia",
      );
      assert.equal(
        readFileSync(join(dir, "04-d1-1x1.jpg"), "utf8"),
        "CONTENT_D1",
        "04-d1-1x1.jpg deveria ter o conteúdo ORIGINAL de D1 restaurado",
      );

      // D2 restaurado com o conteúdo ORIGINAL — o bug deixava D2 com o
      // conteúdo antigo (correto por acidente aqui, mas só porque o
      // rollback sobrescrevia por cima do D1 promovido — o teste abaixo
      // fecha o caso em que isso seria detectável como corrupção).
      assert.ok(existsSync(join(dir, "04-d2-1x1.jpg")));
      assert.equal(
        readFileSync(join(dir, "04-d2-1x1.jpg"), "utf8"),
        "CONTENT_D2",
        "04-d2-1x1.jpg deveria ter o conteúdo ORIGINAL de D2 restaurado (não o de D1 sobrescrito)",
      );

      // D3 nunca fez parte do reorder — intacto.
      assert.ok(existsSync(join(dir, "04-d3-1x1.jpg")));
      assert.equal(readFileSync(join(dir, "04-d3-1x1.jpg"), "utf8"), "CONTENT_D3");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Mesma classe de bug, ciclo de 3 (rotação, não swap) — exercita o caso
  // em que DUAS promoções têm sucesso antes de uma terceira falhar, pra
  // confirmar que o fix generaliza além do swap de 2 documentado no achado
  // original (self-review deste hotfix).
  it("renameDestaqueImages: rotação de 3 (newOrder=[3,1,2]), 2 promoções OK e a 3ª falha → D1/D2/D3 todos restaurados intactos", () => {
    const dir = mkdtempSync(join(tmpdir(), "reorder-img-3cycle-rollback-"));
    try {
      writeFileSync(join(dir, "04-d1-1x1.jpg"), "CONTENT_D1");
      writeFileSync(join(dir, "04-d2-1x1.jpg"), "CONTENT_D2");
      writeFileSync(join(dir, "04-d3-1x1.jpg"), "CONTENT_D3");

      // newOrder=[3,1,2]: oldToNew = {3→1, 1→2, 2→3}. TMP1 (era D1) promove
      // pra D2, TMP2 (era D2) promove pra D3 — ambos com sucesso. TMP3
      // (era D3) falha ao promover pra D1. Mesma flag "só falha 1×" do
      // teste acima — sem ela, o rollback tentando mover TMP3 de volta
      // casaria o mesmo padrão e falharia também.
      let tmp3FailureInjected = false;
      const fakeDeps: RenameFileDeps = {
        renameSync: (from, to) => {
          const fromStr = String(from);
          const toStr = String(to);
          if (!tmp3FailureInjected && fromStr.includes("TMP3") && !toStr.includes("TMP")) {
            tmp3FailureInjected = true;
            throw new Error("simulated failure promoting TMP3 -> final");
          }
          renameFsSync(from, to);
        },
        existsSync,
      };

      assert.throws(
        () => renameDestaqueImages(dir, [3, 1, 2], false, fakeDeps),
        /simulated failure promoting TMP3 -> final/,
      );

      for (const n of [1, 2, 3]) {
        assert.ok(
          !existsSync(join(dir, `04-TMP${n}-1x1.jpg`)),
          `04-TMP${n}-1x1.jpg não deveria sobrar órfão`,
        );
      }
      assert.equal(readFileSync(join(dir, "04-d1-1x1.jpg"), "utf8"), "CONTENT_D1");
      assert.equal(readFileSync(join(dir, "04-d2-1x1.jpg"), "utf8"), "CONTENT_D2");
      assert.equal(readFileSync(join(dir, "04-d3-1x1.jpg"), "utf8"), "CONTENT_D3");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Mesmo cenário exato do achado, mas no OUTRO call site que compartilha
  // `rollbackAppliedRenames` — `renameDestaquePrompts` tinha exatamente a
  // mesma estrutura de bug (mesma função de rollback, mesmo padrão de
  // "remover do tracking ao promover").
  it("renameDestaquePrompts: swap D1↔D2, TMP1 promove OK e TMP2 falha ao promover → D1 e D2 restaurados intactos", () => {
    const dir = mkdtempSync(join(tmpdir(), "reorder-prompts-cyclic-rollback-"));
    try {
      writeFileSync(join(dir, "02-d1-prompt.md"), "CONTENT_D1");
      writeFileSync(join(dir, "02-d2-prompt.md"), "CONTENT_D2");

      let tmp2FailureInjected = false;
      const fakeDeps: RenameFileDeps = {
        renameSync: (from, to) => {
          const fromStr = String(from);
          const toStr = String(to);
          if (!tmp2FailureInjected && fromStr.includes("TMP2") && !toStr.includes("TMP")) {
            tmp2FailureInjected = true;
            throw new Error("simulated failure promoting TMP2 -> final");
          }
          renameFsSync(from, to);
        },
        existsSync,
      };

      assert.throws(
        () => renameDestaquePrompts(dir, [2, 1, 3], false, fakeDeps),
        /simulated failure promoting TMP2 -> final/,
      );

      assert.ok(!existsSync(join(dir, "02-TMP1-prompt.md")));
      assert.ok(!existsSync(join(dir, "02-TMP2-prompt.md")));
      assert.ok(existsSync(join(dir, "02-d1-prompt.md")));
      assert.equal(readFileSync(join(dir, "02-d1-prompt.md"), "utf8"), "CONTENT_D1");
      assert.ok(existsSync(join(dir, "02-d2-prompt.md")));
      assert.equal(readFileSync(join(dir, "02-d2-prompt.md"), "utf8"), "CONTENT_D2");
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

      // Imagens reais no edition dir — newOrder [2,1,3] move D1, então o
      // passo 1 (image rename) tenta 04-d1-1x1.jpg → 04-TMP1-1x1.jpg.
      writeFileSync(join(dir, "04-d1-1x1.jpg"), "img1");
      writeFileSync(join(dir, "04-d2-1x1.jpg"), "img2");
      writeFileSync(join(dir, "04-d3-1x1.jpg"), "img3");
      // Cria o TARGET do rename como diretório de propósito — força uma
      // falha REAL de filesystem (EISDIR), sem precisar de dependency
      // injection (a CLI usa os deps reais de produção).
      mkdirSync(join(dir, "04-TMP1-1x1.jpg"));

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
