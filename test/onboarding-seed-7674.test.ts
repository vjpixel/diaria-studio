/**
 * test/onboarding-seed-7674.test.ts (#7674)
 *
 * Trava o modo dirigido do onboarding — "processe exatamente esta lista".
 *
 * O teste que a issue pede explicitamente (requisito 8) é o último bloco:
 * lista com um endereço já processado ⇒ o plano aborta e NENHUMA entrada é
 * produzida. É a defesa contra repetir o #6043 em miniatura (boas-vindas
 * reenviada a quem já recebeu), e contra o modo de falha que a issue chama
 * de "pular em silêncio".
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  planSeed,
  renderSeedPlan,
  normalizeSeedEmail,
  isoToEpochSeconds,
  type SeedKitSubscriber,
  type SeedExistingEntry,
} from "../scripts/lib/onboarding-seed.ts";

function kit(email: string, over: Partial<SeedKitSubscriber> = {}): SeedKitSubscriber {
  return { id: 4264399626, email, state: "active", created_at: "2026-09-08T10:13:27Z", ...over };
}
function kitMap(...subs: SeedKitSubscriber[]): Map<string, SeedKitSubscriber> {
  return new Map(subs.map((s) => [s.email.toLowerCase(), s]));
}
function storeMap(...es: SeedExistingEntry[]): Map<string, SeedExistingEntry> {
  return new Map(es.map((e) => [e.email.toLowerCase(), e]));
}

test("normalizeSeedEmail apara espaço e baixa a caixa", () => {
  assert.equal(normalizeSeedEmail("  Pedro@Example.COM \n"), "pedro@example.com");
});

test("isoToEpochSeconds converte ISO do Kit e recusa data inválida", () => {
  assert.equal(isoToEpochSeconds("2026-09-08T10:13:27Z"), Date.UTC(2026, 8, 8, 10, 13, 27) / 1000);
  assert.equal(isoToEpochSeconds("nao-e-data"), null);
});

test("#7665: coorte sem nada recebido é semeada com e-mail 1 PENDENTE", () => {
  const plan = planSeed({
    emails: ["orfao1@x.com", "orfao2@x.com"],
    kitByEmail: kitMap(kit("orfao1@x.com", { id: 1 }), kit("orfao2@x.com", { id: 2 })),
    existingByEmail: storeMap(),
    seedEmail1SentAt: null,
    seededBy: "#7665",
  });
  assert.equal(plan.ok, true);
  assert.equal(plan.entries.length, 2);
  for (const e of plan.entries) {
    assert.equal(e.email1_sent_at, null, "e-mail 1 fica pendente: a coorte não recebeu nada");
    assert.equal(e.seeded_by, "#7665");
    assert.equal(e.subscription_id, e.key);
    assert.ok(Number.isInteger(e.created_at) && e.created_at > 0, "created_at nunca pode ser 0 — D+3/D+10 venceriam na hora");
  }
});

test("#7675: coorte que já recebeu o e-mail 1 pelo Kit entra com a data preenchida", () => {
  const plan = planSeed({
    emails: ["rampa@x.com"],
    kitByEmail: kitMap(kit("rampa@x.com", { id: 7, created_at: "2026-09-05T14:00:00Z" })),
    existingByEmail: storeMap(),
    seedEmail1SentAt: "2026-09-05T14:02:00Z",
    seededBy: "#7675",
  });
  assert.equal(plan.ok, true);
  assert.equal(
    plan.entries[0].email1_sent_at,
    "2026-09-05T14:02:00Z",
    "sem isto o caminho normal reenviaria boas-vindas a quem já recebeu",
  );
});

test("subscription_id semeado é o id NUMÉRICO do Kit, nunca um sub_... da Beehiiv (#7670)", () => {
  const plan = planSeed({
    emails: ["a@x.com"],
    kitByEmail: kitMap(kit("a@x.com", { id: 4264399626 })),
    existingByEmail: storeMap(),
    seedEmail1SentAt: null,
    seededBy: "#7665",
  });
  assert.equal(plan.ok, true);
  assert.equal(plan.entries[0].subscription_id, "4264399626");
  assert.ok(!plan.entries[0].subscription_id.startsWith("sub_"));
});

test("assinante não-active é recusado — complained/bounced nunca é semeado", () => {
  for (const state of ["complained", "bounced", "cancelled", "inactive"]) {
    const plan = planSeed({
      emails: ["supri@x.com"],
      kitByEmail: kitMap(kit("supri@x.com", { state })),
      existingByEmail: storeMap(),
      seedEmail1SentAt: null,
      seededBy: "#7665",
    });
    assert.equal(plan.ok, false, `state=${state} deveria abortar`);
    assert.equal(plan.refusals[0].reason, "estado_nao_active");
  }
});

test("e-mail ausente do Kit é recusado, e a recusa nomeia o endereço", () => {
  const plan = planSeed({
    emails: ["existe@x.com", "fantasma@x.com"],
    kitByEmail: kitMap(kit("existe@x.com")),
    existingByEmail: storeMap(),
    seedEmail1SentAt: null,
    seededBy: "#7665",
  });
  assert.equal(plan.ok, false);
  assert.deepEqual(
    plan.refusals.map((r) => [r.email, r.reason]),
    [["fantasma@x.com", "nao_encontrado_no_kit"]],
  );
});

test("duplicata na lista de entrada aborta", () => {
  const plan = planSeed({
    emails: ["a@x.com", "A@X.com"],
    kitByEmail: kitMap(kit("a@x.com")),
    existingByEmail: storeMap(),
    seedEmail1SentAt: null,
    seededBy: "#7665",
  });
  assert.equal(plan.ok, false);
  assert.equal(plan.refusals[0].reason, "duplicado_na_lista");
});

test("seededBy vazio aborta — entrada sem origem não é auditável depois", () => {
  const plan = planSeed({
    emails: ["a@x.com"],
    kitByEmail: kitMap(kit("a@x.com")),
    existingByEmail: storeMap(),
    seedEmail1SentAt: null,
    seededBy: "   ",
  });
  assert.equal(plan.ok, false);
  assert.equal(plan.refusals[0].reason, "seeded_by_ausente");
});

test("todas as recusas são reportadas juntas, não só a primeira", () => {
  const plan = planSeed({
    emails: ["fantasma@x.com", "supri@x.com", "ok@x.com"],
    kitByEmail: kitMap(kit("supri@x.com", { state: "complained" }), kit("ok@x.com")),
    existingByEmail: storeMap(),
    seedEmail1SentAt: null,
    seededBy: "#7665",
  });
  assert.equal(plan.ok, false);
  assert.equal(plan.refusals.length, 2, "operador corrige a lista de uma vez, não uma recusa por rodada");
});

// --- requisito 8 da #7674: o teste de regressão que a issue pede ---------

test("REGRESSÃO #7674: lista com endereço JÁ processado aborta o run inteiro, sem semear nada", () => {
  const plan = planSeed({
    emails: ["novo@x.com", "javeio@x.com"],
    kitByEmail: kitMap(kit("novo@x.com", { id: 1 }), kit("javeio@x.com", { id: 2 })),
    existingByEmail: storeMap({
      subscription_id: "2",
      email: "javeio@x.com",
      email1_sent_at: "2026-09-05T12:05:00Z",
    }),
    seedEmail1SentAt: null,
    seededBy: "#7665",
  });

  assert.equal(plan.ok, false, "um endereço já processado invalida o lote inteiro");
  assert.equal(plan.entries.length, 0, "nem o endereço válido é semeado — tudo-ou-nada");
  const r = plan.refusals.find((x) => x.email === "javeio@x.com");
  assert.ok(r, "a recusa precisa nomear QUAL endereço causou o aborto");
  assert.equal(r.reason, "ja_no_store");
  assert.match(r.detalhe ?? "", /2026-09-05T12:05:00Z/, "o detalhe diz quando o e-mail 1 já saiu");
});

test("render do dry-run imprime a lista NOMINAL, não só a contagem", () => {
  const plan = planSeed({
    emails: ["um@x.com", "dois@x.com"],
    kitByEmail: kitMap(kit("um@x.com", { id: 1 }), kit("dois@x.com", { id: 2 })),
    existingByEmail: storeMap(),
    seedEmail1SentAt: null,
    seededBy: "#7665",
  });
  const out = renderSeedPlan(plan, { send: false, seededBy: "#7665" });
  assert.match(out, /um@x\.com/);
  assert.match(out, /dois@x\.com/);
  assert.match(out, /dry-run/, "sem --send o operador precisa ver que nada foi escrito");
});

test("render de plano abortado lista cada recusa com motivo", () => {
  const plan = planSeed({
    emails: ["fantasma@x.com"],
    kitByEmail: kitMap(),
    existingByEmail: storeMap(),
    seedEmail1SentAt: null,
    seededBy: "#7665",
  });
  const out = renderSeedPlan(plan, { send: true, seededBy: "#7665" });
  assert.match(out, /ABORTADO/);
  assert.match(out, /fantasma@x\.com: nao_encontrado_no_kit/);
});
