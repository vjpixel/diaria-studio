/**
 * scripts/lib/develop-plan-motivo.ts (#5708)
 *
 * Fecha a 2ª causa raiz do #5708: um rótulo de espera INVENTADO ("gated no
 * D0", "timing do editor") gravado no campo `motivo` de uma issue `pulada`
 * do plan.json do /diaria-develop escapava de qualquer verificação — a
 * skill documenta um vocabulário fechado de motivos válidos
 * (`nao-destravavel-na-sessao`, `decisao-adiada`, `claimed-por-outra-sessao`),
 * mas nada validava que o texto gravado batesse com essa lista. Mesmo
 * espírito do guard de contagem do #5521 (`register-report.ts`, marcador
 * `<!-- unidades-mergeadas -->`): checagem mecânica e barata que faz o
 * desvio FALHAR em vez de passar em silêncio.
 *
 * Escopo: só `status === "pulada"` — os outros status (`mergeada`,
 * `draft-ci-vermelho`, `pendente`, `entregue-fora-de-codigo`) não usam
 * `motivo` do mesmo jeito (o caso `entregue-fora-de-codigo` tem seus
 * próprios campos, `fora_de_codigo_evidencia`/`fora_de_codigo_fechamento`,
 * #5441 — fora do escopo deste guard). `nao-destravavel-na-sessao` cobre
 * deliberadamente tanto o bloqueio cat. A/B/E não resolvido quanto a
 * implementação de issue elegível que falha sem nunca abrir PR (Fase 1
 * passo 5 do SKILL.md) — um só valor pros dois casos, de propósito.
 *
 * `ja-resolvida-antes-da-sessao` (#5723, 19/08/2026) — 4º valor. Cobre o
 * desfecho que `nao-destravavel-na-sessao` NÃO descreve: a issue foi
 * verificada AO VIVO nesta sessão e o trabalho que ela pedia **já estava
 * feito** antes da sessão começar — nada foi executado aqui, não há
 * bloqueio nenhum. Sem este valor, o único jeito de passar no guard era
 * forçar `nao-destravavel-na-sessao`, que é falso (não há nada
 * "não-destravável" — já está destravado, resolvido). Motivado por 3
 * casos reais da rodada `260819d` que o guard reprovou: #5501 e #5506
 * (campanha que a issue dizia "não criada" já existia, pausada, confirmado
 * por GAQL contra a API oficial do Google Ads) e #5702 (issue dizia "3
 * assets rejeitados"; a verificação ao vivo achou zero assets não-aprovados
 * nas 5 páginas do asset group, `Ad components: No issues`). Nos três, o
 * trabalho da issue não foi feito NESTA sessão — foi só constatado já
 * pronto, por checagem contra a fonte de verdade externa (API oficial, não
 * cache/memória — mesma disciplina do #1172).
 *
 * **Pressupõe evidência, mecanicamente, não só em prosa.** O histórico
 * deste módulo é precisamente prosa-descumprida-mesmo-lida (#4740/#5716,
 * #5708, #5721 — guard nasceu porque documentar em prosa não bastou) — um
 * 4º valor de escape sem trava equivalente reabriria a mesma porta que os
 * três incidentes anteriores fecharam, só que com um rótulo plausível
 * demais pra ninguém questionar ("já tava feito" é fácil de alegar sem
 * checar). Por isso o guard também exige, quando `motivo ===
 * "ja-resolvida-antes-da-sessao"`, um campo `ja_resolvida_evidencia`
 * (string não-vazia, mesmo padrão de `fora_de_codigo_evidencia` do #5441)
 * descrevendo COMO foi verificado — nunca um secret, sempre o rastro (ex:
 * "GAQL campaign.name='Max' status=PAUSED, confirmado {timestamp}"). Issue
 * `pulada` com este motivo mas sem evidência é reportada pelo guard tanto
 * quanto um motivo fora do vocabulário — ver `reason: "missing-evidencia"`
 * em `InvalidMotivoEntry`.
 *
 * Puro (`findInvalidPuladaMotivos`/`checkDevelopPlanMotivosFromIssues`) + I/O
 * fino (`checkDevelopPlanMotivos`, lê o plan.json do disco). CLI em
 * `scripts/validate-develop-plan-motivo.ts`.
 *
 * @see .claude/skills/diaria-develop/SKILL.md § "'Nenhuma issue aberta' = estado terminal"
 * @see scripts/lib/state-changed-tracker.ts (padrão de estilo do gate)
 * @see scripts/lib/plan-issues-normalize.ts (`plan.issues` array vs dict)
 */

