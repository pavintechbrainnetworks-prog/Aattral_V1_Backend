import { IsString, IsOptional, IsEnum, IsBoolean } from 'class-validator';
import { ChatMode } from '../schemas/conversation.schema';

export class CreateConversationDto {
  @IsOptional()
  @IsString()
  title?: string;

  @IsOptional()
  @IsString()
  industry?: string;

  @IsOptional()
  @IsEnum(ChatMode)
  mode?: ChatMode;
}

export class UpdateConversationDto {
  @IsOptional()
  @IsString()
  title?: string;

  @IsOptional()
  @IsBoolean()
  pinned?: boolean;
}
