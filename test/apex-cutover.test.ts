/**
 * apex-cutover.test.ts (#467)
 *
 * Testa o miolo puro de `scripts/lib/apex-cutover.ts` — sem rede, sem mock de
 * fetch (o módulo não faz I/O). Cobre os 3 requisitos não-negociáveis da
 * unidade:
 *   1. guard de pré-condição do --cutover recusando quando "/" ou "/subscribe"
 *      não dão 200;
 *   2. plano de rollback produzindo exatamente os valores da §1 do
 *      docs/apex-cutover-rollback.md;
 *   3. garantia de que nenhum plano gerado toca MX/TXT/CAA.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  APEX_HOSTNAME,
  WORKER_NAME,
  ZONE_ID,
  ALLOWED_DNS_RECORD_TYPES,
  FORBIDDEN_DNS_RECORD_TYPES,
  PRE_CUTOVER_DNS_RECORDS,
  assertAllowedDnsRecordType,
  evaluateCutoverPrecondition,
  buildCutoverPlan,
  buildRollbackDnsPlan,
  buildRollbackPlan,
  assertPlanTouchesOnlyAllowedRecordTypes,
  verifyDnsRestored,
  verifyCustomDomainDetached,
  verifyCutoverAttached,
} from "../scripts/lib/apex-cutover.ts";

describe("evaluateCutoverPrecondition — guard de pré-condição (#467, coração desta unidade)", () => {
  it("recusa quando '/' não dá 200", () => {
    const r = evaluateCutoverPrecondition({ workerRootStatus: 404, workerSubscribeStatus: 200 });
    assert.equal(r.ready, false);
    assert.equal(r.blockers.length, 1);
    assert.match(r.blockers[0], /"\/"/);
    assert.match(r.blockers[0], /404/);
  });

  it("recusa quando '/subscribe' não dá 200", () => {
    const r = evaluateCutoverPrecondition({ workerRootStatus: 200, workerSubscribeStatus: 404 });
    assert.equal(r.ready, false);
    assert.equal(r.blockers.length, 1);
    assert.match(r.blockers[0], /"\/subscribe"/);
  });

  it("recusa com os DOIS blockers quando ambos falham — estado real de hoje (26/08/2026, #6359)", () => {
    const r = evaluateCutoverPrecondition({ workerRootStatus: 404, workerSubscribeStatus: 404 });
    assert.equal(r.ready, false);
    assert.equal(r.blockers.length, 2);
  });

  it("recusa em erro de rede (null), não só em status HTTP explícito", () => {
    const r = evaluateCutoverPrecondition({ workerRootStatus: null, workerSubscribeStatus: null });
    assert.equal(r.ready, false);
    assert.equal(r.blockers.length, 2);
  });

  it("recusa um redirect (3xx) — a promessa é 200 exato, não 'responde alguma coisa'", () => {
    const r = evaluateCutoverPrecondition({ workerRootStatus: 307, workerSubscribeStatus: 200 });
    assert.equal(r.ready, false);
  });

  it("libera só quando os DOIS dão 200 exato", () => {
    const r = evaluateCutoverPrecondition({ workerRootStatus: 200, workerSubscribeStatus: 200 });
    assert.equal(r.ready, true);
    assert.deepEqual(r.blockers, []);
  });
});

describe("buildCutoverPlan — mecanismo Workers Custom Domain", () => {
  it("gera exatamente 1 attach, hostname=apex, service=diaria-site", () => {
    const plan = buildCutoverPlan();
    assert.equal(plan.workerDomainOp.op, "attach");
    assert.equal(plan.workerDomainOp.hostname, APEX_HOSTNAME);
    assert.equal(plan.workerDomainOp.service, WORKER_NAME);
    assert.equal(plan.workerDomainOp.zoneId, ZONE_ID);
  });

  it("nunca gera operação de DNS — o attach gerencia isso, tocar A/AAAA seria disputar", () => {
    const plan = buildCutoverPlan() as unknown as { dnsOps?: unknown };
    assert.equal(plan.dnsOps, undefined);
  });
});

describe("buildRollbackDnsPlan — produz exatamente os valores da §1 do doc de rollback", () => {
  it("com registros existentes cujo id BATE com o esperado: PATCH no mesmo id", () => {
    const actual = PRE_CUTOVER_DNS_RECORDS.map((r) => ({ id: r.id, type: r.type }));
    const ops = buildRollbackDnsPlan(actual);
    assert.equal(ops.length, 2);

    const aOp = ops.find((o) => o.type === "A")!;
    assert.equal(aOp.op, "patch");
    assert.equal((aOp as { id: string }).id, "9246e7ffc5e6c8df11c979d31ca6cb1e");
    assert.equal(aOp.content, "104.16.243.55");
    assert.equal(aOp.proxied, true);
    assert.equal(aOp.ttl, 1);

    const aaaaOp = ops.find((o) => o.type === "AAAA")!;
    assert.equal(aaaaOp.op, "patch");
    assert.equal((aaaaOp as { id: string }).id, "1e19bf3285dff54456b607f6564617f7");
    assert.equal(aaaaOp.content, "2001:12ff:0:2::95");
    assert.equal(aaaaOp.proxied, true);
    assert.equal(aaaaOp.ttl, 1);
  });

  it("com registro existente de id DIFERENTE (ex: recriado pelo Custom Domain): PATCH no id NOVO, mesmo corpo esperado", () => {
    const ops = buildRollbackDnsPlan([
      { id: "id-novo-A", type: "A" },
      { id: "id-novo-AAAA", type: "AAAA" },
    ]);
    const aOp = ops.find((o) => o.type === "A")!;
    assert.equal(aOp.op, "patch");
    assert.equal((aOp as { id: string }).id, "id-novo-A");
    assert.equal(aOp.content, "104.16.243.55"); // corpo continua o esperado, não o do registro "novo"
  });

  it("sem NENHUM registro existente: CREATE para os dois tipos", () => {
    const ops = buildRollbackDnsPlan([]);
    assert.equal(ops.length, 2);
    for (const op of ops) {
      assert.equal(op.op, "create");
      assert.equal("id" in op, false);
    }
    const a = ops.find((o) => o.type === "A")!;
    assert.equal(a.content, "104.16.243.55");
    const aaaa = ops.find((o) => o.type === "AAAA")!;
    assert.equal(aaaa.content, "2001:12ff:0:2::95");
  });

  it("faltando só um dos dois tipos: PATCH no que existe, CREATE no que falta", () => {
    const ops = buildRollbackDnsPlan([{ id: "existing-a", type: "A" }]);
    const a = ops.find((o) => o.type === "A")!;
    const aaaa = ops.find((o) => o.type === "AAAA")!;
    assert.equal(a.op, "patch");
    assert.equal(aaaa.op, "create");
  });
});

describe("buildRollbackPlan — ordem detach-antes-de-DNS (docs/apex-cutover-rollback.md §3.1)", () => {
  it("com Custom Domain do apex presente: inclui detachOp", () => {
    const plan = buildRollbackPlan("domain-id-123", []);
    assert.ok(plan.detachOp);
    assert.equal(plan.detachOp!.op, "detach");
    assert.equal(plan.detachOp!.domainId, "domain-id-123");
    assert.equal(plan.detachOp!.hostname, APEX_HOSTNAME);
  });

  it("sem Custom Domain do apex: detachOp é null (nada a soltar)", () => {
    const plan = buildRollbackPlan(null, []);
    assert.equal(plan.detachOp, null);
  });

  it("sempre inclui os 2 dnsOps (A + AAAA), independente do custom domain", () => {
    const plan = buildRollbackPlan(null, []);
    assert.equal(plan.dnsOps.length, 2);
  });
});

describe("Guard MX/TXT/CAA — nenhum plano gerado toca esses tipos (requisito não-negociável)", () => {
  it("ALLOWED_DNS_RECORD_TYPES é exatamente A/AAAA — nada mais", () => {
    assert.deepEqual([...ALLOWED_DNS_RECORD_TYPES].sort(), ["A", "AAAA"]);
  });

  it("FORBIDDEN_DNS_RECORD_TYPES (MX/TXT/CAA) nunca aparece na allowlist", () => {
    for (const forbidden of FORBIDDEN_DNS_RECORD_TYPES) {
      assert.equal((ALLOWED_DNS_RECORD_TYPES as readonly string[]).includes(forbidden), false);
    }
  });

  it("assertAllowedDnsRecordType lança para MX/TXT/CAA", () => {
    for (const forbidden of FORBIDDEN_DNS_RECORD_TYPES) {
      assert.throws(() => assertAllowedDnsRecordType(forbidden), /fora do escopo permitido/);
    }
  });

  it("assertAllowedDnsRecordType NÃO lança para A/AAAA", () => {
    assert.doesNotThrow(() => assertAllowedDnsRecordType("A"));
    assert.doesNotThrow(() => assertAllowedDnsRecordType("AAAA"));
  });

  it("assertPlanTouchesOnlyAllowedRecordTypes lança se um plano (hipotético, malicioso/bugado) incluir MX", () => {
    assert.throws(
      () => assertPlanTouchesOnlyAllowedRecordTypes([{ type: "A" }, { type: "MX" }]),
      /fora do escopo permitido/,
    );
  });

  it("assertPlanTouchesOnlyAllowedRecordTypes NÃO lança para um plano só de A/AAAA", () => {
    assert.doesNotThrow(() => assertPlanTouchesOnlyAllowedRecordTypes([{ type: "A" }, { type: "AAAA" }]));
  });

  it("o plano real de buildRollbackDnsPlan (todos os cenários) nunca inclui tipo fora de A/AAAA", () => {
    const scenarios = [
      buildRollbackDnsPlan([]),
      buildRollbackDnsPlan([{ id: "x", type: "A" }]),
      buildRollbackDnsPlan([{ id: "x", type: "A" }, { id: "y", type: "AAAA" }]),
    ];
    for (const ops of scenarios) {
      for (const op of ops) {
        assert.ok((ALLOWED_DNS_RECORD_TYPES as readonly string[]).includes(op.type));
      }
    }
  });

  it("o plano de buildCutoverPlan não tem sequer um campo de tipo de DNS — não há o que auditar", () => {
    const plan = buildCutoverPlan();
    assert.equal("type" in plan.workerDomainOp, false);
  });
});

describe("verifyDnsRestored — verificação pós-mutação (#573), nunca confia na resposta do PUT/POST", () => {
  it("restaurado corretamente (id pode divergir — não entra na comparação)", () => {
    const r = verifyDnsRestored([
      { type: "A", content: "104.16.243.55", proxied: true, ttl: 1 },
      { type: "AAAA", content: "2001:12ff:0:2::95", proxied: true, ttl: 1 },
    ]);
    assert.equal(r.restored, true);
    assert.deepEqual(r.mismatches, []);
  });

  it("detecta content divergente", () => {
    const r = verifyDnsRestored([
      { type: "A", content: "1.2.3.4", proxied: true, ttl: 1 },
      { type: "AAAA", content: "2001:12ff:0:2::95", proxied: true, ttl: 1 },
    ]);
    assert.equal(r.restored, false);
    assert.equal(r.mismatches.length, 1);
    assert.match(r.mismatches[0], /content/);
  });

  it("detecta proxied divergente", () => {
    const r = verifyDnsRestored([
      { type: "A", content: "104.16.243.55", proxied: false, ttl: 1 },
      { type: "AAAA", content: "2001:12ff:0:2::95", proxied: true, ttl: 1 },
    ]);
    assert.equal(r.restored, false);
    assert.match(r.mismatches[0], /proxied/);
  });

  it("detecta registro ausente", () => {
    const r = verifyDnsRestored([{ type: "A", content: "104.16.243.55", proxied: true, ttl: 1 }]);
    assert.equal(r.restored, false);
    assert.match(r.mismatches[0], /ausente/);
  });
});

describe("verifyCustomDomainDetached / verifyCutoverAttached", () => {
  it("detached=true quando o apex não aparece na lista", () => {
    assert.equal(verifyCustomDomainDetached(["outro.host.com"]), true);
    assert.equal(verifyCustomDomainDetached([]), true);
  });

  it("detached=false quando o apex ainda aparece", () => {
    assert.equal(verifyCustomDomainDetached([APEX_HOSTNAME]), false);
  });

  it("attached=true só quando hostname E service batem", () => {
    assert.equal(
      verifyCutoverAttached([{ hostname: APEX_HOSTNAME, service: WORKER_NAME }]),
      true,
    );
  });

  it("attached=false com hostname certo mas service errado", () => {
    assert.equal(
      verifyCutoverAttached([{ hostname: APEX_HOSTNAME, service: "outro-worker" }]),
      false,
    );
  });

  it("attached=false com lista vazia", () => {
    assert.equal(verifyCutoverAttached([]), false);
  });
});
