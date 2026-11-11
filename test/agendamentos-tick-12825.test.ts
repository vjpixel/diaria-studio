/**
 * test/agendamentos-tick-12825.test.ts (#12825)
 *
 * Regressão: o tick do banco de agendamentos alarmava todo vertical 2 enviado
 * certo, porque destino sem leitor (Instagram, TikTok, ...) deixa o item
 * `agendado` para sempre e o `agendado` vencido virava `vencido-sem-publicacao`.
 * Decisão do editor (opção a): `agendado` cujos destinos sem leitor têm
 * registro de envio não alarma; faltando registro, o alarme fica.
 * Diretório temporário e leitores falsos: nenhuma rede, nunca o `data/` real.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addAgendamento,
  avaliarAgendamentos,
  emptyBanco,
  transicionarAgendamento,
  type AgendamentoEstado,
  type AgendamentosBanco,
} from "../scripts/lib/diaria/agendamentos.ts";
import {
  avaliarAgendamentosComEnvio,
  envioRegistradoSemAlarme,
  lerDestinosDoItem,
  type LeitorDestino,
} from "../scripts/lib/diaria/agendamentos-verificar.ts";

const T0 = new Date("2026-11-11T15:00:00Z");
const ALVO = "2026-11-18T15:00:00.000Z";
/** Alvo + 2h: passado a folga de 60 min. */
const VENCIDO = new Date("2026-11-18T17:00:00Z");
const VIDEO_ID = "abcDEF12345";
const DESTINOS = ["youtube_shorts", "instagram", "tiktok"];

function banco(estado: AgendamentoEstado = "agendado", destinos = DESTINOS): AgendamentosBanco {
  const { banco: b } = addAgendamento(
    emptyBanco(),
    { edicao: "261111", peca: "vertical-2", destinos, alvo: ALVO, dono: "/diaria-publica 261118", estado: "pronto" },
    T0,
  );
  return estado === "pronto" ? b : transicionarAgendamento(b, { id: "261111-vertical-2", para: estado }, T0);
}

function rootComCorte(entries: Array<Record<string, unknown>>): string {
  const root = mkdtempSync(join(tmpdir(), "agendamentos-tick-12825-"));
  const dir = join(root, "data", "cortes", "guia-261111");
  mkdirSync(join(dir, "_internal"), { recursive: true });
  writeFileSync(
    join(dir, "corte.json"),
    JSON.stringify({ slug: "guia-261111", date: "261118", hhmm: "12:00", title: "O guia", hook: "Gancho.", video: "corte-guia-261111.mp4" }),
  );
  writeFileSync(join(dir, "_internal", "06-shorts-published.json"), JSON.stringify({ aammdd: "261118", entries }));
  return root;
}

const at = T0.toISOString();
const yt = { destination: "youtube_shorts", status: "scheduled", id: VIDEO_ID, scheduled_at: ALVO, at };
const ig = { destination: "instagram", status: "published", id: "17890000000000000", at };
const tk = { destination: "tiktok", status: "scheduled", id: "buffer-1", scheduled_at: ALVO, at };

const ytNoAr: LeitorDestino = async ({ destino }) => ({ destino, status: "publicado", fonte: "fake yt" });
const ytPrivado: LeitorDestino = async ({ destino }) => ({ destino, status: "nao-publicado", motivo: "privado" });
const ytErro: LeitorDestino = async ({ destino }) => ({ destino, status: "erro", motivo: "faltam credenciais" });

