/**
 * Regressão #9668 (título da fonte com ` | ` escapava do guard de título
 * provisório) e #9669 (marcador do provisório envelhecia após
 * `reorder-destaques.ts`). Ambos achados no review consolidado da PR #9666.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { applySwapToReviewedMd } from "../scripts/swap-destaque.ts";
import {
  checkTituloSubtituloNotProvisional,
  finalizeProvisionalTitulos,
  findSegmentRun,
  locateProvisionalTitulo,
  remapPendingTitulosForReorder,
  replaceTitleInTituloSubtitulo,
  sanitizeTituloSegment,
  serializePendingTitulos,
  toProvisionalTitulo,
  tituloPendingPath,
  type PendingTitulo,
} from "../scripts/lib/titulo-provisional.ts";

const PIPE_TITLE = "OpenAI DevDay | TechCrunch";
const PLACEHOLDER_RE = /\*\*DESTAQUE (\d) \| \[RASCUNHO PENDENTE — swap-destaque\]\*\*\n\n\*\*\[[^\]]+\]\(([^)]+)\)\*\*/;

function baseMd(radarTitle = PIPE_TITLE): string {
  return `TÍTULO

Titulo Um

SUBTÍTULO

Titulo Dois | Titulo Tres

---

**DESTAQUE 1 | 📦 PRODUTO**

**[Titulo Um](https://a.com/1)**

texto

---

**DESTAQUE 2 | 🔬 PESQUISA**

**[Titulo Dois](https://a.com/2)**

texto

---

**DESTAQUE 3 | 🔒 SEGURANÇA**

**[Titulo Tres](https://a.com/3)**

texto

---

**📡 RADAR**

**[${radarTitle}](https://b.com/x)**
desc

**[Outro](https://b.com/y)**
desc
`;
}

/** Simula o writer-destaque: troca o placeholder do D{N} por um bloco final. */
function integrateWriter(md: string, finalTitle: string): string {
  return md.replace(PLACEHOLDER_RE, (_m, n, url) => `**DESTAQUE ${n} | 🔬 PESQUISA**\n\n**[${finalTitle}](${url})**`);
}

function subtitleLine(md: string): string {
  const lines = md.split("\n");
  const i = lines.findIndex((l) => l.trim() === "SUBTÍTULO");
  return lines.slice(i + 1).find((l) => l.trim() !== "") ?? "";
}

function titleLine(md: string): string {
  const lines = md.split("\n");
  const i = lines.findIndex((l) => l.trim() === "TÍTULO");
  return lines.slice(i + 1).find((l) => l.trim() !== "") ?? "";
}

