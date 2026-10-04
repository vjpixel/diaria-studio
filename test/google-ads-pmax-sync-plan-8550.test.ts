/**
 * test/google-ads-pmax-sync-plan-8550.test.ts (#8550)
 *
 * Cobre `scripts/lib/google-ads-pmax-sync-plan.ts` (plano JSON passo a passo,
 * piso da Fase 2, releitura) e a integração na CLI
 * `scripts/google-ads-swap-asset-group-creatives.ts`. Zero rede: todo
 * `fetch` é mock.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  classifyAssetGroupAssets,
  buildAssetGroupAssetsQuery,
  parseAssetGroupAssetRows,
  planTextFieldLinks,
  validateNewTextAssetPlan,
  NEW_HEADLINES,
  NEW_LONG_HEADLINES,
  NEW_DESCRIPTIONS,
  type AssetGroupAssetApiRow,
  type AssetGroupAssetItem,
} from "../scripts/lib/google-ads-asset-group-assets.ts";
import {
  simulateSteps,
  phase1StepsFromLinkPlans,
  planPhase2Removal,
  projectItemsAfterPhase1,
  verifyLinkedAfterApply,
  verifyRemovedAfterApply,
  fieldsBelowMin,
  buildSyncPlanReport,
  type Phase2RemovalPlan,
  countEnabledByFieldType,
  PMAX_MANAGED_FIELD_LIMITS,
  type FieldCounts,
} from "../scripts/lib/google-ads-pmax-sync-plan.ts";
import { main as swapMain } from "../scripts/google-ads-swap-asset-group-creatives.ts";
import { withStatefulSearch } from "./_helpers/pmax-stateful-search.ts";

const CUSTOMER = "2369219639";
const GROUP = `customers/${CUSTOMER}/assetGroups/6642889160`;

function item(id: string, fieldType: string, opts: { text?: string; imageName?: string; approval?: string; status?: string } = {}): AssetGroupAssetItem {
  return {
    assetGroupAssetResourceName: `customers/${CUSTOMER}/assetGroupAssets/6642889160~${id}~${fieldType}`,
    assetResourceName: `customers/${CUSTOMER}/assets/${id}`,
    assetId: id,
    fieldType,
    status: opts.status ?? "ENABLED",
    assetType: fieldType.includes("IMAGE") ? "IMAGE" : "TEXT",
    ...(opts.text !== undefined ? { text: opts.text } : {}),
    ...(opts.imageName !== undefined ? { imageName: opts.imageName } : {}),
    ...(opts.approval !== undefined ? { approvalStatus: opts.approval } : {}),
  };
}

const STALE_HEADLINES = ["Newsletter de IA", "Notícias de IA diariamente", "Notícias de IA todos os dias", "Newsletter de IA grátis", "Dicas de IA"];
const STALE_LONG = ["Sua dose diária de notícias de IA.", "Cursos de IA gratuitos para assinantes."];
const STALE_DESC = ["As notícias mais importantes sobre IA, resumidas para você.", "Receba atualizações diárias sobre as últimas novidades em IA."];

/** Grupo "antes da troca": só antigos genéricos + diar.ia.br + logo_1.jpg,
 *  todos aprovados — o estado real do grupo, em escala menor. */
function oldGroup(): AssetGroupAssetItem[] {
  let id = 100;
  const a = (ft: string, o: Parameters<typeof item>[2]) => item(String(id++), ft, { approval: "APPROVED", ...o });
  return [
    ...STALE_HEADLINES.map((t) => a("HEADLINE", { text: t })),
    a("HEADLINE", { text: "diar.ia.br" }),
    ...STALE_LONG.map((t) => a("LONG_HEADLINE", { text: t })),
    ...STALE_DESC.map((t) => a("DESCRIPTION", { text: t })),
    a("MARKETING_IMAGE", { imageName: "Gemini_Generated_Image_x_1.9108.png" }),
    a("MARKETING_IMAGE", { imageName: "Generated image - 2025-12-27 10:55:41_1.9108.197" }),
    a("SQUARE_MARKETING_IMAGE", { imageName: "Generated image - 2025-12-27 10:55:41_1.197" }),
    a("SQUARE_MARKETING_IMAGE", { imageName: "logo_1.jpg" }),
    a("PORTRAIT_MARKETING_IMAGE", { imageName: "Generated image - 2025-12-27 10:55:41_0.8.197" }),
  ];
}

const zero = (): FieldCounts => ({ HEADLINE: 0, LONG_HEADLINE: 0, DESCRIPTION: 0, SQUARE_MARKETING_IMAGE: 0, MARKETING_IMAGE: 0, PORTRAIT_MARKETING_IMAGE: 0 });

