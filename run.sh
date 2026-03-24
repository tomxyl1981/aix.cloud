#!/bin/bash
while true; do
  cd /Users/xiaoyao/Desktop/AIII/aix.cloud
  node src/index.js >> /tmp/server.log 2>&1
  echo "Server crashed, restarting in 2 seconds..." >> /tmp/server.log
  sleep 2
done
