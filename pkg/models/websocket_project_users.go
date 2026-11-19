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
	"xorm.io/builder"
	"xorm.io/xorm"
)

// GetUserIDsForProject returns the unique set of user IDs who have access to
// the given project (via direct ownership, direct user share, or team membership).
// This is used by the WebSocket layer to broadcast task events to the right clients.
func GetUserIDsForProject(s *xorm.Session, projectID int64) ([]int64, error) {
	type row struct {
		OwnerID    int64 `xorm:"owner_id"`
		UserID     int64 `xorm:"ul_user_id"`
		TeamUserID int64 `xorm:"tm_user_id"`
	}

	rows := []*row{}
	err := s.
		Select(`l.owner_id, ul.user_id as ul_user_id, tm.user_id as tm_user_id`).
		Table("projects").
		Alias("l").
		Join("LEFT", []string{"users_projects", "ul"}, "ul.project_id = l.id").
		Join("LEFT", []string{"team_projects", "tl"}, "tl.project_id = l.id").
		Join("LEFT", []string{"team_members", "tm"}, "tm.team_id = tl.team_id").
		Where(builder.Eq{"l.id": projectID}).
		Find(&rows)
	if err != nil {
		return nil, err
	}

	// De-duplicate
	seen := map[int64]struct{}{}
	result := []int64{}
	for _, r := range rows {
		for _, id := range []int64{r.OwnerID, r.UserID, r.TeamUserID} {
			if id > 0 {
				if _, ok := seen[id]; !ok {
					seen[id] = struct{}{}
					result = append(result, id)
				}
			}
		}
	}
	return result, nil
}
