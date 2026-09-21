import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import {
  snapshotRootDefault,
  snapshotDirPath,
  snapshotJsonlPath,
  serializeSubscriberStateRecord,
  serializeSubscriberStateRecords,
  parseSubscriberStateJsonl,
  listSubscriberStateSnapshotDates,
  readSubscriberStateSnapshotFile,
  loadAllSubscriberStateSnapshots,
  diffSubscriberStateSnapshots,
  newlyActiveSince,
  buildDoiConfirmationCohort,
  type SubscriberStateRecord,
} from "../scripts/lib/subscriber-state-snapshot.ts";

function tmpDir(): string {
  return mkdtempSync(resolve(tmpdir(), "subscriber-state-snapshot-test-"));
}

// ---------------------------------------------------------------------------
// Paths / (de)serialização
// ---------------------------------------------------------------------------

describe("paths + (de)serialização", () => {
  it("snapshotRootDefault/dirPath/jsonlPath montam o caminho esperado", () => {
    const root = snapshotRootDefault("/data");
    assert.equal(root, join("/data", "subscriber-state-snapshots", "kit"));
    assert.equal(snapshotDirPath(root, "2026-09-20"), join(root, "2026-09-20"));
    assert.equal(snapshotJsonlPath(root, "2026-09-20"), join(root, "2026-09-20", "subscribers.jsonl"));
  });

  it("serializa e reparseia uma lista de records sem perda", () => {
    const records: SubscriberStateRecord[] = [
      { id: 1, state: "active", created_at: "2026-09-18T10:00:00.000Z" },
      { id: 2, state: "inactive", created_at: "2026-09-19T22:00:00.000Z" },
    ];
    const raw = serializeSubscriberStateRecords(records);
    assert.deepEqual(parseSubscriberStateJsonl(raw), records);
  });

  it("1 record isolado serializa com \\n final", () => {
    const line = serializeSubscriberStateRecord({ id: 1, state: "active", created_at: "2026-09-18T10:00:00.000Z" });
    assert.ok(line.endsWith("\n"));
  });

  it("linhas vazias e corrompidas são ignoradas, nunca lançam", () => {
    const raw = [
      JSON.stringify({ id: 1, state: "active", created_at: "2026-09-18T10:00:00.000Z" }),
      "",
      "{not valid json",
      JSON.stringify({ id: 2 }), // faltam campos — descartada
    ].join("\n");
    const parsed = parseSubscriberStateJsonl(raw);
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0].id, 1);
  });
});

// ---------------------------------------------------------------------------
// Leitura de disco (listSubscriberStateSnapshotDates, readSubscriberStateSnapshotFile)
// ---------------------------------------------------------------------------

describe("leitura de disco", () => {
  it("root ausente devolve [] / [] fail-soft", () => {
    const root = join(tmpDir(), "nao-existe");
    assert.deepEqual(listSubscriberStateSnapshotDates(root), []);
    assert.deepEqual(readSubscriberStateSnapshotFile(root, "2026-09-20"), []);
  });

  it("lista datas em ordem ascendente e lê um snapshot gravado", () => {
    const root = join(tmpDir(), "kit");
    for (const date of ["2026-09-20", "2026-09-18", "2026-09-19"]) {
      const dir = snapshotDirPath(root, date);
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        snapshotJsonlPath(root, date),
        serializeSubscriberStateRecords([{ id: 1, state: "active", created_at: "2026-09-18T00:00:00.000Z" }]),
      );
    }
    assert.deepEqual(listSubscriberStateSnapshotDates(root), ["2026-09-18", "2026-09-19", "2026-09-20"]);
    const records = readSubscriberStateSnapshotFile(root, "2026-09-19");
    assert.equal(records.length, 1);
    assert.equal(records[0].id, 1);
  });

  it("loadAllSubscriberStateSnapshots carrega todas as datas (ou só as pedidas)", () => {
    const root = join(tmpDir(), "kit");
    for (const date of ["2026-09-18", "2026-09-19"]) {
      mkdirSync(snapshotDirPath(root, date), { recursive: true });
      writeFileSync(
        snapshotJsonlPath(root, date),
        serializeSubscriberStateRecords([{ id: 1, state: "active", created_at: "2026-09-18T00:00:00.000Z" }]),
      );
    }
    const all = loadAllSubscriberStateSnapshots(root);
    assert.deepEqual([...all.keys()].sort(), ["2026-09-18", "2026-09-19"]);
    const only18 = loadAllSubscriberStateSnapshots(root, ["2026-09-18"]);
    assert.deepEqual([...only18.keys()], ["2026-09-18"]);
  });
});

// ---------------------------------------------------------------------------
// diffSubscriberStateSnapshots / newlyActiveSince — a regressão do #8552
// (destrava o escopo 1 da #8543: "quem virou active desde a última rodada")
// ---------------------------------------------------------------------------

