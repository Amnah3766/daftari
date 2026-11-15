// Vercel serverless function → /api/auth (logic in lib/handlers.js, shared with server.mjs).
import { authHandler } from '../lib/handlers.js';

export default authHandler;
