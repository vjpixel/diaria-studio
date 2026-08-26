/**
 * apex-cutover-script.test.ts (#467, fleet review da PR #6364, F3)
 *
 * Cobre a camada de I/O de `scripts/apex-cutover.ts` — a que faltava teste
 * inteiramente, apesar de já aceitar `fetchFn` injetável em toda função.
 * Mesmo padrão de `test/worker-drift-check-script.test.ts` (fetch mockado,
 * sem rede real, contando chamadas por método/URL). Este é o script de maior
 * blast radius do repo (erro aqui tira o site do ar pra ~587 assinantes) e a
 * única execução real é a própria janela de corte — não dá pra ensaiar
 * `--apply` ao vivo, então a rede que substitui o ensaio é este arquivo.
 *
 * O mock da API Cloudflare é STATEFUL (um objeto de zona em memória que os
 * handlers de PUT/DELETE/PATCH/POST mutam de verdade) em vez de respostas
 * fixas por chamada — assim a releitura pós-mutação (#573) exercita o
 * comportamento real: GET depois de PATCH reflete a mudança, sem precisar de
 * flags manuais tipo "já mutou?" espalhadas pelos testes.
 *
 * Cobertura mínima pedida pelo review:
 *   - sem `--apply`, NENHUMA função de mutação é chamada (contagem = 0);
 *   - com `--apply`, a sequência guard → mutação → verificação;
 *   - os exit codes 1 (guard recusou), 2 (mutação/verificação falhou) e 3
 *     (uso inválido).
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  loadConfig,
  runCutover,
  runRollback,
  runStatus,
  resolveMode,
  formatCfError,
  type Config,
} from "../scripts/apex-cutover.ts";
import { parseArgs } from "../scripts/lib/cli-args.ts";
import { WORKER_DEV_HOST, APEX_HOSTNAME, WORKER_NAME } from "../scripts/lib/apex-cutover.ts";

const CFG: Config = { token: "test-token", accountId: "test-account" };

const OK_ROOT_HTML = `<html><head><title>diar.ia.br</title></head></html>`;
const SUBSCRIBE_REDIRECT_LOCATION = "https://diar-ia-br.kit.com/";

interface MockDnsRecord {
  id: string;
  content: string;
  proxied: boolean;
  ttl: number;
}

interface MockZoneState {
  customDomain: { id: string; hostname: string; service: string } | null;
  aRecords: MockDnsRecord[];
  aaaaRecords: MockDnsRecord[];
}

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

/** Probe do Worker (host workers.dev) — usado só por runCutover/runStatus,
 * fixo por teste (não precisa de estado mutável: o guard nunca escreve no
 * Worker). */
interface ProbeConfig {
  rootStatus: number;
  rootBody: string;
  subscribeStatus: number;
  subscribeLocation: string | null;
}

const READY_PROBE: ProbeConfig = {
  rootStatus: 200,
  rootBody: OK_ROOT_HTML,
  subscribeStatus: 302,
  subscribeLocation: SUBSCRIBE_REDIRECT_LOCATION,
};

const NOT_READY_PROBE: ProbeConfig = {
  rootStatus: 404,
  rootBody: "not found",
  subscribeStatus: 404,
  subscribeLocation: null,
};

/**
 * Fetch mockado ÚNICO pra toda a superfície que `scripts/apex-cutover.ts`
 * bate: os 2 probes do Worker (fixos, `probe`) + a API da Cloudflare
 * (stateful, `zone` — mutada de verdade por PUT/DELETE/PATCH/POST, lida de
 * volta por GET). `calls` registra (método, url) de toda chamada, na ordem,
 * pra testes de contagem e de sequência.
 */
