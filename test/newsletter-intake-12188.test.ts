import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { buildIntake, appendSnapshots, applyDecisions } from "../scripts/audit-newsletter-intake.ts";
import { classifySender, loadSenderRegistry, type SenderRegistry } from "../scripts/lib/newsletter-senders.ts";
import { fetchThread, searchThreadIds, mergeCaptured } from "../scripts/fetch-newsletter-threads.ts";
import { main as captureMain } from "../scripts/capture-newsletter-urls.ts";
import { checkNewsletterIntake } from "../scripts/lib/invariant-checks/stage-4.ts";

const registry: SenderRegistry = {version: 1, senders: {
  "ai@example.com": {status: "aprovado", reason: "Editor aprovou", decided_at: "2026-11-04"},
  "other@example.com": {status: "rejeitado", reason: "Editor rejeitou", decided_at: "2026-11-04"},
}};
const thread = (id = "a", sender = "AI <ai@example.com>") => ({thread_id: id, sender, subject: "Boletim", date: "2026-11-04T10:00:00Z", body: "https://openai.com/news/article-one https://anthropic.com/news/article-two"});
const urls = ["https://openai.com/news/article-one", "https://anthropic.com/news/article-two"];
const scored = {all_scored: [{url: urls[0], score: 80, title: "One"}, {url: urls[1], score: 95, title: "Two"}]};
function temp(fn: (dir: string) => void) { const dir = mkdtempSync(resolve(tmpdir(), "intake-12188-")); try {fn(dir);} finally {rmSync(dir, {recursive: true, force: true});} }

