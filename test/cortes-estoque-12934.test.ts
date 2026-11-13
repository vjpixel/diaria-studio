/**
 * test/cortes-estoque-12934.test.ts (#12934)
 *
 * Os cortes extras da montagem entram no banco de agendamentos e a visão de
 * estoque acha os vídeos prontos e não usados. Cenário real da issue: os
 * cortes `nvidia` (261110) e `automacao` (261111) ficaram fora do banco e de
 * `data/cortes/`, e só apareceram numa varredura feita à mão.
 *
 * Tudo contra diretório temporário, nunca o `data/` real.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runAgendamentosCli } from "../scripts/agendamentos.ts";
import { addAgendamento, agendamentosPath, brtAlvoIso, emptyBanco, loadAgendamentos, transicionarAgendamento } from "../scripts/lib/diaria/agendamentos.ts";
import { corteDaPeca, corteDirDoItem, itensVerificaveis, pecaDoCorte } from "../scripts/lib/diaria/agendamentos-verificar.ts";
import { montarEstoque, parseCorteSlug, planejarRegistroExtras, registrarExtras } from "../scripts/lib/diaria/cortes-estoque.ts";
import { nthBusinessDayAfter } from "../scripts/lib/diaria/extra-verticals.ts";
import { loadShortScheduleConfig } from "../scripts/lib/diaria/short-video.ts";
import { defaultSequences, type SequenceSpec } from "../scripts/lib/diaria/video-montage.ts";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const T0 = new Date("2026-11-10T22:00:00Z");
const [YT, OUT] = defaultSequences();
const SCHED = loadShortScheduleConfig({
  publishing: { shorts: { schedule: { rotation_times: ["06:30", "08:00", "12:00"], rotation_start: "2026-10-26", rotation_end: "2026-11-13", default_time: "12:00" } } },
});
const DESTINOS = ["youtube_shorts", "instagram"];

function corteSeq(corte: string, title: string): SequenceSpec {
  return { ...OUT, target: "instagram", name: `Diaria comentada_Vertical_V1-${corte}`, corte, screenTitle: title, hook: `${title} gancho` };
}

function blocksFile(edition: string, cortes: Array<[string, string]>) {
  return { edition, sequences: [YT, OUT, ...cortes.map(([c, t]) => corteSeq(c, t))], blocks: { comentario: [{ start: 1, end: 2 }] } };
}

describe("peça do banco ↔ corte", () => {
  it("guia é vertical-2; os outros cortes são corte-{corte}, ida e volta", () => {
    assert.equal(pecaDoCorte("guia"), "vertical-2");
    assert.equal(pecaDoCorte("nvidia"), "corte-nvidia");
    assert.equal(corteDaPeca("vertical-2"), "guia");
    assert.equal(corteDaPeca("corte-nvidia"), "nvidia");
    assert.equal(corteDaPeca("corte-"), null);
    assert.equal(corteDaPeca("outra-peca"), null);
    assert.deepEqual(parseCorteSlug("jensen-huang-261112"), { corte: "jensen-huang", edicao: "261112" });
    assert.equal(parseCorteSlug("sem-data"), null);
  });

  it("verificar e tick passam a enxergar o corte extra agendado (pasta data/cortes/{corte}-{edição})", () => {
    let { banco } = addAgendamento(emptyBanco(), { edicao: "261110", peca: "corte-nvidia", destinos: DESTINOS, alvo: brtAlvoIso("261111", "08:00"), dono: "d" }, T0);
    assert.equal(itensVerificaveis(banco).length, 0);
    banco = transicionarAgendamento(banco, { id: "261110-corte-nvidia", para: "agendado" }, T0);
    assert.deepEqual(itensVerificaveis(banco).map((it) => it.id), ["261110-corte-nvidia"]);
    assert.equal(corteDirDoItem(banco.itens[0]), "data/cortes/nvidia-261110");
  });
});

describe("planejarRegistroExtras / registrarExtras", () => {
  it("registra os extras como pendente com o alvo do plano e deixa o guia de fora", () => {
    const file = blocksFile("261110", [["nvidia", "Por que a Nvidia vale US$ 5 trilhões?"], ["guia", "O guia"]]);
    const novos = planejarRegistroExtras({ edition: "261110", file, sched: SCHED, destinos: DESTINOS });
    assert.deepEqual(novos.map((n) => n.peca), ["corte-nvidia"]);
    assert.equal(novos[0].estado, "pendente");
    // nvidia é a 1ª sequência de corte: 1º dia útil depois da edição.
    assert.equal(nthBusinessDayAfter("261110", 1), "261111");
    assert.ok(novos[0].alvo.startsWith("2026-11-11T"), novos[0].alvo);
    assert.match(novos[0].nota ?? "", /Nvidia vale/);
    assert.deepEqual(novos[0].destinos, DESTINOS);
  });

  it("sem destino na config é erro (o banco não aceita item sem destino)", () => {
    assert.throws(() => planejarRegistroExtras({ edition: "261110", file: blocksFile("261110", [["nvidia", "t"]]), sched: SCHED, destinos: [] }), /nenhum destino/);
  });

  it("reexecução é no-op; item que mudou fica como está (mantido), nunca reescrito", () => {
    const novos = planejarRegistroExtras({ edition: "261110", file: blocksFile("261110", [["nvidia", "t"]]), sched: SCHED, destinos: DESTINOS });
    const first = registrarExtras(emptyBanco(), novos, T0);
    assert.deepEqual(first.resultados.map((r) => r.status), ["criado"]);
    const again = registrarExtras(first.banco, novos, T0);
    assert.deepEqual(again.resultados.map((r) => r.status), ["ja-registrado"]);
    assert.equal(again.banco, first.banco);
    const outroAlvo = novos.map((n) => ({ ...n, alvo: brtAlvoIso("261113", "08:00") }));
    const mudou = registrarExtras(first.banco, outroAlvo, T0);
    assert.deepEqual(mudou.resultados.map((r) => r.status), ["mantido"]);
    assert.equal(mudou.banco.itens[0].alvo, first.banco.itens[0].alvo);
  });
});

describe("montarEstoque", () => {
  it("cenário da issue: corte só no blocks.json aparece como estoque; o guia agendado no banco não", () => {
    let { banco } = addAgendamento(emptyBanco(), { edicao: "261112", peca: "vertical-2", destinos: DESTINOS, alvo: brtAlvoIso("261119", "12:00"), dono: "d" }, T0);
    banco = transicionarAgendamento(banco, { id: "261112-vertical-2", para: "agendado" }, T0);
    const itens = montarEstoque({
      blocks: [
        { edition: "261110", file: blocksFile("261110", [["nvidia", "Nvidia"]]) },
        { edition: "261111", file: blocksFile("261111", [["automacao", "Automação"]]) },
        { edition: "261112", file: blocksFile("261112", [["guia", "Guia"]]) },
      ],
      cortes: [],
      banco,
    });
    const estoque = itens.filter((it) => !it.usado).map((it) => it.slug);
    assert.deepEqual(estoque, ["nvidia-261110", "automacao-261111"]);
    assert.match(itens[0].motivo, /só no blocks\.json/);
    const guia = itens.find((it) => it.slug === "guia-261112")!;
    assert.equal(guia.usado, true);
    assert.equal(guia.bancoId, "261112-vertical-2");
  });

  it("envio registrado, \"pode publicar\" ou banco agendado contam como uso; banco pendente com envio avisa desatualizado", () => {
    const { banco } = addAgendamento(emptyBanco(), { edicao: "261110", peca: "corte-nvidia", destinos: DESTINOS, alvo: brtAlvoIso("261111", "08:00"), dono: "d" }, T0);
    const itens = montarEstoque({
      blocks: [{ edition: "261110", file: blocksFile("261110", [["nvidia", "Nvidia"]]) }],
      cortes: [
        { slug: "nvidia-261110", spec: { date: "261113", hhmm: "08:00", title: "Nvidia final" }, entries: [{ destination: "youtube_shorts", status: "scheduled" }] },
        { slug: "manual-261108", spec: { date: "261108", hhmm: "18:00", title: "Manual", publish_confirmed_at: "2026-11-08T10:00:00Z" }, entries: [] },
        { slug: "parado-261109", spec: { date: "261109", hhmm: "18:00", title: "Parado" }, entries: [] },
        { slug: "quebrado-261109", spec: null, entries: null, erro: "corte.json ilegível" },
      ],
      banco,
    });
    const by = Object.fromEntries(itens.map((it) => [it.slug, it]));
    assert.equal(by["nvidia-261110"].usado, true);
    assert.equal(by["nvidia-261110"].titulo, "Nvidia final");
    assert.ok(by["nvidia-261110"].avisos.some((a) => /banco desatualizado/.test(a)));
    assert.equal(by["manual-261108"].usado, true);
    assert.equal(by["manual-261108"].noBlocks, false);
    assert.equal(by["parado-261109"].usado, false);
    assert.equal(by["quebrado-261109"].usado, false);
    assert.ok(by["quebrado-261109"].avisos.some((a) => /ilegível/.test(a)));
  });
});

describe("CLI registrar-extras + estoque", () => {
  function setup(): string {
    const root = mkdtempSync(join(tmpdir(), "cortes-estoque-12934-"));
    copyFileSync(join(REPO, "platform.config.json"), join(root, "platform.config.json"));
    for (const [ed, cortes] of [
      ["261110", [["nvidia", "Por que a Nvidia vale US$ 5 trilhões?"]]],
      ["261111", [["automacao", "Como a IA aprende a fazer o seu trabalho"]]],
    ] as const) {
      const p = join(root, "data", "editions", ed.slice(0, 4), ed, "_internal", "video-montagem", "blocks.json");
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, JSON.stringify(blocksFile(ed, cortes.map(([c, t]) => [c, t] as [string, string]))));
    }
    return root;
  }
  function run(root: string, argv: string[]) {
    const out: string[] = [];
    const err: string[] = [];
    const code = runAgendamentosCli(argv, { root, now: T0, out: (s) => out.push(s), err: (s) => err.push(s) });
    return { code, out: out.join("\n"), err: err.join("\n") };
  }

  it("estoque acha os cortes de antes do registro; registrar-extras os põe no banco; retomada é no-op", () => {
    const root = setup();
    try {
      const antes = run(root, ["estoque", "--json"]);
      assert.equal(antes.code, 0, antes.err);
      assert.deepEqual(JSON.parse(antes.out).itens.map((it: { slug: string }) => it.slug), ["nvidia-261110", "automacao-261111"]);

      const reg = run(root, ["registrar-extras", "--edicao", "261110"]);
      assert.equal(reg.code, 0, reg.err);
      assert.match(reg.out, /registrado: 261110-corte-nvidia +pendente/);
      const banco = loadAgendamentos(agendamentosPath(root));
      assert.equal(banco.itens.length, 1);
      assert.ok(banco.itens[0].destinos.includes("youtube_shorts"));

      const again = run(root, ["registrar-extras", "--edicao", "261110"]);
      assert.equal(again.code, 0, again.err);
      assert.match(again.out, /já registrado/);
      assert.equal(loadAgendamentos(agendamentosPath(root)).revisao, banco.revisao);

      // Ainda estoque: registrado no banco como pendente não é uso.
      const depois = run(root, ["estoque"]);
      assert.match(depois.out, /nvidia-261110 +ESTOQUE/);
      assert.match(depois.out, /banco 261110-corte-nvidia \(pendente\)/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("registrar-extras sem blocks.json, ou de outra edição, sai 1 sem gravar", () => {
    const root = setup();
    try {
      const sem = run(root, ["registrar-extras", "--edicao", "261112"]);
      assert.equal(sem.code, 1);
      assert.match(sem.err, /blocks\.json ausente/);
      const p = join(root, "data", "editions", "2611", "261110", "_internal", "video-montagem", "blocks.json");
      const outra = run(root, ["registrar-extras", "--edicao", "261111", "--blocks", p]);
      assert.equal(outra.code, 1);
      assert.match(outra.err, /é da edição 261110/);
      assert.equal(loadAgendamentos(agendamentosPath(root)).itens.length, 0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
