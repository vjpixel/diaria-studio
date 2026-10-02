/**
 * scripts/lib/mensal/retrospectiva-divulgacao.ts (#9474)
 *
 * Estado por canal + regras puras do loop de divulgação da Retrospectiva do
 * Mês em `/diaria-mensal-apoiadores` — o espelho, pro produto mensal, do que
 * `/diaria-artigo-especial` (#5979) faz pro Artigo Especial.
 *
 * ## State por canal
 *
 * `data/monthly/{ciclo}/_internal/divulgacao-published.json`, mesmo shape de
 * `data/artigo-especial/{ano}-{slug}/published.json` (reusa
 * `parseChannelStates`/`decideChannelAction`/`withChannelState`/builders de
 * `scripts/lib/artigo-especial-state.ts` — nada reimplementado), com 6 canais:
 *
 *   | canal             | quem grava                                              |
 *   |-------------------|---------------------------------------------------------|
 *   | `pagina`          | `verify-retrospectiva-page.ts` (GET 200 + KV)            |
 *   | `apoiase`         | `mark-retrospectiva-channel.ts` (post via Claude in Chrome) |
 *   | `linkedin_pagina` | `publish-retrospectiva-linkedin.ts` (Worker)             |
 *   | `linkedin_perfil` | `mark-retrospectiva-channel.ts` (composer manual)         |
 *   | `box`             | `update-retrospectiva-box.ts`                             |
 *   | `email`           | `mark-retrospectiva-channel.ts --sync-email` (deriva do state do publisher) |
 *
 * O canal `email` NÃO duplica o guard do publisher Kit: a fonte de verdade do
 * broadcast segue sendo `_internal/beehiiv-apoiadores-state.json`
 * (`monthly-apoiadores-state.ts`, nome histórico mantido por compat). Este
 * módulo só PROJETA aquele estado no vocabulário done/failed
 * (`deriveEmailChannelState`) pra que o resumo da skill leia um arquivo só.
 * Lição do #7655 preservada: `done` aqui diz o que os SCRIPTS fizeram, nunca
 * o que o ESP entregou — antes de afirmar "enviado", perguntar ao Kit.
 */

import { existsSync, readFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { writeFileAtomic } from "../atomic-write.ts";
import { parseChannelStates, type ChannelState } from "../artigo-especial-state.ts";
import { DIARIA_RETROSPECTIVA_URL } from "../canonical-urls.ts";
import { mensalPathFromCycle } from "../shared/retrospectiva-path.ts";
import type { ApoiadoresState } from "./monthly-apoiadores-state.ts";

export const RETROSPECTIVA_DIVULGACAO_CHANNELS = [
  "pagina",
  "apoiase",
  "linkedin_pagina",
  "linkedin_perfil",
  "box",
  "email",
] as const;
export type RetrospectivaDivulgacaoChannel = (typeof RETROSPECTIVA_DIVULGACAO_CHANNELS)[number];

export interface RetrospectivaDivulgacaoState {
  cycle: string;
  channels: Partial<Record<RetrospectivaDivulgacaoChannel, ChannelState>>;
}

const STATE_FILENAME = "divulgacao-published.json";

/** Path do state file para um `monthlyDir(cycle)` já resolvido. */
export function retrospectivaDivulgacaoStatePath(monthlyDirPath: string): string {
  return resolve(monthlyDirPath, "_internal", STATE_FILENAME);
}

/**
 * Lê o state. Fail-soft (mesma disciplina de `readArtigoEspecialState`):
 * ausente → vazio, silencioso; presente mas ilegível/shape inesperado → vazio
 * COM aviso em stderr (nunca mascarar um estado perdido em silêncio).
 */
export function readRetrospectivaDivulgacaoState(path: string, cycle: string): RetrospectivaDivulgacaoState {
  const empty: RetrospectivaDivulgacaoState = { cycle, channels: {} };
  if (!existsSync(path)) return empty;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<RetrospectivaDivulgacaoState>;
    if (typeof parsed.cycle !== "string" || !parsed.channels || typeof parsed.channels !== "object") {
      process.stderr.write(`[retrospectiva-divulgacao] AVISO: ${path} tem shape inesperado — tratando como vazio.\n`);
      return empty;
    }
    if (parsed.cycle !== cycle) {
      process.stderr.write(
        `[retrospectiva-divulgacao] AVISO: ${path} é do ciclo "${parsed.cycle}", não "${cycle}" — tratando como vazio.\n`,
      );
      return empty;
    }
    const channels = parseChannelStates(
      parsed.channels as Record<string, unknown>,
      RETROSPECTIVA_DIVULGACAO_CHANNELS,
      path,
      "retrospectiva-divulgacao",
    );
    return { cycle, channels };
  } catch (e) {
    process.stderr.write(
      `[retrospectiva-divulgacao] AVISO: ${path} existe mas não pôde ser lido/parseado (${(e as Error).message}) — tratando como vazio.\n`,
    );
    return empty;
  }
}

