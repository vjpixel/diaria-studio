/**
 * research-review-dates.test.ts (#1112)
 *
 * Tests dos helpers puros do `scripts/research-review-dates.ts`:
 * - `unwrapCategorized`: aceita `{kept: {...}}` wrapper ou shape direto
 * - `applyVerifyResults`: aplica datas verified mutando categorized
 *
 * Não testa o `main()` end-to-end — esse depende de network (verifyDate
 * faz fetch real). Cobertura via integration test em smoke-pipeline.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  unwrapCategorized,
  applyVerifyResults,
  buildReviewStats,
} from "../scripts/research-review-dates.ts";
import type { DateVerifyResult } from "../scripts/verify-dates.ts";
import { filterDateWindow } from "../scripts/filter-date-window.ts";

function fakeResult(
  url: string,
  changed: boolean,
  fetchFailed: boolean,
  verifiedDate: string | null,
  dateUnverified = false,
): DateVerifyResult {
  return {
    url,
    original_date: "2026-05-01",
    verified_date: verifiedDate,
    changed,
    fetch_failed: fetchFailed,
    date_unverified: dateUnverified,
    fallback_strategy: "html-meta",
  } as DateVerifyResult;
}

describe("unwrapCategorized (#1112)", () => {
  it("aceita shape direto {lancamento, radar, ...}", () => {
    const input = { lancamento: [{ url: "a", date: "2026-05-01" }] };
    const result = unwrapCategorized(input);
    assert.deepEqual(result, input);
  });

  it("desempacota wrapper {kept: {...}} (output de filter-date-window)", () => {
    const inner = { lancamento: [{ url: "a", date: "2026-05-01" }] };
    const result = unwrapCategorized({ kept: inner });
    assert.deepEqual(result, inner);
  });

  it("rejeita input null/string/array", () => {
    assert.throws(() => unwrapCategorized(null));
    assert.throws(() => unwrapCategorized("string"));
    assert.throws(() => unwrapCategorized(42));
  });

  it("aceita object com buckets vazios", () => {
    const result = unwrapCategorized({ lancamento: [], radar: [
        ] });
    assert.deepEqual(result, { lancamento: [], radar: [] });
  });
});

describe("applyVerifyResults (#1112)", () => {
  it("aplica verified_date quando changed && !fetch_failed", () => {
    const cat = {
      lancamento: [{ url: "u1", date: "2026-05-01" }],
      radar: [
      ],
    };
    const results = [fakeResult("u1", true, false, "2026-05-10")];
    const stats = applyVerifyResults(cat, results);
    assert.equal(cat.lancamento[0].date, "2026-05-10", "data foi corrigida");
    assert.equal(stats.dateCorrected, 1);
    assert.equal(stats.fetchFailed, 0);
  });

  it("preserva data original quando changed=false", () => {
    const cat = {
      lancamento: [{ url: "u1", date: "2026-05-01" }],
      radar: [],
    };
    const results = [fakeResult("u1", false, false, "2026-05-01")];
    applyVerifyResults(cat, results);
    assert.equal(cat.lancamento[0].date, "2026-05-01");
  });

  it("preserva data original quando fetch_failed (e marca date_unverified)", () => {
    const cat = {
      lancamento: [{ url: "u1", date: "2026-05-01" }] as Array<{ url: string; date: string; date_unverified?: boolean }>,
      radar: [],
    };
    const results = [fakeResult("u1", true, true, null, true)];
    const stats = applyVerifyResults(cat, results);
    assert.equal(cat.lancamento[0].date, "2026-05-01", "data original preservada");
    assert.equal(cat.lancamento[0].date_unverified, true, "date_unverified copiado");
    assert.equal(stats.dateCorrected, 0);
    assert.equal(stats.fetchFailed, 1);
  });

  it("aplica em múltiplos buckets na mesma chamada", () => {
    const cat = {
      lancamento: [{ url: "u1", date: "2026-05-01" }],
      radar: [
        { url: "u2", date: "2026-05-02" },
        { url: "u3", date: "2026-05-03" }
      ],
    };
    const results = [
      fakeResult("u1", true, false, "2026-05-10"),
      fakeResult("u2", true, false, "2026-05-11"),
      fakeResult("u3", false, false, "2026-05-03"),
    ];
    const stats = applyVerifyResults(cat, results);
    assert.equal(cat.lancamento[0].date, "2026-05-10");
    assert.equal(cat.radar[0].date, "2026-05-11");
    assert.equal(cat.radar[1].date, "2026-05-03");
    assert.equal(stats.dateCorrected, 2);
  });

  it("ignora resultados sem entry correspondente no categorized", () => {
    const cat = {
      lancamento: [{ url: "u1", date: "2026-05-01" }],
      radar: [],
    };
    const results = [
      fakeResult("u1", true, false, "2026-05-10"),
      fakeResult("u-stale", true, false, "2026-05-15"),
    ];
    const stats = applyVerifyResults(cat, results);
    assert.equal(cat.lancamento[0].date, "2026-05-10");
    assert.equal(stats.dateCorrected, 1, "só conta entries que existiam");
  });

  it("não corrige quando verified_date é null mesmo com changed=true", () => {
    // edge case: API retornou changed=true mas verified_date=null (fetch ok mas no date found)
    const cat = {
      lancamento: [{ url: "u1", date: "2026-05-01" }],
      radar: [],
    };
    const results = [fakeResult("u1", true, false, null)];
    const stats = applyVerifyResults(cat, results);
    assert.equal(cat.lancamento[0].date, "2026-05-01", "preserva original quando verified=null");
    assert.equal(stats.dateCorrected, 0);
  });

  it("processa bucket vazio sem erro", () => {
    const cat = {
      lancamento: [],
      radar: [],
    };
    const stats = applyVerifyResults(cat, []);
    assert.equal(stats.dateCorrected, 0);
    assert.equal(stats.fetchFailed, 0);
  });

  it("ignora bucket ausente do categorized (defensive)", () => {
    const cat = { lancamento: [{ url: "u1", date: "2026-05-01" }] };
    const results = [fakeResult("u1", true, false, "2026-05-10")];
    const stats = applyVerifyResults(cat, results);
    assert.equal(stats.dateCorrected, 1);
  });
});

// ---------------------------------------------------------------------------
// #2371 — published_at=null deve sempre resultar em date_unverified=true
// Regressão: TPU Developer Hub entrou com published_at: null sem flag.
// ---------------------------------------------------------------------------

describe("applyVerifyResults — #2371 date_unverified para null-date articles", () => {
  it("artigo com date=null, published_at=null, fetch ok mas sem data → date_unverified=true", () => {
    // Caso real: TPU Developer Hub. Fetch não falhou, mas data não foi encontrada.
    // Antes do fix: date_unverified=false (era alias de fetch_failed apenas).
    // Após fix: date_unverified=true quando verified_date=null e sem fallback.
    const cat = {
      radar: [{
        url: "https://developers.googleblog.com/tpu-dev-hub",
        date: null,
        published_at: null,
        title: "TPU Developer Hub",
      }] as Array<{ url: string; date: null | string; published_at: null | string; title: string; date_unverified?: boolean }>,
    };
    // fetch_failed=false, verified_date=null → o bug: date_unverified era false
    const results: DateVerifyResult[] = [{
      url: "https://developers.googleblog.com/tpu-dev-hub",
      original_date: "",
      verified_date: null,
      changed: false,
      fetch_failed: false,
      date_unverified: false, // ← como verify-dates.ts produzia antes do fix
    }];
    applyVerifyResults(cat, results);
    assert.equal(
      cat.radar[0].date_unverified,
      true,
      "artigo com published_at=null deve ter date_unverified=true após verify sem data",
    );
  });

  it("artigo com date=null, published_at=null, sem resultado de verify → date_unverified=true", () => {
    // Caso defensivo: artigo não entrou no batch de verify (edge case de dedup/skip).
    const cat = {
      lancamento: [{
        url: "https://example.com/no-verify",
        date: null,
        published_at: null,
        title: "No verify result",
      }] as Array<{ url: string; date: null | string; published_at: null | string; title: string; date_unverified?: boolean }>,
    };
    applyVerifyResults(cat, []); // sem resultado
    assert.equal(
      cat.lancamento[0].date_unverified,
      true,
      "artigo sem resultado de verify e sem data deve ter date_unverified=true",
    );
  });

  it("artigo com date=null mas published_at preenchido → NÃO recebe date_unverified forçado", () => {
    // published_at é um fallback válido — não forçar date_unverified só pelo date=null
    const cat = {
      radar: [{
        url: "https://example.com/has-published-at",
        date: null,
        published_at: "2026-06-15",
        title: "Has published_at",
      }] as Array<{ url: string; date: null | string; published_at: null | string; title: string; date_unverified?: boolean }>,
    };
    const results: DateVerifyResult[] = [{
      url: "https://example.com/has-published-at",
      original_date: "",
      verified_date: null,
      changed: false,
      fetch_failed: false,
      date_unverified: false,
    }];
    applyVerifyResults(cat, results);
    // Com published_at preenchido, date_unverified NÃO deve ser forçado a true.
    // filterDateWindow ainda vai marcar como unverified (fallback não-verificado),
    // mas não é responsabilidade de applyVerifyResults.
    assert.equal(
      cat.radar[0].date_unverified,
      false,
      "published_at preenchido → date_unverified não deve ser forçado pelo applyVerifyResults",
    );
  });

  it("artigo com verified_date preenchido → date_unverified respeita o resultado de verify", () => {
    // Quando verify encontrou a data, não forçar date_unverified.
    const cat = {
      radar: [{
        url: "https://example.com/verified",
        date: null,
        published_at: null,
        title: "Verified article",
      }] as Array<{ url: string; date: null | string; published_at: null | string; title: string; date_unverified?: boolean }>,
    };
    const results: DateVerifyResult[] = [{
      url: "https://example.com/verified",
      original_date: "",
      verified_date: "2026-06-15",
      changed: true,
      fetch_failed: false,
      date_unverified: false,
    }];
    applyVerifyResults(cat, results);
    assert.equal(cat.radar[0].date_unverified, false, "data verificada → date_unverified=false");
  });
});

// ---------------------------------------------------------------------------
// #4656 — buildReviewStats propaga editorSubmittedLost do filterDateWindow
// ---------------------------------------------------------------------------

describe("buildReviewStats (#4656)", () => {
  it("editorSubmittedLost fica [] no caminho normal (editor_submitted poupado pelo guard)", () => {
    const filterResult = filterDateWindow(
      {
        lancamento: [
          { url: "https://openai.com/x", title: "OpenAI post", date: null, flag: "editor_submitted" },
        ],
        radar: [],
      },
      "2026-08-06",
      3,
    );
    const stats = buildReviewStats(1, 0, 1, filterResult);
    assert.deepEqual(stats.editorSubmittedLost, []);
    assert.equal(stats.removed_date_window, 0);
    assert.equal(stats.total_output, 1, "o artigo editor_submitted sobreviveu ao filtro");
  });

  it("propaga editorSubmittedLost não-vazio quando presente no filterResult (defesa-em-profundidade)", () => {
    // Simula o caso hipotético em que o guard de filter-date-window.ts falhou
    // e um editor_submitted acabou em `removed` mesmo assim — buildReviewStats
    // precisa repassar isso pro stats sem perder a informação no caminho.
    const filterResult = {
      kept: { lancamento: [], radar: [], use_melhor: [], video: [] },
      removed: [
        {
          url: "https://openai.com/x",
          title: "OpenAI post",
          date: null,
          bucket: "lancamento",
          reason: "date_window" as const,
          source_field: "date" as const,
          detail: "date null < cutoff 2026-08-03",
          editor_submitted: true,
        },
      ],
      cutoff: "2026-08-03",
      anchor: "2026-08-06",
      editorSubmittedLost: [
        {
          url: "https://openai.com/x",
          title: "OpenAI post",
          date: null,
          bucket: "lancamento",
          reason: "date_window" as const,
          source_field: "date" as const,
          detail: "date null < cutoff 2026-08-03",
          editor_submitted: true,
        },
      ],
    };
    const stats = buildReviewStats(1, 0, 1, filterResult);
    assert.equal(stats.editorSubmittedLost.length, 1);
    assert.equal(stats.editorSubmittedLost[0].url, "https://openai.com/x");
    assert.equal(stats.editorSubmittedLost[0].detail, "date null < cutoff 2026-08-03");
  });
});

// ---------------------------------------------------------------------------
// #4685 (follow-up do #4656) — buildReviewStats propaga dateWindowSpared:
// `date_window_spared` era gravado por filter-date-window.ts mas nunca lido
// em lugar nenhum do pipeline; o gate da Etapa 1 precisa enxergar quando a
// isenção incondicional de fato salvou uma submissão fora da janela.
// ---------------------------------------------------------------------------

describe("buildReviewStats — dateWindowSpared (#4685)", () => {
  it("popula dateWindowSpared quando editor_submitted com data verificada e fora da janela é poupado", () => {
    const filterResult = filterDateWindow(
      {
        lancamento: [],
        radar: [
          {
            url: "https://a.com/old-but-submitted",
            title: "Antigo mas enviado pelo editor",
            date: "2026-04-10",
            flag: "editor_submitted",
          },
        ],
      },
      "2026-04-24",
      3,
    );
    const stats = buildReviewStats(1, 0, 0, filterResult);
    assert.equal(stats.dateWindowSpared.length, 1);
    assert.equal(stats.dateWindowSpared[0].url, "https://a.com/old-but-submitted");
    assert.equal(stats.dateWindowSpared[0].title, "Antigo mas enviado pelo editor");
    assert.equal(stats.dateWindowSpared[0].bucket, "radar");
  });

  it("NÃO marca dateWindowSpared quando o editor_submitted está dentro da janela (isenção não foi necessária)", () => {
    const filterResult = filterDateWindow(
      {
        lancamento: [],
        radar: [
          {
            url: "https://a.com/recent-submitted",
            title: "Recente e enviado pelo editor",
            date: "2026-04-23",
            flag: "editor_submitted",
          },
        ],
      },
      "2026-04-24",
      3,
    );
    const stats = buildReviewStats(1, 0, 0, filterResult);
    assert.deepEqual(stats.dateWindowSpared, []);
  });

  it("NÃO marca dateWindowSpared quando date é null (benefício da dúvida, não isenção de janela)", () => {
    const filterResult = filterDateWindow(
      {
        lancamento: [
          { url: "https://openai.com/x", title: "OpenAI post", date: null, flag: "editor_submitted" },
        ],
        radar: [],
      },
      "2026-08-06",
      3,
    );
    const stats = buildReviewStats(1, 0, 1, filterResult);
    assert.deepEqual(stats.dateWindowSpared, []);
  });
});