import { readFileSync } from "node:fs";
import { normalizeIssues, type IssuesBearing } from "./plan-issues-normalize.ts";

/**
 * Vocabulário fechado de `motivo` para issues `status: "pulada"` no
 * plan.json do /diaria-develop, exatamente como documentado em
 * `.claude/skills/diaria-develop/SKILL.md` § "Nenhuma issue aberta =
 * estado terminal". Um 4º valor legado (`rescan-limit`) existiu antes do
 * #5272 e foi removido junto do cap de re-varredura — nunca gravado por uma
 * sessão atual, não entra aqui.
 *
 * `deixado-para-o-helios` (#5909, refina #5751): issue que exige a máquina
 * Windows/Neo do editor (labels `windows`, `external-blocker` +
 * `credencial-escopo`) — o Helios (servidor Linux) não executa nem dirige o
 * browser do Neo. Terminal no track Helios por construção: a sessão registra
 * a issue como `pulada` com este motivo e o roteamento label-driven
 * (`classifyExecTrack`) é quem garante que ela reapareça no track certo.
 */
export const DEVELOP_PULADA_MOTIVOS = [
  "nao-destravavel-na-sessao",
  "decisao-adiada",
  "claimed-por-outra-sessao",
  "ja-resolvida-antes-da-sessao",
  "deixado-para-o-helios",
] as const;

/** Campo obrigatório (string não-vazia) quando `motivo ===
 * "ja-resolvida-antes-da-sessao"` — ver docstring do módulo. */
const JA_RESOLVIDA_MOTIVO = "ja-resolvida-antes-da-sessao" satisfies DevelopPuladaMotivo;

type DevelopPuladaMotivo = (typeof DEVELOP_PULADA_MOTIVOS)[number];

const VALID_SET: ReadonlySet<string> = new Set(DEVELOP_PULADA_MOTIVOS);

/** Type guard: `motivo` pertence ao vocabulário fechado `DEVELOP_PULADA_MOTIVOS`. */
function isDevelopPuladaMotivo(motivo: string): motivo is DevelopPuladaMotivo {
  return VALID_SET.has(motivo);
}

export interface DevelopPlanIssueLike {
  number?: number;
  status?: unknown;
  motivo?: unknown;
  /** Track calculado pelo `classifyExecTrack` e gravado no plan.json pelo
   * passo 6a da Fase 0 (#5907: hoje é prosa pura — o gap (a) da issue).
   * Consumido por `findHeliosBuraco` (#5907 b). */
  exec_track_painel?: unknown;
  /** Obrigatório (string não-vazia) quando `motivo ===
   * "ja-resolvida-antes-da-sessao"` — ver docstring do módulo. */
  ja_resolvida_evidencia?: unknown;
  [key: string]: unknown;
}

export interface InvalidMotivoEntry {
  number: number;
  /** `null` quando `motivo` está ausente ou não é string — issue `pulada`
   * sem motivo registrado é o mesmo problema, silenciosamente pior. */
  motivo: string | null;
  /** Presente só quando o motivo em si é válido mas falta a evidência
   * obrigatória (`ja-resolvida-antes-da-sessao` sem
   * `ja_resolvida_evidencia`) — distingue esse caso de "motivo fora do
   * vocabulário" pra CLI reportar a mensagem certa. Ausente (não
   * `undefined` explícito) nos demais casos, preservando o shape antigo. */
  reason?: "missing-evidencia";
}

function hasJaResolvidaEvidencia(issue: DevelopPlanIssueLike): boolean {
  const evidencia = issue.ja_resolvida_evidencia;
  return typeof evidencia === "string" && evidencia.trim().length > 0;
}

