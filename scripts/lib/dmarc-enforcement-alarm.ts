/**
 * scripts/lib/dmarc-enforcement-alarm.ts (#6442)
 *
 * MOTOR DE DECISÃO PURO que converte um `DmarcEnforcementReport` (o motor
 * read-only de `scripts/dmarc-enforcement-engine.ts` +
 * `scripts/lib/dmarc-enforcement-policy.ts`) num `AlarmFinding[]` consumível
 * por `scripts/lib/alarm-issues.ts` — o mesmo mecanismo genérico que todo
 * outro alarme agendado deste repo usa (ver docstring de `alarm-issues.ts`).
 *
 * ## Por que este módulo existe separado do motor de decisão
 *
 * `decideDmarcEnforcement` (dmarc-enforcement-policy.ts) já decide TUDO sobre
 * o sinal — não repete lógica aqui. Este módulo só traduz o vocabulário do
 * motor (`DmarcRecommendation`: `hold`/`escalate`/`consider-rollback`) pro
 * vocabulário de alarme (`AlarmFinding[]`), sem reavaliar nada.
 *
 * ## Regra: só "hold" não gera achado
 *
 * `hold` (volume insuficiente, domínio imaturo, ou já sem degrau pra recuar)
 * é o estado "nada a fazer agora" — sem finding, exatamente como qualquer
 * outro alarme `family: "estado"` deste repo (ausência de achado = issue
 * existente fecha sozinha após N execuções limpas, `alarm-issues.ts`).
 * `escalate` e `consider-rollback` são os dois casos em que o editor precisa
 * ver algo: "dá pra subir de degrau" ou "sinal piorou com enforcement já
 * ativo, considere recuar" — ambos geram 1 finding.
 *
 * ## Fingerprint FIXO, `contentSignature` variável
 *
 * Mesmo padrão de `acervo-staleness-alarm.ts` (#7591): o fingerprint NÃO
 * embute o valor corrente (nível/recomendação/política-alvo) — só o domínio.
 * Se embutisse, uma mudança de "escalate → quarantine" pra "escalate →
 * reject" trocaria o fingerprint, fecharia a issue anterior como "resolvida"
 * (não foi) e abriria outra — série de issues fechadas em falso em vez de
 * uma só acompanhando a situação do início ao fim. `contentSignature`
 * preserva o sinal "a situação mudou" sem trocar de issue: muda de valor
 * sempre que nível, recomendação, política-alvo ou as taxas mudam o
 * suficiente para alterar a decisão — `ensureAlarmIssue` comenta com o corpo
 * atualizado em vez de reusar em silêncio.
 */
import type { DmarcEnforcementReport } from "../dmarc-enforcement-engine.ts";
import type { AlarmFinding } from "./alarm-issues.ts";

export const DMARC_ENFORCEMENT_CHECK = "dmarc-enforcement";

/** `dmarc-enforcement:{domain}` — fixo por domínio, nunca embute o valor
 *  corrente da decisão (ver docstring do módulo, "Fingerprint FIXO"). */
export function dmarcEnforcementFingerprint(domain: string): string {
  return `${DMARC_ENFORCEMENT_CHECK}:${domain}`;
}

/** "1,40%" — mesma formatação pt-BR determinística do resto do domínio
 *  (`dmarc-enforcement-policy.ts`, `clarice-envio-policy.ts`). */
function fmtPct(n: number): string {
  return `${n.toFixed(2).replace(".", ",")}%`;
}

/**
 * Converte o relatório do motor num `AlarmFinding[]` de 0 ou 1 elemento.
 * `[]` quando `recommendation === "hold"` — nenhum achado, a issue existente
 * (se houver) fecha sozinha após execuções limpas consecutivas, mesmo
 * mecanismo de qualquer alarme `family: "estado"` deste repo.
 */
