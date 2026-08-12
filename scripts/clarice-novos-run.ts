#!/usr/bin/env node
/**
 * clarice-novos-run.ts (#4941)
 *
 * Orquestrador DETERMINÍSTICO dos Passos 0-7 de `/diaria-clarice-novos`
 * (#4347) — condição de existir: `scripts/lib/scheduled-tasks.ts` só modela
 * passos com args ESTÁTICOS, sem fluxo de dados entre eles, e a skill em
 * prosa (`.claude/skills/diaria-clarice-novos/SKILL.md`) tem o LLM como
 * *glue* — extrai valores do JSON de um passo e injeta no próximo, decide
 * ramos condicionais, aborta em guard. Isso é incompatível com uma task
 * agendada diária (11:00 BRT desde o #5140 — antes 17:00, `Diaria-Clarice-Novos`): julgamento
 * não-determinístico no caminho de um envio de e-mail real e irreversível
 * contraria a regra do #573 ("validar via TS determinístico"). Este script
 * é o *glue* em código — a skill (invocação manual, ad-hoc) passa a
 * DELEGAR pra ele em vez de reimplementar os 7 passos em prosa, pra não
 * nascerem duas implementações divergindo em silêncio (o exato modo de
 * falha que o review do #4936 pegou num arquivo vizinho).
 *
 * Cada sub-script é invocado por SPAWN (`process.execPath --import tsx`,
 * nunca `npx tsx` — mesmo guard #4343 de `scripts/lib/task-runner.ts`),
 * NUNCA por import — spawn preserva o resumo JSON em stdout e o exit code
 * como contrato, que é de onde os 9 guards do #4347 tiram sua força. Importar
 * duplicaria a lógica de guard num segundo lugar (a classe de bug que este
 * repo mais repete — ver `CommittedGuardScope` em clarice-segment.ts).
 *
 * Kill switch (#4941, decisão E3): antes de QUALQUER chamada externa, checa
 * `scripts/lib/clarice-novos-enabled.ts`. Ausente/`false` (default seguro) →
 * sai limpo (exit 0), grava relatório "pausado", zero chamadas de escrita —
 * substitui o kill switch que a invocação manual tinha ("simplesmente não
 * rodar a skill de novo").
 *
 * Exit codes:
 *   0 — sucesso (disparado / rodada vazia / pausado pelo toggle / dry-run concluído)
 *   1 — erro duro (guard abortou, sub-script falhou, exceção inesperada)
 *   2 — disparo INCERTO (POST sendNow aceito, GET-verify não confirmou status
 *       terminal — mesma semântica de exit 2 do `clarice-schedule-group.ts
 *       --send-now`) — NÃO declarar sucesso; a rodada de amanhã reconcilia
 *       (idempotente por key/campanha).
 *
 * Uso:
 *   npx tsx scripts/clarice-novos-run.ts [--since YYYY-MM-DD] [--dry-run] \
 *     [--force] [--subject "Assunto explícito"] [--confirm]
 *
 * `--dry-run` roda os Passos 0-3 (delta Stripe em modo preview, MV pulado —
 * custo real, nunca gasto sem intenção — e o grupo `novos` construído com
 * `--dry-run`) e PARA — não cria lista, não cria campanha, não envia nada.
 * É o modo recomendado pra validar a instalação numa máquina nova (mesma
 * recomendação da SKILL.md original).
 *
 * `--force`/`--confirm` NUNCA são passados automaticamente pela task
 * agendada (que roda sem flags) — só existem pra invocação manual explícita
 * do editor depois de ver um abort do teto de 500 (D13) ou do guard de custo
 * MV (D8). Ver SKILL.md § Notas operacionais.
 *
 * @see .claude/skills/diaria-clarice-novos/SKILL.md (passos 0-7 em prosa —
 *      espelha este script; caminho MANUAL, delega pra cá)
 * @see scripts/lib/scheduled-tasks.ts (entrada "Diaria-Clarice-Novos")
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { getArg, hasFlag, isMainModule } from "./lib/cli-args.ts";
import { detectExecMode } from "./lib/exec-mode.ts";
import { isClariceNovosEnabled } from "./lib/clarice-novos-enabled.ts";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { clariceActivityDepsFromDisk, mostRecentActiveClariceCycle } from "./lib/mensal/monthly-paths.ts";
import type { ResolveLatestMonthlyCycleResult } from "./lib/mensal/monthly-paths.ts";
import { datePartsInTz, toAammdd, BRT_TIMEZONE, type DateParts } from "./lib/next-edition-date.ts";
import { registerReport } from "./studio-ui/studio-reports.ts";
import type { InvocationSummary } from "./clarice-schedule-group.ts";
import type { ResolveFolderResult } from "./clarice-resolve-folder.ts";

// #4983 — achado ao vivo na 1ª invocação real da task agendada (260811): o
// preflight do Passo 0 (abaixo) lê `process.env` diretamente, mas este é o
// processo ORQUESTRADOR — só os sub-scripts SPAWNADOS (clarice-stripe-delta.ts
// e ~8 outros) chamavam `loadProjectEnv()` para carregar `.env`. O
// orquestrador nunca lia `.env` sozinho, então o preflight abortava mesmo com
// as 3 keys presentes em `.env` — barrando na porta um fluxo que teria
// funcionado inteiro (cada sub-script já carregava o próprio `.env`
// corretamente). Chamada em module scope, ANTES de qualquer outro código,
// para que `process.env` já esteja populado quando `runNovos` checar as keys
// no Passo 0 — ver `test/clarice-novos-run.test.ts` para o teste que trava
// essa ORDEM (não só o comportamento final).
loadProjectEnv();

const ROOT = resolve(new URL("..", import.meta.url).pathname);

// ---------------------------------------------------------------------------
// Spawn de sub-script — injetável pra teste (nenhum spawn real nos testes).
// ---------------------------------------------------------------------------

export interface StepResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type ExecFn = (scriptRelPath: string, args: string[]) => StepResult;

/** Default de produção — mesmo padrão de `execTsxStep` (task-runner.ts):
 * `process.execPath` absoluto, nunca `npx`/PATH-resolved (guard #4343). */
