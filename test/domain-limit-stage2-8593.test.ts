/**
 * #8593: limite de 2 URLs por domínio registrável aplicado já no Stage 2
 * (apply-stage2-caps), com recontagem da linha "selecionei os N mais relevantes".
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { applyStage2Caps } from "../scripts/lib/apply-stage2-caps.ts";
import { validateDomainDiversity } from "../scripts/validate-domain-diversity.ts";

const art = (url: string, score: number) => ({ url, title: `t ${score}`, score });
const hl = (url: string, score: number) => ({ rank: 1, score, article: { url, title: "d" } });

function fixture(highlights: unknown[]) {
  return {
    highlights,
    runners_up: [],
    lancamento: [],
    radar: [
      art("https://exame.com/1", 50),
      art("https://exame.com/2", 90),
      art("https://exame.com/3", 70),
      art("https://www.exame.com/4", 60),
      art("https://exame.com/5", 80),
      art("https://canaltech.com.br/1", 40),
      art("https://canaltech.com.br/2", 95),
      art("https://canaltech.com.br/3", 30),
    ],
    coverage: { editor_submitted: 2, diaria_discovered: 40 },
  };
}

describe("limite de domínio no Stage 2 (#8593)", () => {
  it("5 de um domínio + 3 de outro: sobram 2 de cada, os de maior score", () => {
    const { approved, report } = applyStage2Caps(
      fixture([hl("https://a.com/1", 99), hl("https://b.com/1", 98), hl("https://c.com/1", 97)]),
    );
    const urls = (approved.radar ?? []).map((a) => a.url).sort();
    assert.deepEqual(urls, [
      "https://canaltech.com.br/1",
      "https://canaltech.com.br/2",
      "https://exame.com/2",
      "https://exame.com/5",
    ]);
    assert.equal(report.domain_limit.removed.length, 4);
    assert.ok(report.domain_limit.removed.every((r) => r.reason.includes("excede")));
  });

  it("destaque nunca é removido e ocupa vaga do domínio", () => {
    const { approved, report } = applyStage2Caps(
      fixture([hl("https://exame.com/destaque", 10), hl("https://b.com/1", 98), hl("https://c.com/1", 97)]),
    );
    assert.equal(approved.highlights?.length, 3);
    const exame = (approved.radar ?? []).filter((a) => String(a.url).includes("exame.com"));
    assert.equal(exame.length, 1);
    assert.equal(exame[0].url, "https://exame.com/2"); // maior score entre os do radar
    assert.ok(report.domain_limit.removed.every((r) => r.bucket === "radar"));
  });

  it("resultado passa no validador do Stage 4 (mesmo veredito de contagem)", () => {
    const { approved } = applyStage2Caps(fixture([hl("https://a.com/1", 99)]));
    const md = (approved.radar ?? []).map((a) => `[x](${a.url})`).join("\n");
    assert.equal(validateDomainDiversity(md).ok, true);
  });

  it("CLI recontém 'selecionei os N' com o total real e loga warn", () => {
    const root = mkdtempSync(join(tmpdir(), "dl8593-"));
    const dir = join(root, "data", "editions", "260921", "_internal");
    mkdirSync(dir, { recursive: true });
    const inP = join(dir, "01-approved.json");
    const outP = join(dir, "01-approved-capped.json");
    writeFileSync(
      inP,
      JSON.stringify(fixture([hl("https://a.com/1", 99), hl("https://b.com/1", 98), hl("https://c.com/1", 97)])),
    );
    const script = resolve("scripts/apply-stage2-caps.ts");
    const r = spawnSync(process.execPath, ["--import", pathToFileURL(resolve("node_modules/tsx/dist/loader.mjs")).href, script, "--in", inP, "--out", outP], {
      cwd: root,
      encoding: "utf8",
    });
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(readFileSync(outP, "utf8"));
    // 3 destaques + 4 radar restantes = 7
    assert.equal(out.coverage.selected, 7);
    assert.match(out.coverage.line, /selecionei os 7 mais relevantes/);
    const log = join(root, "data", "run-log.jsonl");
    assert.ok(existsSync(log));
    const ev = JSON.parse(readFileSync(log, "utf8").trim().split("\n")[0]);
    assert.equal(ev.level, "warn");
    assert.equal(ev.edition, "260921");
    assert.equal(ev.details.length, 4);
  });
});
