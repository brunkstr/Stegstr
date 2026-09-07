# Adding a hiding method (codec)

Stegstr can read images made by every method it has ever shipped, and writes with one default. Methods live in `src/codecs/` and are tried in a fixed order by `decodeAny()`. This is the extension point: a new method is a new module, not a fork.

## The contract

Implement `Codec` from `src/codecs/types.ts`:

| Member | What it must do |
|---|---|
| `id`, `label`, `description` | Stable id (lowercase, no spaces), a short UI name, one honest sentence on what survives and what it costs. |
| `container` | `"jpeg"` or `"png"`; decides the output extension. |
| `accepts(file)` | Cheap pre-check so expensive decodes are skipped for files that cannot carry this method (e.g. only JPEG). |
| `decode(file)` | Return `{ ok, payload }` only after verifying the payload (checksum, self-test). Never throw for an ordinary file; return `{ ok: false, error }`. |
| `encode(cover, payload, opts)` | Hide the bytes, then decode your own output before returning. Throw if the round-trip fails: an image that looks fine and carries nothing is the worst outcome. |
| `capacityBytes(cover, opts)` | Optional. Lets the app say "too big" before trying. |

## Registering

```ts
import { registerCodec } from "./codecs/registry";
import { myCodec } from "./codecs/my-codec";
registerCodec(myCodec, "dot"); // robust JPEG codecs go before the Dot catch-all
```

Decode order is meaningful: methods that only accept JPEG go first; Dot accepts anything and stays last.

## Verification before it ships

1. Unit tests for the adapter (`src/__tests__/`).
2. Round-trip on three covers (busy, gradient, texture) through the five compression profiles in `contest/gauntlet`, blind (the encoder is not told the profile). Report survival per profile and PSNR.
3. Cross-decode: images from your codec decode in the CLI and the web build, and images from the other codecs still decode after your change.

## Payload format note

All contest-era methods tag payloads with `STEGSTR1` but lay them out differently, so magic bytes alone do not identify a method. New methods should use a distinct magic of their own so they can be recognised without a trial decode.
