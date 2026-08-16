/**
 * test/stage4-capture-state.test.ts (#5414)
 *
 * Cobre `scripts/lib/stage4-capture-state.ts` — os 2 valores computados em
 * §4c.1b/§4c.1c do Stage 4 e consumidos no gate (§4d) precisam sobreviver a
 * um corte de contexto DENTRO do Stage 4 (o stage mais longo do pipeline —
 * 587 turnos medidos na auditoria do #5414), não só entre stages.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  readStage4CaptureState,
  writeStage4CaptureState,
  type Stage4CaptureState,
} from "../scripts/lib/stage4-capture-state.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = resolve(ROOT, "scripts", "lib", "stage4-capture-state.ts");

const DEFAULT: Stage4CaptureState = {
  whatsappUrl: null,
  metaDescriptionSuggestion: null,
  capturedAt: null,
};

describe("readStage4CaptureState / writeStage4CaptureState (#5414)", () => {
  let editionDir: string;

  before(() => {
    editionDir = mkdtempSync(join(tmpdir(), "stage4-capture-state-"));
  });

  after(() => {
    rmSync(editionDir, { recursive: true, force: true });
  });

  it("sem arquivo -> default (ambos null)", () => {
    assert.deepEqual(readStage4CaptureState(editionDir), DEFAULT);
  });

  it("write parcial (só whatsappUrl, §4c.1b) grava e read reflete", () => {
    const written = writeStage4CaptureState(
      editionDir,
      { whatsappUrl: "https://diar.ia.br/e/260817?w=1" },
      { now: () => new Date("2026-08-16T20:00:00.000Z") },
    );
    assert.equal(written.whatsappUrl, "https://diar.ia.br/e/260817?w=1");
    assert.equal(written.metaDescriptionSuggestion, null);
    assert.equal(written.capturedAt, "2026-08-16T20:00:00.000Z");
  });

  it("write subsequente (§4c.1c) faz upsert — não apaga whatsappUrl já gravado", () => {
    writeStage4CaptureState(
      editionDir,
      { metaDescriptionSuggestion: "Uma sugestão de meta description." },
      { now: () => new Date("2026-08-16T20:05:00.000Z") },
    );
    const read = readStage4CaptureState(editionDir);
    assert.equal(read.whatsappUrl, "https://diar.ia.br/e/260817?w=1");
    assert.equal(read.metaDescriptionSuggestion, "Uma sugestão de meta description.");
    assert.equal(read.capturedAt, "2026-08-16T20:05:00.000Z");
  });

  it("string vazia é valor legítimo já capturado — distinto de null (nunca computado)", () => {
    const dir = mkdtempSync(join(tmpdir(), "stage4-capture-state-empty-"));
    writeStage4CaptureState(dir, { metaDescriptionSuggestion: "" });
    const read = readStage4CaptureState(dir);
    assert.equal(read.metaDescriptionSuggestion, ""); // computado, sem sugestão — não é "ainda não rodou"
    assert.notEqual(read.metaDescriptionSuggestion, null);
    rmSync(dir, { recursive: true, force: true });
  });

  it("§4d.1 recompute (editor ajustou título do D1) sobrescreve whatsappUrl", () => {
    writeStage4CaptureState(editionDir, { whatsappUrl: "https://diar.ia.br/e/260817?w=2" });
    assert.equal(readStage4CaptureState(editionDir).whatsappUrl, "https://diar.ia.br/e/260817?w=2");
  });

  it("cria _internal/ se ainda não existir", () => {
    const fresh = mkdtempSync(join(tmpdir(), "stage4-capture-state-nodir-"));
    assert.equal(existsSync(join(fresh, "_internal")), false);
    writeStage4CaptureState(fresh, { whatsappUrl: "https://x" });
    assert.equal(existsSync(join(fresh, "_internal", "stage4-capture-state.json")), true);
    rmSync(fresh, { recursive: true, force: true });
  });

  it("JSON corrompido -> default fail-soft, nunca lança", () => {
    const dir = mkdtempSync(join(tmpdir(), "stage4-capture-state-corrupt-"));
    mkdirSync(join(dir, "_internal"), { recursive: true });
    writeFileSync(join(dir, "_internal", "stage4-capture-state.json"), "{{{", "utf8");
    assert.deepEqual(readStage4CaptureState(dir), DEFAULT);
    rmSync(dir, { recursive: true, force: true });
  });

  it("nunca sobrescreve outro arquivo sob _internal/ — path é dedicado", () => {
    const dir = mkdtempSync(join(tmpdir(), "stage4-capture-state-dedicated-"));
    mkdirSync(join(dir, "_internal"), { recursive: true });
    const other = join(dir, "_internal", "outro-estado.json");
    writeFileSync(other, JSON.stringify({ hello: "world" }), "utf8");
    writeStage4CaptureState(dir, { whatsappUrl: "https://x" });
    assert.equal(JSON.parse(readFileSync(other, "utf8")).hello, "world");
    rmSync(dir, { recursive: true, force: true });
  });

  // Fleet review pré-merge #5414 (silent-failure-hunter, CRITICAL) — o catch
  // genérico original engolia EACCES/EPERM/EISDIR/lock do OneDrive sem log
  // nenhum, indistinguível de "nunca capturado". Simula um erro de FS real
  // (não ausência de arquivo, não JSON corrompido) fazendo o path do state
  // file ser um DIRETÓRIO em vez de um arquivo — `existsSync` retorna true,
  // mas `readFileSync` lança EISDIR, tanto em Windows quanto POSIX.
  it("erro de FS real na leitura (EISDIR) -> loga e retorna default, nunca lança (CRITICAL #1)", () => {
    const dir = mkdtempSync(join(tmpdir(), "stage4-capture-state-eisdir-"));
    mkdirSync(join(dir, "_internal", "stage4-capture-state.json"), { recursive: true });

    let logged = "";
    const originalError = console.error;
    console.error = (msg: unknown) => {
      logged = String(msg);
    };
    try {
      assert.deepEqual(readStage4CaptureState(dir), DEFAULT);
    } finally {
      console.error = originalError;
    }
    assert.ok(logged.length > 0, "esperava console.error chamado com o erro de FS");
    assert.match(logged, /EISDIR/);
    rmSync(dir, { recursive: true, force: true });
  });

  // CRITICAL #2 — o write-side upsert não pode silenciosamente tratar um
  // erro de FS real (arquivo existe mas ilegível) como "nunca existiu": isso
  // apagaria `whatsappUrl` já capturado por §4c.1b quando §4c.1c tentasse
  // gravar `metaDescriptionSuggestion` num write separado. A escrita deve
  // LANÇAR em vez de sobrescrever com DEFAULT_STATE.
  //
  // Mocking direto de `readFileSync`/`writeFileSync` (`node:test`'s
  // `mock.method`) foi tentado e descartado: sob o loader ESM deste
  // ambiente (tsx + Node 24), `node:fs` importado via named import não
  // compartilha identidade mutável com o objeto CJS de
  // `createRequire(...)("node:fs")` — mockar um não afeta o outro, e mockar
  // a própria namespace ESM lança "Cannot redefine property". Fault
  // injection via FS real (arquivo -> diretório) é a alternativa portável
  // usada aqui.
  it("erro de FS real na leitura durante upsert de escrita -> lança (origem é o READ, não o WRITE), preserva o que já estava em disco (CRITICAL #2)", () => {
    const dir = mkdtempSync(join(tmpdir(), "stage4-capture-state-write-eisdir-"));
    const internalDir = join(dir, "_internal");
    mkdirSync(internalDir, { recursive: true });
    const statePath = join(internalDir, "stage4-capture-state.json");

    // Substitui o arquivo por um diretório de mesmo nome — `existsSync`
    // continua true, mas `readFileSync` lança EISDIR. É exatamente o caso
    // "existe mas não pôde ser lido" que o CRITICAL #2 endereça — distinto
    // de "nunca escrito" (legitimamente vira DEFAULT_STATE) e de "JSON
    // corrompido" (legitimamente sobrescrito).
    mkdirSync(statePath, { recursive: true });

    let thrown: Error | undefined;
    try {
      writeStage4CaptureState(dir, { metaDescriptionSuggestion: "nova sugestão" });
    } catch (err) {
      thrown = err as Error;
    }
    assert.ok(thrown, "esperava writeStage4CaptureState lançar em vez de sobrescrever silenciosamente");
    // A mensagem do erro nativo do Node inclui a syscall (`, read` vs
    // `, write`) — confirmando que o throw veio da tentativa de LEITURA
    // dentro de `tryReadRaw`, nunca chegando perto de `writeFileSync`.
    assert.match(thrown!.message, /EISDIR/);
    assert.match(thrown!.message, /, read/);
    assert.doesNotMatch(thrown!.message, /, write/);

    // O path segue sendo o mesmo diretório-armadilha — nunca foi
    // substituído por um arquivo com DEFAULT_STATE merged.
    assert.throws(() => readFileSync(statePath, "utf8"), /EISDIR/);

    rmSync(dir, { recursive: true, force: true });
  });
});

// (#5437) Espelha test/preflight-state.test.ts:266/:284 — mesma classe de
// bug que o #5434 corrigiu em preflight-state.ts: uma flag de valor
// conhecida passada sem argumento (fim dos args, ou seguida de outra
// `--flag`) degradava em silêncio em `parseArgs` (vira flag booleana em vez
// de entrar em `values`), omitindo o write daquele campo do patch sem erro
// nenhum — indistinguível de "flag nem foi passada".
describe("stage4-capture-state.ts CLI (#5414, #5437)", () => {
  let editionDir: string;

  before(() => {
    editionDir = mkdtempSync(join(tmpdir(), "stage4-capture-state-cli-"));
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
      [
        "tsx",
        SCRIPT,
        "--edition-dir",
        editionDir,
        "--whatsapp-url",
        "https://diar.ia.br/e/260817?w=1",
        "--meta-description-suggestion",
        "uma-sugestao-sem-espaco",
      ],
      { cwd: ROOT, shell: true },
    );
    const out = execFileSync("npx", ["tsx", SCRIPT, "--edition-dir", editionDir, "--read"], {
      encoding: "utf8",
      cwd: ROOT,
      shell: true,
    });
    const state = JSON.parse(out.trim());
    assert.equal(state.whatsappUrl, "https://diar.ia.br/e/260817?w=1");
    assert.equal(state.metaDescriptionSuggestion, "uma-sugestao-sem-espaco");
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

  // --whatsapp-url sem valor (fim dos args) degradava em silêncio antes do
  // fix: parseArgs trata isso como flag booleana, `values["whatsapp-url"]`
  // fica undefined, e o write da patch simplesmente pulava esse campo sem
  // erro nenhum. Regressão: falhar alto (exit 2), nunca sair 0.
  it("--whatsapp-url sem valor (fim dos args) -> exit 2, nunca degrada em silêncio", () => {
    assert.throws(
      () => {
        execFileSync("npx", ["tsx", SCRIPT, "--edition-dir", editionDir, "--whatsapp-url"], {
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
  // pode ser mascarada pelo sucesso da outra, e nada deve ser escrito.
  it("--meta-description-suggestion sem valor seguido de --whatsapp-url válida -> exit 2, não escreve nada", () => {
    const before = execFileSync("npx", ["tsx", SCRIPT, "--edition-dir", editionDir, "--read"], {
      encoding: "utf8",
      cwd: ROOT,
      shell: true,
    });
    assert.throws(
      () => {
        execFileSync(
          "npx",
          [
            "tsx",
            SCRIPT,
            "--edition-dir",
            editionDir,
            "--meta-description-suggestion",
            "--whatsapp-url",
            "https://diar.ia.br/e/260817?w=999",
          ],
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
    assert.equal(after, before);
  });
});
