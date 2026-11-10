/**
 * #12593: o invariante `newsletter-intake` (#12188) recusava o sentinel do Stage 4
 * em toda edição (261109: 558 links "sem score", 545 bloqueando). Três causas,
 * cada uma com teste de regressão aqui:
 * 1. o "pool" era o bruto pré-dedup (`tmp-articles-raw.json`): link removido por
 *    dedup/data contava como "no pool sem score". Pool agora = `tmp-scoring-pool.json`,
 *    sem descer em `cluster_sources` (fonte fundida não vai ao scorer);
 * 2. score fora de 0-100 era descartado (bônus: 102; penalidade: -3);
 * 3. junção sensível a `http:`/`https:` (o scoring canonicaliza para https).
 * E: título placeholder de link pontuado e fora da edição é warning, não erro.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { buildIntake, linkMissingBlocks } from "../scripts/audit-newsletter-intake.ts";
import { checkNewsletterIntake } from "../scripts/lib/invariant-checks/stage-4.ts";
import type { SenderRegistry } from "../scripts/lib/newsletter-senders.ts";

const registry: SenderRegistry = {version: 1, senders: {
  "ai@example.com": {status: "aprovado", reason: "Editor aprovou", decided_at: "2026-11-04"},
}};
const urls = ["https://openai.com/news/article-one", "https://anthropic.com/news/article-two"];
const thread = (body = urls.join(" ")) => ({thread_id: "a", sender: "AI <ai@example.com>", subject: "Boletim", date: "2026-11-09T10:00:00Z", body});
function temp(fn: (dir: string) => void) { const dir = mkdtempSync(resolve(tmpdir(), "intake-12593-")); try { fn(dir); } finally { rmSync(dir, {recursive: true, force: true}); } }

function setup(dir: string) {
  const editionDir = resolve(dir, "edition"); const internal = resolve(editionDir, "_internal"); mkdirSync(internal, {recursive: true});
  const registryPath = resolve(dir, "senders.json"); writeFileSync(registryPath, JSON.stringify(registry));
  const write = (file: string, value: unknown) => writeFileSync(resolve(internal, file), JSON.stringify(value));
  write("captured-newsletters.json", [thread()]);
  const audit = () => spawnSync(process.execPath, ["--import", "tsx", "scripts/audit-newsletter-intake.ts", "--edition", "261109", "--edition-dir", editionDir,
    "--data-dir", dir, "--registry", registryPath, "--require-scores"], {encoding: "utf8"});
  const report = () => JSON.parse(readFileSync(resolve(internal, "newsletter-link-scores.json"), "utf8"));
  return {editionDir, internal, write, audit, report};
}

describe("#12593 newsletter-intake não bloqueia o sentinel em toda edição", () => {
  it("cenário 261109: link no bruto mas fora do pool de scoring (dedup/data) não bloqueia", () => temp((dir) => {
    const {editionDir, write, audit, report} = setup(dir);
    // Os dois links estão no bruto pré-dedup; só o 1º chegou ao scoring.
    write("tmp-articles-raw.json", urls.map((url) => ({url})));
    write("tmp-scoring-pool.json", {categorized: {radar: [{url: urls[0], title: "One"}], lancamento: [], use_melhor: [], video: []}});
    write("tmp-allscored.json", {all_scored: [{url: urls[0], score: 60, title: "One"}]});
    const run = audit();
    assert.equal(run.status, 0, run.stdout + run.stderr);
    const link = report().links.find((l: {url: string}) => l.url === urls[1]);
    assert.equal(link.in_pool, false, "pool é o tmp-scoring-pool.json, não o bruto");
    assert.equal(linkMissingBlocks(link), false);
    const v = checkNewsletterIntake(editionDir);
    assert.ok(!v.some((x) => x.severity === "error"), JSON.stringify(v));
    assert.ok(v.some((x) => x.message.includes("removido(s) antes do pool")));
  }));

  it("sem tmp-scoring-pool.json (edição antiga) o bruto segue sendo o pool", () => temp((dir) => {
    const {write, audit, report} = setup(dir);
    write("tmp-articles-raw.json", urls.map((url) => ({url})));
    write("tmp-allscored.json", {all_scored: [{url: urls[0], score: 60, title: "One"}]});
    assert.equal(audit().status, 1, "link no pool (bruto) sem score e sem tentativa continua bloqueando");
    assert.equal(report().links.find((l: {url: string}) => l.url === urls[1]).in_pool, true);
  }));

  it("link no pool de scoring sem score continua bloqueando (o scorer o perdeu)", () => temp((dir) => {
    const {editionDir, write, audit} = setup(dir);
    write("tmp-scoring-pool.json", {categorized: {radar: urls.map((url) => ({url, title: "T"})), lancamento: [], use_melhor: [], video: []}});
    write("tmp-allscored.json", {all_scored: [{url: urls[0], score: 60, title: "One"}]});
    assert.equal(audit().status, 1);
    assert.ok(checkNewsletterIntake(editionDir).some((v) => v.severity === "error" && v.message.includes("sem score")));
  }));

  it("fonte fundida num cluster (cluster_sources) não conta como pool", () => {
    const pool = {categorized: {radar: [{url: urls[0], title: "One", cluster_sources: [{url: urls[1], title: "Two"}]}]}};
    const result = buildIntake([thread()], registry, [{all_scored: [{url: urls[0], score: 70}]}], pool, {});
    const two = result.links.find((l) => l.url === urls[1])!;
    assert.equal(two.in_pool, false);
    assert.equal(two.score, null);
    assert.equal(linkMissingBlocks(two), false);
    // O título da fonte fundida ainda é aproveitado como metadado.
    assert.equal(two.title, "Two");
  });

  it("score fora de 0-100 (bônus e penalidades) é score real", () => {
    const result = buildIntake([thread()], registry,
      [{all_scored: [{url: urls[0], score: 102, title: "One"}, {url: urls[1], score: -3, title: "Two"}]}], [{url: urls[0]}, {url: urls[1]}], {});
    assert.deepEqual(result.links.map((l) => l.score), [102, -3]);
    assert.ok(result.links.every((l) => !linkMissingBlocks(l)));
  });

  it("http:// capturado junta com o https:// pontuado", () => {
    const http = "http://huggingface.co/acme/model-x";
    const result = buildIntake([thread(http)], registry, [{all_scored: [{url: "https://huggingface.co/acme/model-x", score: 40, title: "Model X"}]}],
      [{url: http}], {});
    assert.equal(result.links[0].score, 40);
    assert.equal(result.links[0].title, "Model X");
  });

  it("http:// capturado sem score está no pool https:// (in_pool usa a mesma chave da junção)", () => {
    const http = "http://huggingface.co/acme/model-y";
    const result = buildIntake([thread(http)], registry, [], [{url: "https://huggingface.co/acme/model-y"}], {});
    assert.equal(result.links[0].score, null);
    assert.equal(result.links[0].in_pool, true);
    assert.equal(linkMissingBlocks(result.links[0]), true);
  });

  it("pontuado com título placeholder: warning fora da edição, erro dentro dela", () => temp((dir) => {
    const {editionDir, write, audit, report} = setup(dir);
    write("tmp-scoring-pool.json", {categorized: {radar: urls.map((url) => ({url, title: "(newsletter:AI)"})), lancamento: [], use_melhor: [], video: []}});
    write("tmp-allscored.json", {all_scored: urls.map((url) => ({url, score: 30}))});
    const run = audit();
    assert.equal(run.status, 0, run.stdout + run.stderr);
    assert.ok(report().warnings.some((w: string) => w.includes("título placeholder")));
    let v = checkNewsletterIntake(editionDir);
    assert.ok(!v.some((x) => x.severity === "error"), JSON.stringify(v));
    // O mesmo link com título placeholder dentro da edição bloqueia (o invariante lê o relatório).
    const path = resolve(editionDir, "_internal/newsletter-link-scores.json");
    const r = report(); r.links[0].destino = "RADAR"; writeFileSync(path, JSON.stringify(r));
    v = checkNewsletterIntake(editionDir);
    assert.ok(v.some((x) => x.severity === "error" && x.message.includes("sem título")), JSON.stringify(v));
    assert.equal(linkMissingBlocks(r.links[0]), true);
  }));
});
