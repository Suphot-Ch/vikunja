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

package models

import (
	"context"
	"encoding/json"
	"testing"

	"code.vikunja.io/api/pkg/db"
	"code.vikunja.io/api/pkg/events"
	"code.vikunja.io/api/pkg/user"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestTaskUpdateCrossProjectInvalidation(t *testing.T) {
	for _, tc := range []struct {
		name      string
		projectID int64
		rollback  bool
	}{
		{
			name:      "move commits",
			projectID: 2,
		},
		{
			name:      "move rolls back",
			projectID: 2,
			rollback:  true,
		},
		{
			name:      "same project",
			projectID: 1,
		},
		{
			name: "project omitted",
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			db.LoadAndAssertFixtures(t)
			s := db.NewSession()
			defer s.Close()
			defer events.CleanupPending(s)
			require.NoError(t, s.Begin())
			events.ClearDispatchedEvents()

			task := &Task{
				ID:          1,
				ProjectID:   tc.projectID,
				Title:       "private destination title",
				Description: "private destination description",
			}
			require.NoError(t, task.Update(s, &user.User{ID: 1}))
			assert.Zero(t, events.CountDispatchedEvents("task.moved_from_project"), "must not publish before commit")
			assert.Zero(t, events.CountDispatchedEvents("task.updated"))

			if tc.rollback {
				require.NoError(t, s.Rollback())
				events.CleanupPending(s)
				events.DispatchPending(context.Background(), s)
				assert.Zero(t, events.CountDispatchedEvents("task.moved_from_project"))
				assert.Zero(t, events.CountDispatchedEvents("task.updated"))
				db.AssertExists(t, "tasks", map[string]interface{}{
					"id":         1,
					"project_id": 1,
				}, false)
				return
			}

			require.NoError(t, s.Commit())
			events.DispatchPending(context.Background(), s)
			updated := events.GetDispatchedEvents("task.updated")
			require.Len(t, updated, 1)
			assert.Equal(t, task.ProjectID, updated[0].(*TaskUpdatedEvent).Task.ProjectID)
			moved := events.GetDispatchedEvents("task.moved_from_project")
			if tc.projectID != 2 {
				assert.Empty(t, moved, "ordinary updates must not invalidate another project")
				return
			}

			require.Len(t, moved, 1)
			payload, err := json.Marshal(moved[0])
			require.NoError(t, err)
			var event struct {
				Task *Task `json:"task"`
			}
			require.NoError(t, json.Unmarshal(payload, &event))
			assert.Equal(t, &Task{
				ID:        1,
				ProjectID: 1,
			}, event.Task, "internal source invalidation must retain only the task and original project IDs")
			assert.NotContains(t, string(payload), "private destination")
		})
	}
}
