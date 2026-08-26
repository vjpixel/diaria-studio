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

/**
 * Campos que `KitBroadcastClick` declara hoje, **com o tipo declarado** —
 * porque conferir só o NOME da chave é metade da verificação (achado P2 do
 * review da PR #6192).
 *
 * Um item `{url: "...", unique_clicks: "3"}` tem todas as chaves certas e
 * mesmo assim viola o tipo: `unique_clicks` é `number` na declaração. Sem
 * checar o valor, a sonda diria "tipo confere com a realidade" para
 * exatamente o caso que ela existe pra pegar.
 */
export const CAMPOS_DECLARADOS_COM_TIPO = {
  // #6185 (26/08): `id` entrou depois — a sonda o reportou como INESPERADO
  // no 1º clique real, que é exatamente o serviço que ela presta. Declarado
  // aqui, passa a ser verificado como os outros.
  id: "number",
  url: "string",
  unique_clicks: "number",
  click_to_delivery_rate: "number",
  click_to_open_rate: "number",
} as const satisfies Record<string, "string" | "number">;

/** Só os nomes — conveniência de leitura; a verdade é o mapa acima. */
export const CAMPOS_DECLARADOS = Object.keys(
  CAMPOS_DECLARADOS_COM_TIPO,
) as (keyof typeof CAMPOS_DECLARADOS_COM_TIPO)[];

export type VeredictoClicks =
  | {
      status: "inconclusivo";
      motivo: string;
      /** Quantos cliques totais o broadcast registrou (de `stats`), se conhecido. */
      totalClicks?: number;
    }
  | {
      status: "confirmado";
      /** Campos declarados presentes E com o tipo declarado. */
      presentes: string[];
      /** Campos declarados AUSENTES no item real — o tipo mente sobre eles. */
      ausentes: string[];
      /**
       * Campos presentes com o nome certo e o **tipo errado** — a categoria
       * que faltava (P2 do review): passavam por "presentes" e a sonda
       * concluía que o tipo conferia.
       */
      tipoDivergente: { campo: string; esperado: string; recebido: string }[];
      /** Campos que o Kit devolveu e o tipo não conhece. */
      inesperados: string[];
      /** O item bruto, para inspeção e para virar fixture de teste. */
      amostra: Record<string, unknown>;
      /** Quantos itens foram inspecionados (ver `AMOSTRAS_INSPECIONADAS`). */
      itensInspecionados: number;
    };

/**
 * Quantos itens do array são inspecionados. Mais de 1 porque olhar só
 * `clicks[0]` faz o veredicto depender da sorte de qual item caiu no índice
 * zero (P3 do review) — se a API devolvesse shapes heterogêneos, um item
 * divergente no meio passaria batido.
 */
export const AMOSTRAS_INSPECIONADAS = 3;

function ehObjetoSimples(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

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

  // Guard de ITEM, análogo ao de array acima (P2 do review). Sem ele,
  // `clicks: [42]` virava "confirmado com 4 campos ausentes" — veredicto
  // que descreve o item errado — e `clicks: [null]` lançava em `Object.keys`.
  const itens = clicks.slice(0, AMOSTRAS_INSPECIONADAS);
  const naoObjetos = itens.filter((i) => !ehObjetoSimples(i));
  if (naoObjetos.length > 0) {
    return {
      status: "inconclusivo",
      motivo:
        `o array tem item que não é objeto (ex: ${JSON.stringify(naoObjetos[0])}) — ` +
        `shape inesperado, diferente do documentado. Não dá pra comparar campos ` +
        `contra isto; reconferir o envelope antes de concluir qualquer coisa.`,
      totalClicks,
    };
  }

  const objetos = itens as Record<string, unknown>[];
  const amostra = objetos[0];
  const declarados = new Set<string>(CAMPOS_DECLARADOS);

  // Um campo conta como problema se QUALQUER item inspecionado o tiver
  // ausente ou com tipo errado — o veredicto não pode depender da sorte do
  // índice 0.
  const ausentes: string[] = [];
  const tipoDivergente: { campo: string; esperado: string; recebido: string }[] = [];
  const presentes: string[] = [];

  for (const campo of CAMPOS_DECLARADOS) {
    const esperado = CAMPOS_DECLARADOS_COM_TIPO[campo];
    const faltouEm = objetos.find((o) => !(campo in o));
    if (faltouEm) {
      ausentes.push(campo);
      continue;
    }
    const divergente = objetos.find((o) => typeof o[campo] !== esperado);
    if (divergente) {
      tipoDivergente.push({
        campo,
        esperado,
        recebido: divergente[campo] === null ? "null" : typeof divergente[campo],
      });
      continue;
    }
    presentes.push(campo);
  }

  const inesperados = [...new Set(objetos.flatMap((o) => Object.keys(o)))].filter((k) => !declarados.has(k));

  return {
    status: "confirmado",
    presentes,
    ausentes,
    tipoDivergente,
    inesperados,
    amostra,
    itensInspecionados: objetos.length,
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

  linhas.push(
    `  CONFIRMADO — há clique real; ${v.itensInspecionados} item(ns) inspecionado(s), nome E tipo de cada campo.`,
  );
  linhas.push(`  ok (nome+tipo): ${v.presentes.join(", ") || "(nenhum!)"}`);
  if (v.ausentes.length) {
    linhas.push(`  AUSENTES:       ${v.ausentes.join(", ")}`);
    linhas.push(`                  ^ KitBroadcastClick declara e o Kit não devolve — corrigir o tipo.`);
  }
  if (v.tipoDivergente.length) {
    for (const d of v.tipoDivergente) {
      linhas.push(`  TIPO ERRADO:    ${d.campo}: declarado ${d.esperado}, recebido ${d.recebido}`);
    }
    linhas.push(`                  ^ nome certo, valor de outro tipo — o pior caso, passa despercebido.`);
  }
  if (v.inesperados.length) {
    linhas.push(`  inesperados:    ${v.inesperados.join(", ")}`);
    linhas.push(`                  ^ o Kit devolve e o tipo não conhece — avaliar se servem.`);
  }
  linhas.push(`  amostra: ${JSON.stringify(v.amostra)}`);
  // A conclusão precisa considerar AMBAS as divergências. Olhar só `ausentes`
  // fazia a sonda afirmar "tipo confere" para um item com os 4 campos
  // tipados errado — P2 do review, e exatamente o que ela existe pra pegar.
  const divergiu = v.ausentes.length > 0 || v.tipoDivergente.length > 0;
  linhas.push(
    divergiu
      ? `  → tipo DIVERGE da realidade; ajustar antes de qualquer consumidor depender dele.`
      : `  → tipo confere com a realidade; travar esta amostra como fixture de teste.`,
  );
  return linhas.join("\n");
}
