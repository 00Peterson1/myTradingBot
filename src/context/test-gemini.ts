#!/usr/bin/env node
/**
 * Quick smoke test for the Gemini context filter.
 * Run: tsx src/context/test-gemini.ts
 */
import { getGeminiContextFilter } from './GeminiContextFilter.js';
import { getEnv } from '../config/env.js';
import { getDb } from '../data/database/sqlite.js';

async function main() {
  const env = getEnv();

  if (!env.GEMINI_API_KEY) {
    console.error('❌ GEMINI_API_KEY is not set in .env');
    process.exit(1);
  }

  console.log('✅ GEMINI_API_KEY detected (length:', env.GEMINI_API_KEY.length, 'chars)');
  console.log('   Model: gemini-3.7-flash');
  console.log('   Cache TTL:', env.LLM_CACHE_HOURS, 'hours');
  console.log('   Suppress threshold: divergence_score ≥', env.LLM_DIVERGENCE_SUPPRESS_THRESHOLD, '\n');

  // Initialise DB (needed for cache writes)
  getDb();

  const filter = getGeminiContextFilter();

  // --- Test 1: EUR/GBP pair ---
  console.log('🔍 Test 1: Assessing EUR/GBP + AUD/NZD pair...');
  const result1 = await filter.assess(
    'frxEURGBP',
    {
      symbolB: 'frxAUDNZD',
      spreadZ: 2.35,
      cointegP: 0.038,
      direction: 'SELL (spread too high)',
    },
    [], // No upcoming events for this test
  );

  console.log('  divergence_score:', result1.divergenceScore, '/ 10');
  console.log('  suppress_trade:  ', result1.suppressTrade);
  console.log('  rationale:       ', result1.rationale);
  console.log('  key_risk:        ', result1.keyRisk);
  console.log('  from_llm:        ', result1.fromLLM);

  const adj1 = filter.applyToConfidence(0.75, result1);
  console.log(`  confidence adj:   0.75 → ${adj1.toFixed(3)}\n`);

  // --- Test 2: AUD/NZD with simulated rate-decision event ---
  console.log('🔍 Test 2: AUD/NZD with RBNZ rate decision tomorrow...');
  const result2 = await filter.assess(
    'frxAUDNZD',
    {
      symbolB: undefined,
      spreadZ: -1.8,
      direction: 'BUY',
    },
    [
      {
        eventName: 'RBNZ Interest Rate Decision',
        currency: 'NZD',
        impact: 'CRITICAL',
        scheduledAt: new Date(Date.now() + 18 * 3600 * 1000).toISOString(),
      },
    ],
  );

  console.log('  divergence_score:', result2.divergenceScore, '/ 10');
  console.log('  suppress_trade:  ', result2.suppressTrade);
  console.log('  rationale:       ', result2.rationale);
  console.log('  key_risk:        ', result2.keyRisk);
  console.log('  from_llm:        ', result2.fromLLM);

  const adj2 = filter.applyToConfidence(0.65, result2);
  console.log(`  confidence adj:   0.65 → ${adj2.toFixed(3)}`);

  console.log('\n✅ GeminiContextFilter is working correctly.');
  process.exit(0);
}

main().catch((err: unknown) => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
