/**
 * test/sync-intro-count-9103.test.ts (#9103)
 *
 * Regressão da edição 260930 (gate 4): com a intro em 1ª pessoa singular
 * ("selecionei os 12 mais relevantes", voz atual — #4358), o lint detectava
 * a divergência (claimed 12, actual 9) mas o regex de SUBSTITUIÇÃO do
 * sync-intro-count.ts só conhecia a 1ª pessoa plural e o script devolvia
 * `changed:false` sem reescrever. Aconteceu 3 vezes na sessão: 15→13,
 * 13→12, 12→9.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

function runCli(args: string[]): { code: number; stdout: string; stderr: string } {
  const projectRoot = join(import.meta.dirname, "..");
  const scriptPath = join(projectRoot, "scripts", "sync-intro-count.ts");
  const result = spawnSync(process.execPath, ["--import", "tsx", scriptPath, ...args], {
    cwd: projectRoot,
    encoding: "utf8",
  });
  return { code: result.status ?? -1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

/** 3 destaques + (actual - 3) itens em OUTRAS NOTÍCIAS = `actual` URLs. */
function buildMd(claimed: number, actual: number): string {
  const lines = [
    `Para esta edição, eu (o editor) enviei 2 submissões e a Diar.ia encontrou outros 80 artigos. Eu selecionei os ${claimed} mais relevantes para as pessoas que assinam a newsletter.`,
    "",
    "---",
    "",
  ];
  for (let i = 1; i <= 3; i++) {
    lines.push(
      `DESTAQUE ${i} | PRODUTO`,
      `[Título ${i}](https://h.com/${i})`,
      `https://h.com/${i}`,
      "",
      "Texto.",
      "",
      "---",
      "",
    );
  }
  lines.push("OUTRAS NOTÍCIAS", "");
  for (let i = 1; i <= actual - 3; i++) {
    lines.push(`[N${i}](https://n.com/${i})`, "Desc.", "");
  }
  return lines.join("\n");
}

describe("sync-intro-count CLI — intro em 1ª pessoa singular (#9103)", () => {
  for (const [claimed, actual] of [
    [15, 13],
    [13, 12],
    [12, 9],
  ] as const) {
    it(`reescreve 'selecionei os ${claimed}' → 'selecionei os ${actual}' quando a contagem cai`, () => {
      const dir = mkdtempSync(join(tmpdir(), "sync-intro-9103-"));
      try {
        const mdPath = join(dir, "02-reviewed.md");
        writeFileSync(mdPath, buildMd(claimed, actual), "utf8");

        const r = runCli(["--md", mdPath]);
        assert.equal(r.code, 0, r.stderr);
        const out = JSON.parse(r.stdout);
        assert.equal(out.claimed_before, claimed);
        assert.equal(out.actual, actual);
        assert.equal(out.changed, true, `esperava changed:true; stderr=${r.stderr}`);

        const updated = readFileSync(mdPath, "utf8");
        assert.match(updated, new RegExp(`Eu selecionei os ${actual} mais relevantes`));
        assert.doesNotMatch(updated, new RegExp(`selecionei os ${claimed}\\b`));

        // Idempotente: 2ª rodada não muda nada.
        const r2 = runCli(["--md", mdPath]);
        assert.equal(JSON.parse(r2.stdout).changed, false);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
});
