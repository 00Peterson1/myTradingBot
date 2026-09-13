/**
 * Builders for Deriv WebSocket API request messages.
 * All request construction lives here — the client never builds raw objects.
 */

export function buildAuthorizeRequest(token: string, reqId: number): Record<string, unknown> {
  return { authorize: token, req_id: reqId };
}

export function buildActiveSymbolsRequest(
  detail: 'full' | 'brief' = 'brief',
  reqId?: number,
): Record<string, unknown> {
  return {
    active_symbols: detail,
    ...(reqId !== undefined ? { req_id: reqId } : {}),
  };
}

export function buildTicksHistoryRequest(
  symbol: string,
  count: number,
  end: 'latest' | number = 'latest',
  reqId?: number,
): Record<string, unknown> {
  return {
    ticks_history: symbol,
    adjust_start_time: 1,
    count,
    end,
    start: 1,
    style: 'ticks',
    ...(reqId !== undefined ? { req_id: reqId } : {}),
  };
}

export function buildContractsForRequest(symbol: string, reqId?: number): Record<string, unknown> {
  return {
    contracts_for: symbol,
    ...(reqId !== undefined ? { req_id: reqId } : {}),
  };
}

export function buildTicksHistoryRangeRequest(
  symbol: string,
  start: number,
  end: number,
  reqId?: number,
): Record<string, unknown> {
  return {
    ticks_history: symbol,
    adjust_start_time: 1,
    start,
    end,
    style: 'ticks',
    ...(reqId !== undefined ? { req_id: reqId } : {}),
  };
}

export function buildSubscribeTicksRequest(
  symbol: string,
  reqId?: number,
): Record<string, unknown> {
  return {
    ticks: symbol,
    subscribe: 1,
    ...(reqId !== undefined ? { req_id: reqId } : {}),
  };
}

export function buildUnsubscribeTicksRequest(
  subscriptionId: string,
  reqId?: number,
): Record<string, unknown> {
  return {
    forget: subscriptionId,
    ...(reqId !== undefined ? { req_id: reqId } : {}),
  };
}

export function buildProposalRequest(opts: {
  symbol: string;
  contractType:
    | 'CALL'
    | 'PUT'
    | 'DIGITEVEN'
    | 'DIGITODD'
    | 'DIGITOVER'
    | 'DIGITUNDER'
    | 'DIGITMATCH'
    | 'DIGITDIFF'
    | 'HIGHER'
    | 'LOWER';
  duration: number;
  durationUnit: 's' | 'm' | 'h' | 'd' | 't';
  stake: number;
  currency: string;
  basis: 'stake' | 'payout';
  barrier?: number | string;
  reqId?: number;
}): Record<string, unknown> {
  return {
    proposal: 1,
    amount: opts.stake,
    basis: opts.basis,
    contract_type: opts.contractType,
    currency: opts.currency,
    duration: opts.duration,
    duration_unit: opts.durationUnit,
    underlying_symbol: opts.symbol,  // New Deriv API uses underlying_symbol (not symbol)
    ...(opts.barrier !== undefined ? { barrier: String(opts.barrier) } : {}),
    ...(opts.reqId !== undefined ? { req_id: opts.reqId } : {}),
  };
}

export function buildBuyRequest(
  proposalId: string,
  price: number,
  reqId?: number,
): Record<string, unknown> {
  return {
    buy: proposalId,
    price,
    ...(reqId !== undefined ? { req_id: reqId } : {}),
  };
}

export function buildDirectBuyRequest(opts: {
  symbol: string;
  contractType: string;
  duration: number;
  durationUnit: 's' | 'm' | 'h' | 'd' | 't';
  stake: number;
  currency: string;
  basis: 'stake' | 'payout';
  barrier?: number | string;
  reqId?: number;
}): Record<string, unknown> {
  return {
    buy: '1',
    price: opts.stake,
    parameters: {
      amount: opts.stake,
      basis: opts.basis,
      contract_type: opts.contractType,
      currency: opts.currency,
      duration: opts.duration,
      duration_unit: opts.durationUnit,
      underlying_symbol: opts.symbol,
      ...(opts.barrier !== undefined ? { barrier: String(opts.barrier) } : {}),
    },
    ...(opts.reqId !== undefined ? { req_id: opts.reqId } : {}),
  };
}

export function buildSellRequest(
  contractId: number,
  price: number,
  reqId?: number,
): Record<string, unknown> {
  return {
    sell: contractId,
    price,
    ...(reqId !== undefined ? { req_id: reqId } : {}),
  };
}

export function buildBalanceRequest(reqId?: number): Record<string, unknown> {
  return {
    balance: 1,
    subscribe: 1,
    ...(reqId !== undefined ? { req_id: reqId } : {}),
  };
}

export function buildPingRequest(reqId?: number): Record<string, unknown> {
  return {
    ping: 1,
    ...(reqId !== undefined ? { req_id: reqId } : {}),
  };
}
