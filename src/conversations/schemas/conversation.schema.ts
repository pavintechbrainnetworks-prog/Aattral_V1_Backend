import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type ConversationDocument = HydratedDocument<Conversation>;

export enum ChatMode {
  CHAT = 'chat',
  DEEP_RESEARCH = 'deep_research',
  WEB_SEARCH = 'web_search',
  CREATE_IMAGE = 'create_image',
}

@Schema({ timestamps: true })
export class Conversation {
  @Prop({ type: Types.ObjectId, ref: 'User', required: false, index: true })
  userId?: Types.ObjectId;

  @Prop({ required: true, trim: true, default: 'New Conversation' })
  title: string;

  @Prop({ required: false, trim: true, default: 'Aerospace' })
  industry?: string;

  @Prop({ type: String, enum: ChatMode, default: ChatMode.CHAT })
  mode: ChatMode;

  @Prop({ default: false })
  pinned: boolean;

  createdAt?: Date;
  updatedAt?: Date;
}

export const ConversationSchema = SchemaFactory.createForClass(Conversation);
ConversationSchema.index({ userId: 1, updatedAt: -1 });