function makeMockFetch(zone: MockZoneState, probe: ProbeConfig = READY_PROBE, opts?: { failOn?: (method: string, url: string) => string | null }) {
  const calls: { url: string; method: string }[] = [];

  const fetchFn = (async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    const method = (init?.method ?? "GET").toUpperCase();
    calls.push({ url: u, method });

    if (u === `https://${WORKER_DEV_HOST}/`) return new Response(probe.rootBody, { status: probe.rootStatus });
    if (u === `https://${WORKER_DEV_HOST}/subscribe`) {
      const headers = probe.subscribeLocation ? { Location: probe.subscribeLocation } : undefined;
      return new Response(null, { status: probe.subscribeStatus, headers });
    }

    const forcedError = opts?.failOn?.(method, u);
    if (forcedError) return jsonRes({ success: false, errors: [{ code: 1, message: forcedError }] });

    if (method === "GET" && u.includes("/workers/routes")) {
      return jsonRes({ success: true, result: [] });
    }
    if (method === "GET" && u.includes("/workers/domains")) {
      return jsonRes({ success: true, result: zone.customDomain ? [zone.customDomain] : [] });
    }
    if (method === "PUT" && u.includes("/workers/domains")) {
      const body = JSON.parse(String(init?.body));
      zone.customDomain = { id: "domain-new", hostname: body.hostname, service: body.service };
      return jsonRes({ success: true, result: { id: "domain-new" } });
    }
    if (method === "DELETE" && u.includes("/workers/domains/")) {
      zone.customDomain = null;
      return jsonRes({ success: true, result: {} });
    }
    if (method === "DELETE" && u.includes("/dns_records/")) {
      const id = u.split("/dns_records/")[1];
      zone.aRecords = zone.aRecords.filter((r) => r.id !== id);
      zone.aaaaRecords = zone.aaaaRecords.filter((r) => r.id !== id);
      return jsonRes({ success: true, result: {} });
    }
    if (method === "GET" && u.includes("dns_records") && u.includes("type=AAAA")) {
      return jsonRes({ success: true, result: zone.aaaaRecords.map((r) => ({ ...r, type: "AAAA", name: APEX_HOSTNAME })) });
    }
    if (method === "GET" && u.includes("dns_records") && u.includes("type=A")) {
      return jsonRes({ success: true, result: zone.aRecords.map((r) => ({ ...r, type: "A", name: APEX_HOSTNAME })) });
    }
    if (method === "PATCH" && u.includes("/dns_records/")) {
      const id = u.split("/dns_records/")[1];
      const body = JSON.parse(String(init?.body));
      for (const list of [zone.aRecords, zone.aaaaRecords]) {
        const idx = list.findIndex((r) => r.id === id);
        if (idx >= 0) list[idx] = { ...list[idx], content: body.content, proxied: body.proxied, ttl: body.ttl };
      }
      return jsonRes({ success: true, result: {} });
    }
    if (method === "POST" && u.includes("/dns_records")) {
      const body = JSON.parse(String(init?.body));
      const rec: MockDnsRecord = { id: `${body.type}-created`, content: body.content, proxied: body.proxied, ttl: body.ttl };
      if (body.type === "A") zone.aRecords.push(rec);
      else zone.aaaaRecords.push(rec);
      return jsonRes({ success: true, result: { id: rec.id } });
    }

    throw new Error(`makeMockFetch: rota não coberta — ${method} ${u}`);
  }) as unknown as typeof fetch;

  return { fetchFn, calls };
}

function emptyZone(): MockZoneState {
  return { customDomain: null, aRecords: [], aaaaRecords: [] };
}

function preCutoverZone(): MockZoneState {
  return {
    customDomain: null,
    aRecords: [{ id: "9246e7ffc5e6c8df11c979d31ca6cb1e", content: "104.16.243.55", proxied: true, ttl: 1 }],
    aaaaRecords: [{ id: "1e19bf3285dff54456b607f6564617f7", content: "2001:12ff:0:2::95", proxied: true, ttl: 1 }],
  };
}

function captureConsoleError(): { logged: string[]; restore: () => void } {
  const original = console.error;
  const logged: string[] = [];
  console.error = (...args: unknown[]) => {
    logged.push(args.map(String).join(" "));
  };
  return { logged, restore: () => (console.error = original) };
}

