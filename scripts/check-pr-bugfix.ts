/**
 * check-pr-bugfix.ts (#970, #2060)
 *
 * Roda em GH Action `pr-checks.yml` pra cada PR. Detecta se o PR é bugfix
 * (heurística por título "fix:" / closes label `bug` / etc) e, se for,
 * verifica se há teste novo no diff. Sem teste, exige label `no-regression-test`
 * + justificativa explícita no body.
 *
 * Implementa o invariante #633: "PR de bugfix exige teste de regressão".
 *
 * #2060: 3 melhorias de resiliência:
 *   1. `getPrLabels` (e qualquer chamada `gh`) tem retry+backoff (3 tentativas,
 *      10–30s) pra 401/5xx/timeout transitórios — 401 intermitente da API do
 *      GitHub virava exit 2 (infra), indistinguível de "bugfix sem teste".
 *   2. REORDENAÇÃO: checar o diff PRIMEIRO — se já tem teste novo, o gate passa
 *      sem precisar da API (a API só é necessária pra exceção via label). Isso
 *      elimina a dependência da API quando ela não é necessária.
 *   3. Erro de infra após N tentativas emite mensagem distinta:
 *      "[#970] INFRA: não foi possível consultar a API após N tentativas".
 *
 * Env vars (passados pelo GH Action):
 *   GH_TOKEN     — auth pra gh CLI
 *   PR_BODY      — body do PR
 *   PR_TITLE     — título do PR
 *   PR_NUMBER    — número do PR
 *   BASE_SHA     — sha do base (master) na hora do PR
 *   HEAD_SHA     — sha do head (PR branch) na hora do PR
 *
 * Exit codes:
 *   0 — passa (não é bugfix, OU é bugfix com teste novo, OU é bugfix com label de exceção)
 *   1 — falha (é bugfix sem teste novo e sem label de exceção)
 *   2 — input inválido / erro de gh CLI irrecuperável
 */

import { spawnSync } from "node:child_process";

