// ============================================================
// What a file's reader gives, and how a parse job crosses to its worker
// ============================================================
//
// A reader takes a file's bytes and gives generic output: stretches of text
// with a label each, a few named facts, and what it leaves out. Nothing
// above a reader knows what a PDF or a workbook is, so a new type adds a
// reader and nothing else.
//
// Readers that parse untrusted formats run in a worker process of their own
// (contents-worker.ts), started by the lane (contents-lane.ts). The lane
// writes one line of JSON naming the reader, then the file's bytes, to the
// worker's standard input, and reads one line of JSON back.
//
// This module holds only types and constants, so the worker loads nothing
// else of the server.

/** The command line word that starts the server executable as a worker. */
export const CONTENTS_WORKER_COMMAND = "contents-worker"

/** A stretch of a file's text, and where in the file it is. */
export interface ContentsPart {
  /** Where it is, as a person would say it: "Page 12", "Sheet: Budget". */
  label: string
  text: string
}

/** Something a reader leaves out: where, when it is one place, and why. */
export interface ContentsGap {
  where?: string
  why: string
}

/** What a reader gives for a file. */
export interface ContentsOutput {
  parts: ContentsPart[]
  /** Small named values, such as pages or sheets. */
  facts: Record<string, string | number | boolean>
  gaps: ContentsGap[]
}

/**
 * Why a reader gave no contents: the file is encrypted, damaged, of a kind
 * the reader doesn't read, past what it reads, or the reader failed.
 */
export type ContentsRefusal =
  | "encrypted"
  | "damaged"
  | "unsupported"
  | "too-large"
  | "failed"

/** A reader's refusal, with words for the person or agent asking. */
export class ReaderRefused extends Error {
  readonly reason: ContentsRefusal
  constructor(reason: ContentsRefusal, message: string) {
    super(message)
    this.name = "ReaderRefused"
    this.reason = reason
  }
}

/** A reader that runs in the worker: bytes in, generic output out. */
export interface ParsingReader {
  /** Its version: output from an older one is read again. */
  version: number
  read(bytes: Uint8Array): Promise<ContentsOutput>
}

/** The first line the lane writes to a worker. */
export interface WorkerJobHeader {
  reader: string
}

/** The one line a worker writes back. */
export type WorkerReply =
  | { ok: true; output: ContentsOutput }
  | { ok: false; reason: ContentsRefusal; message: string }
