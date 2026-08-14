# GA4: checklist de conserto no painel GTM/GA4

Issue: [#5248](https://github.com/vjpixel/diaria-studio/issues/5248).

**Decisão do editor (14/08/2026): CONSERTAR GA4, não aposentar.** GA4 fica
como instrumentação viva, complementar ao log próprio de referrer de
assistente de IA (`scripts/lib/shared/ai-referrer-log.ts`, #4558 Parte C) —
os dois cobrem sinais diferentes: GA4 dá comportamento pós-clique na home
(sessões, funil, públicos-alvo pra Ads), o log próprio dá atribuição de
citação por assistente quando o `Referer` chega (35–70% do tráfego de
assistente não chega, cai como "direct" — o log próprio não fecha esse
buraco, só mitiga).

Este documento é o passo-a-passo pronto pro editor executar no painel. A
ação de painel em si (instalar/publicar tag, confirmar coleta) é dele — o
código deste repo não tem nenhum ponto de integração com GTM/GA4 (levantado
abaixo), então não há nada pra implementar aqui além deste guia.

## O que já sabemos (levantamento no código, 14/08/2026)

Busca no repo inteiro (`workers/`, `context/`, `docs/`, `scripts/`) por
`GTM-TC8C65ZN`, `gtag(`, IDs de measurement (`G-XXXXXXX`) e `dataLayer`: **zero
resultado**. O container GTM e a propriedade GA4 existem inteiramente no
painel (Tag Manager + Analytics), sem nenhum snippet, referência ou
configuração versionada neste repo. Achados adjacentes (não é instrumentação
GA4 em si, mas contexto útil):

- `scripts/clarice-cta-ab-setup.ts` (linha ~411) já loga um lembrete manual
  pra DESLIGAR "Activate Google Analytics tracking" nas campanhas Brevo —
  esse toggle é da Brevo, reescreve UTMs quando ligado, e é uma superfície
  GA **diferente** desta issue (não conflita, mas evita confundir os dois ao
  auditar).
- `docs/experiments/cta-ab-mensal-2606-07.md` documenta um incidente real
  desse toggle (campanhas 95/96 tiveram UTM sobrescrito) — mesma disciplina:
  cuidado pra não misturar "GA tracking da Brevo" com "GA4/GTM do site".
- Nenhum vestígio no repo do incidente #4348 (tag de conversão do Google Ads
  `17790097065` disparando em `All Pages`) — confirma que o fix daquela issue
  também foi 100% painel, sem código a auditar aqui.

## Passo a passo no painel

### 1. Acessar o container GTM

1. Abrir [tagmanager.google.com](https://tagmanager.google.com/), entrar no
   container **`GTM-TC8C65ZN`**.
2. Ir em **Tags** (menu lateral) e listar todas as tags existentes. Anotar:
   - Quais tags existem (nome + tipo).
   - Quais estão **publicadas** (versão live) vs. só salvas em rascunho.
   - Confirmar que a tag de conversão do LinkedIn está lá (já sabida, #5248
     corpo da issue) — serve de âncora pra saber que o container em si está
     ativo e recebendo tráfego do site.

### 2. Verificar/criar a tag de configuração GA4

1. Em **Tags** → **Novo** (ou editar se já existir uma tag `GA4 Configuration`
   / `Google Analytics: GA4 Configuration`):
   - Tipo: **Google Analytics: GA4 Configuration**.
   - **Measurement ID**: da propriedade GA4 do projeto (`G-XXXXXXX` — conferir
     em GA4 → Admin → Fluxos de dados → escolher o fluxo do site → topo da
     tela). Se a propriedade/fluxo de dados não existir ainda, criar em GA4
     → Admin → Criar propriedade, escolher **Web** como plataforma, apontar
     pro domínio público (`diar.ia.br`, custom hostname da Beehiiv).
   - **Acionador**: `All Pages` (ou `Initialization - All Pages` se o
     workspace já usa esse padrão) — dispara em toda pageview, é a tag base
     que injeta o `gtag.js`/`dataLayer` antes de qualquer evento.
2. Salvar a tag.

### 3. Publicar o container

1. No canto superior direito, **Enviar** (Submit).
2. Nome da versão: algo como `GA4 configuration tag — #5248`.
3. Descrição: referenciar a issue.
4. **Publicar** (não deixar só como rascunho — rascunho não dispara em
   produção).

### 4. Validar que a propriedade recebe evento

1. Abrir GA4 → escolher a propriedade → **Relatórios** → **Tempo real**
   (Realtime report).
2. Em outra aba/dispositivo, visitar `https://diar.ia.br/` (navegação normal,
   sem bloqueador de anúncios/rastreamento — extensões tipo uBlock Origin
   bloqueiam o próprio `gtag.js` e dariam falso negativo).
3. Confirmar que o relatório em Tempo Real mostra **≥1 usuário ativo** e ao
   menos 1 evento `page_view` na janela dos últimos 30 minutos.
4. Se não aparecer nada em ~2 minutos:
   - Conferir no GTM se a versão publicada é a mesma que tem a tag GA4
     (às vezes o Submit salva mas não promove a versão certa a "live").
   - Usar o **Preview mode** do GTM (Preview & Debug) apontando pra
     `https://diar.ia.br/` — mostra em tempo real se a tag GA4 disparou e
     qual acionador a ativou, mais granular que o Tempo Real do GA4.
   - Checar bloqueador de conteúdo/rastreamento no navegador de teste.

### 5. Reconferir a tag de conversão do Google Ads (#4348)

A issue #5248 pede reconfirmar, antes de religar qualquer campanha paga, que
o fix do #4348 (tag de conversão `17790097065` disparando em `All Pages` em
vez de só no signup) segue publicado:

1. Em **Tags**, abrir a tag de conversão do Google Ads (`17790097065` ou
   nome equivalente — buscar por "Google Ads" no tipo).
2. Conferir o **acionador**: deve ser um evento específico de signup (ex.:
   `Form Submission` filtrado pra página de obrigado, ou um evento custom de
   confirmação de assinatura) — **nunca** `All Pages`.
3. Se o acionador estiver certo na versão publicada atual, está confirmado.
   Se não, corrigir e publicar antes de reativar qualquer campanha Ads —
   com o acionador errado, o algoritmo de otimização do Google usa pageview
   como proxy de conversão, inflando o CPA reportado e distorcendo o
   otimizador de lances.

## Depois de confirmado

Se os passos 1–4 confirmarem coleta ativa, comentar em #5248 fechando o
item de verificação (a issue continua com dependência `local`/painel — não
fecha sozinha via PR de código, ver decisão do editor no comentário de
14/08/2026). Se GA4 seguir sem coletar depois deste passo a passo, o
próximo passo é abrir uma issue nova e mais restrita (ex.: measurement ID
errado, CSP do host bloqueando `googletagmanager.com`, propriedade GA4
desativada) — não reabrir esta.
