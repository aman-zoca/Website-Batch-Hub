# Website Batch Generate & Publish

Automates bulk website generation and publishing via the Zoca internal API.

## How It Works

1. Reads all entities from `query_result_*.json`
2. Processes in **batches of 50**:
   - **Generate** each website (60s delay between calls)
   - **Publish** each website (15s delay between calls)
3. Logs all results to `results.csv`
4. Supports **resume** — if interrupted, re-run and it picks up where it left off

## Prerequisites

```bash
brew install jq   # JSON parser
```

## Setup & Run

1. **Update the auth token** in `batch_generate_publish.sh` (line 16) — it expires!
2. Run:
   ```bash
   chmod +x batch_generate_publish.sh
   ./batch_generate_publish.sh
   ```

## Configuration

| Variable          | Default | Description                          |
|-------------------|---------|--------------------------------------|
| `AUTH_TOKEN`      | —       | Bearer token (update before each run)|
| `BATCH_SIZE`      | 50      | Number of items per batch            |
| `GENERATE_DELAY`  | 60      | Seconds between generate API calls   |
| `PUBLISH_DELAY`   | 15      | Seconds between publish API calls    |

## Output: `results.csv`

| Column              | Description                        |
|---------------------|------------------------------------|
| `entity_id`         | Entity UUID                        |
| `website_id`        | Website UUID                       |
| `url`               | Website URL                        |
| `generated_status`  | SUCCESS / FAILED                   |
| `generated_http_code` | HTTP status code from generate   |
| `generated_response`| Raw API response (generate)        |
| `published_status`  | SUCCESS / FAILED                   |
| `published_http_code` | HTTP status code from publish    |
| `published_response`| Raw API response (publish)         |
| `timestamp`         | UTC timestamp of the operation     |

## Resume Support

The script counts existing rows in `results.csv` and skips already-processed entities. Just re-run the script to continue from where it stopped.
