export interface DeveloperIdExpectation {
  signingIdentity: string
  teamId: string
}

export function assertDeveloperIdSignature(
  details: string,
  signedPath: string,
  expectation: DeveloperIdExpectation,
  options: { hardenedRuntime: boolean }
): void {
  for (const expected of [
    `Authority=${expectation.signingIdentity}`,
    `TeamIdentifier=${expectation.teamId}`,
  ]) {
    if (!details.includes(expected)) {
      throw new Error(`${signedPath} signature is missing ${expected}`)
    }
  }
  const timestamp = details.match(/^Timestamp=(.+)$/m)?.[1]?.trim()
  if (!timestamp || timestamp === "none") {
    throw new Error(`${signedPath} is missing a secure signing timestamp`)
  }
  if (options.hardenedRuntime && !/flags=.*\(.*runtime.*\)/.test(details)) {
    throw new Error(`${signedPath} is missing the hardened runtime signature`)
  }
}
