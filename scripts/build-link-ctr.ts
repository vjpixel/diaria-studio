#!/usr/bin/env tsx
/**
 * build-link-ctr.ts
 * Builds a link-level CTR table across all 164 Beehiiv posts.
 * Output: data/link-ctr-table.csv
 */

import * as fs from 'fs';
import * as path from 'path';

const POSTS_DIR = path.join(process.cwd(), 'data/beehiiv-cache/posts');
const OUT_CSV = path.join(process.cwd(), 'data/link-ctr-table.csv');

// ─── Noise filters ────────────────────────────────────────────────────────────

function baseUrl(raw: string): string {
  try {
    const u = new URL(raw);
    u.search = '';
    u.hash = '';
    return u.toString().replace(/\/$/, '');
  } catch {
    return raw;
  }
}

function isEditorial(url: string): boolean {
  let host: string, pathname: string;
  try {
    const u = new URL(url);
    host = u.hostname.toLowerCase().replace(/^www\./, '');
    pathname = u.pathname;
  } catch { return false; }

  // Skip beehiiv infrastructure
  if (host.includes('beehiiv.com')) return false;

  // Skip social sharing widgets
  const socialShare = [
    'facebook.com/sharer', 'twitter.com/intent', 'threads.net/intent',
    'linkedin.com/sharing', 'x.com/intent',
  ];
  if (socialShare.some(s => url.includes(s))) return false;

  // Skip own social channels
  const ownChannels = [
    'facebook.com/diar.ia', 'linkedin.com/company/diaria',
    'youtube.com/@diaria', 'instagram.com/diaria',
  ];
  if (ownChannels.some(s => url.includes(s))) return false;

  // Skip ad/affiliate/sorteador noise
  const noisePatterns = [
    'sorteador.com.br', '_bhiiv=opp_', 'clarice.ai', 'wispr.flow',
    'wispr.ai', 'wisprflow.ai', 'unsubscribe', 'preferences',
    'beehiivstatus.com', 'omnivery_honeypot', 'archive.is',
  ];
  if (noisePatterns.some(s => url.includes(s))) return false;

  // Skip referral links (pplx.ai/username style)
  if (host === 'pplx.ai' && /^\/[a-z0-9_-]+$/i.test(new URL(url).pathname)) return false;

  // Skip broken/garbled URLs (contain spaces or quotes — parsing artifacts)
  if (url.includes(' ') || url.includes('"')) return false;

  // Skip Amazon product links (not editorial)
  if (host === 'amzn.to' || (host === 'amazon.com.br' && pathname.includes('/dp/'))) return false;

  // Skip LinkedIn profile pages (not editorial)
  if (host === 'linkedin.com' && /^\/in\//.test(pathname)) return false;

  // Skip broken double-protocol URLs
  if (/^https?:\/\/https?[:/]/.test(url)) return false;
  if (host === 'https' || host === 'http') return false;

  // Skip bare platform domains with no editorial path
  if (host === 'google.com' && pathname === '/') return false;
  if (host === 'crypto.com' && pathname === '/') return false;

  // Skip job listings, portfolios, and link shorteners to noise
  if (host === 'amazon.jobs') return false;
  if (host === 'gileslaurent.com') return false;
  if (host === 'resulta.do') return false;

  // Skip non-AI editorial filler
  if (pathname.includes('easter-eggs')) return false;
  if (pathname.includes('moltbook-was-peak-ai-theater')) return false;

  return true;
}

// ─── Origin (BR / INT) ────────────────────────────────────────────────────────

function classifyOrigin(signal: string): 'BR' | 'INT' {
  const s = signal.normalize('NFC').toLowerCase();
  const brKw = [
    'brasil', 'brasileir', 'brazil',
    'são paulo', 'brasília', 'rio de janeiro', 'belo horizonte',
    'curitiba', 'porto alegre', 'recife', 'salvador', 'fortaleza',
    'minas gerais', 'paraná', 'bahia', 'pernambuco',
    'lula', 'governo federal', 'governo brasileiro', 'planalto',
    'anvisa', 'bndes', 'senado', ' stf ', 'anatel', 'cade',
    'câmara dos deputados', 'congresso nacional', 'pgr',
    'fapesp', 'cnpq', 'capes', 'embrapa', 'serpro',
    'no país', 'no brasil', 'ao brasil', 'do brasil', 'pelo brasil',
    'mercado nacional', ' r$ ', ' r$',
    ' usp', 'unicamp', 'ufrj', 'ufrn', 'ufmg',
  ];
  return brKw.some(k => s.includes(k)) ? 'BR' : 'INT';
}

// ─── Categorization ───────────────────────────────────────────────────────────

// ─── Negócios subcategory via text signal ─────────────────────────────────────

function negociosSubcategory(signal: string): string {
  const s = signal.normalize('NFC').toLowerCase();

  // Infraestrutura — chips, data centers, compute, energia
  const hardwareKw = [
    'chip', 'chips', ' gpu', ' tpu', ' cpu', 'supercluster', 'data center',
    'datacenter', 'servidor', 'servidores', 'compute', 'infraestrutura de ia',
    'infraestrutura de i.a', 'hbm', 'memória hbm', 'placa de vídeo',
    'capacidade elétrica', 'energia elétrica', 'consumo energético',
    'sk hynix', 'tsmc', 'broadcom', 'asml', 'amd ', ' intel ',
    'h100', 'h200', 'b200', 'blackwell', 'atlas 950',
    'nuvem de us$', 'data centers',
  ];

  // Aplicação — IA aplicada em setores específicos do mundo real
  const aplicacaoKw = [
    'hospital', 'clínica', 'médico', 'diagnóst', 'anticorpo', 'medicament',
    'robôs', 'robô ', 'robótica', 'robotáxi', 'robotaxi',
    'motorista', 'trânsito', 'rodovia', 'veículo autônomo', 'carro autônomo',
    'call center', 'atendimento ao cliente',
    'varejo', 'walmart', 'loja', 'e-commerce',
    'fazenda', 'agricultura', 'plantio',
    'manufatura', 'fábrica', 'logística',
    'jurídico', 'advogado', 'tribunal', 'justiça',
    'idosos', 'crianças', 'avós robôs',
    'clínicas africanas', 'horizon1000',
    'spotify', 'música', 'entretenimento',
    'desmatamento', 'travel planning', 'booking',
    'mammogram', 'breast cancer', 'remarcação de voos',
    'lung-cancer', 'collaboration with openai',
    'séries e filmes', 'produção de séries',
  ];

  // Geopolítica — corrida global, disputas entre países, soberania tecnológica
  const geopoliticaKw = [
    'china ', 'chinesa', 'chinês', 'beijing', 'pequim',
    'estados unidos', 'washington', 'pentágono', 'white house',
    'corrida ', 'projeto manhattan', 'rivalizar com ocidente', 'rivalizar com o ocidente',
    'aliados dos eua', 'acesso de aliados', 'sanção', 'sanções',
    'geopolítica', 'soberania', 'soberania tecnológica', 'soberania cognitiva',
    'guerra tecnológica', 'guerra fria', 'ocidente',
    'impede entrada de chips', 'veta chips', 'bloqueia chips',
    'indonesia', 'indonésia', 'malásia', 'albânia',
    'davos', 'cúpula', 'g7', 'g20', 'onu', 'unesco',
    'europa ', 'união europeia', 'comissão europeia',
    'capacidade elétrica coloca a china',
    'summit', 'ai summit',
  ];

  // Mercado — financeiro: funding, valuations, M&A, receita
  const mercadoKw = [
    'levanta', 'levantou', 'capta', 'captou', 'valuation', 'bilhão', 'bilhões',
    'bilh', 'milh', 'ipo', 'receita', 'faturamento', 'lucro', 'prejuízo',
    'ações', 'bolsa', 'nasdaq', 'funding', 'rodada', 'série a', 'série b',
    'série c', 'aquisição', 'adquire', 'adquiriu', 'comprou',
    'fusão', 'acordo de us$', 'contrato de us$', 'investe', 'investimento',
    'demite', 'demitiu', 'corte de', 'layoff', 'dispensa',
    'contrata', 'contratou', 'aposta', 'prevê', 'projeção',
    'abrir capital', 'valor de mercado', 'wall street', 's&p ',
    'títulos ', 'bonds ', 'price hike',
    'bilionário', 'bilionários', 'mercado de ia', 'mercado de i.a',
    'mercado aguarda', 'resultados da nvidia', 'raises ',
  ];

  // Impacto — efeitos de IA em pessoas, sociedade, empregos
  const impactoKw = [
    'emprego', 'empregos', 'trabalho', 'trabalhador', 'funcionário', 'funcionários',
    'carreira', 'profissional', 'profissionais', 'habilidade', 'habilidades',
    'escola', 'estudante', 'aluno', 'professor', 'educação',
    'direito', 'direitos', 'lei ', 'legislação',
    'sociedade', 'social', 'emocion', 'psicol', 'mental',
    'vício', 'privacidade', 'vigilância', 'viés',
    'criança', 'adolescente', 'menor ', 'suicídio', 'bem-estar',
    'futuro do trabalho', 'automação', 'substituição',
    'reduzir pessoal', 'redução de empregos',
    'mass-unemployment', 'halved-workforce', 'ganhando em dólar',
    'negative-sentiment', 'gen-z',
    'imagem falsa', 'holocausto',
  ];

  // Regulação — termos jurídicos e processos legais (migra para cat. Regulação existente)
  const regulacaoKw = [
    'processada', 'processam', 'processou', 'processo judicial', 'processo sobre',
    'ação coletiva', 'tribunal', 'litígio', 'infring', 'sues ',
    'violação', 'patente', 'acusa', 'acusação', 'acusando',
    'regulação', 'regulament', 'legislação', 'proíbe', 'proibir',
    'barra ', 'suspende', 'investig', 'ofcom', 'exige que',
    'compliance', 'veta', 'norma', 'lei estadual', 'copyright',
    'cancel chatgpt', 'unauthorized', 'cracks down',
    'safety panel', 'safety-panel',
    'processa ', 'monopolista', 'lei obrigatória', 'rotulagem',
  ];

  // Segurança — ameaças, deepfakes, fraudes, vulnerabilidades
  const segurancaKw = [
    'segurança de ia', 'segurança da ia', 'segurança na ia', 'segurança em ia',
    'deepfake', 'fraude', 'golpe', 'malware',
    'hackeada', 'hackear', 'hacked', 'vulnerab', 'phishing',
    'vazamento de dados', 'vazou dados', 'leaked source code',
    'pornô', 'nudez', 'abuse', 'uso indevido', 'falsific',
    'perigoso', 'pesadelo', 'invasor', 'cibernético',
    'rogue ai agent', 'trouble with rogue',
    'ciberataqu', 'cyberattack', 'expõe dados',
    'age sem autorização', 'sem autorização',
  ];

  // Bastidores — movimentações de executivos, contratações, saídas
  const bastidoresKw = [
    'ceo ', 'executiv', 'líder ', 'chefe ', 'diretor', 'cofundador',
    'contrata ', 'deixa ', 'saída', 'renuncia', 'assume cargo',
    'recruta', 'perde executiv', 'perde o executiv', 'altman', 'musk', 'hassabis',
    'bezos', 'jensen', 'jony ive', 'mira murati', 'robby walker',
    'ex-líder', 'ex-secretário', 'retornam à',
    'joins openai', 'joins anthropic', 'joins google',
    'disbands', 'reassigns staff', 'pessoa do ano',
    'apagão', 'outage', 'parceria', 'partnership',
    'acordo para', 'assinam acordo', 'fecha a torneira',
    'evento de ia', 'conference', 'conferência',
    'licensing',
  ];

  // Tendência — pesquisas, relatórios, estatísticas de adoção
  const tendenciaKw = [
    '% d', '% das', '% dos', 'pesquisa ', 'estudo ', 'survey',
    'relatório', 'revela que', 'aponta que', 'segundo estudo',
    'índice', 'benchmark', 'ranking', 'reporta crescimento',
    'adoção', 'pesquisadores', 'poll', 'surpassed', 'popularidade',
    'gallup', 'stanford report', 'disconnect between',
    'skyrocketing', 'entrou no resultado',
    'desconexão entre', 'mede resultado', 'competição',
  ];

  // Estratégia — visão, previsões, análises de mercado, "bolha"
  const estrategiaKw = [
    'bolha', 'boom ', 'futuro ', 'previsão', 'previsões',
    'tendência', 'moldará', 'esperar da', 'estratégia',
    'projeção', 'potencial de', 'era ', 'próxima era',
    'fase inicial', 'doutrina', 'agenda de ia',
    'predictions for', 'jagged intelligence',
    'diz reitor', 'steady global growth', 'vantagem de',
  ];

  // Tutorial & Dica → merge com Treinamento
  const tutorialKw = [
    'prompt', 'passo a passo', 'setup', 'como extrair',
    'como melhorar', 'dica', 'tutorial', 'guia ',
  ];

  // Produto / Feature — lançamentos de big tech cobertos pela mídia → merge com Lançamento
  const produtoKw = [
    'lança', 'apresenta', 'anuncia', 'estreia', 'libera',
    'atualiza', 'disponibiliza', 'habilita', 'adiciona',
    'novo modelo', 'novo feed', 'novo recurso',
    'iphone', 'galaxy s2', 'airpods', 'macbook', 'ipad air',
    'siri', 'alexa', 'kindle', 'copilot',
    'aposentar', 'desliga o ', 'testa modelo', 'ganha marketplace',
    'agora vende', 'recebe novo', 'abre beta',
    'browser-launch', 'comet-ai-browser', 'releases mmx',
    'shopping results', 'model-for-robots', 'pagamento com ia',
    'ai-assistant-coming', 'rival para o echo',
    'super bowl ai', 'ai ads',
    'vibe coding', 'novos modelos', 'chega ao brasil',
    'personalização chega', 'testa compras',
    'ai assistant', 'personal ai', 'agente autoevolutivo',
    'video generator',
  ];

  // Order matters: most specific first
  if (regulacaoKw.some(k => s.includes(k))) return 'Regulação';
  if (segurancaKw.some(k => s.includes(k))) return 'Segurança';
  if (hardwareKw.some(k => s.includes(k))) return 'Infraestrutura';
  if (bastidoresKw.some(k => s.includes(k))) return 'Bastidores';
  if (geopoliticaKw.some(k => s.includes(k))) return 'Geopolítica';
  if (tendenciaKw.some(k => s.includes(k))) return 'Tendência';
  if (aplicacaoKw.some(k => s.includes(k))) return 'Aplicação';
  if (mercadoKw.some(k => s.includes(k))) return 'Mercado';
  if (estrategiaKw.some(k => s.includes(k))) return 'Estratégia';
  if (impactoKw.some(k => s.includes(k))) return 'Impacto';
  if (tutorialKw.some(k => s.includes(k))) return 'Treinamento';
  if (produtoKw.some(k => s.includes(k))) return 'Lançamento';
  return 'Indústria';
}

function categorize(url: string, anchor = '', sectionTitle = '', postTitle = '', context = ''): string {
  let host: string, pathname: string;
  try {
    const u = new URL(url);
    host = u.hostname.toLowerCase().replace(/^www\./, '');
    pathname = u.pathname.toLowerCase();
  } catch {
    return 'Outro';
  }

  // Blog/newsroom paths inside tool/product sites → Lançamento
  // (announcement ≠ the tool itself)
  const isAnnouncementPath =
    pathname.includes('/blog/') ||
    pathname.includes('/hub/blog/') ||
    pathname.includes('/newsroom/') ||
    pathname.includes('/press-release') ||
    pathname.includes('/news/') ||
    pathname.includes('/changelog') ||
    pathname.includes('/announcing') ||
    pathname.includes('/intl/');

  const isToolDomainWithBlog =
    isAnnouncementPath && (
      host === 'perplexity.ai' || host === 'pplx.ai' ||
      host === 'cursor.com' ||
      host === 'notion.com' ||
      host === 'figma.com' ||
      host === 'slack.com' ||
      host === 'grammarly.com' ||
      host === 'databricks.com' ||
      host === 'huggingface.co' ||
      host === 'github.com' ||
      host === 'cloud.google.com' ||
      host === 'aws.amazon.com' ||
      host === 'oracle.com' ||
      host === 'glideapps.com' ||
      host === 'bentoml.com' ||
      host === 'openrouter.ai' ||
      host === 'opentools.ai' ||
      host === 'testingcatalog.com'
    );

  if (isToolDomainWithBlog) return 'Lançamento';

  // Pesquisa — academic / research
  if (
    host === 'arxiv.org' ||
    host === 'nature.com' || host.endsWith('.nature.com') ||
    host === 'science.org' ||
    host === 'pubmed.ncbi.nlm.nih.gov' || host.includes('pubmed') ||
    host === 'dl.acm.org' || host === 'acm.org' ||
    host === 'proceedings.mlr.press' ||
    host === 'jmlr.org' ||
    host === 'openreview.net' ||
    host.includes('research.google') ||
    host === 'ai.meta.com' ||
    host === 'research.ibm.com' ||
    host === 'research.microsoft.com' ||
    host === 'deepmind.com' || host.includes('deepmind') ||
    host === 'bair.berkeley.edu' ||
    host === 'pair.withgoogle.com' ||
    host === 'news-medical.net' ||
    pathname.includes('/papers/') ||
    // University / study pages
    host.endsWith('.edu') ||
    host.endsWith('.ac.uk') ||
    host === 'apufsc.org.br' ||
    host === 'sbic.com.br' ||
    host === 'sciencedaily.com' ||
    host === 'sciencedirect.com' ||
    host === 'pub.sakana.ai' ||
    host === 'pewresearch.org' ||
    host === 'news.gallup.com' ||
    host === 'gallup.com' ||
    host === 'quantamagazine.org' ||
    host === 'spectrum.ieee.org' ||
    host === 'iclr.cc' ||
    host === 'papers.ssrn.com' ||
    host === 'basecamp-research.com' ||
    host === 'poynter.org' ||
    host === 'oecd.org' ||
    host === 'weforum.org' ||
    host === 'wmo.int' ||
    host === 'who.int' ||
    host === 'internationalaisafetyreport.org' ||
    host === 'cepal.org' ||
    host === 'news-medical.net' ||
    host === 'insidehighered.com' ||
    host === 'statnews.com' ||
    host === 'lesswrong.com' ||
    host === 'alignment.anthropic.com' ||
    host === 'cdn.openai.com' ||
    host === 'assets.anthropic.com' ||
    host === 'thequantuminsider.com' ||
    host === 'odsc.medium.com' ||
    host === 'labidecom.eca.usp.br' ||
    // GitHub research pages
    host.endsWith('.github.io') ||
    // Outro → Pesquisa
    host === 'chaiassets.com' ||
    host === 'danfu.org' ||
    host === 'www-cdn.anthropic.com' ||
    host === 'publications.iadb.org' ||
    host === 'gartner.com' ||
    host === 'news.cognizant.com' ||
    host === 'thesciencesurvey.com' ||
    host === 'advisorperspectives.com' ||
    host === 'edtechinnovationhub.com' ||
    host === 'ufrn.br' ||
    host === 'fastcompanybrasil.com' ||
    host === 'services.google.com' ||
    (host === 'microsoft.com' && pathname.includes('/research/'))
  ) return 'Pesquisa';

  // Treinamento — cursos, certificações, workshops, bootcamps
  if (
    host === 'coursera.org' ||
    host === 'udemy.com' ||
    host === 'edx.org' ||
    host === 'linkedin.com' && pathname.includes('/learning/') ||
    host === 'alura.com.br' ||
    host === 'dio.me' ||
    host === 'nucamp.co' ||
    host === 'conquer.plus' ||
    host === 'learnwithmeai.com' ||
    host === 'youreverydayai.com' ||
    host === 'kahoot.com' ||
    host === 'unlockingaispotential.com' ||
    host === 'skillshare.com' ||
    host === 'pluralsight.com' ||
    host === 'datacamp.com' ||
    host === 'fast.ai' ||
    host === 'cloudonair.withgoogle.com' ||
    host === 'grow.google' ||
    host === 'gd.eurisko.com.br' ||
    host === 'academy.google.com' ||
    host === 'gaiaciencia.com.br' ||
    host === 'academia.org.br' ||
    // Páginas de certificação/curso dentro de sites maiores
    (pathname.includes('/certificate') || pathname.includes('/certification') ||
     pathname.includes('/curso') || pathname.includes('/course') ||
     pathname.includes('/bootcamp') || pathname.includes('/workshop') ||
     pathname.includes('/treinamento') || pathname.includes('/capacita')) ||
    // Outro → Treinamento
    host === 'portal.ifce.edu.br' ||
    host === 'brasil.ia.inesq.org.br'
  ) return 'Treinamento';

  // Ferramenta — docs, repos, tools, apps
  if (
    host === 'github.com' ||
    host === 'gitlab.com' ||
    host.startsWith('docs.') ||
    host.startsWith('developer.') ||
    host.startsWith('platform.') ||
    host === 'npmjs.com' ||
    host === 'pypi.org' ||
    host === 'huggingface.co' ||
    host === 'red.anthropic.com' ||
    host === 'cursor.com' ||
    host === 'claude.ai' ||
    host === 'chatgpt.com' ||
    host === 'gemini.google.com' ||
    host === 'perplexity.ai' || host === 'pplx.ai' ||
    host === 'slack.com' ||
    host === 'ia.br' ||
    host === 'drive.google.com' ||
    host === 'support.google.com' ||
    host === 'support.claude.com' ||
    host === 'help.openai.com' ||
    host === 'developers.openai.com' ||
    host === 'cloud.google.com' ||
    host === 'notion.com' ||
    host === 'figma.com' ||
    host === 'grammarly.com' ||
    host === 'openrouter.ai' ||
    host === 'aws.amazon.com' ||
    host === 'bentoml.com' ||
    host === 'databricks.com' ||
    host === 'oracle.com' ||
    host === 'nodejs.org' ||
    host === 'glideapps.com' ||
    host === 'testingcatalog.com' ||
    host === 'agents.md' ||
    host === 'design.md' ||
    host === 'opentools.ai' ||
    pathname.includes('/docs/') ||
    pathname.includes('/api/') ||
    pathname.includes('/sdk/') ||
    // Outro → Ferramenta
    host === 'creative-tim.com' ||
    (host === 'microsoft.com' && pathname.includes('/edge/'))
  ) return 'Ferramenta';

  // Regulação — policy, law, regulation
  if (
    host.includes('euaiact') ||
    host === 'artificialintelligenceact.eu' ||
    host === 'consilium.europa.eu' ||
    host === 'europarl.europa.eu' ||
    host.endsWith('.gov') ||
    host.endsWith('.gov.br') || host === 'gov.br' ||
    host.endsWith('.leg.br') ||
    host.endsWith('.legis.br') ||
    host.endsWith('.jus.br') ||
    host === 'registro.br' ||
    host === 'cnj.jus.br' ||
    host === 'wto.org' ||
    host === 'news.un.org' ||
    host === 'aisi.gov.uk' ||
    host === 'impact.indiaai.gov.in' ||
    host === 'genai.mil' ||
    host === 'news.bloomberglaw.com' ||
    host === 'politico.com' || host.endsWith('.politico.com') ||
    host === 'thehill.com' ||
    pathname.includes('/policy/') ||
    pathname.includes('/regulation') ||
    pathname.includes('/governance') ||
    url.includes('bug-bounty') || url.includes('safety-bounty') ||
    // Outro → Regulação
    host === 'portal.cfm.org.br' ||
    host === 'transparencycoalition.ai' ||
    host === 'correio24horas.com.br' ||
    host === 'english.luatvietnam.vn' ||
    host === 'iab.com'
  ) return 'Regulação';

  // Curiosidade — cultural, pop, wikipedia, encyclopedic
  if (
    host.includes('wikipedia.org') ||
    host.includes('wikimedia.org') ||
    host === 'wikidata.org' ||
    host === 'gizmodo.com' || host === 'gizmodo.com.br' ||
    host === 'imdb.com' ||
    host === 'rottentomatoes.com' ||
    host === 'soberaniacognitiva.com.br' ||
    host === 'futurism.com' ||
    (host === 'wired.com' && (pathname.includes('/culture/') || pathname.includes('/magazine/'))) ||
    host === 'variety.com' ||
    host === 'deadline.com' ||
    host === 'kotaku.com' ||
    host === 'dexerto.com' ||
    host === 'reddit.com' ||
    host === 'youtube.com' || host === 'youtu.be' ||
    host === 'i.ytimg.com' ||
    host === 'universalmusic.com' ||
    host === 'motionpictures.org' ||
    host === 'nymag.com' && pathname.includes('/culture/') ||
    host === 'darioamodei.com' ||
    host === 'karpathy.bearblog.dev' ||
    host === 'lesswrong.com' ||
    host === 'critterz.tv' ||
    host === 'hollywoodreporter.com' ||
    host === 'automaton-media.com' ||
    // Outro → Curiosidade
    host === 'merriam-webster.com' ||
    host === 'focusfeatures.com' ||
    host === 'computerhope.com' ||
    host === 'molt.church' ||
    host === 'nexalgaming.co' ||
    pathname.includes('copa-do-mundo') || pathname.includes('pokemon')
  ) return 'Curiosidade';

  // Lançamento — official blog announcements & AI company releases
  const isAiCompany =
    host === 'anthropic.com' ||
    host === 'openai.com' ||
    host === 'mistral.ai' ||
    host === 'cohere.com' ||
    host === 'ai21.com' ||
    host === 'inflection.ai' ||
    host === 'together.ai' ||
    host === 'replicate.com' ||
    host === 'stability.ai' ||
    host === 'midjourney.com' ||
    host === 'runway.com' ||
    host === 'z.ai' || host === 'zhipuai.cn' ||
    host === 'andon.ai' ||
    host === 'x.ai' ||
    host === 'qwen.ai' ||
    host === 'minimax.io' ||
    host === 'moonshot.cn' ||
    host === 'tomoviee.ai' ||
    host === 'app.tomoviee.ai' ||
    host === 'heygenuser.com' || host === 'heygen.com' ||
    host === 'arcee.ai' ||
    host === 'allenai.org' ||
    host === 'claude.com' ||
    host === 'elevenlabs.io' ||
    host === 'kimi.com' || host === 'moonshot.ai' ||
    host === 'tegabrain.com' ||
    host === 'accomplish.ai' ||
    host === 'openclaw.ai' ||
    host === 'manus.im' ||
    host === 'meta.ai' ||
    host === 'ai.com' ||
    host === 'humain.com' ||
    host === 'suno.com' ||
    host === 'gamma.app' ||
    host === 'fal.ai' ||
    host === 'bfl.ai' ||
    host === 'runwayml.com' ||
    host === 'extropic.ai' ||
    host === 'superhuman.ai' ||
    host === 'marketeam.ai' ||
    host === 'midoo.ai' ||
    host === 'sentient.foundation' ||
    host === 'epoch.ai' ||
    host === 'exa.ai' ||
    host === 'lovable.dev' || // AI coding tool
    host === 'andonlabs.com' ||
    host === 'builder.ai' ||
    host === 'pharma.ai' ||
    host === 'blip.ai' ||
    host === 'chat.qwen.ai' ||
    host === 'visualelectric.com' ||
    host === 'kiro.dev' ||
    host === 'operaneon.com' ||
    host === 'ap2-protocol.org' ||
    host === 'api-docs.deepseek.com' ||
    host === 'deepseek.com' ||
    host === 'periodic.com' ||
    host === 'anthrogen.com' ||
    host === '3d-models.hunyuan.tencent.com' ||
    host === 'superintelligence-statement.org' ||
    host === 'ir.amd.com' ||
    host === 'github.blog' ||
    host === 'labs.google.com' ||
    host === 'hcompany.ai' ||
    host === 'news.lmarena.ai' ||
    // Outro → Lançamento
    host === 'lambda.ai' ||
    host === 'poe.com' ||
    host === 'intology.ai' ||
    host === 'edisonscientific.com' ||
    host === 'blog.character.ai' ||
    host === 'klarna.com' ||
    host === 'resemble.ai' ||
    host === 'ensemblelisteningmodel.com' ||
    host === 'prism.openai.com' ||
    host === 'community.openai.com' ||
    host === 'securiti.ai' ||
    host === 'nemoclaw.bot' ||
    host === 'sync.so' ||
    host === 't54.ai' ||
    host === 'moltbook.com' ||
    host === 'awesomeagents.ai' ||
    host === '24aiglobal.com' ||
    host === 'datadome.co' ||
    host === 'hp.com' ||
    host === 'seed.bytedance.com' ||
    host === 'clawd.bot' ||
    (host === 'meta.com' && pathname.includes('/connect'));

  const isTechBlog =
    (host.includes('google') && (pathname.includes('/blog/') || pathname.includes('/intl/'))) ||
    host === 'blog.google' ||
    host === 'developers.googleblog.com' ||
    host === 'workspaceupdates.googleblog.com' ||
    host === 'labs.google' ||
    host === 'stitch.withgoogle.com' ||
    host === 'aistudio.google.com' ||
    host === 'cloud.google.com' && pathname.includes('/blog/') ||
    (host.includes('microsoft.com') && pathname.includes('/blog/')) ||
    host === 'microsoft.ai' ||
    host === 'news.microsoft.com' ||
    host === 'blogs.microsoft.com' ||
    (host === 'meta.com' && pathname.includes('/blog/')) ||
    host === 'about.fb.com' ||
    (host === 'facebook.com' && pathname.includes('/business/news/')) ||
    host === 'nvidianews.nvidia.com' ||
    host === 'blogs.nvidia.com' ||
    host === 'nvidia.com' && pathname.includes('/blog/') ||
    host === 'news.samsung.com' ||
    host === 'samsungmobilepress.com' ||
    host === 'aboutamazon.com' ||
    host === 'newsroom.ibm.com' ||
    host === 'newsroom.intel.com' ||
    host === 'newsroom.accenture.com' ||
    host === 'newsroom.spotify.com' ||
    host === 'newsroom.paypal-corp.com' ||
    host === 'press.asus.com' ||
    host === 'news.adobe.com' ||
    host === 'business.adobe.com' ||
    host === 'blog.adobe.com' ||
    host === 'oracle.com' && pathname.includes('/news/') ||
    host === 'aws.amazon.com' && pathname.includes('/blogs/') ||
    (host === 'replit.com' && pathname.includes('/blog/')) ||
    host === 'prnewswire.com' ||
    host === 'globenewswire.com' ||
    host === 'newswire.ca' ||
    host === 'businesswire.com' ||
    // Outro → Lançamento (tech blogs / newsrooms)
    host === 'blog.mozilla.org' ||
    host === 'news.lenovo.com' ||
    host === 'enterprise.wikimedia.com' ||
    host === 'newsroom.fedex.com' ||
    host === 'lego.com';

  if (isAiCompany || isTechBlog) return 'Lançamento';

  // Negócios — business, finance, industry news
  if (
    // International finance/biz
    host === 'bloomberg.com' || host.endsWith('.bloomberg.com') || host === 'bnnbloomberg.ca' ||
    host === 'reuters.com' ||
    host === 'ft.com' ||
    host === 'wsj.com' ||
    host === 'forbes.com' || host === 'forbes.com.br' ||
    host === 'businessinsider.com' ||
    host === 'cnbc.com' ||
    host === 'fortune.com' ||
    host === 'economist.com' ||
    host === 'hbr.org' ||
    host === 'inc.com' ||
    host === 'fastcompany.com' ||
    // Tech news international
    host === 'techcrunch.com' ||
    host === 'venturebeat.com' ||
    host === 'theverge.com' ||
    host === 'wired.com' ||
    host === 'arstechnica.com' ||
    host === 'axios.com' ||
    host === 'technologyreview.com' || host.includes('technologyreview') ||
    host === 'zdnet.com' ||
    host === 'cnet.com' ||
    host === 'engadget.com' ||
    host === 'neowin.net' ||
    host === 'techzine.eu' ||
    host === 'techradar.com' ||
    host === 'tomshardware.com' ||
    host === 'artificialintelligence-news.com' ||
    host === 'the-decoder.com' ||
    host === 'techbuzz.ai' ||
    host === 'mashable.com' ||
    host === 'usnews.com' ||
    host === 'futurism.com' ||
    host === 'aljazeera.com' ||
    host === 'indiatoday.in' ||
    host === 'chosun.com' ||
    host === 'independent.co.uk' ||
    host === 'theatlantic.com' ||
    // Finance/market data
    host === 'yahoo.com' || host === 'finance.yahoo.com' ||
    host === 'markets.financialcontent.com' ||
    // General media
    host === 'nytimes.com' ||
    host === 'washingtonpost.com' ||
    host === 'theguardian.com' ||
    host === 'bbc.com' || host === 'bbc.co.uk' ||
    host === 'cnn.com' || host === 'edition.cnn.com' ||
    // Brazilian media
    host === 'exame.com' ||
    host === 'cnnbrasil.com.br' ||
    host === 'veja.abril.com.br' ||
    host === 'g1.globo.com' ||
    host === 'timesbrasil.com.br' ||
    host === 'tiinside.com.br' ||
    host === 'webpronews.com' ||
    host === 'ibm.com' ||
    // Consulting / enterprise
    host === 'accenture.com' ||
    host === 'mckinsey.com' ||
    host === 'pwc.com' ||
    host === 'deloitte.com' ||
    // Blogs / opinion
    host === 'medium.com' ||
    host === 'substack.com' || host.endsWith('.substack.com') ||
    // Amazon (product/shopping)
    host === 'amazon.com.br' || host === 'amzn.to' ||
    // Apple (product)
    host === 'apple.com' || host.endsWith('.apple.com') ||
    // More intl tech/business news
    host === 'euronews.com' ||
    host === 'timesofindia.indiatimes.com' ||
    host === 'economictimes.indiatimes.com' ||
    host === 'economictimes.com' ||
    host === 'business-standard.com' ||
    host === 'abcnews.go.com' ||
    host === 'cbsnews.com' ||
    host === 'nbcnews.com' ||
    host === 'npr.org' ||
    host === 'latimes.com' ||
    host === 'time.com' ||
    host === 'theatlantic.com' ||
    host === 'nymag.com' ||
    host === 'reason.com' ||
    host === 'theinformation.com' ||
    host === 'thenextweb.com' ||
    host === 'siliconangle.com' ||
    host === 'siliconrepublic.com' ||
    host === '404media.co' ||
    host === 'theregister.com' ||
    host === 'computerworld.com' ||
    host === 'windowscentral.com' ||
    host === 'techspot.com' ||
    host === 'techpowerup.com' ||
    host === 'tweaktown.com' ||
    host === 'geeky-gadgets.com' ||
    host === 'analyticsinsight.net' ||
    host === 'aibusiness.com' ||
    host === 'ainews.net.br' ||
    host === 'ainvest.com' ||
    host === 'aiBusinessnews.com' ||
    host === 'timesofai.com' ||
    host === 'techbuzz.ai' ||
    host === 'thedeepview.com' ||
    host === 'dataconomy.com' ||
    host === 'diginomica.com' ||
    host === 'hpcwire.com' ||
    host === 'cio.com' ||
    host === 'builtin.com' ||
    host === 'marktechpost.com' ||
    host === 'startupresearcher.com' ||
    host === 'startse.com' ||
    host === 'neofeed.com.br' ||
    host === 'suno.com.br' ||
    host === 'canaltech.com.br' ||
    host === 'tecmundo.com.br' ||
    host === 'olhardigital.com.br' ||
    host === 'tecnoblog.net' ||
    host === 'gazetadopovo.com.br' ||
    host === 'otempo.com.br' ||
    host === 'oglobo.globo.com' ||
    host === 'uol.com.br' || host === 'economia.uol.com.br' ||
    host === 'braziljournal.com' ||
    host === 'anba.com.br' ||
    host === 'infomoney.com.br' ||
    host === 'seudinheiro.com' ||
    host === 'portalnovarejo.com.br' ||
    host === 'sbtnews.sbt.com.br' ||
    host === 'jornaldebrasilia.com.br' ||
    host === 'agenciabrasil.ebc.com.br' ||
    host === 'apublica.org' ||
    host === 'congressoemfoco.com.br' ||
    host === 'convergenciadigital.com.br' ||
    host === 'eco.sapo.pt' ||
    host === 'news.cgtn.com' ||
    host === 'eu.36kr.com' ||
    host === 'bnamericas.com' ||
    host === 'morningstar.com' ||
    host === 'investing.com' ||
    host === 'spglobal.com' ||
    host === 'benzinga.com' ||
    host === 'simplywall.st' ||
    host === 'tipranks.com' ||
    host === 'linkedin.com' ||
    host === 'x.com' ||
    // India/intl
    host === 'ndtv.com' ||
    host === 'indiatoday.in' ||
    host === 'thehindu.com' ||
    // EU/international
    host === 'brusselstimes.com' ||
    host === 'europeanbusinessreview.com' ||
    host === 'sifted.eu' ||
    // AI news general
    host === 'theaibreak.com' ||
    host === 'ground.news' ||
    host === 'tomtunguz.com' ||
    host === 'fedscoop.com' ||
    host === 'globalgovernmentforum.com' ||
    host === 'pymnts.com' ||
    host === 'thefintechtimes.com' ||
    host === 'retailtechinnovationhub.com' ||
    host === 'musicbusinessworldwide.com' ||
    host === 'radiologybusiness.com' ||
    host === 'healthcaredive.com' ||
    host === 'highereddive.com' ||
    host === 'hrexecutive.com' ||
    host === 'impakter.com' ||
    host === 'insurancejournal.com' ||
    host === 'japantimes.co.jp' ||
    host === 'abs-cbn.com' ||
    host === 'aljazeera.com' ||
    host === 'chosun.com' ||
    host === 'independent.co.uk' ||
    host === 'canadianaffairs.news' ||
    host === 'indexbox.io' ||
    host === 'waymo.com' ||
    host === 'spacex.com' ||
    host === 'wiz.io' ||
    host === 'cisco.com' || host === 'investor.cisco.com' ||
    host === 'uber.com' ||
    host === 'global.fujitsu' ||
    host === 'epic.com' ||
    host === 'scmp.com' ||
    host === 'pcmag.com' ||
    host === 'patentlyapple.com' ||
    host === 'newsroom.cisco.com' ||
    host === 'techfundingnews.com' ||
    host === 'acaert.com.br' ||
    // Catch Google news/product pages not already caught
    (host === 'google.com' && (pathname.includes('/ai') || pathname.includes('/blog') || pathname.includes('/intl'))) ||
    host === 'content.techgig.com' ||
    host === 'mlq.ai' ||
    host === 'techinasia.com' ||
    host === 'odyssey.ml' ||
    host === 'theaiworld.org' ||
    host === 'aitechsuite.com' ||
    host === 'entrepreneur.com' ||
    host === 'talkdigital.co' ||
    host === 'techshotsapp.com' ||
    host === 'flash.co' ||
    // Outro → Negócios subcategories
    host === 'ultimosegundo.ig.com.br' ||
    host === 'rollingstone.com' ||
    host === '9to5mac.com' ||
    host === '9to5google.com' ||
    host === 'apnews.com' ||
    host === 'businesstimes.com.sg' ||
    host === 'in.mashable.com' ||
    host === 'technobezz.com' ||
    host === 'newsdefused.com' ||
    host === 'seroundtable.com' ||
    host === 'erp.today' ||
    host === 'resilientcyber.io' ||
    host === 'inesplorato.com.br' ||
    host === 'infobae.com' ||
    host === 'roastbrief.us' ||
    host === 'techrt.com' ||
    host === 'kq2.com' ||
    host === 'theblock.co' ||
    host === 'how2shout.com' ||
    host === 'seucreditodigital.com.br' ||
    // Mercado-leaning
    host === 'goldmansachs.com' ||
    host === 'coinpaper.com' ||
    host === 'uk.finance.yahoo.com' ||
    host === 'sg.news.yahoo.com' ||
    host === 'financialcontent.com' ||
    host === 'manilatimes.net' ||
    host === 'thenewyorkfinance.com' ||
    // Aplicação-leaning
    host === 'hyundai.com' ||
    host === 'fiercehealthcare.com' ||
    host === 'virginaustralia.com' ||
    host === 'expresscomputer.in' ||
    host === 'reinsurancene.ws' ||
    host === 'allianz.com' ||
    host === 'synaptics.com' ||
    // Mercado-specific
    host === 'man.com' ||
    // Hardware-leaning
    host === 'nvidia.com' ||
    host === 'nebius.com' ||
    host === 'news.skhynix.com' ||
    host === 'thetechportal.com'
  ) {
    // Use anchor if descriptive, else section title, else post title as last resort
    const isGeneric = !anchor || anchor.length < 3 || /^https?:\/\//.test(anchor) || /^(aprofunde|saiba mais|aqui|veja|clique|leia)$/i.test(anchor.trim());
    const sectionClean = /^[_\s]+$/.test(sectionTitle.trim()) ? '' : sectionTitle;
    const signal = isGeneric ? (sectionClean || postTitle || anchor) : anchor;
    // Enrich with paragraph context + URL path (hyphens→spaces for keyword matching)
    const pathSpaced = pathname.replace(/-/g, ' ');
    const enrichedSignal = signal + ' ' + context + ' ' + pathSpaced;
    return negociosSubcategory(enrichedSignal);
  }

  // .ai TLD heuristic — unknown .ai domains are typically AI startup announcements
  if (/^[^.]+\.ai$/.test(host)) return 'Lançamento';

  // Fallback
  return 'Outro';
}

// ─── HTML link extraction ─────────────────────────────────────────────────────

interface LinkEntry {
  url: string;
  baseUrl: string;
  anchor: string;
  sectionTitle: string; // nearest <b> heading above the link
  context: string; // surrounding paragraph text for richer signal
}

// Boilerplate <b> texts that are NOT section titles
const BOILERPLATE_B = [
  'por que isso importa', 'é ai?', 'é ai', 'leia online', 'saiba mais',
  'aprofunde', 'aqui', 'clique', 'veja', 'acesse',
];

function cleanText(html: string): string {
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ').trim();
}

function extractLinks(html: string): LinkEntry[] {
  const entries: LinkEntry[] = [];
  const seen = new Set<string>();

  // Strip <style> and <head> blocks first to avoid CSS leaking into <b> matches
  const bodyHtml = html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<head[\s\S]*?<\/head>/gi, '');

  // Build a token stream: alternating between <b> tags and <a> tags
  // (?=[\s>\/]) ensures we match <b> and <a> but NOT <base>, <body>, <aside>, etc.
  const tokenRegex = /<(b|a)(?=[\s>\/])([^>]*)>([\s\S]*?)<\/\1>/gi;
  let currentSection = '';
  let match: RegExpExecArray | null;

  while ((match = tokenRegex.exec(bodyHtml)) !== null) {
    const tag = match[1].toLowerCase();
    const attrs = match[2];
    const inner = match[3];

    if (tag === 'b') {
      const text = cleanText(inner);
      const lower = text.toLowerCase();
      // Accept as section title if:
      // - long enough to be a headline (10-150 chars)
      // - not boilerplate
      // - not ending with ":" (editorial labels like "Como usar:", "Glossário:")
      // - not CSS-like content
      // - starts with uppercase (headlines) or common AI company names
      const looksLikeLabel = /:\s*$/.test(text);
      const looksLikeCss = text.includes('{') || text.includes(':root');
      const tooLong = text.length > 150;
      // Body emphasis starts with article/pronoun — not a headline
      const looksLikeBodyBold = /^(a |o |as |os |um |uma |ao |aos |às |do |da |dos |das |no |na |nos |nas |em |de |que |se |por |para |com |quando |porque |isso |este |esta |estes |estas |esse |essa )/i.test(text);
      if (
        text.length >= 10 &&
        !tooLong &&
        !looksLikeLabel &&
        !looksLikeCss &&
        !looksLikeBodyBold &&
        !BOILERPLATE_B.some(b => lower.startsWith(b))
      ) {
        currentSection = text;
      }
      continue;
    }

    // tag === 'a'
    const hrefMatch = match[2].match(/href=["']([^"']+)["']/i);
    if (!hrefMatch) continue;
    const rawUrl = hrefMatch[1].trim();
    if (!rawUrl || rawUrl.startsWith('mailto:') || rawUrl.startsWith('#')) continue;
    if (!isEditorial(rawUrl)) continue;

    const bu = baseUrl(rawUrl);
    if (seen.has(bu)) continue;
    seen.add(bu);

    const anchor = cleanText(inner);

    // Extract surrounding paragraph context (300 chars before link in bodyHtml)
    const linkIdx = match.index!;
    const ctxStart = Math.max(0, linkIdx - 400);
    const ctxEnd = Math.min(bodyHtml.length, linkIdx + 200);
    const context = cleanText(bodyHtml.substring(ctxStart, ctxEnd));

    entries.push({ url: rawUrl, baseUrl: bu, anchor, sectionTitle: currentSection, context });
  }

  return entries;
}

