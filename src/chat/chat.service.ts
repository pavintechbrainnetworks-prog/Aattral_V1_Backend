import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import {
  Conversation,
  ConversationDocument,
  ChatMode,
} from '../conversations/schemas/conversation.schema';
import { Message, MessageDocument } from '../conversations/schemas/message.schema';
import { AiService } from '../ai/ai.service';
import { SearchService, SearchResult } from '../search/search.service';
import { SendMessageDto } from './dto/send-message.dto';

@Injectable()
export class ChatService {
  private readonly logger = new Logger(ChatService.name);

  constructor(
    @InjectModel(Conversation.name)
    private readonly convModel: Model<ConversationDocument>,
    @InjectModel(Message.name)
    private readonly messageModel: Model<MessageDocument>,
    private readonly aiService: AiService,
    private readonly searchService: SearchService,
  ) {}

  private generateTitle(prompt: string): string {
    const clean = prompt.replace(/[^\w\s]/gi, '').trim();
    const words = clean.split(/\s+/).slice(0, 6);
    const title = words.join(' ');
    return title.length > 35 ? title.slice(0, 35) + '...' : title || 'New Conversation';
  }

  /**
   * Decides whether to run a web search for this query.
   * Rules:
   *  - ALWAYS search for web_search and deep_research modes
   *  - For chat mode: search when question asks about current events, problems,
   *    news, prices, weather, government policies, or real-world situations
   */
  private shouldSearch(prompt: string, mode: string): boolean {
    if (mode === 'web_search' || mode === 'deep_research') return true;

    const p = prompt.toLowerCase();

    // Questions that need current real-world information
    const needsCurrentInfo = p.match(
      /issue|problem|challenge|today|current|now|recent|latest|news|price|cost|rate|weather|season|update|status|report|2024|2025|2026|government|scheme|policy|law|regulation|affect|impact|crisis|shortage|shortage|outbreak|war|conflict|disaster/,
    );

    // Questions about real-world situations or broad topics (e.g. "About agriculture")
    const isRealWorldQuestion = p.match(
      /about|what.*happen|how.*deal|why.*happen|farmer|agriculture|health|disease|economy|market|environment|climate|education|science|india|tamil/,
    );

    // Programming/technical questions don't need web search
    const isTechnicalQuery = p.match(
      /^(write|create|build|fix|debug|code for|refactor)\b/,
    );

    if (isTechnicalQuery && !isRealWorldQuestion) return false;

    return !!(needsCurrentInfo || isRealWorldQuestion);
  }

  // ── Non-streaming message processor ────────────────────────────────────────

  async processMessage(userId: string | undefined, dto: SendMessageDto) {
    if (!dto.prompt || !dto.prompt.trim()) {
      throw new BadRequestException('Prompt cannot be empty');
    }
    const userObjectId = userId && Types.ObjectId.isValid(userId)
      ? new Types.ObjectId(userId) : undefined;
    const mode = dto.mode || 'chat';
    const industry = dto.industry || 'General';

    // 1. Get or create conversation
    let conv: ConversationDocument | null = null;
    if (dto.conversationId && Types.ObjectId.isValid(dto.conversationId)) {
      conv = await this.convModel.findById(dto.conversationId).exec();
    }
    if (!conv) {
      conv = new this.convModel({
        userId: userObjectId,
        title: this.generateTitle(dto.prompt),
        industry,
        mode: mode as ChatMode,
      });
      await conv.save();
    }

    // 2. Save user message
    const userMsg = new this.messageModel({
      conversationId: conv._id,
      userId: userObjectId,
      sender: 'user',
      text: dto.prompt,
      mode,
      attachments: dto.attachments || [],
    });
    await userMsg.save();

    // 3. Auto web search — runs for web_search, deep_research, AND relevant chat queries
    const useWebSearch = this.shouldSearch(dto.prompt, mode);
    let sources: SearchResult[] = [];
    if (useWebSearch) {
      try {
        const limit = mode === 'deep_research' ? 6 : 5;
        sources = await this.searchService.searchWeb(dto.prompt, limit);
        this.logger.log(`Auto-search: found ${sources.length} sources for "${dto.prompt}"`);
      } catch (err) {
        this.logger.warn(`Web search failed: ${err.message}`);
      }
    }

    // 4. Retrieve conversation history (last 10 messages for context)
    const historyDocs = await this.messageModel
      .find({ conversationId: conv._id })
      .sort({ createdAt: 1 })
      .limit(10)
      .exec();

    const conversationHistory = historyDocs.map((m) => ({
      sender: m.sender,
      text: m.text,
    }));

    // 5. Generate AI response
    const aiResult = await this.aiService.generateResponse({
      prompt: dto.prompt,
      mode,
      industry,
      conversationHistory,
      sources,
    });

    // 6. Save assistant message
    const assistantMsg = new this.messageModel({
      conversationId: conv._id,
      userId: userObjectId,
      sender: 'assistant',
      text: aiResult.text,
      mode,
      sources,
      suggestedQuestions: aiResult.suggestedQuestions || [],
    });
    await assistantMsg.save();

    // 7. Update conversation timestamp
    conv.updatedAt = new Date();
    await conv.save();

    return {
      conversation: conv,
      userMessage: userMsg,
      assistantMessage: assistantMsg,
    };
  }

