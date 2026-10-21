/**
 * test/newsletter-parse-box0-not-intro-callout.test.ts (#10638)
 *
 * Regressão do achado na edição 261021 (Stage 4): um box de divulgação no
 * slot 0 com título em negrito numa linha só (`<!-- box0 -->` + `**Título**`
 * + parágrafos + link) saía DUPLICADO no HTML — `findIntroCalloutMatch` lia a
 * linha de título como callout de intro e o mesmo bloco ainda renderizava
 * como box0. E `findOrphanBoxWarnings` contava cobertura + box0 como 2 blocos
 * extras, então o lint `orphan-box-in-gap` (gate-blocking) reprovava qualquer
 * slot 0 marcado.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  extractContent,
  extractIntroCallout,
  extractCoverageLineTrailer,
  extractBoxDivulgacao0,
  findOrphanBoxWarnings,
  isBoxDivulgacao0SemRotulo,
  BOX0_SENTINEL,
  BOX0_SEM_ROTULO_MARKER,
} from "../scripts/lib/newsletter-parse.ts";
import { renderHTML, renderDivulgacaoSeparator } from "../scripts/lib/newsletter-render-html.ts";

const EIA = `**É IA?**

Foto teste. [Autor](https://example.com/a) / CC.

Resultado da última edição: 40% das pessoas acertaram.
`;

const BOX_TITLE = "Curso de IA para jornalistas";

function d(n: number, cat: string, url: string): string {
  return `**DESTAQUE ${n} | ${cat}**

**[Título D${n}](${url})**

Corpo do destaque ${n}.

Por que isso importa:

Why do D${n}.
`;
}

function buildReviewed(opts: { box0?: boolean; semRotulo?: boolean; callout?: string } = {}): string {
  const { box0 = true, semRotulo = false, callout = "" } = opts;
  const calloutBlock = callout ? `${callout}\n\n---\n\n` : "";
  const marker = semRotulo ? `${BOX0_SEM_ROTULO_MARKER}\n` : "";
  const box = box0
    ? `${BOX0_SENTINEL}\n${marker}**${BOX_TITLE}**\n\nTurma nova abre em novembro, com aulas ao vivo.\n\n[Inscreva-se](https://example.com/curso)\n\n---\n\n`
    : "";
  return `TÍTULO: Edição de teste

---

Olá! Eu sou o [Pixel](https://example.com/pixel). Hoje li 80 notícias e selecionei os 12 mais relevantes. Se gosta do trabalho, [considere apoiar o projeto](https://example.com/apoie).

---

${calloutBlock}${box}${d(1, "🚀 LANÇAMENTO", "https://example.com/d1")}

---

${d(2, "💼 MERCADO", "https://example.com/d2")}

---

${d(3, "💼 TRABALHO", "https://example.com/d3")}

---

${EIA}

---

**📡 RADAR**

**[Item de radar](https://example.com/r1)**
Resumo do item.
`;
}

function withEdition<T>(reviewed: string, fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "ed-10638-"));
  try {
    writeFileSync(join(dir, "02-reviewed.md"), reviewed, "utf8");
    writeFileSync(join(dir, "01-eia.md"), EIA, "utf8");
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe("#10638 — box0 com título em negrito não vira callout de intro", () => {
  it("título do box0 não é lido como introCallout e sai UMA vez no HTML", () => {
    const reviewed = buildReviewed();
    assert.equal(extractIntroCallout(reviewed), null, "box0 não pode ser lido como callout de intro");
    assert.equal(extractCoverageLineTrailer(reviewed), null);
    const box0 = extractBoxDivulgacao0(reviewed);
    assert.ok(box0, "box0 deveria ser extraído");
    assert.match(box0!, new RegExp(BOX_TITLE));
    withEdition(reviewed, (dir) => {
      const content = extractContent(dir);
      assert.equal(content.introCallout, null);
      const html = renderHTML(content);
      assert.equal(count(html, BOX_TITLE), 1, "título do box0 deveria aparecer exatamente 1 vez no HTML");
      assert.equal(count(html, "Turma nova abre em novembro"), 1);
    });
  });

  it("findOrphanBoxWarnings não reprova slot 0 marcado (cobertura + box0)", () => {
    const warnings = findOrphanBoxWarnings(buildReviewed());
    assert.deepEqual(
      warnings.filter((w) => w.gapIndex === -1),
      [],
      "cobertura antes do sentinel não é candidato a box",
    );
  });

  it("regressão: callout de intro legítimo continua reconhecido ao lado do box0", () => {
    const callout = "**🎥 Hoje às 19h tem sorteio ao vivo: [participe](https://example.com/live).**";
    const reviewed = buildReviewed({ callout });
    assert.match(extractIntroCallout(reviewed) ?? "", /sorteio ao vivo/);
    assert.equal(extractCoverageLineTrailer(reviewed), null, "box0 não vaza como trailer do callout");
    assert.match(extractBoxDivulgacao0(reviewed) ?? "", new RegExp(BOX_TITLE));
    assert.deepEqual(findOrphanBoxWarnings(reviewed).filter((w) => w.gapIndex === -1), []);
    // Sem box0, o callout sozinho continua sendo callout.
    const semBox = buildReviewed({ box0: false, callout });
    assert.match(extractIntroCallout(semBox) ?? "", /sorteio ao vivo/);
    withEdition(reviewed, (dir) => {
      const html = renderHTML(extractContent(dir));
      assert.equal(count(html, "sorteio ao vivo"), 1);
      assert.equal(count(html, BOX_TITLE), 1);
    });
  });

  it("marcador <!-- box0-sem-rotulo --> tira o kicker e não vaza pro conteúdo", () => {
    const comRotulo = buildReviewed();
    const semRotulo = buildReviewed({ semRotulo: true });
    assert.equal(isBoxDivulgacao0SemRotulo(comRotulo), false);
    assert.equal(isBoxDivulgacao0SemRotulo(semRotulo), true);
    assert.doesNotMatch(extractBoxDivulgacao0(semRotulo) ?? "", /box0-sem-rotulo/);

    withEdition(comRotulo, (dir) => {
      const content = extractContent(dir);
      assert.equal(content.boxDivulgacao0SemRotulo, false);
      const kicker = renderDivulgacaoSeparator(content.boxDivulgacao0Categoria || "Divulgação");
      assert.ok(renderHTML(content).includes(kicker), "sem o marcador, o kicker continua");
    });
    withEdition(semRotulo, (dir) => {
      const content = extractContent(dir);
      assert.equal(content.boxDivulgacao0SemRotulo, true);
      const kicker = renderDivulgacaoSeparator(content.boxDivulgacao0Categoria || "Divulgação");
      const html = renderHTML(content);
      assert.ok(!html.includes(kicker), "com o marcador, o box0 sai sem kicker");
      assert.equal(count(html, BOX_TITLE), 1);
      assert.ok(!html.includes("box0-sem-rotulo"), "marcador nunca vai pro HTML");
    });
  });
});

/** Insere `extra` logo antes do bloco do box0 (depois do `---` da cobertura). */
function withBeforeBox0(reviewed: string, extra: string): string {
  const idx = reviewed.indexOf(BOX0_SENTINEL);
  assert.ok(idx !== -1);
  return reviewed.slice(0, idx) + extra + reviewed.slice(idx);
}

