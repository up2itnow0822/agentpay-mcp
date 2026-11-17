/**
 * Install the redacting console sink before any tool module (viem / agentwallet-sdk)
 * is evaluated. Listed first among local imports in src/index.ts.
 */
import { installStdioConsoleSink } from './utils/sink.js'

installStdioConsoleSink()