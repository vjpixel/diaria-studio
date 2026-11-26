/**
 * test/kit-schedule-network-13982.test.ts (#13982)
 *
 * Edição 261126, Etapa 6: `schedule-newsletter-kit.ts` saiu exit 7 duas vezes
 * seguidas porque a listagem de segmentos do Kit falhou por REDE
 * (`fetchWithRetry: falhou após 4 tentativa(s) ... fetch failed`). O exit 7
 * mistura "audiência divergente" (recusa correta) com "rede indisponível"
 * (transitória), e o playbook mandava investigar segmento/config.
 *
 * O fix: falha transitória na listagem (sem resposta HTTP, ou 5xx/429
 * persistente) sai `reason_kind: "network"` e exit 8, com retry mais longo só
 * nessa consulta. Fail-closed intacto: em NENHUMA falha de rede o broadcast é
 * agendado. Divergência real continua exit 7, sem `reason_kind`.
 *
 * `fetch` global mockado; nenhuma chamada real ao Kit.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listSegments } from "../scripts/lib/kit-broadcasts.ts";
import {
  DIARIA_AUDIENCE_SEGMENTS_RETRY,
  isTransientSegmentsListError,
  resolveDiariaAudience,
} from "../scripts/lib/kit-diaria-audience.ts";
import { FetchNetworkError } from "../scripts/lib/fetch-retry.ts";
import { KitApiError } from "../scripts/lib/kit-client.ts";
import { main } from "../scripts/schedule-newsletter-kit.ts";
import {
  KIT_SCHEDULE_NETWORK_LOG_MESSAGE,
  signalsFromKitScheduleNetwork,
  signalsFromTestWarnings,
} from "../scripts/collect-edition-signals.ts";

const CFG = { enabled: true, segment_id: 99 };
const noSleep = (waits: number[]) => async (ms: number) => {
  waits.push(ms);
};

function withFetch<T>(impl: typeof fetch, fn: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  return fn().finally(() => {
    globalThis.fetch = original;
  });
}

const segmentsOk = () =>
  new Response(JSON.stringify({ segments: [{ id: 99, name: "diária" }], pagination: { has_next_page: false, end_cursor: null } }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

describe("#13982 — resolveDiariaAudience classifica falha transitória da listagem", () => {
  it("rede fora em todas as 6 tentativas: ok:false, reason_kind network, sem filtro, backoff longo", async () => {
    const waits: number[] = [];
    let calls = 0;
    const result = await withFetch(
      (async (url: string | URL | Request, init?: RequestInit) => {
        assert.match(String(url), /\/segments\?/);
        assert.equal(init?.method, "GET");
        calls++;
        throw new TypeError("fetch failed");
      }) as typeof fetch,
      () =>
        resolveDiariaAudience(CFG, {
          listSegments: () => listSegments({ apiKey: "k" }, { ...DIARIA_AUDIENCE_SEGMENTS_RETRY, sleep: noSleep(waits) }),
        }),
    );
    assert.equal(calls, 6);
    assert.deepEqual(waits, [5000, 15000, 30000, 60000, 60000]);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.reason_kind, "network");
    assert.match(result.reason, /rede indisponível/);
    assert.match(result.reason, /repita o mesmo comando/);
    assert.equal("filter" in result, false, "falha de rede nunca devolve filtro (nem o da base inteira)");
  });

  it("rede volta na 6ª tentativa: segmento confirmado (o retry longo segura a janela)", async () => {
    let calls = 0;
    const result = await withFetch(
      (async () => {
        calls++;
        if (calls < 6) throw new TypeError("fetch failed");
        return segmentsOk();
      }) as typeof fetch,
      () =>
        resolveDiariaAudience(CFG, {
          listSegments: () => listSegments({ apiKey: "k" }, { ...DIARIA_AUDIENCE_SEGMENTS_RETRY, sleep: noSleep([]) }),
        }),
    );
    assert.equal(calls, 6);
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.mode, "segment");
  });

  it("503 persistente também é transitório: reason_kind network", async () => {
    const result = await withFetch(
      (async () => new Response("unavailable", { status: 503 })) as typeof fetch,
      () =>
        resolveDiariaAudience(CFG, {
          listSegments: () => listSegments({ apiKey: "k" }, { ...DIARIA_AUDIENCE_SEGMENTS_RETRY, sleep: noSleep([]) }),
        }),
    );
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason_kind, "network");
  });

  for (const scenario of ["missing", "auth", "malformed", "plain-error"] as const) {
    it(`${scenario}: continua recusa de audiência (sem reason_kind), como antes`, async () => {
      const result = await withFetch(
        (async () => {
          if (scenario === "auth") return new Response("unauthorized", { status: 401 });
          if (scenario === "malformed") return Response.json({});
          return Response.json({ segments: [], pagination: { has_next_page: false } });
        }) as typeof fetch,
        () =>
          resolveDiariaAudience(CFG, {
            listSegments:
              scenario === "plain-error"
                ? async () => {
                    throw new Error("erro qualquer");
                  }
                : () => listSegments({ apiKey: "k" }),
          }),
      );
      assert.equal(result.ok, false);
      if (result.ok) return;
      assert.equal(result.reason_kind, undefined);
      assert.match(result.reason, /abortando em vez de mandar pra base inteira/);
    });
  }

  it("isTransientSegmentsListError: só transporte, 5xx e 429", () => {
    assert.equal(isTransientSegmentsListError(new FetchNetworkError("x")), true);
    assert.equal(isTransientSegmentsListError(new KitApiError("/segments", 502, "")), true);
    assert.equal(isTransientSegmentsListError(new KitApiError("/segments", 429, "")), true);
    assert.equal(isTransientSegmentsListError(new KitApiError("/segments", 401, "")), false);
    assert.equal(isTransientSegmentsListError(new KitApiError("/segments", 404, "")), false);
    assert.equal(isTransientSegmentsListError(new Error("fetch failed")), false);
  });
});

describe("#13982 — main(): exit 8 para rede, exit 7 para audiência, nada agendado", () => {
  let root: string;
  let origArgv: string[];
  let origKey: string | undefined;
  let origLog: typeof console.log;
  before(() => {
    origArgv = process.argv;
    origKey = process.env.KIT_API_KEY;
    origLog = console.log;
  });
  after(() => {
    process.argv = origArgv;
    console.log = origLog;
    process.exitCode = undefined;
    if (origKey === undefined) delete process.env.KIT_API_KEY;
    else process.env.KIT_API_KEY = origKey;
  });

  async function runMain(fetchImpl: (path: string, method: string) => Response | Promise<Response>) {
    root = mkdtempSync(join(tmpdir(), "kit-schedule-13982-"));
    process.env.KIT_API_KEY = "kit_test_key_13982";
    writeFileSync(
      join(root, "platform.config.json"),
      JSON.stringify({ publishing: { newsletter: { backend: "kit" } }, kit: { diaria_exclusion_segment: CFG } }),
      "utf8",
    );
    const seen: string[] = [];
    const out: string[] = [];
    console.log = (...args: unknown[]) => {
      out.push(args.map(String).join(" "));
    };
    process.argv = ["node", "schedule-newsletter-kit.ts", "--edition-dir", root, "--scheduled-at", "2099-08-26T09:00:00.000Z", "--allow-other-date"];
    process.exitCode = undefined;
    try {
      await withFetch(
        (async (url: string, init?: RequestInit) => {
          const u = new URL(url);
          const method = init?.method ?? "GET";
          seen.push(`${method} ${u.pathname}`);
          return fetchImpl(u.pathname, method);
        }) as typeof fetch,
        () => main(root, { sleep: async () => {} }),
      );
    } finally {
      console.log = origLog;
      rmSync(root, { recursive: true, force: true });
    }
    const exitCode = process.exitCode;
    process.exitCode = undefined;
    return { exitCode, seen, json: JSON.parse(out[out.length - 1] ?? "null") as Record<string, unknown> | null };
  }

  it("rede fora na listagem de segmentos: exit 8, reason_kind network, só GETs de segmentos (nunca PATCH)", async () => {
    const r = await runMain(() => {
      throw new TypeError("fetch failed");
    });
    assert.equal(r.exitCode, 8);
    assert.equal(r.json?.ok, false);
    assert.equal(r.json?.code, 8);
    assert.equal(r.json?.reason_kind, "network");
    assert.match(String(r.json?.reason), /rede indisponível/);
    assert.match(String(r.json?.reason), /repita/);
    assert.ok(r.seen.length === 6 && r.seen.every((s) => s === "GET /v4/segments"), `chamadas: ${r.seen.join(", ")}`);
  });

  it("segmento ausente da conta: exit 7 como antes, sem reason_kind", async () => {
    const r = await runMain((path) => {
      if (path === "/v4/segments") return Response.json({ segments: [], pagination: { has_next_page: false } });
      throw new Error(`chamada inesperada: ${path}`);
    });
    assert.equal(r.exitCode, 7);
    assert.equal(r.json?.code, 7);
    assert.equal("reason_kind" in (r.json ?? {}), false);
    assert.deepEqual(r.seen, ["GET /v4/segments"]);
  });

  it("401 na listagem: exit 7 (credencial não é falha transitória)", async () => {
    const r = await runMain(() => new Response("unauthorized", { status: 401 }));
    assert.equal(r.exitCode, 7);
    assert.equal("reason_kind" in (r.json ?? {}), false);
  });
});

describe("#13982 — collect-edition-signals: exit 8 chega ao auto-reporter", () => {
  const line = (o: Record<string, unknown>) => JSON.stringify(o);
  const lines = [
    line({
      timestamp: "2026-11-25T21:00:00Z",
      edition: "261126",
      stage: 6,
      agent: "orchestrator",
      level: "error",
      message: KIT_SCHEDULE_NETWORK_LOG_MESSAGE,
      details: { ok: false, code: 8, reason_kind: "network", reason: "rede indisponível: ..." },
    }),
    line({ timestamp: "2026-11-25T21:05:00Z", edition: "261126", stage: 6, agent: "orchestrator", level: "error", message: KIT_SCHEDULE_NETWORK_LOG_MESSAGE }),
    line({ timestamp: "2026-11-25T21:06:00Z", edition: "261126", stage: 6, agent: "orchestrator", level: "error", message: "newsletter kit stage6 schedule: exit 7" }),
    line({ timestamp: "2026-11-25T21:07:00Z", edition: "261125", stage: 6, agent: "orchestrator", level: "error", message: KIT_SCHEDULE_NETWORK_LOG_MESSAGE }),
  ];

  it("agrega as ocorrências da edição num signal só; exit 7 e outra edição ficam fora", () => {
    const signals = signalsFromKitScheduleNetwork(lines, "261126");
    assert.equal(signals.length, 1);
    assert.equal(signals[0].kind, "kit_schedule_network");
    assert.equal(signals[0].details.count, 2);
    assert.equal(signals[0].details.sample_reason, "rede indisponível: ...");
    assert.equal(signals[0].related_issue, "#13982");
  });

  it("sem exit 8 no log: nenhum signal", () => {
    assert.deepEqual(signalsFromKitScheduleNetwork([lines[2]], "261126"), []);
  });

  it("test_warning genérico não duplica o exit 8", () => {
    const tw = signalsFromTestWarnings(lines, "261126");
    assert.ok(tw.every((s) => !String(s.details.message).startsWith(KIT_SCHEDULE_NETWORK_LOG_MESSAGE)));
    assert.ok(tw.some((s) => String(s.details.message).endsWith("exit 7")), "o exit 7 segue no test_warning");
  });
});
