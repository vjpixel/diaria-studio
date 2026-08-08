/**
 * cohort-engagement.test.ts (#4464)
 *
 * Cobre os helpers puros de normalização/agrupamento/agregação e a
 * paginação + guard anti-truncamento de `fetchAllSubscribers` (mock de
 * `fetch`, sem tocar a API Beehiiv de verdade — regra #633 + regra
 * invariável do dispatch desta unidade).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  normalizeKey,
  resolveGroupKey,
  parseSinceToEpochSeconds,
  parseUntilToEpochSecondsExclusive,
  filterSince,
  filterWindow,
  countMissingCreated,
  resolveWindowGuardError,
  median,
  mean,
  computeGroupEngagement,
  aggregateEngagement,
  formatEngagementTable,
  fetchAllSubscribers,
  runCohortEngagement,
  type EngagementSubscriber,
} from "../scripts/cohort-engagement.ts";

// ---------------------------------------------------------------------------
// normalizeKey / resolveGroupKey
// ---------------------------------------------------------------------------

describe("normalizeKey (#4464)", () => {
  it("retorna __none__ para null/undefined/vazio/espaço", () => {
    assert.equal(normalizeKey(null), "__none__");
    assert.equal(normalizeKey(undefined), "__none__");
    assert.equal(normalizeKey(""), "__none__");
    assert.equal(normalizeKey("   "), "__none__");
  });

  it("lowercaseia e trimeia", () => {
    assert.equal(normalizeKey("  Google-Ads  "), "google-ads");
  });
});

describe("resolveGroupKey (#4464)", () => {
  it("usa utm_source quando presente", () => {
    const key = resolveGroupKey({ utm_source: "google-ads", referring_site: "google.com" });
    assert.equal(key, "google-ads");
  });

  it("cai para referring_site quando utm_source ausente", () => {
    const key = resolveGroupKey({ utm_source: null, referring_site: "https://google.com" });
    assert.equal(key, "https://google.com");
  });

  it("retorna __none__ quando ambos ausentes", () => {
    const key = resolveGroupKey({ utm_source: null, referring_site: null });
    assert.equal(key, "__none__");
  });

  it("referring_site vazio também cai em __none__", () => {
    const key = resolveGroupKey({ utm_source: "", referring_site: "" });
    assert.equal(key, "__none__");
  });
});

// ---------------------------------------------------------------------------
// parseSinceToEpochSeconds / filterSince — bordas do dia (#4464)
// ---------------------------------------------------------------------------

describe("parseSinceToEpochSeconds (#4464)", () => {
  it("converte AAAA-MM-DD no epoch de início do dia (UTC)", () => {
    const epoch = parseSinceToEpochSeconds("2026-07-31");
    assert.equal(epoch, Date.UTC(2026, 6, 31, 0, 0, 0, 0) / 1000);
  });

  it("lança para formato inválido", () => {
    assert.throws(() => parseSinceToEpochSeconds("31/07/2026"), /--since inválido/);
    assert.throws(() => parseSinceToEpochSeconds("2026-7-31"), /--since inválido/);
    assert.throws(() => parseSinceToEpochSeconds(""), /--since inválido/);
  });
});

/**
 * Janela fechada `--since`/`--until` (#4556).
 *
 * Motivação concreta: o checkpoint de retenção da coorte de lançamento
 * (21/07–02/08) não era isolável com `--since` sozinho — o recorte pegava tudo
 * de 21/07 pra frente e misturava quem chegou depois, que é justamente o grupo
 * de controle contra o qual a coorte deveria ser comparada.
 */
describe("parseUntilToEpochSecondsExclusive (#4556)", () => {
  it("o dia informado entra INTEIRO — a borda é o início do dia seguinte", () => {
    const until = parseUntilToEpochSecondsExclusive("2026-08-02");
    const proximoDia = parseSinceToEpochSeconds("2026-08-03");
    assert.equal(until, proximoDia);
  });

  it("nomeia a própria flag na mensagem de erro, não --since", () => {
    assert.throws(() => parseUntilToEpochSecondsExclusive("02/08/2026"), /--until inválido/);
  });
});

/**
 * Regressão do rollover silencioso (#4556).
 *
 * `Date.UTC` NÃO devolve NaN para mês/dia fora de faixa — ele ROLA:
 * `Date.UTC(2026, 12, 45)` = 2027-02-14. Como o regex aceita qualquer `\d{2}`,
 * `--since 2026-13-45` era aceito em silêncio e media uma janela completamente
 * diferente da pedida, com exit 0. A mensagem "data não existe" que já existia
 * no código era inalcançável.
 */
