import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SearchResult } from '../search/search.service';

export interface AiResponse {
  text: string;
  suggestedQuestions: string[];
  imageUrl?: string;
  citations?: SearchResult[];
}

@Injectable()
export class AiService {
  private readonly logger = new Logger(AiService.name);

  private openaiKey: string | null = null;
  private openaiModel = 'gpt-4o-mini';

  private geminiKey: string | null = null;
  private geminiModel = 'gemini-flash-latest';

  constructor(private readonly config: ConfigService) {
    const oaKey = (this.config.get<string>('OPENAI_API_KEY') || '').trim();
    const oaModel = (this.config.get<string>('OPENAI_MODEL') || 'gpt-4o-mini').trim();
    const gmKey = (this.config.get<string>('GEMINI_API_KEY') || '').trim();
    const gmModel = (this.config.get<string>('GEMINI_MODEL') || 'gemini-flash-latest').trim();

    if (oaKey && oaKey.startsWith('sk-') && !oaKey.includes('...') && oaKey.length > 20) {
      this.openaiKey = oaKey;
      this.openaiModel = ['gpt-4o', 'gpt-4o-mini', 'gpt-4.1', 'gpt-4.1-mini', 'gpt-4-turbo'].includes(oaModel)
        ? oaModel
        : 'gpt-4o-mini';
      this.logger.log(`OpenAI ready. Model: ${this.openaiModel}`);
    }

    // Also recover if a Gemini key (AIza...) was accidentally placed in OPENAI_API_KEY
    const resolvedGeminiKey = gmKey || (oaKey.startsWith('AIza') ? oaKey : '');
    if (resolvedGeminiKey && resolvedGeminiKey.length > 10 && !resolvedGeminiKey.includes('...')) {
      this.geminiKey = resolvedGeminiKey;
      this.geminiModel = gmModel;
      this.logger.log(`Gemini AI ready. Model: ${this.geminiModel}`);
    }

    if (!this.openaiKey && !this.geminiKey) {
      this.logger.warn('No AI API key configured. Using built-in search + knowledge engine.');
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // PUBLIC — Main entry point (non-streaming)
  // ─────────────────────────────────────────────────────────────────────────────

  async generateResponse(params: {
    prompt: string;
    mode: string;
    industry?: string;
    conversationHistory?: Array<{ sender: string; text: string }>;
    sources?: SearchResult[];
    useWebSearch?: boolean;
  }): Promise<AiResponse> {
    const { prompt, mode, industry, conversationHistory = [], sources = [], useWebSearch = false } = params;

    if (mode === 'create_image') return this.handleImageGeneration(prompt);

    const systemPrompt = this.buildSystemPrompt(prompt, mode, industry, sources);

    if (this.openaiKey) {
      try {
        return await this.callOpenAIResponses(systemPrompt, prompt, conversationHistory, useWebSearch || sources.length > 0);
      } catch (err) {
        this.logger.warn(`OpenAI failed: ${err.message}`);
      }
    }

    if (this.geminiKey) {
      try {
        return await this.callGemini(systemPrompt, prompt, conversationHistory, useWebSearch || sources.length > 0);
      } catch (err) {
        this.logger.warn(`Gemini failed: ${err.message}`);
      }
    }

    return this.generateKnowledgeFallback(prompt, mode, industry, sources);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // PUBLIC — Streaming entry point
  // ─────────────────────────────────────────────────────────────────────────────

  async *streamResponse(params: {
    prompt: string;
    mode: string;
    industry?: string;
    conversationHistory?: Array<{ sender: string; text: string }>;
    sources?: SearchResult[];
    useWebSearch?: boolean;
  }): AsyncGenerator<string, void, unknown> {
    const { prompt, mode, industry, conversationHistory = [], sources = [], useWebSearch = false } = params;

    if (mode === 'create_image') {
      const img = await this.handleImageGeneration(prompt);
      yield img.text;
      return;
    }

    const systemPrompt = this.buildSystemPrompt(prompt, mode, industry, sources);

    if (this.openaiKey) {
      try {
        // Use Responses API with web_search when search is needed, or streaming chat completions
        if (useWebSearch || mode === 'web_search' || mode === 'deep_research') {
          const res = await this.callOpenAIResponses(systemPrompt, prompt, conversationHistory, true);
          for (const para of res.text.split('\n\n')) {
            yield para + '\n\n';
            await new Promise((r) => setTimeout(r, 25));
          }
          return;
        }
        yield* this.streamOpenAI(systemPrompt, prompt, conversationHistory);
        return;
      } catch (err) {
        this.logger.warn(`OpenAI stream failed: ${err.message}`);
      }
    }

    if (this.geminiKey) {
      try {
        yield* this.streamGemini(systemPrompt, prompt, conversationHistory, useWebSearch || sources.length > 0);
        return;
      } catch (err) {
        this.logger.warn(`Gemini stream failed: ${err.message}`);
      }
    }

    // Built-in search + knowledge fallback streamed naturally
    const fallback = this.generateKnowledgeFallback(prompt, mode, industry, sources);
    for (const para of fallback.text.split('\n\n')) {
      yield para + '\n\n';
      await new Promise((r) => setTimeout(r, 35));
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // SYSTEM PROMPT — topic-aware, location-aware, search-integrated
  // ─────────────────────────────────────────────────────────────────────────────

  private buildSystemPrompt(
    userPrompt: string,
    mode: string,
    industry: string | undefined,
    sources: SearchResult[],
  ): string {
    const detectedTopic = this.detectTopic(userPrompt);
    const isAgri = detectedTopic === 'Agriculture';
    const isIndia = this.isIndiaRelated(userPrompt) || isAgri;
    const hasSources = sources.length > 0;

    let system = `You are Aattral, an accurate, helpful AI assistant.

Core Rules:
1. Answer the user's EXACT question directly. Never change the topic.
2. Never tell the user to enable Web Search or Deep Research modes, and never suggest searching the internet yourself.
3. Jump straight into the answer without generic introductions.
4. Format naturally in Markdown (headings, bullet points, bold key terms, tables when helpful, code blocks ONLY for programming questions).
5. Never invent facts, URLs, or statistics. If current data is unavailable, state that clearly.`;

    if (isIndia) {
      system += `\n6. For Indian context (especially agriculture), consider India as the primary context and include Tamil Nadu-specific details where relevant (e.g., Cauvery delta water issues, northeast monsoon variability, state procurement/MSP, TNAU/ICAR guidance).`;
    }

    if (industry && industry !== 'General' && industry !== '') {
      system += `\n7. Selected industry context: ${industry}. Apply only if relevant to the user's actual question.`;
    }

    if (hasSources) {
      system += `\n\nRetrieved Web Sources:\n`;
      sources.forEach((s, i) => {
        system += `[${i + 1}] ${s.title}${s.publishedDate ? ` (${s.publishedDate})` : ''}: ${s.snippet}\nURL: ${s.url}\n\n`;
      });
      system += `Synthesize these retrieved sources with your knowledge, cite using [1], [2], etc., and include clickable source links.`;
    }

    if (mode === 'deep_research') {
      system += `\n\nProvide a thorough, multi-section analysis covering causes, real-world impact, practical solutions, and verified sources.`;
    }

    return system;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // OPENAI RESPONSES API (with web_search tool + output_text extraction)
  // ─────────────────────────────────────────────────────────────────────────────

  private async callOpenAIResponses(
    systemPrompt: string,
    userPrompt: string,
    history: Array<{ sender: string; text: string }>,
    enableWebSearch: boolean,
  ): Promise<AiResponse> {
    const input: any[] = [{ role: 'system', content: systemPrompt }];
    for (const msg of history.slice(-8)) {
      input.push({ role: msg.sender === 'user' ? 'user' : 'assistant', content: msg.text });
    }
    input.push({ role: 'user', content: userPrompt });

    const body: any = {
      model: this.openaiModel,
      input,
    };

    if (enableWebSearch) {
      body.tools = [{ type: 'web_search_preview' }];
    }

    const res = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.openaiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(45000),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`OpenAI Responses HTTP ${res.status}: ${errText}`);
    }

    const data: any = await res.json();

    // Extract output_text from Responses API
    let text = data.output_text || '';
    const citations: SearchResult[] = [];

    if (!text && Array.isArray(data.output)) {
      for (const item of data.output) {
        if (item.type === 'message' && Array.isArray(item.content)) {
          for (const part of item.content) {
            if (part.type === 'output_text' && part.text) {
              text += part.text;
              if (Array.isArray(part.annotations)) {
                for (const ann of part.annotations) {
                  if (ann.type === 'url_citation' && ann.url) {
                    citations.push({
                      title: ann.title || ann.url,
                      url: ann.url,
                      snippet: '',
                      siteName: this.extractDomain(ann.url),
                    });
                  }
                }
              }
            }
          }
        }
      }
    }

    if (!text) throw new Error('OpenAI Responses API returned empty output_text');

    if (citations.length > 0 && !text.includes('http')) {
      text += '\n\n### Sources\n' + citations.map((c, i) => `[${i + 1}] [${c.title}](${c.url})`).join('\n');
    }

    return {
      text,
      suggestedQuestions: this.generateSuggestedQuestions(userPrompt),
      citations,
    };
  }

  private async *streamOpenAI(
    systemPrompt: string,
    userPrompt: string,
    history: Array<{ sender: string; text: string }>,
  ): AsyncGenerator<string, void, unknown> {
    const messages: any[] = [{ role: 'system', content: systemPrompt }];
    for (const msg of history.slice(-8)) {
      messages.push({ role: msg.sender === 'user' ? 'user' : 'assistant', content: msg.text });
    }
    messages.push({ role: 'user', content: userPrompt });

    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.openaiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: this.openaiModel, messages, temperature: 0.7, max_tokens: 2048, stream: true }),
      signal: AbortSignal.timeout(60000),
    });

    if (!res.ok) throw new Error(`OpenAI HTTP ${res.status}: ${await res.text()}`);

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const line of decoder.decode(value).split('\n')) {
        if (!line.startsWith('data: ')) continue;
        const raw = line.slice(6).trim();
        if (raw === '[DONE]') return;
        try {
          const content = JSON.parse(raw).choices?.[0]?.delta?.content;
          if (content) yield content;
        } catch {
          // skip
        }
      }
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // GEMINI Integration (with Google Search Grounding)
  // ─────────────────────────────────────────────────────────────────────────────

