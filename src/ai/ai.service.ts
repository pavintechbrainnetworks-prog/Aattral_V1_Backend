import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GoogleGenAI } from '@google/genai';
import { SearchResult } from '../search/search.service';

export interface AiResponse {
  text: string;
  suggestedQuestions: string[];
  imageUrl?: string;
  citations?: SearchResult[];
  provider?: string;
  warning?: string;
}

@Injectable()
export class AiService implements OnModuleInit {
  private readonly logger = new Logger(AiService.name);
  private genAI: GoogleGenAI | null = null;
  private readonly geminiModel: string;
  private readonly hasApiKey: boolean;

  constructor(private readonly config: ConfigService) {
    const rawKey =
      this.config.get<string>('gemini.apiKey') ||
      this.config.get<string>('GEMINI_API_KEY') ||
      process.env.GEMINI_API_KEY ||
      '';
    const apiKey = rawKey.trim().replace(/^["']|["']$/g, '');

    const rawModel =
      this.config.get<string>('gemini.model') ||
      this.config.get<string>('GEMINI_MODEL') ||
      process.env.GEMINI_MODEL ||
      'gemini-flash-latest';
    this.geminiModel = rawModel.trim().replace(/^["']|["']$/g, '') || 'gemini-flash-latest';

    if (apiKey && apiKey.length > 10 && !apiKey.includes('...')) {
      try {
        this.genAI = new GoogleGenAI({ apiKey, httpOptions: { apiVersion: 'v1beta' } });
        this.hasApiKey = true;
      } catch (err: any) {
        this.hasApiKey = false;
        this.logger.error(`Failed to initialize GoogleGenAI SDK: ${this.sanitizeError(err?.message)}`);
      }
    } else {
      this.hasApiKey = false;
    }
  }

  onModuleInit() {
    if (this.hasApiKey && this.genAI) {
      this.logger.log(
        `Startup Check: GEMINI_API_KEY is configured | Model: ${this.geminiModel}`,
      );
    } else {
      this.logger.warn(
        'Startup Check: GEMINI_API_KEY is missing or empty. Set GEMINI_API_KEY in .env (local) or Render Environment Variables (production).',
      );
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // PUBLIC — Non-streaming generation
  // ─────────────────────────────────────────────────────────────────────────────

  async generateResponse(params: {
    prompt: string;
    mode: string;
    industry?: string;
    conversationHistory?: Array<{ sender: string; text: string }>;
    sources?: SearchResult[];
  }): Promise<AiResponse> {
    const { prompt, mode, industry, conversationHistory = [], sources = [] } = params;

    if (!prompt || !prompt.trim()) {
      return {
        text: 'Please enter a question or message so I can help you.',
        suggestedQuestions: [],
      };
    }

    if (mode === 'create_image') {
      return this.handleImageGeneration(prompt);
    }

    const systemInstruction = this.buildSystemPrompt(prompt, mode, industry, sources);
    const contents = this.buildContents(conversationHistory, prompt);

    if (this.genAI && this.hasApiKey) {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 35000);

        const response = await this.genAI.models.generateContent({
          model: this.geminiModel,
          contents,
          config: {
            systemInstruction,
            temperature: 0.7,
            maxOutputTokens: 3000,
            abortSignal: controller.signal,
          },
        });
        clearTimeout(timeout);

        const text = response.text?.trim();
        if (!text) {
          throw new Error('Gemini returned an empty response');
        }

        const finalText = this.appendVerifiedSourcesIfNeeded(text, sources);
        return {
          text: finalText,
          suggestedQuestions: this.generateSuggestedQuestions(prompt),
          citations: sources,
          provider: 'gemini',
        };
      } catch (err: any) {
        const safeErr = this.classifyGeminiError(err);
        this.logger.warn(`Gemini generateContent error (${safeErr.code}): ${safeErr.logMessage}`);
        return this.buildGracefulFallback(prompt, sources, safeErr.userNotice);
      }
    }

    return this.buildGracefulFallback(
      prompt,
      sources,
      'Gemini API key is not configured on the server.',
    );
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // PUBLIC — Streaming generation
  // ─────────────────────────────────────────────────────────────────────────────

  async *streamResponse(params: {
    prompt: string;
    mode: string;
    industry?: string;
    conversationHistory?: Array<{ sender: string; text: string }>;
    sources?: SearchResult[];
  }): AsyncGenerator<string, void, unknown> {
    const { prompt, mode, industry, conversationHistory = [], sources = [] } = params;

    if (!prompt || !prompt.trim()) {
      yield 'Please enter a question or message so I can help you.';
      return;
    }

    if (mode === 'create_image') {
      const img = await this.handleImageGeneration(prompt);
      yield img.text;
      return;
    }

    const systemInstruction = this.buildSystemPrompt(prompt, mode, industry, sources);
    const contents = this.buildContents(conversationHistory, prompt);

    if (this.genAI && this.hasApiKey) {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 45000);

        const stream = await this.genAI.models.generateContentStream({
          model: this.geminiModel,
          contents,
          config: {
            systemInstruction,
            temperature: 0.7,
            maxOutputTokens: 3000,
            abortSignal: controller.signal,
          },
        });

        let streamedText = '';
        for await (const chunk of stream) {
          const piece = chunk.text;
          if (piece) {
            streamedText += piece;
            yield piece;
          }
        }
        clearTimeout(timeout);

        if (!streamedText.trim()) {
          throw new Error('Gemini stream returned empty response');
        }

        if (sources.length > 0 && !streamedText.includes('http')) {
          yield '\n\n### Sources\n' +
            sources
              .map((s, i) => `[${i + 1}] [${s.title}](${s.url})${s.publishedDate ? ` *(${s.publishedDate})*` : ''}`)
              .join('\n');
        }
        return;
      } catch (err: any) {
        const safeErr = this.classifyGeminiError(err);
        this.logger.warn(`Gemini stream error (${safeErr.code}): ${safeErr.logMessage}`);
        const fallback = this.buildGracefulFallback(prompt, sources, safeErr.userNotice);
        for (const para of fallback.text.split('\n\n')) {
          yield para + '\n\n';
          await new Promise((r) => setTimeout(r, 30));
        }
        return;
      }
    }

    const fallback = this.buildGracefulFallback(
      prompt,
      sources,
      'Gemini API key is not configured on the server.',
    );
    for (const para of fallback.text.split('\n\n')) {
      yield para + '\n\n';
      await new Promise((r) => setTimeout(r, 30));
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // SYSTEM INSTRUCTIONS
  // ─────────────────────────────────────────────────────────────────────────────

  private buildSystemPrompt(
    userPrompt: string,
    mode: string,
    industry: string | undefined,
    sources: SearchResult[],
  ): string {
    const topic = this.detectTopic(userPrompt);
    const isAgri = topic === 'Agriculture';

    let system = `You are Aattral, an intelligent and helpful AI assistant.

Rules:
1. Understand the user's actual question.
2. Answer exactly what the user asks.
3. Never change the user's topic.
4. Never return unrelated Aerospace, programming or technical explanations.
5. Do not force answers into fixed templates.
6. Do not generate unnecessary code.
7. Give clear and natural answers formatted cleanly in Markdown.
8. Provide examples when useful.
9. Ask relevant questions when the user's request is ambiguous.
10. Maintain context across follow-up questions.
11. Never invent facts, statistics, citations or news.
12. Clearly distinguish verified information from general knowledge.`;

    if (isAgri) {
      system += `\n\nFor agriculture questions:
- Explain real farming problems.
- Include causes and effects.
- Suggest practical solutions.
- Consider India and Tamil Nadu when relevant.
- Understand locations such as Thanjavur, Salem and Trichy (e.g., Cauvery delta paddy cultivation in Thanjavur, borewell/rain-fed farming in Salem and Trichy).`;
    }

    if (industry && industry !== 'General' && industry !== '') {
      system += `\n\nSelected industry context: ${industry}. Apply this only when directly relevant to the user's question.`;
    }

    if (sources.length > 0) {
      system += `\n\nVerified Search Results Retrieved:\n`;
      sources.forEach((s, i) => {
        system += `[${i + 1}] ${s.title}${s.publishedDate ? ` (${s.publishedDate})` : ''}: ${s.snippet} | URL: ${s.url}\n`;
      });
      system += `Use these retrieved sources when relevant, cite them with [1], [2], etc., and preserve their exact URLs. Do not invent additional URLs.`;
    } else {
      system += `\n\nNote: No live web search results were attached to this turn. Answer from your general knowledge and clearly state if real-time data is required.`;
    }

    if (mode === 'deep_research') {
      system += `\n\nProvide a thorough, well-structured analysis covering causes, impacts, and practical solutions.`;
    }

    return system;
  }

  private buildContents(
    history: Array<{ sender: string; text: string }>,
    currentPrompt: string,
  ): Array<{ role: 'user' | 'model'; parts: Array<{ text: string }> }> {
    const contents: Array<{ role: 'user' | 'model'; parts: Array<{ text: string }> }> = [];

    // Include up to 10 previous turns for follow-up context, excluding the duplicate current user prompt if already saved
    const trimmedHistory = history.slice(-11);
    for (let i = 0; i < trimmedHistory.length; i++) {
      const msg = trimmedHistory[i];
      if (!msg.text?.trim()) continue;
      // Avoid duplicating the current prompt if ChatService already persisted it before calling AiService
      if (i === trimmedHistory.length - 1 && msg.sender === 'user' && msg.text.trim() === currentPrompt.trim()) {
        continue;
      }
      contents.push({
        role: msg.sender === 'user' ? 'user' : 'model',
        parts: [{ text: msg.text }],
      });
    }

    contents.push({
      role: 'user',
      parts: [{ text: currentPrompt.trim() }],
    });

    return contents;
  }

  private appendVerifiedSourcesIfNeeded(text: string, sources: SearchResult[]): string {
    if (!sources.length || text.includes('http')) return text;
    return (
      text +
      '\n\n### Sources\n' +
      sources
        .map((s, i) => `[${i + 1}] [${s.title}](${s.url})${s.publishedDate ? ` *(${s.publishedDate})*` : ''}`)
        .join('\n')
    );
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // ERROR HANDLING (no key exposure)
  // ─────────────────────────────────────────────────────────────────────────────

  private classifyGeminiError(err: any): { code: string; logMessage: string; userNotice: string } {
    const raw = this.sanitizeError(err?.message || String(err));
    const lower = raw.toLowerCase();

    if (err?.name === 'AbortError' || lower.includes('abort') || lower.includes('timeout')) {
      return {
        code: 'TIMEOUT',
        logMessage: 'Gemini request timed out.',
        userNotice: 'The AI request timed out. Please try again in a moment.',
      };
    }
    if (lower.includes('429') || lower.includes('resource_exhausted') || lower.includes('quota') || lower.includes('rate limit')) {
      return {
        code: 'QUOTA_EXCEEDED',
        logMessage: 'Gemini API quota or rate limit exceeded (429).',
        userNotice: 'Gemini API free-tier quota or rate limit is currently exhausted.',
      };
    }
    if (lower.includes('api_key_invalid') || lower.includes('401') || lower.includes('403') || lower.includes('permission_denied')) {
      return {
        code: 'INVALID_KEY',
        logMessage: 'Gemini API key is invalid or unauthorized.',
        userNotice: 'The configured Gemini API key is invalid or unauthorized.',
      };
    }
    if (lower.includes('404') || lower.includes('not found') || lower.includes('is not supported')) {
      return {
        code: 'MODEL_UNAVAILABLE',
        logMessage: `Gemini model "${this.geminiModel}" is unavailable.`,
        userNotice: `The configured Gemini model (${this.geminiModel}) is currently unavailable.`,
      };
    }
    return {
      code: 'GEMINI_ERROR',
      logMessage: raw.slice(0, 200),
      userNotice: 'Gemini AI service is temporarily unavailable.',
    };
  }

  private sanitizeError(msg?: string): string {
    if (!msg) return 'Unknown error';
    return msg.replace(/AIza[0-9A-Za-z_-]{20,}/g, '[REDACTED_KEY]');
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // GRACEFUL FALLBACK WHEN GEMINI API CANNOT RESPOND
  // ─────────────────────────────────────────────────────────────────────────────

  private buildGracefulFallback(
    prompt: string,
    sources: SearchResult[],
    notice: string,
  ): AiResponse {
    let text = `> ⚠️ **Notice:** ${notice}\n\n`;

    if (sources.length > 0) {
      text += `### Retrieved Search Results for "${prompt.trim()}"\n\n`;
      sources.forEach((s, i) => {
        text += `${i + 1}. **[${s.title}](${s.url})**${s.publishedDate ? ` *(${s.publishedDate})*` : ''}\n   ${s.snippet}\n\n`;
      });
    } else {
      text += `Unable to generate a Gemini AI response for **"${prompt.trim()}"** right now. Please verify \`GEMINI_API_KEY\` quota and \`GEMINI_MODEL\` in the backend environment and try again.`;
    }

    return {
      text,
      suggestedQuestions: this.generateSuggestedQuestions(prompt),
      citations: sources,
      provider: 'fallback',
      warning: notice,
    };
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
    if (p.match(/agri|farm|crop|soil|seed|harvest|pesticide|fertilizer|irrigat|cattle|livestock|kisan|farmer|thanjavur|salem|trichy|cauvery/))
      return 'Agriculture';
    if (p.match(/health|medical|medicine|hospital|disease|symptom|treatment|doctor|patient|drug|vaccine|clinical/))
      return 'Healthcare';
    if (p.match(/code|program|software|javascript|python|api|database|algorithm|html|css|react|node|nestjs|typescript/))
      return 'Technology / Programming';
    if (p.match(/business|market|finance|invest|stock|economy|startup|revenue|sales|commerce/))
      return 'Business & Finance';
    if (p.match(/education|school|university|student|learn|teach|curriculum|exam/))
      return 'Education';
    if (p.match(/climate|weather|environment|pollution|renewable|energy|sustainability|carbon/))
      return 'Environment & Climate';
    return 'General Knowledge';
  }

  generateSuggestedQuestions(prompt: string): string[] {
    const topic = this.detectTopic(prompt);
    switch (topic) {
      case 'Agriculture':
        return [
          'What government schemes support farmers in Tamil Nadu?',
          'How does drip irrigation improve crop yield?',
          'What are the major farming challenges in Thanjavur?',
        ];
      case 'Technology / Programming':
        return [
          'Can you show me a practical example?',
          'What are the best practices for this?',
          'How does this compare to alternatives?',
        ];
      default:
        return [
          'Can you explain this in more detail?',
          'Can you give a real-world example?',
          'What are the key takeaways?',
        ];
    }
  }
}