describe("diffSubscriberStateSnapshots", () => {
  it("detecta transição de estado entre 2 snapshots", () => {
    const prev: SubscriberStateRecord[] = [
      { id: 1, state: "inactive", created_at: "2026-09-18T00:00:00.000Z" },
      { id: 2, state: "active", created_at: "2026-09-17T00:00:00.000Z" },
    ];
    const curr: SubscriberStateRecord[] = [
      { id: 1, state: "active", created_at: "2026-09-18T00:00:00.000Z" }, // confirmou
      { id: 2, state: "active", created_at: "2026-09-17T00:00:00.000Z" }, // sem mudança
      { id: 3, state: "active", created_at: "2026-09-20T00:00:00.000Z" }, // novo, já nasceu active
    ];
    const transitions = diffSubscriberStateSnapshots(prev, curr);
    assert.deepEqual(
      transitions.map((t) => [t.id, t.from, t.to]),
      [
        [1, "inactive", "active"],
        [3, null, "active"],
      ],
    );
  });

  it("id que sumiu de curr não gera transição (Kit não expõe delete)", () => {
    const prev: SubscriberStateRecord[] = [{ id: 1, state: "active", created_at: "2026-09-18T00:00:00.000Z" }];
    const curr: SubscriberStateRecord[] = [];
    assert.deepEqual(diffSubscriberStateSnapshots(prev, curr), []);
  });

  it("newlyActiveSince cobre from=inactive→active E from=null (novo já active)", () => {
    const prev: SubscriberStateRecord[] = [{ id: 1, state: "inactive", created_at: "2026-09-18T00:00:00.000Z" }];
    const curr: SubscriberStateRecord[] = [
      { id: 1, state: "active", created_at: "2026-09-18T00:00:00.000Z" },
      { id: 2, state: "active", created_at: "2026-09-20T00:00:00.000Z" },
      { id: 3, state: "cancelled", created_at: "2026-09-15T00:00:00.000Z" },
    ];
    const transitions = diffSubscriberStateSnapshots(prev, curr);
    const newlyActive = newlyActiveSince(transitions);
    assert.deepEqual(newlyActive.map((t) => t.id).sort(), [1, 2]);
  });
});

// ---------------------------------------------------------------------------
// buildDoiConfirmationCohort — insumo de doi-confirmacao-dia (#8552)
// ---------------------------------------------------------------------------

