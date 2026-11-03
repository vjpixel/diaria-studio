/**
 * test/pending-data-writes-12026.test.ts (#12026)
 *
 * No trem de merge o PR mergeado é o PR-trem e as PRs originais terminam
 * fechadas: a seção `Escrita pendente em data/` (item 35, #11780) de cada
 * original sumia do corpo da PR mergeada. Cobre o parser
 * (`scripts/lib/pending-data-writes.ts`), a coleta em `fetchTrainPrInfo`, a
 * réplica no corpo do PR-trem (`buildTrainPrBody`) e o relatório do fim do
 * trem (`run-merge-train.ts`). Nada aqui toca `data/`, `gh` ou rede.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  extractPendingDataWrites,
  buildAggregatedPendingDataWritesSection,
  PENDING_DATA_WRITES_HEADING,
} from "../scripts/lib/pending-data-writes.ts";
import { buildTrainPrBody, buildTrainPendingDataWritesBlock, type TrainPrInfo } from "../scripts/lib/merge-train.ts";
import { fetchTrainPrInfo, type ExecResult, type TrainRunner, type TrainBatchOutcome } from "../scripts/lib/merge-train-live.ts";
import { collectMergedPendingDataWrites, formatPendingDataWritesReport } from "../scripts/run-merge-train.ts";

const CANONICAL_BODY = [
  "Closes #11663",
  "",
  "## Resumo",
  "",
  "- mexe no hub",
  "",
  "## Escrita pendente em `data/` (#11780)",
  "",
  "- `data/hubs/prose-review-state.json`: `openai-chatgpt.proseReviewedDate` de `2026-09-17` para `2026-11-01`",
  "- `data/hubs/outro.json`: arquivo novo com `{}`",
  "",
  "## Testes",
  "",
  "- `npx tsx --test test/x.test.ts`",
].join("\n");

describe("extractPendingDataWrites (#12026)", () => {
  it("lê os itens da seção canônica e para no próximo heading", () => {
    const r = extractPendingDataWrites(CANONICAL_BODY);
    assert.equal(r.present, true);
    assert.deepEqual(
      r.writes.map((w) => w.path),
      ["data/hubs/prose-review-state.json", "data/hubs/outro.json"],
    );
    assert.match(r.writes[0].line, /^`data\/hubs\/prose-review-state\.json`: `openai-chatgpt/);
    assert.ok(!r.writes.some((w) => w.line.includes("npx tsx")), "item da seção seguinte não entra");
  });

  it("corpo sem a seção: present=false, nenhum item", () => {
    const r = extractPendingDataWrites("Closes #1\n\n## Resumo\n\n- algo em `data/x.json`");
    assert.equal(r.present, false);
    assert.deepEqual(r.writes, []);
  });

  it("título citado dentro de bloco de código cercado não conta (cópia do formato do item 35)", () => {
    const body = ["Formato:", "", "```", "## Escrita pendente em `data/` (#11780)", "", "- `data/hubs/x.json`: a de 1 para 2", "```"].join("\n");
    const r = extractPendingDataWrites(body);
    assert.equal(r.present, false);
    assert.deepEqual(r.writes, []);
  });

  it("título dentro de comentário HTML não conta", () => {
    const r = extractPendingDataWrites("<!--\n## Escrita pendente em `data/`\n- `data/a.json`: x\n-->");
    assert.equal(r.present, false);
  });

  it("título sem crase e em nível 3; sub-heading mais profundo não fecha a seção", () => {
    const body = ["### Escrita pendente em data/", "", "- `data/a.json`: k de 1 para 2", "#### detalhe", "- `data/b.json`: k de 3 para 4", "## Fim", "- fora"].join("\n");
    const r = extractPendingDataWrites(body);
    assert.equal(r.present, true);
    assert.deepEqual(r.writes.map((w) => w.path), ["data/a.json", "data/b.json"]);
  });

  it("seção presente e vazia: present=true, writes=[]", () => {
    const r = extractPendingDataWrites("## Escrita pendente em `data/` (#11780)\n\nNenhuma.\n");
    assert.equal(r.present, true);
    assert.deepEqual(r.writes, []);
  });

  it("CRLF e item sem caminho em crase (path=null)", () => {
    const r = extractPendingDataWrites("## Escrita pendente em `data/`\r\n\r\n- atualizar o estado do hub\r\n");
    assert.deepEqual(r.writes, [{ line: "atualizar o estado do hub", path: null }]);
  });
});

describe("buildAggregatedPendingDataWritesSection / PR-trem (#12026)", () => {
  const infos: TrainPrInfo[] = [
    {
      pr: 100,
      headRefName: "overnight/fix-1",
      title: "fix: A",
      issueNumbers: [1],
      pendingDataWrites: extractPendingDataWrites(CANONICAL_BODY).writes,
    },
    { pr: 101, headRefName: "overnight/fix-2", title: "fix: B", issueNumbers: [2], pendingDataWrites: [] },
  ];

  it("sem nenhuma escrita no lote, o bloco é vazio e o corpo não ganha a seção", () => {
    assert.equal(buildAggregatedPendingDataWritesSection([{ pr: 1, writes: [] }]), "");
    const body = buildTrainPrBody({ prs: [101] }, infos);
    assert.ok(!body.includes("Escrita pendente"));
  });

  it("o corpo do PR-trem replica a seção, com título canônico e as linhas por PR de origem", () => {
    const body = buildTrainPrBody({ prs: [100, 101] }, infos);
    assert.ok(body.includes(PENDING_DATA_WRITES_HEADING));
    assert.ok(body.includes("- PR #100:"));
    assert.ok(body.includes("  - `data/hubs/prose-review-state.json`: `openai-chatgpt.proseReviewedDate`"));
    assert.ok(!body.includes("- PR #101:"), "PR sem escrita não aparece");
    // Quem relê o corpo do PR-trem mergeado com o mesmo parser acha as linhas.
    const reparsed = extractPendingDataWrites(body);
    assert.equal(reparsed.present, true);
    assert.ok(reparsed.writes.some((w) => w.path === "data/hubs/prose-review-state.json"));
    // A réplica não pode introduzir marcador de fechamento no PR-trem.
    assert.ok(!/\bcloses\s+#\d/i.test(buildTrainPendingDataWritesBlock({ prs: [100, 101] }, infos)));
  });
});

class MiniRunner implements TrainRunner {
  warnings: string[] = [];
  constructor(private readonly body: string) {}
  exec(_cmd: string, _args: string[]): ExecResult {
    return { ok: true, stdout: JSON.stringify({ number: 100, headRefName: "overnight/fix-1", title: "fix: A", body: this.body }), stderr: "" };
  }
  sleep(): Promise<void> {
    return Promise.resolve();
  }
  now(): number {
    return 0;
  }
  mkTempDir(prefix: string): string {
    return prefix;
  }
  warn(message: string): void {
    this.warnings.push(message);
  }
}

describe("fetchTrainPrInfo coleta a escrita pendente (#12026)", () => {
  it("lê a seção do corpo da PR original", () => {
    const info = fetchTrainPrInfo(new MiniRunner(CANONICAL_BODY), 100);
    assert.equal(info.pendingDataWrites?.length, 2);
    assert.equal(info.pendingDataWrites?.[0].path, "data/hubs/prose-review-state.json");
  });

  it("corpo sem seção: lista vazia, sem aviso", () => {
    const runner = new MiniRunner("Closes #1");
    assert.deepEqual(fetchTrainPrInfo(runner, 100).pendingDataWrites, []);
    assert.deepEqual(runner.warnings, []);
  });
});

describe("run-merge-train: relatório da escrita pendente (#12026)", () => {
  const writes = extractPendingDataWrites(CANONICAL_BODY).writes;
  const infos: TrainPrInfo[] = [
    { pr: 100, headRefName: "a", title: "A", issueNumbers: [], pendingDataWrites: writes },
    { pr: 101, headRefName: "b", title: "B", issueNumbers: [], pendingDataWrites: writes },
    { pr: 102, headRefName: "c", title: "C", issueNumbers: [], pendingDataWrites: [] },
  ];

  it("só PR mergeado entra; PR de lote abandonado/falho não, e nada se repete", () => {
    const outcomes: TrainBatchOutcome[] = [
      { batch: { prs: [100, 101] }, status: "abandoned", detail: "vermelho, bissectando" },
      { batch: { prs: [100] }, status: "solo-merged", detail: "ok" },
      { batch: { prs: [101] }, status: "solo-failed", detail: "falhou" },
      { batch: { prs: [100, 102] }, status: "merged", detail: "ok" },
    ];
    const got = collectMergedPendingDataWrites(outcomes, infos);
    assert.deepEqual(got.map((p) => p.pr), [100]);
  });

  it("formata bloco legível + 1 linha JSON por PR; vazio sem pendência", () => {
    assert.deepEqual(formatPendingDataWritesReport([]), []);
    const lines = formatPendingDataWritesReport([{ pr: 100, writes }]);
    assert.match(lines[0], /ESCRITA PENDENTE em data\//);
    assert.ok(lines.includes("  PR #100:"));
    const json = lines.find((l) => l.startsWith("run-merge-train: escrita-pendente-json "));
    assert.ok(json);
    const parsed = JSON.parse(json.replace("run-merge-train: escrita-pendente-json ", ""));
    assert.equal(parsed.pr, 100);
    assert.equal(parsed.writes[0].path, "data/hubs/prose-review-state.json");
  });
});
