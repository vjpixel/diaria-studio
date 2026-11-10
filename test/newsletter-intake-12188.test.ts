import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { buildIntake, appendSnapshots, applyDecisions, latestManifestEvents } from "../scripts/audit-newsletter-intake.ts";
import { classifySender, detectBulkService, loadSenderRegistry, type SenderRegistry } from "../scripts/lib/newsletter-senders.ts";
import { evaluateCaptureYield } from "../scripts/lib/newsletter-capture-yield.ts";
import { fetchThread, searchThreadIds, mergeCaptured, main as fetchMain } from "../scripts/fetch-newsletter-threads.ts";
import { main as captureMain } from "../scripts/capture-newsletter-urls.ts";
import { checkNewsletterIntake } from "../scripts/lib/invariant-checks/stage-4.ts";
import { captureCountWarning, discoveryWarnings, portableRegistryPath, readFetchFailures, linkMissingBlocks } from "../scripts/audit-newsletter-intake.ts";
import { resolveSenderRegistry, fallbackSenderRegistry } from "../scripts/lib/newsletter-senders.ts";
import { countSubmissionSources, countableCapturedNewsletters, readSubmissionCountFromMarker } from "../scripts/lib/inbox-stats.ts";
import { searchThreadIdsPaged } from "../scripts/fetch-newsletter-threads.ts";
import { computeIntakeFingerprint } from "../scripts/lib/newsletter-intake-fingerprint.ts";

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
    // #12188 item 3: links_no_pool < links_capturados is a distinct state, not "lida".
    assert.equal(result.rows[0].estado, "parcial");
    assert.match(result.rows[0].estado_motivo, /1 de 2 links/);
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
    // Sem tmp-articles-raw.json o pool é desconhecido: nunca "lida" (P3 do re-review).
    assert.equal(report.rows[0].estado,"pool desconhecido");
    writeFileSync(resolve(internal,"tmp-articles-raw.json"),JSON.stringify(urls.map((url) => ({url}))));
    assert.equal(run().status,0);
    assert.equal(JSON.parse(readFileSync(resolve(internal,"newsletter-link-scores.json"),"utf8")).rows[0].estado,"lida");
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
    // Report without the input fingerprint (pre-#12188 item 7) is stale.
    assert.ok(checkNewsletterIntake(dir).some((v) => v.message.includes("desatualizado")));
    writeFileSync(report, "{bad");
    assert.ok(checkNewsletterIntake(dir).some((v) => /ilegível \(.+\)/.test(v.message)), "catch inclui a causa");
  }));
});

const reviewedMd = (radarUrl: string, extra = "") => `**DESTAQUE 1 | 💼 TRABALHO**\n\n**[One title](${urls[0]})**\n\nCorpo do destaque.${extra}\n\nPor que isso importa:\n\nX.\n\n---\n\n**📡 RADAR**\n\n**[Radar item](${radarUrl})**\nDescrição.\n`;
function setupEdition(dir: string) {
  const editionDir = resolve(dir, "edition"); const internal = resolve(editionDir, "_internal"); mkdirSync(internal, {recursive: true});
  const registryPath = resolve(dir, "senders.json"); writeFileSync(registryPath, JSON.stringify(registry));
  writeFileSync(resolve(internal, "captured-newsletters.json"), JSON.stringify([thread()]));
  writeFileSync(resolve(internal, "tmp-allscored.json"), JSON.stringify(scored));
  const audit = () => spawnSync(process.execPath, ["--import", "tsx", "scripts/audit-newsletter-intake.ts", "--edition", "261105", "--edition-dir", editionDir, "--data-dir", dir, "--registry", registryPath], {encoding: "utf8"});
  return {editionDir, internal, registryPath, audit};
}

