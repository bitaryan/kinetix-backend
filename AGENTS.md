# AGENTS.md - Development & AI Collaboration Guidelines

Welcome, AI Agent! Follow these exact project conventions, architecture patterns, and coding standards when generating or modifying code in this repository.

---

## 1. Tech Specifications & Ecosystem
- **Database**: PostgreSQL
- **ORM Choice**: Prisma (TypeScript) or SQLModel / SQLAlchemy v2 (Python FastAPI) — **NO RAW SQL QUERIES**
- **Authentication**: JWT (Access Token in JSON, Refresh Token in HttpOnly Cookie) + Argon2/bcrypt
- **Roles (RBAC)**: `ADMIN`, `MANAGER`, `EMPLOYEE`
- **Real-time Engine**: WebSockets / Socket.io for live location tracking during working hours
- **Validation**: Zod (TypeScript) or Pydantic v2 (Python)

---

## 2. Codebase Architecture Rules
- Follow **Feature-Based Modular Structure** under `src/modules/` or `app/api/v1/endpoints/`.
- Maintain strict separation of concerns:
  - **Controllers/Endpoints**: HTTP request parsing & response formatting ONLY.
  - **Services**: Business logic, password verification, token generation, login attempt counters.
  - **Repositories/CRUD**: ORM calls ONLY (no business logic in database layers).
  - **Schemas**: Input validation schemas (DTOs) and response models.

---

## 3. Database & ORM Guidelines
- **No Raw SQL**: Always use the ORM client (`prisma` instance or `AsyncSession`).
- **Field Naming**:
  - Database columns in SQL: `snake_case` (e.g. `employee_name`, `no_of_attempts`, `locked_until`).
  - Code properties: Standard `camelCase` for TypeScript or `snake_case` for Python.
- **Migrations**: Always modify the schema definition (`schema.prisma` or ORM models) and run migrations. Never alter database tables directly.

---

## 4. Authentication & Security Requirements
- **Attempt Tracking & Lockout**:
  - Track `no_of_attempts`. Increment on failed password checks.
  - If `no_of_attempts >= 5`, lock account for 15 minutes (`locked_until`).
  - Reset `no_of_attempts` to `0` on successful password verification.
- **Active Session Tracking**:
  - Store refresh token hash in `active_sessions` table/model.
  - Check `is_revoked == false` on every token refresh request.
- **Password Safety**: Never log passwords, return `password_hash` in responses, or process unhashed credentials in business logs.

---

## 5. Standard API Response Format

Always return consistent JSON structure:

```json
{
  "success": true,
  "data": { ... },
  "error": null
}
```

In case of failure:

```json
{
  "success": false,
  "data": null,
  "error": {
    "code": "INVALID_CREDENTIALS",
    "message": "Invalid email or password"
  }
}
```
