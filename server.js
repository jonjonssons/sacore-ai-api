// Add polyfills for Google Generative AI
const fetch = require('node-fetch');
const { Headers } = require('node-fetch');
global.fetch = fetch;
global.Headers = Headers;

// Add missing Node.js polyfills for googleapis library (PRODUCTION FIX)
if (!global.Blob) {
  global.Blob = class Blob {
    constructor(chunks, options = {}) {
      const { type = '' } = options;
      this.size = 0;
      this.type = type;
      this._chunks = chunks || [];
      if (chunks) {
        for (const chunk of chunks) {
          if (typeof chunk === 'string') {
            this.size += Buffer.byteLength(chunk, 'utf8');
          } else if (chunk instanceof Buffer) {
            this.size += chunk.length;
          } else if (chunk instanceof ArrayBuffer) {
            this.size += chunk.byteLength;
          }
        }
      }
    }

    text() {
      return Promise.resolve(
        this._chunks.map(chunk =>
          typeof chunk === 'string' ? chunk : chunk.toString()
        ).join('')
      );
    }

    arrayBuffer() {
      const chunks = this._chunks.map(chunk => {
        if (typeof chunk === 'string') {
          return Buffer.from(chunk, 'utf8');
        } else if (chunk instanceof Buffer) {
          return chunk;
        } else if (chunk instanceof ArrayBuffer) {
          return Buffer.from(chunk);
        }
        return Buffer.from(String(chunk), 'utf8');
      });
      return Promise.resolve(Buffer.concat(chunks).buffer);
    }
  };
}



if (!global.FormData) {
  global.FormData = class FormData {
    constructor() {
      this._data = new Map();
    }
    append(name, value) {
      if (!this._data.has(name)) {
        this._data.set(name, []);
      }
      this._data.get(name).push(value);
    }
    get(name) {
      const values = this._data.get(name);
      return values ? values[0] : null;
    }
    getAll(name) {
      return this._data.get(name) || [];
    }
  };
}

if (!global.ReadableStream) {
  global.ReadableStream = class ReadableStream {
    constructor(source) {
      this._source = source || {};
    }
  };
}


process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
  // Optionally, you can decide to exit the process or keep it alive
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  // Optionally, you can decide to exit the process or keep it alive
});

const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const cookieParser = require('cookie-parser');

const path = require('path');
require('dotenv').config();

// Import database connection
const connectDB = require('./config/database');

// Import routes
const authRoutes = require('./routes/authRoutes');
const searchRoutes = require('./routes/searchRoutes');
const stripeRoutes = require('./routes/stripeRoutes');
const linkedinRoutes = require('./routes/linkedinRoutes');
const profileRoutes = require('./routes/profileRoutes');
const proxyRoutes = require('./routes/proxyRoutes');
const callbackRoutes = require('./routes/callbackRoutes');
const creditRoutes = require('./routes/creditRoutes');
const adminRoutes = require('./routes/adminRoutes');
const savedProfileRoutes = require('./routes/savedProfileRoutes');
const projectsRoutes = require('./routes/projectsRoutes');
const profilesRoutes = require('./routes/profilesRoutes');
const searchHistoryRoutes = require('./routes/searchHistoryRoutes');
const dashboardRoutes = require('./routes/dashboardRoutes');

// Import middleware
const notFoundMiddleware = require('./middleware/not-found');
const errorHandlerMiddleware = require('./middleware/error-handler');
const debugLogger = require('./middleware/debugLogger');
const { handleWebhook } = require('./controllers/stripeController');
const { startScheduler } = require('./services/scheduleProcessor');


const app = express();
const PORT = process.env.PORT || 7230;

// Connect to MongoDB
connectDB();

// Start the campaign scheduler
startScheduler();

// Middleware
app.use(cors({
  origin: ['http://localhost:3000', 'https://devsacoreweb.56-north.com', 'https://devsacoreweb.56-north.com/', 'http://localhost:8080', 'http://192.168.29.100:8080', 'https://sacore.ai/', 'https://sacore.ai', 'http://localhost:5173', 'https://sacore-ai-web-ickr.onrender.com/', 'https://sacore-ai-web-ickr.onrender.com'],
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
  credentials: true
}));

// Special handling for Stripe webhooks
// app.use('/api/stripe/webhook', express.raw({ type: 'application/json' }));

app.use('/api/stripe/webhook', express.raw({ type: 'application/json' }), (req, res, next) => {
  // Store the raw body for Stripe signature verification
  req.rawBody = req.body;

  // Parse the body for our route handlers
  if (req.body.length) {
    req.body = JSON.parse(req.body.toString());
  }

  next();
});

// Add direct webhook handler route
app.post('/api/stripe/webhook', handleWebhook);

// Regular middleware for other routes
app.use(express.json({ limit: '10mb' })); // Increased from 1mb to 10mb
app.use(express.urlencoded({ extended: true, limit: '10mb' })); // Added limit for urlencoded as well
app.use(morgan('dev'));
app.use(cookieParser());


// Add debug middleware in development
if (process.env.NODE_ENV !== 'production') {
  app.use(debugLogger);
}

// Health check route for hosting platforms
app.get('/', (req, res) => {
  res.status(200).json({ status: 'ok', message: 'Server is healthy' });
});

// Routes
app.use('/api/admin', adminRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/search', searchRoutes);
app.use('/api/stripe', stripeRoutes);
app.use('/api/linkedin', linkedinRoutes);
app.use('/api/profile', profileRoutes);
app.use('/api/proxy', proxyRoutes);
app.use('/api/callback', callbackRoutes);
app.use('/api/credits', creditRoutes);
app.use('/api/saved-profiles', savedProfileRoutes);
app.use('/api/projects', projectsRoutes);
app.use('/api/profiles', profilesRoutes);
app.use('/api/search-history', searchHistoryRoutes);
app.use('/api', dashboardRoutes);

// Register a new SignalHire API request
app.post('/api/signalhire-request', async (req, res) => {
  const profileService = require('./services/profileService');

  try {
    const { requestId, url } = req.body;

    if (!requestId || !url) {
      return res.status(400).json({ error: 'Missing required fields: requestId and url' });
    }

    // Store the request
    await profileService.saveRequest({
      requestId,
      url,
      createdAt: new Date().toISOString(),
      status: 'pending'
    });

    return res.status(200).json({ success: true, message: 'Request registered successfully' });
  } catch (error) {
    console.error('Error registering SignalHire request:', error);
    return res.status(500).json({ error: 'Internal server error registering request' });
  }
});
// Serve static files from the 'public' directory
// app.use(express.static(path.join(__dirname, 'public')));

// Error handling
app.use(notFoundMiddleware);
app.use(errorHandlerMiddleware);

// Start server
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

module.exports = app; // For testing