describe("data fora de faixa é rejeitada em vez de rolar (#4556)", () => {
  it("mês 13 não vira janeiro do ano seguinte", () => {
    assert.throws(() => parseSinceToEpochSeconds("2026-13-01"), /data não existe/);
  });

  it("dia 45 não rola pro mês seguinte", () => {
    assert.throws(() => parseSinceToEpochSeconds("2026-08-45"), /data não existe/);
  });

  it("31 de fevereiro não vira 3 de março", () => {
    assert.throws(() => parseSinceToEpochSeconds("2026-02-31"), /data não existe/);
  });

  it("dia 00 e mês 00 são rejeitados", () => {
    assert.throws(() => parseSinceToEpochSeconds("2026-08-00"), /data não existe/);
    assert.throws(() => parseSinceToEpochSeconds("2026-00-10"), /data não existe/);
  });

  it("data bissexta VÁLIDA continua passando (o guard não é agressivo demais)", () => {
    assert.equal(typeof parseSinceToEpochSeconds("2028-02-29"), "number");
  });
});

describe("filterWindow — janela fechada (#4556)", () => {
  const since = parseSinceToEpochSeconds("2026-07-21");
  const untilExcl = parseUntilToEpochSecondsExclusive("2026-08-02");

  it("inclui o último segundo do dia informado em --until", () => {
    const subs: EngagementSubscriber[] = [{ created: untilExcl - 1 }];
    assert.equal(filterWindow(subs, { since, untilExclusive: untilExcl }).length, 1);
  });

  it("exclui o primeiro segundo do dia SEGUINTE ao --until", () => {
    const subs: EngagementSubscriber[] = [{ created: untilExcl }];
    assert.equal(filterWindow(subs, { since, untilExclusive: untilExcl }).length, 0);
  });

  it("isola a coorte de quem chegou depois — o caso que motivou a issue", () => {
    const subs: EngagementSubscriber[] = [
      { created: since - 1, utm_source: "antes" },
      { created: since, utm_source: "coorte" },
      { created: untilExcl - 1, utm_source: "coorte" },
      { created: untilExcl, utm_source: "depois" },
    ];
    const dentro = filterWindow(subs, { since, untilExclusive: untilExcl });
    assert.deepEqual(
      dentro.map((s) => s.utm_source),
      ["coorte", "coorte"],
    );
  });

  it("só --until (sem --since) funciona como borda superior sozinha", () => {
    const subs: EngagementSubscriber[] = [{ created: 0 }, { created: untilExcl }];
    assert.equal(filterWindow(subs, { since: null, untilExclusive: untilExcl }).length, 1);
  });

  it("assinante sem `created` é excluído quando só --until é informado", () => {
    const subs: EngagementSubscriber[] = [{ utm_source: "sem-data" }];
    assert.equal(filterWindow(subs, { since: null, untilExclusive: untilExcl }).length, 0);
  });

  it("sem nenhuma borda devolve a lista intacta, inclusive quem não tem `created`", () => {
    const subs: EngagementSubscriber[] = [{ utm_source: "sem-data" }, { created: 123 }];
    assert.equal(filterWindow(subs, { since: null, untilExclusive: null }).length, 2);
  });

  it("filterSince continua sendo filterWindow sem borda superior", () => {
    const subs: EngagementSubscriber[] = [{ created: since }, { created: untilExcl + 999 }];
    assert.deepEqual(filterSince(subs, since), filterWindow(subs, { since, untilExclusive: null }));
  });

  it("ano 0-99 não é remapeado pra 1900-1999 em silêncio", () => {
    // Peculiaridade do JS: Date.UTC(0, 0, 1) = 1900-01-01, não ano 0. O guard
    // de ida-e-volta pega por construção, mas sem teste isso não fica travado
    // contra uma refatoração que comparasse o ano de outra forma.
    assert.throws(() => parseSinceToEpochSeconds("0000-01-01"), /data não existe/);
    assert.throws(() => parseSinceToEpochSeconds("0099-05-01"), /data não existe/);
  });
});

/**
 * O contador existe porque `filterWindow` descarta quem não tem `created` —
 * viés assumido conscientemente, mas que era invisível no output. Pesa mais em
 * janela estreita, que é justamente o caso de uso que `--until` viabiliza.
 * Achado do fleet review da PR #4751.
 */
describe("countMissingCreated (#4556)", () => {
  const since = parseSinceToEpochSeconds("2026-07-21");
  const untilExcl = parseUntilToEpochSecondsExclusive("2026-08-02");
  const subs: EngagementSubscriber[] = [
    { created: since },
    { utm_source: "sem-data" },
    { created: null },
  ];

  it("conta os descartados quando há janela", () => {
    assert.equal(countMissingCreated(subs, { since, untilExclusive: untilExcl }), 2);
  });

  it("conta também quando só uma das bordas existe", () => {
    assert.equal(countMissingCreated(subs, { since, untilExclusive: null }), 2);
    assert.equal(countMissingCreated(subs, { since: null, untilExclusive: untilExcl }), 2);
  });

  it("é 0 sem janela — ninguém é descartado por falta de `created`", () => {
    assert.equal(countMissingCreated(subs, { since: null, untilExclusive: null }), 0);
  });
});

