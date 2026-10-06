/**
 * #9755 — swap-destaque não apagava imagens com hífen nem os sidecars do
 * destaque antigo; promote-to-destaque não limpava o 02-reviewed.md (URL 2×,
 * TÍTULO/SUBTÍTULO e intro defasados); nenhum dos dois sugeria re-selecionar
 * o 4º post social quando o item promovido era o dele.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deleteDestaqueImages, deleteDestaquePrompts } from "../scripts/swap-destaque.ts";
import {
  applyPromoteToReviewedMd,
  insertDestaquePlaceholderInMd,
  insertTitleInTituloSubtitulo,
  promoteToDestaque,
} from "../scripts/promote-to-destaque.ts";
import { useMelhorPostReselectStep } from "../scripts/lib/use-melhor-post.ts";
import { isSwapPlaceholder } from "../scripts/lib/titulo-provisional.ts";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "diaria-9755-"));
}

describe("#9755 — swap apaga todos os artefatos do destaque substituído", () => {
  it("deleteDestaqueImages pega sufixo com hífen (4x5-nativo, carousel-*) e o sd-prompt legado da raiz", () => {
    const dir = tmp();
    try {
      const d1 = [
        "04-d1-2x1.jpg",
        "04-d1-4x5.jpg",
        "04-d1-4x5-nativo.jpg",
        "04-d1-carousel-p1-4x5.jpg",
        "04-d1-carousel-cta-4x5.jpg",
        "04-d1-sd-prompt.json",
      ];
      const keep = ["04-d2-4x5-nativo.jpg", "04-d2-carousel-p1-4x5.jpg", "04-d2-sd-prompt.json", "04-eia-a.jpg"];
      for (const f of [...d1, ...keep]) writeFileSync(join(dir, f), "x");
      const deleted = deleteDestaqueImages(dir, 1, false).map((d) => d.deleted).sort();
      assert.deepEqual(deleted, [...d1].sort());
      for (const f of d1) assert.equal(existsSync(join(dir, f)), false, f);
      for (const f of keep) assert.equal(existsSync(join(dir, f)), true, f);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("deleteDestaquePrompts apaga os sidecars _internal/04-d{N}-{sd-prompt,generator}.json", () => {
    const dir = tmp();
    try {
      const d2 = ["02-d2-prompt.md", "02-d2-sd-prompt.json", "02-d2-draft.md", "04-d2-sd-prompt.json", "04-d2-generator.json"];
      const keep = ["04-d1-generator.json", "04-d3-sd-prompt.json", "04-crop-review.json", "02-d1-prompt.md"];
      for (const f of [...d2, ...keep]) writeFileSync(join(dir, f), "{}");
      const deleted = deleteDestaquePrompts(dir, 2, false).map((d) => d.deleted).sort();
      assert.deepEqual(deleted, [...d2].sort());
      for (const f of keep) assert.equal(existsSync(join(dir, f)), true, f);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("dry-run lista sem apagar", () => {
    const dir = tmp();
    try {
      writeFileSync(join(dir, "04-d3-4x5-nativo.jpg"), "x");
      assert.deepEqual(deleteDestaqueImages(dir, 3, true), [{ deleted: "04-d3-4x5-nativo.jpg" }]);
      assert.equal(existsSync(join(dir, "04-d3-4x5-nativo.jpg")), true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

const URL_RADAR = "https://r.com/2";
const URL_UM = "https://um.com/tut-b";

function md2(): string {
  return [
    "TÍTULO",
    "",
    "Título do D1",
    "",
    "SUBTÍTULO",
    "",
    "Título do D2",
    "",
    "---",
    "Olá! Eu sou o Pixel.",
    "",
    "Nesta edição, a IA analisou 300 conteúdos e selecionei os 6 mais relevantes.",
    "",
    "---",
    "",
    "**DESTAQUE 1 | 🚀 LANÇAMENTO**",
    "",
    "**[Título do D1](https://a.com/d1)**  ",
    "",
    "Texto 1.",
    "",
    "---",
    "",
    "**DESTAQUE 2 | 🛡️ SEGURANÇA**",
    "",
    "**[Título do D2](https://b.com/d2)**  ",
    "",
    "Texto 2.",
    "",
    "---",
    "",
    "**🛠️ USE MELHOR**",
    "",
    "**[Tutorial A](https://um.com/tut-a)**",
    "Descrição A. (5 min)",
    "",
    `**[Tutorial B](${URL_UM})**`,
    "Descrição B. (5 min)",
    "",
    "---",
    "",
    "**📡 RADAR**",
    "",
    "**[Radar 1](https://r.com/1)**  ",
    "Descrição 1.",
    "",
    `**[Radar 2](${URL_RADAR})**  `,
    "Descrição 2.",
    "",
    "---",
    "",
    "**ERRO INTENCIONAL**",
    "",
    "Texto do erro.",
    "",
  ].join("\n");
}

function count(hay: string, needle: string): number {
  return hay.split(needle).length - 1;
}

describe("#9755 — promote limpa o 02-reviewed.md como o swap", () => {
  for (const position of [1, 2, 3] as const) {
    it(`posição ${position}: URL uma vez só, placeholder no lugar, TÍTULO/SUBTÍTULO com 3 títulos, intro coerente`, () => {
      const { md, updates } = applyPromoteToReviewedMd(md2(), position, "Radar 2 | Fonte X", URL_RADAR);
      assert.equal(count(md, URL_RADAR), 1, "URL só no placeholder");
      assert.equal(updates.pool_item_removed, true);
      assert.equal(updates.placeholder_inserted, true);
      assert.ok(isSwapPlaceholder(md, position), "placeholder reconhecido pelo finalize/invariante");
      // ordem dos headers 1..3
      const headers = [...md.matchAll(/^\*\*DESTAQUE (\d) \|/gm)].map((m) => Number(m[1]));
      assert.deepEqual(headers, [1, 2, 3]);
      // TÍTULO/SUBTÍTULO re-derivado
      assert.equal(updates.titulo_subtitulo, "updated");
      const expected = ["Título do D1", "Título do D2"];
      expected.splice(position - 1, 0, updates.provisional_title);
      const head = md.split("\n---\n")[0];
      assert.match(head, new RegExp(`TÍTULO\\n\\n${expected[0]}\\n`));
      assert.ok(head.includes(`SUBTÍTULO\n\n${expected[1]} | ${expected[2]}\n`), head);
      assert.doesNotMatch(updates.provisional_title, /\|/);
      // 3 destaques + 2 use melhor + 1 radar = 6 (sem mudança)
      assert.match(md, /selecionei os 6 mais relevantes/);
      // ERRO INTENCIONAL e demais seções preservadas
      assert.match(md, /\*\*ERRO INTENCIONAL\*\*/);
      assert.match(md, /\*\*\[Radar 1\]/);
    });
  }

  it("posição 3: placeholder entra depois do D2 e antes do --- da próxima seção", () => {
    const { md } = insertDestaquePlaceholderInMd(md2(), 3, "Novo", URL_RADAR);
    assert.match(md, /Texto 2\.\n\n---\n\n\*\*DESTAQUE 3 \| \[RASCUNHO PENDENTE — swap-destaque\]\*\*[\s\S]*?\n\n---\n\n\*\*🛠️ USE MELHOR\*\*/);
  });

  it("TÍTULO/SUBTÍTULO fora do formato de 2 destaques fica intocado", () => {
    const md = md2().replace("SUBTÍTULO\n\nTítulo do D2", "SUBTÍTULO\n\nUm | Dois");
    const r = insertTitleInTituloSubtitulo(md, 1, "Novo");
    assert.equal(r.status, "unexpected_shape");
    assert.equal(r.md, md);
    assert.equal(insertTitleInTituloSubtitulo("sem bloco", 1, "x").status, "no_block");
  });

  it("intro errada antes do promote é corrigida pela contagem real", () => {
    const md = md2().replace("selecionei os 6", "selecionei os 9");
    const { md: out, updates } = applyPromoteToReviewedMd(md, 1, "Radar 2", URL_RADAR);
    assert.equal(updates.intro_count.before, 9);
    assert.equal(updates.intro_count.after, 6);
    assert.match(out, /selecionei os 6 mais relevantes/);
  });
});

