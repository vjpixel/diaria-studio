/**
 * test/agendamentos-12774.test.ts (#12774)
 *
 * Banco de agendamentos: validação, revisão otimista, transições (com a regra
 * do #573 para `publicado`), avaliação de vencidos/falhos, CLI contra um
 * diretório temporário (nunca o `data/` real) e o registro da task.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  AGENDAMENTO_VENCIDO_GRACE_MINUTES,
  addAgendamento,
  addDaysAammdd,
  agendamentosAlarmFingerprint,
  agendamentosPath,
  avaliarAgendamentos,
  brtAlvoIso,
  buildAgendamentosAlarm,
  emptyBanco,
  loadAgendamentos,
  parseBanco,
  removerAgendamento,
  saveAgendamentos,
  transicionarAgendamento,
  type AgendamentosBanco,
} from "../scripts/lib/diaria/agendamentos.ts";
import { DESTINOS_VERTICAL, resolveDestinos, runAgendamentosCli } from "../scripts/agendamentos.ts";
import { fileURLToPath } from "node:url";
import { getScheduledTaskByName } from "../scripts/lib/scheduled-tasks.ts";

const T0 = new Date("2026-11-11T15:00:00Z");

function vertical2(banco: AgendamentosBanco = emptyBanco(), extra: Partial<Parameters<typeof addAgendamento>[1]> = {}) {
  return addAgendamento(
    banco,
    {
      edicao: "261111",
      peca: "vertical-2",
      destinos: ["youtube_shorts", "instagram"],
      alvo: brtAlvoIso(addDaysAammdd("261111", 7), "12:00"),
      dono: "sessão /diaria-publica",
      ...extra,
    },
    T0,
  );
}

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), "agendamentos-12774-"));
}

describe("datas", () => {
  it("D+7 atravessa o fim do mês e o alvo BRT vira UTC+3", () => {
    assert.equal(addDaysAammdd("261128", 7), "261205");
    assert.equal(brtAlvoIso("261118", "12:00"), "2026-11-18T15:00:00.000Z");
    assert.throws(() => brtAlvoIso("261118", "25:00"));
  });
});

describe("addAgendamento", () => {
  it("cria o vertical 2 pendente com id edição-peça e histórico", () => {
    const { banco, item, created } = vertical2();
    assert.equal(created, true);
    assert.equal(item.id, "261111-vertical-2");
    assert.equal(item.estado, "pendente");
    assert.equal(item.alvo, "2026-11-18T15:00:00.000Z");
    assert.equal(item.historico.length, 1);
    assert.equal(banco.itens.length, 1);
  });

  it("registrar de novo com os mesmos dados é no-op; com outros dados lança", () => {
    const first = vertical2();
    const again = vertical2(first.banco, { destinos: ["instagram", "youtube_shorts"] });
    assert.equal(again.created, false);
    assert.equal(again.banco.itens.length, 1);
    assert.throws(() => vertical2(first.banco, { dono: "outro" }), /já existe/);
  });

  it("recusa dono vazio, destinos vazios, edição inválida e nascer publicado", () => {
    assert.throws(() => vertical2(undefined, { dono: "  " }), /dono/);
    assert.throws(() => vertical2(undefined, { destinos: [] }), /destinos/);
    assert.throws(() => vertical2(undefined, { destinos: ["facebook:"] }), /destinos/);
    assert.throws(() => vertical2(undefined, { destinos: ["a:b:c"] }), /destinos/);
    assert.equal(vertical2(undefined, { destinos: ["facebook:diaria"] }).item.destinos[0], "facebook:diaria");
    assert.throws(() => vertical2(undefined, { edicao: "2611" }), /edicao/);
    assert.throws(() => vertical2(undefined, { estado: "publicado" }), /publicado/);
  });
});

describe("transicionarAgendamento", () => {
  it("pendente → pronto → agendado → publicado com verificacao", () => {
    let b = vertical2().banco;
    b = transicionarAgendamento(b, { id: "261111-vertical-2", para: "pronto" }, T0);
    b = transicionarAgendamento(b, { id: "261111-vertical-2", para: "agendado" }, T0);
    b = transicionarAgendamento(
      b,
      { id: "261111-vertical-2", para: "publicado", verificacao: { fonte: "youtube videos.list", em: T0.toISOString() } },
      T0,
    );
    const it = b.itens[0];
    assert.equal(it.estado, "publicado");
    assert.deepEqual(it.historico.map((h) => h.para), ["pendente", "pronto", "agendado", "publicado"]);
  });

  it("publicado sem verificacao relida é recusado (#573)", () => {
    const b = vertical2().banco;
    assert.throws(() => transicionarAgendamento(b, { id: "261111-vertical-2", para: "publicado" }, T0), /#573/);
  });

  it("publicado é terminal; transição fora da tabela lança", () => {
    let b = vertical2().banco;
    b = transicionarAgendamento(
      b,
      { id: "261111-vertical-2", para: "publicado", verificacao: { fonte: "x", em: T0.toISOString() } },
      T0,
    );
    assert.throws(() => transicionarAgendamento(b, { id: "261111-vertical-2", para: "falhou" }, T0), /não permitida/);
    assert.throws(() => transicionarAgendamento(b, { id: "nao-existe", para: "pronto" }, T0), /não existe/);
  });

  it("parseBanco recusa publicado sem verificacao escrito à mão", () => {
    const b = vertical2().banco;
    const raw = JSON.parse(JSON.stringify(b));
    raw.itens[0].estado = "publicado";
    assert.throws(() => parseBanco(JSON.stringify(raw)), /#573/);
  });
});

describe("load/save", () => {
  it("ausente = vazio; grava atômico e sobe a revisão", () => {
    const root = tmpRoot();
    try {
      const path = agendamentosPath(root);
      const b0 = loadAgendamentos(path);
      assert.equal(b0.revisao, 0);
      const saved = saveAgendamentos(path, vertical2(b0).banco);
      assert.equal(saved.revisao, 1);
      assert.equal(loadAgendamentos(path).itens[0].id, "261111-vertical-2");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("revisão otimista: gravar a partir de uma leitura velha é recusado", () => {
    const root = tmpRoot();
    try {
      const path = agendamentosPath(root);
      const stale = loadAgendamentos(path);
      saveAgendamentos(path, vertical2(stale).banco);
      const other = addAgendamento(
        stale,
        { edicao: "261112", peca: "vertical-2", destinos: ["tiktok"], alvo: brtAlvoIso("261119", "12:00"), dono: "x" },
        T0,
      ).banco;
      assert.throws(() => saveAgendamentos(path, other), /banco mudou/);
      assert.equal(loadAgendamentos(path).itens.length, 1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("banco ilegível lança em vez de virar vazio", () => {
    const root = tmpRoot();
    try {
      const path = agendamentosPath(root);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, "{ quebrado");
      assert.throws(() => loadAgendamentos(path), /JSON inválido/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("avaliarAgendamentos", () => {
  const alvo = new Date("2026-11-18T15:00:00Z");
  const at = (min: number) => new Date(alvo.getTime() + min * 60_000);

  it("antes do alvo: futuro, sem achado", () => {
    const ev = avaliarAgendamentos(vertical2().banco, at(-30));
    assert.equal(ev.futuros.length, 1);
    assert.equal(ev.achados.length, 0);
  });

  it("dentro da folga: sem achado; passado alvo + folga: vencido-sem-publicacao", () => {
    const b = vertical2().banco;
    assert.equal(avaliarAgendamentos(b, at(AGENDAMENTO_VENCIDO_GRACE_MINUTES)).achados.length, 0);
    const ev = avaliarAgendamentos(b, at(AGENDAMENTO_VENCIDO_GRACE_MINUTES + 1));
    assert.equal(ev.achados.length, 1);
    assert.equal(ev.achados[0].tipo, "vencido-sem-publicacao");
  });

  it("pronto no horário entra em aPublicar; publicado nunca alarma; falhou alarma mesmo antes do alvo", () => {
    let b = transicionarAgendamento(vertical2().banco, { id: "261111-vertical-2", para: "pronto" }, T0);
    assert.equal(avaliarAgendamentos(b, at(5)).aPublicar.length, 1);
    const pub = transicionarAgendamento(
      b,
      { id: "261111-vertical-2", para: "publicado", verificacao: { fonte: "x", em: T0.toISOString() } },
      T0,
    );
    assert.equal(avaliarAgendamentos(pub, at(10_000)).achados.length, 0);
    b = transicionarAgendamento(b, { id: "261111-vertical-2", para: "falhou", nota: "upload 500" }, T0);
    const ev = avaliarAgendamentos(b, at(-1000));
    assert.equal(ev.achados.length, 1);
    assert.equal(ev.achados[0].tipo, "falhou");
  });

  it("fingerprint é do conjunto (ordem não importa) e o corpo cita o comando de marcar", () => {
    const b1 = vertical2().banco;
    const b2 = addAgendamento(
      b1,
      { edicao: "261110", peca: "vertical-2", destinos: ["tiktok"], alvo: brtAlvoIso("261117", "12:00"), dono: "x" },
      T0,
    ).banco;
    const ev = avaliarAgendamentos(b2, at(500));
    assert.equal(ev.achados.length, 2);
    assert.equal(
      agendamentosAlarmFingerprint(ev.achados),
      agendamentosAlarmFingerprint([...ev.achados].reverse()),
    );
    const { subject, body } = buildAgendamentosAlarm(ev.achados);
    assert.match(subject, /2 itens/);
    assert.match(body, /261111-vertical-2/);
    assert.match(body, /--verificado-fonte/);
  });

  it("removerAgendamento tira o item e lança para id inexistente", () => {
    const b = vertical2().banco;
    assert.equal(removerAgendamento(b, "261111-vertical-2").itens.length, 0);
    assert.throws(() => removerAgendamento(b, "x"), /não existe/);
  });
});

describe("CLI scripts/agendamentos.ts", () => {
  function run(root: string, argv: string[]) {
    const out: string[] = [];
    const err: string[] = [];
    const code = runAgendamentosCli(argv, { root, now: T0, out: (s) => out.push(s), err: (s) => err.push(s) });
    return { code, out: out.join("\n"), err: err.join("\n") };
  }

  it("registrar → listar → marcar publicado → listar vazio", () => {
    const root = tmpRoot();
    try {
      const reg = ["registrar", "--edicao", "261111", "--peca", "vertical-2", "--destinos", "youtube_shorts,instagram", "--dias", "7", "--dono", "sessão"];
      assert.equal(run(root, reg).code, 0);
      assert.match(run(root, reg).out, /já registrado/);
      const banco = JSON.parse(readFileSync(agendamentosPath(root), "utf8"));
      assert.equal(banco.itens[0].alvo, "2026-11-18T15:00:00.000Z");
      assert.match(run(root, ["listar"]).out, /261111-vertical-2/);

      const semProva = run(root, ["marcar", "--id", "261111-vertical-2", "--estado", "publicado"]);
      assert.equal(semProva.code, 1);
      assert.match(semProva.err, /#573/);
      assert.equal(
        run(root, ["marcar", "--id", "261111-vertical-2", "--estado", "publicado", "--verificado-fonte", "youtube videos.list"]).code,
        0,
      );
      assert.match(run(root, ["listar"]).out, /nenhum item/);
      assert.match(run(root, ["listar", "--todos"]).out, /publicado/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("--destinos vertical expande para os destinos da vertical na config (registro do vertical 2 pela montagem)", () => {
    const root = tmpRoot();
    try {
      const reg = ["registrar", "--edicao", "261111", "--peca", "vertical-2", "--destinos", "vertical", "--dias", "7", "--dono", "d"];
      // Sem platform.config.json no root: erro claro, nada gravado.
      const sem = run(root, reg);
      assert.equal(sem.code, 1);
      assert.match(sem.err, /--destinos vertical: não li/);
      writeFileSync(
        join(root, "platform.config.json"),
        JSON.stringify({ publishing: { shorts: { facebook_pages: ["diaria"], instagram: true, x: true, tiktok: false, threads_profile: false, linkedin_profile: false, linkedin_page_repost: false, facebook_profile: false } } }),
      );
      const ok = run(root, reg);
      assert.equal(ok.code, 0, ok.err);
      const banco = JSON.parse(readFileSync(agendamentosPath(root), "utf8"));
      assert.deepEqual(banco.itens[0].destinos, ["youtube_shorts", "facebook:diaria", "instagram", "x"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("--destinos vertical com o platform.config.json real dá ids que o banco aceita", () => {
    const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
    const ids = resolveDestinos(DESTINOS_VERTICAL, repoRoot);
    assert.ok(ids.includes("youtube_shorts"));
    assert.ok(vertical2(undefined, { destinos: ids }).created);
  });

  it("erros de uso saem 1: subcomando ausente, flag desconhecida, --alvo sem fuso, --alvo com --dias", () => {
    const root = tmpRoot();
    try {
      assert.equal(run(root, []).code, 1);
      assert.equal(run(root, ["listar", "--xyz"]).code, 1);
      const base = ["registrar", "--edicao", "261111", "--peca", "vertical-2", "--destinos", "x", "--dono", "d"];
      assert.match(run(root, [...base, "--alvo", "2026-11-18T12:00:00"]).err, /fuso/);
      assert.match(run(root, [...base, "--alvo", "2026-11-18T12:00:00-03:00", "--dias", "7"]).err, /não os dois/);
      assert.equal(run(root, [...base, "--alvo", "2026-11-18T12:00:00-03:00"]).code, 0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("task Diaria-Agendamentos-Tick", () => {
  it("registrada, de hora em hora, rodando o consumidor, com guard da junction data/", () => {
    const t = getScheduledTaskByName("Diaria-Agendamentos-Tick");
    assert.ok(t);
    assert.deepEqual(t.schedule, { kind: "interval", hours: 1 });
    assert.equal(t.steps[0].script, "scripts/agendamentos-tick.ts");
    assert.equal(t.guard?.requiredFile, "editions");
    assert.notEqual(t.enabled, false);
  });

  it("#12970: exit 2 (releitura falhou, alarme preservado) é sucesso para o systemd; 1 continua falha", () => {
    const t = getScheduledTaskByName("Diaria-Agendamentos-Tick");
    assert.deepEqual(t?.successExitCodes, [2]);
  });
});
