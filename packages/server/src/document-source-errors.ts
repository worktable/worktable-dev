export type DocumentSourceReadFailure =
  | "too-large"
  | "invalid-source"
  | "temporarily-unavailable"

/** Shared by format adapters and the source reader without importing storage. */
export class DocumentSourceReadError extends Error {
  readonly reason: DocumentSourceReadFailure

  constructor(reason: DocumentSourceReadFailure, message: string) {
    super(message)
    this.reason = reason
  }
}
