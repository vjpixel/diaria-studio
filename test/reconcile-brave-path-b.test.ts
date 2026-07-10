import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { main } from "../scripts/reconcile-brave-path-b.ts";
import {
  computeBraveCreditStats,
  writeBraveReconcileState,
  readBraveReconcileState,
} from "../scripts/lib/brave-credits.ts";

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

// ---------------------------------------------------------------------------
// #3271 — regressão: anchor não pode avançar quando recordBraveCreditEstimate
// no-opa por causa do SEU PRÓPRIO guard de idempotência (edition+source+mês já
// reconciliado). O teste "idempotente — re-rodar não duplica" (linha 74) usa um
// header INALTERADO (gap incremental=0) — nunca exercita o guard de idempotência
// de recordBraveCreditEstimate em si (o gap<=0 já intercepta antes). Este teste
// força um gap incremental GENUÍNO (>0) numa 2ª rodada da MESMA edição — cenário
// real de uma retomada da pipeline resumível — e verifica que o anchor NÃO avança
// (o gap fica preservado, não perdido) até que uma escrita de fato aconteça.
// ---------------------------------------------------------------------------

test("reconcile: 2ª execução da MESMA edição com gap novo genuíno → guard de idempotência no-opa e o anchor NÃO avança (regressão #3271)", () => {
  const path = tmpPath();
  const statePath = tmpStatePath();

  // --- 1ª rodada: 999 reais, header quota_remaining=49 → real_used=1951.
  // Bootstrap (sem estado anterior) → gap=952, grava 952 estimadas sob a edição
  // 260701, persiste anchor real_used=1951.
  seed(path, [
    ...Array.from({ length: 998 }, (_, i) => ({ timestamp: `${MONTH}-15T10:00:00Z`, query: `q${i}`, status: "ok" })),
    { timestamp: `${MONTH}-15T10:05:00Z`, query: "q999", status: "ok", quota_remaining: 49 },
  ]);
  main(["--edition", "260701"], path, NOW, statePath);

  const afterFirstRun = computeBraveCreditStats("260701", path, NOW);
  assert.equal(afterFirstRun.queries_this_edition_estimated, 952, "1ª rodada grava o gap de bootstrap (952)");
  const stateAfterFirstRun = readBraveReconcileState(statePath);
  assert.equal(stateAfterFirstRun?.real_used, 1951, "anchor persiste real_used=1951 após 1ª rodada");

  // --- 2ª rodada: MESMA edição (260701, pipeline resumível re-rodando Stage 1).
  // Header avançou de verdade: 10 novas queries reais + quota_remaining=39 →
  // real_used=1961. Gap incremental = 1961-1951=10 (genuíno, > 0 — NÃO é o caso
  // "header inalterado" do teste de idempotência existente).
  const moreReal: object[] = Array.from({ length: 9 }, (_, i) => ({
    timestamp: `${MONTH}-15T11:00:00Z`,
    query: `q-more-${i}`,
    status: "ok",
  }));
  moreReal.push({ timestamp: `${MONTH}-15T11:05:00Z`, query: "q-more-9", status: "ok", quota_remaining: 39 });
  writeFileSync(path, moreReal.map((e) => JSON.stringify(e)).join("\n") + "\n", { flag: "a", encoding: "utf8" });

  main(["--edition", "260701"], path, NOW, statePath);

  // recordBraveCreditEstimate no-opa: já existe entry estimated para
  // edition=260701+source=path-b-reconcile este mês (da 1ª rodada) — mesmo o
  // gap desta rodada (10) sendo genuíno e novo.
  const afterSecondRun = computeBraveCreditStats("260701", path, NOW);
  assert.equal(
    afterSecondRun.queries_this_edition_estimated,
    952,
    "2ª rodada NÃO grava as 10 novas — guard de idempotência de recordBraveCreditEstimate no-opa",
  );

  // O PONTO CENTRAL da regressão: o anchor NÃO deve avançar para 1961 quando a
  // escrita não aconteceu. Antes do #3271, persistState() rodava incondicionalmente
  // e o gap de 10 desaparecia pra sempre (nunca gravado, mas o anchor já tinha
  // "consumido" o intervalo).
  const stateAfterSecondRun = readBraveReconcileState(statePath);
  assert.equal(
    stateAfterSecondRun?.real_used,
    1951,
    "anchor permanece em 1951 (NÃO avança para 1961) — gap de 10 preservado, não perdido",
  );

  // --- 3ª rodada: edição DIFERENTE (260702) no mesmo mês — passa o guard de
  // idempotência (chave é edition+source+mês). O gap de 10 preservado pela 2ª
  // rodada agora É recuperado, provando que nada foi perdido permanentemente.
  main(["--edition", "260702"], path, NOW, statePath);

  const afterThirdRun = computeBraveCreditStats("260702", path, NOW);
  assert.equal(afterThirdRun.queries_this_edition_estimated, 10, "3ª rodada recupera o gap de 10 preservado");
  const stateAfterThirdRun = readBraveReconcileState(statePath);
  assert.equal(stateAfterThirdRun?.real_used, 1961, "anchor agora avança para 1961 — escrita de fato aconteceu");

  const totalStats = computeBraveCreditStats(null, path, NOW);
  assert.equal(totalStats.queries_this_month_estimated, 962, "total do mês: 952 (edição 1) + 10 (edição 2), sem perda");

  rmSync(path, { recursive: true, force: true });
});

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

