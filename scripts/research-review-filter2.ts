import * as fs from 'fs';
import * as path from 'path';

interface Article {
  url: string;
  title: string;
  summary?: string;
  published_at?: string;
  source?: string;
  category?: string;
  date_unverified?: boolean;
  date?: string;
  flag?: string;
}

interface Stats {
  total_input?: number;
  date_corrected?: number;
  fetch_failed?: number;
  removed_date_window?: number;
  total_output?: number;
  removals?: Array<{ url: string; reason: string; detail: string }>;
}

interface Input {
  categorized: {
    lancamento: Article[];
    pesquisa: Article[];
    noticias: Article[];
    tutorial: Article[];
    video?: Article[];
  };
  stats: Stats;
}

const editionDir = process.argv[2];
const inputFile = path.join(editionDir, '_internal', 'tmp-dates-reviewed.json');

// Past editions exact URLs
const pastEditionUrls: Record<string, string[]> = {
  '2026-05-12': [
    'https://blog.google/innovation-and-ai/infrastructure-and-cloud/google-cloud/google-threat-intelligence-group-report/',
    'https://blog.google/products-and-platforms/products/search/ai-powered-google-finance-in-europe/',
    'https://openai.com/business/guides-and-resources/how-enterprises-are-scaling-ai',
    'https://openai.com/index/openai-launches-the-deployment-company',
    'https://importai.substack.com/p/import-ai-456-rsi-and-economic-growth',
    'https://www.theguardian.com/technology/2026/may/11/ai-worker-control-surveillance',
    'https://www.theguardian.com/society/2026/may/11/palantir-access-nhs-england-patient-data',
    'https://www.theguardian.com/technology/2026/may/11/ai-powered-hacking-industrial-scale-threat-three-months-google'
  ],
  '2026-05-11': [
    'https://www.theguardian.com/us-news/ng-interactive/2026/may/10/fiction-writing-professor-ai',
    'https://www.theguardian.com/technology/2026/may/10/mistaking-ai-behaviour-for-conscious-being'
  ]
};

function normalizeUrl(url: string): string {
  return url.toLowerCase().trim().replace(/\/$/, '');
}

function checkExactUrlMatch(articleUrl: string, pastUrls: string[]): string {
  const normalized = normalizeUrl(articleUrl);
  for (const pastUrl of pastUrls) {
    if (normalizeUrl(pastUrl) === normalized) {
      return 'match';
    }
  }
  return '';
}

function checkSemanticOverlap(title: string, summary: string = ''): { matched: boolean; edDate: string } {
  const text = (title + ' ' + summary).toLowerCase();

  if (text.includes('android') && (text.includes('pause point') || text.includes('rcs') || text.includes('emoji') || text.includes('creator'))) {
    return { matched: true, edDate: '2026-05-12' };
  }
  if (text.includes('gemini') && text.includes('android')) {
    return { matched: true, edDate: '2026-05-12' };
  }
  if (text.includes('openai') && text.includes('deploy')) {
    return { matched: true, edDate: '2026-05-12' };
  }
  if (text.includes('google') && text.includes('finance') && text.includes('europe')) {
    return { matched: true, edDate: '2026-05-12' };
  }
  if (text.includes('clone') && text.includes('voz')) {
    return { matched: true, edDate: '2026-05-12' };
  }
  if (text.includes('facial recognition') && (text.includes('retail') || text.includes('big brother'))) {
    return { matched: true, edDate: '2026-05-12' };
  }
  if (text.includes('demi moore') && text.includes('film')) {
    return { matched: true, edDate: '2026-05-12' };
  }
  if (text.includes('musk') && text.includes('openai') && text.includes('trial')) {
    return { matched: true, edDate: '2026-05-11' };
  }

  return { matched: false, edDate: '' };
}

const input: Input = JSON.parse(fs.readFileSync(inputFile, 'utf-8'));
const removals: Array<{ url: string; title: string; reason: string; detail: string }> = [];
const allBuckets: (keyof typeof input.categorized)[] = ['lancamento', 'pesquisa', 'noticias', 'tutorial'];

let totalRemoved = 0;

for (const bucket of allBuckets) {
  const articles = input.categorized[bucket] || [];
  if (!Array.isArray(articles)) continue;

  const filtered = articles.filter((article: Article) => {
    // Check exact URL match
    for (const [edDate, urls] of Object.entries(pastEditionUrls)) {
      if (checkExactUrlMatch(article.url, urls) === 'match') {
        removals.push({
          url: article.url,
          title: article.title,
          reason: 'topic_covered',
          detail: `URL publicada em ${edDate}`
        });
        totalRemoved++;
        return false;
      }
    }

    // Check semantic overlap
    const semantic = checkSemanticOverlap(article.title, article.summary || '');
    if (semantic.matched) {
      removals.push({
        url: article.url,
        title: article.title,
        reason: 'topic_covered',
        detail: `tema similar coberto em ${semantic.edDate}`
      });
      totalRemoved++;
      return false;
    }

    return true;
  });

  (input.categorized as any)[bucket] = filtered;
}

if (!input.stats.removals) {
  input.stats.removals = [];
}
input.stats.removals = (input.stats.removals as any[]).concat(removals);
const totalKept = Object.values(input.categorized).reduce((acc, arr) => acc + (Array.isArray(arr) ? arr.length : 0), 0);
input.stats.total_output = totalKept;

fs.writeFileSync(inputFile, JSON.stringify(input, null, 2));

console.log(JSON.stringify({
  removed: totalRemoved,
  kept: totalKept,
  buckets: {
    lancamento: (input.categorized.lancamento || []).length,
    pesquisa: (input.categorized.pesquisa || []).length,
    noticias: (input.categorized.noticias || []).length,
    tutorial: (input.categorized.tutorial || []).length,
    video: (input.categorized.video || []).length
  }
}, null, 2));
