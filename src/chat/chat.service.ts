import {
  Injectable,
  NotFoundException,
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

  async processMessage(userId: string | undefined, dto: SendMessageDto) {
    const userObjectId = userId && Types.ObjectId.isValid(userId) ? new Types.ObjectId(userId) : undefined;
    const mode = dto.mode || 'chat';
    const industry = dto.industry || 'Aerospace';

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

    // 3. Web Search if mode is web_search or deep_research
    let sources: SearchResult[] = [];
    if (mode === 'web_search' || mode === 'deep_research') {
      try {
        sources = await this.searchService.searchWeb(dto.prompt, mode === 'deep_research' ? 6 : 4);
      } catch (err) {
        this.logger.warn(`Web search failed: ${err.message}`);
      }
    }

    // 4. Retrieve conversation history for context (last 8 messages)
    const historyDocs = await this.messageModel
      .find({ conversationId: conv._id })
      .sort({ createdAt: 1 })
      .limit(8)
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

    // 7. Update conversation updatedAt timestamp
    conv.updatedAt = new Date();
    await conv.save();

    return {
      conversation: conv,
      userMessage: userMsg,
      assistantMessage: assistantMsg,
    };
  }

  async *streamMessage(userId: string | undefined, dto: SendMessageDto) {
    const userObjectId = userId && Types.ObjectId.isValid(userId) ? new Types.ObjectId(userId) : undefined;
    const mode = dto.mode || 'chat';
    const industry = dto.industry || 'Aerospace';

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

    // Yield conversation metadata first
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

    yield {
      type: 'user_message',
      userMessage: userMsg,
    };

    // 3. Search sources if needed
    let sources: SearchResult[] = [];
    if (mode === 'web_search' || mode === 'deep_research') {
      try {
        sources = await this.searchService.searchWeb(dto.prompt, mode === 'deep_research' ? 6 : 4);
        yield {
          type: 'sources',
          sources,
        };
      } catch (err) {
        this.logger.warn(`Search failed in stream: ${err.message}`);
      }
    }

    // 4. Retrieve conversation history
    const historyDocs = await this.messageModel
      .find({ conversationId: conv._id })
      .sort({ createdAt: 1 })
      .limit(8)
      .exec();

    const conversationHistory = historyDocs.map((m) => ({
      sender: m.sender,
      text: m.text,
    }));

    // 5. Stream from AI service
    let fullText = '';
    const chunkGenerator = this.aiService.streamResponse({
      prompt: dto.prompt,
      mode,
      industry,
      conversationHistory,
      sources,
    });

    for await (const chunk of chunkGenerator) {
      fullText += chunk;
      yield {
        type: 'chunk',
        chunk,
      };
    }

    // 6. Save assistant message after streaming completes
    const assistantMsg = new this.messageModel({
      conversationId: conv._id,
      userId: userObjectId,
      sender: 'assistant',
      text: fullText,
      mode,
      sources,
      suggestedQuestions: [
        `Tell me more about ${industry} advancements`,
        `Can you provide practical implementation steps?`,
        `What are the security considerations?`,
      ],
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

  async updateFeedback(messageId: string, feedback: 'like' | 'dislike') {
    if (!Types.ObjectId.isValid(messageId)) {
      throw new NotFoundException('Message not found');
    }
    const msg = await this.messageModel.findByIdAndUpdate(
      messageId,
      { feedback },
      { new: true },
    ).exec();

    if (!msg) {
      throw new NotFoundException('Message not found');
    }
    return msg;
  }
}
