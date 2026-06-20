const mongoose = require('mongoose');

const FlashcardDeckSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  documentId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Document',
    required: true
  },
  documentTitle: {
    type: String,
    required: true,
    trim: true,
    default: 'Untitled Document'
  },
  front: {
    type: String,
    required: [true, 'Front of flashcard is required'],
    trim: true
  },
  back: {
    type: String,
    required: [true, 'Back of flashcard is required'],
    trim: true
  },
  savedAt: {
    type: Date,
    default: Date.now
  }
});

module.exports = mongoose.model('FlashcardDeck', FlashcardDeckSchema);
