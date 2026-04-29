import {
  defaultBudgetState,
  SpendCategory,
  PaymentDecision,
} from '../budget-state';

export interface PaymentRequestInput {
  toolName: string;
  amountUsd: number;
  category: SpendCategory;
  justification?: string;
}

export interface PaymentRequestResult {
  ok: boolean;
  decision: PaymentDecision;
  toolName: string;
  amountUsd: number;
  category: SpendCategory;
}

export async function requestPayment(input: PaymentRequestInput): Promise<PaymentRequestResult> {
  const decision = defaultBudgetState.authorizeSpend(input.amountUsd, input.category);

  if (!decision.allowed) {
    return {
      ok: false,
      decision,
      toolName: input.toolName,
      amountUsd: input.amountUsd,
      category: input.category,
    };
  }

  // In production, swap this with an agentpay-mcp call that executes the x402 payment.
  return {
    ok: true,
    decision,
    toolName: input.toolName,
    amountUsd: input.amountUsd,
    category: input.category,
  };
}