describe("newsletter intake #12188", () => {
  it("classifies only by durable sender decision, never AI words in the content", () => {
    assert.equal(classifySender("Name <AI@EXAMPLE.COM>", registry).classificacao, "IA");
    assert.equal(classifySender("new@example.com", registry).remetente_status, "novo-pendente");
    const result = buildIntake([thread("new", "new@example.com"), thread("no", "other@example.com")], registry, [scored], [], {});
    assert.equal(result.links.length, 0);
    assert.deepEqual(result.pending_senders, ["new@example.com"]);
    assert.deepEqual(result.rows.map((r) => r.estado), ["ignorada", "ignorada"]);
  });
  it("keeps every link and every origin, ranks descending and reports destinations", () => {
    const result = buildIntake([thread(), thread("b")], registry, [scored], [{url: urls[0]}], {highlights: [{article: {url: urls[0]}, score: 80}]});
    assert.equal(result.links.length, 4); // one shared URL still has both newsletters/threads
    assert.deepEqual(result.links.map((l) => l.score), [95,95,80,80]);
    assert.equal(result.links[0].destino, "fora da edição");
    assert.equal(result.links[3].destino, "destaque");
    assert.equal(result.rows[0].links_no_pool, 1);
    assert.equal(result.rows[0].estado, "lida");
  });
  it("missing scores are explicit failures, never fabricated zero; zero is a real score", () => {
    const result = buildIntake([thread()], registry, [{scored: [{url: urls[0], score: 0}]}], [], {});
    assert.equal(result.links[0].score, 0);
    assert.equal(result.links[1].score, null);
    assert.equal(result.rows[0].estado, "falhou");
    assert.equal(result.rows[0].links_pontuados, 1);
  });
  it("preserves failures and joins wrapped scorer scores through resolvedFrom", () => {
    const result = buildIntake([{...thread(), capture_error: "Gmail sem corpo"}], registry,
      [{highlights: [{article: {url: "https://resolved.example/article", title: "Resolved"}, score: 88}]}],
      [{url: "https://resolved.example/article", resolvedFrom: urls[0]}], {});
    assert.equal(result.links[0].score, 88);
    assert.equal(result.rows[0].estado_motivo, "Gmail sem corpo");
  });
  it("append-only snapshots survive resume and A/B/A changes without duplicate consecutive events", () => temp((dir) => {
    const path = resolve(dir, "261105.jsonl");
    const a = {thread_id: "a", estado: "falhou"}; const b = {...a, estado: "lida"};
    assert.equal(appendSnapshots(path, "261105", [a]), 1);
    const original = readFileSync(path, "utf8");
    assert.equal(appendSnapshots(path, "261105", [a]), 0);
    assert.equal(appendSnapshots(path, "261105", [b]), 1);
    assert.equal(appendSnapshots(path, "261105", [a]), 1);
    assert.ok(readFileSync(path, "utf8").startsWith(original));
    assert.equal(readFileSync(path, "utf8").trim().split("\n").length, 3);
  }));
  it("persists approved/rejected batch atomically, clears pending and rejects malformed batches", () => temp((dir) => {
    const path = resolve(dir, "senders.json"); writeFileSync(path, JSON.stringify(registry));
    applyDecisions(path, {"NEW@EXAMPLE.COM": {status: "aprovado", reason: "Gate 261105", decided_at: "2026-11-04"}});
    assert.equal(classifySender("new@example.com", loadSenderRegistry(path)).remetente_status, "aprovado");
    const before = readFileSync(path, "utf8");
    assert.throws(() => applyDecisions(path, {"bad@example.com": {status: "rejeitado", reason: "", decided_at: "2026-11-04"}}));
    assert.equal(readFileSync(path, "utf8"), before);
  }));
  it("paginates Gmail and deduplicates IDs instead of dropping the 101st newsletter", async () => {
    let calls = 0;
    const request = async <T>(path: string): Promise<T> => {
      calls++;
      return (path.includes("pageToken=p2") ? {threads: [{id: "a"}, {id: "b"}]} : {threads: [{id: "a"}], nextPageToken: "p2"}) as T;
    };
    assert.deepEqual(await searchThreadIds("in:inbox", 100, request), ["a", "b"]);
    assert.equal(calls, 2);
  });
  it("preserves metadata for a newsletter with no readable body and recovers on retry", async () => {
    const request = async <T>(): Promise<T> => ({id: "a", messages: [{internalDate: "1793786400000", payload: {mimeType: "text/plain", headers: [{name: "From", value: "ai@example.com"}, {name: "List-ID", value: "ai"}], body: {}}}]}) as T;
    const failed = await fetchThread("a", 8000, request);
    assert.equal(failed?.sender, "ai@example.com");
    assert.equal(failed?.newsletter_headers, true);
    assert.ok(failed?.capture_error);
    assert.equal(mergeCaptured([failed!], [thread()])[0].body, thread().body);
  });
});

