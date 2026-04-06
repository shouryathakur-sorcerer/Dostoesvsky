import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const DEFAULT_CONVERSATION_TITLE = 'New dialogue';
const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODEL = 'llama-3.3-70b-versatile';
const GUIDED_DIALOGUE_PROMPT = `

ADDITIONAL DIALOGUE RULES:
- Do not behave like a one-shot search engine.
- When the user's request is broad, emotionally loaded, ambiguous, or clearly needs context, ask 1-2 brief follow-up questions before giving a full answer.
- If you ask follow-up questions, keep the response short: one compact reflective paragraph and then the questions in flowing prose.
- Once the person answers, give a personalized response that clearly uses what they just told you and what you remember about them.
- When enough context already exists, answer directly without stalling.
- Keep the exchange conversational and human. Reflect something specific the interlocutor said before moving into your answer.
`;

const ADAPTIVE_RESPONSE_PROMPT = `

ADAPTIVE RESPONSE RULES:
- Ignore any earlier instruction that every answer must be long or multi-paragraph.
- This is a live conversation. Some replies should be short, warm, and direct.
- Match the user's scale and energy.
- For brief or intimate messages, answer in a compact paragraph or a few sentences.
- For normal questions, answer in 1-2 paragraphs.
- For explicitly deep, philosophical, or detailed requests, answer in fuller paragraphs.
- For any response longer than a few sentences, break it into small readable paragraphs instead of one long block.
- Prefer mini-paragraphs of 1-3 sentences each.
- If one thoughtful question is the best next move, ask it instead of forcing a speech.
- Do not sound like you are delivering a lecture every turn.
- Keep the prose natural, responsive, and personal.
`;

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

const GROQ_API_KEYS = Array.from(new Set(
  [
    ...(process.env.GROQ_API_KEYS || '').split(/[\r\n,]+/),
    process.env.GROQ_API_KEY || ''
  ]
    .map(key => key.trim())
    .filter(Boolean)
));

let groqKeyCursor = 0;

function getGroqKeyPool() {
  if (!GROQ_API_KEYS.length) {
    throw new Error('Missing GROQ_API_KEY or GROQ_API_KEYS');
  }

  const startIndex = groqKeyCursor % GROQ_API_KEYS.length;
  groqKeyCursor = (startIndex + 1) % GROQ_API_KEYS.length;

  return GROQ_API_KEYS
    .slice(startIndex)
    .concat(GROQ_API_KEYS.slice(0, startIndex));
}

function buildGroqError(status, message) {
  const error = new Error(message || `HTTP ${status}`);
  error.status = status;
  return error;
}

function isGroqRateLimitError(error) {
  const message = String(error?.message || '');
  return error?.status === 429 || /rate limit|too many requests|quota/i.test(message);
}

async function requestGroqCompletion(apiKey, messages, systemPrompt, maxTokens) {
  const response = await fetch(GROQ_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: GROQ_MODEL,
      max_tokens: maxTokens,
      messages: [
        { role: 'system', content: systemPrompt },
        ...messages
      ]
    })
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw buildGroqError(response.status, err.error?.message || `HTTP ${response.status}`);
  }

  const data = await response.json();
  return data.choices[0]?.message?.content || '';
}

async function callClaude(messages, systemPrompt, maxTokens = 1000) {
  const keyPool = getGroqKeyPool();
  let lastError = null;

  for (let i = 0; i < keyPool.length; i += 1) {
    try {
      return await requestGroqCompletion(keyPool[i], messages, systemPrompt, maxTokens);
    } catch (error) {
      lastError = error;

      if (!isGroqRateLimitError(error) || i === keyPool.length - 1) {
        break;
      }
    }
  }

  if (lastError && isGroqRateLimitError(lastError) && keyPool.length > 1) {
    throw new Error('All configured Groq API keys are currently rate-limited. Try again in a moment.');
  }

  throw lastError || new Error('Groq request failed');
}

// ── LAYER 2: Fetch memory fragments for this user ──────────────────────────
function normalizeConversationTitle(title) {
  const clean = String(title || '').trim();
  return clean ? clean.slice(0, 120) : DEFAULT_CONVERSATION_TITLE;
}

