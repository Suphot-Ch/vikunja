// Vikunja is a to-do list application to facilitate your life.
// Copyright 2018-present Vikunja and contributors. All rights reserved.
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with this program.  If not, see <https://www.gnu.org/licenses/>.

package websocket

import (
	"context"
	"encoding/json"
	"fmt"
	"sync"
	"testing"

	"code.vikunja.io/api/pkg/config"
	"code.vikunja.io/api/pkg/events"
	"code.vikunja.io/api/pkg/models"
	"code.vikunja.io/api/pkg/user"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

var taskMoveListenersOnce sync.Once

func TestTaskListenerCrossProjectMove(t *testing.T) {
	s := setupDBTest(t)
	defer events.CleanupPending(s)
	_, err := s.Insert(&models.ProjectUser{
		ProjectID:  1,
		UserID:     2,
		Permission: models.PermissionRead,
	}, &models.ProjectUser{
		ProjectID:  2,
		UserID:     1,
		Permission: models.PermissionWrite,
	})
	require.NoError(t, err)
	require.NoError(t, s.Commit())
	InitHub()
	conns := map[int64]*Connection{}
	for _, uid := range []int64{1, 2, 3, 15} {
		conns[uid] = taskConn(uid)
		GetHub().Register(conns[uid])
	}

	// Both listeners must be wired through production registration, not invoked by hand.
	taskMoveListenersOnce.Do(RegisterListeners)
	events.ClearDispatchedEvents()
	require.NoError(t, s.Begin())
	task := &models.Task{
		ID:          1,
		ProjectID:   2,
		Title:       "private destination title",
		Description: "private destination description",
	}
	require.NoError(t, task.Update(s, &user.User{ID: 1}))
	assert.Zero(t, events.CountDispatchedEvents("task.updated"))
	assert.Zero(t, events.CountDispatchedEvents("task.moved_from_project"))
	for _, conn := range conns {
		assert.Empty(t, conn.send, "no invalidation before commit")
	}
	require.NoError(t, s.Commit())
	events.DispatchPending(context.Background(), s)
	for _, eventName := range []string{"task.updated", "task.moved_from_project"} {
		dispatched := events.GetDispatchedEvents(eventName)
		require.Len(t, dispatched, 1)
		listeners := events.ListenersFor(eventName)
		found := false
		for _, listener := range listeners {
			if _, ok := listener.(*TaskListener); ok {
				found = true
				events.TestListener(t, dispatched[0], listener)
			}
		}
		require.True(t, found, "missing task invalidation listener for %s", eventName)
	}

	for _, tc := range []struct {
		name       string
		userID     int64
		projectIDs []int64
	}{
		{
			name:       "source only",
			userID:     2,
			projectIDs: []int64{1},
		},
		{
			name:       "destination only",
			userID:     3,
			projectIDs: []int64{2},
		},
		{
			name:       "shared",
			userID:     1,
			projectIDs: []int64{2, 1},
		},
		{
			name:   "outsider",
			userID: 15,
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			conn := conns[tc.userID]
			require.Len(t, conn.send, len(tc.projectIDs))
			for _, projectID := range tc.projectIDs {
				msg := <-conn.send
				assert.Equal(t, "task.updated", msg.Event)
				payload, err := json.Marshal(msg.Data)
				require.NoError(t, err)
				assert.JSONEq(t, fmt.Sprintf(`{"id":1,"project_id":%d}`, projectID), string(payload), "no destination metadata, contents or bucket IDs")
			}
		})
	}
}

func TestTaskMoveInvalidationIsInternal(t *testing.T) {
	enabled := config.WebhooksEnabled.GetBool()
	config.WebhooksEnabled.Set(true)
	t.Cleanup(func() { config.WebhooksEnabled.Set(enabled) })
	models.RegisterListeners()
	taskMoveListenersOnce.Do(RegisterListeners)
	name := (&models.TaskMovedFromProjectEvent{}).Name()
	assert.False(t, isValidEvent(name), "clients subscribe to task.updated, not the internal event")
	assert.NotContains(t, models.GetAvailableWebhookEvents(), name)
	for _, listener := range events.ListenersFor(name) {
		assert.IsType(t, &TaskListener{}, listener, "internal event must not reach webhook or public task listeners")
	}
	assert.Contains(t, models.GetAvailableWebhookEvents(), "task.updated", "ordinary webhooks must remain registered")
}
