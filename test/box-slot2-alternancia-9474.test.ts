/**
 * test/box-slot2-alternancia-9474.test.ts (#9474)
 *
 * Retrospectiva do Mês e Artigo Especial se ALTERNAM no slot 2 (decisão do
 * editor, 02/10/2026): pin last-writer-wins; `--unpin` de um só solta o slot
 * se ele ainda aponta pro arquivo dele — nunca derruba o pin do outro.
 * Também cobre o parsing/edição cirúrgica do snippet `retrospectiva-apoiadores.md`.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyBoxPin, isBoxSlotOwnedBy, type BoxesDivulgacaoConfig } from "../scripts/lib/box-slot-pin.ts";
import { runUpdateArtigoEspecialBox } from "../scripts/update-artigo-especial-box.ts";
import {
  RETROSPECTIVA_BOX_FILENAME,
  RETROSPECTIVA_BOX_HEADER,
  RetrospectivaBoxFormatError,
  TIER_BLOCK,
  applyRetrospectivaBoxUpdate,
  buildDefaultRetrospectivaBox,
  normalizeTemas,
  parseTemasArg,
  runUpdateRetrospectivaBox,
} from "../scripts/update-retrospectiva-box.ts";
import { readRetrospectivaDivulgacaoState, retrospectivaDivulgacaoStatePath } from "../scripts/lib/mensal/retrospectiva-divulgacao.ts";
import { stitchNewsletter } from "../scripts/stitch-newsletter.ts";
import { extractBoxDivulgacao2 } from "../scripts/lib/newsletter-parse.ts";

const AE = "artigo-especial-apoiadores.md";
const RETRO = RETROSPECTIVA_BOX_FILENAME;
const base: BoxesDivulgacaoConfig = {
  boxes_divulgacao: { slot1: "livros-divulgacao.md", slot2: AE },
  boxes_divulgacao_auto: { enabled: true, pinned_slots: [1, 2] },
};

describe("applyBoxPin — alternância no slot 2", () => {
  it("pin é last-writer-wins: a Retrospectiva assume o slot do Artigo Especial", () => {
    const next = applyBoxPin(base, { slot: 2, filename: RETRO, pin: true });
    assert.equal(next.boxes_divulgacao!.slot2, RETRO);
    assert.deepEqual(next.boxes_divulgacao_auto!.pinned_slots, [1, 2]);
  });

  it("--unpin atrasado do Artigo Especial NÃO derruba o pin da Retrospectiva", () => {
    const retroPinned = applyBoxPin(base, { slot: 2, filename: RETRO, pin: true });
    const afterAeUnpin = applyBoxPin(retroPinned, { slot: 2, filename: AE, pin: false });
    assert.deepEqual(afterAeUnpin, retroPinned);
    assert.ok(isBoxSlotOwnedBy(afterAeUnpin, 2, RETRO));
  });

  it("--unpin atrasado da Retrospectiva NÃO derruba o pin do Artigo Especial (sentido inverso)", () => {
    const aeBack = applyBoxPin(applyBoxPin(base, { slot: 2, filename: RETRO, pin: true }), { slot: 2, filename: AE, pin: true });
    const afterRetroUnpin = applyBoxPin(aeBack, { slot: 2, filename: RETRO, pin: false });
    assert.deepEqual(afterRetroUnpin.boxes_divulgacao_auto!.pinned_slots, [1, 2]);
    assert.equal(afterRetroUnpin.boxes_divulgacao!.slot2, AE);
  });

  it("--unpin do dono atual solta o slot (sem apagar boxes_divulgacao.slot2)", () => {
    const r = applyBoxPin(base, { slot: 2, filename: AE, pin: false });
    assert.deepEqual(r.boxes_divulgacao_auto!.pinned_slots, [1]);
    assert.equal(r.boxes_divulgacao!.slot2, AE);
  });
});

const TEMAS = [
  "agentes de IA que saíram do teste e invadiram governos e empresas",
  "modelos mais capazes com mais risco e preço menor",
  "empresas brasileiras colocando agentes para trabalhar",
];
const INPUT = {
  mesLabel: "Setembro",
  temas: TEMAS,
  url: "https://retrospectiva.diar.ia.br/2609",
};

/**
 * Texto aprovado pelo editor na edição 261008 (#9845), sem o header. Única
 * diferença: o template junta os temas como "{t1}, {t2} e {t3}" (sem a vírgula
 * antes do "e" que o texto colado à mão na 261008 tinha).
 */
