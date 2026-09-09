/**
 * test/kit-subscriber-state-transition-alarm-cli.test.ts (#7660)
 *
 * Cobre o CLI do alarme — a metade que o review da PR #7673 reprovou por
 * não ter comportamento observável nenhum: `main()` imprimia duas linhas e
 * saía 0 independente do conteúdo dos snapshots, `loadPrev`/`loadCurrent`
 * ficavam declaradas e nunca chamadas, e nada abria issue. Rodar o script
 * era no-op, então o #7660 não estava resolvido apesar da lib pura estar
 * pronta e testada.
 *
 * Cada caso monta seu próprio `data/kit-sub-state/` num diretório
 * temporário e roda o CLI de verdade, com `--dry-run` — o caminho sem
 * `--dry-run` chama `gh` pra abrir issue e não tem lugar num teste.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT_REL = "scripts/kit-subscriber-state-transition-alarm.ts";

let sandbox: string;

/** O CLI resolve `data/kit-sub-state/` a partir da RAIZ DO REPO (via
 *  `import.meta.dirname/..`), então o teste precisa de um repo-ish: linka o
 *  necessário e copia só o `scripts/` + `node_modules` por referência. Mais
 *  simples que injetar path — e prova que os defaults reais funcionam. */
before(() => {
  sandbox = mkdtempSync(join(tmpdir(), "kit-transition-"));
});
after(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

interface Snapshots {
  prev?: { id: number; state: string }[];
  current?: { id: number; email_address: string; state: string; fields?: Record<string, string> }[];
}

/** Monta um `data/kit-sub-state/` isolado e roda o CLI com `--dry-run`
 *  apontando `HOME`-like via cwd — o script usa caminhos relativos à raiz do
 *  próprio arquivo, então rodamos o script do repo com um `data/` plantado
 *  numa cópia rasa da árvore. */
function runCli(name: string, snaps: Snapshots): { stdout: string; status: number } {
  const repo = join(sandbox, name);
  mkdirSync(join(repo, "scripts", "lib"), { recursive: true });
  mkdirSync(join(repo, "data", "kit-sub-state"), { recursive: true });
  cpSync(join(ROOT, "scripts"), join(repo, "scripts"), { recursive: true });
  // `node_modules` por symlink: o CLI só precisa de `tsx` pra rodar.
  try {
    execFileSync("ln", ["-sfn", join(ROOT, "node_modules"), join(repo, "node_modules")]);
  } catch {
    /* ambiente sem ln — o npx do PATH resolve mesmo assim */
  }
  cpSync(join(ROOT, "tsconfig.json"), join(repo, "tsconfig.json"));

  const stateDir = join(repo, "data", "kit-sub-state");
  if (snaps.prev !== undefined) writeFileSync(join(stateDir, "prev.json"), JSON.stringify(snaps.prev), "utf8");
  if (snaps.current !== undefined) writeFileSync(join(stateDir, "current.json"), JSON.stringify(snaps.current), "utf8");

  try {
    const stdout = execFileSync("npx", ["tsx", join(repo, SCRIPT_REL), "--dry-run"], {
      cwd: repo,
      encoding: "utf8",
      timeout: 90_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { stdout, status: 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; status?: number };
    return { stdout: (e.stdout ?? "") + (e.stderr ?? ""), status: e.status ?? 1 };
  }
}

describe("CLI do alarme de transição Kit (#7660)", () => {
  it("current.json AUSENTE é erro duro (exit 1) — nunca no-op verde", () => {
    const { stdout, status } = runCli("sem-current", { prev: [{ id: 1, state: "active" }] });
    assert.equal(status, 1, "sair 0 aqui deixaria a task agendada verde sem ter checado nada");
    assert.match(stdout, /current\.json/);
  });

  it("sem prev.json: grava linha de base e sai 0, sem detectar transição", () => {
    const { stdout, status } = runCli("primeira-vez", {
      current: [{ id: 1, email_address: "a@x.com", state: "active" }],
    });
    assert.equal(status, 0);
    assert.match(stdout, /linha de base/);
    assert.doesNotMatch(stdout, /transição\(ões\) detectada\(s\)/);
  });

  it("active → complained: detecta e planeja abrir issue", () => {
    const { stdout, status } = runCli("transicao", {
      prev: [{ id: 1, state: "active" }],
      current: [{ id: 1, email_address: "a@x.com", state: "complained" }],
    });
    assert.equal(status, 0);
    assert.match(stdout, /1 transição\(ões\) detectada\(s\), 1 ainda não alertada\(s\)/);
    assert.match(stdout, /a@x\.com \(id 1\) active → complained/);
  });

  it("active → active: zero transições, nenhuma ação", () => {
    const { stdout, status } = runCli("sem-transicao", {
      prev: [{ id: 1, state: "active" }],
      current: [{ id: 1, email_address: "a@x.com", state: "active" }],
    });
    assert.equal(status, 0);
    assert.match(stdout, /0 transição\(ões\) detectada\(s\)/);
    assert.match(stdout, /nenhuma/);
  });

  it("--dry-run não escreve prev.json por cima nem cria o latch", () => {
    const repoName = "dry-nao-escreve";
    runCli(repoName, {
      prev: [{ id: 1, state: "active" }],
      current: [{ id: 1, email_address: "a@x.com", state: "complained" }],
    });
    const stateDir = join(sandbox, repoName, "data", "kit-sub-state");
    assert.deepEqual(
      JSON.parse(readFileSync(join(stateDir, "prev.json"), "utf8")),
      [{ id: 1, state: "active" }],
      "prev.json deve continuar intacto em --dry-run",
    );
    assert.equal(existsSync(join(stateDir, ".transition-latch.json")), false);
  });
});
