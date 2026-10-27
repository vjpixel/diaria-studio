/**
 * #8548 item 1 — `doi-confirmacao-dia` por canal pago e ligada no painel.
 *
 * Regressões cobertas:
 *  - a safra de confirmação passa a carregar o canal pago do cadastro
 *    (`utm_source` do Kit), com a mesma precedência do relatório de
 *    confirmação (primeiro valor visto vence; `""` = orgânico; sem dado =
 *    desconhecido, nunca orgânico);
 *  - a métrica aceita a decomposição `canal` e respeita o piso n<5 por canal;
 *  - o painel do Studio deixa de chamar a métrica com `deps: {}` (o que a
 *    deixava `indeterminado` para sempre) e mostra a safra mais recente que
 *    já resolveu.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildDoiConfirmationCohort,
  findLatestResolvedDoiCohort,
  resolveCohortCanal,
  serializeSubscriberStateRecords,
  type SubscriberStateRecord,
} from "../scripts/lib/subscriber-state-snapshot.ts";
import { doiConfirmacaoPorCanal, getMetric, type Janela } from "../scripts/lib/metrics/registry.ts";
import { loadDoiBaselineInput } from "../scripts/studio-ui/studio-metrics.ts";

const rec = (id: number, state: string, utm?: string, created = "2026-10-01T15:00:00.000Z"): SubscriberStateRecord => ({
  id,
  state,
  created_at: created,
  ...(utm !== undefined ? { utm_source: utm } : {}),
});

describe("resolveCohortCanal (#8548)", () => {
  it("usa o utm_source do nascimento quando presente", () => {
    assert.equal(resolveCohortCanal(1, rec(1, "inactive", "meta-ads"), []), "meta-ads");
  });

  it("sufixo de campanha conta no canal base", () => {
    assert.equal(resolveCohortCanal(1, rec(1, "inactive", "google-ads-260901"), []), "google-ads");
  });

  it("nascimento sem o campo: o PRIMEIRO valor de um snapshot posterior vence o último (reativar sobrescreve, #8235)", () => {
    const later = [
      new Map([[1, rec(1, "inactive", "google-ads")]]),
      new Map([[1, rec(1, "active", "brevo-reativar")]]),
    ];
    assert.equal(resolveCohortCanal(1, rec(1, "inactive"), later), "google-ads");
  });

  it("valor posterior vence o '' do nascimento (lag de fields do endpoint de lista)", () => {
    const later = [new Map([[1, rec(1, "inactive", "meta-ads")]])];
    assert.equal(resolveCohortCanal(1, rec(1, "inactive", ""), later), "meta-ads");
  });

  it("'' no nascimento sem valor posterior = orgânico", () => {
    assert.equal(resolveCohortCanal(1, rec(1, "inactive", ""), [new Map([[1, rec(1, "active", "")]])]), "orgânico");
  });

  it("sem nenhum dado = desconhecido, nunca orgânico", () => {
    assert.equal(resolveCohortCanal(1, rec(1, "inactive"), [new Map([[1, rec(1, "active")]])]), "(utm_source desconhecido)");
  });
});

describe("buildDoiConfirmationCohort carrega o canal (#8548)", () => {
  it("cada membro da safra sai com o canal resolvido", () => {
    const snaps = new Map<string, SubscriberStateRecord[]>([
      ["2026-10-01", [rec(1, "inactive", "meta-ads"), rec(2, "inactive"), rec(3, "inactive", "")]],
      ["2026-10-03", [rec(1, "active", "meta-ads"), rec(2, "inactive", "google-ads"), rec(3, "inactive", "")]],
    ]);
    const r = buildDoiConfirmationCohort(snaps, "2026-10-01");
    assert.deepEqual(
      r.cohort.sort((a, b) => a.id - b.id),
      [
        { id: 1, confirmed: true, canal: "meta-ads" },
        { id: 2, confirmed: false, canal: "google-ads" },
        { id: 3, confirmed: false, canal: "orgânico" },
      ],
    );
  });
});

describe("doi-confirmacao-dia: decomposição canal (#8548)", () => {
  const janela: Janela = { de: "2026-10-01", ate: "2026-10-01", granularidade: "dia", fuso: "BRT" };
  const def = getMetric("doi-confirmacao-dia")!;

  it("declara a decomposição canal", () => {
    assert.deepEqual([...def.decomposicoes], ["canal"]);
  });

  it("taxa por canal, maior safra primeiro, canal com n<5 sai null", async () => {
    const cohort = [
      ...Array.from({ length: 6 }, (_, i) => ({ id: i, confirmed: i < 3, canal: "meta-ads" })),
      ...Array.from({ length: 5 }, (_, i) => ({ id: 100 + i, confirmed: i < 4, canal: "google-ads" })),
      { id: 200, confirmed: true, canal: "orgânico" },
      { id: 201, confirmed: false },
    ];
    const r = await def.computar({ janela, decomposicao: "canal", deps: { cohort } });
    assert.equal(r.qualidade, "exato");
    assert.equal(r.valor, 8 / 13);
    assert.deepEqual(r.series, [
      { chave: "meta-ads", valor: 0.5 },
      { chave: "google-ads", valor: 0.8 },
      { chave: "(utm_source desconhecido)", valor: null },
      { chave: "orgânico", valor: null },
    ]);
  });

  it("sem decomposição pedida não anexa série", async () => {
    const cohort = Array.from({ length: 5 }, (_, i) => ({ id: i, confirmed: true, canal: "meta-ads" }));
    const r = await def.computar({ janela, deps: { cohort } });
    assert.equal(r.series, undefined);
  });

  it("safra sem filtro DOI (piso) também leva a série", async () => {
    const cohort = Array.from({ length: 5 }, (_, i) => ({ id: i, confirmed: i === 0, canal: "google-ads" }));
    const r = await def.computar({ janela, decomposicao: "canal", deps: { cohort, semFiltroDoi: true } });
    assert.equal(r.qualidade, "piso");
    assert.deepEqual(r.series, [{ chave: "google-ads", valor: 0.2 }]);
  });

  it("doiConfirmacaoPorCanal é puro e não muta a safra", () => {
    const cohort = [{ id: 1, confirmed: true, canal: "meta-ads" }];
    const copia = structuredClone(cohort);
    doiConfirmacaoPorCanal(cohort);
    assert.deepEqual(cohort, copia);
  });
});

describe("findLatestResolvedDoiCohort (#8548)", () => {
  it("pula a safra de hoje (imatura) e devolve a mais recente que resolve", () => {
    const snaps = new Map<string, SubscriberStateRecord[]>([
      ["2026-10-01", [rec(1, "inactive", "meta-ads", "2026-10-01T15:00:00.000Z")]],
      ["2026-10-02", [rec(2, "inactive", "google-ads", "2026-10-02T15:00:00.000Z")]],
      ["2026-10-03", [rec(1, "active"), rec(2, "inactive"), rec(3, "inactive", "", "2026-10-03T15:00:00.000Z")]],
    ]);
    const found = findLatestResolvedDoiCohort(snaps);
    assert.equal(found.cohortDate, "2026-10-01");
  });

  it("sem snapshot nenhum devolve motivo", () => {
    const found = findLatestResolvedDoiCohort(new Map());
    assert.equal(found.cohortDate, null);
    assert.match((found as { motivoIndeterminado: string }).motivoIndeterminado, /nenhum snapshot/);
  });

  it("nenhuma safra resolvida devolve o motivo da mais recente", () => {
    const snaps = new Map<string, SubscriberStateRecord[]>([["2026-10-03", [rec(3, "inactive", "", "2026-10-03T15:00:00.000Z")]]]);
    const found = findLatestResolvedDoiCohort(snaps);
    assert.equal(found.cohortDate, null);
    assert.match((found as { motivoIndeterminado: string }).motivoIndeterminado, /menos de 2 snapshots/);
  });
});

describe("Studio: loadDoiBaselineInput liga a métrica no painel (#8548)", () => {
  it("sem data/ devolve null (comportamento antigo)", () => {
    const dir = mkdtempSync(join(tmpdir(), "doi-baseline-"));
    try {
      assert.equal(loadDoiBaselineInput(dir), null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("com snapshots, resolve a safra mais recente e a métrica sai exata com série por canal", async () => {
    const dir = mkdtempSync(join(tmpdir(), "doi-baseline-"));
    try {
      const root = join(dir, "subscriber-state-snapshots", "kit");
      const write = (date: string, records: SubscriberStateRecord[]) => {
        mkdirSync(join(root, date), { recursive: true });
        writeFileSync(join(root, date, "subscribers.jsonl"), serializeSubscriberStateRecords(records));
      };
      const born = Array.from({ length: 5 }, (_, i) => rec(i + 1, "inactive", "meta-ads"));
      write("2026-10-01", born);
      write("2026-10-03", born.map((r, i) => ({ ...r, state: i < 2 ? "active" : "inactive" })));
      const input = loadDoiBaselineInput(dir);
      assert.ok(input);
      assert.equal(input.janela.de, "2026-10-01");
      const r = await getMetric("doi-confirmacao-dia")!.computar({
        janela: input.janela,
        decomposicao: "canal",
        deps: input.deps,
      });
      assert.equal(r.qualidade, "piso"); // snapshot sem doi_form: a safra é piso
      assert.equal(r.valor, 0.4);
      assert.deepEqual(r.series, [{ chave: "meta-ads", valor: 0.4 }]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
