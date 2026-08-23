/**
 * test/derive-editor-requests.test.ts (#5731)
 *
 * Cobre scripts/derive-editor-requests.ts — derivação determinística de
 * pedidos editoriais a partir do diff entre snapshots (pós-Stage 2 vs
 * estado no gate do Stage 4/6), em vez de depender de log manual
 * (log-editor-request.ts, #4966) que quase nunca rodava na prática.
 *
 * Padrão de teste espelha test/log-editor-request.test.ts: CLI via
 * spawnSync + --editions-dir para isolamento.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const PROJECT_ROOT = join(import.meta.dirname, "..");
const SCRIPT_PATH = join(PROJECT_ROOT, "scripts", "derive-editor-requests.ts");

function runCli(args: string[]) {
  return spawnSync(process.execPath, ["--import", "tsx", SCRIPT_PATH, ...args], {
    cwd: PROJECT_ROOT,
    encoding: "utf8",
    timeout: 15000,
  });
}

function readEntries(editionDir: string): Array<Record<string, unknown>> {
  const outPath = join(editionDir, "_internal", "editor-requests.jsonl");
  if (!existsSync(outPath)) return [];
  return readFileSync(outPath, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

/** 01-approved.json com 2 highlights, URLs distintas por posição (d1/d2). */
function approvedJson(urlD1: string, titleD1: string, urlD2 = "https://example.com/fixo-d2"): string {
  return JSON.stringify({
    highlights: [
      { article: { url: urlD1, title: titleD1 } },
      { article: { url: urlD2, title: "Fixo D2" } },
    ],
  });
}

