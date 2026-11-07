const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const path = require('node:path');
const db = require('./db');
const apiRoutes = require('./routes/api');

const app = express();
const PORT = process.env.PORT || 9090;
const HOST = process.env.HOST || '0.0.0.0';

// Defensively disable X-Powered-By header to prevent fingerprinting
app.disable('x-powered-by');

// Enterprise Defensive Security Headers (Fully self-contained for air-gapped environments)
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      scriptSrcAttr: ["'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      fontSrc: ["'self'", "data:"],
      imgSrc: ["'self'", "data:"],
      connectSrc: ["'self'"],
      upgradeInsecureRequests: null
    }
  },
  hsts: process.env.ENABLE_HSTS === 'true' ? { maxAge: 31536000, includeSubDomains: true } : false,
  crossOriginEmbedderPolicy: false
}));

// Hardened CORS policy: supports Burp Suite extensions and trusted dashboard origins
const allowedOriginsEnv = process.env.CORS_ORIGIN;
const allowedOrigins = allowedOriginsEnv ? allowedOriginsEnv.split(',').map(s => s.trim()) : null;

app.use(cors({
  origin: (origin, callback) => {
    // Non-browser clients (Burp Suite Montoya extension, CLI tools) send no Origin header
    if (!origin) return callback(null, true);
    // Allow localhost / loopback addresses
    if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
      return callback(null, true);
    }
    if (allowedOrigins) {
      if (allowedOrigins.includes(origin)) return callback(null, true);
      return callback(new Error('Blocked by swatcher CORS Policy'));
    }
    return callback(null, true);
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Session-Token', 'X-API-Key']
}));

app.use(compression());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Static dashboard assets
app.use(express.static(path.join(__dirname, '..', 'public')));

// API Routes
app.use('/api/v1', apiRoutes);

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'UP',
    service: 'swatcher-server',
    db_type: 'postgresql',
    version: '1.1.0',
    timestamp: new Date().toISOString()
  });
});

// Fallback to dashboard index for SPA navigation
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

// Centralized Defensive Error Handler (Never leaks stack traces or internal DB errors)
app.use((err, req, res, next) => {
  console.error('[swatcher-server] Unhandled Application Error:', err);
  if (res.headersSent) {
    return next(err);
  }
  res.status(err.status || 500).json({
    error: process.env.NODE_ENV === 'production' 
      ? 'An unexpected internal server error occurred. Please contact an administrator.'
      : err.message || 'Internal Server Error'
  });
});

async function startServer() {
  try {
    // Ensure all database tables and indexes are created before accepting requests
    await db.initSchema();

    const server = app.listen(PORT, HOST, () => {
      console.log(`=======================================================`);
      console.log(`  swatcher Central Server listening on ${HOST}:${PORT}`);
      console.log(`  Database Engine:      Enterprise PostgreSQL 16`);
      console.log(`  Leadership Dashboard: http://localhost:${PORT}`);
      console.log(`  Ingestion Endpoint:   http://localhost:${PORT}/api/v1/ingest/batch`);
      console.log(`=======================================================`);
    });

    const shutdown = async (signal) => {
      console.log(`\n[swatcher-server] Received ${signal}. Shutting down gracefully...`);
      server.close(async () => {
        try {
          await db.close();
          console.log('[swatcher-server] Clean exit.');
          process.exit(0);
        } catch (e) {
          console.error('[swatcher-server] Error during database shutdown:', e);
          process.exit(1);
        }
      });
    };

    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));

  } catch (error) {
    console.error('[swatcher-server] Fatal startup failure:', error);
    process.exit(1);
  }
}

startServer();
