/**
 * test/resolve-latest-monthly-cycle.test.ts (#4347 Etapa 3a)
 *
 * `resolveLatestMonthlyCycle` — escolhe o ciclo mensal mais recente PRONTO
 * pra reenvio (preview + gabarito É IA? + assunto conhecido). Núcleo puro,
 * deps injetadas — nunca toca disco real neste arquivo.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  resolveLatestMonthlyCycle,
  resolveLatestMonthlyCycleDeps,
  resolveSubjectForCycle,
  type ResolveLatestMonthlyCycleDeps,
} from "../scripts/lib/mensal/monthly-paths.ts";

function makeDeps(overrides: Partial<{
  cycles: string[];
  preview: Record<string, boolean>;
  eia: Record<string, boolean>;
  subject: Record<string, string | undefined>;
}>): ResolveLatestMonthlyCycleDeps {
  const cycles = overrides.cycles ?? [];
  const preview = overrides.preview ?? {};
  const eia = overrides.eia ?? {};
  const subject = overrides.subject ?? {};
  return {
    listCandidateCycles: () => cycles,
    hasPreviewWithUnsubscribe: (c) => preview[c] ?? false,
    hasEiaGabarito: (c) => eia[c] ?? false,
    resolveSubject: (c) => subject[c],
  };
}

test("resolveLatestMonthlyCycle: escolhe o maior ciclo completo (preview+eia+assunto)", () => {
  const deps = makeDeps({
    cycles: ["2605-06", "2606-07"],
    preview: { "2605-06": true, "2606-07": true },
    eia: { "2605-06": true, "2606-07": true },
    subject: { "2605-06": "Assunto maio", "2606-07": "Assunto junho" },
  });
  const result = resolveLatestMonthlyCycle(deps);
  assert.equal(result.cycle, "2606-07");
  assert.equal(result.subject, "Assunto junho");
  assert.equal(result.fallback, false);
});

test("resolveLatestMonthlyCycle: ignora ciclo sem preview (cai no anterior, fallback=true)", () => {
  const deps = makeDeps({
    cycles: ["2605-06", "2606-07"],
    preview: { "2605-06": true, "2606-07": false }, // ciclo corrente sem preview pronto
    eia: { "2605-06": true, "2606-07": true },
    subject: { "2605-06": "Assunto maio", "2606-07": "Assunto junho" },
  });
  const result = resolveLatestMonthlyCycle(deps);
  assert.equal(result.cycle, "2605-06");
  assert.equal(result.fallback, true);
  const junho = result.checked.find((c) => c.cycle === "2606-07")!;
  assert.equal(junho.ready, false);
  assert.ok(junho.reasons.some((r) => /preview/.test(r)));
});

test("resolveLatestMonthlyCycle: ignora ciclo sem gabarito É IA? (cai no anterior)", () => {
  const deps = makeDeps({
    cycles: ["2605-06", "2606-07"],
    preview: { "2605-06": true, "2606-07": true },
    eia: { "2605-06": true, "2606-07": false }, // sem gabarito
    subject: { "2605-06": "Assunto maio", "2606-07": "Assunto junho" },
  });
  const result = resolveLatestMonthlyCycle(deps);
  assert.equal(result.cycle, "2605-06");
  assert.equal(result.fallback, true);
});

test("resolveLatestMonthlyCycle: cai no ciclo anterior quando o corrente está incompleto (sem assunto conhecido)", () => {
  const deps = makeDeps({
    cycles: ["2605-06", "2606-07"],
    preview: { "2605-06": true, "2606-07": true },
    eia: { "2605-06": true, "2606-07": true },
    subject: { "2605-06": "Assunto maio" }, // 2606-07 sem assunto conhecido
  });
  const result = resolveLatestMonthlyCycle(deps);
  assert.equal(result.cycle, "2605-06");
  assert.equal(result.subject, "Assunto maio");
  assert.equal(result.fallback, true);
});

test("resolveLatestMonthlyCycle: --subject explícito vence a resolução automática e destrava o ciclo mais recente", () => {
  const deps = makeDeps({
    cycles: ["2605-06", "2606-07"],
    preview: { "2605-06": true, "2606-07": true },
    eia: { "2605-06": true, "2606-07": true },
    subject: {}, // nenhum assunto conhecido via campaigns-summary.json
  });
  const result = resolveLatestMonthlyCycle(deps, "Assunto explícito");
  assert.equal(result.cycle, "2606-07");
  assert.equal(result.subject, "Assunto explícito");
  assert.equal(result.fallback, false);
});

test("resolveLatestMonthlyCycle: nenhum ciclo pronto → cycle=null, checked lista os motivos de cada um", () => {
  const deps = makeDeps({
    cycles: ["2605-06", "2606-07"],
    preview: {},
    eia: {},
    subject: {},
  });
  const result = resolveLatestMonthlyCycle(deps);
  assert.equal(result.cycle, null);
  assert.equal(result.checked.length, 2);
  assert.ok(result.checked.every((c) => !c.ready));
});

// #4794 achado 3 (fleet review da #4783): `resolveLatestMonthlyCycleDeps()`
// (fábrica de PRODUÇÃO) foi trocada pra usar `resolveSubjectForCycle` em vez
// do antigo `resolveSubjectFromCampaignsSummary` isolado — essa É a mudança
// que resolve o bug real do #4783 (o fallback pra group-campaigns.json). Sem
// este teste, nenhum outro cobre a COSTURA de produção: todos os demais
// testes deste arquivo injetam deps fake, e os de monthly-paths-group-campaigns-4783.test.ts
// chamam `resolveSubjectForCycle` diretamente, nunca através de
// `resolveLatestMonthlyCycleDeps()`. Se alguém reverter essa linha por
// engano no futuro, nenhum teste ficaria vermelho sem esta checagem.
test("resolveLatestMonthlyCycleDeps: production factory usa resolveSubjectForCycle (não um resolver isolado)", () => {
  const deps = resolveLatestMonthlyCycleDeps();
  assert.equal(deps.resolveSubject, resolveSubjectForCycle, "resolveSubject deve ser resolveSubjectForCycle por referência — não um wrapper equivalente nem o resolver canônico isolado");
});

test("resolveLatestMonthlyCycle: ciclos com forma inválida são ignorados (não candidatos)", () => {
  const deps = makeDeps({
    cycles: ["nao-e-ciclo", "2606-07", "2605-13"], // 2605-13 = mês impossível
    preview: { "2606-07": true },
    eia: { "2606-07": true },
    subject: { "2606-07": "Assunto" },
  });
  const result = resolveLatestMonthlyCycle(deps);
  assert.equal(result.cycle, "2606-07");
});
