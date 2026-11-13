/**
 * test/agendamentos-verificar-12774.test.ts (#12774, #573)
 *
 * `agendamentos.ts verificar`: o item `agendado` do vertical só vira
 * `publicado` com TODOS os destinos relidos no ar na plataforma. O registro
 * local do corte (`status: published`) nunca basta sozinho, e destino sem
 * leitor deixa o item como está. Tudo contra diretório temporário e fetch
 * falso (nenhuma chamada de rede, nunca o `data/` real).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addAgendamento,
  agendamentosPath,
  emptyBanco,
  saveAgendamentos,
  transicionarAgendamento,
  type AgendamentosBanco,
} from "../scripts/lib/diaria/agendamentos.ts";
import {
  YOUTUBE_LEITURA_FONTE,
  corteDirDoItem,
  decidirVerificacao,
  itensVerificaveis,
  lerDestinosDoItem,
  youtubeShortsLeitor,
  type LeitorDestino,
} from "../scripts/lib/diaria/agendamentos-verificar.ts";
import { runVerificarCli, runAgendamentosCli } from "../scripts/agendamentos.ts";
import { verificarBancoDoTick } from "../scripts/agendamentos-tick.ts";
import { GOOGLE_TOKEN_ENDPOINT } from "../scripts/lib/diaria/youtube-upload.ts";

const T0 = new Date("2026-11-11T15:00:00Z");
const T_DIA = new Date("2026-11-18T16:00:00Z");
const VIDEO_ID = "abcDEF12345";

function bancoAgendado(destinos: string[], estado: "agendado" | "pronto" = "agendado"): AgendamentosBanco {
  const { banco } = addAgendamento(
    emptyBanco(),
    { edicao: "261111", peca: "vertical-2", destinos, alvo: "2026-11-18T15:00:00.000Z", dono: "/diaria-publica 261118", estado: "pronto" },
    T0,
  );
  return estado === "agendado" ? transicionarAgendamento(banco, { id: "261111-vertical-2", para: "agendado" }, T0) : banco;
}

/** Raiz temporária com o corte `guia-261111` e as entradas do registro. */
function rootComCorte(entries: Array<Record<string, unknown>>, { semCorte = false } = {}): string {
  const root = mkdtempSync(join(tmpdir(), "agendamentos-verificar-12774-"));
  if (semCorte) return root;
  const dir = join(root, "data", "cortes", "guia-261111");
  mkdirSync(join(dir, "_internal"), { recursive: true });
  writeFileSync(
    join(dir, "corte.json"),
    JSON.stringify({ slug: "guia-261111", date: "261118", hhmm: "12:00", title: "O guia", hook: "Gancho.", video: "corte-guia-261111.mp4" }),
  );
  writeFileSync(join(dir, "_internal", "06-shorts-published.json"), JSON.stringify({ aammdd: "261118", entries }));
  return root;
}

const ytEntry = { destination: "youtube_shorts", status: "scheduled", id: VIDEO_ID, url: `https://youtube.com/shorts/${VIDEO_ID}`, scheduled_at: "2026-11-18T15:00:00.000Z", at: T0.toISOString() };
const igEntry = { destination: "instagram", status: "published", id: "17890000000000000", at: T0.toISOString() };

const leitorPublicado: LeitorDestino = async ({ destino }) => ({ destino, status: "publicado", fonte: "fake", url: "https://example.test/v" });

function io(root: string, now = T_DIA) {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { root, now, out: (s: string) => out.push(s), err: (s: string) => err.push(s) }, out, err };
}

function lerBanco(root: string): AgendamentosBanco {
  return JSON.parse(readFileSync(agendamentosPath(root), "utf8"));
}

describe("decidirVerificacao", () => {
  it("publicado só com todos os destinos relidos no ar; a fonte cita cada um", () => {
    const item = bancoAgendado(["youtube_shorts", "instagram"]).itens[0];
    const ok = decidirVerificacao(
      item,
      [
        { destino: "youtube_shorts", status: "publicado", fonte: "yt" },
        { destino: "instagram", status: "publicado", fonte: "ig" },
      ],
      T_DIA,
    );
    assert.equal(ok.publicado, true);
    assert.match(ok.verificacao!.fonte, /youtube_shorts=yt; instagram=ig/);
    assert.equal(ok.verificacao!.url, undefined, "URL só com um destino");

    const parcial = decidirVerificacao(
      item,
      [
        { destino: "youtube_shorts", status: "publicado", fonte: "yt" },
        { destino: "instagram", status: "sem-leitor", motivo: "x" },
      ],
      T_DIA,
    );
    assert.equal(parcial.publicado, false);
    assert.equal(parcial.verificacao, undefined);
  });

  it("destino sem leitura nenhuma não conta como publicado", () => {
    const item = bancoAgendado(["youtube_shorts", "instagram"]).itens[0];
    assert.equal(decidirVerificacao(item, [{ destino: "youtube_shorts", status: "publicado", fonte: "yt" }], T_DIA).publicado, false);
  });
});

