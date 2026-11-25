# Aattral Backend API

NestJS + TypeScript + MongoDB backend for the Aattral React frontend.

## Tech Stack
- **Framework:** NestJS (TypeScript)
- **Database:** MongoDB via Mongoose
- **Auth:** JWT + Passport
- **Security:** bcrypt, helmet, @nestjs/throttler
- **Validation:** class-validator, class-transformer

## Getting Started

### Prerequisites
- Node.js v18+
- MongoDB running on port 27017

### Installation
```bash
cd backend
npm install
```

### Environment
Copy `.env.example` to `.env` and update values:
```bash
cp .env.example .env
```

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | Backend port | `5000` |
| `MONGODB_URI` | MongoDB connection string | `mongodb://localhost:27017/aattral` |
| `JWT_SECRET` | Secret for signing JWT tokens | *(change this!)* |
| `JWT_EXPIRES_IN` | JWT expiry duration | `7d` |
| `FRONTEND_URL` | Allowed CORS origin | `http://localhost:5173` |
| `BCRYPT_ROUNDS` | bcrypt hashing rounds | `10` |

### Run Development Server
```bash
npm run start:dev
```

Backend starts at: **http://localhost:5000/api**

---

## API Reference

### Auth Endpoints
| Method | URL | Description | Auth Required |
|--------|-----|-------------|--------------|
| `POST` | `/api/auth/register` | Register new user | ❌ |
| `POST` | `/api/auth/login` | Login and receive JWT | ❌ |
| `GET` | `/api/auth/me` | Get current user profile | ✅ Bearer JWT |
| `PATCH` | `/api/auth/me` | Update profile (name/phone) | ✅ Bearer JWT |
| `POST` | `/api/auth/send-otp` | Send OTP to email | ❌ |
| `POST` | `/api/auth/verify-otp` | Verify OTP | ❌ |
| `POST` | `/api/auth/reset-password` | Reset password with OTP | ❌ |

### Users Endpoints (Admin Only)
| Method | URL | Description | Auth Required |
|--------|-----|-------------|--------------|
| `GET` | `/api/users` | Get all users | ✅ Admin JWT |
| `POST` | `/api/users` | Create user | ✅ Admin JWT |
| `GET` | `/api/users/:id` | Get user by ID | ✅ Admin JWT |
| `PATCH` | `/api/users/:id` | Update user | ✅ Admin JWT |
| `DELETE` | `/api/users/:id` | Delete user | ✅ Admin JWT |
| `PATCH` | `/api/users/:id/toggle-active` | Toggle active status | ✅ Admin JWT |
| `POST` | `/api/users/:id/login-history` | Add login/logout history | ✅ Admin JWT |

---

## Request/Response Examples

### Register
```json
POST /api/auth/register
Content-Type: application/json

{
  "name": "John Doe",
  "email": "john@example.com",
  "phone": "9876543210",
  "password": "Secret@123"
}
```

### Login
```json
POST /api/auth/login
Content-Type: application/json

{
  "email": "john@example.com",
  "password": "Secret@123"
}
```
**Response:**
```json
{
  "success": true,
  "message": "Login successful",
  "data": {
    "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
    "user": { "_id": "...", "name": "John Doe", "email": "john@example.com", "role": "user" }
  }
}
```

### Password Reset Flow
**Step 1 — Send OTP:**
```json
POST /api/auth/send-otp
{ "email": "john@example.com" }
```
*(OTP is logged to console in development. Wire up an email provider in production.)*

**Step 2 — Verify OTP:**
```json
POST /api/auth/verify-otp
{ "email": "john@example.com", "otp": "123456" }
```

**Step 3 — Reset Password:**
```json
POST /api/auth/reset-password
{ "email": "john@example.com", "otp": "123456", "newPassword": "NewPass@123" }
```

---

## Project Structure
```
backend/
├── src/
│   ├── main.ts                        ← App bootstrap
│   ├── app.module.ts                  ← Root module
│   ├── config/
│   │   └── configuration.ts           ← Env config factory
│   ├── database/
│   │   └── database.module.ts         ← Mongoose connection
│   ├── common/
│   │   ├── decorators/
│   │   │   ├── roles.decorator.ts     ← @Roles() decorator
│   │   │   └── current-user.decorator.ts
│   │   └── filters/
│   │       └── http-exception.filter.ts
│   ├── auth/
│   │   ├── auth.module.ts
│   │   ├── auth.controller.ts         ← /api/auth/* routes
│   │   ├── auth.service.ts
│   │   ├── dto/                       ← Validation DTOs
│   │   ├── guards/
│   │   │   ├── jwt-auth.guard.ts
│   │   │   └── roles.guard.ts
│   │   ├── schemas/
│   │   │   └── otp.schema.ts
│   │   └── strategies/
│   │       └── jwt.strategy.ts
│   └── users/
│       ├── users.module.ts
│       ├── users.controller.ts        ← /api/users/* routes
│       ├── users.service.ts
│       ├── dto/
│       └── schemas/
│           └── user.schema.ts
├── .env                               ← Local env (git-ignored)
├── .env.example                       ← Template
└── README.md
```

---

## Frontend Integration

The React frontend at `Aattral_v_0.1/` connects via:

```
src/services/api.js   ← Axios instance with JWT interceptor
.env                  ← VITE_API_BASE_URL=http://localhost:5000/api
```

---

## Production Notes
- Replace `console.log` OTP with a real email provider (e.g. SendGrid, Nodemailer).
- Change `JWT_SECRET` to a long random string.
- Run `npm audit fix` to address known vulnerabilities.
- Consider adding refresh tokens for production auth flows.
