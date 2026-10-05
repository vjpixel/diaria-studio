/**
 * #9673 — regra do editor de 05/10/2026: no gate 4, cada item 🔎 (modo sombra
 * da penalidade de estudo/case genérico, #9462) exige resposta EXPLÍCITA
 * sim/não. Silêncio = `nao_lido`; manter/tirar o item no texto não é
 * resposta; a decisão de ligar a flag usa só respostas explícitas.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  MIN_EXPLICIT_ANSWERS,
  aggregateShadowFeedback,
  buildFeedback,
  formatGateQuestions,
  parseAnswersArg,
  shadowItemsFromLog,
  shadowVerdict,
  type GenericStudyFeedbackItem,
} from "../scripts/lib/generic-study-feedback.ts";
import { feedbackPath, recordGenericStudyFeedback } from "../scripts/generic-study-gate-feedback.ts";
import { collectShadowFeedback } from "../scripts/generic-study-shadow-report.ts";

const ROOT = resolve(import.meta.dirname, "..");

const URL_A = "https://exemplo.com/estudo-70-medicos";
const URL_B = "https://exemplo.com/case-sabin";
const URL_OTHER = "https://exemplo.com/lancamento";

const SHADOW_LOG = {
  applied: false,
  demoted: [
    { url: URL_A, title: "Quase 70% dos médicos já usam IA, aponta estudo", from_rank: 1, to_rank: 4, signals: ["estudo"] },
    { url: URL_B, title: "Grupo Sabin reduz em 25% o tempo de atendimento com IA", from_rank: 3, to_rank: 5, signals: ["case"] },
  ],
  kept: [],
};

function reviewedMd(urls: string[]): string {
  return urls
    .map(
      (u, i) =>
        `**DESTAQUE ${i + 1} | GERAL**\n\n**[Título ${i + 1}](${u})**\n\nCorpo.\n\nPor que isso importa:\n\nPorque sim.`,
    )
    .join("\n\n---\n\n");
}

function makeEdition(root: string, aammdd: string, opts: { log?: unknown; reviewed?: string[] } = {}): string {
  const dir = join(root, aammdd.slice(0, 4), aammdd);
  mkdirSync(join(dir, "_internal"), { recursive: true });
  if (opts.log !== undefined) writeFileSync(join(dir, "_internal", "01-generic-study-demoted.json"), JSON.stringify(opts.log));
  if (opts.reviewed) writeFileSync(join(dir, "02-reviewed.md"), reviewedMd(opts.reviewed));
  return dir;
}

describe("shadowItemsFromLog", () => {
  it("só modo sombra (applied:false) gera pergunta", () => {
    assert.equal(shadowItemsFromLog(SHADOW_LOG).length, 2);
    assert.deepEqual(shadowItemsFromLog({ ...SHADOW_LOG, applied: true }), []);
    assert.deepEqual(shadowItemsFromLog(null), []);
    assert.deepEqual(shadowItemsFromLog({ applied: false, demoted: [] }), []);
  });
});

describe("formatGateQuestions", () => {
  it("pergunta explícita sim/não por item, e nada sem item", () => {
    const block = formatGateQuestions(shadowItemsFromLog(SHADOW_LOG));
    assert.match(block, /1\. Concorda que "Quase 70% dos médicos já usam IA, aponta estudo" sairia do destaque\? responda sim\/não/);
    assert.match(block, /2\. Concorda que "Grupo Sabin .*" sairia do destaque\? responda sim\/não/);
    assert.match(block, /Sem resposta = "não lido"/);
    assert.equal(formatGateQuestions([]), "");
  });
});

describe("parseAnswersArg", () => {
  it("aceita sim/não com e sem acento e separadores variados", () => {
    const m = parseAnswersArg("1=sim, 2:Não", 2);
    assert.equal(m.get(1), "sim");
    assert.equal(m.get(2), "nao");
    assert.equal(parseAnswersArg(undefined, 2).size, 0);
  });
  it("lança em resposta mal formada ou índice fora do intervalo (nunca vira nao_lido em silêncio)", () => {
    assert.throws(() => parseAnswersArg("1=talvez", 2));
    assert.throws(() => parseAnswersArg("3=sim", 2));
    assert.throws(() => parseAnswersArg("sim", 2));
  });
});

describe("buildFeedback", () => {
  const items = shadowItemsFromLog(SHADOW_LOG);
  const now = "2026-10-06T12:00:00.000Z";

  it("sem resposta ⇒ nao_lido, respondido_em null", () => {
    const fb = buildFeedback({ items, answers: new Map(), reviewedMd: null, now });
    assert.deepEqual(fb.map((f) => f.resposta), ["nao_lido", "nao_lido"]);
    assert.deepEqual(fb.map((f) => f.respondido_em), [null, null]);
  });

  it("manter o item no destaque sem responder NÃO vira 'nao' (só acao_no_final)", () => {
    const fb = buildFeedback({ items, answers: new Map(), reviewedMd: reviewedMd([URL_A, URL_OTHER, URL_B]), now });
    assert.deepEqual(fb.map((f) => f.resposta), ["nao_lido", "nao_lido"]);
    assert.deepEqual(fb.map((f) => f.acao_no_final), ["manteve", "manteve"]);
  });

  it("tirar o item sem responder NÃO vira 'sim'", () => {
    const fb = buildFeedback({ items, answers: new Map(), reviewedMd: reviewedMd([URL_OTHER]), now });
    assert.deepEqual(fb.map((f) => f.resposta), ["nao_lido", "nao_lido"]);
    assert.deepEqual(fb.map((f) => f.acao_no_final), ["tirou", "tirou"]);
  });

  it("resposta explícita é gravada independente da ação no texto", () => {
    const fb = buildFeedback({
      items,
      answers: new Map([[1, "nao" as const], [2, "sim" as const]]),
      reviewedMd: reviewedMd([URL_OTHER, URL_A]),
      now,
    });
    assert.deepEqual(fb.map((f) => [f.resposta, f.acao_no_final, f.respondido_em]), [
      ["nao", "manteve", now],
      ["sim", "tirou", now],
    ]);
  });

  it("re-registro sem resposta preserva resposta explícita anterior; resposta nova vence", () => {
    const previous: GenericStudyFeedbackItem[] = [
      { url: URL_A, titulo: "x", resposta: "sim", respondido_em: "2026-10-06T10:00:00.000Z", acao_no_final: null },
      { url: URL_B, titulo: "y", resposta: "nao_lido", respondido_em: null, acao_no_final: null },
    ];
    const fb = buildFeedback({ items, answers: new Map([[2, "nao" as const]]), reviewedMd: null, now, previous });
    assert.equal(fb[0].resposta, "sim");
    assert.equal(fb[0].respondido_em, "2026-10-06T10:00:00.000Z");
    assert.equal(fb[1].resposta, "nao");
  });
});

describe("recordGenericStudyFeedback (CLI --record)", () => {
  it("grava 04-generic-study-feedback.json com nao_lido quando o editor não respondeu", () => {
    const root = mkdtempSync(join(tmpdir(), "gsf-"));
    const dir = makeEdition(root, "261006", { log: SHADOW_LOG, reviewed: [URL_A, URL_B, URL_OTHER] });
    const file = recordGenericStudyFeedback({ editionDir: dir, now: "2026-10-06T12:00:00.000Z" });
    assert.ok(file);
    const disk = JSON.parse(readFileSync(feedbackPath(dir), "utf8"));
    assert.equal(disk.edition, "261006");
    assert.deepEqual(
      disk.items.map((i: GenericStudyFeedbackItem) => [i.url, i.resposta, i.acao_no_final]),
      [
        [URL_A, "nao_lido", "manteve"],
        [URL_B, "nao_lido", "manteve"],
      ],
    );
    assert.ok(disk.items.every((i: GenericStudyFeedbackItem) => "titulo" in i && "respondido_em" in i));
  });

  it("sem item em modo sombra não grava nada; --answers inválido não grava", () => {
    const root = mkdtempSync(join(tmpdir(), "gsf-"));
    const noShadow = makeEdition(root, "261007", { log: { ...SHADOW_LOG, applied: true } });
    assert.equal(recordGenericStudyFeedback({ editionDir: noShadow }), null);
    assert.equal(existsSync(feedbackPath(noShadow)), false);
    const dir = makeEdition(root, "261008", { log: SHADOW_LOG });
    assert.throws(() => recordGenericStudyFeedback({ editionDir: dir, answers: "1=talvez" }));
    assert.equal(existsSync(feedbackPath(dir)), false);
  });
});

describe("agregador (decisão da #9673)", () => {
  const item = (resposta: GenericStudyFeedbackItem["resposta"], acao: GenericStudyFeedbackItem["acao_no_final"] = "manteve") =>
    ({ url: `https://x/${Math.random()}`, titulo: "t", resposta, respondido_em: null, acao_no_final: acao }) as GenericStudyFeedbackItem;

  it("menos de 5 respostas explícitas ⇒ insuficiente — continuar perguntando", () => {
    assert.equal(MIN_EXPLICIT_ANSWERS, 5);
    const v = shadowVerdict(4, 0);
    assert.equal(v.verdict, "insuficiente");
    assert.match(v.verdict_text, /insuficiente — continuar perguntando/);
  });

  it("nao_lido não entra no veredito, por mais que haja (e acao_no_final também não)", () => {
    const r = aggregateShadowFeedback([
      { edition: "261006", items: [item("sim"), item("sim"), ...Array.from({ length: 10 }, () => item("nao_lido", "manteve"))] },
    ]);
    assert.equal(r.respondidos, 2);
    assert.equal(r.nao_lido, 10);
    assert.equal(r.acao.manteve, 12);
    assert.equal(r.verdict, "insuficiente");
  });

  it("≥5 explícitas sem 'não' ⇒ ligar; com 'não' ⇒ perguntar ao editor", () => {
    const five = Array.from({ length: 5 }, () => item("sim"));
    assert.equal(aggregateShadowFeedback([{ edition: "261006", items: five }]).verdict, "ligar");
    const r = aggregateShadowFeedback([{ edition: "261006", items: [...five, item("nao", "manteve"), item("nao_lido")] }]);
    assert.equal(r.verdict, "perguntar");
    assert.equal(r.nao_items.length, 1);
  });

  it("collectShadowFeedback: ≥since, sem registro conta como nao_lido", () => {
    const root = mkdtempSync(join(tmpdir(), "gsr-"));
    makeEdition(root, "261005", { log: SHADOW_LOG }); // antes do corte
    const d6 = makeEdition(root, "261006", { log: SHADOW_LOG, reviewed: [URL_OTHER] });
    recordGenericStudyFeedback({ editionDir: d6, answers: "1=sim" });
    makeEdition(root, "261007", { log: SHADOW_LOG }); // gate sem registro
    makeEdition(root, "261008", { log: { ...SHADOW_LOG, applied: true } }); // flag ligada: nada
    const eds = collectShadowFeedback(root, "261006");
    assert.deepEqual(eds.map((e) => e.edition), ["261006", "261007"]);
    const r = aggregateShadowFeedback(eds);
    assert.equal(r.sim, 1);
    assert.equal(r.nao_lido, 3);
    assert.equal(r.sem_registro, 2);
    assert.equal(r.acao.tirou, 2); // 261006 (d6 sem os itens no destaque)
    assert.equal(r.acao.desconhecida, 2); // 261007 sem 02-reviewed.md
    assert.equal(r.verdict, "insuficiente");
  });
});

describe("playbook do Stage 4 (guard textual)", () => {
  const md = readFileSync(join(ROOT, ".claude/agents/orchestrator-stage-4.md"), "utf8");

  it("resumo do gate tem o bloco de perguntas logo abaixo do cabeçalho", () => {
    const header = md.indexOf("📋 REVISÃO EDITORIAL — Edição {AAMMDD}");
    const block = md.indexOf("{generic_study_questions_block}", header);
    const destaques = md.indexOf("━━━ DESTAQUES", header);
    assert.ok(header > 0 && block > header && block < destaques, "bloco ❓ precisa vir antes de DESTAQUES/avisos");
  });

  it("pergunta explícita sim/não por item, gerada pelo script", () => {
    assert.match(md, /generic-study-gate-feedback\.ts --edition-dir \{EDITION_DIR\} --questions/);
    assert.match(md, /Concorda que "<título>" sairia do destaque\? responda sim\/não/);
  });

  it("registro na aprovação, sem resposta ⇒ nao_lido, ação no texto não é resposta", () => {
    assert.match(md, /generic-study-gate-feedback\.ts --edition-dir \{EDITION_DIR\} --record/);
    assert.match(md, /`nao_lido`/);
    assert.match(md, /Nunca derivar resposta de ele ter mantido ou tirado o item/);
  });

  it("modo sombra não fica mais perdido no violations_block", () => {
    assert.doesNotMatch(md, /listar `demoted\[\]` como 🔎 "seria rebaixado"/);
  });
});
