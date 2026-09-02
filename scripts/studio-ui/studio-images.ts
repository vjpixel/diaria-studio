/**
 * studio-images.ts (#6447 Fatia 4, achados 6 + 9)
 *
 * Galeria de imagens por destaque (2:1, 1:1, card 4:5, carrossel de
 * parágrafos+CTA) e do É IA? (A/B) no painel de Revisão do Studio — leitura
 * PURA de disco via `existsSync` (fail-soft, nunca lança) — mais a ação
 * "Regenerar", que dispara a MESMA cadeia de scripts que o Stage 3 real roda
 * pra aquele destaque (`stage-3-run.ts`), só que a partir de um clique no
 * painel em vez do orchestrator.
 *
 * Cadeia de regeneração por destaque d{N} (espelha `stage-3-run.ts` linhas
 * ~420-502, ver docstring de lá — #6447 review, code-reviewer: a 1ª versão
 * desta cadeia pulava o lint pre-flight, permitindo que "Regenerar" pelo
 * painel produzisse uma imagem que uma rodada real de Stage 3 teria pausado):
 *   1. `lint-image-prompt.ts {prompt.md}` (#810 — pre-flight SEM custo,
 *      detecta violação da regra editorial — "Noite Estrelada", resolução em
 *      pixels — ANTES de gastar API call; exit 1 = violação encontrada,
 *      vira `job.error` sem chamar `image-generate.ts`)
 *   2. `image-generate.ts --destaque d{N} --force` (par 2x1/1x1 — chamada
 *      Gemini/ComfyUI PAGA, ver `platform.config.json` → `image_generator`)
 *   3. `image-generate.ts --destaque d{N} --ratio 4x5 --force` (4x5 nativo —
 *      2ª chamada paga)
 *   4. `gen-social-card-4x5.ts --destaque d{N}` (compõe o card 4:5 publicado
 *      a partir do nativo — sharp puro, sem custo de API)
 *   5. `gen-carousel-cards.ts --force` (recompõe os 4 slides sem foto do
 *      carrossel de TODOS os destaques a partir de `03-social.md` — sharp
 *      puro; roda pra todos, não só `d{N}`, porque o script não aceita
 *      escopo por destaque, e o custo é só render de texto, não API paga.
 *      **Risco de corrida cross-destaque (#6447 review, code-reviewer):**
 *      esse passo faz read-modify-write de `_internal/.carousel-source-
 *      hashes.json`, compartilhado entre TODOS os destaques da edição — se o
 *      editor clicar "Regenerar" em D1 e D2 dentro da mesma janela de poucos
 *      segundos, os 2 processos rodam esse passo concorrentemente. Mitigado
 *      via lock (`scripts/lib/file-lock.ts`) dentro de
 *      `writeCarouselSourceHashes`, mesmo mecanismo de
 *      `stage4-capture-state.ts`/`stage4-decision.ts` — mas note que isso só
 *      serializa a ESCRITA do hash; os 2 `gen-carousel-cards.ts` ainda
 *      recompõem os slides de TODOS os destaques de forma redundante (custo
 *      de CPU duplicado, não de API paga, e idempotente por conteúdo).
 *
 * Pra "eia": `eia-compose.ts --edition {aammdd} --force` (escolhe entre
 * imagem real/gerada — não é uma chamada de geração de imagem nova, é
 * curadoria sobre conteúdo já disponível).
 *
 * ASSÍNCRONO POR DESIGN (#6447 review consciente): os passos 1-2 chamam uma
 * API de imagem paga que pode levar dezenas de segundos — bloquear a
 * resposta HTTP até o fim faria o cliente (e o event loop single-threaded
 * do server, que também serve SSE/chat pra outras abas) travar por esse
 * tempo. `startRegenerateJob` retorna IMEDIATAMENTE após validar
 * pré-condições e disparar a cadeia em background (spawn assíncrono, nunca
 * spawnSync); o cliente faz polling em `GET /api/editions/:aammdd/images`
 * (campo `regenerating` por destaque/eia) até o job concluir — mesmo padrão
 * de UX que outros paineis do Studio já usam pra long-running work (SSE não
 * foi escolhido aqui porque o job é curto o bastante — minutos, não horas —
 * pra polling de baixa frequência ser suficiente, e evita mais um canal de
 * stream só pra isto).
 *
 * Estado dos jobs vive em memória (`Map`, processo único do
 * `Diaria-Studio-Server`) — reinício do server perde jobs em progresso (o
 * script filho spawnado continua rodando órfão até terminar; o próximo GET
 * da galeria não vai mostrar `regenerating: true` pra ele, mas os arquivos
 * finais aparecem quando ele terminar de escrever). Aceitável: mesmo
 * trade-off de qualquer estado em memória de processo único (o chat do
 * Studio tinha o mesmo trade-off em `pendingByRoot`, `studio-chat.ts`,
 * removido no #6942), e reiniciar o server no meio de uma regeneração de
 * imagem é um evento raro o bastante pra não justificar persistência.
 *
 * PROTEÇÃO CONTRA DUPLO-CLIQUE (#6447 guardrail — API cara): 1 job por
 * `{aammdd}:{destaque}` por vez — uma 2ª chamada a `startRegenerateJob`
 * enquanto a 1ª está `running` retorna `{alreadyRunning: true}` SEM
 * disparar um 2º processo (nunca 2 chamadas Gemini concorrentes pro mesmo
 * destaque). O client (`rv-images.js`) desabilita o botão no clique e só
 * reabilita quando `regenerating` volta `false` no próximo poll — a Map é a
 * rede de segurança do lado servidor, o disable é a do lado cliente.
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { spawn } from "node:child_process";
import { resolveEditionDir } from "../lib/find-current-edition.ts";
import { readDestaqueCount } from "../lib/invariant-checks/stage-3.ts";
import { CAROUSEL_SLIDE_SLOTS, carouselSlideFilename } from "../lib/daily-carousel-card.ts";

const AAMMDD_RE = /^[0-9]{6}$/;

export type ImageTarget = "d1" | "d2" | "d3" | "eia";

function isDestaqueTarget(target: string): target is "d1" | "d2" | "d3" {
  return target === "d1" || target === "d2" || target === "d3";
}

export function isImageTarget(target: string): target is ImageTarget {
  return isDestaqueTarget(target) || target === "eia";
}

export interface ImageEntry {
  type: string;
  label: string;
  filename: string;
  exists: boolean;
}

export interface DestaqueImages {
  n: number;
  images: ImageEntry[];
  regenerating: boolean;
  /** #6447 review (code-reviewer, P2): mensagem do último job que terminou
   * em erro pra este destaque, ou `null` se o último job (se algum já
   * rodou) terminou `done`/nunca rodou. Sem este campo, `regenerating`
   * simplesmente volta a `false` quando um job FALHA — indistinguível, do
   * lado do client, de "terminou com sucesso" (silent failure numa chamada
   * de API paga). `null` também depois de um job bem-sucedido — só reflete
   * o job MAIS RECENTE, nunca acumula histórico. */
  lastError: string | null;
}