/**
 * Pure: varre as issues já normalizadas (sempre array — via
 * `normalizeIssues`, agnóstico do plan.json ter gravado array ou dict),
 * devolve as `status: "pulada"` cujo `motivo` não bate com
 * `DEVELOP_PULADA_MOTIVOS`, OU cujo motivo é `ja-resolvida-antes-da-sessao`
 * sem `ja_resolvida_evidencia` preenchida. Nunca lança.
 */
export function findInvalidPuladaMotivos(
  issues: DevelopPlanIssueLike[],
): InvalidMotivoEntry[] {
  const out: InvalidMotivoEntry[] = [];
  for (const issue of issues) {
    if (issue?.status !== "pulada") continue;
    const motivo = typeof issue.motivo === "string" ? issue.motivo : null;
    const number = typeof issue.number === "number" ? issue.number : Number.NaN;
    if (motivo === null || !isDevelopPuladaMotivo(motivo)) {
      out.push({ number, motivo });
      continue;
    }
    if (motivo === JA_RESOLVIDA_MOTIVO && !hasJaResolvidaEvidencia(issue)) {
      out.push({ number, motivo, reason: "missing-evidencia" });
    }
  }
  return out;
}

/**
 * #5907 (b) — `deixado-para-o-helios` aplicado a issue que o helios NUNCA
 * pega manda a issue pra um buraco: o develop não faz, o overnight não faz.
 * Issue com track painel `develop`, `bloqueada` ou `epica` não pode terminar
 * como `pulada` com esse motivo — o roteamento label-driven
 * (`classifyExecTrack`) é quem decide pra onde ela vai, e nenhum desses
 * tracks é algo que o overnight pegaria sozinho (`develop`/`bloqueada`
 * exigem máquina/editor que esta sessão não representa; `epica`, #6201,
 * nunca é implementada direto — delegada às issues-filhas). Terminações
 * legítimas para essas tracks: `mergeada`, `entregue-fora-de-codigo`,
 * `nao-tentada`, ou `pulada` com outro motivo do vocabulário.
 *
 * Pure: devolve os números das issues cujo status é exatamente
 * `deixado-para-o-helios` com `exec_track_painel` conhecido e incompatível.
 * Issues sem `exec_track_painel` gravado NÃO são reportadas aqui — a falta
 * do campo é o gap (a) da mesma #5907 (gate próprio no passo 6a), não deste.
 */
export function findHeliosBuraco(
  issues: DevelopPlanIssueLike[],
): number[] {
  const out: number[] = [];
  for (const issue of issues) {
    if (issue?.status !== "deixado-para-o-helios") continue;
    const track = typeof issue.exec_track_painel === "string" ? issue.exec_track_painel : null;
    if (track === "develop" || track === "bloqueada" || track === "epica") {
      out.push(typeof issue.number === "number" ? issue.number : Number.NaN);
    }
  }
  return out.sort((a, b) => a - b);
}

export type DevelopPlanMotivoCheckResult =
  | { status: "ok" }
  | { status: "invalid"; entries: InvalidMotivoEntry[] };

/** Pure: veredito a partir das issues já normalizadas. */
export function checkDevelopPlanMotivosFromIssues(
  issues: DevelopPlanIssueLike[],
): DevelopPlanMotivoCheckResult {
  const entries = findInvalidPuladaMotivos(issues);
  if (entries.length === 0) return { status: "ok" };
  return { status: "invalid", entries: [...entries].sort((a, b) => a.number - b.number) };
}

/** I/O: lê o plan.json do disco (array ou dict, #4860) e devolve o veredito. */
export function checkDevelopPlanMotivos(planPath: string): DevelopPlanMotivoCheckResult {
  const raw = readFileSync(planPath, "utf8");
  const plan = JSON.parse(raw) as IssuesBearing<DevelopPlanIssueLike>;
  const issues = normalizeIssues(plan);
  return checkDevelopPlanMotivosFromIssues(issues);
}