// ---------------------------------------------------------------------------
describe("#8550 sync — simulateSteps: nunca abaixo do mínimo, nunca acima do máximo", () => {
  it("adicionar antes de remover mantém o tipo no intervalo em todo passo", () => {
    const start = { ...zero(), LONG_HEADLINE: 2 };
    const snaps = simulateSteps(start, [
      { label: "add", add: { LONG_HEADLINE: 3 }, remove: [] },
      { label: "remove", add: {}, remove: [{ resourceName: "a", fieldType: "LONG_HEADLINE" }, { resourceName: "b", fieldType: "LONG_HEADLINE" }] },
    ]);
    assert.deepEqual(snaps.map((s) => s.counts.LONG_HEADLINE), [5, 3]);
    assert.deepEqual(snaps.flatMap((s) => s.violations), []);
  });

  it("remover antes de adicionar (ordem errada) é marcado como violação de mínimo", () => {
    const start = { ...zero(), LONG_HEADLINE: 1 };
    const snaps = simulateSteps(start, [
      { label: "remove primeiro", add: {}, remove: [{ resourceName: "a", fieldType: "LONG_HEADLINE" }] },
      { label: "add depois", add: { LONG_HEADLINE: 5 }, remove: [] },
    ]);
    assert.match(snaps[0].violations.join(), /LONG_HEADLINE: 0 < mínimo 1/);
  });

  it("adicionar além do máximo é violação; a troca atômica (remove+add no mesmo passo) não", () => {
    const start = { ...zero(), DESCRIPTION: 5 };
    const [over] = simulateSteps(start, [{ label: "só add", add: { DESCRIPTION: 5 }, remove: [] }]);
    assert.match(over.violations.join(), /DESCRIPTION: 10 > máximo 5/);
    const removes = ["a", "b", "c", "d", "e"].map((r) => ({ resourceName: r, fieldType: "DESCRIPTION" }));
    const [atomic] = simulateSteps(start, [{ label: "swap", add: { DESCRIPTION: 5 }, remove: removes }]);
    assert.deepEqual(atomic.violations, []);
    assert.equal(atomic.counts.DESCRIPTION, 5);
  });

  it("tipo já abaixo do mínimo e não tocado pelo passo não vira violação do passo", () => {
    const [s] = simulateSteps({ ...zero(), HEADLINE: 5 }, [{ label: "add headline", add: { HEADLINE: 1 }, remove: [] }]);
    assert.deepEqual(s.violations, []);
  });
});

describe("#8550 sync — Fase 1 a partir do plano de link (#9017)", () => {
  it("os passos derivados do plano real de texto nunca estouram o máximo nem furam o mínimo", () => {
    const items = oldGroup();
    const classification = classifyAssetGroupAssets(items);
    const linkPlan = planTextFieldLinks(items, classification, { HEADLINE: 4, LONG_HEADLINE: 5, DESCRIPTION: 5 });
    assert.equal(linkPlan.ok, true);
    const steps = phase1StepsFromLinkPlans(linkPlan.plans, items);
    const snaps = simulateSteps(countEnabledByFieldType(items), steps);
    assert.deepEqual(snaps.flatMap((s) => s.violations), []);
    const last = snaps[snaps.length - 1].counts;
    assert.equal(last.LONG_HEADLINE, 5); // 2 antigos + 5 novos > 5 → 2 saem no mesmo mutate
    assert.equal(last.DESCRIPTION, 5);
    assert.equal(last.HEADLINE, 10); // 6 + 4, cabe sem remover
  });
});