describe("#12516 captured acumulado × manifesto com 2 eventos", () => {
  const manifest = (internal: string, events: object[]) =>
    writeFileSync(resolve(internal, "captured-newsletters.json.fetch.jsonl"), events.map((e) => JSON.stringify(e)).join("\n") + "\n");
  const warningsOf = (internal: string) =>
    (JSON.parse(readFileSync(resolve(internal, "newsletter-link-scores.json"), "utf8")) as {warnings: string[]}).warnings;

  it("thread da rodada anterior no registro não gera aviso de total (excesso não é perda)", () => {
    const events = [{scope: "S", thread_ids: ["new"]}];
    assert.equal(captureCountWarning(events as never, ["old", "new"]), null);
    assert.equal(captureCountWarning(events as never, ["old"]), "total no inbox na janela (1) != total registrado (0)");
  });

  it("CLI: resume com janela andada — captured acumula a thread antiga, último evento só tem a nova", () => temp((dir) => {
    const {internal, audit} = setupEdition(dir);
    writeFileSync(resolve(internal, "captured-newsletters.json"), JSON.stringify([thread("old"), thread("a")]));
    manifest(internal, [{scope: "S", thread_ids: ["old", "a"]}, {scope: "S", thread_ids: ["a"]}]);
    assert.equal(audit().status, 0);
    assert.ok(!warningsOf(internal).some((w) => w.startsWith("total no inbox")), warningsOf(internal).join(" | "));
  }));

  it("CLI: id esperado do último evento ausente do registro continua avisando", () => temp((dir) => {
    const {internal, audit} = setupEdition(dir);
    writeFileSync(resolve(internal, "captured-newsletters.json"), JSON.stringify([thread("old"), thread("a")]));
    manifest(internal, [{scope: "S", thread_ids: ["old"]}, {scope: "S", thread_ids: ["a", "perdida"]}]);
    assert.equal(audit().status, 0);
    assert.ok(warningsOf(internal).includes("total no inbox na janela (2) != total registrado (1)"), warningsOf(internal).join(" | "));
  }));
});

