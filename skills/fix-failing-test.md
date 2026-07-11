---
name: fix-failing-test
description: run the tests, find the failure, fix it, verify
---
1. Run the test command with Bash and read the failure output. If no test command was given, look for one in package.json scripts or a test file in the project root.
2. Read the file the failure points to and find the cause.
3. Fix it with Edit — the minimal change only.
4. Run the tests again and confirm they pass. If they still fail, go back to step 2.

Task input: $ARGUMENTS
