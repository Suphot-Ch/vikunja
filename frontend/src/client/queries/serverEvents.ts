import {
	useMutation,
	type QueryClient,
	type QueryKey,
} from '@tanstack/vue-query'
import type {TimeEntry} from '@/client/generated'
import {contextMutationOptions} from './contextMutation'
import {
	cachedTaskIdOf,
	normalizeTimeEntry,
	patchTimeEntry,
	removeTimeEntry,
	timeEntryKeys,
	type TimeEntryResponse,
} from './timeEntries'
import {notificationKeys} from './notifications'
import {commentKeys} from './comments'
import {taskKeys} from './tasks'
import {kanbanKeys} from './kanban'
import {
	invalidateTaskMembership,
	taskQueryKeys,
} from './taskCache'

export const CACHE_EVENTS = [
	'task.created',
	'task.updated',
	'task.deleted',
	'timer.created',
	'timer.updated',
	'timer.deleted',
	'notification.created',
] as const

export type ServerCacheEventName = typeof CACHE_EVENTS[number]

type TimerEvent = 'timer.created' | 'timer.updated' | 'timer.deleted'
type TaskEvent = 'task.created' | 'task.updated' | 'task.deleted'
export type ServerCacheEvent =
	| {
		kind: TaskEvent,
		taskId: number,
		projectId: number,
	}
	| {
		kind: TimerEvent,
		entry: TimeEntryResponse,
	}
	| {
		kind: 'notifications',
		taskId?: number,
	}
	| {
		kind: 'subscribed',
		since: number,
	}
	| {kind: 'reconnect'}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null
}

export function parseServerCacheEvent(
	event: ServerCacheEventName,
	data: unknown,
	currentUserId: number | undefined,
): ServerCacheEvent | null {
	if (!isRecord(data)) return null
	if (event === 'task.created' || event === 'task.updated' || event === 'task.deleted') {
		if (typeof data.id !== 'number' || !Number.isSafeInteger(data.id) || data.id <= 0) return null
		if (typeof data.project_id !== 'number'
			|| !Number.isSafeInteger(data.project_id)
			|| data.project_id <= 0) return null
		return {
			kind: event,
			taskId: data.id,
			projectId: data.project_id,
		}
	}
	if (event === 'timer.created' || event === 'timer.updated' || event === 'timer.deleted') {
		if (currentUserId === undefined || !isRecord(data.user) || data.user.id !== currentUserId) return null
		if (typeof data.id !== 'number' || data.id <= 0) return null
		if (data.task_id !== undefined && data.task_id !== null && typeof data.task_id !== 'number') return null
		return {
			kind: event,
			entry: normalizeTimeEntry(data as TimeEntry),
		}
	}
	if (event === 'notification.created') {
		const task = data.name === 'task.comment' && isRecord(data.notification) ? data.notification.task : undefined
		const taskId = isRecord(task) && typeof task.id === 'number' && task.id > 0 ? task.id : undefined
		if (taskId === undefined && !(typeof data.id === 'number' && data.id > 0)) return null
		return {
			kind: 'notifications',
			taskId,
		}
	}
	return null
}

const startsWith = (key: QueryKey, prefix: readonly unknown[]) => prefix.every((part, index) => key[index] === part)
const isTaskDetailKey = (key: QueryKey) => startsWith(key, taskKeys.details)

const SUBSCRIBE_SWEEP_KEYS = [
	notificationKeys.all,
	timeEntryKeys.all,
	commentKeys.all,
	taskKeys.details,
	taskKeys.lists,
	taskKeys.allLists,
	kanbanKeys.all,
]

// Only collections that already hold the task can have gone stale; its own detail key is invalidated anyway.
async function invalidateCachedTask(client: QueryClient, taskId: number | undefined): Promise<void> {
	if (!taskId) return
	const heldByCollection = taskQueryKeys(client, taskId).some(key => !isTaskDetailKey(key))
	await Promise.all([
		client.invalidateQueries({queryKey: taskKeys.detail(taskId)}),
		...(heldByCollection ? [invalidateTaskMembership(client)] : []),
	])
}

export function serverCacheEventMutationOptions() {
	return contextMutationOptions({
		mutationFn: async (event: ServerCacheEvent) => event,
		onSettled: (event, client) => {
			if (event.kind === 'task.created' || event.kind === 'task.updated' || event.kind === 'task.deleted') {
				const relatedDetails = taskQueryKeys(client, event.taskId).filter(key =>
					isTaskDetailKey(key) && !startsWith(key, taskKeys.detail(event.taskId)),
				)
				return Promise.all([
					// Parent details can embed the changed child even when its own detail is not cached.
					...relatedDetails.map(queryKey => client.invalidateQueries({queryKey, exact: true, refetchType: 'active'})),
					invalidateTaskMembership(client, event.taskId, 'active'),
					// Membership and per-view positions are server-decided, not a projection of the event payload.
					// Refresh all active boards: a move may leave an old project whose id the event does not carry.
					client.invalidateQueries({
						queryKey: kanbanKeys.all,
						refetchType: 'active',
					}),
				])
			}
			if ('entry' in event) {
				// The payload carries only the new task, so a reassignment would leave the old one's count stale.
				const previousTaskId = event.kind === 'timer.updated' ? cachedTaskIdOf(client, event.entry.id) : undefined
				if (event.kind === 'timer.deleted') removeTimeEntry(client, event.entry.id)
				else patchTimeEntry(client, event.entry)
				return Promise.all([
					// Whether a new entry belongs to a server-filtered list cannot be decided from the payload.
					...(event.kind === 'timer.created' ? [client.invalidateQueries({queryKey: timeEntryKeys.lists})] : []),
					invalidateCachedTask(client, event.entry.task_id),
					...(previousTaskId === event.entry.task_id ? [] : [invalidateCachedTask(client, previousTaskId)]),
				])
			}
			if (event.kind === 'notifications') {
				const taskId = event.taskId
				return Promise.all([
					client.invalidateQueries({queryKey: notificationKeys.all}),
					...(taskId === undefined ? [] : [
						client.invalidateQueries({queryKey: commentKeys.task(taskId)}),
						invalidateCachedTask(client, taskId),
					]),
				])
			}
			if (event.kind === 'subscribed') {
				// Data that arrived before the subscribe frames went out may have missed an event nobody saw.
				return client.invalidateQueries({
					predicate: query => query.state.dataUpdatedAt > 0
						&& query.state.dataUpdatedAt < event.since
						&& SUBSCRIBE_SWEEP_KEYS.some(prefix => startsWith(query.queryKey, prefix)),
				})
			}
			return Promise.all([
				client.invalidateQueries({queryKey: timeEntryKeys.all}),
				client.invalidateQueries({queryKey: notificationKeys.all}),
				client.invalidateQueries({queryKey: commentKeys.all}),
				client.invalidateQueries({queryKey: taskKeys.details}),
				invalidateTaskMembership(client, undefined, 'active'),
				client.invalidateQueries({
					queryKey: kanbanKeys.all,
					refetchType: 'active',
				}),
			])
		},
		toastError: () => false,
	})
}

export function useServerCacheEventMutation() {
	return useMutation(serverCacheEventMutationOptions())
}
