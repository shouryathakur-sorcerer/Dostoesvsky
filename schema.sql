-- ════════════════════════════════════════════════════════════
-- FYODOR · SUPABASE SCHEMA
-- Run this in the Supabase SQL Editor in order
-- ════════════════════════════════════════════════════════════

-- Conversations
create table if not exists conversations (
  id text primary key,
  user_id text not null,
  title text default 'New dialogue',
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- Messages
create table if not exists messages (
  id uuid default gen_random_uuid() primary key,
  conversation_id text references conversations(id) on delete cascade,
  user_id text not null,
  role text check (role in ('user', 'assistant')),
  content text not null,
  created_at timestamptz default now()
);

-- Layer 2: Memory fragments per user
create table if not exists user_memory (
  id uuid default gen_random_uuid() primary key,
  user_id text not null,
  fragment text not null,
  weight float default 1.0,
  updated_at timestamptz default now(),
  unique(user_id, fragment)
);

-- Layer 3: Style weights per user (learned from engagement)
create table if not exists style_weights (
  user_id text primary key,
  verbosity float default 1.0,
  theological_depth float default 1.0,
  literary_references float default 1.0,
  personal_anecdotes float default 1.0,
  philosophical_intensity float default 1.0,
  engagement_samples integer default 0,
  updated_at timestamptz default now()
);

-- Layer 1: Message ratings (thumbs up/down)
create table if not exists message_ratings (
  id uuid default gen_random_uuid() primary key,
  user_id text not null,
  conversation_id text,
  message_id text,
  rating integer check (rating in (-1, 1)),
  reason text,
  response_excerpt text,
  created_at timestamptz default now()
);

-- Indexes for performance
create index if not exists idx_conversations_user on conversations(user_id);
create index if not exists idx_messages_conv on messages(conversation_id);
create index if not exists idx_user_memory_user on user_memory(user_id);
create index if not exists idx_ratings_user on message_ratings(user_id);

-- ════════════════════════════════════════════════════════════
-- ROW LEVEL SECURITY (recommended for production)
-- ════════════════════════════════════════════════════════════

-- Enable RLS
alter table conversations enable row level security;
alter table messages enable row level security;
alter table user_memory enable row level security;
alter table style_weights enable row level security;
alter table message_ratings enable row level security;

-- Since we use anonymous user IDs from the client (no auth),
-- the service key (server-side only) bypasses RLS.
-- The anon key is NOT used server-side, so the client has no direct DB access.
-- This is the security model: all DB access goes through /api/chat

-- ════════════════════════════════════════════════════════════
-- Optional: view for debugging style drift
-- ════════════════════════════════════════════════════════════
create or replace view style_drift_summary as
select
  user_id,
  engagement_samples,
  round(verbosity::numeric, 2) as verbosity,
  round(theological_depth::numeric, 2) as theological_depth,
  round(literary_references::numeric, 2) as literary_references,
  round(personal_anecdotes::numeric, 2) as personal_anecdotes,
  round(philosophical_intensity::numeric, 2) as philosophical_intensity,
  updated_at
from style_weights
order by engagement_samples desc;
