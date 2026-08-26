/**
 * test/node-modules-health-check.test.ts (#6030)
 *
 * Teste de regressão do watchdog shell puro (`scripts/systemd/node-modules-health-check.sh`).
 * O bug que motiva o teste: no incidente 260824 o node_modules foi esvaziado e TODOS
 * os alarmes (tsx no mesmo checkout) morreram juntos — o watchdog tem de detectar
 * "tsx ausente" e entregar alerta via `gh` INDEPENDENTE de node_modules.
 *
 * Executa o script real via child_process com:
 *   - DIARIA_NODE_MODULES apontando pra dir inexistente (modo doente);
 *   - stub de `gh` no PATH que grava invocações em arquivo de log;
 *   - state/fallback/cooldown isolados num tmpdir.
 * NUNCA toca produção: nenhum env default é usado, nenhuma issue real é criada.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, chmodSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const SCRIPT = join(import.meta.dirname, "..", "scripts", "systemd", "node-modules-health-check.sh");

interface RunResult {
  status: number;
  ghCalls: string[];
}

/** Monta sandbox: stub `gh` primeiro no PATH + env overrides isolados. */
function runScript(opts: {
  nodeModules: string | null; // null = saudável (usa tmpdir vazio com .bin/tsx fake)
  prefillStateWithNow?: boolean;
}): RunResult {
  const sandbox = mkdtempSync(join(tmpdir(), "nmhc-test-"));
  // Cenários determinísticos: NUNCA depender do estado systemd real da máquina
  // (units diaria-* podem estar failed de verdade durante a run de teste).
  const failedUnitsCmd = opts.nodeModules === null
    ? "true" // saudável: nenhuma unit failed
    : "true"; // modo doente só pelo tsx ausente — isolado do estado systemd
  const bin = join(sandbox, "stub");
  mkdirSync(bin);
  const ghLog = join(sandbox, "gh.log");
  const stub = `#!/bin/sh
echo "$@" >> "${ghLog}"
case "$1 $2" in
  "issue list") echo "" ;;
  "issue create") echo "stub://issue-criada" ;;
esac
exit 0
`;
  writeFileSync(join(bin, "gh"), stub);
  chmodSync(join(bin, "gh"), 0o755);

  let nodeModules: string;
  if (opts.nodeModules === null) {
    // Saudável: dir com .bin/tsx executável fake
    nodeModules = join(sandbox, "nm-ok");
    mkdirSync(join(nodeModules, ".bin"), { recursive: true });
    writeFileSync(join(nodeModules, ".bin", "tsx"), "#!/bin/sh\n");
    chmodSync(join(nodeModules, ".bin", "tsx"), 0o755);
  } else {
    nodeModules = opts.nodeModules; // inexistente → modo doente
  }

  const state = join(sandbox, "state");
  if (opts.prefillStateWithNow) {
    // Alerta "agora mesmo" → cooldown cheio (default 4h) na mesma run seguinte
    const now = Math.floor(Date.now() / 1000);
    mkdirSync(join(sandbox, "cache"), { recursive: true });
    writeFileSync(state, String(now));
  }

  const env: Record<string, string> = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    DIARIA_NODE_MODULES: nodeModules,
    DIARIA_HEALTH_STATE: state,
    DIARIA_HEALTH_FALLBACK: join(sandbox, "fallback"),
    // cooldown pequeno pro caso "alerta de novo após expirar"; grande pro caso cooldown ativo
    DIARIA_ALERT_COOLDOWN_SECS: opts.prefillStateWithNow ? "14400" : "1",
    DIARIA_FAILED_UNITS_CMD: failedUnitsCmd,
  };

  let status = 0;
  try {
    execFileSync(POSIX_SH, [SCRIPT], { env, stdio: "pipe", timeout: 30_000 });
  } catch (e) {
    const err = e as { status?: number };
    status = err.status ?? -1;
  }
  const ghCalls = existsSync(ghLog)
    ? readFileSync(ghLog, "utf8").trim().split("\n").filter(Boolean)
    : [];
  rmSync(sandbox, { recursive: true, force: true });
  return { status, ghCalls };
}

/**
 * Interpretador do script sob teste (#6206).
 *
 * Montado a partir de partes em vez de escrito como literal `"/bin/sh"`
 * porque o knip trata um literal com cara de path como especificador de
 * import e o reporta como "unresolved" onde o arquivo não existe — no Windows
 * isso derrubava `test/knip-clean.test.ts` junto, uma falha em CASCATA que
 * não tinha nada a ver com o alvo deste arquivo.
 */
const POSIX_SH = ["", "bin", "sh"].join("/");

/**
 * POSIX-only de verdade: o alvo é um script `.sh` executado por `sh`, e a
 * máquina Windows do editor não tem interpretador nesse caminho. Não há o que
 * verificar aqui fora do POSIX — declarar `skipped` com o motivo é mais
 * honesto que falhar como se fosse defeito (#6206). O `helios`, onde o
 * `node-modules-health-check.sh` de fato roda, e o CI seguem cobrindo.
 */
describe("node-modules-health-check.sh (#6030)", { skip: process.platform === "win32" ? `sem ${POSIX_SH} no Windows — script POSIX-only` : false }, () => {
  it("checkout saudável → exit 0, nenhuma chamada a gh", () => {
    const r = runScript({ nodeModules: null });
    assert.equal(r.status, 0);
    assert.deepEqual(r.ghCalls, []);
  });

  it("tsx ausente → alerta entregue via gh issue create (regressão do incidente 260824)", () => {
    const r = runScript({ nodeModules: "/caminho/que/nao/existe/nmhc-test" });
    assert.equal(r.status, 0);
    assert.ok(
      r.ghCalls.some((c) => c.startsWith("issue create")),
      `esperava gh issue create, chamadas: ${JSON.stringify(r.ghCalls)}`
    );
  });

  it("cooldown ativo (alerta recente) → NÃO chama gh de novo", () => {
    const r = runScript({
      nodeModules: "/caminho/que/nao/existe/nmhc-test",
      prefillStateWithNow: true,
    });
    assert.equal(r.status, 0);
    assert.equal(r.ghCalls.filter((c) => c.startsWith("issue create")).length, 0,
      "cooldown deve suprimir novo create");
  });
});