describe("#8550 sync — planPhase2Removal (piso com aprovação)", () => {
  it("rodada ANTES da Fase 1: mantém stale suficiente pra nenhum tipo ficar abaixo do mínimo", () => {
    const items = oldGroup();
    const plan = planPhase2Removal(items, classifyAssetGroupAssets(items));
    const after = items.filter((i) => !plan.remove.includes(i.assetGroupAssetResourceName));
    assert.deepEqual(fieldsBelowMin(after), []);
    const byFt = Object.fromEntries(plan.fields.map((f) => [f.fieldType, f]));
    assert.equal(byFt.HEADLINE.retain.length, 2); // diar.ia.br + 2 antigos = 3
    assert.equal(byFt.LONG_HEADLINE.retain.length, 1);
    assert.equal(byFt.DESCRIPTION.retain.length, 2);
    assert.equal(byFt.MARKETING_IMAGE.retain.length, 1);
    // logo_1.jpg é needsReview: NÃO conta no piso — 1 imagem quadrada antiga fica.
    assert.equal(byFt.SQUARE_MARKETING_IMAGE.retain.length, 1);
    assert.equal(byFt.SQUARE_MARKETING_IMAGE.needsReview, 1);
    assert.equal(byFt.PORTRAIT_MARKETING_IMAGE.retain.length, 0); // mínimo 0
  });

  it("novos ainda em revisão (approval UNKNOWN/ausente) ou reprovados NÃO contam no piso", () => {
    const pendente = [
      item("900", "LONG_HEADLINE", { text: NEW_LONG_HEADLINES[0], approval: "UNKNOWN" }),
      item("901", "LONG_HEADLINE", { text: NEW_LONG_HEADLINES[1] }),
      item("902", "LONG_HEADLINE", { text: NEW_LONG_HEADLINES[2], approval: "DISAPPROVED" }),
    ];
    const items = [...oldGroup(), ...pendente];
    const plan = planPhase2Removal(items, classifyAssetGroupAssets(items));
    const lh = plan.fields.find((f) => f.fieldType === "LONG_HEADLINE")!;
    assert.equal(lh.confirmedPermanent, 0);
    assert.equal(lh.unconfirmedPermanent, 3);
    assert.equal(lh.retain.length, 1, "1 antigo aprovado fica até um novo ser aprovado");
  });

  it("novos aprovados cobrindo o mínimo: remove TODO o stale", () => {
    const items = [
      ...oldGroup(),
      ...NEW_HEADLINES.map((t, k) => item(`80${k}`, "HEADLINE", { text: t, approval: "APPROVED" })),
      ...NEW_LONG_HEADLINES.slice(0, 1).map((t, k) => item(`81${k}`, "LONG_HEADLINE", { text: t, approval: "APPROVED_LIMITED" })),
      ...NEW_DESCRIPTIONS.slice(0, 2).map((t, k) => item(`82${k}`, "DESCRIPTION", { text: t, approval: "APPROVED" })),
      item("830", "MARKETING_IMAGE", { imageName: "pmax-d1-191x1.jpg", approval: "APPROVED" }),
      item("831", "SQUARE_MARKETING_IMAGE", { imageName: "pmax-d1-1x1.jpg", approval: "APPROVED" }),
    ];
    const classification = classifyAssetGroupAssets(items);
    const plan = planPhase2Removal(items, classification);
    assert.equal(plan.remove.length, classification.stale.length);
    assert.ok(plan.fields.every((f) => f.retain.length === 0));
  });

  it("entre stale, mantém primeiro os já aprovados", () => {
    const items = [
      item("1", "LONG_HEADLINE", { text: STALE_LONG[0], approval: "DISAPPROVED" }),
      item("2", "LONG_HEADLINE", { text: STALE_LONG[1], approval: "APPROVED" }),
    ];
    const plan = planPhase2Removal(items, classifyAssetGroupAssets(items));
    const lh = plan.fields.find((f) => f.fieldType === "LONG_HEADLINE")!;
    assert.deepEqual(lh.retain, [items[1].assetGroupAssetResourceName]);
    assert.deepEqual(lh.remove, [items[0].assetGroupAssetResourceName]);
  });
});

describe("#8550 sync — logo usado como marketing image", () => {
  it("logo_1.91:1.jpg (MARKETING_IMAGE real do grupo) é needsReview, não keep", () => {
    const c = classifyAssetGroupAssets([item("318613044963", "MARKETING_IMAGE", { imageName: "logo_1.91:1.jpg", approval: "APPROVED" })]);
    assert.equal(c.needsReview.length, 1);
    assert.equal(c.keep.length, 0);
  });
});

describe("#8550 sync — texto acima do limite é reportado, nunca truncado", () => {
  it("headline de 33 chars (título do d1 na Meta) vira erro com o texto inteiro", () => {
    const longo = "De centenas de links para uns dez";
    const headlines = ["5 minutos por dia", "Também o lado ruim da IA", longo];
    const v = validateNewTextAssetPlan(headlines, NEW_LONG_HEADLINES, NEW_DESCRIPTIONS);
    assert.equal(v.ok, false);
    assert.ok(v.errors.some((e) => e.includes(`"${longo}"`) && e.includes("33 chars")));
    assert.equal(headlines[2], longo, "o input não é alterado");
  });

  it("o relatório carrega os erros de texto em `violations`", () => {
    const items = oldGroup();
    const report = buildSyncPlanReport({
      generatedAt: "2026-10-03T00:00:00Z",
      assetGroup: GROUP,
      mode: "dry-run",
      items,
      classification: classifyAssetGroupAssets(items),
      text: { headlines: ["x"], longHeadlines: [], descriptions: [], errors: ['headline "y" tem 40 chars (máx 30)'] },
      images: { manifest: null, pending: ["sem manifesto"] },
      phase1Plans: [],
      capacityErrors: [],
    });
    assert.ok(report.violations.some((v) => v.includes("40 chars")));
  });
});

