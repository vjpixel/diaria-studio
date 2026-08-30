/**
 * test/select-boxes-by-clicks.test.ts (#4626)
 *
 * Cobre as funções PURAS de `scripts/select-boxes-by-clicks.ts` (ranking,
 * tendência, anti-repetição, seleção por slot) sem tocar disco, e a
 * resolução end-to-end (`resolveBoxesForEdition`) com fixtures injetadas
 * (nenhum teste toca `data/` real nem `platform.config.json` real, exceto o
 * teste dedicado que confirma o parse do arquivo real do repo).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildSnippetHistory,
  computeTrend,
  scoreBox,
  findPreviousEditionSnippets,
  selectBoxesForSlots,
  loadBoxesDivulgacaoAutoConfig,
  resolveBoxesForEdition,
  ROTATION_SLOTS,
  type SnippetEditionClicks,
  type SnippetHistory,
  type RankedBox,
} from "../scripts/select-boxes-by-clicks.ts";
import type { SnippetInfo, PostCacheLike } from "../scripts/box-click-report.ts";

// ── #6748: ROTATION_SLOTS ────────────────────────────────────────────────

describe("ROTATION_SLOTS (#6748 — slot 3 eliminado da rotação)", () => {
  it("contém só 1 e 2 — slot 3 nunca mais participa de ranking/histórico/anti-repetição", () => {
    assert.deepEqual([...ROTATION_SLOTS].sort(), [1, 2]);
    assert.equal(ROTATION_SLOTS.has(3), false);
  });
});

// ── computeTrend ─────────────────────────────────────────────────────────

describe("computeTrend (#4626 critério 2)", () => {
  const mk = (clicks: number[]): SnippetEditionClicks[] =>
    clicks.map((c, i) => ({ aammdd: `26080${i}`, unique_verified_clicks: c, verified_clicks: c }));

  it("null quando não há aparições suficientes em nenhuma janela (box nova)", () => {
    assert.equal(computeTrend([], 3, 3), null);
  });

  it("null quando só há aparições recentes, sem janela 'anterior' (histórico curto)", () => {
    // 2 aparições, recentWindow=3 consome as 2 -> prior fica vazio.
    assert.equal(computeTrend(mk([10, 12]), 3, 3), null);
  });

  it("declining=true quando a média recente é menor que a anterior", () => {
    // anterior: [10,10,10] avg=10; recente: [2,2,2] avg=2.
    const t = computeTrend(mk([10, 10, 10, 2, 2, 2]), 3, 3);
    assert.ok(t);
    assert.equal(t!.priorAvg, 10);
    assert.equal(t!.recentAvg, 2);
    assert.equal(t!.declining, true);
    assert.equal(t!.delta, -8);
  });

  it("declining=false quando a média recente é maior ou igual à anterior", () => {
    const t = computeTrend(mk([2, 2, 2, 10, 10, 10]), 3, 3);
    assert.ok(t);
    assert.equal(t!.declining, false);
  });

  it("janelas menores que o default (recentWindow/priorWindow customizados)", () => {
    // recentWindow=1, priorWindow=1: últimas 2 aparições, comparação direta.
    const t = computeTrend(mk([5, 1]), 1, 1);
    assert.ok(t);
    assert.equal(t!.recentAvg, 1);
    assert.equal(t!.priorAvg, 5);
    assert.equal(t!.declining, true);
  });
});

// ── scoreBox ─────────────────────────────────────────────────────────────

describe("scoreBox (#4626 critério 1+2 combinados)", () => {
  const history = (file: string, clicks: number[]): SnippetHistory => ({
    file,
    nome: file,
    appearances: clicks.map((c, i) => ({ aammdd: `26080${i}`, unique_verified_clicks: c, verified_clicks: c })),
  });

  it("sem tendência (histórico curto): score = média histórica simples", () => {
    const r = scoreBox(history("a.md", [10, 20]));
    assert.equal(r.trend, null);
    assert.equal(r.avgUniqueVerifiedClicks, 15);
    assert.equal(r.score, 15);
  });

  it("em queda: score cai pra média RECENTE, não a histórica (inflada)", () => {
    // histórica: (10+10+10+2+2+2)/6 = 6; recente (últimas 3): 2.
    const r = scoreBox(history("b.md", [10, 10, 10, 2, 2, 2]));
    assert.ok(r.trend?.declining);
    assert.equal(r.avgUniqueVerifiedClicks, 6);
    assert.equal(r.score, 2, "score deve refletir a média RECENTE (2), não a histórica (6)");
  });

  it("em alta: score = média histórica (sem penalidade)", () => {
    const r = scoreBox(history("c.md", [2, 2, 2, 10, 10, 10]));
    assert.equal(r.trend?.declining, false);
    assert.equal(r.score, r.avgUniqueVerifiedClicks);
  });

  it("critério 2 na prática: box em queda com média histórica MAIOR cede a box estável com média MENOR", () => {
    // 'declining' (b.md): histórica 6, mas em queda -> score 2.
    // 'stable' (d.md): histórica 4, estável -> score 4.
    // Mesmo a declining tendo média histórica maior (6 > 4), seu score final
    // (2) perde pra stable (4) — exatamente o comportamento pedido pela issue.
    const declining = scoreBox(history("declining.md", [10, 10, 10, 2, 2, 2]));
    const stable = scoreBox(history("stable.md", [4, 4, 4, 4, 4, 4]));
    assert.ok(declining.avgUniqueVerifiedClicks > stable.avgUniqueVerifiedClicks, "sanity: histórica da declining é maior");
    assert.ok(declining.score < stable.score, "mas o score final da declining deve ser MENOR — ela cede espaço");
  });
});

// ── buildSnippetHistory ──────────────────────────────────────────────────

const SNIPPET_A: SnippetInfo = { file: "a.md", nome: "A", urls: ["https://x.com/a"] };
const SNIPPET_B: SnippetInfo = { file: "b.md", nome: "B", urls: ["https://x.com/b"] };

function mdWithBox(slot: 1 | 2 | 3, url: string): string {
  const box = `**📚 Título**\n\n[Link](${url})`;
  if (slot === 1) {
    return `**DESTAQUE 1 | 🚀**\n\n[T](https://d1.com)\n\nbody\n\n---\n\n${box}\n\n---\n\n**DESTAQUE 2 | 🚀**\n\n[T](https://d2.com)\n\nbody`;
  }
  if (slot === 2) {
    return `**DESTAQUE 2 | 🚀**\n\n[T](https://d2.com)\n\nbody\n\n---\n\n${box}\n\n---\n\n**DESTAQUE 3 | 🚀**\n\n[T](https://d3.com)\n\nbody`;
  }
  return `**DESTAQUE 3 | 🚀**\n\n[T](https://d3.com)\n\nbody\n\n---\n\n${box}\n\n---\n\n**USE MELHOR**\n\nresto`;
}

function postFor(url: string, uniqueClicks: number): PostCacheLike {
  return {
    id: "p1",
    publish_date: 0,
    stats: { clicks: [{ url, email: { verified_clicks: uniqueClicks, unique_verified_clicks: uniqueClicks } }] },
  };
}

describe("buildSnippetHistory (#4626)", () => {
  it("agrega por snippet, cronológico oldest->newest, só slots 1/2/3", () => {
    const reviewed: Record<string, string> = {
      "260801": mdWithBox(1, "https://x.com/a"),
      "260802": mdWithBox(1, "https://x.com/a"),
    };
    const posts: Record<string, PostCacheLike> = {
      "260801": postFor("https://x.com/a", 5),
      "260802": postFor("https://x.com/a", 8),
    };
    const history = buildSnippetHistory({
      aammddList: ["260802", "260801"], // newest-first, convenção listEditions
      readReviewedMd: (a) => reviewed[a] ?? null,
      snippets: [SNIPPET_A, SNIPPET_B],
      findPost: (a) => posts[a] ?? null,
    });
    const a = history.get("a.md");
    assert.ok(a);
    assert.deepEqual(
      a!.appearances.map((x) => x.aammdd),
      ["260801", "260802"],
      "oldest -> newest",
    );
    assert.equal(a!.appearances[0].unique_verified_clicks, 5);
    assert.equal(a!.appearances[1].unique_verified_clicks, 8);
  });

  it("edição sem post cacheado NÃO vira aparição com 0 (omitida, não fabrica falso declínio)", () => {
    const reviewed: Record<string, string> = {
      "260801": mdWithBox(1, "https://x.com/a"),
      "260802": mdWithBox(1, "https://x.com/a"), // sem post correspondente
    };
    const posts: Record<string, PostCacheLike> = {
      "260801": postFor("https://x.com/a", 5),
    };
    const history = buildSnippetHistory({
      aammddList: ["260802", "260801"],
      readReviewedMd: (a) => reviewed[a] ?? null,
      snippets: [SNIPPET_A],
      findPost: (a) => posts[a] ?? null,
    });
    assert.equal(history.get("a.md")!.appearances.length, 1, "só a edição COM post cacheado entra");
  });

  // #5153: post fora da janela de 7 dias (never_enriched) precisa do MESMO
  // tratamento de "sem post cacheado" acima — nunca vira uma aparição
  // fabricada de 0 cliques (isso derrubaria artificialmente o score/tendência
  // de qualquer box que caísse numa edição recente ainda não medida).
  it("#5153: edição com post never_enriched NÃO vira aparição com 0 (omitida, mesmo com email.clicks > 0 no post real)", () => {
    const reviewed: Record<string, string> = {
      "260810": mdWithBox(1, "https://x.com/a"), // recém-publicada, fora da janela de 7 dias
      "260801": mdWithBox(1, "https://x.com/a"), // já madura, com dado real
    };
    const posts: Record<string, PostCacheLike> = {
      "260810": {
        id: "p-recente",
        publish_date: 0,
        stats: {
          // O ponto central: mesmo que o post tenha tido cliques reais no
          // e-mail (email.clicks > 0 na Beehiiv), o enrichment por link
          // nunca rodou pra ELE — clicks fica [], never_enriched explícito.
          clicks: [],
          enrichment_state: "never_enriched",
        },
      },
      "260801": postFor("https://x.com/a", 5),
    };
    const history = buildSnippetHistory({
      aammddList: ["260810", "260801"],
      readReviewedMd: (a) => reviewed[a] ?? null,
      snippets: [SNIPPET_A],
      findPost: (a) => posts[a] ?? null,
    });
    const a = history.get("a.md");
    assert.ok(a);
    assert.equal(a!.appearances.length, 1, "só a edição madura (com enrichment confirmado) entra no histórico");
    assert.equal(a!.appearances[0].aammdd, "260801");
    assert.equal(a!.appearances[0].unique_verified_clicks, 5);
  });

  it("slot 0 nunca entra no histórico (fora de escopo do #4626)", () => {
    const md = `cov\n\n---\n\n${"BOX0_SENTINEL"}\n\n**📚 Título**\n\n[Link](https://x.com/a)\n\n---\n\n**DESTAQUE 1 | 🚀**\n\n[T](https://d1.com)\n\nbody`;
    const history = buildSnippetHistory({
      aammddList: ["260801"],
      readReviewedMd: () => md,
      snippets: [SNIPPET_A],
      findPost: () => postFor("https://x.com/a", 99),
    });
    assert.equal(history.size, 0, "slot0 (mesmo com link batendo o snippet) não deve gerar histórico de rotação");
  });

  it("edição ilegível (readReviewedMd null) é pulada sem lançar", () => {
    const history = buildSnippetHistory({
      aammddList: ["260801"],
      readReviewedMd: () => null,
      snippets: [SNIPPET_A],
      findPost: () => null,
    });
    assert.equal(history.size, 0);
  });
});

// ── findPreviousEditionSnippets ──────────────────────────────────────────

describe("findPreviousEditionSnippets (#4626 critério 3)", () => {
  it("acha a 1ª edição legível ANTERIOR, excluindo a atual, e devolve os arquivos usados (slot 1/2/3)", () => {
    const reviewed: Record<string, string> = {
      "260803": mdWithBox(1, "https://x.com/a"), // edição atual (excluída)
      "260802": mdWithBox(2, "https://x.com/b"), // edição anterior real
    };
    const excluded = findPreviousEditionSnippets(
      "260803",
      ["260803", "260802"],
      (a) => reviewed[a] ?? null,
      [SNIPPET_A, SNIPPET_B],
    );
    assert.deepEqual([...excluded], ["b.md"]);
  });

  it("pula edições ilegíveis até achar a 1ª com 02-reviewed.md", () => {
    const reviewed: Record<string, string> = {
      // #6748: slot 3 saiu de ROTATION_SLOTS (default) — usa slot 1 aqui, já
      // que o ponto do teste é "pular edições ilegíveis", não qual slot.
      "260801": mdWithBox(1, "https://x.com/a"),
    };
    const excluded = findPreviousEditionSnippets(
      "260803",
      ["260803", "260802", "260801"],
      (a) => reviewed[a] ?? null,
      [SNIPPET_A],
    );
    assert.deepEqual([...excluded], ["a.md"]);
  });

  it("nenhuma edição anterior legível -> conjunto vazio (nunca lança)", () => {
    const excluded = findPreviousEditionSnippets("260803", ["260803"], () => null, [SNIPPET_A]);
    assert.equal(excluded.size, 0);
  });
});

// ── selectBoxesForSlots ───────────────────────────────────────────────────

describe("selectBoxesForSlots (#4626)", () => {
  const ranked: RankedBox[] = [
    { file: "high.md", nome: "High", editionsAppeared: 5, avgUniqueVerifiedClicks: 10, trend: null, score: 10 },
    { file: "mid.md", nome: "Mid", editionsAppeared: 5, avgUniqueVerifiedClicks: 5, trend: null, score: 5 },
    { file: "low.md", nome: "Low", editionsAppeared: 5, avgUniqueVerifiedClicks: 1, trend: null, score: 1 },
  ];

  it("escolhe por score desc, 1 candidato por slot, sem repetir a mesma box em 2 slots", () => {
    const picks = selectBoxesForSlots({ ranked, slotsToFill: [1, 2, 3], excludeFiles: new Set() });
    assert.deepEqual(picks.map((p) => p.file), ["high.md", "mid.md", "low.md"]);
  });

  it("anti-repetição: arquivo da edição anterior nunca é escolhido pra NENHUM slot", () => {
    const picks = selectBoxesForSlots({ ranked, slotsToFill: [1, 2], excludeFiles: new Set(["high.md"]) });
    assert.deepEqual(picks.map((p) => p.file), ["mid.md", "low.md"]);
  });

  it("slot pinado/já-atribuído não entra na disputa (alreadyAssignedFiles)", () => {
    const picks = selectBoxesForSlots({
      ranked,
      slotsToFill: [1],
      excludeFiles: new Set(),
      alreadyAssignedFiles: new Set(["high.md"]),
    });
    assert.equal(picks[0].file, "mid.md");
  });

  it("pool esgotado: slot sem candidato disponível -> file null (cold start / #4626 self-review)", () => {
    const picks = selectBoxesForSlots({
      ranked: [ranked[0]],
      slotsToFill: [1, 2, 3],
      excludeFiles: new Set(),
    });
    assert.equal(picks[0].file, "high.md");
    assert.equal(picks[1].file, null);
    assert.equal(picks[2].file, null);
  });

  it("pool vazio (nenhum histórico ainda) -> todos os slots null, sem lançar", () => {
    const picks = selectBoxesForSlots({ ranked: [], slotsToFill: [1, 2, 3], excludeFiles: new Set() });
    assert.deepEqual(picks.map((p) => p.file), [null, null, null]);
  });

  it("tiebreak determinístico (score empatado) por ordem alfabética do arquivo", () => {
    const tied: RankedBox[] = [
      { file: "z.md", nome: "Z", editionsAppeared: 1, avgUniqueVerifiedClicks: 5, trend: null, score: 5 },
      { file: "a.md", nome: "A", editionsAppeared: 1, avgUniqueVerifiedClicks: 5, trend: null, score: 5 },
    ];
    const picks = selectBoxesForSlots({ ranked: tied, slotsToFill: [1], excludeFiles: new Set() });
    assert.equal(picks[0].file, "a.md");
  });
});

// ── loadBoxesDivulgacaoAutoConfig ─────────────────────────────────────────

function withTempConfig(content: unknown, fn: (path: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "select-boxes-cfg-"));
  const path = join(dir, "platform.config.json");
  writeFileSync(path, JSON.stringify(content));
  try {
    fn(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("loadBoxesDivulgacaoAutoConfig (#4626)", () => {
  it("chave ausente -> enabled:false (back-compat total, automação desligada por default)", () => {
    withTempConfig({}, (p) => {
      const cfg = loadBoxesDivulgacaoAutoConfig(p);
      assert.equal(cfg.enabled, false);
      assert.equal(cfg.pinnedSlots.size, 0);
    });
  });

  it("config corrompido (JSON inválido) -> default seguro, nunca lança", () => {
    const dir = mkdtempSync(join(tmpdir(), "select-boxes-cfg-bad-"));
    const path = join(dir, "platform.config.json");
    writeFileSync(path, "{not json");
    try {
      const cfg = loadBoxesDivulgacaoAutoConfig(path);
      assert.equal(cfg.enabled, false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("enabled:true + pinned_slots filtra valores fora de 1/2/3", () => {
    withTempConfig(
      { boxes_divulgacao_auto: { enabled: true, pinned_slots: [1, 0, 4, "x", 3] } },
      (p) => {
        const cfg = loadBoxesDivulgacaoAutoConfig(p);
        assert.equal(cfg.enabled, true);
        assert.deepEqual([...cfg.pinnedSlots].sort(), [1, 3]);
      },
    );
  });

  it("recent_window/prior_window/last_n customizados são lidos; inválidos caem no default", () => {
    withTempConfig(
      { boxes_divulgacao_auto: { enabled: true, recent_window: 5, prior_window: -1, last_n: 0 } },
      (p) => {
        const cfg = loadBoxesDivulgacaoAutoConfig(p);
        assert.equal(cfg.recentWindow, 5);
        assert.equal(cfg.priorWindow, 3, "valor inválido (-1) cai no default 3");
        assert.equal(cfg.lastN, 20, "valor inválido (0) cai no DEFAULT_LAST_N");
      },
    );
  });

  it("platform.config.json REAL do repo tem boxes_divulgacao_auto.enabled:true (#4626 — decisão do editor: automático por padrão)", () => {
    const repoRoot = join(import.meta.dirname ?? new URL(".", import.meta.url).pathname, "..");
    const cfg = loadBoxesDivulgacaoAutoConfig(join(repoRoot, "platform.config.json"));
    assert.equal(cfg.enabled, true);
  });
});

// ── resolveBoxesForEdition (integração, disco via fixtures) ──────────────

function setupEditionsFixture(): { dir: string; editionsDir: string; postsDir: string; snippetsDir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "select-boxes-e2e-"));
  const editionsDir = join(dir, "editions");
  const postsDir = join(dir, "posts");
  const snippetsDir = join(dir, "snippets");
  mkdirSync(editionsDir, { recursive: true });
  mkdirSync(postsDir, { recursive: true });
  mkdirSync(snippetsDir, { recursive: true });
  return { dir, editionsDir, postsDir, snippetsDir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function writeSnippet(snippetsDir: string, file: string, nome: string, url: string): void {
  writeFileSync(join(snippetsDir, file), `<!-- nome: ${nome} -->\n**📚 ${nome}**\n\n[Link](${url})`);
}

function writeEdition(editionsDir: string, aammdd: string, md: string): void {
  const editionDir = join(editionsDir, aammdd);
  mkdirSync(editionDir, { recursive: true });
  writeFileSync(join(editionDir, "02-reviewed.md"), md);
}

function writePost(postsDir: string, id: string, aammddIso: string, url: string, clicks: number): void {
  const publishDate = Math.floor(new Date(`${aammddIso}T09:00:00Z`).getTime() / 1000);
  writeFileSync(
    join(postsDir, `${id}.json`),
    JSON.stringify({
      id,
      publish_date: publishDate,
      stats: { clicks: [{ url, email: { verified_clicks: clicks, unique_verified_clicks: clicks } }] },
    }),
  );
}

describe("resolveBoxesForEdition (#4626, integração com fixtures)", () => {
  it("auto DESLIGADO (autoCfg.enabled=false) -> passthrough total, boxes_divulgacao usado tal como está — #6748: slot3 sempre null/disabled, mesmo configurado", () => {
    const { editionsDir, postsDir, snippetsDir, cleanup } = setupEditionsFixture();
    try {
      const { effective, selection } = resolveBoxesForEdition({
        aammdd: "260806",
        boxesCfg: { slot0: "", slot1: "a.md", slot2: "b.md", slot3: "c.md" },
        autoCfg: { enabled: false, pinnedSlots: new Set(), recentWindow: 3, priorWindow: 3, lastN: 20 },
        editionsDir,
        postsDir,
        snippetsDir,
      });
      // #6748: slot3 sai como `null` no efetivo, independente do "c.md"
      // configurado — slot 3 eliminado da rotação, revoga #3476.
      assert.deepEqual(effective, { slot0: "", slot1: "a.md", slot2: "b.md", slot3: null });
      assert.ok(selection.every((s) => s.mode === "disabled"));
      assert.equal(selection.find((s) => s.slot === 3)!.file, null, "slot3 nunca reporta arquivo, mesmo configurado");
    } finally {
      cleanup();
    }
  });

  it("cold start (0 edições no histórico) -> cede pro valor já configurado nos slots 1/2 auto, sem quebrar (#4626 self-review); slot3 continua sempre disabled/null (#6748)", () => {
    const { editionsDir, postsDir, snippetsDir, cleanup } = setupEditionsFixture();
    try {
      const { effective, selection } = resolveBoxesForEdition({
        aammdd: "260806",
        boxesCfg: { slot0: null, slot1: "existing1.md", slot2: "existing2.md", slot3: "existing3.md" },
        autoCfg: { enabled: true, pinnedSlots: new Set(), recentWindow: 3, priorWindow: 3, lastN: 20 },
        editionsDir,
        postsDir,
        snippetsDir,
      });
      assert.deepEqual(effective, {
        slot0: null,
        slot1: "existing1.md",
        slot2: "existing2.md",
        // #6748: nunca "existing3.md", mesmo configurado.
        slot3: null,
      });
      assert.ok(
        selection.filter((s) => s.slot === 1 || s.slot === 2).every((s) => s.mode === "fallback-no-candidates"),
      );
      assert.equal(selection.find((s) => s.slot === 3)!.mode, "disabled");
    } finally {
      cleanup();
    }
  });

  it("com histórico: seleciona por score, aplica anti-repetição vs. edição anterior, e respeita pinned_slots", () => {
    const { editionsDir, postsDir, snippetsDir, cleanup } = setupEditionsFixture();
    try {
      writeSnippet(snippetsDir, "winner.md", "Winner", "https://x.com/winner");
      writeSnippet(snippetsDir, "loser.md", "Loser", "https://x.com/loser");
      writeSnippet(snippetsDir, "pinned.md", "Pinned", "https://x.com/pinned");

      // Edição 260804: winner.md no slot1 com muitos cliques.
      writeEdition(
        editionsDir,
        "260804",
        `**DESTAQUE 1 | 🚀**\n\n[T](https://d1.com)\n\nbody\n\n---\n\n**📚 Winner**\n\n[Link](https://x.com/winner)\n\n---\n\n**DESTAQUE 2 | 🚀**\n\n[T](https://d2.com)\n\nbody`,
      );
      writePost(postsDir, "p804", "2026-08-04", "https://x.com/winner", 50);

      // Edição 260805 (imediatamente anterior à atual): winner.md de novo no
      // slot1 — anti-repetição deve EXCLUIR winner.md da edição 260806.
      writeEdition(
        editionsDir,
        "260805",
        `**DESTAQUE 1 | 🚀**\n\n[T](https://d1.com)\n\nbody\n\n---\n\n**📚 Winner**\n\n[Link](https://x.com/winner)\n\n---\n\n**DESTAQUE 2 | 🚀**\n\n[T](https://d2.com)\n\nbody`,
      );
      writePost(postsDir, "p805", "2026-08-05", "https://x.com/winner", 40);

      // loser.md apareceu 1x com poucos cliques (candidato mais fraco, mas
      // elegível já que winner.md está banido por anti-repetição).
      writeEdition(
        editionsDir,
        "260803",
        `**DESTAQUE 2 | 🚀**\n\n[T](https://d2.com)\n\nbody\n\n---\n\n**📚 Loser**\n\n[Link](https://x.com/loser)\n\n---\n\n**DESTAQUE 3 | 🚀**\n\n[T](https://d3.com)\n\nbody`,
      );
      writePost(postsDir, "p803", "2026-08-03", "https://x.com/loser", 3);

      const { effective, selection } = resolveBoxesForEdition({
        aammdd: "260806",
        // #6748: pinnedSlots inclui 3 de propósito — pin de slot 3 é ignorado
        // (slot 3 nunca mais participa, nem pinado).
        boxesCfg: { slot0: null, slot1: "current1.md", slot2: "current2.md", slot3: "pinned.md" },
        autoCfg: { enabled: true, pinnedSlots: new Set([3]), recentWindow: 3, priorWindow: 3, lastN: 20 },
        editionsDir,
        postsDir,
        snippetsDir,
      });

      // #6748: slot3 nunca participa — nem ranking, nem pin, mesmo com 3
      // presente em `pinned_slots`. Sempre "disabled" e `null`.
      assert.equal(effective.slot3, null);
      assert.equal(selection.find((s) => s.slot === 3)!.mode, "disabled");

      // slot1 auto: winner.md tem o score mais alto, mas foi usado na edição
      // IMEDIATAMENTE anterior (260805) -> banido. loser.md (única alternativa
      // com dado) deve ser escolhido.
      assert.equal(effective.slot1, "loser.md");
      const slot1Sel = selection.find((s) => s.slot === 1)!;
      assert.equal(slot1Sel.mode, "auto");
      assert.equal(slot1Sel.file, "loser.md");

      // slot2 auto: nenhum outro candidato sobrou (winner banido, loser já
      // usado no slot1 desta mesma edição) -> cede pro valor configurado.
      assert.equal(effective.slot2, "current2.md");
      assert.equal(selection.find((s) => s.slot === 2)!.mode, "fallback-no-candidates");
    } finally {
      cleanup();
    }
  });

  it("#6185: edição de origem Kit (kitBroadcastsDir) entra no ranking ao lado de edições Beehiiv", () => {
    const { editionsDir, postsDir, snippetsDir, cleanup } = setupEditionsFixture();
    const kitDir = join(postsDir, "..", "kit-broadcasts");
    mkdirSync(kitDir, { recursive: true });
    try {
      writeSnippet(snippetsDir, "kit-winner.md", "Kit Winner", "https://x.com/kit-winner");
      writeSnippet(snippetsDir, "beehiiv-loser.md", "Beehiiv Loser", "https://x.com/beehiiv-loser");

      // Edição de origem Kit, NÃO imediatamente anterior à atual (260820, vs.
      // atual 260827) — de propósito, pra não disparar a anti-repetição do
      // critério 3 (#4626), que bane só a box da edição IMEDIATAMENTE
      // anterior. Sem escritor real de cache Kit hoje, mas o contrato de
      // leitura (`clicks` anexado ao raw broadcast) já está pronto, ver
      // docstring de edition-cache-reader.ts.
      writeEdition(
        editionsDir,
        "260820",
        `**DESTAQUE 1 | 🚀**\n\n[T](https://d1.com)\n\nbody\n\n---\n\n**📚 Kit Winner**\n\n[Link](https://x.com/kit-winner)\n\n---\n\n**DESTAQUE 2 | 🚀**\n\n[T](https://d2.com)\n\nbody`,
      );
      writeFileSync(
        join(kitDir, "broadcast_1.json"),
        JSON.stringify({
          id: 1,
          subject: "Edição Kit",
          status: "completed",
          published_at: "2026-08-20T09:00:00Z",
          clicks: [
            { id: 1, url: "https://x.com/kit-winner", unique_clicks: 9, click_to_delivery_rate: 0.2, click_to_open_rate: 0.4 },
          ],
        }),
      );

      // Edição Beehiiv IMEDIATAMENTE anterior à atual, com clique bem menor
      // — cobre anti-repetição (banida por ser a edição anterior) E ranking
      // (perderia pra kit-winner mesmo sem a anti-repetição, já que 1 < 9).
      writeEdition(
        editionsDir,
        "260826",
        `**DESTAQUE 1 | 🚀**\n\n[T](https://d1.com)\n\nbody\n\n---\n\n**📚 Beehiiv Loser**\n\n[Link](https://x.com/beehiiv-loser)\n\n---\n\n**DESTAQUE 2 | 🚀**\n\n[T](https://d2.com)\n\nbody`,
      );
      writePost(postsDir, "p826", "2026-08-26", "https://x.com/beehiiv-loser", 1);

      const { effective, selection } = resolveBoxesForEdition({
        aammdd: "260827",
        boxesCfg: { slot0: null, slot1: "current1.md", slot2: null, slot3: null },
        autoCfg: { enabled: true, pinnedSlots: new Set(), recentWindow: 3, priorWindow: 3, lastN: 20 },
        editionsDir,
        postsDir,
        kitBroadcastsDir: kitDir,
        snippetsDir,
      });

      // kit-winner.md tem o score mais alto (9 cliques do Kit, via
      // unique_clicks — #6185 aproximação documentada) — sem isso ser lido,
      // o slot1 cederia pro valor já configurado (current1.md).
      assert.equal(effective.slot1, "kit-winner.md");
      assert.equal(selection.find((s) => s.slot === 1)!.mode, "auto");
    } finally {
      cleanup();
    }
  });
});