  private async callGemini(
    systemPrompt: string,
    userPrompt: string,
    history: Array<{ sender: string; text: string }>,
    enableGoogleSearch: boolean,
  ): Promise<AiResponse> {
    const contents: any[] = [];
    for (const msg of history.slice(-8)) {
      contents.push({ role: msg.sender === 'user' ? 'user' : 'model', parts: [{ text: msg.text }] });
    }
    contents.push({ role: 'user', parts: [{ text: userPrompt }] });

    const body: any = {
      system_instruction: { parts: [{ text: systemPrompt }] },
      contents,
      generationConfig: { temperature: 0.7, maxOutputTokens: 3000 },
    };
    if (enableGoogleSearch) {
      body.tools = [{ google_search: {} }];
    }

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.geminiModel}:generateContent?key=${this.geminiKey}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(40000),
    });

    if (!res.ok) throw new Error(`Gemini HTTP ${res.status}: ${await res.text()}`);
    const data: any = await res.json();
    let text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) throw new Error('Gemini returned empty response');

    const chunks = data.candidates?.[0]?.groundingMetadata?.groundingChunks || [];
    const citations: SearchResult[] = chunks
      .filter((c: any) => c.web?.uri)
      .map((c: any) => ({
        title: c.web.title || c.web.uri,
        url: c.web.uri,
        snippet: '',
        siteName: this.extractDomain(c.web.uri),
      }));

    if (citations.length > 0) {
      text += '\n\n### Sources\n' + citations.map((c, i) => `[${i + 1}] [${c.title}](${c.url})`).join('\n');
    }

    return { text, suggestedQuestions: this.generateSuggestedQuestions(userPrompt), citations };
  }

  private async *streamGemini(
    systemPrompt: string,
    userPrompt: string,
    history: Array<{ sender: string; text: string }>,
    enableGoogleSearch: boolean,
  ): AsyncGenerator<string, void, unknown> {
    const contents: any[] = [];
    for (const msg of history.slice(-8)) {
      contents.push({ role: msg.sender === 'user' ? 'user' : 'model', parts: [{ text: msg.text }] });
    }
    contents.push({ role: 'user', parts: [{ text: userPrompt }] });

    const body: any = {
      system_instruction: { parts: [{ text: systemPrompt }] },
      contents,
      generationConfig: { temperature: 0.7, maxOutputTokens: 3000 },
    };
    if (enableGoogleSearch) {
      body.tools = [{ google_search: {} }];
    }

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.geminiModel}:streamGenerateContent?alt=sse&key=${this.geminiKey}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60000),
    });

    if (!res.ok) throw new Error(`Gemini HTTP ${res.status}: ${await res.text()}`);

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    const seenUrls = new Set<string>();
    const collectedCitations: SearchResult[] = [];

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() || '';
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const raw = line.slice(6).trim();
        if (!raw) continue;
        try {
          const json = JSON.parse(raw);
          const text = json.candidates?.[0]?.content?.parts?.[0]?.text;
          if (text) yield text;

          const chunks = json.candidates?.[0]?.groundingMetadata?.groundingChunks || [];
          for (const c of chunks) {
            if (c.web?.uri && !seenUrls.has(c.web.uri)) {
              seenUrls.add(c.web.uri);
              collectedCitations.push({
                title: c.web.title || c.web.uri,
                url: c.web.uri,
                snippet: '',
                siteName: this.extractDomain(c.web.uri),
              });
            }
          }
        } catch {
          // skip
        }
      }
    }

    if (collectedCitations.length > 0) {
      yield '\n\n### Sources\n' +
        collectedCitations.map((c, i) => `[${i + 1}] [${c.title}](${c.url})`).join('\n');
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // BUILT-IN SEARCH + KNOWLEDGE FALLBACK (never redirects to Web Search button)
  // ─────────────────────────────────────────────────────────────────────────────

  private generateKnowledgeFallback(
    prompt: string,
    mode: string,
    industry?: string,
    sources: SearchResult[] = [],
  ): AiResponse {
    const q = prompt.trim();
    const topic = this.detectTopic(q);
    const isIndia = this.isIndiaRelated(q) || topic === 'Agriculture';
    let text = '';

    if (topic === 'Agriculture') {
      text = this.buildAgricultureResponse(q, isIndia, sources);
    } else if (sources.length > 0) {
      text = `## ${q}\n\nBased on retrieved sources:\n\n`;
      sources.forEach((s, i) => {
        text += `### ${i + 1}. [${s.title}](${s.url})\n`;
        if (s.publishedDate) text += `*Published: ${s.publishedDate}* — `;
        text += `${s.snippet}\n\n`;
      });
      text += `---\n### Sources\n` + sources.map((s, i) => `[${i + 1}] [${s.title}](${s.url}) (${s.siteName || 'Web'})`).join('\n');
    } else if (topic === 'Healthcare') {
      text = `## ${q}\n\n${this.getHealthcareKnowledge(q)}`;
    } else {
      text = `## ${q}\n\nThis question falls under **${topic}**. Live AI model access is currently unavailable (API quota or key not active), so a full generative answer could not be produced for "${q}". Please check your configured ` +
        '`GEMINI_API_KEY` or `OPENAI_API_KEY` quota on the backend.';
    }

    return {
      text,
      suggestedQuestions: this.generateSuggestedQuestions(prompt),
      citations: sources,
    };
  }

  private buildAgricultureResponse(query: string, isIndia: boolean, sources: SearchResult[]): string {
    const regionNote = isIndia
      ? 'with a focus on **India** (including **Tamil Nadu** where relevant)'
      : 'globally';

    let text = `## Current Issues Farmers Face in Agriculture\n\nFarmers ${regionNote} face a combination of climatic, economic, biological, and structural challenges:\n\n`;

    text += `### 1. Water Scarcity & Irregular Rainfall\n`;
    text += `- **What is happening:** Groundwater tables are dropping in major agricultural belts (Punjab, Haryana, Tamil Nadu, Maharashtra), while monsoon onset and withdrawal have become erratic.\n`;
    text += `- **Why:** Over-extraction through borewells, free/subsidized electricity encouraging water-intensive crops (paddy, sugarcane), and climate-driven monsoon variability. In Tamil Nadu's Cauvery delta, delayed river water releases and uneven northeast monsoons directly affect Kuruvai and Samba rice crops.\n`;
    text += `- **Impact on farmers:** Delayed sowing, crop wilting during dry spells, and rising borewell deepening costs.\n`;
    text += `- **Practical solutions:** Micro-irrigation (drip and sprinkler systems under PMKSY), rainwater harvesting, farm ponds, System of Rice Intensification (SRI), and shifting toward drought-tolerant millets and pulses.\n\n`;

    text += `### 2. Rising Input Costs (Fertilizers, Pesticides, Diesel & Seeds)\n`;
    text += `- **What is happening:** Costs for diammonium phosphate (DAP), potash, crop protection chemicals, hybrid seeds, and tractor fuel have climbed steadily.\n`;
    text += `- **Why:** Global supply chain volatility, import dependence for potash and phosphate raw materials, and energy price inflation.\n`;
    text += `- **Impact on farmers:** Narrowing profit margins and heavier reliance on informal or institutional credit.\n`;
    text += `- **Practical solutions:** Soil Health Card-based balanced fertilization (avoiding urea overuse), bio-fertilizers, neem-coated urea, and bulk input procurement through Farmer Producer Organizations (FPOs).\n\n`;

    text += `### 3. Crop Diseases & Pest Outbreaks\n`;
    text += `- **What is happening:** Invasive and weather-triggered pests such as fall armyworm (maize), pink bollworm (cotton), whitefly, and fungal blights/blast (paddy) cause recurring crop damage.\n`;
    text += `- **Why:** Warmer winters, unseasonal humidity, monocropping, and growing pest resistance to chemical sprays.\n`;
    text += `- **Impact on farmers:** Yield losses and repeated spending on pesticides.\n`;
    text += `- **Practical solutions:** Integrated Pest Management (IPM), pheromone traps, resistant seed varieties (from ICAR / TNAU), and timely advisory alerts.\n\n`;

    text += `### 4. Unstable Market Prices & Post-Harvest Losses\n`;
    text += `- **What is happening:** Sharp price crashes during bumper harvests (especially perishables like tomatoes, onions, and vegetables) alongside limited cold-storage and warehousing.\n`;
    text += `- **Why:** Fragmented supply chains, distress selling immediately after harvest due to debt/cash needs, and limited MSP procurement outside wheat and paddy.\n`;
    text += `- **Impact on farmers:** Selling below production cost despite good yields.\n`;
    text += `- **Practical solutions:** Cold storage and warehouse receipt financing, e-NAM digital auctions, crop diversification, and collective bargaining via FPOs.\n\n`;

    text += `### 5. Soil Degradation & Micronutrient Deficiency\n`;
    text += `- **What is happening:** Declining organic carbon, salinization in irrigated tracts, and widespread zinc, boron, and sulphur deficiencies.\n`;
    text += `- **Why:** Continuous rice-wheat or rice-rice monocropping, residue burning, and imbalanced chemical fertilizer application.\n`;
    text += `- **Practical solutions:** Crop rotation with legumes, green manuring, mulching, and organic compost.\n\n`;

    text += `### 6. Labour Shortages & Rising Wages\n`;
    text += `- **What is happening:** Shortage of skilled farm workers during peak transplanting and harvesting windows.\n`;
    text += `- **Why:** Rural youth moving to urban construction, manufacturing, and service jobs.\n`;
    text += `- **Practical solutions:** Custom Hiring Centres (CHCs) for harvesters/transplanters, direct-seeded rice (DSR), and drone-based spraying.\n\n`;

    text += `### 7. Climate Change & Extreme Weather\n`;
    text += `- **What is happening:** Heatwaves during wheat grain-filling, unseasonal hailstorms, and coastal cyclones (such as in Tamil Nadu and Andhra Pradesh) damaging standing crops.\n`;
    text += `- **Practical solutions:** Crop insurance (Pradhan Mantri Fasal Bima Yojana — PMFBY), weather-based advisories, and climate-resilient seed varieties.\n\n`;

    if (sources.length > 0) {
      text += `### Recent News & Verified Sources\n`;
      sources.forEach((s, i) => {
        text += `[${i + 1}] **[${s.title}](${s.url})**${s.publishedDate ? ` *(${s.publishedDate})*` : ''} — ${s.snippet}\n\n`;
      });
    } else {
      text += `### Official References\n`;
      text += `- [FAO — Food and Agriculture Organization](https://www.fao.org)\n`;
      text += `- [ICAR — Indian Council of Agricultural Research](https://icar.org.in)\n`;
      text += `- [Ministry of Agriculture & Farmers Welfare, India](https://agriwelfare.gov.in)\n`;
    }

    return text;
  }

  private getHealthcareKnowledge(query: string): string {
    return `Healthcare challenges include access and affordability gaps, rising chronic non-communicable diseases (diabetes, cardiovascular disease), antimicrobial resistance, mental health burden, and healthcare workforce shortages.\n\n- [WHO](https://www.who.int)\n- [NIH](https://www.nih.gov)`;
  }

  private async handleImageGeneration(prompt: string): Promise<AiResponse> {
    const seed = Math.floor(Math.random() * 999999);
    const encoded = encodeURIComponent(prompt.trim().slice(0, 200));
    const imageUrl = `https://image.pollinations.ai/prompt/${encoded}?width=1024&height=1024&nologo=true&seed=${seed}`;
    return {
      text: `### Generated Image: "${prompt}"\n\n![${prompt}](${imageUrl})\n\n---\n**Prompt**: *${prompt}*`,
      suggestedQuestions: ['Generate a variation in a different style', 'Create a more detailed version', 'Generate with different colors'],
      imageUrl,
    };
  }

  detectTopic(prompt: string): string {
    const p = prompt.toLowerCase();
    if (p.match(/agri|farm|crop|soil|seed|harvest|pesticide|fertilizer|irrigat|cattle|livestock|kisan|farmer/))
      return 'Agriculture';
    if (p.match(/health|medical|medicine|hospital|disease|symptom|treatment|doctor|patient|drug|vaccine|clinical/))
      return 'Healthcare';
    if (p.match(/code|program|software|javascript|python|api|database|algorithm|html|css|react|node|nestjs|typescript/))
      return 'Technology / Programming';
    if (p.match(/space|nasa|rocket|satellite|aerospac|aircraft|aviation|flight/))
      return 'Aerospace';
    if (p.match(/business|market|finance|invest|stock|economy|startup|revenue|sales|commerce/))
      return 'Business & Finance';
    if (p.match(/education|school|university|student|learn|teach|curriculum|exam/))
      return 'Education';
    if (p.match(/science|physics|chemistry|biology|research|experiment|scientist/))
      return 'Science';
    if (p.match(/automotive|car|vehicle|engine|ev|electric vehicle|automobile/))
      return 'Automotive';
    if (p.match(/climate|weather|environment|pollution|renewable|energy|sustainability|carbon/))
      return 'Environment & Climate';
    return 'General Knowledge';
  }

  private isIndiaRelated(prompt: string): boolean {
    return /india|indian|tamil|karnataka|kerala|gujarat|punjab|maharashtra|andhra|telangana|bengal|rajasthan|bihar|icar|pmfby|pm-kisan|e-nam|msp|rabi|kharif/i.test(prompt);
  }

  private extractDomain(url: string): string {
    try {
      return new URL(url).hostname.replace('www.', '');
    } catch {
      return 'web';
    }
  }

  generateSuggestedQuestions(prompt: string): string[] {
    const topic = this.detectTopic(prompt);
    switch (topic) {
      case 'Agriculture':
        return [
          'What government schemes help Indian farmers?',
          'How does drip irrigation improve crop yield?',
          'What are the major farming challenges in Tamil Nadu?',
        ];
      case 'Healthcare':
        return [
          'What are the latest advancements in this treatment?',
          'How can preventive care reduce these risks?',
          'What does WHO recommend for this condition?',
        ];
      case 'Technology / Programming':
        return [
          'Can you show me a code example for this?',
          'What are the best practices for this technology?',
          'How does this compare to alternatives?',
        ];
      case 'Business & Finance':
        return [
          'What are the latest market trends?',
          'How can small businesses improve margins?',
          'What financial planning strategies work best?',
        ];
      default:
        return [
          'Can you explain this in more detail?',
          'What are the most recent developments here?',
          'What practical steps can be taken?',
        ];
    }
  }
}
