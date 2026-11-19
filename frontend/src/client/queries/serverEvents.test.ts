import {
	expect,
	it,
	vi,
} from 'vitest'
import {
	QueryClient,
	QueryObserver,
} from '@tanstack/vue-query'
import {
	parseServerCacheEvent,
	serverCacheEventMutationOptions,
} from './serverEvents'
import {
	timeEntryKeys,
	normalizeTimeEntry,
	type TimeEntryPage,
	type TimeEntryResponse,
} from './timeEntries'
import {commentKeys} from './comments'
import {notificationKeys} from './notifications'
import {
	taskKeys,
	normalizeTask,
} from './tasks'
import {kanbanKeys} from './kanban'
vi.mock('@/message', () => ({
	error: vi.fn(),
	success: vi.fn(),
}))

const RUNNING_ENTRY = normalizeTimeEntry({
	id: 4,
	user: {id: 7},
	start_time: '2026-09-19T08:00:00Z',
	end_time: null,
})

const TASK_ENTRY = normalizeTimeEntry({
	id: 9,
	user: {id: 7},
	task_id: 3,
	start_time: '2026-09-19T08:00:00Z',
	end_time: '2026-09-19T09:00:00Z',
})

function timeEntryPage(items: TimeEntryResponse[]): TimeEntryPage {
	return {
		items,
		page: 1,
		per_page: 50,
		total: items.length,
		total_pages: 1,
	}
}

it('routes task creation using ids without normalizing an incomplete task payload', async () => {
	const client = new QueryClient()
	const boardKey = kanbanKeys.board(2, 1, {filter: 'done = false'})
	const board = {
		buckets: [],
		pages: {},
	}
	client.setQueryData(boardKey, board)
	const event = parseServerCacheEvent('task.created', {
		id: 3,
		project_id: 2,
		created_by: {id: 8},
	}, 7)
	expect(event).toEqual({
		kind: 'task.created',
		taskId: 3,
		projectId: 2,
	})
	await client.getMutationCache().build(client, serverCacheEventMutationOptions()).execute(event!)
	expect(client.getQueryState(boardKey)?.isInvalidated).toBe(true)
	expect(client.getQueryData(boardKey)).toEqual(board)
})

it.each(['task.created', 'task.updated', 'task.deleted'] as const)(
	'refetches active server-filtered collections on %s without patching partial task data',
	async kind => {
		const client = new QueryClient()
		const task = normalizeTask({
			id: 3,
			project_id: 1,
			title: 'Cached title',
		})
		const board = {
			buckets: [{
				id: 1,
				title: 'Todo',
				count: 50,
				limit: 0,
				position: 100,
				tasks: [normalizeTask({id: 5})],
			}],
			pages: {1: 2},
		}
		const keys = [
			kanbanKeys.board(1, 1, {filter: 'done = false'}),
			kanbanKeys.board(2, 2, {q: 'search'}),
			kanbanKeys.board(-5, 3),
			taskKeys.allList({project: 2}),
			taskKeys.list({project: 1}, 1),
		]
		const observers = keys.map(queryKey => {
			const page = {
				items: [task],
				page: 1,
				per_page: 50,
				total: 1,
				total_pages: 1,
			}
			const cached = queryKey[0] === 'kanban' ? board : queryKey[1] === 'list' ? page : [task]
			client.setQueryData(queryKey, cached)
			const queryFn = vi.fn(() => {
				// The event must not overwrite expanded fields or invent filtered membership before refetching.
				expect(client.getQueryData(queryKey)).toEqual(cached)
				return cached
			})
			const unsubscribe = new QueryObserver(client, {
				queryKey,
				queryFn,
				staleTime: Infinity,
			}).subscribe(() => {})
			return {
				queryFn,
				unsubscribe,
			}
		})
		const inactiveBoard = kanbanKeys.board(4, 4)
		client.setQueryData(inactiveBoard, board)
		const inactiveUpdates = client.getQueryState(inactiveBoard)!.dataUpdateCount
		client.setQueryData(taskKeys.detail(3), task)
		client.setQueryData(taskKeys.detail(9), normalizeTask({id: 9}))
		const event = parseServerCacheEvent(kind, {
			id: 3,
			project_id: 2,
			bucket_id: 99,
			created_by: {id: 8},
		}, 7)
		try {
			expect(event).toEqual({
				kind,
				taskId: 3,
				projectId: 2,
			})
			await client.getMutationCache().build(client, serverCacheEventMutationOptions()).execute(event!)
			for (const {queryFn} of observers) expect(queryFn).toHaveBeenCalledTimes(1)
			expect(client.getQueryState(inactiveBoard)?.isInvalidated).toBe(true)
			expect(client.getQueryState(inactiveBoard)?.dataUpdateCount).toBe(inactiveUpdates)
			expect(client.getQueryState(taskKeys.detail(3))?.isInvalidated).toBe(true)
			expect(client.getQueryState(taskKeys.detail(9))?.isInvalidated).toBe(false)
		} finally {
			observers.forEach(({unsubscribe}) => unsubscribe())
			client.clear()
		}
	},
)

