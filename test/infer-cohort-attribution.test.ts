/**
 * test/infer-cohort-attribution.test.ts (#5514)
 *
 * Trava o núcleo puro de `infer-cohort-attribution.ts`: quem conta como
 * "sem atribuição", a busca de vizinho mais próximo dentro/fora da janela,
 * e o invariante `inferencia: true` sempre presente quando há palpite.
 * Fixtures sintéticas — nenhuma leitura de `data/` (gitignored/ausente em
 * worktree, ver `context/overnight-dispatch-rules.md` item 4).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  isUnattributed,
  inferCohortAttribution,
  filterByCreatedWindow,
  dateToEpoch,
  parseInferCohortAttributionArgs,
  DEFAULT_WINDOW_MINUTES,
  type AttributionSubscriber,
} from "../scripts/infer-cohort-attribution.ts";

function sub(overrides: Partial<AttributionSubscriber> = {}): AttributionSubscriber {
  return {
    email: "x@example.com",
    created: 1_753_000_000,
    utm_source: "direct",
    utm_medium: "",
    utm_campaign: "",
    referring_site: "",
    ...overrides,
  };
}

describe("isUnattributed", () => {
  it("direct e vazio contam como sem atribuição", () => {
    assert.equal(isUnattributed("direct"), true);
    assert.equal(isUnattributed(""), true);
    assert.equal(isUnattributed(null), true);
    assert.equal(isUnattributed(undefined), true);
    assert.equal(isUnattributed("  Direct  "), true); // trim + case-insensitive
  });

  it("qualquer outro source conta como atribuído", () => {
    assert.equal(isUnattributed("linkedin"), false);
    assert.equal(isUnattributed("clarice"), false);
    assert.equal(isUnattributed("instagram"), false);
  });
});

describe("inferCohortAttribution", () => {
  it("acha o vizinho atribuído mais próximo dentro da janela e marca inferencia:true", () => {
    const base = 1_753_000_000;
    const result = inferCohortAttribution(
      [
        sub({ email: "unattr@x.com", created: base, utm_source: "direct" }),
        sub({ email: "far@x.com", created: base - 3600, utm_source: "linkedin" }), // 1h antes: fora da janela padrão
        sub({ email: "near@x.com", created: base + 600, utm_source: "instagram", utm_medium: "social" }), // 10min depois
      ],
      { windowMinutes: 30 },
    );

    assert.equal(result.unattributed_total, 1);
    assert.equal(result.guessed_count, 1);
    const rec = result.records.find((r) => r.email === "unattr@x.com");
    assert.ok(rec?.guess);
    assert.equal(rec!.guess!.source, "instagram");
    assert.equal(rec!.guess!.neighbor_email, "near@x.com");
    assert.equal(rec!.guess!.distance_seconds, 600);
    assert.equal(rec!.guess!.inferencia, true);
  });

  it("sem vizinho dentro da janela → guess null (nunca força um palpite distante)", () => {
    const base = 1_753_000_000;
    const result = inferCohortAttribution(
      [
        sub({ email: "unattr@x.com", created: base, utm_source: "" }),
        sub({ email: "far@x.com", created: base + 7200, utm_source: "clarice" }), // 2h depois
      ],
      { windowMinutes: 30 },
    );
    assert.equal(result.guessed_count, 0);
    assert.equal(result.records[0].guess, null);
  });

  it("sem nenhum atribuído na base inteira → todos os guesses null", () => {
    const result = inferCohortAttribution([
      sub({ email: "a@x.com", utm_source: "direct" }),
      sub({ email: "b@x.com", utm_source: "" }),
    ]);
    assert.equal(result.attributed_total, 0);
    assert.equal(result.guessed_count, 0);
    assert.ok(result.records.every((r) => r.guess === null));
  });

  it("default window é 30 minutos quando omitido", () => {
    const base = 1_753_000_000;
    const result = inferCohortAttribution([
      sub({ email: "unattr@x.com", created: base, utm_source: "direct" }),
      sub({ email: "near@x.com", created: base + 1500, utm_source: "linkedin" }), // 25min
    ]);
    assert.equal(result.window_minutes, DEFAULT_WINDOW_MINUTES);
    assert.equal(result.guessed_count, 1);
  });

  it("guessed_pct calcula corretamente e não divide por zero", () => {
    const result = inferCohortAttribution([]);
    assert.equal(result.unattributed_total, 0);
    assert.equal(result.guessed_pct, 0);
  });
});

describe("filterByCreatedWindow", () => {
  it("inclui os limites (since/until inclusivos)", () => {
    const items = [{ created: 100 }, { created: 200 }, { created: 300 }];
    const filtered = filterByCreatedWindow(items, 100, 200);
    assert.deepEqual(
      filtered.map((i) => i.created),
      [100, 200],
    );
  });
});

describe("dateToEpoch", () => {
  it("início do dia vs fim do dia", () => {
    const start = dateToEpoch("2026-07-21", false);
    const end = dateToEpoch("2026-07-21", true);
    assert.equal(end - start, 24 * 3600 - 1);
  });

  it("lança em formato inválido", () => {
    assert.throws(() => dateToEpoch("21/07/2026"));
  });
});

describe("parseInferCohortAttributionArgs", () => {
  it("exige --since e --until", () => {
    assert.throws(() => parseInferCohortAttributionArgs(["--window-minutes", "45"]));
  });

  it("aplica defaults quando opcionais omitidos", () => {
    const args = parseInferCohortAttributionArgs(["--since", "2026-07-21", "--until", "2026-08-02"]);
    assert.equal(args.windowMinutes, DEFAULT_WINDOW_MINUTES);
    assert.equal(args.json, false);
    assert.equal(args.snapshot, null);
  });

  it("respeita overrides explícitos", () => {
    const args = parseInferCohortAttributionArgs([
      "--since",
      "2026-07-21",
      "--until",
      "2026-08-02",
      "--window-minutes",
      "45",
      "--snapshot",
      "2026-08-10",
      "--json",
    ]);
    assert.equal(args.windowMinutes, 45);
    assert.equal(args.snapshot, "2026-08-10");
    assert.equal(args.json, true);
  });
});
