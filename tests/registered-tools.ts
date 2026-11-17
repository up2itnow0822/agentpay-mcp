/**
 * Mirrors src/index.ts ALL_TOOLS for registry assertions (does not boot the server).
 */
import { deployWalletTool } from '../src/tools/deploy.js'
import { getWalletInfoTool, checkSpendLimitTool, queueApprovalTool } from '../src/tools/wallet.js'
import { sendPaymentTool } from '../src/tools/payments.js'
import { x402PayTool, x402QuoteTool } from '../src/tools/x402.js'
import { getTransactionHistoryTool } from '../src/tools/history.js'
import {
  x402SessionStartTool,
  x402SessionFetchTool,
  x402SessionStatusTool,
  x402SessionEndTool,
} from '../src/tools/session.js'
import { lookupTokenTool, addCustomTokenTool, listChainTokensTool } from '../src/tools/tokens.js'
import { sendTokenTool, getBalancesTool } from '../src/tools/transfers.js'
import { swapTokensTool } from '../src/tools/swap.js'
import { bridgeUsdcTool } from '../src/tools/bridge.js'
import { setSpendPolicyTool, checkBudgetTool } from '../src/tools/budget.js'
import { verifyAgentIdentityTool, getReputationTool, verifyAgentUAIDTool } from '../src/tools/identity.js'
import { createEscrowTool } from '../src/tools/escrow.js'
import {
  otelRegisterPolicyTool,
  otelEvaluateSpendTool,
  otelBudgetStatusTool,
} from '../src/tools/otel-budget.js'

export const REGISTERED_TOOLS = [
  deployWalletTool,
  getWalletInfoTool,
  sendPaymentTool,
  checkSpendLimitTool,
  queueApprovalTool,
  x402PayTool,
  x402QuoteTool,
  getTransactionHistoryTool,
  x402SessionStartTool,
  x402SessionFetchTool,
  x402SessionStatusTool,
  x402SessionEndTool,
  lookupTokenTool,
  addCustomTokenTool,
  listChainTokensTool,
  sendTokenTool,
  getBalancesTool,
  swapTokensTool,
  bridgeUsdcTool,
  setSpendPolicyTool,
  checkBudgetTool,
  verifyAgentIdentityTool,
  getReputationTool,
  verifyAgentUAIDTool,
  createEscrowTool,
  otelRegisterPolicyTool,
  otelEvaluateSpendTool,
  otelBudgetStatusTool,
] as const