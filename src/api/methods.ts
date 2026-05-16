import type { RpcClient } from './client'
import type { DynamicSummary, StaticData, TaskQueryCondition, TaskQueryResult } from '../types'

export const listAgentUuids = (c: RpcClient) =>
  c.call<{ uuids?: string[] }>('nodeget-server_list_all_agent_uuid', {}).then(r => r?.uuids || [])

export const staticDataMulti = (c: RpcClient, uuids: string[], fields: string[]) =>
  c.call<StaticData[]>('agent_static_data_multi_last_query', { uuids, fields })

export const dynamicSummaryMulti = (c: RpcClient, uuids: string[], fields: string[]) =>
  c.call<DynamicSummary[]>('agent_dynamic_summary_multi_last_query', { uuids, fields })

export const kvGetMulti = (
  c: RpcClient,
  items: { namespace: string; key: string }[],
) => c.call<{ namespace: string; key: string; value: unknown }[]>('kv_get_multi_value', { namespace_key: items })

export const taskQuery = (
  c: RpcClient,
  conditions: TaskQueryCondition[],
  timeoutMs?: number,
) => c.call<TaskQueryResult[]>('task_query', { task_data_query: { condition: conditions } }, timeoutMs)

export interface CrontabEntry {
  id: number
  name: string
  enable: boolean
  cron_expression: string
  cron_type: { agent?: [string[], Record<string, unknown>]; server?: unknown }
  last_run_time: number | null
}

export const crontabGet = (c: RpcClient) =>
  c.call<CrontabEntry[]>('crontab_get', {})
