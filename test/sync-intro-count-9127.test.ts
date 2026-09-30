/**
 * test/sync-intro-count-9127.test.ts (#9127)
 *
 * O replace do `sync-intro-count.ts` rodava sobre o MD cru e pegava a PRIMEIRA
 * ocorrência de "verbo os N" em qualquer lugar do arquivo — enquanto o
 * extractor do lint (`extractIntroClaimedCount`) descartava o frontmatter.
 * Um frontmatter com `description: "... selecionei os 12 ..."` e o mesmo
 * número da intro era reescrito no lugar da intro, com `changed:true`, e a
 * intro publicava o número errado. O padrão também vivia em 2 cópias (extractor
 * + sync), convidando o #9103 a voltar.
 *
 * Fix: `locateIntroClaimedCount` devolve o offset do número no MD original
 * (calculado sobre o corpo sem frontmatter) e `replaceIntroClaimedCount`
 * substitui ali — fonte única pro lint e pro sync.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import {
  locateIntroClaimedCount,
  replaceIntroClaimedCount,
  extractIntroClaimedCount,
} from "../scripts/lib/newsletter-count.ts";

const PROJECT_ROOT = join(import.meta.dirname, "..");

function runCli(args: string[]): { code: number; stdout: string; stderr: string } {
  const scriptPath = join(PROJECT_ROOT, "scripts", "sync-intro-count.ts");
  const result = spawnSync(process.execPath, ["--import", "tsx", scriptPath, ...args], {
    cwd: PROJECT_ROOT,
    encoding: "utf8",
  });
  return { code: result.status ?? -1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

const FRONTMATTER = [
  "---",
  'description: "Hoje eu selecionei os 12 mais relevantes da semana"',
  "---",
  "",
].join("\n");

/** 3 destaques + (actual - 3) itens em OUTRAS NOTÍCIAS = `actual` URLs. */
function buildBody(claimed: number, actual: number): string {
  const lines = [
    `Para esta edição, eu selecionei os ${claimed} mais relevantes para quem assina.`,
    "",
    "---",
    "",
  ];
  for (let i = 1; i <= 3; i++) {
    lines.push(`DESTAQUE ${i} | PRODUTO`, `[Título ${i}](https://h.com/${i})`, "", "Texto.", "", "---", "");
  }
  lines.push("OUTRAS NOTÍCIAS", "");
  for (let i = 1; i <= actual - 3; i++) lines.push(`[N${i}](https://n.com/${i})`, "Desc.", "");
  return lines.join("\n");
}

describe("locateIntroClaimedCount / replaceIntroClaimedCount (#9127)", () => {
  it("ignora o frontmatter com a mesma frase e aponta pro número da intro", () => {
    const md = FRONTMATTER + buildBody(12, 9);
    const loc = locateIntroClaimedCount(md);
    assert.ok(loc);
    assert.equal(loc.count, 12);
    assert.equal(md.slice(loc.start, loc.end), "12");
    assert.ok(loc.start > FRONTMATTER.length, "offset deveria cair depois do frontmatter");
    assert.equal(md.slice(loc.start - "selecionei os ".length, loc.end), "selecionei os 12");
  });

  it("reescreve só a intro; o frontmatter fica intacto", () => {
    const md = FRONTMATTER + buildBody(12, 9);
    const r = replaceIntroClaimedCount(md, 9);
    assert.equal(r.changed, true);
    assert.ok(r.md.startsWith(FRONTMATTER), "frontmatter não pode ser tocado");
    assert.match(r.md, /eu selecionei os 9 mais relevantes/);
    assert.equal(extractIntroClaimedCount(r.md), 9);
  });

  it("offsets corretos com CRLF (frontmatter + corpo)", () => {
    const md = (FRONTMATTER + buildBody(12, 9)).replace(/\n/g, "\r\n");
    const loc = locateIntroClaimedCount(md);
    assert.ok(loc);
    assert.equal(md.slice(loc.start, loc.end), "12");
    assert.ok(loc.start > FRONTMATTER.length);
    const r = replaceIntroClaimedCount(md, 9);
    assert.equal(r.changed, true);
    assert.ok(r.md.startsWith(FRONTMATTER.replace(/\n/g, "\r\n")));
    assert.match(r.md, /eu selecionei os 9 mais relevantes/);
  });

  it("número com qtd. de dígitos diferente (9 → 12) preserva o resto do texto", () => {
    const md = buildBody(9, 12);
    const r = replaceIntroClaimedCount(md, 12);
    assert.equal(r.md, md.replace("selecionei os 9 mais", "selecionei os 12 mais"));
  });

  it("sem frase de contagem ou já correta → changed:false", () => {
    assert.equal(locateIntroClaimedCount("Sem contagem aqui."), null);
    assert.deepEqual(replaceIntroClaimedCount("Sem contagem aqui.", 3), {
      md: "Sem contagem aqui.",
      changed: false,
    });
    assert.equal(replaceIntroClaimedCount(buildBody(9, 9), 9).changed, false);
  });
});

describe("sync-intro-count CLI — frontmatter com a mesma frase (#9127)", () => {
  it("corrige a intro, não o frontmatter", () => {
    const dir = mkdtempSync(join(tmpdir(), "sync-intro-9127-"));
    try {
      const mdPath = join(dir, "02-reviewed.md");
      writeFileSync(mdPath, FRONTMATTER + buildBody(12, 9), "utf8");
      const r = runCli(["--md", mdPath]);
      assert.equal(r.code, 0, r.stderr);
      const out = JSON.parse(r.stdout);
      assert.equal(out.claimed_before, 12);
      assert.equal(out.actual, 9);
      assert.equal(out.changed, true);
      const updated = readFileSync(mdPath, "utf8");
      assert.ok(updated.startsWith(FRONTMATTER), "frontmatter foi reescrito");
      assert.match(updated, /eu selecionei os 9 mais relevantes/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("fonte única do padrão (#9127)", () => {
  it("sync-intro-count.ts não monta regex própria de 'verbo os N'", () => {
    const src = readFileSync(join(PROJECT_ROOT, "scripts", "sync-intro-count.ts"), "utf8");
    assert.doesNotMatch(src, /COVERAGE_COUNT_VERB_FRAGMENT/);
    assert.match(src, /replaceIntroClaimedCount/);
  });
});
