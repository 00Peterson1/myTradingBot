import { getDb } from '../data/database/sqlite.js';

getDb().prepare('DELETE FROM gemini_context_cache').run();
console.log('✅ Gemini context cache cleared');
process.exit(0);
