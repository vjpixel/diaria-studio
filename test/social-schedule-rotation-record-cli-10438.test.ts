/**
 * #10438 — dois achados do review 1.5b (PR #10432) na CLI manual
 * `scripts/social-schedule-rotation.ts --record`:
 *
 * 1. "já gravada(s)" era `rows.length - n` sobre as linhas NÃO filtradas: a
 *    linha `um` descartada (06-social-published.json ausente) aparecia como
 *    "já gravada". Cenário: `--record --date` antes do Stage 5 → "4 já
 *    gravadas" com a do `um` nunca gravada.
 * 2. `06-social-published.json` truncado (escrita concorrente) derrubava a CLI
 *    no `JSON.parse` do leitor default.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  filterUseMelhorRowsByPublished,
  formatRecordSummary,
  readPublishedPosts,
} from "../scripts/lib/social-schedule-rotation-record.ts";
import { editionDir } from "../scripts/lib/edition-paths.ts";
import type { RotationPlanRow } from "../scripts/lib/social-schedule-rotation.ts";

const rows = [
  { kind: "weekday", date: "2026-10-20", type: "d1", time: "09:45", source: "rotation" },
  { kind: "weekday", date: "2026-10-20", type: "d2", time: "12:15", source: "rotation" },
  { kind: "weekday", date: "2026-10-20", type: "d3", time: "17:15", source: "rotation" },
  { kind: "weekday", date: "2026-10-20", type: "um", time: "20:00", source: "rotation" },
] as unknown as RotationPlanRow[];

describe("formatRecordSummary conta sobre o array filtrado (#10438 item 1)", () => {
  it("antes do Stage 5: 3 novas, 0 já gravadas, 1 um não gravada (não '1 já gravada')", () => {
    const msg = formatRecordSummary("log.jsonl", 3, 3, 1);
    assert.match(msg, /3 linha\(s\) nova\(s\)/);
    assert.match(msg, /0 já gravada\(s\)/);
    assert.match(msg, /1 não gravada/);
  });

  it("re-rodada sem filtro: tudo já gravado", () => {
    assert.equal(
      formatRecordSummary("log.jsonl", 0, 4, 0),
      "[social-schedule-rotation] 0 linha(s) nova(s) em log.jsonl (4 já gravada(s)).",
    );
  });
});

describe("06-social-published.json malformado não derruba o --record (#10438 item 2)", () => {
  it("readPublishedPosts: truncado → null + WARN; ausente → null; válido → posts", () => {
    const dir = mkdtempSync(join(tmpdir(), "rot-10438-"));
    try {
      const warns: string[] = [];
      const p = join(dir, "06-social-published.json");
      assert.equal(readPublishedPosts(p, (m) => warns.push(m)), null);
      writeFileSync(p, '{"posts":[{"destaque":"um","sta');
      assert.equal(readPublishedPosts(p, (m) => warns.push(m)), null);
      assert.equal(warns.length, 1);
      assert.match(warns[0], /malformado/);
      writeFileSync(p, JSON.stringify({ posts: [{ destaque: "um", status: "scheduled" }] }));
      assert.deepEqual(readPublishedPosts(p), [{ destaque: "um", status: "scheduled" }]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("leitor default do filtro: arquivo truncado → linha um descartada, sem lançar", () => {
    const root = mkdtempSync(join(tmpdir(), "rot-10438-root-"));
    try {
      const edDir = join(root, editionDir("261020"));
      mkdirSync(edDir, { recursive: true });
      writeFileSync(join(edDir, "06-social-published.json"), '{"posts":[{"destaque":');
      const warns: string[] = [];
      const out = filterUseMelhorRowsByPublished(rows, {}, root, (m) => warns.push(m));
      assert.deepEqual(
        out.map((r) => (r as unknown as { type: string }).type),
        ["d1", "d2", "d3"],
      );
      assert.ok(warns.some((w) => /malformado/.test(w)));
      assert.ok(warns.some((w) => /ausente ou ilegível/.test(w)));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
