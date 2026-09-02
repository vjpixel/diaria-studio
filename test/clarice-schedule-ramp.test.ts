import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseVolumesArg,
  sliceIntoVolumes,
  parseExtraEmailArg,
  buildRampCsv,
  buildRampManifest,
  creditCoversPlan,
  parseDatesArg,
  scheduledAtFromDate,
  assertDatesFuture,
  assertHtmlHasUnsubscribeLink,
  deriveRampVolumes,
  pollUntilCount,
  DAY_LABELS,
  resolveDashboardLimit,
  warnIfLimitExceedsWorkerClamp,
  DEFAULT_DASHBOARD_LIMIT,
  DASHBOARD_WORKER_CLAMP,
  shouldSkipImport,
  hasPassedImportPhase,
  WAVE_STATUS_ORDER,
  resolveImportStatus,
  assertImportUsable,
  buildImportFileBody,
  checkAllCampaignsCreated,
  runScheduleLoop,
  fetchPostmasterSpamEntry,
  extractDashboardStaleInfo,
  describeSpamSignalLine,
  assertScheduleLeadTimeForWave,
  type CampaignEntryLike,
} from "../scripts/clarice-schedule-ramp.ts";
import { EDITOR_COPY_EMAIL } from "../scripts/lib/editor-copy.ts";
import { resolveSpamSignal } from "../workers/brevo-dashboard/src/thresholds.ts";
import type { BrevoCampaign } from "../workers/brevo-dashboard/src/types.ts";

/**
 * #3593 — script committed fim-a-fim pra agendar os envios ramp-warm da
 * Clarice via Brevo API. Testes cobrem os helpers PUROS/testáveis (mesmo
 * padrão de clarice-schedule-sends.test.ts/clarice-schedule-group.test.ts —
 * main() não é testado diretamente pois faz chamadas de rede reais; ver
 * docstring do topo do script e o guard de publicação do #633).
 */

describe("parseVolumesArg (#3593 — mesma validação de weekly-send-plan-audience.ts)", () => {
  it("3 inteiros válidos", () => {
    assert.deepEqual(parseVolumesArg("7000,7500,8000"), [7000, 7500, 8000]);
  });

  it("rejeita contagem != 3, não-inteiros, <=0, ausente", () => {
    assert.equal(parseVolumesArg("7000,7500"), null);
    assert.equal(parseVolumesArg("7000,7500,8000,9000"), null);
    assert.equal(parseVolumesArg("7000,abc,8000"), null);
    assert.equal(parseVolumesArg("7000,-1,8000"), null);
    assert.equal(parseVolumesArg("7000,7500.5,8000"), null);
    assert.equal(parseVolumesArg(undefined), null);
  });
});

describe("sliceIntoVolumes", () => {
  it("respeita a ordem e os tamanhos pedidos", () => {
    const ordered = Array.from({ length: 10 }, (_, i) => i);
    assert.deepEqual(sliceIntoVolumes(ordered, [3, 4, 2]), [[0, 1, 2], [3, 4, 5, 6], [7, 8]]);
  });

  it("audiência menor que o pedido: últimos grupos ficam menores/vazios", () => {
    const ordered = [0, 1, 2, 3];
    assert.deepEqual(sliceIntoVolumes(ordered, [3, 3, 3]), [[0, 1, 2], [3], []]);
  });
});

describe("parseExtraEmailArg (#3593 item 2 — --extra-email)", () => {
  it("ausente → array vazio", () => {
    assert.deepEqual(parseExtraEmailArg(undefined), []);
  });

  it("1 email → array de 1", () => {
    assert.deepEqual(parseExtraEmailArg("a@b.com"), ["a@b.com"]);
  });

  it("múltiplos emails separados por vírgula, com espaços → trim aplicado", () => {
    assert.deepEqual(parseExtraEmailArg("a@b.com, c@d.com , e@f.com"), ["a@b.com", "c@d.com", "e@f.com"]);
  });

  it("entradas sem formato de email são descartadas (não quebra o import)", () => {
    assert.deepEqual(parseExtraEmailArg("a@b.com,not-an-email,"), ["a@b.com"]);
  });

  it("#self-review: deduplica case-insensitive (mantém a 1ª grafia) — evita drift entre entry.count e o CSV real", () => {
    assert.deepEqual(parseExtraEmailArg("A@b.com,a@B.com,a@b.com"), ["A@b.com"]);
  });
});

describe("buildRampCsv (#3593 item 2 — CSV disjunto por wave + extra-email anexado)", () => {
  it("monta CSV email,NOME a partir das linhas reais", () => {
    const csv = buildRampCsv([
      { email: "ana@x.com", name: "Ana Costa" },
      { email: "bia@x.com", name: null },
    ]);
    assert.ok(csv.includes("email,NOME"));
    assert.ok(csv.includes("ana@x.com,Ana"));
    assert.ok(csv.includes("bia@x.com,"));
  });

  it("anexa extra-email(s) no fim", () => {
    const csv = buildRampCsv([{ email: "ana@x.com", name: "Ana" }], ["editor@x.com"]);
    assert.ok(csv.includes("editor@x.com"));
  });

  it("NÃO duplica extra-email já presente na audiência real (dedup case-insensitive)", () => {
    const csv = buildRampCsv([{ email: "Ana@X.com", name: "Ana" }], ["ana@x.com"]);
    const occurrences = csv.split(/\r?\n/).filter((l) => l.toLowerCase().startsWith("ana@x.com")).length;
    assert.equal(occurrences, 1, `esperado 1 ocorrência, csv:\n${csv}`);
  });

  it("NÃO duplica extra-emails repetidos entre si", () => {
    const csv = buildRampCsv([], ["editor@x.com", "editor@x.com", "EDITOR@x.com"]);
    const occurrences = csv.split(/\r?\n/).filter((l) => l.toLowerCase().startsWith("editor@x.com")).length;
    assert.equal(occurrences, 1, `esperado 1 ocorrência, csv:\n${csv}`);
  });

  it("audiência vazia + sem extras → só o header", () => {
    const csv = buildRampCsv([]);
    assert.equal(csv.trim(), "email,NOME");
  });

  it("nome com replacement character (U+FFFD) sai sanitizado do CSV (#5200 — firstName compartilhado de lib/clarice-name.ts)", () => {
    const csv = buildRampCsv([{ email: "a13962@aecampo.pt", name: "Gon�alo Soares" }]);
    assert.ok(csv.includes("a13962@aecampo.pt,Gonalo"), `esperado NOME sanitizado, csv:\n${csv}`);
    assert.ok(!csv.includes("�"));
  });
});

describe("buildRampManifest (#3593 — mesmo shape de WaveDef lido por clarice-import-waves.ts)", () => {
  it("3 volumes → 3 entradas com key/file/desc determinísticos", () => {
    const manifest = buildRampManifest([7000, 7500, 8000]);
    assert.equal(manifest.length, 3);
    assert.deepEqual(manifest.map((m) => m.key), ["w1", "w2", "w3"]);
    assert.deepEqual(manifest.map((m) => m.file), ["w1-ter.csv", "w2-sex.csv", "w3-dom.csv"]);
    assert.ok(manifest[0].desc.includes("ter"));
  });

  it("--days customizado propaga pro nome do arquivo/desc", () => {
    const manifest = buildRampManifest([1, 2, 3], ["seg", "qua", "sab"]);
    assert.deepEqual(manifest.map((m) => m.file), ["w1-seg.csv", "w2-qua.csv", "w3-sab.csv"]);
  });

  it("DAY_LABELS default é ter/sex/dom (memória #260716 — cadência real usada)", () => {
    assert.deepEqual(DAY_LABELS, ["ter", "sex", "dom"]);
  });
});

