import {beforeEach, expect, it, vi} from 'vitest'
import {QueryClient} from '@tanstack/vue-query'
import {serverCacheEventMutationOptions, type ServerCacheEvent} from './serverEvents'
import {taskKeys, normalizeTask} from './tasks'
import {kanbanKeys} from './kanban'
import {error, success} from '@/message'

const session = vi.hoisted(() => ({
	epoch: 1,
	userId: 7,
	apiBaseUrl: '/api/v2',
}))

vi.mock('@/message', () => ({
	error: vi.fn(),
	success: vi.fn(),
}))
vi.mock('@/helpers/auth', async importOriginal => ({
	...await importOriginal<typeof import('@/helpers/auth')>(),
	getAuthSessionEpoch: () => session.epoch,
	getTokenIdentity: () => ({
		id: session.userId,
		type: 1,
	}),
}))
vi.mock('@/helpers/apiUrl', async importOriginal => ({
	...await importOriginal<typeof import('@/helpers/apiUrl')>(),
	getApiBaseUrl: () => session.apiBaseUrl,
}))

beforeEach(() => {
	session.epoch = 1
	session.userId = 7
	session.apiBaseUrl = '/api/v2'
	vi.clearAllMocks()
})

const events: ServerCacheEvent[] = [
	{
		kind: 'task.created',
		taskId: 3,
		projectId: 2,
	},
	{
		kind: 'task.updated',
		taskId: 3,
		projectId: 2,
	},
	{
		kind: 'task.deleted',
		taskId: 3,
		projectId: 2,
	},
	{kind: 'reconnect'},
	{
		kind: 'subscribed',
		since: 20,
	},
]

it.each(events)('does not apply $kind from a previous request context', async event => {
	for (const change of ['session', 'account', 'server'] as const) {
		const client = new QueryClient()
		const boardKey = kanbanKeys.board(2, 1)
		const listKey = taskKeys.allList({project: 2})
		const task = normalizeTask({
			id: 3,
			project_id: 2,
			title: 'Next context',
		})
		client.setQueryData(boardKey, {
			buckets: [],
			pages: {},
		}, {updatedAt: 10})
		client.setQueryData(listKey, [task], {updatedAt: 10})
		client.setQueryData(taskKeys.detail(3), task, {updatedAt: 10})
		const options = serverCacheEventMutationOptions()
		const mutation = client.getMutationCache().build(client, {
			...options,
			onMutate: async (...args) => {
				const context = await options.onMutate!(...args)
				if (change === 'session') session.epoch++
				if (change === 'account') session.userId++
				if (change === 'server') session.apiBaseUrl = '/other/api/v2'
				return context
			},
		})
		try {
			await expect(mutation.execute(event)).rejects.toMatchObject({name: 'AbortError'})
			for (const key of [boardKey, listKey, taskKeys.detail(3)]) {
				expect(client.getQueryState(key)?.isInvalidated).toBe(false)
				expect(client.getQueryState(key)?.dataUpdateCount).toBe(1)
			}
			expect(client.getQueryData(taskKeys.detail(3))).toEqual(task)
			expect(error).not.toHaveBeenCalled()
			expect(success).not.toHaveBeenCalled()
		} finally {
			client.clear()
		}
	}
})
