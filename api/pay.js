// Vercel serverless function → /api/pay (customer payment link; logic in lib/handlers.js, shared with server.mjs).
import { payHandler } from '../lib/handlers.js';

export default payHandler;