/** Escreve o state (atômico), criando `_internal/` se faltar. */
export function writeRetrospectivaDivulgacaoState(path: string, state: RetrospectivaDivulgacaoState): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileAtomic(path, JSON.stringify(state, null, 2) + "\n");
}

// ── --skip ──────────────────────────────────────────────────────────────

/** Tokens aceitos em `--skip` → canais. `linkedin` cobre os dois LinkedIn. */
const SKIP_TOKEN_TO_CHANNELS: Record<string, readonly RetrospectivaDivulgacaoChannel[]> = {
  pagina: ["pagina"],
  apoiase: ["apoiase"],
  linkedin: ["linkedin_pagina", "linkedin_perfil"],
  box: ["box"],
  email: ["email"],
};

/**
 * Pura: `--skip pagina,apoiase,linkedin,box,email` → conjunto de canais.
 * Token desconhecido LANÇA (typo nunca vira "não pulou nada" em silêncio —
 * mesma disciplina do `--only` de `publish-artigo-especial-linkedin.ts`).
 */
export function parseRetrospectivaSkip(skipArg: string | undefined): Set<RetrospectivaDivulgacaoChannel> {
  const out = new Set<RetrospectivaDivulgacaoChannel>();
  if (!skipArg) return out;
  const tokens = skipArg
    .split(",")
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);
  const invalid = tokens.filter((t) => !(t in SKIP_TOKEN_TO_CHANNELS));
  if (invalid.length > 0) {
    throw new Error(
      `--skip contém valor(es) não reconhecido(s): ${invalid.join(", ")} (esperado: ${Object.keys(SKIP_TOKEN_TO_CHANNELS).join(", ")}).`,
    );
  }
  for (const t of tokens) for (const ch of SKIP_TOKEN_TO_CHANNELS[t]) out.add(ch);
  return out;
}

// ── URL / rótulos ──────────────────────────────────────────────────────

/**
 * Pura: URL pública da Retrospectiva do ciclo — `retrospectiva.diar.ia.br/{AAMM}`
 * com o mês de CONTEÚDO (`2609-10` → `/2609`), via `mensalPathFromCycle`, a
 * MESMA função que o Worker usa pra rotear e o publisher pra derivar a chave
 * do KV. Lança em ciclo malformado.
 */
export function retrospectivaUrl(cycle: string): string {
  const path = mensalPathFromCycle(cycle);
  if (!path) throw new Error(`ciclo "${cycle}" não vira path de retrospectiva (esperado YYMM-MM, ex: 2609-10).`);
  return `${DIARIA_RETROSPECTIVA_URL}/${path}`;
}

const MESES = [
  "Janeiro",
  "Fevereiro",
  "Março",
  "Abril",
  "Maio",
  "Junho",
  "Julho",
  "Agosto",
  "Setembro",
  "Outubro",
  "Novembro",
  "Dezembro",
] as const;

/** Pura: mês de CONTEÚDO do ciclo por extenso, capitalizado (`2609-10` → `Setembro`). */
export function contentMonthLabel(cycle: string): string {
  const path = mensalPathFromCycle(cycle);
  if (!path) throw new Error(`ciclo "${cycle}" inválido (esperado YYMM-MM).`);
  return MESES[Number(path.slice(2)) - 1];
}

