/**
 * test/preflight-state.test.ts (#5414)
 *
 * Cobre `scripts/lib/preflight-state.ts` — o requisito central da issue:
 * um stage disparado como sessão nova (Stage 2, Stage 5) precisa conseguir
 * ler os 5 sinais de saúde de dependência externa apurados pelo Stage 0
 * SEM depender de memória de conversa, lendo direto do disco.
 *
 *   1. Lógica pura — fixture de diretório temporário: default fail-soft,
 *      round-trip write/read, upsert parcial não apaga outros campos,
 *      `capturedAt` avança, corpo corrompido/shape errado não lança.
 *   2. Contrato CLI — `--edition-dir` + flags de escrita, `--read`.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  readPreflightState,
  writePreflightState,
  type PreflightState,
} from "../scripts/lib/preflight-state.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = resolve(ROOT, "scripts", "lib", "preflight-state.ts");

const DEFAULT: PreflightState = {
  chromeMcp: null,
  gmailMcp: null,
  beehiivMcp: null,
  clariceRest: null,
  cloudflareTokenOk: null,
  capturedAt: null,
};

describe("readPreflightState / writePreflightState (#5414, pure)", () => {
  let editionDir: string;

  before(() => {
    editionDir = mkdtempSync(join(tmpdir(), "preflight-state-"));
  });

  after(() => {
    rmSync(editionDir, { recursive: true, force: true });
  });

  it("sem _internal/preflight-state.json -> default (todos null)", () => {
    assert.deepEqual(readPreflightState(editionDir), DEFAULT);
  });

  it("writePreflightState grava e readPreflightState reflete, com capturedAt", () => {
    const written = writePreflightState(
      editionDir,
      { chromeMcp: true, clariceRest: false },
      { now: () => new Date("2026-08-16T10:00:00.000Z") },
    );
    assert.equal(written.chromeMcp, true);
    assert.equal(written.clariceRest, false);
    assert.equal(written.capturedAt, "2026-08-16T10:00:00.000Z");

    const read = readPreflightState(editionDir);
    assert.deepEqual(read, {
      ...DEFAULT,
      chromeMcp: true,
      clariceRest: false,
      capturedAt: "2026-08-16T10:00:00.000Z",
    });
  });

  it("write parcial subsequente faz upsert — não apaga campos já gravados", () => {
    writePreflightState(editionDir, { gmailMcp: true }, { now: () => new Date("2026-08-16T10:05:00.000Z") });
    const read = readPreflightState(editionDir);
    // campos do write anterior continuam presentes
    assert.equal(read.chromeMcp, true);
    assert.equal(read.clariceRest, false);
    // campo novo entrou
    assert.equal(read.gmailMcp, true);
    // capturedAt avançou para o write mais recente
    assert.equal(read.capturedAt, "2026-08-16T10:05:00.000Z");
  });

  it("write posterior sobrescreve um campo já setado", () => {
    writePreflightState(editionDir, { chromeMcp: false }, { now: () => new Date("2026-08-16T10:10:00.000Z") });
    assert.equal(readPreflightState(editionDir).chromeMcp, false);
  });

  it("cria _internal/ se ainda não existir", () => {
    const fresh = mkdtempSync(join(tmpdir(), "preflight-state-nodir-"));
    assert.equal(existsSync(join(fresh, "_internal")), false);
    writePreflightState(fresh, { beehiivMcp: true });
    assert.equal(existsSync(join(fresh, "_internal", "preflight-state.json")), true);
    rmSync(fresh, { recursive: true, force: true });
  });

  it("JSON corrompido -> default fail-soft, nunca lança", () => {
    const dir = mkdtempSync(join(tmpdir(), "preflight-state-corrupt-"));
    mkdirSync(join(dir, "_internal"), { recursive: true });
    writeFileSync(join(dir, "_internal", "preflight-state.json"), "{ isso não é json", "utf8");
    assert.deepEqual(readPreflightState(dir), DEFAULT);
    rmSync(dir, { recursive: true, force: true });
  });

  it("shape com campo de tipo errado -> normaliza esse campo pra null, resto ok", () => {
    const dir = mkdtempSync(join(tmpdir(), "preflight-state-badtype-"));
    mkdirSync(join(dir, "_internal"), { recursive: true });
    writeFileSync(
      join(dir, "_internal", "preflight-state.json"),
      JSON.stringify({ chromeMcp: "sim", gmailMcp: true, capturedAt: 123 }),
      "utf8",
    );
    assert.deepEqual(readPreflightState(dir), { ...DEFAULT, chromeMcp: null, gmailMcp: true, capturedAt: null });
    rmSync(dir, { recursive: true, force: true });
  });

  it("nunca sobrescreve/reaproveita outro arquivo sob _internal/ — path é dedicado", () => {
    const dir = mkdtempSync(join(tmpdir(), "preflight-state-dedicated-"));
    mkdirSync(join(dir, "_internal"), { recursive: true });
    const other = join(dir, "_internal", "outro-estado.json");
    writeFileSync(other, JSON.stringify({ hello: "world" }), "utf8");
    writePreflightState(dir, { chromeMcp: true });
    assert.equal(JSON.parse(readFileSync(other, "utf8")).hello, "world");
    rmSync(dir, { recursive: true, force: true });
  });

  // Fleet review pré-merge #5414 (silent-failure-hunter, CRITICAL) — o catch
  // genérico original engolia EACCES/EPERM/EISDIR/lock do OneDrive sem log
  // nenhum, indistinguível de "arquivo nunca escrito". Simula um erro de FS
  // real (não ausência de arquivo, não JSON corrompido) fazendo o path do
  // state file ser um DIRETÓRIO em vez de um arquivo — `existsSync` retorna
  // true, mas `readFileSync` lança EISDIR, tanto em Windows quanto POSIX.
  it("erro de FS real na leitura (EISDIR) -> loga e retorna default, nunca lança (CRITICAL #1)", () => {
    const dir = mkdtempSync(join(tmpdir(), "preflight-state-eisdir-"));
    mkdirSync(join(dir, "_internal", "preflight-state.json"), { recursive: true });

    let logged = "";
    const originalError = console.error;
    console.error = (msg: unknown) => {
      logged = String(msg);
    };
    try {
      assert.deepEqual(readPreflightState(dir), DEFAULT);
    } finally {
      console.error = originalError;
    }
    assert.ok(logged.length > 0, "esperava console.error chamado com o erro de FS");
    assert.match(logged, /EISDIR/);
    rmSync(dir, { recursive: true, force: true });
  });

  // CRITICAL #2 — o write-side upsert não pode silenciosamente tratar um
  // erro de FS real (arquivo existe mas ilegível) como "nunca existiu": isso
  // apagaria campos já persistidos por um write anterior na mesma edição.
  // Preparamos um estado real em disco (JSON válido, campo capturado), então
  // forçamos EISDIR só na hora do upsert seguinte — a escrita deve LANÇAR
  // (não sobrescrever com DEFAULT_STATE) e o conteúdo original — aqui, o
  // fato de o path continuar sendo um diretório e nunca um arquivo — precisa
  // sobreviver intacto.
  //
  // Mocking direto de `readFileSync`/`writeFileSync` (`node:test`'s
  // `mock.method`) foi tentado e descartado: sob o loader ESM deste
  // ambiente (tsx + Node 24), `node:fs` importado via `import { readFileSync
  // } from "node:fs"` não compartilha identidade mutável com o objeto CJS
  // obtido via `createRequire(...)("node:fs")` — mockar um não afeta o
  // outro, e mockar a própria namespace ESM lança "Cannot redefine
  // property" (propriedades de module namespace object são não-
  // configuráveis). Fault injection via FS real (arquivo -> diretório) é a
  // alternativa portável (Windows + POSIX) usada aqui.
  it("erro de FS real na leitura durante upsert de escrita -> lança (origem é o READ, não o WRITE), preserva o que já estava em disco (CRITICAL #2)", () => {
    const dir = mkdtempSync(join(tmpdir(), "preflight-state-write-eisdir-"));
    const internalDir = join(dir, "_internal");
    mkdirSync(internalDir, { recursive: true });
    const statePath = join(internalDir, "preflight-state.json");

    // Substitui o arquivo por um diretório de mesmo nome — `existsSync`
    // continua true (arquivo "existe"), mas `readFileSync` lança EISDIR.
    // É exatamente o caso "existe mas não pôde ser lido" que o CRITICAL #2
    // endereça — distinto de "nunca escrito" (que legitimamente vira
    // DEFAULT_STATE) e de "JSON corrompido" (que legitimamente é
    // sobrescrito).
    mkdirSync(statePath, { recursive: true });

    let thrown: Error | undefined;
    try {
      writePreflightState(dir, { gmailMcp: true });
    } catch (err) {
      thrown = err as Error;
    }
    assert.ok(thrown, "esperava writePreflightState lançar em vez de sobrescrever silenciosamente");
    // A mensagem do erro nativo do Node inclui a syscall (`, read` vs
    // `, write`) — confirmando que o throw veio da tentativa de LEITURA
    // dentro de `tryReadRaw` (regra: propaga sem capturar), e que o código
    // nunca chegou perto de `writeFileSync` nesse caminho.
    assert.match(thrown!.message, /EISDIR/);
    assert.match(thrown!.message, /, read/);
    assert.doesNotMatch(thrown!.message, /, write/);

    // O path segue sendo o mesmo diretório-armadilha — nunca foi
    // substituído por um arquivo com DEFAULT_STATE merged. Se o bug do
    // CRITICAL #2 tivesse voltado, o upsert teria seguido em frente com
    // `current = DEFAULT_STATE` e tentado `writeFileSync` sobre o
    // diretório — o que lançaria um EISDIR DIFERENTE (`, write`), não o
    // que capturamos acima.
    assert.throws(() => readFileSync(statePath, "utf8"), /EISDIR/);

    rmSync(dir, { recursive: true, force: true });
  });
});

describe("preflight-state.ts CLI (#5414)", () => {
  let editionDir: string;

  before(() => {
    editionDir = mkdtempSync(join(tmpdir(), "preflight-state-cli-"));
  });

  after(() => {
    rmSync(editionDir, { recursive: true, force: true });
  });

  it("--read sem arquivo -> JSON default", () => {
    const out = execFileSync("npx", ["tsx", SCRIPT, "--edition-dir", editionDir, "--read"], {
      encoding: "utf8",
      cwd: ROOT,
      shell: true,
    });
    assert.deepEqual(JSON.parse(out.trim()), DEFAULT);
  });

  it("escrever via flags e reler via --read", () => {
    execFileSync(
      "npx",
      ["tsx", SCRIPT, "--edition-dir", editionDir, "--chrome-mcp", "true", "--clarice-rest", "false"],
      { cwd: ROOT, shell: true },
    );
    const out = execFileSync("npx", ["tsx", SCRIPT, "--edition-dir", editionDir, "--read"], {
      encoding: "utf8",
      cwd: ROOT,
      shell: true,
    });
    const state = JSON.parse(out.trim());
    assert.equal(state.chromeMcp, true);
    assert.equal(state.clariceRest, false);
    assert.ok(state.capturedAt);
  });

  it("sem --edition-dir -> exit != 0", () => {
    assert.throws(() => {
      execFileSync("npx", ["tsx", SCRIPT, "--read"], { cwd: ROOT, shell: true, stdio: "pipe" });
    });
  });

  it("sem flags de escrita e sem --read -> exit != 0", () => {
    assert.throws(() => {
      execFileSync("npx", ["tsx", SCRIPT, "--edition-dir", editionDir], { cwd: ROOT, shell: true, stdio: "pipe" });
    });
  });

  // (#5434) --chrome-mcp sem valor (fim dos args) degradava em silêncio antes
  // do fix: parseArgs trata isso como flag booleana, `values["chrome-mcp"]`
  // fica undefined, e o write da patch simplesmente pulava esse campo sem
  // erro nenhum — indistinguível de "flag nunca passada". Regressão: falhar
  // alto (exit 2), nunca sair 0 nem cair no dump de --read.
  it("--chrome-mcp sem valor (fim dos args) -> exit 2, nunca degrada em silêncio", () => {
    assert.throws(
      () => {
        execFileSync("npx", ["tsx", SCRIPT, "--edition-dir", editionDir, "--chrome-mcp"], {
          cwd: ROOT,
          shell: true,
          stdio: "pipe",
        });
      },
      (err: unknown) => {
        assert.equal((err as { status: number }).status, 2);
        return true;
      },
    );
  });

  // Mesmo caso, mas com uma flag válida em seguida — a flag sem valor não
  // pode ser mascarada pelo sucesso da outra.
  it("--chrome-mcp sem valor seguido de --gmail-mcp true -> exit 2, não escreve nada", () => {
    const before = execFileSync("npx", ["tsx", SCRIPT, "--edition-dir", editionDir, "--read"], {
      encoding: "utf8",
      cwd: ROOT,
      shell: true,
    });
    assert.throws(
      () => {
        execFileSync(
          "npx",
          ["tsx", SCRIPT, "--edition-dir", editionDir, "--chrome-mcp", "--gmail-mcp", "true"],
          { cwd: ROOT, shell: true, stdio: "pipe" },
        );
      },
      (err: unknown) => {
        assert.equal((err as { status: number }).status, 2);
        return true;
      },
    );
    const after = execFileSync("npx", ["tsx", SCRIPT, "--edition-dir", editionDir, "--read"], {
      encoding: "utf8",
      cwd: ROOT,
      shell: true,
    });
    assert.equal(after, before, "estado em disco não deve mudar quando o comando falha por flag sem valor");
  });

  // (#5434 item 2) §0e–0h do playbook do Stage 0 manda disparar os 5 checks
  // de preflight "numa única mensagem" — chamadas Bash paralelas, cada uma
  // um processo `preflight-state.ts --set` separado. Sem lock, dois desses
  // processos fazem read-modify-write sobre o mesmo `preflight-state.json`:
  // A lê, B lê o mesmo estado antes de A gravar, A grava, B grava por cima —
  // o campo que A tinha acabado de setar some, sem erro nenhum (lost
  // update). Regressão: disparar N processos concorrentes, cada um setando
  // um campo DIFERENTE, e confirmar que todos os N campos sobrevivem.
  it("escritas concorrentes (5 processos, 1 campo cada) não se perdem — race do #5434 item 2", async () => {
    const dir = mkdtempSync(join(tmpdir(), "preflight-state-race-"));
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execFileAsync = promisify(execFile);

    const writes: [string, string][] = [
      ["chrome-mcp", "true"],
      ["gmail-mcp", "false"],
      ["beehiiv-mcp", "true"],
      ["clarice-rest", "false"],
      ["cloudflare-token-ok", "true"],
    ];

    // Todos disparados ao mesmo tempo (Promise.all, sem await sequencial) —
    // reproduz o paralelismo que o playbook pede "numa única mensagem".
    await Promise.all(
      writes.map(([flag, value]) =>
        execFileAsync("npx", ["tsx", SCRIPT, "--edition-dir", dir, `--${flag}`, value], {
          cwd: ROOT,
          shell: true,
        }),
      ),
    );

    const out = execFileSync("npx", ["tsx", SCRIPT, "--edition-dir", dir, "--read"], {
      encoding: "utf8",
      cwd: ROOT,
      shell: true,
    });
    const state = JSON.parse(out.trim());
    assert.equal(state.chromeMcp, true, "chromeMcp perdido — lost update da race");
    assert.equal(state.gmailMcp, false, "gmailMcp perdido — lost update da race");
    assert.equal(state.beehiivMcp, true, "beehiivMcp perdido — lost update da race");
    assert.equal(state.clariceRest, false, "clariceRest perdido — lost update da race");
    assert.equal(state.cloudflareTokenOk, true, "cloudflareTokenOk perdido — lost update da race");

    rmSync(dir, { recursive: true, force: true });
  });
});