it.each(['task.created', 'task.updated', 'task.deleted'] as const)(
	'ignores malformed task identifiers on %s',
	kind => {
		const malformed: unknown[] = [undefined, null, [], 'task', {}, {id: 3}, {project_id: 2}]
		const invalidIds = [undefined, null, '3', 0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]
		for (const id of invalidIds) {
			malformed.push({
				id,
				project_id: 2,
			}, {
				id: 3,
				project_id: id,
			})
		}
		for (const payload of malformed) expect(parseServerCacheEvent(kind, payload, 7)).toBeNull()
	},
)

it.each(['reconnect', 'subscribed'] as const)('refetches active board and task membership after %s', async kind => {
	const client = new QueryClient()
	const since = Date.now()
	const keys = [kanbanKeys.board(1, 1), taskKeys.allList({project: 1}), taskKeys.list({project: 1}, 1)]
	const observers = keys.map(queryKey => {
		const data = {
			items: [],
			buckets: [],
			pages: {},
		}
		client.setQueryData(queryKey, data, {updatedAt: since - 1})
		const queryFn = vi.fn(() => data)
		const unsubscribe = new QueryObserver(client, {
			queryKey,
			queryFn,
			staleTime: Infinity,
		}).subscribe(() => {})
		return {
			queryFn,
			unsubscribe,
		}
	})
	try {
		const event = kind === 'subscribed' ? {
			kind,
			since,
		} : {kind}
		await client.getMutationCache().build(client, serverCacheEventMutationOptions()).execute(event)
		for (const {queryFn} of observers) expect(queryFn).toHaveBeenCalledTimes(1)
	} finally {
		observers.forEach(({unsubscribe}) => unsubscribe())
		client.clear()
	}
})

it('ignores malformed payloads', () => {
	expect(parseServerCacheEvent('timer.created', undefined, 7)).toBeNull()
	expect(parseServerCacheEvent('notification.created', 'task.comment', 7)).toBeNull()
	expect(parseServerCacheEvent('notification.created', {name: 'team.member.added'}, 7)).toBeNull()
	expect(parseServerCacheEvent('notification.created', {
		id: 0,
		name: 'team.member.added',
	}, 7)).toBeNull()
})

it('rejects timer entries that do not belong to the current user', () => {
	const entry = {
		id: 4,
		user: {id: 8},
		task_id: 1,
	}
	expect(parseServerCacheEvent('timer.created', entry, 7)).toBeNull()
	expect(parseServerCacheEvent('timer.created', entry, undefined)).toBeNull()
	expect(parseServerCacheEvent('timer.created', {
		id: 4,
		task_id: 1,
	}, undefined)).toBeNull()
	expect(parseServerCacheEvent('timer.created', {
		...entry,
		user: {id: 7},
	}, 7)).not.toBeNull()
})