describe("creditCoversPlan (#3593 — guard obrigatório ANTES de qualquer escrita)", () => {
  it("total menor que crédito → cobre", () => {
    assert.equal(creditCoversPlan(20000, 30000), true);
  });

  it("total igual ao crédito → cobre (limite inclusivo)", () => {
    assert.equal(creditCoversPlan(30000, 30000), true);
  });

  it("total maior que crédito → NÃO cobre", () => {
    assert.equal(creditCoversPlan(30001, 30000), false);
  });
});

describe("parseDatesArg (#3593 — datas EXPLÍCITAS, nunca inferidas de weekday)", () => {
  it("3 datas ISO crescentes válidas", () => {
    assert.deepEqual(parseDatesArg("2026-07-18,2026-07-21,2026-07-23", 3), ["2026-07-18", "2026-07-21", "2026-07-23"]);
  });

  it("trim de espaços ao redor das vírgulas", () => {
    assert.deepEqual(parseDatesArg("2026-07-18, 2026-07-21 ,2026-07-23", 3), ["2026-07-18", "2026-07-21", "2026-07-23"]);
  });

  it("contagem errada → null", () => {
    assert.equal(parseDatesArg("2026-07-18,2026-07-21", 3), null);
    assert.equal(parseDatesArg("2026-07-18,2026-07-21,2026-07-23,2026-07-25", 3), null);
  });

  it("formato inválido (não YYYY-MM-DD) → null", () => {
    assert.equal(parseDatesArg("18/07/2026,21/07/2026,23/07/2026", 3), null);
    assert.equal(parseDatesArg("2026-13-01,2026-07-21,2026-07-23", 3), null, "mês 13 é inválido");
  });

  it("datas NÃO estritamente crescentes → null (ordem importa, evita agendar fora de sequência)", () => {
    assert.equal(parseDatesArg("2026-07-21,2026-07-18,2026-07-23", 3), null);
    assert.equal(parseDatesArg("2026-07-18,2026-07-18,2026-07-23", 3), null, "datas iguais também rejeitadas");
  });

  it("ausente → null", () => {
    assert.equal(parseDatesArg(undefined, 3), null);
  });
});

describe("scheduledAtFromDate (#3593 — 06:00 BRT = 09:00 UTC, sem DST no Brasil desde 2019)", () => {
  it("converte YYYY-MM-DD pra ISO 09:00 UTC", () => {
    assert.equal(scheduledAtFromDate("2026-07-18"), "2026-07-18T09:00:00.000Z");
  });

  it("data inválida lança erro claro", () => {
    assert.throws(() => scheduledAtFromDate("18/07/2026"), /data inválida/);
  });
});

describe("assertDatesFuture (#2101 — guard simétrico ao de clarice-schedule-sends.ts)", () => {
  it("não lança quando todas as datas são futuras", () => {
    const now = new Date("2026-07-01T00:00:00Z");
    assert.doesNotThrow(() => assertDatesFuture(["2026-07-18T09:00:00.000Z", "2026-07-21T09:00:00.000Z"], now));
  });

  it("lança quando qualquer data é passada/presente", () => {
    const now = new Date("2026-07-20T00:00:00Z");
    assert.throws(
      () => assertDatesFuture(["2026-07-18T09:00:00.000Z", "2026-07-21T09:00:00.000Z"], now),
      /passado ou presente/,
    );
  });

  it("lança quando a data é EXATAMENTE agora (<=, não <)", () => {
    const now = new Date("2026-07-18T09:00:00.000Z");
    assert.throws(() => assertDatesFuture(["2026-07-18T09:00:00.000Z"], now), /passado ou presente/);
  });
});

describe("assertScheduleLeadTimeForWave (#7047 — camada NOVA além de assertDatesFuture: antecedência mínima)", () => {
  // #7047: clarice-schedule-ramp.ts é o de MAIOR blast radius dos 3 scripts
  // corrigidos por esta issue (dezenas de milhares de contatos por onda) —
  // antes desta issue só recusava passado/presente (assertDatesFuture acima),
  // exatamente o estado em que clarice-schedule-group.ts estava antes do
  // incidente de 01/09/2026 (campanhas #208/209/210 destinadas ao dia
  // seguinte saindo no mesmo dia).
  const NOW = new Date("2026-09-01T14:00:00.000Z");

  it("REGRESSÃO #7047: antecedência insuficiente (30s) lança, prefixado com a identidade da wave", () => {
    const raw = new Date(NOW.getTime() + 30_000).toISOString();
    assert.throws(
      () => assertScheduleLeadTimeForWave("d1-qua01", raw, { now: NOW }),
      /d1-qua01: .*antecedência mínima/is,
    );
  });

  it("antecedência suficiente (2h) não lança", () => {
    const raw = new Date(NOW.getTime() + 2 * 3600_000).toISOString();
    assert.doesNotThrow(() => assertScheduleLeadTimeForWave("d1-qua01", raw, { now: NOW }));
  });

  it("allowImminent=true permite antecedência insuficiente", () => {
    const raw = new Date(NOW.getTime() + 30_000).toISOString();
    assert.doesNotThrow(() => assertScheduleLeadTimeForWave("d1-qua01", raw, { now: NOW, allowImminent: true }));
  });

  it("horário fora do canônico (09:00 UTC = 06:00 BRT) avisa via logFn sem lançar", () => {
    const raw = "2026-09-02T17:00:00.000Z";
    const calls: string[] = [];
    assertScheduleLeadTimeForWave("d1-qua01", raw, { now: NOW }, (m) => calls.push(m));
    assert.equal(calls.length, 1);
    assert.match(calls[0], /fora do horário canônico/i);
    assert.match(calls[0], /09:00 UTC/);
    assert.match(calls[0], /06:00 BRT/);
  });
});

describe("assertHtmlHasUnsubscribeLink (#3593 — guard legal ANTES de qualquer POST /emailCampaigns)", () => {
  const validHtml = `<html><body>${"x".repeat(300)}<a href="{{ unsubscribe }}">descadastrar</a></body></html>`;

  it("HTML com a merge tag {{ unsubscribe }} → não lança", () => {
    assert.doesNotThrow(() => assertHtmlHasUnsubscribeLink(validHtml));
  });

  it("aceita variação de espaçamento {{unsubscribe}} / {{  unsubscribe  }}", () => {
    const noSpace = `<html><body>${"x".repeat(300)}<a href="{{unsubscribe}}">x</a></body></html>`;
    assert.doesNotThrow(() => assertHtmlHasUnsubscribeLink(noSpace));
  });

  it("HTML sem a merge tag → lança (risco legal)", () => {
    const html = `<html><body>${"x".repeat(300)}<p>Conteúdo sem link de descadastro.</p></body></html>`;
    assert.throws(() => assertHtmlHasUnsubscribeLink(html), /descadastro|unsubscribe/);
  });

  it("HTML suspeito demais (curto) → lança antes mesmo de checar a merge tag", () => {
    assert.throws(() => assertHtmlHasUnsubscribeLink("<p>{{ unsubscribe }}</p>"), /suspeito demais/);
  });
});

