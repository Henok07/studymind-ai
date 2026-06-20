const { GoogleGenAI } = require('@google/genai');
const ChatHistory = require('../models/ChatHistory');
const fs   = require('fs');
const path = require('path');

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const MODEL = 'gemini-2.5-flash';

// Retries a Gemini API call when it fails with a transient overload error
// (HTTP 503 / status UNAVAILABLE), using short exponential backoff. Does
// not change what is sent or how the response is parsed — only retries
// the call itself when the model is temporarily overloaded.
async function callWithRetry(fn, { retries = 3, baseDelayMs = 800 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const message = (err && err.message) || '';
      const isOverloaded =
        message.includes('UNAVAILABLE') ||
        message.includes('503') ||
        message.includes('overloaded') ||
        message.includes('high demand');

      if (!isOverloaded || attempt === retries) throw err;

      const delay = baseDelayMs * Math.pow(2, attempt); // 800ms, 1600ms, 3200ms…
      console.warn(`Gemini overloaded, retrying in ${delay}ms (attempt ${attempt + 1}/${retries})…`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  throw lastErr;
}

// Converts a raw SDK error (which may be a dense JSON blob) into a short,
// human-readable message for the chat UI. Falls back to the original
// message for anything that isn't a recognized overload error.
function friendlyErrorMessage(err) {
  const message = (err && err.message) || 'AI generation failed.';
  if (message.includes('UNAVAILABLE') || message.includes('503') || message.includes('high demand')) {
    return 'The AI model is temporarily overloaded with requests. Please wait a moment and try again.';
  }
  return message;
}

// In-memory cache of extracted PDF text, keyed by documentId, so we don't
// re-parse the same file on every chat message. Cleared on server restart.
const documentTextCache = new Map();

// Extract full text from the PDF on disk (used for "global file awareness").
async function getDocumentFullText(document) {
  const cacheKey = document._id.toString();
  if (documentTextCache.has(cacheKey)) return documentTextCache.get(cacheKey);

  try {
    const pdfParse = require('pdf-parse');
    const filePath = path.join(__dirname, '../public', document.fileUrl);
    const buffer    = fs.readFileSync(filePath);
    const data      = await pdfParse(buffer);

    // Cap to a safe context size to avoid oversized prompts
    const MAX_CHARS = 60000;
    const fullText  = data.text.length > MAX_CHARS
      ? data.text.slice(0, MAX_CHARS) + '\n…[truncated]'
      : data.text;

    documentTextCache.set(cacheKey, fullText);
    return fullText;
  } catch (err) {
    console.error('PDF text extraction error:', err);
    return '';
  }
}

// ─── EXPLAIN / SUMMARIZE  (Server-Sent Events streaming) ─────────────────────
exports.explainText = async (req, res) => {
  const { text, documentId, mode } = req.body;
  const userId = req.session.userId;

  if (!text || !documentId) {
    return res.status(400).json({ error: 'Text and documentId are required.' });
  }

  const wordCount = text.trim().split(/\s+/).length;
  const isLong   = wordCount >= 1000;

  const prompt = isLong
    ? `You are a scholarly study assistant. Summarise the following section clearly and concisely. Use headings and bullet points.\n\n---\n${text}`
    : `You are a patient expert tutor. Explain the following concept to a student using simple language, analogies, and examples.\n\n---\n${text}`;

  // SSE headers
  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // disable nginx buffering if present
  res.flushHeaders();

  // Helper: write an SSE event and flush immediately
  const send = (obj) => {
    res.write(`data: ${JSON.stringify(obj)}\n\n`);
    if (typeof res.flush === 'function') res.flush();
  };

  let fullResponse = '';

  try {
    // generateContentStream returns an async iterable directly.
    // Only the *initiation* of the stream is retried — once chunks start
    // flowing to the client the SSE connection is already committed.
    const stream = await callWithRetry(() =>
      ai.models.generateContentStream({
        model: MODEL,
        contents: prompt,          // string shorthand works fine
      })
    );

    for await (const chunk of stream) {
      // .text is a getter, NOT a method — do NOT call chunk.text()
      const piece = chunk.text;
      if (piece) {
        fullResponse += piece;
        send({ chunk: piece });
      }
    }

    send({ done: true });
    res.end();

    // Persist to ChatHistory (fire-and-forget)
    saveChatMessage(documentId, userId, text, fullResponse, isLong ? 'summarize' : 'explain')
      .catch(err => console.error('ChatHistory save error:', err));

  } catch (err) {
    console.error('Streaming error:', err);
    send({ error: friendlyErrorMessage(err) });
    res.end();
  }
};

// ─── CONTINUOUS CHAT  (multi-turn, document-aware, SSE streaming) ────────────
// Separate endpoint from explainText — does not alter the Explain/Summarize flow.
exports.chatMessage = async (req, res) => {
  const { message, documentId, highlightedContext } = req.body;
  const userId = req.session.userId;

  if (!message || !documentId) {
    return res.status(400).json({ error: 'Message and documentId are required.' });
  }

  // SSE headers (identical pattern to explainText)
  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const send = (obj) => {
    res.write(`data: ${JSON.stringify(obj)}\n\n`);
    if (typeof res.flush === 'function') res.flush();
  };

  try {
    const Document = require('../models/Document');
    const document = await Document.findOne({ _id: documentId, userId });
    if (!document) {
      send({ error: 'Document not found.' });
      return res.end();
    }

    // Pull prior turns so the model has conversational memory
    const history = await ChatHistory.findOne({ documentId, userId });
    const recentTurns = history ? history.messages.slice(-10) : [];
    const conversationLog = recentTurns
      .map(m => `${m.sender === 'user' ? 'Student' : 'Tutor'}: ${m.text}`)
      .join('\n');

    let contextBlock;
    if (highlightedContext && highlightedContext.trim().length > 0) {
      // CONTEXTUAL AWARENESS: a snippet was highlighted earlier in this
      // session — keep answering relative to that snippet.
      contextBlock = `The student previously highlighted this passage from the document:\n"""\n${highlightedContext}\n"""`;
    } else {
      // GLOBAL FILE AWARENESS: no active highlight — fall back to the
      // full extracted document text so general questions can be answered.
      const fullText = await getDocumentFullText(document);
      contextBlock = `The student is asking a general question about the full document titled "${document.title}". Use the following extracted document content as your knowledge source:\n"""\n${fullText}\n"""`;
    }

    const prompt = `You are a patient, expert tutor having an ongoing conversation with a student about a study document.

${contextBlock}

${conversationLog ? `Conversation so far:\n${conversationLog}\n` : ''}
Student: ${message}

Reply directly and helpfully as the Tutor. Use clear Markdown formatting (headings, bold, bullet points) where useful. Do not include any internal reasoning, planning notes, or <think> tags in your reply — output only the final clean answer.`;

    let fullResponse = '';

    const stream = await callWithRetry(() =>
      ai.models.generateContentStream({
        model: MODEL,
        contents: prompt,
      })
    );

    for await (const chunk of stream) {
      const piece = chunk.text;
      if (piece) {
        fullResponse += piece;
        send({ chunk: piece });
      }
    }

    send({ done: true });
    res.end();

    saveChatMessage(documentId, userId, message, fullResponse, 'chat')
      .catch(err => console.error('ChatHistory save error:', err));

  } catch (err) {
    console.error('Chat message error:', err);
    send({ error: friendlyErrorMessage(err) });
    res.end();
  }
};

// ─── GENERATE QUIZ  (structured JSON) ────────────────────────────────────────
exports.generateQuiz = async (req, res) => {
  const { text, documentId, mode } = req.body;

  if (!text || !documentId) {
    return res.status(400).json({ error: 'Text and documentId are required.' });
  }

  const isLong = text.trim().split(/\s+/).length >= 1000;
  const count  = isLong ? 10 : 5;

  const prompt = `You are an expert exam writer. Generate exactly ${count} multiple-choice questions from the study material below.
Return ONLY a raw JSON array — no markdown, no code fences, no explanation.

Each object must have:
- "question": string
- "options": array of exactly 4 strings
- "correctAnswer": string (must exactly match one of the options)
- "explanation": string

Study material:
---
${text}`;

  try {
    const response = await callWithRetry(() =>
      ai.models.generateContent({
        model: MODEL,
        contents: prompt,
        config: {
          responseMimeType: 'application/json',
          responseSchema: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                question:      { type: 'string' },
                options:       { type: 'array', items: { type: 'string' } },
                correctAnswer: { type: 'string' },
                explanation:   { type: 'string' },
              },
              required: ['question', 'options', 'correctAnswer', 'explanation'],
            },
          },
        },
      })
    );

    // .text is a getter
    const raw     = response.text;
    const cleaned = raw.replace(/```json|```/g, '').trim();
    const quiz    = JSON.parse(cleaned);
    res.json({ quiz });

  } catch (err) {
    console.error('Quiz generation error:', err);
    res.status(500).json({ error: friendlyErrorMessage(err) });
  }
};

