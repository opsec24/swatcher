const express = require('express');
const cors = require('cors');
const compression = require('compression');
const path = require('node:path');
const apiRoutes = require('./routes/api');

const app = express();
const PORT = process.env.PORT || 9090;

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
  res.json({ status: 'UP', service: 'swatcher-server', version: '1.0.0', timestamp: new Date().toISOString() });
});

// Fallback to dashboard index for SPA navigation
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`=======================================================`);
  console.log(`  swatcher central server listening on port ${PORT}`);
  console.log(`  Leadership Dashboard: http://localhost:${PORT}`);
  console.log(`  Ingestion Endpoint:   http://localhost:${PORT}/api/v1/ingest/batch`);
  console.log(`=======================================================`);
});
