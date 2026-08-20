/**
 * scripts/lib/prev-social-status.ts (#5756)
 *
 * Classifica os posts sociais da edição ANTERIOR para o check 0l do Stage 0,
 * separando o que exige ação do editor do que é estado terminal por desenho.
 *
 * **O problema que isto resolve.** O check 0l era prosa no playbook: "posts
 * com `status === "scheduled"` e `scheduled_at < now` → alertar o editor".
 * Essa regra assume que todo canal eventualmente vira `published` — e quatro
 * dos cinco nunca viram, por construção:
 *
 *   - **LinkedIn, Instagram, Threads** roteiam via fila do Worker Cloudflare.
 *     O script local grava `scheduled` no momento do enqueue e nunca volta a
 *     consultar: o disparo real acontece dentro do Worker, sem callback para
 *     o repo.
 *   - **Twitter** (via Buffer) tem o mesmo padrão — `scheduled` na criação,
 *     sem poll de confirmação.
 *   - **Facebook** é a exceção: a Graph API permite poll do status real, e o
 *     `verify-facebook-posts.ts` do check 0k de fato atualiza para `published`.
 *
 * Medição que fecha o caso (edições de agosto/2026, `06-social-published.json`):
 * Facebook aparece como `published` 31 vezes e `scheduled` 11; LinkedIn,
 * Instagram, Threads e Twitter aparecem como `scheduled` **42 de 42 vezes
 * cada, e `published` zero**. Não é um canal atrasado — é um canal que não
 * reporta.
 *
 * Consequência do check antigo: um warning de "12 posts sociais atrasados"
 * em TODA edição, TODO dia, indefinidamente — sobre um estado correto. Alarme
 * que sempre dispara não é alarme; ele treina o leitor a ignorar a categoria
 * inteira, e o dia em que o Facebook de fato falhar o aviso vai estar no meio
 * do mesmo ruído.
 */

/** Canais cujo `scheduled` é ESTADO TERMINAL — não há poll pós-dispatch. */
export const FIRE_AND_FORGET_PLATFORMS = new Set(["linkedin", "instagram", "threads", "twitter"]);

export interface SocialPostLike {
  platform?: string;
  destaque?: string;
  status?: string;
  scheduled_at?: string | null;
  url?: string | null;
}

export interface PrevSocialFinding {
  platform: string;
  destaque: string;
  status: string;
  scheduled_at: string | null;
  reason: "failed" | "overdue-pollable";
}

export interface PrevSocialReport {
  /** Exige ação do editor. */
  findings: PrevSocialFinding[];
  /** `scheduled` vencido em canal fire-and-forget — esperado, nunca alertado. */
  terminalByDesign: number;
  /** Total examinado. */
  total: number;
}

/**
 * `overdue-pollable` só existe para canal que REPORTA status. Para os
 * fire-and-forget, "vencido" não é informação: o registro local congela em
 * `scheduled` no enqueue e nunca mais muda, então `scheduled_at < now` é
 * verdadeiro para 100% dos posts de toda edição passada — a condição não
 * distingue nada.
 */
export function analyzePrevSocial(posts: SocialPostLike[], now: Date): PrevSocialReport {
  const findings: PrevSocialFinding[] = [];
  let terminalByDesign = 0;

  for (const post of posts) {
    const platform = (post.platform ?? "").toLowerCase();
    const status = post.status ?? "";
    const destaque = post.destaque ?? "?";
    const scheduledAt = post.scheduled_at ?? null;

    // `failed` é acionável em qualquer canal — é o script local dizendo que o
    // dispatch não saiu, não uma inferência sobre estado remoto.
    if (status === "failed") {
      findings.push({ platform, destaque, status, scheduled_at: scheduledAt, reason: "failed" });
      continue;
    }

    if (status !== "scheduled") continue;

    if (FIRE_AND_FORGET_PLATFORMS.has(platform)) {
      terminalByDesign++;
      continue;
    }

    // Canal pollable (Facebook) ainda em `scheduled` depois da hora: aqui
    // "vencido" significa alguma coisa, porque o verify-facebook-posts.ts do
    // check 0k teria atualizado para `published` se o post tivesse saído.
    const ts = scheduledAt ? Date.parse(scheduledAt) : NaN;
    if (Number.isFinite(ts) && ts < now.getTime()) {
      findings.push({ platform, destaque, status, scheduled_at: scheduledAt, reason: "overdue-pollable" });
    }
  }

  return { findings, terminalByDesign, total: posts.length };
}

/** Resumo de uma linha para o log/terminal. `null` quando não há o que dizer. */
export function formatPrevSocialSummary(report: PrevSocialReport, prevEdition: string): string | null {
  if (report.findings.length === 0) return null;
  const parts = report.findings.map((f) => `${f.platform}/${f.destaque} (${f.reason})`);
  return `edição anterior ${prevEdition}: ${report.findings.length} post(s) social(is) exigem atenção — ${parts.join(", ")}`;
}
