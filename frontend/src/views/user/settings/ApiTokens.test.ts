import {describe, it, expect, beforeEach, afterEach, vi} from 'vitest'
import {mount, flushPromises, type VueWrapper} from '@vue/test-utils'
import {setActivePinia, createPinia} from 'pinia'
import {createI18n} from 'vue-i18n'
import {createRouter, createMemoryHistory} from 'vue-router'
import ApiTokens from '@/views/user/settings/ApiTokens.vue'
import Modal from '@/components/misc/Modal.vue'
import testid from '@/directives/testid'
import {VueQueryPlugin, QueryClient} from '@tanstack/vue-query'
import en from '@/i18n/lang/en.json'
import type {ApiToken} from '@/client/generated'

const tokens: ApiToken[] = [
	{
		id: 1,
		title: 'chrome-quick-add',
		token: '',
		permissions: {tasks: ['create', 'read_all']},
		expires_at: '2036-01-01T00:00:00Z',
		created: '2026-01-01T00:00:00Z',
	},
	{
		id: 2,
		title: 'backup-sync',
		token: '',
		permissions: {tasks: ['read_all']},
		expires_at: '2036-01-01T00:00:00Z',
		created: '2026-01-01T00:00:00Z',
	},
]

const SERVER_PER_PAGE = 50
let stored = tokens.slice()
const {getAll, del, create} = vi.hoisted(() => ({
	getAll: vi.fn(async ({query}: {query: {page: number}}) => ({data: {
		items: stored.slice((query.page - 1) * SERVER_PER_PAGE, query.page * SERVER_PER_PAGE),
		page: query.page,
		per_page: SERVER_PER_PAGE,
		total: stored.length,
		total_pages: Math.ceil(stored.length / SERVER_PER_PAGE),
	}})),
	del: vi.fn(async ({path}: {path: {id: number}}) => {
		stored = stored.filter(token => token.id !== path.id)
		return {}
	}),
	create: vi.fn(),
}))
vi.mock('@/client/generated', () => ({
	tokensList: getAll,
	tokensDelete: del,
	tokensCreate: create,
}))
vi.mock('@/message', () => ({success: vi.fn(), error: vi.fn()}))

const i18n = createI18n({legacy: false, locale: 'en', messages: {en}})

async function mountPage(path = '/user/settings/api-tokens') {
	const errors: unknown[] = []
	const router = createRouter({
		history: createMemoryHistory(),
		routes: [{path: '/user/settings/api-tokens', name: 'user.settings.apiTokens', component: ApiTokens}],
	})
	await router.push(path)
	await router.isReady()

	const wrapper = mount(ApiTokens, {
		global: {
			plugins: [
				i18n,
				router,
				[VueQueryPlugin, {queryClient: new QueryClient({defaultOptions: {queries: {retry: false}}})}],
			],
			components: {Modal},
			directives: {cy: testid},
			stubs: {
				Card: {template: '<div><slot /></div>'},
				XButton: {
					template: '<button type="button" v-bind="$attrs" @click="$emit(\'click\', $event)"><slot /></button>',
					emits: ['click'],
				},
				BaseButton: {template: '<a v-bind="$attrs"><slot /></a>'},
				Message: {template: '<div class="message"><slot /></div>'},
				Icon: true,
			},
			config: {
				errorHandler(err) {
					errors.push(err)
				},
			},
		},
		attachTo: document.body,
	})
	await flushPromises()
	return {wrapper, errors, router}
}

async function openDeleteModalForFirstToken(wrapper: VueWrapper) {
	const deleteBtn = wrapper.findAll('button').find(b => /delete/i.test(b.text()))
	expect(deleteBtn).toBeTruthy()
	await deleteBtn!.trigger('click')
	await flushPromises()

	const confirmBtn = document.querySelector<HTMLButtonElement>('dialog [data-cy="modalPrimary"]')
	expect(confirmBtn).toBeTruthy()
	return confirmBtn!
}

// Modal keeps the dialog mounted for its 150ms close transition.
async function settleCloseTransition() {
	await flushPromises()
	await new Promise(r => setTimeout(r, 200))
	await flushPromises()
}

function runtimeErrorMessages(errors: unknown[]) {
	return errors.map(e => (e instanceof Error ? e.message : String(e)))
}