// ─── GENERATE FLASHCARDS  (structured JSON) ───────────────────────────────────
exports.generateFlashcards = async (req, res) => {
  const { text, documentId } = req.body;

  if (!text || !documentId) {
    return res.status(400).json({ error: 'Text and documentId are required.' });
  }

  const prompt = `You are a smart study-card creator. Extract key concepts from the text below and create flashcards.
Return ONLY a raw JSON array — no markdown, no code fences, no explanation.

Each object must have:
- "front": the term or question (short)
- "back": the definition or answer (clear and concise)

Generate 5–12 cards depending on content density.

Text:
---
${text}`;

  try {
    const response = await callWithRetry(() =>
      ai.models.generateContent({
        model: MODEL,
        contents: prompt,
        config: {
          responseMimeType: 'application/json',
          responseSchema: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                front: { type: 'string' },
                back:  { type: 'string' },
              },
              required: ['front', 'back'],
            },
          },
        },
      })
    );

    const raw        = response.text;
    const cleaned    = raw.replace(/```json|```/g, '').trim();
    const flashcards = JSON.parse(cleaned);
    res.json({ flashcards });

  } catch (err) {
    console.error('Flashcard generation error:', err);
    res.status(500).json({ error: friendlyErrorMessage(err) });
  }
};

// ─── SAVE FLASHCARD ───────────────────────────────────────────────────────────
exports.saveFlashcard = async (req, res) => {
  const { front, back, documentId } = req.body;
  const userId = req.session.userId;

  if (!front || !back || !documentId) {
    return res.status(400).json({ error: 'Missing required fields.' });
  }

  try {
    const FlashcardDeck = require('../models/FlashcardDeck');
    const Document = require('../models/Document');

    // Look up the parent document's title to snapshot onto the flashcard
    const doc = await Document.findOne({ _id: documentId, userId });
    const documentTitle = doc ? doc.title : 'Untitled Document';

    const card = await FlashcardDeck.create({ userId, documentId, documentTitle, front, back });
    res.json({ success: true, card });
  } catch (err) {
    console.error('Save flashcard error:', err);
    res.status(500).json({ error: 'Failed to save flashcard.' });
  }
};

// ─── GET CHAT HISTORY ─────────────────────────────────────────────────────────
exports.getChatHistory = async (req, res) => {
  const { documentId } = req.params;
  const userId         = req.session.userId;

  try {
    const history = await ChatHistory.findOne({ documentId, userId });
    res.json({ messages: history ? history.messages : [] });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch chat history.' });
  }
};

// ─── HELPER ───────────────────────────────────────────────────────────────────
async function saveChatMessage(documentId, userId, userText, aiText, action) {
  let history = await ChatHistory.findOne({ documentId, userId });
  if (!history) history = new ChatHistory({ documentId, userId, messages: [] });

  history.messages.push({
    sender: 'user',
    text: `[${action.toUpperCase()}] ${userText.substring(0, 200)}${userText.length > 200 ? '…' : ''}`,
  });
  history.messages.push({ sender: 'ai', text: aiText });
  await history.save();
}
