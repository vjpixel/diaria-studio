/**
 * test/ci-test-shards-14003.test.ts (#14003)
 *
 * O `npm test` do CI roda em N jobs de matrix, e cada job roda só a fatia
 * que `scripts/run-tests.ts` escolhe pelo hash do caminho do arquivo. Este
 * arquivo trava as duas metades:
 *
 * 1. A partição (`parseShardSpec`, `shardOfPath`, `selectShardFiles`): sobre
 *    a lista REAL de arquivos de teste, as N fatias cobrem a suíte inteira,
 *    sem sobreposição, e a fatia de um arquivo não depende dos outros.
 * 2. O `ci.yml`: a lista da matrix vai de 1 a `RUN_TESTS_SHARD_TOTAL` sem
 *    buraco (um shard removido da lista deixaria 1/N dos testes sem rodar,
 *    com todos os checks verdes), e o check `test` que o gate de merge lê é
 *    um agregador que só sai verde com todos os shards `success`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { parseShardSpec, shardOfPath, selectShardFiles } from "../scripts/run-tests.ts";
import { listTestFiles } from "../scripts/assert-test-discovery.ts";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const CI_YML = readFileSync(resolve(ROOT, ".github", "workflows", "ci.yml"), "utf8");

describe("parseShardSpec (#14003)", () => {
  it("sem as duas variáveis: null (suíte inteira)", () => {
    assert.equal(parseShardSpec({}), null);
    assert.equal(parseShardSpec({ RUN_TESTS_SHARD_INDEX: "", RUN_TESTS_SHARD_TOTAL: " " }), null);
  });

  it("lê índice e total válidos", () => {
    assert.deepEqual(parseShardSpec({ RUN_TESTS_SHARD_INDEX: "3", RUN_TESTS_SHARD_TOTAL: "4" }), { index: 3, total: 4 });
    assert.deepEqual(parseShardSpec({ RUN_TESTS_SHARD_INDEX: "1", RUN_TESTS_SHARD_TOTAL: "1" }), { index: 1, total: 1 });
  });

  it("só uma das duas é erro, nunca suíte inteira em silêncio", () => {
    assert.throws(() => parseShardSpec({ RUN_TESTS_SHARD_INDEX: "1" }), /vão juntos/);
    assert.throws(() => parseShardSpec({ RUN_TESTS_SHARD_TOTAL: "4" }), /vão juntos/);
  });

  it("valor não inteiro ou fora de 1..N é erro", () => {
    for (const [index, total] of [
      ["0", "4"],
      ["5", "4"],
      ["1", "0"],
      ["1.5", "4"],
      ["-1", "4"],
      ["a", "4"],
      ["1", "4x"],
    ]) {
      assert.throws(
        () => parseShardSpec({ RUN_TESTS_SHARD_INDEX: index, RUN_TESTS_SHARD_TOTAL: total }),
        /shard inválido/,
        `INDEX=${index} TOTAL=${total}`,
      );
    }
  });
});

describe("shardOfPath (#14003)", () => {
  it("devolve um shard em 1..N", () => {
    for (const total of [1, 2, 3, 4, 7]) {
      for (const p of ["test/a.test.ts", "workers/x/b.test.ts", "scripts/lib/c.test.ts"]) {
        const s = shardOfPath(p, total);
        assert.ok(Number.isInteger(s) && s >= 1 && s <= total, `${p} total=${total} → ${s}`);
      }
    }
  });

  it("estável: valores fixados (mudar o hash reembaralha a suíte entre os shards)", () => {
    assert.deepEqual([2, 3, 4].map((t) => shardOfPath("test/run-tests.test.ts", t)), [2, 2, 2]);
    assert.deepEqual([2, 3, 4].map((t) => shardOfPath("test/lib-boundary.test.ts", t)), [1, 1, 1]);
  });

  it("separador do Windows dá o mesmo shard que o do POSIX", () => {
    for (const total of [2, 3, 4]) {
      assert.equal(shardOfPath("workers\\x\\b.test.ts", total), shardOfPath("workers/x/b.test.ts", total));
    }
  });

  it("total inválido lança", () => {
    assert.throws(() => shardOfPath("test/a.test.ts", 0));
    assert.throws(() => shardOfPath("test/a.test.ts", 1.5));
  });
});

describe("selectShardFiles sobre a lista real de testes (#14003)", () => {
  const all = listTestFiles(ROOT);

  it("sanity: a lista real não é vazia", () => {
    assert.ok(all.length > 100, `só ${all.length} arquivos de teste`);
  });

  for (const total of [2, 3, 4]) {
    it(`total=${total}: cada arquivo cai em exatamente 1 shard e a união é a suíte inteira`, () => {
      const seen = new Map<string, number>();
      for (let index = 1; index <= total; index++) {
        const slice = selectShardFiles(all, ROOT, { index, total });
        assert.ok(slice.length > 0, `shard ${index}/${total} vazio`);
        // Balanceamento só aproximado, mas nenhum shard com menos da metade
        // da média (sinal de hash degenerado).
        assert.ok(slice.length >= all.length / total / 2, `shard ${index}/${total} com só ${slice.length} de ${all.length}`);
        for (const f of slice) {
          assert.equal(seen.has(f), false, `${f} em dois shards (${seen.get(f)} e ${index})`);
          seen.set(f, index);
        }
      }
      assert.equal(seen.size, all.length);
      assert.deepEqual([...seen.keys()].sort(), [...all].sort());
    });
  }

  it("preserva a ordem da lista original", () => {
    const slice = selectShardFiles(all, ROOT, { index: 2, total: 4 });
    const positions = slice.map((f) => all.indexOf(f));
    assert.deepEqual(positions, [...positions].sort((a, b) => a - b));
  });

  it("um arquivo novo não muda o shard dos outros (partição por hash, não por posição)", () => {
    const novo = join(ROOT, "test", "aaa-arquivo-novo-14003.test.ts");
    const comNovo = [novo, ...all];
    for (let index = 1; index <= 4; index++) {
      const antes = selectShardFiles(all, ROOT, { index, total: 4 });
      const depois = selectShardFiles(comNovo, ROOT, { index, total: 4 }).filter((f) => f !== novo);
      assert.deepEqual(depois, antes, `shard ${index}/4 mudou com um arquivo novo`);
    }
  });

  it("spec nulo devolve a lista inteira", () => {
    assert.equal(selectShardFiles(all, ROOT, null), all);
  });
});

describe("run-tests.ts CLI com shard inválido (#14003)", () => {
  it("sai 1 sem rodar nada quando o índice está fora de 1..N", () => {
    const r = spawnSync(process.execPath, ["--import", "tsx", resolve(ROOT, "scripts", "run-tests.ts")], {
      cwd: ROOT,
      env: { ...process.env, RUN_TESTS_SHARD_INDEX: "5", RUN_TESTS_SHARD_TOTAL: "4" },
      encoding: "utf8",
      timeout: 60_000,
    });
    assert.equal(r.status, 1, `status=${r.status} signal=${r.signal} stderr=${r.stderr}`);
    assert.match(r.stderr, /shard inválido/);
  });
});

/** Bloco de um job de nível 2 (`  nome:`) do ci.yml, até o próximo job. */
function jobBlock(name: string): string {
  const lines = CI_YML.split("\n");
  const start = lines.findIndex((l) => l === `  ${name}:`);
  assert.notEqual(start, -1, `job '${name}' não encontrado em ci.yml`);
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^ {2}[A-Za-z0-9_-]+:\s*$/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join("\n");
}

