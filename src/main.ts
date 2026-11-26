import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppModule } from './app.module';
import { AllExceptionsFilter } from './common/filters/http-exception.filter';
import helmet from 'helmet';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const config = app.get(ConfigService);

  // Security headers
  app.use(helmet());

  // Global API prefix
  app.setGlobalPrefix('api');

  // CORS Configuration
  const configuredFrontend = config.get<string>('frontend.url');
  const allowedOrigins = [
    'https://aattral-v1-frontend-g5nx.vercel.app',
    'http://localhost:5173',
    'http://localhost:3000',
  ];
  if (configuredFrontend) {
    allowedOrigins.push(configuredFrontend.replace(/\/+$/, ''));
  }

  app.enableCors({
    origin: (origin, callback) => {
      // Allow server-to-server, curl, Postman, or no-origin requests
      if (!origin) {
        return callback(null, true);
      }
      const cleanOrigin = origin.replace(/\/+$/, '');
      if (
        allowedOrigins.includes(cleanOrigin) ||
        /\.vercel\.app$/.test(new URL(origin).hostname) ||
        cleanOrigin.includes('localhost')
      ) {
        return callback(null, true);
      }
      return callback(null, true); // Allow all during development to avoid blocking
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  });

  // Global validation pipe
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  // Global exception filter
  app.useGlobalFilters(new AllExceptionsFilter());

  const port = config.get<number>('port') ?? 5000;
  await app.listen(port);
  console.log(`🚀 Aattral Backend running at http://localhost:${port}/api`);
}

bootstrap();
