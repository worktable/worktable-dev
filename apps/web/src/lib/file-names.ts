/**
 * The name a renamed file takes: what was typed, keeping the file's
 * extension when the new name gives none, so renaming error.png to Error
 * can't leave a file that nothing can show.
 */
export function renamedFileName(current: string, typed: string): string {
  const extension = /\.[^./]+$/.exec(current)?.[0] ?? ""
  return extension && !/[^.]\.[^./]+$/.test(typed) ? `${typed}${extension}` : typed
}
