#!/bin/bash
# Browser control helper for Claude Code agent
# Usage: browser <action> [params...]
#
# Examples:
#   browser navigate https://google.com
#   browser click "#search-btn"
#   browser type "#input" "hello world"
#   browser fill "#email" "user@example.com"
#   browser getText "main"
#   browser getLinks
#   browser getPageInfo
#   browser evaluate "document.title"
#   browser newTab https://github.com
#   browser listTabs
#   browser switchTab tab-1
#   browser back
#   browser scroll down

MC_URL="${MC_URL:-http://localhost:3001}"
ACTION="$1"
shift

case "$ACTION" in
  navigate)
    curl -s "$MC_URL/api/browser" -H 'Content-Type: application/json' -d "{\"action\":\"navigate\",\"url\":\"$1\"}"
    ;;
  click)
    curl -s "$MC_URL/api/browser" -H 'Content-Type: application/json' -d "{\"action\":\"click\",\"selector\":\"$1\"}"
    ;;
  type)
    curl -s "$MC_URL/api/browser" -H 'Content-Type: application/json' -d "{\"action\":\"type\",\"selector\":\"$1\",\"text\":\"$2\"}"
    ;;
  fill)
    curl -s "$MC_URL/api/browser" -H 'Content-Type: application/json' -d "{\"action\":\"fill\",\"selector\":\"$1\",\"text\":\"$2\"}"
    ;;
  press)
    curl -s "$MC_URL/api/browser" -H 'Content-Type: application/json' -d "{\"action\":\"press\",\"key\":\"$1\"}"
    ;;
  select)
    curl -s "$MC_URL/api/browser" -H 'Content-Type: application/json' -d "{\"action\":\"select\",\"selector\":\"$1\",\"value\":\"$2\"}"
    ;;
  getText)
    curl -s "$MC_URL/api/browser" -H 'Content-Type: application/json' -d "{\"action\":\"getText\",\"selector\":\"${1:-body}\"}"
    ;;
  getLinks)
    curl -s "$MC_URL/api/browser" -H 'Content-Type: application/json' -d "{\"action\":\"getLinks\",\"selector\":\"${1:-}\"}"
    ;;
  getPageInfo)
    curl -s "$MC_URL/api/browser" -H 'Content-Type: application/json' -d "{\"action\":\"getPageInfo\"}"
    ;;
  evaluate)
    curl -s "$MC_URL/api/browser" -H 'Content-Type: application/json' -d "{\"action\":\"evaluate\",\"script\":\"$1\"}"
    ;;
  querySelector)
    curl -s "$MC_URL/api/browser" -H 'Content-Type: application/json' -d "{\"action\":\"querySelector\",\"selector\":\"$1\"}"
    ;;
  querySelectorAll)
    curl -s "$MC_URL/api/browser" -H 'Content-Type: application/json' -d "{\"action\":\"querySelectorAll\",\"selector\":\"$1\"}"
    ;;
  waitFor)
    curl -s "$MC_URL/api/browser" -H 'Content-Type: application/json' -d "{\"action\":\"waitFor\",\"selector\":\"$1\"}"
    ;;
  getAttribute)
    curl -s "$MC_URL/api/browser" -H 'Content-Type: application/json' -d "{\"action\":\"getAttribute\",\"selector\":\"$1\",\"attribute\":\"$2\"}"
    ;;
  getInputValues)
    curl -s "$MC_URL/api/browser" -H 'Content-Type: application/json' -d "{\"action\":\"getInputValues\",\"selector\":\"${1:-}\"}"
    ;;
  newTab)
    curl -s "$MC_URL/api/browser" -H 'Content-Type: application/json' -d "{\"action\":\"newTab\",\"url\":\"${1:-}\"}"
    ;;
  switchTab)
    curl -s "$MC_URL/api/browser" -H 'Content-Type: application/json' -d "{\"action\":\"switchTab\",\"tabId\":\"$1\"}"
    ;;
  closeTab)
    curl -s "$MC_URL/api/browser" -H 'Content-Type: application/json' -d "{\"action\":\"closeTab\",\"tabId\":\"$1\"}"
    ;;
  listTabs)
    curl -s "$MC_URL/api/browser" -H 'Content-Type: application/json' -d "{\"action\":\"listTabs\"}"
    ;;
  back)
    curl -s "$MC_URL/api/browser" -H 'Content-Type: application/json' -d "{\"action\":\"back\"}"
    ;;
  forward)
    curl -s "$MC_URL/api/browser" -H 'Content-Type: application/json' -d "{\"action\":\"forward\"}"
    ;;
  reload)
    curl -s "$MC_URL/api/browser" -H 'Content-Type: application/json' -d "{\"action\":\"reload\"}"
    ;;
  scroll)
    curl -s "$MC_URL/api/browser" -H 'Content-Type: application/json' -d "{\"action\":\"scroll\",\"direction\":\"${1:-down}\",\"amount\":${2:-500}}"
    ;;
  connect)
    curl -s "$MC_URL/api/browser" -H 'Content-Type: application/json' -d "{\"action\":\"connect\",\"port\":${1:-9222}}"
    ;;
  status)
    curl -s "$MC_URL/api/browser"
    ;;
  close)
    curl -s "$MC_URL/api/browser" -H 'Content-Type: application/json' -d "{\"action\":\"close\"}"
    ;;
  *)
    echo "Usage: browser <action> [params...]"
    echo "Actions: navigate click type fill press select getText getLinks getPageInfo evaluate querySelector querySelectorAll waitFor getAttribute getInputValues newTab switchTab closeTab listTabs back forward reload scroll status close"
    ;;
esac