describe("runCutover — guard recusa (exit 1), ZERO mutação (#6364 F3)", () => {
  it("Worker não pronto (404/404, estado real 26/08) — recusa, nenhum PUT chamado", async () => {
    const { fetchFn, calls } = makeMockFetch(emptyZone(), NOT_READY_PROBE);
    const code = await runCutover(CFG, true, fetchFn); // mesmo com --apply
    assert.equal(code, 1);
    assert.equal(calls.filter((c) => c.method === "PUT").length, 0);
  });

  it("F1 — '/' com 200 mas corpo de erro (página capturada) — recusa mesmo com status certo", async () => {
    const { fetchFn, calls } = makeMockFetch(emptyZone(), {
      ...READY_PROBE,
      rootStatus: 200,
      rootBody: "Internal Server Error",
    });
    const code = await runCutover(CFG, true, fetchFn);
    assert.equal(code, 1);
    assert.equal(calls.filter((c) => c.method === "PUT").length, 0);
  });

  it("'/subscribe' com 200 estrito (critério antigo) já não basta — recusa, pois não é redirect", async () => {
    const { fetchFn } = makeMockFetch(emptyZone(), { ...READY_PROBE, subscribeStatus: 200, subscribeLocation: null });
    const code = await runCutover(CFG, true, fetchFn);
    assert.equal(code, 1);
  });
});

describe("runCutover — dry-run (sem --apply): ZERO mutação mesmo com guard OK (#6364 F3)", () => {
  it("guard OK, apply=false — 0 chamadas de PUT/DELETE/PATCH/POST", async () => {
    const { fetchFn, calls } = makeMockFetch(emptyZone(), READY_PROBE);
    const code = await runCutover(CFG, false, fetchFn);
    assert.equal(code, 0);
    assert.equal(calls.filter((c) => ["PUT", "DELETE", "PATCH", "POST"].includes(c.method)).length, 0);
  });

  it("#6373 — zona com A/AAAA legado, apply=false: plano impresso inclui a remoção prévia, ZERO chamada de mutação", async () => {
    const zone = preCutoverZone();
    const { fetchFn, calls } = makeMockFetch(zone, READY_PROBE);
    const originalLog = console.log;
    let printed = "";
    console.log = (s: string) => {
      printed = s;
    };
    let code: number;
    try {
      code = await runCutover(CFG, false, fetchFn);
    } finally {
      console.log = originalLog;
    }
    assert.equal(code, 0);
    assert.equal(calls.filter((c) => ["PUT", "DELETE", "PATCH", "POST"].includes(c.method)).length, 0);

    const parsed = JSON.parse(printed);
    const kinds = parsed.plan.map((s: { kind: string }) => s.kind);
    assert.deepEqual(kinds, ["dns-delete", "dns-delete", "attach"]);
  });
});

