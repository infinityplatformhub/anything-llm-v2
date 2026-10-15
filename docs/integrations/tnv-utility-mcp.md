# Connect TNv Utility in My MCP

Add `tnv-utility` to the existing MCP catalog, then connect each user's Utility API key through **My MCP**. The integration uses the existing Streamable HTTP transport and personal API-key support. It discovers the tools published by TNv without a local filter.

The catalog entry is separate from `tnv2-novels`. Keep both entries when both services are needed.

## Add the catalog entry

Run these commands from the repository root with the same Node.js version and dependencies as the application. Set `STORAGE_DIR` to the application's persistent storage directory.

1. Preview the change. The default is a dry run and writes no files.

   ```sh
   STORAGE_DIR=/path/to/storage node scripts/mcp/configure-tnv-utility.cjs
   ```

2. Pause other MCP catalog edits for the duration of the command, including admin UI edits and deployment scripts. Other writers do not share the script's lock. If you cannot exclude concurrent catalog edits, stop all application replicas before applying.

3. Apply the entry.

   ```sh
   STORAGE_DIR=/path/to/storage node scripts/mcp/configure-tnv-utility.cjs --apply
   ```

4. Reopen **My MCP** to load the catalog. This catalog-only change does not require an application restart.

The script writes `plugins/anythingllm_mcp_servers.json` under `STORAGE_DIR`. It validates the new entry with the application's `serverConfig` validator, preserves existing entries and top-level fields, and replaces the file atomically. A successful repeat reports `unchanged` and creates no additional backup.

Before changing an existing file, the script saves its exact contents beside it in a unique `.tnv-utility-*.bak` file. Both the backup and the replacement have mode `0600` because existing entries may contain credentials. Keep the backup in protected storage.

The script refuses an existing `tnv-utility` entry whose definition differs. Review that entry manually. It also rejects malformed catalogs, an existing script lock, and a catalog change detected before replacement. The last check is not a compare-and-swap operation. Prevent concurrent catalog edits until the command finishes.

If an interrupted run leaves `.tnv-utility.lock`, confirm that the process ID in the file is no longer running before removing the lock. Do not remove another run's lock. To restore the backup, stop the application, restore the saved catalog, and restart it. Do not restore over catalog changes made after the backup.

## Connect a user

1. Open **My MCP** in the deployed application.
2. Find `tnv-utility` and enter that user's TNv Utility API key.
3. Connect and enable the integration for that user.
4. Confirm that the seven tools are available.

The key is sent to `https://utility-production-4bec.up.railway.app/mcp` as `X-API-Key` through the existing personal connection. Do not add a shared key to the global catalog or paste a key into chat. Each user connects and enables their own entry. Sharing a Utility API key grants access to the same TNv test dataset.

## Use the tools

The [TNv MCP guide](https://utility-production-4bec.up.railway.app/mcp-docs) publishes these tools.

- `search_recommendation_novels` finds novels and their IDs.
- `list_recommendation_readers` lists reader IDs from the test dataset.
- `recommend_novels` returns related or personal recommendations. It may incur BGE and Jev inference charges.
- `recommendation_sections` returns the `trending`, `trending_for_you`, and `because_you_read` sections with evidence for each item. It may incur inference charges and stores a delivery receipt.
- `explain_recommendation` explains an item from an earlier result using that result's `request_id`, `section_id`, and `novel_id`. It reads the stored evidence and does not rerank.
- `submit_duplicate_check` creates a real duplicate-check job and may incur inference charges.
- `get_duplicate_check` reads a job's status and similarity evidence without starting inference.

For personal recommendations, supply one TNv account selector in the chat. Use an email, username, user ID, or legacy reader ID. Do not infer that the AnythingLLM account is the TNv account. TNv matches accounts against a local snapshot and does not verify account ownership. If a username matches several accounts, TNv returns `account_ambiguous`; use the TNv user ID instead. If the account is absent, report `account_not_found` rather than inventing a reader profile.

`recommendation_sections` accepts at most one account selector. Omit the selector for general discovery. A supplied `novel_id` is a related seed, not evidence that the reader read it. Sections without evidence are reported as unavailable. Historical data carries a dated title rather than a current trending claim. A delivery receipt records that items were returned; it is not an impression, a click, or a reading event. To answer why an item was recommended, call `explain_recommendation` with the identifiers from the original result. An expired or missing receipt returns `not_found`.

For a duplicate check, supply the actual full text of exactly ten chapters in order. Preserve paragraph boundaries. Each chapter needs at least 100 Unicode characters after trimming. This minimum does not guarantee that TNv can select the required context from the paragraphs. Do not invent, summarize, or pad chapters to satisfy validation. Reuse an `idempotency_key` for a retry of the same submission, then poll the returned job ID with `get_duplicate_check`. Report similarity evidence without claiming that similarity proves plagiarism.

Read recommendation results according to the [Recommendation API specification](https://utility-production-4bec.up.railway.app/api-docs/recommendations). Preserve `ranking_used`, `stages`, `fallback_reason`, `context_provenance`, `snapshot_provenance`, and `limitations` when explaining the result. Scores are ranking scores, not accuracy percentages or click probabilities. For `decision=abstained` or `decision=empty`, explain the absence of recommendations without fabricating items. For `profile_status=cold_start`, state that recommendations use historical popularity and any caller-supplied context.

The documented pilot uses July 13–14, 2026 reading activity. It has no live Main production connection or live popularity signal. Caller-supplied `context` is not activity independently observed by the service.

## Verify the connection

Run the persisted-catalog tests from the repository root.

```sh
node node_modules/jest/bin/jest.js server/__tests__/utils/MCP/tnvUtilityCatalog.test.js --runInBand
```

In the deployed application, connect a test user's key, list the seven tools, and search for a novel. Use the returned novel ID for a related recommendation. Verify a personal recommendation with a TNv account selector supplied by the user. Check that a second user without a connection cannot use the first user's credentials. Confirm that existing MCP connections still work.

Exercise duplicate submission only with real chapter text provided for that purpose. Follow the returned job through `get_duplicate_check`. Keep account details, keys, and chapter text out of test logs.
