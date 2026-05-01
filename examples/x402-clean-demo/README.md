# x402 clean 402 scanner demo

This tiny HTTP server gives scanners a stable x402 probe path:

- `/api/x402/demo` returns a clean `402 Payment Required` response.
- The response includes `PAYMENT-REQUIRED` and `X-X402-Supported` headers.
- `/`, `/docs`, and `/sitemap.xml` point to the same demo route, but scanners should not depend on those hints alone.

Run it:

```bash
node examples/x402-clean-demo/server.mjs
curl -si http://127.0.0.1:8787/api/x402/demo | head -n 12
```

Expected proof:

```text
HTTP/1.1 402 Payment Required
Content-Type: application/json
X-X402-Supported: true
PAYMENT-REQUIRED: true
```
