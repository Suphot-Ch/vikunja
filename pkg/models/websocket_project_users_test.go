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
	"fmt"
	"testing"

	"code.vikunja.io/api/pkg/db"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestGetUserIDsForProject(t *testing.T) {
	for _, tc := range []struct {
		projectID int64
		want      []int64
	}{
		{3, []int64{1, 2, 3}},
		{14, []int64{1, 6, 8, 9, 10, 11, 12, 13}},
		{40, []int64{1, 2, 3}},
		{42, []int64{6, 14}},
	} {
		t.Run(fmt.Sprint(tc.projectID), func(t *testing.T) {
			db.LoadAndAssertFixtures(t)
			s := db.NewSession()
			defer s.Close()
			got, err := GetUserIDsForProject(s, tc.projectID)
			require.NoError(t, err)
			assert.ElementsMatch(t, tc.want, got, "must include ancestor owners and shares, once each, without zero IDs")
		})
	}
}

func TestGetUserIDsForProjectMissingOrTrashed(t *testing.T) {
	db.LoadAndAssertFixtures(t)
	s := db.NewSession()
	defer s.Close()
	for _, projectID := range []int64{0, -1, 999999, 45, 46} {
		t.Run(fmt.Sprint(projectID), func(t *testing.T) {
			got, err := GetUserIDsForProject(s, projectID)
			require.Error(t, err)
			assert.True(t, IsErrProjectDoesNotExist(err))
			assert.Empty(t, got)
		})
	}
}
