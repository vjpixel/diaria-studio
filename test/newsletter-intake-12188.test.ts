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