it('rejects timer entries with an unusable id or task id', () => {
	expect(parseServerCacheEvent('timer.created', {
		id: 0,
		user: {id: 7},
	}, 7)).toBeNull()
	expect(parseServerCacheEvent('timer.created', {
		id: 4,
		user: {id: 7},
		task_id: '1',
	}, 7)).toBeNull()
})

it('falls back to an inbox refresh for notifications it cannot route', () => {
	expect(parseServerCacheEvent('notification.created', {
		id: 5,
		name: 'team.member.added',
	}, 7)).toEqual({kind: 'notifications'})
	expect(parseServerCacheEvent('notification.created', {
		id: 5,
		name: 'task.comment',
		notification: {},
	}, 7)).toEqual({kind: 'notifications'})
	expect(parseServerCacheEvent('notification.created', {
		id: 5,
		name: 'task.comment',
		notification: {task: {id: 0}},
	}, 7)).toEqual({kind: 'notifications'})
})

it.each([
	'notification',
	'comment',
	'reconnect',
	'subscribe',
])('invalidates notification data on %s without replacing it with the event payload', async kind => {
	const client = new QueryClient()
	client.setQueryData(notificationKeys.all, [{id: 1}], {updatedAt: 10})
	const event = kind === 'reconnect'
		? {kind: 'reconnect'} as const
		: kind === 'subscribe'
			? {
				kind: 'subscribed',
				since: 20,
			} as const
			: parseServerCacheEvent('notification.created', {
				id: 2,
				name: kind === 'comment' ? 'task.comment' : 'team.member.added',
				notification: {task: {id: 3}},
			}, 7)!
	await client.getMutationCache().build(client, serverCacheEventMutationOptions()).execute(event)
	expect(client.getQueryData(notificationKeys.all)).toEqual([{id: 1}])
	expect(client.getQueryState(notificationKeys.all)?.isInvalidated).toBe(true)
})

it('invalidates only the notified task comments and detail', async () => {
	const client = new QueryClient()
	client.setQueryData(commentKeys.page(1, 'asc', 1), {items: []})
	client.setQueryData(commentKeys.page(2, 'asc', 1), {items: []})
	client.setQueryData(taskKeys.detail(1), normalizeTask({id: 1}))
	const event = parseServerCacheEvent('notification.created', {
		name: 'task.comment',
		notification: {task: {id: 1}},
	}, 7)!
	expect(event).toEqual({
		kind: 'notifications',
		taskId: 1,
	})
	await client.getMutationCache().build(client, serverCacheEventMutationOptions()).execute(event)
	expect(client.getQueryState(commentKeys.page(1, 'asc', 1))?.isInvalidated).toBe(true)
	expect(client.getQueryState(commentKeys.page(2, 'asc', 1))?.isInvalidated).toBe(false)
	expect(client.getQueryState(taskKeys.detail(1))?.isInvalidated).toBe(true)
})

it('stales task collections only for a task they hold', async () => {
	const client = new QueryClient()
	const listKey = taskKeys.allList({project: 2})
	const queryFn = vi.fn(() => [normalizeTask({id: 5})])
	const unsubscribe = new QueryObserver(client, {
		queryKey: listKey,
		queryFn,
	}).subscribe(() => {})
	await vi.waitFor(() => expect(queryFn).toHaveBeenCalledTimes(1))
	client.setQueryData(taskKeys.detail(5), normalizeTask({id: 5}))
	const commentOn = (taskId: number) => parseServerCacheEvent('notification.created', {
		name: 'task.comment',
		notification: {task: {id: taskId}},
	}, 7)!
	await client.getMutationCache().build(client, serverCacheEventMutationOptions()).execute(commentOn(1))
	expect(client.getQueryState(listKey)?.isInvalidated).toBe(false)
	await client.getMutationCache().build(client, serverCacheEventMutationOptions()).execute(commentOn(5))
	expect(client.getQueryState(listKey)?.isInvalidated).toBe(true)
	expect(client.getQueryState(listKey)?.fetchStatus).toBe('idle')
	expect(queryFn).toHaveBeenCalledTimes(1)
	expect(client.getQueryState(taskKeys.detail(5))?.isInvalidated).toBe(true)
	unsubscribe()
})

