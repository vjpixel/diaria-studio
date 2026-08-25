/**
 * test/brevo-unrecognised-ip-alarm-6137.test.ts (#6137)
 *
 * Cobre `scripts/lib/brevo-unrecognised-ip-alarm.ts` (detecção pura + I/O
 * injetado, mesmo padrão de `test/alarm-issues.test.ts` — nenhum teste aqui
 * chama `gh` ou a rede (ipify) de verdade) e a PONTA de wiring em
 * `brevo-client.ts` (`brevoRawFetch`/`brevoGet`, análogo a
 * `test/brevo-client-quota-wiring-5697.test.ts`).
 *
 * Pedido explícito da issue:
 *   - 401 "unrecognised IP" simulado produz achado com conta/IP/URL
 *   - múltiplas chamadas falhando não geram múltiplos achados
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GhSpawnResult, GhRunFn } from "../scripts/lib/shared/gh-run.ts";
import {
  parseUnrecognisedIpBody,
  resolveBrevoAccountLabel,
  buildUnrecognisedIpFinding,
  reportUnrecognisedIpFinding,
  maybeReconcileResolvedFindings,
  loadUnrecognisedIpAlarmState,
  provesIpAllowlisted,
  AUTHORISED_IPS_URL,
  CHECK,
  __setUnrecognisedIpAlarmTestOverrides,
  __resetUnrecognisedIpAlarmTestOverrides,
} from "../scripts/lib/brevo-unrecognised-ip-alarm.ts";
import { brevoPost, brevoGet, __waitForPendingUnrecognisedIpWork } from "../scripts/lib/brevo-client.ts";

const IP = "2804:1b3:a941:cb3a:9a28:a6ff:fe0c:1af7";
const UNRECOGNISED_IP_BODY = JSON.stringify({
  code: "unauthorized",
  message:
    "We have detected you are using an unrecognised IP address " +
    IP +
    ". If you performed this action make sure to add the new IP address in " +
    "this link: https://app.brevo.com/security/authorised_ips",
});
const OTHER_401_BODY = JSON.stringify({ code: "unauthorized", message: "Key not found" });

function makeFakeRun(): { run: GhRunFn; calls: string[][] } {
  const calls: string[][] = [];
  const run: GhRunFn = (args: string[]): GhSpawnResult => {
    calls.push(args);
    if (args[0] === "issue" && args[1] === "list") {
      return { status: 0, stdout: "[]", stderr: "" }; // nenhuma issue existente via marcador
    }
    if (args[0] === "issue" && args[1] === "create") {
      return { status: 0, stdout: "https://github.com/x/y/issues/9001\n", stderr: "" };
    }
    if (args[0] === "issue" && args[1] === "view") {
      return { status: 0, stdout: JSON.stringify({ state: "OPEN" }), stderr: "" };
    }
    if (args[0] === "issue" && (args[1] === "comment" || args[1] === "close" || args[1] === "reopen")) {
      return { status: 0, stdout: "", stderr: "" };
    }
    return { status: 1, stdout: "", stderr: `run() inesperado: ${JSON.stringify(args)}` };
  };
  return { run, calls };
}

// ─── Detecção (pura) ────────────────────────────────────────────────────────

describe("parseUnrecognisedIpBody (#6137, pura)", () => {
  it("extrai o IP citado no corpo do 401", () => {
    assert.equal(parseUnrecognisedIpBody(UNRECOGNISED_IP_BODY), IP);
  });

  it("IPv4 também é reconhecido", () => {
    const body = "using an unrecognised IP address 177.139.69.116. If you performed...";
    assert.equal(parseUnrecognisedIpBody(body), "177.139.69.116");
  });

  it("null pra 401 de outra causa (key inválida) — nunca vira este achado", () => {
    assert.equal(parseUnrecognisedIpBody(OTHER_401_BODY), null);
  });

  it("null pra corpo vazio/ausente", () => {
    assert.equal(parseUnrecognisedIpBody(null), null);
    assert.equal(parseUnrecognisedIpBody(""), null);
  });
});

describe("resolveBrevoAccountLabel (#6137, pura)", () => {
  it("resolve 'clarice' quando a key bate com BREVO_CLARICE_API_KEY", () => {
    const env = { BREVO_CLARICE_API_KEY: "key-clarice", BREVO_DIARIA_API_KEY: "key-diaria" };
    assert.equal(resolveBrevoAccountLabel("key-clarice", env as NodeJS.ProcessEnv), "clarice");
  });

  it("resolve 'diaria' quando a key bate com BREVO_DIARIA_API_KEY", () => {
    const env = { BREVO_CLARICE_API_KEY: "key-clarice", BREVO_DIARIA_API_KEY: "key-diaria" };
    assert.equal(resolveBrevoAccountLabel("key-diaria", env as NodeJS.ProcessEnv), "diaria");
  });

  it("'desconhecida' quando a key não bate com nenhuma env conhecida", () => {
    const env = { BREVO_CLARICE_API_KEY: "key-clarice", BREVO_DIARIA_API_KEY: "key-diaria" };
    assert.equal(resolveBrevoAccountLabel("key-outra", env as NodeJS.ProcessEnv), "desconhecida");
  });
});

describe("buildUnrecognisedIpFinding (#6137, pura)", () => {
  it("monta achado com conta, IP, endpoint, timestamp, os 2 IPs do host e a URL da allowlist", () => {
    const finding = buildUnrecognisedIpFinding({
      account: "clarice",
      ip: IP,
      endpoint: "https://api.brevo.com/v3/emailCampaigns/178",
      timestamp: new Date("2026-08-25T13:15:00.000Z"),
      hostIPv4: "177.139.69.116",
      hostIPv6: IP,
    });
    assert.equal(finding.check, CHECK);
    assert.equal(finding.fingerprint, `clarice:${IP}`);
    assert.equal(finding.family, "estado");
    assert.match(finding.title, /clarice/);
    assert.match(finding.title, new RegExp(IP.replace(/[.:]/g, "\\$&")));
    assert.match(finding.body, /Conta Brevo: clarice/);
    assert.match(finding.body, new RegExp(`IP citado pela própria resposta: ${IP}`));
    assert.match(finding.body, /https:\/\/api\.brevo\.com\/v3\/emailCampaigns\/178/);
    assert.match(finding.body, /2026-08-25T13:15:00\.000Z/);
    assert.match(finding.body, /IPv4\s+177\.139\.69\.116/);
    assert.match(finding.body, new RegExp(`IPv6\\s+${IP.replace(/[.:]/g, "\\$&")}`));
    assert.ok(finding.body.includes(AUTHORISED_IPS_URL));
    assert.equal(finding.priority, "P1");
  });

  it("IPs não resolvidos (null) viram texto explicativo, nunca 'null' cru", () => {
    const finding = buildUnrecognisedIpFinding({
      account: "diaria",
      ip: IP,
      endpoint: "https://api.brevo.com/v3/account",
      timestamp: new Date(),
      hostIPv4: null,
      hostIPv6: null,
    });
    assert.ok(!finding.body.includes("IPv4  null"));
    assert.ok(!finding.body.includes("IPv6  null"));
    assert.match(finding.body, /não resolvido/);
  });

  it("#6156 P3: account 'desconhecida' nunca interpola BREVO_DESCONHECIDA_API_KEY (env var inexistente)", () => {
    const finding = buildUnrecognisedIpFinding({
      account: "desconhecida",
      ip: IP,
      endpoint: "https://api.brevo.com/v3/account",
      timestamp: new Date(),
      hostIPv4: null,
      hostIPv6: null,
    });
    assert.ok(!finding.body.includes("BREVO_DESCONHECIDA_API_KEY"));
    assert.match(finding.body, /conta não identificada/);
  });

  it("account 'clarice'/'diaria' continuam citando o env var real no comando de confirmação", () => {
    const finding = buildUnrecognisedIpFinding({
      account: "clarice",
      ip: IP,
      endpoint: "https://api.brevo.com/v3/account",
      timestamp: new Date(),
      hostIPv4: null,
      hostIPv6: null,
    });
    assert.ok(finding.body.includes("BREVO_CLARICE_API_KEY"));
  });
});

describe("provesIpAllowlisted (#6156 P2, pura)", () => {
  it("401 nunca prova allowlist (é o próprio bloqueio)", () => {
    assert.equal(provesIpAllowlisted(401), false);
  });

  it("429 (rate limit) não prova allowlist", () => {
    assert.equal(provesIpAllowlisted(429), false);
  });

  it("5xx (erro de servidor) não prova allowlist", () => {
    assert.equal(provesIpAllowlisted(500), false);
    assert.equal(provesIpAllowlisted(503), false);
  });

  it("2xx/3xx/4xx (exceto 401/429) provam allowlist", () => {
    assert.equal(provesIpAllowlisted(200), true);
    assert.equal(provesIpAllowlisted(201), true);
    assert.equal(provesIpAllowlisted(404), true);
    assert.equal(provesIpAllowlisted(403), true);
  });
});

// ─── reportUnrecognisedIpFinding (I/O injetado) ────────────────────────────

describe("reportUnrecognisedIpFinding (#6137, I/O injetado)", () => {
  let stateDir: string;
  let statePath: string;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "brevo-unrec-ip-alarm-"));
    statePath = join(stateDir, "state.json");
  });

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
  });

  it("cria 1 issue na 1ª chamada", () => {
    const { run, calls } = makeFakeRun();
    const finding = buildUnrecognisedIpFinding({
      account: "clarice",
      ip: IP,
      endpoint: "https://api.brevo.com/v3/account",
      timestamp: new Date(),
      hostIPv4: "1.2.3.4",
      hostIPv6: IP,
    });
    reportUnrecognisedIpFinding(finding, { cwd: "/repo", run, statePath });

    const createCalls = calls.filter((a) => a[0] === "issue" && a[1] === "create");
    assert.equal(createCalls.length, 1);
    assert.ok(createCalls[0].some((a) => a.includes(IP)));

    const state = loadUnrecognisedIpAlarmState(statePath);
    assert.equal(state[`${CHECK}:clarice:${IP}`]?.issueNumber, 9001);
  });

  it("2ª chamada com o MESMO fingerprint reusa — nunca cria uma 2ª issue", () => {
    const { run, calls } = makeFakeRun();
    const finding = buildUnrecognisedIpFinding({
      account: "clarice",
      ip: IP,
      endpoint: "https://api.brevo.com/v3/account",
      timestamp: new Date(),
      hostIPv4: "1.2.3.4",
      hostIPv6: IP,
    });

    reportUnrecognisedIpFinding(finding, { cwd: "/repo", run, statePath });
    reportUnrecognisedIpFinding(finding, { cwd: "/repo", run, statePath });
    reportUnrecognisedIpFinding(finding, { cwd: "/repo", run, statePath });

    const createCalls = calls.filter((a) => a[0] === "issue" && a[1] === "create");
    assert.equal(createCalls.length, 1, "só a 1ª chamada deveria criar issue — as demais reusam via cache");
  });

  it("auto-close (#6137): sumir por closeAfterRuns execuções fecha a issue sozinha", () => {
    const { run, calls } = makeFakeRun();
    const finding = buildUnrecognisedIpFinding({
      account: "clarice",
      ip: IP,
      endpoint: "https://api.brevo.com/v3/account",
      timestamp: new Date(),
      hostIPv4: "1.2.3.4",
      hostIPv6: IP,
    });
    // 1: cria a issue (bloqueio detectado).
    reportUnrecognisedIpFinding(finding, { cwd: "/repo", run, statePath, closeAfterRuns: 2 });
    // 2 e 3: nenhum novo achado pra esta conta (IP já autorizado) — o
    // "tick" que o wiring real dispara a cada resposta não-401 da conta.
    maybeReconcileResolvedFindings("clarice", { cwd: "/repo", run, statePath, closeAfterRuns: 2 });
    maybeReconcileResolvedFindings("clarice", { cwd: "/repo", run, statePath, closeAfterRuns: 2 });

    const commentCalls = calls.filter((a) => a[0] === "issue" && a[1] === "comment");
    const closeCalls = calls.filter((a) => a[0] === "issue" && a[1] === "close");
    assert.equal(commentCalls.length, 1, "1ª ausência deveria comentar 'não reproduz mais'");
    assert.equal(closeCalls.length, 1, "2ª ausência consecutiva (closeAfterRuns=2) deveria fechar");

    const state = loadUnrecognisedIpAlarmState(statePath);
    assert.ok(state[`${CHECK}:clarice:${IP}`]?.closedAt, "estado local deveria marcar closedAt");
  });

  it("maybeReconcileResolvedFindings nunca toca conta sem achado rastreado (fast path sem I/O)", () => {
    const { run, calls } = makeFakeRun();
    maybeReconcileResolvedFindings("diaria", { cwd: "/repo", run, statePath });
    assert.equal(calls.length, 0, "sem estado nenhum pra 'diaria', não deveria chamar gh");
  });

  it("maybeReconcileResolvedFindings escopado por conta — não mexe em achado de OUTRA conta", () => {
    const { run, calls } = makeFakeRun();
    const findingClarice = buildUnrecognisedIpFinding({
      account: "clarice",
      ip: IP,
      endpoint: "https://api.brevo.com/v3/account",
      timestamp: new Date(),
      hostIPv4: null,
      hostIPv6: null,
    });
    reportUnrecognisedIpFinding(findingClarice, { cwd: "/repo", run, statePath });
    calls.length = 0; // reseta o registro — só nos importa o que acontece a partir daqui

    // Uma chamada bem-sucedida da conta 'diaria' NUNCA deveria mexer no
    // achado aberto de 'clarice'.
    maybeReconcileResolvedFindings("diaria", { cwd: "/repo", run, statePath });
    assert.equal(calls.length, 0);

    const state = loadUnrecognisedIpAlarmState(statePath);
    assert.equal(state[`${CHECK}:clarice:${IP}`]?.closedAt, null, "achado de clarice não deveria ter sido tocado");
  });

  it("fail-soft: gh indisponível não lança (chamada Brevo real nunca é afetada)", () => {
    const failingRun: GhRunFn = () => ({ status: 1, stdout: "", stderr: "gh: not authenticated" });
    const finding = buildUnrecognisedIpFinding({
      account: "clarice",
      ip: IP,
      endpoint: "https://api.brevo.com/v3/account",
      timestamp: new Date(),
      hostIPv4: null,
      hostIPv6: null,
    });
    assert.doesNotThrow(() => reportUnrecognisedIpFinding(finding, { cwd: "/repo", run: failingRun, statePath }));
  });
});

// ─── Wiring: brevoPost/brevoGet (mock de fetch, sem gh/rede reais) ─────────

describe("wiring em brevo-client.ts (#6137)", () => {
  let stateDir: string;
  let statePath: string;
  let origFetch: typeof fetch;
  let origClariceKey: string | undefined;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "brevo-unrec-ip-wiring-"));
    statePath = join(stateDir, "state.json");
    origFetch = globalThis.fetch;
    origClariceKey = process.env.BREVO_CLARICE_API_KEY;
    process.env.BREVO_CLARICE_API_KEY = "fake-clarice-key";
    __resetUnrecognisedIpAlarmTestOverrides();
  });

  afterEach(() => {
    globalThis.fetch = origFetch;
    if (origClariceKey === undefined) delete process.env.BREVO_CLARICE_API_KEY;
    else process.env.BREVO_CLARICE_API_KEY = origClariceKey;
    __resetUnrecognisedIpAlarmTestOverrides();
    rmSync(stateDir, { recursive: true, force: true });
  });

  it("brevoPost com 401 unrecognised IP produz achado (via brevoRawFetch) sem quebrar o erro original", async () => {
    const { run, calls } = makeFakeRun();
    __setUnrecognisedIpAlarmTestOverrides({
      run,
      statePath,
      cwd: "/repo",
      hostIps: { ipv4: "1.2.3.4", ipv6: IP },
    });
    globalThis.fetch = (async () =>
      new Response(UNRECOGNISED_IP_BODY, { status: 401 })) as unknown as typeof fetch;

    await assert.rejects(
      () => brevoPost("fake-clarice-key", "/emailCampaigns", { foo: "bar" }),
      (err: Error) => {
        // #6137: o clone pro achado não pode ter consumido o body que o
        // caller usa pra montar a mensagem de erro original.
        assert.match(err.message, /Brevo API POST/);
        assert.ok(err.message.includes(IP));
        return true;
      },
    );
    // #6156 P1: a detecção agora é fire-and-forget (nunca await'ada pelo
    // caminho de fetch) — o teste precisa esperar o trabalho pendente antes
    // de checar `calls`, senão a asserção corre uma race contra o `gh`
    // simulado.
    await __waitForPendingUnrecognisedIpWork();

    const createCalls = calls.filter((a) => a[0] === "issue" && a[1] === "create");
    assert.equal(createCalls.length, 1);
    assert.ok(createCalls[0].some((a) => a.includes("clarice") && a.includes(IP)));
  });

  it("brevoGet com 401 unrecognised IP também produz achado (caminho separado de brevoRawFetch)", async () => {
    const { run, calls } = makeFakeRun();
    __setUnrecognisedIpAlarmTestOverrides({
      run,
      statePath,
      cwd: "/repo",
      hostIps: { ipv4: "1.2.3.4", ipv6: IP },
    });
    globalThis.fetch = (async () =>
      new Response(UNRECOGNISED_IP_BODY, { status: 401 })) as unknown as typeof fetch;

    await assert.rejects(() => brevoGet("fake-clarice-key", "/emailCampaigns/178"));
    await __waitForPendingUnrecognisedIpWork();

    const createCalls = calls.filter((a) => a[0] === "issue" && a[1] === "create");
    assert.equal(createCalls.length, 1);
  });

  it("múltiplas chamadas falhando (mesma conta+IP) não geram múltiplos achados — dedup em processo", async () => {
    const { run, calls } = makeFakeRun();
    __setUnrecognisedIpAlarmTestOverrides({
      run,
      statePath,
      cwd: "/repo",
      hostIps: { ipv4: "1.2.3.4", ipv6: IP },
    });
    globalThis.fetch = (async () =>
      new Response(UNRECOGNISED_IP_BODY, { status: 401 })) as unknown as typeof fetch;

    // Simula o padrão real do incidente: N chamadas falhando em sequência
    // (retries, ou vários scripts/units diferentes na mesma janela).
    for (let i = 0; i < 5; i++) {
      await assert.rejects(() => brevoPost("fake-clarice-key", "/emailCampaigns", {}));
      await __waitForPendingUnrecognisedIpWork();
    }

    const createCalls = calls.filter((a) => a[0] === "issue" && a[1] === "create");
    assert.equal(createCalls.length, 1, "5 chamadas falhando deveriam produzir só 1 achado/issue");
  });

  it("401 de outra causa (key inválida, sem 'unrecognised IP') nunca aciona o alarme", async () => {
    const { run, calls } = makeFakeRun();
    __setUnrecognisedIpAlarmTestOverrides({ run, statePath, cwd: "/repo", hostIps: { ipv4: null, ipv6: null } });
    globalThis.fetch = (async () => new Response(OTHER_401_BODY, { status: 401 })) as unknown as typeof fetch;

    await assert.rejects(() => brevoPost("fake-clarice-key", "/emailCampaigns", {}));
    await __waitForPendingUnrecognisedIpWork();

    assert.equal(calls.length, 0, "401 sem 'unrecognised IP' não deveria chamar gh nenhuma vez");
  });

  it("resposta 200 normal nunca aciona o alarme quando não há achado rastreado (fast path)", async () => {
    const { run, calls } = makeFakeRun();
    __setUnrecognisedIpAlarmTestOverrides({ run, statePath, cwd: "/repo", hostIps: { ipv4: null, ipv6: null } });
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ id: 1 }), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;

    await brevoPost("fake-clarice-key", "/contacts", {});
    await __waitForPendingUnrecognisedIpWork();

    assert.equal(calls.length, 0);
  });

  it("#6156 P2: 429 nunca aciona a reconciliação (não prova que a conta+IP passaram a allowlist)", async () => {
    const { run, calls } = makeFakeRun();
    __setUnrecognisedIpAlarmTestOverrides({
      run,
      statePath,
      cwd: "/repo",
      hostIps: { ipv4: "1.2.3.4", ipv6: IP },
    });

    // 1: bloqueio detectado — cria a issue.
    globalThis.fetch = (async () =>
      new Response(UNRECOGNISED_IP_BODY, { status: 401 })) as unknown as typeof fetch;
    await assert.rejects(() => brevoPost("fake-clarice-key", "/emailCampaigns", {}));
    await __waitForPendingUnrecognisedIpWork();
    assert.equal(calls.filter((a) => a[0] === "issue" && a[1] === "create").length, 1);
    calls.length = 0;

    // 2: a MESMA conta passa a receber 429 (rate limit) — NÃO prova que o
    // IP foi autorizado, então não deveria avançar o streak de "resolvido".
    globalThis.fetch = (async () =>
      new Response("", { status: 429, headers: { "retry-after": "0" } })) as unknown as typeof fetch;
    await assert.rejects(() => brevoPost("fake-clarice-key", "/emailCampaigns", {}, (_ms: number) => Promise.resolve()));
    await __waitForPendingUnrecognisedIpWork();

    assert.equal(
      calls.filter((a) => a[0] === "issue" && (a[1] === "comment" || a[1] === "close")).length,
      0,
      "429 nunca deveria acionar comment/close da issue aberta",
    );
    const state = loadUnrecognisedIpAlarmState(statePath);
    assert.equal(state[`${CHECK}:clarice:${IP}`]?.closedAt, null, "achado deveria continuar aberto após só 429s");
  });

  it("auto-close fim-a-fim (#6137): 401 cria a issue; chamadas 200 seguintes fecham sozinhas", async () => {
    const { run, calls } = makeFakeRun();
    __setUnrecognisedIpAlarmTestOverrides({
      run,
      statePath,
      cwd: "/repo",
      // closeAfterRuns não é injetável via override — o wiring real usa o
      // default do módulo (2), o mesmo valor exercitado aqui.
      hostIps: { ipv4: "1.2.3.4", ipv6: IP },
    });

    globalThis.fetch = (async () =>
      new Response(UNRECOGNISED_IP_BODY, { status: 401 })) as unknown as typeof fetch;
    await assert.rejects(() => brevoPost("fake-clarice-key", "/emailCampaigns", {}));
    await __waitForPendingUnrecognisedIpWork();
    assert.equal(calls.filter((a) => a[0] === "issue" && a[1] === "create").length, 1);

    // IP foi autorizado — as próximas chamadas da MESMA conta voltam a 200.
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ id: 1 }), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
    await brevoPost("fake-clarice-key", "/contacts", {});
    await __waitForPendingUnrecognisedIpWork();
    await brevoPost("fake-clarice-key", "/contacts", {});
    await __waitForPendingUnrecognisedIpWork();

    assert.equal(calls.filter((a) => a[0] === "issue" && a[1] === "comment").length, 1);
    assert.equal(calls.filter((a) => a[0] === "issue" && a[1] === "close").length, 1);

    const state = loadUnrecognisedIpAlarmState(statePath);
    assert.ok(state[`${CHECK}:clarice:${IP}`]?.closedAt);
  });

  it("#6156 P2: dedup em-processo limpa após auto-close — o MESMO IP bloqueado de novo reabre o alarme", async () => {
    const { run, calls } = makeFakeRun();
    __setUnrecognisedIpAlarmTestOverrides({
      run,
      statePath,
      cwd: "/repo",
      hostIps: { ipv4: "1.2.3.4", ipv6: IP },
    });

    // 1: bloqueio detectado — cria a issue.
    globalThis.fetch = (async () =>
      new Response(UNRECOGNISED_IP_BODY, { status: 401 })) as unknown as typeof fetch;
    await assert.rejects(() => brevoPost("fake-clarice-key", "/emailCampaigns", {}));
    await __waitForPendingUnrecognisedIpWork();
    assert.equal(calls.filter((a) => a[0] === "issue" && a[1] === "create").length, 1);

    // 2-3: IP autorizado — 2 chamadas 200 consecutivas fecham a issue
    // (closeAfterRuns=2, default do módulo).
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ id: 1 }), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
    await brevoPost("fake-clarice-key", "/contacts", {});
    await __waitForPendingUnrecognisedIpWork();
    await brevoPost("fake-clarice-key", "/contacts", {});
    await __waitForPendingUnrecognisedIpWork();
    assert.ok(loadUnrecognisedIpAlarmState(statePath)[`${CHECK}:clarice:${IP}`]?.closedAt);

    // 4: o MESMO IP é bloqueado de novo (ex: allowlist revertida) — sem a
    // limpeza do dedup em-processo, isto ficaria silenciado pra sempre neste
    // processo (fingerprint já "reportado"), apesar da issue estar fechada.
    globalThis.fetch = (async () =>
      new Response(UNRECOGNISED_IP_BODY, { status: 401 })) as unknown as typeof fetch;
    await assert.rejects(() => brevoPost("fake-clarice-key", "/emailCampaigns", {}));
    await __waitForPendingUnrecognisedIpWork();

    const reopenOrCreateCalls = calls.filter(
      (a) => a[0] === "issue" && (a[1] === "create" || a[1] === "reopen"),
    );
    assert.equal(
      reopenOrCreateCalls.length,
      2,
      "recorrência após auto-close deveria reabrir/recriar o alarme, não ficar silenciada",
    );
  });
});