describe("itensVerificaveis / corteDirDoItem", () => {
  it("só itens agendado de peça com corte conhecido", () => {
    assert.equal(itensVerificaveis(bancoAgendado(["youtube_shorts"], "pronto")).length, 0);
    const b = bancoAgendado(["youtube_shorts"]);
    assert.equal(itensVerificaveis(b).length, 1);
    assert.equal(itensVerificaveis(b, "outro").length, 0);
    assert.equal(corteDirDoItem(b.itens[0]), "data/cortes/guia-261111");
  });
});

describe("lerDestinosDoItem", () => {
  it("registro published sem leitor fica sem-leitor; destino sem entrada fica sem-registro (#573)", async () => {
    const root = rootComCorte([igEntry]);
    try {
      const item = bancoAgendado(["instagram", "youtube_shorts"]).itens[0];
      const l = await lerDestinosDoItem(item, { root, now: T_DIA, leitores: {} });
      assert.deepEqual(
        l.map((x) => [x.destino, x.status]),
        [
          ["instagram", "sem-leitor"],
          ["youtube_shorts", "sem-registro"],
        ],
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("corte ausente vira erro em todos os destinos; leitor que lança vira erro", async () => {
    const vazio = rootComCorte([], { semCorte: true });
    const root = rootComCorte([ytEntry]);
    try {
      const item = bancoAgendado(["youtube_shorts"]).itens[0];
      const a = await lerDestinosDoItem(item, { root: vazio, now: T_DIA, leitores: { youtube_shorts: leitorPublicado } });
      assert.equal(a[0].status, "erro");
      const b = await lerDestinosDoItem(item, {
        root,
        now: T_DIA,
        leitores: {
          youtube_shorts: async () => {
            throw new Error("rede caiu");
          },
        },
      });
      assert.deepEqual([b[0].status, "motivo" in b[0] ? b[0].motivo : ""], ["erro", "rede caiu"]);
    } finally {
      rmSync(vazio, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("youtubeShortsLeitor", () => {
  const env = { GOOGLE_CLIENT_ID: "c", GOOGLE_CLIENT_SECRET: "s", YOUTUBE_REFRESH_TOKEN: "r", YOUTUBE_CHANNEL_ID: "UC1" };

  function fakeFetch(status: Record<string, unknown> | null) {
    const calls: Array<{ url: string; method: string }> = [];
    const fetch = async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method ?? "GET" });
      if (url === GOOGLE_TOKEN_ENDPOINT) return new Response(JSON.stringify({ access_token: "tok" }), { status: 200 });
      return new Response(JSON.stringify({ items: status ? [{ id: VIDEO_ID, status }] : [] }), { status: 200 });
    };
    return { fetch, calls };
  }

  const item = bancoAgendado(["youtube_shorts"]).itens[0];
  const entry = ytEntry as never;

  it("vídeo public relido → publicado, e só lê (o único POST é a troca do token)", async () => {
    const f = fakeFetch({ privacyStatus: "public", uploadStatus: "processed" });
    const l = await youtubeShortsLeitor({ deps: { fetch: f.fetch, now: () => T_DIA }, env })({ item, destino: "youtube_shorts", entry });
    assert.deepEqual(l, { destino: "youtube_shorts", status: "publicado", fonte: YOUTUBE_LEITURA_FONTE, url: `https://youtube.com/shorts/${VIDEO_ID}` });
    assert.deepEqual(
      f.calls.filter((c) => c.method !== "GET").map((c) => c.url),
      [GOOGLE_TOKEN_ENDPOINT],
    );
    assert.ok(f.calls.some((c) => c.url.includes(`/videos?part=status&id=${VIDEO_ID}`)));
  });

  it("ainda agendado (private + publishAt futuro) → nao-publicado", async () => {
    const f = fakeFetch({ privacyStatus: "private", publishAt: "2026-11-19T15:00:00Z", uploadStatus: "processed" });
    const l = await youtubeShortsLeitor({ deps: { fetch: f.fetch, now: () => T_DIA }, env })({ item, destino: "youtube_shorts", entry });
    assert.equal(l.status, "nao-publicado");
  });

  it("id de --mark (URL) é aceito; send_unknown sem id de vídeo não confirma; sem credencial é erro", async () => {
    const f = fakeFetch({ privacyStatus: "public" });
    const leitor = youtubeShortsLeitor({ deps: { fetch: f.fetch, now: () => T_DIA }, env });
    const mark = { ...ytEntry, id: `https://youtube.com/shorts/${VIDEO_ID}`, url: undefined } as never;
    assert.equal((await leitor({ item, destino: "youtube_shorts", entry: mark })).status, "publicado");
    const unknown = { destination: "youtube_shorts", status: "send_unknown", id: "send_unknown-2026-11-18T15:00:00Z", at: T0.toISOString() } as never;
    assert.equal((await leitor({ item, destino: "youtube_shorts", entry: unknown })).status, "nao-publicado");
    const semCred = youtubeShortsLeitor({ deps: { fetch: f.fetch, now: () => T_DIA }, env: {} });
    assert.equal((await semCred({ item, destino: "youtube_shorts", entry })).status, "erro");
    const sumiu = youtubeShortsLeitor({ deps: { fetch: fakeFetch(null).fetch, now: () => T_DIA }, env });
    assert.equal((await sumiu({ item, destino: "youtube_shorts", entry })).status, "erro");
  });
});

describe("CLI verificar", () => {
  function setup(destinos: string[], entries: Array<Record<string, unknown>>): string {
    const root = rootComCorte(entries);
    saveAgendamentos(agendamentosPath(root), bancoAgendado(destinos));
    return root;
  }

  it("todos os destinos relidos no ar → grava publicado com a verificacao", async () => {
    const root = setup(["youtube_shorts"], [ytEntry]);
    try {
      const t = io(root);
      assert.equal(await runVerificarCli([], t.io, { youtube_shorts: leitorPublicado }), 0);
      const it = lerBanco(root).itens[0];
      assert.equal(it.estado, "publicado");
      assert.match(it.verificacao?.fonte ?? "", /youtube_shorts=fake/);
      assert.equal(it.verificacao?.url, "https://example.test/v");
      assert.equal(it.historico.at(-1)?.para, "publicado");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("regressão #573: registro published + destino sem leitor nunca vira publicado", async () => {
    const root = setup(["youtube_shorts", "instagram"], [ytEntry, igEntry]);
    try {
      const t = io(root);
      assert.equal(await runVerificarCli([], t.io, { youtube_shorts: leitorPublicado }), 0);
      assert.equal(lerBanco(root).itens[0].estado, "agendado");
      assert.ok(t.out.some((l) => /instagram\s+sem-leitor/.test(l)), t.out.join("\n"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("--dry-run relê sem gravar; leitura com erro sai 2", async () => {
    const root = setup(["youtube_shorts"], [ytEntry]);
    try {
      const antes = readFileSync(agendamentosPath(root), "utf8");
      assert.equal(await runVerificarCli(["--dry-run"], io(root).io, { youtube_shorts: leitorPublicado }), 0);
      assert.equal(readFileSync(agendamentosPath(root), "utf8"), antes);
      const erro: LeitorDestino = async ({ destino }) => ({ destino, status: "erro", motivo: "x" });
      assert.equal(await runVerificarCli([], io(root).io, { youtube_shorts: erro }), 2);
      assert.equal(lerBanco(root).itens[0].estado, "agendado");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("--id inexistente sai 1; o CLI síncrono recusa verificar", async () => {
    const root = setup(["youtube_shorts"], [ytEntry]);
    try {
      assert.equal(await runVerificarCli(["--id", "261111-outro"], io(root).io, {}), 1);
      assert.equal(runAgendamentosCli(["verificar"], io(root).io), 1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});


describe("verificação automática do tick (#12774)", () => {
  it("persiste confirmação e entrega o banco atualizado ao alarme; segundo tick é idempotente", async () => {
    const root = rootComCorte([ytEntry]);
    try {
      saveAgendamentos(agendamentosPath(root), bancoAgendado(["youtube_shorts"]));
      let chamadas = 0;
      const leitores = { youtube_shorts: async (ctx: Parameters<LeitorDestino>[0]) => {
        chamadas++;
        return leitorPublicado(ctx);
      } };
      const primeiro = await verificarBancoDoTick(io(root).io, false, leitores);
      assert.equal(primeiro.code, 0);
      assert.equal(primeiro.banco.itens[0].estado, "publicado");
      assert.match(primeiro.banco.itens[0].verificacao!.fonte, /youtube_shorts=fake/);
      assert.deepEqual(primeiro.banco, lerBanco(root));
      const segundo = await verificarBancoDoTick(io(root).io, false, leitores);
      assert.deepEqual(segundo.banco, primeiro.banco);
      assert.equal(chamadas, 1);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("dry-run confirma sem alterar um byte do banco e avalia o mesmo banco da execução real (#12970)", async () => {
    const root = rootComCorte([ytEntry]);
    try {
      saveAgendamentos(agendamentosPath(root), bancoAgendado(["youtube_shorts"]));
      const antes = readFileSync(agendamentosPath(root), "utf8");
      const resultado = await verificarBancoDoTick(io(root).io, true, { youtube_shorts: leitorPublicado });
      // Antes do #12970 o dry-run relia o disco (ainda `agendado`) e alarmava o que a execução real não alarma.
      assert.equal(resultado.banco.itens[0].estado, "publicado");
      assert.equal(readFileSync(agendamentosPath(root), "utf8"), antes);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("corrida: outra sessão grava no meio (revisão mudou) → relê e grava na 2ª tentativa (#12970)", async () => {
    const root = rootComCorte([ytEntry]);
    try {
      saveAgendamentos(agendamentosPath(root), bancoAgendado(["youtube_shorts"]));
      let chamadas = 0;
      const save = (path: string, banco: AgendamentosBanco) => {
        chamadas++;
        if (chamadas === 1) {
          // A sessão do Neo grava entre a releitura do tick e a gravação dele.
          const outro = JSON.parse(readFileSync(path, "utf8")) as AgendamentosBanco;
          saveAgendamentos(path, outro);
          return saveAgendamentos(path, banco);
        }
        return saveAgendamentos(path, banco);
      };
      const t = io(root);
      const resultado = await verificarBancoDoTick(t.io, false, { youtube_shorts: leitorPublicado }, { save });
      assert.equal(chamadas, 2);
      assert.equal(resultado.code, 0);
      assert.equal(resultado.banco.itens[0].estado, "publicado");
      assert.equal(lerBanco(root).itens[0].estado, "publicado");
      assert.ok(t.err.some((l) => /gravação 1\/2 recusada/.test(l)), t.err.join("\n"));
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("corrida que não passa: avalia com o banco em memória (alarme não é pulado) e sai 1 (#12970)", async () => {
    const root = rootComCorte([ytEntry]);
    try {
      saveAgendamentos(agendamentosPath(root), bancoAgendado(["youtube_shorts"]));
      const save = (): AgendamentosBanco => {
        throw new Error("banco mudou desde a leitura (revisão em disco 9, lida 1) — releia e repita");
      };
      const t = io(root);
      const resultado = await verificarBancoDoTick(t.io, false, { youtube_shorts: leitorPublicado }, { save });
      assert.equal(resultado.code, 1);
      assert.equal(resultado.banco.itens[0].estado, "publicado");
      assert.equal(lerBanco(root).itens[0].estado, "agendado");
      assert.ok(t.err.some((l) => /avalia o banco em memória/.test(l)), t.err.join("\n"));
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  for (const caso of ["sem-leitor", "nao-publicado", "erro"] as const) {
    it(`preserva agendado com destino ${caso}, mesmo com envio local published`, async () => {
      const root = rootComCorte([igEntry]);
      try {
        saveAgendamentos(agendamentosPath(root), bancoAgendado(["instagram"]));
        const leitores: Record<string, LeitorDestino> = caso === "sem-leitor" ? {} : {
          instagram: async ({ destino }) => ({ destino, status: caso, motivo: "não confirmado" }),
        };
        const resultado = await verificarBancoDoTick(io(root).io, false, leitores);
        assert.equal(resultado.code, caso === "erro" ? 2 : 0);
        assert.equal(resultado.banco.itens[0].estado, "agendado");
      } finally { rmSync(root, { recursive: true, force: true }); }
    });
  }

  it("banco ilegível interrompe a avaliação", async () => {
    const root = rootComCorte([]);
    try {
      saveAgendamentos(agendamentosPath(root), bancoAgendado(["youtube_shorts"]));
      writeFileSync(agendamentosPath(root), "{quebrado");
      await assert.rejects(verificarBancoDoTick(io(root).io, false, {}), /avaliação interrompida/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