it('does not stale task collections for an open task none of them hold', async () => {
	const client = new QueryClient()
	const listKey = taskKeys.allList({project: 2})
	client.setQueryData(listKey, [normalizeTask({id: 5})])
	client.setQueryData(taskKeys.detail(9), normalizeTask({id: 9}))
	const event = parseServerCacheEvent('notification.created', {
		name: 'task.comment',
		notification: {task: {id: 9}},
	}, 7)!
	await client.getMutationCache().build(client, serverCacheEventMutationOptions()).execute(event)
	expect(client.getQueryState(listKey)?.isInvalidated).toBe(false)
	expect(client.getQueryState(taskKeys.detail(9))?.isInvalidated).toBe(true)
})

it('refetches an open list for a created timer without inserting it or refetching the active key', async () => {
	const client = new QueryClient()
	const listKey = timeEntryKeys.list('task_id = 99', 'UTC', 1)
	const queryFn = vi.fn(() => timeEntryPage([]))
	const activeFn = vi.fn(() => null)
	const unsubscribe = new QueryObserver(client, {
		queryKey: listKey,
		queryFn,
	}).subscribe(() => {})
	const unsubscribeActive = new QueryObserver(client, {
		queryKey: timeEntryKeys.active(7),
		queryFn: activeFn,
	}).subscribe(() => {})
	await vi.waitFor(() => expect(queryFn).toHaveBeenCalledTimes(1))
	await vi.waitFor(() => expect(activeFn).toHaveBeenCalledTimes(1))
	const event = parseServerCacheEvent('timer.created', RUNNING_ENTRY, 7)!
	await client.getMutationCache().build(client, serverCacheEventMutationOptions()).execute(event)
	expect(client.getQueryData(timeEntryKeys.active(7))).toEqual(RUNNING_ENTRY)
	expect(client.getQueryData<TimeEntryPage>(listKey)?.items).toEqual([])
	expect(queryFn).toHaveBeenCalledTimes(2)
	expect(activeFn).toHaveBeenCalledTimes(1)
	unsubscribe()
	unsubscribeActive()
})

it('patches an updated timer into an open list without refetching it', async () => {
	const client = new QueryClient()
	const listKey = timeEntryKeys.list('task_id = 99', 'UTC', 1)
	const queryFn = vi.fn(() => timeEntryPage([RUNNING_ENTRY]))
	const unsubscribe = new QueryObserver(client, {
		queryKey: listKey,
		queryFn,
	}).subscribe(() => {})
	await vi.waitFor(() => expect(queryFn).toHaveBeenCalledTimes(1))
	client.setQueryData(timeEntryKeys.active(7), RUNNING_ENTRY)
	const stopped = normalizeTimeEntry({
		...RUNNING_ENTRY,
		end_time: '2026-09-19T09:00:00Z',
	})
	const event = parseServerCacheEvent('timer.updated', stopped, 7)!
	await client.getMutationCache().build(client, serverCacheEventMutationOptions()).execute(event)
	expect(client.getQueryData<TimeEntryPage>(listKey)?.items).toEqual([stopped])
	expect(client.getQueryData(timeEntryKeys.active(7))).toBeNull()
	expect(client.getQueryState(listKey)?.isInvalidated).toBe(false)
	expect(queryFn).toHaveBeenCalledTimes(1)
	unsubscribe()
})

