# API Reference

## Overview

The Skateboard backend provides a RESTful API for authentication, user management, payments, and usage tracking. All endpoints are prefixed with `/api`.

## Authentication

Authentication uses JWT tokens stored in HttpOnly cookies with CSRF protection.

### Headers

State-changing requests (POST, PUT, DELETE) require a CSRF token:
```
X-CSRF-Token: <csrf_token>
```

### Cookie Authentication

The `token` cookie is automatically sent with credentials. No manual token handling required.

---

## Endpoints

### Authentication

#### POST /api/signup
Create a new user account.

**Request Body:**
```json
{
  "name": "John Doe",
  "email": "john@example.com",
  "password": "securepassword"
}
```

**Validation:**
- `name`: 1-100 characters
- `email`: Valid email, max 254 characters
- `password`: 6-72 characters

**Response (200):**
```json
{
  "_id": "uuid",
  "email": "john@example.com",
  "name": "John Doe",
  "created_at": 1704067200,
  "subscription": null,
  "usage": { "count": 0, "reset_at": null }
}
```

**Cookies Set:**
- `token`: JWT token (HttpOnly, 30 days)
- `<appname>_csrf`: CSRF token (24 hours)

---

#### POST /api/signin
Sign in to existing account.

**Request Body:**
```json
{
  "email": "john@example.com",
  "password": "securepassword"
}
```

**Response (200):**
```json
{
  "_id": "uuid",
  "email": "john@example.com",
  "name": "John Doe",
  "created_at": 1704067200,
  "subscription": {
    "stripeID": "cus_xxx",
    "status": "active",
    "expires": 1735689600
  }
}
```

**Cookies Set:** Same as signup

---

#### POST /api/signout
Sign out current user.

**Response (200):**
```json
{ "message": "Signed out successfully" }
```

**Cookies Cleared:** `token`, `<appname>_csrf`

---

### User Management

#### GET /api/me
Get current authenticated user.

**Response (200):**
```json
{
  "_id": "uuid",
  "email": "john@example.com",
  "name": "John Doe",
  "created_at": 1704067200,
  "subscription": { ... },
  "usage": { "count": 5, "reset_at": 1706745600 }
}
```

---

#### PUT /api/me
Update current user profile.

**Request Body:**
```json
{
  "name": "New Name"
}
```

**Response (200):**
```json
{
  "_id": "uuid",
  "email": "john@example.com",
  "name": "New Name",
  ...
}
```

---

### Subscription

#### GET /api/isSubscriber
Check if current user has active subscription.

**Response (200):**
```json
{ "isSubscriber": true }
```
or
```json
{ "isSubscriber": false }
```

---

### Usage Tracking

#### POST /api/usage
Check or track usage for free users.

**Request Body:**
```json
{
  "operation": "check"
}
```
or
```json
{
  "operation": "track"
}
```

**Response (200) - Free User:**
```json
{
  "remaining": 15,
  "total": 20,
  "isSubscriber": false,
  "used": 5,
  "subscription": null
}
```

**Response (200) - Subscriber:**
```json
{
  "remaining": -1,
  "total": -1,
  "isSubscriber": true,
  "subscription": {
    "status": "active",
    "expiresAt": "2025-01-01T00:00:00.000Z"
  }
}
```

**Response (429) - Limit Reached:**
```json
{
  "error": "Usage limit reached",
  "remaining": 0,
  "total": 20,
  "isSubscriber": false
}
```

---

### Guides

Audio guide catalog. Reads are public; writes are currently open (auth gating is on the todo — see `todo.md`).

#### GET /api/guides
List guide summaries. Returns only `public` visibility, newest-first.

**Response (200):**
```json
[
  {
    "slug": "the-brand-age",
    "title": "The Brand Age",
    "author": "Paul Graham",
    "date": "March 2026",
    "duration": 2942,
    "thumbnail": "/images/the-brand-age/generated/timeline-eras.jpg",
    "chapterCount": 13,
    "visibility": "public",
    "createdAt": 1779488475341,
    "updatedAt": 1779488527289
  }
]
```

---

#### GET /api/guides/:slug
Full guide payload — chapters, transcript, and word timings inlined.

**Response (200):**
```json
{
  "slug": "the-brand-age",
  "title": "The Brand Age",
  "author": "Paul Graham",
  "date": "March 2026",
  "duration": 2942,
  "audio": "/audio/TheBrandAge.mp3",
  "thumbnail": "/images/the-brand-age/generated/timeline-eras.jpg",
  "timingOffset": 0.15,
  "defaultViewMode": "real",
  "visibility": "public",
  "chapterCount": 13,
  "chapters": [
    { "time": 0, "title": "The Quartz Crisis", "quote": "…", "realImage": "/images/…", "caption": "…" }
  ],
  "transcript": "Full essay text…",
  "timing": { "words": [{ "w": "The", "t": 0.12 }, { "w": "quartz", "t": 0.41 }] }
}
```

**Errors:** `404` if no guide with that slug, or visibility is not `public`.

---

#### POST /api/guides
Create a guide row. Audio is uploaded in a follow-up call.

**Request Body:**
```json
{
  "title": "My Essay",
  "author": "Author Name",
  "date": "May 2026",
  "duration": 1234,
  "transcript": "Full essay text…",
  "thumbnail": "/images/my-essay/hero.jpg",
  "defaultViewMode": "real",
  "slug": "my-essay"
}
```

