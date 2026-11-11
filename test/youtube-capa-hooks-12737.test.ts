/**
 * #12737 — sugestão de texto de capa do vídeo do dia (o "gancho").
 * Cobre a diretriz (tamanho, repetição do título, jargão, número), o caso real
 * de 261111 (o gancho aprovado pelo editor sai acima do recusado), o topo com
 * pergunta E afirmação, o `--hook` pronto por formato, o registro e o cruzamento
 * com as views, e o CLI ponta a ponta numa edição sintética.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CAPA_HOOKS_RECORD_FILE,
  capaHookWords,
  horizontalHookArg,
  joinHookHistory,
  rankCapaHooks,
  salientNumbers,
  scoreCapaHook,
  seedCapaHooks,
  shortHookArg,
  upsertCapaHookRecord,
} from "../scripts/lib/diaria/youtube-capa-hooks.ts";
import { parseCandidatesFile, parseSuggestArgs } from "../scripts/suggest-capa-hooks.ts";

const D1_261111 = { title: "Nubank demite time antifraude e põe IA no lugar", body: "O banco demitiu 40 pessoas que treinaram o sistema." };

test("261111: o gancho aprovado pelo editor fica acima do recusado", () => {
  const aprovado = scoreCapaHook("Ensinaram a IA e foram demitidos", D1_261111);
  const recusado = scoreCapaHook("IA demitiu?", D1_261111);
  assert.equal(aprovado.violations.length, 0);
  assert.ok(aprovado.score > recusado.score, `${aprovado.score} > ${recusado.score}`);
  assert.equal(aprovado.potential, "alto");
  assert.match(recusado.notes.join(" "), /fórmula "IA \.\.\.\?"/);
});

test("trecho literal do título é violação, não só penalidade", () => {
  const s = scoreCapaHook("Nubank demite time antifraude", D1_261111);
  assert.ok(s.violations.some((v) => /trecho literal do título/.test(v)));
  assert.equal(s.potential, "baixo");
  assert.ok(s.score <= 20);
});

test("repetição parcial do título é penalizada", () => {
  const rep = scoreCapaHook("Nubank põe IA antifraude?", D1_261111);
  const novo = scoreCapaHook("Treinou o próprio substituto?", D1_261111);
  assert.match(rep.notes.join(" "), /repete o título/);
  assert.ok(novo.score > rep.score);
});

test("tamanho: 1 palavra e 7 palavras quebram a diretriz", () => {
  assert.ok(scoreCapaHook("Demitidos?", D1_261111).violations.length > 0);
  assert.ok(scoreCapaHook("Eles ensinaram a IA e depois foram demitidos", D1_261111).violations.length > 0);
});

test("moeda + número conta como 1 palavra, como nos scripts de capa (#12278)", () => {
  assert.equal(capaHookWords("R$ 1 milhão por dia").length, 4);
  assert.equal(capaHookWords("Ensinaram a IA|e foram demitidos").length, 6);
});

test("jargão derruba o potencial; seta e emoji são violação", () => {
  assert.equal(scoreCapaHook("IA LLM agêntica", D1_261111).potential, "baixo");
  assert.ok(scoreCapaHook("Demitidos → pela IA", D1_261111).violations.some((v) => /seta/.test(v)));
  assert.ok(scoreCapaHook("Demitidos pela IA 😱", D1_261111).violations.some((v) => /emoji/.test(v)));
});

test("número do D1 ganha ponto; número que o D1 não traz vira alerta", () => {
  const ok = scoreCapaHook("40 demitidos pela IA", D1_261111);
  const inventado = scoreCapaHook("300 demitidos pela IA", D1_261111);
  assert.match(ok.notes.join(" "), /número concreto do D1/);
  assert.match(inventado.notes.join(" "), /não aparece no D1/);
  assert.ok(ok.score > inventado.score);
});

test("--hook pronto: horizontal quebra acima de 4 palavras, Short recusa 6", () => {
  assert.deepEqual(horizontalHookArg("IA ladra?"), { hook: "IA ladra?", reason: null });
  assert.equal(horizontalHookArg("Ensinaram a IA e foram demitidos").hook, "Ensinaram a IA|e foram demitidos");
  assert.equal(shortHookArg("Ensinaram a IA e foram demitidos").hook, null);
  assert.equal(shortHookArg("Treinou o próprio substituto?").hook, "Treinou o|próprio substituto?");
});

test("topo traz pergunta e afirmação mesmo quando as perguntas pontuam mais", () => {
  const d1 = { title: "Google usa fotos para anúncios" };
  const scores = [
    scoreCapaHook("Suas fotos viram anúncio?", d1),
    scoreCapaHook("Quem vê suas fotos?", d1),
    scoreCapaHook("Te vigiam pela galeria?", d1),
    scoreCapaHook("Sua galeria virou vitrine", d1),
  ];
  const ranked = rankCapaHooks(scores, 3);
  const top = ranked.slice(0, 3);
  assert.ok(top.some((s) => s.form === "pergunta"));
  assert.ok(top.some((s) => s.form === "afirmação"));
  assert.equal(ranked.length, 4);
});

test("ranking põe violação no fim e tira duplicata", () => {
  const ranked = rankCapaHooks([
    scoreCapaHook("Nubank demite time antifraude", D1_261111),
    scoreCapaHook("Treinou o próprio substituto?", D1_261111),
    scoreCapaHook("Treinou o próprio  substituto?", D1_261111),
  ]);
  assert.equal(ranked.length, 2);
  assert.equal(ranked[ranked.length - 1].violations.length > 0, true);
});

test("sementes: número com unidade e nome reconhecível do título", () => {
  assert.deepEqual(salientNumbers("Gasta R$ 1 milhão por dia em 2026 com 3 fornecedores e 40%"), ["R$ 1 milhão", "40%"]);
  const seeds = seedCapaHooks({ title: "OpenAI gasta R$ 1 milhão por dia", body: "" });
  assert.ok(seeds.includes("R$ 1 milhão"));
  assert.ok(seeds.includes("E o OpenAI?"));
});

test("registro: um gancho por formato, o novo substitui o anterior", () => {
  const now = new Date("2026-11-11T10:00:00Z");
  const a = upsertCapaHookRecord(null, { edition: "261111", d1Title: "x", format: "horizontal", hook: "IA demitiu?", now });
  const b = upsertCapaHookRecord(a, { edition: "261111", d1Title: "x", format: "horizontal", hook: "Ensinaram a IA|e foram demitidos", now });
  const c = upsertCapaHookRecord(b, { edition: "261111", d1Title: "x", format: "short", hook: "Treinou o substituto?", now });
  assert.deepEqual(c.entries.map((e) => [e.format, e.hook]), [["horizontal", "Ensinaram a IA|e foram demitidos"], ["short", "Treinou o substituto?"]]);
});

test("histórico cruza o gancho com a última captura de views do mesmo formato", () => {
  const rec = upsertCapaHookRecord(null, { edition: "261021", d1Title: "x", format: "horizontal", hook: "IA ladra?", now: new Date() });
  const rows = joinHookHistory([rec], [
    { edition: "261021", kind: "horizontal", views: 100, capturedAt: "2026-11-01T00:00:00Z" },
    { edition: "261021", kind: "horizontal", views: 152, capturedAt: "2026-11-10T00:00:00Z" },
    { edition: "261021", kind: "short", views: 999, capturedAt: "2026-11-10T00:00:00Z" },
  ]);
  assert.deepEqual(rows, [{ edition: "261021", format: "horizontal", hook: "IA ladra?", views: 152 }]);
  const semViews = joinHookHistory([rec], []);
  assert.equal(semViews[0].views, null);
});

test("CLI: --candidate repetível aceita `|` no valor; arquivo ignora vazio e comentário", () => {
  const a = parseSuggestArgs(["261111", "--candidate", "Ensinaram a IA|e foram demitidos", "--candidate=IA ladra?", "--json"]);
  assert.deepEqual(a.candidates, ["Ensinaram a IA|e foram demitidos", "IA ladra?"]);
  assert.ok(a.flags.has("json"));
  assert.deepEqual(parseCandidatesFile("# forma: pergunta\nIA ladra?\n\n  Golpe da selfie  \n"), ["IA ladra?", "Golpe da selfie"]);
});

test("CLI ponta a ponta: sugere a partir do 02-reviewed.md e grava o registro", () => {
  const dir = mkdtempSync(join(tmpdir(), "capa-hooks-12737-"));
  mkdirSync(join(dir, "_internal"), { recursive: true });
  writeFileSync(
    join(dir, "02-reviewed.md"),
    "DESTAQUE 1 | TRABALHO\nNubank demite time antifraude e põe IA no lugar\n\nO banco demitiu 40 pessoas.\n\nhttps://example.com/a\n\nPor que isso importa:\n\nTexto.\n\n---\n",
  );
  const cands = join(dir, "cands-12737.txt");
  writeFileSync(cands, "Ensinaram a IA e foram demitidos\nIA demitiu?\n");
  const out = execFileSync(process.execPath, ["--import", "tsx", "scripts/suggest-capa-hooks.ts", "--edition-dir", dir, "--candidates-file", cands, "--json"], { encoding: "utf8" });
  const parsed = JSON.parse(out) as { d1: { title: string }; suggestions: Array<{ hook: string; horizontal_hook: string | null }> };
  assert.equal(parsed.d1.title, "Nubank demite time antifraude e põe IA no lugar");
  assert.equal(parsed.suggestions[0].hook, "Ensinaram a IA e foram demitidos");
  assert.equal(parsed.suggestions[0].horizontal_hook, "Ensinaram a IA|e foram demitidos");

  execFileSync(process.execPath, ["--import", "tsx", "scripts/suggest-capa-hooks.ts", "--edition-dir", dir, "--record", "Ensinaram a IA|e foram demitidos", "--format", "horizontal"], { encoding: "utf8" });
  const rec = JSON.parse(readFileSync(join(dir, CAPA_HOOKS_RECORD_FILE), "utf8")) as { entries: Array<{ format: string; hook: string }> };
  assert.deepEqual(rec.entries.map((e) => e.hook), ["Ensinaram a IA|e foram demitidos"]);
});

test("Passo A2 do /diaria-publica usa a diretriz e o script, não mais o '2 a 4 palavras'", () => {
  const skill = readFileSync(join(import.meta.dirname, "..", ".claude/skills/diaria-publica/SKILL.md"), "utf8");
  const a2 = skill.slice(skill.indexOf("### Passo A2"), skill.indexOf("### Passo A3"));
  assert.match(a2, /docs\/youtube-capa-texto\.md/);
  assert.match(a2, /suggest-capa-hooks\.ts \{AAMMDD\} --candidates-file/);
  assert.match(a2, /--record/);
  assert.doesNotMatch(a2, /Gancho:\*\* 2 a 4 palavras/);
  const doc = readFileSync(join(import.meta.dirname, "..", "docs/youtube-capa-texto.md"), "utf8");
  assert.match(doc, /## Diretriz/);
  assert.match(doc, /## Benchmark externo/);
});
