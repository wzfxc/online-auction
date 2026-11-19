# Runs the seed from the host against `docker compose up -d postgres meilisearch minio` (dev defaults, no secrets of value).
$env:DATABASE_URL = 'postgres://auction:auction_dev_password@127.0.0.1:5433/auction'
$env:MEILI_URL = 'http://127.0.0.1:7700'
$env:MEILI_MASTER_KEY = 'dev_meili_master_key_change_me_32chars'
$env:S3_ENDPOINT = 'http://127.0.0.1:9000'
$env:S3_PUBLIC_ENDPOINT = 'http://127.0.0.1:9000'
$env:S3_ACCESS_KEY = 'minio_dev_access'
$env:S3_SECRET_KEY = 'minio_dev_secret_key'
$env:S3_BUCKET = 'lots'
$env:JWT_SECRET = 'dev_jwt_secret_change_me_at_least_32_chars'
$env:PAYMENT_WEBHOOK_SECRET = 'dev_webhook_hmac_secret_change_me'
$env:PAYMENT_STUB_BASE_URL = 'http://localhost:8080'
$sw = [Diagnostics.Stopwatch]::StartNew()
pnpm --filter @auction/api seed
"seed seconds: $($sw.Elapsed.TotalSeconds)"
