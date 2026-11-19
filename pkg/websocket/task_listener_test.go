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
	"encoding/json"
	"fmt"
	"testing"

	"code.vikunja.io/api/pkg/models"

	"github.com/ThreeDotsLabs/watermill/message"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func taskConn(userID int64) *Connection {
	return &Connection{
		userID:        userID,
		subscriptions: map[string]bool{"task.created": true, "task.updated": true, "task.deleted": true},
		send:          make(chan OutgoingMessage, 16),
	}
}

func handleTaskEvent(t *testing.T, eventName string, task *models.Task) {
	t.Helper()
	payload, err := json.Marshal(struct {
		Task *models.Task `json:"task"`
	}{Task: task})
	require.NoError(t, err)
	require.NoError(t, (&TaskListener{wsEvent: eventName}).Handle(message.NewMessage("task-event", payload)))
}

func TestTaskListener(t *testing.T) {
	for _, eventName := range []string{"task.created", "task.updated", "task.deleted"} {
		t.Run(eventName, func(t *testing.T) {
			for _, tc := range []struct {
				projectID int64
				allowed   []int64
			}{
				{3, []int64{1, 2, 3}},                     // Direct user and team shares; owner.
				{14, []int64{1, 6, 8, 9, 10, 11, 12, 13}}, // Parent user/team shares.
				{40, []int64{1, 2, 3}},                    // Parent has a different owner; archived remains readable.
				{42, []int64{6, 14}},                      // Team-only inherited access.
			} {
				t.Run(fmt.Sprintf("project-%d", tc.projectID), func(t *testing.T) {
					s := setupDBTest(t)
					// Keep the fixture task consistent with the event, avoiding another task's per-project index.
					_, err := s.ID(32).Cols("project_id", "index").Update(&models.Task{ProjectID: tc.projectID, Index: 100000})
					require.NoError(t, err)
					if eventName == "task.deleted" {
						// The task row is gone before delivery; Task.CanRead cannot authorize this event.
						deleted, err := s.ID(32).Delete(&models.Task{})
						require.NoError(t, err)
						require.EqualValues(t, 1, deleted)
					}
					require.NoError(t, s.Commit())
					InitHub()
					conns := map[int64]*Connection{}
					for _, uid := range []int64{1, 2, 3, 6, 8, 9, 10, 11, 12, 13, 14, 15} {
						conns[uid] = taskConn(uid)
						GetHub().Register(conns[uid])
					}
					unsubscribed := taskConn(tc.allowed[0])
					unsubscribed.Unsubscribe(eventName)
					GetHub().Register(unsubscribed)
					handleTaskEvent(t, eventName, &models.Task{
						ID: 32, ProjectID: tc.projectID, Title: "secret title", Description: "secret description", BucketID: 99,
					})
					for uid, conn := range conns {
						allowed := false
						for _, recipient := range tc.allowed {
							allowed = allowed || recipient == uid
						}
						if !allowed {
							assert.Empty(t, conn.send, "unrelated user %d must not receive task IDs", uid)
							continue
						}
						require.Len(t, conn.send, 1, "user %d must receive exactly one event", uid)
						msg := <-conn.send
						assert.Equal(t, eventName, msg.Event)
						data, err := json.Marshal(msg.Data)
						require.NoError(t, err)
						assert.JSONEq(t, fmt.Sprintf(`{"id":32,"project_id":%d}`, tc.projectID), string(data), "no full task or guessed bucket data")
					}
					assert.Empty(t, unsubscribed.send)
				})
			}
		})
	}
}

func TestTaskListenerRevokedAccess(t *testing.T) {
	for _, eventName := range []string{"task.created", "task.updated", "task.deleted"} {
		for _, projectID := range []int64{3, 40} {
			t.Run(fmt.Sprintf("%s/project-%d", eventName, projectID), func(t *testing.T) {
				s := setupDBTest(t)
				InitHub()
				conn := taskConn(2)
				GetHub().Register(conn)
				// Keep the connection subscribed across revocation: recipients cannot be cached.
				handleTaskEvent(t, eventName, &models.Task{ID: 32, ProjectID: projectID})
				require.Len(t, conn.send, 1)
				<-conn.send
				unshareProject(t, s, 3, 2)
				require.NoError(t, s.Commit())
				handleTaskEvent(t, eventName, &models.Task{ID: 32, ProjectID: projectID})
				assert.Empty(t, conn.send)
			})
		}
	}
}

func TestTaskListenerInvalidGrant(t *testing.T) {
	s := setupDBTest(t)
	// The candidate query joins user and team shares. A valid team share must
	// not make an invalid direct share on that same project grant access.
	_, err := s.Where("project_id = ? AND user_id = ?", 3, 2).
		Cols("permission").Update(&models.ProjectUser{Permission: models.Permission(99)})
	require.NoError(t, err)
	_, err = s.Where("team_id = ? AND user_id = ?", 1, 2).Delete(&models.TeamMember{})
	require.NoError(t, err)
	require.NoError(t, s.Commit())
	InitHub()
	conn := taskConn(2)
	GetHub().Register(conn)
	for _, eventName := range []string{"task.created", "task.updated", "task.deleted"} {
		handleTaskEvent(t, eventName, &models.Task{ID: 32, ProjectID: 3})
	}
	assert.Empty(t, conn.send, "candidate IDs must be rechecked with Project.CanRead")
}

func TestTaskListenerMissingProject(t *testing.T) {
	for _, projectID := range []int64{999999, 45, 46} {
		t.Run(fmt.Sprint(projectID), func(t *testing.T) {
			setupDBTest(t)
			InitHub()
			conn := taskConn(1)
			GetHub().Register(conn)
			for _, eventName := range []string{"task.created", "task.updated", "task.deleted"} {
				handleTaskEvent(t, eventName, &models.Task{ID: 32, ProjectID: projectID})
			}
			assert.Empty(t, conn.send, "missing and trashed projects must fail closed")
		})
	}
}

func TestTaskListenerInvalidEvent(t *testing.T) {
	InitHub()
	conn := taskConn(1)
	GetHub().Register(conn)
	for _, payload := range []string{
		`null`, `{}`, `{"task":null}`, `{"task":{}}`,
		`{"task":{"id":0,"project_id":1}}`, `{"task":{"id":-1,"project_id":1}}`,
		`{"task":{"id":32,"project_id":0}}`, `{"task":{"id":32,"project_id":-1}}`,
	} {
		t.Run(payload, func(t *testing.T) {
			require.NoError(t, (&TaskListener{wsEvent: "task.updated"}).Handle(message.NewMessage("invalid-task", []byte(payload))))
		})
	}
	for _, payload := range []string{`{`, `{"task":[]}`, `{"task":{"id":"32","project_id":1}}`} {
		t.Run(payload, func(t *testing.T) {
			require.Error(t, (&TaskListener{wsEvent: "task.updated"}).Handle(message.NewMessage("malformed-task", []byte(payload))))
		})
	}
	require.NoError(t, (&TaskListener{wsEvent: "task.updated"}).Handle(nil))
	assert.Empty(t, conn.send)
}

func TestTaskEventsAreSubscribable(t *testing.T) {
	for _, eventName := range []string{"task.created", "task.updated", "task.deleted"} {
		assert.True(t, isValidEvent(eventName))
	}
	assert.False(t, isValidEvent("task.unknown"))
}
