/**
 * scripts/lib/prev-social-status.ts (#5756)
 *
 * Classifica os posts sociais da edição ANTERIOR para o check 0l do Stage 0,
 * separando o que exige ação do editor do que é estado terminal por desenho.
 *
 * **O problema que isto resolve.** O check 0l era prosa no playbook: "posts
 * com `status === "scheduled"` e `scheduled_at < now` → alertar o editor".
 * Essa regra assume que todo canal eventualmente vira `published` — e quatro
 * dos cinco nunca viravam, por construção:
 *
 *   - **LinkedIn, Instagram, Threads** roteiam via fila do Worker Cloudflare.
 *     O script local grava `scheduled` no momento do enqueue e nunca voltava a
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
 *
 * **#5766 — LinkedIn/Instagram/Threads saíram deste conjunto.** O check 0k
 * ganhou um vizinho, `verify-social-worker-dispatch.ts` (0k-2), que reconcilia
 * esses 3 canais contra `GET /list`/`GET /dlq` do Worker `diaria-linkedin-cron`
 * ANTES deste check 0l rodar — o mesmo papel que `verify-facebook-posts.ts`
 * cumpre pro Facebook, reusando endpoints que o Worker já expõe (não precisou
 * tocar o Worker). Instagram/Threads saem de lá como `published` com
 * confirmação real de entrega (a chamada de publish da própria Graph API já
 * respondeu com sucesso); LinkedIn sai como `published` com confiança mais
 * fraca (só confirma que o webhook Make foi aceito — ver `verification_note`
 * na entry). Falha genuína (DLQ do Worker) vira `failed` nos 3. Consequência
 * pra este módulo: se depois dessa reconciliação uma entry desses 3 canais
 * AINDA está `scheduled` e vencida, isso agora significa algo real (Worker
 * inalcançável, cron/alarm ainda não processou, ou reconciliação não rodou) —
 * voltou a ser `overdue-pollable`, não mais terminal-by-design. **Twitter
 * continua fora** — não passa pelo Worker (via Buffer MCP, chamado direto
 * pelo orchestrator), sem reconciliador equivalente ainda.
 */

/** Canais cujo `scheduled` é ESTADO TERMINAL — não há poll pós-dispatch.
 * Ver #5766 acima: LinkedIn/Instagram/Threads saíram deste conjunto porque
 * `verify-social-worker-dispatch.ts` agora reconcilia os 3 antes deste check
 * rodar. Só Twitter (via Buffer, sem reconciliador) permanece. */
export const FIRE_AND_FORGET_PLATFORMS = new Set(["twitter"]);

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

/** Rótulo em pt-BR por motivo — a frase é lida pelo editor, não pelo código. */
const REASON_LABEL: Record<PrevSocialFinding["reason"], string> = {
  failed: "dispatch falhou",
  "overdue-pollable": "agendado e não publicado",
};

/** Resumo de uma linha para o log/terminal. `null` quando não há o que dizer. */
export function formatPrevSocialSummary(report: PrevSocialReport, prevEdition: string): string | null {
  if (report.findings.length === 0) return null;
  const parts = report.findings.map((f) => `${f.platform}/${f.destaque} (${REASON_LABEL[f.reason]})`);
  return `edição anterior ${prevEdition}: ${report.findings.length} post(s) social(is) exigem atenção — ${parts.join(", ")}`;
}
