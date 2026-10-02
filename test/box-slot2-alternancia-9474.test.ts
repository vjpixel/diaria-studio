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
  applyRetrospectivaBoxUpdate,
  buildDefaultRetrospectivaBox,
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

const INPUT = {
  mesLabel: "Setembro",
  titulo: "A IA que decide sozinha já está no seu banco",
  gancho: "Três movimentos do mês explicam por que isso aconteceu agora",
  url: "https://retrospectiva.diar.ia.br/2609",
};

describe("snippet retrospectiva-apoiadores.md", () => {
  it("bootstrap tem header, título, frase-padrão, tier e CTA pra página do mês", () => {
    const s = buildDefaultRetrospectivaBox(INPUT);
    assert.ok(s.startsWith(RETROSPECTIVA_BOX_HEADER));
    assert.match(s, /^\*\*Retrospectiva de Setembro\*\*$/m);
    assert.match(s, /^A Retrospectiva de Setembro é: \*\*"A IA que decide sozinha já está no seu banco"\*\*\. Três movimentos .* agora\.$/m);
    assert.match(s, /R\$25\/mês/);
    assert.match(s, /^\[Ler a Retrospectiva\]\(https:\/\/retrospectiva\.diar\.ia\.br\/2609\)$/m);
  });

  it("update é cirúrgico: troca título/frase/URL e preserva header + tier editados à mão", () => {
    const original = buildDefaultRetrospectivaBox(INPUT).replace(
      "Quem apoia a partir de R$25/mês",
      "Quem apoia (editado à mão) a partir de R$25/mês",
    );
    const next = applyRetrospectivaBoxUpdate(original, {
      ...INPUT,
      mesLabel: "Outubro",
      titulo: "Novo título",
      gancho: "Novo gancho.",
      url: "https://retrospectiva.diar.ia.br/2610",
    });
    assert.match(next, /\*\*Retrospectiva de Outubro\*\*/);
    assert.match(next, /A Retrospectiva de Outubro é: \*\*"Novo título"\*\*\. Novo gancho\.$/m);
    assert.match(next, /\(https:\/\/retrospectiva\.diar\.ia\.br\/2610\)/);
    assert.ok(next.includes("Quem apoia (editado à mão)"));
    assert.ok(!next.includes("Setembro"));
  });

  it("título/gancho com padrões de substituição ($&, $') entram literais", () => {
    const next = applyRetrospectivaBoxUpdate(buildDefaultRetrospectivaBox(INPUT), {
      ...INPUT,
      titulo: "IA custa $& por mês",
      gancho: "Preço $' de verdade",
    });
    assert.ok(next.includes('**"IA custa $& por mês"**. Preço $\' de verdade.'));
  });

  it("formato divergente aborta com RetrospectivaBoxFormatError (nunca adivinha)", () => {
    assert.throws(() => applyRetrospectivaBoxUpdate("**Outro box**\n\ntexto", INPUT), RetrospectivaBoxFormatError);
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
    titulo: INPUT.titulo,
    gancho: INPUT.gancho,
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

  it("--unpin da Retrospectiva com o Artigo Especial no slot é no-op e não exige título/gancho", () => {
    const r = runUpdateRetrospectivaBox({ ...opts(), titulo: undefined, gancho: undefined, cycle: undefined, unpin: true });
    assert.equal(r.action, "noop");
    assert.match((r as { reason: string }).reason, /Artigo Especial/);
    assert.equal(readFileSync(configPath, "utf8"), realishConfig);
  });

  it("--unpin com um 3º valor no slot (drift) também é no-op, mas avisando que não é o parceiro", () => {
    writeFileSync(configPath, realishConfig.replace(`"slot2": "${AE}"`, '"slot2": "outro-box.md"'));
    const r = runUpdateRetrospectivaBox({ ...opts(), titulo: undefined, gancho: undefined, cycle: undefined, unpin: true });
    assert.equal(r.action, "noop");
    assert.match((r as { reason: string }).reason, /nenhum dos 2 boxes/);
  });

  it("--unpin da Retrospectiva quando ELA é a dona: solta o slot sem tocar snippet nem state", () => {
    runUpdateRetrospectivaBox(opts());
    const r = runUpdateRetrospectivaBox({ ...opts(), titulo: undefined, gancho: undefined, unpin: true });
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
      assert.match(box!, /A IA que decide sozinha/);
      assert.match(box!, /retrospectiva\.diar\.ia\.br\/2609/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