describe("runCutover — --apply: remoção de A/AAAA legado ANTES do attach (#6373)", () => {
  it("zona com A/AAAA legado (estado real 26/08): remove os 2 ANTES do PUT, verifica remoção, então anexa — DELETE×2 antes do PUT, nessa ordem", async () => {
    const zone = preCutoverZone();
    const { fetchFn, calls } = makeMockFetch(zone, READY_PROBE);
    const code = await runCutover(CFG, true, fetchFn);
    assert.equal(code, 0);

    const deleteIdxs = calls
      .map((c, i) => ({ ...c, i }))
      .filter((c) => c.method === "DELETE" && c.url.includes("/dns_records/"))
      .map((c) => c.i);
    const putIdx = calls.findIndex((c) => c.method === "PUT");
    assert.equal(deleteIdxs.length, 2, "esperava 2 DELETE de dns_records (A + AAAA)");
    assert.ok(putIdx !== -1, "esperava 1 PUT (attach)");
    for (const di of deleteIdxs) {
      assert.ok(di < putIdx, "todo DELETE de A/AAAA deveria vir ANTES do PUT (#6373)");
    }

    // releitura pós-DELETE (confirma remoção) também vem antes do PUT.
    const dnsGetIdxsBeforePut = calls
      .slice(0, putIdx)
      .filter((c) => c.method === "GET" && c.url.includes("dns_records")).length;
    assert.ok(dnsGetIdxsBeforePut >= 2, "esperava releitura de A/AAAA antes do attach");

    assert.equal(zone.aRecords.length, 0);
    assert.equal(zone.aaaaRecords.length, 0);
    assert.equal(zone.customDomain?.hostname, APEX_HOSTNAME);
  });

  it("zona SEM A/AAAA legado (2ª execução, ou zona limpa): nenhum DELETE de dns_records — vai direto pro attach, sem falhar por 'nada a deletar'", async () => {
    const { fetchFn, calls } = makeMockFetch(emptyZone(), READY_PROBE);
    const code = await runCutover(CFG, true, fetchFn);
    assert.equal(code, 0);
    assert.equal(calls.filter((c) => c.method === "DELETE" && c.url.includes("/dns_records/")).length, 0);
    assert.equal(calls.filter((c) => c.method === "PUT").length, 1);
  });

  it("DELETE de A/AAAA legado falha — exit 2, NUNCA tenta o attach (0 PUT)", async () => {
    const zone = preCutoverZone();
    const { fetchFn, calls } = makeMockFetch(zone, READY_PROBE, {
      failOn: (method, url) => (method === "DELETE" && url.includes("/dns_records/") ? "boom" : null),
    });
    const code = await runCutover(CFG, true, fetchFn);
    assert.equal(code, 2);
    assert.equal(calls.filter((c) => c.method === "PUT").length, 0);
  });

  it("releitura pós-DELETE mostra que o registro sobreviveu — aborta ANTES do attach (0 PUT), mensagem clara", async () => {
    const zone = preCutoverZone();
    const { fetchFn } = makeMockFetch(zone, READY_PROBE);
    // DELETE "sucede" na resposta mas a zona não muda de verdade — simula o
    // cenário de releitura pós-mutação (#573) detectando que o DELETE não
    // pegou, mesmo com HTTP 200 na resposta.
    const flakyFetch = (async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      const method = (init?.method ?? "GET").toUpperCase();
      if (method === "DELETE" && u.includes("/dns_records/")) {
        return jsonRes({ success: true, result: {} }); // responde OK, mas NÃO apaga da zona
      }
      return fetchFn(url, init);
    }) as unknown as typeof fetch;

    const { logged, restore } = captureConsoleError();
    let code: number;
    let putCalled = false;
    try {
      const countingFetch = (async (url: string | URL, init?: RequestInit) => {
        if ((init?.method ?? "GET").toUpperCase() === "PUT") putCalled = true;
        return flakyFetch(url, init);
      }) as unknown as typeof fetch;
      code = await runCutover(CFG, true, countingFetch);
    } finally {
      restore();
    }
    assert.equal(code, 2);
    assert.equal(putCalled, false, "nunca deveria chegar ao attach com o legado ainda presente");
    assert.ok(
      logged.some((l) => l.includes("ainda existe")),
      `esperava mensagem de registro remanescente, obteve: ${JSON.stringify(logged)}`,
    );
  });

  it("2 registros A na zona (duplicata) — lança ANTES de qualquer mutação (0 DELETE/PUT), regressão do guard existente", async () => {
    const zone: MockZoneState = {
      customDomain: null,
      aRecords: [
        { id: "a-1", content: "1.2.3.4", proxied: true, ttl: 1 },
        { id: "a-2", content: "5.6.7.8", proxied: true, ttl: 1 },
      ],
      aaaaRecords: [],
    };
    const { fetchFn, calls } = makeMockFetch(zone, READY_PROBE);
    await assert.rejects(() => runCutover(CFG, true, fetchFn), /2 registros A encontrados/);
    assert.equal(calls.filter((c) => ["DELETE", "PUT", "PATCH", "POST"].includes(c.method)).length, 0);
  });

  it("PUT bem-sucedido + releitura confirma attach — exit 0, exatamente 1 PUT + 1 GET de verificação, nessa ordem", async () => {
    const { fetchFn, calls } = makeMockFetch(emptyZone(), READY_PROBE);
    const code = await runCutover(CFG, true, fetchFn);
    assert.equal(code, 0);

    const putCalls = calls.filter((c) => c.method === "PUT");
    const verifyGetCalls = calls.filter((c) => c.method === "GET" && c.url.includes("/workers/domains"));
    assert.equal(putCalls.length, 1);
    assert.equal(verifyGetCalls.length, 1, "esperava exatamente 1 GET de verificação pós-PUT (#573)");

    const putIdx = calls.findIndex((c) => c.method === "PUT");
    const verifyGetIdx = calls.findIndex((c) => c.method === "GET" && c.url.includes("/workers/domains"));
    assert.ok(putIdx < verifyGetIdx, "GET de verificação deveria vir depois do PUT");
  });

  it("PUT falha (success:false) — exit 2, NUNCA chega a reler (0 GET de verificação)", async () => {
    const { fetchFn, calls } = makeMockFetch(emptyZone(), READY_PROBE, {
      failOn: (method, url) => (method === "PUT" && url.includes("/workers/domains") ? "boom" : null),
    });
    const code = await runCutover(CFG, true, fetchFn);
    assert.equal(code, 2);
    assert.equal(calls.filter((c) => c.method === "GET" && c.url.includes("/workers/domains")).length, 0);
  });

  it("P2 — PUT bem-sucedido mas releitura LANÇA (rede cai no meio) — exit 2, mensagem distinta de 'nada aconteceu ainda'", async () => {
    const zone = emptyZone();
    const { fetchFn } = makeMockFetch(zone, READY_PROBE);
    const throwingFetch = (async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      const method = (init?.method ?? "GET").toUpperCase();
      if (method === "GET" && u.includes("/workers/domains")) throw new Error("ECONNRESET");
      return fetchFn(url, init);
    }) as unknown as typeof fetch;

    const { logged, restore } = captureConsoleError();
    let code: number;
    try {
      code = await runCutover(CFG, true, throwingFetch);
    } finally {
      restore();
    }
    assert.equal(code, 2);
    assert.ok(
      logged.some((l) => l.includes("MUTAÇÃO PODE TER SIDO APLICADA")),
      `esperava mensagem distinta de mutação-pode-ter-sido-aplicada, obteve: ${JSON.stringify(logged)}`,
    );
  });

  it("P2 — DELETE bem-sucedido mas releitura pós-DELETE LANÇA (rede cai no meio) — exit 2, mensagem distinta, nunca chega ao attach", async () => {
    const zone = preCutoverZone();
    const { fetchFn } = makeMockFetch(zone, READY_PROBE);
    let deleteHappened = false;
    let putCalled = false;
    const flaky = (async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      const method = (init?.method ?? "GET").toUpperCase();
      if (method === "DELETE" && u.includes("/dns_records/")) deleteHappened = true;
      if (method === "PUT") putCalled = true;
      if (deleteHappened && method === "GET" && u.includes("dns_records")) throw new Error("ECONNRESET pós-DELETE");
      return fetchFn(url, init);
    }) as unknown as typeof fetch;

    const { logged, restore } = captureConsoleError();
    let code: number;
    try {
      code = await runCutover(CFG, true, flaky);
    } finally {
      restore();
    }
    assert.equal(code, 2);
    assert.equal(putCalled, false);
    assert.ok(logged.some((l) => l.includes("MUTAÇÃO PODE TER SIDO APLICADA")));
  });
});