describe("#12188 fleet-review fixes", () => {
  it("item 7: editing 02-reviewed.md text (and touching files) does not make the intake stale; changing a link does", () => temp((dir) => {
    const {editionDir, internal, audit} = setupEdition(dir);
    writeFileSync(resolve(editionDir, "02-reviewed.md"), reviewedMd(urls[1]));
    assert.equal(audit().status, 0);
    const stale = () => checkNewsletterIntake(editionDir).some((v) => v.message.includes("desatualizado"));
    assert.equal(stale(), false);
    writeFileSync(resolve(editionDir, "02-reviewed.md"), reviewedMd(urls[1], " Frase nova do editor."));
    const future = new Date(Date.now() + 60_000);
    utimesSync(resolve(editionDir, "02-reviewed.md"), future, future);
    utimesSync(resolve(internal, "captured-newsletters.json"), future, future);
    assert.equal(stale(), false, "save sem mudar links não é intake desatualizado");
    writeFileSync(resolve(editionDir, "02-reviewed.md"), reviewedMd("https://example.org/outro-link"));
    assert.equal(stale(), true, "trocar link é intake desatualizado");
  }));

  it("item 8: destaque wins over a section listing the same URL (reviewed) and over buckets of 01-approved", () => {
    const md = reviewedMd(urls[0]);
    const final = [
      {url: urls[0], destination: "destaque"}, {url: urls[0], destination: "RADAR"},
    ];
    assert.equal(buildIntake([thread()], registry, [scored], undefined, final).links.find((l) => l.url === urls[0])?.destino, "destaque");
    assert.ok(md.includes("DESTAQUE 1 |"));
    const approved = {highlights: [{article: {url: urls[0]}, score: 80}], radar: [{url: urls[0]}], runners_up: [{url: urls[1]}]};
    const result = buildIntake([thread()], registry, [scored], undefined, approved);
    assert.equal(result.links.find((l) => l.url === urls[0])?.destino, "destaque");
    assert.equal(result.links.find((l) => l.url === urls[1])?.destino, "fora da edição", "runners_up não está na edição");
  });

  it("item 8 (CLI): DESTAQUE heading in 02-reviewed.md with the same URL repeated in RADAR keeps destino destaque", () => temp((dir) => {
    const {editionDir, internal, audit} = setupEdition(dir);
    writeFileSync(resolve(editionDir, "02-reviewed.md"), reviewedMd(urls[0]));
    assert.equal(audit().status, 0);
    const report = JSON.parse(readFileSync(resolve(internal, "newsletter-link-scores.json"), "utf8"));
    assert.equal(report.links.find((l: {url: string}) => l.url === urls[0]).destino, "destaque");
  }));

  it("item 3: approved newsletter with 0 captured links is falhou with an explicit reason", () => {
    const empty = {...thread(), body: "Sem links hoje."};
    const result = buildIntake([empty], registry, [scored], undefined, {});
    assert.equal(result.rows[0].estado, "falhou");
    assert.match(result.rows[0].estado_motivo, /sem nenhum link capturado/);
  });

  it("items 1+6: discovery is audit-only, offers only bulk-service senders and counts the rest without address", () => {
    const discovered = [
      {thread_id: "d1", sender: "Letter <hello@newletter.ai>", subject: "Issue 1", date: "", list_unsubscribe: "<https://newletter.beehiiv.com/unsub>"},
      {thread_id: "d2", sender: "Pessoa <pessoa@gmail.com>", subject: "Re: lista", date: "", list_id: "<grupo.googlegroups.com>"},
      {thread_id: "d3", sender: "other@example.com", subject: "x", date: "", list_id: "<x.mcsv.net>"},
      {thread_id: "a", sender: "AI <ai@example.com>", subject: "dup", date: "", list_id: "<x.mcsv.net>"},
    ];
    const result = buildIntake([thread()], registry, [scored], undefined, {}, [], [], {discovered});
    assert.deepEqual(result.pending_senders, ["hello@newletter.ai"]);
    assert.equal(result.discovery.fora_de_servico_conhecido, 1);
    assert.equal(result.discovery.rejeitados, 1);
    assert.equal(result.discovery.threads, 3, "thread já capturada não conta na descoberta");
    assert.equal(result.rows.length, 1, "descoberta nunca vira linha do intake");
    assert.ok(!JSON.stringify(result).includes("pessoa@gmail.com"), "endereço fora de serviço conhecido nunca sai no relatório");
  });

  it("item 6: rejection of a sender the gate did not offer never goes to the seed; null decision is a clear error", () => temp((dir) => {
    const path = resolve(dir, "senders.json"); writeFileSync(path, JSON.stringify(registry));
    const decision = {status: "rejeitado" as const, reason: "Gate 261105", decided_at: "2026-11-04"};
    const out = applyDecisions(path, {"pessoa@gmail.com": decision, "hello@newletter.ai": decision}, new Set(["hello@newletter.ai"]));
    assert.deepEqual(out, {applied: 1, skipped_rejections: 1});
    const saved = readFileSync(path, "utf8");
    assert.ok(!saved.includes("pessoa@gmail.com"));
    assert.ok(saved.includes("hello@newletter.ai"));
    assert.throws(() => applyDecisions(path, {"x@example.com": null as never}), /sem objeto de decisão/);
    assert.equal(readFileSync(path, "utf8"), saved);
    assert.equal(existsSync(path + ".tmp"), false);
  }));

  it("item 9: only the latest manifest event per scope counts", () => temp((dir) => {
    const path = resolve(dir, "m.jsonl");
    writeFileSync(path, [
      {scope: "A", thread_ids: ["old"]}, {scope: "B", thread_ids: ["b"]}, {scope: "A", thread_ids: ["new"]},
    ].map((e) => JSON.stringify(e)).join("\n") + "\n");
    assert.deepEqual(latestManifestEvents(path).flatMap((e) => e.thread_ids).sort(), ["b", "new"]);
  }));

  it("detects bulk services by header host, never by substring of a person domain", () => {
    assert.equal(detectBulkService(["<abc.list-id.mcsv.net>"]), "mcsv.net");
    assert.equal(detectBulkService(["Fulano <fulano@notsubstack.com>"]), null);
    assert.equal(detectBulkService(["x@y.com"], ["y.com"]), "y.com");
  });

  it("#9368 guard counts only threads of approved senders", () => {
    const threads = JSON.stringify([{sender: "ai@example.com"}, {sender: "config-only@example.com"}]);
    const approved = (t: {sender?: string}) => classifySender(t.sender ?? "", registry).classificacao === "IA";
    assert.equal(evaluateCaptureYield(JSON.stringify([{sender: "config-only@example.com"}]), "[]", approved).empty, false);
    assert.equal(evaluateCaptureYield(threads, "[]", approved).threads, 1);
    assert.equal(evaluateCaptureYield(threads, "[]").threads, 2);
  });
});

