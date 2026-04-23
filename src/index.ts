#!/usr/bin/env node
/**
 * AgentPay MCP Server — Entry Point
 *
 * Exposes Agent Wallet SDK tools via the Model Context Protocol (MCP).
 * Compatible with Claude Desktop, Cursor, Windsurf, and any MCP client.
 *
 * v1.1.0 adds x402 V2 session payment support:
 *   - x402_session_start  — pay once, receive a signed session token
 *   - x402_session_fetch  — make N calls within a session (no new payments)
 *   - x402_session_status — inspect active sessions and TTL
 *   - x402_session_end    — close a session explicitly
 *
 * Transport: stdio (standard MCP transport)
 * Config:    AGENT_PRIVATE_KEY + AGENT_WALLET_ADDRESS env vars required
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolRequest,
} from '@modelcontextprotocol/sdk/types.js';

// ─── Tool imports (v1.0.0) ─────────────────────────────────────────────────

import { deployWalletTool, handleDeployWallet, DeployWalletSchema } from './tools/deploy.js';
import { getWalletInfoTool, handleGetWalletInfo, GetWalletInfoSchema } from './tools/wallet.js';
import { checkSpendLimitTool, handleCheckSpendLimit, CheckSpendLimitSchema } from './tools/wallet.js';
import { queueApprovalTool, handleQueueApproval, QueueApprovalSchema } from './tools/wallet.js';
import { sendPaymentTool, handleSendPayment, SendPaymentSchema } from './tools/payments.js';
import { x402PayTool, handleX402Pay, X402PaySchema } from './tools/x402.js';
import { getTransactionHistoryTool, handleGetTransactionHistory, GetTransactionHistorySchema } from './tools/history.js';

// ─── Tool imports (v1.1.0 — x402 V2 session payments) ─────────────────────

import {
  x402SessionStartTool,
  handleX402SessionStart,
  X402SessionStartSchema,
  x402SessionFetchTool,
  handleX402SessionFetch,
  X402SessionFetchSchema,
  x402SessionStatusTool,
  handleX402SessionStatus,
  X402SessionStatusSchema,
  x402SessionEndTool,
  handleX402SessionEnd,
  X402SessionEndSchema,
} from './tools/session.js';

// ─── Tool imports (v4.0.0 — tokens, transfers, swap, bridge, budget, identity, escrow) ──

import {
  lookupTokenTool,
  handleLookupToken,
  LookupTokenSchema,
  addCustomTokenTool,
  handleAddCustomToken,
  AddCustomTokenSchema,
  listChainTokensTool,
  handleListChainTokens,
  ListChainTokensSchema,
} from './tools/tokens.js';

import {
  sendTokenTool,
  handleSendToken,
  SendTokenSchema,
  getBalancesTool,
  handleGetBalances,
  GetBalancesSchema,
} from './tools/transfers.js';

import { swapTokensTool, handleSwapTokens, SwapTokensSchema } from './tools/swap.js';

import { bridgeUsdcTool, handleBridgeUsdc, BridgeUsdcSchema } from './tools/bridge.js';

import {
  setSpendPolicyTool,
  handleSetSpendPolicy,
  SetSpendPolicySchema,
  checkBudgetTool,
  handleCheckBudget,
  CheckBudgetSchema,
} from './tools/budget.js';

import {
  verifyAgentIdentityTool,
  handleVerifyAgentIdentity,
  VerifyAgentIdentitySchema,
  getReputationTool,
  handleGetReputation,
  GetReputationSchema,
  verifyAgentUAIDTool,
  handleVerifyAgentUAID,
  VerifyAgentUAIDSchema,
} from './tools/identity.js';

import { createEscrowTool, handleCreateEscrow, CreateEscrowSchema } from './tools/escrow.js';

// ─── Tool imports (v4.2.0 — OTel budget circuit-breaker for AWS AgentCore) ──

import {
  otelRegisterPolicyTool,
  handleOTelRegisterPolicy,
  OTelRegisterPolicySchema,
  otelEvaluateSpendTool,
  handleOTelEvaluateSpend,
  OTelEvaluateSpendSchema,
  otelBudgetStatusTool,
  handleOTelBudgetStatus,
  OTelBudgetStatusSchema,
} from './tools/otel-budget.js';

// ─── Server configuration ──────────────────────────────────────────────────

const SERVER_INFO = {
  name: 'agentpay-mcp',
  version: '4.0.0',
};

const SERVER_CAPABILITIES = {
  tools: {},
};

// ─── Tool registry ─────────────────────────────────────────────────────────

const ALL_TOOLS = [
  // v1.0.0 tools
  deployWalletTool,
  getWalletInfoTool,
  sendPaymentTool,
  checkSpendLimitTool,
  queueApprovalTool,
  x402PayTool,
  getTransactionHistoryTool,
  // v1.1.0 — x402 V2 session tools
  x402SessionStartTool,
  x402SessionFetchTool,
  x402SessionStatusTool,
  x402SessionEndTool,
  // v4.0.0 — tokens
  lookupTokenTool,
  addCustomTokenTool,
  listChainTokensTool,
  // v4.0.0 — transfers
  sendTokenTool,
  getBalancesTool,
  // v4.0.0 — swap
  swapTokensTool,
  // v4.0.0 — bridge
  bridgeUsdcTool,
  // v4.0.0 — budget
  setSpendPolicyTool,
  checkBudgetTool,
  // v4.0.0 — identity
  verifyAgentIdentityTool,
  getReputationTool,
  // v6.1.0 — cross-chain identity (UAID)
  verifyAgentUAIDTool,
  // v4.0.0 — escrow
  createEscrowTool,
  // v4.2.0 — OTel budget circuit-breaker (AWS AgentCore integration)
  otelRegisterPolicyTool,
  otelEvaluateSpendTool,
  otelBudgetStatusTool,
];

// ─── Server initialization ─────────────────────────────────────────────────

const server = new Server(SERVER_INFO, {
  capabilities: SERVER_CAPABILITIES,
});

// ─── List tools handler ────────────────────────────────────────────────────

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: ALL_TOOLS,
  };
});

// ─── Call tool handler ─────────────────────────────────────────────────────

server.setRequestHandler(CallToolRequestSchema, async (request: CallToolRequest) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      // ── v1.0.0 tools ──────────────────────────────────────────────────

      case 'deploy_wallet': {
        const input = DeployWalletSchema.parse(args);
        return handleDeployWallet(input);
      }

      case 'get_wallet_info': {
        const input = GetWalletInfoSchema.parse(args ?? {});
        return handleGetWalletInfo(input);
      }

      case 'send_payment': {
        const input = SendPaymentSchema.parse(args);
        return handleSendPayment(input);
      }

      case 'check_spend_limit': {
        const input = CheckSpendLimitSchema.parse(args);
        return handleCheckSpendLimit(input);
      }

      case 'queue_approval': {
        const input = QueueApprovalSchema.parse(args);
        return handleQueueApproval(input);
      }

      case 'x402_pay': {
        const input = X402PaySchema.parse(args);
        return handleX402Pay(input);
      }

      case 'get_transaction_history': {
        const input = GetTransactionHistorySchema.parse(args ?? {});
        return handleGetTransactionHistory(input);
      }

      // ── v1.1.0 — x402 V2 session tools ───────────────────────────────

      case 'x402_session_start': {
        const input = X402SessionStartSchema.parse(args);
        return handleX402SessionStart(input);
      }

      case 'x402_session_fetch': {
        const input = X402SessionFetchSchema.parse(args);
        return handleX402SessionFetch(input);
      }

      case 'x402_session_status': {
        const input = X402SessionStatusSchema.parse(args ?? {});
        return handleX402SessionStatus(input);
      }

      case 'x402_session_end': {
        const input = X402SessionEndSchema.parse(args);
        return handleX402SessionEnd(input);
      }

      // ── v4.0.0 — tokens ───────────────────────────────────────────────

      case 'lookup_token': {
        const input = LookupTokenSchema.parse(args);
        return handleLookupToken(input);
      }

      case 'add_custom_token': {
        const input = AddCustomTokenSchema.parse(args);
        return handleAddCustomToken(input);
      }

      case 'list_chain_tokens': {
        const input = ListChainTokensSchema.parse(args);
        return handleListChainTokens(input);
      }

      // ── v4.0.0 — transfers ────────────────────────────────────────────

      case 'send_token': {
        const input = SendTokenSchema.parse(args);
        return handleSendToken(input);
      }

      case 'get_balances': {
        const input = GetBalancesSchema.parse(args ?? {});
        return handleGetBalances(input);
      }

      // ── v4.0.0 — swap ─────────────────────────────────────────────────

      case 'swap_tokens': {
        const input = SwapTokensSchema.parse(args);
        return handleSwapTokens(input);
      }

      // ── v4.0.0 — bridge ───────────────────────────────────────────────

      case 'bridge_usdc': {
        const input = BridgeUsdcSchema.parse(args);
        return handleBridgeUsdc(input);
      }

      // ── v4.0.0 — budget ───────────────────────────────────────────────

      case 'set_spend_policy': {
        const input = SetSpendPolicySchema.parse(args ?? {});
        return handleSetSpendPolicy(input);
      }

      case 'check_budget': {
        const input = CheckBudgetSchema.parse(args ?? {});
        return handleCheckBudget(input);
      }

      // ── v4.0.0 — identity ─────────────────────────────────────────────

      case 'verify_agent_identity': {
        const input = VerifyAgentIdentitySchema.parse(args);
        return handleVerifyAgentIdentity(input);
      }

      case 'get_reputation': {
        const input = GetReputationSchema.parse(args);
        return handleGetReputation(input);
      }

      // ── v6.1.0 — cross-chain identity (UAID) ─────────────────────────

      case 'verify_agent_uaid': {
        const input = VerifyAgentUAIDSchema.parse(args);
        return handleVerifyAgentUAID(input);
      }

      // ── v4.0.0 — escrow ───────────────────────────────────────────────

      case 'create_escrow': {
        const input = CreateEscrowSchema.parse(args);
        return handleCreateEscrow(input);
      }

      // ── v4.2.0 — OTel budget circuit-breaker ─────────────────────────

      case 'otel_register_budget_policy': {
        const input = OTelRegisterPolicySchema.parse(args);
        return handleOTelRegisterPolicy(input);
      }

      case 'otel_evaluate_spend': {
        const input = OTelEvaluateSpendSchema.parse(args);
        return handleOTelEvaluateSpend(input);
      }

      case 'otel_budget_status': {
        const input = OTelBudgetStatusSchema.parse(args);
        return handleOTelBudgetStatus(input);
      }

      default:
        return {
          content: [
            {
              type: 'text' as const,
              text: `❌ Unknown tool: "${name}". Available tools: ${ALL_TOOLS.map(t => t.name).join(', ')}`,
            },
          ],
          isError: true,
        };
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: [
        {
          type: 'text' as const,
          text: `❌ Tool "${name}" failed: ${message}`,
        },
      ],
      isError: true,
    };
  }
});

// ─── Start server ──────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const transport = new StdioServerTransport();

  // Graceful shutdown
  process.on('SIGINT', async () => {
    await server.close();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    await server.close();
    process.exit(0);
  });

  await server.connect(transport);

  // Log to stderr (not stdout — stdout is reserved for MCP protocol)
  process.stderr.write(
    `AgentPay MCP v1.1.0 started. ` +
    `Wallet: ${process.env['AGENT_WALLET_ADDRESS'] ?? '(not configured)'} | ` +
    `Chain: ${process.env['CHAIN_ID'] ?? '8453 (Base Mainnet)'} | ` +
    `Session TTL: ${process.env['SESSION_TTL_SECONDS'] ?? '3600'}s\n`
  );
}

main().catch((error: unknown) => {
  const msg = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Fatal error starting AgentPay MCP: ${msg}\n`);
  process.exit(1);
});