describe("#8550 sync — buildSyncPlanReport (dry-run)", () => {
  it("plano completo do conjunto da issue: nenhum passo fora dos limites; Fase 2 projetada remove todo o stale de texto", () => {
    const items = oldGroup();
    const classification = classifyAssetGroupAssets(items);
    const linkPlan = planTextFieldLinks(items, classification, { HEADLINE: 4, LONG_HEADLINE: 5, DESCRIPTION: 5 });
    const report = buildSyncPlanReport({
      generatedAt: "2026-10-03T00:00:00Z",
      assetGroup: GROUP,
      mode: "dry-run",
      items,
      classification,
      text: { headlines: NEW_HEADLINES, longHeadlines: NEW_LONG_HEADLINES, descriptions: NEW_DESCRIPTIONS, errors: [] },
      images: { manifest: null, pending: ["sem manifesto"] },
      phase1Plans: linkPlan.plans,
      capacityErrors: [],
    });
    assert.deepEqual(report.violations, []);
    assert.equal(report.phase2.assumedNewApproved, true);
    assert.match(report.phase2.snapshot.label, /assume os novos já APROVADOS/);
    const final = report.phase2.snapshot.counts;
    for (const [ft, n] of Object.entries(final)) {
      assert.ok(n >= PMAX_MANAGED_FIELD_LIMITS[ft as keyof FieldCounts].min, `${ft} terminou com ${n}`);
    }
    assert.equal(final.HEADLINE, 5); // 4 novos + diar.ia.br
    // Sem imagens novas, a Fase 2 projetada mantém 1 antiga por tipo obrigatório
    // (o logo needsReview não conta no piso, mas segue no grupo).
    assert.equal(final.MARKETING_IMAGE, 1);
    assert.equal(final.SQUARE_MARKETING_IMAGE, 2);
    // LONG_HEADLINE/DESCRIPTION: 2 antigos + 5 novos > 5 → os 2 saem no link e
    // o tipo fica só com novos — a limitação conhecida (#9017) vai pro relatório.
    assert.ok(report.notes.some((n) => n.includes("INTEIRO")));
    JSON.parse(JSON.stringify(report)); // serializável
  });

  it("projectItemsAfterPhase1 marca os novos como aprovados só quando pedido (premissa explícita)", () => {
    const steps = [{ label: "x", add: { HEADLINE: 2 }, remove: [] }];
    assert.ok(projectItemsAfterPhase1([], steps, true).every((i) => i.approvalStatus === "APPROVED"));
    assert.ok(projectItemsAfterPhase1([], steps, false).every((i) => i.approvalStatus === undefined));
  });
});

describe("#8550 sync — releitura pós-mutação", () => {
  it("verifyLinkedAfterApply acusa asset que não aparece ENABLED no tipo pedido", () => {
    const after = [item("1", "HEADLINE", { text: "a" }), item("2", "HEADLINE", { text: "b", status: "REMOVED" })];
    const errors = verifyLinkedAfterApply(after, [{ fieldType: "HEADLINE", assetResourceNames: [`customers/${CUSTOMER}/assets/1`, `customers/${CUSTOMER}/assets/2`, `customers/${CUSTOMER}/assets/3`] }]);
    assert.equal(errors.length, 2);
    assert.deepEqual(verifyLinkedAfterApply(after, [{ fieldType: "LONG_HEADLINE", assetResourceNames: [`customers/${CUSTOMER}/assets/1`] }]).length, 1);
  });

  it("verifyRemovedAfterApply acusa removido que segue ENABLED", () => {
    const after = [item("1", "HEADLINE", { text: "a" })];
    assert.equal(verifyRemovedAfterApply(after, [after[0].assetGroupAssetResourceName]).length, 1);
    assert.equal(verifyRemovedAfterApply(after, ["outro"]).length, 0);
  });
});