describe("intake CLI and gate #12188", () => {
  it("persists all scores, mismatch/failure warnings, destinations from reviewed and query filters", () => temp((dir) => {
    const editionDir = resolve(dir, "edition"); const internal = resolve(editionDir, "_internal"); mkdirSync(internal, {recursive: true});
    const registryPath = resolve(dir, "senders.json"); writeFileSync(registryPath, JSON.stringify(registry));
    const write = (file: string, value: unknown) => writeFileSync(resolve(internal,file), JSON.stringify(value));
    write("captured-newsletters.json", [thread(), thread("new", "new@example.com")]);
    writeFileSync(resolve(internal,"captured-newsletters.json.fetch.jsonl"), JSON.stringify({thread_ids: ["a","new","missing"]}) + "\n");
    write("tmp-allscored.json", scored);
    write("tmp-articles-raw.json", urls.map((url) => ({url})));
    writeFileSync(resolve(editionDir,"02-reviewed.md"), `**🚀 LANÇAMENTOS**\n\n**[One](${urls[0]})**\nDescrição.\n`);
    const args = ["--edition", "261105", "--edition-dir", editionDir, "--data-dir", dir, "--registry", registryPath, "--require-scores"];
    const run = spawnSync(process.execPath, ["--import", "tsx", "scripts/audit-newsletter-intake.ts", ...args], {encoding:"utf8"});
    assert.equal(run.status, 0, run.stderr);
    const report = JSON.parse(readFileSync(resolve(internal,"newsletter-link-scores.json"),"utf8"));
    assert.equal(report.links.length, 2);
    assert.equal(report.links[1].destino, "LANÇAMENTOS");
    assert.ok(report.warnings.some((w: string) => w.includes("total no inbox")));
    assert.ok(readFileSync(resolve(internal,"newsletter-intake-gate.md"),"utf8").includes(urls[1]));
    const query = spawnSync(process.execPath, ["--import","tsx","scripts/audit-newsletter-intake.ts","--data-dir",dir,"--sender","AI@EXAMPLE.COM","--from","261105","--to","261105"],{encoding:"utf8"});
    assert.equal(query.status, 0, query.stderr);
    assert.equal(JSON.parse(query.stdout).length, 1);
    assert.ok(checkNewsletterIntake(editionDir).some((v) => v.message.includes("pendentes")));
    // Missing report never silently passes when captured threads exist.
    writeFileSync(resolve(internal,"newsletter-link-scores.json"), "bad");
    assert.ok(checkNewsletterIntake(editionDir).some((v) => v.severity === "error"));
  }));
  it("require-scores exits nonzero until all captured IA links have scores", () => temp((dir) => {
    const internal = resolve(dir, "_internal"); mkdirSync(internal);
    const registryPath = resolve(dir, "senders.json"); writeFileSync(registryPath, JSON.stringify(registry));
    writeFileSync(resolve(internal,"captured-newsletters.json"),JSON.stringify([thread()]));
    const args = ["--edition","261105","--edition-dir",dir,"--data-dir",dir,"--registry",registryPath,"--require-scores"];
    const run = () => spawnSync(process.execPath,["--import","tsx","scripts/audit-newsletter-intake.ts",...args],{encoding:"utf8"});
    assert.equal(run().status,1);
    assert.equal(JSON.parse(readFileSync(resolve(internal,"newsletter-unscored.json"),"utf8")).categorized.radar.length,2);
    writeFileSync(resolve(internal,"newsletter-extra-scores.json"),JSON.stringify(scored));
    assert.equal(run().status,0);
    const report = JSON.parse(readFileSync(resolve(internal,"newsletter-link-scores.json"),"utf8"));
    assert.deepEqual(report.links.map((l: {score: number}) => l.score),[95,80]);
    assert.equal(report.rows[0].estado,"lida");
  }));
  it("capture never injects a new sender and drops rejected existing origins on resume", () => temp((dir) => {
    const input = resolve(dir,"threads.json"); const out = resolve(dir,"articles.json");
    writeFileSync(input,JSON.stringify([thread("new","new@example.com")]));
    writeFileSync(out,JSON.stringify([{url:urls[0],newsletter_mentions:["new@example.com"]}]));
    captureMain(["node","capture-newsletter-urls.ts","--threads",input,"--out",out,"--cursor",resolve(dir,"cursor.json"),"--edition","261105"]);
    assert.deepEqual(JSON.parse(readFileSync(out,"utf8")),[]);
  }));
  it("gate refuses missing scores and stale reports", () => temp((dir) => {
    const internal = resolve(dir,"_internal"); mkdirSync(internal);
    writeFileSync(resolve(internal,"captured-newsletters.json"),JSON.stringify([thread()]));
    assert.equal(checkNewsletterIntake(dir)[0].severity,"error");
    const report = resolve(internal,"newsletter-link-scores.json");
    writeFileSync(report,JSON.stringify({links:[{score:null}],rows:[{thread_id:"a"}],pending_senders:[],warnings:["Newsletter falhou"]}));
    assert.ok(checkNewsletterIntake(dir).some((v) => v.message.includes("sem score")));
    assert.ok(checkNewsletterIntake(dir).some((v) => v.severity === "warning"));
    utimesSync(report,new Date(0),new Date(0));
    assert.ok(checkNewsletterIntake(dir).some((v) => v.message.includes("desatualizado")));
  }));
});
