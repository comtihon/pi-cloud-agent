// Turn one `session/new` (or `session/load`) into a ready environment for pi:
// tools + env, GCP auth, workspace restore + hooks, MCP pre-start, mcp.json
// and settings.json. Process-wide state (applied env keys, pre-started MCP
// servers) lives in the returned setup object so the next session undoes it.

import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'

import { applyAgentEnv, createEnvState } from './env.js'
import {
  buildMcpConfig,
  prestartServers,
  selectPrestart,
  stopPrestarted,
  writeCliToolsConfig,
  writePiConfig,
} from './mcp.js'
import { activateGcloudServiceAccount, downloadWorkspace, runWorkspaceHooks } from '../workspace.js'
import { log } from '../log.js'

export function defaultAgentDir(env = process.env) {
  return env.PI_CODING_AGENT_DIR || join(env.HOME || '/home/node', '.pi', 'agent')
}

export function createCarrierSetup({ agentDir = defaultAgentDir(), env = process.env } = {}) {
  const state = { env: createEnvState(), prestarted: {}, registered: [] }

  return {
    agentDir,
    get registeredTools() { return state.registered },

    /**
     * @param {object} p
     * @param {string} p.cwd
     * @param {object[]} p.mcpServers   ACP mcpServers
     * @param {object} p.agentConfig    _meta.carrier
     * @param {boolean} [p.restore]     restore the workspace from GCS first
     */
    async apply({ cwd, mcpServers, agentConfig = {}, restore = true }) {
      stopPrestarted(state.prestarted)
      state.prestarted = {}

      const { registered, skipped, blocked } = applyAgentEnv(agentConfig, { env, state: state.env })
      state.registered = registered
      if (registered.length) log('tools registered:', registered.map((t) => t.name).join(', '))
      for (const t of skipped) log(`tool '${t.name}' granted but '${t.command}' is not installed here — skipped`)
      if (blocked.length) log('commands blocked:', blocked.join(', '))

      await activateGcloudServiceAccount(env)

      await mkdir(cwd, { recursive: true })
      let restored = false
      if (restore) {
        restored = await downloadWorkspace(agentConfig.extra || {}, cwd)
        await runWorkspaceHooks(registered, cwd)
      }

      const toPrestart = selectPrestart(mcpServers, agentConfig.mcp_servers)
      state.prestarted = toPrestart.length ? await prestartServers(toPrestart, { baseEnv: { ...env } }) : {}

      const cliTools = await writeCliToolsConfig(agentDir, registered)
      const mcpConfig = buildMcpConfig(mcpServers, {
        prestarted: state.prestarted,
        cliTools,
        baseEnv: { ...env },
      })
      await writePiConfig(agentDir, mcpConfig)
      return { registered, restored, mcpServerNames: Object.keys(mcpConfig.mcpServers) }
    },

    dispose() {
      stopPrestarted(state.prestarted)
      state.prestarted = {}
    },
  }
}
