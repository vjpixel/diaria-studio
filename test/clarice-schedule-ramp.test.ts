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
} from "../scripts/clarice-schedule-ramp.ts";
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

  it("envio maduro, saúde boa (verde) → plano computado com volumes crescentes", () => {
    const now = new Date("2026-07-17T00:00:00Z");
    const campaigns = [campaign({ id: 1, sentDate: "2026-07-10T09:00:00Z" })]; // >48h
    const result = deriveRampVolumes(campaigns, now);
    assert.equal(result.ok, true);
    if (!result.ok) throw new Error("unreachable");
    assert.equal(result.plan.semaphore, "green");
    assert.equal(result.plan.baseVolume, 1000);
    assert.deepEqual(result.plan.volumes, [1100, 1210, 1331]);
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
  });
});