describe("avaliarAgendamentosComEnvio (#12825)", () => {
  it("regressão: agendado vencido com envio registrado em todos os destinos sem leitor não alarma", async () => {
    const b = banco();
    // O comportamento antigo: sem a releitura, o mesmo item vira achado.
    assert.equal(avaliarAgendamentos(b, VENCIDO).achados.length, 1);
    const { avaliacao, envios } = await avaliarAgendamentosComEnvio(b, {
      root: rootComCorte([yt, ig, tk]),
      now: VENCIDO,
      leitores: { youtube_shorts: ytNoAr },
    });
    assert.equal(avaliacao.achados.length, 0);
    assert.deepEqual(avaliacao.semAlarme.map((it) => it.id), ["261111-vertical-2"]);
    assert.equal(envios.length, 1);
    assert.equal(envios[0].semAlarme, true);
  });

  it("falta registro de envio de um destino: alarme preservado", async () => {
    const { avaliacao } = await avaliarAgendamentosComEnvio(banco(), {
      root: rootComCorte([yt, ig]),
      now: VENCIDO,
      leitores: { youtube_shorts: ytNoAr },
    });
    assert.equal(avaliacao.achados.length, 1);
    assert.equal(avaliacao.achados[0].tipo, "vencido-sem-publicacao");
    assert.equal(avaliacao.semAlarme.length, 0);
  });

  it("corte sem registro nenhum nesta máquina: alarme preservado", async () => {
    const root = mkdtempSync(join(tmpdir(), "agendamentos-tick-12825-vazio-"));
    const { avaliacao } = await avaliarAgendamentosComEnvio(banco(), { root, now: VENCIDO, leitores: { youtube_shorts: ytNoAr } });
    assert.equal(avaliacao.achados.length, 1);
  });

  it("send_unknown num destino sem leitor: alarme preservado (o envio pode não ter saído)", async () => {
    const { avaliacao } = await avaliarAgendamentosComEnvio(banco(), {
      root: rootComCorte([yt, ig, { ...tk, status: "send_unknown" }]),
      now: VENCIDO,
      leitores: { youtube_shorts: ytNoAr },
    });
    assert.equal(avaliacao.achados.length, 1);
  });

  it("destino com leitor que não confirma no ar (ou cuja leitura falha) mantém o alarme", async () => {
    for (const leitor of [ytPrivado, ytErro]) {
      const { avaliacao } = await avaliarAgendamentosComEnvio(banco(), {
        root: rootComCorte([yt, ig, tk]),
        now: VENCIDO,
        leitores: { youtube_shorts: leitor },
      });
      assert.equal(avaliacao.achados.length, 1);
    }
  });

  it("só agendado é dispensado: pronto vencido alarma mesmo com envio registrado", async () => {
    const { avaliacao, envios } = await avaliarAgendamentosComEnvio(banco("pronto"), {
      root: rootComCorte([yt, ig, tk]),
      now: VENCIDO,
      leitores: { youtube_shorts: ytNoAr },
    });
    assert.equal(avaliacao.achados.length, 1);
    assert.equal(envios.length, 0, "não relê a plataforma para item que não é agendado");
  });

  it("falhou continua achado; dentro da folga não relê a plataforma", async () => {
    const leituras: string[] = [];
    const contando: LeitorDestino = async (ctx) => {
      leituras.push(ctx.destino);
      return ytNoAr(ctx);
    };
    const dentroDaFolga = await avaliarAgendamentosComEnvio(banco(), {
      root: rootComCorte([yt, ig, tk]),
      now: new Date("2026-11-18T15:30:00Z"),
      leitores: { youtube_shorts: contando },
    });
    assert.equal(dentroDaFolga.avaliacao.achados.length, 0);
    assert.equal(leituras.length, 0);

    const falhou = await avaliarAgendamentosComEnvio(banco("falhou"), {
      root: rootComCorte([yt, ig, tk]),
      now: VENCIDO,
      leitores: { youtube_shorts: contando },
    });
    assert.equal(falhou.avaliacao.achados[0]?.tipo, "falhou");
  });
});

describe("envioRegistradoSemAlarme / sem-leitor carrega o status do envio", () => {
  it("lerDestinosDoItem anota o status do registro no sem-leitor", async () => {
    const item = banco().itens[0];
    const leituras = await lerDestinosDoItem(item, { root: rootComCorte([yt, ig, tk]), now: VENCIDO, leitores: {} });
    const igL = leituras.find((l) => l.destino === "instagram");
    assert.equal(igL?.status, "sem-leitor");
    assert.equal(igL?.status === "sem-leitor" ? igL.envio : undefined, "published");
  });

  it("destino sem leitura nenhuma não dispensa o alarme", () => {
    const item = banco().itens[0];
    assert.equal(
      envioRegistradoSemAlarme(item, [
        { destino: "youtube_shorts", status: "publicado", fonte: "yt" },
        { destino: "instagram", status: "sem-leitor", motivo: "x", envio: "published" },
      ]),
      false,
    );
    assert.equal(
      envioRegistradoSemAlarme(item, [
        { destino: "youtube_shorts", status: "publicado", fonte: "yt" },
        { destino: "instagram", status: "sem-leitor", motivo: "x", envio: "published" },
        { destino: "tiktok", status: "sem-leitor", motivo: "x", envio: "scheduled" },
      ]),
      true,
    );
  });
});
