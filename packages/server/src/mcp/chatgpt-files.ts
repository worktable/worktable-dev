// Files a person attaches in ChatGPT. A tool that marks a parameter as a
// file (`_meta["openai/fileParams"]`) receives, instead of the bytes, a
// short-lived link to them on OpenAI's file hosts, and fetches them itself.
// On the preview surface.

import type { z } from "zod"
import {
  FILE_UPLOAD_MAX_BYTES,
  FILE_UPLOAD_TOO_LARGE,
  readLimitedBody,
} from "../file-uploads.ts"
import type { ChatGptFileInput } from "./schemas.ts"

export type ChatGptFile = z.infer<typeof ChatGptFileInput>

// OpenAI serves these links from files.oaiusercontent.com and from regional
// hosts such as sdmntprwestus.oaiusercontent.com. Nothing else is fetched:
// the link comes from the caller, so any other host would let a tool call
// make this server request an address of the caller's choosing.
const CHATGPT_FILE_HOST =
  /^(?:files|sdmntpr[a-z0-9]{1,32})\.oaiusercontent\.com$/
const FETCH_TIMEOUT_MS = 60_000

/** Whether a link names a file on ChatGPT's file hosts, over HTTPS. */
export function isChatGptFileUrl(value: string): boolean {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return false
  }
  return (
    url.protocol === "https:" &&
    url.port === "" &&
    url.username === "" &&
    url.password === "" &&
    CHATGPT_FILE_HOST.test(url.hostname)
  )
}

/** The bytes of a file attached in ChatGPT, or why they couldn't be read. */
export async function fetchChatGptFile(
  file: ChatGptFile,
  signal?: AbortSignal
): Promise<Uint8Array> {
  if (!isChatGptFileUrl(file.download_url)) {
    throw new Error(
      "file.download_url must be a ChatGPT file link. Attach the file in ChatGPT, or use upload without file for a link to send it to."
    )
  }
  const timeout = AbortSignal.timeout(FETCH_TIMEOUT_MS)
  const response = await fetch(file.download_url, {
    redirect: "manual",
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  }).catch(() => {
    throw new Error("ChatGPT's link to the file didn't answer. Try again.")
  })
  if (!response.ok) {
    await response.body?.cancel()
    throw new Error(
      "ChatGPT's link to the file has expired or was refused. Attach the file again."
    )
  }
  const bytes = await readLimitedBody(response, FILE_UPLOAD_MAX_BYTES)
  if (!bytes) throw new Error(FILE_UPLOAD_TOO_LARGE)
  return bytes
}
