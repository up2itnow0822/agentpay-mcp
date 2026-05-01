# x402 scanner-readiness recipe for AgentPay MCP

External scanners now need a cheap way to answer one question before they spend engineering time on a paid endpoint: does this service speak x402, and where is the protected endpoint?

This recipe makes that answer machine-readable without giving agents unlimited spending authority.

## What to expose

A scanner-ready AgentPay MCP demo should expose a dedicated, clean 402 probe route first:

1. `/api/x402/demo` returns `402 Payment Required` with `PAYMENT-REQUIRED` and x402 payment metadata. This is the scanner target.
2. `X-X402-Supported: true` on the service home page or docs landing page points humans and crawlers to x402 support.
3. A `sitemap.xml`, docs page, or `Link` header lists `/api/x402/demo` so crawlers do not have to guess paths.

Do not rely on headers, sitemap entries, or Link headers alone. The x402 Foundation scanner path changed after `/protected`, sitemap discovery, `Link` headers, and `X-X402-Supported` did not give isitagentready.com a stable pass. A clean API-style 402 route is now the recommended readiness signal.

The scanner route is not the payment control. It is a discovery layer. AgentPay MCP still owns approval, policy checks, spend caps, wallet signing, settlement audit rows, and fail-closed behavior.

## Minimal HTTP pattern

```ts
import http from "node:http";

const demoUrl = "https://agentpay.example.com/api/x402/demo";

http.createServer((request, response) => {
  response.setHeader("X-X402-Supported", "true");

  if (request.url === "/sitemap.xml") {
    response.setHeader("Content-Type", "application/xml");
    response.end(`<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>${demoUrl}</loc></url>
</urlset>`);
    return;
  }

  if (request.url === "/api/x402/demo") {
    response.writeHead(402, {
      "Content-Type": "application/json",
      "X-X402-Supported": "true",
    });
    response.end(JSON.stringify({
      error: "Payment Required",
      x402Version: "2",
      accepts: [{
        scheme: "exact",
        network: "base",
        amount: "10000",
        asset: "USDC",
        resource: demoUrl,
      }],
    }));
    return;
  }

  response.writeHead(200, { "Content-Type": "text/plain" });
  response.end("AgentPay MCP demo. See /sitemap.xml and /api/x402/demo.\n");
}).listen(8787);
```

## Runnable demo

A minimal Node route lives at `examples/x402-clean-demo/server.mjs`. It is intentionally small so teams can copy the scanner contract without copying wallet logic into the demo endpoint.

```bash
node examples/x402-clean-demo/server.mjs
curl -si http://127.0.0.1:8787/api/x402/demo | head -n 12
```

Expected result: HTTP `402`, `PAYMENT-REQUIRED: true`, `X-X402-Supported: true`, and a JSON body with x402 payment metadata.

## AgentPay MCP payment flow

1. Scanner calls `/api/x402/demo` and receives `402 Payment Required` plus x402 payment metadata.
2. Human readers and crawlers can also see `X-X402-Supported: true` on `/`.
3. Sitemap or `Link` metadata can point to `/api/x402/demo`, but the clean 402 route is the source of truth.
4. The agent calls AgentPay MCP `x402_pay` with the protected URL.
5. AgentPay MCP checks policy before signing: daily cap, task cap, recipient allowlist, approval mode, and kill switch.
6. Only after approval does AgentPay MCP sign and retry the request.
7. The transaction history records URL, amount, chain, token, approval status, and settlement reference.

## Curl verification checklist

Run these commands against the demo or deployment:

```bash
$ curl -si https://agentpay.example.com/ | grep -i '^x-x402-supported:'
X-X402-Supported: true

$ curl -s https://agentpay.example.com/sitemap.xml | grep '/api/x402/demo'
  <url><loc>https://agentpay.example.com/api/x402/demo</loc></url>

$ curl -si https://agentpay.example.com/api/x402/demo | head -n 8
HTTP/2 402
content-type: application/json
x-x402-supported: true
payment-required: true
```

A scanner pass means discovery works. A production pass means discovery plus AgentPay MCP policy gates both work.

## Acceptance criteria

- `/api/x402/demo` returns HTTP 402 before payment.
- The 402 response includes `PAYMENT-REQUIRED` and x402 payment metadata.
- Home or docs route returns `X-X402-Supported: true`.
- Sitemap, docs, or `Link` metadata points to `/api/x402/demo`, but verification does not depend on metadata alone.
- `x402_pay` cannot sign until AgentPay MCP policy approves the request.
- Audit output includes resource URL, amount, chain, approval decision, and settlement reference.
