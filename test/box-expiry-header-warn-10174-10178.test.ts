/**
 * #10174: validade (`expires:`) de caixa de divulgação — caso real: a caixa do
 * evento de sáb 17/10 pinada no slot 1 anunciaria, a partir da edição de
 * 18/10, um evento passado, sem nada acusar.
 *
 * #10178: header de comentário fora da 1ª linha — caso real 14/10/2026: um
 * `.md` começando com `---` antes do `<!-- -->` perdeu `alt:`/`titulo:` em
 * silêncio e o `---` vazou pro `02-reviewed.md`.
 *
 * Tudo em diretório temporário: `data/snippets/` é gitignored (#5227) e nunca
 * é tocado por teste.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  aammddToIsoDate,
  hasMisplacedHeaderComment,
  readSnippetExpiry,
} from "../scripts/lib/shared/snippet-header.ts";
import {
  checkFallbackEligibility,
  resolveBoxesForEdition,
  type BoxesDivulgacaoAutoConfig,
} from "../scripts/select-boxes-by-clicks.ts";
import { parseSnippetContent } from "../scripts/box-click-report.ts";
import { loadDivulgacaoSnippet } from "../scripts/stitch-newsletter.ts";
import { checkBoxDivulgacaoExpiry, STAGE_4_RULES } from "../scripts/lib/invariant-checks/stage-4.ts";
import { STAGE_2_RULES } from "../scripts/lib/invariant-checks/stage-2.ts";
import { computeBoxWarnings, listBoxes } from "../scripts/studio-ui/studio-boxes.ts";

const EVENTO = `<!--
nome: Agente de IA em uma hora (17/10)
expires: 2026-10-17
-->

**📣 Agente de IA: um mês em uma hora**

[Quero participar](https://diar.ia.br/evento/agente-ia)`;

const LIVROS = `<!--
nome: Livros
-->

**📚 Livros sobre IA**

[Ver livros](https://diar.ia.br/livros)`;

function auto(pinned: number[], enabled = true): BoxesDivulgacaoAutoConfig {
  return { enabled, pinnedSlots: new Set(pinned as (1 | 2 | 3)[]), recentWindow: 3, priorWindow: 3, lastN: 20 };
}

function fixture(): { dir: string; editionsDir: string; postsDir: string; snippetsDir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "box-expiry-10174-"));
  const editionsDir = join(dir, "editions");
  const postsDir = join(dir, "posts");
  const snippetsDir = join(dir, "data", "snippets");
  for (const d of [editionsDir, postsDir, snippetsDir]) mkdirSync(d, { recursive: true });
  return { dir, editionsDir, postsDir, snippetsDir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function silenceStderr<T>(fn: () => T): { result: T; stderr: string } {
  const orig = process.stderr.write.bind(process.stderr);
  let buf = "";
  (process.stderr as unknown as { write: (s: string) => boolean }).write = (s: string) => {
    buf += s;
    return true;
  };
  try {
    return { result: fn(), stderr: buf };
  } finally {
    process.stderr.write = orig;
  }
}

describe("readSnippetExpiry / aammddToIsoDate (#10174)", () => {
  it("expires é o último dia válido, inclusive — edição 261017 ainda sai, 261018 não", () => {
    assert.deepEqual(readSnippetExpiry(EVENTO, "2026-10-17"), { status: "valid", expires: "2026-10-17", daysLeft: 0 });
    assert.deepEqual(readSnippetExpiry(EVENTO, "2026-10-18"), { status: "expired", expires: "2026-10-17", daysLeft: -1 });
    assert.deepEqual(readSnippetExpiry(EVENTO, "2026-10-14"), { status: "valid", expires: "2026-10-17", daysLeft: 3 });
  });

  it("sem expires → none; data malformada ou impossível → invalid (nunca expired)", () => {
    assert.deepEqual(readSnippetExpiry(LIVROS, "2026-10-18"), { status: "none" });
    assert.equal(readSnippetExpiry("<!--\nexpires: 17/10/2026\n-->\nx", "2026-10-18").status, "invalid");
    assert.equal(readSnippetExpiry("<!--\nexpires: 2026-02-30\n-->\nx", "2026-10-18").status, "invalid");
  });

  it("aammddToIsoDate aceita só AAMMDD de data válida", () => {
    assert.equal(aammddToIsoDate("261018"), "2026-10-18");
    assert.equal(aammddToIsoDate("261318"), null);
    assert.equal(aammddToIsoDate("2610"), null);
  });

  it("parseSnippetContent carrega o expires cru", () => {
    assert.equal(parseSnippetContent("e.md", EVENTO).expires, "2026-10-17");
    assert.equal(parseSnippetContent("l.md", LIVROS).expires, null);
  });
});

describe("resolveBoxesForEdition pula caixa vencida (#10174)", () => {
  it("cenário real: evento pinado no slot 1 — 261017 mantém, 261018 tira (sem candidato → slot vazio)", () => {
    const { editionsDir, postsDir, snippetsDir, cleanup } = fixture();
    try {
      writeFileSync(join(snippetsDir, "agente-ia-um-mes-em-uma-hora.md"), EVENTO);
      writeFileSync(join(snippetsDir, "livros-divulgacao.md"), LIVROS);
      const boxesCfg = { slot0: "", slot1: "agente-ia-um-mes-em-uma-hora.md", slot2: "livros-divulgacao.md", slot3: null };
      const opts = { boxesCfg, autoCfg: auto([1, 2]), editionsDir, postsDir, snippetsDir };

      const before = resolveBoxesForEdition({ ...opts, aammdd: "261017" });
      assert.equal(before.effective.slot1, "agente-ia-um-mes-em-uma-hora.md");
      assert.equal(before.selection.find((s) => s.slot === 1)!.mode, "pinned");

      const { result: after, stderr } = silenceStderr(() => resolveBoxesForEdition({ ...opts, aammdd: "261018" }));
      assert.equal(after.effective.slot1, null, "caixa vencida nunca chega ao stitch");
      assert.equal(after.effective.slot2, "livros-divulgacao.md", "slot pinado válido segue intacto");
      const rec1 = after.selection.find((s) => s.slot === 1)!;
      assert.equal(rec1.mode, "fallback-ineligible");
      assert.equal(rec1.rejectedFile, "agente-ia-um-mes-em-uma-hora.md");
      assert.equal(rec1.rejectReason, "expirado");
      assert.match(stderr, /expirou \(expires: 2026-10-17, edição 2026-10-18\)/);
    } finally {
      cleanup();
    }
  });

  it("pin vencido com candidato automático disponível → slot recebe a seleção automática", () => {
    const { editionsDir, postsDir, snippetsDir, cleanup } = fixture();
    try {
      writeFileSync(join(snippetsDir, "evento.md"), EVENTO);
      writeFileSync(join(snippetsDir, "livros.md"), LIVROS);
      // histórico: livros apareceu numa edição anterior (não a imediatamente
      // anterior, 261017, que sai sem caixa — anti-repetição #4626) com cliques
      const prev = join(editionsDir, "261017");
      mkdirSync(prev, { recursive: true });
      writeFileSync(join(prev, "02-reviewed.md"), "**DESTAQUE 1 | 🚀**\n\n[T](https://d1.com)\n\nbody\n\n---\n\n**DESTAQUE 2 | 🚀**\n\n[T](https://d2.com)\n\nbody");
      const ed = join(editionsDir, "261010");
      mkdirSync(ed, { recursive: true });
      writeFileSync(
        join(ed, "02-reviewed.md"),
        "**DESTAQUE 1 | 🚀**\n\n[T](https://d1.com)\n\nbody\n\n---\n\n**📚 Livros sobre IA**\n\n[Ver livros](https://diar.ia.br/livros)\n\n---\n\n**DESTAQUE 2 | 🚀**\n\n[T](https://d2.com)\n\nbody",
      );
      writeFileSync(
        join(postsDir, "p1.json"),
        JSON.stringify({
          id: "p1",
          publish_date: Math.floor(Date.parse("2026-10-10T09:00:00Z") / 1000),
          stats: { clicks: [{ url: "https://diar.ia.br/livros", email: { verified_clicks: 7, unique_verified_clicks: 7 } }] },
        }),
      );
      const { result } = silenceStderr(() =>
        resolveBoxesForEdition({
          aammdd: "261018",
          boxesCfg: { slot0: null, slot1: "evento.md", slot2: null, slot3: null },
          autoCfg: auto([1]),
          editionsDir,
          postsDir,
          snippetsDir,
          destaqueCount: 2,
        }),
      );
      assert.equal(result.effective.slot1, "livros.md");
      const rec1 = result.selection.find((s) => s.slot === 1)!;
      assert.equal(rec1.mode, "auto");
      assert.equal(rec1.rejectedFile, "evento.md");
      assert.equal(rec1.rejectReason, "expirado");
    } finally {
      cleanup();
    }
  });

  it("caixa vencida nunca é candidata do ranking, mesmo com cliques", () => {
    const { editionsDir, postsDir, snippetsDir, cleanup } = fixture();
    try {
      writeFileSync(join(snippetsDir, "evento.md"), EVENTO);
      // 261017 (imediatamente anterior) sai sem caixa — sem ela a anti-repetição
      // #4626 já excluiria evento.md e o teste não discriminaria o filtro de
      // expiração do ranking.
      const prev = join(editionsDir, "261017");
      mkdirSync(prev, { recursive: true });
      writeFileSync(join(prev, "02-reviewed.md"), "**DESTAQUE 1 | 🚀**\n\n[T](https://d1.com)\n\nbody\n\n---\n\n**DESTAQUE 2 | 🚀**\n\n[T](https://d2.com)\n\nbody");
      const ed = join(editionsDir, "261010");
      mkdirSync(ed, { recursive: true });
      writeFileSync(
        join(ed, "02-reviewed.md"),
        "**DESTAQUE 1 | 🚀**\n\n[T](https://d1.com)\n\nbody\n\n---\n\n**📣 Agente de IA: um mês em uma hora**\n\n[Quero participar](https://diar.ia.br/evento/agente-ia)\n\n---\n\n**DESTAQUE 2 | 🚀**\n\n[T](https://d2.com)\n\nbody",
      );
      writeFileSync(
        join(postsDir, "p1.json"),
        JSON.stringify({
          id: "p1",
          publish_date: Math.floor(Date.parse("2026-10-10T09:00:00Z") / 1000),
          stats: { clicks: [{ url: "https://diar.ia.br/evento/agente-ia", email: { verified_clicks: 50, unique_verified_clicks: 50 } }] },
        }),
      );
      const { result } = silenceStderr(() =>
        resolveBoxesForEdition({
          aammdd: "261018",
          boxesCfg: { slot0: null, slot1: "outro.md", slot2: null, slot3: null },
          autoCfg: auto([]),
          editionsDir,
          postsDir,
          snippetsDir,
          destaqueCount: 2,
        }),
      );
      assert.notEqual(result.effective.slot1, "evento.md");
    } finally {
      cleanup();
    }
  });

  it("automação desligada → slot com caixa vencida sai vazio; slot 0 vencido também", () => {
    const { editionsDir, postsDir, snippetsDir, cleanup } = fixture();
    try {
      writeFileSync(join(snippetsDir, "evento.md"), EVENTO);
      writeFileSync(join(snippetsDir, "livros.md"), LIVROS);
      const { result } = silenceStderr(() =>
        resolveBoxesForEdition({
          aammdd: "261020",
          boxesCfg: { slot0: "evento.md", slot1: "evento.md", slot2: "livros.md", slot3: null },
          autoCfg: auto([], false),
          editionsDir,
          postsDir,
          snippetsDir,
        }),
      );
      assert.equal(result.effective.slot0, null);
      assert.equal(result.effective.slot1, null);
      assert.equal(result.effective.slot2, "livros.md");
      const rec1 = result.selection.find((s) => s.slot === 1)!;
      assert.equal(rec1.mode, "disabled");
      assert.equal(rec1.rejectReason, "expirado");
    } finally {
      cleanup();
    }
  });

  it("checkFallbackEligibility recusa por expirado só com data de edição", () => {
    const snippetByFile = new Map([["evento.md", parseSnippetContent("evento.md", EVENTO)]]);
    const base = { file: "evento.md", snippetByFile, assignedFiles: new Set<string>() };
    assert.equal(checkFallbackEligibility(base), null, "sem editionIsoDate não há checagem (back-compat)");
    assert.equal(checkFallbackEligibility({ ...base, editionIsoDate: "2026-10-18" }), "expirado");
    assert.equal(checkFallbackEligibility({ ...base, editionIsoDate: "2026-10-17" }), null);
  });
});

describe("invariante box-divulgacao-expiry (#10174, Stage 2 e 4)", () => {
  function setup(slot1Content: string, pinned: number[] = [1, 2]): { root: string; editionsDir: string; cleanup: () => void } {
    const root = mkdtempSync(join(tmpdir(), "box-expiry-inv-"));
    mkdirSync(join(root, "data", "snippets"), { recursive: true });
    writeFileSync(join(root, "data", "snippets", "evento.md"), slot1Content);
    writeFileSync(join(root, "data", "snippets", "livros.md"), LIVROS);
    writeFileSync(
      join(root, "platform.config.json"),
      JSON.stringify({
        boxes_divulgacao: { slot0: "", slot1: "evento.md", slot2: "livros.md", slot3: null },
        boxes_divulgacao_auto: { enabled: true, pinned_slots: pinned },
      }),
    );
    const editionsDir = join(root, "editions");
    return { root, editionsDir, cleanup: () => rmSync(root, { recursive: true, force: true }) };
  }

  it("slot pinado com caixa expirada → warning nomeando caixa, slot e datas", () => {
    const { root, editionsDir, cleanup } = setup(EVENTO);
    try {
      const v = checkBoxDivulgacaoExpiry(join(editionsDir, "261018"), root);
      assert.equal(v.length, 1);
      assert.equal(v[0].rule, "box-divulgacao-expiry");
      assert.equal(v[0].severity, "warning");
      assert.match(v[0].message, /evento\.md/);
      assert.match(v[0].message, /slot1 \(pinado\)/);
      assert.match(v[0].message, /expirada: expires: 2026-10-17, edição 2026-10-18/);
    } finally {
      cleanup();
    }
  });

  it("expira em N dias (≤3) avisa; longe da data ou sem expires não avisa", () => {
    const { root, editionsDir, cleanup } = setup(EVENTO);
    try {
      assert.match(checkBoxDivulgacaoExpiry(join(editionsDir, "261015"), root)[0].message, /expira em 2 dias/);
      assert.match(checkBoxDivulgacaoExpiry(join(editionsDir, "261017"), root)[0].message, /expira hoje/);
      assert.deepEqual(checkBoxDivulgacaoExpiry(join(editionsDir, "261010"), root), []);
    } finally {
      cleanup();
    }
  });

  it("expires malformado → warning de data inválida", () => {
    const { root, editionsDir, cleanup } = setup("<!--\nexpires: sábado\n-->\n\n**📣 X**\n\n[x](https://x.com)");
    try {
      const v = checkBoxDivulgacaoExpiry(join(editionsDir, "261018"), root);
      assert.equal(v.length, 1);
      assert.match(v[0].message, /não é uma data AAAA-MM-DD/);
    } finally {
      cleanup();
    }
  });

  it("editionDir sem AAMMDD → sem checagem", () => {
    const { root, cleanup } = setup(EVENTO);
    try {
      assert.deepEqual(checkBoxDivulgacaoExpiry(join(root, "qualquer"), root), []);
    } finally {
      cleanup();
    }
  });

  it("registrado no Stage 2 e no Stage 4", () => {
    assert.ok(STAGE_2_RULES.some((r) => r.id === "box-divulgacao-expiry" && r.stage === 2));
    assert.ok(STAGE_4_RULES.some((r) => r.id === "box-divulgacao-expiry" && r.stage === 4));
  });
});

describe("header de comentário fora da 1ª linha (#10178)", () => {
  const DESLOCADO = "---\n<!--\nnome: Caixa\nalt: Capa do livro\n-->\n\n**📚 Livros**\n\n[Ver](https://x.com/l)";

  it("hasMisplacedHeaderComment: `---` antes do comentário → true; header no topo ou sem comentário → false", () => {
    assert.equal(hasMisplacedHeaderComment(DESLOCADO), true);
    assert.equal(hasMisplacedHeaderComment(LIVROS), false);
    assert.equal(hasMisplacedHeaderComment("\n\n  <!-- nome: x -->\ncorpo"), false, "espaço antes do header é ok");
    assert.equal(hasMisplacedHeaderComment("**📚 Livros**\n\n[Ver](https://x.com)"), false);
  });

  it("loadDivulgacaoSnippet avisa (console.warn) e segue carregando o conteúdo", () => {
    const root = mkdtempSync(join(tmpdir(), "box-header-10178-"));
    mkdirSync(join(root, "data", "snippets"), { recursive: true });
    writeFileSync(join(root, "data", "snippets", "deslocado.md"), DESLOCADO);
    writeFileSync(join(root, "data", "snippets", "ok.md"), LIVROS);
    const orig = console.warn;
    const warns: string[] = [];
    console.warn = (...args: unknown[]) => {
      warns.push(args.map(String).join(" "));
    };
    try {
      assert.ok(loadDivulgacaoSnippet("deslocado.md", root));
      assert.equal(warns.filter((w) => w.includes("deslocado.md") && w.includes("1ª linha")).length, 1);
      warns.length = 0;
      assert.ok(loadDivulgacaoSnippet("ok.md", root));
      assert.equal(warns.length, 0, "header no topo não gera aviso");
    } finally {
      console.warn = orig;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("slot apontando pra arquivo ausente continua erro duro (#5227, não relaxado)", () => {
    const root = mkdtempSync(join(tmpdir(), "box-header-10178-missing-"));
    mkdirSync(join(root, "data", "snippets"), { recursive: true });
    try {
      assert.throws(() => loadDivulgacaoSnippet("nao-existe.md", root), /não existe/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("painel Caixas: avisos no card (#10174, #10178)", () => {
  it("computeBoxWarnings: header deslocado, expira em N dias, expirada, inválida", () => {
    assert.match(computeBoxWarnings("d.md", "---\n<!-- nome: x -->\ncorpo", "2026-10-14")[0], /1ª linha/);
    assert.match(computeBoxWarnings("e.md", EVENTO, "2026-10-15")[0], /Expira em 2 dias/);
    assert.match(computeBoxWarnings("e.md", EVENTO, "2026-10-16")[0], /Expira em 1 dia \(/);
    assert.match(computeBoxWarnings("e.md", EVENTO, "2026-10-18")[0], /Expirada em 2026-10-17/);
    assert.deepEqual(computeBoxWarnings("e.md", EVENTO, "2026-10-01"), []);
    assert.deepEqual(computeBoxWarnings("l.md", LIVROS, "2026-10-18"), []);
  });

  it("listBoxes devolve warnings por caixa (data de referência = hoje em BRT)", () => {
    const root = mkdtempSync(join(tmpdir(), "box-panel-10174-"));
    mkdirSync(join(root, "data", "snippets"), { recursive: true });
    writeFileSync(join(root, "data", "snippets", "evento.md"), EVENTO);
    writeFileSync(join(root, "data", "snippets", "livros.md"), LIVROS);
    writeFileSync(join(root, "platform.config.json"), JSON.stringify({ boxes_divulgacao: { slot1: "evento.md" } }));
    try {
      // 02:00 UTC de 18/10 ainda é 17/10 em BRT → "expira hoje", não "expirada".
      const boxes = listBoxes(root, new Date("2026-10-18T02:00:00Z"));
      const ev = boxes.find((b) => b.slug === "evento.md")!;
      assert.equal(ev.warnings.length, 1);
      assert.match(ev.warnings[0], /Expira hoje/);
      assert.deepEqual(boxes.find((b) => b.slug === "livros.md")!.warnings, []);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