describe("runRollback — dry-run (sem --apply): ZERO mutação (#6364 F3)", () => {
  it("com custom domain + registros DNS presentes, apply=false — 0 DELETE/PATCH/POST", async () => {
    const zone: MockZoneState = {
      customDomain: { id: "domain-1", hostname: APEX_HOSTNAME, service: WORKER_NAME },
      aRecords: [{ id: "a-1", content: "1.2.3.4", proxied: true, ttl: 1 }],
      aaaaRecords: [],
    };
    const { fetchFn, calls } = makeMockFetch(zone);
    const code = await runRollback(CFG, false, fetchFn);
    assert.equal(code, 0);
    assert.equal(calls.filter((c) => ["DELETE", "PATCH", "POST"].includes(c.method)).length, 0);
  });
});

describe("runRollback — --apply: sequência detach → dns → verificação, ordem estrutural (#6364 F2/F3)", () => {
  it("com custom domain presente: DELETE (detach) acontece ANTES de qualquer PATCH/POST de DNS, e o estado final bate com PRE_CUTOVER_DNS_RECORDS", async () => {
    const zone: MockZoneState = {
      customDomain: { id: "domain-1", hostname: APEX_HOSTNAME, service: WORKER_NAME },
      aRecords: [],
      aaaaRecords: [],
    };
    const { fetchFn, calls } = makeMockFetch(zone);
    const code = await runRollback(CFG, true, fetchFn);
    assert.equal(code, 0);

    const deleteIdx = calls.findIndex((c) => c.method === "DELETE");
    const firstDnsMutationIdx = calls.findIndex((c) => c.method === "POST" || c.method === "PATCH");
    assert.ok(deleteIdx !== -1, "esperava 1 DELETE (detach)");
    assert.ok(firstDnsMutationIdx !== -1, "esperava pelo menos 1 mutação de DNS");
    assert.ok(deleteIdx < firstDnsMutationIdx, "DELETE (detach) deveria vir ANTES de qualquer mutação de DNS");

    assert.equal(zone.customDomain, null);
    assert.equal(zone.aRecords.length, 1);
    assert.equal(zone.aRecords[0].content, "104.16.243.55");
    assert.equal(zone.aaaaRecords[0].content, "2001:12ff:0:2::95");
  });

  it("sem custom domain: nenhum DELETE é chamado — pula direto pro DNS (2 CREATE)", async () => {
    const zone = emptyZone();
    const { fetchFn, calls } = makeMockFetch(zone);
    const code = await runRollback(CFG, true, fetchFn);
    assert.equal(code, 0);
    assert.equal(calls.filter((c) => c.method === "DELETE").length, 0);
    assert.equal(calls.filter((c) => c.method === "POST").length, 2);
  });

  it("registros já corretos (mesmo id do snapshot): PATCH nos 2, nenhum CREATE", async () => {
    const zone = preCutoverZone();
    const { fetchFn, calls } = makeMockFetch(zone);
    const code = await runRollback(CFG, true, fetchFn);
    assert.equal(code, 0);
    assert.equal(calls.filter((c) => c.method === "PATCH").length, 2);
    assert.equal(calls.filter((c) => c.method === "POST").length, 0);
  });

  it("PATCH de DNS falha — exit 2", async () => {
    const zone: MockZoneState = { customDomain: null, aRecords: [{ id: "a-1", content: "1.2.3.4", proxied: true, ttl: 1 }], aaaaRecords: [] };
    const { fetchFn } = makeMockFetch(zone, READY_PROBE, { failOn: (method) => (method === "PATCH" ? "nope" : null) });
    const code = await runRollback(CFG, true, fetchFn);
    assert.equal(code, 2);
  });

  it("DELETE (detach) falha — exit 2, NENHUM PATCH/POST de DNS é tentado depois", async () => {
    const zone: MockZoneState = { customDomain: { id: "domain-1", hostname: APEX_HOSTNAME, service: WORKER_NAME }, aRecords: [], aaaaRecords: [] };
    const { fetchFn, calls } = makeMockFetch(zone, READY_PROBE, { failOn: (method) => (method === "DELETE" ? "nope" : null) });
    const code = await runRollback(CFG, true, fetchFn);
    assert.equal(code, 2);
    assert.equal(calls.filter((c) => c.method === "POST" || c.method === "PATCH").length, 0);
  });

  it("P2 — mutação OK mas releitura pós-rollback LANÇA — exit 2, mensagem distinta", async () => {
    const zone = emptyZone();
    const { fetchFn } = makeMockFetch(zone);
    let mutationHappened = false;
    const flaky = (async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      const method = (init?.method ?? "GET").toUpperCase();
      if (method === "POST" || method === "PATCH" || method === "DELETE") mutationHappened = true;
      if (mutationHappened && method === "GET" && u.includes("dns_records")) throw new Error("ECONNRESET pós-mutação");
      return fetchFn(url, init);
    }) as unknown as typeof fetch;

    const { logged, restore } = captureConsoleError();
    let code: number;
    try {
      code = await runRollback(CFG, true, flaky);
    } finally {
      restore();
    }
    assert.equal(code, 2);
    assert.ok(logged.some((l) => l.includes("MUTAÇÃO PODE TER SIDO APLICADA")));
  });

  it("P1 (item 4) — 2 registros A na zona: lança ANTES de qualquer mutação (0 PATCH/POST/DELETE)", async () => {
    const zone: MockZoneState = {
      customDomain: null,
      aRecords: [
        { id: "a-1", content: "1.2.3.4", proxied: true, ttl: 1 },
        { id: "a-2", content: "5.6.7.8", proxied: true, ttl: 1 },
      ],
      aaaaRecords: [],
    };
    const { fetchFn, calls } = makeMockFetch(zone);
    await assert.rejects(() => runRollback(CFG, true, fetchFn), /2 registros A encontrados/);
    assert.equal(calls.filter((c) => ["PATCH", "POST", "DELETE"].includes(c.method)).length, 0);
  });
});

