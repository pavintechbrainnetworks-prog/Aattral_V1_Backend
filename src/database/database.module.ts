import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ConfigModule, ConfigService } from '@nestjs/config';

@Module({
  imports: [
    MongooseModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        uri: config.get<string>('mongodbUri') || 'mongodb://127.0.0.1:27017/aattral',
        autoIndex: true,
      }),
    }),
  ],
  exports: [MongooseModule],
})
export class DatabaseModule {}
