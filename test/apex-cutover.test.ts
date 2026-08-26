/**
 * apex-cutover.test.ts (#467, revisado no fleet review da PR #6364)
 *
 * Testa o miolo puro de `scripts/lib/apex-cutover.ts` — sem rede, sem mock de
 * fetch (o módulo não faz I/O). Cobre os requisitos não-negociáveis da
 * unidade:
 *   1. guard de pré-condição do --cutover: `/` precisa servir CONTEÚDO
 *      conhecido (não só 200), `/subscribe` precisa REDIRECIONAR pro destino
 *      certo (não 200 — é um redirect por design, #6359/#6363).
 *   2. plano de rollback ORDENADO (detach sempre antes de qualquer op de
 *      DNS, estrutural — não convenção imperativa do executor).
 *   3. duplicata de registro DNS na zona é erro DURO (buildRollbackDnsPlan)
 *      ou mismatch explícito (verifyDnsRestored) — nunca "primeiro encontrado,
 *      segue em frente".
 *   4. garantia de que nenhum plano gerado toca MX/TXT/CAA (nem qualquer
 *      outro tipo fora de A/AAAA).
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
  EXPECTED_ROOT_MARKER,
  EXPECTED_SUBSCRIBE_REDIRECT_HOST,
  assertAllowedDnsRecordType,
  evaluateCutoverPrecondition,
  buildCutoverPlan,
  buildRollbackDnsPlan,
  buildRollbackPlan,
  extractRollbackDnsOps,
  assertPlanTouchesOnlyAllowedRecordTypes,
  verifyDnsRestored,
  verifyCustomDomainDetached,
  verifyCutoverAttached,
  findApexCustomDomains,
  selectSingleApexCustomDomain,
} from "../scripts/lib/apex-cutover.ts";

const OK_ROOT_BODY = `<html><head><title>diar.ia.br</title></head><body></body></html>`;
const OK_SUBSCRIBE_LOCATION = `https://${EXPECTED_SUBSCRIBE_REDIRECT_HOST}/`;

const READY_INPUT = {
  workerRootStatus: 200,
  workerRootBody: OK_ROOT_BODY,
  workerSubscribeStatus: 302,
  workerSubscribeLocation: OK_SUBSCRIBE_LOCATION,
};

describe("evaluateCutoverPrecondition — guard de pré-condição (#467, coração desta unidade)", () => {
  it("libera quando '/' serve o marcador certo e '/subscribe' redireciona pro destino certo", () => {
    const r = evaluateCutoverPrecondition(READY_INPUT);
    assert.equal(r.ready, true);
    assert.deepEqual(r.blockers, []);
  });

  it("recusa quando '/' não dá 200", () => {
    const r = evaluateCutoverPrecondition({ ...READY_INPUT, workerRootStatus: 404, workerRootBody: null });
    assert.equal(r.ready, false);
    assert.equal(r.blockers.length, 1);
    assert.match(r.blockers[0], /"\/"/);
    assert.match(r.blockers[0], /404/);
  });

  it("F1 (PR #6364) — recusa '/' com 200 mas corpo de ERRO (página capturada, não a real)", () => {
    const r = evaluateCutoverPrecondition({
      ...READY_INPUT,
      workerRootStatus: 200,
      workerRootBody: "<html><body>Internal Server Error</body></html>",
    });
    assert.equal(r.ready, false);
    assert.equal(r.blockers.length, 1);
    assert.match(r.blockers[0], /marcador esperado/);
  });

  it("recusa '/' com 200 e corpo nulo (erro de rede na leitura do corpo) — fail closed", () => {
    const r = evaluateCutoverPrecondition({ ...READY_INPUT, workerRootStatus: 200, workerRootBody: null });
    assert.equal(r.ready, false);
  });

  it("recusa quando '/subscribe' não é um redirect (200 estrito não é mais o critério — é redirect por design)", () => {
    const r = evaluateCutoverPrecondition({
      ...READY_INPUT,
      workerSubscribeStatus: 200,
      workerSubscribeLocation: null,
    });
    assert.equal(r.ready, false);
    assert.equal(r.blockers.length, 1);
    assert.match(r.blockers[0], /"\/subscribe"/);
  });

  it("recusa quando '/subscribe' responde 404 (estado real ANTES do #6363 mergear)", () => {
    const r = evaluateCutoverPrecondition({
      ...READY_INPUT,
      workerSubscribeStatus: 404,
      workerSubscribeLocation: null,
    });
    assert.equal(r.ready, false);
    assert.match(r.blockers[0], /"\/subscribe"/);
    assert.match(r.blockers[0], /404/);
  });

  it("recusa quando '/subscribe' redireciona (3xx) mas para o HOST ERRADO", () => {
    const r = evaluateCutoverPrecondition({
      ...READY_INPUT,
      workerSubscribeStatus: 302,
      workerSubscribeLocation: "https://outro-host.exemplo/",
    });
    assert.equal(r.ready, false);
    assert.match(r.blockers[0], /outro-host.exemplo/);
  });

  it("recusa quando '/subscribe' é 3xx mas sem header Location", () => {
    const r = evaluateCutoverPrecondition({
      ...READY_INPUT,
      workerSubscribeStatus: 302,
      workerSubscribeLocation: null,
    });
    assert.equal(r.ready, false);
    assert.match(r.blockers[0], /sem header Location/);
  });

  it("aceita qualquer código 3xx (301, 302, 307, 308) pro redirect de '/subscribe', não só 302", () => {
    for (const status of [301, 302, 307, 308]) {
      const r = evaluateCutoverPrecondition({ ...READY_INPUT, workerSubscribeStatus: status });
      assert.equal(r.ready, true, `esperava ready=true para status ${status}`);
    }
  });

  it("recusa com os DOIS blockers quando ambos os paths falham", () => {
    const r = evaluateCutoverPrecondition({
      workerRootStatus: 404,
      workerRootBody: null,
      workerSubscribeStatus: 404,
      workerSubscribeLocation: null,
    });
    assert.equal(r.ready, false);
    assert.equal(r.blockers.length, 2);
  });

  it("recusa em erro de rede (null) nos dois paths, não só em status HTTP explícito", () => {
    const r = evaluateCutoverPrecondition({
      workerRootStatus: null,
      workerRootBody: null,
      workerSubscribeStatus: null,
      workerSubscribeLocation: null,
    });
    assert.equal(r.ready, false);
    assert.equal(r.blockers.length, 2);
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

  it("F(P1, silent-failure-hunter) — 2 registros A na zona: lança, não escolhe 'o primeiro' silenciosamente", () => {
    assert.throws(
      () =>
        buildRollbackDnsPlan([
          { id: "a-1", type: "A" },
          { id: "a-2", type: "A" },
        ]),
      /2 registros A encontrados/,
    );
  });

  it("duplicata em AAAA também lança, não só A", () => {
    assert.throws(
      () =>
        buildRollbackDnsPlan([
          { id: "aaaa-1", type: "AAAA" },
          { id: "aaaa-2", type: "AAAA" },
        ]),
      /2 registros AAAA encontrados/,
    );
  });

  it("3+ registros do mesmo tipo: a mensagem cita a contagem real, não trava em '2'", () => {
    assert.throws(
      () =>
        buildRollbackDnsPlan([
          { id: "a-1", type: "A" },
          { id: "a-2", type: "A" },
          { id: "a-3", type: "A" },
        ]),
      /3 registros A encontrados/,
    );
  });
});

describe("buildRollbackPlan — plano ORDENADO detach-antes-de-DNS (docs/apex-cutover-rollback.md §3.1)", () => {
  it("com Custom Domain do apex presente: o PRIMEIRO passo é sempre o detach", () => {
    const plan = buildRollbackPlan("domain-id-123", []);
    assert.equal(plan[0].kind, "detach");
    assert.equal((plan[0] as { kind: "detach"; detach: { domainId: string } }).detach.domainId, "domain-id-123");
    assert.equal((plan[0] as { kind: "detach"; detach: { hostname: string } }).detach.hostname, APEX_HOSTNAME);
  });

  it("F2 (PR #6364) — nenhum passo 'dns' aparece ANTES do passo 'detach' quando ambos existem", () => {
    const plan = buildRollbackPlan("domain-id-123", []);
    const detachIndex = plan.findIndex((s) => s.kind === "detach");
    const firstDnsIndex = plan.findIndex((s) => s.kind === "dns");
    assert.ok(detachIndex !== -1, "esperava um passo de detach no plano");
    assert.ok(firstDnsIndex !== -1, "esperava pelo menos um passo de dns no plano");
    assert.ok(
      detachIndex < firstDnsIndex,
      `detach (index ${detachIndex}) deveria vir antes do primeiro dns (index ${firstDnsIndex})`,
    );
  });

  it("sem Custom Domain do apex: nenhum passo 'detach' no plano — começa direto no DNS", () => {
    const plan = buildRollbackPlan(null, []);
    assert.equal(plan.some((s) => s.kind === "detach"), false);
    assert.equal(plan[0].kind, "dns");
  });

  it("sempre inclui os 2 passos de dns (A + AAAA), independente do custom domain", () => {
    const plan = buildRollbackPlan(null, []);
    assert.equal(plan.filter((s) => s.kind === "dns").length, 2);
  });

  it("propaga o erro de duplicata de buildRollbackDnsPlan (não engole silenciosamente)", () => {
    assert.throws(
      () =>
        buildRollbackPlan("domain-id-123", [
          { id: "a-1", type: "A" },
          { id: "a-2", type: "A" },
        ]),
      /2 registros A encontrados/,
    );
  });
});

describe("extractRollbackDnsOps — extrai só o lado DNS do plano, na ordem", () => {
  it("com detach presente: extrai só os 2 dns ops, sem o detach", () => {
    const plan = buildRollbackPlan("domain-id-123", []);
    const dnsOps = extractRollbackDnsOps(plan);
    assert.equal(dnsOps.length, 2);
    assert.ok(dnsOps.every((op) => op.type === "A" || op.type === "AAAA"));
  });

  it("sem detach: mesmo resultado (não depende do detach existir)", () => {
    const plan = buildRollbackPlan(null, []);
    assert.equal(extractRollbackDnsOps(plan).length, 2);
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

  it("F4 (P2, PR #6364) — assertAllowedDnsRecordType lança pra um tipo FORA da allowlist e fora de FORBIDDEN_DNS_RECORD_TYPES (CNAME) — não é só MX/TXT/CAA hardcoded", () => {
    assert.throws(() => assertAllowedDnsRecordType("CNAME"), /fora do escopo permitido/);
    assert.throws(() => assertAllowedDnsRecordType("NS"), /fora do escopo permitido/);
    assert.throws(() => assertAllowedDnsRecordType("SRV"), /fora do escopo permitido/);
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

  it("assertPlanTouchesOnlyAllowedRecordTypes lança pra CNAME também (não só os 3 tipos citados no docstring)", () => {
    assert.throws(
      () => assertPlanTouchesOnlyAllowedRecordTypes([{ type: "A" }, { type: "CNAME" }]),
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

  it("F5 (P3, PR #6364) — detecta ttl divergente ISOLADO (content e proxied corretos)", () => {
    const r = verifyDnsRestored([
      { type: "A", content: "104.16.243.55", proxied: true, ttl: 300 },
      { type: "AAAA", content: "2001:12ff:0:2::95", proxied: true, ttl: 1 },
    ]);
    assert.equal(r.restored, false);
    assert.equal(r.mismatches.length, 1);
    assert.match(r.mismatches[0], /ttl/);
  });

  it("F5 (P3, PR #6364) — detecta mismatch SIMULTÂNEO em A e AAAA (2 entradas em mismatches, não só a primeira)", () => {
    const r = verifyDnsRestored([
      { type: "A", content: "1.2.3.4", proxied: true, ttl: 1 },
      { type: "AAAA", content: "dead:beef::1", proxied: true, ttl: 1 },
    ]);
    assert.equal(r.restored, false);
    assert.equal(r.mismatches.length, 2);
    assert.ok(r.mismatches.some((m) => m.startsWith("A:")));
    assert.ok(r.mismatches.some((m) => m.startsWith("AAAA:")));
  });

  it("detecta registro ausente", () => {
    const r = verifyDnsRestored([{ type: "A", content: "104.16.243.55", proxied: true, ttl: 1 }]);
    assert.equal(r.restored, false);
    assert.match(r.mismatches[0], /ausente/);
  });

  it("P1 (silent-failure-hunter, PR #6364) — 2 registros A na zona (1 certo + 1 stale): mismatch explícito, NUNCA restored:true cego", () => {
    const r = verifyDnsRestored([
      { type: "A", content: "104.16.243.55", proxied: true, ttl: 1 }, // o "certo"
      { type: "A", content: "1.2.3.4", proxied: true, ttl: 1 }, // stale, ainda na zona
      { type: "AAAA", content: "2001:12ff:0:2::95", proxied: true, ttl: 1 },
    ]);
    assert.equal(r.restored, false);
    assert.equal(r.mismatches.length, 1);
    assert.match(r.mismatches[0], /2 registros encontrados/);
    assert.match(r.mismatches[0], /^A:/);
  });

  it("duplicata em AAAA também vira mismatch, não só A", () => {
    const r = verifyDnsRestored([
      { type: "A", content: "104.16.243.55", proxied: true, ttl: 1 },
      { type: "AAAA", content: "2001:12ff:0:2::95", proxied: true, ttl: 1 },
      { type: "AAAA", content: "dead:beef::stale", proxied: true, ttl: 1 },
    ]);
    assert.equal(r.restored, false);
    assert.match(r.mismatches[0], /^AAAA:/);
    assert.match(r.mismatches[0], /2 registros encontrados/);
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

describe("Constantes de conteúdo esperado (#6364, item 1) — sanidade", () => {
  it("EXPECTED_ROOT_MARKER é um marcador de conteúdo real, não um status", () => {
    assert.match(EXPECTED_ROOT_MARKER, /<title>/);
  });

  it("EXPECTED_SUBSCRIBE_REDIRECT_HOST é um host, sem protocolo/path", () => {
    assert.equal(EXPECTED_SUBSCRIBE_REDIRECT_HOST.includes("://"), false);
    assert.equal(EXPECTED_SUBSCRIBE_REDIRECT_HOST.includes("/"), false);
  });
});

describe("Custom Domain do apex — duplicata tratada como o DNS (P3 silent-failure-hunter, PR #6364)", () => {
  const OTHER = { id: "cd-outro", hostname: "especial.diar.ia.br" };
  const APEX_1 = { id: "cd-1", hostname: APEX_HOSTNAME };
  const APEX_2 = { id: "cd-2", hostname: APEX_HOSTNAME };

  it("findApexCustomDomains devolve só os que casam o apex", () => {
    assert.deepEqual(findApexCustomDomains([OTHER, APEX_1]), [APEX_1]);
    assert.deepEqual(findApexCustomDomains([OTHER]), []);
  });

  it("selectSingleApexCustomDomain: nenhum → null (caminho normal pré-cutover)", () => {
    assert.equal(selectSingleApexCustomDomain([OTHER]), null);
    assert.equal(selectSingleApexCustomDomain([]), null);
  });

  it("selectSingleApexCustomDomain: exatamente 1 → devolve ele", () => {
    assert.deepEqual(selectSingleApexCustomDomain([OTHER, APEX_1]), APEX_1);
  });

  it("selectSingleApexCustomDomain: 2 casando o apex → LANÇA, nunca escolhe 'o primeiro'", () => {
    // Sem este guard, `--rollback` desanexaria só `cd-1` e deixaria `cd-2`
    // no ar — o apex seguiria roteando pro Worker enquanto o script diz
    // "restaurado e verificado". Mesma classe do guard de duplicata de DNS,
    // que esta mesma PR endureceu para registros A/AAAA.
    assert.throws(
      () => selectSingleApexCustomDomain([APEX_1, APEX_2, OTHER]),
      (e: Error) => e.message.includes("2 Workers Custom Domains") && e.message.includes(APEX_HOSTNAME),
    );
  });

  it("a mensagem cita a contagem REAL, não um literal fixo", () => {
    const three = [APEX_1, APEX_2, { id: "cd-3", hostname: APEX_HOSTNAME }];
    assert.throws(() => selectSingleApexCustomDomain(three), /3 Workers Custom Domains/);
  });
});
