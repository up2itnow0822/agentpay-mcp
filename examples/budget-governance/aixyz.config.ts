import { checkBudget } from './tools/check-budget';
import { requestPayment } from './tools/request-payment';

export default {
  name: 'budget-governance-agent',
  model: 'gpt-4.1-mini',
  instructions: [
    'Use checkBudget to inspect available spend before any paid call.',
    'Use requestPayment for every x402-gated operation.',
    'Respect session, per-call, category, and velocity constraints.',
  ].join(' '),
  tools: {
    checkBudget,
    requestPayment,
  },
};