// ─── Match link to click stats ────────────────────────────────────────────────

interface ClickStat {
  verified_clicks: number;
  unique_verified_clicks: number;
  unique_clicks: number;
}

function matchClick(bu: string, clicks: any[]): ClickStat {
  if (!clicks || clicks.length === 0) return { verified_clicks: 0, unique_verified_clicks: 0, unique_clicks: 0 };

  // Try exact base_url match first
  const exactMatch = clicks.find(c => {
    const cb = c.base_url || baseUrl(c.url);
    return cb === bu || cb.replace(/\/$/, '') === bu.replace(/\/$/, '');
  });

  if (exactMatch) {
    return {
      verified_clicks: exactMatch.email?.verified_clicks ?? 0,
      unique_verified_clicks: exactMatch.email?.unique_verified_clicks ?? 0,
      unique_clicks: exactMatch.email?.unique_clicks ?? 0,
    };
  }

  // Fuzzy: match by stripping protocol + trailing slash
  const normalize = (u: string) => u.replace(/^https?:\/\//, '').replace(/\/$/, '').toLowerCase();
  const buNorm = normalize(bu);

  const fuzzyMatch = clicks.find(c => {
    const cb = c.base_url || baseUrl(c.url);
    return normalize(cb) === buNorm;
  });

  if (fuzzyMatch) {
    return {
      verified_clicks: fuzzyMatch.email?.verified_clicks ?? 0,
      unique_verified_clicks: fuzzyMatch.email?.unique_verified_clicks ?? 0,
      unique_clicks: fuzzyMatch.email?.unique_clicks ?? 0,
    };
  }

  return { verified_clicks: 0, unique_verified_clicks: 0, unique_clicks: 0 };
}

// ─── CSV helpers ──────────────────────────────────────────────────────────────

function csvEscape(val: string | number): string {
  const s = String(val ?? '');
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

interface Row {
  date: string;
  post_title: string;
  section_title: string;
  anchor: string;
  url: string;
  base_url: string;
  domain: string;
  unique_opens: number;
  verified_clicks: number;
  unique_verified_clicks: number;
  ctr_pct: string;
  category: string;
  origin: 'BR' | 'INT';
}

function main() {
  if (!fs.existsSync(POSTS_DIR)) {
    console.error(`Error: ${POSTS_DIR} not found. Run the Beehiiv cache sync first.`);
    process.exit(1);
  }

  const header = [
    'date', 'post_title', 'section_title', 'anchor', 'url', 'base_url', 'domain',
    'unique_opens', 'verified_clicks', 'unique_verified_clicks', 'ctr_pct', 'category', 'origin'
  ];

  // Incremental: read existing CSV to find the most recent date already processed
  let existingLines: string[] = [];
  let lastDate = '';
  const isBootstrap = !fs.existsSync(OUT_CSV);

  if (!isBootstrap) {
    const existing = fs.readFileSync(OUT_CSV, 'utf8').split('\n');
    existingLines = existing.slice(1).filter(Boolean); // skip header
    // Find most recent date in existing data (first column)
    for (const line of existingLines) {
      const date = line.split(',')[0];
      if (date > lastDate) lastDate = date;
    }
  }

  const files = fs.readdirSync(POSTS_DIR).filter(f => f !== 'index.json');

  const posts: any[] = files.map(f =>
    JSON.parse(fs.readFileSync(path.join(POSTS_DIR, f), 'utf8'))
  );

  // Sort by publish_date ascending
  posts.sort((a, b) => (a.publish_date ?? 0) - (b.publish_date ?? 0));

  const newRows: Row[] = [];
  let processed = 0;
  let skipped = 0;

  const MIN_AGE_DAYS = 7;
  const cutoff = Date.now() - MIN_AGE_DAYS * 24 * 60 * 60 * 1000;
  let tooRecent = 0;
  let alreadyProcessed = 0;

  for (const post of posts) {
    if (post.status !== 'confirmed') { skipped++; continue; }

    // Skip editions published less than 7 days ago (CTR still settling)
    if (post.publish_date && post.publish_date * 1000 > cutoff) {
      tooRecent++;
      continue;
    }

    const date = post.publish_date
      ? new Date(post.publish_date * 1000).toISOString().slice(0, 10)
      : '';

    // Incremental: skip posts already in the CSV
    if (!isBootstrap && date <= lastDate) {
      alreadyProcessed++;
      continue;
    }

    const title = post.title ?? '';
    const uniqueOpens = post.stats?.email?.unique_opens ?? 0;
    const clicks = post.stats?.clicks ?? [];

    const html = post.content?.free?.email ?? post.content?.free?.web ?? '';
    if (!html) { skipped++; continue; }

    const links = extractLinks(html);

    for (const link of links) {
      const clickStat = matchClick(link.baseUrl, clicks);
      const ctr = uniqueOpens > 0
        ? ((clickStat.unique_verified_clicks / uniqueOpens) * 100).toFixed(2)
        : '0.00';

      let domain = '';
      try { domain = new URL(link.baseUrl).hostname.replace(/^www\./, ''); } catch {}

      newRows.push({
        date,
        post_title: title,
        section_title: link.sectionTitle,
        anchor: link.anchor,
        url: link.url,
        base_url: link.baseUrl,
        domain,
        unique_opens: uniqueOpens,
        verified_clicks: clickStat.verified_clicks,
        unique_verified_clicks: clickStat.unique_verified_clicks,
        ctr_pct: ctr,
        category: categorize(link.baseUrl, link.anchor, link.sectionTitle, title, link.context),
        origin: classifyOrigin(link.anchor + ' ' + link.sectionTitle + ' ' + title + ' ' + link.context),
      });
    }

    processed++;
  }

  // Write CSV: existing rows + new rows
  const newCsvLines = newRows.map(r => [
    r.date, r.post_title, r.section_title, r.anchor, r.url, r.base_url, r.domain,
    r.unique_opens, r.verified_clicks, r.unique_verified_clicks, r.ctr_pct, r.category, r.origin
  ].map(csvEscape).join(','));

  const allLines = [header.join(','), ...existingLines, ...newCsvLines];
  fs.writeFileSync(OUT_CSV, allLines.join('\n'), 'utf8');

  const totalRows = existingLines.length + newRows.length;
  const mode = isBootstrap ? 'bootstrap' : 'incremental';

  console.log(`\nDone (${mode}).`);
  console.log(`  New posts processed: ${processed}`);
  if (!isBootstrap) console.log(`  Posts already in CSV: ${alreadyProcessed}`);
  console.log(`  Posts skipped (draft/no HTML): ${skipped}`);
  console.log(`  Posts skipped (< ${MIN_AGE_DAYS} days old): ${tooRecent}`);
  console.log(`  New links added: ${newRows.length}`);
  console.log(`  Total link rows: ${totalRows}`);
  console.log(`  Output: ${OUT_CSV}`);

  // Summary stats for new rows only
  if (newRows.length > 0) {
    const byCategory: Record<string, { count: number; clicks: number; opens: number }> = {};
    for (const r of newRows) {
      if (!byCategory[r.category]) byCategory[r.category] = { count: 0, clicks: 0, opens: 0 };
      byCategory[r.category].count++;
      byCategory[r.category].clicks += r.unique_verified_clicks;
      byCategory[r.category].opens += r.unique_opens;
    }

    console.log('\nNovas links por categoria:');
    for (const [cat, stat] of Object.entries(byCategory).sort((a, b) => b[1].count - a[1].count)) {
      const avgCtr = stat.opens > 0 ? ((stat.clicks / stat.opens) * 100).toFixed(2) : '0.00';
      console.log(`  ${cat.padEnd(16)}: ${String(stat.count).padStart(4)} links | CTR médio ${avgCtr}%`);
    }
  } else if (!isBootstrap) {
    console.log('\nNenhuma edição nova para processar.');
  }
}

main().catch(console.error);
