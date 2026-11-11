/**
 * test/video-montage-vertical-75s-12694.test.ts — #12694 (decisão do editor,
 * 10/11/2026, montagem da 261111): toda vertical (a da edição e os
 * cortes/Shorts avulsos) chega à prévia com até 75 s de fala, card de CTA fora
 * da conta. Acima disso o roteiro propõe o corte (roteiro enxuto com a duração
 * de cada frase) e `preview`/`review` saem com exit 1 e `[aviso] GATE
 * BLOQUEADO`, antes de baixar o bruto.
 *
 * Regressão do cenário da 261111: o 1º vertical do Nubank chegou à prévia com
 * 2:26 e o Short de automação com 1:27; os dois teriam passado pelo alvo
 * antigo (85 s, só aviso) sem bloqueio.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseBlocksFile, type BlockKey, type ResolvedItem, type SequencePlan, type SequenceSpec } from "../scripts/lib/diaria/video-montage.ts";
import {
  VERTICAL_TARGET_S,
  effectiveVerticalTargetS,
  itemSpeechSeconds,
  roteiroMarkdown,
  verticalPreviewGate,
  verticalTargetCheck,
  verticalTargetOverrideWarning,
  verticalTargetWarning,
} from "../scripts/lib/diaria/video-montage-docs.ts";
import { main, planHashOf, verticalDurationGateBlocks } from "../scripts/video-montagem.ts";

const SPEC_H: SequenceSpec = { target: "youtube", name: "Diaria comentada_Youtube_V1", width: 1920, height: 1080, order: ["comentario"], scales: [50, 62] };
const SPEC_V: SequenceSpec = { target: "outras-redes", name: "Diaria comentada_Vertical_V1", width: 1080, height: 1920, order: ["titulo", "resumo_curto", "comentario", "fecho"], scales: [115, 130] };

const item = (start: number, end: number, text: string): ResolvedItem => ({ interval: { start, end }, text, words: [], lastWordEnd: null, holdLimit: end, how: "explicit" });
const vplan = (seconds: number, spec: SequenceSpec = SPEC_V): SequencePlan => ({ spec, clips: [], durationFrames: Math.round(seconds * 30), script: "", missingBlocks: [], dropped: [] });

const resolved: Partial<Record<BlockKey, ResolvedItem[]>> = {
  titulo: [item(10, 13, "O Nubank quer um banco feito por IA.")],
  resumo_curto: [item(20, 40, "O banco disse que vai usar agentes para atender os clientes."), item(41, 55, "A meta é cortar o tempo de resposta pela metade.")],
  comentario: [item(400, 420, "Isso muda a relação com o cliente."), item(430, 445, "Vale lembrar que nem tudo deve ser automático.")],
  fecho: [item(900, 903, "Até amanhã.")],
};

describe("#12694: alvo de 75 s da vertical", () => {
  it("o alvo é 75 s e a edição só reduz", () => {
    assert.equal(VERTICAL_TARGET_S, 75);
    assert.equal(effectiveVerticalTargetS(), 75);
    assert.equal(effectiveVerticalTargetS(60), 60);
    assert.equal(effectiveVerticalTargetS(90), 75);
    assert.equal(verticalTargetOverrideWarning(undefined), null);
    assert.equal(verticalTargetOverrideWarning(75), null);
    assert.match(verticalTargetOverrideWarning(85)!, /verticalTargetS 85 .*usando 75 s/);
  });

  it("blocks.json antigo com verticalTargetS 85 segue carregando (limitado, não recusado)", () => {
    const base = { edition: "261030", blocks: { titulo: [{ text: "x" }] } };
    for (const v of [85, 90, 75, 60]) assert.equal(parseBlocksFile({ ...base, verticalTargetS: v }).ok, true, String(v));
    assert.equal(parseBlocksFile({ ...base, verticalTargetS: 0 }).ok, false);
  });

  it("gate da prévia: 75 s exatos passam; acima bloqueia; horizontal nunca", () => {
    assert.equal(verticalPreviewGate(vplan(75), 30), null);
    assert.match(verticalPreviewGate(vplan(75.1), 30)!, /GATE BLOQUEADO.*card de CTA fora da conta/);
    assert.match(verticalPreviewGate(vplan(80), 30, 85)!, /alvo de 75 s/);
    assert.match(verticalPreviewGate(vplan(70), 30, 60)!, /alvo de 60 s/);
    assert.equal(verticalPreviewGate(vplan(300, SPEC_H), 30), null);
  });

  it("regressão 261111: o vertical de 2:26 e o Short de 1:27 ficam bloqueados (o alvo antigo de 85 s deixava o Short passar com aviso)", () => {
    assert.match(verticalPreviewGate(vplan(146), 30)!, /GATE BLOQUEADO/);
    const corte = vplan(87, { ...SPEC_V, corte: "automacao" });
    assert.match(verticalPreviewGate(corte, 30)!, /GATE BLOQUEADO/);
  });

  it("--over-target força, com o aviso mesmo assim", () => {
    const log: string[] = [];
    assert.equal(verticalDurationGateBlocks(vplan(90), 30, undefined, false, (l) => log.push(l)), true);
    assert.equal(verticalDurationGateBlocks(vplan(90), 30, undefined, true, (l) => log.push(l)), false);
    assert.equal(verticalDurationGateBlocks(vplan(70), 30, undefined, false, (l) => log.push(l)), false);
    assert.equal(log.length, 2);
    assert.match(log[0], /GATE BLOQUEADO/);
    assert.match(log[1], /forçado por --over-target/);
  });
});

describe("#12694: o corte proposto quando o comentário não basta", () => {
  it("Short sem comentário: propõe frases de outros blocos, preserva o gancho e nunca o fecho", () => {
    const spec: SequenceSpec = { ...SPEC_V, corte: "automacao", order: ["titulo", "resumo_curto", "fecho"] };
    const c = verticalTargetCheck(vplan(100, spec), resolved, 30)!;
    assert.ok(c.cuts.length > 0);
    assert.ok(c.cuts.every((x) => x.block === "resumo_curto"), JSON.stringify(c.cuts));
    assert.ok(!c.cuts.some((x) => x.block === "titulo"), "a 1ª fala (gancho) fica");
    assert.ok(!c.cuts.some((x) => x.block === "fecho"), "o fecho nunca é proposto");
    assert.match(verticalTargetWarning(spec.name, c), /resumo curto \[1\]/i);
  });

  it("o roteiro mostra o roteiro enxuto (duração por frase) sem as frases cortadas", () => {
    const md = roteiroMarkdown("261111", [vplan(100)], resolved, 30);
    assert.match(md, /A prévia fica bloqueada até caber \(#12694\)/);
    const enxuto = md.split("Roteiro enxuto proposto")[1].split("Estimativa depois dos cortes")[0];
    assert.match(enxuto, /\| Bloco \| Fala mantida \| Duração \|/);
    const c = verticalTargetCheck(vplan(100), resolved, 30)!;
    for (const cut of c.cuts) assert.ok(!enxuto.includes(cut.text), `cortada no enxuto: ${cut.text}`);
    assert.match(enxuto, /Título \[0\] \| O Nubank quer um banco feito por IA\. \| 3,0 s/);
  });

  it("a duração do item desconta os silêncios", () => {
    assert.equal(itemSpeechSeconds(item(0, 10, "x")), 10);
    assert.ok(itemSpeechSeconds(item(0, 10, "x"), [{ start: 2, end: 6 }]) < 10);
  });
});

describe("#12694: CLI preview/review saem com 1 antes do bruto", () => {
  it("vertical da edição e corte avulso acima de 75 s", async () => {
    const root = mkdtempSync(join(tmpdir(), "vertical-12694-"));
    const source = JSON.stringify({ path: join(root, "ausente.mp4"), fps: 30 });
    const blocks = JSON.stringify({ edition: "261111", blocks: { titulo: [{ text: "Gancho" }] } });
    const oldError = console.error;
    const messages: string[] = [];
    console.error = (...args: unknown[]) => {
      messages.push(args.join(" "));
    };
    try {
      writeFileSync(join(root, "source.json"), source);
      writeFileSync(join(root, "blocks.json"), blocks);
      for (const corte of [undefined, "automacao"]) {
        const plan = vplan(87, { ...SPEC_V, ...(corte ? { corte } : {}) });
        writeFileSync(join(root, "plan.json"), JSON.stringify({ hash: planHashOf(blocks, source, null), source: { fps: 30 }, plans: [plan] }));
        for (const cmd of ["preview", "review"]) {
          const code = await main([cmd, "261111", "--drive-root", root, "--state-dir", root, "--work-dir", root, "--out-dir", root, "--seq", corte ?? "outras-redes"]);
          assert.equal(code, 1, `${cmd} ${corte ?? "edição"}: ${messages.join(" | ")}`);
        }
      }
      assert.equal(messages.filter((m) => m.includes("GATE BLOQUEADO")).length, 4);
    } finally {
      console.error = oldError;
      rmSync(root, { recursive: true, force: true });
    }
  });
});
