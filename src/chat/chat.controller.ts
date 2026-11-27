import {
  Controller,
  Post,
  Patch,
  Body,
  Param,
  Res,
  Req,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { Response } from 'express';
import { OptionalJwtAuthGuard } from '../auth/guards/optional-jwt-auth.guard';
import { ChatService } from './chat.service';
import { SendMessageDto, FeedbackDto } from './dto/send-message.dto';

@Controller('chat')
export class ChatController {
  constructor(private readonly chatService: ChatService) {}

  @Post('message')
  @UseGuards(OptionalJwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  async sendMessage(@Req() req: any, @Body() dto: SendMessageDto) {
    const userId = req.user?._id?.toString() || req.user?.id;
    const result = await this.chatService.processMessage(userId, dto);
    return {
      success: true,
      data: result,
    };
  }

  @Post('stream')
  @UseGuards(OptionalJwtAuthGuard)
  async streamChat(
    @Req() req: any,
    @Body() dto: SendMessageDto,
    @Res() res: Response,
  ) {
    const userId = req.user?._id?.toString() || req.user?.id;

    // Set SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    try {
      const stream = this.chatService.streamMessage(userId, dto);
      for await (const event of stream) {
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      }
      res.end();
    } catch (err) {
      res.write(`data: ${JSON.stringify({ type: 'error', error: err.message })}\n\n`);
      res.end();
    }
  }

  @Patch('messages/:id/feedback')
  @UseGuards(OptionalJwtAuthGuard)
  async updateFeedback(
    @Param('id') id: string,
    @Body() dto: FeedbackDto,
  ) {
    const updated = await this.chatService.updateFeedback(id, dto.feedback);
    return { success: true, data: updated };
  }
}