describe("pollUntilCount (#3593 item 3 — poll de import assíncrono, sleep injetável)", () => {
  it("bate a contagem esperada na 1ª tentativa → não dorme", async () => {
    const sleeps: number[] = [];
    const result = await pollUntilCount(async () => 100, 100, { sleepFn: async (ms) => { sleeps.push(ms); } });
    assert.deepEqual(result, { matched: true, finalCount: 100, attempts: 1 });
    assert.equal(sleeps.length, 0);
  });

  it("bate a contagem só na 3ª tentativa → 2 sleeps, matched=true", async () => {
    let calls = 0;
    const counts = [10, 60, 100];
    const sleeps: number[] = [];
    const result = await pollUntilCount(
      async () => counts[calls++],
      100,
      { maxAttempts: 5, delayMs: 500, sleepFn: async (ms) => { sleeps.push(ms); } },
    );
    assert.deepEqual(result, { matched: true, finalCount: 100, attempts: 3 });
    assert.deepEqual(sleeps, [500, 500]);
  });

  it("esgota tentativas sem bater a contagem → matched=false, finalCount = última observada", async () => {
    const result = await pollUntilCount(async () => 42, 100, { maxAttempts: 3, sleepFn: async () => {} });
    assert.deepEqual(result, { matched: false, finalCount: 42, attempts: 3 });
  });
});

describe("deriveRampVolumes (#3593 item 1 — recomputa volumes via a MESMA lógica pura do worker)", () => {
  function campaign(overrides: Partial<BrevoCampaign> & { id: number }): BrevoCampaign {
    return {
      name: `cold 2606-07 — ${overrides.id}`,
      subject: "x",
      status: "sent",
      sentDate: null,
      scheduledAt: null,
      createdAt: "2026-07-01T00:00:00Z",
      recipients: { lists: [1] },
      statistics: {
        globalStats: {
          sent: 1000, delivered: 990, hardBounces: 2, softBounces: 1, uniqueViews: 300, viewed: 300,
          trackableViews: 300, uniqueClicks: 50, clickers: 40, unsubscriptions: 1, complaints: 0, appleMppOpens: 10,
        },
      },
      ...overrides,
    };
  }

  it("nenhum envio → erro claro", () => {
    const result = deriveRampVolumes([], new Date("2026-07-17T00:00:00Z"));
    assert.equal(result.ok, false);
    if (result.ok) throw new Error("unreachable");
    assert.match(result.reason, /Nenhum envio registrado/);
  });

  it("envio existe mas é imaturo (<48h) → erro claro pedindo espera", () => {
    const now = new Date("2026-07-17T00:00:00Z");
    const campaigns = [campaign({ id: 1, sentDate: "2026-07-16T20:00:00Z" })]; // 4h atrás
    const result = deriveRampVolumes(campaigns, now);
    assert.equal(result.ok, false);
    if (result.ok) throw new Error("unreachable");
    assert.match(result.reason, /maduro/);
  });

  // #4063: `decideSemaphore` não recebe mais leitura de Postmaster aqui (este
  // script não lê o KV `postmaster:spam` — isso vive só no Worker) —
  // `resolveSpamSignal(null)` é sempre "indeterminate", que nunca resolve pra
  // "green" (mesmo com `complaints` da Brevo em zero, que ANTES bastava pra
  // verde). O teto passou a ser "yellow" (mantém volume, nunca escalona às
  // cegas) até este script também consumir a leitura manual do Postmaster.
  it("envio maduro, saúde boa (sem leitura de Postmaster) → nunca verde (#4063), plano mantém o volume-base", () => {
    const now = new Date("2026-07-17T00:00:00Z");
    const campaigns = [campaign({ id: 1, sentDate: "2026-07-10T09:00:00Z" })]; // >48h
    const result = deriveRampVolumes(campaigns, now);
    assert.equal(result.ok, true);
    if (!result.ok) throw new Error("unreachable");
    assert.equal(result.plan.semaphore, "yellow");
    assert.equal(result.plan.baseVolume, 1000);
    assert.deepEqual(result.plan.volumes, [1000, 1000, 1000]);
    assert.equal(result.plan.flagged, false);
  });

  it("saúde ruim (vermelho) → plano flagged=true, volumes cortados", () => {
    const now = new Date("2026-07-17T00:00:00Z");
    const badStats = {
      sent: 1000, delivered: 900, hardBounces: 30, softBounces: 10, uniqueViews: 50, viewed: 50,
      trackableViews: 50, uniqueClicks: 5, clickers: 4, unsubscriptions: 40, complaints: 5, appleMppOpens: 0,
    };
    const campaigns = [campaign({ id: 1, sentDate: "2026-07-10T09:00:00Z", statistics: { globalStats: badStats } })];
    const result = deriveRampVolumes(campaigns, now);
    assert.equal(result.ok, true);
    if (!result.ok) throw new Error("unreachable");
    assert.equal(result.plan.semaphore, "red");
    assert.equal(result.plan.flagged, true);
    assert.ok(result.plan.volumes[0] < result.plan.baseVolume, "vermelho deve cortar o volume-base");
    // #5592: `breachedMetrics` nomeia QUAL(is) métrica(s) romperam — antes só
    // "semaphore: red" chegava até o texto do abort, sem dizer qual breaker.
    // Neste fixture: abertura baixa + bounce duro alto + unsub alto rompem;
    // bounce TOTAL (4%) fica abaixo do limiar (5%) e spam é indeterminado
    // (sem leitura de Postmaster) — nenhum dos dois deve aparecer.
    assert.ok(result.plan.breachedMetrics && result.plan.breachedMetrics.length > 0, "vermelho deve nomear ao menos 1 métrica rompida");
    const breaches = (result.plan.breachedMetrics ?? []).join(" | ");
    assert.match(breaches, /abertura/);
    assert.match(breaches, /bounce duro/);
    assert.match(breaches, /unsub/);
    assert.doesNotMatch(breaches, /bounce total/);
    assert.doesNotMatch(breaches, /spam/);
  });

  it("saúde ok (verde/amarelo) → breachedMetrics vazio (#5592)", () => {
    const now = new Date("2026-07-17T00:00:00Z");
    const campaigns = [campaign({ id: 1, sentDate: "2026-07-10T09:00:00Z" })]; // saúde boa, sem leitura Postmaster → "yellow" (#4063)
    const result = deriveRampVolumes(campaigns, now);
    assert.equal(result.ok, true);
    if (!result.ok) throw new Error("unreachable");
    assert.equal(result.plan.semaphore, "yellow");
    assert.deepEqual(result.plan.breachedMetrics, []);
  });

  // #4131 finding 4: com uma leitura FRESCA e boa do Postmaster injetada
  // (fetchPostmasterSpamEntry), o semáforo agora PODE escalonar a verde de
  // novo — antes deste fix, `deriveRampVolumes` nunca recebia nenhum sinal e
  // ficava travado em "yellow" pra sempre (teste acima, sem 3º argumento).
  it("com leitura FRESCA e boa do Postmaster → semáforo pode escalonar a verde (#4131 finding 4)", () => {
    const now = new Date("2026-07-17T00:00:00Z");
    const campaigns = [campaign({ id: 1, sentDate: "2026-07-10T09:00:00Z" })]; // saúde boa, ver teste acima
    // #4541: `date` (medição) precisa estar dentro de POSTMASTER_DATA_STALE_MS
    // também, não só `recordedAt` (gravação) — aqui, 1 dia-calendário antes de
    // `now`, bem dentro da folga de 5 dias.
    const freshEntry = { spamRatePct: 0.02, recordedAt: "2026-07-16T12:00:00Z", date: "2026-07-16" }; // 12h antes de `now`, bem dentro das 48h
    const result = deriveRampVolumes(campaigns, now, freshEntry);
    assert.equal(result.ok, true);
    if (!result.ok) throw new Error("unreachable");
    assert.equal(result.plan.semaphore, "green");
    assert.equal(result.plan.flagged, false);
  });

  it("leitura do Postmaster STALE (>48h de recordedAt) → permanece indeterminate, nunca verde (regressão #4063)", () => {
    const now = new Date("2026-07-17T00:00:00Z");
    const campaigns = [campaign({ id: 1, sentDate: "2026-07-10T09:00:00Z" })];
    const staleEntry = { spamRatePct: 0.02, recordedAt: "2026-07-01T00:00:00Z", date: "2026-07-01" }; // >48h antes de `now`
    const result = deriveRampVolumes(campaigns, now, staleEntry);
    assert.equal(result.ok, true);
    if (!result.ok) throw new Error("unreachable");
    assert.equal(result.plan.semaphore, "yellow");
  });

  // #4541: mesmo com `recordedAt` fresco (gravação recente), uma `date`
  // (medição) velha demais também degrada pra indeterminate — o bug real do
  // incidente 260803 que esta issue corrige.
  it("leitura do Postmaster com recordedAt FRESCO mas date STALE → permanece indeterminate, nunca verde (#4541)", () => {
    const now = new Date("2026-07-17T00:00:00Z");
    const campaigns = [campaign({ id: 1, sentDate: "2026-07-10T09:00:00Z" })];
    const staleDateEntry = { spamRatePct: 0.02, recordedAt: "2026-07-16T23:00:00Z", date: "2026-07-01" }; // recordedAt fresco, date de 16 dias atrás
    const result = deriveRampVolumes(campaigns, now, staleDateEntry);
    assert.equal(result.ok, true);
    if (!result.ok) throw new Error("unreachable");
    assert.equal(result.plan.semaphore, "yellow");
  });

  it("leitura do Postmaster AUSENTE (undefined/null) → permanece indeterminate, nunca verde (mesmo comportamento pré-#4131)", () => {
    const now = new Date("2026-07-17T00:00:00Z");
    const campaigns = [campaign({ id: 1, sentDate: "2026-07-10T09:00:00Z" })];
    for (const spamEntry of [null, undefined]) {
      const result = deriveRampVolumes(campaigns, now, spamEntry);
      assert.equal(result.ok, true);
      if (!result.ok) throw new Error("unreachable");
      assert.equal(result.plan.semaphore, "yellow");
    }
  });

  // #4705: cenário real da issue fim-a-fim através deste CLI (não só via
  // resolveSpamSignal isolado, testado em test/weekly-plan.test.ts) — a média
  // de domínio sozinha ficaria dentro do limite e deixaria o semáforo
  // escalonar a verde; o pico por campanha é o que revela o risco e trava o
  // semáforo em vermelho.
  it("worstCampaignSpamRatePct acima do limite trava o semáforo em vermelho MESMO com a média de domínio saudável (#4705)", () => {
    const now = new Date("2026-07-17T00:00:00Z");
    const campaigns = [campaign({ id: 1, sentDate: "2026-07-10T09:00:00Z" })]; // saúde boa nas outras métricas
    const entryWithCampaignPeak = {
      spamRatePct: 0.02, // média de domínio: dentro do limite (green)
      recordedAt: "2026-07-16T12:00:00Z",
      date: "2026-07-16",
      worstCampaignSpamRatePct: 1.39, // pico de uma campanha específica: bem acima do breaker
    };
    const result = deriveRampVolumes(campaigns, now, entryWithCampaignPeak);
    assert.equal(result.ok, true);
    if (!result.ok) throw new Error("unreachable");
    assert.equal(result.plan.semaphore, "red", "a média de domínio sozinha resolveria 'green' — só o pico por campanha revela o risco real");
    assert.equal(result.plan.flagged, true);
  });
});

