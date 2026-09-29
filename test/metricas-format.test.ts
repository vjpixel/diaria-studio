/**
 * test/metricas-format.test.ts (#9023 item 3)
 *
 * `fmtValor` (scripts/studio-ui/public/metricas-format.js) renderizava todo
 * resultado `qualidade: "faixa"` com o sufixo fixo "(até X com
 * não-atribuídos)" — correto só pra aquisição. Churn e LTV reusam a função e
 * o teto deles significa outra coisa ("com limpeza manual", "com churn
 * orgânico"). O rótulo agora vem de `limites.rotuloMax`, por métrica.
 *
 * Inclui também o guard de `studio-metrics.ts` pro item 2 (denominador de
 * LTV÷CAC = custo por ATIVO, nunca `custoPorLeitor`).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fmtValor } from "../scripts/studio-ui/public/metricas-format.js";
import { getMetric, type ChurnMensalDeps, type Janela, type LtvCaixaDeps } from "../scripts/lib/metrics/registry.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function janelaDia(dia: string): Janela {
  return { de: dia, ate: dia, granularidade: "dia", fuso: "BRT" };
}

describe("fmtValor — rótulo da faixa por métrica (#9023)", () => {
  it("churn usa 'com limpeza manual', nunca 'não-atribuídos'", async () => {
    const deps: ChurnMensalDeps = {
      exits: [{ email: "a@x.com" }, { email: "manual@x.com" }],
      manualCleanupEmails: new Set(["manual@x.com"]),
      periodMonths: 1,
      avgActiveBase: 100,
    };
    const r = await getMetric("churn-mensal")!.computar({ janela: janelaDia("2026-09-01"), deps });
    const out = fmtValor(r, "razao");
    assert.match(out, /com limpeza manual\)$/);
    assert.doesNotMatch(out, /não-atribuídos/);
  });

  it("LTV usa 'com churn orgânico', nunca 'não-atribuídos'", async () => {
    const deps: LtvCaixaDeps = { arpuMensal: 0.78, churnMensalOrganico: 0.024, churnMensalComLimpeza: 0.05 };
    const r = await getMetric("ltv-caixa")!.computar({ janela: janelaDia("2026-09-01"), deps });
    const out = fmtValor(r, "brl");
    assert.match(out, /^R\$ [\d,]+ \(até R\$ [\d,]+ com churn orgânico\)$/);
    assert.doesNotMatch(out, /não-atribuídos/);
  });

  it("aquisição mantém 'com não-atribuídos'", () => {
    const r = { valor: 2, qualidade: "faixa", limites: { min: 2, max: 3, rotuloMax: "com não-atribuídos" } };
    assert.equal(fmtValor(r, "contagem"), "2 (até 3 com não-atribuídos)");
  });

  it("sem rotuloMax: só '(até X)', nunca um sufixo inventado", () => {
    const r = { valor: 2, qualidade: "faixa", limites: { min: 2, max: 3 } };
    assert.equal(fmtValor(r, "contagem"), "2 (até 3)");
  });

  it("faixa degenerada (min === max) mostra só o valor", () => {
    const r = { valor: 0.5, qualidade: "faixa", limites: { min: 0.5, max: 0.5, rotuloMax: "x" } };
    assert.equal(fmtValor(r, "razao"), "0.500");
  });

  it("null segue 'sem coleta'; piso segue com '≥'", () => {
    assert.equal(fmtValor({ valor: null, qualidade: "indeterminado" }, "brl"), "sem coleta");
    assert.equal(fmtValor({ valor: 3, qualidade: "piso" }, "contagem"), "≥ 3");
  });
});

describe("studio-metrics — LTV÷CAC divide por custo por ATIVO (#9023 item 2)", () => {
  it("custoPorCanal vem de computeCustoPorAtivo(spend, ativos), nunca de row.custoPorLeitor", () => {
    const src = readFileSync(join(ROOT, "scripts", "studio-ui", "studio-metrics.ts"), "utf8");
    assert.match(src, /custoPorCanal\[row\.canal\]\s*=\s*computeCustoPorAtivo\(row\.spend\.valor,\s*row\.ativos\)/);
    assert.doesNotMatch(src, /custoPorCanal\[row\.canal\]\s*=\s*row\.custoPorLeitor/);
  });
});
