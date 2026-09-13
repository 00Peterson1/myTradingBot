/**
 * GeminiContextFilter
 *
 * Purpose: Replace static RATE_DECISION_BLACKOUT_DAYS with actual NLP
 * comprehension of central bank policy statements.
 *
 * For the EUR/GBP + AUD/NZD correlation basket, this filter:
 *   - Fetches the latest ECB/BOE statements (for EUR/GBP)
 *   - Fetches the latest RBA/RBNZ statements (for AUD/NZD)
 *   - Asks Gemini to score "policy divergence risk" on 0–10
 *   - Suppresses trade if score exceeds LLM_DIVERGENCE_SUPPRESS_THRESHOLD
 *   - Reduces confidence proportionally for non-suppressed signals
 *   - Caches results for LLM_CACHE_HOURS (default 4h) per pair
 *
 * Graceful degradation:
 *   - If GEMINI_API_KEY is not set: filter is a no-op (returns safe defaults)
 *   - If Gemini API call fails: returns cached result or safe defaults
 *   - If context fetch fails: uses empty context (model returns low risk)
 *
 * Cost: <30 calls/day at max (6 pairs × every 4h = 36 max). Essentially free.
 *
 * References:
 *   - TradingAgents (arXiv:2412.20138): multi-agent LLM for market decisions
 *   - FinMem (arXiv:2311.13743): memory-augmented LLM agent
 *   - "Profit Mirage" (arXiv:2510.07920): use LLM as filter, not signal generator
 */

import { GoogleGenAI } from '@google/genai';
import { getDb } from '../data/database/sqlite.js';
import { createLogger } from '../monitoring/Logger.js';
import { getEnv } from '../config/env.js';

const log = createLogger('GeminiFilter');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ContextAssessment {
  /** 0–10 policy divergence risk score */
  divergenceScore: number;
  /** Whether to fully suppress the trade signal */
  suppressTrade: boolean;
  /** Brief human-readable rationale (≤2 sentences) */
  rationale: string;
  /** Primary risk factor identified */
  keyRisk: string;
  /** True if assessment came from Gemini (false = fallback/no key) */
  fromLLM: boolean;
}

// Central bank context sources per currency
// These are the landing pages for recent policy statements
const CB_SOURCES: Record<string, { name: string; url: string }> = {
  EUR: {
    name: 'ECB (European Central Bank)',
    url: 'https://www.ecb.europa.eu/press/pr/date/html/index.en.html',
  },
  GBP: {
    name: 'BOE (Bank of England)',
    url: 'https://www.bankofengland.co.uk/monetary-policy-summary-and-minutes',
  },
  AUD: {
    name: 'RBA (Reserve Bank of Australia)',
    url: 'https://www.rba.gov.au/monetary-policy/rba-board-minutes/',
  },
  NZD: {
    name: 'RBNZ (Reserve Bank of New Zealand)',
    url: 'https://www.rbnz.govt.nz/monetary-policy/monetary-policy-statements',
  },
  USD: {
    name: 'Federal Reserve',
    url: 'https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm',
  },
  JPY: {
    name: 'BOJ (Bank of Japan)',
    url: 'https://www.boj.or.jp/en/mopo/mpmsche_minu/index.htm/',
  },
};

// Symbol to currencies mapping
const SYMBOL_CURRENCIES: Record<string, string[]> = {
  frxEURGBP: ['EUR', 'GBP'],
  frxEURUSD: ['EUR', 'USD'],
  frxGBPUSD: ['GBP', 'USD'],
  frxAUDNZD: ['AUD', 'NZD'],
  frxAUDUSD: ['AUD', 'USD'],
  frxNZDUSD: ['NZD', 'USD'],
  frxUSDJPY: ['USD', 'JPY'],
  frxGBPJPY: ['GBP', 'JPY'],
  frxEURJPY: ['EUR', 'JPY'],
};

/** Fallback safe assessment when LLM unavailable */
const SAFE_ASSESSMENT: ContextAssessment = {
  divergenceScore: 0,
  suppressTrade: false,
  rationale: 'Gemini context filter inactive (no API key configured).',
  keyRisk: 'none',
  fromLLM: false,
};

// ---------------------------------------------------------------------------
// GeminiContextFilter
// ---------------------------------------------------------------------------

export class GeminiContextFilter {
  private genai: GoogleGenAI | null = null;
  private readonly apiKey: string;
  private readonly cacheHours: number;
  private readonly suppressThreshold: number;

