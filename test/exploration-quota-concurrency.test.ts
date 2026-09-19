/**
 * #8407 — o lock de `exploration-quota` cobria só a ESCRITA.
 *
 * `writeExplorationState` envolvia apenas o `writeFileAtomic` no
 * `withFileLock`, mas o ciclo real é read→decide→write e a leitura acontecia
 * no chamador (`assemble-scored.ts`), fora do lock. Duas execuções na mesma
 * semana ISO com `data/` compartilhado (OneDrive entre as máquinas do
 * projeto) liam o mesmo snapshot e a segunda gravação apagava o registro da
 * primeira — `countWeekUsage` passava a subestimar o consumo da semana.
 *
 * Os testes aqui rodam DOIS PROCESSOS de verdade sobre o mesmo arquivo: é a
 * única forma de reproduzir a intercalação (o lock é síncrono, então não há
 * como intercalar duas seções críticas dentro do mesmo processo).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  readExplorationState,
  writeExplorationState,
  withExplorationStateLock,
  recordExplorationDecision,
  emptyExplorationState,
  countWeekUsage,
} from "../scripts/lib/exploration-quota.ts";

const ROOT = resolve(import.meta.dirname, "..");
const CHILD = resolve(ROOT, "test/fixtures/exploration-quota-concurrent-child.ts");

/** Janela artificial entre leitura e escrita nos filhos, em ms. */
const WINDOW_MS = 600;