export type ImagesGallery =
  | {
      available: true;
      destaques: DestaqueImages[];
      eia: { images: ImageEntry[]; regenerating: boolean; lastError: string | null };
    }
  | { available: false; note: string };

function destaqueImageSpecs(d: string): { type: string; label: string; filename: string }[] {
  const specs = [
    { type: "2x1", label: "Hero 2:1 (e-mail)", filename: `04-${d}-2x1.jpg` },
    { type: "1x1", label: "Quadrado 1:1", filename: `04-${d}-1x1.jpg` },
    { type: "4x5", label: "Card feed 4:5 (capa do carrossel)", filename: `04-${d}-4x5.jpg` },
  ];
  for (const slot of CAROUSEL_SLIDE_SLOTS) {
    specs.push({
      type: `carousel-${slot}`,
      label: `Carrossel — ${slot === "cta" ? "CTA" : `parágrafo ${slot.slice(1)}`}`,
      filename: carouselSlideFilename(d, slot),
    });
  }
  return specs;
}

const EIA_SPECS = [
  { type: "eia-a", label: "É IA? — Opção A", filename: "01-eia-A.jpg" },
  { type: "eia-b", label: "É IA? — Opção B", filename: "01-eia-B.jpg" },
];

/** Lê a galeria de imagens da edição — puramente `existsSync`, nunca lança.
 * `available: false` só pra AAMMDD inválido ou edição inexistente (mesmo
 * padrão fail-soft de `buildGateSummary`). */
