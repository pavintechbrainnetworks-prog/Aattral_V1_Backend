/**
 * Migration Script: PostgreSQL -> MongoDB
 * 
 * Usage:
 *   1. Set POSTGRES_URL and MONGODB_URI in your environment or below.
 *   2. Run: node scripts/migrate-pg-to-mongo.js
 */

const { MongoClient } = require('mongodb');
const { Client: PgClient } = require('pg');

async function migrate() {
  const pgUrl = process.env.DATABASE_URL || 'postgresql://postgres:password@localhost:5432/postgres';
  const mongoUri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/aattral';

  console.log('Connecting to PostgreSQL and MongoDB...');
  const pgClient = new PgClient({ connectionString: pgUrl });
  const mongoClient = new MongoClient(mongoUri);

  try {
    await pgClient.connect();
    await mongoClient.connect();
    console.log('Connected to both databases.');

    const mongoDb = mongoClient.db();

    // 1. Migrate Users
    console.log('Migrating users...');
    const usersRes = await pgClient.query('SELECT * FROM users');
    const userDocs = usersRes.rows.map(row => ({
      name: row.name,
      email: (row.email || '').toLowerCase().trim(),
      phone: row.phone || '',
      password: row.password,
      role: row.role || 'user',
      active: row.active !== undefined ? row.active : true,
      loginHistory: Array.isArray(row.login_history)
        ? row.login_history
        : typeof row.login_history === 'string'
        ? JSON.parse(row.login_history)
        : [],
      createdAt: row.created_at || new Date(),
      updatedAt: row.updated_at || new Date(),
    }));

    if (userDocs.length > 0) {
      const usersCol = mongoDb.collection('users');
      for (const u of userDocs) {
        await usersCol.updateOne(
          { email: u.email },
          { $set: u },
          { upsert: true }
        );
      }
      console.log(`Successfully migrated ${userDocs.length} users.`);
    } else {
      console.log('No users found in PostgreSQL.');
    }

    // 2. Migrate OTPs
    console.log('Migrating otps...');
    const otpsRes = await pgClient.query('SELECT * FROM otps');
    const otpDocs = otpsRes.rows.map(row => ({
      email: (row.email || '').toLowerCase().trim(),
      hashedOtp: row.hashed_otp,
      expiresAt: row.expires_at,
      used: row.used !== undefined ? row.used : false,
      createdAt: row.created_at || new Date(),
      updatedAt: row.updated_at || new Date(),
    }));

    if (otpDocs.length > 0) {
      const otpsCol = mongoDb.collection('otps');
      await otpsCol.insertMany(otpDocs);
      console.log(`Successfully migrated ${otpDocs.length} OTP records.`);
    } else {
      console.log('No OTPs found in PostgreSQL.');
    }

    console.log('Migration completed successfully!');
  } catch (err) {
    console.error('Migration failed:', err);
  } finally {
    await pgClient.end().catch(() => {});
    await mongoClient.close().catch(() => {});
  }
}

migrate();