/**
 * O guard de janela vivia inline no bloco `isMainModule` e por isso não tinha
 * teste nenhum — categoria que quebra em silêncio num refactor (trocar `>=` por
 * `>` reabriria a janela de um único dia como erro). Extraído no fleet review
 * da PR #4751 justamente pra ser testável sem subir subprocesso.
 */
describe("resolveWindowGuardError (#4556)", () => {
  const dia = (d: string) => parseSinceToEpochSeconds(d);
  const ate = (d: string) => parseUntilToEpochSecondsExclusive(d);

  it("janela invertida vira erro", () => {
    const err = resolveWindowGuardError({ since: dia("2026-08-02"), untilExclusive: ate("2026-07-21") });
    assert.match(err ?? "", /janela inválida/);
  });

  it("janela de UM ÚNICO dia é válida — o limite exato do `>=`", () => {
    assert.equal(
      resolveWindowGuardError({ since: dia("2026-07-21"), untilExclusive: ate("2026-07-21") }),
      null,
    );
  });

  it("janela normal não erra", () => {
    assert.equal(
      resolveWindowGuardError({ since: dia("2026-07-21"), untilExclusive: ate("2026-08-02") }),
      null,
    );
  });

  it("uma borda só nunca erra — não há o que comparar", () => {
    assert.equal(resolveWindowGuardError({ since: dia("2026-07-21"), untilExclusive: null }), null);
    assert.equal(resolveWindowGuardError({ since: null, untilExclusive: ate("2026-08-02") }), null);
    assert.equal(resolveWindowGuardError({ since: null, untilExclusive: null }), null);
  });

  it("usa os rótulos do usuário na mensagem, não o epoch", () => {
    const err = resolveWindowGuardError(
      { since: dia("2026-08-02"), untilExclusive: ate("2026-07-21") },
      { since: "2026-08-02", until: "2026-07-21" },
    );
    assert.match(err ?? "", /--since 2026-08-02 é depois de --until 2026-07-21/);
  });
});

describe("filterSince — bordas do dia (#4464)", () => {
  const cutoff = parseSinceToEpochSeconds("2026-07-31");

  it("assinante criado EXATAMENTE na data de corte entra (inclusivo)", () => {
    const subs: EngagementSubscriber[] = [{ created: cutoff }];
    const out = filterSince(subs, cutoff);
    assert.equal(out.length, 1);
  });

  it("assinante criado 1 segundo antes da data de corte NÃO entra", () => {
    const subs: EngagementSubscriber[] = [{ created: cutoff - 1 }];
    const out = filterSince(subs, cutoff);
    assert.equal(out.length, 0);
  });

  it("assinante criado 1 dia inteiro antes não entra", () => {
    const oneDayBefore = cutoff - 86400;
    const subs: EngagementSubscriber[] = [{ created: oneDayBefore }];
    const out = filterSince(subs, cutoff);
    assert.equal(out.length, 0);
  });

  it("assinante criado depois da data de corte entra", () => {
    const subs: EngagementSubscriber[] = [{ created: cutoff + 86400 }];
    const out = filterSince(subs, cutoff);
    assert.equal(out.length, 1);
  });

  it("sem sinceEpochSeconds (null), não filtra nada", () => {
    const subs: EngagementSubscriber[] = [{ created: 0 }, { created: cutoff - 999999 }];
    const out = filterSince(subs, null);
    assert.equal(out.length, 2);
  });

  it("assinante sem `created` é excluído quando --since está ativo", () => {
    const subs: EngagementSubscriber[] = [{ created: undefined }, { created: cutoff }];
    const out = filterSince(subs, cutoff);
    assert.equal(out.length, 1);
  });
});

// ---------------------------------------------------------------------------
// median / mean
// ---------------------------------------------------------------------------

describe("median (#4464)", () => {
  it("retorna null para lista vazia", () => {
    assert.equal(median([]), null);
  });

  it("ímpar: retorna o elemento central", () => {
    assert.equal(median([1, 3, 2]), 2);
  });

  it("par: retorna a média dos dois centrais", () => {
    assert.equal(median([1, 2, 3, 4]), 2.5);
  });

  it("não muta o array de entrada", () => {
    const input = [5, 1, 3];
    median(input);
    assert.deepEqual(input, [5, 1, 3]);
  });
});

