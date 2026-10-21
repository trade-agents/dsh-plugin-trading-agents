#!/usr/bin/env node
/**
 * Verifies that every skill and role this plugin registers can actually be
 * **loaded** by DSH's real skill registry, not merely listed.
 *
 * `ctx.skills.register()` does not validate the definition, but the later
 * `get()` re-validates it and requires fields such as a string `source`. A skill
 * missing one still appears in the catalog while `/name` and the `skill` tool
 * fail, so this check registers into the real `SkillRegistry` and loads every
 * entry back.
 *
 * The DSH runtime lives inside `app.asar`, which only Electron's patched `fs`
 * can read, so this script must run through the packaged Electron binary:
 *
 *   ELECTRON_RUN_AS_NODE=1 "/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness" \
 *     test/dsh-skill-check.mjs
 *
 * @module dsh-plugin-trading-agents/test/dsh-skill-check
 */

import { fileURLToPath } from 'node:url'

const ASAR = process.env.DSH_APP_ASAR
    ? `${process.env.DSH_APP_ASAR}/dsh/node_modules/@deepseek-ai`
    : '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai'

const PACKAGE = fileURLToPath(new URL('..', import.meta.url))

let passed = 0
const failures = []

/**
 * Records one assertion.
 *
 * @param label - what was checked.
 * @param error - the thrown error, or undefined on success.
 */
function check(label, error) {
    if (error === undefined) {
        passed += 1
        console.log(`  ok   ${label}`)
    } else {
        failures.push(`${label} — ${error?.message ?? error}`)
        console.log(`  FAIL ${label} — ${error?.message ?? error}`)
    }
}

/**
 * Runs a thunk and returns the error it threw, if any.
 *
 * @param fn - the thunk to run.
 * @returns the thrown error, or undefined.
 */
function attempt(fn) {
    try {
        fn()
        return undefined
    } catch (error) {
        return error
    }
}

const { Context } = await import(`${ASAR}/cordis/lib/index.js`)
const { SkillRegistry } = await import(`${ASAR}/dsh-skill/lib/index.js`)
const { collectSkills } = await import('../lib/skills.js')

const ctx = new Context()
const registry = new SkillRegistry(ctx)
console.log(`loaded the DSH skill registry from app.asar\n`)
check('registry installs itself as ctx.skills', attempt(() => {
    if (!ctx.skills) throw new Error('ctx.skills is absent after constructing SkillRegistry')
}))

const { skills, problems } = collectSkills({
    skillsDir: `${PACKAGE}skills`,
    rolesDir: `${PACKAGE}roles`,
    exposeRoleSkills: true,
})
console.log(`[1] collected ${skills.length} skill(s) from the package`)
check('collection reports no problems', attempt(() => {
    if (problems.length > 0) throw new Error(problems.join('; '))
}))
check('all 16 skills are collected', attempt(() => {
    if (skills.length !== 16) throw new Error(`expected 16, got ${skills.length}`)
}))
check('every skill declares a string source', attempt(() => {
    for (const skill of skills) {
        if (typeof skill.source !== 'string' || skill.source === '') {
            throw new Error(`${skill.name} has no string source`)
        }
    }
}))
check('every skill declares an invocation policy', attempt(() => {
    for (const skill of skills) {
        const policy = skill.invocation
        if (!policy || typeof policy.modelInvocable !== 'boolean' || typeof policy.userInvocable !== 'boolean') {
            throw new Error(`${skill.name} has no boolean invocation policy`)
        }
    }
}))

console.log('\n[2] registering into the real registry')
for (const skill of skills) {
    check(`register ${skill.name}`, attempt(() => ctx.skills.register(skill)))
}

console.log('\n[3] listing and loading every registered skill')
const lookup = { cwd: process.cwd() }
let listed = []
check('catalog lists every registered skill', attempt(() => {
    // The registry's list is asynchronous; this thunk only guards the shape.
    if (typeof ctx.skills.list !== 'function') throw new Error('ctx.skills.list is not a function')
}))
listed = await ctx.skills.list(lookup)
check('catalog contains all 16 skills', attempt(() => {
    if (listed.length !== 16) throw new Error(`expected 16, got ${listed.length}: ${listed.map((entry) => entry.name).join(', ')}`)
}))

for (const summary of listed) {
    const loaded = await ctx.skills.get(summary.name, lookup).catch((error) => ({ error }))
    check(`load ${summary.name}`, attempt(() => {
        if (loaded?.error) throw loaded.error
        if (!loaded) throw new Error('get() returned nothing')
        if (typeof loaded.content !== 'string' || loaded.content.length === 0) throw new Error('loaded skill has no body')
        if (loaded.invocation.userInvocable !== summary.invocation.userInvocable) throw new Error('invocation policy changed on load')
    }))
}

console.log('\n[4] user-invocable slash commands')
const slash = listed.filter((entry) => entry.invocation.userInvocable).map((entry) => entry.name).sort()
check('exactly the three command skills are user-invocable', attempt(() => {
    const expected = ['trading-agents-pipeline', 'trading-agents-settle-decisions', 'trading-agents-trade']
    if (JSON.stringify(slash) !== JSON.stringify(expected)) throw new Error(`got ${JSON.stringify(slash)}`)
}))
check('no skill name collides with a built-in host command', attempt(() => {
    const reserved = new Set(['compact', 'feedback', 'goal', 'plan'])
    for (const name of listed.map((entry) => entry.name)) {
        if (reserved.has(name)) throw new Error(`${name} collides with a host command`)
    }
}))

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length > 0) {
    console.log('\nFailures:')
    for (const failure of failures) console.log(`  - ${failure}`)
    process.exit(1)
}
