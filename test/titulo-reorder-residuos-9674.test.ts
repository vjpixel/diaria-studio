/**
 * #9674 — resíduos do review 1.5b sobre #9668/#9669:
 *   1. reorder-destaques remapeava o `position` do marcador de título provisório
 *      mesmo quando o `02-reviewed.md` NÃO era reordenado (ausente, blocos de
 *      menos) — MD na ordem velha, marcador na nova;
 *   2. `renderTituloSubtituloBlock` gravava título com `|` cru, e o SUBTÍTULO
 *      voltava a ter 3 segmentos depois de um reorder.
 * CLI end-to-end no item 1 porque a regressão possível é de fiação em main().
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { renderTituloSubtituloBlock } from "../scripts/insert-titulo-subtitulo.ts";
import { deriveTituloSubtitulo } from "../scripts/reorder-destaques.ts";
import {
  parsePendingTitulos,
  replaceTitleInTituloSubtitulo,
  serializePendingTitulos,
  tituloPendingPath,
} from "../scripts/lib/titulo-provisional.ts";

const ROOT = join(import.meta.dirname, "..");

function runReorder(dir: string, order: string) {
  const r = spawnSync(
    process.execPath,
    ["--import", "tsx", join(ROOT, "scripts", "reorder-destaques.ts"), "--edition", "999999", "--edition-dir", dir, "--new-order", order],
    { cwd: ROOT, encoding: "utf8" },
  );
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function block(n: number, title: string, url: string): string {
  return `**DESTAQUE ${n} | 📦 PRODUTO**\n\n**[${title}](${url})**\n\ntexto ${n}\n\nPor que isso importa:\n\nporque sim.\n\nAprofunde: [link](${url})`;
}

function reviewedMd(n: number): string {
  const titles = ["Titulo Um", "Titulo Dois", "Titulo Tres"].slice(0, n);
  const header = `TÍTULO\n\n${titles[0]}\n\nSUBTÍTULO\n\n${titles.slice(1).join(" | ")}\n\n---\n\n`;
  const body = titles.map((t, i) => block(i + 1, t, `https://x${i + 1}.com/a`)).join("\n\n---\n\n");
  return `${header}${body}\n\n---\n\n**📡 RADAR**\n\n**[Outro](https://b.com/y)**\ndesc\n`;
}

function makeEdition(md: string | null): string {
  const dir = mkdtempSync(join(tmpdir(), "reorder-9674-"));
  const internal = join(dir, "_internal");
  mkdirSync(internal, { recursive: true });
  const approved = {
    highlights: [1, 2, 3].map((i) => ({ url: `https://x${i}.com/a`, title_options: [`T${i}`] })),
  };
  writeFileSync(join(internal, "01-approved.json"), JSON.stringify(approved, null, 2));
  if (md !== null) writeFileSync(join(dir, "02-reviewed.md"), md);
  writeFileSync(tituloPendingPath(dir), serializePendingTitulos([{ position: 1, provisional_title: "Titulo Um" }]));
  return dir;
}

function markerPosition(dir: string): number {
  return parsePendingTitulos(readFileSync(tituloPendingPath(dir), "utf8"))[0].position;
}

describe("#9674 item 1 — marcador só remapeia se o MD foi de fato reordenado", () => {
  it("02-reviewed.md ausente: marcador fica na posição original", () => {
    const dir = makeEdition(null);
    try {
      const r = runReorder(dir, "3,1,2");
      assert.equal(r.status, 0, r.stderr);
      assert.equal(markerPosition(dir), 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("02-reviewed.md com menos blocos que o newOrder: MD intacto e marcador também", () => {
    const md = reviewedMd(2);
    const dir = makeEdition(md);
    try {
      const r = runReorder(dir, "3,1,2");
      const out = readFileSync(join(dir, "02-reviewed.md"), "utf8");
      const body = (s: string) => s.slice(s.indexOf("**DESTAQUE 1"));
      assert.equal(body(out), body(md), "destaques do MD não reordenados");
      assert.equal(markerPosition(dir), 1, `marcador não pode seguir a ordem nova (status ${r.status}): ${r.stderr}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("controle: MD reordenado → marcador segue a nova posição", () => {
    const dir = makeEdition(reviewedMd(3));
    try {
      const r = runReorder(dir, "3,1,2");
      assert.equal(r.status, 0, r.stderr);
      // D1 antigo vai pra posição 2 em 3,1,2.
      assert.equal(markerPosition(dir), 2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("#9674 item 2 — renderTituloSubtituloBlock limpa `|` dos títulos", () => {
  it("título com `|` não vira segmento extra no SUBTÍTULO nem no TÍTULO", () => {
    const out = renderTituloSubtituloBlock("A | B", "OpenAI DevDay | Keynote", "Tres");
    const lines = out.split("\n");
    assert.equal(lines[2], "A – B");
    assert.equal(lines[6], "OpenAI DevDay – Keynote | Tres");
    assert.equal(lines[6].split("|").length, 2);
  });

  it("após re-derivar com D2 de título com `|`, um swap posterior acha o título antigo", () => {
    const md = reviewedMd(3).replace("**[Titulo Dois](", "**[OpenAI DevDay | Keynote](");
    const derived = deriveTituloSubtitulo(md);
    assert.ok(derived);
    assert.match(derived.md, /\nOpenAI DevDay – Keynote \| Titulo Tres\n/);
    // o swap grava o título no bloco já sanitizado (como o finalize faz)
    const r = replaceTitleInTituloSubtitulo(derived.md, "OpenAI DevDay – Keynote", "Novo", 2);
    assert.equal(r.status, "updated");
    assert.match(r.md, /\nNovo \| Titulo Tres\n/);
  });

  it("swap com o título antigo CRU (com `|`) acha o segmento sanitizado do bloco", () => {
    const md = reviewedMd(3).replace("**[Titulo Dois](", "**[OpenAI DevDay | Keynote](");
    const derived = deriveTituloSubtitulo(md);
    assert.ok(derived);
    // `applySwapToReviewedMd` passa o título do **DESTAQUE N |** como veio.
    const r = replaceTitleInTituloSubtitulo(derived.md, "OpenAI DevDay | Keynote", "Novo", 2);
    assert.equal(r.status, "updated");
    assert.match(r.md, /\nNovo \| Titulo Tres\n/);
  });
});