describe("#8550 sync — regras de comprimento e casos de aprovação", () => {
  it("sem DESCRIPTION nova curta aprovada, mantém a stale aprovada MAIS CURTA (≤60)", () => {
    const longNew = NEW_DESCRIPTIONS.filter((d) => d.length > 60).slice(0, 2);
    const items = [
      ...longNew.map((t, k) => item(`70${k}`, "DESCRIPTION", { text: t, approval: "APPROVED" })),
      item("710", "DESCRIPTION", { text: "As notícias mais importantes sobre IA, resumidas para você.", approval: "APPROVED" }), // 59
      item("711", "DESCRIPTION", { text: "Receba atualizações diárias sobre as últimas novidades em IA.", approval: "APPROVED" }), // 61
    ];
    const plan = planPhase2Removal(items, classifyAssetGroupAssets(items));
    const d = plan.fields.find((f) => f.fieldType === "DESCRIPTION")!;
    assert.equal(d.shortRule?.status, "retained");
    assert.deepEqual(d.retain, [items[2].assetGroupAssetResourceName]);
    assert.deepEqual(d.remove, [items[3].assetGroupAssetResourceName]);
  });

  it("HEADLINE ≤15 (premissa conservadora): diar.ia.br aprovado já atende", () => {
    const items = [
      item("1", "HEADLINE", { text: "diar.ia.br", approval: "APPROVED" }),
      ...NEW_HEADLINES.map((t, k) => item(`2${k}`, "HEADLINE", { text: t, approval: "APPROVED" })),
      item("9", "HEADLINE", { text: "Dicas de IA", approval: "APPROVED" }),
    ];
    const plan = planPhase2Removal(items, classifyAssetGroupAssets(items));
    const h = plan.fields.find((f) => f.fieldType === "HEADLINE")!;
    assert.equal(h.shortRule?.status, "permanent");
    assert.equal(h.remove.length, 1);
  });

  it("HEADLINE ≤15 sem nenhum curto aprovado entre os permanentes: mantém o stale curto aprovado", () => {
    const items = [
      ...NEW_HEADLINES.map((t, k) => item(`2${k}`, "HEADLINE", { text: t, approval: "APPROVED" })),
      item("9", "HEADLINE", { text: "Dicas de IA", approval: "APPROVED" }),
    ];
    const plan = planPhase2Removal(items, classifyAssetGroupAssets(items));
    const h = plan.fields.find((f) => f.fieldType === "HEADLINE")!;
    assert.equal(h.shortRule?.status, "retained");
    assert.equal(h.remove.length, 0);
  });

  it("todo o stale REPROVADO e nenhum novo aprovado: mantém o necessário ao mínimo, sem regra curta atendível", () => {
    const items = STALE_LONG.map((t, k) => item(`5${k}`, "LONG_HEADLINE", { text: t, approval: "DISAPPROVED" }));
    const plan = planPhase2Removal(items, classifyAssetGroupAssets(items));
    const lh = plan.fields.find((f) => f.fieldType === "LONG_HEADLINE")!;
    assert.equal(lh.retain.length, 1);
    assert.equal(lh.remove.length, 1);
    const desc = STALE_DESC.map((t, k) => item(`6${k}`, "DESCRIPTION", { text: t, approval: "DISAPPROVED" }));
    const dplan = planPhase2Removal(desc, classifyAssetGroupAssets(desc));
    const d = dplan.fields.find((f) => f.fieldType === "DESCRIPTION")!;
    assert.equal(d.retain.length, 2, "mínimo 2 mesmo reprovados");
    // Só o reprovado EXPLÍCITO justifica `unmet` (#9557): nada curto e
    // não-reprovado sai no `remove`.
    assert.equal(d.shortRule?.status, "unmet", "reprovado não atende a regra curta");
    assert.equal(d.remove.length, 0);
  });

  it("#9557: sem aprovação lida (policy_summary ausente), NÃO remove a única DESCRIPTION ≤60 — retém a curta de aprovação desconhecida", () => {
    // Cenário da issue: `--send --remove-stale` sem policy_summary. O piso de
    // contagem mantém as 2 primeiras stale (uma de 85 chars) e, antes do fix,
    // a única ≤60 caía no `remove` com status `unmet` (só nota).
    const longNew = NEW_DESCRIPTIONS.filter((t) => t.length > 60).slice(0, 2);
    const stale85 = "As notícias mais importantes sobre IA chegando todos os dias na sua caixa de entrada.";
    const stale61 = "Receba atualizações diárias sobre as últimas novidades em IA.";
    const stale59 = "As notícias mais importantes sobre IA, resumidas para você.";
    assert.ok(stale85.length > 60 && stale61.length > 60 && stale59.length <= 60, "premissa de comprimento do cenário");
    const items = [
      ...longNew.map((t, k) => item(`80${k}`, "DESCRIPTION", { text: t })), // sem approval
      item("810", "DESCRIPTION", { text: stale85 }),
      item("811", "DESCRIPTION", { text: stale61 }),
      item("812", "DESCRIPTION", { text: stale59 }),
    ];
    const classification = classifyAssetGroupAssets(items);
    assert.equal(classification.stale.length, 3, "premissa: as 3 antigas são stale");
    const plan = planPhase2Removal(items, classification);
    const d = plan.fields.find((f) => f.fieldType === "DESCRIPTION")!;
    const short = items[4].assetGroupAssetResourceName;
    assert.ok(!d.remove.includes(short), "a única DESCRIPTION ≤60 não pode sair");
    assert.ok(d.retain.includes(short));
    assert.equal(d.shortRule?.status, "retained-unconfirmed");
    assert.ok(!plan.remove.includes(short));

    // E o relatório em modo phase2 não declara violação nem trata como "nada a preservar".
    const report = buildSyncPlanReport({
      generatedAt: "x", assetGroup: GROUP, mode: "phase2-dry-run", items, classification,
      text: { headlines: [], longHeadlines: [], descriptions: [], errors: [] },
      images: { manifest: null, pending: [] }, phase1Plans: [], capacityErrors: [],
    });
    assert.deepEqual(report.violations.filter((v) => v.includes("DESCRIPTION")), []);
    assert.ok(report.notes.some((n) => n.includes("DESCRIPTION") && n.includes("#9557")));
    assert.ok(!report.notes.some((n) => n.startsWith("DESCRIPTION") && n.includes("nada a preservar")));
  });

  it("#9557: curto de aprovação desconhecida já mantido pelo piso de contagem conta como retained-unconfirmed (sem reter a mais)", () => {
    const stale59 = "As notícias mais importantes sobre IA, resumidas para você.";
    const stale61 = "Receba atualizações diárias sobre as últimas novidades em IA.";
    const items = [item("820", "DESCRIPTION", { text: stale59 }), item("821", "DESCRIPTION", { text: stale61 })];
    const plan = planPhase2Removal(items, classifyAssetGroupAssets(items));
    const d = plan.fields.find((f) => f.fieldType === "DESCRIPTION")!;
    assert.equal(d.retain.length, 2, "piso de contagem segura os 2");
    assert.equal(d.shortRule?.status, "retained-unconfirmed");
  });

  it("simulateSteps: remove de tipo não resolvido vira violação explícita", () => {
    const [s] = simulateSteps(zero(), [{ label: "x", add: {}, remove: [{ resourceName: "r", fieldType: "UNKNOWN" }] }]);
    assert.match(s.violations.join(), /tipo não resolvido \(UNKNOWN\)/);
  });

  it("relatório registra a limitação de troca do tipo INTEIRO (#9017)", () => {
    const items = [
      ...oldGroup().filter((i) => i.fieldType !== "LONG_HEADLINE"),
      ...["a", "b", "c", "d", "e"].map((x, k) => item(`4${k}`, "LONG_HEADLINE", { text: STALE_LONG[k % 2], approval: "APPROVED" })),
    ];
    const classification = classifyAssetGroupAssets(items);
    const linkPlan = planTextFieldLinks(items, classification, { HEADLINE: 4, LONG_HEADLINE: 5, DESCRIPTION: 5 });
    const report = buildSyncPlanReport({
      generatedAt: "x", assetGroup: GROUP, mode: "dry-run", items, classification,
      text: { headlines: NEW_HEADLINES, longHeadlines: NEW_LONG_HEADLINES, descriptions: NEW_DESCRIPTIONS, errors: [] },
      images: { manifest: null, pending: [] }, phase1Plans: linkPlan.plans, capacityErrors: [],
    });
    assert.ok(report.notes.some((n) => n.includes("INTEIRO")));
  });
});

