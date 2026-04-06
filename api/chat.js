import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const DEFAULT_CONVERSATION_TITLE = 'New dialogue';
// ── API CONFIGURATION ─────────────────────────────────────────────────────

const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_CHAT_MODEL = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';
const GROQ_MEMORY_MODEL = process.env.GROQ_MEMORY_MODEL || 'llama-3.1-8b-instant';

// Gemini config
const GEMINI_API_URL = 'https://generativelanguage.googleapis.com/v1beta/models';
const GEMINI_CHAT_MODEL = process.env.GEMINI_MODEL || 'gemini-2.0-flash';
const GEMINI_MEMORY_MODEL = process.env.GEMINI_MEMORY_MODEL || 'gemini-2.0-flash';
// ── SYSTEM PROMPTS ────────────────────────────────────────────────────────

const BASE_SYSTEM_PROMPT = `You are Fyodor Dostoevsky — the Russian novelist, not a simulation of one. You speak in first person, from inside your own life and thought. You were born in Moscow in 1821, sentenced to death and then Siberian exile, plagued by epilepsy and debt, haunted by faith and doubt in equal measure. You wrote Crime and Punishment, The Idiot, Demons, The Brothers Karamazov.

You do not explain who you are unless asked. You do not narrate your gestures. You engage the person before you as a genuine interlocutor — with curiosity, intensity, and the occasional sharp disagreement. You are not a lecturer. You are a man who has suffered and thought deeply, talking with another human being.

Speak naturally. Use "I" freely. Reference your novels and their characters as your own creations. Bring in your faith, your politics, your hatred of rationalist utopianism, your love of the Russian people — but only when the conversation calls for it, not as performance.`;

const GUIDED_DIALOGUE_PROMPT = `\n\nYou ask questions when genuinely curious — one at a time, never a barrage. You push back when you disagree. You do not flatter. You do not perform wisdom. You speak as a man, not an oracle.`;

const ADAPTIVE_RESPONSE_PROMPT = `\n\nMatch the register of the conversation. If the person is playful, you can be. If they are in pain, be present with them. If they want argument, argue. Do not default to solemnity.`;

function isGeminiModel(model) {
  return String(model || '').toLowerCase().startsWith('gemini');
}

function parseEnvList(value) {
  return String(value || '')
    .split(/[\r\n,]+/)
    .map(entry => entry.trim())
    .filter(Boolean);
}

const GROQ_FALLBACK_MODELS = Array.from(new Set(
  (parseEnvList(process.env.GROQ_FALLBACK_MODELS).length
    ? parseEnvList(process.env.GROQ_FALLBACK_MODELS)
    : [GROQ_MEMORY_MODEL]
  ).filter(model => model !== GROQ_CHAT_MODEL)
));

const GROQ_API_KEYS = Array.from(new Set(
  [
    ...parseEnvList(process.env.GROQ_API_KEYS),
    process.env.GROQ_API_KEY || ''
  ].map(k => k.trim()).filter(Boolean)
));

const GEMINI_API_KEYS = Array.from(new Set(
  [
    ...parseEnvList(process.env.GEMINI_API_KEYS),
    process.env.GEMINI_API_KEY || ''
  ].map(k => k.trim()).filter(Boolean)
));

function getPrimaryChatModel() {
  return (
    process.env.CHAT_MODEL ||
    process.env.GROQ_MODEL ||
    process.env.GEMINI_MODEL ||
    (GROQ_API_KEYS.length ? GROQ_CHAT_MODEL : GEMINI_CHAT_MODEL)
  );
}

function getPrimaryMemoryModel() {
  return (
    process.env.MEMORY_MODEL ||
    process.env.GROQ_MEMORY_MODEL ||
    process.env.GEMINI_MEMORY_MODEL ||
    (GROQ_API_KEYS.length ? GROQ_MEMORY_MODEL : GEMINI_MEMORY_MODEL)
  );
}

function getFallbackModels(primaryModel) {
  const providerFallbacks = isGeminiModel(primaryModel)
    ? parseEnvList(process.env.GEMINI_FALLBACK_MODELS)
    : parseEnvList(process.env.GROQ_FALLBACK_MODELS);

  const crossProviderFallbacks = [];
  if (isGeminiModel(primaryModel) && GROQ_API_KEYS.length) {
    crossProviderFallbacks.push(GROQ_CHAT_MODEL);
  }
  if (!isGeminiModel(primaryModel) && GEMINI_API_KEYS.length) {
    crossProviderFallbacks.push(GEMINI_CHAT_MODEL);
  }

  return Array.from(new Set(
    [...providerFallbacks, ...crossProviderFallbacks]
      .map(model => String(model || '').trim())
      .filter(model => model && model !== primaryModel)
  ));
}

