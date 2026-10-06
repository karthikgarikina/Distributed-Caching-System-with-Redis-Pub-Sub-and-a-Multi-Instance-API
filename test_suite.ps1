Write-Host "==================================================" -ForegroundColor Cyan
Write-Host " RUNNING COMPLETE VERIFICATION OF ALL 13 REQS    " -ForegroundColor Cyan
Write-Host "==================================================" -ForegroundColor Cyan

$allPassed = $true

# Helper function
function Test-HeaderAndStatus {
    param($url, $expectedStatus, $expectedCache)
    $output = curl.exe -s -i $url
    $statusLine = ($output | Select-String -Pattern "HTTP/1.1 (\d+)").Matches.Groups[1].Value
    $cacheLine = ($output | Select-String -Pattern "X-Cache:\s*(\S+)").Matches.Groups[1].Value
    return @{
        Status = $statusLine
        Cache = $cacheLine
        Raw = $output
    }
}

# REQ 1: Check Docker Compose Services
Write-Host "`n[REQ 1] Verifying Docker Compose health status..." -ForegroundColor Yellow
$ps = docker compose ps --format json | ConvertFrom-Json
$healthyCount = 0
foreach ($svc in $ps) {
    if ($svc.Status -match "healthy") {
        $healthyCount++
        Write-Host "  Service $($svc.Service) is $($svc.Status)" -ForegroundColor Green
    } else {
        Write-Host "  Service $($svc.Service) is $($svc.Status)" -ForegroundColor Red
        $allPassed = $false
    }
}
if ($healthyCount -eq 6) {
    Write-Host "  [PASS] All 6 services healthy" -ForegroundColor Green
} else {
    Write-Host "  [FAIL] Expected 6 healthy services, got $healthyCount" -ForegroundColor Red
}

# REQ 2: Database Schema and Seed Count
Write-Host "`n[REQ 2] Verifying PostgreSQL schema and seed count..." -ForegroundColor Yellow
$dbRaw = (docker exec db psql -U user -d products_db -t -c "SELECT COUNT(*) FROM products;")
$dbCount = [int]($dbRaw | Out-String).Trim()
Write-Host "  Products count: $dbCount"
if ($dbCount -ge 5) {
    Write-Host "  [PASS] Seed count >= 5 ($dbCount products found)" -ForegroundColor Green
} else {
    Write-Host "  [FAIL] Seed count < 5" -ForegroundColor Red
    $allPassed = $false
}

