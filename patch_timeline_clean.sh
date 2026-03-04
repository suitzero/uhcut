#!/bin/bash
sed -i 's/  if (this.dragClipId   onTimelineClick  onTimelineClick this.dragOriginalTrackType === '\''audio'\'') {/  if (this.dragClipId \&\& this.dragOriginalTrackType === '\''audio'\'') {/' ui/src/app/components/timeline/timeline.ts
sed -i 's/  if (event.changedTouches   onTimelineClick  onTimelineClick event.changedTouches.length > 0) {/  if (event.changedTouches \&\& event.changedTouches.length > 0) {/' ui/src/app/components/timeline/timeline.ts
