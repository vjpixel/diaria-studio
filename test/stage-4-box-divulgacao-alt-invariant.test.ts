/**
 * test/stage-4-box-divulgacao-alt-invariant.test.ts (#4086)
 *
 * Cobre o registro do guard warn-only `box-divulgacao-alt-missing` em
 * `invariant-checks/stage-4.ts` — mesmo padrão de
 * test/stage-4-no-trailing-ellipsis-invariant.test.ts (#2881) e
 * test/stage-4-title-normalization-invariant.test.ts (#2693 item 3).
 *
 * checkBoxDivulgacaoAltMissing dispara (warning, nunca error) quando um slot
 * de box de divulgação (0/1/2/3 — slot 0 desde #4274) tem imagem —
 * `box_slot{N}_image` explícito, ou
 * `livros_promo` no box de livros — mas o snippet atribuído àquele slot em
 * `boxes_divulgacao.slot{N}` (platform.config.json) não declara `alt:` no
 * header.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  checkBoxDivulgacaoAltMissing,
  STAGE_4_RULES,
} from "../scripts/lib/invariant-checks/stage-4.ts";
import { BOX0_SENTINEL } from "../scripts/lib/newsletter-parse.ts"; // #4338

const LIVROS_MD = `Para esta edição, selecionamos 15 itens.

---

**DESTAQUE 1 | 🚀 LANÇAMENTO**

**[Título D1](https://example.com/d1)**

Corpo do destaque 1.

Por que isso importa:

Algo importante.

---

**📚 Nossa curadoria de livros sobre IA ganhou página nova. [Confira a nova página](https://livros.diar.ia.br).**

---

**DESTAQUE 2 | 🚀 LANÇAMENTO**

**[Título D2](https://example.com/d2)**

Corpo do destaque 2.
`;

/** MD sem nenhum box no slot 1 (sem a lacuna extra entre D1 e D2). */
const NO_BOX_MD = `Para esta edição, selecionamos 15 itens.

---

**DESTAQUE 1 | 🚀 LANÇAMENTO**

**[Título D1](https://example.com/d1)**

Corpo do destaque 1.

Por que isso importa:

Algo importante.

---

**DESTAQUE 2 | 🚀 LANÇAMENTO**

**[Título D2](https://example.com/d2)**

Corpo do destaque 2.
`;

function makeEdition(md: string, publicImages?: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), "stage4-box-alt-"));
  mkdirSync(join(dir, "_internal"), { recursive: true });
  writeFileSync(resolve(dir, "02-reviewed.md"), md);
  if (publicImages) {
    writeFileSync(resolve(dir, "06-public-images.json"), JSON.stringify({ images: publicImages }));
  }
  return dir;
}

function makeRoot(snippetFilename: string, snippetContent: string): string {
  const root = mkdtempSync(join(tmpdir(), "stage4-box-alt-root-"));
  mkdirSync(join(root, "data", "snippets"), { recursive: true });
  writeFileSync(join(root, "data", "snippets", snippetFilename), snippetContent);
  writeFileSync(
    join(root, "platform.config.json"),
    JSON.stringify({ boxes_divulgacao: { slot1: snippetFilename } }),
  );
  return root;
}

/** #4274: MD com box na região de intro (slot 0) — sem box no slot 1.
 * #4338: precisa do marcador sentinel — sem ele, `extractBoxDivulgacao0`
 * (detecção por marcador explícito, não mais por posição) não reconhece
 * este bloco como box0. */
const SLOT0_MD = `Para esta edição, selecionamos 15 itens.

---

${BOX0_SENTINEL}
🔧 Indicação de ferramenta: [Raycast](https://raycast.com).

---

**DESTAQUE 1 | 🚀 LANÇAMENTO**

**[Título D1](https://example.com/d1)**

Corpo do destaque 1.

Por que isso importa:

Algo importante.
`;

/** #4274: mesmo contrato de `makeRoot`, mas atribui o snippet ao slot0. */
function makeRootSlot0(snippetFilename: string, snippetContent: string): string {
  const root = mkdtempSync(join(tmpdir(), "stage4-box-alt-root-slot0-"));
  mkdirSync(join(root, "data", "snippets"), { recursive: true });
  writeFileSync(join(root, "data", "snippets", snippetFilename), snippetContent);
  writeFileSync(
    join(root, "platform.config.json"),
    JSON.stringify({ boxes_divulgacao: { slot0: snippetFilename } }),
  );
  return root;
}