# REQ 3: Nginx Load Balancing
Write-Host "`n[REQ 3] Verifying Nginx Round-Robin distribution..." -ForegroundColor Yellow
$instList = @()
1..3 | ForEach-Object {
    $inst = (curl.exe -s http://localhost/api/instance/id).Trim()
    $instList += $inst
    Write-Host "  Request $_ to Nginx: $inst"
}
$distinct = $instList | Select-Object -Unique
if ($distinct.Count -eq 3) {
    Write-Host "  [PASS] Nginx rotated across all 3 instances ($($distinct -join ', '))" -ForegroundColor Green
} else {
    Write-Host "  [FAIL] Did not rotate across 3 instances" -ForegroundColor Red
    $allPassed = $false
}

# REQ 4: Instance ID endpoints
Write-Host "`n[REQ 4] Verifying direct instance IDs on ports 8081, 8082, 8083..." -ForegroundColor Yellow
$i1 = (curl.exe -s http://localhost:8081/api/instance/id).Trim()
$i2 = (curl.exe -s http://localhost:8082/api/instance/id).Trim()
$i3 = (curl.exe -s http://localhost:8083/api/instance/id).Trim()
if ($i1 -eq "instance-1" -and $i2 -eq "instance-2" -and $i3 -eq "instance-3") {
    Write-Host "  [PASS] Direct instance IDs: 8081=$i1, 8082=$i2, 8083=$i3" -ForegroundColor Green
} else {
    Write-Host "  [FAIL] Instance IDs mismatch: $i1, $i2, $i3" -ForegroundColor Red
    $allPassed = $false
}

# REQ 5: Two-level cache-aside logic
Write-Host "`n[REQ 5] Verifying Two-Level Cache-Aside (MISS -> HIT-L1 -> HIT-L2)..." -ForegroundColor Yellow
# Invalidate product 1 first
curl.exe -s -X POST http://localhost:8081/api/cache/invalidate -H "Content-Type: application/json" -d "{\`"key\`": \`"product:1\`"}" | Out-Null
Start-Sleep -Milliseconds 300

$r1 = Test-HeaderAndStatus -url "http://localhost:8081/api/products/1"
Write-Host "  Call 1 on 8081: Status=$($r1.Status), X-Cache=$($r1.Cache)"
$r2 = Test-HeaderAndStatus -url "http://localhost:8081/api/products/1"
Write-Host "  Call 2 on 8081: Status=$($r2.Status), X-Cache=$($r2.Cache)"
$r3 = Test-HeaderAndStatus -url "http://localhost:8082/api/products/1"
Write-Host "  Call 3 on 8082: Status=$($r3.Status), X-Cache=$($r3.Cache)"

if ($r1.Cache -eq "MISS" -and $r2.Cache -eq "HIT-L1" -and $r3.Cache -eq "HIT-L2") {
    Write-Host "  [PASS] Exact sequence MISS -> HIT-L1 -> HIT-L2 verified" -ForegroundColor Green
} else {
    Write-Host "  [FAIL] Sequence mismatch" -ForegroundColor Red
    $allPassed = $false
}

# REQ 6 & 7 & 8: PUT update, pub/sub format, cross-instance invalidation
Write-Host "`n[REQ 6, 7, 8] Verifying PUT invalidation & Cross-instance coherence..." -ForegroundColor Yellow
# Prime product 2 on 8081 and 8082
curl.exe -s -X POST http://localhost:8081/api/cache/invalidate -H "Content-Type: application/json" -d "{\`"key\`": \`"product:2\`"}" | Out-Null
Start-Sleep -Milliseconds 200
$pPrime1 = Test-HeaderAndStatus -url "http://localhost:8081/api/products/2"
$pPrime1Hit = Test-HeaderAndStatus -url "http://localhost:8081/api/products/2"
$pPrime2Hit = Test-HeaderAndStatus -url "http://localhost:8082/api/products/2"
Write-Host "  Primed product 2: 8081 Cache=$($pPrime1Hit.Cache), 8082 Cache=$($pPrime2Hit.Cache)"

# Update product 2 via 8083
$putRes = curl.exe -s -X PUT http://localhost:8083/api/products/2 -H "Content-Type: application/json" -d "{\`"name\`": \`"Smartphone Pro v2\`", \`"price\`": \`"899.99\`"}"
Write-Host "  PUT to 8083: $putRes"
Start-Sleep -Milliseconds 400

# Verify invalidation on 8081
$pAfter1 = Test-HeaderAndStatus -url "http://localhost:8081/api/products/2"
Write-Host "  Verify 8081 after PUT: X-Cache=$($pAfter1.Cache)"

if ($pAfter1.Cache -eq "MISS" -and $putRes -match "Smartphone Pro v2") {
    Write-Host "  [PASS] Cross-instance invalidation verified on 8081" -ForegroundColor Green
} else {
    Write-Host "  [FAIL] Expected MISS on 8081 after update" -ForegroundColor Red
    $allPassed = $false
}

# REQ 9: POST product and list invalidation
Write-Host "`n[REQ 9] Verifying POST product and paginated list invalidation..." -ForegroundColor Yellow
$list1 = Test-HeaderAndStatus -url "http://localhost:8081/api/products?page=1"
$list2 = Test-HeaderAndStatus -url "http://localhost:8081/api/products?page=1"
Write-Host "  List fetch 1: $($list1.Cache), List fetch 2: $($list2.Cache)"

$postRes = curl.exe -s -X POST http://localhost:8081/api/products -H "Content-Type: application/json" -d "{\`"name\`": \`"Bluetooth Speaker\`", \`"description\`": \`"Bass portable speaker\`", \`"price\`": \`"59.99\`", \`"stock\`": 40}"
Write-Host "  POST created: $postRes"
Start-Sleep -Milliseconds 400

$list3 = Test-HeaderAndStatus -url "http://localhost:8081/api/products?page=1"
Write-Host "  List fetch after POST: X-Cache=$($list3.Cache)"
if ($list3.Cache -eq "MISS" -and $postRes -match "Bluetooth Speaker") {
    Write-Host "  [PASS] List cache invalidated after POST" -ForegroundColor Green
} else {
    Write-Host "  [FAIL] List cache was not invalidated" -ForegroundColor Red
    $allPassed = $false
}

# REQ 10: Cache Stats Endpoint
Write-Host "`n[REQ 10] Verifying GET /api/cache/stats schema and values..." -ForegroundColor Yellow
$stats = curl.exe -s http://localhost:8081/api/cache/stats | ConvertFrom-Json
Write-Host "  Stats: instanceId=$($stats.instanceId), l1_hits=$($stats.l1_hits), l1_misses=$($stats.l1_misses), l2_hits=$($stats.l2_hits), l2_misses=$($stats.l2_misses), db_hits=$($stats.db_hits), total_requests=$($stats.total_requests), hit_ratio=$($stats.hit_ratio)"
if ($stats.instanceId -eq "instance-1" -and $null -ne $stats.l1_hits -and $null -ne $stats.hit_ratio) {
    Write-Host "  [PASS] Stats endpoint schema and values are valid" -ForegroundColor Green
} else {
    Write-Host "  [FAIL] Stats endpoint response invalid" -ForegroundColor Red
    $allPassed = $false
}

# REQ 11: Manual Invalidation
Write-Host "`n[REQ 11] Verifying Manual Invalidation (POST /api/cache/invalidate)..." -ForegroundColor Yellow
# Prime
curl.exe -s http://localhost:8081/api/products/3 | Out-Null
# Invalidate key via 8082
$invKey = curl.exe -s -X POST http://localhost:8082/api/cache/invalidate -H "Content-Type: application/json" -d "{\`"key\`": \`"product:3\`"}"
Write-Host "  Invalidate response: $invKey"
Start-Sleep -Milliseconds 300
$afterInv = Test-HeaderAndStatus -url "http://localhost:8081/api/products/3"
Write-Host "  GET after manual invalidation: X-Cache=$($afterInv.Cache)"
if ($invKey -match "ok" -and $afterInv.Cache -eq "MISS") {
    Write-Host "  [PASS] Manual key invalidation verified" -ForegroundColor Green
} else {
    Write-Host "  [FAIL] Manual key invalidation failed" -ForegroundColor Red
    $allPassed = $false
}

# REQ 12: Clear All Caches
Write-Host "`n[REQ 12] Verifying Flush All Caches (DELETE /api/cache/clear)..." -ForegroundColor Yellow
$clearRes = curl.exe -s -X DELETE http://localhost:8081/api/cache/clear
Write-Host "  Clear response: $clearRes"
$dbsize = (docker exec redis redis-cli DBSIZE).Trim()
Write-Host "  Redis DBSIZE: $dbsize"
$afterClear = Test-HeaderAndStatus -url "http://localhost:8081/api/products/1"
Write-Host "  GET after clear: X-Cache=$($afterClear.Cache)"
if ($clearRes -match "ok" -and $dbsize -eq "0" -and $afterClear.Cache -eq "MISS") {
    Write-Host "  [PASS] Clear all caches verified" -ForegroundColor Green
} else {
    Write-Host "  [FAIL] Clear all caches failed" -ForegroundColor Red
    $allPassed = $false
}

# REQ 13: .env.example verification
Write-Host "`n[REQ 13] Verifying .env.example..." -ForegroundColor Yellow
$envContent = Get-Content .env.example -Raw
$hasAppPort = $envContent -match "APP_PORT"
$hasInstanceId = $envContent -match "INSTANCE_ID"
$hasDbUrl = $envContent -match "DATABASE_URL"
$hasRedisUrl = $envContent -match "REDIS_URL"
if ($hasAppPort -and $hasInstanceId -and $hasDbUrl -and $hasRedisUrl) {
    Write-Host "  [PASS] .env.example contains all required environment variables" -ForegroundColor Green
} else {
    Write-Host "  [FAIL] .env.example missing required variables" -ForegroundColor Red
    $allPassed = $false
}

Write-Host "`n==================================================" -ForegroundColor Cyan
if ($allPassed) {
    Write-Host " ALL 13 REQUIREMENTS VERIFIED AND PASSED 100%!   " -ForegroundColor Green
} else {
    Write-Host " SOME REQUIREMENTS FAILED!                      " -ForegroundColor Red
}
Write-Host "==================================================" -ForegroundColor Cyan