describe("derive-editor-requests.ts (#5731)", () => {
  it("snapshot-stage2 grava o snapshot corretamente", () => {
    const dir = mkdtempSync(join(tmpdir(), "derive-snap-"));
    try {
      const editionDir = join(dir, "260811");
      mkdirSync(editionDir, { recursive: true });
      const content = "**DESTAQUE 1 | 🚀 LANÇAMENTO**\nconteúdo original\n";
      writeFileSync(join(editionDir, "02-reviewed.md"), content, "utf8");

      const r = runCli(["snapshot-stage2", "--edition", "260811", "--editions-dir", dir]);
      assert.equal(r.status, 0, r.stderr);

      const snapPath = join(
        editionDir,
        "_internal",
        "editor-request-snapshots",
        "stage2-post-gate",
        "02-reviewed.md",
      );
      assert.ok(existsSync(snapPath), "snapshot deveria existir em disco");
      assert.equal(readFileSync(snapPath, "utf8"), content);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("diff entre dois snapshots idênticos não gera pedido nenhum", () => {
    const dir = mkdtempSync(join(tmpdir(), "derive-noop-"));
    try {
      const editionDir = join(dir, "260811");
      mkdirSync(editionDir, { recursive: true });
      writeFileSync(join(editionDir, "02-reviewed.md"), "**DESTAQUE 1 | 🚀 LANÇAMENTO**\nsem mudança\n", "utf8");

      assert.equal(runCli(["snapshot-stage2", "--edition", "260811", "--editions-dir", dir]).status, 0);

      const r = runCli(["derive-stage4", "--edition", "260811", "--editions-dir", dir]);
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /0 pedidos derivados/);
      assert.deepEqual(readEntries(editionDir), []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("diff com troca de destaque em 01-approved.json é classificado como destaque-swap, source derived", () => {
    const dir = mkdtempSync(join(tmpdir(), "derive-swap-"));
    try {
      const editionDir = join(dir, "260811");
      const internalDir = join(editionDir, "_internal");
      mkdirSync(internalDir, { recursive: true });
      writeFileSync(
        join(internalDir, "01-approved.json"),
        approvedJson("https://example.com/artigo-antigo", "Artigo antigo"),
        "utf8",
      );

      assert.equal(runCli(["snapshot-stage2", "--edition", "260811", "--editions-dir", dir]).status, 0);

      // Editor troca o D1 por outro artigo — mesma posição, URL diferente.
      writeFileSync(
        join(internalDir, "01-approved.json"),
        approvedJson("https://example.com/artigo-novo", "Artigo novo"),
        "utf8",
      );

      const r = runCli(["derive-stage4", "--edition", "260811", "--editions-dir", dir]);
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /1 pedidos derivados/);

      const entries = readEntries(editionDir);
      assert.equal(entries.length, 1);
      assert.equal(entries[0].request_type, "destaque-swap");
      assert.equal(entries[0].target, "d1");
      assert.equal(entries[0].source, "derived");
      assert.equal(entries[0].edition, "260811");
      assert.equal(entries[0].stage, 4);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("diff com mudança de título em 02-reviewed.md é classificado como title-choice, source derived", () => {
    const dir = mkdtempSync(join(tmpdir(), "derive-title-"));
    try {
      const editionDir = join(dir, "260811");
      mkdirSync(editionDir, { recursive: true });
      const build = (title: string) =>
        [
          "**DESTAQUE 1 | 🚀 LANÇAMENTO**",
          `**[${title}](https://example.com/mesmo-link)**`,
          "Por que isso importa: motivo estável, idêntico nas duas versões.",
          "https://example.com/mesmo-link",
          "",
        ].join("\n");

      writeFileSync(join(editionDir, "02-reviewed.md"), build("Título original aqui hoje"), "utf8");

      assert.equal(runCli(["snapshot-stage2", "--edition", "260811", "--editions-dir", dir]).status, 0);

      // Só o título muda — URL e "Por que isso importa" ficam idênticos.
      writeFileSync(join(editionDir, "02-reviewed.md"), build("Novo título mais objetivo"), "utf8");

      const r = runCli(["derive-stage4", "--edition", "260811", "--editions-dir", dir]);
      assert.equal(r.status, 0, r.stderr);

      const entries = readEntries(editionDir);
      assert.equal(entries.length, 1);
      assert.equal(entries[0].request_type, "title-choice");
      assert.equal(entries[0].target, "d1");
      assert.equal(entries[0].source, "derived");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("derive-stage4 refresca o checkpoint — derive-stage6 só vê mudanças NOVAS pós-Stage 4, sem duplicar", () => {
    const dir = mkdtempSync(join(tmpdir(), "derive-checkpoint-"));
    try {
      const editionDir = join(dir, "260811");
      const internalDir = join(editionDir, "_internal");
      mkdirSync(internalDir, { recursive: true });
      writeFileSync(join(internalDir, "01-approved.json"), approvedJson("https://example.com/v1", "V1"), "utf8");

      assert.equal(runCli(["snapshot-stage2", "--edition", "260811", "--editions-dir", dir]).status, 0);

      // Mudança 1, detectada e logada no gate do Stage 4.
      writeFileSync(join(internalDir, "01-approved.json"), approvedJson("https://example.com/v2", "V2"), "utf8");
      const r4 = runCli(["derive-stage4", "--edition", "260811", "--editions-dir", dir]);
      assert.equal(r4.status, 0, r4.stderr);
      assert.equal(readEntries(editionDir).length, 1, "Stage 4 loga a 1ª troca");

      // Sem mudança adicional: Stage 6 não deveria re-derivar a mesma troca.
      const r6NoChange = runCli(["derive-stage6", "--edition", "260811", "--editions-dir", dir]);
      assert.equal(r6NoChange.status, 0, r6NoChange.stderr);
      assert.match(r6NoChange.stdout, /0 pedidos derivados/);
      assert.equal(readEntries(editionDir).length, 1, "sem duplicar a troca já logada pelo Stage 4");

      // Mudança 2, feita DEPOIS da aprovação do gate Stage 4 (ex: edição via Studio durante Stage 5).
      writeFileSync(join(internalDir, "01-approved.json"), approvedJson("https://example.com/v3", "V3"), "utf8");
      const r6 = runCli(["derive-stage6", "--edition", "260811", "--editions-dir", dir]);
      assert.equal(r6.status, 0, r6.stderr);
      assert.match(r6.stdout, /1 pedidos derivados/);

      const entries = readEntries(editionDir);
      assert.equal(entries.length, 2, "Stage 6 loga só a mudança nova, sem duplicar a do Stage 4");
      assert.equal(entries[1].stage, 6);
      assert.equal(entries[1].source, "derived");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("#5782 — mudança real entre os 2 HTMLs do snapshot stage4-pre-render e o estado atual gera ao menos 1 pedido derivado", () => {
    const dir = mkdtempSync(join(tmpdir(), "derive-html-"));
    try {
      const editionDir = join(dir, "260811");
      const internalDir = join(editionDir, "_internal");
      mkdirSync(internalDir, { recursive: true });
      writeFileSync(join(internalDir, "newsletter-final.html"), "<html><body>V1</body></html>", "utf8");
      writeFileSync(join(internalDir, "social-preview.html"), "<html><body>Social V1</body></html>", "utf8");

      assert.equal(runCli(["snapshot-stage4", "--edition", "260811", "--editions-dir", dir]).status, 0);

      // Simula re-render disparado por "ajustar" em §4d.1 — HTML final muda antes do gate ser aprovado.
      writeFileSync(join(internalDir, "newsletter-final.html"), "<html><body>V2 (ajustado)</body></html>", "utf8");

      const r = runCli(["derive-stage4", "--edition", "260811", "--editions-dir", dir]);
      assert.equal(r.status, 0, r.stderr);

      const entries = readEntries(editionDir);
      assert.equal(entries.length, 1, "mudança no newsletter-final.html deveria gerar 1 pedido derivado");
      assert.equal(entries[0].request_type, "other");
      assert.equal(entries[0].target, "newsletter");
      assert.equal(entries[0].source, "derived");
      assert.equal(entries[0].stage, 4);
      assert.equal((entries[0].context as Record<string, unknown>).subtype, "html-final-changed");

      // social-preview.html ficou idêntico — não deveria gerar pedido adicional.
      assert.equal(entries.filter((e) => e.target === "social").length, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("#5782 — snapshot stage4-pre-render idêntico ao estado atual não gera pedido nenhum", () => {
    const dir = mkdtempSync(join(tmpdir(), "derive-html-noop-"));
    try {
      const editionDir = join(dir, "260811");
      const internalDir = join(editionDir, "_internal");
      mkdirSync(internalDir, { recursive: true });
      const html = "<html><body>Sem mudança</body></html>";
      writeFileSync(join(internalDir, "newsletter-final.html"), html, "utf8");
      writeFileSync(join(internalDir, "social-preview.html"), html, "utf8");

      assert.equal(runCli(["snapshot-stage4", "--edition", "260811", "--editions-dir", dir]).status, 0);

      const r = runCli(["derive-stage4", "--edition", "260811", "--editions-dir", dir]);
      assert.equal(r.status, 0, r.stderr);
      assert.deepEqual(readEntries(editionDir), []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejeita comando desconhecido / edição inexistente", () => {
    const dir = mkdtempSync(join(tmpdir(), "derive-errs-"));
    try {
      const rNoDir = runCli(["derive-stage4", "--edition", "999999", "--editions-dir", dir]);
      assert.equal(rNoDir.status, 2);
      assert.match(rNoDir.stderr, /não existe/);

      const editionDir = join(dir, "260811");
      mkdirSync(editionDir, { recursive: true });
      const rBadCmd = runCli(["bogus-command", "--edition", "260811", "--editions-dir", dir]);
      assert.equal(rBadCmd.status, 2);
      assert.match(rBadCmd.stderr, /Comando desconhecido/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  // --- Movimentação entre buckets do pool (follow-up do #5731) ---
  //
  // Pedido que o editor identificou (23/08/2026) como o mais frequente dele:
  // mover item entre Use Melhor / Lançamentos / Radar. Antes destes testes,
  // `classifyApprovedDiff` só olhava `highlights` — o movimento não derivava
  // NADA, e logado à mão virava `other`, que nunca conta na recorrência.

  /** 01-approved.json com highlights fixos + buckets do pool parametrizáveis. */
  function approvedWithPool(pool: {
    lancamento?: Array<{ url: string; title: string }>;
    radar?: Array<{ url: string; title: string }>;
    use_melhor?: Array<{ url: string; title: string }>;
    video?: Array<{ url: string; title: string }>;
    highlights?: Array<{ url: string; title: string }>;
  }): string {
    return JSON.stringify({
      highlights: (pool.highlights ?? [{ url: "https://example.com/d1", title: "D1" }]).map((a) => ({
        article: a,
        url: a.url,
      })),
      lancamento: pool.lancamento ?? [],
      radar: pool.radar ?? [],
      use_melhor: pool.use_melhor ?? [],
      video: pool.video ?? [],
    });
  }

  /** Roda snapshot → mutação → derive-stage4 e devolve as entradas geradas. */
  function deriveFromApproved(before: string, after: string): Array<Record<string, unknown>> {
    const dir = mkdtempSync(join(tmpdir(), "derive-pool-"));
    try {
      const editionDir = join(dir, "260811");
      const internalDir = join(editionDir, "_internal");
      mkdirSync(internalDir, { recursive: true });
      const approvedPath = join(internalDir, "01-approved.json");

      writeFileSync(approvedPath, before, "utf8");
      assert.equal(runCli(["snapshot-stage2", "--edition", "260811", "--editions-dir", dir]).status, 0);
      writeFileSync(approvedPath, after, "utf8");

      const r = runCli(["derive-stage4", "--edition", "260811", "--editions-dir", dir]);
      assert.equal(r.status, 0, r.stderr);
      return readEntries(editionDir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  const ITEM_A = { url: "https://example.com/a", title: "Item A" };
  const ITEM_B = { url: "https://example.com/b", title: "Item B" };

  it("item movido de LANÇAMENTOS para RADAR vira bucket-move com target de destino", () => {
    const entries = deriveFromApproved(
      approvedWithPool({ lancamento: [ITEM_A] }),
      approvedWithPool({ radar: [ITEM_A] }),
    );

    const moves = entries.filter((e) => e.request_type === "bucket-move");
    assert.equal(moves.length, 1, JSON.stringify(entries));
    assert.equal(moves[0].target, "radar");
    assert.equal(moves[0].source, "derived");
    assert.deepEqual(moves[0].context, {
      url: ITEM_A.url,
      from_bucket: "lancamento",
      to_bucket: "radar",
    });
    // Não pode sobrar pool-cut/pool-add pro mesmo item — seria contar 2×.
    assert.equal(entries.filter((e) => e.request_type === "pool-cut").length, 0);
    assert.equal(entries.filter((e) => e.request_type === "pool-add").length, 0);
  });

  it("item movido de RADAR para USE MELHOR vira bucket-move (direção oposta)", () => {
    const entries = deriveFromApproved(
      approvedWithPool({ radar: [ITEM_A] }),
      approvedWithPool({ use_melhor: [ITEM_A] }),
    );

    const moves = entries.filter((e) => e.request_type === "bucket-move");
    assert.equal(moves.length, 1, JSON.stringify(entries));
    assert.equal(moves[0].target, "use-melhor");
    assert.match(String(moves[0].description), /RADAR → USE MELHOR/);
  });

  it("item que sai do pool sem virar destaque vira pool-cut com o bucket de origem", () => {
    const entries = deriveFromApproved(
      approvedWithPool({ radar: [ITEM_A, ITEM_B] }),
      approvedWithPool({ radar: [ITEM_B] }),
    );

    const cuts = entries.filter((e) => e.request_type === "pool-cut");
    assert.equal(cuts.length, 1, JSON.stringify(entries));
    assert.equal(cuts[0].target, "radar");
    assert.equal((cuts[0].context as Record<string, unknown>).from_bucket, "radar");
  });

  it("item novo no pool vira pool-add", () => {
    const entries = deriveFromApproved(
      approvedWithPool({ radar: [ITEM_A] }),
      approvedWithPool({ radar: [ITEM_A], use_melhor: [ITEM_B] }),
    );

    const adds = entries.filter((e) => e.request_type === "pool-add");
    assert.equal(adds.length, 1, JSON.stringify(entries));
    assert.equal(adds[0].target, "use-melhor");
  });

  it("promoção pool→destaque NÃO vira pool-cut (já é reportada por destaque-swap)", () => {
    const before = approvedWithPool({
      highlights: [{ url: "https://example.com/d1-antigo", title: "D1 antigo" }],
      radar: [ITEM_A],
    });
    // Editor promove ITEM_A a D1; o D1 antigo sai da edição inteira.
    const after = approvedWithPool({ highlights: [ITEM_A], radar: [] });

    const entries = deriveFromApproved(before, after);
    assert.equal(
      entries.filter((e) => e.request_type === "pool-cut").length,
      0,
      "promoção não pode ser contada como corte de pool: " + JSON.stringify(entries),
    );
    assert.ok(
      entries.some((e) => String(e.request_type).startsWith("destaque-")),
      "promoção deveria continuar sendo reportada pelo caminho destaque-*",
    );
  });

  it("demoção destaque→pool NÃO vira pool-add (já é reportada por destaque-*)", () => {
    const before = approvedWithPool({ highlights: [ITEM_A], radar: [] });
    const after = approvedWithPool({
      highlights: [{ url: "https://example.com/d1-novo", title: "D1 novo" }],
      radar: [ITEM_A],
    });

    const entries = deriveFromApproved(before, after);
    assert.equal(
      entries.filter((e) => e.request_type === "pool-add").length,
      0,
      "demoção não pode ser contada como item novo no pool: " + JSON.stringify(entries),
    );
  });

  it("pool inalterado não gera entrada nenhuma", () => {
    const same = approvedWithPool({ lancamento: [ITEM_A], radar: [ITEM_B] });
    assert.deepEqual(deriveFromApproved(same, same), []);
  });
});
