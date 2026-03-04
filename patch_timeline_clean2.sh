#!/bin/bash
sed -i '/closeReorderMode() {/,+54d' ui/src/app/components/timeline/timeline.ts