  constructor() {
    const env = getEnv();
    this.apiKey = env.GEMINI_API_KEY;
    this.cacheHours = env.LLM_CACHE_HOURS;
    this.suppressThreshold = env.LLM_DIVERGENCE_SUPPRESS_THRESHOLD;

    if (this.apiKey) {
      this.genai = new GoogleGenAI({ apiKey: this.apiKey });
      log.info('Gemini context filter initialized (active)');
    } else {
      log.warn('GEMINI_API_KEY not set — context filter will be a no-op (safe fallback)');
    }
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Assess policy divergence risk for a pair signal.
   *
   * @param symbolA Primary symbol being traded
   * @param signalMetadata Metadata from the strategy signal (z-score, spread state)
   * @param upcomingEvents Economic events affecting this pair (from EconomicCalendar)
   */
  async assess(
    symbolA: string,
    signalMetadata: Record<string, unknown> = {},
    upcomingEvents: { eventName: string; currency: string; impact: string; scheduledAt: string }[] = [],
  ): Promise<ContextAssessment> {
    if (!this.genai) return SAFE_ASSESSMENT;

    // Build pair ID from primary symbol + its pair partner (from metadata)
    const symbolB = signalMetadata.symbolB as string | undefined;
    const pairId = symbolB ? `${symbolA}-${symbolB}` : symbolA;

    // Check cache first
    const cached = this.getCached(pairId);
    if (cached) {
      log.debug({ pairId, divergenceScore: cached.divergenceScore }, 'Returning cached context');
      return cached;
    }

    // Determine currencies for this pair
    const currencies = this.getCurrencies(symbolA, symbolB);
    if (currencies.length === 0) {
      // Synthetic index or unknown pair — no CB risk
      return { ...SAFE_ASSESSMENT, rationale: 'Synthetic index — no central bank risk.' };
    }

    // Fetch CB context for each currency
    const cbContextParts: string[] = [];
    for (const currency of currencies) {
      const source = CB_SOURCES[currency];
      if (!source) continue;
      const text = await this.fetchCBContext(source.url, source.name);
      if (text) cbContextParts.push(`[${source.name}]:\n${text}`);
    }

    const cbContext =
      cbContextParts.length > 0
        ? cbContextParts.join('\n\n')
        : 'No central bank statements available at this time.';

    // Format upcoming events
    const eventsText =
      upcomingEvents.length > 0
        ? upcomingEvents
            .map((e) => `  - ${e.currency} ${e.eventName} (${e.impact}) at ${e.scheduledAt}`)
            .join('\n')
        : '  None in next 48h';

    // Build prompt
    const prompt = this.buildPrompt(
      symbolA,
      symbolB ?? 'N/A',
      currencies,
      signalMetadata,
      cbContext,
      eventsText,
    );

    // Call Gemini
    try {
      const result = await this.callGemini(prompt);
      const assessment: ContextAssessment = {
        ...result,
        fromLLM: true,
      };

      // Persist to cache
      this.persistCache(pairId, assessment);
      log.info(
        { pairId, score: assessment.divergenceScore, suppress: assessment.suppressTrade },
        'Gemini context assessment complete',
      );

      return assessment;
    } catch (err) {
      log.error({ err, pairId }, 'Gemini API call failed — using safe fallback');
      return { ...SAFE_ASSESSMENT, rationale: 'Context assessment failed — safe fallback used.' };
    }
  }

  /**
   * Apply the context assessment to modify signal confidence.
   * Call this after assess() and before the RiskEngine.
   *
   * @returns Modified confidence [0, 1]
   */
  applyToConfidence(originalConfidence: number, assessment: ContextAssessment): number {
    if (assessment.suppressTrade) return 0;
    // Linear confidence reduction: score 7/10 reduces by 21%, score 10/10 by 30%
    const reduction = (assessment.divergenceScore / 10) * 0.3;
    return Math.max(0, originalConfidence * (1 - reduction));
  }

  // ---------------------------------------------------------------------------
  // Private: Gemini Call
  // ---------------------------------------------------------------------------

  private async callGemini(prompt: string): Promise<Omit<ContextAssessment, 'fromLLM'>> {
    const models = ['gemini-3.6-flash', 'gemini-3.7-flash'];
    const maxRetries = 3;

    for (const model of models) {
      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
          const response = await this.genai!.models.generateContent({
            model,
            contents: prompt,
            config: {
              responseMimeType: 'application/json',
              temperature: 0.1,
              maxOutputTokens: 256,
            },
          });

          const text = response.text ?? '{}';

          // Robust JSON extraction — handles partial/truncated responses
          const jsonMatch = /\{[\s\S]*\}/.exec(text);
          const jsonStr = jsonMatch?.[0] ?? '{}';

          let parsed: Record<string, unknown>;
          try {
            parsed = JSON.parse(jsonStr) as Record<string, unknown>;
          } catch {
            log.warn({ text: text.slice(0, 200), model, attempt }, 'Non-JSON response — retrying');
            continue;
          }

          const divergenceScore = Math.min(10, Math.max(0, Number(parsed.divergence_score ?? 0)));
          const suppressTrade =
            Boolean(parsed.suppress_trade) || divergenceScore >= this.suppressThreshold;

          // Ensure rationale and keyRisk are never empty strings
          const rationale =
            String(parsed.rationale ?? '').trim() ||
            (divergenceScore <= 3
              ? 'Central bank policies appear broadly aligned; mean-reversion premise valid.'
              : divergenceScore <= 6
                ? 'Some policy divergence signals detected; trade confidence reduced.'
                : 'Significant policy divergence detected; trade suppressed for safety.');
          const keyRisk = String(parsed.key_risk ?? '').trim() || 'none identified';

          return {
            divergenceScore,
            suppressTrade,
            rationale,
            keyRisk,
          };
        } catch (err: unknown) {
          const status = (err as { status?: number }).status;
          const isRetryable = status === 503 || status === 429 || status === 500;

          if (isRetryable && attempt < maxRetries) {
            const delayMs = 1000 * Math.pow(2, attempt - 1); // 1s, 2s, 4s
            log.warn(
              { model, attempt, status, delayMs },
              `Model overloaded — retrying in ${delayMs}ms`,
            );
            await new Promise((r) => setTimeout(r, delayMs));
            continue;
          }

          // Non-retryable or exhausted retries — try next model
          log.warn({ model, status, err }, 'Model failed — trying next');
          break;
        }
      }
    }