export function toAlarmFindings(report: DmarcEnforcementReport): AlarmFinding[] {
  const { decision } = report;
  if (decision.recommendation === "hold") return [];

  const currentDisplay =
    report.currentPolicy ?? "none (sem registro DMARC — comportamento efetivo p=none)";
  const nextDisplay = decision.nextPolicy ?? "(decisão de rollback fica a critério do editor — não sugerido automaticamente)";
  const recommendationLabel =
    decision.recommendation === "escalate"
      ? "ESCALAR — sinal limpo, domínio maduro, dá pra subir de degrau"
      : "CONSIDERAR ROLLBACK — sinal não saudável com enforcement já ativo";

  const title =
    decision.recommendation === "escalate"
      ? `[diar.ia.br] DMARC ${report.domain}: motor recomenda escalar ${report.currentPolicy ?? "none"} → ${decision.nextPolicy}`
      : `[diar.ia.br] DMARC ${report.domain}: sinal não saudável com enforcement ativo — considerar rollback`;

  const body = [
    "Achado automático do alarme `Diaria-Dmarc-Enforcement-Alarm`",
    "(`scripts/dmarc-enforcement-alarm.ts`, motor em `scripts/dmarc-enforcement-engine.ts` +",
    "`scripts/lib/dmarc-enforcement-policy.ts`, #6442).",
    "",
    `Recomendação: **${recommendationLabel}**`,
    "",
    "| campo | valor |",
    "|---|---|",
    `| política DNS atual | ${currentDisplay} |`,
    `| política recomendada | ${nextDisplay} |`,
    `| bounce cumulativo | ${fmtPct(decision.bounceRatePct)} (${report.signals.bouncedCount}/${report.signals.totalConsidered}) |`,
    `| complaint cumulativo | ${fmtPct(decision.complaintRatePct)} (${report.signals.complainedCount}/${report.signals.totalConsidered}) |`,
    `| maturidade do domínio | ${report.signals.daysSinceFirstSend ?? "sem broadcast completado"} dia(s) |`,
    "",
    "Motivos do motor:",
    ...decision.reasons.map((r) => `- ${r}`),
    "",
    "**Este motor é READ-ONLY — nunca escreve DNS.** Aplicar a recomendação",
    "(subir `_dmarc.news.diar.ia.br` no Cloudflare pra `p=quarantine`/`p=reject`,",
    "ou recuar) é sempre ação MANUAL do editor. Reler o estado a qualquer",
    "momento: `npx tsx scripts/dmarc-enforcement-engine.ts --json`.",
    "",
    "Fecha sozinha quando o motor voltar a recomendar `hold` por 2 execuções",
    "consecutivas (mesmo padrão de `alarm-issues.ts`, `family: \"estado\"`).",
  ].join("\n");

  return [
    {
      check: DMARC_ENFORCEMENT_CHECK,
      fingerprint: dmarcEnforcementFingerprint(report.domain),
      title,
      body,
      family: "estado",
      labels: ["enhancement"],
      priority: "P2",
      contentSignature: `${decision.level}:${decision.recommendation}:${decision.nextPolicy ?? "-"}:${report.currentPolicy ?? "none"}`,
    },
  ];
}

export type DmarcEnforcementReportOutcome =
  | { ok: true; report: DmarcEnforcementReport }
  | { ok: false; error: string };

/**
 * Casca fail-soft, injetável, ao redor de `buildDmarcEnforcementReport` (ou
 * equivalente) — nunca lança, sempre devolve `{ok:false, error}` em falha de
 * leitura (rede/DNS/Kit indisponível). Extraído do `main()` de
 * `scripts/dmarc-enforcement-alarm.ts` pra ser testável sem mockar `fetch`
 * global: os testes passam um `buildFn` fake que rejeita, e verificam que
 * NENHUM finding é produzido a partir de `{ok:false}` — "sem dado" nunca vira
 * "situação ruim, abra issue" (mesmo racional de `acervo-staleness-alarm.ts`).
 */
export async function resolveDmarcEnforcementReport(
  buildFn: (domain: string, now: Date) => Promise<DmarcEnforcementReport>,
  domain: string,
  now: Date,
): Promise<DmarcEnforcementReportOutcome> {
  try {
    return { ok: true, report: await buildFn(domain, now) };
  } catch (e) {
    return { ok: false, error: (e as Error)?.message ?? String(e) };
  }
}