describe("ci.yml: shards do npm test e agregador `test` (#14003)", () => {
  const shardJob = jobBlock("test-shard");
  const total = Number(shardJob.match(/RUN_TESTS_SHARD_TOTAL:\s*(\d+)/)?.[1]);

  it("RUN_TESTS_SHARD_TOTAL declarado entre 2 e 4", () => {
    assert.ok(Number.isInteger(total) && total >= 2 && total <= 4, `RUN_TESTS_SHARD_TOTAL=${total}`);
  });

  it("matrix.shard é exatamente 1..TOTAL (sem shard faltando nem sobrando)", () => {
    const m = shardJob.match(/^\s+shard:\s*\[([^\]]*)\]/m);
    assert.ok(m, "matrix.shard não encontrado em test-shard");
    const shards = m[1].split(",").map((s) => Number(s.trim()));
    assert.deepEqual(shards, Array.from({ length: total }, (_, i) => i + 1));
  });

  it("índice vem da matrix e o nome do job mostra o total", () => {
    assert.match(shardJob, /RUN_TESTS_SHARD_INDEX:\s*\$\{\{\s*matrix\.shard\s*\}\}/);
    assert.match(shardJob, new RegExp(`name:\\s*test \\(shard \\$\\{\\{ matrix\\.shard \\}\\}/${total}\\)`));
  });

  it("fail-fast desligado e RUN_TESTS_MAX_PROCS preservado no job dos shards", () => {
    assert.match(shardJob, /fail-fast:\s*false/);
    assert.match(shardJob, /RUN_TESTS_MAX_PROCS:\s*\d+/);
    assert.match(shardJob, /^\s+- run: npm test\s*$/m);
  });

  it("job `test` agrega: depende dos shards, roda sempre e exige success", () => {
    const agg = jobBlock("test");
    assert.match(agg, /needs:\s*test-shard/);
    assert.match(agg, /if:\s*always\(\)/);
    assert.match(agg, /\$\{\{\s*needs\.test-shard\.result\s*\}\}/);
    assert.match(agg, /!= "success"/);
    assert.match(agg, /exit 1/);
  });

  it("o agregador é o único job chamado `test` e não roda a suíte", () => {
    const agg = jobBlock("test");
    assert.doesNotMatch(agg, /run:\s*npm (ci|test)/);
    assert.equal(CI_YML.match(/^ {2}test:\s*$/gm)?.length, 1);
  });
});
