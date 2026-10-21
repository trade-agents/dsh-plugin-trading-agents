/**
 * Runtime skill registration.
 *
 * Two sources feed one merged idea of "a role the trading pipeline can act as":
 *
 * - `skills/<name>/SKILL.md` — the user-facing entry points (pipeline, trade,
 *   settle-decisions). These are user-invocable, so `/trading-agents-trade NVDA`
 *   expands into its instructions in the composer, exactly like a Claude Code
 *   slash command.
 * - `roles/<role>.md` — the thirteen desk roles. These are model-invocable but
 *   not user-invocable: a subagent the orchestrator spawns is told to load its
 *   role skill first, so role instructions never pass through the orchestrator's
 *   context (the same reason Claude Code agents never did).
 *
 * Both are read from the package, not from `~/.dsh/skills`, so installation is a
 * single bundle install and the plugin's own copy always wins.
 *
 * @module dsh-plugin-trading-agents/skills
 */

import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { parseFrontmatter, looseBoolean } from './frontmatter.js'

/** DSH trims tool results above 8192 characters; keep skill bodies well below it. */
export const SKILL_CONTENT_LIMIT = 8192

/**
 * Reads one `SKILL.md`.
 *
 * @param path - absolute path to the file.
 * @param expectedName - the name the directory/file must declare.
 * @returns the parsed skill source.
 * @throws {Error} when the file is missing fields or names a different skill.
 */
function readSkillFile(path, expectedName) {
    const { fields, body } = parseFrontmatter(readFileSync(path, 'utf8'), path)
    const name = fields.name
    const description = fields.description
    if (!name) throw new Error(`${path}: frontmatter needs a \`name\``)
    if (name !== expectedName) {
        throw new Error(`${path}: frontmatter name "${name}" must equal "${expectedName}"`)
    }
    if (!description) throw new Error(`${path}: frontmatter needs a \`description\``)
    if (!body.trim()) throw new Error(`${path}: skill body is empty`)

    const disableModel = looseBoolean(fields['disable-model-invocation'] ?? 'false')
    const userInvocable = looseBoolean(fields['user-invocable'] ?? 'true')
    if (disableModel === undefined) throw new Error(`${path}: \`disable-model-invocation\` must be a boolean`)
    if (userInvocable === undefined) throw new Error(`${path}: \`user-invocable\` must be a boolean`)

    return {
        name,
        description,
        whenToUse: fields.whenToUse || undefined,
        content: body,
        path,
        // DSH's `get()` re-validates a loaded definition and requires a string
        // `source`; without it the skill lists in the catalog but cannot load.
        source: 'bundled',
        resourceBase: { kind: 'directory', path: dirname(path) },
        invocation: {
            modelInvocable: !disableModel,
            userInvocable,
        },
    }
}

/**
 * Reads every skill directory under `skills/`.
 *
 * @param skillsDir - the package's `skills` directory.
 * @returns the skill sources, sorted by name.
 * @throws {Error} when the directory is unreadable.
 */
export function collectCommandSkills(skillsDir) {
    const entries = readdirSync(skillsDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort()

    /** @type {ReturnType<typeof readSkillFile>[]} */
    const skills = []
    for (const name of entries) {
        const path = join(skillsDir, name, 'SKILL.md')
        try {
            skills.push(readSkillFile(path, name))
        } catch (error) {
            if (error?.code === 'ENOENT') continue
            throw error
        }
    }
    return skills
}

/**
 * Reads every role file under `roles/` and turns it into a model-only skill
 * named `trading-agents-<role>`.
 *
 * @param rolesDir - the package's `roles` directory.
 * @param errorLogger - called once per unreadable role instead of failing the load.
 * @returns the role skill sources, sorted by role name.
 */
export function collectRoleSkills(rolesDir, errorLogger) {
    const names = readdirSync(rolesDir, { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
        .map((entry) => entry.name.slice(0, -3))
        .sort()

    /** @type {Array<{name: string, description: string, whenToUse?: string, content: string, path: string, invocation: {modelInvocable: boolean, userInvocable: boolean}}>} */
    const skills = []
    for (const role of names) {
        const path = join(rolesDir, `${role}.md`)
        try {
            const { fields, body } = parseFrontmatter(readFileSync(path, 'utf8'), path)
            if (!fields.description) throw new Error(`${path}: frontmatter needs a \`description\``)
            if (!body.trim()) throw new Error(`${path}: role body is empty`)
            skills.push({
                name: `trading-agents-${role}`,
                description: fields.description,
                whenToUse: fields.whenToUse || `Load only when the trading-agents pipeline asks you to act as the ${role}.`,
                content: body,
                path,
                source: 'bundled',
                resourceBase: { kind: 'directory', path: rolesDir },
                invocation: { modelInvocable: true, userInvocable: false },
            })
        } catch (error) {
            errorLogger?.(`skipping role "${role}": ${error?.message ?? error}`)
        }
    }
    return skills
}

/**
 * Collects everything the plugin should register, skipping unusable files with
 * a warning rather than failing the profile load.
 *
 * @param options - dirs, whether to include roles, and an error sink.
 * @returns the skill sources and the per-file problems encountered.
 */
export function collectSkills({ skillsDir, rolesDir, exposeRoleSkills, onError }) {
    /** @type {unknown[]} */
    const skills = []
    /** @type {string[]} */
    const problems = []

    for (const [label, collector] of [
        ['skills', () => collectCommandSkills(skillsDir)],
        ['roles', () => (exposeRoleSkills ? collectRoleSkills(rolesDir, (message) => {
            problems.push(message)
            onError?.(message)
        }) : [])],
    ]) {
        try {
            skills.push(...collector())
        } catch (error) {
            const message = `cannot read ${label} from ${label === 'skills' ? skillsDir : rolesDir}: ${error?.message ?? error}`
            problems.push(message)
            onError?.(message)
        }
    }

    return { skills, problems }
}

/**
 * Registers the collected skills on `ctx.skills`.
 *
 * @param ctx - the plugin context; `ctx.skills` is injected.
 * @param skills - the collected skill sources.
 * @param logger - optional DSH logger.
 * @returns the number registered and any that DSH rejected.
 */
export function registerSkills(ctx, skills, logger) {
    let registered = 0
    const rejected = []
    for (const skill of skills) {
        try {
            ctx.skills.register(skill)
            registered += 1
            if (skill.content.length > SKILL_CONTENT_LIMIT) {
                logger?.warn?.(
                    `trading-agents: skill "${skill.name}" body is ${skill.content.length} characters, `
                    + `above DSH's ${SKILL_CONTENT_LIMIT}-character reliable tool-result size; move detail into references/`,
                )
            }
        } catch (error) {
            const message = `skill "${skill.name}" rejected: ${error?.message ?? error}`
            rejected.push(message)
            logger?.warn?.(`trading-agents: ${message}`)
        }
    }
    return { registered, rejected }
}
