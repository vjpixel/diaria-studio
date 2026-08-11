/**
 * test/eia-anchor-section-4991.test.ts (#4991)
 *
 * Reimplementação de um fix perdido (commit `3bd161f9`, branch
 * `fix/4956-eia-anchor-section-reverte-3476` — validado ao vivo na edição
 * 260811, worktree removido antes do push, ver #4991 comentários).
 *
 * `scripts/lib/newsletter-render-html.ts` tinha uma regra PERMANENTE
 * hardcoded (#3476, 260716): É IA? SEMPRE renderiza logo após USE MELHOR,
 * ignorando onde `**É IA?**` de fato aparece em `02-reviewed.md`. Isso
 * quebrou a reordenação que o editor pediu ao vivo na edição 260811 (mover
 * É IA? para depois de VÍDEO).
 *
 * Fix: `findEiaAnchorSection()` (newsletter-parse.ts) deriva a posição real
 * do mirror `**É IA?**` no md. `extractContent` popula
 * `content.eiaAnchorSectionIdx`; `renderHTML` usa esse valor quando não é
 * `null`/`undefined`, senão cai no fallback histórico #3476 — regressão
 * zero pra qualquer edição que nunca reordenou nada (a maioria).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  extractContent,
  findEiaAnchorSection,
  renderHTML,
} from "../scripts/render-newsletter-html.ts";

const EIA = `**É IA?**

Foto teste. [Autor](https://example.com/a) / CC.

Resultado da última edição: 40% das pessoas acertaram.
`;

function d(n: number, cat: string, url: string): string {
  return `**DESTAQUE ${n} | ${cat}**

**[Título D${n}](${url})**

Corpo do destaque ${n}.

Por que isso importa:

Why do D${n}.
`;
}

const USE_MELHOR = `**🛠️ USE MELHOR**

**[Tutorial](https://example.com/t)**
Descrição do tutorial.
`;

const VIDEO = `**📺 VÍDEOS**

**[Vídeo legal](https://example.com/v)**
Descrição do vídeo.
`;

const LANCAMENTOS = `**🚀 LANÇAMENTOS**

**[Lançamento novo](https://example.com/l)**
Descrição do lançamento.
`;

const RADAR = `**📡 RADAR**

**[Item de radar](https://example.com/r1)**
Resumo do item.
`;

function buildDestaquesBlock(): string {
  return [
    "Para esta edição, selecionamos 12 itens.",
    "---",
    d(1, "🚀 LANÇAMENTO", "https://example.com/d1"),
    "---",
    d(2, "💼 MERCADO", "https://example.com/d2"),
    "---",
    d(3, "💼 TRABALHO", "https://example.com/d3"),
  ].join("\n\n---\n\n");
}

function writeEdition(dir: string, reviewedTail: string): void {
  const reviewed = `${buildDestaquesBlock()}\n\n---\n\n${reviewedTail}`;
  writeFileSync(join(dir, "02-reviewed.md"), reviewed, "utf8");
  writeFileSync(join(dir, "01-eia.md"), EIA, "utf8");
}

describe("findEiaAnchorSection (#4991) — unit, texto puro", () => {
  it("mirror ausente → null (fallback pro comportamento antigo #3476)", () => {
    const text = [USE_MELHOR, LANCAMENTOS].join("\n\n---\n\n");
    assert.equal(findEiaAnchorSection(text), null);
  });

  it("mirror presente após USE MELHOR → índice de USE MELHOR (0)", () => {
    const text = [USE_MELHOR, EIA, LANCAMENTOS].join("\n\n---\n\n");
    assert.equal(findEiaAnchorSection(text), 0);
  });

  it("reordenação: mirror após USE MELHOR + VÍDEO → índice de VÍDEO (1)", () => {
    const text = [USE_MELHOR, VIDEO, EIA, LANCAMENTOS, RADAR].join("\n\n---\n\n");
    assert.equal(findEiaAnchorSection(text), 1);
  });

  it("mirror presente mas sem nenhuma seção antes → -1", () => {
    const text = [EIA, LANCAMENTOS, RADAR].join("\n\n---\n\n");
    assert.equal(findEiaAnchorSection(text), -1);
  });

  it("mirror em formato legado sem bold (É IA? sem **) também é reconhecido", () => {
    const legacyEia = EIA.replace("**É IA?**", "É IA?");
    const text = [USE_MELHOR, legacyEia, LANCAMENTOS].join("\n\n---\n\n");
    assert.equal(findEiaAnchorSection(text), 0);
  });
});

describe("renderHTML — anchor de É IA? deriva do mirror (#4991), fallback #3476 preservado", () => {
  it("reordenação: mirror após VÍDEO → renderiza USE MELHOR < VÍDEO < É IA? < LANÇAMENTOS < RADAR", () => {
    const dir = mkdtempSync(join(tmpdir(), "ed-4991-reorder-"));
    try {
      writeEdition(dir, [USE_MELHOR, VIDEO, EIA, LANCAMENTOS, RADAR].join("\n\n---\n\n"));
      const content = extractContent(dir);
      assert.equal(content.eiaAnchorSectionIdx, 1, "anchor deve apontar pro índice de VÍDEO");
      const html = renderHTML(content);
      const umIdx = html.indexOf("<!-- USE MELHOR -->");
      const vidIdx = html.indexOf("<!-- VÍDEOS -->");
      const eiaIdx = html.indexOf("<!-- É IA? (poll) -->");
      const lancIdx = html.indexOf("<!-- LANÇAMENTOS -->");
      const radarIdx = html.indexOf("<!-- RADAR -->");
      assert.ok(
        [umIdx, vidIdx, eiaIdx, lancIdx, radarIdx].every((i) => i !== -1),
        `algum marcador não encontrado: UM=${umIdx} VID=${vidIdx} EIA=${eiaIdx} LANC=${lancIdx} RADAR=${radarIdx}`,
      );
      assert.ok(
        umIdx < vidIdx && vidIdx < eiaIdx && eiaIdx < lancIdx && lancIdx < radarIdx,
        `ordem incorreta: UM(${umIdx}) < VID(${vidIdx}) < EIA(${eiaIdx}) < LANC(${lancIdx}) < RADAR(${radarIdx})`,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fallback (#633 regressão zero): mirror AUSENTE do reviewed.md → É IA? renderiza após USE MELHOR (comportamento antigo #3476)", () => {
    const dir = mkdtempSync(join(tmpdir(), "ed-4991-fallback-um-"));
    try {
      // Sem o mirror **É IA?** no reviewed.md — só USE MELHOR + LANÇAMENTOS.
      // 01-eia.md continua existindo (é a fonte real do render).
      writeEdition(dir, [USE_MELHOR, LANCAMENTOS, RADAR].join("\n\n---\n\n"));
      const content = extractContent(dir);
      assert.equal(content.eiaAnchorSectionIdx, null, "sem mirror no md, anchor deve ser null");
      const html = renderHTML(content);
      const umIdx = html.indexOf("<!-- USE MELHOR -->");
      const eiaIdx = html.indexOf("<!-- É IA? (poll) -->");
      const lancIdx = html.indexOf("<!-- LANÇAMENTOS -->");
      assert.ok(umIdx !== -1 && eiaIdx !== -1 && lancIdx !== -1);
      assert.ok(
        umIdx < eiaIdx && eiaIdx < lancIdx,
        `fallback #3476 quebrado: UM(${umIdx}) < EIA(${eiaIdx}) < LANC(${lancIdx})`,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fallback sem USE MELHOR (#1085 preservado): mirror ausente e sem USE MELHOR → É IA? renderiza ANTES das seções secundárias", () => {
    const dir = mkdtempSync(join(tmpdir(), "ed-4991-fallback-no-um-"));
    try {
      // Sem USE MELHOR, sem mirror — só LANÇAMENTOS + RADAR.
      writeEdition(dir, [LANCAMENTOS, RADAR].join("\n\n---\n\n"));
      const content = extractContent(dir);
      assert.equal(content.eiaAnchorSectionIdx, null);
      assert.equal(content.sections.findIndex((s) => s.name === "USE MELHOR"), -1);
      const html = renderHTML(content);
      const eiaIdx = html.indexOf("<!-- É IA? (poll) -->");
      const lancIdx = html.indexOf("<!-- LANÇAMENTOS -->");
      assert.ok(eiaIdx !== -1 && lancIdx !== -1);
      assert.ok(
        eiaIdx < lancIdx,
        `#1085 quebrado: É IA? deveria vir ANTES das seções secundárias — EIA(${eiaIdx}) < LANC(${lancIdx})`,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("mirror presente mas SEM nenhuma seção antes (-1) → mesma posição do fallback #1085 (antes de todas as seções)", () => {
    const dir = mkdtempSync(join(tmpdir(), "ed-4991-mirror-no-section-before-"));
    try {
      // Mirror logo após os destaques, ANTES de qualquer seção secundária.
      writeEdition(dir, [EIA, LANCAMENTOS, RADAR].join("\n\n---\n\n"));
      const content = extractContent(dir);
      assert.equal(content.eiaAnchorSectionIdx, -1);
      const html = renderHTML(content);
      const eiaIdx = html.indexOf("<!-- É IA? (poll) -->");
      const lancIdx = html.indexOf("<!-- LANÇAMENTOS -->");
      assert.ok(eiaIdx !== -1 && lancIdx !== -1);
      assert.ok(eiaIdx < lancIdx, `EIA(${eiaIdx}) deveria vir antes de LANC(${lancIdx})`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
