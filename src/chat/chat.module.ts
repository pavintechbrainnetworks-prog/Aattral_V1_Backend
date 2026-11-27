import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ChatService } from './chat.service';
import { ChatController } from './chat.controller';
import { AiModule } from '../ai/ai.module';
import { SearchModule } from '../search/search.module';
import {
  Conversation,
  ConversationSchema,
} from '../conversations/schemas/conversation.schema';
import { Message, MessageSchema } from '../conversations/schemas/message.schema';

@Module({
  imports: [
    AiModule,
    SearchModule,
    MongooseModule.forFeature([
      { name: Conversation.name, schema: ConversationSchema },
      { name: Message.name, schema: MessageSchema },
    ]),
  ],
  controllers: [ChatController],
  providers: [ChatService],
  exports: [ChatService],
})
export class ChatModule {}