describe("runStatus — nunca muta", () => {
  it("--status com fetch mockado: 0 chamadas de mutação, retorna 0", async () => {
    const zone = preCutoverZone();
    const { fetchFn, calls } = makeMockFetch(zone, READY_PROBE);
    const code = await runStatus(CFG, fetchFn);
    assert.equal(code, 0);
    assert.equal(calls.filter((c) => ["PUT", "PATCH", "POST", "DELETE"].includes(c.method)).length, 0);
  });

  it("expõe cutover_precondition no JSON de saída (self-review da PR #6364)", async () => {
    const zone = preCutoverZone();
    const { fetchFn } = makeMockFetch(zone, READY_PROBE);
    const originalLog = console.log;
    let printed = "";
    console.log = (s: string) => {
      printed = s;
    };
    try {
      await runStatus(CFG, fetchFn);
    } finally {
      console.log = originalLog;
    }
    const parsed = JSON.parse(printed);
    assert.equal(parsed.cutover_precondition.ready, true);
  });
});

describe("resolveMode — exit code 3 (uso inválido), puro", () => {
  it("nenhuma flag de modo -> null", () => {
    assert.equal(resolveMode(parseArgs([])), null);
  });

  it("2 flags de modo ao mesmo tempo -> null", () => {
    assert.equal(resolveMode(parseArgs(["--status", "--cutover"])), null);
  });

  it("exatamente 1 flag de modo -> o modo", () => {
    assert.equal(resolveMode(parseArgs(["--status"])), "status");
    assert.equal(resolveMode(parseArgs(["--cutover"])), "cutover");
    assert.equal(resolveMode(parseArgs(["--rollback"])), "rollback");
  });

  it("flag de modo + --apply junto -> ainda resolve o modo (apply não conta como modo)", () => {
    assert.equal(resolveMode(parseArgs(["--cutover", "--apply"])), "cutover");
  });
});