it('invalidates both tasks when an updated timer moves to another task', async () => {
	const client = new QueryClient()
	client.setQueryData(timeEntryKeys.list('task_id = 3', 'UTC', 1), timeEntryPage([TASK_ENTRY]))
	client.setQueryData(taskKeys.detail(3), normalizeTask({id: 3}))
	client.setQueryData(taskKeys.detail(4), normalizeTask({id: 4}))
	const event = parseServerCacheEvent('timer.updated', {
		...TASK_ENTRY,
		task_id: 4,
	}, 7)!
	await client.getMutationCache().build(client, serverCacheEventMutationOptions()).execute(event)
	expect(client.getQueryState(taskKeys.detail(3))?.isInvalidated).toBe(true)
	expect(client.getQueryState(taskKeys.detail(4))?.isInvalidated).toBe(true)
})

it('invalidates only the timer task when an update keeps it there', async () => {
	const client = new QueryClient()
	client.setQueryData(timeEntryKeys.list('task_id = 3', 'UTC', 1), timeEntryPage([TASK_ENTRY]))
	client.setQueryData(taskKeys.detail(3), normalizeTask({id: 3}))
	client.setQueryData(taskKeys.detail(4), normalizeTask({id: 4}))
	const event = parseServerCacheEvent('timer.updated', {
		...TASK_ENTRY,
		comment: 'changed',
	}, 7)!
	await client.getMutationCache().build(client, serverCacheEventMutationOptions()).execute(event)
	expect(client.getQueryState(taskKeys.detail(3))?.isInvalidated).toBe(true)
	expect(client.getQueryState(taskKeys.detail(4))?.isInvalidated).toBe(false)
})

it('invalidates only the new task when the updated timer is not cached', async () => {
	const client = new QueryClient()
	client.setQueryData(taskKeys.detail(3), normalizeTask({id: 3}))
	client.setQueryData(taskKeys.detail(4), normalizeTask({id: 4}))
	const event = parseServerCacheEvent('timer.updated', {
		...TASK_ENTRY,
		task_id: 4,
	}, 7)!
	await client.getMutationCache().build(client, serverCacheEventMutationOptions()).execute(event)
	expect(client.getQueryState(taskKeys.detail(3))?.isInvalidated).toBe(false)
	expect(client.getQueryState(taskKeys.detail(4))?.isInvalidated).toBe(true)
})

it('removes a deleted timer from an open list without refetching it', async () => {
	const client = new QueryClient()
	const listKey = timeEntryKeys.list('task_id = 99', 'UTC', 1)
	const queryFn = vi.fn(() => timeEntryPage([RUNNING_ENTRY]))
	const unsubscribe = new QueryObserver(client, {
		queryKey: listKey,
		queryFn,
	}).subscribe(() => {})
	await vi.waitFor(() => expect(queryFn).toHaveBeenCalledTimes(1))
	client.setQueryData(timeEntryKeys.active(7), RUNNING_ENTRY)
	const event = parseServerCacheEvent('timer.deleted', RUNNING_ENTRY, 7)!
	await client.getMutationCache().build(client, serverCacheEventMutationOptions()).execute(event)
	expect(client.getQueryData<TimeEntryPage>(listKey)?.items).toEqual([])
	expect(client.getQueryData<TimeEntryPage>(listKey)?.total).toBe(0)
	expect(client.getQueryData(timeEntryKeys.active(7))).toBeNull()
	expect(client.getQueryState(listKey)?.isInvalidated).toBe(false)
	expect(queryFn).toHaveBeenCalledTimes(1)
	unsubscribe()
})

