# Registro do canal Brevo dos apoiadores mensais (2607-08)

Registro histórico do único envio do digest mensal para os apoiadores Mantenedor/Patrono feito pela Brevo. O canal foi aposentado no #7633 (o envio passou para o Kit, 1º broadcast real em 10/09/2026, ciclo 2608-09, broadcast 25844671). A limpeza dedicada do #14049 apagou os scripts `*-apoiadores-brevo.ts` e a chave `brevo_apoiadores` do `platform.config.json`; este arquivo guarda o que eles carregavam como registro, como o CLAUDE.md e as skills mensais pediam.

## O envio de 04/08/2026

| Campo | Valor |
|---|---|
| Ciclo | 2607-08 |
| Campanha Brevo | 12, "Mensal apoiadores 2607-08" |
| Assunto | "Julho 2026 — Agentes saem do controle" |
| Envio | 04/08/2026 13:09, feito à mão pela UI da Brevo |
| Lista | 8, "Apoio — Mantenedor + Patrono (mensal, one-off 2607-08)", criada em 04/08/2026 07:33 e populada à mão pelo editor no mesmo dia |
| Conta | Brevo da diária (`BREVO_DIARIA_API_KEY`), remetente e reply-to: os endereços do domínio do projeto que o bloco tinha (ver a nota da cópia abaixo) |
| Resultado (API, 08/09/2026) | 10 enviados, 10 entregues, 4 aberturas únicas, 5 clickers, 2 cliques únicos |
| Lista em 08/09/2026 | 10 assinantes (11 únicos, 1 blacklisted) |
| UTM | `utm_source=mensal-apoiadores-brevo`, `utm_campaign=mensal-apoiadores-brevo-{ciclo}-{posicao}` (entrada `mensal-apoiadores-brevo` de `UTM_EMITTERS`, `scripts/lib/shared/utm-registry.ts`) |
| Voto do É IA? | brand `mensal-apoiadores-brevo` no worker poll (`workers/poll/src/lib.ts`, `BRAND_INFO`), merge tag `{{ contact.EMAIL }}` |

Para comparar com os envios Kit, os números de engajamento vêm da Brevo (campanha 12). Esta é a única série histórica de engajamento desta audiência fora do Kit.

## Lição de método (#7655)

O state local (`data/monthly/2607-08/_internal/beehiiv-apoiadores-state.json`) ficou em `draft_prepared`: o envio saiu pela UI e ninguém rodou `--mark-sent`. Por um mês a documentação afirmou que a Brevo nunca tinha enviado, com base nesse state e numa leitura de lista feita antes de ela ser populada. A verificação que corrigiu foi uma chamada à API da Brevo. O state registra o que os scripts fizeram, não o que o ESP fez. O campo `brevoCampaignId` de `scripts/lib/mensal/monthly-apoiadores-state.ts` segue lido só como histórico.

## O que existia no repo até o #14049

- `scripts/publish-monthly-apoiadores-brevo.ts` (Passo 2 da skill: criava a campanha como rascunho na Brevo; nunca foi ele quem enviou a campanha 12).
- `scripts/sync-apoio-nivel-brevo.ts` (convergia o atributo `APOIO_NIVEL` e a lista 8; nunca rodou com `--push` contra a Brevo real).
- `scripts/render-monthly-apoiadores-brevo.ts` e `scripts/lib/mensal/monthly-apoiadores-brevo-render.ts` (render do e-mail). As funções de imagem do ciclo foram para `scripts/lib/mensal/monthly-public-images.ts` e o perfil de UTM para `scripts/lib/shared/utm-registry.ts`.
- 4 testes próprios.

## Bloco `brevo_apoiadores` do `platform.config.json` (removido no #14049)

Cópia literal, menos os campos `sender_email` e `reply_to`: o guard de PII do `gh pr create` (#6753) barra endereço de e-mail em arquivo novo, e esses dois são só o remetente e o reply-to do domínio do projeto, sem dado do envio. O bloco inteiro, com os dois campos, está em `git show c9808fca7:platform.config.json` (último commit de `master` antes da remoção).

```json
{
  "brevo_apoiadores": {
    "api_key_env": "BREVO_DIARIA_API_KEY",
    "list_id": 8,
    "sender_name": "diar.ia.br",
    "status_note": "#7655 (08/09/2026) — CANAL APOSENTADO (sucedido por kit_apoiadores abaixo), mas NÃO natimorto: esta lista ENVIOU de verdade. Campanha 12 (\"Mensal apoiadores 2607-08\", assunto \"Julho 2026 — Agentes saem do controle\") saiu em 04/08/2026 13:09 para a lista 8 — 10 enviados, 10 entregues, 4 aberturas únicas, 5 clickers, 2 cliques únicos (medido na API em 08/09/2026). A lista tem 10 assinantes (11 únicos, 1 blacklisted), não 0. A afirmação anterior aqui (\"NADA chegou a acontecer\") vinha do state local, que ficou em draft_prepared porque o envio foi feito à mão pela UI e ninguém rodou --mark-sent — ver o aviso de método no SKILL.md da skill. Motivo real da migração: o backend da newsletter virou \"kit\" (#7388) e a base inteira migrou (#7386), então um 2º ESP vivo só pra este envio é manutenção sem contrapartida. Ao remover esta chave (e os scripts *-apoiadores-brevo.ts) depois do 1º envio Kit real, PRESERVAR em algum lugar o registro do envio de 04/08 — é a única série histórica de engajamento desta audiência.",
    "note": "#4572/#4593 — lista Brevo dedicada aos apoiadores Mantenedor/Patrono, alvo de scripts/sync-apoio-nivel-brevo.ts (audiência) e scripts/publish-monthly-apoiadores-brevo.ts (Passo 2 da skill /diaria-mensal-apoiadores, cria a campanha). Migrou de segmento Beehiiv pra lista Brevo (plano Launch/free bloqueia 'Include and exclude segments' na Beehiiv, confirmado ao vivo 260804). Mesma conta Brevo de brevo_diaria (api_key_env + sender compartilhados) — lista PRÓPRIA, distinta. list_id=8 confirmado via API pelo coordenador da sessão develop 260804 (fora deste worktree, usando o .env do editor — este worktree isolado não tem a credencial): GET /v3/contacts/lists retornou nome 'Apoio — Mantenedor + Patrono (mensal, one-off 2607-08)', folderId 1, totalSubscribers 0 (vazia — scripts/sync-apoio-nivel-brevo.ts --push é quem popula, ainda não rodado). Nenhuma escrita real (--push, criação de campanha) rodou nesta sessão — só a leitura de confirmação. O nome com sufixo de ciclo ('one-off 2607-08') sugere criação ad-hoc pro 1º envio — antes do 2º envio mensal, o editor precisa decidir se vira uma lista PERMANENTE (sem sufixo de ciclo, reusada todo mês) ou se cada ciclo ganha lista própria; não decidido nesta sessão, ver #4572. CORREÇÃO #7655 (08/09/2026): a frase acima sobre totalSubscribers 0 descrevia a lista antes de ser populada — em 08/09/2026 a API devolveu totalSubscribers 10 (uniqueSubscribers 11, 1 blacklisted), createdAt 04/08/2026 07:33, e campaignStats da campanha 12 com 10 entregues. Quem populou não foi o sync-apoio-nivel-brevo.ts (esse de fato nunca rodou com --push) — foi trabalho manual do editor no painel, no mesmo dia do envio."
  }
}
```