describe("mean (#4464)", () => {
  it("retorna null para lista vazia", () => {
    assert.equal(mean([]), null);
  });

  it("calcula a média simples", () => {
    assert.equal(mean([2, 4, 6]), 4);
  });
});

// ---------------------------------------------------------------------------
// computeGroupEngagement — agregação pura (#4464)
// ---------------------------------------------------------------------------

function makeSub(overrides: Partial<EngagementSubscriber> = {}): EngagementSubscriber {
  return {
    id: "sub_x",
    status: "active",
    created: 1_700_000_000,
    utm_source: "google-ads",
    referring_site: null,
    stats: { total_sent: 10, total_received: 10, total_unique_opened: 4, open_rate: 40 },
    ...overrides,
  };
}

describe("computeGroupEngagement (#4464)", () => {
  it("conta status corretamente", () => {
    const subs = [
      makeSub({ status: "active" }),
      makeSub({ status: "active" }),
      makeSub({ status: "inactive" }),
      makeSub({ status: "pending" }),
      makeSub({ status: "invalid" }),
    ];
    const g = computeGroupEngagement(subs, { threshold: 40 });
    assert.equal(g.cadastros, 5);
    assert.equal(g.ativos, 2);
    assert.equal(g.inativos, 1);
    assert.equal(g.pending, 1);
    assert.equal(g.invalid, 1);
    assert.equal(g.outros_status, 0);
  });

  it("status desconhecido (ex: validating) cai em outros_status, não é descartado", () => {
    const subs = [makeSub({ status: "validating" })];
    const g = computeGroupEngagement(subs, { threshold: 40 });
    assert.equal(g.cadastros, 1);
    assert.equal(g.outros_status, 1);
    assert.equal(g.ativos, 0);
  });

  it("leitores = ativos com open_rate >= threshold", () => {
    const subs = [
      makeSub({ stats: { total_received: 10, total_unique_opened: 5, open_rate: 50 } }),
      makeSub({ stats: { total_received: 10, total_unique_opened: 3, open_rate: 30 } }),
      makeSub({ stats: { total_received: 10, total_unique_opened: 4, open_rate: 40 } }), // == threshold, entra
    ];
    const g = computeGroupEngagement(subs, { threshold: 40 });
    assert.equal(g.ativos, 3);
    assert.equal(g.leitores, 2, "50 e 40 (>= 40) contam; 30 não");
  });

  it("abertura_agregada = soma(total_unique_opened) / soma(total_received)", () => {
    const subs = [
      makeSub({ stats: { total_received: 10, total_unique_opened: 5, open_rate: 50 } }),
      makeSub({ stats: { total_received: 20, total_unique_opened: 2, open_rate: 10 } }),
    ];
    const g = computeGroupEngagement(subs, { threshold: 40 });
    // (5+2) / (10+20) = 7/30
    assert.equal(g.abertura_agregada, 7 / 30);
  });

  it("abertura_agregada é null quando não há denominador (nenhum ativo com stats)", () => {
    const subs = [makeSub({ stats: null })];
    const g = computeGroupEngagement(subs, { threshold: 40 });
    assert.equal(g.ativos, 1);
    assert.equal(g.abertura_agregada, null);
    assert.equal(g.leitores, 0);
  });

  it("assinante sem `stats` (campo ausente) não quebra e não conta como leitor", () => {
    const subs = [
      makeSub({ stats: undefined }),
      makeSub({ stats: { total_received: 10, total_unique_opened: 9, open_rate: 90 } }),
    ];
    const g = computeGroupEngagement(subs, { threshold: 40 });
    assert.equal(g.ativos, 2, "ambos contam como ativos (status independe de stats)");
    assert.equal(g.leitores, 1, "só o que tem stats conta como leitor");
    assert.equal(g.amostra_considerada, 1, "sem-stats fica fora do denominador de engajamento");
  });

  it("inativo/pending/invalid nunca entram no denominador de leitores/abertura", () => {
    const subs = [
      makeSub({ status: "inactive", stats: { total_received: 100, total_unique_opened: 100, open_rate: 100 } }),
      makeSub({ status: "active", stats: { total_received: 10, total_unique_opened: 1, open_rate: 10 } }),
    ];
    const g = computeGroupEngagement(subs, { threshold: 5 });
    assert.equal(g.leitores, 1, "só o ativo conta, mesmo tendo open_rate menor que o inativo");
    assert.equal(g.amostra_considerada, 1);
  });

  it("--min-received refaz o corte só com ativos com total_received >= N", () => {
    const subs = [
      makeSub({ stats: { total_received: 3, total_unique_opened: 3, open_rate: 100 } }), // pouco histórico
      makeSub({ stats: { total_received: 20, total_unique_opened: 2, open_rate: 10 } }),
    ];
    const semCorte = computeGroupEngagement(subs, { threshold: 40 });
    assert.equal(semCorte.leitores, 1);
    assert.equal(semCorte.amostra_considerada, 2);

    const comCorte = computeGroupEngagement(subs, { threshold: 40, minReceived: 10 });
    assert.equal(comCorte.amostra_considerada, 1, "só o de 20 recebidas sobrevive ao corte de 10");
    assert.equal(comCorte.leitores, 0, "o único considerado tem open_rate 10 < 40");
  });

  it("amostra_instavel = true quando mediana de total_received < 10", () => {
    const subs = [
      makeSub({ stats: { total_received: 2, total_unique_opened: 1, open_rate: 50 } }),
      makeSub({ stats: { total_received: 3, total_unique_opened: 1, open_rate: 33 } }),
      makeSub({ stats: { total_received: 4, total_unique_opened: 1, open_rate: 25 } }),
    ];
    const g = computeGroupEngagement(subs, { threshold: 40 });
    assert.equal(g.mediana_recebidas, 3);
    assert.equal(g.amostra_instavel, true);
  });

  it("amostra_instavel = false quando mediana de total_received >= 10", () => {
    const subs = [
      makeSub({ stats: { total_received: 10, total_unique_opened: 1, open_rate: 10 } }),
      makeSub({ stats: { total_received: 15, total_unique_opened: 1, open_rate: 10 } }),
      makeSub({ stats: { total_received: 20, total_unique_opened: 1, open_rate: 10 } }),
    ];
    const g = computeGroupEngagement(subs, { threshold: 40 });
    assert.equal(g.mediana_recebidas, 15);
    assert.equal(g.amostra_instavel, false);
  });

  it("grupo sem nenhum ativo: media/mediana/abertura null, amostra_instavel false", () => {
    const subs = [makeSub({ status: "pending", stats: null })];
    const g = computeGroupEngagement(subs, { threshold: 40 });
    assert.equal(g.ativos, 0);
    assert.equal(g.media_recebidas, null);
    assert.equal(g.mediana_recebidas, null);
    assert.equal(g.abertura_agregada, null);
    assert.equal(g.amostra_instavel, false);
  });

  /**
   * Regressão #4752: `amostra_considerada === 0` (denominador vazio, o caso
   * PIOR) fazia `amostra_instavel` ficar `false` — indistinguível de "amostra
   * grande e saudável" no JSON. `amostra_vazia` é o sinal dedicado, aditivo,
   * que não muda o significado de `amostra_instavel` (opção 2 da issue).
   */
  // O fixture usa status ATIVO com `stats: null` de propósito. Um `status:
  // "pending"` sairia no `continue` de status antes de chegar em `stats`, e o
  // teste passaria sem nunca exercitar o caminho que o nome promete — achado
  // do fleet review da PR #4757.
  it("amostra_vazia = true quando amostra_considerada é zero (ativo, mas sem stats)", () => {
    const subs = [makeSub({ status: "active", stats: null })];
    const g = computeGroupEngagement(subs, { threshold: 40 });
    assert.equal(g.amostra_considerada, 0);
    assert.equal(g.amostra_vazia, true);
    assert.equal(g.amostra_instavel, false, "amostra_instavel não é redefinida — continua false pra vazio");
  });

  it("amostra_vazia = true quando --min-received corta todos os ativos", () => {
    const subs = [makeSub({ stats: { total_received: 3, total_unique_opened: 1, open_rate: 100 } })];
    const g = computeGroupEngagement(subs, { threshold: 40, minReceived: 10 });
    assert.equal(g.amostra_considerada, 0);
    assert.equal(g.amostra_vazia, true);
  });

  it("amostra_vazia = false quando amostra_considerada está entre 1 e 9 — amostra_instavel continua disparando (não regride)", () => {
    const subs = [
      makeSub({ stats: { total_received: 2, total_unique_opened: 1, open_rate: 50 } }),
      makeSub({ stats: { total_received: 3, total_unique_opened: 1, open_rate: 33 } }),
      makeSub({ stats: { total_received: 4, total_unique_opened: 1, open_rate: 25 } }),
    ];
    const g = computeGroupEngagement(subs, { threshold: 40 });
    assert.equal(g.amostra_considerada, 3);
    assert.equal(g.amostra_vazia, false);
    assert.equal(g.amostra_instavel, true, "1-9 considerados continua marcando amostra_instavel");
  });

  // Borda EXATA entre vazio e não-vazio. Os testes de 0 e 3 não distinguem
  // `=== 0` de `<= 1` — um refactor que confundisse a condição com a de
  // `amostra_instavel` passaria despercebido. Achado do fleet review #4757.
  it("amostra_vazia = false quando amostra_considerada é exatamente 1", () => {
    const subs = [makeSub({ stats: { total_received: 2, total_unique_opened: 1, open_rate: 50 } })];
    const g = computeGroupEngagement(subs, { threshold: 40 });
    assert.equal(g.amostra_considerada, 1);
    assert.equal(g.amostra_vazia, false);
    assert.equal(g.amostra_instavel, true, "1 considerado com mediana 2 é instável, não vazio");
  });

  /**
   * `pre_corte_considerado` (#4757) — os dois caminhos que produzem
   * `amostra_vazia` produziam saída IDÊNTICA e pedem ações OPOSTAS: "não há
   * tracking de stats neste grupo" (investigar) vs "--min-received cortou todo
   * mundo" (baixar o piso). Sem este campo, quem lê não distingue.
   */
  it("pre_corte_considerado distingue 'sem stats' de 'cortado pelo piso'", () => {
    const semStats = computeGroupEngagement([makeSub({ status: "active", stats: null })], {
      threshold: 40,
    });
    assert.equal(semStats.amostra_vazia, true);
    assert.equal(semStats.pre_corte_considerado, 0, "ninguém tinha stats pra começar");

    const cortado = computeGroupEngagement(
      [makeSub({ stats: { total_received: 3, total_unique_opened: 1, open_rate: 100 } })],
      { threshold: 40, minReceived: 10 },
    );
    assert.equal(cortado.amostra_vazia, true);
    assert.equal(cortado.pre_corte_considerado, 1, "tinha 1 com stats, o piso cortou");
    assert.equal(
      cortado.pre_corte_considerado - cortado.amostra_considerada,
      1,
      "a diferença é quantos o piso cortou",
    );
  });

  it("pre_corte_considerado === amostra_considerada quando não há --min-received", () => {
    const subs = [
      makeSub({ stats: { total_received: 20, total_unique_opened: 10, open_rate: 50 } }),
      makeSub({ stats: { total_received: 30, total_unique_opened: 9, open_rate: 30 } }),
    ];
    const g = computeGroupEngagement(subs, { threshold: 40 });
    assert.equal(g.pre_corte_considerado, g.amostra_considerada);
  });

  it("amostra_vazia = false quando amostra_considerada é saudável (>= 10)", () => {
    const subs = [
      makeSub({ stats: { total_received: 10, total_unique_opened: 1, open_rate: 10 } }),
      makeSub({ stats: { total_received: 15, total_unique_opened: 1, open_rate: 10 } }),
      makeSub({ stats: { total_received: 20, total_unique_opened: 1, open_rate: 10 } }),
    ];
    const g = computeGroupEngagement(subs, { threshold: 40 });
    assert.equal(g.amostra_vazia, false);
    assert.equal(g.amostra_instavel, false);
  });
});

