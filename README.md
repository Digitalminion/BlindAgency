# BlindAgency

Most "bring your own key" integrations make a quiet trade: the user hands you their API key, you proxy it through your server, and you both try not to think too hard about where it ends up. BlindAgency takes that trade off the table.

The user's key is encrypted in their browser — using the Web Crypto API and an RSA public key fetched from your relay — before it leaves their device. Your server handles only ciphertext. The private key that can decrypt it lives exclusively in AWS KMS and never moves. The relay Lambda decrypts the key in memory for the duration of one outbound request, then the reference is gone. There is no database, no log line, and no code path through which the plaintext key can be persisted.

That's what "blind" means: the relay infrastructure is architecturally blind to the plaintext credential.

## Packages

| Package | npm | Description |
|---------|-----|-------------|
| [`@blindagency/browser`](./packages/browser) | [![npm](https://img.shields.io/npm/v/@blindagency/browser)](https://www.npmjs.com/package/@blindagency/browser) | Browser runtime: key encryption, hook-driven agent loop, thread management |
| [`@blindagency/aws`](./packages/aws) | [![npm](https://img.shields.io/npm/v/@blindagency/aws)](https://www.npmjs.com/package/@blindagency/aws) | CDK L3 construct: relay API, KMS key management, and automatic rotation |

## How it works

1. **The browser fetches a public key** from your relay endpoint and encrypts the user's API key with it using RSA-OAEP.
2. **The encrypted blob is stored in `sessionStorage`** — never the plaintext, never sent to your backend unencrypted.
3. **Each LLM request is relayed** through your endpoint. The Lambda decrypts the key in memory, constructs the provider request, nulls the reference, and fires the call.
4. **Keys rotate automatically** via a scheduled Lambda. The previous key stays valid for a grace window, then is permanently deleted from KMS.

## Agent runtime

The browser package includes a lightweight agent runtime. Rather than streaming raw LLM text, it drives the LLM through a structured hook protocol — the model responds exclusively with JSON describing what it wants to do, and the runtime executes it.

Three hook types cover most agent patterns:

- **Message hooks** are terminal — the LLM has finished its turn and wants to show the user something.
- **Context hooks** are a request for data — the LLM calls a hook, your handler fetches whatever it needs, and the result is injected back into the conversation before the LLM is re-invoked.
- **UI hooks** are side effects — highlight an element, trigger an animation, update state — nothing is returned to the LLM.

This structure keeps the LLM focused on decisions rather than formatting, and gives you clean control over what data it can access and when.

## License

Apache-2.0
