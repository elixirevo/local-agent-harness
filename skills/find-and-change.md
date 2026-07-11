---
name: find-and-change
description: locate a symbol or value in the codebase and change it safely
---
1. Use Grep to find where the target is DEFINED (not just used).
2. Read that file to see the exact current content.
3. Change it with Edit — the minimal change only.
4. Use Grep again to confirm the old value is gone and the new value is present.

Task input: $ARGUMENTS