const APPROVED_BODY_2609 = `**Retrospectiva de Setembro**

Três temas marcaram o mês: agentes de IA que saíram do teste e invadiram governos e empresas, modelos mais capazes com mais risco e preço menor e empresas brasileiras colocando agentes para trabalhar. A Retrospectiva liga esses pontos e mostra as tendências por trás deles.

Quem apoia a partir de R$25/mês recebe:

- a Retrospectiva do Mês por e-mail, com a edição completa na web
- o Artigo Especial mensal
- voto no tema do próximo Artigo Especial
- nome na página "Quem torna a Diar.ia possível" (opcional)

[Ler a Retrospectiva](https://retrospectiva.diar.ia.br/2609)
`;

/** Arquivo como o script do #9474 o gerava (formato anterior ao #9845). */
const LEGACY_FILE = `<!--
nome: Retrospectiva do Mês
categoria: Retrospectiva
retrospectiva-apoiadores.md — box de divulgação da Retrospectiva do Mês
(recompensa Mantenedor/Patrono, R$25+). Slot 2, ALTERNANDO com
artigo-especial-apoiadores.md (quem publica por último ocupa o slot, #9474).
Reescrito por scripts/update-retrospectiva-box.ts (/diaria-mensal-apoiadores)
a cada ciclo — não editar título/frase-padrão/URL do CTA à mão aqui, o
próximo ciclo sobrescreve (o parágrafo do tier segue estável). Formato:
context/snippets/README.md.
-->

**Retrospectiva de Agosto**

A Retrospectiva de Agosto é: **"A IA que decide sozinha já está no seu banco"**. Três movimentos do mês explicam por que isso aconteceu agora.

Quem apoia a partir de R$25/mês recebe a Retrospectiva do Mês por e-mail e lê a edição completa na web.

[Ler a Retrospectiva](https://retrospectiva.diar.ia.br/2608)
`;

