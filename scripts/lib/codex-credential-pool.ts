/**
 * scripts/lib/codex-credential-pool.ts (#7250)
 *
 * Lógica PURA (sem I/O) do alarme das contas OpenAI Codex do Hermes. Mesmo
 * molde de `scripts/lib/kit-doi-orphan-guard.ts` — decisão pura e testável
 * aqui, I/O em `scripts/codex-credential-alarm.ts`.
 *
 * ─── Por que este alarme existe (#7250) ─────────────────────────────────────
 *
 * O Hermes delega codificação a contas **OpenAI Codex via OAuth**, não por API
 * key. Isso elimina o caminho óbvio de monitoramento: **não existe endpoint de
 * saldo**. Não há como perguntar "quanto resta"; só é possível observar o que
 * a última tentativa de uso registrou.
 *
 * O que torna o alarme viável é o Hermes já persistir esse resultado, por
 * conta, em `~/.hermes/auth.json` → `credential_pool["openai-codex"]`. Cada
 * entrada carrega `last_status`, `last_error_reason`, `last_error_code` e
 * `last_error_reset_at` — dado estruturado, não prosa a ser adivinhada.
 *
 * ─── O que a medição de 03/09/2026 revelou, e muda a urgência ───────────────
 *
 * Estado ao vivo no momento em que este módulo foi escrito:
 *
 *   vjpixel        exhausted  usage_limit_reached  429  volta 2026-09-29
 *   diaria.editor  exhausted  usage_limit_reached  429  volta 2026-10-02
 *   memelab        ok
 *
 * **A data não é inferida: vem da própria OpenAI.** O corpo do 429 traz
 * `resets_at` (epoch) e `resets_in_seconds`, e o Hermes copia o primeiro para
 * `last_error_reset_at`. Nas 6 amostras registradas em `~/.hermes/sessions/`,
 * `resets_in_seconds` variou entre **21,9 e 29,2 dias** — todas em `plan_type:
 * "go"`.
 *
 * Isso é o que muda o risco: o horizonte de recuperação é de SEMANAS, não de
 * horas. Se a última conta esgotar, a delegação Codex fica fora por semanas e
 * nada avisa — o editor descobriria pela ausência de trabalho entregue.
 *
 * O que essas amostras NÃO provam é o formato do ciclo. Uma janela de 30 dias
 * explicaria os números; uma janela semanal com acúmulo também. Este módulo
 * não afirma nem depende de nenhuma das duas: ele só repassa a data que a
 * OpenAI devolveu.
 *
 * ─── A distinção que decide se o alarme presta ──────────────────────────────
 *
 * Esgotamento de cota (`usage_limit_reached`, HTTP 429) precisa ser
 * distinguível de OAuth expirado, erro de rede e falha do wrapper — senão o
 * alarme dispara pelo motivo errado, ou pior: o esgotamento real se esconde
 * atrás de um erro genérico. Por isso `classifyCodexCredential` NUNCA infere
 * esgotamento a partir de `last_status` sozinho: exige a razão registrada.
 * Motivo desconhecido vira `indeterminado`, estado de primeira classe — mesma
 * disciplina que o épico #7172 estabeleceu para as métricas (decisão 14):
 * "não sei" e "está tudo bem" nunca podem colapsar no mesmo valor.
 *
 * ─── Aviso na PENÚLTIMA conta, não só na última ─────────────────────────────
 *
 * Decisão do editor (#7250): alarmar quando resta UMA conta viva, não quando
 * resta zero. É a diferença entre "recarregue quando puder" e "está tudo
 * parado agora" — e, com reset mensal, entre ter margem e não ter nenhuma.
 */

/** Razão registrada pelo Hermes quando a conta bateu o limite do plano. */
export const CODEX_EXHAUSTION_REASON = "usage_limit_reached";

/** HTTP code que acompanha o esgotamento de cota. */
export const CODEX_EXHAUSTION_CODE = 429;

/**
 * Quantas contas VIVAS ainda restando já disparam o alarme.
 *
 * `1` = avisa quando sobra a última. Com reset mensal, avisar só em zero
 * significa avisar quando já não há o que fazer por semanas.
 */
export const CODEX_ALARM_LIVE_THRESHOLD = 1;

/** Uma entrada do `credential_pool` como o Hermes a persiste. Campos extras
 *  (tokens, fingerprints) são deliberadamente omitidos: este módulo nunca
 *  precisa deles, e não tê-los no tipo impede que vazem por acidente num log
 *  ou numa mensagem de alarme — o canal de entrega do contínuo é o Telegram. */
export interface CodexCredentialEntry {
  readonly label?: string;
  readonly id?: string;
  readonly priority?: number;
  readonly last_status?: string | null;
  readonly last_error_reason?: string | null;
  readonly last_error_code?: number | string | null;
  readonly last_error_reset_at?: number | string | null;
}

export type CodexCredentialState = "viva" | "esgotada" | "indeterminada";

export interface CodexCredentialVerdict {
  /** Rótulo legível da conta. Nunca o token. */
  readonly label: string;
  readonly state: CodexCredentialState;
  /** ISO do momento em que a cota volta, quando o Hermes registrou. */
  readonly resetsAtIso: string | null;
  /** Por que este veredito — texto curto, para a mensagem do alarme. */
  readonly reason: string;
}

/** Converte o `last_error_reset_at` do Hermes (epoch em segundos, número ou
 *  string) em ISO. Devolve `null` para ausente ou ilegível — nunca inventa
 *  data, porque "volta em algum momento" e "não sei quando" são respostas
 *  diferentes para quem decide se recarrega a conta agora. */
