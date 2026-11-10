/**
 * test/audience-profile-staleness-checkout-divergence-12311.test.ts (#12311)
 *
 * Regressão: o alarme abriu a #12311 dizendo que a regeneração entre os
 * snapshots `2026-10-22.md` e `2026-10-24.md` "nunca completou". Ela
 * completou: a edição 261023 (Stage 0 de 22/10, Neo) gravou
 * `_internal/audience-profile-snapshot.md` com `updated_at: 2026-10-22`. O
 * profile regerado nunca foi commitado, e o Stage 0 de 24/10 rodou noutro
 * checkout, que ainda tinha o profile de master (`updated_at: 2026-10-21`),
 * e arquivou esse conteúdo. Os dois snapshots em master saíram idênticos por
 * divergência entre checkouts, não por falha de regeneração. Com a prova da
 * edição, o par não vira finding; sem ela, continua virando.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  findDuplicateSnapshotEntries,
  findDuplicateArchiveEntries,
  partitionByCheckoutDivergence,
  isExplainedByCheckoutDivergence,
  buildAlarmFindings,
  mergeStalenessEntries,
  DUPLICATE_ARCHIVE_ISSUE_TAG,
} from "../scripts/lib/audience-profile-staleness-alarm.ts";

const profile = (updatedAt: string) => `# Perfil de Audiência — diar.ia.br\n\n**updated_at:** ${updatedAt}\n**subscribers ativos:** 1168\n`;

// Snapshots como estão em master: 10-22 (Neo) e 10-24 (outro checkout) com o MESMO profile de 10-21.
const masterSnapshots = [
  { name: "2026-10-21.md", content: profile("2026-10-20") },
  { name: "2026-10-22.md", content: profile("2026-10-21") },
  { name: "2026-10-24.md", content: profile("2026-10-21") },
  { name: "2026-10-27.md", content: profile("2026-10-24") },
];

describe("partitionByCheckoutDivergence (#12311)", () => {
  it("caso real 10-22/10-24: regeneração de 22/10 comprovada pela edição 261023 -> nenhum finding", () => {
    const entries = findDuplicateSnapshotEntries(masterSnapshots, "2026-09-15.md");
    assert.equal(entries.length, 1, "o par idêntico continua sendo detectado");
    // updated_at lidos dos audience-profile-snapshot.md das edições 261022, 261023, 261026.
    const regenerated = new Set(["2026-10-21", "2026-10-22", "2026-10-24"]);
    const { kept, explained } = partitionByCheckoutDivergence(entries, regenerated);
    assert.equal(kept.length, 0);
    assert.equal(explained.length, 1);
    assert.equal(explained[0].details?.today_file, "2026-10-24.md");
    assert.equal(buildAlarmFindings(kept).length, 0);
  });

  it("sem prova de regeneração entre as datas (falha real) -> finding continua saindo", () => {
    const entries = findDuplicateSnapshotEntries(masterSnapshots, "2026-09-15.md");
    // Só regenerações fora de [10-22, 10-24): nada prova o run intermediário.
    const regenerated = new Set(["2026-10-21", "2026-10-24", "2026-10-27"]);
    const { kept } = partitionByCheckoutDivergence(entries, regenerated);
    const findings = buildAlarmFindings(kept);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].fingerprint, "snapshot-2026-10-24.md");
    assert.match(findings[0].body, /checkouts diferentes/);
  });

  it("data/ ausente (conjunto vazio) -> comportamento anterior preservado", () => {
    const entries = findDuplicateSnapshotEntries(masterSnapshots, "2026-09-15.md");
    const { kept } = partitionByCheckoutDivergence(entries, new Set());
    assert.equal(kept.length, 1);
  });

  it("intervalo é [prev, cur): regeneração no próprio dia de cur não explica o par", () => {
    const [entry] = findDuplicateSnapshotEntries(masterSnapshots, "2026-09-15.md");
    assert.equal(isExplainedByCheckoutDivergence(entry, new Set(["2026-10-24"])), false);
    assert.equal(isExplainedByCheckoutDivergence(entry, new Set(["2026-10-22"])), true);
    assert.equal(isExplainedByCheckoutDivergence(entry, new Set(["2026-10-23"])), true);
  });

  it("disparo do guard no run-log (mesmo checkout) nunca é descartado", () => {
    const logEntries = findDuplicateArchiveEntries([
      JSON.stringify({
        timestamp: "2026-10-24T18:00:00.000Z",
        agent: "update-audience",
        level: "warn",
        message: "dup",
        details: { today_file: "2026-10-24.md", latest_file: "2026-10-22.md", issue: DUPLICATE_ARCHIVE_ISSUE_TAG },
      }),
    ]);
    const merged = mergeStalenessEntries(logEntries, findDuplicateSnapshotEntries(masterSnapshots, "2026-09-15.md"));
    const { kept } = partitionByCheckoutDivergence(merged, new Set(["2026-10-22"]));
    assert.equal(kept.length, 1);
    assert.notEqual(kept[0].details?.source, "snapshot");
  });
});