// ---------------------------------------------------------------------------
// aggregateEngagement — agrupamento (#4464)
// ---------------------------------------------------------------------------

describe("aggregateEngagement (#4464)", () => {
  it("agrupa por utm_source com referring_site como fallback", () => {
    const subs = [
      makeSub({ utm_source: "google-ads", referring_site: null }),
      makeSub({ utm_source: null, referring_site: "linkedin.com" }),
      makeSub({ utm_source: null, referring_site: "linkedin.com" }),
      makeSub({ utm_source: null, referring_site: null }),
    ];
    const result = aggregateEngagement(subs, { threshold: 40 });
    assert.equal(result["google-ads"].cadastros, 1);
    assert.equal(result["linkedin.com"].cadastros, 2);
    assert.equal(result["__none__"].cadastros, 1);
  });
});

// ---------------------------------------------------------------------------
// formatEngagementTable — smoke (#4464)
// ---------------------------------------------------------------------------

describe("formatEngagementTable (#4464)", () => {
  it("retorna mensagem para resultado vazio", () => {
    const table = formatEngagementTable({
      groups: {},
      total_cadastros: 0,
      threshold: 40,
      min_received: null,
      since: null,
      until: null,
      excluded_missing_created: 0,
      fetched_at: "2026-08-02T00:00:00.000Z",
    });
    assert.match(table, /\(nenhum assinante encontrado\)/);
  });

  /**
   * Antes do fleet review da PR #4751 o caminho vazio devolvia SÓ
   * "(nenhum assinante encontrado)", sem ecoar a janela aplicada. No modo texto
   * — o que o editor usa na mão — isso torna um typo de mês
   * (`--since 2026-06-21` no lugar de `07`) indistinguível de "essa coorte não
   * existe". O rodapé some junto com a tabela, e some justamente quando é a
   * única informação que ainda importa.
   */
  it("resultado vazio ECOA a janela aplicada, pra typo de data não parecer coorte inexistente", () => {
    const table = formatEngagementTable({
      groups: {},
      total_cadastros: 0,
      threshold: 40,
      min_received: null,
      since: "2026-06-21",
      until: "2026-08-02",
      excluded_missing_created: 3,
      fetched_at: "2026-08-02T00:00:00.000Z",
    });
    assert.match(table, /\(nenhum assinante encontrado\)/);
    assert.match(table, /since: 2026-06-21/);
    assert.match(table, /until: 2026-08-02/);
    assert.match(table, /TOTAL cadastros: 0/);
    assert.match(table, /descartados sem `created`: 3/);
  });

  it("não polui o rodapé com o contador quando ninguém foi descartado", () => {
    const table = formatEngagementTable({
      groups: {},
      total_cadastros: 0,
      threshold: 40,
      min_received: null,
      since: "2026-06-21",
      until: null,
      excluded_missing_created: 0,
      fetched_at: "2026-08-02T00:00:00.000Z",
    });
    assert.ok(!table.includes("descartados sem"));
  });

  it("inclui a origem, cadastros e o marcador de instabilidade", () => {
    const table = formatEngagementTable({
      groups: {
        "google-ads": {
          cadastros: 3,
          ativos: 3,
          inativos: 0,
          pending: 0,
          invalid: 0,
          outros_status: 0,
          leitores: 1,
          abertura_agregada: 0.249,
          media_recebidas: 5,
          mediana_recebidas: 3,
          amostra_instavel: true,
          amostra_considerada: 3,
          pre_corte_considerado: 3,
          amostra_vazia: false,
        },
      },
      total_cadastros: 3,
      threshold: 40,
      min_received: null,
      since: null,
      fetched_at: "2026-08-02T00:00:00.000Z",
    });
    assert.ok(table.includes("google-ads"));
    assert.ok(table.includes("24.9%"));
    assert.ok(table.includes("⚠instável"));
  });

  /**
   * #4752 opção 3: `amostra_considerada` existia no tipo desde sempre e nunca
   * aparecia na tabela de texto — a única saída que o editor lê na mão. A
   * coluna "considerados" fecha essa lacuna de legibilidade.
   */
  it("expõe amostra_considerada como coluna na tabela de texto", () => {
    const table = formatEngagementTable({
      groups: {
        "google-ads": {
          // Valores DISTINTOS de propósito: com cadastros === ativos ===
          // amostra_considerada === 5, a asserção casava por acidente em
          // `cadastros` e passaria mesmo se a coluna nova nunca fosse
          // renderizada — achado do fleet review da PR #4757.
          cadastros: 12,
          ativos: 9,
          inativos: 0,
          pending: 0,
          invalid: 0,
          outros_status: 0,
          leitores: 2,
          abertura_agregada: 0.4,
          media_recebidas: 12,
          mediana_recebidas: 12,
          amostra_instavel: false,
          amostra_considerada: 5,
          pre_corte_considerado: 5,
          amostra_vazia: false,
        },
      },
      total_cadastros: 12,
      threshold: 40,
      min_received: null,
      since: null,
      fetched_at: "2026-08-02T00:00:00.000Z",
    });
    assert.match(table, /considerados/);
    // Ancorado na CAUDA da linha do grupo, não em busca livre. Sem isso, a
    // regex casa no primeiro número depois de "google-ads" — que é `cadastros`,
    // não a coluna nova — e passaria mesmo se `amostra_considerada` nunca fosse
    // renderizado. Achado do fleet review da PR #4757, confirmado imprimindo a
    // linha real.
    const linha = table.split("\n").find((l) => l.startsWith("google-ads"));
    assert.ok(linha, "esperava a linha do grupo na tabela");
    assert.match(
      linha!,
      /\s5\s*$/,
      `a coluna "considerados" (5) deveria ser o último campo da linha: ${linha}`,
    );
  });

  /**
   * #4752: o caso PIOR (amostra_considerada === 0) precisa de um marcador tão
   * visível quanto `⚠instável` — antes não tinha nenhum, e a linha parecia
   * "normal" (leitores: 0, abertura%: n/a) sem sinalizar que o denominador
   * inteiro estava vazio.
   */
  it("marca ⚠vazio quando amostra_considerada é zero — nunca junto de ⚠instável", () => {
    const table = formatEngagementTable({
      groups: {
        "campanha-fechada": {
          cadastros: 2,
          ativos: 2,
          inativos: 0,
          pending: 0,
          invalid: 0,
          outros_status: 0,
          leitores: 0,
          abertura_agregada: null,
          media_recebidas: null,
          mediana_recebidas: null,
          amostra_instavel: false,
          amostra_considerada: 0,
          amostra_vazia: true,
        },
      },
      total_cadastros: 2,
      threshold: 40,
      min_received: null,
      since: null,
      fetched_at: "2026-08-02T00:00:00.000Z",
    });
    assert.ok(table.includes("⚠vazio"));
    assert.ok(!table.includes("⚠instável"));
  });
});

