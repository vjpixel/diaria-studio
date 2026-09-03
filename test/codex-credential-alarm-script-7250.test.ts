/**
 * test/codex-credential-alarm-script-7250.test.ts (#7250)
 *
 * Regressão da camada de I/O do alarme das contas Codex — o que
 * `test/codex-credential-pool-7250.test.ts` deliberadamente não cobre, porque
 * lá só mora decisão pura.
 *
 * As três funções aqui decidem, juntas, se o editor é avisado:
 *
 * - `readCodexPool` traduz o JSON bruto do Hermes. É a fronteira onde uma
 *   mudança de formato do lado de lá vira bug do lado de cá — a mesma classe
 *   que já mordeu o projeto no #7049 (bug de casing numa transformação
 *   bruto→interno que não tinha nenhum teste cobrindo o caminho).
 * - `readState`/`writeState` são o que impede o alarme de repetir. Um defeito
 *   aqui não faz barulho: ele SUPRIME o aviso, que é exatamente o desfecho
 *   contra o qual o script inteiro existe.
 *
 * A distinção que estes testes travam com mais cuidado é entre **não consegui
 * ler** (→ `null`, exit 1, mensagem no stderr) e **li, e não há conta
 * nenhuma** (→ lista vazia, que `evaluateCodexPool` trata como alarme). As
 * duas levariam a conclusões opostas se colapsassem num valor só.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readCodexPool, readState, writeState } from "../scripts/codex-credential-alarm.ts";
import { evaluateCodexPool } from "../scripts/lib/codex-credential-pool.ts";

let dir: string;
before(() => {
  dir = mkdtempSync(join(tmpdir(), "codex-alarm-7250-"));
});
after(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Escreve um arquivo no tmpdir e devolve o caminho. */
function escrever(nome: string, conteudo: string): string {
  const p = join(dir, nome);
  writeFileSync(p, conteudo, "utf8");
  return p;
}

describe("readCodexPool — fronteira com o formato do Hermes (#7250)", () => {
  it("arquivo ausente devolve null, não lista vazia", () => {
    assert.equal(readCodexPool(join(dir, "nao-existe.json")), null);
  });

  it("JSON inválido devolve null — não engole como pool vazio", () => {
    assert.equal(readCodexPool(escrever("quebrado.json", "{isto não é json")), null);
  });

  it("sem `credential_pool` devolve null", () => {
    assert.equal(readCodexPool(escrever("sem-pool.json", '{"outra_coisa":1}')), null);
  });

  it("`credential_pool` sem a chave openai-codex devolve null", () => {
    assert.equal(readCodexPool(escrever("outra-chave.json", '{"credential_pool":{"openrouter":[]}}')), null);
  });

  it("pool como OBJETO em vez de array devolve null — mudança de formato não vira leitura silenciosa", () => {
    // O Hermes poderia passar a indexar por label. Se isso acontecer, o script
    // precisa gritar, não interpretar o objeto como "zero contas".
    const p = escrever("objeto.json", '{"credential_pool":{"openai-codex":{"vjpixel":{"last_status":"ok"}}}}');
    assert.equal(readCodexPool(p), null);
  });

  it("array VAZIO devolve [] — e isso é diferente de null, de propósito", () => {
    const pool = readCodexPool(escrever("vazio.json", '{"credential_pool":{"openai-codex":[]}}'));
    assert.deepEqual(pool, [], "array vazio não pode virar null: a leitura funcionou");
    // E o veredito sobre esse [] é ALARMAR — o rastreamento sumiu.
    assert.equal(evaluateCodexPool(pool!).shouldAlarm, true);
    assert.equal(evaluateCodexPool(pool!).poolVazio, true);
  });

  it("caso feliz repassa as entradas sem alterar", () => {
    const p = escrever(
      "ok.json",
      JSON.stringify({
        credential_pool: {
          "openai-codex": [
            { label: "vjpixel", last_status: "exhausted", last_error_code: 429 },
            { label: "memelab", last_status: "ok" },
          ],
        },
      }),
    );
    const pool = readCodexPool(p);
    assert.equal(pool?.length, 2);
    assert.equal(pool?.[0].label, "vjpixel");
  });

  it("ignora as demais chaves do auth.json, inclusive material de credencial", () => {
    // O auth.json real guarda tokens OAuth. Ler o pool não pode arrastá-los.
    const p = escrever(
      "com-segredo.json",
      JSON.stringify({
        access_token: "sk-NAO-PODE-SAIR-DAQUI",
        credential_pool: { "openai-codex": [{ label: "memelab", last_status: "ok" }] },
      }),
    );
    const pool = readCodexPool(p);
    assert.equal(pool?.length, 1);
    assert.ok(!JSON.stringify(pool).includes("NAO-PODE-SAIR-DAQUI"));
  });
});

describe("readState / writeState — a idempotência do alarme (#7250)", () => {
  it("estado ausente vira estado vazio, nunca lança", () => {
    assert.deepEqual(readState(join(dir, "sem-estado.json")), {
      last_fingerprint: null,
      last_alarmed_at: null,
    });
  });

  it("estado corrompido degrada para vazio — o pior caso é alarme repetido, nunca suprimido", () => {
    const p = escrever("estado-quebrado.json", "{{{");
    assert.deepEqual(readState(p), { last_fingerprint: null, last_alarmed_at: null });
  });

  it("campos com tipo errado não passam adiante", () => {
    const p = escrever("estado-tipos.json", '{"last_fingerprint":42,"last_alarmed_at":{"a":1}}');
    assert.deepEqual(readState(p), { last_fingerprint: null, last_alarmed_at: null });
  });

  it("roundtrip preserva o estado", () => {
    const p = join(dir, "roundtrip.json");
    const estado = { last_fingerprint: "memelab:viva|vjpixel:esgotada", last_alarmed_at: "2026-09-03T08:00:00.000Z" };
    writeState(p, estado);
    assert.deepEqual(readState(p), estado);
  });

  it("cria o diretório-pai quando ele não existe", () => {
    const p = join(dir, "fundo", "do", "poco", "state.json");
    writeState(p, { last_fingerprint: "x", last_alarmed_at: null });
    assert.ok(existsSync(p));
    assert.equal(readState(p).last_fingerprint, "x");
  });

  it("não deixa arquivo temporário para trás", () => {
    // Escrita atômica passa por um arquivo intermediário; ele não pode
    // sobreviver ao rename e ser lido depois como se fosse o estado.
    const p = join(dir, "atomico.json");
    writeState(p, { last_fingerprint: "a", last_alarmed_at: null });
    writeState(p, { last_fingerprint: "b", last_alarmed_at: null });
    assert.equal(readState(p).last_fingerprint, "b");
    assert.ok(readFileSync(p, "utf8").trim().endsWith("}"), "o arquivo final tem de ser JSON completo");
  });
});
