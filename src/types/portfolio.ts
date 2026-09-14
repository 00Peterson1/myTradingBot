import type { Money, OptionSpecification } from './product.js';

/** Product and account identity are mandatory; account balances are never interchangeable. */
interface PortfolioEventBase {
  readonly eventId: string;
  readonly accountId: string;
  readonly occurredAt: string; // UTC ISO-8601
}
export type PortfolioEvent = PortfolioEventBase & (
  | { readonly type: 'OPTION_RESERVED'; readonly product: 'OPTIONS'; readonly intentId: string; readonly specification: OptionSpecification }
  | { readonly type: 'OPTION_OPENED'; readonly product: 'OPTIONS'; readonly intentId: string; readonly contractId: string; readonly purchaseCost: Money }
  | { readonly type: 'OPTION_SETTLED'; readonly product: 'OPTIONS'; readonly contractId: string; readonly payout: Money; readonly profit: Money }
  | { readonly type: 'CFD_POSITION_OPENED'; readonly product: 'CFD'; readonly positionId: string; readonly quantity: number; readonly margin: Money }
  | { readonly type: 'CFD_POSITION_CLOSED'; readonly product: 'CFD'; readonly positionId: string; readonly profit: Money; readonly financing: Money }
);
