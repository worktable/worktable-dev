/** Small independent state seam shared by network writes and draft persistence. */
let frozen = false
let epoch: string | null = null
export function workspaceWritesFrozen(): boolean {
  return frozen
}
export function setWorkspaceWritesFrozen(value: boolean): void {
  frozen = value
}
export function currentWorkspaceContentEpoch(): string | null {
  return epoch
}
export function setCurrentWorkspaceContentEpoch(value: string): void {
  epoch = value
}