  // ── Streaming message processor ─────────────────────────────────────────────

  async *streamMessage(userId: string | undefined, dto: SendMessageDto) {
    if (!dto.prompt || !dto.prompt.trim()) {
      throw new BadRequestException('Prompt cannot be empty');
    }
    const userObjectId = userId && Types.ObjectId.isValid(userId)
      ? new Types.ObjectId(userId) : undefined;
    const mode = dto.mode || 'chat';
    const industry = dto.industry || 'General';

    // 1. Get or create conversation
    let conv: ConversationDocument | null = null;
    if (dto.conversationId && Types.ObjectId.isValid(dto.conversationId)) {
      conv = await this.convModel.findById(dto.conversationId).exec();
    }
    if (!conv) {
      conv = new this.convModel({
        userId: userObjectId,
        title: this.generateTitle(dto.prompt),
        industry,
        mode: mode as ChatMode,
      });
      await conv.save();
    }

    // Yield conversation metadata
    yield {
      type: 'meta',
      conversationId: conv._id.toString(),
      title: conv.title,
    };

    // 2. Save user message
    const userMsg = new this.messageModel({
      conversationId: conv._id,
      userId: userObjectId,
      sender: 'user',
      text: dto.prompt,
      mode,
      attachments: dto.attachments || [],
    });
    await userMsg.save();

    yield { type: 'user_message', userMessage: userMsg };

    // 3. Auto web search — runs automatically when query needs current info
    const useWebSearch = this.shouldSearch(dto.prompt, mode);
    let sources: SearchResult[] = [];
    if (useWebSearch) {
      try {
        const limit = mode === 'deep_research' ? 6 : 5;
        sources = await this.searchService.searchWeb(dto.prompt, limit);
        this.logger.log(`Auto-search (stream): found ${sources.length} sources for "${dto.prompt}"`);
        if (sources.length > 0) {
          yield { type: 'sources', sources };
        }
      } catch (err) {
        this.logger.warn(`Stream search failed: ${err.message}`);
      }
    }

    // 4. Retrieve conversation history
    const historyDocs = await this.messageModel
      .find({ conversationId: conv._id })
      .sort({ createdAt: 1 })
      .limit(10)
      .exec();

    const conversationHistory = historyDocs.map((m) => ({
      sender: m.sender,
      text: m.text,
    }));

    // 5. Stream from AI service
    let fullText = '';
    for await (const chunk of this.aiService.streamResponse({
      prompt: dto.prompt,
      mode,
      industry,
      conversationHistory,
      sources,
    })) {
      fullText += chunk;
      yield { type: 'chunk', chunk };
    }

    // 6. Save assistant message after streaming completes
    const assistantMsg = new this.messageModel({
      conversationId: conv._id,
      userId: userObjectId,
      sender: 'assistant',
      text: fullText,
      mode,
      sources,
      suggestedQuestions: this.aiService.generateSuggestedQuestions(dto.prompt),
    });
    await assistantMsg.save();

    conv.updatedAt = new Date();
    await conv.save();

    yield {
      type: 'done',
      assistantMessage: assistantMsg,
      conversationId: conv._id.toString(),
    };
  }

  // ── Feedback ─────────────────────────────────────────────────────────────────

  async updateFeedback(messageId: string, feedback: 'like' | 'dislike') {
    if (!Types.ObjectId.isValid(messageId)) {
      throw new NotFoundException('Message not found');
    }
    const msg = await this.messageModel.findByIdAndUpdate(
      messageId,
      { feedback },
      { new: true },
    ).exec();
    if (!msg) throw new NotFoundException('Message not found');
    return msg;
  }
}
