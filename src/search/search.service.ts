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

  /**
   * Extract concise search keywords from a natural-language question
   */
  private extractKeywords(query: string): string {
    const stopWords = new Set([
      'what', 'which', 'who', 'whom', 'whose', 'where', 'when', 'why', 'how',
      'is', 'are', 'was', 'were', 'be', 'been', 'being', 'am',
      'do', 'does', 'did', 'doing', 'have', 'has', 'had',
      'can', 'could', 'will', 'would', 'shall', 'should', 'may', 'might', 'must',
      'the', 'a', 'an', 'in', 'on', 'at', 'to', 'for', 'of', 'with', 'by', 'from',
      'about', 'nowadays', 'currently', 'today', 'please', 'give', 'me', 'tell',
      'explain', 'describe', 'list', 'some', 'any', 'facing', 'face',
    ]);

    const words = query
      .replace(/[^\w\s-]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 1 && !stopWords.has(w.toLowerCase()));

    return words.length > 0 ? words.join(' ') : query.trim();
  }

  async searchWeb(query: string, limit = 5): Promise<SearchResult[]> {
    const cleanQuery = query.trim();
    if (!cleanQuery) return [];

    const keywords = this.extractKeywords(cleanQuery);
    const results: SearchResult[] = [];
    const seenUrls = new Set<string>();

    const addUnique = (items: SearchResult[]) => {
      for (const item of items) {
        if (!item.url || seenUrls.has(item.url)) continue;
        seenUrls.add(item.url);
        results.push(item);
        if (results.length >= limit) break;
      }
    };

    // Run Google News RSS, Wikipedia full-text search, and DuckDuckGo in parallel
    const [newsRes, wikiRes, ddgRes] = await Promise.allSettled([
      this.searchGoogleNewsRss(keywords, Math.min(3, limit)),
      this.searchWikipediaQuery(keywords, Math.min(3, limit)),
      this.searchDuckDuckGo(keywords, Math.min(2, limit)),
    ]);

    if (newsRes.status === 'fulfilled' && newsRes.value.length > 0) {
      addUnique(newsRes.value);
    }
    if (results.length < limit && wikiRes.status === 'fulfilled' && wikiRes.value.length > 0) {
      addUnique(wikiRes.value);
    }
    if (results.length < limit && ddgRes.status === 'fulfilled' && ddgRes.value.length > 0) {
      addUnique(ddgRes.value);
    }

    if (results.length > 0) {
      this.logger.log(`Search returned ${results.length} live results for "${keywords}"`);
      return results.slice(0, limit);
    }

    // Last resort: topic-aware authoritative sources
    return this.getCuratedSources(cleanQuery);
  }

  private async searchGoogleNewsRss(query: string, limit: number): Promise<SearchResult[]> {
    const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-IN&gl=IN&ceid=IN:en`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Aattral-AI/2.0' },
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) return [];

    const xml = await res.text();
    const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].slice(0, limit);
    const results: SearchResult[] = [];

    for (const match of items) {
      const block = match[1];
      const titleRaw = block.match(/<title>([\s\S]*?)<\/title>/)?.[1] || '';
      const linkRaw = block.match(/<link>([\s\S]*?)<\/link>/)?.[1] || '';
      const pubDateRaw = block.match(/<pubDate>([\s\S]*?)<\/pubDate>/)?.[1] || '';
      const sourceRaw = block.match(/<source[^>]*>([\s\S]*?)<\/source>/)?.[1] || '';

      const title = this.decodeXml(titleRaw).trim();
      const link = linkRaw.trim();
      const source = this.decodeXml(sourceRaw).trim();

      if (title && link) {
        results.push({
          title,
          url: link,
          snippet: source ? `Published by ${source}${pubDateRaw ? ` (${pubDateRaw.slice(0, 16)})` : ''}.` : title,
          siteName: source || 'news.google.com',
          publishedDate: pubDateRaw ? pubDateRaw.slice(0, 16) : undefined,
        });
      }
    }

    return results;
  }

  private async searchWikipediaQuery(query: string, limit: number): Promise<SearchResult[]> {
    const url = `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&srlimit=${limit}&format=json&origin=*`;
    const res = await fetch(url, { signal: AbortSignal.timeout(6000) });
    if (!res.ok) return [];

    const data: any = await res.json();
    const items = data.query?.search || [];
    return items.map((item: any) => ({
      title: item.title,
      url: `https://en.wikipedia.org/wiki/${encodeURIComponent(item.title.replace(/ /g, '_'))}`,
      snippet: (item.snippet || '').replace(/<[^>]+>/g, '').trim(),
      siteName: 'wikipedia.org',
      publishedDate: item.timestamp ? item.timestamp.slice(0, 10) : undefined,
    }));
  }

  private async searchDuckDuckGo(query: string, limit: number): Promise<SearchResult[]> {
    const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Aattral-AI/2.0 (aattral.ai)' },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return [];

    const data: any = await res.json();
    const results: SearchResult[] = [];

    if (data.AbstractText && data.AbstractURL) {
      results.push({
        title: data.Heading || query,
        url: data.AbstractURL,
        snippet: data.AbstractText,
        siteName: data.AbstractSource || this.extractDomain(data.AbstractURL),
      });
    }

    if (Array.isArray(data.RelatedTopics)) {
      for (const item of data.RelatedTopics) {
        if (results.length >= limit) break;
        if (item.Text && item.FirstURL) {
          results.push({
            title: item.Text.split(' - ')[0]?.slice(0, 80) || item.Text.slice(0, 80),
            url: item.FirstURL,
            snippet: item.Text,
            siteName: this.extractDomain(item.FirstURL),
          });
        }
      }
    }

    return results.slice(0, limit);
  }

  private getCuratedSources(query: string): SearchResult[] {
    const q = query.toLowerCase();
    const encoded = encodeURIComponent(query);
    const sources: SearchResult[] = [];

    if (q.match(/agri|farm|crop|soil|seed|harvest|pesticide|fertilizer|irrigation|cattle|livestock|kisan|farmer/)) {
      sources.push(
        {
          title: 'FAO — Food and Agriculture Organization',
          url: `https://www.fao.org/search/en/?q=${encoded}`,
          snippet: 'UN agency providing global data on agriculture, food security, and farming practices.',
          siteName: 'fao.org',
        },
        {
          title: 'ICAR — Indian Council of Agricultural Research',
          url: 'https://icar.org.in',
          snippet: 'Apex body for coordinating, guiding and managing agricultural research and education in India.',
          siteName: 'icar.org.in',
        },
        {
          title: 'Ministry of Agriculture & Farmers Welfare (India)',
          url: 'https://agriwelfare.gov.in',
          snippet: 'Official Government of India portal for farmer schemes (PM-KISAN, PMFBY, e-NAM) and crop data.',
          siteName: 'agriwelfare.gov.in',
        },
      );
    }

    sources.push({
      title: `${query} — Wikipedia`,
      url: `https://en.wikipedia.org/wiki/Special:Search?search=${encoded}`,
      snippet: `Overview and references for ${query} on Wikipedia.`,
      siteName: 'wikipedia.org',
    });

    return sources.slice(0, 5);
  }

  private decodeXml(str: string): string {
    return str
      .replace(/<!\[CDATA\[|\]\]>/g, '')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'");
  }

  private extractDomain(url: string): string {
    try {
      return new URL(url).hostname.replace('www.', '');
    } catch {
      return 'web';
    }
  }
}
