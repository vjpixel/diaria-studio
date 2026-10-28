/**
 * test/_helpers/fake-gh.ts (#11487)
 *
 * Ponto único para todo teste que põe um `gh` FALSO no PATH.
 *
 * Incidente que motivou (28/10/2026, Neo/Windows): `test/continuo-escalate-
 * head-marker-9323.test.ts` rodou sem o skip de win32. O shim `gh` (bash, sem
 * extensão) perdeu para o `gh.exe` real — no Windows a busca no PATH sem
 * shell só tenta `.com`/`.exe`, e o PATH era montado com `:` em vez do
 * delimitador `;`. O teste aplicou de verdade um label e postou um comentário
 * na PR #9204 com a credencial do editor.
 *
 * Duas defesas, independentes, aplicadas por `fakeGhEnv`:
 *
 * 1. **Sonda**: antes de devolver o ambiente, executa `gh <PROBE>` do mesmo
 *    jeito que os scripts sob teste executam (`spawnSync("gh")`, sem shell) e
 *    exige a resposta que só o shim escrito por `writeFakeGh` dá. Se o `gh`
 *    resolvido for qualquer outro, lança ANTES de o teste fazer a 1ª chamada.
 *    O `gh` real que recebe a sonda só responde "unknown command".
 * 2. **Sem credencial**: `GH_TOKEN`/`GITHUB_TOKEN` com um valor inválido (o
 *    token de ambiente vence o keyring e o `hosts.yml`, então o `gh` real leva
 *    401), `GH_HOST` num domínio `.invalid` (RFC 2606, nunca resolve),
 *    `GH_CONFIG_DIR` vazio e tokens de Enterprise removidos. Vale mesmo se a
 *    sonda for contornada por um teste que spawna por outro caminho.
 *
 * O guard estrutural `test/fake-gh-safety-guard-11487.test.ts` reprova teste
 * que escreva um `gh` falso sem passar por aqui.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

/** Argumento que o shim reconhece; nenhum subcomando real do gh se chama assim. */
export const FAKE_GH_PROBE_ARG = "__diaria_fake_gh_probe_11487__";
/** Resposta que só o shim dá. */
export const FAKE_GH_PROBE_REPLY = "diaria-fake-gh-ok-11487";
/** Token propositalmente inválido: o `gh` real que escapar leva 401. */
export const FAKE_GH_INVALID_TOKEN = "diaria-fake-gh-sem-credencial-11487";
/** Host que nunca resolve (TLD reservado `.invalid`). */
export const FAKE_GH_INVALID_HOST = "github.invalid";

/**
 * Motivo de skip para testes de `gh` falso no Windows. O shim é bash sem
 * extensão e `spawnSync("gh")` sem shell não o encontra lá — o teste não tem
 * como provar nada e, sem a sonda, chamaria o `gh.exe` real.
 */
export const FAKE_GH_SKIP_WIN32: string | false =
  process.platform === "win32" &&
  "#11487: gh falso é shim bash; no Windows spawnSync('gh') sem shell acha só .exe e o gh real venceria";

/** Linha que responde à sonda; vai logo depois do shebang (bash ou node). */
const PROBE_LINE_SH = `if [ "\${1:-}" = "${FAKE_GH_PROBE_ARG}" ]; then echo "${FAKE_GH_PROBE_REPLY}"; exit 0; fi`;
const PROBE_LINE_NODE = `if (process.argv[2] === ${JSON.stringify(FAKE_GH_PROBE_ARG)}) { process.stdout.write(${JSON.stringify(FAKE_GH_PROBE_REPLY + "\n")}); process.exit(0); }`;

/**
 * Escreve o shim `gh` em `dir` (cria o executável) a partir de um script com
 * shebang, inserindo a resposta à sonda depois da 1ª linha. Devolve o caminho.
 */
export function writeFakeGh(dir: string, script: string): string {
  if (!script.startsWith("#!")) {
    throw new Error("[fake-gh #11487] o script do gh falso precisa começar com shebang (#!)");
  }
  const nl = script.indexOf("\n");
  const shebang = nl === -1 ? script : script.slice(0, nl);
  const rest = nl === -1 ? "" : script.slice(nl + 1);
  const path = join(dir, "gh");
  const probe = /\bnode\b/.test(shebang) ? PROBE_LINE_NODE : PROBE_LINE_SH;
  writeFileSync(path, `${shebang}\n${probe}\n${rest}`, "utf8");
  chmodSync(path, 0o755);
  return path;
}

let emptyConfigDir: string | undefined;
function isolatedConfigDir(): string {
  if (!emptyConfigDir) {
    emptyConfigDir = mkdtempSync(join(tmpdir(), "fake-gh-config-vazio-"));
    const d = emptyConfigDir;
    process.on("exit", () => {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        // diretório temporário: o SO limpa depois
      }
    });
  }
  return emptyConfigDir;
}

/** Chave do PATH no env (no Windows costuma ser `Path`). */
function pathKey(env: NodeJS.ProcessEnv): string {
  return Object.keys(env).find((k) => k.toLowerCase() === "path") ?? "PATH";
}

/** Só a neutralização de credencial (defesa 2), sem mexer no PATH nem sondar. */
export function withoutGhCredentials(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env };
  delete out.GH_ENTERPRISE_TOKEN;
  delete out.GITHUB_ENTERPRISE_TOKEN;
  out.GH_TOKEN = FAKE_GH_INVALID_TOKEN;
  out.GITHUB_TOKEN = FAKE_GH_INVALID_TOKEN;
  out.GH_HOST = FAKE_GH_INVALID_HOST;
  out.GH_CONFIG_DIR = isolatedConfigDir();
  return out;
}

/**
 * Lança se o `gh` que `env` resolve não for o shim de `writeFakeGh`. Usa a
 * mesma forma de spawn dos scripts sob teste (`spawnSync("gh")`, sem shell).
 */
export function assertFakeGhResolves(env: NodeJS.ProcessEnv): void {
  const r = spawnSync("gh", [FAKE_GH_PROBE_ARG], { env, encoding: "utf8", timeout: 15_000 });
  const out = (r.stdout ?? "").trim();
  if (out !== FAKE_GH_PROBE_REPLY) {
    const detalhe = r.error ? String(r.error.message) : `status=${r.status} stdout=${JSON.stringify(out.slice(0, 120))}`;
    throw new Error(
      `[fake-gh #11487] o gh resolvido no PATH NÃO é o falso (${detalhe}). ` +
        `Abortando antes de qualquer chamada: um gh real escreveria no GitHub com a credencial de quem roda a suíte.`,
    );
  }
}

/**
 * Ambiente para rodar um script com o `gh` falso de `fakeDir` na frente do
 * PATH: delimitador da plataforma, credenciais neutralizadas e sonda. Lança se
 * o `gh` resolvido não for o falso. `extra` entra por cima de `base`.
 */
export function fakeGhEnv(
  fakeDir: string,
  extra: NodeJS.ProcessEnv = {},
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const merged: NodeJS.ProcessEnv = { ...base, ...extra };
  const key = pathKey(merged);
  const oldPath = merged[key] ?? "";
  for (const k of Object.keys(merged)) if (k.toLowerCase() === "path") delete merged[k];
  merged[key] = oldPath ? `${fakeDir}${delimiter}${oldPath}` : fakeDir;
  const env = withoutGhCredentials(merged);
  assertFakeGhResolves(env);
  return env;
}
