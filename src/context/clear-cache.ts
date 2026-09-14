import { print } from '../monitoring/print.js';
import { getDb } from '../data/database/sqlite.js';

getDb().prepare('DELETE FROM gemini_context_cache').run();
print('✅ Gemini context cache cleared');
process.exit(0);
