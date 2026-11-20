// Small, valid PDFs built in a test, so a reader's behaviour is checked on
// known bytes without fixture files: pages with text, a page that is only a
// picture, a blank page, and a file that says it is encrypted.

export type SmallPdfPage = { text: string } | { picture: true } | { blank: true }

/** A PDF of these pages, with a correct cross-reference table. */
export function smallPdf(pages: SmallPdfPage[], options: { encrypted?: boolean } = {}): Uint8Array {
  const objects: string[] = []
  const add = (body: string) => {
    objects.push(body)
    return objects.length
  }
  const catalog = add("") // filled in once the page tree's number is known
  const font = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>")
  const pageIds: number[] = []
  const tree = add("")
  for (const page of pages) {
    let resources = ""
    let content = ""
    if ("text" in page) {
      const lines = page.text.split("\n")
      content = `BT /F1 12 Tf 72 720 Td 14 TL ${lines
        .map((line) => `(${line.replace(/[\\()]/g, (c) => `\\${c}`)}) Tj T*`)
        .join(" ")} ET`
      resources = `/Resources << /Font << /F1 ${font} 0 R >> >>`
    } else if ("picture" in page) {
      const image = add(
        "<< /Type /XObject /Subtype /Image /Width 2 /Height 2 /ColorSpace /DeviceGray " +
          "/BitsPerComponent 8 /Length 4 >>\nstream\n\u0000ÿÿ\u0000\nendstream"
      )
      content = "q 400 0 0 400 100 200 cm /Im1 Do Q"
      resources = `/Resources << /XObject << /Im1 ${image} 0 R >> >>`
    }
    const stream = add(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`)
    pageIds.push(
      add(
        `<< /Type /Page /Parent ${tree} 0 R /MediaBox [0 0 612 792] ${resources} /Contents ${stream} 0 R >>`
      )
    )
  }
  objects[catalog - 1] = `<< /Type /Catalog /Pages ${tree} 0 R >>`
  objects[tree - 1] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageIds.length} >>`
  const encrypt = options.encrypted
    ? add(
        "<< /Filter /Standard /V 1 /R 2 /O (0123456789abcdef0123456789abcdef) " +
          "/U (0123456789abcdef0123456789abcdef) /P -4 >>"
      )
    : null
  let pdf = "%PDF-1.4\n"
  const offsets: number[] = []
  objects.forEach((body, index) => {
    offsets.push(pdf.length)
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`
  })
  const xref = pdf.length
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const offset of offsets) pdf += `${String(offset).padStart(10, "0")} 00000 n \n`
  pdf +=
    `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R` +
    (encrypt ? ` /Encrypt ${encrypt} 0 R /ID [<0123456789abcdef> <0123456789abcdef>]` : "") +
    ` >>\nstartxref\n${xref}\n%%EOF\n`
  // Latin-1, so the image's bytes are written as themselves.
  return Uint8Array.from(pdf, (c) => c.charCodeAt(0))
}