describe("extractDashboardStaleInfo (#4543 — clarice-check-semaphore.ts/clarice-schedule-ramp.ts checavam só res.ok, ignoravam cache stale)", () => {
  it("header X-Dashboard-Stale presente -> extrai kind + upstreamStatus", () => {
    const res = new Response("[]", {
      status: 200,
      headers: { "X-Dashboard-Stale": "upstream-error", "X-Dashboard-Upstream-Status": "503" },
    });
    assert.deepEqual(extractDashboardStaleInfo(res), { kind: "upstream-error", upstreamStatus: "503" });
  });

  it("header X-Dashboard-Stale ausente -> undefined (resposta fresh não fica marcada)", () => {
    const res = new Response("[]", { status: 200 });
    assert.equal(extractDashboardStaleInfo(res), undefined);
  });

  it("X-Dashboard-Stale presente sem X-Dashboard-Upstream-Status -> upstreamStatus cai em 'unknown', nunca lança", () => {
    const res = new Response("[]", { status: 200, headers: { "X-Dashboard-Stale": "rate-limit" } });
    assert.deepEqual(extractDashboardStaleInfo(res), { kind: "rate-limit", upstreamStatus: "unknown" });
  });
});

describe("fetchPostmasterSpamEntry (#4131 finding 4 — leitura manual do Postmaster via /api/postmaster-spam)", () => {
  function fakeFetch(status: number, body: unknown): typeof fetch {
    return (async () =>
      new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })) as unknown as typeof fetch;
  }

  it("entry válida → retorna { date, spamRatePct, recordedAt }", async () => {
    const entry = await fetchPostmasterSpamEntry(
      "https://x",
      fakeFetch(200, { entry: { date: "2026-07-27", spamRatePct: 0.9, recordedAt: "2026-07-27T10:00:00.000Z" } }),
    );
    assert.deepEqual(entry, {
      date: "2026-07-27",
      spamRatePct: 0.9,
      recordedAt: "2026-07-27T10:00:00.000Z",
      producedBy: undefined,
      daysWithData: undefined,
      daysProbed: undefined,
      worstCampaignSpamRatePct: undefined,
      worstCampaignFeedbackLoopId: undefined,
      worstCampaignDaysWithData: undefined,
    });
  });

  // #4541: mesma classe de risco documentada acima pra producedBy — sem
  // repassar `date`/`daysWithData`/`daysProbed`, `resolveSpamSignal` (que
  // agora exige medição recente, não só gravação recente) trataria toda
  // leitura vinda deste script como indeterminate pra sempre.
  it("entry com date/daysWithData/daysProbed preserva os campos (#4541)", async () => {
    const entry = await fetchPostmasterSpamEntry(
      "https://x",
      fakeFetch(200, {
        entry: {
          date: "2026-07-27",
          spamRatePct: 0.9,
          recordedAt: "2026-07-27T10:00:00.000Z",
          daysWithData: 3,
          daysProbed: 10,
        },
      }),
    );
    assert.equal(entry?.date, "2026-07-27");
    assert.equal(entry?.daysWithData, 3);
    assert.equal(entry?.daysProbed, 10);
  });

  // #4154, achado do self-review do #4342 (3ª rodada): producedBy é uma 2ª
  // leitura da mesma info que normalizePostmasterSpamEntry já normaliza no
  // worker — sem repassar aqui, o CLI de agendamento da ramp nunca soube
  // distinguir leitura auto de manual.
  it("entry com producedBy 'auto'/'manual' preserva o campo", async () => {
    const auto = await fetchPostmasterSpamEntry(
      "https://x",
      fakeFetch(200, { entry: { date: "2026-07-27", spamRatePct: 0.9, recordedAt: "2026-07-27T10:00:00.000Z", producedBy: "auto" } }),
    );
    assert.equal(auto?.producedBy, "auto");

    const manual = await fetchPostmasterSpamEntry(
      "https://x",
      fakeFetch(200, { entry: { date: "2026-07-27", spamRatePct: 0.9, recordedAt: "2026-07-27T10:00:00.000Z", producedBy: "manual" } }),
    );
    assert.equal(manual?.producedBy, "manual");
  });

  // #4705: mesma classe de risco documentada acima pra date/daysWithData/
  // daysProbed/producedBy — sem repassar worstCampaignSpamRatePct aqui, o CLI
  // de agendamento da ramp nunca veria o pico por campanha e resolveSpamSignal
  // cairia sempre no fallback de domínio pra este caminho.
  it("entry com worstCampaignSpamRatePct preserva o campo (#4705)", async () => {
    const entry = await fetchPostmasterSpamEntry(
      "https://x",
      fakeFetch(200, {
        entry: {
          date: "2026-08-03",
          spamRatePct: 0.08,
          recordedAt: "2026-08-06T09:00:00.000Z",
          worstCampaignSpamRatePct: 1.39,
        },
      }),
    );
    assert.equal(entry?.worstCampaignSpamRatePct, 1.39);
  });

  it("worstCampaignSpamRatePct ausente ou não-numérico vira undefined, nunca inferido (#4705)", async () => {
    const missing = await fetchPostmasterSpamEntry(
      "https://x",
      fakeFetch(200, { entry: { date: "2026-08-03", spamRatePct: 0.08, recordedAt: "2026-08-06T09:00:00.000Z" } }),
    );
    assert.equal(missing?.worstCampaignSpamRatePct, undefined);

    const corrupted = await fetchPostmasterSpamEntry(
      "https://x",
      fakeFetch(200, {
        entry: {
          date: "2026-08-03",
          spamRatePct: 0.08,
          recordedAt: "2026-08-06T09:00:00.000Z",
          worstCampaignSpamRatePct: "não é número",
        },
      }),
    );
    assert.equal(corrupted?.worstCampaignSpamRatePct, undefined);
  });

  // #4780 item 3: mesma classe de risco do #4705 acima — sem repassar estes
  // 2 campos aqui, o CLI de agendamento da ramp nunca teria como imprimir
  // QUAL campanha decidiu o semáforo nem a cobertura do pico.
  it("entry com worstCampaignFeedbackLoopId/worstCampaignDaysWithData preserva os 2 campos (#4780)", async () => {
    const entry = await fetchPostmasterSpamEntry(
      "https://x",
      fakeFetch(200, {
        entry: {
          date: "2026-08-03",
          spamRatePct: 0.08,
          recordedAt: "2026-08-06T09:00:00.000Z",
          worstCampaignSpamRatePct: 1.39,
          worstCampaignFeedbackLoopId: "11130585_107",
          worstCampaignDaysWithData: 3,
        },
      }),
    );
    assert.equal(entry?.worstCampaignFeedbackLoopId, "11130585_107");
    assert.equal(entry?.worstCampaignDaysWithData, 3);
  });

  it("worstCampaignFeedbackLoopId/worstCampaignDaysWithData ausentes ou corrompidos viram undefined, nunca inferidos (#4780)", async () => {
    const missing = await fetchPostmasterSpamEntry(
      "https://x",
      fakeFetch(200, { entry: { date: "2026-08-03", spamRatePct: 0.08, recordedAt: "2026-08-06T09:00:00.000Z" } }),
    );
    assert.equal(missing?.worstCampaignFeedbackLoopId, undefined);
    assert.equal(missing?.worstCampaignDaysWithData, undefined);

    const corrupted = await fetchPostmasterSpamEntry(
      "https://x",
      fakeFetch(200, {
        entry: {
          date: "2026-08-03",
          spamRatePct: 0.08,
          recordedAt: "2026-08-06T09:00:00.000Z",
          worstCampaignFeedbackLoopId: 107,
          worstCampaignDaysWithData: "três",
        },
      }),
    );
    assert.equal(corrupted?.worstCampaignFeedbackLoopId, undefined);
    assert.equal(corrupted?.worstCampaignDaysWithData, undefined);
  });

  it("entry null (sem leitura registrada) → null", async () => {
    const entry = await fetchPostmasterSpamEntry("https://x", fakeFetch(200, { entry: null }));
    assert.equal(entry, null);
  });

  it("HTTP não-ok → null (fail-soft)", async () => {
    const entry = await fetchPostmasterSpamEntry("https://x", fakeFetch(500, { error: "boom" }));
    assert.equal(entry, null);
  });

  it("fetch lança (rede offline) → null (fail-soft, nunca propaga)", async () => {
    const throwingFetch = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    const entry = await fetchPostmasterSpamEntry("https://x", throwingFetch);
    assert.equal(entry, null);
  });

  it("shape inesperado (spamRatePct não-numérico) → null", async () => {
    const entry = await fetchPostmasterSpamEntry(
      "https://x",
      fakeFetch(200, { entry: { spamRatePct: "não é número", recordedAt: "2026-07-27T10:00:00.000Z" } }),
    );
    assert.equal(entry, null);
  });
});