describe("snippet retrospectiva-apoiadores.md", () => {
  it("seed reproduz o texto aprovado (3 temas + tier completo), sem o título da retrospectiva", () => {
    const s = buildDefaultRetrospectivaBox(INPUT);
    assert.ok(s.startsWith(RETROSPECTIVA_BOX_HEADER));
    assert.equal(s, `${RETROSPECTIVA_BOX_HEADER}\n\n${APPROVED_BODY_2609}`);
    assert.ok(s.includes(TIER_BLOCK));
    assert.ok(!/ é: /.test(s), "o título da retrospectiva não entra no box");
    assert.ok(!s.includes("Mantenedor)"), 'sem "(plano Mantenedor)"');
  });

  it("temas: trim e ponto final removidos antes de montar o parágrafo", () => {
    const s = buildDefaultRetrospectivaBox({ ...INPUT, temas: [" um tema. ", "dois", "três."] });
    assert.match(s, /^Três temas marcaram o mês: um tema, dois e três\. A Retrospectiva liga esses pontos e mostra as tendências por trás deles\.$/m);
  });

  it("update cirúrgico no formato novo: troca título/temas/URL e preserva header + tier editados à mão", () => {
    const original = buildDefaultRetrospectivaBox(INPUT).replace("- o Artigo Especial mensal", "- o Artigo Especial mensal (editado à mão)");
    const next = applyRetrospectivaBoxUpdate(original, {
      mesLabel: "Outubro",
      temas: ["tema a", "tema b", "tema c"],
      url: "https://retrospectiva.diar.ia.br/2610",
    });
    assert.match(next, /^\*\*Retrospectiva de Outubro\*\*$/m);
    assert.match(next, /^Três temas marcaram o mês: tema a, tema b e tema c\. A Retrospectiva liga/m);
    assert.match(next, /^\[Ler a Retrospectiva\]\(https:\/\/retrospectiva\.diar\.ia\.br\/2610\)$/m);
    assert.ok(next.includes("- o Artigo Especial mensal (editado à mão)"));
    assert.ok(next.startsWith(RETROSPECTIVA_BOX_HEADER));
    assert.ok(!next.includes("Setembro"));
    assert.equal((next.match(/^Três temas/gm) ?? []).length, 1);
  });

  it("migração: arquivo no formato anterior (#9474) vira o formato novo, inclusive tier e header", () => {
    const next = applyRetrospectivaBoxUpdate(LEGACY_FILE, INPUT);
    assert.equal(next, `${RETROSPECTIVA_BOX_HEADER}\n\n${APPROVED_BODY_2609}`);
    // idempotente: rodar de novo sobre o resultado não muda nada
    assert.equal(applyRetrospectivaBoxUpdate(next, INPUT), next);
  });

  it("migração preserva header editado à mão (só troca o header gerado pelo script)", () => {
    const custom = LEGACY_FILE.replace(/^<!--[\s\S]*?-->/, "<!-- nota do editor -->");
    const next = applyRetrospectivaBoxUpdate(custom, INPUT);
    assert.ok(next.startsWith("<!-- nota do editor -->\n\n**Retrospectiva de Setembro**"));
    assert.ok(next.includes(TIER_BLOCK));
  });

  it("temas com padrões de substituição ($&, $') entram literais (novo e migração)", () => {
    const temas = ["IA custa $& por mês", "preço $' de verdade", "fim $1"];
    const expected = "Três temas marcaram o mês: IA custa $& por mês, preço $' de verdade e fim $1.";
    assert.ok(applyRetrospectivaBoxUpdate(buildDefaultRetrospectivaBox(INPUT), { ...INPUT, temas }).includes(expected));
    assert.ok(applyRetrospectivaBoxUpdate(LEGACY_FILE, { ...INPUT, temas }).includes(expected));
  });

  it("formato divergente aborta com RetrospectivaBoxFormatError (nunca adivinha)", () => {
    assert.throws(() => applyRetrospectivaBoxUpdate("**Outro box**\n\ntexto", INPUT), RetrospectivaBoxFormatError);
    // formato anterior sem o tier de uma linha (editado à mão): não migra às cegas
    const semTier = LEGACY_FILE.replace(/^Quem apoia[^\n]*$/m, "Apoie a partir de R$25.");
    assert.throws(() => applyRetrospectivaBoxUpdate(semTier, INPUT), RetrospectivaBoxFormatError);
    // formato novo sem CTA
    const semCta = buildDefaultRetrospectivaBox(INPUT).replace(/^\[Ler a Retrospectiva\].*$/m, "");
    assert.throws(() => applyRetrospectivaBoxUpdate(semCta, INPUT), RetrospectivaBoxFormatError);
  });

  it("temas ≠ 3 (ou vazio) erra com mensagem clara", () => {
    assert.throws(() => buildDefaultRetrospectivaBox({ ...INPUT, temas: ["a", "b"] }), /exatamente 3 temas/);
    assert.throws(() => buildDefaultRetrospectivaBox({ ...INPUT, temas: ["a", "b", "c", "d"] }), /exatamente 3 temas/);
    assert.throws(() => normalizeTemas(["a", " ", "c"]), /tema vazio/);
  });

  it("parseTemasArg: separa por | e valida a contagem", () => {
    assert.deepEqual(parseTemasArg("a | b |c."), ["a", "b", "c"]);
    assert.throws(() => parseTemasArg("a|b"), /exatamente 3 temas/);
    assert.throws(() => parseTemasArg("a|b|c|d"), /exatamente 3 temas/);
    assert.throws(() => parseTemasArg("a||c"), /tema vazio/);
  });
});