describe("#8550 sync — leitura de approval_status/primary_status", () => {
  it("query pede os dois campos e o parser os preserva (e omite quando ausentes)", () => {
    const q = buildAssetGroupAssetsQuery(GROUP);
    assert.match(q, /asset_group_asset\.primary_status/);
    assert.match(q, /asset_group_asset\.policy_summary\.approval_status/);
    const [withStatus, without] = parseAssetGroupAssetRows([
      {
        asset: { resourceName: "customers/1/assets/1", id: "1", type: "TEXT", textAsset: { text: "a" } },
        assetGroupAsset: { resourceName: "r1", asset: "customers/1/assets/1", fieldType: "HEADLINE", status: "ENABLED", primaryStatus: "NOT_ELIGIBLE", policySummary: { approvalStatus: "APPROVED" } },
      },
      {
        asset: { resourceName: "customers/1/assets/2", id: "2", type: "TEXT", textAsset: { text: "b" } },
        assetGroupAsset: { resourceName: "r2", asset: "customers/1/assets/2", fieldType: "HEADLINE", status: "ENABLED" },
      },
    ]);
    assert.equal(withStatus.approvalStatus, "APPROVED");
    assert.equal(withStatus.primaryStatus, "NOT_ELIGIBLE");
    assert.ok(!("approvalStatus" in without) && !("primaryStatus" in without));
  });
});

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const AUTH_ENV = {
  GOOGLE_ADS_CLIENT_ID: "client-id",
  GOOGLE_ADS_CLIENT_SECRET: "client-secret",
  GOOGLE_ADS_REFRESH_TOKEN: "refresh-token",
  GOOGLE_ADS_DEVELOPER_TOKEN: "dev-token",
  GOOGLE_ADS_LOGIN_CUSTOMER_ID: "6236094249",
  GOOGLE_ADS_CUSTOMER_ID: CUSTOMER,
};

