import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { main } from "../scripts/reconcile-brave-path-b.ts";
import { computeBraveCreditStats } from "../scripts/lib/brave-credits.ts";

// now FIXO injetado via main(argv, path, now) → determinístico (sem flaky de
// virada de mês). Os timestamps seedados usam o mesmo mês do now.
const NOW = new Date("2026-06-15T12:00:00Z");
const MONTH = "2026-06";

function tmpPath(): string {
  return resolve(mkdtempSync(resolve(tmpdir(), "rec-")), "brave.jsonl");
}

// jsonl em produção SEMPRE termina com \n (recordBraveCredit appenda com \n).
// O seed precisa replicar isso, senão o append da estimativa cola na última linha.
function seed(path: string, entries: object[]): void {
  writeFileSync(path, entries.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");
}

test("reconcile: grava o gap do header como Path B; local passa a bater com o real", () => {
  const path = tmpPath();
  // 5 reais locais; última com quota_remaining=49 → real_used=1951 → gap=1946
  seed(path, [
    ...Array.from({ length: 4 }, (_, i) => ({ timestamp: `${MONTH}-15T10:00:00Z`, query: `q${i}`, status: "ok" })),
    { timestamp: `${MONTH}-15T10:05:00Z`, query: "q5", status: "ok", quota_remaining: 49 },
  ]);

  main(["--edition", "260701"], path, NOW);

  const s = computeBraveCreditStats("260701", path, NOW);
  assert.equal(s.queries_this_month_estimated, 1946, "deve gravar 1946 estimadas (o gap)");
  assert.equal(s.queries_this_month, 1951, "local agora bate com o real do header");
  assert.equal(s.delta_untracked, 0, "delta zera após reconciliar");
  rmSync(path, { recursive: true, force: true });
});

test("reconcile: idempotente — re-rodar não duplica", () => {
  const path = tmpPath();
  seed(path, [{ timestamp: `${MONTH}-15T10:00:00Z`, query: "q", status: "ok", quota_remaining: 1990 }]);
  main(["--edition", "260701"], path, NOW); // gap = 2000-1990-1 = 9 → grava 9
  main(["--edition", "260701"], path, NOW); // idempotente → não grava de novo
  const s = computeBraveCreditStats("260701", path, NOW);
  assert.equal(s.queries_this_month_estimated, 9, "não duplica na 2ª rodada");
  rmSync(path, { recursive: true, force: true });
});

test("reconcile: sem header → no-op (nada a reconciliar)", () => {
  const path = tmpPath();
  seed(path, [{ timestamp: `${MONTH}-15T10:00:00Z`, query: "q", status: "ok" }]);
  main(["--edition", "260701"], path, NOW);
  const s = computeBraveCreditStats("260701", path, NOW);
  assert.equal(s.queries_this_month_estimated, 0, "sem header não grava estimativa");
  rmSync(path, { recursive: true, force: true });
});

test("reconcile: gap ≤ 0 (local já ≥ header) → no-op", () => {
  const path = tmpPath();
  // 10 locais, quota_remaining=1995 → real_used=5 < 10 → delta negativo → no-op
  seed(path, Array.from({ length: 10 }, (_, i) => ({
    timestamp: `${MONTH}-15T10:00:00Z`,
    query: `q${i}`,
    status: "ok",
    ...(i === 9 ? { quota_remaining: 1995 } : {}),
  })));
  main(["--edition", "260701"], path, NOW);
  const s = computeBraveCreditStats("260701", path, NOW);
  assert.equal(s.queries_this_month_estimated, 0, "gap≤0 não grava");
  rmSync(path, { recursive: true, force: true });
});