export function realExec(rootDir: string): ExecFn {
  return (scriptRelPath, args) => {
    const abs = resolve(rootDir, ...scriptRelPath.split("/"));
    const result = spawnSync(process.execPath, ["--import", "tsx", abs, ...args], {
      cwd: rootDir,
      encoding: "utf8",
    });
    if (result.error || result.status === null) {
      return {
        code: 1,
        stdout: result.stdout ?? "",
        stderr: (result.stderr ?? "") + `\nERRO: o passo nao executou (falha de spawn): ${result.error?.message ?? "status null"}\n`,
      };
    }
    return { code: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  };
}

/** Extrai o bloco JSON de stdout a partir do PRIMEIRO `{`/`[` — todo
 * sub-script deste fluxo imprime logs humano-legíveis em stderr e o resumo
 * JSON (só) em stdout via `console.log(JSON.stringify(...))`, então stdout
 * inteiro normalmente já É o JSON; localizar o primeiro `{`/`[` e parsear
 * até o fim é defesa extra contra qualquer prefixo perdido antes dele
 * (não protege contra sufixo — nenhum sub-script deste fluxo imprime nada
 * em stdout depois do JSON). */
export function parseStepJson<T = unknown>(stdout: string): T | undefined {
  const trimmed = stdout.trim();
  if (!trimmed) return undefined;
  const start = Math.min(...["{", "["].map((c) => trimmed.indexOf(c)).filter((i) => i >= 0));
  if (!Number.isFinite(start)) return undefined;
  try {
    return JSON.parse(trimmed.slice(start)) as T;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Abort tipado — carrega o motivo até o relatório final.
// ---------------------------------------------------------------------------

/** Sempre `code: 1` — o exit code 2 ("disparo incerto") NUNCA passa por
 * exceção, é um `return` antecipado dentro de `runNovos` (o desfecho não é
 * um erro, é um resultado ambíguo que a rodada de amanhã reconcilia
 * sozinha). Um `1 | 2` no tipo aqui sugeria uma uniformidade que não
 * existe no controle de fluxo real — achado do review do #4949. */
export class NovosAbort extends Error {
  readonly code = 1 as const;
  constructor(reason: string) {
    super(reason);
    this.name = "NovosAbort";
  }
}

// ---------------------------------------------------------------------------
// Opções da CLI
// ---------------------------------------------------------------------------

export interface NovosRunOptions {
  since?: string;
  dryRun: boolean;
  force: boolean;
  subject?: string;
  confirm: boolean;
}

export function parseNovosRunArgs(argv: string[]): NovosRunOptions {
  return {
    since: getArg(argv, "since") || undefined,
    dryRun: hasFlag(argv, "dry-run"),
    force: hasFlag(argv, "force"),
    subject: getArg(argv, "subject") || undefined,
    confirm: hasFlag(argv, "confirm"),
  };
}

// ---------------------------------------------------------------------------
// Datas — AAMMDD/DD-MM em BRT (mesmo helper de next-edition-date.ts, "hoje"
// em vez de "amanhã").
// ---------------------------------------------------------------------------

export function todayPartsBrt(now: Date): DateParts {
  return datePartsInTz(now, BRT_TIMEZONE);
}

export function todayAammdd(now: Date): string {
  return toAammdd(todayPartsBrt(now));
}

function ddmm(parts: DateParts): string {
  return `${String(parts.day).padStart(2, "0")}/${String(parts.month).padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------
// Deps injetáveis — produção usa os defaults reais; testes injetam fakes.
// ---------------------------------------------------------------------------

export interface NovosRunDeps {
  rootDir: string;
  now: () => Date;
  exec: ExecFn;
  isEnabled: () => boolean;
  resolveEnvioCycle: () => string | undefined;
  /** Injetável (não `detectExecMode` direto) — testes rodam num `rootDir`
   * temporário sem junction `data/` real, e o sinal de exec-mode não deve
   * depender disso pra ser exercitado. */
  execMode: () => "local" | "cloud";
}

export function productionDeps(rootDir: string = ROOT): NovosRunDeps {
  return {
    rootDir,
    now: () => new Date(),
    exec: realExec(rootDir),
    isEnabled: () => isClariceNovosEnabled(rootDir),
    resolveEnvioCycle: () => mostRecentActiveClariceCycle(clariceActivityDepsFromDisk()),
    execMode: () => detectExecMode({ projectRoot: rootDir }),
  };
}

// ---------------------------------------------------------------------------
// Relatório — markdown acumulado + registro (#3714) mesmo nos caminhos de
// abort (#4941 escopo 1: uma rodada agendada que aborta em silêncio é
// indistinguível de uma que não rodou — diferente da skill manual original,
// que só descrevia o Passo 7 no caminho feliz).
// ---------------------------------------------------------------------------

export interface NovosRunResult {
  code: 0 | 1 | 2;
  reportId: string;
  reportMarkdown: string;
}

class ReportBuilder {
  private lines: string[] = [];
  constructor(readonly title: string) {
    this.lines.push(`# ${title}`, "");
  }
  note(line: string): void {
    this.lines.push(`- ${line}`);
    console.error(line);
  }
  section(heading: string): void {
    this.lines.push("", `## ${heading}`, "");
  }
  build(): string {
    return this.lines.join("\n") + "\n";
  }
}

function writeAndRegisterReport(deps: NovosRunDeps, reportId: string, title: string, markdown: string): void {
  const dir = resolve(deps.rootDir, "data", "clarice-subscribers", "novos-reports");
  mkdirSync(dir, { recursive: true });
  const relPath = `data/clarice-subscribers/novos-reports/${reportId}.md`;
  writeFileSync(resolve(deps.rootDir, relPath), markdown, "utf8");
  const result = registerReport(deps.rootDir, { kind: "clarice-novos", sessionId: reportId, title, htmlPath: relPath });
  if (!result.ok) {
    console.error(`[clarice-novos-run] aviso: registro do relatório falhou (fail-soft, #3714): ${result.error}`);
  }
  // Fire-and-forget de propósito (mesmo padrão de send-edition-report.ts e
  // do --finalize de clarice-novos-html-state.ts) — o processo Node não
  // encerra até o fetch pendente do e-mail assentar, mesmo sem await.
}

// ---------------------------------------------------------------------------
// Passo runner — spawna, loga, e devolve o JSON parseado (ou lança NovosAbort
// se o exit code não for aceito por `okCodes`).
// ---------------------------------------------------------------------------

function step<T = unknown>(
  deps: NovosRunDeps,
  report: ReportBuilder,
  label: string,
  scriptRelPath: string,
  args: string[],
  okCodes: number[] = [0],
): { result: StepResult; json: T | undefined } {
  report.note(`▶ ${label}`);
  const result = deps.exec(scriptRelPath, args);
  if (result.stderr.trim()) console.error(result.stderr.trim());
  if (!okCodes.includes(result.code)) {
    const detail = result.stderr.trim().split("\n").slice(-6).join(" | ") || "(sem stderr)";
    throw new NovosAbort(`❌ ${label} falhou (exit ${result.code}): ${detail}`);
  }
  return { result, json: parseStepJson<T>(result.stdout) };
}

// ---------------------------------------------------------------------------
// Orquestração principal — pura o suficiente pra ser testada com `exec`/`now`
// injetados, sem rede nem `data/` real.
// ---------------------------------------------------------------------------

export async function runNovos(argv: string[], deps: NovosRunDeps): Promise<NovosRunResult> {
  const opts = parseNovosRunArgs(argv);
  const now = deps.now();
  const aammdd = todayAammdd(now);
  const report = new ReportBuilder(`diar.ia.br Clarice novos ${aammdd}`);

  // --- Kill switch (#4941 E3) — ANTES de qualquer chamada externa. ---
  if (!deps.isEnabled()) {
    report.note(
      "⏸️  automação PAUSADA (data/clarice-novos-enabled.json ausente ou {enabled:false}) — " +
        "nenhuma chamada Stripe/MV/Brevo feita. Rode `npx tsx scripts/lib/clarice-novos-enabled.ts --set enabled` pra liberar.",
    );
    const reportId = `novos-${aammdd}-paused`;
    writeAndRegisterReport(deps, reportId, `diar.ia.br Clarice novos ${aammdd} — pausado`, report.build());
    return { code: 0, reportId, reportMarkdown: report.build() };
  }

  try {
    // --- Passo 0: preflight ---
    report.section("Passo 0 — Preflight");
    if (deps.execMode() !== "local") {
      throw new NovosAbort(
        "❌ exec-mode != local — esta rotina precisa do junction data/ (Stripe/Brevo/MV reais). " +
          "Não roda em sessão cloud.",
      );
    }
    for (const envVar of ["STRIPE_API_KEY", "BREVO_CLARICE_API_KEY", "MILLION_VERIFIER_API_KEY"]) {
      if (!process.env[envVar]) throw new NovosAbort(`❌ ${envVar} não definida.`);
    }
    const stale = step(deps, report, "clarice-check-derived-stale", "scripts/clarice-check-derived-stale.ts", []);
    if (String(stale.result.stdout).trim() === "stale") {
      report.note("↻ store derivado stale — reingerindo (clarice-build-db.ts) antes de montar a rodada.");
      step(deps, report, "clarice-build-db (pré-stale)", "scripts/clarice-build-db.ts", []);
    }

    // --- Passo 1: delta Stripe → store ---
    report.section("Passo 1 — Delta Stripe → store");
    const deltaArgs = ["--execute", ...(opts.since ? ["--since", opts.since] : [])];
    const delta = step<{ since?: string; rows?: number }>(
      deps,
      report,
      "clarice-stripe-delta --execute",
      "scripts/clarice-stripe-delta.ts",
      opts.dryRun ? deltaArgs.filter((a) => a !== "--execute") : deltaArgs,
    );
    const since = delta.json?.since;
    if (!since) throw new NovosAbort("❌ clarice-stripe-delta não devolveu 'since' no resumo JSON — não dá pra prosseguir sem saber a janela usada.");
    report.note(`since efetivo: ${since} (${delta.json?.rows ?? "?"} cliente(s) no delta)`);
    step(deps, report, "clarice-build-db (pós-delta)", "scripts/clarice-build-db.ts", []);

    // --- Resolve {CICLO_ENVIO} — determinístico, ambiguidade aborta (#4941) ---
    const cicloEnvio = deps.resolveEnvioCycle();
    if (!cicloEnvio) {
      throw new NovosAbort(
        "❌ nenhum ciclo Clarice com atividade real em data/clarice-subscribers/ — não dá pra resolver " +
          "{CICLO_ENVIO} automaticamente (1ª rodada da automação numa base sem histórico precisa de setup manual).",
      );
    }
    report.note(`ciclo de envio resolvido: ${cicloEnvio}`);

    if (opts.dryRun) {
      report.note("ℹ️  --dry-run: MV pulado (custo real de crédito, nunca gasto sem intenção).");
    } else {
      // --- Passo 2: MV roteado por cohort (guard de custo D8) ---
      report.section("Passo 2 — MV roteado por cohort");
      step(
        deps,
        report,
        "verify-emails-mv --since",
        "scripts/verify-emails-mv.ts",
        ["--since", since, "--cycle", cicloEnvio, ...(opts.confirm ? ["--confirm"] : [])],
      );
      step(deps, report, "clarice-build-db (pós-MV, #4362)", "scripts/clarice-build-db.ts", []);
    }

    // --- Semáforo (D4) ---
    report.section("Passo 3 — Grupo 'novos' (D13 + D4)");
    step(deps, report, "clarice-check-semaphore", "scripts/clarice-check-semaphore.ts", []);

    // --- Grupo novos (--hold juridico obrigatório, #4542) ---
    const segmentArgs = [
      "--group",
      "novos",
      "--since",
      since,
      "--cycle",
      cicloEnvio,
      "--hold",
      "juridico",
      ...(opts.dryRun ? ["--dry-run"] : []),
      ...(opts.force ? ["--force"] : []),
    ];
    const segment = step<{ selected?: number; hold?: string }>(
      deps,
      report,
      "clarice-build-segment --group novos",
      "scripts/clarice-build-segment.ts",
      segmentArgs,
    );
    // Sanity check (#4542) — se --hold não aparece no resumo, a flag não
    // chegou ao script: bug de CÓDIGO deste orquestrador, não condição
    // operacional — falha alto em vez de arriscar vazar o cohort jurídico.
    if (segment.json?.hold !== "juridico") {
      throw new NovosAbort(
        `❌ clarice-build-segment não confirmou --hold juridico no resumo (hold="${segment.json?.hold}") — ` +
          `abortando por segurança (#4542, risco de vazar cohort jurídico reservado).`,
      );
    }
    const selected = segment.json?.selected ?? 0;
    report.note(`grupo 'novos': ${selected} contato(s) selecionado(s).`);

    if (selected === 0) {
      report.note("ℹ️  0 contato(s) — rodada vazia, não é erro. Nada a importar/disparar.");
      const reportId = `novos-${aammdd}-empty`;
      writeAndRegisterReport(deps, reportId, `diar.ia.br Clarice novos ${aammdd} — 0 contatos`, report.build());
      return { code: 0, reportId, reportMarkdown: report.build() };
    }

    if (opts.dryRun) {
      report.note("ℹ️  --dry-run: parando aqui (Passos 0-3) — nenhuma lista/campanha criada, nada enviado.");
      const reportId = `novos-${aammdd}-dry-run`;
      writeAndRegisterReport(deps, reportId, `diar.ia.br Clarice novos ${aammdd} — dry-run`, report.build());
      return { code: 0, reportId, reportMarkdown: report.build() };
    }

    // --- Passo 4: resolver a key + import Brevo ---
    report.section("Passo 4 — Key da campanha + import Brevo");
    const keyStep = step<{ key: string }>(
      deps,
      report,
      "clarice-novos-resolve-key",
      "scripts/clarice-novos-resolve-key.ts",
      ["--cycle", cicloEnvio, "--date", aammdd],
    );
    const key = keyStep.json?.key;
    if (!key) throw new NovosAbort("❌ clarice-novos-resolve-key não devolveu 'key' no resumo JSON.");
    report.note(`key resolvida: ${key}`);

    const folderStep = step<ResolveFolderResult>(
      deps,
      report,
      "clarice-resolve-folder",
      "scripts/clarice-resolve-folder.ts",
      ["--name", "Clarice novos"],
    );
    const folderId = folderStep.json?.folderId ?? 1;

    step(
      deps,
      report,
      "clarice-import-waves --group novos --execute",
      "scripts/clarice-import-waves.ts",
      [
        "--cycle",
        cicloEnvio,
        "--group",
        "novos",
        "--key",
        key,
        // #4949 review (achado 1, correctness): --label precisa carregar a
        // MESMA key resolvida acima, não só a data — sem isso, um retry no
        // mesmo dia (resolveNovosKey já sufixa -2/-3) gera o mesmo nome de
        // lista Brevo da 1ª tentativa (label + wave.key + wave.desc do
        // grupo 'novos' são todos constantes por dia em resolveListName), e
        // o pré-flight de idempotência de clarice-import-waves.ts aborta
        // com "lista já existe" — derrotando o propósito do sufixo de key.
        "--label",
        `Novos ${ddmm(todayPartsBrt(now))} (${key})`,
        "--folder-id",
        String(folderId),
        "--execute",
      ],
    );

    // --- Passo 5: resolver a edição + criar a campanha (sem data) ---
    report.section("Passo 5 — Resolver edição + criar campanha");
    const cycleStep = step<ResolveLatestMonthlyCycleResult>(
      deps,
      report,
      "clarice-novos-resolve-cycle",
      "scripts/clarice-novos-resolve-cycle.ts",
      opts.subject ? ["--subject", opts.subject] : [],
    );
    const cicloMensal = cycleStep.json?.cycle;
    const assunto = opts.subject || cycleStep.json?.subject;
    if (!cicloMensal || !assunto) throw new NovosAbort("❌ clarice-novos-resolve-cycle não devolveu 'cycle'/'subject' no resumo JSON.");
    if (cycleStep.json?.fallback) report.note(`⚠️  ciclo mais recente não estava pronto — caiu em ${cicloMensal} (D3, registrado).`);
    report.note(`ciclo mensal (conteúdo): ${cicloMensal} — assunto: "${assunto}"`);

    const contentCycleArgs = cicloMensal === cicloEnvio ? [] : ["--content-cycle", cicloMensal];
    step(
      deps,
      report,
      "clarice-schedule-group --create",
      "scripts/clarice-schedule-group.ts",
      ["--cycle", cicloEnvio, ...contentCycleArgs, "--group", "novos", "--key", key, "--subject", assunto, "--create"],
    );

    // --- Passo 6: test email condicional (D12) + envio imediato ---
    report.section("Passo 6 — Test email (D12) + envio");
    const htmlState = step<{ shouldSendTest: boolean }>(
      deps,
      report,
      "clarice-novos-html-state",
      "scripts/clarice-novos-html-state.ts",
      ["--cycle", cicloMensal],
    );
    // #4949 review (silent-failure, achado 3): default TRUE quando o JSON
    // não parseou (`?? true`) — D12 é só uma otimização (pular test email
    // redundante), nunca uma trava de segurança; na dúvida, mandar o test
    // email A MAIS é o lado seguro, o oposto de pular silenciosamente um
    // teste que devia ter rodado.
    if (htmlState.json?.shouldSendTest ?? true) {
      step(
        deps,
        report,
        "clarice-schedule-group --send-test",
        "scripts/clarice-schedule-group.ts",
        ["--cycle", cicloEnvio, ...contentCycleArgs, "--group", "novos", "--key", key, "--send-test"],
      );
    } else {
      report.note("↷ SHA do HTML idêntico à última rodada (D12) — pulando --send-test.");
    }

    const sendNow = deps.exec("scripts/clarice-schedule-group.ts", [
      "--cycle",
      cicloEnvio,
      ...contentCycleArgs,
      "--group",
      "novos",
      "--key",
      key,
      "--send-now",
    ]);
    if (sendNow.stderr.trim()) console.error(sendNow.stderr.trim());
    const sendJson = parseStepJson<InvocationSummary>(sendNow.stdout);
    const reportIdSent = key; // key já inclui o prefixo "novos-" (resolveNovosKey)

    if (sendNow.code === 2) {
      report.note(
        `⚠️  disparo INCERTO — POST sendNow aceito mas GET-verify não confirmou status terminal ` +
          `(status="${sendJson?.status ?? "?"}"). NÃO declarado como sucesso. A rodada de amanhã reconcilia ` +
          `(idempotente por key/campanha, re-tentar --send-now é seguro).`,
      );
      writeAndRegisterReport(deps, reportIdSent, `diar.ia.br Clarice novos ${aammdd} — disparo incerto`, report.build());
      return { code: 2, reportId: reportIdSent, reportMarkdown: report.build() };
    }
    if (sendNow.code !== 0) {
      throw new NovosAbort(`❌ clarice-schedule-group --send-now falhou (exit ${sendNow.code}): ${sendNow.stderr.trim().split("\n").slice(-6).join(" | ")}`);
    }
    // #4949 review (correctness, achado 2): exit 0 do sub-script não é, por
    // si só, garantia de "sent" — `checkSendNowGuard` pode devolver exit 0
    // sem re-disparar quando o status AO VIVO já é "queued" (retry manual
    // da MESMA key/campanha, fora do fluxo deste orquestrador — que sempre
    // resolve uma key nova, mas um chamador direto de
    // clarice-schedule-group.ts poderia). Tratar como incerto (código 2) em
    // vez de assumir sucesso — nunca declarar "confirmado" sem o status
    // literal "sent" no resumo.
    if (sendJson?.status !== "sent") {
      report.note(
        `⚠️  --send-now saiu exit 0 mas status="${sendJson?.status ?? "desconhecido"}" (esperado "sent") — ` +
          `tratando como disparo INCERTO por segurança, não declarando sucesso.`,
      );
      writeAndRegisterReport(deps, reportIdSent, `diar.ia.br Clarice novos ${aammdd} — disparo incerto`, report.build());
      return { code: 2, reportId: reportIdSent, reportMarkdown: report.build() };
    }
    report.note(`✅ disparo confirmado (status="sent") — ${selected} contato(s).`);

    if (!sendJson?.listId || !sendJson?.campaignId) {
      // #4949 review (silent-failure, achado 2): NÃO usar NovosAbort aqui —
      // o disparo já aconteceu (irreversível), então o resultado desta
      // rodada é SUCESSO, mesmo que o --finalize não tenha os dados pra
      // rodar. Lançar faria o catch externo reportar "abortado", misreportando
      // um envio real como falha.
      report.note(
        `⚠️  disparo confirmado mas o resumo de --send-now não trouxe listId/campaignId ` +
          `(listId=${sendJson?.listId}, campaignId=${sendJson?.campaignId}) — --finalize NÃO rodado nesta ` +
          `rodada (state fica com o SHA/sentCount desatualizados, sem afetar o envio já feito). Rode manualmente: ` +
          `clarice-novos-html-state.ts --cycle ${cicloMensal} --finalize --list-id N --campaign-id N --sent-count ${selected}`,
      );
      writeAndRegisterReport(deps, reportIdSent, `diar.ia.br Clarice novos ${aammdd} — ${selected} contato(s)`, report.build());
      return { code: 0, reportId: reportIdSent, reportMarkdown: report.build() };
    }

    // #4949 review (silent-failure, achado 2): --finalize é uma escrita
    // LOCAL de state (SHA/sentCount/D12) — se ela falhar depois do disparo
    // já confirmado, o resultado da rodada continua sendo SUCESSO (o envio
    // real já aconteceu e é irreversível). Capturado localmente, nunca
    // propagado pro catch externo (que reportaria "abortado" por cima de
    // um envio bem-sucedido).
    try {
      step(
        deps,
        report,
        "clarice-novos-html-state --finalize",
        "scripts/clarice-novos-html-state.ts",
        [
          "--cycle",
          cicloMensal,
          "--finalize",
          "--list-id",
          String(sendJson.listId),
          "--campaign-id",
          String(sendJson.campaignId),
          "--sent-count",
          String(selected),
        ],
      );
    } catch (finalizeError) {
      report.note(
        `⚠️  disparo confirmado (${selected} contato(s)) mas --finalize falhou: ` +
          `${(finalizeError as Error).message} — state (SHA/sentCount) fica desatualizado, sem afetar o ` +
          `envio já feito. Rode manualmente: clarice-novos-html-state.ts --cycle ${cicloMensal} --finalize ` +
          `--list-id ${sendJson.listId} --campaign-id ${sendJson.campaignId} --sent-count ${selected}`,
      );
    }

    writeAndRegisterReport(deps, reportIdSent, `diar.ia.br Clarice novos ${aammdd} — ${selected} contato(s)`, report.build());
    return { code: 0, reportId: reportIdSent, reportMarkdown: report.build() };
  } catch (e) {
    const abort = e instanceof NovosAbort ? e : new NovosAbort(`❌ erro inesperado: ${(e as Error).message}`);
    report.note(abort.message);
    const reportId = `novos-${aammdd}-abort`;
    writeAndRegisterReport(deps, reportId, `diar.ia.br Clarice novos ${aammdd} — abortado`, report.build());
    return { code: abort.code, reportId, reportMarkdown: report.build() };
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

if (isMainModule(import.meta.url)) {
  const deps = productionDeps(ROOT);
  runNovos(process.argv.slice(2), deps)
    .then((r) => {
      // #4949 review (silent-failure, achado 1, HIGH): `process.exit()` no
      // sucesso força o shutdown do libuv ANTES do fetch pendente do e-mail
      // de notificação (fire-and-forget em writeAndRegisterReport) assentar
      // — mesma classe de bug já corrigida caso a caso neste repo (#1401,
      // #4638, #4651, consolidada em `runMain`/exit-handler.ts #4653).
      // `process.exitCode` deixa o event loop drenar sozinho: o processo
      // termina com o código certo assim que não sobrar handle pendente,
      // sem matar o e-mail no meio do caminho.
      process.exitCode = r.code;
    })
    .catch((e) => {
      console.error(String((e as Error)?.stack || e));
      process.exitCode = 1;
    });
}
