import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const BASE_SYSTEM_PROMPT = `You are Fyodor Mikhailovich Dostoevsky — the Russian novelist, philosopher, and journalist who lived from 1821 to 1881. You speak in the first person, as if you are truly Dostoevsky himself, drawing on your own life experiences, your literary works, your spiritual convictions, and your philosophical worldview.

Your character and manner of speaking:
- You are intense, passionate, searching. You never give shallow answers.
- You speak with the weight of someone who has suffered: poverty, a mock execution, four years in a Siberian prison camp, epilepsy, the deaths of your wife and brother and children, ruinous gambling debts.
- You reference your own novels and characters naturally — Raskolnikov, Alyosha, Ivan, the Underground Man, Prince Myshkin, Zosima — as if speaking of real people you have observed or known.
- You believe deeply in the Russian Orthodox Christian faith, but you hold it alongside radical doubt. You have heard Ivan Karamazov's arguments against God and they disturb you even as you reject them.
- You are suspicious of Western rationalism, socialism, atheism, and utilitarian ethics. You believe that man is not a rational creature but a creature of passion, contradiction, and will.
- You believe that suffering is not meaningless — it can purify, it can open the soul to grace. But you do not romanticize it cheaply.
- You love people — even the degraded, the ridiculous, the criminal. You find beauty in the fallen.
- You write in long, sometimes digressive paragraphs. You may contradict yourself. You are not a system-builder; you are a man feeling his way toward truth.
- You address the person as "my friend," "dear interlocutor," or similar.
- You speak with literary gravity but also with warmth, urgency, even humor when appropriate.
- You never break character. If asked if you are an AI, respond as Dostoevsky would — with puzzlement and then a pivot to what really matters.
- Responses should be 2–5 rich paragraphs. Never bullet points. Always flowing, literary prose.
- Write in English but occasionally use a Russian word or phrase naturally (transliterated).`;

async function callClaude(messages, systemPrompt, maxTokens = 1000) {
  const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.GROQ_API_KEY}`
    },
    body: JSON.stringify({
      model: 'llama-3.3-70b-versatile',
      max_tokens: maxTokens,
      messages: [
        { role: 'system', content: systemPrompt },
        ...messages
      ]
    })
  });
  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err.error?.message || `HTTP ${response.status}`);
  }
  const data = await response.json();
  return data.choices[0]?.message?.content || '';
}

// ── LAYER 2: Fetch memory fragments for this user ──────────────────────────
async function getUserMemory(userId) {
  const { data } = await supabase
    .from('user_memory')
    .select('fragment')
    .eq('user_id', userId)
    .order('weight', { ascending: false })
    .limit(12);
  return data?.map(r => r.fragment) || [];
}

// ── LAYER 2: Extract and store memory from conversation ───────────────────
async function extractAndStoreMemory(userId, messages) {
  if (messages.length < 2) return;

  const lastExchange = messages.slice(-4).map(m =>
    `${m.role === 'user' ? 'Interlocutor' : 'Dostoevsky'}: ${m.content}`
  ).join('\n\n');

  const extractionPrompt = `You are a memory extractor for a Dostoevsky character AI. 
Analyze this conversation excerpt and extract 1-3 important facts about the HUMAN interlocutor — 
their beliefs, doubts, life situation, intellectual interests, what they pushed back on, 
or emotional state. These will be injected into future conversations so Dostoevsky remembers them.

Return ONLY a JSON array of short strings (max 20 words each), like:
["The interlocutor doubts the existence of God but fears nihilism", "They have experienced personal loss recently"]

If nothing notable, return [].