// -----------------------------------------------------------------------------
// #3643 — 4 bugs de data-integrity + 2 achados menores no --import/--schedule
// -----------------------------------------------------------------------------

describe("resolveDashboardLimit (#3643 minor 2 — falsy-zero de `Number(raw) || fallback`)", () => {
  it("--dashboard-limit ausente → fallback", () => {
    assert.equal(resolveDashboardLimit(undefined, 80), 80);
  });

  it("BUG ORIGINAL: --dashboard-limit 0 explícito era descartado por `|| fallback` — agora é respeitado", () => {
    assert.equal(resolveDashboardLimit("0", 80), 0);
  });

  it("valor numérico normal é respeitado", () => {
    assert.equal(resolveDashboardLimit("30", 80), 30);
  });

  it("valor não-numérico cai no fallback", () => {
    assert.equal(resolveDashboardLimit("abc", 80), 80);
  });

  // #4568: `getArg` devolve "" quando a flag NÃO foi passada (nunca undefined),
  // e o `Number("") === 0` daqui virava `?limit=0` — que o Worker responde com
  // 502. O guard D4 do semáforo abortava toda invocação padrão sem nunca
  // avaliar entregabilidade.
  it("string VAZIA é 'flag ausente', não 'limite zero' (regressão #4568)", () => {
    assert.equal(resolveDashboardLimit("", 80), 80);
    assert.equal(resolveDashboardLimit("   ", 80), 80);
  });

  it("o `0` EXPLÍCITO segue preservado — o fix do #4568 não desfaz o do #3643", () => {
    assert.equal(resolveDashboardLimit("0", 80), 0);
  });
});

describe("warnIfLimitExceedsWorkerClamp (#3643 minor 1 — Worker clampa em 50 sem avisar)", () => {
  it("limit dentro do clamp → sem warning", () => {
    assert.equal(warnIfLimitExceedsWorkerClamp(50, 50), null);
    assert.equal(warnIfLimitExceedsWorkerClamp(10, 50), null);
  });

  it("limit acima do clamp → warning explícito", () => {
    const msg = warnIfLimitExceedsWorkerClamp(80, 50);
    assert.ok(msg, "esperava warning");
    assert.match(msg!, /80/);
    assert.match(msg!, /50/);
  });

  it("DEFAULT_DASHBOARD_LIMIT agora reflete o clamp real do Worker (era 80, morto/enganoso)", () => {
    assert.equal(DEFAULT_DASHBOARD_LIMIT, DASHBOARD_WORKER_CLAMP);
    assert.equal(warnIfLimitExceedsWorkerClamp(DEFAULT_DASHBOARD_LIMIT), null);
  });
});

