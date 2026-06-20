const express  = require('express');
const router   = express.Router();
const multer   = require('multer');
const path     = require('path');
const fs       = require('fs');
const Document     = require('../models/Document');
const FlashcardDeck = require('../models/FlashcardDeck');
const ChatHistory   = require('../models/ChatHistory');

// ── Auth middleware ───────────────────────────────────────────────────────────
const requireAuth = (req, res, next) => {
  if (!req.session.userId) return res.redirect('/auth/login');
  next();
};

const requireAuthJson = (req, res, next) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Unauthorized' });
  next();
};

// ── Multer storage ────────────────────────────────────────────────────────────
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(__dirname, '../public/uploads');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const unique = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
    cb(null, unique + path.extname(file.originalname));
  },
});

const upload = multer({
  storage,
  fileFilter: (req, file, cb) => {
    file.mimetype === 'application/pdf'
      ? cb(null, true)
      : cb(new Error('Only PDF files are allowed.'));
  },
  limits: { fileSize: 50 * 1024 * 1024 },
});

// ── GET / — Landing page (or redirect into the unified workspace) ─────────────
router.get('/', (req, res) => {
  if (req.session.userId) return res.redirect('/dashboard');
  res.render('landing');
});

// ── GET /dashboard — Legacy entry point: redirect into the unified workspace ──
router.get('/dashboard', requireAuth, async (req, res) => {
  try {
    const documents = await Document.find({ userId: req.session.userId }).sort({ uploadedAt: -1 });

    // The standalone dashboard page no longer exists — the sidebar is now
    // the command center. Land the user on their most recent document,
    // or show the empty-state workspace shell if they have none yet.
    if (documents.length > 0) {
      return res.redirect(`/pdf/${documents[0]._id}`);
    }
    return res.redirect('/workspace/empty');
  } catch (err) {
    console.error(err);
    res.redirect('/auth/login');
  }
});

// ── GET /workspace/empty — Unified shell with no document loaded ──────────────
router.get('/workspace/empty', requireAuth, async (req, res) => {
  try {
    const documents  = await Document.find({ userId: req.session.userId }).sort({ uploadedAt: -1 });
    const flashcards = await FlashcardDeck.find({ userId: req.session.userId })
      .populate('documentId', 'title')
      .sort({ savedAt: -1 });

    res.render('workspace', {
      document: null,
      documents,
      flashcards,
      username: req.session.username,
    });
  } catch (err) {
    console.error(err);
    res.redirect('/auth/login');
  }
});

// ── POST /pdf/upload ──────────────────────────────────────────────────────────
router.post('/pdf/upload', requireAuthJson, upload.single('pdf'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });

    const fileUrl = `/uploads/${req.file.filename}`;
    const title   = req.body.title || req.file.originalname.replace(/\.pdf$/i, '');

    const doc = await Document.create({
      userId:   req.session.userId,
      title,
      fileUrl,
      fileName: req.file.originalname,
      fileSize: req.file.size,
    });

    res.json({ success: true, document: doc });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Upload failed.' });
  }
});

// ── GET /pdf/:id — Open unified workspace with this document loaded ──────────
router.get('/pdf/:id', requireAuth, async (req, res) => {
  try {
    const document  = await Document.findOne({ _id: req.params.id, userId: req.session.userId });
    if (!document) return res.redirect('/dashboard');

    const documents  = await Document.find({ userId: req.session.userId }).sort({ uploadedAt: -1 });
    const flashcards = await FlashcardDeck.find({ userId: req.session.userId })
      .populate('documentId', 'title')
      .sort({ savedAt: -1 });

    res.render('workspace', {
      document,
      documents,
      flashcards,
      username: req.session.username,
    });
  } catch (err) {
    console.error(err);
    res.redirect('/dashboard');
  }
});

// ── DELETE /api/pdf/:id — Delete document + chat history ──────────────────────
router.delete('/api/pdf/:id', requireAuthJson, async (req, res) => {
  try {
    const doc = await Document.findOneAndDelete({
      _id:    req.params.id,
      userId: req.session.userId,
    });

    if (!doc) return res.status(404).json({ error: 'Document not found.' });

    // Delete physical file
    const filePath = path.join(__dirname, '../public', doc.fileUrl);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);

    // Delete orphaned chat history
    await ChatHistory.deleteMany({ documentId: doc._id });

    // Delete associated flashcards
    await FlashcardDeck.deleteMany({ documentId: doc._id });

    res.json({ success: true });
  } catch (err) {
    console.error('Delete error:', err);
    res.status(500).json({ error: 'Delete failed.' });
  }
});

module.exports = router;
