/**
 * test/clarice-novos-state.test.ts (#4347 Etapa 4)
 *
 * Estado da skill `/diaria-clarice-novos`: skip de test email por SHA-256
 * idêntico (D12) e resolução de --key idempotente por dia.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  readNovosState,
  writeNovosState,
  novosStatePath,
  sha256Hex,
  shouldSendTest,
  resolveNovosKey,
  buildFinalizeScheduledState,
  buildFinalizeState,
  reconcilePendingSend,
  reconcileNovosSentCount,
  type NovosState,
  type NovosCampaignSentCount,
} from "../scripts/lib/clarice-novos-state.ts";

// ---------------------------------------------------------------------------
// readNovosState / writeNovosState
// ---------------------------------------------------------------------------

test("readNovosState: arquivo ausente -> null (1ª rodada)", () => {
  const dir = mkdtempSync(resolve(tmpdir(), "novos-state-empty-"));
  assert.equal(readNovosState(dir), null);
});

test("readNovosState: JSON corrompido -> null (tolerante, nunca lança)", () => {
  const dir = mkdtempSync(resolve(tmpdir(), "novos-state-corrupt-"));
  writeFileSync(novosStatePath(dir), "{ não é json", "utf8");
  assert.equal(readNovosState(dir), null);
});

test("writeNovosState + readNovosState: round-trip preserva os campos", () => {
  const dir = mkdtempSync(resolve(tmpdir(), "novos-state-roundtrip-"));
  const state: NovosState = {
    lastRunAt: "2026-07-30T10:00:00.000Z",
    lastHtmlSha256: "abc123",
    lastCycle: "2606-07",
    lastListId: 42,
    lastCampaignId: 99,
    sentCount: 37,
    pendingSend: null,
  };
  writeNovosState(state, dir);
  assert.ok(existsSync(novosStatePath(dir)));
  assert.deepEqual(readNovosState(dir), state);
});

test("writeNovosState + readNovosState: round-trip preserva pendingSend (#4670)", () => {
  const dir = mkdtempSync(resolve(tmpdir(), "novos-state-roundtrip-pending-"));
  const state: NovosState = {
    lastRunAt: "2026-08-05T10:00:00.000Z",
    lastHtmlSha256: "sha-agendado",
    lastCycle: "2607-08",
    lastListId: null,
    lastCampaignId: null,
    sentCount: 0,
    pendingSend: { campaignId: 120, listId: 106, scheduledAt: "2026-08-06T10:00:00-03:00", contactCount: 70 },
  };
  writeNovosState(state, dir);
  assert.deepEqual(readNovosState(dir), state);
});

test("readNovosState: state LEGADO sem pendingSend lê sem quebrar -> pendingSend null (#4670 retrocompat)", () => {
  const dir = mkdtempSync(resolve(tmpdir(), "novos-state-legacy-"));
  const legacy = {
    lastRunAt: "2026-07-01T00:00:00.000Z",
    lastHtmlSha256: "sha-antigo",
    lastCycle: "2606-07",
    lastListId: 1,
    lastCampaignId: 2,
    sentCount: 10,
    // sem pendingSend — state gravado antes do #4670
  };
  writeFileSync(novosStatePath(dir), JSON.stringify(legacy), "utf8");
  const read = readNovosState(dir);
  assert.deepEqual(read, { ...legacy, pendingSend: null });
});

test("readNovosState: pendingSend corrompido/parcial no JSON -> degrada pra null, não lança", () => {
  const dir = mkdtempSync(resolve(tmpdir(), "novos-state-pending-corrupt-"));
  const raw = {
    lastRunAt: "2026-08-01T00:00:00.000Z",
    lastHtmlSha256: null,
    lastCycle: null,
    lastListId: null,
    lastCampaignId: null,
    sentCount: 0,
    pendingSend: { campaignId: 120 }, // faltam listId/scheduledAt/contactCount
  };
  writeFileSync(novosStatePath(dir), JSON.stringify(raw), "utf8");
  const read = readNovosState(dir);
  assert.equal(read?.pendingSend, null);
});

// ---------------------------------------------------------------------------
// shouldSendTest (D12)
// ---------------------------------------------------------------------------

test("shouldSendTest: state ausente (1ª rodada) -> sempre manda test email", () => {
  assert.equal(shouldSendTest("sha-novo", null), true);
});

test("shouldSendTest: SHA IDÊNTICO ao da última rodada -> pula (D12)", () => {
  const state: NovosState = { lastRunAt: "x", lastHtmlSha256: "sha-igual", lastCycle: null, lastListId: null, lastCampaignId: null, sentCount: 0, pendingSend: null };
  assert.equal(shouldSendTest("sha-igual", state), false);
});

test("shouldSendTest: SHA DIFERENTE -> manda de novo", () => {
  const state: NovosState = { lastRunAt: "x", lastHtmlSha256: "sha-antigo", lastCycle: null, lastListId: null, lastCampaignId: null, sentCount: 0, pendingSend: null };
  assert.equal(shouldSendTest("sha-novo", state), true);
});

test("shouldSendTest: state existe mas SEM lastHtmlSha256 (versão antiga) -> fail-safe, manda", () => {
  const state: NovosState = { lastRunAt: "x", lastHtmlSha256: null, lastCycle: null, lastListId: null, lastCampaignId: null, sentCount: 0, pendingSend: null };
  assert.equal(shouldSendTest("sha-qualquer", state), true);
});

test("sha256Hex: determinístico, muda com o conteúdo", () => {
  const a = sha256Hex("<html>A</html>");
  const b = sha256Hex("<html>A</html>");
  const c = sha256Hex("<html>B</html>");
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.equal(a.length, 64); // hex de 32 bytes
});

// ---------------------------------------------------------------------------
// resolveNovosKey — idempotência por dia
// ---------------------------------------------------------------------------

test("resolveNovosKey: 1ª rodada do dia -> novos-{AAMMDD} sem sufixo", () => {
  assert.equal(resolveNovosKey([], "260730"), "novos-260730");
});

test("resolveNovosKey: key base já existe -> sufixo -2", () => {
  assert.equal(resolveNovosKey(["novos-260730"], "260730"), "novos-260730-2");
});

test("resolveNovosKey: -2 também já existe -> avança pra -3", () => {
  assert.equal(resolveNovosKey(["novos-260730", "novos-260730-2"], "260730"), "novos-260730-3");
});

test("resolveNovosKey: não colide com key de outro dia", () => {
  assert.equal(resolveNovosKey(["novos-260729"], "260730"), "novos-260730");
});

// ---------------------------------------------------------------------------
// #4670 — envio agendado: buildFinalizeScheduledState / buildFinalizeState /
// reconcilePendingSend. Caso real: campanha #120 (lista 106, 70 contatos),
// agendada pro dia seguinte em vez de disparada na hora.
// ---------------------------------------------------------------------------

test("buildFinalizeScheduledState: grava SHA + pendingSend, NÃO soma sentCount", () => {
  const prev: NovosState = {
    lastRunAt: "2026-08-01T00:00:00.000Z",
    lastHtmlSha256: "sha-velho",
    lastCycle: "2606-07",
    lastListId: 10,
    lastCampaignId: 20,
    sentCount: 200,
    pendingSend: null,
  };
  const next = buildFinalizeScheduledState(prev, {
    htmlSha256: "sha-novo",
    cycle: "2607-08",
    listId: 106,
    campaignId: 120,
    scheduledAt: "2026-08-06T10:00:00-03:00",
    contactCount: 70,
    now: "2026-08-05T12:00:00.000Z",
  });
  assert.equal(next.lastHtmlSha256, "sha-novo");
  assert.equal(next.lastCycle, "2607-08");
  assert.equal(next.sentCount, 200); // inalterado — disparo ainda não confirmado
  // lastListId/lastCampaignId só avançam na confirmação, não no agendamento
  assert.equal(next.lastListId, 10);
  assert.equal(next.lastCampaignId, 20);
  assert.deepEqual(next.pendingSend, {
    campaignId: 120,
    listId: 106,
    scheduledAt: "2026-08-06T10:00:00-03:00",
    contactCount: 70,
  });
});

test("buildFinalizeScheduledState: 1ª rodada (prev null) -> sentCount 0, sem lastListId/lastCampaignId prévios", () => {
  const next = buildFinalizeScheduledState(null, {
    htmlSha256: "sha-1",
    cycle: "2607-08",
    listId: 106,
    campaignId: 120,
    scheduledAt: "2026-08-06T10:00:00-03:00",
    contactCount: 70,
    now: "2026-08-05T12:00:00.000Z",
  });
  assert.equal(next.sentCount, 0);
  assert.equal(next.lastListId, null);
  assert.equal(next.lastCampaignId, null);
});

test("buildFinalizeState (caso 'agendado→disparado' via confirmação manual): mesmo campaignId do pendingSend -> soma sentCount E limpa pendingSend", () => {
  const prev: NovosState = {
    lastRunAt: "2026-08-05T12:00:00.000Z",
    lastHtmlSha256: "sha-novo",
    lastCycle: "2607-08",
    lastListId: 10,
    lastCampaignId: 20,
    sentCount: 200,
    pendingSend: { campaignId: 120, listId: 106, scheduledAt: "2026-08-06T10:00:00-03:00", contactCount: 70 },
  };
  const next = buildFinalizeState(prev, {
    htmlSha256: "sha-novo",
    cycle: "2607-08",
    listId: 106,
    campaignId: 120,
    sentCountDelta: 70,
    now: "2026-08-06T11:00:00.000Z",
  });
  assert.equal(next.sentCount, 270); // 200 acumulado + 70 confirmados agora
  assert.equal(next.lastListId, 106);
  assert.equal(next.lastCampaignId, 120);
  assert.equal(next.pendingSend, null); // #4670: confirmação limpa o pendingSend correspondente
});

test("buildFinalizeState: campaignId NÃO bate com pendingSend de outra rodada -> soma sentCount mas preserva o pendingSend alheio", () => {
  // Rodada N agendou #120 (ainda não confirmada). Rodada N+1, imediata,
  // dispara e finaliza sua PRÓPRIA campanha #130 — não deve apagar o rastro
  // de #120, que continua pendente de confirmação separadamente.
  const prev: NovosState = {
    lastRunAt: "2026-08-05T12:00:00.000Z",
    lastHtmlSha256: "sha-novo",
    lastCycle: "2607-08",
    lastListId: 10,
    lastCampaignId: 20,
    sentCount: 200,
    pendingSend: { campaignId: 120, listId: 106, scheduledAt: "2026-08-06T10:00:00-03:00", contactCount: 70 },
  };
  const next = buildFinalizeState(prev, {
    htmlSha256: "sha-novo",
    cycle: "2607-08",
    listId: 107,
    campaignId: 130,
    sentCountDelta: 12,
    now: "2026-08-06T09:00:00.000Z",
  });
  assert.equal(next.sentCount, 212);
  assert.equal(next.lastCampaignId, 130);
  assert.deepEqual(next.pendingSend, { campaignId: 120, listId: 106, scheduledAt: "2026-08-06T10:00:00-03:00", contactCount: 70 });
});

test("buildFinalizeState (dupla finalização não conta 2×): finalizar 2 vezes com o mesmo campaignId/sentCount soma o delta 2×, mas cada chamada é o efeito de UM disparo real — a proteção contra dupla-contagem é o caller nunca reinvocar --finalize pra um disparo já confirmado (idempotência de invocação, não de estado)", () => {
  // A função em si é uma soma pura — o guard de "não conte 2×" é: depois da
  // 1ª finalização, pendingSend já está null, então uma 2ª finalização SEM
  // um pendingSend novo não tem o que "confirmar de novo" no fluxo normal da
  // skill (Passo 6 só chama --finalize uma vez por --send-now). Este teste
  // documenta que reconcilePendingSend (abaixo) É o guard real pro caminho
  // agendado: uma vez finalizado (finalized), pendingSend vira null e uma
  // 2ª chamada de reconcilePendingSend vira "no-pending" — não soma de novo.
  const afterFirst = buildFinalizeState(null, {
    htmlSha256: "sha-1",
    cycle: "2607-08",
    listId: 106,
    campaignId: 120,
    sentCountDelta: 70,
    now: "2026-08-06T11:00:00.000Z",
  });
  assert.equal(afterFirst.sentCount, 70);
  assert.equal(afterFirst.pendingSend, null);
});

test("reconcilePendingSend: sem pendingSend -> 'no-pending', state inalterado, fetchStatus NUNCA chamado", async () => {
  const prev: NovosState = {
    lastRunAt: "x",
    lastHtmlSha256: null,
    lastCycle: null,
    lastListId: null,
    lastCampaignId: null,
    sentCount: 0,
    pendingSend: null,
  };
  let calls = 0;
  const result = await reconcilePendingSend(prev, async () => {
    calls++;
    return { status: "sent" };
  });
  assert.equal(result.action, "no-pending");
  assert.deepEqual(result.state, prev);
  assert.equal(calls, 0);
});

test("reconcilePendingSend (caso 'agendado→disparado'): status sent -> finaliza, soma sentCount, promove listId/campaignId, limpa pendingSend", async () => {
  const prev: NovosState = {
    lastRunAt: "2026-08-05T12:00:00.000Z",
    lastHtmlSha256: "sha-agendado",
    lastCycle: "2607-08",
    lastListId: 10,
    lastCampaignId: 20,
    sentCount: 200,
    pendingSend: { campaignId: 120, listId: 106, scheduledAt: "2026-08-06T10:00:00-03:00", contactCount: 70 },
  };
  const result = await reconcilePendingSend(
    prev,
    async (campaignId) => {
      assert.equal(campaignId, 120);
      return { status: "sent" };
    },
    "2026-08-06T12:00:00.000Z",
  );
  assert.equal(result.action, "finalized");
  assert.equal(result.state.sentCount, 270);
  assert.equal(result.state.lastListId, 106);
  assert.equal(result.state.lastCampaignId, 120);
  assert.equal(result.state.pendingSend, null);
});

test("reconcilePendingSend: status inProcess TAMBÉM confirma disparo (mesma semântica de isTerminalSendStatus)", async () => {
  const prev: NovosState = {
    lastRunAt: "x",
    lastHtmlSha256: null,
    lastCycle: null,
    lastListId: null,
    lastCampaignId: null,
    sentCount: 0,
    pendingSend: { campaignId: 5, listId: 1, scheduledAt: "2026-08-06T10:00:00-03:00", contactCount: 3 },
  };
  const result = await reconcilePendingSend(prev, async () => ({ status: "inProcess" }));
  assert.equal(result.action, "finalized");
  assert.equal(result.state.sentCount, 3);
});

test("reconcilePendingSend: status queued -> 'still-pending', state INALTERADO (não confirma, não cancela)", async () => {
  const prev: NovosState = {
    lastRunAt: "2026-08-05T12:00:00.000Z",
    lastHtmlSha256: "sha-agendado",
    lastCycle: "2607-08",
    lastListId: 10,
    lastCampaignId: 20,
    sentCount: 200,
    pendingSend: { campaignId: 120, listId: 106, scheduledAt: "2026-08-06T10:00:00-03:00", contactCount: 70 },
  };
  const result = await reconcilePendingSend(prev, async () => ({ status: "queued" }));
  assert.equal(result.action, "still-pending");
  assert.deepEqual(result.state, prev); // nada muda — nem sentCount, nem pendingSend
});

test("reconcilePendingSend: status scheduled -> 'still-pending' (Brevo reporta 'queued' OU 'scheduled' conforme versão/timing, mesma semântica de isSchedulableStatus/isScheduledStatus)", async () => {
  const prev: NovosState = {
    lastRunAt: "2026-08-05T12:00:00.000Z",
    lastHtmlSha256: "sha-agendado",
    lastCycle: "2607-08",
    lastListId: 10,
    lastCampaignId: 20,
    sentCount: 200,
    pendingSend: { campaignId: 120, listId: 106, scheduledAt: "2026-08-06T10:00:00-03:00", contactCount: 70 },
  };
  const result = await reconcilePendingSend(prev, async () => ({ status: "scheduled" }));
  assert.equal(result.action, "still-pending");
  assert.deepEqual(result.state, prev);
});

test("reconcilePendingSend: status in_review -> 'still-pending' (revisão de compliance/anti-abuso da Brevo, não-terminal, mesma semântica de describeUncertainSendStatus)", async () => {
  const prev: NovosState = {
    lastRunAt: "2026-08-05T12:00:00.000Z",
    lastHtmlSha256: "sha-agendado",
    lastCycle: "2607-08",
    lastListId: 10,
    lastCampaignId: 20,
    sentCount: 200,
    pendingSend: { campaignId: 120, listId: 106, scheduledAt: "2026-08-06T10:00:00-03:00", contactCount: 70 },
  };
  const result = await reconcilePendingSend(prev, async () => ({ status: "in_review" }));
  assert.equal(result.action, "still-pending");
  assert.deepEqual(result.state, prev);
});

test("reconcilePendingSend (caso 'agendado→cancelado'): status suspended -> 'cancelled', limpa pendingSend, sentCount NÃO incrementa", async () => {
  const prev: NovosState = {
    lastRunAt: "2026-08-05T12:00:00.000Z",
    lastHtmlSha256: "sha-agendado",
    lastCycle: "2607-08",
    lastListId: 10,
    lastCampaignId: 20,
    sentCount: 200,
    pendingSend: { campaignId: 120, listId: 106, scheduledAt: "2026-08-06T10:00:00-03:00", contactCount: 70 },
  };
  const result = await reconcilePendingSend(prev, async () => ({ status: "suspended" }));
  assert.equal(result.action, "cancelled");
  assert.equal(result.state.sentCount, 200); // NÃO incrementou
  assert.equal(result.state.pendingSend, null);
  assert.equal(result.state.lastCampaignId, 20); // NÃO promove o campaignId cancelado
});

test("reconcilePendingSend: status draft -> 'cancelled' (reversão manual pro rascunho — cancelamento CONHECIDO)", async () => {
  const prev: NovosState = {
    lastRunAt: "x",
    lastHtmlSha256: null,
    lastCycle: null,
    lastListId: null,
    lastCampaignId: null,
    sentCount: 0,
    pendingSend: { campaignId: 9, listId: 1, scheduledAt: "2026-08-06T10:00:00-03:00", contactCount: 1 },
  };
  const result = await reconcilePendingSend(prev, async () => ({ status: "draft" }));
  assert.equal(result.action, "cancelled");
  assert.equal(result.state.sentCount, 0);
  assert.equal(result.state.pendingSend, null);
});

test("reconcilePendingSend: status GENUINAMENTE desconhecido -> 'uncertain', state INALTERADO (nem soma sentCount, nem limpa pendingSend — não é conclusão que o código tem base pra tirar)", async () => {
  const prev: NovosState = {
    lastRunAt: "x",
    lastHtmlSha256: null,
    lastCycle: null,
    lastListId: null,
    lastCampaignId: null,
    sentCount: 0,
    pendingSend: { campaignId: 9, listId: 1, scheduledAt: "2026-08-06T10:00:00-03:00", contactCount: 1 },
  };
  const result = await reconcilePendingSend(prev, async () => ({ status: "someNewBrevoStatus" }));
  assert.equal(result.action, "uncertain");
  assert.equal(result.state.sentCount, 0);
  assert.notEqual(result.state.pendingSend, null);
  assert.deepEqual(result.state.pendingSend, prev.pendingSend);
});

test("reconcilePendingSend (dupla finalização não conta 2×): 2ª chamada após 'finalized' -> 'no-pending', sentCount NÃO soma de novo", async () => {
  const prev: NovosState = {
    lastRunAt: "2026-08-05T12:00:00.000Z",
    lastHtmlSha256: "sha-agendado",
    lastCycle: "2607-08",
    lastListId: 10,
    lastCampaignId: 20,
    sentCount: 200,
    pendingSend: { campaignId: 120, listId: 106, scheduledAt: "2026-08-06T10:00:00-03:00", contactCount: 70 },
  };
  const first = await reconcilePendingSend(prev, async () => ({ status: "sent" }));
  assert.equal(first.action, "finalized");
  assert.equal(first.state.sentCount, 270);

  // Simula uma 2ª invocação da skill/reconciliação sobre o state JÁ finalizado
  // (pendingSend agora é null) — nunca deve re-somar os mesmos 70 contatos.
  const second = await reconcilePendingSend(first.state, async () => ({ status: "sent" }));
  assert.equal(second.action, "no-pending");
  assert.equal(second.state.sentCount, 270); // inalterado — não somou de novo
});

// ---------------------------------------------------------------------------
// reconcileNovosSentCount (#4788) — reconciliação de sentCount contra a soma
// real das campanhas novos-* na Brevo. Caso real da issue: state gravava 350,
// as 5 campanhas novos-* realmente enviadas somavam 440 (90 de diferença,
// nunca detectados porque nada comparava os dois lados).
//
// Fixtures usam o nome REAL de campanha (`Clarice {yymm} grupo:{key}`,
// `campaignNameFor` em `clarice-schedule-group.ts`), NUNCA a key isolada
// (`novos-{AAMMDD}`) — os testes originais deste bloco usavam a key como se
// fosse o nome (`{ name: "novos-260731", ... }`) e por isso não pegaram o bug
// de `c.name.startsWith(NOVOS_CAMPAIGN_NAME_PREFIX)` nunca casar com um nome
// real. Ver `groupKeyFromCampaignName` em `scripts/lib/clarice-wave-plan.ts`.
// ---------------------------------------------------------------------------

test("reconcileNovosSentCount: reproduz o caso real #4788 — 350 gravado vs 440 real -> matches=false, detail nomeia a diferença", () => {
  const campaigns: NovosCampaignSentCount[] = [
    { name: "Clarice 2607 grupo:novos-260731", sent: 164 },
    { name: "Clarice 2608 grupo:novos-260805", sent: 75 },
    { name: "Clarice 2608 grupo:novos-260806", sent: 88 },
    { name: "Clarice 2608 grupo:novos-260807", sent: 57 },
    { name: "Clarice 2608 grupo:novos-260808", sent: 56 },
  ];
  const result = reconcileNovosSentCount(350, campaigns);
  assert.equal(result.actual, 440);
  assert.equal(result.expected, 350);
  assert.equal(result.matchedCampaigns, 5);
  assert.equal(result.matches, false);
  assert.ok(/DIVERGE/.test(result.detail));
  assert.ok(/440/.test(result.detail));
  assert.ok(/90/.test(result.detail)); // diferença nomeada, não só os dois totais
});

test("reconcileNovosSentCount: soma bate -> matches=true, detail com ✓", () => {
  const campaigns: NovosCampaignSentCount[] = [
    { name: "Clarice 2608 grupo:novos-260805", sent: 75 },
    { name: "Clarice 2608 grupo:novos-260806", sent: 88 },
  ];
  const result = reconcileNovosSentCount(163, campaigns);
  assert.equal(result.actual, 163);
  assert.equal(result.matches, true);
  assert.ok(/✓/.test(result.detail));
});

test("reconcileNovosSentCount: actual < expected (diferença negativa) -> matches=false, diferença nomeada com sinal", () => {
  const campaigns: NovosCampaignSentCount[] = [{ name: "Clarice 2608 grupo:novos-260805", sent: 40 }];
  const result = reconcileNovosSentCount(75, campaigns);
  assert.equal(result.actual, 40);
  assert.equal(result.expected, 75);
  assert.equal(result.matches, false);
  assert.ok(/DIVERGE/.test(result.detail));
  assert.ok(/-35/.test(result.detail)); // actual - expected = 40 - 75 = -35
});

test("reconcileNovosSentCount: ignora campanhas de OUTROS grupos (key com outro prefixo)", () => {
  const campaigns: NovosCampaignSentCount[] = [
    { name: "Clarice 2608 grupo:novos-260805", sent: 75 },
    { name: "Clarice 2607 grupo:ramp-warm-T1-W3", sent: 9999 }, // outro grupo — não deve entrar na soma
    { name: "Clarice News 2607 envio 8B", sent: 6687 }, // digest mensal, sem "grupo:" — idem
  ];
  const result = reconcileNovosSentCount(75, campaigns);
  assert.equal(result.matchedCampaigns, 1);
  assert.equal(result.actual, 75);
  assert.equal(result.matches, true);
});

test("reconcileNovosSentCount: nenhuma campanha novos-* ainda (1ª rodada) -> actual=0, compara contra expected=0", () => {
  const result = reconcileNovosSentCount(0, []);
  assert.equal(result.matchedCampaigns, 0);
  assert.equal(result.actual, 0);
  assert.equal(result.matches, true);
});
