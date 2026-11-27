import {
  Injectable,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import {
  Conversation,
  ConversationDocument,
  ChatMode,
} from './schemas/conversation.schema';
import { Message, MessageDocument } from './schemas/message.schema';
import {
  CreateConversationDto,
  UpdateConversationDto,
} from './dto/conversation.dto';

@Injectable()
export class ConversationsService {
  constructor(
    @InjectModel(Conversation.name)
    private readonly convModel: Model<ConversationDocument>,
    @InjectModel(Message.name)
    private readonly messageModel: Model<MessageDocument>,
  ) {}

  async create(userId?: string, dto?: CreateConversationDto): Promise<ConversationDocument> {
    const userObjectId = userId && Types.ObjectId.isValid(userId) ? new Types.ObjectId(userId) : undefined;
    const conv = new this.convModel({
      userId: userObjectId,
      title: dto?.title?.trim() || 'New Conversation',
      industry: dto?.industry?.trim() || 'Aerospace',
      mode: dto?.mode || ChatMode.CHAT,
    });
    return conv.save();
  }

  async findAll(userId?: string): Promise<ConversationDocument[]> {
    if (!userId || !Types.ObjectId.isValid(userId)) {
      return [];
    }
    return this.convModel
      .find({ userId: new Types.ObjectId(userId) })
      .sort({ updatedAt: -1 })
      .limit(50)
      .exec();
  }

  async findOne(id: string, userId?: string): Promise<{ conversation: ConversationDocument; messages: MessageDocument[] }> {
    if (!Types.ObjectId.isValid(id)) {
      throw new NotFoundException('Conversation not found');
    }

    const conversation = await this.convModel.findById(id).exec();
    if (!conversation) {
      throw new NotFoundException('Conversation not found');
    }

    // Verify ownership if conversation has a userId and user is authenticated
    if (conversation.userId && userId && conversation.userId.toString() !== userId) {
      throw new ForbiddenException('Access denied to this conversation');
    }

    const messages = await this.messageModel
      .find({ conversationId: new Types.ObjectId(id) })
      .sort({ createdAt: 1 })
      .exec();

    return { conversation, messages };
  }

  async update(id: string, userId: string, dto: UpdateConversationDto): Promise<ConversationDocument> {
    if (!Types.ObjectId.isValid(id)) {
      throw new NotFoundException('Conversation not found');
    }

    const conv = await this.convModel.findById(id).exec();
    if (!conv) {
      throw new NotFoundException('Conversation not found');
    }

    if (conv.userId && conv.userId.toString() !== userId) {
      throw new ForbiddenException('Access denied to this conversation');
    }

    if (dto.title !== undefined) conv.title = dto.title.trim();
    if (dto.pinned !== undefined) conv.pinned = dto.pinned;

    return conv.save();
  }

  async remove(id: string, userId: string): Promise<void> {
    if (!Types.ObjectId.isValid(id)) {
      throw new NotFoundException('Conversation not found');
    }

    const conv = await this.convModel.findById(id).exec();
    if (!conv) {
      throw new NotFoundException('Conversation not found');
    }

    if (conv.userId && conv.userId.toString() !== userId) {
      throw new ForbiddenException('Access denied to this conversation');
    }

    await this.convModel.findByIdAndDelete(id).exec();
    await this.messageModel.deleteMany({ conversationId: new Types.ObjectId(id) }).exec();
  }
}