describe("runUpdateRetrospectivaBox / runUpdateArtigoEspecialBox — integração com arquivos", () => {
  let tmp: string;
  let configPath: string;
  let snippetsFile: string;
  const realishConfig = `{\n  "boxes_divulgacao": {\n    "slot1": "livros-divulgacao.md",\n    "slot2": "${AE}"\n  },\n  "boxes_divulgacao_auto": {\n    "enabled": true,\n    "pinned_slots": [1, 2]\n  },\n  "outra": [1, 2, 3]\n}\n`;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "box-9474-"));
    configPath = join(tmp, "platform.config.json");
    snippetsFile = join(tmp, "snippets", RETRO);
    writeFileSync(configPath, realishConfig);
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  const opts = () => ({
    cycle: "2609-10",
    temas: TEMAS as readonly string[] | undefined,
    unpin: false,
    pin: true,
    force: false,
    dryRun: false,
    snippetsFile,
    configPath,
    cycleDir: tmp,
  });

  it("publica: snippet criado, slot2 → Retrospectiva (diff cirúrgico), canal box done; 2ª vez pula", () => {
    const r = runUpdateRetrospectivaBox(opts());
    assert.equal(r.action, "updated");
    assert.ok(readFileSync(snippetsFile, "utf8").includes("retrospectiva.diar.ia.br/2609"));
    const cfgText = readFileSync(configPath, "utf8");
    assert.ok(cfgText.includes(`"slot2": "${RETRO}"`));
    assert.ok(cfgText.includes('"outra": [1, 2, 3]'), "arrays inline não podem ser expandidos (#9256/#495)");
    assert.equal(readRetrospectivaDivulgacaoState(retrospectivaDivulgacaoStatePath(tmp), "2609-10").channels.box?.status, "done");
    assert.equal(runUpdateRetrospectivaBox(opts()).action, "skipped");
  });

  it("dry-run não escreve nada", () => {
    runUpdateRetrospectivaBox({ ...opts(), dryRun: true });
    assert.ok(!existsSync(snippetsFile));
    assert.equal(readFileSync(configPath, "utf8"), realishConfig);
  });

  it("--unpin da Retrospectiva com o Artigo Especial no slot é no-op e não exige --temas", () => {
    const r = runUpdateRetrospectivaBox({ ...opts(), temas: undefined, cycle: undefined, unpin: true });
    assert.equal(r.action, "noop");
    assert.match((r as { reason: string }).reason, /Artigo Especial/);
    assert.equal(readFileSync(configPath, "utf8"), realishConfig);
  });

  it("--unpin com um 3º valor no slot (drift) também é no-op, mas avisando que não é o parceiro", () => {
    writeFileSync(configPath, realishConfig.replace(`"slot2": "${AE}"`, '"slot2": "outro-box.md"'));
    const r = runUpdateRetrospectivaBox({ ...opts(), temas: undefined, cycle: undefined, unpin: true });
    assert.equal(r.action, "noop");
    assert.match((r as { reason: string }).reason, /nenhum dos 2 boxes/);
  });

  it("--unpin da Retrospectiva quando ELA é a dona: solta o slot sem tocar snippet nem state", () => {
    runUpdateRetrospectivaBox(opts());
    const r = runUpdateRetrospectivaBox({ ...opts(), temas: undefined, unpin: true });
    assert.deepEqual(r, { action: "updated", snippetWritten: false, configChanged: true });
    const cfg = JSON.parse(readFileSync(configPath, "utf8")) as BoxesDivulgacaoConfig;
    assert.deepEqual(cfg.boxes_divulgacao_auto!.pinned_slots, [1]);
    assert.equal(cfg.boxes_divulgacao!.slot2, RETRO);
  });

  it("retomar o slot depois do Artigo Especial exige --force (canal box já done)", () => {
    runUpdateRetrospectivaBox(opts());
    const cfg = JSON.parse(readFileSync(configPath, "utf8")) as BoxesDivulgacaoConfig;
    cfg.boxes_divulgacao!.slot2 = AE;
    writeFileSync(configPath, JSON.stringify(cfg, null, 2) + "\n");
    assert.equal(runUpdateRetrospectivaBox(opts()).action, "skipped");
    assert.equal((JSON.parse(readFileSync(configPath, "utf8")) as BoxesDivulgacaoConfig).boxes_divulgacao!.slot2, AE);
    assert.equal(runUpdateRetrospectivaBox({ ...opts(), force: true }).action, "updated");
    assert.equal((JSON.parse(readFileSync(configPath, "utf8")) as BoxesDivulgacaoConfig).boxes_divulgacao!.slot2, RETRO);
  });

  it("formato divergente num snippet existente: canal box failed, nada escrito, erro propaga", () => {
    mkdirSync(join(tmp, "snippets"), { recursive: true });
    writeFileSync(snippetsFile, "**Outro box**\n\ntexto\n");
    assert.throws(() => runUpdateRetrospectivaBox(opts()), RetrospectivaBoxFormatError);
    assert.equal(readFileSync(snippetsFile, "utf8"), "**Outro box**\n\ntexto\n");
    assert.equal(readFileSync(configPath, "utf8"), realishConfig);
    assert.equal(readRetrospectivaDivulgacaoState(retrospectivaDivulgacaoStatePath(tmp), "2609-10").channels.box?.status, "failed");
  });

  it("--temas ausente ou com ≠3 itens erra antes de tocar snippet, config ou state", () => {
    assert.throws(() => runUpdateRetrospectivaBox({ ...opts(), temas: undefined }), /--temas/);
    assert.throws(() => runUpdateRetrospectivaBox({ ...opts(), temas: ["a", "b"] }), /exatamente 3 temas/);
    assert.ok(!existsSync(snippetsFile));
    assert.equal(readFileSync(configPath, "utf8"), realishConfig);
    assert.equal(readRetrospectivaDivulgacaoState(retrospectivaDivulgacaoStatePath(tmp), "2609-10").channels.box, undefined);
  });

  it("snippet existente no formato anterior é migrado pelo runner (cenário real do ciclo 2609-10)", () => {
    mkdirSync(join(tmp, "snippets"), { recursive: true });
    writeFileSync(snippetsFile, LEGACY_FILE);
    assert.equal(runUpdateRetrospectivaBox(opts()).action, "updated");
    assert.equal(readFileSync(snippetsFile, "utf8"), `${RETROSPECTIVA_BOX_HEADER}\n\n${APPROVED_BODY_2609}`);
  });

  it("--no-pin escreve o snippet e não toca no config", () => {
    const r = runUpdateRetrospectivaBox({ ...opts(), pin: false });
    assert.deepEqual(r, { action: "updated", snippetWritten: true, configChanged: false });
    assert.equal(readFileSync(configPath, "utf8"), realishConfig);
  });

  it("Artigo Especial --unpin depois que a Retrospectiva pinou: slot 2 continua pinado na Retrospectiva", () => {
    runUpdateRetrospectivaBox(opts());
    const before = readFileSync(configPath, "utf8");
    runUpdateArtigoEspecialBox({
      titulo: "t",
      gancho: "g",
      mesLabel: "Setembro",
      snippetsFile: join(tmp, "snippets", AE),
      configPath,
      dataDir: tmp,
      slot: 2,
      pin: false,
      dryRun: false,
      force: false,
    });
    const cfg = JSON.parse(readFileSync(configPath, "utf8")) as BoxesDivulgacaoConfig;
    assert.equal(cfg.boxes_divulgacao!.slot2, RETRO);
    assert.deepEqual(cfg.boxes_divulgacao_auto!.pinned_slots, [1, 2]);
    assert.equal(readFileSync(configPath, "utf8"), before);
  });
});