describe("loadConfig", () => {
  let originalToken: string | undefined;
  beforeEach(() => {
    originalToken = process.env.CLOUDFLARE_API_TOKEN;
  });
  afterEach(() => {
    if (originalToken === undefined) delete process.env.CLOUDFLARE_API_TOKEN;
    else process.env.CLOUDFLARE_API_TOKEN = originalToken;
  });

  it("token ausente -> lança com mensagem acionável", () => {
    delete process.env.CLOUDFLARE_API_TOKEN;
    assert.throws(() => loadConfig(), /CLOUDFLARE_API_TOKEN não definida/);
  });

  it("token presente -> Config com o token e o accountId default", () => {
    process.env.CLOUDFLARE_API_TOKEN = "abc123";
    const originalAccount = process.env.CLOUDFLARE_ACCOUNT_ID;
    delete process.env.CLOUDFLARE_ACCOUNT_ID;
    try {
      const cfg = loadConfig();
      assert.equal(cfg.token, "abc123");
      assert.ok(cfg.accountId.length > 0);
    } finally {
      if (originalAccount === undefined) delete process.env.CLOUDFLARE_ACCOUNT_ID;
      else process.env.CLOUDFLARE_ACCOUNT_ID = originalAccount;
    }
  });
});

describe("formatCfError (#6364, P2) — cai pro corpo bruto quando errors vem vazio", () => {
  it("errors preenchido -> usa JSON.stringify(errors)", () => {
    const out = formatCfError({ errors: [{ code: 1, message: "boom" }], raw: "ignored" });
    assert.match(out, /boom/);
  });

  it("errors vazio (resposta não-JSON: WAF/rate-limit) -> usa o corpo bruto truncado, não '[]'", () => {
    const out = formatCfError({ errors: [], raw: "<html>Cloudflare challenge page...</html>" });
    assert.match(out, /Cloudflare challenge/);
    assert.equal(out.includes("[]"), false);
  });

  it("errors vazio e raw longo -> trunca em 300 chars", () => {
    const longRaw = "x".repeat(1000);
    const out = formatCfError({ errors: [], raw: longRaw });
    assert.equal(out.length, 300);
  });
});