describe("#9755 — promote ponta a ponta + 4º post social", () => {
  function makeEdition(): string {
    const dir = tmp();
    const internal = join(dir, "_internal");
    mkdirSync(internal, { recursive: true });
    const approved = {
      highlights: [
        { rank: 1, url: "https://a.com/d1", article: { url: "https://a.com/d1", title: "Título do D1" } },
        { rank: 2, url: "https://b.com/d2", article: { url: "https://b.com/d2", title: "Título do D2" } },
      ],
      use_melhor: [
        { url: "https://um.com/tut-a", title: "Tutorial A" },
        { url: URL_UM, title: "Tutorial B" },
      ],
      radar: [
        { url: "https://r.com/1", title: "Radar 1" },
        { url: URL_RADAR, title: "Radar 2" },
      ],
    };
    writeFileSync(join(internal, "01-approved.json"), JSON.stringify(approved));
    writeFileSync(
      join(internal, "use-melhor-post.json"),
      JSON.stringify({ enabled: true, time: "19:00", item: { url: URL_UM, title: "Tutorial B" }, generated_at: "x" }),
    );
    writeFileSync(join(dir, "02-reviewed.md"), md2());
    return dir;
  }

  it("grava md limpo + marcador do provisório; item do 4º post sugere re-seleção", () => {
    const dir = makeEdition();
    try {
      const r = promoteToDestaque(dir, URL_UM, 2);
      const md = readFileSync(join(dir, "02-reviewed.md"), "utf8");
      assert.equal(count(md, URL_UM), 1);
      assert.ok(isSwapPlaceholder(md, 2));
      assert.equal(r.md_updates?.titulo_subtitulo, "updated");
      const marker = JSON.parse(readFileSync(join(dir, "_internal", "swap-destaque-titulo-pending.json"), "utf8"));
      assert.deepEqual(marker.pending, [{ position: 2, provisional_title: "Tutorial B" }]);
      assert.ok(r.next_steps.some((s) => s.includes("--finalize-titulo")));
      assert.ok(
        r.next_steps.some((s) => s.includes("select-use-melhor-post.ts") && s.includes("--reviewed")),
        "sugere re-selecionar o 4º post",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("item que não era o do 4º post não gera o passo", () => {
    const dir = makeEdition();
    try {
      const r = promoteToDestaque(dir, URL_RADAR, 3);
      assert.ok(!r.next_steps.some((s) => s.includes("select-use-melhor-post.ts")));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("useMelhorPostReselectStep: casa URL normalizada (utm/barra final), null sem estado", () => {
    const dir = makeEdition();
    try {
      assert.match(useMelhorPostReselectStep(dir, `${URL_UM}/?utm_source=x`) ?? "", /select-use-melhor-post\.ts/);
      assert.equal(useMelhorPostReselectStep(dir, URL_RADAR), null);
      rmSync(join(dir, "_internal", "use-melhor-post.json"));
      assert.equal(useMelhorPostReselectStep(dir, URL_UM), null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