describe("buildDoiConfirmationCohort", () => {
  it("menos de 2 snapshots -> indeterminado", () => {
    const snapshots = new Map<string, SubscriberStateRecord[]>([
      ["2026-09-18", [{ id: 1, state: "inactive", created_at: "2026-09-18T10:00:00.000Z" }]],
    ]);
    const result = buildDoiConfirmationCohort(snapshots, "2026-09-18");
    assert.deepEqual(result.cohort, []);
    assert.match(result.motivoIndeterminado ?? "", /menos de 2 snapshots/);
  });

  it("sem snapshot do próprio dia da safra -> indeterminado (estado de criação perdido)", () => {
    const snapshots = new Map<string, SubscriberStateRecord[]>([
      ["2026-09-17", [{ id: 1, state: "active", created_at: "2026-09-10T10:00:00.000Z" }]],
      ["2026-09-20", [{ id: 1, state: "active", created_at: "2026-09-10T10:00:00.000Z" }]],
    ]);
    const result = buildDoiConfirmationCohort(snapshots, "2026-09-18");
    assert.deepEqual(result.cohort, []);
    assert.match(result.motivoIndeterminado ?? "", /sem snapshot do próprio dia/);
  });

  it("nenhum inactive criado no dia -> indeterminado", () => {
    const snapshots = new Map<string, SubscriberStateRecord[]>([
      ["2026-09-18", [{ id: 1, state: "active", created_at: "2026-09-18T10:00:00.000Z" }]],
      ["2026-09-20", [{ id: 1, state: "active", created_at: "2026-09-18T10:00:00.000Z" }]],
    ]);
    const result = buildDoiConfirmationCohort(snapshots, "2026-09-18");
    assert.deepEqual(result.cohort, []);
    assert.match(result.motivoIndeterminado ?? "", /nenhum assinante inactive/);
  });

  it("safra ainda não maturou 48h -> indeterminado", () => {
    const snapshots = new Map<string, SubscriberStateRecord[]>([
      ["2026-09-18", [{ id: 1, state: "inactive", created_at: "2026-09-18T10:00:00.000Z" }]],
      // 2026-09-19 é só +1 dia — maturação de 48h só fecha em 2026-09-20 BRT.
      ["2026-09-19", [{ id: 1, state: "active", created_at: "2026-09-18T10:00:00.000Z" }]],
    ]);
    const result = buildDoiConfirmationCohort(snapshots, "2026-09-18");
    assert.deepEqual(result.cohort, []);
    assert.match(result.motivoIndeterminado ?? "", /ainda não maturou/);
  });

  it("safra madura -> calcula confirmados/total", () => {
    const snapshots = new Map<string, SubscriberStateRecord[]>([
      [
        "2026-09-18",
        [
          { id: 1, state: "inactive", created_at: "2026-09-18T10:00:00.000Z" },
          { id: 2, state: "inactive", created_at: "2026-09-18T11:00:00.000Z" },
          { id: 3, state: "inactive", created_at: "2026-09-18T12:00:00.000Z" },
          // criado em outro dia — nunca entra na safra de 18/09
          { id: 4, state: "inactive", created_at: "2026-09-17T12:00:00.000Z" },
          // já nasceu active — nunca entra na safra (não é confirmação)
          { id: 5, state: "active", created_at: "2026-09-18T13:00:00.000Z" },
        ],
      ],
      [
        // 48h depois de 2026-09-18 00:00 BRT = 2026-09-20 00:00 BRT
        "2026-09-20",
        [
          { id: 1, state: "active", created_at: "2026-09-18T10:00:00.000Z" }, // confirmou
          { id: 2, state: "inactive", created_at: "2026-09-18T11:00:00.000Z" }, // não confirmou
          // id 3 nem reaparece — tratado como não confirmado (fail-soft)
        ],
      ],
    ]);
    const result = buildDoiConfirmationCohort(snapshots, "2026-09-18");
    assert.equal(result.motivoIndeterminado, undefined);
    assert.deepEqual(
      result.cohort.sort((a, b) => a.id - b.id),
      [
        { id: 1, confirmed: true },
        { id: 2, confirmed: false },
        { id: 3, confirmed: false },
      ],
    );
  });

  it("usa o PRIMEIRO snapshot >= maturationDateKey, mesmo se houver vários posteriores", () => {
    const snapshots = new Map<string, SubscriberStateRecord[]>([
      ["2026-09-18", [{ id: 1, state: "inactive", created_at: "2026-09-18T10:00:00.000Z" }]],
      ["2026-09-20", [{ id: 1, state: "active", created_at: "2026-09-18T10:00:00.000Z" }]],
      ["2026-09-25", [{ id: 1, state: "inactive", created_at: "2026-09-18T10:00:00.000Z" }]], // ruído posterior
    ]);
    const result = buildDoiConfirmationCohort(snapshots, "2026-09-18", 48);
    assert.deepEqual(result.cohort, [{ id: 1, confirmed: true }]);
  });
});

// ---------------------------------------------------------------------------
// #8552 (a) — cruzamento com o form DOI
// ---------------------------------------------------------------------------

import { markDoiFormMembership } from "../scripts/lib/subscriber-state-snapshot.ts";