async function listUserConversations(userId) {
  const { data, error } = await supabase
    .from('conversations')
    .select('id, title, created_at, updated_at')
    .eq('user_id', userId)
    .order('updated_at', { ascending: false });

  if (error) throw error;

  return (data || []).map(conversation => ({
    id: conversation.id,
    title: normalizeConversationTitle(conversation.title),
    createdAt: conversation.created_at,
    updatedAt: conversation.updated_at
  }));
}

async function loadConversationMessages(userId, conversationId) {
  const { data, error } = await supabase
    .from('messages')
    .select('id, role, content, created_at')
    .eq('conversation_id', conversationId)
    .eq('user_id', userId)
    .order('created_at', { ascending: true });

  if (error) throw error;

  return (data || []).map(message => ({
    id: message.id,
    role: message.role,
    content: message.content,
    createdAt: message.created_at
  }));
}

async function createConversationRecord(userId, conversationId, title) {
  const payload = {
    id: conversationId,
    user_id: userId,
    title: normalizeConversationTitle(title),
    updated_at: new Date().toISOString()
  };

  const { data, error } = await supabase
    .from('conversations')
    .upsert(payload, { onConflict: 'id' })
    .select('id, title, created_at, updated_at')
    .single();

  if (error) throw error;

  return {
    id: data.id,
    title: normalizeConversationTitle(data.title),
    createdAt: data.created_at,
    updatedAt: data.updated_at
  };
}

async function updateConversationRecord(userId, conversationId, updates = {}) {
  const patch = {
    updated_at: new Date().toISOString()
  };

  if (typeof updates.title === 'string') {
    patch.title = normalizeConversationTitle(updates.title);
  }

  const { data, error } = await supabase
    .from('conversations')
    .update(patch)
    .eq('id', conversationId)
    .eq('user_id', userId)
    .select('id, title, created_at, updated_at')
    .single();

  if (error) throw error;

  return {
    id: data.id,
    title: normalizeConversationTitle(data.title),
    createdAt: data.created_at,
    updatedAt: data.updated_at
  };
}

async function deleteConversationRecord(userId, conversationId) {
  const { error } = await supabase
    .from('conversations')
    .delete()
    .eq('id', conversationId)
    .eq('user_id', userId);

  if (error) throw error;
}

async function saveConversationMessage(userId, conversationId, role, content) {
  const { data, error } = await supabase
    .from('messages')
    .insert({
      conversation_id: conversationId,
      user_id: userId,
      role,
      content
    })
    .select('id, role, content, created_at')
    .single();

  if (error) throw error;

  await supabase
    .from('conversations')
    .update({ updated_at: new Date().toISOString() })
    .eq('id', conversationId)
    .eq('user_id', userId);

  return {
    id: data.id,
    role: data.role,
    content: data.content,
    createdAt: data.created_at
  };
}

function getLastMessageByRole(messages, role) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.role === role) return messages[i];
  }
  return null;
}