// ---------------------------------------------------------------------------
// fetchAllSubscribers — paginação + guard anti-truncamento (#4464)
// mesmo padrão de mock do count-subscriptions-by-utm.test.ts, NUNCA rede real.
// ---------------------------------------------------------------------------

describe("fetchAllSubscribers — paginação (#4464)", () => {
  const mockFetchPages = (pages: Array<Record<string, unknown>>) => {
    let call = 0;
    const orig = globalThis.fetch;
    globalThis.fetch = (async () => ({
      status: 200,
      ok: true,
      headers: { get: () => null },
      json: async () => pages[call++],
    })) as unknown as typeof fetch;
    return { restore: () => { globalThis.fetch = orig; }, calls: () => call };
  };

  it("respeita total_results e drena todas as páginas", async () => {
    const m = mockFetchPages([
      { data: Array.from({ length: 100 }, (_, i) => ({ id: `s${i}`, status: "active" })), total_results: 130, limit: 100 },
      { data: Array.from({ length: 30 }, (_, i) => ({ id: `s${100 + i}`, status: "active" })), total_results: 130, limit: 100 },
    ]);
    try {
      const subs = await fetchAllSubscribers("pub_x", "key_x");
      assert.equal(subs.length, 130);
      assert.equal(m.calls(), 2);
    } finally {
      m.restore();
    }
  });

  it("sem total_results, usa o `limit` reportado pra decidir se há mais", async () => {
    const m = mockFetchPages([
      { data: Array.from({ length: 10 }, () => ({ status: "active" })), limit: 10 },
      { data: Array.from({ length: 3 }, () => ({ status: "active" })), limit: 10 },
    ]);
    try {
      const subs = await fetchAllSubscribers("pub_x", "key_x");
      assert.equal(subs.length, 13);
      assert.equal(m.calls(), 2);
    } finally {
      m.restore();
    }
  });

  it("guard anti-truncamento: aborta (nunca retorna contagem parcial) em drenagem incompleta", async () => {
    const m = mockFetchPages([
      { data: Array.from({ length: 5 }, () => ({ status: "active" })), total_results: 50, limit: 10 },
      { data: [], total_results: 50, limit: 10 }, // página vazia mid-drain
    ]);
    try {
      await assert.rejects(
        fetchAllSubscribers("pub_x", "key_x"),
        /truncado: 5\/50/,
        "deve lançar (não retornar contagem parcial) quando total_results não foi totalmente drenado",
      );
    } finally {
      m.restore();
    }
  });

  it("página vazia sem total_results reportado encerra a drenagem normalmente", async () => {
    const m = mockFetchPages([{ data: [], limit: 100 }]);
    try {
      const subs = await fetchAllSubscribers("pub_x", "key_x");
      assert.equal(subs.length, 0);
    } finally {
      m.restore();
    }
  });
});

