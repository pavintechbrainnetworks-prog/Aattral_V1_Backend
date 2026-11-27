import { Module } from '@nestjs/common';
import { AiService } from './ai.service';
import { SearchModule } from '../search/search.module';

@Module({
  imports: [SearchModule],
  providers: [AiService],
  exports: [AiService],
})
export class AiModule {}