function withTmpDir<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(resolve(tmpdir(), "exploration-concurrency-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Variante assíncrona: `withTmpDir` com um callback `async` apagaria o
 * diretório assim que a promessa fosse CRIADA, não quando ela resolvesse —
 * os filhos encontrariam `data/` ausente e nada seria gravado.
 */
async function withTmpDirAsync<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(resolve(tmpdir(), "exploration-concurrency-"));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Dispara os dois filhos com a mesma barreira de início e espera os dois. */
function runConcurrentEditions(statePath: string, editions: [string, string]): Promise<void> {
  const startAt = Date.now() + 1_000;
  const children = editions.map(
    (edition) =>
      new Promise<void>((done, fail) => {
        const child = spawn(
          process.execPath,
          [
            "--import",
            "tsx",
            CHILD,
            "--state-path",
            statePath,
            "--edition",
            edition,
            "--start-at",
            String(startAt),
            "--delay-ms",
            String(WINDOW_MS),
          ],
          { cwd: ROOT, stdio: ["ignore", "ignore", "pipe"] },
        );
        let stderr = "";
        child.stderr.on("data", (chunk) => (stderr += String(chunk)));
        child.on("error", fail);
        child.on("exit", (code) =>
          code === 0 ? done() : fail(new Error(`filho ${edition} saiu ${code}: ${stderr}`)),
        );
      }),
  );
  return Promise.all(children).then(() => undefined);
}

describe("cota de exploração sob concorrência real (#8407)", () => {
  it("duas edições da mesma semana ISO em processos concorrentes: nenhum registro se perde", async () => {
    await withTmpDirAsync(async (dir) => {
      const statePath = resolve(dir, "exploration-quota.json");

      // 260919 (sex) e 260920 (sáb) caem ambas na 2026-W38 — é a semana que
      // pode estourar a cota se um dos registros sumir.
      await runConcurrentEditions(statePath, ["260919", "260920"]);

      const { state, corrupted } = readExplorationState(statePath);
      assert.equal(corrupted, false, "arquivo final tem que ser JSON íntegro");
      assert.deepEqual(
        Object.keys(state.editions).sort(),
        ["260919", "260920"],
        "as duas edições têm que sobreviver — a implementação antiga perdia a primeira gravada",
      );
      // Sem os dois registros, a semana pareceria ter consumido 1 slot quando
      // consumiu 2 — é a subcontagem que deixa a cota de 4/semana estourar.
      assert.equal(countWeekUsage(state, "2026-W38"), 2);
    });
  });

  /**
   * Prova que o harness acima de fato produz a corrida: a FORMA ANTIGA
   * (`readExplorationState` fora do lock + `writeExplorationState` depois)
   * perde um registro com a mesma intercalação. Sem esta asserção, o teste
   * acima passaria mesmo num mundo onde a janela nunca se sobrepõe — e não
   * discriminaria nada (#633).
   */
  it("a forma antiga (read fora do lock + write) perde o registro concorrente", () => {
    withTmpDir((dir) => {
      const statePath = resolve(dir, "exploration-quota.json");
      const record = (week: string) =>
        ({ week, exploracao: false, decided_at: "2026-09-19T00:00:00.000Z" }) as const;

      // Processo A lê o estado (vazio)…
      const snapshotA = readExplorationState(statePath).state;
      // …processo B faz o ciclo inteiro dele e grava…
      writeExplorationState(
        statePath,
        recordExplorationDecision(readExplorationState(statePath).state, "260920", record("2026-W38")),
      );
      // …e A grava em cima do snapshot velho.
      writeExplorationState(statePath, recordExplorationDecision(snapshotA, "260919", record("2026-W38")));

      assert.deepEqual(
        Object.keys(readExplorationState(statePath).state.editions),
        ["260919"],
        "a forma antiga apaga o registro de B — é exatamente o defeito da #8407",
      );
    });
  });

  it("withExplorationStateLock relê de dentro da seção crítica, então o mesmo roteiro não perde nada", () => {
    withTmpDir((dir) => {
      const statePath = resolve(dir, "exploration-quota.json");
      const record = (week: string) =>
        ({ week, exploracao: false, decided_at: "2026-09-19T00:00:00.000Z" }) as const;

      const commit = (edition: string) =>
        withExplorationStateLock(statePath, (read) => ({
          next: recordExplorationDecision(read.state, edition, record("2026-W38")),
          value: null,
        }));

      // Mesmo roteiro do teste anterior, com a diferença que importa: não há
      // como o chamador segurar um snapshot antigo — a leitura é da função.
      commit("260920");
      commit("260919");

      assert.deepEqual(Object.keys(readExplorationState(statePath).state.editions).sort(), [
        "260919",
        "260920",
      ]);
    });
  });
});

describe("withExplorationStateLock — degradações preservadas (#8407)", () => {
  it("diretório ausente (worktree isolado/clone fresco): não lança, não persiste, e a decisão ainda roda", () => {
    withTmpDir((dir) => {
      const statePath = resolve(dir, "sem-data", "exploration-quota.json");
      let mutouCom: boolean | undefined;

      const out = withExplorationStateLock(statePath, (read) => {
        mutouCom = read.corrupted;
        return {
          next: recordExplorationDecision(read.state, "260919", {
            week: "2026-W38",
            exploracao: false,
            decided_at: "2026-09-19T00:00:00.000Z",
          }),
          value: "decidiu",
        };
      });

      assert.equal(out.persisted, false);
      assert.equal(out.reason, "no-data-dir");
      assert.equal(out.value, "decidiu", "a decisão da edição vale mesmo sem data/");
      assert.equal(mutouCom, false);
      // Nem arquivo nem lock ficaram pra trás num diretório que não existe.
      assert.equal(readExplorationState(statePath).state.editions["260919"], undefined);
    });
  });

  it("arquivo corrompido: o mutador vê `corrupted` e pode recusar a escrita (o arquivo fica intacto)", () => {
    withTmpDir((dir) => {
      const statePath = resolve(dir, "exploration-quota.json");
      writeFileSync(statePath, "{ arquivo pela metade", "utf8");

      const out = withExplorationStateLock(statePath, (read) => {
        assert.equal(read.corrupted, true);
        assert.deepEqual(read.state, emptyExplorationState());
        return { next: null, value: "pulou" };
      });

      assert.equal(out.persisted, false);
      assert.equal(out.reason, "mutator-declined");
      assert.equal(out.value, "pulou");
      // Regravar apagaria o registro das outras edições da semana (#8398).
      assert.equal(readExplorationState(statePath).corrupted, true);
    });
  });

  it("o lock é liberado mesmo quando o mutador lança", () => {
    withTmpDir((dir) => {
      const statePath = resolve(dir, "exploration-quota.json");
      assert.throws(
        () =>
          withExplorationStateLock(statePath, () => {
            throw new Error("boom");
          }),
        /boom/,
      );
      // Se o `.lock` tivesse vazado, esta chamada giraria até o timeout.
      const out = withExplorationStateLock(statePath, (read) => ({
        next: recordExplorationDecision(read.state, "260919", {
          week: "2026-W38",
          exploracao: false,
          decided_at: "2026-09-19T00:00:00.000Z",
        }),
        value: null,
      }));
      assert.equal(out.persisted, true);
    });
  });
});

/** Sanidade: o filho existe e roda sozinho (erro de import aqui vira flake lá). */
describe("fixture do teste de concorrência", () => {
  it("o filho roda isolado e registra a edição", () => {
    withTmpDir((dir) => {
      const statePath = resolve(dir, "exploration-quota.json");
      const res = spawnSync(
        process.execPath,
        [
          "--import",
          "tsx",
          CHILD,
          "--state-path",
          statePath,
          "--edition",
          "260919",
          "--start-at",
          "0",
          "--delay-ms",
          "0",
        ],
        { cwd: ROOT, encoding: "utf8" },
      );
      assert.equal(res.status, 0, res.stderr);
      assert.ok(readExplorationState(statePath).state.editions["260919"]);
    });
  });
});