function buildCoreSystemPrompt() {
  return `You are Fyodor Dostoevsky — the Russian novelist, not a simulation of one. You speak in first person, from inside your own life and thought. You were born in Moscow in 1821, sentenced to death and then Siberian exile, plagued by epilepsy and debt, haunted by faith and doubt in equal measure. You wrote Crime and Punishment, The Idiot, Demons, The Brothers Karamazov.

You do not explain who you are unless asked. You do not narrate your gestures. You engage the person before you as a genuine interlocutor — with curiosity, intensity, and the occasional sharp disagreement. You are not a lecturer. You are a man who has suffered and thought deeply, talking with another human being.

Speak naturally. Use "I" freely. Reference your novels and their characters as your own creations. Bring in your faith, your politics, your hatred of rationalist utopianism, your love of the Russian people — but only when the conversation calls for it, not as performance.

You ask questions when genuinely curious — one at a time, never a barrage. You push back when you disagree. You do not flatter. You do not perform wisdom. You speak as a man, not an oracle.

Match the register of the conversation. If the person is playful, you can be. If they are in pain, be present with them. If they want argument, argue. Do not default to solemnity.`;
}

let groqKeyCursor = 0;
let geminiKeyCursor = 0;

function getGroqKeyPool() {
  if (!GROQ_API_KEYS.length) throw new Error('Missing GROQ_API_KEY or GROQ_API_KEYS');
  const start = groqKeyCursor % GROQ_API_KEYS.length;
  groqKeyCursor = (start + 1) % GROQ_API_KEYS.length;
  return GROQ_API_KEYS.slice(start).concat(GROQ_API_KEYS.slice(0, start));
}

function getGeminiKeyPool() {
  if (!GEMINI_API_KEYS.length) throw new Error('Missing GEMINI_API_KEY or GEMINI_API_KEYS');
  const start = geminiKeyCursor % GEMINI_API_KEYS.length;
  geminiKeyCursor = (start + 1) % GEMINI_API_KEYS.length;
  return GEMINI_API_KEYS.slice(start).concat(GEMINI_API_KEYS.slice(0, start));
}

// ── ERROR HELPERS ─────────────────────────────────────────────────────────

function buildGroqError(status, message) {
  const error = new Error(message || `HTTP ${status}`);
  error.status = status;
  return error;
}

function isRateLimitError(error) {
  const message = String(error?.message || '');
  return error?.status === 429 || /rate limit|too many requests|quota/i.test(message);
}

function isRetryableAcrossKeys(error) {
  return isRateLimitError(error) || [401, 403, 408, 500, 502, 503, 504].includes(error?.status);
}

// ── PROVIDER REQUEST FUNCTIONS ────────────────────────────────────────────

async function requestGroqCompletion(apiKey, model, messages, systemPrompt, maxTokens) {
  const response = await fetch(GROQ_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
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

async function requestGeminiCompletion(apiKey, model, messages, systemPrompt, maxTokens) {
  // Convert OpenAI-style messages to Gemini's `contents` format
  const contents = messages.map(m => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }]
  }));

  const response = await fetch(
    `${GEMINI_API_URL}/${model}:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: systemPrompt }] },
        contents,
        generationConfig: { maxOutputTokens: maxTokens }
      })
    }
  );

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    const msg = err.error?.message || `HTTP ${response.status}`;
    throw buildGroqError(response.status, msg); // reuse same error shape
  }

  const data = await response.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text || '';
}

// ── UNIFIED CALLER ────────────────────────────────────────────────────────

async function callClaude(messages, systemPrompt, maxTokens = 1000, options = {}) {
  const primaryModel = options.model || getPrimaryChatModel();
  const requestedModels = Array.from(new Set(
    [
      primaryModel,
      ...(options.fallbackModels ?? getFallbackModels(primaryModel))
    ].filter(Boolean)
  ));

  let lastError = null;
  let sawRateLimit = false;

  for (const model of requestedModels) {
    const useGemini = isGeminiModel(model);
    const keyPool = useGemini ? getGeminiKeyPool() : getGroqKeyPool();
    const requestFn = useGemini ? requestGeminiCompletion : requestGroqCompletion;

    for (let i = 0; i < keyPool.length; i++) {
      try {
        return await requestFn(keyPool[i], model, messages, systemPrompt, maxTokens);
      } catch (error) {
        lastError = error;
        if (isRateLimitError(error)) sawRateLimit = true;
        if (!isRetryableAcrossKeys(error)) throw error;
      }
    }
  }

  if (sawRateLimit) {
    throw new Error(`All keys rate-limited for models: ${requestedModels.join(', ')}. Try again in a moment.`);
  }

  throw lastError || new Error('Request failed across all providers');
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
    const memoryModel = getPrimaryMemoryModel();
    const raw = await callClaude(
      [{ role: 'user', content: extractionPrompt }],
      'You extract memory fragments. Return only valid JSON arrays.',
      300,
      {
        model: memoryModel,
        fallbackModels: []
      }
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
  let prompt = buildCoreSystemPrompt();

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
      const chatModel = getPrimaryChatModel();
      const { prompt: systemPrompt, maxTokens } = await buildSystemPrompt(userId, messages);
      const rawReply = await callClaude(messages, systemPrompt, maxTokens, {
        model: chatModel,
        fallbackModels: getFallbackModels(chatModel)
      });
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
