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
import { applyStage2Caps, type ApprovedJson, type ScoredHighlight } from "../scripts/lib/apply-stage2-caps.ts";
import { validateDomainDiversity } from "../scripts/validate-domain-diversity.ts";

const art = (url: string, score: number) => ({ url, title: `t ${score}`, score });
const hl = (url: string, score: number) => ({ rank: 1, score, article: { url, title: "d" } });

function fixture(highlights: ScoredHighlight[]): ApprovedJson {
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
    assert.equal(ev.details.removed.length, 4);
  });
});

describe("limite de domínio no Stage 2 — cobertura ampliada (#8593)", () => {
  const allUrls = (a: ApprovedJson): string[] => [
    ...(a.highlights ?? []).map((h) => String((h.article?.url ?? h.url) ?? "")),
    ...(a.lancamento ?? []).map((x) => String(x.url)),
    ...(a.radar ?? []).map((x) => String(x.url)),
    ...(a.use_melhor ?? []).map((x) => String(x.url)),
    ...(a.video ?? []).map((x) => String(x.url)),
  ];
  const three = () => [hl("https://a.com/1", 99), hl("https://b.com/1", 98), hl("https://c.com/1", 97)];

  it("prioridade de bucket: LANÇAMENTO nunca perde pra RADAR do mesmo domínio", () => {
    const { approved } = applyStage2Caps({
      highlights: three(),
      lancamento: [art("https://openai.com/l1", 10), art("https://openai.com/l2", 5)],
      radar: [art("https://openai.com/r1", 99), art("https://blog.openai.com/r2", 98)],
    });
    assert.deepEqual((approved.lancamento ?? []).map((x) => x.url), ["https://openai.com/l1", "https://openai.com/l2"]);
    assert.equal((approved.radar ?? []).length, 0);
  });

  it("USE MELHOR e VÍDEO entram na contagem; USE MELHOR > VÍDEO > RADAR", () => {
    const { approved, report } = applyStage2Caps({
      highlights: three(),
      use_melhor: [art("https://youtube.com/u1", 50)],
      video: [art("https://youtube.com/v1", 90), art("https://youtube.com/v2", 95)],
      radar: [art("https://youtube.com/r1", 99)],
    });
    assert.equal((approved.use_melhor ?? []).length, 1);
    assert.deepEqual((approved.video ?? []).map((x) => x.url), ["https://youtube.com/v2"]);
    assert.equal((approved.radar ?? []).length, 0);
    assert.equal(report.domain_limit.removed.length, 2);
  });

  it("itens sem score valem 0 e desempatam pela ordem original", () => {
    const { approved } = applyStage2Caps({
      highlights: three(),
      radar: [{ url: "https://x.com/1" }, { url: "https://x.com/2" }, { url: "https://x.com/3" }, art("https://x.com/4", 1)],
    });
    assert.deepEqual((approved.radar ?? []).map((x) => x.url).sort(), ["https://x.com/1", "https://x.com/4"]);
  });

  it("TLD .com.br: subdomínios contam como o mesmo domínio registrável", () => {
    const { approved } = applyStage2Caps({
      highlights: three(),
      radar: [art("https://www.uol.com.br/1", 10), art("https://tecnologia.uol.com.br/2", 20), art("https://uol.com.br/3", 30)],
    });
    assert.deepEqual((approved.radar ?? []).map((x) => x.url).sort(), ["https://tecnologia.uol.com.br/2", "https://uol.com.br/3"]);
  });

  it("limite roda antes do slice dos caps: sobra preenche o cap", () => {
    const { approved, report } = applyStage2Caps({
      highlights: three(),
      radar: [
        art("https://x.com/1", 90), art("https://x.com/2", 89), art("https://x.com/3", 88),
        art("https://y.com/1", 10), art("https://z.com/1", 9), art("https://w.com/1", 8),
        art("https://v.com/1", 7), art("https://u.com/1", 6), art("https://t.com/1", 5), art("https://s.com/1", 4),
      ],
    });
    assert.equal(report.caps.radar, 9);
    assert.equal((approved.radar ?? []).length, 9); // 10 - 1 excedente, cap 9
    assert.ok(!report.domain_limit.warnings.some((w) => w.includes("RADAR")));
  });

  it("avisa quando RADAR/USE MELHOR ficam abaixo do piso", () => {
    const { report } = applyStage2Caps(fixture(three()));
    assert.ok(report.domain_limit.warnings.some((w) => w.includes("RADAR abaixo do piso")));
    assert.ok(report.domain_limit.warnings.some((w) => w.includes("USE MELHOR abaixo do piso")));
  });

  it("runner-up de domínio já no limite não é promovido a USE MELHOR", () => {
    const { approved } = applyStage2Caps({
      highlights: three(),
      lancamento: [art("https://tut.com/l1", 50), art("https://tut.com/l2", 40)],
      runners_up: [
        { url: "https://tut.com/ru", bucket: "use_melhor", score: 80 },
        { url: "https://ok.com/ru", bucket: "use_melhor", score: 70 },
      ],
    });
    assert.deepEqual((approved.use_melhor ?? []).map((x) => x.url), ["https://ok.com/ru"]);
  });

  it("edição inteira passa no validateDomainDiversity", () => {
    const { approved } = applyStage2Caps({
      highlights: [hl("https://exame.com/d", 99), hl("https://b.com/1", 98), hl("https://c.com/1", 97)],
      lancamento: [art("https://exame.com/l", 60), art("https://openai.com/1", 50)],
      use_melhor: [art("https://canaltech.com.br/u", 70)],
      video: [art("https://canaltech.com.br/v", 60), art("https://canaltech.com.br/v2", 50)],
      radar: fixture([]).radar,
    });
    assert.equal(validateDomainDiversity(allUrls(approved).map((u) => `[x](${u})`).join("\n")).ok, true);
  });

  it("CLI: layout aninhado data/editions/2609/260921/_internal resolve edition", () => {
    const root = mkdtempSync(join(tmpdir(), "dl8593n-"));
    const dir = join(root, "data", "editions", "2609", "260921", "_internal");
    mkdirSync(dir, { recursive: true });
    const inP = join(dir, "01-approved.json");
    const outP = join(dir, "01-approved-capped.json");
    writeFileSync(inP, JSON.stringify(fixture(three())));
    const loader = pathToFileURL(resolve("node_modules/tsx/dist/loader.mjs")).href;
    const r = spawnSync(
      process.execPath,
      ["--import", loader, resolve("scripts/apply-stage2-caps.ts"), "--in", inP, "--out", outP],
      { cwd: root, encoding: "utf8" },
    );
    assert.equal(r.status, 0, r.stderr);
    const ev = JSON.parse(readFileSync(join(root, "data", "run-log.jsonl"), "utf8").trim().split("\n")[0]);
    assert.equal(ev.edition, "260921");
    assert.equal(ev.details.removed.length, 4);
  });
});
