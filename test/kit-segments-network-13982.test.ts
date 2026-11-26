import { test } from "node:test";
import assert from "node:assert/strict";
import { listSegments } from "../scripts/lib/kit-broadcasts.ts";
import { resolveDiariaAudience } from "../scripts/lib/kit-diaria-audience.ts";

for (const recover of [true, false]) {
  test(`#13982: rede ${recover ? "recupera antes de confirmar" : "esgota retries e bloqueia"}`, async () => {
    const original = globalThis.fetch;
    const waits: number[] = [];
    let calls = 0;
    globalThis.fetch = (async (url, init) => {
      assert.match(String(url), /\/segments\?/);
      assert.equal(init?.method, "GET");
      calls++;
      if (!recover || calls < 6) throw new TypeError("fetch failed");
      return Response.json({ segments: [{ id: 99, name: "diária" }] });
    }) as typeof fetch;
    try {
      const result = await resolveDiariaAudience({ enabled: true, segment_id: 99 }, {
        listSegments: () => listSegments({ apiKey: "test" }, { sleep: async ms => { waits.push(ms); } }),
      });
      assert.equal(calls, 6);
      assert.deepEqual(waits, [5000, 15000, 30000, 60000, 60000]);
      assert.equal(result.ok, recover);
      if (!result.ok) {
        assert.equal(result.reason_kind, "network");
        assert.equal("filter" in result, false);
      } else assert.equal(result.mode, "segment");
    } finally { globalThis.fetch = original; }
  });
}

for (const scenario of ["missing", "auth", "malformed"] as const) {
  test(`#13982: ${scenario} continua bloqueando sem classificar como rede`, async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () => scenario === "auth"
      ? new Response("unauthorized", { status: 401 })
      : Response.json(scenario === "missing" ? { segments: [] } : {})) as typeof fetch;
    try {
      const result = await resolveDiariaAudience({ enabled: true, segment_id: 99 }, {
        listSegments: () => listSegments({ apiKey: "test" }),
      });
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.reason_kind, undefined);
      assert.equal("filter" in result, false);
    } finally { globalThis.fetch = original; }
  });
}
