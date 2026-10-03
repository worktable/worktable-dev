/**
 * A change to a rich Doc as the top-level blocks it replaced, so it can be
 * applied to a newer state of the same document — the Doc open in a live
 * session — without touching any other block.
 *
 * `narrowRegions` reduces the regions an edit reports to the blocks that
 * actually changed. `rebaseRegions` applies them to the current top-level
 * blocks by id: replaced blocks must still be there, next to each other, and
 * (when asked) unchanged since the base the edit was made against.
 */

type Block = Record<string, any>

export interface BlockRegion {
  /** Ids of the base document's top-level blocks this region replaces, in order. */
  replacedBlockIds: string[]
  /** The blocks now in their place. A kept or edited block keeps its id. */
  blocks: Block[]
  /** The unchanged top-level block just before the region in the base, if any. */
  precedingBlockId?: string
  /** The unchanged top-level block just after the region in the base, if any. */
  followingBlockId?: string
}

const serialized = new WeakMap<Block, string>()

function serialize(block: Block): string {
  let text = serialized.get(block)
  if (text === undefined) {
    text = JSON.stringify(block)
    serialized.set(block, text)
  }
  return text
}

function sameBlock(left: Block | undefined, right: Block | undefined): boolean {
  if (!left || !right || left.id !== right.id) return false
  return left === right || serialize(left) === serialize(right)
}

/**
 * The regions of a change reduced to the top-level blocks that differ: inside
 * each region, blocks that are identical to the base block with the same id
 * (and in the same order) are left out, and regions that touch are merged, so
 * every region sits between unchanged blocks of the base.
 */
export function narrowRegions(
  base: readonly Block[],
  regions: ReadonlyArray<{ replacedBlockIds: readonly string[]; blocks: readonly Block[]; followingBlockId?: string }>
): BlockRegion[] {
  const position = new Map<string, number>()
  base.forEach((block, index) => {
    if (typeof block?.id === "string") position.set(block.id, index)
  })
  // Narrowed pieces as base index ranges [from, to) and their new blocks.
  const pieces: Array<{ from: number; to: number; blocks: Block[] }> = []
  for (const region of regions) {
    const indexes = region.replacedBlockIds.map((id) => position.get(id))
    if (indexes.some((index) => index === undefined)) {
      throw new Error("a region replaces a block that is not in the base document")
    }
    let from: number
    if (indexes.length > 0) {
      from = indexes[0]!
      indexes.forEach((index, offset) => {
        if (index !== from + offset) throw new Error("a region's replaced blocks are not contiguous")
      })
    } else {
      from = region.followingBlockId === undefined ? base.length : position.get(region.followingBlockId) ?? -1
      if (from === -1) throw new Error("a region follows a block that is not in the base document")
    }
    const replaced = base.slice(from, from + indexes.length)
    const next = [...region.blocks]
    const matches = commonBlocks(replaced, next)
    let r = 0
    let n = 0
    for (const [mr, mn] of [...matches, [replaced.length, next.length] as const]) {
      if (mr > r || mn > n) {
        pieces.push({ from: from + r, to: from + mr, blocks: next.slice(n, mn) })
      }
      r = mr + 1
      n = mn + 1
    }
  }
  pieces.sort((left, right) => left.from - right.from || left.to - right.to)
  const merged: typeof pieces = []
  for (const piece of pieces) {
    const last = merged.at(-1)
    if (last && piece.from <= last.to) {
      last.to = Math.max(last.to, piece.to)
      last.blocks.push(...piece.blocks)
    } else {
      merged.push({ ...piece, blocks: [...piece.blocks] })
    }
  }
  return merged.map(({ from, to, blocks }) => ({
    replacedBlockIds: base.slice(from, to).map((block) => String(block.id)),
    blocks,
    ...(from > 0 ? { precedingBlockId: String(base[from - 1]!.id) } : {}),
    ...(to < base.length ? { followingBlockId: String(base[to]!.id) } : {}),
  }))
}

/**
 * Index pairs of identical blocks, in order, as many as possible. Identical
 * blocks share an id, and ids are unique within a document, so each block
 * has at most one candidate: the longest common subsequence is the longest
 * increasing run of candidate positions, found in O(n log n).
 */
