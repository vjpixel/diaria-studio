/**
 * scripts/lib/linkedin-article-mention-gate.ts (#13286)
 *
 * Trava do registro do artigo semanal do LinkedIn: o
 * `social-schedule-rotation.ts --record` de uma linha `linkedin_article` só
 * grava quando a conferência da menção "@diar.ia.br" do post de feed
 * (`weekly-feed-post-mention-audit.ts`, #13261) existe para o ciclo e
 * aprovou.
 *
 * Por que existe: a conferência é um passo em prosa do
 * `/diaria-linkedin-semanal` (Passo 9, item 4) que a sessão precisa lembrar
 * de rodar. A falha original (#13261) foi justamente um passo manual pulado
 * em silêncio, com o post saindo com o link para o site em vez da menção à
 * página. O `--record` é o passo que a sessão roda logo depois de o editor
 * agendar, então é o ponto mecânico onde a falta da conferência vira erro
 * visível em vez de silêncio.
 *
 * O `--record` recebe a DATA (segunda de publicação), não o ciclo: o ciclo
 * sai de `resolveWeeklyLinkedinCycle` (semana de conteúdo anterior à
 * segunda), a mesma conta que a skill usa para montar `data/weekly/{cycle}`.
 *
 * Status `unverified` (o nome aparece sem "@", mas o DOM não mostra sinal de
 * menção) é recusado por padrão; a skill manda o editor confirmar à vista, e
 * só então a sessão passa `allowUnverified` (`--mention-visual-ok` na CLI).
 * `plain-text`, `site-link` e `missing` nunca passam.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveWeeklyLinkedinCycle } from "./weekly-linkedin-cycle.ts";

/** Resultado da conferência, relativo ao diretório do ciclo (`data/weekly/{cycle}`). */
export const FEED_POST_MENTION_REL = "_internal/ln-feed-post-mention.json";

export type LinkedinArticleMentionGate =
  | { ok: true; cycle: string; status: string; path: string }
  | { ok: false; cycle: string | null; path: string | null; reason: string };

/** "2026-10-26" ou "261026" → "261026". `null` se não reconhecer. */
function toAAMMDD(date: string): string | null {
  if (/^\d{6}$/.test(date)) return date;
  const m = /^20(\d{2})-(\d{2})-(\d{2})$/.exec(date);
  return m ? `${m[1]}${m[2]}${m[3]}` : null;
}

/**
 * Confere o resultado da conferência da menção para a segunda de publicação
 * `publishDate`. `weeklyRoot` é o diretório que contém `{cycle}/`
 * (`{repo}/data/weekly` em produção; um diretório temporário nos testes).
 */
export function checkLinkedinArticleMentionGate(opts: {
  publishDate: string;
  weeklyRoot: string;
  allowUnverified?: boolean;
}): LinkedinArticleMentionGate {
  const aammdd = toAAMMDD(opts.publishDate);
  const res = aammdd ? resolveWeeklyLinkedinCycle(aammdd) : null;
  if (!res) {
    return { ok: false, cycle: null, path: null, reason: `data '${opts.publishDate}' inválida: não deu para resolver o ciclo do LinkedIn semanal.` };
  }
  const { cycle } = res;
  const path = join(opts.weeklyRoot, cycle, FEED_POST_MENTION_REL);
  const rerun = `rode a conferência (weekly-feed-post-mention-audit.ts --cycle ${cycle} --dom-json ...) com o post aberto, Passo 9 item 4 do /diaria-linkedin-semanal`;
  if (!existsSync(path)) {
    return { ok: false, cycle, path, reason: `conferência da menção @diar.ia.br ausente para o ciclo ${cycle} (${path}): ${rerun}.` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    return { ok: false, cycle, path, reason: `${path} não é JSON válido (${(e as Error).message.split("\n")[0]}): ${rerun}.` };
  }
  const o = (parsed && typeof parsed === "object" ? parsed : {}) as Record<string, unknown>;
  const status = typeof o.status === "string" ? o.status : "";
  if (o.ok === true && (status === "mention" || status === "not-needed")) {
    return { ok: true, cycle, status, path };
  }
  if (status === "unverified" && opts.allowUnverified) {
    return { ok: true, cycle, status, path };
  }
  const msg = typeof o.message === "string" ? ` (${o.message})` : "";
  const hint =
    status === "unverified"
      ? "o editor precisa confirmar a menção à vista; confirmada, repita o --record com --mention-visual-ok"
      : `corrija a menção no post e ${rerun}`;
  return {
    ok: false,
    cycle,
    path,
    reason: `conferência da menção @diar.ia.br do ciclo ${cycle} reprovou: status '${status || "ausente"}'${msg}. ${hint}.`,
  };
}