describe("doi_form (#8552 a)", () => {
  it("markDoiFormMembership marca só os ids do form e sobrevive ao roundtrip JSONL", () => {
    const recs: SubscriberStateRecord[] = [
      { id: 1, state: "inactive", created_at: "2026-09-18T10:00:00.000Z" },
      { id: 2, state: "inactive", created_at: "2026-09-18T11:00:00.000Z" },
    ];
    const marked = markDoiFormMembership(recs, new Set([2]));
    assert.equal(marked[0].doi_form, undefined);
    assert.equal(marked[1].doi_form, true);
    const back = parseSubscriberStateJsonl(serializeSubscriberStateRecords(marked));
    assert.equal(back[1].doi_form, true);
    assert.equal(back[0].doi_form, undefined);
  });

  const mk = (id: number, state: string, doi?: boolean): SubscriberStateRecord => ({
    id, state, created_at: "2026-09-18T10:00:00.000Z", ...(doi ? { doi_form: true } : {}),
  });

  it("com cobertura do form no snapshot do dia, a safra exclui órfãos (nunca vinculados)", () => {
    const day = [mk(1, "inactive", true), mk(2, "inactive", true), mk(3, "inactive")]; // 3 = órfão
    const matured = [mk(1, "active", true), mk(2, "inactive", true), mk(3, "inactive")];
    const r = buildDoiConfirmationCohort(new Map([["2026-09-18", day], ["2026-09-20", matured]]), "2026-09-18");
    assert.deepEqual(r.cohort, [{ id: 1, confirmed: true }, { id: 2, confirmed: false }]);
  });

  it("sem cobertura (snapshot antigo), mantém todo inactive criado no dia", () => {
    const day = [mk(1, "inactive"), mk(3, "inactive")];
    const matured = [mk(1, "active"), mk(3, "inactive")];
    const r = buildDoiConfirmationCohort(new Map([["2026-09-18", day], ["2026-09-20", matured]]), "2026-09-18");
    assert.equal(r.cohort.length, 2);
  });

  it("dia misto: dia com cobertura do form filtra; dia sem cobertura marca semFiltroDoi", () => {
    const d1 = "2026-09-18";
    const d2 = "2026-09-19";
    const mk2 = (id: number, day: string, doi?: boolean): SubscriberStateRecord => ({
      id, state: "inactive", created_at: `${day}T10:00:00.000Z`, ...(doi ? { doi_form: true } : {}),
    });
    const snaps = new Map<string, SubscriberStateRecord[]>([
      [d1, [mk2(1, d1, true), mk2(2, d1)]],
      [d2, [mk2(3, d2), mk2(4, d2)]], // leitura do form falhou neste dia
      ["2026-09-21", [mk2(1, d1, true), mk2(3, d2), mk2(4, d2)]],
    ]);
    const a = buildDoiConfirmationCohort(snaps, d1);
    assert.equal(a.cohort.length, 1);
    assert.equal(a.semFiltroDoi, undefined);
    const b = buildDoiConfirmationCohort(snaps, d2);
    assert.equal(b.cohort.length, 2);
    assert.equal(b.semFiltroDoi, true);
  });

  it("doi-form-status distingue leitura falha (piso) de form ok sem ninguém do dia (safra vazia, motivo próprio)", () => {
    const d = "2026-09-18";
    const day = [{ id: 1, state: "inactive", created_at: `${d}T10:00:00.000Z` }];
    const matured = [{ id: 1, state: "active", created_at: `${d}T10:00:00.000Z` }];
    const snaps = new Map<string, SubscriberStateRecord[]>([[d, day], ["2026-09-20", matured]]);
    const falhou = buildDoiConfirmationCohort(snaps, d, 48, new Map([[d, { ok: false }]]));
    assert.equal(falhou.semFiltroDoi, true);
    assert.equal(falhou.cohort.length, 1);
    const okSemNinguem = buildDoiConfirmationCohort(snaps, d, 48, new Map([[d, { ok: true }]]));
    assert.equal(okSemNinguem.semFiltroDoi, undefined);
    assert.equal(okSemNinguem.cohort.length, 0);
    assert.match(okSemNinguem.motivoIndeterminado ?? "", /vinculado ao form DOI/);
  });

  it("readDoiFormStatus/loadDoiFormStatuses leem o arquivo; ausente/corrompido = sem entrada", async () => {
    const { readDoiFormStatus, loadDoiFormStatuses } = await import("../scripts/lib/subscriber-state-snapshot.ts");
    const root = tmpDir();
    mkdirSync(join(root, "2026-09-18"), { recursive: true });
    mkdirSync(join(root, "2026-09-19"), { recursive: true });
    writeFileSync(join(root, "2026-09-18", "doi-form-status.json"), JSON.stringify({ ok: false }));
    writeFileSync(join(root, "2026-09-19", "doi-form-status.json"), "{lixo");
    assert.deepEqual(readDoiFormStatus(root, "2026-09-18"), { ok: false });
    assert.equal(readDoiFormStatus(root, "2026-09-19"), null);
    assert.equal(loadDoiFormStatuses(root, ["2026-09-18", "2026-09-19", "2026-09-20"]).size, 1);
  });

  it("métrica com semFiltroDoi vira piso (motivo sem-filtro-doi), nunca exato", async () => {
    const { getMetric } = await import("../scripts/lib/metrics/registry.ts");
    const def = getMetric("doi-confirmacao-dia")!;
    const janela = { de: "2026-09-18", ate: "2026-09-18", granularidade: "dia", fuso: "BRT" } as const;
    const cohort = [1, 2, 3, 4, 5].map((id) => ({ id, confirmed: id <= 2 }));
    const res = await def.computar({ janela, deps: { cohort, semFiltroDoi: true } });
    assert.equal(res.qualidade, "piso");
    assert.match(res.motivo ?? "", /sem-filtro-doi/);
  });

  it("(c) com snapshots suficientes a métrica deixa de ser indeterminado", async () => {
    const { getMetric } = await import("../scripts/lib/metrics/registry.ts");
    const ids = [1, 2, 3, 4, 5, 6];
    const day = ids.map((i) => mk(i, "inactive", true));
    const matured = ids.map((i) => mk(i, i <= 3 ? "active" : "inactive", true));
    const { cohort } = buildDoiConfirmationCohort(new Map([["2026-09-18", day], ["2026-09-20", matured]]), "2026-09-18");
    const def = getMetric("doi-confirmacao-dia")!;
    const janela = { de: "2026-09-18", ate: "2026-09-18", granularidade: "dia", fuso: "BRT" } as const;
    const res = await def.computar({ janela, deps: { cohort } });
    assert.notEqual(res.qualidade, "indeterminado");
    assert.equal(res.valor, 0.5);
  });
});
