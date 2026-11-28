import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  siteName?: string;
  publishedDate?: string;
}

@Injectable()
export class SearchService {
  private readonly logger = new Logger(SearchService.name);

  constructor(private readonly config: ConfigService) {}

  async searchWeb(query: string, limit = 5): Promise<SearchResult[]> {
    const cleanQuery = query.trim();
    if (!cleanQuery) return [];

    // 1. Try DuckDuckGo Instant Answer API
    try {
      const ddgResults = await this.searchDuckDuckGo(cleanQuery, limit);
      if (ddgResults && ddgResults.length > 0) {
        this.logger.log(`DuckDuckGo returned ${ddgResults.length} results for: "${cleanQuery}"`);
        return ddgResults;
      }
    } catch (err) {
      this.logger.warn(`DuckDuckGo search failed: ${err.message}`);
    }

    // 2. Try Wikipedia OpenSearch
    try {
      const wikiResults = await this.searchWikipedia(cleanQuery, limit);
      if (wikiResults && wikiResults.length > 0) {
        this.logger.log(`Wikipedia returned ${wikiResults.length} results for: "${cleanQuery}"`);
        return wikiResults;
      }
    } catch (err) {
      this.logger.warn(`Wikipedia search failed: ${err.message}`);
    }

    // 3. Topic-aware curated sources as last resort
    return this.getCuratedSources(cleanQuery);
  }

