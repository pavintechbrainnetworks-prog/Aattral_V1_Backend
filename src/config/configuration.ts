export default () => ({
  port: parseInt(process.env.PORT ?? '5000', 10) || 5000,
  mongodbUri: process.env.MONGODB_URI ?? 'mongodb://127.0.0.1:27017/aattral',
  jwt: {
    secret: process.env.JWT_SECRET ?? 'fallback_secret',
    expiresIn: process.env.JWT_EXPIRES_IN ?? '7d',
  },
  frontend: {
    url: process.env.FRONTEND_URL ?? 'http://localhost:5173',
  },
  bcryptRounds: parseInt(process.env.BCRYPT_ROUNDS ?? '10', 10) || 10,
  mail: {
    host: process.env.SMTP_HOST ?? 'smtp.gmail.com',
    port: parseInt(process.env.SMTP_PORT ?? '465', 10) || 465,
    secure: (process.env.SMTP_SECURE ?? 'true') === 'true',
    user: process.env.SMTP_USER ?? 'techbrainnetworks@gmail.com',
    pass: process.env.SMTP_PASS ?? '',
    from: process.env.SMTP_FROM ?? '"Techbrain Networks" <techbrainnetworks@gmail.com>',
  },
});
