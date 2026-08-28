# Kit Creator Network — estado e decisões

> **Status: setup inicial FEITO pelo editor em 28/08/2026** (https://app.kit.com/creator-network/setup).
> Issue guarda-chuva: **#6674**. Este doc é o registro vivo do canal — atualizar aqui quando
> a lista de criadores recomendados ou o estado do slot mudar.

O **Creator Network** da Kit é a rede de recomendação cruzada entre newsletters: outras
publicações recomendam a diar.ia.br no funil delas, e (opcionalmente) nós recomendamos
outras no nosso. É canal de aquisição **sem custo recorrente** — não gasta crédito de API
nem mídia paga —, o que o coloca no topo da ordem de preferência do projeto
(`CLAUDE.md` → "Zero custo recorrente").

---

## Decisões do editor (28/08/2026)

| # | Decisão | Valor |
|---|---|---|
| 1 | Opt-in na rede | **Sim** — feito na UI pelo editor |
| 2 | Exibir recomendações de terceiros no NOSSO funil | **Sim** |
| 3 | Curadoria dos criadores que recomendamos | **Manual, item a item** — o editor escolhe; não aceitamos a curadoria automática da Kit |
| 4 | Onde registrar o estado | Este doc |

A decisão 2 é um trade-off editorial genuíno (recomendar terceiros custa atenção do leitor
recém-inscrito) e foi levada ao editor em vez de assumida. A 3 é o que a torna aceitável:
reciprocidade sim, mas com a nossa marca só ao lado do que passou pelo mesmo critério
editorial das fontes — público BR, tema compatível, sem infoproduto/growth-hacking.

---

## Estado do canal

| Item | Estado | Última verificação |
|---|---|---|
| Perfil da publicação na rede | ⬜ a confirmar | — |
| Opt-in na rede | ✅ feito pelo editor | 28/08/2026 |
| Criadores que RECOMENDAMOS | ⬜ nenhum escolhido ainda | — |
| Quem NOS recomenda | ⬜ desconhecido | — |
| Slot de exibição no nosso funil | ⬜ não verificado (ver ressalva abaixo) | — |
| Atribuição de origem nos assinantes novos | ⬜ não verificado | — |

### ⚠️ Ressalva técnica: o nosso cadastro não passa pelo formulário nativo da Kit

Os 3 workers de assinatura cadastram via `POST /v4/subscribers` (#6339), **não** pelo
formulário hospedado da Kit. Isso já é conhecido por outro motivo — é a razão de
`publishing.newsletter.subscriber_backend` continuar em `beehiiv`: a atribuição nativa
(`KitSubscriberAttribution`) só é populada por quem entra pelo formulário nativo
(#6425 Parte A).

Consequência para este canal, a **verificar antes de dar a decisão 2 como implementada**:
a tela "recommended by" da Kit é parte do fluxo do formulário/landing hospedado. Se o
nosso cadastro nunca passa por lá, ligar a exibição na conta pode não produzir efeito
nenhum no funil real. Dois desdobramentos possíveis:

- **Se a exibição exigir o formulário nativo** — a decisão 2 fica pendente de uma mudança
  de funil (rotear parte do cadastro pelo form da Kit), que é decisão à parte e não estava
  no escopo da pergunta feita ao editor.
- **Se houver snippet/embed independente** — dá pra montar no nosso próprio pós-inscrição
  sem tocar no fluxo de cadastro.

### ⚠️ O backend de ENVIO está na Beehiiv, não na Kit

Desde 28/08/2026 o envio da diária voltou pra Beehiiv por incidente de entregabilidade no
Gmail (`platform.config.json` → `publishing.newsletter.backend_note`). Isso **não** bloqueia
o Creator Network — a rede opera sobre o perfil/formulários da publicação na Kit, não sobre
de onde a edição é disparada —, mas significa que assinante captado pela rede entra numa
conta que hoje não é a que envia. A rampa `kit_diaria` (`audience_tag: rampa-kit`) é o
mecanismo que move gente pro envio via Kit; assinante novo vindo da rede precisa cair num
dos dois lados de forma explícita, nunca em nenhum.

---

## Como medir

Sem atribuição, o canal fica invisível na contabilidade de CAC/leitor
(`scripts/lib/cac.ts`, `scripts/lib/leitor.ts`). A verificar via API/MCP `kit`:

1. Se o assinante criado pela rede carrega origem identificável (`attribution`, tag, ou
   campo equivalente) — e qual o valor exato.
2. Se sim, incluir o canal na agregação por UTM/origem já consumida pelo Studio
   (`scripts/count-subscriptions-by-utm.ts` → `studio-ui/studio-utms.ts`).

Enquanto (1) não for respondido, qualquer número atribuído à rede é estimativa, não medição —
tratar como tal em relatório.