describe("shouldSkipImport (#3643 bug 1 — retry-skip gatava em listId, não em conclusão)", () => {
  it("status \"imported\" (confirmado) → pula em retry", () => {
    assert.equal(shouldSkipImport({ status: "imported" }), true);
  });

  it("BUG ORIGINAL: status \"planned\" com listId já setado (import ainda não tentado/falhou) — agora NÃO pula", () => {
    // Antes: skip-check gatava em `entry.listId !== undefined`, que é gravado
    // ANTES do /contacts/import ser tentado — uma wave cujo import falhasse
    // (rede, 5xx) ficava PERMANENTEMENTE pulada em retries futuros.
    assert.equal(shouldSkipImport({ status: "planned" }), false);
  });

  it("status \"list_created\" (lista criada, import não confirmado) → NÃO pula, permite retomar", () => {
    assert.equal(shouldSkipImport({ status: "list_created" }), false);
  });

  it("status \"import_incomplete\" (poll não bateu) → NÃO pula, permite re-tentar", () => {
    assert.equal(shouldSkipImport({ status: "import_incomplete" }), false);
  });

  it("BUG #3652: status \"draft\" (pós --create) — antes só reconhecia o literal \"imported\" e clobbrava; agora pula", () => {
    assert.equal(shouldSkipImport({ status: "draft" }), true);
  });

  it("BUG #3652: status \"scheduled\" (pós --schedule) — antes só reconhecia o literal \"imported\" e clobbrava; agora pula", () => {
    assert.equal(shouldSkipImport({ status: "scheduled" }), true);
  });
});

describe("hasPassedImportPhase / WAVE_STATUS_ORDER (#3652 bug 1 — check reusável, não literal espalhado)", () => {
  it("ordem do ciclo de vida: import_incomplete fica ANTES de imported (retryable, não é progresso)", () => {
    assert.ok(WAVE_STATUS_ORDER.indexOf("import_incomplete") < WAVE_STATUS_ORDER.indexOf("imported"));
  });

  it("imported/draft/scheduled → true (já passou da fase de import)", () => {
    assert.equal(hasPassedImportPhase("imported"), true);
    assert.equal(hasPassedImportPhase("draft"), true);
    assert.equal(hasPassedImportPhase("scheduled"), true);
  });

  it("planned/list_created/import_incomplete → false (ainda não passou, ou não confirmou)", () => {
    assert.equal(hasPassedImportPhase("planned"), false);
    assert.equal(hasPassedImportPhase("list_created"), false);
    assert.equal(hasPassedImportPhase("import_incomplete"), false);
  });

  it("#self-review: --import não clobbra draft/scheduled — a entry nem chega no código que sobrescreveria status, porque shouldSkipImport (que delega pra hasPassedImportPhase) já a pula com `continue` antes de qualquer POST/atribuição de status (ver scripts/clarice-schedule-ramp.ts main(), bloco --import)", () => {
    // Prova indireta: simula a decisão que o loop de --import toma pra uma
    // wave já avançada — se shouldSkipImport(entry) é true, o loop faz
    // `continue` e `entry.status` nunca é reatribuído nesta invocação.
    const entry = { key: "w1", status: "scheduled" as const, listId: 42, count: 100 };
    const originalStatus = entry.status;
    if (shouldSkipImport(entry)) {
      // no-op — é exatamente o que o loop real faz: pula sem tocar em entry.status
    } else {
      (entry as { status: string }).status = "imported"; // simula o clobber do bug original
    }
    assert.equal(entry.status, originalStatus, "status não deveria ter sido tocado");
  });
});

describe("resolveImportStatus (#3643 bug 2 — status \"imported\" era setado mesmo com poll.matched=false)", () => {
  it("poll bateu (matched=true) → \"imported\"", () => {
    assert.equal(resolveImportStatus(true, false), "imported");
  });

  it("BUG ORIGINAL: poll NÃO bateu (matched=false) — antes virava \"imported\" incondicionalmente, agora \"import_incomplete\"", () => {
    assert.equal(resolveImportStatus(false, false), "import_incomplete");
  });

  it("--skip-verify ativo (decisão explícita do operador) → \"imported\" mesmo sem poll", () => {
    assert.equal(resolveImportStatus(false, true), "imported");
    assert.equal(resolveImportStatus(true, true), "imported");
  });
});

describe("assertImportUsable (#3643 bug 2 — --create/--schedule recusam prosseguir com import incompleto sem --force)", () => {
  it("status \"imported\" → não lança (com ou sem --force)", () => {
    assert.doesNotThrow(() => assertImportUsable({ key: "w1", status: "imported", count: 100, importedCount: 100 }, false));
    assert.doesNotThrow(() => assertImportUsable({ key: "w1", status: "imported", count: 100, importedCount: 100 }, true));
  });

  it("BUG ORIGINAL: status \"import_incomplete\" sem --force — antes prosseguia silenciosamente (só um console.error perdido), agora lança", () => {
    assert.throws(
      () => assertImportUsable({ key: "w1", status: "import_incomplete", count: 100, importedCount: 42 }, false),
      /não confirmado/,
    );
  });

  it("status \"import_incomplete\" com --force → não lança (override consciente do operador)", () => {
    assert.doesNotThrow(() => assertImportUsable({ key: "w1", status: "import_incomplete", count: 100, importedCount: 42 }, true));
  });

  it("status \"planned\"/\"list_created\" (import nem tentado) → lança mesmo com --force (força não pula --import inteiramente)", () => {
    assert.throws(() => assertImportUsable({ key: "w1", status: "planned", count: 100 }, true), /não concluído/);
    assert.throws(() => assertImportUsable({ key: "w1", status: "list_created", count: 100 }, true), /não concluído/);
  });

  // #3660: gap residual do #3652 — assertImportUsable ainda comparava só o
  // literal "imported", então uma wave já avançada pra "draft"/"scheduled"
  // (rodada anterior do ramp multi-dia) caía incorretamente no throw final
  // de "import não concluído". Agora usa hasPassedImportPhase, que reconhece
  // qualquer status ">= imported" na ordem do ciclo de vida.
  it("status \"draft\" (pós --create de rodada anterior) → não lança (com ou sem --force)", () => {
    assert.doesNotThrow(() => assertImportUsable({ key: "w1", status: "draft", count: 100, importedCount: 100 }, false));
    assert.doesNotThrow(() => assertImportUsable({ key: "w1", status: "draft", count: 100, importedCount: 100 }, true));
  });

  it("status \"scheduled\" (pós --schedule de rodada anterior) → não lança (com ou sem --force)", () => {
    assert.doesNotThrow(() => assertImportUsable({ key: "w1", status: "scheduled", count: 100, importedCount: 100 }, false));
    assert.doesNotThrow(() => assertImportUsable({ key: "w1", status: "scheduled", count: 100, importedCount: 100 }, true));
  });
});

describe("buildImportFileBody (#3643 bug 3 — faltava ensureEditorCopyRow, quebrava invariante #3455)", () => {
  it("BUG ORIGINAL: CSV importado agora inclui a cópia QA do editor (antes só normalizeImportCsv, sem ensureEditorCopyRow)", () => {
    const csv = "email,NOME\nana@x.com,Ana\n";
    const body = buildImportFileBody(csv);
    assert.ok(
      body.toLowerCase().includes(EDITOR_COPY_EMAIL.toLowerCase()),
      `esperava ${EDITOR_COPY_EMAIL} no fileBody, recebido:\n${body}`,
    );
  });

  it("idempotente: não duplica se o editor já estiver na audiência real", () => {
    const csv = `email,NOME\n${EDITOR_COPY_EMAIL},Pixel\n`;
    const body = buildImportFileBody(csv);
    const occurrences = body.toLowerCase().split(EDITOR_COPY_EMAIL.toLowerCase()).length - 1;
    assert.equal(occurrences, 1);
  });
});