describe('ApiTokens settings page', () => {
	let wrapper: VueWrapper | undefined

	beforeEach(() => {
		// Makes v-cy emit data-cy attributes so the modal's primary button is selectable.
		vi.stubGlobal('TESTING', true)
		setActivePinia(createPinia())
		document.body.innerHTML = ''
		del.mockClear()
		create.mockClear()
		getAll.mockClear()
		stored = tokens.slice()
	})

	afterEach(() => {
		wrapper?.unmount()
		wrapper = undefined
		vi.unstubAllGlobals()
		document.body.innerHTML = ''
	})

	it('keeps permissions in independent, initially collapsed native disclosures without API changes', async () => {
		stored = [
			{
				...tokens[0],
				permissions: {
					tasks: ['create', 'read_all'],
					task_comments: ['read_all', 'update'],
					projects: null,
				},
			},
			tokens[1],
		]
		const originalTokens = JSON.parse(JSON.stringify(stored))
		const mounted = await mountPage()
		wrapper = mounted.wrapper
		const rows = wrapper.findAll('tbody tr')
		const disclosures = rows.map(row => row.find<HTMLDetailsElement>('td details'))
		expect(disclosures).toHaveLength(2)

		for (const disclosure of disclosures) {
			expect(disclosure.exists()).toBe(true)
			expect(disclosure.element.open).toBe(false)
			// A shared name would turn the rows into a mutually exclusive accordion.
			expect(disclosure.attributes('name')).toBeUndefined()
			expect(disclosure.find('summary .permissions-show').text()).toBe('Show permissions')
			expect(disclosure.find('summary .permissions-hide').text()).toBe('Hide permissions')
		}

		const permissionList = disclosures[0].find('.is-capitalized')
		const originalPermissionText = permissionList.text()
		expect(permissionList.findAll('strong').map(group => group.text())).toEqual([
			'tasks:',
			'task comments:',
			'projects:',
		])
		expect(permissionList.text()).toContain('create, read all')
		expect(permissionList.text()).toContain('read all, update')
		expect(permissionList.text()).not.toContain('_')
		expect(disclosures[1].find('.is-capitalized').text()).toBe('tasks: read all')

		// DOM simulators do not reliably implement native summary activation; the browser verifies keyboard/click behavior.
		disclosures[0].element.open = true
		await disclosures[0].trigger('toggle')
		expect(disclosures[1].element.open).toBe(false)
		disclosures[1].element.open = true
		await disclosures[1].trigger('toggle')
		expect(disclosures[0].element.open).toBe(true)
		disclosures[0].element.open = false
		await disclosures[0].trigger('toggle')
		expect(disclosures[1].element.open).toBe(true)
		expect(disclosures[0].find('.is-capitalized').text()).toBe(originalPermissionText)

		expect(stored).toEqual(originalTokens)
		expect(getAll).toHaveBeenCalledTimes(1)
		expect(del).not.toHaveBeenCalled()
		expect(create).not.toHaveBeenCalled()
		expect(runtimeErrorMessages(mounted.errors)).toEqual([])
	})

	it('deletes a token without crashing while the modal close animation is in flight', async () => {
		const mounted = await mountPage()
		wrapper = mounted.wrapper
		const {errors} = mounted

		const confirmBtn = await openDeleteModalForFirstToken(wrapper)
		confirmBtn.click()
		await settleCloseTransition()

		expect(del).toHaveBeenCalledTimes(1)
		expect(del).toHaveBeenCalledWith({path: {id: 1}})
		expect(document.querySelector('dialog.modal-dialog')).toBeNull()

		const rows = wrapper.findAll('tbody tr')
		expect(rows).toHaveLength(1)
		expect(rows[0].text()).toContain('backup-sync')
		expect(wrapper.text()).not.toContain('chrome-quick-add')
		expect(runtimeErrorMessages(errors)).toEqual([])
	})

	it('keeps the delete text out of the closing modal once the token is gone', async () => {
		const mounted = await mountPage()
		wrapper = mounted.wrapper
		const {errors} = mounted

		const confirmBtn = await openDeleteModalForFirstToken(wrapper)
		confirmBtn.click()
		await flushPromises()

		// The dialog is still mounted here, in the middle of its close transition.
		const dialog = document.querySelector('dialog.modal-dialog')
		expect(dialog).not.toBeNull()
		expect(dialog?.textContent).not.toContain('Are you sure you want to delete the token')

		await settleCloseTransition()
		expect(runtimeErrorMessages(errors)).toEqual([])
	})

	it('deletes only once when the confirm button is double clicked', async () => {
		const mounted = await mountPage()
		wrapper = mounted.wrapper
		const {errors} = mounted

		const confirmBtn = await openDeleteModalForFirstToken(wrapper)
		confirmBtn.click()
		confirmBtn.click()
		await settleCloseTransition()

		expect(del).toHaveBeenCalledTimes(1)
		expect(del).toHaveBeenCalledWith({path: {id: 1}})
		expect(runtimeErrorMessages(errors)).toEqual([])
	})

	it('moves an out-of-range page in the route to the last page', async () => {
		const mounted = await mountPage('/user/settings/api-tokens?page=3')
		wrapper = mounted.wrapper
		await flushPromises()

		expect(mounted.router.currentRoute.value.query.page).toBe('1')
		expect(getAll).toHaveBeenLastCalledWith(expect.objectContaining({query: {page: 1}}))
		expect(wrapper.findAll('tbody tr')).toHaveLength(tokens.length)
		expect(runtimeErrorMessages(mounted.errors)).toEqual([])
	})

	it('loads the page from the route and steps back once its last token is deleted', async () => {
		stored = [
			...tokens,
			...Array.from({length: SERVER_PER_PAGE - tokens.length}, (_, index) => ({
				...tokens[1],
				id: index + 3,
				title: `token-${index + 3}`,
			})),
		]
		stored.push({
			...tokens[0],
			id: 99,
			title: 'last-page-token',
		})
		const mounted = await mountPage('/user/settings/api-tokens?page=2')
		wrapper = mounted.wrapper

		expect(getAll).toHaveBeenLastCalledWith(expect.objectContaining({query: {page: 2}}))
		expect(wrapper.findAll('tbody tr')).toHaveLength(1)
		expect(wrapper.find('nav.pagination').exists()).toBe(true)

		const confirmBtn = await openDeleteModalForFirstToken(wrapper)
		confirmBtn.click()
		await settleCloseTransition()

		expect(del).toHaveBeenCalledWith({path: {id: 99}})
		expect(mounted.router.currentRoute.value.query.page).toBe('1')
		expect(wrapper.findAll('tbody tr')).toHaveLength(SERVER_PER_PAGE)
		expect(wrapper.find('nav.pagination').exists()).toBe(false)
		expect(runtimeErrorMessages(mounted.errors)).toEqual([])
	})
})
