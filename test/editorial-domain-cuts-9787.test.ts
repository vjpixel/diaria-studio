/**
 * #9787 — domínios que o editor mais retira do que mantém no gate 4.
 *
 * Cobre os cenários pedidos na issue com fixtures de edição (rascunho que
 * chegou ao gate × aprovado): domínio candidato, abaixo do piso, já na
 * blacklist, já na lista de mantidos, item trocado de seção — e o monitor
 * incremental lendo edições reais em disco (snapshot stage2-post-gate).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  classifyEditionItems,
  formatGateQuestions,
  formatListEntry,
  insertSetEntry,
  MIN_CUT_OCCURRENCES,
  parseDecisionAnswers,
  parseDecisions,
  parseState,
  selectCandidates,
  stateItems,
  tallyByDomain,
  type ItemOutcomeRecord,
} from "../scripts/lib/editorial-domain-cuts.ts";
import { isDomainEditoriallyBlocked } from "../scripts/lib/editorial-blocklist.ts";
import { EDITORIAL_KEEP_LIST, isEditoriallyKept } from "../scripts/lib/editorial-keep-list.ts";
import { makeIsDecided, pendingDecisions, updateState } from "../scripts/editorial-domain-cuts.ts";

function edition(sections: Record<string, string[]>): string {
  const out = ["Olá! Eu sou o [Pixel](https://www.linkedin.com/in/vjpixel/), editor.", ""];
  for (const [name, urls] of Object.entries(sections)) {
    out.push("---", "", `**${name}**`, "");
    urls.forEach((u, i) => out.push(`**[Item ${i} de ${name}](${u})**  `, "Descrição.", ""));
  }
  return out.join("\n");
}

test("classifyEditionItems: retirado × mantido por URL; troca de seção conta como mantido", () => {
  const baseline = edition({
    "DESTAQUE 1 | 📦 PRODUTO": ["https://ruim.com/a"],
    "📡 RADAR": ["https://boa.com/x", "https://ruim.com/b", "https://movida.com/c"],
  });
  const final = edition({
    "DESTAQUE 1 | 📦 PRODUTO": ["https://boa.com/x"],
    "🛠️ USE MELHOR": ["https://movida.com/c"],
  });
  const r = classifyEditionItems(baseline, final);
  const by = Object.fromEntries(r.map((x) => [x.url, x.outcome]));
  assert.equal(by["https://ruim.com/a"], "retirado");
  assert.equal(by["https://ruim.com/b"], "retirado");
  assert.equal(by["https://boa.com/x"], "mantido", "destaque rebaixado/promovido segue presente");
  assert.equal(by["https://movida.com/c"], "mantido", "item trocado de seção conta como mantido");
  assert.ok(!r.some((x) => x.domain === "linkedin.com"), "intro/rodapé não-editorial fica de fora");
});

test("classifyEditionItems: URL corrigida da mesma página e barra final contam como mantido", () => {
  const baseline = edition({ "📡 RADAR": ["https://site.com/blog/um-slug-longo/", "https://outro.com/news/gemini-4-argon/"] });
  const final = edition({ "📡 RADAR": ["https://site.com/blog/um-slug-longo", "https://outro.com/news/models/gemini-4-argon/"] });
  assert.deepEqual(classifyEditionItems(baseline, final).map((x) => x.outcome), ["mantido", "mantido"]);
});

function rec(domain: string, outcome: "retirado" | "mantido", n: number): ItemOutcomeRecord[] {
  return Array.from({ length: n }, (_, i) => ({ url: `https://${domain}/${outcome}-${i}`, domain, section: "RADAR", outcome }));
}

test("selectCandidates: candidato, abaixo do piso, já decidido", () => {
  const tallies = tallyByDomain({
    "261001": [...rec("candidato.com", "retirado", 7), ...rec("candidato.com", "mantido", 3)],
    "261002": [...rec("poucas.com", "retirado", 6), ...rec("poucas.com", "mantido", 3)],
    "261003": [...rec("chatprd.ai", "retirado", 8), ...rec("chatprd.ai", "mantido", 2)],
    "261004": [...rec("mantido.com", "retirado", 6), ...rec("mantido.com", "mantido", 6)],
  });
  assert.equal(MIN_CUT_OCCURRENCES, 10, "piso decidido pelo editor em 06/10/2026");
  const isDecided = makeIsDecided([]);
  const names = selectCandidates(tallies, { isDecided }).map((c) => c.domain);
  assert.deepEqual(names, ["candidato.com"], "9 ocorrências fica abaixo do piso; empate não é candidato; blacklist não pergunta");
  assert.equal(isDomainEditoriallyBlocked("chatprd.ai"), true);
});

test("selectCandidates: domínio na lista de mantidos ou com decisão registrada nunca é reperguntado", () => {
  const tallies = tallyByDomain({ "261001": [...rec("keep.com", "retirado", 9), ...rec("keep.com", "mantido", 1)] });
  // lista de mantidos (simulada via decisão registrada `manter` — mesmo efeito em isDecided)
  const isDecided = makeIsDecided([{ domain: "keep.com", decision: "manter", decided_at: "2026-10-07T00:00:00Z" }]);
  assert.deepEqual(selectCandidates(tallies, { isDecided }), []);
  // subdomínio de um domínio decidido também
  assert.equal(makeIsDecided([{ domain: "keep.com", decision: "manter", decided_at: "x" }])("blog.keep.com"), true);
  assert.equal(isEditoriallyKept("nunca-listado.example"), false);
  assert.ok(EDITORIAL_KEEP_LIST instanceof Set);
});

test("formatGateQuestions: uma pergunta por candidato, com exemplos retirados; vazio sem candidato", () => {
  assert.equal(formatGateQuestions([]), "");
  const [c] = tallyByDomain({ "261001": [...rec("x.com", "retirado", 8), ...rec("x.com", "mantido", 2)] });
  const block = formatGateQuestions([c]);
  assert.match(block, /x\.com: retirado 8× × mantido 2×/);
  assert.match(block, /"x\.com=retirar" ou "x\.com=manter"/);
  assert.match(block, /261001 RADAR: https:\/\/x\.com\/retirado-0/);
});

test("parseDecisionAnswers: aceita retirar/manter e sim/nao; rejeita lixo", () => {
  assert.deepEqual(parseDecisionAnswers("WWW.A.com=retirar, b.org=manter,c.net=sim,d.io=não"), [
    { domain: "a.com", decision: "retirar" },
    { domain: "b.org", decision: "manter" },
    { domain: "c.net", decision: "retirar" },
    { domain: "d.io", decision: "manter" },
  ]);
  assert.throws(() => parseDecisionAnswers("a.com=talvez"));
  assert.throws(() => parseDecisionAnswers(""));
});

test("parseDecisions: última decisão por domínio vence, linha corrompida ignorada", () => {
  const raw = [
    JSON.stringify({ domain: "a.com", decision: "retirar", decided_at: "1" }),
    "{lixo",
    JSON.stringify({ domain: "a.com", decision: "manter", decided_at: "2" }),
  ].join("\n");
  assert.deepEqual(parseDecisions(raw).map((d) => d.decision), ["manter"]);
});

test("insertSetEntry + pendingDecisions: aplica no padrão do arquivo, idempotente", () => {
  const src = readFileSync(join(import.meta.dirname, "..", "scripts", "lib", "editorial-blocklist.ts"), "utf8");
  const d = { domain: "novo.example", decision: "retirar" as const, decided_at: "2026-10-08T12:00:00Z", edition: "261008", retirado: 9, mantido: 2 };
  const entry = formatListEntry(d);
  assert.match(entry, /^ {2}"novo\.example", \/\/ editor 261008 — .*#9787.*retirado 9× × mantido 2×/);
  const once = insertSetEntry(src, "EDITORIAL_BLOCKLIST", d.domain, entry);
  assert.ok(once.includes(entry + "\n]);"), "entra como última linha do Set");
  assert.equal(insertSetEntry(once, "EDITORIAL_BLOCKLIST", d.domain, entry), once, "idempotente");
  assert.deepEqual(pendingDecisions([d], src, ""), [d]);
  assert.deepEqual(pendingDecisions([d], once, ""), []);
  assert.throws(() => insertSetEntry(src, "NAO_EXISTE", "x", "y"));
  const keepSrc = readFileSync(join(import.meta.dirname, "..", "scripts", "lib", "editorial-keep-list.ts"), "utf8");
  const k = insertSetEntry(keepSrc, "EDITORIAL_KEEP_LIST", "k.example", formatListEntry({ ...d, domain: "k.example", decision: "manter" }));
  assert.match(k, /new Set<string>\(\[\n {2}"k\.example", \/\/ editor 261008 — editor pediu explicitamente para manter/);
});

// ---------------------------------------------------------------------------
// Monitor incremental sobre edições em disco
// ---------------------------------------------------------------------------

function writeEdition(root: string, ed: string, baseline: string, final: string, closed: boolean): void {
  const dir = join(root, ed.slice(0, 4), ed);
  const snap = join(dir, "_internal", "editor-request-snapshots", "stage2-post-gate");
  mkdirSync(snap, { recursive: true });
  writeFileSync(join(snap, "02-reviewed.md"), baseline);
  writeFileSync(join(snap, ".capture.json"), JSON.stringify({ captured_at: "2026-10-01T10:00:00Z", trigger: "pipeline-sentinel-step-2" }));
  writeFileSync(join(dir, "02-reviewed.md"), final);
  writeFileSync(join(dir, "_internal", ".step-2-done.json"), JSON.stringify({ completed_at: "2026-10-01T10:00:00Z" }));
  if (closed) writeFileSync(join(dir, "_internal", ".step-4-done.json"), JSON.stringify({ completed_at: "2026-10-01T12:00:00Z" }));
}

test("updateState: conta só edições fechadas anteriores à edição em curso, incremental", () => {
  const root = mkdtempSync(join(tmpdir(), "edc-9787-"));
  try {
    const b = edition({ "📡 RADAR": ["https://corta.com/1", "https://fica.com/1"] });
    const f = edition({ "📡 RADAR": ["https://fica.com/1"] });
    writeEdition(root, "261001", b, f, true);
    writeEdition(root, "261002", b, f, true);
    writeEdition(root, "261003", b, f, false); // gate 4 ainda não aprovado
    writeEdition(root, "261004", b, f, true); // edição do gate atual
    const state = parseState(null, "now");
    assert.equal(updateState(state, root, { before: "261004", now: "t1" }), 2);
    assert.deepEqual(Object.keys(state.editions).sort(), ["261001", "261002"]);
    const t = tallyByDomain(stateItems(state));
    assert.deepEqual(t.map((x) => [x.domain, x.retirado, x.mantido]), [["corta.com", 2, 0], ["fica.com", 0, 2]]);
    assert.equal(state.editions["261001"].baseline_source, "snapshot");
    assert.equal(updateState(state, root, { before: "261004", now: "t2" }), 0, "edição já contada não é recontada");
    assert.equal(updateState(state, root, { now: "t3" }), 1, "sem --edition entra a 261004 (fechada); 261003 nunca");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("parseState: JSON inválido ou versão antiga ⇒ recontagem completa", () => {
  assert.deepEqual(parseState("{lixo", "n").editions, {});
  assert.deepEqual(parseState(JSON.stringify({ version: 0, editions: { "261001": {} } }), "n").editions, {});
});
