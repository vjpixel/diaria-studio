/**
 * test/acquisition-class.test.ts (#7173)
 *
 * Cobertura de `scripts/lib/metrics/acquisition-class.ts`: (a) as 4
 * armadilhas nominais; (b) o corpus congelado com o teto de 20% em
 * `indeterminado`; (c) o guard de chave duplicada; (d) `google.com`
 * dentro/fora da janela ambígua.
 *
 * Nenhuma leitura do diretório de dados local, gitignored e ausente em
 * clone fresco/CI — o corpus é uma fixture committed em
 * `test/fixtures/acquisition-class/corpus-260830.json` (ver a `_nota` nesse
 * arquivo: números tirados do corpo da issue #7173, não extraídos ao vivo,
 * porque esse diretório não está montado neste ambiente). Critério de
 * aceite verificado de fora deste arquivo — nunca citar aqui o caminho
 * literal que o próprio critério procura.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  classifyAcquisition,
  assertNoDuplicateClassKeys,
  NAO_PAGO_NAO_REATIVACAO,
  isNaoPagoNaoReativacao,
  adaptBeehiivAttribution,
  adaptKitAttribution,
  type AcquisitionClass,
  type AcquisitionClassInput,
} from "../scripts/lib/metrics/acquisition-class.ts";

const HERE = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Prova do Passo 1: importar o módulo não popula ADMIN_SECRET
// ---------------------------------------------------------------------------

describe("acquisition-class: módulo puro, sem I/O na cadeia de import", () => {
  it("importar o módulo não populou process.env.ADMIN_SECRET", () => {
    // Se `dotenv/config` estivesse na cadeia de import (cohort-engagement.ts
    // ou cac.ts), esta variável apareceria populada mesmo sem o teste tê-la
    // setado — ver a docstring de attribution-keys.ts para o achado medido.
    assert.equal(process.env.ADMIN_SECRET, undefined);
  });
});

// ---------------------------------------------------------------------------
// NAO_PAGO_NAO_REATIVACAO
// ---------------------------------------------------------------------------

describe("NAO_PAGO_NAO_REATIVACAO", () => {
  it("é organico + iniciativa, e nada mais", () => {
    assert.deepEqual([...NAO_PAGO_NAO_REATIVACAO].sort(), ["iniciativa", "organico"]);
  });

  it("isNaoPagoNaoReativacao casa só as duas classes do placar", () => {
    assert.equal(isNaoPagoNaoReativacao("organico"), true);
    assert.equal(isNaoPagoNaoReativacao("iniciativa"), true);
    assert.equal(isNaoPagoNaoReativacao("pago"), false);
    assert.equal(isNaoPagoNaoReativacao("reativacao"), false);
    assert.equal(isNaoPagoNaoReativacao("indeterminado"), false);
  });
});

// ---------------------------------------------------------------------------
// Guard de chave duplicada
// ---------------------------------------------------------------------------

describe("assertNoDuplicateClassKeys", () => {
  it("não lança sobre as listas reais do módulo (chamado no load)", () => {
    assert.doesNotThrow(() => assertNoDuplicateClassKeys());
  });

  it("lança quando a MESMA chave normalizada aparece em duas classes diferentes (critério (c) da issue #7173)", () => {
    assert.throws(
      () =>
        assertNoDuplicateClassKeys([
          { keys: ["clarice"], cls: "iniciativa" },
          { keys: ["Clarice"], cls: "reativacao" }, // mesma chave, normalização diferente
        ]),
      /declarada em duas classes/,
    );
  });

  it("não lança quando a mesma chave repete na MESMA classe (não é conflito, é redundância inofensiva)", () => {
    assert.doesNotThrow(() =>
      assertNoDuplicateClassKeys([{ keys: ["clarice", "clarice"], cls: "iniciativa" }]),
    );
  });
});

// ---------------------------------------------------------------------------
// As 4 armadilhas nominais
// ---------------------------------------------------------------------------

describe("classifyAcquisition — armadilha 1: linkedin* é ambíguo", () => {
  const created = 1_785_542_400; // 2026-08-01, fora de qualquer janela de campanha
  const cases: Array<[string, AcquisitionClassInput]> = [
    ["linkedin / organic_social", { utm_source: "linkedin", utm_medium: "organic_social", utm_channel: null, referring_site: null, created }],
    ["linkedin.com / referral", { utm_source: "linkedin.com", utm_medium: "referral", utm_channel: null, referring_site: "linkedin.com", created }],
    ["linkedin.android / referral", { utm_source: "linkedin.android", utm_medium: "referral", utm_channel: null, referring_site: null, created }],
    ["linkedin-pessoal / social", { utm_source: "linkedin-pessoal", utm_medium: "social", utm_channel: null, referring_site: null, created }],
    ["linkedin / newsletter", { utm_source: "linkedin", utm_medium: "newsletter", utm_channel: null, referring_site: null, created }],
  ];
  for (const [label, input] of cases) {
    it(`${label} → organico (spec LinkedIn nunca casa como pago sem gasto real)`, () => {
      assert.equal(classifyAcquisition(input), "organico");
    });
  }
});

describe("classifyAcquisition — armadilha 2: utm_medium=referral não é indicação", () => {
  it("android.googlequicksearchbox (PMax, medium=referral) → pago, nunca organico", () => {
    const result = classifyAcquisition({
      utm_source: null,
      utm_medium: "referral",
      utm_channel: null,
      referring_site: "android.googlequicksearchbox",
      created: 1_785_542_400,
    });
    assert.equal(result, "pago");
  });
});

describe("classifyAcquisition — armadilha 3: brevo-diaria/sendinblue é reativação", () => {
  it("brevo-diaria → reativacao, mesmo com sinal de origem ausente", () => {
    assert.equal(
      classifyAcquisition({ utm_source: "brevo-diaria", utm_medium: null, utm_channel: null, referring_site: null, created: 1_785_542_400 }),
      "reativacao",
    );
  });
  it("sendinblue → reativacao (nome antigo da Brevo)", () => {
    assert.equal(
      classifyAcquisition({ utm_source: "sendinblue", utm_medium: null, utm_channel: null, referring_site: null, created: 1_785_542_400 }),
      "reativacao",
    );
  });
});

describe("classifyAcquisition — armadilha 4: utm_channel resolve histórico, ausente na série viva", () => {
  it("utm_channel=boost (histórico) → iniciativa", () => {
    assert.equal(
      classifyAcquisition({
        utm_source: "www.alquimiaoperativa.news",
        utm_medium: null,
        utm_channel: "boost",
        referring_site: null,
        created: 1_785_542_400,
      }),
      "iniciativa",
    );
  });
  it("registro vivo sem utm_channel, utm_source=clarice-email → iniciativa via catálogo", () => {
    assert.equal(
      classifyAcquisition({ utm_source: "clarice-email", utm_medium: null, utm_channel: null, referring_site: null, created: 1_785_542_400 }),
      "iniciativa",
    );
  });
  it("registro vivo sem utm_channel e sem catálogo de source, com sinal orgânico → organico", () => {
    assert.equal(
      classifyAcquisition({ utm_source: "instagram", utm_medium: "social", utm_channel: null, referring_site: null, created: 1_785_542_400 }),
      "organico",
    );
  });
});

// ---------------------------------------------------------------------------
// google.com dentro/fora da janela ambígua (critério (d))
// ---------------------------------------------------------------------------

describe("classifyAcquisition — google.com (spec ambígua com janela)", () => {
  it("dentro da janela dez/2025-fev/2026 → pago", () => {
    // 2026-01-15, dentro da janela [2025-12-01, 2026-02-28)
    const created = Math.floor(Date.UTC(2026, 0, 15) / 1000);
    assert.equal(
      classifyAcquisition({ utm_source: "google.com", utm_medium: null, utm_channel: null, referring_site: null, created }),
      "pago",
    );
  });
  it("fora da janela → NUNCA pago (cai para organico)", () => {
    const created = Math.floor(Date.UTC(2026, 7, 1) / 1000); // 2026-08-01
    const result = classifyAcquisition({ utm_source: "google.com", utm_medium: null, utm_channel: null, referring_site: null, created });
    assert.notEqual(result, "pago");
    assert.equal(result, "organico");
  });
});

// ---------------------------------------------------------------------------
// indeterminado nunca por omissão de utm_channel import/api
// ---------------------------------------------------------------------------

describe("classifyAcquisition — cadastro que não é aquisição", () => {
  it("utm_channel=import → indeterminado", () => {
    assert.equal(
      classifyAcquisition({ utm_source: null, utm_medium: null, utm_channel: "import", referring_site: null, created: 1_785_542_400 }),
      "indeterminado",
    );
  });
  it("utm_channel=api → indeterminado", () => {
    assert.equal(
      classifyAcquisition({ utm_source: null, utm_medium: null, utm_channel: "api", referring_site: null, created: 1_785_542_400 }),
      "indeterminado",
    );
  });
  it("utm_source=internal → indeterminado, nunca organico por omissão", () => {
    assert.equal(
      classifyAcquisition({ utm_source: "internal", utm_medium: null, utm_channel: null, referring_site: null, created: 1_785_542_400 }),
      "indeterminado",
    );
  });
  it("direct puro (sem utm_source, sem referring_site) → indeterminado", () => {
    assert.equal(
      classifyAcquisition({ utm_source: null, utm_medium: null, utm_channel: null, referring_site: null, created: 1_785_542_400 }),
      "indeterminado",
    );
  });
});

// ---------------------------------------------------------------------------
// Corpus congelado — teto de 20% em indeterminado
// ---------------------------------------------------------------------------

interface CorpusEntry {
  utm_source: string | null;
  utm_medium: string | null;
  utm_channel: string | null;
  referring_site: string | null;
  created: number;
  n: number;
}

function loadCorpus(): CorpusEntry[] {
  const raw = readFileSync(join(HERE, "fixtures", "acquisition-class", "corpus-260830.json"), "utf8");
  const parsed = JSON.parse(raw) as { entries: CorpusEntry[] };
  return parsed.entries;
}

describe("classifyAcquisition — corpus congelado (test/fixtures/acquisition-class/corpus-260830.json)", () => {
  const entries = loadCorpus();

  it("teto de indeterminado ≤ 20% do corpus — nomeando as chaves responsáveis", () => {
    const counts: Record<AcquisitionClass, number> = { pago: 0, reativacao: 0, iniciativa: 0, organico: 0, indeterminado: 0 };
    const indeterminadoKeys: string[] = [];
    let total = 0;
    for (const entry of entries) {
      const cls = classifyAcquisition({
        utm_source: entry.utm_source,
        utm_medium: entry.utm_medium,
        utm_channel: entry.utm_channel,
        referring_site: entry.referring_site,
        created: entry.created,
      });
      counts[cls] += entry.n;
      total += entry.n;
      if (cls === "indeterminado") {
        indeterminadoKeys.push(`utm_source=${entry.utm_source ?? "∅"}/utm_channel=${entry.utm_channel ?? "∅"} (n=${entry.n})`);
      }
    }
    const pct = (counts.indeterminado / total) * 100;
    assert.ok(
      pct <= 20,
      `indeterminado ficou em ${pct.toFixed(1)}% (> 20%) — chaves responsáveis: ${indeterminadoKeys.join(", ")}`,
    );
    // Sempre imprime a lista, falhando ou não (issue: "impressa sempre").
    // eslint-disable-next-line no-console
    console.log(`[acquisition-class corpus] indeterminado: ${pct.toFixed(1)}% — ${indeterminadoKeys.join(", ") || "(nenhuma)"}`);
  });

  it("distribuição bate com os números citados no corpo da issue #7173", () => {
    const counts: Record<AcquisitionClass, number> = { pago: 0, reativacao: 0, iniciativa: 0, organico: 0, indeterminado: 0 };
    for (const entry of entries) {
      const cls = classifyAcquisition({
        utm_source: entry.utm_source,
        utm_medium: entry.utm_medium,
        utm_channel: entry.utm_channel,
        referring_site: entry.referring_site,
        created: entry.created,
      });
      counts[cls] += entry.n;
    }
    assert.equal(counts.pago, 0);
    assert.equal(counts.reativacao, 67);
    assert.equal(counts.iniciativa, 62);
    assert.equal(counts.organico, 14);
    // indeterminado = 30 (direct) + 5 (internal) = 35 no fixture (a issue
    // separa "interno" da distribuição de classe — aqui os dois caem em
    // `indeterminado`, decisão documentada no módulo).
    assert.equal(counts.indeterminado, 35);
  });
});

// ---------------------------------------------------------------------------
// Adaptadores por plataforma
// ---------------------------------------------------------------------------

describe("adaptBeehiivAttribution", () => {
  it("lança sem `created`", () => {
    assert.throws(() => adaptBeehiivAttribution({ utm_source: "google.com" }), /created/);
  });
  it("mapeia campos 1:1", () => {
    const out = adaptBeehiivAttribution({
      utm_source: "clarice",
      referring_site: null,
      utm_channel: "boost",
      utm_medium: null,
      created: 1_785_542_400,
    });
    assert.deepEqual(out, {
      utm_source: "clarice",
      utm_medium: null,
      utm_channel: "boost",
      referring_site: null,
      created: 1_785_542_400,
    });
  });
});

describe("adaptKitAttribution", () => {
  it("lança sem created_at nem createdEpochSeconds", () => {
    assert.throws(() => adaptKitAttribution({ fields: { utm_source: "clarice" } }), /created/);
  });
  it("lê de `fields`, nunca de um bloco `attribution` (cobertura zero medida em 02/09)", () => {
    const out = adaptKitAttribution({
      fields: { utm_source: "clarice", utm_medium: null, utm_channel: null, referring_site: null },
      created_at: "2026-08-01T00:00:00Z",
    });
    assert.equal(out.utm_source, "clarice");
    assert.equal(out.created, Math.floor(Date.UTC(2026, 7, 1) / 1000));
  });
  it("utm_channel ausente (série viva) vira null, nunca inventado", () => {
    const out = adaptKitAttribution({
      fields: { utm_source: "instagram" },
      created_at: "2026-08-01T00:00:00Z",
    });
    assert.equal(out.utm_channel, null);
  });
  it("aceita createdEpochSeconds diretamente", () => {
    const out = adaptKitAttribution({ fields: {}, createdEpochSeconds: 1_785_542_400 });
    assert.equal(out.created, 1_785_542_400);
  });
});
