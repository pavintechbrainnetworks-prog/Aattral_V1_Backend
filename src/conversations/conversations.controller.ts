import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  UseGuards,
  Req,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { ConversationsService } from './conversations.service';
import {
  CreateConversationDto,
  UpdateConversationDto,
} from './dto/conversation.dto';

@Controller('conversations')
@UseGuards(JwtAuthGuard)
export class ConversationsController {
  constructor(private readonly conversationsService: ConversationsService) {}

  @Get()
  async getAllConversations(@Req() req: any) {
    const userId = req.user?._id?.toString() || req.user?.id;
    const conversations = await this.conversationsService.findAll(userId);
    return { success: true, data: conversations };
  }

  @Post()
  async createConversation(@Req() req: any, @Body() dto: CreateConversationDto) {
    const userId = req.user?._id?.toString() || req.user?.id;
    const conversation = await this.conversationsService.create(userId, dto);
    return { success: true, data: conversation };
  }

  @Get(':id')
  async getConversation(@Req() req: any, @Param('id') id: string) {
    const userId = req.user?._id?.toString() || req.user?.id;
    const result = await this.conversationsService.findOne(id, userId);
    return { success: true, data: result };
  }

  @Patch(':id')
  async updateConversation(
    @Req() req: any,
    @Param('id') id: string,
    @Body() dto: UpdateConversationDto,
  ) {
    const userId = req.user?._id?.toString() || req.user?.id;
    const updated = await this.conversationsService.update(id, userId, dto);
    return { success: true, data: updated };
  }

  @Delete(':id')
  async deleteConversation(@Req() req: any, @Param('id') id: string) {
    const userId = req.user?._id?.toString() || req.user?.id;
    await this.conversationsService.remove(id, userId);
    return { success: true, message: 'Conversation deleted successfully' };
  }
}
