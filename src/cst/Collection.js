import { Type } from '../constants'
import BlankLine from './BlankLine'
import CollectionItem from './CollectionItem'
import Comment from './Comment'
import Node from './Node'
import Range from './Range'

export function grabCollectionEndComments(node) {
  let cnode = node
  while (cnode instanceof CollectionItem) cnode = cnode.node
  if (!(cnode instanceof Collection)) return null
  const len = cnode.items.length
  let ci = -1
  for (let i = len - 1; i >= 0; --i) {
    const n = cnode.items[i]
    if (n.type === Type.COMMENT) {
      // Keep sufficiently indented comments with preceding node
      const { indent, lineStart } = n.context
      if (indent > 0 && n.range.start >= lineStart + indent) break
      ci = i
    } else if (n.type === Type.BLANK_LINE) ci = i
    else break
  }
  if (ci === -1) return null
  const ca = cnode.items.splice(ci, len - ci)
  trace: 'item-end-comments', ca
  const prevEnd = ca[0].range.start
  while (true) {
    cnode.range.end = prevEnd
    if (cnode.valueRange && cnode.valueRange.end > prevEnd)
      cnode.valueRange.end = prevEnd
    if (cnode === node) break
    cnode = cnode.context.parent
  }
  return ca
}

export default class Collection extends Node {
  static nextContentHasIndent(src, offset, indent) {
    const lineStart = Node.endOfLine(src, offset) + 1
    offset = Node.endOfWhiteSpace(src, lineStart)
    const ch = src[offset]
    if (!ch) return false
    if (offset >= lineStart + indent) return true
    if (ch !== '#' && ch !== '\n') return false
    return Collection.nextContentHasIndent(src, offset, indent)
  }

  constructor(firstItem) {
    super(firstItem.type === Type.SEQ_ITEM ? Type.SEQ : Type.MAP)
    for (let i = firstItem.props.length - 1; i >= 0; --i) {
      if (firstItem.props[i].start < firstItem.context.lineStart) {
        // props on previous line are assumed by the collection
        this.props = firstItem.props.slice(0, i + 1)
        firstItem.props = firstItem.props.slice(i + 1)
        const itemRange = firstItem.props[0] || firstItem.valueRange
        firstItem.range.start = itemRange.start
        break
      }
    }
    this.items = [firstItem]
    const ec = grabCollectionEndComments(firstItem)
    if (ec) Array.prototype.push.apply(this.items, ec)
  }

  get includesTrailingLines() {
    return this.items.length > 0
  }

  /**
   * @param {ParseContext} context
   * @param {number} start - Index of first character
   * @returns {number} - Index of the character after this
   */
  parse(context, start) {
    trace: 'collection-start', context.pretty, { start }
    this.context = context
    const { parseNode, src } = context
    // It's easier to recalculate lineStart here rather than tracking down the
    // last context from which to read it -- eemeli/yaml#2
    let lineStart = Node.startOfLine(src, start)
    const firstItem = this.items[0]
    // First-item context needs to be correct for later comment handling
    // -- eemeli/yaml#17
    firstItem.context.parent = this
    this.valueRange = Range.copy(firstItem.valueRange)
    const indent = firstItem.range.start - firstItem.context.lineStart
    let offset = start
    offset = Node.normalizeOffset(src, offset)
    let ch = src[offset]
    let atLineStart = Node.endOfWhiteSpace(src, lineStart) === offset
    let prevIncludesTrailingLines = false
    trace: 'items-start', { offset, indent, lineStart, ch: JSON.stringify(ch) }
    while (ch) {
      while (ch === '\n' || ch === '#') {
        if (atLineStart && ch === '\n' && !prevIncludesTrailingLines) {
          const blankLine = new BlankLine()
          offset = blankLine.parse({ src }, offset)
          this.valueRange.end = offset
          if (offset >= src.length) {
            ch = null
            break
          }
          this.items.push(blankLine)
          trace: 'collection-blankline', blankLine.range
          offset -= 1 // blankLine.parse() consumes terminal newline
        } else if (ch === '#') {
          if (
            offset < lineStart + indent &&
            !Collection.nextContentHasIndent(src, offset, indent)
          ) {
            trace: 'end:comment-unindent', { offset, lineStart, indent }
            return offset
          }
          const comment = new Comment()
          offset = comment.parse({ indent, lineStart, src }, offset)
          this.items.push(comment)
          this.valueRange.end = offset
          if (offset >= src.length) {
            ch = null
            break
          }
        }
        lineStart = offset + 1
        offset = Node.endOfIndent(src, lineStart)
        if (Node.atBlank(src, offset)) {
          const wsEnd = Node.endOfWhiteSpace(src, offset)
          const next = src[wsEnd]
          if (!next || next === '\n' || next === '#') {
            offset = wsEnd
          }
        }
        ch = src[offset]
        atLineStart = true
      }
      if (!ch) {
        trace: 'end:src', { offset }
        break
      }
      if (offset !== lineStart + indent && (atLineStart || ch !== ':')) {
        trace: 'end:unindent',
          { offset, lineStart, indent, ch: JSON.stringify(ch) }
        if (lineStart > start) offset = lineStart
        break
      }
      if ((firstItem.type === Type.SEQ_ITEM) !== (ch === '-')) {
        let typeswitch = true
        if (ch === '-') {
          // map key may start with -, as long as it's followed by a non-whitespace char
          const next = src[offset + 1]
          typeswitch = !next || next === '\n' || next === '\t' || next === ' '
        }
        if (typeswitch) {
          trace: 'end:typeswitch',
            { offset, lineStart, indent, ch: JSON.stringify(ch) }
          if (lineStart > start) offset = lineStart
          break
        }
      }
      trace: 'item-start', this.items.length, { ch: JSON.stringify(ch) }
      const node = parseNode(
        { atLineStart, inCollection: true, indent, lineStart, parent: this },
        offset
      )
      if (!node) return offset // at next document start
      this.items.push(node)
      this.valueRange.end = node.valueRange.end
      offset = Node.normalizeOffset(src, node.range.end)
      ch = src[offset]
      atLineStart = false
      prevIncludesTrailingLines = node.includesTrailingLines
      // Need to reset lineStart and atLineStart here if preceding node's range
      // has advanced to check the current line's indentation level
      // -- eemeli/yaml#10 & eemeli/yaml#38
      if (ch) {
        let ls = offset - 1
        let prev = src[ls]
        while (prev === ' ' || prev === '\t') prev = src[--ls]
        if (prev === '\n') {
          lineStart = ls + 1
          atLineStart = true
        }
      }
      const ec = grabCollectionEndComments(node)
      if (ec) Array.prototype.push.apply(this.items, ec)
      trace: 'item-end', node.type, { offset, ch: JSON.stringify(ch) }
    }
    trace: 'items', this.items
    return offset
  }

  setOrigRanges(cr, offset) {
    offset = super.setOrigRanges(cr, offset)
    this.items.forEach(node => {
      offset = node.setOrigRanges(cr, offset)
    })
    return offset
  }

  toString() {
    const {
      context: { src },
      items,
      range,
      value
    } = this
    if (value != null) return value
    let str = src.slice(range.start, items[0].range.start) + String(items[0])
    for (let i = 1; i < items.length; ++i) {
      const item = items[i]
      const { atLineStart, indent } = item.context
      if (atLineStart) for (let i = 0; i < indent; ++i) str += ' '
      str += String(item)
    }
    return Node.addStringTerminator(src, range.end, str)
  }
}