export function parseResetAt(raw: number | string | null | undefined): string | null {
  if (raw === null || raw === undefined || raw === "") return null;
  const seconds = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  const ms = seconds * 1000;
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

/**
 * Classifica UMA conta. Pura.
 *
 * `esgotada` exige a razão registrada — nunca é inferida de `last_status`
 * sozinho. Uma conta com `last_status: "error"` e razão desconhecida é
 * `indeterminada`, não esgotada: o alarme prefere dizer "não sei" a afirmar
 * um esgotamento que pode ser OAuth expirado ou rede.
 */
export function classifyCodexCredential(entry: CodexCredentialEntry): CodexCredentialVerdict {
  const label = entry.label ?? entry.id ?? "(sem rótulo)";
  const resetsAtIso = parseResetAt(entry.last_error_reset_at);
  const status = (entry.last_status ?? "").toLowerCase();
  const reason = (entry.last_error_reason ?? "").toLowerCase();
  const code = entry.last_error_code === null || entry.last_error_code === undefined
    ? null
    : Number(entry.last_error_code);

  if (status === "ok") {
    return { label, state: "viva", resetsAtIso: null, reason: "last_status=ok" };
  }

  if (reason === CODEX_EXHAUSTION_REASON || code === CODEX_EXHAUSTION_CODE) {
    return {
      label,
      state: "esgotada",
      resetsAtIso,
      reason: `${entry.last_error_reason ?? "?"} (HTTP ${code ?? "?"})`,
    };
  }

  if (!status) {
    return { label, state: "indeterminada", resetsAtIso, reason: "sem last_status registrado" };
  }

  return {
    label,
    state: "indeterminada",
    resetsAtIso,
    reason: `last_status=${entry.last_status} sem razão de cota reconhecida`,
  };
}

export interface CodexPoolVerdict {
  readonly verdicts: readonly CodexCredentialVerdict[];
  readonly vivas: number;
  readonly esgotadas: number;
  readonly indeterminadas: number;
  /** `true` quando o número de contas VIVAS caiu ao limiar ou abaixo. */
  readonly shouldAlarm: boolean;
  /** `true` quando NENHUMA conta está viva — delegação parada agora. */
  readonly allExhausted: boolean;
}

/**
 * Avalia o pool inteiro. Pura.
 *
 * Conta `indeterminada` **não** é contada como viva. Fail-closed de propósito:
 * o custo de alarmar à toa é uma mensagem; o de não alarmar é o editor
 * descobrir semanas depois, pela ausência de trabalho entregue.
 */
export function evaluateCodexPool(
  entries: readonly CodexCredentialEntry[],
  liveThreshold: number = CODEX_ALARM_LIVE_THRESHOLD,
): CodexPoolVerdict {
  const verdicts = entries.map(classifyCodexCredential);
  const vivas = verdicts.filter((v) => v.state === "viva").length;
  const esgotadas = verdicts.filter((v) => v.state === "esgotada").length;
  const indeterminadas = verdicts.filter((v) => v.state === "indeterminada").length;
  return {
    verdicts,
    vivas,
    esgotadas,
    indeterminadas,
    shouldAlarm: verdicts.length > 0 && vivas <= liveThreshold,
    allExhausted: verdicts.length > 0 && vivas === 0,
  };
}

/** Fingerprint para idempotência do alarme — muda quando o CONJUNTO de
 *  estados muda, não a cada leitura. Assim o alarme não repete enquanto a
 *  situação for a mesma, e volta a disparar quando piora ou melhora. */
export function computeCodexPoolFingerprint(v: CodexPoolVerdict): string {
  return v.verdicts
    .map((c) => `${c.label}:${c.state}`)
    .sort()
    .join("|");
}

/** Corpo do alarme, em texto. Nunca inclui token, refresh_token nem
 *  fingerprint de segredo — só rótulo, estado e data de retorno. */
export function buildCodexAlarmMessage(v: CodexPoolVerdict, nowIso: string): string {
  const linhas = v.verdicts.map((c) => {
    const volta = c.resetsAtIso ? ` — volta ${c.resetsAtIso.slice(0, 16).replace("T", " ")} UTC` : "";
    return `  ${c.label.padEnd(16)} ${c.state.toUpperCase().padEnd(14)} ${c.reason}${volta}`;
  });

  const titulo = v.allExhausted
    ? "TODAS as contas Codex estão esgotadas — a delegação está parada."
    : `Resta ${v.vivas} conta Codex viva de ${v.verdicts.length}.`;

  const nota = v.allExhausted
    ? "Nenhum trabalho delegado ao Codex vai rodar até uma conta voltar ou ser recarregada."
    : "Quando a última esgotar, a delegação para — e a volta é medida em SEMANAS, não em horas.";

  const indet = v.indeterminadas > 0
    ? `\n${v.indeterminadas} conta(s) em estado INDETERMINADO — o Hermes registrou falha sem razão de cota reconhecível. Pode ser OAuth expirado ou rede, não necessariamente cota. Não são contadas como vivas (fail-closed).\n`
    : "";

  return [
    titulo,
    "",
    linhas.join("\n"),
    "",
    nota,
    indet,
    `Fonte: ~/.hermes/auth.json → credential_pool["openai-codex"], lido em ${nowIso}.`,
    "Não há endpoint de saldo — estas contas são OAuth, então o único sinal é o resultado da última tentativa de uso.",
    "A data de retorno é a que a OpenAI devolve no 429 (`resets_at`), não uma estimativa nossa.",
  ].join("\n");
}
