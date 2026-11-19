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

	"code.vikunja.io/api/pkg/db"
	"code.vikunja.io/api/pkg/events"
	"code.vikunja.io/api/pkg/log"
	"code.vikunja.io/api/pkg/models"
	"code.vikunja.io/api/pkg/notifications"

	"github.com/ThreeDotsLabs/watermill/message"
)

// NotificationListener pushes new notifications to WebSocket clients.
type NotificationListener struct{}

// Name returns the listener name.
func (n *NotificationListener) Name() string {
	return "websocket.notification.push"
}

// Handle processes a notification created event, reloads the notification
// from the database (to get accurate timestamps), and pushes it to the
// relevant WebSocket connections.
func (n *NotificationListener) Handle(msg *message.Message) error {
	var event notifications.NotificationCreatedEvent
	if err := json.Unmarshal(msg.Payload, &event); err != nil {
		return err
	}

	hub := GetHub()
	if hub == nil {
		log.Warningf("WebSocket: hub not initialized, skipping notification push")
		return nil
	}

	s := db.NewSession()
	defer s.Close()

	dbNotification, err := notifications.GetNotificationByID(s, event.NotificationID)
	if err != nil {
		log.Errorf("WebSocket: failed to load notification %d: %v", event.NotificationID, err)
		return nil
	}
	if dbNotification == nil {
		log.Warningf("WebSocket: notification %d not found, skipping push", event.NotificationID)
		return nil
	}

	hub.PublishForUser(event.UserID, "notification.created", dbNotification)
	return nil
}

// TimeEntryListener pushes a user's own timer changes to their WebSocket
// connections. wsEvent is "timer.created", "timer.updated" or "timer.deleted";
// the payload is the full entry, so the running-elsewhere badge reads end_time
// to know whether a timer is active (and the id to drop a deleted one). Not
// emitted on unlicensed instances.
type TimeEntryListener struct {
	wsEvent string
}

func (l *TimeEntryListener) Name() string { return "websocket.push." + l.wsEvent }

func (l *TimeEntryListener) Handle(msg *message.Message) error {
	// All TimeEntry events share the {time_entry, doer} shape; only the entry is needed.
	var event struct {
		TimeEntry *models.TimeEntry `json:"time_entry"`
	}
	if err := json.Unmarshal(msg.Payload, &event); err != nil {
		return err
	}
	if event.TimeEntry == nil {
		return nil
	}

	hub := GetHub()
	if hub == nil {
		log.Warningf("WebSocket: hub not initialized, skipping timer push")
		return nil
	}

	hub.PublishForUser(event.TimeEntry.UserID, l.wsEvent, event.TimeEntry)
	return nil
}

// TaskListener broadcasts task create/update/delete events to all users
// who have access to the affected project.
type TaskListener struct {
	wsEvent string
}

func (l *TaskListener) Name() string { return "websocket.task.push." + l.wsEvent }

func (l *TaskListener) Handle(msg *message.Message) error {
	var event struct {
		Task *models.Task `json:"task"`
	}
	if err := json.Unmarshal(msg.Payload, &event); err != nil {
		return err
	}
	if event.Task == nil {
		return nil
	}

	hub := GetHub()
	if hub == nil {
		return nil
	}

	s := db.NewSession()
	defer s.Close()

	// Populate BucketID if not set
	if event.Task.BucketID == 0 {
		var tb struct {
			BucketID int64 `xorm:"bucket_id"`
		}
		has, err := s.Table("task_buckets").
			Select("bucket_id").
			Where("task_id = ?", event.Task.ID).
			Get(&tb)
		if err == nil && has {
			event.Task.BucketID = tb.BucketID
		}
	}

	// Get all user IDs that have access to this project
	userIDs, err := models.GetUserIDsForProject(s, event.Task.ProjectID)
	if err != nil {
		log.Errorf("WebSocket: failed to get users for project %d: %v", event.Task.ProjectID, err)
		return nil
	}

	for _, userID := range userIDs {
		hub.PublishForUser(userID, l.wsEvent, event.Task)
	}
	return nil
}

// RegisterListeners registers WebSocket event listeners.
func RegisterListeners() {
	events.RegisterListener(
		(&notifications.NotificationCreatedEvent{}).Name(),
		&NotificationListener{},
	)
	events.RegisterListener((&models.TimeEntryCreatedEvent{}).Name(), &TimeEntryListener{wsEvent: "timer.created"})
	events.RegisterListener((&models.TimeEntryUpdatedEvent{}).Name(), &TimeEntryListener{wsEvent: "timer.updated"})
	events.RegisterListener((&models.TimeEntryDeletedEvent{}).Name(), &TimeEntryListener{wsEvent: "timer.deleted"})

	// Task realtime sync listeners
	events.RegisterListener((&models.TaskCreatedEvent{}).Name(), &TaskListener{wsEvent: "task.created"})
	events.RegisterListener((&models.TaskUpdatedEvent{}).Name(), &TaskListener{wsEvent: "task.updated"})
	events.RegisterListener((&models.TaskDeletedEvent{}).Name(), &TaskListener{wsEvent: "task.deleted"})
}
