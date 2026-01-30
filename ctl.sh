#!/bin/bash
cd "$(dirname "$0")"

case "$1" in
  start)
    # Kill any orphaned process on port 3379 first
    pid=$(lsof -ti :3379 2>/dev/null)
    if [ -n "$pid" ]; then
      echo "Killing orphaned process $pid on port 3379"
      kill "$pid" 2>/dev/null
      sleep 1
    fi
    uv run supervisord -c supervisord.conf
    ;;
  stop)
    uv run supervisorctl -c supervisord.conf shutdown 2>/dev/null
    # Kill any orphaned process on port 3379
    pid=$(lsof -ti :3379 2>/dev/null)
    if [ -n "$pid" ]; then
      echo "Killing orphaned process $pid on port 3379"
      kill "$pid" 2>/dev/null
      sleep 1
    fi
    ;;
  restart)
    uv run supervisorctl -c supervisord.conf restart cdburner
    ;;
  status)
    uv run supervisorctl -c supervisord.conf status
    ;;
  logs)
    tail -f logs/cdburner.log
    ;;
  *)
    echo "Usage: $0 {start|stop|restart|status|logs}"
    exit 1
    ;;
esac