describe("fetch-newsletter-threads #12188 discovery and failures", () => {
  const b64 = (s: string) => Buffer.from(s).toString("base64url");
  function gmail(threads: Record<string, unknown>, failing = new Set<string>()) {
    const paths: string[] = [];
    const request = async <T>(path: string): Promise<T> => {
      paths.push(path);
      if (path.startsWith("threads?")) return {threads: Object.keys(threads).map((id) => ({id}))} as T;
      const id = path.slice("threads/".length).split("?")[0];
      if (failing.has(id)) throw new Error(`boom ${id}`);
      return {...(threads[id] as object), id} as T;
    };
    return {request, paths};
  }
  const message = (headers: Array<{name: string; value: string}>, html = "") => ({id: "x", messages: [{id: "m", internalDate: "1793786400000",
    payload: {mimeType: "text/html", headers, body: html ? {data: b64(html)} : {}}}]});

  it("items 1+2: discovery writes its own file, uses format=metadata, skips captured IDs and never touches capture file or sentinel", async () => {
    const dir = mkdtempSync(resolve(tmpdir(), "intake-12188-"));
    try {
      const internal = resolve(dir, "_internal"); mkdirSync(internal);
      const capturedPath = resolve(internal, "captured-newsletters.json");
      const sentinel = resolve(internal, ".capture-newsletter-failed.json");
      writeFileSync(capturedPath, JSON.stringify([thread("a")]));
      writeFileSync(sentinel, JSON.stringify({failed: true, error: "grupo falhou", at: "x"}));
      const {request, paths} = gmail({
        a: message([{name: "From", value: "ai@example.com"}, {name: "List-ID", value: "<a.mcsv.net>"}]),
        n: message([{name: "From", value: "hello@newletter.ai"}, {name: "List-Unsubscribe", value: "<https://x.beehiiv.com/u>"}]),
        p: message([{name: "From", value: "amigo@example.com"}, {name: "Subject", value: "oi"}]),
      });
      const out = resolve(internal, "discovered-newsletters.json");
      await fetchMain(["node", "f", "--discover", "--since-hours", "48", "--out", out, "--skip-ids-from", capturedPath], request);
      const discovered = JSON.parse(readFileSync(out, "utf8"));
      assert.deepEqual(discovered.map((t: {thread_id: string}) => t.thread_id), ["n"]);
      assert.equal(discovered[0].list_unsubscribe, "<https://x.beehiiv.com/u>");
      assert.ok(paths.filter((p) => p.startsWith("threads/")).every((p) => p.includes("format=metadata")), "descoberta nunca pede format=full");
      assert.ok(!paths.some((p) => p.startsWith("threads/a")), "thread já capturada é pulada");
      assert.deepEqual(JSON.parse(readFileSync(capturedPath, "utf8")).map((t: {thread_id: string}) => t.thread_id), ["a"], "captured-newsletters.json intocado");
      assert.ok(existsSync(sentinel), "sucesso da descoberta não apaga o sentinel de um grupo que falhou");
      assert.ok(existsSync(out + ".fetch.jsonl"));
    } finally { rmSync(dir, {recursive: true, force: true}); }
  });

  it("sender-group failures stay in the manifest, never as sender:'' placeholders in captured-newsletters.json; the intake keeps them as falhou", async () => {
    const dir = mkdtempSync(resolve(tmpdir(), "intake-12188-"));
    try {
      const internal = resolve(dir, "_internal"); mkdirSync(internal);
      const out = resolve(internal, "captured-newsletters.json");
      const {request} = gmail({
        ok: message([{name: "From", value: "ai@example.com"}], `<p>Leia <a href="${urls[0]}">aqui</a></p>`),
        bad: {},
      }, new Set(["bad"]));
      await fetchMain(["node", "f", "--senders", "ai@example.com", "--since-hours", "48", "--out", out], request);
      const captured = JSON.parse(readFileSync(out, "utf8"));
      assert.deepEqual(captured.map((t: {thread_id: string}) => t.thread_id), ["ok"]);
      assert.ok(captured.every((t: {sender: string}) => t.sender));
      const events = latestManifestEvents(out + ".fetch.jsonl");
      const failed = events.flatMap((e) => (e.outcomes ?? []).filter((o) => o.outcome === "falhou"));
      assert.deepEqual(failed.map((o) => o.thread_id), ["bad"]);
      const result = buildIntake(captured, registry, [scored], undefined, {}, [], [], {failedThreads: failed});
      assert.equal(result.rows.find((r) => r.thread_id === "bad")?.estado, "falhou");
      assert.deepEqual(result.pending_senders, [], "falha sem remetente nunca vira remetente pendente");
    } finally { rmSync(dir, {recursive: true, force: true}); }
  });

  it("an image-only HTML with link hrefs is readable, not 'Sem corpo legível'", async () => {
    const {request} = gmail({i: message([{name: "From", value: "ai@example.com"}], `<a href="${urls[0]}"><img src="https://cdn.example/x.png"></a>`)});
    const t = await fetchThread("i", 8000, request);
    assert.equal(t?.capture_error, undefined);
    assert.deepEqual(t?.urls_extraidas, [urls[0]]);
  });
});

