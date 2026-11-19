/**
 * useKanbanSync — subscribes to task.created / task.updated / task.deleted
 * WebSocket events and updates the kanban store in real-time.
 *
 * Usage: call once inside the KanbanView component's setup().
 */

import {onUnmounted} from 'vue'
import {useWebSocket} from '@/composables/useWebSocket'
import {useKanbanStore} from '@/stores/kanban'
import TaskModel from '@/models/task'
import type {ITask} from '@/modelTypes/ITask'

export function useKanbanSync() {
	const {subscribe} = useWebSocket()
	const kanbanStore = useKanbanStore()

	const unsubCreated = subscribe('task.created', (msg) => {
		if (!msg.data) return
		const task = new TaskModel(msg.data as ITask)
		kanbanStore.ensureTaskIsInCorrectBucket(task)
	})

	const unsubUpdated = subscribe('task.updated', (msg) => {
		if (!msg.data) return
		const task = new TaskModel(msg.data as ITask)
		kanbanStore.ensureTaskIsInCorrectBucket(task)
	})

	const unsubDeleted = subscribe('task.deleted', (msg) => {
		if (!msg.data) return
		const task = msg.data as ITask
		kanbanStore.removeTaskFromBuckets(task.id)
	})

	onUnmounted(() => {
		unsubCreated()
		unsubUpdated()
		unsubDeleted()
	})
}