function withEdition(md: string, pending: PendingTitulo[], fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "titulo-prov-"));
  try {
    mkdirSync(join(dir, "_internal"), { recursive: true });
    writeFileSync(join(dir, "02-reviewed.md"), md);
    writeFileSync(tituloPendingPath(dir), serializePendingTitulos(pending));
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("#9668 — título da fonte com ' | '", () => {
  it("toProvisionalTitulo tira sufixo de veículo e nunca devolve '|'", () => {
    assert.equal(toProvisionalTitulo("Especialistas criticam IA no Brasil | G1"), "Especialistas criticam IA no Brasil");
    const short = toProvisionalTitulo(PIPE_TITLE); // prefixo curto demais pro strip
    assert.ok(!short.includes("|"), short);
    assert.equal(short, "OpenAI DevDay – TechCrunch");
    assert.equal(sanitizeTituloSegment(short), short, "idempotente");
  });

  it("findSegmentRun compara sequência de segmentos", () => {
    assert.equal(findSegmentRun(["Titulo Dois", "OpenAI DevDay", "TechCrunch"], PIPE_TITLE), 1);
    assert.equal(findSegmentRun(["OpenAI DevDay"], PIPE_TITLE), -1);
    assert.equal(findSegmentRun(["a", "b"], "b"), 1);
  });

  it("cenário do repro: swap no D2 deixa SUBTÍTULO com 2 segmentos e o marcador casando com o bloco", () => {
    const r = applySwapToReviewedMd(baseMd(), 2, PIPE_TITLE, "https://b.com/x");
    assert.equal(r.updates.titulo_subtitulo, "updated");
    const prov = r.updates.provisional_title;
    assert.ok(!prov.includes("|"));
    assert.equal(subtitleLine(r.md).split("|").length, 2, subtitleLine(r.md));
    assert.equal(locateProvisionalTitulo(r.md, prov), 2);

    // Antes do writer: invariante acusa o placeholder.
    withEdition(r.md, [{ position: 2, provisional_title: prov }], (dir) => {
      const v = checkTituloSubtituloNotProvisional(dir);
      assert.equal(v.length, 1);
      assert.match(v[0].message, /placeholder/);
    });

    // Writer integrado, finalize NÃO pode ser already_final (bug original).
    const fin = integrateWriter(r.md, "Titulo Final");
    withEdition(fin, [{ position: 2, provisional_title: prov }], (dir) => {
      assert.equal(checkTituloSubtituloNotProvisional(dir).length, 1, "invariante precisa acusar o provisório");
    });
    const out = finalizeProvisionalTitulos(fin, [{ position: 2, provisional_title: prov }]);
    assert.equal(out.finalized[0].status, "updated");
    assert.equal(subtitleLine(out.md), "Titulo Final | Titulo Tres");
    assert.ok(!out.md.includes("TechCrunch |") && !subtitleLine(out.md).includes("TechCrunch"));
  });

  it("marcador LEGADO (provisório cru com '|', gravado antes do fix) ainda é detectado e finalizado", () => {
    const legacy = integrateWriter(
      baseMd()
        .replace("Titulo Dois | Titulo Tres", `${PIPE_TITLE} | Titulo Tres`)
        .replace(
          "**DESTAQUE 2 | 🔬 PESQUISA**\n\n**[Titulo Dois](https://a.com/2)**",
          `**DESTAQUE 2 | [RASCUNHO PENDENTE — swap-destaque]**\n\n**[${PIPE_TITLE}](https://b.com/x)**`,
        ),
      "Titulo Final",
    );
    const entry = { position: 2 as const, provisional_title: PIPE_TITLE };
    withEdition(legacy, [entry], (dir) => {
      const v = checkTituloSubtituloNotProvisional(dir);
      assert.equal(v.length, 1);
      assert.match(v[0].message, /Titulo Final/);
    });
    const out = finalizeProvisionalTitulos(legacy, [entry]);
    assert.equal(out.finalized[0].status, "updated");
    assert.equal(subtitleLine(out.md), "Titulo Final | Titulo Tres");
  });

  it("replaceTitleInTituloSubtitulo nunca grava '|' dentro de um segmento novo", () => {
    const r = replaceTitleInTituloSubtitulo(baseMd(), "Titulo Dois", PIPE_TITLE, 2);
    assert.equal(subtitleLine(r.md).split("|").length, 2);
  });
});

describe("#9669 — marcador envelhece após reorder-destaques", () => {
  it("remapPendingTitulosForReorder segue o newOrder", () => {
    assert.deepEqual(remapPendingTitulosForReorder([{ position: 1, provisional_title: "P" }], [3, 2, 1]), [
      { position: 3, provisional_title: "P" },
    ]);
    assert.deepEqual(remapPendingTitulosForReorder([{ position: 2, provisional_title: "P" }], [2, 1, 3]), [
      { position: 1, provisional_title: "P" },
    ]);
    assert.deepEqual(remapPendingTitulosForReorder([{ position: 2, provisional_title: "P" }], [3, 1, 2]), [
      { position: 3, provisional_title: "P" },
    ]);
  });

  it("marcador com position desatualizada: invariante e finalize acham o provisório pela linha real", () => {
    // Swap no D1 → provisório "Kolibri Has Landed" no TÍTULO. Depois, D1↔D3:
    // o bloco re-derivado leva o provisório pro 2º segmento do SUBTÍTULO.
    const prov = "Kolibri Has Landed";
    const md = baseMd()
      .replace("TÍTULO\n\nTitulo Um", "TÍTULO\n\nTitulo Tres")
      .replace("Titulo Dois | Titulo Tres", `Titulo Dois | ${prov}`)
      .replace("**[Titulo Um](https://a.com/1)**", "**[Titulo Tres](https://a.com/3)**")
      .replace(
        "**DESTAQUE 3 | 🔒 SEGURANÇA**\n\n**[Titulo Tres](https://a.com/3)**",
        `**DESTAQUE 3 | [RASCUNHO PENDENTE — swap-destaque]**\n\n**[${prov}](https://k.com/1)**`,
      );
    const stale = { position: 1 as const, provisional_title: prov };
    assert.equal(locateProvisionalTitulo(md, prov), 3);

    withEdition(md, [stale], (dir) => {
      const v = checkTituloSubtituloNotProvisional(dir);
      assert.equal(v.length, 1, "o invariante não pode passar mudo");
      assert.match(v[0].message, /D3 ainda é o placeholder/);
    });

    const fin = integrateWriter(md, "Alemanha lança modelo aberto");
    withEdition(fin, [stale], (dir) => {
      assert.equal(checkTituloSubtituloNotProvisional(dir).length, 1);
    });
    const out = finalizeProvisionalTitulos(fin, [stale]);
    assert.equal(out.finalized[0].status, "updated");
    assert.equal(out.finalized[0].final_title, "Alemanha lança modelo aberto");
    assert.equal(subtitleLine(out.md), "Titulo Dois | Alemanha lança modelo aberto");
    assert.equal(titleLine(out.md), "Titulo Tres", "TÍTULO (D1) intocado — nada de usar o título do D1 errado");
  });

  it("CLI reorder-destaques remapeia o position do marcador", () => {
    const dir = mkdtempSync(join(tmpdir(), "reorder-titulo-prov-"));
    try {
      mkdirSync(join(dir, "_internal"), { recursive: true });
      writeFileSync(
        join(dir, "_internal", "01-approved-capped.json"),
        JSON.stringify({ highlights: [{}, {}, {}] }, null, 2),
      );
      const md = applySwapToReviewedMd(baseMd(), 1, "Kolibri Has Landed", "https://b.com/x").md;
      writeFileSync(join(dir, "02-reviewed.md"), md);
      writeFileSync(tituloPendingPath(dir), serializePendingTitulos([{ position: 1, provisional_title: "Kolibri Has Landed" }]));
      const projectRoot = join(import.meta.dirname, "..");
      const res = spawnSync(
        process.execPath,
        ["--import", "tsx", join(projectRoot, "scripts", "reorder-destaques.ts"), "--edition", "999999", "--edition-dir", dir, "--new-order", "3,2,1"],
        { cwd: projectRoot, encoding: "utf8" },
      );
      assert.equal(res.status, 0, res.stderr);
      const marker = JSON.parse(readFileSync(tituloPendingPath(dir), "utf8"));
      assert.deepEqual(marker.pending, [{ position: 3, provisional_title: "Kolibri Has Landed" }]);
      const after = readFileSync(join(dir, "02-reviewed.md"), "utf8");
      assert.equal(locateProvisionalTitulo(after, "Kolibri Has Landed"), 3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