    // All models exhausted
    log.error('All Gemini models failed — returning safe fallback');
    return {
      divergenceScore: 0,
      suppressTrade: false,
      rationale: 'Context assessment temporarily unavailable — safe fallback.',
      keyRisk: 'none',
    };
  }

  // ---------------------------------------------------------------------------
  // Private: Prompt Builder
  // ---------------------------------------------------------------------------

  private buildPrompt(
    symbolA: string,
    symbolB: string,
    currencies: string[],
    metadata: Record<string, unknown>,
    cbContext: string,
    eventsText: string,
  ): string {
    const zScore = metadata.spreadZ !== undefined ? Number(metadata.spreadZ).toFixed(2) : 'N/A';
    const cointegP =
      metadata.cointegP !== undefined ? Number(metadata.cointegP).toFixed(3) : 'N/A';
    const direction = metadata.direction ?? 'unknown';

    return `You are a central bank policy analyst for FX correlation trading.

PAIR BASKET: ${symbolA} / ${symbolB}
CURRENCIES INVOLVED: ${currencies.join(', ')}

CURRENT SIGNAL:
  Spread z-score: ${zScore} (direction: ${direction})
  Cointegration p-value: ${cointegP}

STRATEGY CONTEXT:
  This is a statistical mean-reversion trade on the correlation spread between
  ${symbolA} and ${symbolB}. The model assumes the two exchange rates remain
  correlated due to shared risk drivers. Policy divergence between the central
  banks controlling these currencies would break this assumption and make the
  trade dangerous regardless of the statistical signal.

UPCOMING ECONOMIC EVENTS (next 48h):
${eventsText}

CENTRAL BANK STATEMENTS (most recent available):
${cbContext}

TASK:
Assess whether current or imminent central bank policy divergence creates
meaningful risk for this correlation pair trade.

Consider:
1. Are the two currency-pair central banks moving in the same direction (both
   hawkish, both dovish) or diverging (one hawkish, one cutting)?
2. Is there an imminent rate decision that could cause a step-change in spreads?
3. Is there explicit forward guidance that contradicts mean-reversion?

Respond with ONLY valid JSON (no markdown, no explanation outside JSON):
{
  "divergence_score": <integer 0-10>,
  "rationale": "<1-2 sentences MAX>",
  "suppress_trade": <true or false>,
  "key_risk": "<single phrase>"
}

Score guide:
  0–3: Banks aligned or neutral, mean-reversion premise valid
  4–6: Some divergence signals but not definitive, reduce confidence
  7–9: Clear policy divergence likely, suppress recommended
  10: One bank actively hiking while other is cutting, suppress mandatory`;
  }

  // ---------------------------------------------------------------------------
  // Private: CB Context Fetch
  // ---------------------------------------------------------------------------

  private async fetchCBContext(url: string, sourceName: string): Promise<string> {
    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(5000), // 5s timeout
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; research-bot/1.0)' },
      });
      if (!res.ok) return '';

      const html = await res.text();
      // Extract readable text: strip HTML tags, collapse whitespace, take first 1500 chars
      const stripped = html
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s{2,}/g, ' ')
        .trim()
        .slice(0, 1500);

      return `${sourceName}: ${stripped}`;
    } catch {
      log.warn({ url, sourceName }, 'Failed to fetch CB context — skipping');
      return '';
    }
  }

  // ---------------------------------------------------------------------------
  // Private: Currency Resolution
  // ---------------------------------------------------------------------------

  private getCurrencies(symbolA: string, symbolB?: string): string[] {
    const setA = SYMBOL_CURRENCIES[symbolA] ?? this.deriveCurrencies(symbolA);
    if (!symbolB) return setA;
    const setB = SYMBOL_CURRENCIES[symbolB] ?? this.deriveCurrencies(symbolB);
    // Unique union
    return [...new Set([...setA, ...setB])];
  }

  private deriveCurrencies(symbol: string): string[] {
    // Synthetic indices: no CB risk
    if (/^(1HZ|BOOM|CRASH|stpRNG|JD)\d/.test(symbol)) return [];
    // 'frxEURGBP' → ['EUR', 'GBP']
    const match = /^frx([A-Z]{3})([A-Z]{3})$/.exec(symbol);
    if (match?.[1] && match?.[2]) return [match[1], match[2]];
    // 'EURUSD' → ['EUR', 'USD']
    const bare = /^([A-Z]{3})([A-Z]{3})$/.exec(symbol);
    if (bare?.[1] && bare?.[2]) return [bare[1], bare[2]];
    return [];
  }

  // ---------------------------------------------------------------------------
  // Private: SQLite Cache
  // ---------------------------------------------------------------------------

  private getCached(pairId: string): ContextAssessment | null {
    try {
      const db = getDb();
      const row = db
        .prepare<[string, string], {
          divergence_score: number;
          suppress_trade: number;
          rationale: string;
          key_risk: string;
          expires_at: string;
        }>(
          `SELECT divergence_score, suppress_trade, rationale, key_risk, expires_at
           FROM gemini_context_cache
           WHERE pair_id = ? AND expires_at > ?`,
        )
        .get(pairId, new Date().toISOString());

      if (!row) return null;

      return {
        divergenceScore: row.divergence_score,
        suppressTrade: row.suppress_trade === 1,
        rationale: row.rationale,
        keyRisk: row.key_risk,
        fromLLM: true,
      };
    } catch {
      return null;
    }
  }

  private persistCache(pairId: string, assessment: ContextAssessment): void {
    try {
      const db = getDb();
      const now = new Date();
      const expiresAt = new Date(now.getTime() + this.cacheHours * 60 * 60 * 1000);

      db.prepare(
        `INSERT INTO gemini_context_cache
           (pair_id, divergence_score, suppress_trade, rationale, key_risk, fetched_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(pair_id) DO UPDATE SET
           divergence_score = excluded.divergence_score,
           suppress_trade   = excluded.suppress_trade,
           rationale        = excluded.rationale,
           key_risk         = excluded.key_risk,
           fetched_at       = excluded.fetched_at,
           expires_at       = excluded.expires_at`,
      ).run(
        pairId,
        assessment.divergenceScore,
        assessment.suppressTrade ? 1 : 0,
        assessment.rationale,
        assessment.keyRisk,
        now.toISOString(),
        expiresAt.toISOString(),
      );
    } catch (err) {
      log.warn({ err, pairId }, 'Failed to persist context cache');
    }
  }
}

// Singleton
let _filter: GeminiContextFilter | null = null;
export function getGeminiContextFilter(): GeminiContextFilter {
  if (!_filter) _filter = new GeminiContextFilter();
  return _filter;
}
