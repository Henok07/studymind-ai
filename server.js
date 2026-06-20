require('dotenv').config();
const express = require('express');
const session = require('express-session');
const flash = require('connect-flash');
const path = require('path');
const connectDB = require('./config/db');
const MongoStore = require('connect-mongo')(session);

const app = express();
connectDB();

// View engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Static files
app.use(express.static(path.join(__dirname, 'public')));

// Body parsing
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Session
// With this:

app.use(session({
  secret: process.env.SESSION_SECRET || 'fallback-secret-key',
  resave: false,
  saveUninitialized: false,
  store: new MongoStore({ mongooseConnection: require('mongoose').connection }),
  cookie: { secure: false, maxAge: 7 * 24 * 60 * 60 * 1000 }
}));

// Flash messages
app.use(flash());

// Make session available in all views
app.use((req, res, next) => {
  res.locals.username = req.session.username || null;
  res.locals.userId = req.session.userId || null;
  next();
});

// Routes
app.use('/auth', require('./routes/auth'));
app.use('/', require('./routes/pdf'));
app.use('/api/ai', require('./routes/ai'));

// 404 handler
app.use((req, res) => {
  res.status(404).render('login', {
    error: ['Page not found'],
    success: []
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running at http://localhost:${PORT}`);
});
