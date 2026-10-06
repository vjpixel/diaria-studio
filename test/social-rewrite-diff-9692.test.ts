/**
 * test/social-rewrite-diff-9692.test.ts (#9692)
 *
 * Medição Stage 2 → aprovado do `03-social.md`. Fixtures reproduzem os 3
 * padrões reais de 260928/261005/261006 que o `derive-editor-requests`
 * contava como `social-rewrite`: reordenação sem edição, troca de destaque
 * (texto novo, não reescrita) e troca de FONTE com texto quase igual — além
 * do `Map` por nome de seção que deixava o `# Curto ## d1` sobrescrever o
 * `# Social ## d1`.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  chooseBaseline,
  classifyPair,
  countLoggedSocialRewrites,
  isRealRewrite,
  matchSections,
  measureEdition,
  namedCheckpointSteps,
  normalizeSocialMd,
  parseSocialSections,
  summarize,
  vetoedStructureCount,
  type SectionPair,
} from "../scripts/lib/social-rewrite-diff.ts";

const GARTNER =
  "Agentes autônomos pareciam o próximo passo óbvio dentro das empresas. **Segundo o Gartner, 40% delas podem desligar esses agentes até 2027.** O motivo tem pouco a ver com os modelos.\n\nSão falhas de governança que aparecem em produção, mexendo em processo de verdade.\n\n#InteligenciaArtificial #Agentes";
const MEDICARE =
  "Agentes da OpenAI acessaram sites sem autorização, incluindo o Medicare. **A revisão custa mais de US$ 500 mil por dia.**\n\nSão 50 petabytes de dados pra examinar. **E quem paga é a empresa que colocou o agente no ar.**\n\n#OpenAI";
const MEDICARE_EDITED = MEDICARE.replace("E quem paga é a empresa que colocou o agente no ar.", "Quem arca com essa conta ainda está em aberto.");
const GPTS =
  "Os GPTs personalizados chegaram como o jeito de qualquer pessoa montar o próprio assistente dentro do ChatGPT. **A OpenAI decidiu aposentar todos eles.** Era um dos recursos mais exibidos da plataforma.\n\nA mudança vale pra todas as versões do ChatGPT: plano gratuito, Plus e Enterprise.\n\n#ChatGPT";
const GPTS_EDITED = GPTS.replace(" Era um dos recursos mais exibidos da plataforma.", "");
const KOLIBRI =
  "Tem empresa que não pode mandar dado interno pra fora. **A alemã Aleph Alpha lançou o Kolibri, de pesos abertos.**\n\nEle fala inglês e alemão e lê até 1 milhão de tokens.\n\n#ModeloAberto";

function md(social: Record<string, string>, curto: Record<string, string> = {}): string {
  const parts = ["# Social", "", "> nota fixa do template", ""];
  for (const [k, v] of Object.entries(social)) parts.push(`## ${k}`, "", v, "");
  parts.push("# Curto", "");
  for (const [k, v] of Object.entries(curto)) parts.push(`## ${k}`, "", v, "");
  return parts.join("\n");
}
const urls = (o: Record<string, string>) => new Map(Object.entries(o));

describe("parseSocialSections (#9692)", () => {
  it("separa `# Social ## d1` de `# Curto ## d1` — o Curto não sobrescreve o texto longo", () => {
    const secs = parseSocialSections(md({ d1: GARTNER }, { d1: "curto do gartner" }));
    const d1s = secs.filter((s) => s.section === "d1");
    assert.equal(d1s.length, 2);
    assert.deepEqual(d1s.map((s) => s.block), ["social", "curto"]);
    assert.match(d1s[0].body, /Gartner/);
    assert.equal(d1s[1].body, "curto do gartner");
  });

  it("CRLF e URL própria do site não contam como mudança (260928: toda linha 'mudava')", () => {
    const lf = md({}, { d1: "Mais em {edition_url} #X" });
    const crlfPublished = lf.replace("{edition_url}", "https://diar.ia.br/p/slug-real").replace(/\n/g, "\r\n");
    assert.equal(normalizeSocialMd(crlfPublished), normalizeSocialMd(lf));
    const pairs = matchSections(parseSocialSections(lf), parseSocialSections(crlfPublished));
    assert.ok(pairs.every((p) => p.kind === "mesma-historia" && classifyPair(p).labels.includes("identico")));
  });
});

describe("matchSections — casa por URL, nunca por posição (#9692)", () => {
  it("reordenação pura (261006: Gartner d1→d2) é idêntico + reordenado, não reescrita", () => {
    const base = parseSocialSections(md({ d1: GARTNER, d2: MEDICARE }));
    const appr = parseSocialSections(md({ d1: MEDICARE, d2: GARTNER }));
    const pairs = matchSections(base, appr, urls({ d1: "u-gartner", d2: "u-medicare" }), urls({ d1: "u-medicare", d2: "u-gartner" }));
    const d2 = pairs.find((p) => p.block === "social" && p.section === "d2")!;
    assert.equal(d2.kind, "mesma-historia");
    assert.equal(d2.baselineSection, "d1");
    assert.equal(d2.matchedBy, "url");
    const c = classifyPair(d2);
    assert.deepEqual(c.labels, ["reordenado", "identico"]);
    assert.equal(isRealRewrite({ ...d2, classification: c }), false);
  });

  it("troca de destaque (261005: deepfakes → Kolibri) é historia-trocada + historia-removida", () => {
    const base = parseSocialSections(md({ d3: GARTNER }));
    const appr = parseSocialSections(md({ d3: KOLIBRI }));
    const pairs = matchSections(base, appr, urls({ d3: "u-gartner" }), urls({ d3: "u-kolibri" }));
    const kinds = pairs.filter((p) => p.block === "social" && p.section === "d3").map((p) => p.kind).sort();
    assert.deepEqual(kinds, ["historia-removida", "historia-trocada"]);
  });

  it("fonte trocada com texto quase igual (261006: GPTs canaltech → help.openai) casa por similaridade", () => {
    const base = parseSocialSections(md({ d3: GPTS }));
    const appr = parseSocialSections(md({ d1: GPTS_EDITED }));
    const [p] = matchSections(base, appr, urls({ d3: "u-canaltech" }), urls({ d1: "u-help-openai" })).filter(
      (x) => x.block === "social" && x.section === "d1",
    );
    assert.equal(p.kind, "mesma-historia");
    assert.equal(p.matchedBy, "similaridade");
    assert.equal(p.sourceChanged, true);
    const labels = classifyPair(p).labels;
    assert.ok(labels.includes("fonte-trocada"));
    assert.ok(labels.includes("frase-removida"));
  });

  it("passe de URL vem antes da similaridade — um texto parecido não rouba o par de outra seção", () => {
    // d1 aprovado é PARECIDO com o d2 do baseline, mas a URL dele aponta pro d1 do baseline.
    const base = parseSocialSections(md({ d1: GARTNER, d2: GPTS }));
    const appr = parseSocialSections(md({ d1: GPTS_EDITED, d2: GPTS }));
    const pairs = matchSections(base, appr, urls({ d1: "u-a", d2: "u-b" }), urls({ d1: "u-x", d2: "u-b" }));
    const d2 = pairs.find((p) => p.block === "social" && p.section === "d2")!;
    assert.equal(d2.matchedBy, "url");
    assert.equal(d2.baselineSection, undefined);
  });

  it("sem mapas de URL cai para similaridade (baseline legado sem 01-approved confiável)", () => {
    const pairs = matchSections(parseSocialSections(md({ d1: MEDICARE })), parseSocialSections(md({ d2: MEDICARE_EDITED })));
    const p = pairs.find((x) => x.section === "d2")!;
    assert.equal(p.matchedBy, "similaridade");
    assert.equal(p.sourceChanged, undefined);
  });

  it("`um` com item trocado (aula de inglês → guias da OpenAI) não é reescrita", () => {
    const pairs = matchSections(parseSocialSections(md({ um: KOLIBRI })), parseSocialSections(md({ um: GARTNER })));
    assert.deepEqual(pairs.filter((p) => p.section === "um").map((p) => p.kind).sort(), ["historia-removida", "historia-trocada"]);
  });
});

describe("classifyPair — heurísticas declaradas (#9692)", () => {
  const pair = (before: string, after: string, block = "social", section = "d1"): SectionPair => ({
    kind: "mesma-historia",
    block,
    section,
    before,
    after,
  });

  it("fechamento trocado (261006 Medicare)", () => {
    assert.deepEqual(classifyPair(pair(MEDICARE, MEDICARE_EDITED)).labels, ["fechamento"]);
  });

  it("encurtamento + estouro do teto de 260 do carrossel", () => {
    const long = "A".repeat(10) + " " + "palavra ".repeat(40) + "fim.";
    const short = "A".repeat(10) + " " + "palavra ".repeat(20) + "fim.";
    const c = classifyPair(pair(long, short));
    assert.ok(c.overCapBefore === 1 && c.overCapAfter === 0);
    assert.ok(c.labels.includes("encurtamento"));
    assert.ok(c.labels.includes("estouro-teto-260"));
  });

  it("teto de 260 só vale pro `# Social` d1-d3, não pro Curto", () => {
    const long = "palavra ".repeat(40) + "fim.";
    assert.equal(classifyPair(pair(long, "curto.", "curto")).overCapBefore, 0);
  });

  it("curto acima de 280 cortado pra caber (260928 curto d1, 281→268)", () => {
    const over = "x".repeat(270) + " Mais em {edition_url} #A";
    const under = "x".repeat(250) + " Mais em {edition_url} #A";
    assert.ok(classifyPair(pair(over, under, "curto")).labels.includes("estouro-teto-280"));
  });

  it("hook, CTA, factual e tom", () => {
    const before = "Para começar, a empresa lançou um modelo. Portanto vale olhar.";
    const after = "A Cloudflare lançou o Clef pra decidir rápido, pra quem tá testando. Mais em {edition_url}";
    const c = classifyPair(pair(before, after));
    for (const l of ["hook", "cta", "factual", "tom-coloquial"] as const) assert.ok(c.labels.includes(l), l);
    assert.ok(c.factsAdded.includes("Cloudflare") && c.factsAdded.includes("Clef"));
  });

  it("remoção de estrutura vetada (antítese-revelação)", () => {
    const before = "Não é motivo pra parar de usar agentes, é motivo pra rever governança.";
    const after = "Vale rever governança antes de liberar agentes.";
    assert.ok(vetoedStructureCount(before) > 0);
    assert.equal(vetoedStructureCount(after), 0);
    assert.ok(classifyPair(pair(before, after)).labels.includes("estrutura-vetada-removida"));
  });

  it("mudança sem nenhum sinal mecânico vira `outro`", () => {
    assert.deepEqual(classifyPair(
        pair(
          "Primeira frase igual. A empresa testou o sistema ontem. Última frase igual.",
          "Primeira frase igual. A empresa testou o modelo ontem. Última frase igual.",
        ),
      ).labels, ["outro"]);
  });
});

describe("chooseBaseline (#9692)", () => {
  const step2 = Date.parse("2026-09-28T00:48:38Z");
  it("snapshot carimbado (#9356) vence", () => {
    const c = chooseBaseline({ snapshotPath: "snap", snapshotHealth: "ok", step2CompletedAtMs: step2, candidates: [] });
    assert.equal(c.kind, "snapshot");
  });
  it("legado: intermediário mais recente escrito ATÉ o fim do Stage 2; regeneração do Stage 4 é ignorada (260928)", () => {
    const c = chooseBaseline({
      snapshotPath: "snap",
      snapshotHealth: "legacy",
      step2CompletedAtMs: step2,
      candidates: [
        { path: "_internal/03-clarice-corrected.md", mtimeMs: Date.parse("2026-09-28T00:37:59Z") },
        { path: "_internal/03-social-pre-humanizador.md", mtimeMs: Date.parse("2026-09-28T01:43:34Z") },
        { path: "_internal/03-social-post-humanizador.md", mtimeMs: Date.parse("2026-09-28T02:03:10Z") },
      ],
    });
    assert.equal(c.kind, "intermediate");
    assert.equal(c.kind === "intermediate" && c.path, "_internal/03-clarice-corrected.md");
  });
  it("sem snapshot confiável e sem intermediário até o Stage 2 → irrecuperável", () => {
    const c = chooseBaseline({
      snapshotPath: "snap",
      snapshotHealth: "missing",
      step2CompletedAtMs: step2,
      candidates: [{ path: "x", mtimeMs: step2 + 3_600_000 }],
    });
    assert.equal(c.kind, "unrecoverable");
    assert.equal(chooseBaseline({ snapshotPath: "s", snapshotHealth: "late", step2CompletedAtMs: null, candidates: [] }).kind, "unrecoverable");
  });
});

describe("medição de edição + agregado (#9692)", () => {
  it("cenário 261006: 4 `social-rewrite` logados → 2 editadas de fato", () => {
    const base = md({ d1: GARTNER, d2: MEDICARE, d3: GPTS }, { d1: "curto gartner {edition_url}" });
    const appr = md({ d2: GARTNER, d3: MEDICARE_EDITED, d1: GPTS_EDITED }, { d2: "curto gartner {edition_url}" });
    const jsonl = [
      JSON.stringify({ request_type: "social-rewrite", target: "d1" }),
      JSON.stringify({ request_type: "social-rewrite", target: "d2" }),
      "{malformada",
      JSON.stringify({ request_type: "social-rewrite", target: "d3" }),
      JSON.stringify({ request_type: "social-rewrite", target: "social" }),
      JSON.stringify({ request_type: "title-choice", target: "d1" }),
    ].join("\n");
    const m = measureEdition({
      edition: "261006",
      baselineMd: base,
      approvedMd: appr,
      baselineSource: "snap",
      approvedSource: "final",
      baselineUrls: urls({ d1: "u-gartner", d2: "u-medicare", d3: "u-canaltech" }),
      approvedUrls: urls({ d1: "u-help", d2: "u-gartner", d3: "u-medicare" }),
      editorRequestsJsonl: jsonl,
    });
    const s = summarize([m]);
    assert.equal(s.logged, 4);
    assert.equal(s.rewritten, 2);
    assert.equal(s.swapped, 0);
    assert.equal(s.labelCounts["fechamento"], 1);
    assert.equal(s.labelCounts["frase-removida"], 1);
    assert.equal(countLoggedSocialRewrites(undefined), 0);
  });
});

describe("namedCheckpointSteps — motivo declarado (#9692)", () => {
  it("atribui cada mudança ao checkpoint `pre-{tag}` que a precede (261005: factfix mexeu no d2)", () => {
    const s0 = md({ d1: GARTNER, d2: MEDICARE });
    const s1 = md({ d1: GARTNER, d2: MEDICARE_EDITED });
    const s2 = md({ d1: KOLIBRI, d2: MEDICARE_EDITED });
    const steps = namedCheckpointSteps(
      [
        { tag: "pre-factfix", md: s0 },
        { tag: "pre-kolibri", md: s1 },
      ],
      s2,
    );
    assert.deepEqual(steps, [
      { tag: "pre-factfix", changed: ["social/d2"] },
      { tag: "pre-kolibri", changed: ["social/d1"] },
    ]);
  });
});

describe("CLI measure-social-rewrite-diff (#9692)", () => {
  it("lê o layout nested, usa o snapshot carimbado e devolve JSON", () => {
    const root = mkdtempSync(join(tmpdir(), "srd-9692-"));
    try {
      const dir = join(root, "2610", "261006");
      const snap = join(dir, "_internal", "editor-request-snapshots", "stage2-post-gate");
      mkdirSync(join(snap, "_internal"), { recursive: true });
      writeFileSync(join(dir, "_internal", ".step-2-done.json"), JSON.stringify({ completed_at: "2026-10-05T20:59:02.000Z" }));
      writeFileSync(join(snap, ".capture.json"), JSON.stringify({ captured_at: "2026-10-05T20:59:02.620Z", trigger: "pipeline-sentinel-step-2" }));
      writeFileSync(join(snap, "03-social.md"), md({ d1: MEDICARE }));
      writeFileSync(join(snap, "_internal", "01-approved.json"), JSON.stringify({ highlights: [{ url: "u-m" }] }));
      writeFileSync(join(dir, "03-social.md"), md({ d1: MEDICARE_EDITED }));
      writeFileSync(join(dir, "_internal", "01-approved.json"), JSON.stringify({ highlights: [{ article: { url: "u-m" } }] }));
      // intermediário escrito depois do Stage 2 não deve ser escolhido (o snapshot ok vence)
      writeFileSync(join(dir, "_internal", "03-clarice-corrected.md"), "lixo");
      utimesSync(join(dir, "_internal", "03-clarice-corrected.md"), new Date(0), new Date(0));

      const r = spawnSync(
        process.execPath,
        ["--import", "tsx", join(import.meta.dirname, "..", "scripts", "measure-social-rewrite-diff.ts"), "--editions-root", root, "--editions", "261006,269999", "--json"],
        { encoding: "utf8" },
      );
      assert.equal(r.status, 0, r.stderr);
      const out = JSON.parse(r.stdout);
      assert.equal(out.editions[0].baselineSource, "_internal/editor-request-snapshots/stage2-post-gate/03-social.md");
      assert.equal(out.summary.rewritten, 1);
      assert.equal(out.unrecoverable[0].edition, "269999");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
