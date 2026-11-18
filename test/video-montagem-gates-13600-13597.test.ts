/**
 * #13600: o Gate 1 (decupagem) da /diaria-video-montagem deixou de ser parada
 * obrigatória; a decupagem segue direto com um banner de premissas e só para
 * numa exceção que o Gate 2 não resolve (tomada colapsada não separada, "usar"
 * contra a direção sem motivo, espelhamento ambíguo que o frame não decidiu).
 *
 * #13597: o fact-check da fala roda logo depois da decupagem, em paralelo, e
 * quando a fala muda no Gate 2 refaz só os itens alterados.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collapsedStatus, decupagemGate, decupagemGateBanner, decupagemTakeLines, type Gate1Input } from "../scripts/lib/diaria/video-decupagem-gate.ts";
import type { DecupagemPlan } from "../scripts/lib/diaria/video-montage-docs.ts";
import {
  checkedSnapshotFrom,
  factCheckFontesSha256,
  factCheckItemHash,
  factCheckItemsSha256,
  mergeVideoFactCheck,
  planVideoFactCheck,
  type FactCheckItem,
  type VideoFactCheck,
} from "../scripts/lib/diaria/video-fact-check.ts";
import { DECUPAGEM_GATE_FILE, EXIT_DECUPAGEM_PARADA, SUBCOMMANDS, VIDEO_FACT_CHECK_DELTA_FILE, main } from "../scripts/video-montagem.ts";

const ROOT = join(import.meta.dirname, "..");

const PLAN: DecupagemPlan = {
  edition: "261118",
  blocks: [
    { key: "resumo", rows: [{ segments: [1], suggestion: "usar" }, { segments: [2], suggestion: "cortar", reason: "2ª tomada" }] },
    { key: "comentario", rows: [{ segments: [3], suggestion: "usar", falaId: "H6" }] },
  ],
};

const base = (over: Partial<Gate1Input> = {}): Gate1Input => ({
  plan: PLAN,
  origin: [{ original: 1 }, { original: 2 }, { original: 3 }],
  contraDirecao: [],
  mirror: { premise: "mirrored=false (metadado da câmera: traseira, não espelha)", ambiguous: false, frameUnresolved: false },
  takes: ["resumo: segmento(s) 1: tomada única"],
  durations: [{ name: "Diaria comentada_Vertical_V1", totalS: 70, overS: 0 }],
  verticalMaxS: 180,
  loudness: "-14.0 LUFS integrado",
  alternativas: 0,
  ...over,
});

describe("#13600: decupagem segue sem parada, com banner de premissas", () => {
  it("sem exceção: segue, com tomadas, duração, espelhamento, loudness e enquadramento no banner", () => {
    const d = decupagemGate(base());
    assert.equal(d.decision, "segue");
    assert.deepEqual(d.stops, []);
    const banner = decupagemGateBanner(d, "https://docs.google.com/x").join("\n");
    assert.match(banner, /Decupagem sem parada \(#13600\)/);
    assert.match(banner, /Doc da decupagem \(consulta\): https:\/\/docs\.google\.com\/x/);
    for (const want of [/Tomadas por frase/, /Vertical_V1: ~70\.0 s/, /Espelhamento: mirrored=false/, /Loudness: -14\.0 LUFS/, /Enquadramento:/]) assert.match(banner, want);
  });

  it("vertical acima do teto: a premissa diz que o corte proposto entra no blocks.json, sem parar", () => {
    const d = decupagemGate(base({ durations: [{ name: "Vertical", totalS: 200, overS: 20 }] }));
    assert.equal(d.decision, "segue");
    assert.ok(d.premissas.some((p) => /20\.0 s acima do teto de 180 s: o corte proposto/.test(p)));
  });

  it("tomada colapsada não separada numa linha que vai ao ar: para", () => {
    const origin = [{ original: 1, note: "possível tomada colapsada (x): conferir no áudio", collapsed: "nao-separada" as const }, { original: 2 }, { original: 3 }];
    const d = decupagemGate(base({ origin }));
    assert.equal(d.decision, "para");
    assert.equal(d.stops[0].kind, "tomada-colapsada");
    assert.match(d.stops[0].detail, /resumo\.rows\[0\].*segmento 1/);
    assert.match(decupagemGateBanner(d, "doc").join("\n"), /\[parada\]/);
  });

  it("tomada colapsada numa linha cortada, ou com o falso começo achado, não para", () => {
    const cortada = [{ original: 1 }, { original: 2, note: "possível tomada colapsada", collapsed: "nao-separada" as const }, { original: 3 }];
    assert.equal(decupagemGate(base({ origin: cortada })).decision, "segue");
    const falso = [{ original: 1, note: "falso começo \"de seus\" em 1–2 s", collapsed: "falso-comeco" as const }, { original: 2 }, { original: 3 }];
    assert.equal(decupagemGate(base({ origin: falso })).decision, "segue");
  });

  it("listagem gravada antes do #13600 (sem o campo collapsed): o estado sai da nota", () => {
    assert.equal(collapsedStatus({ original: 1, note: "possível tomada colapsada (vão de 2 s); nem a janela nem as subjanelas separaram: conferir no áudio (#13587)" }), "nao-separada");
    assert.equal(collapsedStatus({ original: 1, note: "falso começo \"duas\" em 3.00–4.00 s (subjanelas): o roteiro propõe o corte" }), "falso-comeco");
    assert.equal(collapsedStatus({ original: 1, retranscribed: { file: "r.json" }, note: "retranscrito: parte 1 de 2 (tomada colapsada)" }), null);
    assert.equal(collapsedStatus({ original: 1 }), null);
  });

  it("plano anterior ao #13587 (sem listagem): suspeita de colapso numa linha que vai ao ar para", () => {
    assert.equal(decupagemGate(base({ origin: null, legacyCollapsed: [3] })).decision, "para");
    assert.equal(decupagemGate(base({ origin: null, legacyCollapsed: [2] })).decision, "segue");
  });

  it("'usar' contra a direção: sem reason para, com reason vira premissa", () => {
    const sem = decupagemGate(base({ contraDirecao: [{ label: "resumo.rows[0]", segment: 1, approved: 2 }] }));
    assert.equal(sem.decision, "para");
    assert.equal(sem.stops[0].kind, "contra-direcao");
    const com = decupagemGate(base({ contraDirecao: [{ label: "resumo.rows[0]", segment: 1, approved: 2, reason: "a 2ª tem ruído" }] }));
    assert.equal(com.decision, "segue");
    assert.ok(com.premissas.some((p) => /Contraria a direção com motivo: .*a 2ª tem ruído/.test(p)));
  });

  it("espelhamento: só para com bruto ambíguo E frame que não decidiu", () => {
    const amb = { premise: "mirrored=false (default)", ambiguous: true, frameUnresolved: false };
    assert.equal(decupagemGate(base({ mirror: amb })).decision, "segue");
    assert.equal(decupagemGate(base({ mirror: { ...amb, frameUnresolved: true } })).stops[0].kind, "espelhamento-ambiguo");
    assert.equal(decupagemGate(base({ mirror: { ...amb, ambiguous: false, frameUnresolved: true } })).decision, "segue");
  });

  it("tomadas por frase: reason da linha vence, depois o critério da listagem, senão tomada única", () => {
    const plan: DecupagemPlan = {
      edition: "261118",
      blocks: [{ key: "resumo", rows: [{ segments: [1], suggestion: "usar" }, { segments: [3], suggestion: "usar", reason: "emenda com a seguinte" }, { segments: [4], suggestion: "usar", falaId: "H2" }] }],
    };
    const by = new Map([[0, { suggestion: "usar" as const, reason: "aprovada pela direção: \"é este\"", group: [0, 1] }]]);
    const lines = decupagemTakeLines(plan, by);
    assert.match(lines[0], /resumo: segmento\(s\) 1: 1ª de 2 tomadas, aprovada pela direção/);
    assert.match(lines[1], /emenda com a seguinte/);
    assert.match(lines[2], /\(H2\): tomada única/);
  });
});

describe("#13600: 2ª passada da decupagem pelo CLI", () => {
  const setup = (source: Record<string, unknown>) => {
    const dir = mkdtempSync(join(tmpdir(), "vm-13600-"));
    writeFileSync(join(dir, "source.json"), JSON.stringify({ path: "bruto.mp4", fps: 30, durationS: 10, width: 1920, height: 1080, mirrored: false, ...source }));
    writeFileSync(join(dir, "transcript.json"), JSON.stringify({ duration: 10, segments: [{ start: 0, end: 2, text: "Olá, eu sou o Pixel.", words: [{ start: 0, end: 1, text: "Olá," }, { start: 1, end: 2, text: "Pixel." }] }] }));
    writeFileSync(join(dir, "decupagem-plan.json"), JSON.stringify({ edition: "261118", blocks: [{ key: "abertura", rows: [{ segments: [1], suggestion: "usar" }] }] }));
    return dir;
  };

  it("sem exceção sai 0 e grava decupagem-gate.json com decision segue", async () => {
    const dir = setup({});
    try {
      assert.equal(await main(["decupagem", "261118", "--state-dir", dir, "--no-drive-api"]), 0);
      const gate = JSON.parse(readFileSync(join(dir, DECUPAGEM_GATE_FILE), "utf8"));
      assert.equal(gate.decision, "segue");
      assert.ok(gate.premissas.some((p: string) => /^Espelhamento: /.test(p)));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("--espelho-ambiguo com bruto sem metadado de câmera: exit 5 (parada)", async () => {
    const dir = setup({ mirroredFrom: "config" });
    try {
      assert.equal(await main(["decupagem", "261118", "--state-dir", dir, "--no-drive-api", "--espelho-ambiguo"]), EXIT_DECUPAGEM_PARADA);
      assert.equal(JSON.parse(readFileSync(join(dir, DECUPAGEM_GATE_FILE), "utf8")).decision, "para");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("--espelho-ambiguo com o metadado da câmera decidindo: segue", async () => {
    const dir = setup({ mirroredFrom: "camera-metadata", camera: "back" });
    try {
      assert.equal(await main(["decupagem", "261118", "--state-dir", dir, "--no-drive-api", "--espelho-ambiguo"]), 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

const it_ = (id: string, text: string, heard?: string): FactCheckItem => ({ id, block: "comentario", index: Number(id.match(/\d+/)![0]), text, ...(heard ? { heard } : {}), start: 0, end: 1, versions: ["Horizontal"] });

describe("#13597: fact-check só dos trechos alterados", () => {
  const v1 = [it_("comentario[0]", "A OpenAI lançou o GPT-6."), it_("comentario[1]", "Custa 20 dólares."), it_("comentario[2]", "Sai em março.")];
  const fc1: VideoFactCheck = {
    mode: "video",
    edition: "261118",
    items_sha256: factCheckItemsSha256(v1),
    claims: [
      { item: "comentario[0]", claim: "lançou o GPT-6", verdict: "SUSTAINED" },
      { item: "comentario[1]", claim: "20 dólares", verdict: "DIVERGENT", suggested_fix: "25 dólares" },
      { item: "comentario[2]", claim: "em março", verdict: "SUSTAINED" },
    ],
  };
  const input1 = { items_sha256: fc1.items_sha256, all_items: v1.map((i) => ({ id: i.id, hash: factCheckItemHash(i) })), fontes_sha256: factCheckFontesSha256([]) };

  it("sem fact-check anterior: inteiro", () => {
    const p = planVideoFactCheck(v1, [], null, null);
    assert.equal(p.mode, "full");
  });

  it("versão igual: em dia, nada a despachar", () => {
    assert.equal(planVideoFactCheck(v1, [], fc1, checkedSnapshotFrom(input1, fc1)).mode, "em-dia");
  });

  it("uma frase trocada e um item inserido antes: checa só as novas, mantém os achados dos outros com o id atual", () => {
    // O editor inseriu uma frase no começo (renumera) e corrigiu o preço no Gate 2.
    const v2 = [it_("comentario[0]", "Frase nova de abertura."), it_("comentario[1]", "A OpenAI lançou o GPT-6."), it_("comentario[2]", "Custa 25 dólares."), it_("comentario[3]", "Sai em março.")];
    const p = planVideoFactCheck(v2, [], fc1, checkedSnapshotFrom(input1, fc1));
    assert.equal(p.mode, "delta");
    if (p.mode !== "delta") return;
    assert.deepEqual(p.check.map((i) => i.text), ["Frase nova de abertura.", "Custa 25 dólares."]);
    assert.equal(p.reused, 2);
    // O DIVERGENT do preço antigo cai (o item mudou); os outros seguem, renumerados.
    assert.deepEqual(p.carried.map((c) => [c.item, c.claim]), [["comentario[1]", "lançou o GPT-6"], ["comentario[3]", "em março"]]);
  });

  it("fala ouvida diferente (heard) conta como trecho alterado", () => {
    const v2 = [v1[0], it_("comentario[1]", "Custa 20 dólares.", "Custa 30 dólares."), v1[2]];
    const p = planVideoFactCheck(v2, [], fc1, checkedSnapshotFrom(input1, fc1));
    assert.equal(p.mode, "delta");
    if (p.mode === "delta") assert.deepEqual(p.check.map((i) => i.id), ["comentario[1]"]);
  });

  it("fontes do roteiro trocadas, input de outra versão ou achado com item desconhecido: inteiro", () => {
    const v2 = [v1[0], it_("comentario[1]", "Custa 25 dólares."), v1[2]];
    const fontes = [{ fala: "H6", url: "https://x", sustenta: "preço" }];
    assert.equal(planVideoFactCheck(v2, fontes, fc1, checkedSnapshotFrom(input1, fc1)).mode, "full");
    assert.equal(checkedSnapshotFrom({ ...input1, items_sha256: "outra" }, fc1), null);
    assert.equal(planVideoFactCheck(v2, [], fc1, null).mode, "full");
    const fcOdd = { ...fc1, claims: [...fc1.claims, { item: "resumo[9]", claim: "x", verdict: "SUSTAINED" as const }] };
    const p = planVideoFactCheck(v2, [], fcOdd, checkedSnapshotFrom(input1, fcOdd));
    assert.equal(p.mode, "full");
  });

  it("input anterior ao #13597 (só items, sem all_items): os items são o que foi checado", () => {
    const legacy = { items_sha256: fc1.items_sha256, items: v1 };
    const snap = checkedSnapshotFrom(legacy, fc1);
    assert.ok(snap);
    assert.deepEqual(snap!.all_items, input1.all_items);
  });

  it("merge: carregados + delta, com o hash da versão inteira; delta de outra versão é recusado", () => {
    const delta: VideoFactCheck = { mode: "video", edition: "261118", items_sha256: "sha-v2", claims: [{ item: "comentario[2]", claim: "25 dólares", verdict: "SUSTAINED" }] };
    const merged = mergeVideoFactCheck(delta, [{ item: "comentario[1]", claim: "lançou o GPT-6", verdict: "SUSTAINED" }], "sha-v2");
    assert.equal(merged.items_sha256, "sha-v2");
    assert.equal(merged.claims.length, 2);
    assert.throws(() => mergeVideoFactCheck(delta, [], "sha-v3"), /outra versão/);
  });

  it("fact-check-merge pelo CLI grava o fact-check.json juntando os dois", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vm-13597-"));
    try {
      writeFileSync(join(dir, "fact-check-input.json"), JSON.stringify({ mode: "video", edition: "261118", items_sha256: "sha-v2", items: [], incremental: { reused: 1, carried_claims: [{ item: "comentario[1]", claim: "lançou", verdict: "SUSTAINED" }] } }));
      writeFileSync(join(dir, VIDEO_FACT_CHECK_DELTA_FILE), JSON.stringify({ mode: "video", edition: "261118", items_sha256: "sha-v2", claims: [{ item: "comentario[2]", claim: "25 dólares", verdict: "DIVERGENT" }] }));
      assert.equal(await main(["fact-check-merge", "261118", "--state-dir", dir, "--no-drive-api"]), 0);
      const fc = JSON.parse(readFileSync(join(dir, "fact-check.json"), "utf8"));
      assert.equal(fc.items_sha256, "sha-v2");
      assert.deepEqual(fc.claims.map((c: { item: string }) => c.item), ["comentario[1]", "comentario[2]"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("subcomando fact-check-merge registrado", () => {
    assert.ok((SUBCOMMANDS as readonly string[]).includes("fact-check-merge"));
  });
});

describe("#13600 / #13597: a skill reflete o fluxo novo", () => {
  const skill = readFileSync(join(ROOT, ".claude/skills/diaria-video-montagem/SKILL.md"), "utf8");
  it("description sem 'decupagem (gate 1)' e com a decupagem sem parada", () => {
    const desc = skill.split("\n").find((l) => l.startsWith("description: "))!;
    assert.doesNotMatch(desc, /decupagem \(gate 1\)/);
    assert.match(desc, /decupagem sem parada/);
  });
  it("Passo 2 documenta o banner, as exceções e o exit 5; sem 'resumo do Gate 1'", () => {
    assert.doesNotMatch(skill, /resumo do Gate 1/);
    assert.match(skill, /decupagem-gate\.json/);
    assert.match(skill, /exit 5/);
    assert.match(skill, /--espelho-ambiguo/);
  });
  it("o fact-check vem logo depois do blocks.json, antes do roteiro, com o merge do delta", () => {
    const fc = skill.indexOf("scripts/video-montagem.ts fact-check-input");
    assert.ok(fc > skill.indexOf("scripts/video-montagem.ts blocks"), "depois do blocks --from-plan");
    assert.ok(fc < skill.indexOf("scripts/video-montagem.ts roteiro"), "antes do roteiro");
    assert.match(skill, /scripts\/video-montagem\.ts fact-check-merge/);
  });
});
