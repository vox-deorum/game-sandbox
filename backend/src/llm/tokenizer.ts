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
    return this.tokenizer.encode(JSON.stringify(value)).length
  }
}
