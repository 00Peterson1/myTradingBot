import type { EconomicCalendar, EconomicEvent } from './EconomicCalendar.js';

export interface MacroContext {
  rateDifferential: number | null;
  riskAppetite: 'RISK_ON' | 'RISK_OFF' | 'NEUTRAL';
  upcomingEvents: EconomicEvent[];
  isBlackout: boolean;
}

export class MacroFeatures {
  async getContext(symbol: string, calendar: EconomicCalendar): Promise<MacroContext> {
    return {
      rateDifferential: null,
      riskAppetite: 'NEUTRAL',
      upcomingEvents: calendar.getUpcoming(symbol, 4),
      isBlackout: calendar.isBlackout(symbol)
    };
  }
}
