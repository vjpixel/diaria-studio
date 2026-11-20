/**
 * test/agendamentos-13729-13736-13730.test.ts
 *
 * Regressões do banco de agendamentos (`scripts/agendamentos.ts`):
 *   #13729 — o vertical 2 registrado às 12:00 de D+7 colidia com o vertical 1
 *            da edição daquele dia útil, nos mesmos destinos.
 *   #13736 — `--dono "/diaria-publica …"` virava `C:/Program Files/Git/…` no
 *            Git Bash e era gravado sem aviso.
 *   #13730 — `estoque` listava a pasta de conflito do sync (`_conflitos-*`) como corte.
 *
 * CLI sempre contra um diretório temporário, nunca o `data/` real.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  addAgendamento,
  agendamentosPath,
  brtAlvoIso,
  donoConvertidoPeloMsys,
  emptyBanco,
  horarioLivreNoBanco,
  saveAgendamentos,
} from "../scripts/lib/diaria/agendamentos.ts";
import { pastaDeSyncNaoCorte } from "../scripts/lib/diaria/cortes-estoque.ts";
import { loadShortScheduleConfig } from "../scripts/lib/diaria/short-video.ts";
import { runAgendamentosCli } from "../scripts/agendamentos.ts";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const T0 = new Date("2026-11-19T15:00:00Z");
const REAL_CONFIG = JSON.parse(readFileSync(join(REPO, "platform.config.json"), "utf8"));
const SCHED = loadShortScheduleConfig(REAL_CONFIG);

function tmpRoot(withConfig = true): string {
  const root = mkdtempSync(join(tmpdir(), "agendamentos-13729-"));
  if (withConfig) copyFileSync(join(REPO, "platform.config.json"), join(root, "platform.config.json"));
  return root;
}

function run(root: string, argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = runAgendamentosCli(argv, { root, now: T0, out: (s) => out.push(s), err: (s) => err.push(s) });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

const banco = (root: string) => JSON.parse(readFileSync(agendamentosPath(root), "utf8"));

describe("#13729 horário do vertical 2 fora da vertical principal do dia", () => {
  const v2 = (edicao: string, extra: string[] = []) => [
    "registrar", "--edicao", edicao, "--peca", "vertical-2", "--destinos", "vertical",
    "--dias", "7", "--hora", "12:00", "--dono", "/diaria-publica x", ...extra,
  ];

  it("cenário da issue: 261116 + 7 = 261123 (segunda) às 12:00 vira o horário livre (08:00)", () => {
    const root = tmpRoot();
    try {
      const r = run(root, v2("261116"));
      assert.equal(r.code, 0, r.err);
      assert.match(r.out, /\[horário\] 12:00 de 261123 é da vertical principal de 261123: usa 08:00/);
      assert.equal(banco(root).itens[0].alvo, brtAlvoIso("261123", "08:00"));
      // Retomada com o mesmo comando: mesmo alvo, no-op.
      assert.match(run(root, v2("261116")).out, /já registrado/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("--hora-exata mantém 12:00", () => {
    const root = tmpRoot();
    try {
      const r = run(root, v2("261116", ["--hora-exata"]));
      assert.equal(r.code, 0, r.err);
      assert.equal(banco(root).itens[0].alvo, brtAlvoIso("261123", "12:00"));
      assert.doesNotMatch(r.out, /\[horário\]/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("horário livre já ocupado por outro item do banco nos mesmos destinos: fica o pedido, com aviso", () => {
    const root = tmpRoot();
    try {
      const destinos = ["youtube_shorts", "instagram"];
      const extra = addAgendamento(emptyBanco(), { edicao: "261120", peca: "corte-nvidia", destinos, alvo: brtAlvoIso("261123", "08:00"), dono: "modo corte" }, T0);
      mkdirSync(dirname(agendamentosPath(root)), { recursive: true });
      saveAgendamentos(agendamentosPath(root), extra.banco);
      const r = run(root, v2("261116"));
      assert.equal(r.code, 0, r.err);
      assert.match(r.err, /nenhum horário de rotation_times .* livre em 261123/);
      assert.match(r.err, /item 261120-corte-nvidia do banco/);
      assert.equal(banco(root).itens.find((it: { id: string }) => it.id === "261116-vertical-2").alvo, brtAlvoIso("261123", "12:00"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("pure: fim de semana não tem vertical principal; destinos disjuntos não colidem", () => {
    const base = { sched: SCHED, hhmm: "12:00", destinosVertical: ["youtube_shorts", "instagram"], banco: emptyBanco(), id: "x-vertical-2" };
    assert.equal(horarioLivreNoBanco({ ...base, aammdd: "261121", destinos: ["instagram"] }).ajustado, false);
    assert.equal(horarioLivreNoBanco({ ...base, aammdd: "261123", destinos: ["outro"] }).ajustado, false);
    const util = horarioLivreNoBanco({ ...base, aammdd: "261123", destinos: ["instagram"] });
    assert.deepEqual([util.hhmm, util.ajustado], ["08:00", true]);
    // 06:30 também é da principal (YouTube Shorts, #12250).
    assert.equal(horarioLivreNoBanco({ ...base, aammdd: "261123", hhmm: "06:30", destinos: ["youtube_shorts"] }).hhmm, "08:00");
  });

  it("sem platform.config.json: avisa e mantém o horário pedido", () => {
    const root = tmpRoot(false);
    try {
      const r = run(root, ["registrar", "--edicao", "261116", "--peca", "vertical-2", "--destinos", "instagram", "--dias", "7", "--dono", "d"]);
      assert.equal(r.code, 0, r.err);
      assert.match(r.err, /não conferido contra a vertical principal/);
      assert.equal(banco(root).itens[0].alvo, brtAlvoIso("261123", "12:00"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("#13736 dono convertido pelo Git Bash", () => {
  it("detecta a conversão e devolve o dono pretendido", () => {
    assert.equal(donoConvertidoPeloMsys("C:/Program Files/Git/diaria-publica 261123"), "/diaria-publica 261123");
    assert.equal(donoConvertidoPeloMsys("C:\\Program Files\\Git\\diaria-publica 261123"), "/diaria-publica 261123");
    assert.equal(donoConvertidoPeloMsys("D:/tools/diaria-publica 261123"), "/diaria-publica 261123");
    assert.equal(donoConvertidoPeloMsys("/diaria-publica 261123"), null);
    assert.equal(donoConvertidoPeloMsys("sessão /diaria-publica do dia"), null);
    assert.equal(donoConvertidoPeloMsys("modo corte nvidia-261110 (publish-shorts.ts --corte)"), null);
  });

  it("cenário da issue: registrar com o dono convertido sai 1, cita MSYS_NO_PATHCONV e não grava", () => {
    const root = tmpRoot();
    try {
      const r = run(root, [
        "registrar", "--edicao", "261116", "--peca", "vertical-2", "--destinos", "instagram",
        "--dias", "7", "--dono", "C:/Program Files/Git/diaria-publica 261123",
      ]);
      assert.equal(r.code, 1);
      assert.match(r.err, /MSYS_NO_PATHCONV=1/);
      assert.match(r.err, /"\/diaria-publica 261123"/);
      assert.match(run(root, ["listar"]).out, /nenhum item/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("#13730 estoque ignora pasta de conflito do sync", () => {
  it("pure: _/. no nome, ou sem corte.json e sem vídeo, não é corte", () => {
    assert.match(pastaDeSyncNaoCorte("_conflitos-261117", [".shorts-corte-timer-heartbeat.json.conflict1", "desktop.ini"]) ?? "", /começa com "_"/);
    assert.match(pastaDeSyncNaoCorte("lixo-261117", ["desktop.ini"]) ?? "", /sem corte.json e sem vídeo/);
    assert.equal(pastaDeSyncNaoCorte("nvidia-261110", ["video.mp4"]), null);
    assert.equal(pastaDeSyncNaoCorte("nvidia-261110", null), null);
  });

  it("cenário da issue: _conflitos-261117 sai do estoque e vai para a linha de lixo de sync", () => {
    const root = tmpRoot(false);
    try {
      const lixo = join(root, "data", "cortes", "_conflitos-261117");
      mkdirSync(lixo, { recursive: true });
      writeFileSync(join(lixo, ".shorts-corte-timer-heartbeat.json.conflict1"), "{}");
      writeFileSync(join(lixo, "desktop.ini"), "");
      const r = run(root, ["estoque"]);
      assert.equal(r.code, 0, r.err);
      assert.doesNotMatch(r.out, /_conflitos-261117/);
      assert.match(r.out, /nenhum corte pronto sem uso/);
      assert.match(r.err, /\[lixo de sync, fora do estoque\] data\/cortes\/_conflitos-261117/);
      assert.doesNotMatch(r.err, /corte\.json ausente/);
      const json = JSON.parse(run(root, ["estoque", "--json", "--todos"]).out);
      assert.equal(json.itens.length, 0);
      assert.equal(json.ignoradas.length, 1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
