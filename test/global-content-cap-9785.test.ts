/**
 * test/global-content-cap-9785.test.ts (#9785)
 *
 * Teto GLOBAL de 13 conteúdos por edição (decisão do editor, briefing overnight
 * 261007): corte por score, sem cota por seção, destaques intocados, itens
 * pinados pelo editor preservados. Cobre o corte cedo (`applyStage2Caps`,
 * início do Stage 2) e o guard pré-gate (`max-content-items`, Stage 4).
 *
 * Baseline que motivou: 02-draft.md com 15–18 conteúdos únicos em todas as
 * edições de 260909 a 261007 (ex.: 261007 = 3 destaques + 5 lançamentos +
 * 5 radar + 4 use melhor = 17), cortados à mão pelo editor no Gate 4.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyGlobalContentCap,
  applyStage2Caps,
  isEditorPinned,
  MAX_EDITION_CONTENT_ITEMS,
  type StageArticle,
} from "../scripts/lib/apply-stage2-caps.ts";
import { checkMaxContentItems, STAGE_4_RULES } from "../scripts/lib/invariant-checks/stage-4.ts";

const art = (host: string, i: number, score?: number, extra: Partial<StageArticle> = {}): StageArticle => ({
  url: `https://${host}${i}.com/p`,
  title: `${host} ${i}`,
  ...(score !== undefined ? { score } : {}),
  ...extra,
});

const highlights3 = [0, 1, 2].map((i) => ({
  rank: i + 1,
  score: 90,
  article: { url: `https://dest${i}.com/d`, title: `D${i + 1}` },
}));

describe("MAX_EDITION_CONTENT_ITEMS (#9785)", () => {
  it("é 13", () => {
    assert.equal(MAX_EDITION_CONTENT_ITEMS, 13);
  });
});

describe("isEditorPinned (#9785)", () => {
  it("reconhece submissão do editor e item incluído no gate", () => {
    assert.equal(isEditorPinned({ flag: "editor_submitted" }), true);
    assert.equal(isEditorPinned({ flag: "editor_added" }), true);
    assert.equal(isEditorPinned({ source: "editor: incluído no gate" }), true);
  });
  it("não confunde newsletter extraída nem fonte comum", () => {
    assert.equal(isEditorPinned({ flag: "newsletter_extracted", source: "inbox_newsletter:TLDR AI" }), false);
    assert.equal(isEditorPinned({ source: "The Verge (AI)" }), false);
    assert.equal(isEditorPinned({}), false);
  });
});

describe("applyGlobalContentCap (#9785)", () => {
  it("≤ teto: devolve tudo intacto", () => {
    const buckets = {
      lancamento: [art("l", 0, 50)],
      use_melhor: [art("u", 0, 40)],
      video: [],
      radar: [art("r", 0, 30)],
    };
    const { buckets: out, report } = applyGlobalContentCap(3, buckets);
    assert.equal(report.before, 6);
    assert.equal(report.after, 6);
    assert.deepEqual(report.removed, []);
    assert.equal(out.lancamento.length, 1);
    assert.equal(out.radar.length, 1);
  });

  it("corta pelo score GLOBAL, sem cota por seção — seção inteira pode sumir", () => {
    // 3 destaques + 14 itens = 17 → corta 4. Os 4 de menor score são todos do RADAR.
    const buckets = {
      lancamento: [80, 79, 78, 77, 76].map((s, i) => art("l", i, s)),
      use_melhor: [75, 74, 73, 72].map((s, i) => art("u", i, s)),
      video: [],
      radar: [71, 10, 11, 12, 13].map((s, i) => art("r", i, s)),
    };
    const { buckets: out, report } = applyGlobalContentCap(3, buckets);
    assert.equal(report.before, 17);
    assert.equal(report.after, 13);
    assert.equal(out.lancamento.length, 5);
    assert.equal(out.use_melhor.length, 4);
    assert.equal(out.radar.length, 1);
    assert.equal(out.radar[0].score, 71);
    assert.deepEqual(
      report.removed.map((r) => r.score).sort((a, b) => (a ?? 0) - (b ?? 0)),
      [10, 11, 12, 13],
    );
    assert.ok(report.removed.every((r) => r.bucket === "radar"));
  });

  it("preserva a ordem original dentro de cada bucket", () => {
    const buckets = {
      lancamento: [],
      use_melhor: [],
      video: [],
      radar: [5, 90, 1, 80, 70, 60, 50, 40, 30, 20, 15, 12].map((s, i) => art("r", i, s)),
    };
    const { buckets: out } = applyGlobalContentCap(3, buckets);
    // 10 vagas: corta os 2 menores (1 e 5), mantém ordem.
    assert.deepEqual(out.radar.map((a) => a.score), [90, 80, 70, 60, 50, 40, 30, 20, 15, 12]);
  });

  it("item sem score conta como 0 e sai primeiro", () => {
    const buckets = {
      lancamento: [],
      use_melhor: [],
      video: [],
      radar: [...Array.from({ length: 10 }, (_, i) => art("r", i, 50)), art("x", 0)],
    };
    const { buckets: out, report } = applyGlobalContentCap(3, buckets);
    assert.equal(out.radar.length, 10);
    assert.equal(report.removed.length, 1);
    assert.equal(report.removed[0].url, "https://x0.com/p");
  });

  it("empate de score: LANÇAMENTOS > USE MELHOR > VÍDEO > RADAR", () => {
    const buckets = {
      lancamento: [art("l", 0, 50)],
      use_melhor: [art("u", 0, 50)],
      video: [art("v", 0, 50)],
      radar: [art("r", 0, 50)],
    };
    const { buckets: out, report } = applyGlobalContentCap(10, buckets);
    assert.equal(report.after, 13);
    assert.equal(out.radar.length, 0);
    assert.equal(out.video.length, 1);
  });

  it("item pinado pelo editor nunca sai, mesmo sem score", () => {
    const pinned = art("ed", 0, undefined, { flag: "editor_added", source: "editor: incluído no gate" });
    const buckets = {
      lancamento: [],
      use_melhor: [],
      video: [],
      radar: [pinned, ...Array.from({ length: 12 }, (_, i) => art("r", i, 60 + i))],
    };
    const { buckets: out, report } = applyGlobalContentCap(3, buckets);
    assert.equal(report.after, 13);
    assert.ok(out.radar.includes(pinned));
    assert.equal(report.editor_pinned, 1);
    assert.equal(report.removed.length, 3);
  });

  it("pinados que estouram sozinhos: teto excedido, nada pinado é cortado", () => {
    const pinned = Array.from({ length: 12 }, (_, i) => art("ed", i, 10, { flag: "editor_submitted" }));
    const buckets = { lancamento: [], use_melhor: [], video: [], radar: [...pinned, art("r", 0, 99)] };
    const { buckets: out, report } = applyGlobalContentCap(3, buckets);
    assert.equal(out.radar.length, 12);
    assert.equal(report.after, 15);
    assert.ok(report.after > report.max);
    assert.equal(report.removed.length, 1);
    assert.equal(report.removed[0].score, 99);
  });

  it("não muta os arrays de entrada", () => {
    const radar = Array.from({ length: 15 }, (_, i) => art("r", i, i));
    const buckets = { lancamento: [], use_melhor: [], video: [], radar };
    applyGlobalContentCap(3, buckets);
    assert.equal(radar.length, 15);
  });
});

describe("applyStage2Caps — teto global integrado (#9785)", () => {
  it("cenário 261007: 3 + 5 lançamentos + 5 radar + 4 use melhor = 17 → 13", () => {
    const approved = {
      highlights: highlights3,
      lancamento: [77, 67, 65, 50, 65].map((s, i) => art("l", i, s)),
      radar: [78, 87, 80, 78, 78, 78, 55, 40].map((s, i) => art("r", i, s)),
      use_melhor: [69, 68, 55, 48].map((s, i) => art("u", i, s, { bucket: "use_melhor" })),
    };
    const { approved: capped, report } = applyStage2Caps(approved);
    const total =
      (capped.highlights?.length ?? 0) +
      (capped.lancamento?.length ?? 0) +
      (capped.radar?.length ?? 0) +
      (capped.use_melhor?.length ?? 0);
    assert.equal(total, 13);
    assert.equal(capped.highlights?.length, 3, "destaques nunca são cortados");
    assert.equal(report.global_cap.before, 17);
    assert.equal(report.global_cap.after, 13);
    assert.equal(report.global_cap.removed.length, 4);
    // Os cortados são os 4 de menor score entre os sobreviventes dos caps por seção.
    const cutScores = report.global_cap.removed.map((r) => r.score).sort((a, b) => (a ?? 0) - (b ?? 0));
    assert.deepEqual(cutScores, [48, 50, 55, 65]);
    assert.equal(report.after.lancamento, capped.lancamento?.length);
    assert.equal(report.after.radar, capped.radar?.length);
    assert.equal(report.use_melhor.after, capped.use_melhor?.length);
  });

  it("edição já dentro do teto não perde nada", () => {
    const approved = {
      highlights: highlights3,
      lancamento: [art("l", 0, 70)],
      radar: [70, 60, 50, 40, 30].map((s, i) => art("r", i, s)),
      use_melhor: [art("u", 0, 60, { bucket: "use_melhor" }), art("u", 1, 55, { bucket: "use_melhor" })],
    };
    const { approved: capped, report } = applyStage2Caps(approved);
    assert.equal(report.global_cap.removed.length, 0);
    assert.equal(capped.radar?.length, 5);
    assert.equal(report.global_cap.after, 11);
  });

  it("2 destaques liberam 1 vaga a mais pras seções (16 → 13 com 11 itens)", () => {
    const approved = {
      highlights: highlights3.slice(0, 2),
      lancamento: [80, 79, 78, 77, 76].map((s, i) => art("l", i, s)),
      radar: [70, 69, 68, 67, 66].map((s, i) => art("r", i, s)),
      use_melhor: [60, 59, 58, 57].map((s, i) => art("u", i, s, { bucket: "use_melhor" })),
    };
    const { approved: capped, report } = applyStage2Caps(approved);
    assert.equal(report.global_cap.before, 16);
    assert.equal(report.global_cap.after, 13);
    assert.equal(
      (capped.lancamento?.length ?? 0) + (capped.radar?.length ?? 0) + (capped.use_melhor?.length ?? 0),
      11,
    );
  });
});

function mdWith(radarCount: number): string {
  const dest = [1, 2, 3]
    .map((n) => `**DESTAQUE ${n} | 🚀 LANÇAMENTO**\n\n**[Título D${n}](https://d${n}.example.org/x)**\n\nTexto.`)
    .join("\n\n---\n\n");
  const radar = Array.from({ length: radarCount }, (_, i) => `**[Item ${i}](https://r${i}.example.org/x)**\nFrase.`).join("\n\n");
  return (
    `${dest}\n\n---\n\n**🛠️ USE MELHOR**\n\n**[Tut A](https://ua.example.org/x)**\nComo (5 min).\n\n**[Tut B](https://ub.example.org/x)**\nComo (5 min).\n\n---\n\n` +
    `## É IA?\n\n[Vote](https://eia.example.org/a) [Vote B](https://eia.example.org/b)\n\n---\n\n` +
    `**📡 RADAR**\n\n${radar}\n\n---\n\n**🎁 SORTEIO**\n\n[Regulamento](https://sorteio.example.org/x)\n`
  );
}

describe("checkMaxContentItems — guard pré-Gate 4 (#9785)", () => {
  const withMd = (md: string | null, fn: (dir: string) => void) => {
    const dir = mkdtempSync(join(tmpdir(), "max-content-9785-"));
    try {
      if (md !== null) writeFileSync(join(dir, "02-reviewed.md"), md, "utf8");
      fn(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  it("13 conteúdos (3 + 2 use melhor + 8 radar) → sem violação; É IA? e sorteio não contam", () => {
    withMd(mdWith(8), (dir) => assert.deepEqual(checkMaxContentItems(dir), []));
  });

  it("14 conteúdos → warning nomeando o excesso", () => {
    withMd(mdWith(9), (dir) => {
      const v = checkMaxContentItems(dir);
      assert.equal(v.length, 1);
      assert.equal(v[0].rule, "max-content-items");
      assert.equal(v[0].severity, "warning");
      assert.equal(v[0].source_issue, "#9785");
      assert.match(v[0].message, /14 conteúdos, teto é 13/);
      assert.match(v[0].message, /Cortar 1 item/);
    });
  });

  it("sem 02-reviewed.md → no-op", () => {
    withMd(null, (dir) => assert.deepEqual(checkMaxContentItems(dir), []));
  });

  it("registrado no Stage 4 como regra própria", () => {
    const rule = STAGE_4_RULES.find((r) => r.id === "max-content-items");
    assert.ok(rule, "max-content-items deve estar em STAGE_4_RULES");
    assert.equal(rule.stage, 4);
    assert.equal(rule.source_issue, "#9785");
  });
});
