/**
 * test/mensal-templ-11811-11810.test.ts
 *
 * #11811: o passo 8 do writer-monthly mandava "É IA? antes do USE MELHOR"
 * (#1920), contra o checklist do passo 9 e o template (#6881: É IA? depois do
 * RADAR). Trava que toda sequência de seções em seta no prompt põe É IA?
 * depois do RADAR, igual ao template.
 *
 * #11810: DIVULGAÇÃO dizia "até 67%" e o CTA do TUTORIAL "até 63%" no mesmo
 * e-mail. `checkDiscountConsistency` aponta a divergência.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { checkDiscountConsistency } from "../scripts/lint-monthly-draft.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WRITER = readFileSync(resolve(ROOT, ".claude/agents/writer-monthly.md"), "utf8");
const TEMPLATE = readFileSync(resolve(ROOT, "context/templates/newsletter-monthly.md"), "utf8");

function labelIndex(seq: string, re: RegExp): number {
  const m = re.exec(seq);
  return m ? m.index : -1;
}

describe("#11811 — ordem do É IA? no writer-monthly igual ao template", () => {
  it("template: USE MELHOR → RADAR → É IA? → PARA ENCERRAR", () => {
    const labels = [...TEMPLATE.matchAll(/^\*\*([^*\n]+)\*\*\s*$/gm)].map((m) => m[1].trim());
    const pos = (re: RegExp) => labels.findIndex((l) => re.test(l));
    const use = pos(/^USE MELHOR$/);
    const radar = pos(/^RADAR$/);
    const eia = pos(/^É IA\?/);
    const fim = pos(/^(PARA ENCERRAR|ENCERRAMENTO)$/);
    assert.ok(use >= 0 && radar > use && eia > radar && fim > eia, `ordem do template: ${labels.join(" | ")}`);
  });

  it("toda sequência em seta do prompt que cita É IA? e Radar põe É IA? depois do Radar", () => {
    const seqs = WRITER.split("\n").filter((l) => /→/.test(l) && /É IA\?/.test(l) && /radar/i.test(l));
    assert.ok(seqs.length >= 2, `esperava o passo 8 e o checklist do passo 9, achei ${seqs.length}`);
    for (const line of seqs) {
      // Só a cadeia de setas: do 1º trecho com → até o último.
      const chain = line.slice(Math.max(0, line.indexOf("→") - 40));
      const radar = labelIndex(chain, /radar/i);
      const eia = labelIndex(chain, /É IA\?/);
      assert.ok(radar >= 0 && eia > radar, `É IA? antes do Radar em: ${line.slice(0, 200)}`);
    }
  });

  it("a regra revogada do #1920 (É IA? antes do USE MELHOR) não volta", () => {
    assert.doesNotMatch(WRITER, /É IA\?`?\s+vem logo \*\*após o DESTAQUE 3 e ANTES do/);
    assert.doesNotMatch(WRITER, /DESTAQUE 3 → É IA\? → Use Melhor/);
  });
});

describe("#11810 — checkDiscountConsistency", () => {
  it("acusa 67% e 63% no mesmo draft (cenário real dos ciclos 2607-08 a 2610-11)", () => {
    const draft = [
      "**CLARICE — DIVULGAÇÃO**",
      "",
      "Leitores desta newsletter têm 25% de desconto no plano mensal por 3 meses ou 50% de desconto no plano anual, acumulando até 67% de desconto.",
      "",
      "**CLARICE — TUTORIAL**",
      "",
      "→ [Assine agora e ganhe até 63% de desconto](https://clarice.ai/precos-planos?via=diaria)",
    ].join("\n");
    const r = checkDiscountConsistency(draft);
    assert.equal(r.ok, false);
    assert.deepEqual(r.percents, [67, 63]);
  });

  it("um número só (repetido) passa", () => {
    const r = checkDiscountConsistency("acumulando até 67% de desconto\n\n→ [ganhe até 67% de desconto](https://x)");
    assert.deepEqual(r, { ok: true, percents: [67] });
  });

  it("descontos de cupom sem 'até' não contam", () => {
    const r = checkDiscountConsistency("25% de desconto no plano mensal ou 50% de desconto no plano anual, acumulando até 67% de desconto.");
    assert.deepEqual(r, { ok: true, percents: [67] });
  });

  it("tolera 'ate' sem acento e espaço antes do %", () => {
    const r = checkDiscountConsistency("ate 67 % de desconto e até 63% de desconto");
    assert.deepEqual(r.percents, [67, 63]);
  });

  it("draft sem desconto passa", () => {
    assert.deepEqual(checkDiscountConsistency("nada aqui"), { ok: true, percents: [] });
  });
});