// ── CTA dos posts PÚBLICOS (LinkedIn) ──────────────────────────────────

/**
 * Linha literal de CTA dos posts públicos (LinkedIn página + perfil) — adaptação
 * da frase do editor no Artigo Especial (#5979: "Apoie nosso trabalho e leia o
 * artigo completo em: apoia.se/diaria"). Não reescrever, não passar por
 * Clarice/humanizador.
 */
export const RETROSPECTIVA_PUBLIC_CTA = "Apoie nosso trabalho e leia a retrospectiva completa em: apoia.se/diaria";

/** Hosts que servem a Retrospectiva paga — o canônico e o legado (301, #7658). */
const PAYWALLED_HOSTS_RE = /\b(?:retrospectiva|artigo)\.diar\.ia\.br\b/i;

/**
 * Pura: problemas de um texto de post PÚBLICO da Retrospectiva (lista vazia =
 * ok). Regra herdada do Artigo Especial (decisão do editor no #9474): o CTA
 * aponta pro apoia.se, NUNCA pra URL direta da retrospectiva paywalled — é no
 * apoia.se que a conversão acontece.
 */
export function publicPostCtaProblems(text: string): string[] {
  const problems: string[] = [];
  if (PAYWALLED_HOSTS_RE.test(text)) {
    problems.push("o texto cita a URL da retrospectiva paywalled (retrospectiva./artigo.diar.ia.br) — post público aponta só pro apoia.se");
  }
  const lines = text.replace(/\r\n/g, "\n").split("\n").map((l) => l.trim());
  if (!lines.includes(RETROSPECTIVA_PUBLIC_CTA)) {
    problems.push(`falta a linha literal de CTA: "${RETROSPECTIVA_PUBLIC_CTA}"`);
  }
  return problems;
}

// ── Canal email: projeção do state do publisher Kit ──────────────────────

/**
 * Pura: projeta `beehiiv-apoiadores-state.json` (fonte de verdade do canal
 * email, `publish-monthly-apoiadores-kit.ts`) no `ChannelState` do canal
 * `email`. `null` = nada a gravar (nenhum broadcast criado ainda — canal
 * segue pendente).
 *
 *   - `kitAudienceVerified === false` → `failed` sempre (registro de
 *     INCIDENTE: rascunho com audiência divergente, inclusive se marcado
 *     `sent` — mandar com filtro errado é o pior caso do canal, #6126).
 *   - `status: "sent"` (agendado via `--schedule` ou `--mark-sent` do editor)
 *     → `done`.
 *   - `kitBroadcastId` com audiência confirmada (`true`) → `done`.
 *   - `kitBroadcastId` com `kitAudienceVerified: null` → `failed`: "não
 *     confirmável" não é "ok" (mesma regra do canal email do Artigo Especial).
 *     O rascunho existe — depois de conferir a audiência no painel, o editor
 *     marca `done` à mão via `mark-retrospectiva-channel.ts`.
 */
export function deriveEmailChannelState(apoiadores: ApoiadoresState | null): ChannelState | null {
  if (!apoiadores) return null;
  const attemptedAt = apoiadores.sentAt ?? apoiadores.preparedAt ?? "";
  const id = apoiadores.kitBroadcastId;
  if (apoiadores.kitAudienceVerified === false) {
    return {
      status: "failed",
      attemptedAt,
      url: null,
      reason: `audiência do broadcast Kit ${id ?? "?"} DIVERGIU do filtro esperado (kitAudienceVerified=false) — conferir no painel antes de qualquer disparo.`,
    };
  }
  if (apoiadores.status === "sent") return { status: "done", attemptedAt, url: null, reason: null };
  if (id === null) return null;
  if (apoiadores.kitAudienceVerified === true) return { status: "done", attemptedAt, url: null, reason: null };
  return {
    status: "failed",
    attemptedAt,
    url: null,
    reason: `rascunho Kit ${id} criado, mas a audiência não foi confirmada na releitura (kitAudienceVerified=null) — conferir no painel e marcar done à mão.`,
  };
}