// ---------------------------------------------------------------------------
// runCohortEngagement — integração fetch + since + aggregate (mock) (#4464)
// ---------------------------------------------------------------------------

describe("runCohortEngagement — integração com mock (#4464)", () => {
  const mockFetchOnePage = (data: Array<Record<string, unknown>>) => {
    const orig = globalThis.fetch;
    globalThis.fetch = (async () => ({
      status: 200,
      ok: true,
      headers: { get: () => null },
      json: async () => ({ data, total_results: data.length, limit: 100 }),
    })) as unknown as typeof fetch;
    return { restore: () => { globalThis.fetch = orig; } };
  };

  it("aplica --since antes de agregar", async () => {
    const cutoff = parseSinceToEpochSeconds("2026-07-31");
    const m = mockFetchOnePage([
      { id: "old", status: "active", created: cutoff - 86400, utm_source: "google-ads", stats: { total_received: 10, total_unique_opened: 4, open_rate: 40 } },
      { id: "new", status: "active", created: cutoff, utm_source: "google-ads", stats: { total_received: 10, total_unique_opened: 4, open_rate: 40 } },
    ]);
    try {
      const result = await runCohortEngagement("pub_x", "key_x", {
        threshold: 40,
        sinceEpochSeconds: cutoff,
        sinceLabel: "2026-07-31",
      });
      assert.equal(result.total_cadastros, 1, "só o assinante criado na/após a data de corte entra");
      assert.equal(result.groups["google-ads"].cadastros, 1);
      assert.equal(result.since, "2026-07-31");
    } finally {
      m.restore();
    }
  });
});
