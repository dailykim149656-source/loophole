/**
 * THE LOOPHOLE — Single-Port Full-Stack Runtime Server (Port 3000 / Cloud Run PORT)
 * Serves API routes (/health, /api/scenario, /api/run, /api/selftest) and React + Three.js client.
 */

import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApiRouter } from './src/server/app';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function startServer() {
  const app = express();
  const port = Number(process.env.PORT) || 3000;

  // Mount API routes
  app.use(createApiRouter());

  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.resolve(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(port, '0.0.0.0', () => {
    console.log(
      `[THE LOOPHOLE v15.2.0] CleanCo KPI Incentive Test Harness listening on http://localhost:${port}`
    );
  });
}

startServer().catch((err) => {
  console.error('Failed to start THE LOOPHOLE server:', err);
  process.exit(1);
});