async function withEnv<T>(overrides: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const saved: Record<string, string | undefined> = {};
  for (const key of Object.keys(overrides)) saved[key] = process.env[key];
  Object.assign(process.env, overrides);
  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function toRow(i: AssetGroupAssetItem): AssetGroupAssetApiRow {
  return {
    asset: { resourceName: i.assetResourceName, id: i.assetId, type: i.assetType, ...(i.text ? { textAsset: { text: i.text } } : {}), ...(i.imageName ? { name: i.imageName } : {}) },
    assetGroupAsset: {
      resourceName: i.assetGroupAssetResourceName,
      asset: i.assetResourceName,
      fieldType: i.fieldType,
      status: i.status,
      ...(i.approvalStatus ? { policySummary: { approvalStatus: i.approvalStatus } } : {}),
    },
  };
}

describe("#8550 sync — CLI", () => {
  it("dry-run grava o plano JSON em --plan-out e não muta nada", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gads-pmax-sync-dry-"));
    try {
      const rows = oldGroup().map(toRow);
      const calls: string[] = [];
      const fetchMock = async (input: string) => {
        if (input === "https://oauth2.googleapis.com/token") return jsonResponse(200, { access_token: "tok" });
        calls.push(input);
        if (input.endsWith(":search")) return jsonResponse(200, { results: rows });
        throw new Error(`chamada inesperada: ${input}`);
      };
      const planOut = join(dir, "plan.json");
      const code = await withEnv(AUTH_ENV, () => swapMain(["--customer-id", CUSTOMER, "--plan-out", planOut], fetchMock as unknown as typeof fetch));
      assert.equal(code, 0);
      assert.ok(!calls.some((c) => c.includes(":mutate")));
      const report = JSON.parse(readFileSync(planOut, "utf8"));
      assert.equal(report.mode, "dry-run");
      assert.equal(report.phase1.steps.length, 3);
      assert.deepEqual(report.violations, []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("--send --remove-stale ANTES da Fase 1 remove só o excedente acima do piso", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gads-pmax-sync-p2-"));
    try {
      const items = oldGroup();
      let removed: string[] = [];
      const inner = async (input: string, init?: RequestInit) => {
        if (input === "https://oauth2.googleapis.com/token") return jsonResponse(200, { access_token: "tok" });
        if (input.endsWith("assetGroupAssets:mutate")) {
          removed = JSON.parse(String(init?.body)).operations.map((op: { remove: string }) => op.remove);
          return jsonResponse(200, { results: removed.map((r) => ({ resourceName: r })) });
        }
        throw new Error(`chamada inesperada: ${input}`);
      };
      const code = await withEnv(AUTH_ENV, () =>
        swapMain(["--customer-id", CUSTOMER, "--send", "--remove-stale", "--plan-out", join(dir, "p.json")], withStatefulSearch(inner, items.map(toRow)) as unknown as typeof fetch, () => []),
      );
      assert.equal(code, 0);
      const after = items.filter((i) => !removed.includes(i.assetGroupAssetResourceName));
      assert.deepEqual(fieldsBelowMin(after), []);
      // Por tipo, exatamente o que o plano puro manda remover.
      const expected: Phase2RemovalPlan = planPhase2Removal(items, classifyAssetGroupAssets(items));
      for (const f of expected.fields) {
        assert.deepEqual(removed.filter((r) => f.remove.includes(r)).sort(), [...f.remove].sort(), f.fieldType);
      }
      assert.equal(removed.length, expected.remove.length);
      assert.ok(removed.length > 0 && removed.length < classifyAssetGroupAssets(items).stale.length);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  for (const approval of ["UNKNOWN", "DISAPPROVED", null] as const) {
    it(`Fase 1 → Fase 2 com os novos ${approval ?? "sem approval_status"}: a releitura nunca fica abaixo do mínimo`, async () => {
      const dir = mkdtempSync(join(tmpdir(), "gads-pmax-sync-p2-pending-"));
      try {
        const img = (n: string) => {
          const p = join(dir, n);
          writeFileSync(p, Buffer.from(n));
          return p;
        };
        const manifestPath = join(dir, "manifest.json");
        writeFileSync(manifestPath, JSON.stringify({ SQUARE_MARKETING_IMAGE: [img("a.jpg")], MARKETING_IMAGE: [img("b.jpg")], PORTRAIT_MARKETING_IMAGE: [img("c.jpg")] }));
        let assetCounter = 8000;
        const inner = async (input: string, init?: RequestInit) => {
          if (input === "https://oauth2.googleapis.com/token") return jsonResponse(200, { access_token: "tok" });
          const ops = JSON.parse(String(init?.body)).operations;
          if (input.endsWith("assets:mutate")) return jsonResponse(200, { results: ops.map(() => ({ resourceName: `customers/${CUSTOMER}/assets/${assetCounter++}` })) });
          if (input.endsWith("assetGroupAssets:mutate")) return jsonResponse(200, { results: ops.map(() => ({ resourceName: "x" })) });
          throw new Error(`chamada inesperada: ${input}`);
        };
        const api = withStatefulSearch(inner, oldGroup().map(toRow), { newApprovalStatus: approval });
        const p1 = await withEnv(AUTH_ENV, () =>
          swapMain(
            ["--customer-id", CUSTOMER, "--send", "--images-manifest", manifestPath, "--progress-file", join(dir, "progress.json"), "--plan-out", join(dir, "p1.json")],
            api as unknown as typeof fetch,
            () => [],
          ),
        );
        assert.equal(p1, 0);
        const p2 = await withEnv(AUTH_ENV, () =>
          swapMain(["--customer-id", CUSTOMER, "--send", "--remove-stale", "--plan-out", join(dir, "p2.json")], api as unknown as typeof fetch, () => []),
        );
        assert.equal(p2, 0);
        const res = await api(`https://googleads.googleapis.com/v0/customers/${CUSTOMER}/googleAds:search`);
        const finalItems = parseAssetGroupAssetRows((await res.json()).results);
        assert.deepEqual(fieldsBelowMin(finalItems), []);
        // Novos pendentes/reprovados não contam: sobra stale aprovado nos tipos em
        // que a Fase 1 não trocou tudo (LONG_HEADLINE/DESCRIPTION foram trocados
        // inteiros no link — limitação conhecida do #9017).
        const stale = classifyAssetGroupAssets(finalItems).stale;
        for (const ft of ["HEADLINE", "SQUARE_MARKETING_IMAGE", "MARKETING_IMAGE"]) {
          assert.ok(stale.some((i) => i.fieldType === ft), `${ft} precisa manter stale aprovado`);
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }

  it("releitura que FALHA depois da remoção (search HTTP 500) → exit 1", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gads-pmax-sync-reread-fail-"));
    try {
      const rows = oldGroup().map(toRow);
      let searches = 0;
      const fetchMock = async (input: string, init?: RequestInit) => {
        if (input === "https://oauth2.googleapis.com/token") return jsonResponse(200, { access_token: "tok" });
        if (input.endsWith(":search")) return ++searches === 1 ? jsonResponse(200, { results: rows }) : jsonResponse(500, { error: "x" });
        if (input.endsWith("assetGroupAssets:mutate")) {
          const ops = JSON.parse(String(init?.body)).operations;
          return jsonResponse(200, { results: ops.map(() => ({ resourceName: "x" })) });
        }
        throw new Error(`chamada inesperada: ${input}`);
      };
      const code = await withEnv(AUTH_ENV, () =>
        swapMain(["--customer-id", CUSTOMER, "--send", "--remove-stale", "--plan-out", join(dir, "p.json")], fetchMock as unknown as typeof fetch, () => []),
      );
      assert.equal(code, 1);
      assert.equal(searches, 2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("search com nextPageToken (estado parcial) recusa antes de planejar ou mutar", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gads-pmax-sync-page-"));
    try {
      const fetchMock = async (input: string) => {
        if (input === "https://oauth2.googleapis.com/token") return jsonResponse(200, { access_token: "tok" });
        if (input.endsWith(":search")) return jsonResponse(200, { results: oldGroup().map(toRow), nextPageToken: "p2" });
        throw new Error(`chamada inesperada: ${input}`);
      };
      const code = await withEnv(AUTH_ENV, () =>
        swapMain(["--customer-id", CUSTOMER, "--send", "--remove-stale", "--plan-out", join(dir, "p.json")], fetchMock as unknown as typeof fetch, () => []),
      );
      assert.equal(code, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("remoção com 2xx mas sem efeito na releitura (escrita silenciosa) → exit 1", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gads-pmax-sync-silent-"));
    try {
      const rows = oldGroup().map(toRow);
      const fetchMock = async (input: string, init?: RequestInit) => {
        if (input === "https://oauth2.googleapis.com/token") return jsonResponse(200, { access_token: "tok" });
        if (input.endsWith(":search")) return jsonResponse(200, { results: rows }); // nunca muda
        if (input.endsWith("assetGroupAssets:mutate")) {
          const ops = JSON.parse(String(init?.body)).operations;
          return jsonResponse(200, { results: ops.map(() => ({ resourceName: "x" })) });
        }
        throw new Error(`chamada inesperada: ${input}`);
      };
      const code = await withEnv(AUTH_ENV, () =>
        swapMain(["--customer-id", CUSTOMER, "--send", "--remove-stale", "--plan-out", join(dir, "p.json")], fetchMock as unknown as typeof fetch, () => []),
      );
      assert.equal(code, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("Fase 1 com 2xx mas links ausentes na releitura → exit 1 e progresso preservado", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gads-pmax-sync-p1-silent-"));
    try {
      const img = (n: string) => {
        const p = join(dir, n);
        writeFileSync(p, Buffer.from(n));
        return p;
      };
      const manifestPath = join(dir, "manifest.json");
      writeFileSync(manifestPath, JSON.stringify({ SQUARE_MARKETING_IMAGE: [img("a.jpg")], MARKETING_IMAGE: [img("b.jpg")], PORTRAIT_MARKETING_IMAGE: [img("c.jpg")] }));
      const rows = oldGroup().map(toRow);
      let assetCounter = 7000;
      const fetchMock = async (input: string, init?: RequestInit) => {
        if (input === "https://oauth2.googleapis.com/token") return jsonResponse(200, { access_token: "tok" });
        if (input.endsWith(":search")) return jsonResponse(200, { results: rows }); // nunca reflete os links
        const ops = JSON.parse(String(init?.body)).operations;
        if (input.endsWith("assets:mutate")) return jsonResponse(200, { results: ops.map(() => ({ resourceName: `customers/${CUSTOMER}/assets/${assetCounter++}` })) });
        if (input.endsWith("assetGroupAssets:mutate")) return jsonResponse(200, { results: ops.map(() => ({ resourceName: "x" })) });
        throw new Error(`chamada inesperada: ${input}`);
      };
      const progressFile = join(dir, "progress.json");
      const code = await withEnv(AUTH_ENV, () =>
        swapMain(
          ["--customer-id", CUSTOMER, "--send", "--images-manifest", manifestPath, "--progress-file", progressFile, "--plan-out", join(dir, "p.json")],
          fetchMock as unknown as typeof fetch,
          () => [],
        ),
      );
      assert.equal(code, 1);
      const progress = JSON.parse(readFileSync(progressFile, "utf8"));
      assert.ok(Object.values(progress.steps).every((s) => (s as { linked: boolean }).linked), "retry não recria nem relinka");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
