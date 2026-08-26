/**
 * scripts/lib/kit-click-fields.ts (#6185)
 *
 * Miolo puro da sonda que confirma os **nomes de campo** de
 * `GET /v4/broadcasts/{id}/clicks` contra um clique real.
 *
 * ## Por que isto existe
 *
 * `KitBroadcastClick` (em `lib/kit-client.ts`) declara `url`,
 * `unique_clicks`, `click_to_delivery_rate` e `click_to_open_rate` — mas o
 * docstring de lá registra que **nenhum desses nomes foi verificado com um
 * clique real**. Em 24/08 a conta não tinha broadcast enviado, então só o
 * envelope `{broadcast: {id, clicks}}` foi confirmado, com `clicks: []`.
 *
 * Um tipo que ninguém verificou é uma suposição com sintaxe de garantia. Se
 * os nomes estiverem errados, todo consumidor lê `undefined` e a curadoria
 * por clique (Use Melhor/Radar do mensal, boxes, CTR comportamental) degrada
 * em silêncio — não quebra, só passa a ranquear por nada.
 *
 * ## A distinção que esta sonda protege
 *
 * `clicks: []` tem **duas leituras completamente diferentes**:
 *
 * - **ninguém clicou** — a sonda não conclui nada, roda de novo depois
 * - **o Kit não expõe cliques por link** — achado de bloqueio da migração
 *
 * Só a segunda bloqueia o #463. Confundir as duas foi risco real: com 4
 * destinatários no piloto Patronos, array vazio era o resultado mais
 * provável e o mais fácil de ler errado.
 *
 * Por isso `interpretClicksResponse` devolve `inconclusivo` — nunca
 * `nao_suportado` — quando não há clique. **Ausência de dado não é evidência
 * de ausência de capacidade.**
 */

/** Campos que `KitBroadcastClick` declara hoje, sem verificação ao vivo. */
export const CAMPOS_DECLARADOS = [
  "url",
  "unique_clicks",
  "click_to_delivery_rate",
  "click_to_open_rate",
] as const;

export type VeredictoClicks =
  | {
      status: "inconclusivo";
      motivo: string;
      /** Quantos cliques totais o broadcast registrou (de `stats`), se conhecido. */
      totalClicks?: number;
    }
  | {
      status: "confirmado";
      /** Campos declarados que apareceram no item real. */
      presentes: string[];
      /** Campos declarados AUSENTES no item real — o tipo mente sobre eles. */
      ausentes: string[];
      /** Campos que o Kit devolveu e o tipo não conhece. */
      inesperados: string[];
      /** O item bruto, para inspeção e para virar fixture de teste. */
      amostra: Record<string, unknown>;
    };

export interface EntradaVerificacao {
  /** `clicks` de `GET /broadcasts/{id}/clicks`. */
  clicks: unknown;
  /** `total_clicks` de `GET /broadcasts/{id}/stats`, quando disponível. */
  totalClicks?: number;
  /** `status` do broadcast — para distinguir "não enviado" de "enviado sem clique". */
  broadcastStatus?: string;
}

/**
 * Decide o veredicto a partir da resposta bruta.
 *
 * Puro de propósito: a parte difícil aqui é a INTERPRETAÇÃO (o que um array
 * vazio significa), não a chamada HTTP. Separar deixa a interpretação
 * testável sem rede.
 */
export function interpretClicksResponse(entrada: EntradaVerificacao): VeredictoClicks {
  const { clicks, totalClicks, broadcastStatus } = entrada;

  if (!Array.isArray(clicks)) {
    return {
      status: "inconclusivo",
      motivo:
        `resposta não trouxe um array em 'clicks' (veio ${typeof clicks}) — ` +
        `envelope diferente do documentado, reconferir o shape antes de concluir qualquer coisa`,
      totalClicks,
    };
  }

  if (clicks.length === 0) {
    // O ponto central deste módulo. Nunca dizer "não suportado" aqui.
    const contexto =
      broadcastStatus && broadcastStatus !== "completed" && broadcastStatus !== "sent"
        ? `broadcast ainda em status "${broadcastStatus}" — pode nem ter sido entregue`
        : typeof totalClicks === "number" && totalClicks === 0
          ? "o próprio stats reporta total_clicks=0, ou seja, NINGUÉM clicou"
          : "sem clique registrado até agora";

    return {
      status: "inconclusivo",
      motivo:
        `array vazio — ${contexto}. Isto NÃO prova que o Kit deixa de expor cliques por link; ` +
        `prova apenas que não há clique para expor. Rodar de novo após um clique real.`,
      totalClicks,
    };
  }

  const amostra = clicks[0] as Record<string, unknown>;
  const chaves = Object.keys(amostra);
  const declarados = new Set<string>(CAMPOS_DECLARADOS);

  return {
    status: "confirmado",
    presentes: CAMPOS_DECLARADOS.filter((c) => chaves.includes(c)),
    ausentes: CAMPOS_DECLARADOS.filter((c) => !chaves.includes(c)),
    inesperados: chaves.filter((k) => !declarados.has(k)),
    amostra,
  };
}

/** Render legível — o que o operador lê no terminal. */
export function renderVeredicto(v: VeredictoClicks, broadcastId: number): string {
  const linhas: string[] = [`[kit-click-fields] broadcast ${broadcastId}`];

  if (v.status === "inconclusivo") {
    linhas.push(`  INCONCLUSIVO — ${v.motivo}`);
    if (typeof v.totalClicks === "number") linhas.push(`  stats.total_clicks: ${v.totalClicks}`);
    linhas.push(`  #6185 continua bloqueada (por falta de dado, não por limitação da plataforma).`);
    return linhas.join("\n");
  }

  linhas.push(`  CONFIRMADO — há clique real, os nomes de campo agora são observáveis.`);
  linhas.push(`  presentes:  ${v.presentes.join(", ") || "(nenhum!)"}`);
  if (v.ausentes.length) {
    linhas.push(`  AUSENTES:   ${v.ausentes.join(", ")}`);
    linhas.push(`              ^ KitBroadcastClick declara estes e o Kit não devolve — corrigir o tipo.`);
  }
  if (v.inesperados.length) {
    linhas.push(`  inesperados: ${v.inesperados.join(", ")}`);
    linhas.push(`              ^ o Kit devolve estes e o tipo não conhece — avaliar se servem.`);
  }
  linhas.push(`  amostra: ${JSON.stringify(v.amostra)}`);
  linhas.push(
    v.ausentes.length === 0
      ? `  → tipo confere com a realidade; travar esta amostra como fixture de teste.`
      : `  → tipo DIVERGE da realidade; ajustar antes de qualquer consumidor depender dele.`,
  );
  return linhas.join("\n");
}