**Validation:**
- `title`: required, 1–200 characters
- `slug`: optional — derived from title if omitted; must match `^[a-z0-9-]+$`
- `defaultViewMode`: `"real"` (default) or `"generated"`

**Response (201):**
```json
{ "slug": "my-essay" }
```

**Errors:**
- `400` — invalid title or slug
- `409` — slug already exists (response includes `slug`)

---

#### POST /api/guides/:slug/audio
Multipart upload. Stores the file at `backend/public/audio/<slug>.mp3` and updates the guide's `audio_url`.

**Request:** `multipart/form-data` with field `audio` (single file).

**Validation:**
- `slug`: must match `^[a-z0-9-]+$` and refer to an existing guide
- Content-Type: must start with `audio/`
- File size: max 200 MB

**Response (200):**
```json
{ "audio": "/audio/my-essay.mp3", "bytes": 31415926 }
```

**Errors:**
- `400` — invalid slug or missing `audio` field
- `404` — guide does not exist
- `413` — file too large
- `415` — non-audio content-type

---

> **Live captions during streaming:** while TTS is rendering, `GET /api/guides/:slug`
> merges the streaming timing sidecar (`<slug>.parts/timing.json` — cumulative
> per-word timings + normalized transcript) into the response, so the PiP can
> show word-synced captions for the portion already rendered. Once TTS finishes,
> the DB row's canonical `timing`/`transcript` are returned instead.

#### GET /api/guides/:slug/stream.mp3
Progressive audio for fast playback start. While TTS is still rendering, the
background job feeds each chunk's PCM into one continuous ffmpeg encoder that
writes a single growing `<slug>.parts/stream.mp3`; this endpoint tails that file
over a chunked-transfer response, holding the connection open and appending new
bytes as they land. One encoder (not per-chunk MP3s concatenated) means no
encoder-delay silence at chunk seams — gapless audio. The player starts within
seconds (once several chunks have flushed to disk) instead of waiting for the
whole render. The encoder waits for each chunk's MP3 bytes to land on disk
before bumping `chunksDone`, so progress never races ahead of playable audio.
Once the canonical `<slug>.mp3` exists, the endpoint `302`-redirects to it
(Range-seekable).

**Response:**
- `200` — `audio/mpeg`, `Transfer-Encoding: chunked` (live render in progress)
- `302` — redirect to `/audio/<slug>.mp3` (render finished)

Served with `Cross-Origin-Resource-Policy: cross-origin` so the extension PiP
(`chrome-extension://` origin) can play it.

**Errors:**
- `400` — invalid slug
- `404` — no render in progress and no canonical file (TTS not started)

---

### Payments (Stripe)

#### POST /api/checkout
Create Stripe checkout session.

**Request Body:**
```json
{
  "email": "john@example.com",
  "lookup_key": "premium_monthly"
}
```

**Response (200):**
```json
{
  "url": "https://checkout.stripe.com/...",
  "id": "cs_xxx",
  "customerID": "cus_xxx"
}
```

---

#### POST /api/portal
Create Stripe billing portal session.

**Request Body:**
```json
{
  "customerID": "cus_xxx"
}
```

**Response (200):**
```json
{
  "url": "https://billing.stripe.com/...",
  "id": "bps_xxx"
}
```

---

#### POST /api/payment
Stripe webhook endpoint. Handles subscription events.

**Events Handled:**
- `customer.subscription.created`
- `customer.subscription.updated`
- `customer.subscription.deleted`

---

### Health Check

#### GET /api/health
Health check endpoint.

**Response (200):**
```json
{
  "status": "healthy",
  "timestamp": "2025-01-01T00:00:00.000Z",
  "database": "connected"
}
```

---

## Rate Limiting

| Route Type | Limit | Window |
|------------|-------|--------|
| Auth routes (`/signin`, `/signup`) | 10 requests | 15 minutes |
| Payment routes (`/checkout`, `/portal`) | 5 requests | 15 minutes |
| All other routes | 300 requests | 15 minutes |

Rate limit headers:
- `X-RateLimit-Remaining`: Requests remaining
- `Retry-After`: Seconds until limit resets (on 429)

---

## Error Responses

All errors return JSON with an `error` field:

```json
{ "error": "Error message here" }
```

### Status Codes

| Code | Meaning |
|------|---------|
| 400 | Bad Request - Invalid input |
| 401 | Unauthorized - Not authenticated |
| 403 | Forbidden - Invalid CSRF or permission denied |
| 404 | Not Found - Resource doesn't exist |
| 429 | Too Many Requests - Rate limited |
| 500 | Internal Server Error |
| 503 | Service Unavailable - Auth disabled |

---

## Environment Variables

| Variable | Description | Required |
|----------|-------------|----------|
| `JWT_SECRET` | Secret for JWT signing | Yes |
| `STRIPE_KEY` | Stripe secret key | Yes |
| `STRIPE_ENDPOINT_SECRET` | Stripe webhook secret | Yes |
| `FREE_USAGE_LIMIT` | Monthly limit for free users | No (default: 20) |
| `CORS_ORIGINS` | Comma-separated allowed origins | No |
| `FRONTEND_URL` | Frontend URL for redirects | No |
| `PORT` | Server port | No (default: 8000) |

---

## Known Limitations

### Password Reset

Password reset functionality is not yet implemented. Users who forget their password must contact support for manual account recovery.

**Planned for future release:** Self-service password reset via email with time-limited tokens.
