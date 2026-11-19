import {beforeEach, expect, it, vi} from 'vitest'
import {defineComponent, ref, type Ref} from 'vue'
import {flushPromises, mount} from '@vue/test-utils'
import {QueryClient, VueQueryPlugin} from '@tanstack/vue-query'
import {useServerCacheEvents} from './useServerCacheEvents'
import {kanbanKeys} from '@/client/queries/kanban'

const ws = vi.hoisted(() => ({
	authenticated: undefined as unknown as Ref<boolean>,
	mayHaveMissedEvents: undefined as unknown as Ref<boolean>,
	subscribedAt: undefined as unknown as Ref<number>,
	handlers: new Map<string, (message: {data: unknown}) => void>(),
	subscribe: vi.fn(),
	unsubscribe: vi.fn(),
}))
vi.mock('./useWebSocket', () => ({
	useWebSocket: () => ({
		authenticated: ws.authenticated,
		mayHaveMissedEvents: ws.mayHaveMissedEvents,
		subscribedAt: ws.subscribedAt,
		subscribe: ws.subscribe,
	}),
}))
vi.mock('@/stores/auth', () => ({
	useAuthStore: () => ({info: {id: 7}}),
}))
vi.mock('@/message', () => ({
	error: vi.fn(),
	success: vi.fn(),
}))

beforeEach(() => {
	vi.clearAllMocks()
	ws.authenticated = ref(false)
	ws.mayHaveMissedEvents = ref(false)
	ws.subscribedAt = ref(0)
	ws.handlers.clear()
	ws.subscribe.mockImplementation((event: string, callback: (message: {data: unknown}) => void) => {
		ws.handlers.set(event, callback)
		return () => {
			ws.unsubscribe(event)
			ws.handlers.delete(event)
		}
	})
})

it.each(['task.created', 'task.updated', 'task.deleted'] as const)(
	'routes %s through the global subscriber and cleans up its one subscription',
	async event => {
		const client = new QueryClient()
		const boardKey = kanbanKeys.board(1, 1)
		client.setQueryData(boardKey, {
			buckets: [],
			pages: {},
		})
		const wrapper = mount(defineComponent({
			setup() {
				useServerCacheEvents()
				return () => null
			},
		}), {
			global: {plugins: [[VueQueryPlugin, {queryClient: client}]]},
		})
		try {
			expect(ws.subscribe.mock.calls.filter(([name]) => name === event)).toHaveLength(1)
			const handler = ws.handlers.get(event)!
			handler({data: {
				id: 'malformed',
				project_id: 1,
			}})
			await flushPromises()
			expect(client.getMutationCache().getAll()).toHaveLength(0)
			expect(client.getQueryState(boardKey)?.isInvalidated).toBe(false)
			handler({data: {
				id: 3,
				project_id: 1,
				created_by: {id: 8},
			}})
			await flushPromises()
			expect(client.getQueryState(boardKey)?.isInvalidated).toBe(true)
			expect(client.getMutationCache().getAll()).toHaveLength(1)
		} finally {
			wrapper.unmount()
			client.clear()
		}
		expect(ws.unsubscribe.mock.calls.filter(([name]) => name === event)).toHaveLength(1)
		expect(ws.handlers.has(event)).toBe(false)
	},
)