function commonBlocks(left: readonly Block[], right: readonly Block[]): Array<readonly [number, number]> {
  const rightIndex = new Map<string, number>()
  right.forEach((block, index) => {
    if (typeof block?.id === "string" && !rightIndex.has(block.id)) rightIndex.set(block.id, index)
  })
  const candidates: Array<readonly [number, number]> = []
  left.forEach((block, index) => {
    const match = typeof block?.id === "string" ? rightIndex.get(block.id) : undefined
    if (match !== undefined && sameBlock(block, right[match])) candidates.push([index, match])
  })
  // Patience sorting over right positions, remembering predecessors.
  const tails: number[] = []
  const previous: number[] = []
  candidates.forEach(([, position], index) => {
    let low = 0
    let high = tails.length
    while (low < high) {
      const mid = (low + high) >> 1
      if (candidates[tails[mid]!]![1] < position) low = mid + 1
      else high = mid
    }
    previous[index] = low > 0 ? tails[low - 1]! : -1
    tails[low] = index
  })
  const pairs: Array<readonly [number, number]> = []
  for (let index = tails.at(-1) ?? -1; index !== -1; index = previous[index]!) {
    pairs.push(candidates[index]!)
  }
  return pairs.reverse()
}

/** One splice of the current top-level blocks. */
export interface RegionOperation {
  index: number
  deleteCount: number
  blocks: Block[]
}

export type RebaseResult =
  | { ok: true; blocks: Block[]; operations: RegionOperation[] }
  | { ok: false; reason: string; blockId?: string }

/**
 * Apply regions to the current top-level blocks. A region's replaced blocks
 * must all still exist, next to each other and in order; a region that only
 * inserts goes before its following block (or after its preceding one).
 * `unchanged`, when given, must accept every replaced block as it is now.
 * Operations are returned last first, so applying them in order keeps every
 * index valid.
 */
export function rebaseRegions(
  current: readonly Block[],
  regions: readonly BlockRegion[],
  unchanged?: (block: Block) => boolean
): RebaseResult {
  const position = new Map<string, number>()
  current.forEach((block, index) => {
    if (typeof block?.id === "string") position.set(block.id, index)
  })
  const operations: RegionOperation[] = []
  for (const region of regions) {
    if (region.replacedBlockIds.length > 0) {
      const first = region.replacedBlockIds[0]!
      const index = position.get(first)
      if (index === undefined) return { ok: false, reason: "a block the change replaces was removed", blockId: first }
      for (const [offset, id] of region.replacedBlockIds.entries()) {
        const block = current[index + offset]
        if (block?.id !== id) {
          return {
            ok: false,
            reason: position.has(id) ? "blocks the change replaces were moved apart" : "a block the change replaces was removed",
            blockId: id,
          }
        }
        if (unchanged && !unchanged(block)) {
          return { ok: false, reason: "a block the change replaces was edited", blockId: id }
        }
      }
      operations.push({ index, deleteCount: region.replacedBlockIds.length, blocks: region.blocks })
      continue
    }
    let index: number | undefined
    if (region.followingBlockId !== undefined) {
      index = position.get(region.followingBlockId)
      if (index === undefined) {
        return { ok: false, reason: "the block after the insertion was removed", blockId: region.followingBlockId }
      }
    } else if (region.precedingBlockId !== undefined) {
      const preceding = position.get(region.precedingBlockId)
      if (preceding === undefined) {
        return { ok: false, reason: "the block before the insertion was removed", blockId: region.precedingBlockId }
      }
      index = preceding + 1
    } else {
      index = current.length
    }
    operations.push({ index, deleteCount: 0, blocks: region.blocks })
  }
  operations.sort((left, right) => left.index - right.index || left.deleteCount - right.deleteCount)
  for (let at = 1; at < operations.length; at++) {
    const previous = operations[at - 1]!
    if (operations[at]!.index < previous.index + previous.deleteCount) {
      return { ok: false, reason: "the change's regions overlap in the current document" }
    }
  }
  operations.reverse()
  const blocks = [...current]
  for (const operation of operations) {
    blocks.splice(operation.index, operation.deleteCount, ...operation.blocks)
  }
  return { ok: true, blocks, operations }
}