  private async searchDuckDuckGo(query: string, limit: number): Promise<SearchResult[]> {
    const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Aattral-AI/2.0 (aattral.ai)' },
      signal: AbortSignal.timeout(7000),
    });
    if (!res.ok) return [];

    const data: any = await res.json();
    const results: SearchResult[] = [];

    // Main abstract
    if (data.AbstractText && data.AbstractURL) {
      results.push({
        title: data.Heading || query,
        url: data.AbstractURL,
        snippet: data.AbstractText,
        siteName: data.AbstractSource || this.extractDomain(data.AbstractURL),
      });
    }

    // Related topics
    if (Array.isArray(data.RelatedTopics)) {
      for (const item of data.RelatedTopics) {
        if (results.length >= limit) break;
        // Handle nested topics
        if (item.Topics && Array.isArray(item.Topics)) {
          for (const sub of item.Topics) {
            if (results.length >= limit) break;
            if (sub.Text && sub.FirstURL) {
              results.push({
                title: sub.Text.split(' - ')[0]?.slice(0, 80) || sub.Text.slice(0, 80),
                url: sub.FirstURL,
                snippet: sub.Text,
                siteName: this.extractDomain(sub.FirstURL),
              });
            }
          }
        } else if (item.Text && item.FirstURL) {
          results.push({
            title: item.Text.split(' - ')[0]?.slice(0, 80) || item.Text.slice(0, 80),
            url: item.FirstURL,
            snippet: item.Text,
            siteName: this.extractDomain(item.FirstURL),
          });
        }
      }
    }

    // Instant Answers
    if (data.Answer && results.length < limit) {
      results.push({
        title: `Quick Answer: ${query}`,
        url: data.AnswerURL || `https://duckduckgo.com/?q=${encodeURIComponent(query)}`,
        snippet: String(data.Answer),
        siteName: 'duckduckgo.com',
      });
    }

    return results.slice(0, limit);
  }

  private async searchWikipedia(query: string, limit: number): Promise<SearchResult[]> {
    // Use Wikipedia's search API for better results
    const searchUrl = `https://en.wikipedia.org/w/api.php?action=opensearch&search=${encodeURIComponent(query)}&limit=${limit}&namespace=0&format=json&origin=*`;
    const res = await fetch(searchUrl, { signal: AbortSignal.timeout(6000) });
    if (!res.ok) return [];

    const data: any = await res.json();
    const titles: string[] = data[1] || [];
    const snippets: string[] = data[2] || [];
    const urls: string[] = data[3] || [];

    const results: SearchResult[] = [];
    for (let i = 0; i < titles.length; i++) {
      if (urls[i]) {
        results.push({
          title: titles[i],
          url: urls[i],
          snippet: snippets[i] || `Wikipedia article about ${titles[i]}.`,
          siteName: 'wikipedia.org',
        });
      }
    }
    return results;
  }

  private getCuratedSources(query: string): SearchResult[] {
    const q = query.toLowerCase();
    const encoded = encodeURIComponent(query);
    const sources: SearchResult[] = [];

    // Always add Wikipedia and Scholar as universal fallbacks
    sources.push({
      title: `${query} — Wikipedia`,
      url: `https://en.wikipedia.org/wiki/Special:Search?search=${encoded}`,
      snippet: `Comprehensive overview and factual information about ${query} from Wikipedia.`,
      siteName: 'wikipedia.org',
    });

    sources.push({
      title: `${query} — Google Scholar`,
      url: `https://scholar.google.com/scholar?q=${encoded}`,
      snippet: `Peer-reviewed academic research, papers and citations related to ${query}.`,
      siteName: 'scholar.google.com',
    });

    // Topic-specific authoritative sources
    if (q.match(/agri|farm|crop|soil|seed|harvest|pesticide|fertilizer|irrigation|cattle|livestock|agriculture/)) {
      sources.push(
        {
          title: 'FAO — Food and Agriculture Organization',
          url: `https://www.fao.org/search/en/?q=${encoded}`,
          snippet: 'UN agency providing global data on agriculture, food security, and farming practices.',
          siteName: 'fao.org',
        },
        {
          title: 'USDA Agricultural Research',
          url: `https://www.ars.usda.gov/research/publications/?oc=main&search=${encoded}`,
          snippet: 'United States Department of Agriculture research on crop science and farming.',
          siteName: 'ars.usda.gov',
        },
        {
          title: 'Agriculture.com — Farming News',
          url: `https://www.agriculture.com/search?q=${encoded}`,
          snippet: 'Latest farming news, crop prices, weather, and agricultural market updates.',
          siteName: 'agriculture.com',
        },
      );
    } else if (q.match(/health|medical|medicine|hospital|disease|symptom|treatment|doctor|vaccine|pharma/)) {
      sources.push(
        {
          title: 'WHO — World Health Organization',
          url: `https://www.who.int/search?indexCatalogue=genericsearchindex1&searchQuery=${encoded}`,
          snippet: 'Global health data, disease reports, and healthcare guidelines from the WHO.',
          siteName: 'who.int',
        },
        {
          title: 'NIH — National Institutes of Health',
          url: `https://search.nih.gov/search?affiliate=nih&query=${encoded}`,
          snippet: 'Biomedical research, clinical trials, and medical publications from the NIH.',
          siteName: 'nih.gov',
        },
        {
          title: 'PubMed — Medical Research Articles',
          url: `https://pubmed.ncbi.nlm.nih.gov/?term=${encoded}`,
          snippet: 'Peer-reviewed biomedical literature and medical research articles.',
          siteName: 'pubmed.ncbi.nlm.nih.gov',
        },
      );
    } else if (q.match(/code|program|software|javascript|python|api|algorithm|html|css|react|node|developer/)) {
      sources.push(
        {
          title: 'MDN Web Docs',
          url: `https://developer.mozilla.org/en-US/search?q=${encoded}`,
          snippet: 'Authoritative web technology documentation for HTML, CSS, JavaScript and APIs.',
          siteName: 'developer.mozilla.org',
        },
        {
          title: 'Stack Overflow — Developer Q&A',
          url: `https://stackoverflow.com/search?q=${encoded}`,
          snippet: 'Community answers for programming questions and software development issues.',
          siteName: 'stackoverflow.com',
        },
        {
          title: 'GitHub — Open Source Projects',
          url: `https://github.com/search?q=${encoded}&type=repositories`,
          snippet: 'Open source code, libraries, and repositories related to this technology.',
          siteName: 'github.com',
        },
      );
    } else if (q.match(/space|nasa|rocket|satellite|aerospace|aircraft|aviation|flight/)) {
      sources.push(
        {
          title: 'NASA Official Research',
          url: `https://www.nasa.gov/search/?q=${encoded}`,
          snippet: 'Official NASA space missions, aeronautics research, and technology developments.',
          siteName: 'nasa.gov',
        },
        {
          title: 'ESA — European Space Agency',
          url: `https://www.esa.int/search?q=${encoded}`,
          snippet: 'European space exploration missions, satellite technology, and space science.',
          siteName: 'esa.int',
        },
      );
    } else if (q.match(/business|market|finance|invest|stock|economy|startup|revenue/)) {
      sources.push(
        {
          title: 'Bloomberg — Business & Finance News',
          url: `https://www.bloomberg.com/search?query=${encoded}`,
          snippet: 'Real-time financial news, market data, and business intelligence.',
          siteName: 'bloomberg.com',
        },
        {
          title: 'Forbes — Business Insights',
          url: `https://www.forbes.com/search/?q=${encoded}`,
          snippet: 'Business strategy, entrepreneurship, and financial market analysis.',
          siteName: 'forbes.com',
        },
      );
    } else if (q.match(/climate|environment|pollution|renewable|energy|sustainability|carbon/)) {
      sources.push(
        {
          title: 'IPCC — Climate Change Reports',
          url: `https://www.ipcc.ch/search/?q=${encoded}`,
          snippet: 'Intergovernmental Panel on Climate Change reports and scientific assessments.',
          siteName: 'ipcc.ch',
        },
        {
          title: 'IEA — International Energy Agency',
          url: `https://www.iea.org/search?q=${encoded}`,
          snippet: 'Global energy data, clean energy transitions, and sustainability reports.',
          siteName: 'iea.org',
        },
      );
    } else if (q.match(/education|school|university|student|learn|teach|curriculum/)) {
      sources.push(
        {
          title: 'UNESCO — Education Resources',
          url: `https://www.unesco.org/en/search?q=${encoded}`,
          snippet: 'Global education data, policies, and research from UNESCO.',
          siteName: 'unesco.org',
        },
        {
          title: 'Khan Academy — Free Learning',
          url: `https://www.khanacademy.org/search?page_search_query=${encoded}`,
          snippet: 'Free, world-class education resources for students at all levels.',
          siteName: 'khanacademy.org',
        },
      );
    } else if (q.match(/news|current|today|latest|recent|2024|2025/)) {
      sources.push(
        {
          title: 'BBC News — World News',
          url: `https://www.bbc.com/search?q=${encoded}`,
          snippet: 'Latest world news, breaking stories, and analysis from the BBC.',
          siteName: 'bbc.com',
        },
        {
          title: 'Reuters — International News',
          url: `https://www.reuters.com/search/news?blob=${encoded}`,
          snippet: 'Real-time global news coverage and investigative reporting from Reuters.',
          siteName: 'reuters.com',
        },
      );
    }

    return sources.slice(0, 5);
  }

  private extractDomain(url: string): string {
    try {
      return new URL(url).hostname.replace('www.', '');
    } catch {
      return 'web';
    }
  }
}
