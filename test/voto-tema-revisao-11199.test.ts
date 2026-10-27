/**
 * test/voto-tema-revisao-11199.test.ts (#11199)
 *
 * O rascunho do e-mail da votação de tema só vai pro Kit depois de a cédula
 * passar por Humanizador + Clarice. Guard mecânico: marcador `revisado` em
 * `ballot.json`, com hash do texto da cédula; qualquer edição posterior (ou
 * cédula do KV diferente da revisada) faz `publish-voto-tema-kit.ts --push`
 * recusar. Sem Kit/KV real: só arquivos temporários.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  buildRevisaoMarker,
  cedulaTextoHash,
  checkRevisao,
  type CedulaTexto,
} from "../scripts/lib/voto-tema-revisao.ts";
import { checkCedulaRevisada } from "../scripts/publish-voto-tema-kit.ts";
import { marcarRevisado } from "../scripts/voto-tema-marcar-revisado.ts";
import { VotoTemaGuardError } from "../scripts/lib/voto-tema-channel.ts";

const CEDULA: CedulaTexto = {
  titulo: "Qual tema você quer no próximo Artigo Especial?",
  prazo: "2099-01-01T09:00:00-03:00",
  opcoes: [
    { n: 1, titulo: "Tema A", descricao: "Descrição A" },
    { n: 2, titulo: "Tema B", descricao: "Descrição B", proponente: "Fulana" },
  ],
};
const NOW = new Date("2026-10-27T12:00:00Z");

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

function withDataDir(fn: (dataDir: string, ballotPath: string) => void): void {
  const dataDir = mkdtempSync(join(tmpdir(), "voto-tema-revisao-"));
  try {
    const dir = join(dataDir, "artigo-especial", "votacao", "2611");
    mkdirSync(dir, { recursive: true });
    fn(dataDir, join(dir, "ballot.json"));
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
}

describe("cedulaTextoHash", () => {
  it("muda quando muda qualquer texto que chega ao leitor", () => {
    const base = cedulaTextoHash(CEDULA);
    const variantes: CedulaTexto[] = [
      { ...clone(CEDULA), titulo: CEDULA.titulo + " " },
      { ...clone(CEDULA), prazo: "2099-01-02T09:00:00-03:00" },
      (() => { const c = clone(CEDULA); c.opcoes[0].descricao = "Descrição A revisada"; return c; })(),
      (() => { const c = clone(CEDULA); c.opcoes[1].titulo = "Tema B2"; return c; })(),
      (() => { const c = clone(CEDULA); delete c.opcoes[1].proponente; return c; })(),
      (() => { const c = clone(CEDULA); c.opcoes.reverse(); return c; })(),
    ];
    for (const v of variantes) assert.notEqual(cedulaTextoHash(v), base, JSON.stringify(v));
  });

  it("ignora campos que não viram texto (eleitores, aberta_em, revisado) e a ordem das chaves", () => {
    const comExtras = {
      opcoes: CEDULA.opcoes.map((o) => ({ descricao: o.descricao, titulo: o.titulo, n: o.n, ...(o.proponente ? { proponente: o.proponente } : {}) })),
      prazo: CEDULA.prazo,
      titulo: CEDULA.titulo,
      eleitores: ["abc"],
      aberta_em: "2026-10-26T10:00:00Z",
      revisado: { humanizador: true },
    };
    assert.equal(cedulaTextoHash(comExtras), cedulaTextoHash(CEDULA));
  });
});

describe("checkRevisao", () => {
  const marker = buildRevisaoMarker(CEDULA, NOW);

  it("aceita marcador íntegro com cédula local e do KV iguais à revisada", () => {
    const r = checkRevisao({ ...clone(CEDULA), revisado: marker }, clone(CEDULA));
    assert.equal(r.ok, true);
  });

  it("recusa ballot.json ausente ou sem marcador", () => {
    assert.equal(checkRevisao(null, CEDULA).ok, false);
    const r = checkRevisao(clone(CEDULA), CEDULA);
    assert.equal(r.ok, false);
    assert.match(!r.ok ? r.reason : "", /sem marcador "revisado"/);
  });

  it("recusa marcador sem uma das passadas", () => {
    for (const parcial of [
      { ...marker, humanizador: false },
      { ...marker, clarice: undefined },
      { ...marker, em: "ontem" },
      { ...marker, hash: "x" },
    ]) {
      const r = checkRevisao({ ...clone(CEDULA), revisado: parcial }, CEDULA);
      assert.equal(r.ok, false, JSON.stringify(parcial));
      assert.match(!r.ok ? r.reason : "", /marcador "revisado" inválido/);
    }
  });

  it("recusa cédula editada depois da revisão (cenário do ciclo 2611)", () => {
    const editada = clone(CEDULA);
    editada.opcoes[0].descricao = "Texto novo, nunca revisado";
    const r = checkRevisao({ ...editada, revisado: marker }, editada);
    assert.equal(r.ok, false);
    assert.match(!r.ok ? r.reason : "", /mudou depois da revisão/);
  });

  it("recusa quando o KV guarda texto diferente do revisado (revisão feita depois do abrir)", () => {
    const kvAntigo = clone(CEDULA);
    kvAntigo.opcoes[1].descricao = "Versão crua que foi pro KV";
    const r = checkRevisao({ ...clone(CEDULA), revisado: marker }, kvAntigo);
    assert.equal(r.ok, false);
    assert.match(!r.ok ? r.reason : "", /voto-tema-open\.ts --ciclo AAMM --push --force/);
  });
});

describe("checkCedulaRevisada (publish-voto-tema-kit.ts)", () => {
  it("lê ballot.json do ciclo e confere contra a cédula do KV", () => {
    withDataDir((dataDir, ballotPath) => {
      assert.equal(checkCedulaRevisada(dataDir, "2611", CEDULA).ok, false, "sem ballot.json");
      writeFileSync(ballotPath, JSON.stringify(CEDULA));
      assert.equal(checkCedulaRevisada(dataDir, "2611", CEDULA).ok, false, "sem marcador");
      writeFileSync(ballotPath, JSON.stringify({ ...CEDULA, revisado: buildRevisaoMarker(CEDULA, NOW) }));
      assert.equal(checkCedulaRevisada(dataDir, "2611", CEDULA).ok, true);
    });
  });

  it("o guard roda no run() antes de qualquer createBroadcast do rascunho real e recusa no --push", () => {
    const src = readFileSync(resolve(import.meta.dirname, "../scripts/publish-voto-tema-kit.ts"), "utf8");
    const runBody = src.slice(src.indexOf("export async function run("));
    const testSendEnd = runBody.indexOf("const platformConfig");
    const guardIdx = runBody.indexOf("checkCedulaRevisada(dataDir, ciclo, ballot)");
    const createIdx = runBody.indexOf("await createBroadcast(");
    assert.ok(guardIdx > testSendEnd, "guard fica fora do ramo --test-send");
    assert.ok(guardIdx > 0 && guardIdx < createIdx, "guard precisa vir antes do createBroadcast");
    assert.match(runBody.slice(guardIdx, createIdx), /if \(!dryRun\) throw new VotoTemaGuardError/);
  });
});

describe("voto-tema-marcar-revisado.ts", () => {
  const base = { ciclo: "2611", now: NOW, log: () => {} };

  it("exige as duas flags e grava marcador que o publish aceita", () => {
    withDataDir((dataDir, ballotPath) => {
      writeFileSync(ballotPath, JSON.stringify(CEDULA));
      assert.throws(
        () => marcarRevisado({ ...base, dataDir, humanizador: true, clarice: false, checkOnly: false }),
        (e: unknown) => e instanceof VotoTemaGuardError && /--humanizador E --clarice/.test((e as Error).message),
      );
      assert.equal(JSON.parse(readFileSync(ballotPath, "utf8")).revisado, undefined, "nada gravado sem as duas flags");

      marcarRevisado({ ...base, dataDir, humanizador: true, clarice: true, checkOnly: false });
      const gravado = JSON.parse(readFileSync(ballotPath, "utf8"));
      assert.equal(gravado.revisado.humanizador, true);
      assert.equal(gravado.revisado.clarice, true);
      assert.equal(gravado.revisado.em, NOW.toISOString());
      assert.deepEqual({ ...gravado, revisado: undefined }, { ...CEDULA, revisado: undefined }, "texto da cédula intacto");
      assert.equal(checkCedulaRevisada(dataDir, "2611", CEDULA).ok, true);
      marcarRevisado({ ...base, dataDir, humanizador: false, clarice: false, checkOnly: true });
    });
  });

  it("--check falha depois de editar a cédula revisada", () => {
    withDataDir((dataDir, ballotPath) => {
      writeFileSync(ballotPath, JSON.stringify(CEDULA));
      marcarRevisado({ ...base, dataDir, humanizador: true, clarice: true, checkOnly: false });
      const gravado = JSON.parse(readFileSync(ballotPath, "utf8"));
      gravado.titulo = "Título editado depois";
      writeFileSync(ballotPath, JSON.stringify(gravado));
      assert.throws(
        () => marcarRevisado({ ...base, dataDir, humanizador: false, clarice: false, checkOnly: true }),
        /mudou depois da revisão/,
      );
    });
  });

  it("recusa cédula inválida (sem prazo)", () => {
    withDataDir((dataDir, ballotPath) => {
      const { prazo: _p, ...semPrazo } = CEDULA;
      writeFileSync(ballotPath, JSON.stringify(semPrazo));
      assert.throws(
        () => marcarRevisado({ ...base, dataDir, humanizador: true, clarice: true, checkOnly: false }),
        /cédula inválida/,
      );
    });
  });
});
