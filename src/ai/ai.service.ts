import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SearchResult } from '../search/search.service';

export interface AiResponse {
  text: string;
  suggestedQuestions: string[];
  imageUrl?: string;
}

@Injectable()
export class AiService {
  private readonly logger = new Logger(AiService.name);
  private openaiBaseUrl = 'https://api.openai.com/v1';
  private openaiKey: string | null = null;
  private openaiModel = 'gpt-4o-mini';

  // Gemini (Google) support
  private geminiKey: string | null = null;
  private geminiModel = 'gemini-1.5-flash';

  constructor(private readonly config: ConfigService) {
    // OpenAI
    const oaKey = this.config.get<string>('OPENAI_API_KEY') || '';
    const oaModel = this.config.get<string>('OPENAI_MODEL') || 'gpt-4o-mini';
    if (oaKey && oaKey.startsWith('sk-') && !oaKey.includes('...') && oaKey.length > 20) {
      this.openaiKey = oaKey;
      // Fix invalid model names
      this.openaiModel = ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo', 'gpt-3.5-turbo'].includes(oaModel)
        ? oaModel
        : 'gpt-4o-mini';
      this.logger.log(`OpenAI client ready. Model: ${this.openaiModel}`);
    } else {
      this.logger.warn('OPENAI_API_KEY not set or invalid. Checking Gemini...');
    }

    // Gemini fallback
    const gmKey = this.config.get<string>('GEMINI_API_KEY') || '';
    if (gmKey && gmKey.length > 10 && !gmKey.includes('...')) {
      this.geminiKey = gmKey;
      this.logger.log('Gemini AI client ready.');
    }

    if (!this.openaiKey && !this.geminiKey) {
      this.logger.warn('No AI API keys configured. Using built-in knowledge engine.');
    }
  }

  // ─── Main Entry Point ────────────────────────────────────────────────────────

  async generateResponse(params: {
    prompt: string;
    mode: string;
    industry?: string;
    conversationHistory?: Array<{ sender: string; text: string }>;
    sources?: SearchResult[];
  }): Promise<AiResponse> {
    const { prompt, mode, industry, conversationHistory = [], sources = [] } = params;

    if (mode === 'create_image') {
      return this.handleImageGeneration(prompt);
    }

    const systemPrompt = this.buildSystemPrompt(prompt, mode, industry, sources);

    // Try OpenAI
    if (this.openaiKey) {
      try {
        return await this.callOpenAI(systemPrompt, prompt, conversationHistory);
      } catch (err) {
        this.logger.warn(`OpenAI failed: ${err.message}. Trying Gemini...`);
      }
    }

    // Try Gemini
    if (this.geminiKey) {
      try {
        return await this.callGemini(systemPrompt, prompt, conversationHistory);
      } catch (err) {
        this.logger.warn(`Gemini failed: ${err.message}. Using built-in engine.`);
      }
    }

    // Built-in fallback
    return this.generateSmartFallback(prompt, mode, industry, sources);
  }

  // ─── Streaming ────────────────────────────────────────────────────────────────