describe("checkAllCampaignsCreated (#3643 bug 4 — --schedule agendava parcial antes de detectar campaignId ausente)", () => {
  it("todas as entries com campaignId → ready=true, sem missing", () => {
    const result = checkAllCampaignsCreated([
      { key: "w1", campaignId: 111 },
      { key: "w2", campaignId: 222 },
      { key: "w3", campaignId: 333 },
    ]);
    assert.deepEqual(result, { ready: true, missingKeys: [] });
  });

  it("BUG ORIGINAL: w1/w2 têm campaignId, w3 não — antes o loop de --schedule agendaria w1/w2 de VERDADE via brevoPut antes de lançar em w3; agora o guard detecta ANTES de qualquer PUT", () => {
    const result = checkAllCampaignsCreated([
      { key: "w1", campaignId: 111 },
      { key: "w2", campaignId: 222 },
      { key: "w3", campaignId: undefined },
    ]);
    assert.equal(result.ready, false);
    assert.deepEqual(result.missingKeys, ["w3"], "identifica exatamente a(s) wave(s) sem campanha, sem tocar nas já criadas");
  });

  it("nenhuma entry com campaignId → ready=false, todas em missingKeys", () => {
    const result = checkAllCampaignsCreated([{ key: "w1" }, { key: "w2" }]);
    assert.equal(result.ready, false);
    assert.deepEqual(result.missingKeys, ["w1", "w2"]);
  });
});

// -----------------------------------------------------------------------------
// #3652 — 2 gaps residuais do fix do #3643 (status clobbering + mid-loop schedule failure)
// -----------------------------------------------------------------------------

describe("runScheduleLoop (#3652 bug 2 — persistência per-iteração, não em lote no fim)", () => {
  function wave(overrides: Partial<CampaignEntryLike> & { key: string; campaignId: number }): CampaignEntryLike {
    return {
      listId: 1,
      subject: "Assunto",
      scheduledAt: "2026-08-01T09:00:00.000Z",
      status: "draft",
      ...overrides,
    };
  }

  it("caminho feliz: todas as waves são PUT + verificadas + persistidas → todas \"scheduled\"", async () => {
    const w1 = wave({ key: "w1", campaignId: 1 });
    const w2 = wave({ key: "w2", campaignId: 2 });
    const campaignsView = [w1, w2];
    const putCalls: string[] = [];
    const writes: string[] = [];

    await runScheduleLoop(campaignsView, "/fake/ramp-summary.json", {
      putFn: async (v) => { putCalls.push(v.key); },
      verifyFn: async () => ({ status: "scheduled" }),
      writeFn: (_p, content) => { writes.push(content); },
      logFn: () => {},
      now: () => new Date("2026-07-17T00:00:00Z"),
    });

    assert.deepEqual(putCalls, ["w1", "w2"]);
    assert.equal(w1.status, "scheduled");
    assert.equal(w2.status, "scheduled");
    assert.equal(writes.length, 2, "1 write por wave persistida — não 1 write em lote no fim");
  });

  it("wave já \"scheduled\" → pulada sem chamar putFn (idempotente)", async () => {
    const w1 = wave({ key: "w1", campaignId: 1, status: "scheduled" });
    const putCalls: string[] = [];

    await runScheduleLoop([w1], "/fake/ramp-summary.json", {
      putFn: async (v) => { putCalls.push(v.key); },
      verifyFn: async () => ({ status: "scheduled" }),
      logFn: () => {},
    });

    assert.deepEqual(putCalls, [], "wave já agendada não deveria disparar novo PUT");
  });

  it(
    "BUG #3652 bug 2: putFn da wave 2 lança (timeout/5xx/rate-limit) — wave 1 JÁ foi persistida " +
    "como \"scheduled\" ANTES da exceção propagar, e wave 3 nunca é tentada",
    async () => {
      const w1 = wave({ key: "w1", campaignId: 1 });
      const w2 = wave({ key: "w2", campaignId: 2 });
      const w3 = wave({ key: "w3", campaignId: 3 });
      const campaignsView = [w1, w2, w3];
      const putCalls: string[] = [];
      const writes: string[] = [];

      await assert.rejects(
        runScheduleLoop(campaignsView, "/fake/ramp-summary.json", {
          putFn: async (v) => {
            putCalls.push(v.key);
            if (v.key === "w2") throw new Error("Brevo 503 (simulado, não é campaignId ausente)");
          },
          verifyFn: async () => ({ status: "scheduled" }),
          writeFn: (_p, content) => { writes.push(content); },
          logFn: () => {},
          now: () => new Date("2026-07-17T00:00:00Z"),
        }),
        /503/,
      );

      assert.deepEqual(putCalls, ["w1", "w2"], "w3 nunca deveria ser tentada depois que w2 lançou");
      assert.equal(w1.status, "scheduled", "w1 deveria ter sido persistida ANTES da exceção de w2 propagar");
      assert.equal(w2.status, "draft", "w2 não avança — seu próprio putFn falhou");
      assert.equal(w3.status, "draft", "w3 nunca foi tentada");
      assert.equal(writes.length, 1, "exatamente 1 write — a persistência de w1, antes da exceção de w2");
      const persisted = JSON.parse(writes[0]) as Array<{ key: string; status: string }>;
      assert.equal(persisted.find((e) => e.key === "w1")?.status, "scheduled");
    },
  );

  it("verifyFn rejeita (GET-verify falha) → status local NÃO atualizado, não lança, loop continua pra próxima wave", async () => {
    const w1 = wave({ key: "w1", campaignId: 1 });
    const w2 = wave({ key: "w2", campaignId: 2 });
    const campaignsView = [w1, w2];

    await runScheduleLoop(campaignsView, "/fake/ramp-summary.json", {
      putFn: async () => {},
      verifyFn: async (v) => {
        if (v.key === "w1") throw new Error("GET timeout");
        return { status: "scheduled" };
      },
      writeFn: () => {},
      logFn: () => {},
      now: () => new Date("2026-07-17T00:00:00Z"),
    });

    assert.equal(w1.status, "draft", "GET-verify falhou — status local não deveria avançar (mesmo com PUT real aceito)");
    assert.equal(w2.status, "scheduled");
  });

  it("scheduledAt no passado → lança sem chamar putFn (guard preservado do loop original)", async () => {
    const w1 = wave({ key: "w1", campaignId: 1, scheduledAt: "2026-07-01T09:00:00.000Z" });
    const putCalls: string[] = [];
    await assert.rejects(
      runScheduleLoop([w1], "/fake/ramp-summary.json", {
        putFn: async (v) => { putCalls.push(v.key); },
        verifyFn: async () => ({ status: "scheduled" }),
        logFn: () => {},
        now: () => new Date("2026-07-17T00:00:00Z"),
      }),
      /passado\/presente/,
    );
    assert.deepEqual(putCalls, []);
  });

  it(
    "interação com bug 1: o status \"scheduled\" persistido por runScheduleLoop é reconhecido por " +
    "hasPassedImportPhase/shouldSkipImport como já-avançado (--import subsequente pularia a wave)",
    async () => {
      const w1 = wave({ key: "w1", campaignId: 1 });
      await runScheduleLoop([w1], "/fake/ramp-summary.json", {
        putFn: async () => {},
        verifyFn: async () => ({ status: "scheduled" }),
        writeFn: () => {},
        logFn: () => {},
        now: () => new Date("2026-07-17T00:00:00Z"),
      });
      assert.equal(w1.status, "scheduled");
      assert.equal(shouldSkipImport(w1), true, "shouldSkipImport deveria reconhecer o status escrito por runScheduleLoop");
    },
  );

  // ---------------------------------------------------------------------
  // #7047 — antecedência mínima (SCHEDULE_AT_MIN_LEAD_MS, extraída do #7042
  // pra scripts/lib/schedule-guard.ts). clarice-schedule-ramp.ts é o de
  // MAIOR blast radius dos 3 scripts corrigidos por esta issue — antes,
  // este loop só recusava passado/presente (teste acima), exatamente o
  // estado em que clarice-schedule-group.ts estava antes do incidente de
  // 01/09/2026 (campanhas #208/209/210 destinadas ao dia seguinte saindo
  // no mesmo dia).
  // ---------------------------------------------------------------------
  it("REGRESSÃO #7047: scheduledAt a 30s de 'agora' lança ANTES do putFn", async () => {
    const NOW = new Date("2026-09-01T14:00:00.000Z");
    const w1 = wave({ key: "w1", campaignId: 1, scheduledAt: new Date(NOW.getTime() + 30_000).toISOString() });
    const putCalls: string[] = [];

    await assert.rejects(
      runScheduleLoop([w1], "/fake/ramp-summary.json", {
        putFn: async (v) => { putCalls.push(v.key); },
        verifyFn: async () => ({ status: "scheduled" }),
        logFn: () => {},
        now: () => NOW,
      }),
      /antecedência mínima/i,
    );
    assert.deepEqual(putCalls, [], "guard de antecedência deve barrar ANTES de chamar putFn — não bastava passar em 'no futuro'");
    assert.equal(w1.status, "draft");
  });

  it("#7047: allowImminent=true no deps permite o mesmo scheduledAt imminente", async () => {
    const NOW = new Date("2026-09-01T14:00:00.000Z");
    const w1 = wave({ key: "w1", campaignId: 1, scheduledAt: new Date(NOW.getTime() + 30_000).toISOString() });
    const putCalls: string[] = [];

    await runScheduleLoop([w1], "/fake/ramp-summary.json", {
      putFn: async (v) => { putCalls.push(v.key); },
      verifyFn: async () => ({ status: "scheduled" }),
      writeFn: () => {},
      logFn: () => {},
      now: () => NOW,
      allowImminent: true,
    });
    assert.deepEqual(putCalls, ["w1"]);
    assert.equal(w1.status, "scheduled");
  });

  it("#7047: horário fora do canônico não bloqueia — só avisa via logFn", async () => {
    const NOW = new Date("2026-09-01T14:00:00.000Z");
    const w1 = wave({ key: "w1", campaignId: 1, scheduledAt: "2026-09-02T17:00:00.000Z" });
    const logs: string[] = [];

    await runScheduleLoop([w1], "/fake/ramp-summary.json", {
      putFn: async () => {},
      verifyFn: async () => ({ status: "scheduled" }),
      writeFn: () => {},
      logFn: (m) => logs.push(m),
      now: () => NOW,
    });
    assert.equal(w1.status, "scheduled", "aviso não bloqueia o agendamento");
    assert.ok(logs.some((m) => /fora do horário canônico/i.test(m)), "esperava o aviso nomeado no log");
  });
});

