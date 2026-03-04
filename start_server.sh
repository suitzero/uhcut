#!/bin/bash
cd www
npx serve -s -p 8080 > ../server.log 2>&1 &