it('refetches only cache families that loaded before the first subscription', async () => {
	const client = new QueryClient()
	const listKey = timeEntryKeys.list('task_id = 99', 'UTC', 1)
	const queryFn = vi.fn(() => timeEntryPage([]))
	const unsubscribe = new QueryObserver(client, {
		queryKey: listKey,
		queryFn,
	}).subscribe(() => {})
	await vi.waitFor(() => expect(queryFn).toHaveBeenCalledTimes(1))
	const since = Date.now() + 1000
	const commentKey = commentKeys.page(1, 'asc', 1)
	const boardKey = kanbanKeys.board(1, 1)
	const newerBoardKey = kanbanKeys.board(2, 2)
	const listKeyBeforeSubscription = taskKeys.allList({project: 1})
	client.setQueryData(commentKey, {items: []}, {updatedAt: since - 1})
	client.setQueryData(taskKeys.detail(1), normalizeTask({id: 1}), {updatedAt: since + 1})
	client.setQueryData(boardKey, {buckets: []}, {updatedAt: since - 1})
	client.setQueryData(newerBoardKey, {buckets: []}, {updatedAt: since + 1})
	client.setQueryData(listKeyBeforeSubscription, [], {updatedAt: since - 1})
	await client.getMutationCache().build(client, serverCacheEventMutationOptions()).execute({
		kind: 'subscribed',
		since,
	})
	expect(queryFn).toHaveBeenCalledTimes(2)
	expect(client.getQueryState(commentKey)?.isInvalidated).toBe(true)
	expect(client.getQueryState(taskKeys.detail(1))?.isInvalidated).toBe(false)
	expect(client.getQueryState(boardKey)?.isInvalidated).toBe(true)
	expect(client.getQueryState(newerBoardKey)?.isInvalidated).toBe(false)
	expect(client.getQueryState(listKeyBeforeSubscription)?.isInvalidated).toBe(true)
	unsubscribe()
})

it('leaves a query still loading at the first subscription untouched', async () => {
	const client = new QueryClient()
	const listKey = timeEntryKeys.list('task_id = 1', 'UTC', 1)
	const queryFn = vi.fn(() => new Promise<TimeEntryPage>(() => {}))
	const unsubscribe = new QueryObserver(client, {
		queryKey: listKey,
		queryFn,
	}).subscribe(() => {})
	await vi.waitFor(() => expect(queryFn).toHaveBeenCalledTimes(1))
	await client.getMutationCache().build(client, serverCacheEventMutationOptions()).execute({
		kind: 'subscribed',
		since: Date.now() + 1000,
	})
	expect(queryFn).toHaveBeenCalledTimes(1)
	expect(client.getQueryState(listKey)?.isInvalidated).toBe(false)
	unsubscribe()
})

it.each(['task.updated', 'task.deleted'] as const)('refetches a parent detail containing a child after %s', async name => {
	const client = new QueryClient()
	const parent = normalizeTask({id: 10, related_tasks: {subtask: [{id: 5, title: 'before'}]}})
	const refreshed = normalizeTask({id: 10, related_tasks: {subtask: []}})
	const parentFn = vi.fn().mockResolvedValueOnce(parent).mockResolvedValue(refreshed)
	const unsubscribe = new QueryObserver(client, {
		queryKey: taskKeys.detail(10),
		queryFn: parentFn,
	}).subscribe(() => {})
	await vi.waitFor(() => expect(parentFn).toHaveBeenCalledTimes(1))
	try {
		const event = parseServerCacheEvent(name, {id: 5, project_id: 1}, 7)!
		await client.getMutationCache().build(client, serverCacheEventMutationOptions()).execute(event)
		expect(parentFn).toHaveBeenCalledTimes(2)
		expect(client.getQueryData(taskKeys.detail(10))).toEqual(refreshed)
	} finally {
		unsubscribe()
	}
})

it('refreshes task details and marks board membership stale after reconnecting', async () => {
	const client = new QueryClient()
	client.setQueryData(taskKeys.detail(1), normalizeTask({
		id: 1,
		comment_count: 0,
	}))
	const boardKey = kanbanKeys.board(1, 1)
	client.setQueryData(boardKey, {buckets: []})
	await client.getMutationCache().build(client, serverCacheEventMutationOptions()).execute({kind: 'reconnect'})
	expect(client.getQueryState(boardKey)?.isInvalidated).toBe(true)
	expect(client.getQueryState(taskKeys.detail(1))?.isInvalidated).toBe(true)
})
