# x402 scanner-readiness recipe for AgentPay MCP

External scanners now need a cheap way to answer one question before they spend engineering time on a paid endpoint: does this service speak x402, and where is the protected endpoint?

This recipe makes that answer machine-readable without giving agents unlimited spending authority.

## What to expose

A scanner-ready AgentPay MCP demo should expose three public signals:

1. `X-X402-Supported: true` on the service home page or docs landing page.
2. A discoverable protected endpoint, normally `/protected` or `/api/protected`, that returns `402 Payment Required` before payment.
3. A `sitemap.xml` or docs page that lists the protected endpoint so crawlers do not have to guess paths.

The scanner metadata is not the payment control. It is a discovery layer. AgentPay MCP still owns approval, policy checks, spend caps, wallet signing, settlement audit rows, and fail-closed behavior.

## Minimal HTTP pattern

```ts
import http from "node:http";

const protectedUrl = "https://agentpay.example.com/protected";

http.createServer((request, response) => {
  response.setHeader("X-X402-Supported", "true");

  if (request.url === "/sitemap.xml") {
    response.setHeader("Content-Type", "application/xml");
    response.end(`<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>${protectedUrl}</loc></url>
</urlset>`);
    return;
  }

  if (request.url === "/protected") {
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
        resource: protectedUrl,
      }],
    }));
    return;
  }

  response.writeHead(200, { "Content-Type": "text/plain" });
  response.end("AgentPay MCP demo. See /sitemap.xml and /protected.\n");
}).listen(8787);
```

## AgentPay MCP payment flow

1. Scanner sees `X-X402-Supported: true` on `/`.
2. Scanner reads `/sitemap.xml` and finds `/protected`.
3. Scanner calls `/protected` and receives `402 Payment Required` plus x402 payment metadata.
4. The agent calls AgentPay MCP `x402_pay` with the protected URL.
5. AgentPay MCP checks policy before signing: daily cap, task cap, recipient allowlist, approval mode, and kill switch.
6. Only after approval does AgentPay MCP sign and retry the request.
7. The transaction history records URL, amount, chain, token, approval status, and settlement reference.

## Curl verification checklist

Run these commands against the demo or deployment:

```bash
$ curl -si https://agentpay.example.com/ | grep -i '^x-x402-supported:'
X-X402-Supported: true

$ curl -s https://agentpay.example.com/sitemap.xml | grep '/protected'
  <url><loc>https://agentpay.example.com/protected</loc></url>

$ curl -si https://agentpay.example.com/protected | head -n 8
HTTP/2 402
content-type: application/json
x-x402-supported: true
```

A scanner pass means discovery works. A production pass means discovery plus AgentPay MCP policy gates both work.

## Acceptance criteria

- Home or docs route returns `X-X402-Supported: true`.
- Sitemap or docs route links to the protected 402 endpoint.
- Protected endpoint returns HTTP 402 before payment.
- `x402_pay` cannot sign until AgentPay MCP policy approves the request.
- Audit output includes resource URL, amount, chain, approval decision, and settlement reference.
