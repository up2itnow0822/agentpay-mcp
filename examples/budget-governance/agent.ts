import { exampleLog } from '../value-packs/shared/redact';
import { checkBudget } from './tools/check-budget';
import { requestPayment } from './tools/request-payment';

const instructions = `
You are a governance-aware agent:
- Always call checkBudget before paid actions.
- Never request payment above $1.00 per call.
- Keep total session spend under $5.00.
- Use category budgets responsibly (data <= $3, compute <= $2, infra <= $1).
- If a payment is denied, explain why and ask for operator guidance.
`;

async function runExample(): Promise<void> {
  exampleLog(instructions.trim());

  const budget = await checkBudget();
  exampleLog('Initial budget:', budget.budget);

  const first = await requestPayment({
    toolName: 'market-data-pro',
    amountUsd: 0.75,
    category: 'data',
    justification: 'Need premium sentiment feed for analysis.',
  });

  exampleLog('Payment #1:', first);

  const second = await requestPayment({
    toolName: 'model-inference-pro',
    amountUsd: 1.25,
    category: 'compute',
    justification: 'High-cost model generation.',
  });

  exampleLog('Payment #2:', second);
}

void runExample();
