/**
 * Builders for Deriv WebSocket API request messages.
 * All request construction lives here — the client never builds raw objects.
 */

export function buildAuthorizeRequest(token: string, reqId: number): Record<string, unknown> {
  return { authorize: token, req_id: reqId };
}

export function buildActiveSymbolsRequest(
  productType: 'basic' | 'advanced' = 'basic',
  reqId?: number,
): Record<string, unknown> {
  return {
    active_symbols: 'full',
    product_type: productType,
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
  contractType: 'CALL' | 'PUT' | 'DIGITEVEN' | 'DIGITODD';
  duration: number;
  durationUnit: 's' | 'm' | 'h' | 'd' | 't';
  stake: number;
  currency: string;
  basis: 'stake' | 'payout';
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
    symbol: opts.symbol,
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
