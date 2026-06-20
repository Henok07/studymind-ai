const express = require('express');
const router = express.Router();
const aiController = require('../controllers/aiController');

const requireAuth = (req, res, next) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Unauthorized' });
  next();
};

// POST /api/ai/explain  — SSE streaming
router.post('/explain', requireAuth, aiController.explainText);

// POST /api/ai/chat  — multi-turn document-aware chat, SSE streaming
router.post('/chat', requireAuth, aiController.chatMessage);

// POST /api/ai/quiz
router.post('/quiz', requireAuth, aiController.generateQuiz);

// POST /api/ai/flashcards
router.post('/flashcards', requireAuth, aiController.generateFlashcards);

// POST /api/flashcards/save
router.post('/flashcards/save', requireAuth, aiController.saveFlashcard);

// GET /api/ai/history/:documentId
router.get('/history/:documentId', requireAuth, aiController.getChatHistory);

// DELETE /api/ai/flashcards/:id
router.delete('/flashcards/:id', requireAuth, async (req, res) => {
  try {
    const FlashcardDeck = require('../models/FlashcardDeck');
    await FlashcardDeck.findOneAndDelete({ _id: req.params.id, userId: req.session.userId });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Delete failed.' });
  }
});

module.exports = router;