describe("capture-newsletter-urls #12188 resume", () => {
  it("preserves an article whose mention has no '@' (unclassifiable legacy origin)", () => temp((dir) => {
    const input = resolve(dir, "threads.json"); const out = resolve(dir, "articles.json");
    writeFileSync(input, JSON.stringify([]));
    writeFileSync(out, JSON.stringify([{url: urls[0], newsletter_mentions: ["AI Roundup"]}, {url: urls[1], newsletter_mentions: ["new@example.com"]}]));
    captureMain(["node", "capture-newsletter-urls.ts", "--threads", input, "--out", out, "--cursor", resolve(dir, "cursor.json"), "--edition", "261105"]);
    assert.deepEqual(JSON.parse(readFileSync(out, "utf8")).map((a: {url: string}) => a.url), [urls[0]]);
  }));
});

describe("#12188 re-review fixes", () => {
  const runAudit = (editionDir: string, dir: string, registryPath: string, extra: string[] = []) =>
    spawnSync(process.execPath, ["--import", "tsx", "scripts/audit-newsletter-intake.ts", "--edition", "261105", "--edition-dir", editionDir, "--data-dir", dir, "--registry", registryPath, ...extra], {encoding: "utf8"});
  const report = (internal: string) => JSON.parse(readFileSync(resolve(internal, "newsletter-link-scores.json"), "utf8"));

  it("item 1: fetch/enrich failure registered → warning, never error; only 'nobody tried' blocks", () => temp((dir) => {
    const editionDir = resolve(dir, "edition"); const internal = resolve(editionDir, "_internal"); mkdirSync(internal, {recursive: true});
    const registryPath = resolve(dir, "senders.json"); writeFileSync(registryPath, JSON.stringify(registry));
    writeFileSync(resolve(internal, "captured-newsletters.json"), JSON.stringify([thread()]));
    writeFileSync(resolve(internal, "tmp-articles-raw.json"), JSON.stringify(urls.map((url) => ({url}))));
    writeFileSync(resolve(internal, "tmp-allscored.json"), JSON.stringify({all_scored: [{url: urls[0], score: 80, title: "One"}]}));
    const blocked = runAudit(editionDir, dir, registryPath, ["--require-scores"]);
    assert.equal(blocked.status, 1, "link no pool sem score e sem tentativa bloqueia");
    assert.ok(checkNewsletterIntake(editionDir).some((v) => v.severity === "error" && v.message.includes("sem score")));
    // Paywall registrado no gate (scorer não leu a URL).
    writeFileSync(resolve(internal, "newsletter-fetch-failures.json"), JSON.stringify([{url: urls[1], reason: "paywall"}]));
    const ok = runAudit(editionDir, dir, registryPath, ["--require-scores"]);
    assert.equal(ok.status, 0, ok.stderr);
    const r = report(internal);
    const link = r.links.find((l: {url: string}) => l.url === urls[1]);
    assert.equal(link.fetch_error, "paywall");
    assert.equal(link.score_status, "falha-fetch");
    const v = checkNewsletterIntake(editionDir);
    assert.ok(!v.some((x) => x.severity === "error"), JSON.stringify(v));
    assert.ok(v.some((x) => x.severity === "warning" && x.message.includes("falha de fetch")));
    assert.ok(readFileSync(resolve(internal, "newsletter-intake-gate.md"), "utf8").includes("FALHA FETCH (paywall)"));
  }));

  it("item 1: enrich stdout outcomes (fetch_failed) count as a registered failure", () => temp((dir) => {
    const internal = resolve(dir, "_internal"); mkdirSync(internal);
    writeFileSync(resolve(internal, "newsletter-unscored.enrich.json"), JSON.stringify({outcomes: [
      {url: urls[0], enriched: false, reason: "fetch_failed"}, {url: urls[1], enriched: true}, {url: "https://x.example/a", enriched: false, reason: "cache_miss_skipped_non_inbox"},
    ]}));
    const failures = readFetchFailures(internal);
    assert.equal(failures.size, 1);
    assert.match([...failures.values()][0], /fetch_failed/);
  }));

  it("item 1: links removed before the pool (dedup/date) do not need a score — warning only", () => temp((dir) => {
    const editionDir = resolve(dir, "edition"); const internal = resolve(editionDir, "_internal"); mkdirSync(internal, {recursive: true});
    const registryPath = resolve(dir, "senders.json"); writeFileSync(registryPath, JSON.stringify(registry));
    writeFileSync(resolve(internal, "captured-newsletters.json"), JSON.stringify([thread()]));
    writeFileSync(resolve(internal, "tmp-articles-raw.json"), JSON.stringify([{url: urls[0]}]));
    writeFileSync(resolve(internal, "tmp-allscored.json"), JSON.stringify({all_scored: [{url: urls[0], score: 80, title: "One"}]}));
    const run = runAudit(editionDir, dir, registryPath, ["--require-scores"]);
    assert.equal(run.status, 0, run.stderr);
    const link = report(internal).links.find((l: {url: string}) => l.url === urls[1]);
    assert.equal(link.in_pool, false);
    assert.equal(linkMissingBlocks(link), false);
    const v = checkNewsletterIntake(editionDir);
    assert.ok(!v.some((x) => x.severity === "error"), JSON.stringify(v));
    assert.ok(v.some((x) => x.message.includes("removido(s) antes do pool")));
  }));

  it("item 2: registry absent/invalid falls back to config senders with an explicit error", () => temp((dir) => {
    const missing = resolveSenderRegistry(() => readFileSync(resolve(dir, "nope.json"), "utf8"), ["A <A@X.COM>"]);
    assert.equal(missing.missing, true);
    assert.match(missing.error ?? "", /ausente/);
    assert.equal(classifySender("a@x.com", missing.registry).classificacao, "IA");
    const invalid = resolveSenderRegistry(() => "{bad", ["a@x.com"]);
    assert.match(invalid.error ?? "", /inválido/);
    assert.equal(classifySender("a@x.com", invalid.registry).classificacao, "IA");
    assert.deepEqual(Object.keys(fallbackSenderRegistry(["sem-arroba"]).senders), []);
  }));

  it("item 2: capture-newsletter-urls with an invalid registry keeps config senders and logs error (never crashes)", () => temp((dir) => {
    const config = JSON.parse(readFileSync("platform.config.json", "utf8")) as {newsletter_auto_capture?: {senders?: string[]}};
    const sender = config.newsletter_auto_capture?.senders?.[0];
    assert.ok(sender, "config precisa de ao menos 1 sender para este teste");
    const input = resolve(dir, "threads.json"); const out = resolve(dir, "articles.json");
    const badRegistry = resolve(dir, "bad.json"); writeFileSync(badRegistry, "{ not json");
    writeFileSync(input, JSON.stringify([thread("c", sender)]));
    captureMain(["node", "capture-newsletter-urls.ts", "--threads", input, "--out", out, "--cursor", resolve(dir, "cursor.json")], {registryPath: badRegistry, logRoot: dir});
    assert.ok(JSON.parse(readFileSync(out, "utf8")).length > 0, "fallback: sender do config segue no pool");
    const log = readFileSync(resolve(dir, "data/run-log.jsonl"), "utf8");
    assert.match(log, /"level":"error".*newsletter-senders\.json inválido/);
  }));

  it("P3: capture config_warnings count dropped threads and removed existing articles", () => temp((dir) => {
    const input = resolve(dir, "threads.json"); const out = resolve(dir, "articles.json");
    writeFileSync(input, JSON.stringify([thread("x", "pendente@example.com")]));
    writeFileSync(out, JSON.stringify([{url: urls[0], newsletter_mentions: ["pendente@example.com"]}]));
    const lines: string[] = []; const orig = console.log; console.log = (m: string) => { lines.push(m); };
    try {
      captureMain(["node", "capture-newsletter-urls.ts", "--threads", input, "--out", out, "--cursor", resolve(dir, "cursor.json")], {logRoot: dir});
    } finally { console.log = orig; }
    const summary = JSON.parse(lines.join("\n"));
    assert.ok(summary.config_warnings.some((w: string) => /1 thread\(s\) de remetente não aprovado/.test(w)));
    assert.ok(summary.config_warnings.some((w: string) => /1 artigo\(s\) já gravado\(s\)/.test(w)));
  }));

  it("item 3: swapping a non-newsletter Radar link does not make the intake stale", () => temp((dir) => {
    const {editionDir, audit} = setupEdition(dir);
    writeFileSync(resolve(editionDir, "02-reviewed.md"), reviewedMd("https://example.org/radar-a"));
    assert.equal(audit().status, 0);
    const stale = () => checkNewsletterIntake(editionDir).some((v) => v.message.includes("desatualizado"));
    assert.equal(stale(), false);
    writeFileSync(resolve(editionDir, "02-reviewed.md"), reviewedMd("https://example.org/radar-b"));
    assert.equal(stale(), false, "link do Radar fora das newsletters auditadas não entra no fingerprint");
    writeFileSync(resolve(editionDir, "02-reviewed.md"), reviewedMd(urls[1]));
    assert.equal(stale(), true, "incluir link de newsletter auditada muda o fingerprint");
  }));

  it("item 3: fingerprint only hashes reviewed entries among the audited keys", () => temp((dir) => {
    mkdirSync(resolve(dir, "_internal"));
    writeFileSync(resolve(dir, "02-reviewed.md"), reviewedMd("https://example.org/a"));
    const a = computeIntakeFingerprint(dir, resolve(dir, "r.json"), []);
    writeFileSync(resolve(dir, "02-reviewed.md"), reviewedMd("https://example.org/b"));
    assert.equal(computeIntakeFingerprint(dir, resolve(dir, "r.json"), []), a);
  }));

  it("items 4+5: coverage counts only approved senders whose body was read", () => {
    const captured = [
      {sender: "AI <ai@example.com>", thread_id: "1"},
      {sender: "ai2@example.com", thread_id: "2", capture_error: "Sem corpo legível"},
      {sender: "config-only@example.com", thread_id: "3"},
      {thread_id: "legacy"},
    ];
    assert.equal(countSubmissionSources([], captured).newsletterSenders, 3, "capture_error nunca conta");
    const approved = (s: string) => classifySender(s, registry).classificacao === "IA";
    const countable = countableCapturedNewsletters(captured, approved);
    assert.deepEqual(countable.map((c) => c.thread_id), ["1", "legacy"]);
    assert.equal(countSubmissionSources([], countable).newsletterSenders, 2);
  });

  it("items 4+5 (marker fallback): coverage reads the registry and skips unapproved / unread threads", () => temp((dir) => {
    const registryPath = resolve(dir, "senders.json"); writeFileSync(registryPath, JSON.stringify(registry));
    writeFileSync(resolve(dir, ".marker-inject-inbox-urls.json"), JSON.stringify({details: {editor_blocks: 0, newsletter_source: "captured-articles"}}));
    writeFileSync(resolve(dir, "captured-newsletters.json"), JSON.stringify([
      {thread_id: "1", sender: "ai@example.com"}, {thread_id: "2", sender: "config-only@example.com"},
      {thread_id: "3", sender: "other@example.com"}, {thread_id: "4", sender: "AI <ai@example.com>", capture_error: "Sem corpo legível"},
    ]));
    process.env.DIARIA_NEWSLETTER_SENDERS_PATH = registryPath;
    try { assert.equal(readSubmissionCountFromMarker(dir), 1); } finally { delete process.env.DIARIA_NEWSLETTER_SENDERS_PATH; }
  }));

  it("item 6: discovery cap flags only when there is a next page", async () => {
    const page = (n: number, next?: string) => ({threads: Array.from({length: n}, (_, i) => ({id: `t${i}`})), ...(next ? {nextPageToken: next} : {})});
    const exact = async <T>(): Promise<T> => page(5) as T;
    assert.equal((await searchThreadIdsPaged("q", 100, exact, 5)).truncated, false);
    const more = async <T>(): Promise<T> => page(5, "p2") as T;
    assert.equal((await searchThreadIdsPaged("q", 100, more, 5)).truncated, true);
  });

  it("item 6 (CLI): discovery hitting the cap with a next page writes capped:true in the manifest and the audit warns", async () => {
    const dir = mkdtempSync(resolve(tmpdir(), "intake-12188-"));
    try {
      let listed = 0;
      const request = async <T>(path: string): Promise<T> => {
        if (path.startsWith("threads?")) { listed++; return {threads: Array.from({length: 100}, (_, i) => ({id: `p${listed}-${i}`})), nextPageToken: `n${listed}`} as T; }
        return {id: path.slice(8).split("?")[0], messages: [{id: "m", internalDate: "1", payload: {mimeType: "text/plain", headers: [{name: "From", value: "x@y.com"}]}}]} as T;
      };
      const out = resolve(dir, "discovered-newsletters.json");
      await fetchMain(["node", "f", "--discover", "--since-hours", "48", "--out", out], request);
      const events = latestManifestEvents(out + ".fetch.jsonl");
      assert.equal(events[0].capped, true);
      assert.ok(discoveryWarnings(events, "ok").some((w) => w.includes("teto")));
    } finally { rmSync(dir, {recursive: true, force: true}); }
  });

  it("items 7+8: unread discovery threads and unavailable discovery are warnings, never '0 encontradas'", () => {
    const ok = {at: "x", scope: "d", thread_ids: ["a", "b", "c"], outcomes: [{thread_id: "a", outcome: "descoberta"}, {thread_id: "b", outcome: "falhou"}, {thread_id: "c", outcome: "falhou"}]};
    assert.ok(discoveryWarnings([ok], "ok").some((w) => w === "2 thread(s) da descoberta não foram lidas (falha ao ler metadados)"));
    assert.ok(discoveryWarnings([], "ausente").some((w) => w.startsWith("Descoberta indisponível: manifesto ausente")));
    assert.ok(discoveryWarnings([ok], "ilegível").some((w) => w.startsWith("Descoberta indisponível: arquivo ilegível")));
    assert.ok(discoveryWarnings([ok], "ausente").some((w) => w.startsWith("Descoberta indisponível: arquivo ausente")));
    assert.deepEqual(discoveryWarnings([{...ok, outcomes: []}], "ok"), []);
  });

  it("item 8 (CLI): unreadable discovered-newsletters.json becomes a warning in the report", () => temp((dir) => {
    const {internal, audit} = setupEdition(dir);
    writeFileSync(resolve(internal, "discovered-newsletters.json.fetch.jsonl"), JSON.stringify({scope: "d", thread_ids: []}) + "\n");
    writeFileSync(resolve(internal, "discovered-newsletters.json"), "{bad");
    assert.equal(audit().status, 0);
    assert.ok(report(internal).warnings.some((w: string) => w.includes("arquivo ilegível")));
  }));

  it("item 9: invariant evaluates the report even with zero captured threads or no captured file", () => temp((dir) => {
    const internal = resolve(dir, "_internal"); mkdirSync(internal);
    assert.deepEqual(checkNewsletterIntake(dir), [], "captura nunca rodou: nada a auditar");
    writeFileSync(resolve(internal, ".capture-newsletter-failed.json"), JSON.stringify({failed: true}));
    assert.ok(checkNewsletterIntake(dir).some((v) => v.message.includes("Intake ausente") && v.severity === "warning"), "sem threads: ausente é warning");
    writeFileSync(resolve(internal, "captured-newsletters.json"), "[]");
    writeFileSync(resolve(internal, "newsletter-link-scores.json"), JSON.stringify({links: [], rows: [], pending_senders: ["n@x.com"], warnings: ["capture_failed: captura Gmail falhou", "Descoberta de remetentes novos falhou: boom"]}));
    const v = checkNewsletterIntake(dir);
    assert.ok(v.some((x) => x.message.includes("capture_failed")));
    assert.ok(v.some((x) => x.message.includes("Descoberta de remetentes novos falhou")));
    assert.ok(v.some((x) => x.message.includes("pendentes")));
    assert.ok(v.some((x) => x.message.includes("desatualizado")), "relatório sem fingerprint é desatualizado mesmo sem threads");
  }));

  it("P3: no 'Total capturado != registrado' comparison (it could never fire)", () => temp((dir) => {
    const {editionDir, audit} = setupEdition(dir);
    assert.equal(audit().status, 0);
    assert.ok(!checkNewsletterIntake(editionDir).some((v) => v.message.includes("Total capturado")));
  }));

  it("item 10: --no-sentinel never clears nor writes the Stage 0 capture sentinel", async () => {
    const dir = mkdtempSync(resolve(tmpdir(), "intake-12188-"));
    try {
      const out = resolve(dir, "captured-newsletters.json");
      const sentinel = resolve(dir, ".capture-newsletter-failed.json");
      writeFileSync(sentinel, JSON.stringify({failed: true, error: "stage 0", at: "x"}));
      const empty = async <T>(): Promise<T> => ({threads: []}) as T;
      await fetchMain(["node", "f", "--senders", "ai@example.com", "--out", out, "--no-sentinel"], empty);
      assert.equal(JSON.parse(readFileSync(sentinel, "utf8")).error, "stage 0", "sucesso suplementar não apaga o sentinel");
      rmSync(sentinel);
      const boom = async <T>(): Promise<T> => { throw new Error("rede"); };
      await assert.rejects(fetchMain(["node", "f", "--senders", "ai@example.com", "--out", out, "--no-sentinel"], boom));
      assert.equal(existsSync(sentinel), false, "falha suplementar não grava o sentinel");
      await fetchMain(["node", "f", "--senders", "ai@example.com", "--out", out], empty);
      assert.equal(existsSync(sentinel), false);
      await assert.rejects(fetchMain(["node", "f", "--senders", "ai@example.com", "--out", out], boom));
      assert.ok(existsSync(sentinel), "sem a flag o comportamento do Stage 0 é o de sempre");
    } finally { rmSync(dir, {recursive: true, force: true}); }
  });

  it("P3: registry path inside the repo is stored relative; outside stays absolute", () => {
    assert.equal(portableRegistryPath(resolve("seed/newsletter-senders.json")), "seed/newsletter-senders.json");
    assert.equal(portableRegistryPath("/tmp/x/senders.json"), "/tmp/x/senders.json");
  });
});