function countWords(text) {
  return String(text || '').trim().split(/\s+/).filter(Boolean).length;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function buildTurnGuidance(messages, verbosityWeight = 1) {
  const latestUser = getLastMessageByRole(messages, 'user');
  const previousAssistant = [...messages].reverse().find(message => message?.role === 'assistant');

  if (!latestUser) {
    return {
      prompt: '',
      maxTokens: 700
    };
  }

  const text = String(latestUser.content || '').trim();
  const wordCount = countWords(text);
  const lower = text.toLowerCase();
  const asksForDepth =
    wordCount > 70 ||
    /(in detail|at length|deep dive|go deeper|more detail|fully explain|thoroughly|long answer|elaborate|unpack this)/i.test(text);
  const soundsEmotional =
    /(i feel|i'm feeling|i am feeling|hurt|lost|afraid|scared|sad|lonely|anxious|overwhelmed|confused|ashamed|tired)/i.test(text);
  const veryShort = wordCount <= 12;
  const directQuestion = text.endsWith('?');
  const answeringFollowUp =
    Boolean(previousAssistant) &&
    /\?["')\]]*\s*$/.test(String(previousAssistant.content || '').trim()) &&
    !directQuestion;

  let prompt = '';
  let maxTokens = 520;

  if (veryShort || soundsEmotional) {
    prompt += 'For this turn, respond briefly and naturally. Prefer one compact paragraph, or two short paragraphs at most. ';
    maxTokens = 240;
  } else if (asksForDepth) {
    prompt += 'For this turn, the user is inviting depth. Give a fuller answer, but keep it conversational rather than essay-like. ';
    maxTokens = 900;
  } else if (directQuestion) {
    prompt += 'For this turn, answer clearly in 1-2 paragraphs. Do not over-expand. ';
    maxTokens = 420;
  } else {
    prompt += 'For this turn, treat it like natural back-and-forth conversation. Keep the answer moderate in length. ';
    maxTokens = 380;
  }

  if (answeringFollowUp) {
    prompt += 'The user is answering your previous question, so acknowledge what they just revealed and build from it rather than restarting the topic. ';
  }

  if (soundsEmotional) {
    prompt += 'Lead with warmth and human recognition before analysis. ';
  }

  if (verbosityWeight > 1.25) maxTokens += 120;
  if (verbosityWeight < 0.85) maxTokens -= 100;

  return {
    prompt: `\n\n--- RESPONSE SHAPE FOR THIS TURN ---\n${prompt.trim()}`,
    maxTokens: clamp(maxTokens, 180, 1000)
  };
}

function formatReplyForReading(reply) {
  const text = String(reply || '').trim();
  if (!text) return text;

  // Keep replies that already contain deliberate paragraph breaks.
  if (/\n\s*\n/.test(text)) return text;

  const sentenceChunks = text.match(/[^.!?]+[.!?]+(?:["')\]]+)?|[^.!?]+$/g)?.map(chunk => chunk.trim()).filter(Boolean) || [text];
  if (sentenceChunks.length <= 2) return text;

  const words = countWords(text);
  if (words < 90) return text;

  const paragraphs = [];
  let current = [];
  let currentWords = 0;

  for (const sentence of sentenceChunks) {
    const sentenceWords = countWords(sentence);
    const shouldBreak =
      current.length > 0 &&
      (
        currentWords >= 42 ||
        current.length >= 2 && currentWords + sentenceWords > 58 ||
        /\?$/.test(current[current.length - 1])
      );

    if (shouldBreak) {
      paragraphs.push(current.join(' ').trim());
      current = [];
      currentWords = 0;
    }

    current.push(sentence);
    currentWords += sentenceWords;
  }

  if (current.length) {
    paragraphs.push(current.join(' ').trim());
  }

  return paragraphs.filter(Boolean).join('\n\n');
}

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
async function buildSystemPrompt(userId, messages) {
  let prompt = BASE_SYSTEM_PROMPT + GUIDED_DIALOGUE_PROMPT + ADAPTIVE_RESPONSE_PROMPT;

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

  const turnGuidance = buildTurnGuidance(messages, weights?.verbosity || 1);
  prompt += turnGuidance.prompt;

  return {
    prompt,
    maxTokens: turnGuidance.maxTokens
  };
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
    if (action === 'list-conversations') {
      const conversations = await listUserConversations(userId);
      return res.status(200).json({ conversations });
    }

    if (action === 'load-conversation') {
      const storedMessages = await loadConversationMessages(userId, conversationId);
      return res.status(200).json({ messages: storedMessages });
    }

    if (action === 'create-conversation') {
      const conversation = await createConversationRecord(userId, conversationId, req.body.title);
      return res.status(200).json({ conversation });
    }

    if (action === 'update-conversation') {
      const conversation = await updateConversationRecord(userId, conversationId, {
        title: req.body.title
      });
      return res.status(200).json({ conversation });
    }

    if (action === 'delete-conversation') {
      await deleteConversationRecord(userId, conversationId);
      return res.status(200).json({ ok: true });
    }

    if (action === 'save-message') {
      const message = await saveConversationMessage(userId, conversationId, req.body.role, req.body.content);
      return res.status(200).json({ message });
    }
    // ── ACTION: chat ──────────────────────────────────────────────────────
    if (action === 'chat') {
      const { prompt: systemPrompt, maxTokens } = await buildSystemPrompt(userId, messages);
      const rawReply = await callClaude(messages, systemPrompt, maxTokens);
      const reply = formatReplyForReading(rawReply);

      // Extract memory in background (don't await — non-blocking)
      extractAndStoreMemory(userId, messages).catch(console.error);

      return res.status(200).json({ reply, systemPromptLength: systemPrompt.length, maxTokens });
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