export function buildImagesGallery(rootDir: string, aammdd: string): ImagesGallery {
  if (!AAMMDD_RE.test(aammdd)) return { available: false, note: "AAMMDD inválido" };
  const editionDir = resolveEditionDir(resolve(rootDir, "data", "editions"), aammdd);
  if (!existsSync(editionDir)) return { available: false, note: "edição não encontrada" };

  const destaqueCount = readDestaqueCount(editionDir);
  const destaques: DestaqueImages[] = [];
  for (let n = 1; n <= destaqueCount; n++) {
    const d = `d${n}`;
    const images = destaqueImageSpecs(d).map((spec) => ({
      ...spec,
      exists: existsSync(resolve(editionDir, spec.filename)),
    }));
    destaques.push({ n, images, regenerating: isJobRunning(aammdd, d), lastError: lastJobError(aammdd, d) });
  }
  const eiaImages = EIA_SPECS.map((spec) => ({
    ...spec,
    exists: existsSync(resolve(editionDir, spec.filename)),
  }));
  return {
    available: true,
    destaques,
    eia: { images: eiaImages, regenerating: isJobRunning(aammdd, "eia"), lastError: lastJobError(aammdd, "eia") },
  };
}

// ── Regeneração assíncrona ──────────────────────────────────────────────

export type RegenerateJobStatus = "running" | "done" | "error";

export interface RegenerateJobStep {
  label: string;
  code: number | null;
}

export interface RegenerateJob {
  target: ImageTarget;
  status: RegenerateJobStatus;
  startedAt: string;
  finishedAt: string | null;
  steps: RegenerateJobStep[];
  error: string | null;
}

/** Executa um script filho — extraído como tipo pra ser injetável em teste
 * (mesmo padrão de `RenderCarouselSlidesFn` em `gen-carousel-cards.ts`):
 * spawnar processo real (Gemini/ComfyUI de verdade) custaria dinheiro e
 * minutos por teste. */
export type RunScriptFn = (scriptRelPath: string, args: string[], cwd: string) => Promise<{ code: number | null; stderr: string }>;

function tailStderr(stderr: string, n = 6): string {
  const lines = stderr.trim().split("\n");
  return lines.slice(-n).join("\n");
}

/** #6447 review (silent-failure-hunter, P2): `stdio` pipa stdout SEM
 * consumidor era um duplo risco — (a) qualquer log de progresso que os 4
 * scripts desta cadeia escrevam em stdout (não só stderr) desaparecia sem
 * deixar rastro pro `job.error`, e (b) um script que escrevesse mais que o
 * buffer de pipe do SO em stdout sem nunca ler stderr correria risco de
 * travar esperando alguém drenar — o job ficaria `running` pra sempre, sem
 * timeout em lugar nenhum desta cadeia. Agora stdout é drenado e anexado
 * (com um separador) ao mesmo buffer que `tailStderr` corta — diagnóstico
 * de qualquer um dos 2 streams sobrevive no `job.error` de uma falha. */
/** Exportado pra teste direto (#6447 review, pr-test-analyzer): toda a
 * cobertura de `startRegenerateJob` injeta `runScript`, então o wrapper de
 * `spawn` de verdade (captura de stdout/stderr, `child.on("error")`) nunca
 * era exercitado — um regressão ali (typo nos args do `--import tsx`,
 * handler de erro quebrado) só apareceria ao vivo, no 1º clique real em
 * "Regenerar". O teste usa um script Node fixture descartável (`process.exit`
 * + escrita em stdout/stderr), nunca um script real da pipeline — sem custo
 * de API. */
