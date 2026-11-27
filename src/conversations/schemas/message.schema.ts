import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type MessageDocument = HydratedDocument<Message>;

export class SourceItem {
  title: string;
  url: string;
  snippet: string;
  siteName?: string;
}

export class AttachmentItem {
  name: string;
  url: string;
  type: string;
}

@Schema({ timestamps: true })
export class Message {
  @Prop({ type: Types.ObjectId, ref: 'Conversation', required: true, index: true })
  conversationId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'User', required: false })
  userId?: Types.ObjectId;

  @Prop({ required: true, enum: ['user', 'assistant'] })
  sender: 'user' | 'assistant';

  @Prop({ required: true })
  text: string;

  @Prop({ default: 'chat' })
  mode: string;

  @Prop({ type: [Object], default: [] })
  sources: SourceItem[];

  @Prop({ type: [Object], default: [] })
  attachments: AttachmentItem[];

  @Prop({ type: String, enum: ['like', 'dislike', null], default: null })
  feedback?: 'like' | 'dislike' | null;

  @Prop({ type: [String], default: [] })
  suggestedQuestions: string[];

  createdAt?: Date;
  updatedAt?: Date;
}

export const MessageSchema = SchemaFactory.createForClass(Message);
MessageSchema.index({ conversationId: 1, createdAt: 1 });