  async *streamResponse(params: {
    prompt: string;
    mode: string;
    industry?: string;
    conversationHistory?: Array<{ sender: string; text: string }>;
    sources?: SearchResult[];
  }): AsyncGenerator<string, void, unknown> {
    const { prompt, mode, industry, conversationHistory = [], sources = [] } = params;

    if (mode === 'create_image') {
      const imgRes = await this.handleImageGeneration(prompt);
      yield imgRes.text;
      return;
    }

    const systemPrompt = this.buildSystemPrompt(prompt, mode, industry, sources);

    // OpenAI streaming
    if (this.openaiKey) {
      try {
        yield* this.streamOpenAI(systemPrompt, prompt, conversationHistory);
        return;
      } catch (err) {
        this.logger.warn(`OpenAI stream failed: ${err.message}. Trying Gemini...`);
      }
    }

    // Gemini streaming
    if (this.geminiKey) {
      try {
        yield* this.streamGemini(systemPrompt, prompt, conversationHistory);
        return;
      } catch (err) {
        this.logger.warn(`Gemini stream failed: ${err.message}. Using fallback.`);
      }
    }

    // Built-in fallback streamed in chunks
    const response = this.generateSmartFallback(prompt, mode, industry, sources);
    const paragraphs = response.text.split('\n\n');
    for (const p of paragraphs) {
      yield p + '\n\n';
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  // ─── System Prompt Builder (KEY FIX: topic-aware, never hardcoded) ────────────

  private buildSystemPrompt(
    userPrompt: string,
    mode: string,
    industry?: string,
    sources: SearchResult[] = [],
  ): string {
    // Detect actual topic from the user's message — never force industry
    const detectedTopic = this.detectTopic(userPrompt);

    let system = `You are Aattral, a highly capable and accurate AI assistant created by Techbrain Networks.

CRITICAL RULES:
1. ALWAYS answer the user's EXACT question. If they ask about agriculture, answer about agriculture. If they ask about cooking, answer about cooking. NEVER switch topics.
2. NEVER generate unrelated content. The detected topic of this question is: "${detectedTopic}".
3. Format responses in clean Markdown: use headings (##, ###), bullet points, numbered lists, bold for key terms, tables when comparing, and code blocks for code.
4. Keep responses natural and conversational — like ChatGPT. Do NOT force every answer into rigid templates.
5. For simple questions: give a direct, concise answer.
6. For complex questions: provide thorough explanations with examples.
7. NEVER invent facts, URLs, or citations. If you don't know something, say so clearly.`;

    if (industry && industry !== 'Aerospace' && industry !== 'General') {
      system += `\n8. The user has selected "${industry}" as their industry context. Use this to make examples more relevant, but ONLY if the question is related to it. Do NOT force industry context onto unrelated topics.`;
    }

    if (mode === 'web_search') {
      system += `\n\n## Web Search Mode
The following sources were retrieved from the web for the query "${userPrompt}":
${sources.map((s, i) => `[${i + 1}] **${s.title}** — ${s.snippet}\nURL: ${s.url}`).join('\n\n')}

INSTRUCTIONS:
- Use these sources to answer the question accurately.
- Cite sources using [1], [2] etc. when referencing their information.
- If the sources don't fully answer the question, say what you do and don't know.
- Do NOT invent information not present in the sources.`;
    } else if (mode === 'deep_research') {
      system += `\n\n## Deep Research Mode
Provide a comprehensive, well-structured research report on: "${userPrompt}"
Structure your response with:
- **Executive Summary** (2-3 sentences)
- **Background & Context** (what it is, why it matters)
- **Key Facts & Current State** (data, statistics, recent developments)
- **Challenges & Problems** (real issues, not generic)
- **Solutions & Recommendations** (practical, specific)
- **Sources** (from retrieved sources if available)

${sources.length > 0 ? `Retrieved sources:\n${sources.map((s, i) => `[${i + 1}] ${s.title}: ${s.snippet} — ${s.url}`).join('\n')}` : ''}`;
    }

    return system;
  }

  // ─── Topic Detection (prevents Aerospace/template bleed) ───────────────────

  private detectTopic(prompt: string): string {
    const p = prompt.toLowerCase();
    if (p.match(/agri|farm|crop|soil|seed|harvest|pesticide|fertilizer|irrigation|cattle|livestock/))
      return 'Agriculture';
    if (p.match(/health|medical|medicine|hospital|disease|symptom|treatment|doctor|patient|drug|vaccine/))
      return 'Healthcare';
    if (p.match(/code|program|software|javascript|python|api|database|algorithm|html|css|react|node/))
      return 'Technology / Programming';
    if (p.match(/space|nasa|rocket|satellite|aerospac|aircraft|aviation|flight/))
      return 'Aerospace';
    if (p.match(/business|market|finance|invest|stock|economy|startup|revenue|sales/))
      return 'Business & Finance';
    if (p.match(/education|school|university|student|learn|teach|curriculum/))
      return 'Education';
    if (p.match(/science|physics|chemistry|biology|research|experiment/))
      return 'Science';
    if (p.match(/automotive|car|vehicle|engine|ev|electric vehicle/))
      return 'Automotive';
    return 'General Knowledge';
  }

  // ─── OpenAI Integration ─────────────────────────────────────────────────────

  private async callOpenAI(
    systemPrompt: string,
    userPrompt: string,
    history: Array<{ sender: string; text: string }>,
  ): Promise<AiResponse> {
    const messages: any[] = [{ role: 'system', content: systemPrompt }];
    for (const msg of history.slice(-8)) {
      messages.push({ role: msg.sender === 'user' ? 'user' : 'assistant', content: msg.text });
    }
    messages.push({ role: 'user', content: userPrompt });

    const res = await fetch(`${this.openaiBaseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.openaiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ model: this.openaiModel, messages, temperature: 0.7, max_tokens: 2048 }),
      signal: AbortSignal.timeout(30000),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`OpenAI HTTP ${res.status}: ${err}`);
    }

    const data: any = await res.json();
    const text = data.choices?.[0]?.message?.content || 'No response generated.';
    return { text, suggestedQuestions: this.generateSuggestedQuestions(userPrompt) };
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

    const res = await fetch(`${this.openaiBaseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.openaiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ model: this.openaiModel, messages, temperature: 0.7, max_tokens: 2048, stream: true }),
      signal: AbortSignal.timeout(60000),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`OpenAI HTTP ${res.status}: ${err}`);
    }

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const lines = decoder.decode(value).split('\n');
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const raw = line.slice(6).trim();
        if (raw === '[DONE]') return;
        try {
          const json = JSON.parse(raw);
          const content = json.choices?.[0]?.delta?.content;
          if (content) yield content;
        } catch {
          // skip malformed chunks
        }
      }
    }
  }

  // ─── Gemini Integration ──────────────────────────────────────────────────────

  private async callGemini(
    systemPrompt: string,
    userPrompt: string,
    history: Array<{ sender: string; text: string }>,
  ): Promise<AiResponse> {
    const contents: any[] = [];
    for (const msg of history.slice(-8)) {
      contents.push({ role: msg.sender === 'user' ? 'user' : 'model', parts: [{ text: msg.text }] });
    }
    contents.push({ role: 'user', parts: [{ text: userPrompt }] });

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.geminiModel}:generateContent?key=${this.geminiKey}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: systemPrompt }] },
        contents,
        generationConfig: { temperature: 0.7, maxOutputTokens: 2048 },
      }),
      signal: AbortSignal.timeout(30000),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Gemini HTTP ${res.status}: ${err}`);
    }

    const data: any = await res.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text || 'No response generated.';
    return { text, suggestedQuestions: this.generateSuggestedQuestions(userPrompt) };
  }

  private async *streamGemini(
    systemPrompt: string,
    userPrompt: string,
    history: Array<{ sender: string; text: string }>,
  ): AsyncGenerator<string, void, unknown> {
    const contents: any[] = [];
    for (const msg of history.slice(-8)) {
      contents.push({ role: msg.sender === 'user' ? 'user' : 'model', parts: [{ text: msg.text }] });
    }
    contents.push({ role: 'user', parts: [{ text: userPrompt }] });

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.geminiModel}:streamGenerateContent?alt=sse&key=${this.geminiKey}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: systemPrompt }] },
        contents,
        generationConfig: { temperature: 0.7, maxOutputTokens: 2048 },
      }),
      signal: AbortSignal.timeout(60000),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Gemini HTTP ${res.status}: ${err}`);
    }

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const lines = decoder.decode(value).split('\n');
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const raw = line.slice(6).trim();
        if (!raw) continue;
        try {
          const json = JSON.parse(raw);
          const text = json.candidates?.[0]?.content?.parts?.[0]?.text;
          if (text) yield text;
        } catch {
          // skip malformed
        }
      }
    }
  }

  // ─── Image Generation ────────────────────────────────────────────────────────

  private async handleImageGeneration(prompt: string): Promise<AiResponse> {
    const cleanPrompt = encodeURIComponent(prompt.trim().slice(0, 200));
    const seed = Math.floor(Math.random() * 999999);
    const imageUrl = `https://image.pollinations.ai/prompt/${cleanPrompt}?width=1024&height=1024&nologo=true&seed=${seed}`;

    const text = `### 🎨 Generated Image: "${prompt}"

![${prompt}](${imageUrl})

---
**Prompt**: *${prompt}*  
**Tip**: Right-click (or long-press on mobile) to save the image.`;

    return {
      text,
      suggestedQuestions: [
        `Generate a variation of this image in a different style`,
        `Create a more detailed version of this image`,
        `Generate a similar image with different colors`,
      ],
      imageUrl,
    };
  }

  // ─── Smart Fallback Engine (topic-aware, NOT industry-forced) ──────────────

  private generateSmartFallback(
    prompt: string,
    mode: string,
    industry?: string,
    sources: SearchResult[] = [],
  ): AiResponse {
    const q = prompt.trim();
    const topic = this.detectTopic(q);
    let text = '';

    if (mode === 'web_search') {
      const citedSources =
        sources.length > 0
          ? sources
          : [
              {
                title: `${q} — Wikipedia`,
                url: `https://en.wikipedia.org/wiki/Special:Search?search=${encodeURIComponent(q)}`,
                snippet: `Comprehensive information about ${q} from Wikipedia.`,
                siteName: 'wikipedia.org',
              },
              {
                title: `${q} — Google Scholar`,
                url: `https://scholar.google.com/scholar?q=${encodeURIComponent(q)}`,
                snippet: `Academic research and peer-reviewed articles about ${q}.`,
                siteName: 'scholar.google.com',
              },
            ];

      text = `## 🌐 Web Search: "${q}"

Here is what was found about **${q}**:

${citedSources.map((s, i) => `### [${i + 1}] [${s.title}](${s.url})\n${s.snippet}\n*Source: ${s.siteName || 'Web'}*`).join('\n\n')}

---
> ℹ️ For the most current and detailed information, please visit the sources above directly.`;
    } else if (mode === 'deep_research') {
      text = `## 🔬 Deep Research: "${q}"

### Executive Summary
This report provides a comprehensive analysis of **${q}** in the context of **${topic}**.

### Background & Context
${q} is an important topic in ${topic}. Understanding it requires examining its core principles, current developments, and practical implications.

### Key Areas to Explore
1. **Definition & Fundamentals** — What is ${q} and why does it matter?
2. **Current State** — What is happening today in this area?
3. **Challenges** — What are the main problems and obstacles?
4. **Solutions & Best Practices** — How are these challenges being addressed?
5. **Future Outlook** — Where is this heading?

> ⚠️ **Note**: For the most accurate and up-to-date research on "${q}", please enable **Web Search** mode or visit reliable sources such as Wikipedia, Google Scholar, or domain-specific publications.

${sources.length > 0 ? `### Sources\n${sources.map((s, i) => `[${i + 1}] [${s.title}](${s.url}) — ${s.snippet}`).join('\n')}` : ''}`;
    } else {
      // Smart conversational fallback based on detected topic
      text = `## ${q}

I'm Aattral, your AI assistant. Here's what I can tell you about **${q}** (${topic}):

This is a ${topic} question. To give you the most accurate and current answer, I'd recommend:

1. **Enable Web Search mode** — I'll search the internet and give you real, cited information about "${q}".
2. **Enable Deep Research mode** — For a comprehensive, structured analysis.

### What I know about "${q}":
${this.getTopicBasedHint(q, topic)}

> 💡 **Tip**: For the best results with questions like this, click the **Web Search** button before sending your message. I'll retrieve current, verified information from reliable sources.`;
    }

    return {
      text,
      suggestedQuestions: this.generateSuggestedQuestions(prompt),
    };
  }

  private getTopicBasedHint(query: string, topic: string): string {
    switch (topic) {
      case 'Agriculture':
        return `Agriculture involves farming, crop cultivation, livestock management, and food production. Common topics include soil health, crop diseases, irrigation methods, sustainable farming, pesticide use, and modern agricultural technology like precision farming and drones.`;
      case 'Healthcare':
        return `Healthcare encompasses medicine, patient care, disease prevention, and medical research. Topics include treatments, diagnostics, public health policies, pharmaceutical developments, and healthcare technology.`;
      case 'Technology / Programming':
        return `Technology and programming cover software development, computer science, web technologies, mobile apps, AI/ML, databases, and digital systems. Happy to explain code, debug problems, or explain technical concepts.`;
      case 'Business & Finance':
        return `Business and finance topics include entrepreneurship, investment, markets, accounting, strategy, economics, and financial planning.`;
      case 'Education':
        return `Education encompasses learning methods, curriculum design, school systems, educational technology, student development, and teaching practices.`;
      case 'Science':
        return `Science covers physics, chemistry, biology, environmental science, research methodology, and scientific discoveries.`;
      case 'Aerospace':
        return `Aerospace includes aircraft design, space exploration, satellite technology, aerodynamics, rocket propulsion, and aviation safety.`;
      default:
        return `I can help answer questions on a wide range of topics. For the most accurate current information on "${query}", please use Web Search mode.`;
    }
  }

  // ─── Suggested Questions (topic-aware) ──────────────────────────────────────

  generateSuggestedQuestions(prompt: string): string[] {
    const topic = this.detectTopic(prompt);
    const q = prompt.trim();

    switch (topic) {
      case 'Agriculture':
        return [
          `What are the most common crop diseases and how to treat them?`,
          `How does precision farming technology improve yield?`,
          `What are sustainable farming practices for small farmers?`,
        ];
      case 'Healthcare':
        return [
          `What are the latest treatments for this condition?`,
          `How does preventive medicine reduce healthcare costs?`,
          `What are the global health challenges in 2024?`,
        ];
      case 'Technology / Programming':
        return [
          `Can you give me a code example for this?`,
          `What are the best practices for this technology?`,
          `How does this compare to other alternatives?`,
        ];
      case 'Business & Finance':
        return [
          `What are the key market trends in this area?`,
          `How can small businesses improve profitability?`,
          `What financial metrics should I track?`,
        ];
      case 'Aerospace':
        return [
          `How do modern aircraft navigation systems work?`,
          `What are the latest developments in space exploration?`,
          `How is AI being used in aerospace engineering?`,
        ];
      default:
        return [
          `Can you explain this in more detail?`,
          `What are the latest developments in this area?`,
          `What are some practical examples?`,
        ];
    }
  }
}
