// Vercel serverless function → /api/orders (logic in lib/handlers.js, shared with server.mjs).
import { ordersHandler } from '../lib/handlers.js';

export default ordersHandler;