export const defaultRunScript: RunScriptFn = (scriptRelPath, args, cwd) =>
  new Promise((resolvePromise) => {
    const child = spawn(process.execPath, ["--import", "tsx", resolve(cwd, scriptRelPath), ...args], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    const combined = () => (stdout.trim() ? `${stderr}\n[stdout]\n${stdout}` : stderr);
    child.on("close", (code) => resolvePromise({ code, stderr: combined() }));
    child.on("error", (err) => resolvePromise({ code: null, stderr: `${combined()}\n${String(err)}` }));
  });

/** Passos da cadeia de regeneração de UM destaque (extraído pra ser
 * testável sem I/O nem spawn — mesma disciplina de `resolveRatio`/
 * `resolveWideImageIntegrity` em `image-generate.ts`). Espelha
 * `stage-3-run.ts` linhas ~439-502. `aammdd` só é usado pelo passo `eia`
 * (`eia-compose.ts` recebe `--edition AAMMDD`, não um path — CLI distinta
 * de todos os outros scripts desta cadeia, que recebem `--out-dir`/
 * `--edition-dir`, ver docstring de `eia-compose.ts`). */
export function buildRegenerateSteps(
  target: ImageTarget,
  editionDir: string,
  aammdd: string,
): { label: string; script: string; args: string[] }[] {
  if (target === "eia") {
    return [
      {
        label: "eia-compose",
        script: "scripts/eia-compose.ts",
        args: ["--edition", aammdd, "--out-dir", `${editionDir}/`, "--force"],
      },
    ];
  }
  const editorialPath = resolve(editionDir, "_internal", `02-${target}-prompt.md`);
  const genArgs = ["--editorial", editorialPath, "--out-dir", `${editionDir}/`, "--destaque", target];
  return [
    // #6447 review (comment-analyzer, P1): a 1ª versão desta cadeia pulava
    // este passo — stage-3-run.ts SEMPRE roda lint-image-prompt.ts antes de
    // gastar a 1ª chamada Gemini/ComfyUI. Exit 1 (violação) vira job.error
    // sem chamar image-generate.ts; exit 0 segue pro passo pago.
    { label: "lint-image-prompt", script: "scripts/lint-image-prompt.ts", args: [editorialPath] },
    { label: `image-generate (${target}, 2x1/1x1)`, script: "scripts/image-generate.ts", args: [...genArgs, "--force"] },
    { label: `image-generate (${target}, 4x5 nativo)`, script: "scripts/image-generate.ts", args: [...genArgs, "--ratio", "4x5", "--force"] },
    { label: "gen-social-card-4x5", script: "scripts/gen-social-card-4x5.ts", args: ["--edition-dir", `${editionDir}/`, "--destaque", target] },
    { label: "gen-carousel-cards", script: "scripts/gen-carousel-cards.ts", args: ["--edition-dir", `${editionDir}/`, "--force"] },
  ];
}

const jobs = new Map<string, RegenerateJob>();

function jobKey(aammdd: string, target: string): string {
  return `${aammdd}:${target}`;
}

function isJobRunning(aammdd: string, target: string): boolean {
  return jobs.get(jobKey(aammdd, target))?.status === "running";
}

/** #6447 review (code-reviewer, P2): mensagem do último job `error` pra
 * `{aammdd}:{target}`, ou `null` se não há job registrado ou o último
 * terminou `done`/ainda está `running` — usado por `buildImagesGallery`
 * pra `DestaqueImages.lastError`/`eia.lastError` (ver docstring do campo). */
function lastJobError(aammdd: string, target: string): string | null {
  const job = jobs.get(jobKey(aammdd, target));
  return job?.status === "error" ? job.error : null;
}

export function getRegenerateJob(aammdd: string, target: string): RegenerateJob | null {
  return jobs.get(jobKey(aammdd, target)) ?? null;
}

export type StartRegenerateResult =
  | { ok: true; alreadyRunning: false; job: RegenerateJob }
  | { ok: true; alreadyRunning: true; job: RegenerateJob }
  | { ok: false; error: string };

/**
 * Dispara a cadeia de regeneração pra `target` (d1/d2/d3/eia) — retorna
 * IMEDIATAMENTE (a cadeia roda em background, ver docstring do módulo).
 * `deps.runScript` é injetável pra teste (default: `spawn` real).
 */
export function startRegenerateJob(
  rootDir: string,
  aammdd: string,
  target: string,
  opts: { runScript?: RunScriptFn; now?: () => Date } = {},
): StartRegenerateResult {
  if (!AAMMDD_RE.test(aammdd)) return { ok: false, error: "AAMMDD inválido" };
  if (!isImageTarget(target)) return { ok: false, error: "destaque inválido — use d1, d2, d3 ou eia" };
  const editionDir = resolveEditionDir(resolve(rootDir, "data", "editions"), aammdd);
  if (!existsSync(editionDir)) return { ok: false, error: "edição não encontrada" };

  const key = jobKey(aammdd, target);
  const existing = jobs.get(key);
  if (existing && existing.status === "running") {
    return { ok: true, alreadyRunning: true, job: existing };
  }

  if (target !== "eia") {
    const editorialPath = resolve(editionDir, "_internal", `02-${target}-prompt.md`);
    if (!existsSync(editorialPath)) {
      return { ok: false, error: `prompt editorial ausente: _internal/02-${target}-prompt.md (destaque não existe nesta edição, ou Stage 2 não gerou o prompt)` };
    }
  }

  const now = opts.now ?? (() => new Date());
  const runScript = opts.runScript ?? defaultRunScript;
  const steps = buildRegenerateSteps(target, editionDir, aammdd);

  const job: RegenerateJob = {
    target,
    status: "running",
    startedAt: now().toISOString(),
    finishedAt: null,
    steps: steps.map((s) => ({ label: s.label, code: null })),
    error: null,
  };
  jobs.set(key, job);

  // Fire-and-forget deliberado (#6447): o caller HTTP já recebeu a resposta
  // "job iniciado" antes desta Promise resolver — erros são gravados no
  // próprio `job` (consumido pelo próximo poll), nunca perdidos, mas também
  // nunca propagados a um caller que já foi embora.
  //
  // #6447 review (silent-failure-hunter, P2): o `try/catch` abaixo não
  // existia na 1ª versão — se `runScript` REJEITASSE (em vez de resolver
  // com `{code, stderr}`, o contrato normal), a IIFE lançava sem handler:
  // unhandled rejection (risco de derrubar o `Diaria-Studio-Server`
  // inteiro, não só este job) e o `job` ficava `running` pra sempre, porque
  // nada nunca setava `status`/`finishedAt`. `defaultRunScript` hoje nunca
  // rejeita (seu próprio `child.on("error", ...)` RESOLVE em vez de
  // rejeitar), mas `RunScriptFn` é um tipo público injetável — nada além
  // deste catch impede um `runScript` alternativo (teste futuro, refactor)
  // de rejeitar e deixar o job travado sem diagnóstico nenhum.
  void (async () => {
    try {
      for (let i = 0; i < steps.length; i++) {
        const step = steps[i];
        const result = await runScript(step.script, step.args, rootDir);
        job.steps[i].code = result.code;
        if (result.code !== 0) {
          job.status = "error";
          job.error = `${step.label} falhou (exit ${result.code ?? "null"}): ${tailStderr(result.stderr)}`;
          job.finishedAt = now().toISOString();
          return;
        }
      }
      job.status = "done";
      job.finishedAt = now().toISOString();
    } catch (err) {
      job.status = "error";
      job.error = `exceção inesperada durante a regeneração: ${(err as Error).message ?? String(err)}`;
      job.finishedAt = now().toISOString();
    }
  })();

  return { ok: true, alreadyRunning: false, job };
}