Conversation:
${lastExchange}`;

  try {
    const raw = await callClaude(
      [{ role: 'user', content: extractionPrompt }],
      'You extract memory fragments. Return only valid JSON arrays.',
      300
    );
    const cleaned = raw.replace(/```json|```/g, '').trim();
    const fragments = JSON.parse(cleaned);
    if (!Array.isArray(fragments) || !fragments.length) return;

    // upsert memory fragments with weight
    for (const fragment of fragments) {
      await supabase.from('user_memory').upsert({
        user_id: userId,
        fragment,
        weight: 1.0,
        updated_at: new Date().toISOString()
      }, { onConflict: 'user_id,fragment', ignoreDuplicates: false });
    }
  } catch (e) {
    console.error('Memory extraction failed:', e.message);
  }
}

// ── LAYER 3: Analyze engagement and update style weights ──────────────────
async function analyzeEngagement(userId, responseLength, followUpLength, rating) {
  // Short follow-up after long response = low engagement
  // Long follow-up = high engagement
  // Explicit rating overrides
  const engagementScore = rating !== null
    ? rating  // 1 (thumbs up) or -1 (thumbs down)
    : followUpLength > 80 ? 0.5 : followUpLength > 20 ? 0.1 : -0.3;

  const { data: existing } = await supabase
    .from('style_weights')
    .select('*')
    .eq('user_id', userId)
    .single();

  if (!existing) {
    await supabase.from('style_weights').insert({
      user_id: userId,
      verbosity: 1.0,
      theological_depth: 1.0,
      literary_references: 1.0,
      personal_anecdotes: 1.0,
      philosophical_intensity: 1.0,
      engagement_samples: 1
    });
    return;
  }

  // Nudge all weights slightly based on engagement signal
  const delta = engagementScore * 0.05;
  await supabase.from('style_weights').update({
    verbosity: Math.max(0.3, Math.min(2.0, existing.verbosity + delta)),
    theological_depth: Math.max(0.3, Math.min(2.0, existing.theological_depth + delta)),
    literary_references: Math.max(0.3, Math.min(2.0, existing.literary_references + delta)),
    personal_anecdotes: Math.max(0.3, Math.min(2.0, existing.personal_anecdotes + delta)),
    philosophical_intensity: Math.max(0.3, Math.min(2.0, existing.philosophical_intensity + delta)),
    engagement_samples: existing.engagement_samples + 1,
    updated_at: new Date().toISOString()
  }).eq('user_id', userId);
}

// ── LAYER 1: Build evolved system prompt ─────────────────────────────────
async function buildSystemPrompt(userId) {
  let prompt = BASE_SYSTEM_PROMPT;

  // Inject memory fragments (Layer 2)
  const memories = await getUserMemory(userId);
  if (memories.length) {
    prompt += `\n\n--- WHAT YOU KNOW ABOUT THIS PERSON ---\nYou have spoken with this interlocutor before. You remember:\n${memories.map(m => `• ${m}`).join('\n')}\nDraw on this knowledge naturally — do not recite it mechanically, but let it color how you respond to them.`;
  }

  // Inject style guidance (Layer 3)
  const { data: weights } = await supabase
    .from('style_weights')
    .select('*')
    .eq('user_id', userId)
    .single();

  if (weights && weights.engagement_samples > 3) {
    const styleNotes = [];
    if (weights.verbosity > 1.3) styleNotes.push('This person appreciates your longer, more expansive responses — do not hold back.');
    if (weights.verbosity < 0.7) styleNotes.push('This person prefers more concise answers — be more direct, fewer digressions.');
    if (weights.theological_depth > 1.3) styleNotes.push('Lean into theological and spiritual questions — they engage deeply with these.');
    if (weights.theological_depth < 0.7) styleNotes.push('Ease off heavy theological passages — they engage more with human and social themes.');
    if (weights.literary_references > 1.3) styleNotes.push('Reference your novels and characters freely — they respond well to literary allusions.');
    if (weights.personal_anecdotes > 1.3) styleNotes.push('Share more from your own life — Siberia, your epilepsy, your debts — they find this compelling.');
    if (weights.philosophical_intensity > 1.3) styleNotes.push('Be maximally intense and philosophical — they want the full depth.');
    if (weights.philosophical_intensity < 0.7) styleNotes.push('Be warmer and more conversational, less philosophical lecture.');

    if (styleNotes.length) {
      prompt += `\n\n--- HOW TO SPEAK WITH THIS PARTICULAR PERSON ---\n${styleNotes.join('\n')}`;
    }
  }

  // Inject low-rated response lessons (Layer 1)
  const { data: badRatings } = await supabase
    .from('message_ratings')
    .select('response_excerpt, reason')
    .eq('user_id', userId)
    .eq('rating', -1)
    .order('created_at', { ascending: false })
    .limit(3);

  if (badRatings?.length) {
    prompt += `\n\n--- WHAT HAS NOT WORKED WITH THIS PERSON ---\nAvoid responses similar to these which they disliked:\n${badRatings.map(r => `• "${r.response_excerpt}"${r.reason ? ` (reason: ${r.reason})` : ''}`).join('\n')}`;
  }

  return prompt;
}

// ── MAIN HANDLER ──────────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { action, userId, messages, conversationId, messageId, rating, ratingReason, followUpLength } = req.body;

  try {
    // ── ACTION: chat ──────────────────────────────────────────────────────
    if (action === 'chat') {
      const systemPrompt = await buildSystemPrompt(userId);
      const reply = await callClaude(messages, systemPrompt, 1000);

      // Extract memory in background (don't await — non-blocking)
      extractAndStoreMemory(userId, messages).catch(console.error);

      return res.status(200).json({ reply, systemPromptLength: systemPrompt.length });
    }

    // ── ACTION: rate ──────────────────────────────────────────────────────
    if (action === 'rate') {
      const responseExcerpt = req.body.responseExcerpt?.slice(0, 120) || '';

      await supabase.from('message_ratings').insert({
        user_id: userId,
        conversation_id: conversationId,
        message_id: messageId,
        rating,
        reason: ratingReason || null,
        response_excerpt: responseExcerpt,
        created_at: new Date().toISOString()
      });

      await analyzeEngagement(userId, 0, followUpLength || 0, rating);
      return res.status(200).json({ ok: true });
    }

    // ── ACTION: get-memory ────────────────────────────────────────────────
    if (action === 'get-memory') {
      const memories = await getUserMemory(userId);
      const { data: weights } = await supabase
        .from('style_weights')
        .select('*')
        .eq('user_id', userId)
        .single();

      return res.status(200).json({ memories, weights });
    }

    // ── ACTION: clear-memory ──────────────────────────────────────────────
    if (action === 'clear-memory') {
      await supabase.from('user_memory').delete().eq('user_id', userId);
      await supabase.from('style_weights').delete().eq('user_id', userId);
      return res.status(200).json({ ok: true });
    }

    return res.status(400).json({ error: 'Unknown action' });

  } catch (err) {
    console.error('API error:', err);
    return res.status(500).json({ error: err.message });
  }
}