const slot0Warnings = (md: string) => findOrphanBoxWarnings(md).filter((w) => w.gapIndex === -1);

describe("#10696 — bloco perdido antes do box0 e marcador sem-rótulo fora do bloco", () => {
  it("regressão: bloco extra entre a cobertura e o box0 gera warning (não some calado)", () => {
    const reviewed = withBeforeBox0(buildReviewed(), "Parágrafo perdido que o render não emite.\n\n---\n\n");
    const warnings = slot0Warnings(reviewed);
    assert.equal(warnings.length, 1, JSON.stringify(warnings));
    assert.match(warnings[0].reason, /Parágrafo perdido/);
    assert.match(warnings[0].reason, /descartados/);
    // E de fato o render não emite esse bloco — o warning não é falso alarme.
    withEdition(reviewed, (dir) => {
      assert.ok(!renderHTML(extractContent(dir)).includes("Parágrafo perdido"));
    });
  });

  it("texto colado antes do sentinel no mesmo bloco também é avisado", () => {
    const reviewed = withBeforeBox0(buildReviewed(), "Texto solto antes do marcador.\n");
    assert.match(slot0Warnings(reviewed)[0]?.reason ?? "", /Texto solto/);
  });

  it("sem bloco perdido: cobertura + box0 e cobertura + callout + box0 seguem sem warning", () => {
    assert.deepEqual(slot0Warnings(buildReviewed()), []);
    const callout = "**🎥 Hoje às 19h tem sorteio ao vivo: [participe](https://example.com/live).**";
    assert.deepEqual(slot0Warnings(buildReviewed({ callout })), []);
  });

  it("trailer depois do callout é renderizado — não conta como bloco perdido", () => {
    const callout = "**🎥 Sorteio ao vivo hoje: [participe](https://example.com/live).**";
    const reviewed = buildReviewed({ callout: `${callout}\n\n---\n\nTexto de trailer da cobertura.` });
    assert.equal(extractCoverageLineTrailer(reviewed), "Texto de trailer da cobertura.");
    assert.deepEqual(slot0Warnings(reviewed), []);
  });

  it("marcador sem-rótulo na linha ACIMA do <!-- box0 --> vale (caso real 261021)", () => {
    const reviewed = withBeforeBox0(buildReviewed(), `${BOX0_SEM_ROTULO_MARKER}\n`);
    assert.equal(isBoxDivulgacao0SemRotulo(reviewed), true);
    assert.deepEqual(slot0Warnings(reviewed), []);
    withEdition(reviewed, (dir) => {
      const content = extractContent(dir);
      assert.equal(content.boxDivulgacao0SemRotulo, true);
      const html = renderHTML(content);
      const kicker = renderDivulgacaoSeparator(content.boxDivulgacao0Categoria || "Divulgação");
      assert.ok(!html.includes(kicker));
      assert.ok(!html.includes("box0-sem-rotulo"));
    });
  });

  it("marcador sem-rótulo ao lado de um callout não vaza como trailer", () => {
    const callout = "**🎥 Sorteio ao vivo hoje: [participe](https://example.com/live).**";
    const reviewed = withBeforeBox0(buildReviewed({ callout }), `${BOX0_SEM_ROTULO_MARKER}\n`);
    assert.equal(extractCoverageLineTrailer(reviewed), null);
    assert.equal(isBoxDivulgacao0SemRotulo(reviewed), true);
  });

  it("marcador sem-rótulo fora do bloco do box0 gera warning", () => {
    const reviewed = buildReviewed().replace(
      "[considere apoiar o projeto](https://example.com/apoie).",
      `[considere apoiar o projeto](https://example.com/apoie).\n\n${BOX0_SEM_ROTULO_MARKER}`,
    );
    assert.equal(isBoxDivulgacao0SemRotulo(reviewed), false);
    assert.ok(slot0Warnings(reviewed).some((w) => /box0-sem-rotulo/.test(w.reason)));
  });

  it("limitação documentada: `---` dentro do box0 corta o box e o lint acusa a sobra", () => {
    const reviewed = buildReviewed().replace(
      "[Inscreva-se](https://example.com/curso)",
      "Parte 1 do box.\n\n---\n\nParte 2 do box, depois do separador interno.",
    );
    assert.doesNotMatch(extractBoxDivulgacao0(reviewed) ?? "", /Parte 2/);
    assert.ok(slot0Warnings(reviewed).length > 0, "a sobra do box precisa ser avisada");
  });
});