describe("box da Retrospectiva pinado de fato RENDERIZA no slot 2 (cross-módulo com stitch-newsletter.ts)", () => {
  it("edição de 3 destaques: o box aparece no gap D2/D3 com o título e o link da página do mês", () => {
    const dir = mkdtempSync(join(tmpdir(), "retro-render-9474-"));
    try {
      mkdirSync(join(dir, "data", "snippets"), { recursive: true });
      writeFileSync(join(dir, "data", "snippets", RETRO), buildDefaultRetrospectivaBox(INPUT), "utf8");
      const internalDir = join(dir, "_internal");
      mkdirSync(internalDir, { recursive: true });
      writeFileSync(join(internalDir, "02-d1-draft.md"), "**DESTAQUE 1 | 🚀**\n\n[**T1**](https://e.com/d1)\n\nbody1");
      writeFileSync(join(internalDir, "02-d2-draft.md"), "**DESTAQUE 2 | 🔬**\n\n[**T2**](https://e.com/d2)\n\nbody2");
      writeFileSync(join(internalDir, "02-d3-draft.md"), "**DESTAQUE 3 | ⚖️**\n\n[**T3**](https://e.com/d3)\n\nbody3");
      writeFileSync(join(internalDir, "01-approved-capped.json"), JSON.stringify({ coverage: { line: "cov" } }));
      const pinned = applyBoxPin(base, { slot: 2, filename: RETRO, pin: true });
      const out = stitchNewsletter({
        d1Path: join(internalDir, "02-d1-draft.md"),
        d2Path: join(internalDir, "02-d2-draft.md"),
        d3Path: join(internalDir, "02-d3-draft.md"),
        approvedCappedPath: join(internalDir, "01-approved-capped.json"),
        editionDir: dir,
        snippetsRootDir: dir,
        boxesDivulgacao: { slot1: null, slot2: pinned.boxes_divulgacao!.slot2 as string },
      });
      const box = extractBoxDivulgacao2(out);
      assert.ok(box, "o box da Retrospectiva deve aparecer no slot 2");
      assert.match(box!, /Três temas marcaram o mês: agentes de IA/);
      assert.match(box!, /voto no tema do próximo Artigo Especial/);
      assert.match(box!, /retrospectiva\.diar\.ia\.br\/2609/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