describe("checkBoxDivulgacaoAltMissing (#4086)", () => {
  it("retorna [] quando 02-reviewed.md não existe (stage não chegou lá)", () => {
    const dir = mkdtempSync(join(tmpdir(), "stage4-box-alt-missing-md-"));
    try {
      assert.deepEqual(checkBoxDivulgacaoAltMissing(dir), []);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("retorna [] quando o slot não tem box nenhum", () => {
    const dir = makeEdition(NO_BOX_MD);
    try {
      assert.deepEqual(checkBoxDivulgacaoAltMissing(dir), []);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("retorna [] quando o slot tem box mas SEM imagem (livros_promo ausente de 06-public-images.json)", () => {
    const dir = makeEdition(LIVROS_MD); // sem 06-public-images.json
    try {
      assert.deepEqual(checkBoxDivulgacaoAltMissing(dir), []);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("warning quando o slot tem imagem (livros_promo) e o snippet não declara alt:", () => {
    const dir = makeEdition(LIVROS_MD, {
      livros_promo: { cloudflare_url: "https://img.example/livros.jpg" },
    });
    const root = makeRoot("sem-alt.md", "<!--\nnome: Livros\n-->\n\nConteúdo.");
    try {
      const v = checkBoxDivulgacaoAltMissing(dir, root);
      assert.equal(v.length, 1);
      assert.equal(v[0].severity, "warning");
      assert.equal(v[0].rule, "box-divulgacao-alt-missing");
      assert.equal(v[0].source_issue, "#4086");
      assert.match(v[0].message, /slot 1/i);
    } finally {
      rmSync(dir, { recursive: true });
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("retorna [] quando o slot tem imagem E o snippet declara alt:", () => {
    const dir = makeEdition(LIVROS_MD, {
      livros_promo: { cloudflare_url: "https://img.example/livros.jpg" },
    });
    const root = makeRoot(
      "com-alt.md",
      "<!--\nnome: Livros\nalt: Prévia da página de livros\n-->\n\nConteúdo.",
    );
    try {
      assert.deepEqual(checkBoxDivulgacaoAltMissing(dir, root), []);
    } finally {
      rmSync(dir, { recursive: true });
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("warning quando a imagem vem de box_slot1_image (explícita) e o snippet não declara alt:", () => {
    const dir = makeEdition(LIVROS_MD, {
      box_slot1_image: { cloudflare_url: "https://img.example/explicit.jpg" },
    });
    const root = makeRoot("sem-alt.md", "<!--\nnome: Livros\n-->\n\nConteúdo.");
    try {
      const v = checkBoxDivulgacaoAltMissing(dir, root);
      assert.equal(v.length, 1);
      assert.equal(v[0].rule, "box-divulgacao-alt-missing");
    } finally {
      rmSync(dir, { recursive: true });
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("#4274: warning quando a imagem vem de box_slot0_image (introdução) e o snippet não declara alt:", () => {
    const dir = makeEdition(SLOT0_MD, {
      box_slot0_image: { cloudflare_url: "https://img.example/explicit0.jpg" },
    });
    const root = makeRootSlot0("sem-alt-slot0.md", "<!--\nnome: Ferramenta\n-->\n\nConteúdo.");
    try {
      const v = checkBoxDivulgacaoAltMissing(dir, root);
      assert.equal(v.length, 1);
      assert.equal(v[0].rule, "box-divulgacao-alt-missing");
      assert.match(v[0].message, /slot 0/i);
    } finally {
      rmSync(dir, { recursive: true });
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("nunca é gate-blocking — severity é sempre 'warning', nunca 'error'", () => {
    const dir = makeEdition(LIVROS_MD, {
      livros_promo: { cloudflare_url: "https://img.example/livros.jpg" },
    });
    const root = makeRoot("sem-alt.md", "<!--\nnome: Livros\n-->\n\nConteúdo.");
    try {
      const v = checkBoxDivulgacaoAltMissing(dir, root);
      assert.ok(v.every((x) => x.severity === "warning"), "nenhuma violação deve ser 'error'");
    } finally {
      rmSync(dir, { recursive: true });
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("checkBoxDivulgacaoAltMissing prefere _internal/box-selection.json (#5457)", () => {
  /**
   * Cenário real do achado ao vivo (edição 260817): o config estático
   * (`boxes_divulgacao.slot1`) aponta pra um snippet SEM imagem/alt, mas
   * `box-selection.json` (gravado por `stitch-newsletter.ts` a cada stitch,
   * via `resolveBoxesForEdition`) registra que o slot 1 na verdade usou um
   * OUTRO snippet — o que de fato está em `02-reviewed.md` — que TEM `alt:`
   * declarado. O check deve seguir box-selection.json e não acusar nada.
   */
  it("slot com box-selection.json divergindo do config: usa o snippet do box-selection.json (com alt) — sem warning", () => {
    const dir = makeEdition(LIVROS_MD, {
      livros_promo: { cloudflare_url: "https://img.example/livros.jpg" },
    });
    // config estático aponta pro snippet SEM alt
    const root = makeRoot("estatico-sem-alt.md", "<!--\nnome: Estático\n-->\n\nConteúdo.");
    // box-selection.json diverge: o snippet EFETIVO do slot 1 tem alt
    writeFileSync(
      join(root, "data", "snippets", "efetivo-com-alt.md"),
      "<!--\nnome: Efetivo\nalt: Prévia real usada nesta edição\n-->\n\nConteúdo.",
    );
    writeFileSync(
      resolve(dir, "_internal", "box-selection.json"),
      JSON.stringify([
        { slot: 1, mode: "auto", file: "efetivo-com-alt.md", nome: "Efetivo", score: 10, trend: null, editionsAppeared: 3 },
      ]),
    );
    try {
      assert.deepEqual(checkBoxDivulgacaoAltMissing(dir, root), []);
    } finally {
      rmSync(dir, { recursive: true });
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("slot com box-selection.json divergindo do config: usa o snippet do box-selection.json (sem alt) — warning cita o arquivo efetivo, não o do config", () => {
    const dir = makeEdition(LIVROS_MD, {
      livros_promo: { cloudflare_url: "https://img.example/livros.jpg" },
    });
    // config estático aponta pro snippet COM alt — se o check caísse nele por
    // engano, este teste passaria (falso negativo). O box-selection.json é
    // que deve mandar, e ele aponta pro arquivo SEM alt.
    const root = makeRoot("estatico-com-alt.md", "<!--\nnome: Estático\nalt: Alt do config, nunca deveria aparecer aqui\n-->\n\nConteúdo.");
    writeFileSync(
      join(root, "data", "snippets", "efetivo-sem-alt.md"),
      "<!--\nnome: Efetivo\n-->\n\nConteúdo.",
    );
    writeFileSync(
      resolve(dir, "_internal", "box-selection.json"),
      JSON.stringify([
        { slot: 1, mode: "auto", file: "efetivo-sem-alt.md", nome: "Efetivo", score: 5, trend: null, editionsAppeared: 1 },
      ]),
    );
    try {
      const v = checkBoxDivulgacaoAltMissing(dir, root);
      assert.equal(v.length, 1);
      assert.equal(v[0].rule, "box-divulgacao-alt-missing");
      assert.match(v[0].message, /efetivo-sem-alt\.md/);
      assert.doesNotMatch(v[0].message, /estatico-com-alt\.md/);
    } finally {
      rmSync(dir, { recursive: true });
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("box-selection.json ausente: cai no fallback do config estático (comportamento pré-#5457)", () => {
    const dir = makeEdition(LIVROS_MD, {
      livros_promo: { cloudflare_url: "https://img.example/livros.jpg" },
    });
    const root = makeRoot("sem-alt.md", "<!--\nnome: Livros\n-->\n\nConteúdo.");
    // sem box-selection.json em _internal/ — mesma fixture do teste original #4086
    try {
      const v = checkBoxDivulgacaoAltMissing(dir, root);
      assert.equal(v.length, 1);
      assert.equal(v[0].rule, "box-divulgacao-alt-missing");
    } finally {
      rmSync(dir, { recursive: true });
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("box-selection.json presente mas sem entry pro slot: cai no fallback do config estático", () => {
    const dir = makeEdition(LIVROS_MD, {
      livros_promo: { cloudflare_url: "https://img.example/livros.jpg" },
    });
    const root = makeRoot("sem-alt.md", "<!--\nnome: Livros\n-->\n\nConteúdo.");
    writeFileSync(resolve(dir, "_internal", "box-selection.json"), JSON.stringify([]));
    try {
      const v = checkBoxDivulgacaoAltMissing(dir, root);
      assert.equal(v.length, 1);
      assert.equal(v[0].rule, "box-divulgacao-alt-missing");
    } finally {
      rmSync(dir, { recursive: true });
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("slot 0 nunca consulta box-selection.json (fora da rotação automática) — sempre o config estático", () => {
    const dir = makeEdition(SLOT0_MD, {
      box_slot0_image: { cloudflare_url: "https://img.example/explicit0.jpg" },
    });
    const root = makeRootSlot0("com-alt-slot0.md", "<!--\nnome: Ferramenta\nalt: Alt do config para slot0\n-->\n\nConteúdo.");
    // box-selection.json com uma entry pro slot 0 (não deveria existir na
    // prática — `resolveBoxesForEdition` só cobre 1/2/3 — mas mesmo que
    // apareça por engano/config futuro, slot 0 deve ignorá-la).
    writeFileSync(
      resolve(dir, "_internal", "box-selection.json"),
      JSON.stringify([{ slot: 0, mode: "auto", file: "outro-arquivo-sem-alt.md" }]),
    );
    try {
      assert.deepEqual(checkBoxDivulgacaoAltMissing(dir, root), []);
    } finally {
      rmSync(dir, { recursive: true });
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("STAGE_4_RULES registry (#4086)", () => {
  it("inclui box-divulgacao-alt-missing", () => {
    const ids = STAGE_4_RULES.map((r) => r.id);
    assert.ok(ids.includes("box-divulgacao-alt-missing"));
  });

  it("box-divulgacao-alt-missing está registrado no stage 4, source_issue #4086", () => {
    const entry = STAGE_4_RULES.find((r) => r.id === "box-divulgacao-alt-missing");
    assert.ok(entry);
    assert.equal(entry!.stage, 4);
    assert.equal(entry!.source_issue, "#4086");
  });
});