export function isBugfixPr(title: string, body: string, labels: string[]): boolean {
  // Heurísticas pra detectar bug fix:
  if (labels.includes("bug")) return true;
  if (/^fix(\(|:)/i.test(title)) return true;
  // "closes #N" no body onde #N é label `bug` — mais caro de checar via API,
  // skip pra MVP. Title + label cobrem ~95% dos casos.
  if (/\b(bugfix|fixe|hotfix)\b/i.test(title)) return true;
  return false;
}

export function hasExceptionLabel(labels: string[]): boolean {
  return labels.includes("no-regression-test");
}

function getChangedFiles(baseSha: string, headSha: string): string[] {
  const r = spawnSync("git", ["diff", "--name-status", `${baseSha}..${headSha}`], {
    encoding: "utf8",
  });
  if (r.status !== 0) {
    throw new Error(`git diff failed: ${r.stderr}`);
  }
  const paths: string[] = [];
  for (const line of r.stdout.split("\n")) {
    if (!line.trim()) continue;
    const parts = line.split("\t");
    const status = parts[0];
    if (status === "A" || status === "M") {
      paths.push(parts[1]);
    } else if (status?.startsWith("R")) {
      // #2082: rename — git diff --name-status emite "R{score}\t{old}\t{new}".
      // O path relevante é o novo nome (parts[2]), não o antigo.
      // Um teste renomeado conta como "modificado" para fins do invariante #633.
      paths.push(parts[2] ?? parts[1]);
    }
  }
  return paths;
}

export function hasNewOrModifiedTest(changedFiles: string[]): boolean {
  return changedFiles.some(
    (f) =>
      (f.startsWith("test/") || f.startsWith("tests/")) &&
      (f.endsWith(".test.ts") || f.endsWith(".test.js")),
  );
}

/**
 * #2060: Tipo do spawner injetável — aceita os mesmos args do spawnSync mas
 * retorna só o que o teste precisa mockar. Produção usa spawnSync diretamente.
 */
export type SpawnFn = (
  cmd: string,
  args: string[],
  opts: { encoding: "utf8" },
) => { status: number | null; stdout: string; stderr: string };

/** Delay real entre tentativas (produção). Em testes, substituído por mock via sleepFn. */
function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * #2060: getPrLabels com retry+backoff (3 tentativas, 10–20s).
 * Considera transitórios: status !== 0 (inclui 401, 5xx, timeout).
 * Lança após esgotar tentativas com mensagem distinta "[#970] INFRA:...".
 *
 * Delays: tentativa 1→2: 10s, tentativa 2→3: 20s. A 3ª tentativa não dorme
 * (último attempt não tem sleep), então o array tem 2 elementos (#2082).
 */
export async function getPrLabels(
  prNumber: string,
  spawnFn: SpawnFn = spawnSync as SpawnFn,
  sleepFn: (ms: number) => Promise<void> = sleepMs,
  maxAttempts = 3,
): Promise<string[]> {
  if (maxAttempts < 1) {
    // #2082: maxAttempts=0 geraria loop vazio e lançaria mensagem incoerente
    // "após 0 tentativas". Guard trivial.
    throw new Error(`[#970] INFRA: maxAttempts deve ser ≥ 1, recebido ${maxAttempts}`);
  }
  const backoffMs = [10_000, 20_000];
  let lastError = "";
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const r = spawnFn(
      "gh",
      ["pr", "view", prNumber, "--json", "labels", "--jq", ".labels[].name"],
      { encoding: "utf8" },
    );
    if (r.status === 0) {
      return r.stdout
        .split("\n")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
    }
    lastError = r.stderr || (r.status === null ? "processo morto por sinal — possível OOM/timeout do runner" : `exit ${r.status}`);
    if (attempt < maxAttempts) {
      const delay = backoffMs[attempt - 1] ?? 30_000;
      console.warn(
        `[#970] tentativa ${attempt}/${maxAttempts} falhou (${lastError.trim()}). Aguardando ${delay / 1000}s...`,
      );
      await sleepFn(delay);
    }
  }
  throw new Error(
    `[#970] INFRA: não foi possível consultar a API após ${maxAttempts} tentativas. Último erro: ${lastError.trim()}`,
  );
}

export function justificationInBody(body: string): boolean {
  // Procura indício de justificativa quando label `no-regression-test` é usado.
  // Lower bar: pelo menos 30 chars de contexto sobre por que não tem teste.
  const re = /no[-\s]?regression[-\s]?test:?\s*([^\n]{30,})/i;
  return re.test(body);
}

async function main(): Promise<void> {
  const prTitle = process.env.PR_TITLE ?? "";
  const prBody = process.env.PR_BODY ?? "";
  const prNumber = process.env.PR_NUMBER ?? "";
  const baseSha = process.env.BASE_SHA ?? "";
  const headSha = process.env.HEAD_SHA ?? "";

  if (!prNumber || !baseSha || !headSha) {
    console.error("[#970] env vars ausentes: PR_NUMBER, BASE_SHA, HEAD_SHA são obrigatórias.");
    process.exit(2);
  }

  // #2060: checar o diff PRIMEIRO — se o diff JÁ contém teste novo, o gate
  // passa sem precisar consultar a API (a API só é necessária pra validar a
  // exceção via label `no-regression-test`). Isso elimina a dependência da API
  // no caminho feliz (bugfix com teste), onde 401 transitório virava exit 2.

  let changedFiles: string[];
  try {
    changedFiles = getChangedFiles(baseSha, headSha);
  } catch (e) {
    console.error(`[#970] git diff falhou: ${(e as Error).message}`);
    process.exit(2);
  }

  if (hasNewOrModifiedTest(changedFiles)) {
    // Tem teste novo no diff: passa sem precisar da API em nenhum cenário.
    // (Se não é bugfix, também não precisaria — mas pode ser bugfix não-identificável
    // sem label, então a presença de teste é suficiente.)
    const testFiles = changedFiles.filter(
      (f) => (f.startsWith("test/") || f.startsWith("tests/")) && (f.endsWith(".test.ts") || f.endsWith(".test.js")),
    );
    console.log(`[#970] Diff contém teste(s) novo(s)/modificado(s): ${testFiles.join(", ")}. Pass.`);
    process.exit(0);
  }

  // Sem teste no diff: agora precisamos das labels para:
  //   (a) detectar label `bug` (isBugfixPr depende das labels)
  //   (b) detectar exceção `no-regression-test`
  // #2060: retry+backoff em getPrLabels — 401/5xx transitórios são recuperáveis.
  let labels: string[];
  try {
    labels = await getPrLabels(prNumber);
  } catch (e) {
    // Esgotadas as tentativas: INFRA — não indistinguível de "bugfix sem teste".
    // NOTA (#2082): (e as Error).message já começa com "[#970] INFRA:" — não
    // prefixar novamente ou geraria "[#970] [#970] INFRA:..." no log do GH Action.
    console.error((e as Error).message);
    process.exit(2);
  }

  if (!isBugfixPr(prTitle, prBody, labels)) {
    console.log(`[#970] PR não é bugfix (título='${prTitle.slice(0, 60)}', labels=${labels.join(",")}). Skip.`);
    process.exit(0);
  }

  if (hasExceptionLabel(labels)) {
    if (!justificationInBody(prBody)) {
      console.error(
        `[#970] PR tem label 'no-regression-test' mas falta justificativa no body.\n` +
          `       Adicione "no-regression-test: <razão clara em 30+ chars>" ao body.`,
      );
      process.exit(1);
    }
    console.log(`[#970] Bugfix sem teste mas com label de exceção + justificativa. Pass.`);
    process.exit(0);
  }

  console.error(
    [
      `[#970] PR de bugfix sem teste novo (regra #633).`,
      ``,
      `Adicione um teste de regressão (test/*.test.ts) que demonstre que o bug não voltaria,`,
      `OU adicione label 'no-regression-test' + justificativa no body explicando por que`,
      `o fix não pode ser testado (ex: "agent prompt", "config-only change").`,
      ``,
      `Title: ${prTitle}`,
      `Files changed: ${changedFiles.length}`,
      `Test files added/modified: 0`,
    ].join("\n"),
  );
  process.exit(1);
}

// Guard contra import em tests — só rodar main() quando invocado como CLI.
const _argv1 = process.argv[1]?.replaceAll("\\", "/") ?? "";
if (
  import.meta.url === `file://${_argv1}` ||
  import.meta.url === `file:///${_argv1.replace(/^\//, "")}`
) {
  main().catch((e) => {
    console.error(`[#970] erro não-tratado: ${(e as Error).message}`);
    process.exit(2);
  });
}