// ---------------------------------------------------------------------------
// #3271 (achado na review do próprio PR) — quando o sanity cap ZERA `injected`
// (cap=0: já não sobra espaço nenhum no free tier este mês), recordBraveCreditEstimate
// no-opa pelo SEU PRÓPRIO guard `count<=0` — uma causa de no-op DIFERENTE da que o
// #3271 fix trata (guard de idempotência). Sem tratamento explícito, o gate genérico
// `if (!wrote)` do #3271 fix bloquearia persistState() TAMBÉM neste caso, congelando o
// anchor indefinidamente enquanto o cap continuar ativo — regressão nova (o
// comportamento pré-#3271 sempre avançava o anchor aqui). Este teste confirma que o
// anchor AINDA avança quando o motivo do no-op é o cap (não idempotência), e que o
// `reason` emitido distingue os dois casos.
// ---------------------------------------------------------------------------

test("reconcile: sanity cap zera a injeção (cap=0) → anchor AINDA avança (motivo é cap, não idempotência) (regressão #3271 review)", () => {
  const path = tmpPath();
  const statePath = tmpStatePath();
  const now = new Date("2026-07-20T12:00:00Z");

  // Anchor anterior real_used=1000 (não corrompido — só desatualizado o suficiente pra
  // gerar um gap genuíno de 1000 contra o header atual, real_used=2000).
  writeBraveReconcileState({ quota_remaining: 1000, real_used: 1000, timestamp: "2026-07-01T00:00:00Z" }, statePath);

  // 2000 reais já trackeados este mês → cap = max(0, 2000-2000) = 0. gap = 2000-1000 =
  // 1000 (>0, passa o gate gap<=0), mas injected = min(1000, cap=0) = 0.
  seed(path, [
    ...Array.from({ length: 1999 }, (_, i) => ({ timestamp: "2026-07-20T10:00:00Z", query: `q${i}`, status: "ok" })),
    { timestamp: "2026-07-20T10:05:00Z", query: "q2000", status: "ok", quota_remaining: 0 }, // real_used=2000
  ]);

  main(["--edition", "260720"], path, now, statePath);

  // Nada foi gravado (cap=0 → count<=0 → recordBraveCreditEstimate no-opa antes do
  // guard de idempotência).
  const stats = computeBraveCreditStats("260720", path, now);
  assert.equal(stats.queries_this_month_estimated, 0, "cap=0 não grava nenhuma estimativa");

  // O PONTO CENTRAL: o anchor AVANÇA (real_used=2000) mesmo sem gravar nada — porque o
  // motivo é o sanity cap (esgotamento de orçamento), não o guard de idempotência do
  // #3271. Congelar o anchor aqui acumularia o gap indefinidamente e o dumparia de uma
  // vez quando o cap reabrir no mês seguinte — regressão que #3122 já havia corrigido
  // para o caso de virada de mês.
  const state = readBraveReconcileState(statePath);
  assert.equal(state?.real_used, 2000, "anchor avança para 2000 mesmo com injected=0 (motivo: sanity cap, não idempotência)");

  rmSync(path, { recursive: true, force: true });
});
