# Fyodor — A Conversation with Dostoevsky

A literary AI chatbot powered by Claude, with persistent memory, style adaptation,
and feedback-driven prompt evolution. Deploys to Vercel + Supabase.

---

## Architecture

```
Browser (public/index.html)
  └─→ /api/chat  (Vercel serverless function)
        ├─→ Anthropic API  (Claude Sonnet)
        └─→ Supabase       (conversations, messages, memory, ratings)
```

---

## Step 1 — Supabase Setup

1. Go to https://supabase.com → create a free project
2. Go to **SQL Editor** → paste the entire contents of `schema.sql` → Run
3. Go to **Project Settings → API** and copy:
   - **Project URL**
   - **anon public** key  ← used in the frontend
   - **service_role** key  ← used in the backend (NEVER expose this client-side)

---

## Step 2 — Anthropic API Key

1. Go to https://console.anthropic.com → API Keys → Create key
2. Save it — you'll add it as an environment variable

---

## Step 3 — Configure the Frontend

In `public/index.html`, find these two lines near the top of the `<script>` block:

```js
const SUPABASE_URL = 'YOUR_SUPABASE_URL';
const SUPABASE_ANON_KEY = 'YOUR_SUPABASE_ANON_KEY';
```

Replace with your actual Supabase Project URL and anon key.
(The anon key is safe to expose — Supabase RLS + server-side service key handle security.)

---

## Step 4 — Deploy to Vercel

### Option A — GitHub (recommended)

1. Push this entire folder to a GitHub repo
2. Go to https://vercel.com → New Project → Import your repo
3. Framework Preset: **Other**
4. Root Directory: leave as `/` (or wherever this folder is)
5. Add Environment Variables:
   - `ANTHROPIC_API_KEY` = your Anthropic key
   - `SUPABASE_URL` = your Supabase project URL
   - `SUPABASE_SERVICE_KEY` = your Supabase **service_role** key (for server-side use)
6. Deploy

### Option B — Vercel CLI

```bash
npm i -g vercel
cd fyodor
vercel
# Follow prompts, then add env vars:
vercel env add ANTHROPIC_API_KEY
vercel env add SUPABASE_URL
vercel env add SUPABASE_SERVICE_KEY
vercel --prod
```

---

## How the 3 AI Learning Layers Work

### Layer 1 — Prompt Evolution from Ratings
Every thumbs-up/down is stored in `message_ratings`. The next time the system
prompt is built for that user, the 3 most recent thumbs-down excerpts are injected
as "what has not worked." Dostoevsky literally learns to avoid what you disliked.

### Layer 2 — Persistent Memory Injection
After every exchange, a background Claude call reads the last 2 turns and extracts
facts about the human — beliefs, doubts, emotional state, pushback. These are stored
as `user_memory` fragments and injected into every future system prompt. Dostoevsky
remembers that you're an atheist, that you lost someone, that you challenged him on
free will — and responds accordingly.

### Layer 3 — Style Drift from Engagement
After each reply, engagement is measured: explicit rating (±1) or implicit signal
(follow-up length). Five style weights per user are nudged up or down: verbosity,
theological depth, literary references, personal anecdotes, philosophical intensity.
After 3+ samples, these shape the system prompt's style instructions. The Memory
Panel (⌁ button) visualizes this as live bar charts.

---

## File Structure

```
fyodor/
├── api/
│   └── chat.js          ← Vercel serverless function (all AI + DB logic)
├── public/
│   └── index.html       ← Frontend (HTML/CSS/JS, no build step needed)
├── schema.sql           ← Run this in Supabase SQL Editor
├── package.json
├── vercel.json
└── README.md
```

---

## Security Model

- The **Anthropic API key** and **Supabase service key** live only in Vercel env vars.
  They are never sent to the browser.
- The browser uses only the Supabase **anon key** (safe to expose) for zero direct
  DB writes — all writes go through `/api/chat`.
- RLS is enabled on all tables; the service key (server-side only) bypasses it.
- Users are identified by an anonymous UUID stored in localStorage — no login needed.

---

## Local Development

```bash
npm install
npx vercel dev
```

Create a `.env.local` file:
```
ANTHROPIC_API_KEY=sk-ant-...
SUPABASE_URL=https://xxx.supabase.co
SUPABASE_SERVICE_KEY=eyJ...
```
