# BlindAgency

A browser-native LLM agent runtime with a privacy-first key relay. Users bring their own API key — it is encrypted in the browser before it leaves their device, and the server never stores it.

## How it works

1. **The browser fetches a public key** from your relay endpoint and encrypts the user's API key with it using the Web Crypto API (RSA-OAEP).
2. **The encrypted blob is stored in `sessionStorage`** — never in plain text, never sent to your backend unencrypted.
3. **Each LLM request is relayed** through your endpoint. The Lambda decrypts the key, constructs the provider request, nulls the reference, and fires the call. The decrypted key exists in memory only for the duration of request construction.
4. **Keys rotate hourly** via a scheduled Lambda. The previous key stays valid for a grace window, then is permanently deleted from KMS.

The server cannot log, persist, or exfiltrate the API key — the architecture makes it structurally impossible.

## Packages

| Package | npm | Description |
|---------|-----|-------------|
| [`@blindagency/browser`](./packages/browser) | [![npm](https://img.shields.io/npm/v/@blindagency/browser)](https://www.npmjs.com/package/@blindagency/browser) | Browser runtime: key encryption, hook-driven agent loop, conversation management |
| [`@blindagency/aws`](./packages/aws) | [![npm](https://img.shields.io/npm/v/@blindagency/aws)](https://www.npmjs.com/package/@blindagency/aws) | CDK L3 construct: deploys the relay API, KMS key management, and rotation schedule |

## Agent runtime

The browser package includes a lightweight agent runtime that drives LLM conversations through a **three-hook protocol**:

- **Message hooks** — terminal, display a response to the user
- **Context hooks** — fetch data and re-invoke the LLM with the result injected into the conversation
- **UI hooks** — trigger side effects on the page

The LLM is instructed to respond exclusively with structured JSON (`{ "invocations": [...] }`). The runtime processes invocations in order, handles context loops up to a configurable depth, and enforces the protocol at the Lambda boundary — if the LLM goes off-script and returns non-JSON, the relay returns a `422 PROTOCOL_VIOLATION` before the browser sees it.

## License

MIT
