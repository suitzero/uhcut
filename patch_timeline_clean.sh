#!/bin/bash
sed -i '/reorderClips: Clip\[\] = \[\];/d' ui/src/app/components/timeline/timeline.ts
sed -i '/reorderDragIndex = -1;/d' ui/src/app/components/timeline/timeline.ts
sed -i '/reorderDragOverIndex = -1;/d' ui/src/app/components/timeline/timeline.ts
