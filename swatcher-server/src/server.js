const express = require('express');
const cors = require('cors');
const compression = require('compression');
const path = require('node:path');
const db = require('./db');
const apiRoutes = require('./routes/api');

const app = express();
const PORT = process.env.PORT || 9090;
const HOST = process.env.HOST || '0.0.0.0';

app.use(cors());
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
    version: '1.0.0',
    timestamp: new Date().toISOString()
  });
});

// Fallback to dashboard index for SPA navigation
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
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
