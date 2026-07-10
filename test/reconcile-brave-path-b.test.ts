import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { main } from "../scripts/reconcile-brave-path-b.ts";
import { computeBraveCreditStats, writeBraveReconcileState } from "../scripts/lib/brave-credits.ts";

// now FIXO injetado via main(argv, path, now, statePath) → determinístico (sem flaky de
// virada de mês). Os timestamps seedados usam o mesmo mês do now.
const NOW = new Date("2026-06-15T12:00:00Z");
const MONTH = "2026-06";

function tmpPath(): string {
  return resolve(mkdtempSync(resolve(tmpdir(), "rec-")), "brave.jsonl");
}

// (#3122) statePath TAMBÉM precisa ser isolado por teste — o default
// (`DEFAULT_RECONCILE_STATE_PATH`, sob `data/`) é COMPARTILHADO entre chamadas
// se não sobrescrito, o que polui um teste com o estado gravado por outro
// (ou, pior, com o estado real do editor rodando `npm test` localmente).
function tmpStatePath(): string {
  return resolve(mkdtempSync(resolve(tmpdir(), "rec-state-")), "state.json");
}

// jsonl em produção SEMPRE termina com \n (recordBraveCredit appenda com \n).
// O seed precisa replicar isso, senão o append da estimativa cola na última linha.
function seed(path: string, entries: object[]): void {
  writeFileSync(path, entries.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");
}

test("reconcile: grava o gap do header como Path B; local passa a bater com o real", () => {
  const path = tmpPath();
  const statePath = tmpStatePath();
  // 999 reais locais; última com quota_remaining=49 → real_used=1951 → gap=952.
  // Divergência ~2× (plausível, #2668) — não descartada pelo guard de #3002.
  // Sem estado anterior (1ª rodada) → bootstrap: gap = delta vs. mês corrente
  // (comportamento idêntico ao pré-#3122 só nesta 1ª vez).
  seed(path, [
    ...Array.from({ length: 998 }, (_, i) => ({ timestamp: `${MONTH}-15T10:00:00Z`, query: `q${i}`, status: "ok" })),
    { timestamp: `${MONTH}-15T10:05:00Z`, query: "q999", status: "ok", quota_remaining: 49 },
  ]);

  main(["--edition", "260701"], path, NOW, statePath);

  const s = computeBraveCreditStats("260701", path, NOW);
  assert.equal(s.queries_this_month_estimated, 952, "deve gravar 952 estimadas (o gap)");
  assert.equal(s.queries_this_month, 1951, "local agora bate com o real do header");
  assert.equal(s.delta_untracked, 0, "delta zera após reconciliar");
  rmSync(path, { recursive: true, force: true });
});

// (#3002) Quando o header diverge implausivelmente do local (ciclo de rate-limit
// desalinhado), computeBraveCreditStats já descarta o header (delta_untracked
// fica undefined) — reconcile deve então cair no branch "no_header" e NÃO gravar
// nenhuma estimativa fantasma a partir do gap implausível.
test("reconcile: header descartado por divergência implausível → no-op (regressão #3002)", () => {
  const path = tmpPath();
  const statePath = tmpStatePath();
  // 5 reais locais; última com quota_remaining=49 → real_used=1951 → ratio 390× (implausível)
  seed(path, [
    ...Array.from({ length: 4 }, (_, i) => ({ timestamp: `${MONTH}-15T10:00:00Z`, query: `q${i}`, status: "ok" })),
    { timestamp: `${MONTH}-15T10:05:00Z`, query: "q5", status: "ok", quota_remaining: 49 },
  ]);

  main(["--edition", "260701"], path, NOW, statePath);

  const s = computeBraveCreditStats("260701", path, NOW);
  assert.equal(s.queries_this_month_estimated, 0, "não deve gravar nenhuma estimativa fantasma");
  assert.equal(s.queries_this_month, 5, "local permanece 5 — sem reconciliação espúria");
  rmSync(path, { recursive: true, force: true });
});

test("reconcile: idempotente — re-rodar não duplica", () => {
  const path = tmpPath();
  const statePath = tmpStatePath();
  seed(path, [{ timestamp: `${MONTH}-15T10:00:00Z`, query: "q", status: "ok", quota_remaining: 1990 }]);
  main(["--edition", "260701"], path, NOW, statePath); // bootstrap: gap = 2000-1990-1 = 9 → grava 9, persiste estado
  main(["--edition", "260701"], path, NOW, statePath); // 2ª rodada: mesmo header → incremental gap=0 → no-op
  const s = computeBraveCreditStats("260701", path, NOW);
  assert.equal(s.queries_this_month_estimated, 9, "não duplica na 2ª rodada");
  rmSync(path, { recursive: true, force: true });
});

test("reconcile: sem header → no-op (nada a reconciliar)", () => {
  const path = tmpPath();
  const statePath = tmpStatePath();
  seed(path, [{ timestamp: `${MONTH}-15T10:00:00Z`, query: "q", status: "ok" }]);
  main(["--edition", "260701"], path, NOW, statePath);
  const s = computeBraveCreditStats("260701", path, NOW);
  assert.equal(s.queries_this_month_estimated, 0, "sem header não grava estimativa");
  rmSync(path, { recursive: true, force: true });
});

test("reconcile: gap ≤ 0 (local já ≥ header) → no-op", () => {
  const path = tmpPath();
  const statePath = tmpStatePath();
  // 10 locais, quota_remaining=1995 → real_used=5 < 10 → delta negativo → no-op
  seed(path, Array.from({ length: 10 }, (_, i) => ({
    timestamp: `${MONTH}-15T10:00:00Z`,
    query: `q${i}`,
    status: "ok",
    ...(i === 9 ? { quota_remaining: 1995 } : {}),
  })));
  main(["--edition", "260701"], path, NOW, statePath);
  const s = computeBraveCreditStats("260701", path, NOW);
  assert.equal(s.queries_this_month_estimated, 0, "gap≤0 não grava");
  rmSync(path, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// #3122 — regressão: header cumulativo pelo CICLO DE COBRANÇA (não mês-calendário)
// não deve dumpar o gap inteiro no mês novo quando ele vira.
// ---------------------------------------------------------------------------

test("reconcile: virada de mês — estimativa de julho é o INCREMENTO desde a última rodada, não o header absoluto (regressão #3122)", () => {
  const path = tmpPath();
  const statePath = tmpStatePath();

  // Reproduz o formato exato do incidente 260708: junho com 999 reais + Path B
  // reconciliado dentro do mês; header, em 07-07, mostra ~1951 cumulativo — mas
  // esse total inclui o consumo de junho (o ciclo de cobrança do Brave não é
  // mês-calendário). Julho trackeou 220 reais localmente.
  const JUNE_NOW = new Date("2026-06-15T10:05:00Z");
  const JULY_NOW = new Date("2026-07-07T19:05:23Z");

  // --- Junho: 999 reais, header quota_remaining=49 (real_used=1951) ---
  seed(path, [
    ...Array.from({ length: 998 }, (_, i) => ({ timestamp: "2026-06-15T10:00:00Z", query: `jun-q${i}`, status: "ok" })),
    { timestamp: "2026-06-15T10:05:00Z", query: "jun-q999", status: "ok", quota_remaining: 49 },
  ]);
  main(["--edition", "260615"], path, JUNE_NOW, statePath); // bootstrap: gap=952, injeta 952, persiste real_used=1951

  const juneStats = computeBraveCreditStats("260615", path, JUNE_NOW);
  assert.equal(juneStats.queries_this_month_estimated, 952, "junho reconciliado normalmente (952 estimadas)");

  // --- Julho: 220 reais tracked; header ainda mostra quota_remaining=49
  // (real_used=1951 — mesma leitura cumulativa, sem incremento perceptível
  // desde a rodada de junho). Sob o bug pré-#3122, isso geraria
  // delta_untracked = 1951 - 220 = 1731 atribuído inteiramente a julho —
  // exatamente o número do alarme falso da issue.
  const julyEntries: object[] = Array.from({ length: 219 }, (_, i) => ({
    timestamp: "2026-07-07T09:00:00Z",
    query: `jul-q${i}`,
    status: "ok",
  }));
  julyEntries.push({
    timestamp: "2026-07-07T19:00:00Z",
    query: "jul-q220",
    status: "ok",
    quota_remaining: 49,
  });
  // Append (não sobrescreve) — o jsonl é histórico cumulativo real.
  writeFileSync(path, julyEntries.map((e) => JSON.stringify(e)).join("\n") + "\n", { flag: "a", encoding: "utf8" });

  // Confirma a premissa do teste: SEM o fix, o cálculo antigo (header absoluto −
  // tracked do mês) daria 1731 — o número exato do incidente 260708.
  const julyStatsBeforeReconcile = computeBraveCreditStats("260707", path, JULY_NOW);
  assert.equal(julyStatsBeforeReconcile.queries_this_month_real, 220, "220 reais trackeados em julho");
  assert.equal(
    julyStatsBeforeReconcile.delta_untracked,
    1731,
    "premissa do bug: o gap absoluto vs. mês corrente seria 1731 (o número do incidente)",
  );

  main(["--edition", "260707"], path, JULY_NOW, statePath);

  const julyStats = computeBraveCreditStats("260707", path, JULY_NOW);
  assert.notEqual(julyStats.queries_this_month_estimated, 1731, "NÃO deve injetar o gap absoluto de 1731");
  assert.equal(
    julyStats.queries_this_month_estimated,
    0,
    "incremento desde a última rodada (junho) é 0 — header não avançou — logo nada novo a atribuir a julho",
  );
  assert.equal(julyStats.queries_this_month, 220, "julho permanece só com o real trackeado (220), sem gap fantasma");

  rmSync(path, { recursive: true, force: true });
});

test("reconcile: virada de mês com incremento genuíno pequeno → só o incremento é atribuído ao mês novo (#3122)", () => {
  const path = tmpPath();
  const statePath = tmpStatePath();
  const JUNE_NOW = new Date("2026-06-15T10:05:00Z");
  const JULY_NOW = new Date("2026-07-07T19:05:23Z");

  seed(path, [
    ...Array.from({ length: 998 }, (_, i) => ({ timestamp: "2026-06-15T10:00:00Z", query: `jun-q${i}`, status: "ok" })),
    { timestamp: "2026-06-15T10:05:00Z", query: "jun-q999", status: "ok", quota_remaining: 49 }, // real_used=1951
  ]);
  main(["--edition", "260615"], path, JUNE_NOW, statePath); // persiste real_used=1951

  // Julho: 220 reais + header avançou de quota_remaining=49 → 20 (real_used=1980)
  // → incremento genuíno de 29 desde a rodada de junho.
  const julyEntries: object[] = Array.from({ length: 219 }, (_, i) => ({
    timestamp: "2026-07-07T09:00:00Z",
    query: `jul-q${i}`,
    status: "ok",
  }));
  julyEntries.push({ timestamp: "2026-07-07T19:00:00Z", query: "jul-q220", status: "ok", quota_remaining: 20 });
  writeFileSync(path, julyEntries.map((e) => JSON.stringify(e)).join("\n") + "\n", { flag: "a", encoding: "utf8" });

  main(["--edition", "260707"], path, JULY_NOW, statePath);

  const julyStats = computeBraveCreditStats("260707", path, JULY_NOW);
  assert.equal(julyStats.queries_this_month_estimated, 29, "só o incremento (1980-1951=29) é atribuído a julho");
  assert.equal(julyStats.queries_this_month, 249, "220 reais + 29 estimadas");
  rmSync(path, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// #3122 fix 3 — sanity cap: uma rodada nunca injeta mais que o espaço livre
// do free tier este mês, mesmo com a lógica incremental (defense-in-depth
// contra estado de reconcile corrompido/stale).
// ---------------------------------------------------------------------------

test("reconcile: sanity cap — gap incremental implausivelmente alto é clampado ao espaço livre do mês (#3122 fix 3)", () => {
  const path = tmpPath();
  const statePath = tmpStatePath();
  const now = new Date("2026-07-20T12:00:00Z");

  // Estado anterior deliberadamente stale/corrompido: real_used=0 (como se o
  // sidecar tivesse sido resetado/perdido parcialmente) — força um gap
  // incremental de 2000 contra o header atual (quota_remaining=0 → real_used=2000).
  writeBraveReconcileState({ quota_remaining: 2000, real_used: 0, timestamp: "2026-07-01T00:00:00Z" }, statePath);

  // 1990 reais já trackeados este mês (julho) → só sobra espaço pra 10 no free tier.
  seed(path, [
    ...Array.from({ length: 1989 }, (_, i) => ({ timestamp: "2026-07-20T10:00:00Z", query: `q${i}`, status: "ok" })),
    { timestamp: "2026-07-20T10:05:00Z", query: "q1990", status: "ok", quota_remaining: 0 }, // real_used=2000
  ]);

  main(["--edition", "260720"], path, now, statePath);

  const stats = computeBraveCreditStats("260720", path, now);
  // Sem o cap, o incremental (2000-0=2000) seria injetado inteiro. Com o cap,
  // fica limitado a 2000-1990=10 (o espaço livre real no free tier este mês).
  assert.equal(
    stats.queries_this_month_estimated,
    10,
    "cap clampa a injeção a (limite - reais do mês) = 10, não ao gap bruto de 2000",
  );
  assert.equal(stats.queries_this_month, 2000, "total do mês nunca ultrapassa o free tier limit após o cap");
  rmSync(path, { recursive: true, force: true });
});
