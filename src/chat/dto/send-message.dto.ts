import { IsString, IsNotEmpty, IsOptional, IsArray } from 'class-validator';

export class SendMessageDto {
  @IsString()
  @IsNotEmpty()
  prompt: string;

  @IsOptional()
  @IsString()
  conversationId?: string;

  @IsOptional()
  @IsString()
  mode?: string; // 'chat' | 'deep_research' | 'web_search' | 'create_image'

  @IsOptional()
  @IsString()
  industry?: string;

  @IsOptional()
  @IsArray()
  attachments?: Array<{ name: string; url: string; type: string }>;
}

export class FeedbackDto {
  @IsString()
  @IsNotEmpty()
  feedback: 'like' | 'dislike';
}