// -----------------------------------------------------------------------------
// describeSpamSignalLine (#4780 item 2 — achado do fleet review pré-merge do
// #4779: o CLI imprimia a média de domínio mesmo quando o pico por campanha
// decidia o semáforo)
// -----------------------------------------------------------------------------

describe("describeSpamSignalLine (#4780)", () => {
  const NOW = new Date("2026-08-06T12:00:00.000Z");

  it("spamEntry ausente → mensagem 'ausente/indisponível' (comportamento preservado)", () => {
    const signal = resolveSpamSignal(null, NOW);
    const line = describeSpamSignalLine(null, signal);
    assert.match(line, /ausente\/indisponível/);
  });

  it("média de domínio governa (sem pico por campanha) → imprime o valor da média com origem 'domínio'", () => {
    const entry = { spamRatePct: 0.02, recordedAt: "2026-08-06T09:00:00.000Z", producedBy: "auto" as const };
    const signal = resolveSpamSignal({ ...entry, date: "2026-08-06" }, NOW);
    const line = describeSpamSignalLine(entry, signal);
    assert.match(line, /0\.020%/);
    assert.match(line, /origem: média de domínio/);
    assert.doesNotMatch(line, /pico da campanha/);
  });

  // Cenário real da issue #4780 (item 2): a média de domínio sozinha
  // resolveria "verde"/número baixo, mas o pico por campanha é o que
  // efetivamente governa o semáforo — a linha impressa precisa refletir ISSO,
  // não a média.
  it("pico por campanha governa (Math.max) → imprime o valor efetivo + origem 'campanha {feedback_loop_id}' + cobertura", () => {
    const entry = {
      spamRatePct: 0.02, // média de domínio: baixa
      recordedAt: "2026-08-06T09:00:00.000Z",
      producedBy: "auto" as const,
      worstCampaignSpamRatePct: 1.39, // pico de campanha: bem mais alto
      worstCampaignFeedbackLoopId: "11130585_107",
      worstCampaignDaysWithData: 1,
    };
    const signal = resolveSpamSignal({ ...entry, date: "2026-08-06" }, NOW);
    const line = describeSpamSignalLine(entry, signal);
    assert.match(line, /1\.390%/, "deve imprimir o valor EFETIVO (pico), não a média de domínio (0.02%)");
    assert.doesNotMatch(line, /0\.020%/);
    assert.match(line, /origem: pico da campanha 11130585_107/);
    assert.match(line, /\(1 dia\(s\) com dado\)/, "cobertura do pico (#4780 item 3) deve aparecer na linha");
  });

  it("domínio pior que o pico por campanha → Math.max escolhe o domínio, origem continua 'domínio' (não mascara o pior sinal)", () => {
    const entry = {
      spamRatePct: 0.5, // domínio pior
      recordedAt: "2026-08-06T09:00:00.000Z",
      producedBy: "auto" as const,
      worstCampaignSpamRatePct: 0.1, // campanha melhor
      worstCampaignFeedbackLoopId: "11130585_107",
      worstCampaignDaysWithData: 5,
    };
    const signal = resolveSpamSignal({ ...entry, date: "2026-08-06" }, NOW);
    const line = describeSpamSignalLine(entry, signal);
    assert.match(line, /0\.500%/);
    assert.match(line, /origem: média de domínio/);
  });

  // #4785 (pr-test-analyzer, gap do fleet review pré-merge do #4780): entry
  // LEGADA pré-#4780 — pico de campanha governa, mas `worstCampaignDaysWithData`
  // nunca foi gravado (campo não existia ainda). Precisa renderizar a origem
  // SEM o sufixo de cobertura, sem quebrar por acesso a campo ausente.
  it("pico por campanha governa mas worstCampaignDaysWithData está AUSENTE (entry legado pré-#4780) → origem sem sufixo de cobertura, sem quebrar (#4785)", () => {
    const entry = {
      spamRatePct: 0.02,
      recordedAt: "2026-08-06T09:00:00.000Z",
      producedBy: "auto" as const,
      worstCampaignSpamRatePct: 1.39,
      worstCampaignFeedbackLoopId: "11130585_107",
      // worstCampaignDaysWithData intencionalmente ausente (undefined)
    };
    const signal = resolveSpamSignal({ ...entry, date: "2026-08-06" }, NOW);
    const line = describeSpamSignalLine(entry, signal);
    assert.match(line, /origem: pico da campanha 11130585_107/);
    assert.doesNotMatch(line, /dia\(s\) com dado/, "sem worstCampaignDaysWithData, o sufixo de cobertura não deve aparecer");
  });

  it("entry presente mas indeterminate (stale) → mostra o valor cru e sinaliza que não governa o semáforo agora", () => {
    const entry = { spamRatePct: 0.02, recordedAt: "2026-07-01T00:00:00.000Z", producedBy: "auto" as const }; // recordedAt bem velho
    const signal = resolveSpamSignal({ ...entry, date: "2026-07-01" }, NOW);
    const line = describeSpamSignalLine(entry, signal);
    assert.match(line, /indeterminate/);
    assert.match(line, /0\.02%/);
  });
});
