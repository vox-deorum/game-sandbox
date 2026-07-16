import { get_encoding, type Tiktoken, type TiktokenEncoding } from 'tiktoken'

export interface LlmTokenCounter {
  countRequest(request: Readonly<Record<string, unknown>>): number
  countCompletion(completion: Readonly<Record<string, unknown>>): number
}

/** Deterministic fallback accounting over the exact JSON documents retained in telemetry. */
export class TiktokenCounter implements LlmTokenCounter {
  private readonly tokenizer: Tiktoken

  constructor(encoding: TiktokenEncoding) {
    this.tokenizer = get_encoding(encoding)
  }

  countRequest(request: Readonly<Record<string, unknown>>): number {
    return this.countJson(request)
  }

  countCompletion(completion: Readonly<Record<string, unknown>>): number {
    return this.countJson(completion)
  }

  close(): void {
    this.tokenizer.free()
  }

  private countJson(value: unknown): number {
    // Agent prompts are arbitrary text. `encode()` rejects strings that look like reserved model
    // tokens by default, while ordinary encoding treats those same bytes as content and cannot turn
    // a participant-controlled prompt into a metering failure.
    return this.tokenizer.encode_ordinary(JSON.stringify(value)).length
  }
}
