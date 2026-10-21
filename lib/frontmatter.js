/**
 * A deliberately small YAML-frontmatter reader.
 *
 * Skill and role files use the subset DSH's own `SKILL.md` files use: a `---`
 * fence, then one `key: value` pair per line, then a closing `---`. Values may
 * be single- or double-quoted, and the two invocation keys accept the YAML
 * boolean spellings the skill provider documents. Anything more elaborate is
 * rejected rather than guessed at, so a malformed file fails loudly.
 *
 * @module dsh-plugin-trading-agents/frontmatter
 */

const FENCE = '---'

/**
 * Unquotes a scalar value.
 *
 * @param value - the raw text after the colon.
 * @returns the scalar, still a string.
 */
function unquote(value) {
    const text = value.trim()
    if (text.length >= 2) {
        const first = text[0]
        const last = text[text.length - 1]
        if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
            const inner = text.slice(1, -1)
            return first === '"' ? inner.replace(/\\"/g, '"').replace(/\\n/g, '\n') : inner.replace(/''/g, "'")
        }
    }
    return text
}

/**
 * Parses the strict boolean grammar the skill provider accepts.
 *
 * @param value - the raw scalar.
 * @returns the boolean, or `undefined` when the value is not one of the accepted spellings.
 */
export function looseBoolean(value) {
    const lowered = String(value).trim().toLowerCase()
    if (['true', 'yes', 'on', '1'].includes(lowered)) return true
    if (['false', 'no', 'off', '0'].includes(lowered)) return false
    return undefined
}

/**
 * Splits a markdown file into its frontmatter fields and body.
 *
 * @param source - the whole file.
 * @param label - a name used in error messages (usually the path).
 * @returns the parsed fields plus the body with the frontmatter removed.
 * @throws {Error} when the file has no frontmatter or an unparsable line.
 */
export function parseFrontmatter(source, label = 'file') {
    const text = String(source).replace(/^\uFEFF/, '')
    const lines = text.split(/\r?\n/)
    if (lines[0]?.trim() !== FENCE) {
        throw new Error(`${label}: expected YAML frontmatter starting with \`${FENCE}\``)
    }
    let end = -1
    for (let index = 1; index < lines.length; index += 1) {
        if (lines[index].trim() === FENCE) {
            end = index
            break
        }
    }
    if (end === -1) throw new Error(`${label}: unterminated YAML frontmatter`)

    /** @type {Record<string, string>} */
    const fields = {}
    for (let index = 1; index < end; index += 1) {
        const line = lines[index]
        if (line.trim() === '' || line.trimStart().startsWith('#')) continue
        if (/^\s/.test(line)) {
            throw new Error(`${label}: nested or multi-line frontmatter is not supported (line ${index + 1})`)
        }
        const match = /^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(line)
        if (!match) throw new Error(`${label}: cannot parse frontmatter line ${index + 1}: ${JSON.stringify(line)}`)
        fields[match[1]] = unquote(match[2])
    }

    return { fields, body: lines.slice(end + 1).join('\n').replace(/^\n+/, '') }
}
