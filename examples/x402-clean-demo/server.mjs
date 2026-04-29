import http from "node:http";

const host = process.env.HOST || "127.0.0.1";
const port = Number(process.env.PORT || 8787);
const publicBaseUrl = process.env.PUBLIC_BASE_URL || `http://${host}:${port}`;
const demoResource = `${publicBaseUrl}/api/x402/demo`;

function writeJson(response, statusCode, headers, body) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json",
    ...headers,
  });
  response.end(JSON.stringify(body, null, 2));
}

const server = http.createServer((request, response) => {
  if (request.url === "/" || request.url === "/docs") {
    response.writeHead(200, {
      "Content-Type": "text/plain",
      "X-X402-Supported": "true",
      Link: `</api/x402/demo>; rel="payment"`,
    });
    response.end(`AgentPay MCP x402 demo\nClean scanner route: ${demoResource}\n`);
    return;
  }

  if (request.url === "/sitemap.xml") {
    response.writeHead(200, { "Content-Type": "application/xml" });
    response.end(`<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>${demoResource}</loc></url>
</urlset>`);
    return;
  }

  if (request.url === "/api/x402/demo") {
    writeJson(
      response,
      402,
      {
        "X-X402-Supported": "true",
        "PAYMENT-REQUIRED": "true",
      },
      {
        error: "Payment Required",
        x402Version: "2",
        accepts: [
          {
            scheme: "exact",
            network: "base",
            amount: "10000",
            asset: "USDC",
            resource: demoResource,
          },
        ],
      },
    );
    return;
  }

  writeJson(response, 404, {}, { error: "not_found" });
});

server.listen(port, host, () => {
  console.log(`AgentPay MCP x402 scanner demo listening on ${publicBaseUrl}`);
  console.log(`Verify: curl -si ${demoResource}`);
});
